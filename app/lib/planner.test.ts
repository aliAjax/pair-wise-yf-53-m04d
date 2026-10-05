import { describe, it, assert, assertEqual } from '../../scripts/harness.mjs';
import { planSchedule, findCycles, topoOrder } from './planner.ts';
import type { RepositoryGate } from './types.ts';

let seq = 0;
function gate(id: string, dependsOn: string[] = [], blocked = false): RepositoryGate {
  seq += 1;
  return { id, repository: id, owner: `owner-${id}`, dependsOn, blocked, version: '1.0.0' };
}

function idsByWindow(plan: ReturnType<typeof planSchedule>): string[][] {
  return plan.windows.map((win) => win.assignments.map((a) => a.gateId));
}

describe('依赖分批', () => {
  it('线性依赖 a<-b<-c 时上游严格落在更早的窗口（批次而不是批次内序）', () => {
    const plan = planSchedule({ gates: [gate('c', ['b']), gate('b', ['a']), gate('a')], capacity: 5 });
    assert(plan.ok);
    assertEqual(idsByWindow(plan), [['a'], ['b'], ['c']]);
    const indexOf = new Map(plan.windows.flatMap((win) => win.assignments.map((a) => [a.gateId, win.index])));
    assert(indexOf.get('a')! < indexOf.get('b')!);
    assert(indexOf.get('b')! < indexOf.get('c')!);
  });

  it('同批内按稳定拓扑序，结果与输入顺序无关', () => {
    const g = () => [gate('web', ['ui', 'auth']), gate('auth'), gate('ui')];
    const p1 = planSchedule({ gates: g(), capacity: 5 });
    const p2 = planSchedule({ gates: [...g()].reverse(), capacity: 5 });
    assertEqual(idsByWindow(p1), idsByWindow(p2));
    // 两个无依赖上游同窗，下游严格在下一窗
    assertEqual(idsByWindow(p1), [['auth', 'ui'], ['web']]);
  });

  it('被依赖的上游即使字典序靠后也先进前面的批次', () => {
    // zzz 是 aaa 的上游，不能因为 id 大被排到后面窗口
    const plan = planSchedule({ gates: [gate('aaa', ['zzz']), gate('zzz')], capacity: 1 });
    assertEqual(idsByWindow(plan), [['zzz'], ['aaa']]);
  });
});

