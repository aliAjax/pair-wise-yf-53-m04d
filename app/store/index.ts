import {
  configureStore,
  createAsyncThunk,
  createSlice,
  type PayloadAction
} from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { planSchedule } from '../lib/planner';
import { createRemoteScheduler, resolveRemoteScheduler, type RemoteConfirm } from '../lib/remote';
import {
  DEFAULT_CAPACITY,
  loadDraft,
  saveDraft,
  type PersistedStateV2
} from '../lib/storage';
import type { Confirmation, ReleaseTrain, RepositoryGate, SchedulePlan } from '../lib/types';

export type { RepositoryGate, ReleaseTrain, Confirmation };

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
  /** 下一窗远端确认是否模拟失败（演示用开关） */
  remoteFaultInjected: boolean;
}

const now = (): string => new Date().toLocaleTimeString();
const auditId = (): string => `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function addAudit(train: ReleaseTrain, text: string): void {
  train.audit.unshift({ id: auditId(), at: now(), text });
}

const seed: TrainState = {
  activeId: 'train-101',
  remoteFaultInjected: false,
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    capacity: 2,
    gates: [
      { id: 'g1', repository: 'shared-ui', owner: '林澈', dependsOn: [], blocked: false, version: '4.2.0' },
      { id: 'g2', repository: 'auth-sdk', owner: '韩梅', dependsOn: [], blocked: false, version: '2.1.0' },
      { id: 'g3', repository: 'web-console', owner: '陈珂', dependsOn: ['g1'], blocked: false, version: '4.8.0' },
      { id: 'g4', repository: 'gateway', owner: '周扬', dependsOn: ['g2'], blocked: false, version: '2.12.0' },
      { id: 'g5', repository: 'billing-service', owner: '苏晓', dependsOn: [], blocked: false, version: '0.9.7' },
      { id: 'g6', repository: 'data-sync', owner: '罗雨', dependsOn: ['g4'], blocked: true, blockerReason: 'critical：依赖的网关发布单还没签字', version: '1.9.4' },
      { id: 'g7', repository: 'mobile-app', owner: '高凡', dependsOn: ['g3', 'g4'], blocked: false, version: '7.0.0' }
    ],
    confirmations: {},
    audit: [{ id: 'a-seed', at: '09:20', text: '创建发布列车并关联 7 个仓库，窗口容量 2' }]
  }]
};

/** 从当前列车输入重算排期（容量/依赖/阻断任一改动都走这里，批次自动重算） */
export function selectPlan(train: ReleaseTrain): SchedulePlan {
  const locks: Record<string, number> = {};
  for (const gate of train.gates) {
    const confirmation = train.confirmations[gate.id];
    if (confirmation?.status === 'confirmed' && confirmation.windowIndex !== undefined) {
      locks[gate.id] = confirmation.windowIndex;
    }
  }
  return planSchedule({ gates: train.gates, capacity: train.capacity, locks });
}

export function selectActiveTrain(state: TrainState): ReleaseTrain | undefined {
  return state.trains.find((train) => train.id === state.activeId) ?? state.trains[0];
}

// 远端调度器：remoteFaultInjected 时只放倒本轮第一个请求（dispatch 同步清标志），
// 用来演示“部分仓库确认失败，已定批次保留，只重试没定下来的仓库”。
let storeInstance: { getState: () => RootState; dispatch: (action: unknown) => unknown } | undefined;
let schedulerSingleton: RemoteConfirm | undefined;
function getRemote(): RemoteConfirm {
  if (!schedulerSingleton) {
    schedulerSingleton = createRemoteScheduler({
      failNext: () => {
        if (!storeInstance) return false;
        const injected = storeInstance.getState().train.remoteFaultInjected;
        if (injected) storeInstance.dispatch(setRemoteFaultInjected(false));
        return injected;
      }
    });
  }
  return resolveRemoteScheduler(schedulerSingleton);
}

export interface ConfirmResult {
  confirmed: Array<{ gateId: string; windowIndex: number; at: string }>;
  failed: Array<{ gateId: string; message: string }>;
}

export interface PendingItem {
  gateId: string;
  windowIndex: number;
}

/** 计算当前计划里“没定下来”的仓库（unconfirmed/failed）；环拦截时为空 */
export function selectPendingConfirmations(train: ReleaseTrain): { items: PendingItem[]; plan: ReturnType<typeof selectPlan> } {
  const plan = selectPlan(train);
  if (!plan.ok) return { items: [], plan };
  const items: PendingItem[] = [];
  for (const win of plan.windows) {
    for (const assignment of win.assignments) {
      const status = train.confirmations[assignment.gateId]?.status ?? 'unconfirmed';
      if (status === 'unconfirmed' || status === 'failed') {
        items.push({ gateId: assignment.gateId, windowIndex: win.index });
      }
    }
  }
  return { items, plan };
}

/**
 * 向远端确认当前批次。待确认清单在 dispatch 前算出并作为参数传入——
 * RTK 的 pending reducer 先于 payloadCreator 执行，不能在 thunk 体内再读确认状态
 * （那时自己的 pending 写入已经生效）。
 * 只提交“没定下来”的仓库：已 confirmed 的批次原样保留；失败仓库标 failed，
 * 负责人处理完再点一次即只重试这些。
 */
export const confirmSchedule = createAsyncThunk<ConfirmResult, { trainId: string; items: PendingItem[] }, { state: { train: TrainState } }>(
  'train/confirmSchedule',
  async ({ trainId, items }, { dispatch }) => {
    if (items.length === 0) return { confirmed: [], failed: [] };

    const remote = getRemote();
    const confirmed: ConfirmResult['confirmed'] = [];
    const failed: ConfirmResult['failed'] = [];

    await Promise.all(
      items.map(async (item) => {
        try {
          const response = await remote({ trainId, gateId: item.gateId, windowIndex: item.windowIndex });
          confirmed.push({ gateId: response.gateId, windowIndex: response.windowIndex, at: response.confirmedAt });
        } catch (error) {
          failed.push({ gateId: item.gateId, message: error instanceof Error ? error.message : String(error) });
        }
      })
    );

    confirmed.sort((a, b) => a.windowIndex - b.windowIndex || (a.gateId < b.gateId ? -1 : 1));
    failed.sort((a, b) => (a.gateId < b.gateId ? -1 : b.gateId > a.gateId ? 1 : 0));
    dispatch(applyConfirmResult({ confirmed, failed }));
    return { confirmed, failed };
  }
);

interface GateDraft {
  repository: string;
  owner: string;
  version: string;
  dependsOn: string[];
  blocked: boolean;
  blockerReason?: string;
}

const trainSlice = createSlice({
  name: 'train',
  initialState: seed,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({
        id,
        name: action.payload.name,
        freezeAt: action.payload.freezeAt,
        status: 'preparing',
        capacity: DEFAULT_CAPACITY,
        gates: [],
        confirmations: {},
        audit: [{ id: auditId(), at: now(), text: '创建发布列车' }]
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) {
      state.activeId = action.payload;
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      addAudit(train, `状态调整为 ${action.payload}`);
    },
    /** 窗口容量改动：已锁定的确认保留，其余批次由 selector 立即重算 */
    setCapacity(state, action: PayloadAction<number>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const capacity = Math.max(1, Math.floor(action.payload) || 1);
      train.capacity = capacity;
      addAudit(train, `窗口容量改为 ${capacity}，未定批次已按依赖重新排期`);
    },
    addGate(state, action: PayloadAction<GateDraft>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const id = `g-${Date.now()}`;
      const gate: RepositoryGate = { id, ...action.payload, dependsOn: [...new Set(action.payload.dependsOn)].filter((dep) => dep !== id) };
      train.gates.push(gate);
      addAudit(train, `加入仓库 ${gate.repository}`);
    },
    updateGate(state, action: PayloadAction<{ id: string; patch: Partial<GateDraft> }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload.id);
      if (!train || !gate) return;
      const { patch } = action.payload;
      if (patch.repository !== undefined) gate.repository = patch.repository;
      if (patch.owner !== undefined) gate.owner = patch.owner;
      if (patch.version !== undefined) gate.version = patch.version;
      if (patch.blocked !== undefined) gate.blocked = patch.blocked;
      if (patch.blockerReason !== undefined) gate.blockerReason = patch.blockerReason;
      if (patch.dependsOn !== undefined) {
        gate.dependsOn = [...new Set(patch.dependsOn)].filter((dep) => dep !== gate.id);
        addAudit(train, `${gate.repository} 的依赖门禁有调整，批次重新排期`);
      }
    },
    removeGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const index = train.gates.findIndex((item) => item.id === action.payload);
      if (index < 0) return;
      const [removed] = train.gates.splice(index, 1);
      for (const gate of train.gates) gate.dependsOn = gate.dependsOn.filter((dep) => dep !== removed.id);
      delete train.confirmations[removed.id];
      addAudit(train, `移除仓库 ${removed.repository}，相关依赖一并清理`);
    },
    /** 负责人处理完阻断问题后放行：仓库下一轮排期自动进批次 */
    resolveGateBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.blocked = false;
      gate.blockerReason = undefined;
      addAudit(train, `${gate.repository} 的阻断问题已关闭，恢复排期`);
    },
    /** 撤回远端确认（锁定批次失效，重新参与重算） */
    unconfirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      delete train.confirmations[action.payload];
      const gate = train.gates.find((item) => item.id === action.payload);
      addAudit(train, `撤回 ${gate?.repository ?? action.payload} 的远端确认，批次重新排期`);
    },
    applyConfirmResult(
      state,
      action: PayloadAction<{
        confirmed: Array<{ gateId: string; windowIndex: number; at: string }>;
        failed: Array<{ gateId: string; message: string }>;
      }>
    ) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      for (const item of action.payload.confirmed) {
        train.confirmations[item.gateId] = {
          status: 'confirmed',
          windowIndex: item.windowIndex,
          at: item.at,
          message: '远端排期已锁定'
        };
      }
      for (const item of action.payload.failed) {
        train.confirmations[item.gateId] = { status: 'failed', message: item.message, at: new Date().toISOString() };
      }
      const gateName = (id: string): string => train.gates.find((gate) => gate.id === id)?.repository ?? id;
      if (action.payload.confirmed.length) {
        addAudit(train, `远端锁定批次：${action.payload.confirmed.map((item) => `${gateName(item.gateId)}@窗${item.windowIndex + 1}`).join('、')}`);
      }
      if (action.payload.failed.length) {
        addAudit(train, `远端确认失败（已定批次保留）：${action.payload.failed.map((item) => gateName(item.gateId)).join('、')}；修复后可只重试这些仓库`);
      }
      state.remoteFaultInjected = false;
    },
    setRemoteFaultInjected(state, action: PayloadAction<boolean>) {
      state.remoteFaultInjected = action.payload;
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(confirmSchedule.pending, (state, action) => {
        const train = state.trains.find((item) => item.id === state.activeId);
        if (!train || train.id !== action.meta.arg.trainId) return;
        for (const item of action.meta.arg.items) {
          train.confirmations[item.gateId] = { status: 'confirming' };
        }
      })
      .addCase(confirmSchedule.rejected, (state, action) => {
        const train = state.trains.find((item) => item.id === action.meta.arg.trainId);
        if (!train) return;
        for (const item of action.meta.arg.items) {
          train.confirmations[item.gateId] = {
            status: 'failed',
            message: '远端确认请求中断，可重试',
            at: new Date().toISOString()
          };
        }
      });
  }
});

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain,
  addGate,
  applyConfirmResult,
  createTrain,
  removeGate,
  resolveGateBlocker,
  setCapacity,
  setFreeze,
  setRemoteFaultInjected,
  unconfirmGate,
  updateGate
} = trainSlice.actions;

function buildInitialState(): TrainState {
  const fallback: PersistedStateV2 = { version: 2, activeId: seed.activeId, trains: seed.trains };
  const persisted = loadDraft(fallback);
  return { activeId: persisted.activeId, trains: persisted.trains, remoteFaultInjected: false };
}

export const store = configureStore({
  // 直接以（可能已从 v1 迁移的）localStorage 旧稿作为初始状态，
  // 避免创建后 hydrate 误触发 confirmSchedule.pending。
  preloadedState: typeof window === 'undefined' ? undefined : (() => {
    const initial = buildInitialState();
    return { train: initial };
  })(),
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  // 注意必须回调式：RTK 默认中间件（含 thunk）由 getDefaultMiddleware 提供，
  // 直接传数组会丢掉 thunk，dispatch(createAsyncThunk(...)) 不会执行。
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(releaseApi.middleware)
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
export const useAppDispatch = (): AppDispatch => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

storeInstance = store;

if (typeof window !== 'undefined') {
  store.subscribe(() => {
    const { train } = store.getState();
    saveDraft({ version: 2, activeId: train.activeId, trains: train.trains });
  });
}
