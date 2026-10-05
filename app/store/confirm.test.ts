import { describe, itAsync, assert, assertEqual } from '../../scripts/harness.mjs';
import { _setRemoteSchedulerForTest } from '../lib/remote.ts';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

function freshStoreModule() {
  // 每个用例拿到干净的模块单例（store、远端缓存都重置）
  globalThis.window = { localStorage: new MemoryStorage() };
  const url = new URL('./index.ts?t=' + Math.random(), import.meta.url).href;
  return import(url);
}

function failingScheduler(failIds) {
  return async (req) => {
    if (failIds.has(req.gateId)) throw new Error(`远端拒绝 ${req.gateId}`);
    return { gateId: req.gateId, windowIndex: req.windowIndex, confirmedAt: `at-${req.gateId}` };
  };
}


async function confirmPending(mod) {
  const train = mod.selectActiveTrain(mod.store.getState().train);
  const { items } = mod.selectPendingConfirmations(train);
  if (items.length === 0) return { confirmed: [], failed: [] };
  const result = await mod.store.dispatch(mod.confirmSchedule({ trainId: train.id, items })).unwrap();
  return result;
}

describe('远端确认与失败重试', () => {
  itAsync('部分失败：已定批次保留，失败仓库标 failed，其余锁定', async () => {
    _setRemoteSchedulerForTest(failingScheduler(new Set(['g3'])));
    const mod = await freshStoreModule();
    mod.store.dispatch(mod.setCapacity(2)); // 种子 7 仓库，g6 阻断不排
    await confirmPending(mod);

    const train = mod.selectActiveTrain(mod.store.getState().train);
    const plan = mod.selectPlan(train);
    const statusOf = Object.fromEntries(train.gates.map((g) => [g.id, train.confirmations[g.id]?.status ?? 'unconfirmed']));

    // g6 阻断、不进批次，因此永远 unconfirmed（不会被提交）
    assertEqual(statusOf.g6, 'unconfirmed');
    // g3 失败
    assertEqual(statusOf.g3, 'failed');
    assert(train.confirmations.g3.message.includes('g3'));
    // 其余进批次的仓库全部锁定，且 windowIndex 与计划一致
    for (const win of plan.windows) {
      for (const assignment of win.assignments) {
        if (assignment.gateId === 'g3') continue;
        assertEqual(statusOf[assignment.gateId], 'confirmed');
        assertEqual(train.confirmations[assignment.gateId].windowIndex, win.index);
      }
    }
  });

  itAsync('负责人处理完再确认：只重试 failed 的仓库，confirmed 的不重复提交', async () => {
    const calls = [];
    let failGate = true;
    _setRemoteSchedulerForTest(async (req) => {
      calls.push(req.gateId);
      if (req.gateId === 'g3' && failGate) throw new Error('远端拒绝 g3');
      return { gateId: req.gateId, windowIndex: req.windowIndex, confirmedAt: `at-${req.gateId}` };
    });
    const mod = await freshStoreModule();
    mod.store.dispatch(mod.setCapacity(2));

    await confirmPending(mod);
    const firstCallCount = calls.length;
    assert(calls.includes('g3'));

    // 远端修好后再次确认
    failGate = false;
    await confirmPending(mod);

    const train = mod.selectActiveTrain(mod.store.getState().train);
    assertEqual(train.confirmations.g3.status, 'confirmed');
    // 第二轮只提交了 g3 一个仓库
    const secondRound = calls.slice(firstCallCount);
    assertEqual(secondRound, ['g3']);
  });

  itAsync('确认后修改容量：已锁定批次不动，未定仓库重算', async () => {
    _setRemoteSchedulerForTest(failingScheduler(new Set()));
    const mod = await freshStoreModule();
    mod.store.dispatch(mod.setCapacity(2));
    await confirmPending(mod);

    const before = mod.selectActiveTrain(mod.store.getState().train);
    const lockedG1 = before.confirmations.g1.windowIndex;

    mod.store.dispatch(mod.setCapacity(5));
    const after = mod.selectActiveTrain(mod.store.getState().train);
    // 确认信息保留原窗
    assertEqual(after.confirmations.g1.status, 'confirmed');
    assertEqual(after.confirmations.g1.windowIndex, lockedG1);
    // 容量 5 时窗口数压缩
    const plan = mod.selectPlan(after);
    assert(plan.windows.length < 4);
  });

  itAsync('撤回确认后仓库重新参与排期', async () => {
    _setRemoteSchedulerForTest(failingScheduler(new Set()));
    const mod = await freshStoreModule();
    mod.store.dispatch(mod.setCapacity(2));
    await confirmPending(mod);
    mod.store.dispatch(mod.unconfirmGate('g1'));
    const train = mod.selectActiveTrain(mod.store.getState().train);
    assertEqual(train.confirmations.g1, undefined);
    const plan = mod.selectPlan(train);
    // g1 重新出现在计划里且不溢出
    assert(plan.windows.some((win) => win.assignments.some((a) => a.gateId === 'g1')));
  });

  itAsync('阻断关闭后下一轮确认自动带上该仓库', async () => {
    const calls = [];
    _setRemoteSchedulerForTest(async (req) => {
      calls.push(req.gateId);
      return { gateId: req.gateId, windowIndex: req.windowIndex, confirmedAt: 'x' };
    });
    const mod = await freshStoreModule();
    mod.store.dispatch(mod.setCapacity(3));
    await confirmPending(mod);
    assert(!calls.includes('g6'), '阻断仓库首轮不提交');

    mod.store.dispatch(mod.resolveGateBlocker('g6'));
    await confirmPending(mod);
    assert(calls.includes('g6'), '阻断关闭后该仓库只在重试轮提交');
  });

  itAsync('制造互相依赖后 plan.ok=false，确认被拦下；打断环后恢复', async () => {
    _setRemoteSchedulerForTest(failingScheduler(new Set()));
    const mod = await freshStoreModule();
    let train = mod.selectActiveTrain(mod.store.getState().train);
    assert(mod.selectPlan(train).ok, '初始无环');

    // g1(shared-ui) 与 g3(web-console)：让 g1 反向依赖 g3，形成 g1 <-> g3
    mod.store.dispatch(mod.updateGate({ id: 'g1', patch: { dependsOn: ['g3'] } }));
    train = mod.selectActiveTrain(mod.store.getState().train);
    const cyclic = mod.selectPlan(train);
    assert(!cyclic.ok);
    assertEqual(cyclic.cycles[0].nodes.sort(), ['g1', 'g3']);
    assert(cyclic.cycles[0].path[0] === cyclic.cycles[0].path.at(-1));

    // 有环时确认 thunk 直接空跑，不会有任何仓库被锁定
    await confirmPending(mod);
    train = mod.selectActiveTrain(mod.store.getState().train);
    assertEqual(Object.keys(train.confirmations).length, 0);

    // 打断环后批次恢复
    mod.store.dispatch(mod.updateGate({ id: 'g1', patch: { dependsOn: [] } }));
    train = mod.selectActiveTrain(mod.store.getState().train);
    assert(mod.selectPlan(train).ok);
    assert(mod.selectPlan(train).windows.length > 0);
  });

  itAsync('容量改动触发重算，且已锁定窗口不动', async () => {
    _setRemoteSchedulerForTest(failingScheduler(new Set()));
    const mod = await freshStoreModule();
    mod.store.dispatch(mod.setCapacity(2));
    await confirmPending(mod);
    const before = mod.selectActiveTrain(mod.store.getState().train);
    const lockWindow = new Map(Object.entries(before.confirmations).map(([id, c]) => [id, c.windowIndex]));

    mod.store.dispatch(mod.setCapacity(1));
    const after = mod.selectActiveTrain(mod.store.getState().train);
    // 所有已锁定仓库仍保留原窗号
    for (const [id, win] of lockWindow) assertEqual(after.confirmations[id].windowIndex, win);
  });
});