describe('窗口容量', () => {
  it('容量满了顺延到下一窗，并保留跨窗依赖关系', () => {
    // 链 a<-b<-c<-d，上游必须严格更早：容量 2 时 a 窗0；b 窗1；c、d 顺延，窗3 末位
    const plan = planSchedule({
      gates: [gate('a'), gate('b', ['a']), gate('c', ['b']), gate('d', ['c'])],
      capacity: 2
    });
    assertEqual(idsByWindow(plan), [['a'], ['b'], ['c'], ['d']]);
    assert(plan.windows.every((win) => win.assignments.length <= 2));
  });

  it('容量在分支依赖上生效：同级下游共享窗口', () => {
    // a 是 b、c 的上游，b 是 d 的上游，容量 2：a 独占窗0；b、c 同为 a 的下游共享窗1；d 晚于 b 进窗2
    const plan = planSchedule({
      gates: [gate('a'), gate('b', ['a']), gate('c', ['a']), gate('d', ['b'])],
      capacity: 2
    });
    assertEqual(idsByWindow(plan), [['a'], ['b', 'c'], ['d']]);
  });

  it('独立仓库纯按容量填满窗口', () => {
    const plan = planSchedule({ gates: ['a', 'b', 'c', 'd', 'e'].map((id) => gate(id)), capacity: 2 });
    assertEqual(idsByWindow(plan), [['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('容量从 1 改到 3 后重算：批次压缩，依赖仍严格有序', () => {
    const gates = [gate('a'), gate('b', ['a']), gate('c', ['b']), gate('d', ['a'])];
    const narrow = planSchedule({ gates, capacity: 1 });
    const wide = planSchedule({ gates, capacity: 3 });
    assertEqual(idsByWindow(narrow), [['a'], ['b'], ['c'], ['d']]);
    // 容量 3：a 窗0；b 窗1；c 晚于 b 进窗2；d 作为 a 的下游补进窗1 空位
    assertEqual(idsByWindow(wide), [['a'], ['b', 'd'], ['c']]);
  });

  it('容量不是正整数时兜底为 1', () => {
    const plan = planSchedule({ gates: [gate('a'), gate('b')], capacity: 0 });
    assertEqual(idsByWindow(plan), [['a'], ['b']]);
  });
});

describe('阻断问题', () => {
  it('有未关闭阻断问题的仓库不进批次', () => {
    const plan = planSchedule({ gates: [gate('a'), gate('b', [], true)], capacity: 5 });
    assertEqual(idsByWindow(plan), [['a']]);
    assertEqual(plan.unscheduled.map((u) => u.gateId), ['b']);
    assertEqual(plan.unscheduled[0].reason, 'open-blocker');
  });

  it('下游跟着不排并点名被阻断的上游', () => {
    const plan = planSchedule({
      gates: [gate('a', [], true), gate('b', ['a']), gate('c', ['b'])],
      capacity: 5
    });
    assertEqual(idsByWindow(plan), []);
    const reasons = new Map(plan.unscheduled.map((u) => [u.gateId, u]));
    assertEqual(reasons.get('a')?.reason, 'open-blocker');
    assertEqual(reasons.get('b')?.reason, 'upstream-blocked');
    assertEqual(reasons.get('b')?.causedBy, ['a']);
    assertEqual(reasons.get('c')?.reason, 'upstream-blocked');
    assertEqual(reasons.get('c')?.causedBy, ['b']);
  });

  it('缺失的依赖被标记而不是抛错', () => {
    const plan = planSchedule({ gates: [gate('a', ['ghost'])], capacity: 5 });
    assertEqual(idsByWindow(plan), []);
    assertEqual(plan.unscheduled[0].reason, 'upstream-missing');
    assertEqual(plan.unscheduled[0].causedBy, ['ghost']);
  });
});

describe('环检测', () => {
  it('双仓库互相依赖时拦下发布并点名环', () => {
    const plan = planSchedule({ gates: [gate('a', ['b']), gate('b', ['a'])], capacity: 5 });
    assert(!plan.ok);
    assertEqual(plan.cycles.length, 1);
    assertEqual(plan.cycles[0].nodes, ['a', 'b']);
    assertEqual(plan.cycles[0].path, ['a', 'b', 'a']);
    assertEqual(plan.windows, []);
  });

  it('三环给出闭环路径，环上仓库全部不排', () => {
    const plan = planSchedule({ gates: [gate('a', ['c']), gate('b', ['a']), gate('c', ['b']), gate('d')], capacity: 5 });
    assert(!plan.ok);
    assertEqual(plan.cycles[0].path, ['a', 'c', 'b', 'a']);
    assert(plan.unscheduled.some((u) => u.gateId === 'a' && u.reason === 'upstream-cycle'));
    // 无关节仓库 d 不进批次（整个发布被拦下，windows 为空）
    assertEqual(idsByWindow(plan), []);
  });

  it('自环被识别', () => {
    const plan = planSchedule({ gates: [gate('a', ['a'])], capacity: 5 });
    assert(!plan.ok);
    assertEqual(plan.cycles[0].nodes, ['a']);
  });

  it('无环图 findCycles 返回空，topoOrder 正常', () => {
    const gates = [gate('c', ['a', 'b']), gate('a'), gate('b')];
    const map = new Map(gates.map((g) => [g.id, g.dependsOn]));
    assertEqual(findCycles(gates.map((g) => g.id), map), []);
    assertEqual(topoOrder(gates.map((g) => g.id), map), ['a', 'b', 'c']);
  });
});

describe('锁定批次与重算', () => {
  it('已确认锁定的仓库保留在原窗口，重算只动未定仓库', () => {
    const gates = [gate('a'), gate('b', ['a']), gate('c', ['a']), gate('d', ['b'])];
    // 容量 2 先排（无锁）：a 窗0；b、c 窗1；d 窗2
    const first = planSchedule({ gates, capacity: 2 });
    assertEqual(idsByWindow(first), [['a'], ['b', 'c'], ['d']]);
    // 锁定 a@0、b@1 后容量改 3：c 依赖 a 可进窗1（锁 b 已占 1 位，仍有空）；d 晚于 b(窗1) -> 窗2
    const recalc = planSchedule({ gates, capacity: 3, locks: { a: 0, b: 1 } });
    assertEqual(idsByWindow(recalc), [['a'], ['b', 'c'], ['d']]);

    // 更能体现“只动未定”的场景：容量 2 下锁 a@0、b@0（人为允许同窗），
    // 未定的 c 最早窗1 空位 -> 窗1；d 晚于 b(窗0) 进窗1
    const merged = planSchedule({ gates, capacity: 2, locks: { a: 0, b: 0 } });
    assertEqual(idsByWindow(merged), [['a', 'b'], ['c', 'd']]);
  });

  it('容量缩小导致锁顶爆窗口：保留锁但标记 overflow', () => {
    const gates = [gate('a'), gate('b'), gate('c', ['a'])];
    const plan = planSchedule({ gates, capacity: 1, locks: { a: 0, b: 0 } });
    assertEqual(plan.windows[0].assignments.length, 2);
    assert(plan.windows[0].overflow);
  });

  it('锁定仓库的上游被改到同窗/后窗时点名 lockConflict，但批次保留', () => {
    const gates = [gate('a'), gate('b', ['a'])];
    // 正常 a@0 b@1；人为把 a 锁到窗1、b 锁到窗1
    const plan = planSchedule({ gates, capacity: 5, locks: { a: 1, b: 1 } });
    assertEqual(plan.lockConflicts.length, 1);
    assertEqual(plan.lockConflicts[0], { gateId: 'b', windowIndex: 1, upstream: 'a', upstreamWindow: 1 });
  });

  it('阻断/环上的锁定仓库不参与排期', () => {
    const blockedPlan = planSchedule({ gates: [gate('a', [], true), gate('b')], capacity: 5, locks: { a: 0 } });
    assertEqual(idsByWindow(blockedPlan), [['b']]);
    const cyclePlan = planSchedule({ gates: [gate('a', ['b']), gate('b', ['a'])], capacity: 5, locks: { a: 0 } });
    assert(!cyclePlan.ok);
    assertEqual(cyclePlan.windows, []);
  });
});
