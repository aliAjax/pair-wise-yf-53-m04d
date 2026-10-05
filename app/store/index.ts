import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { migrateState, STORAGE_VERSION } from './migrate';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';
export type GateRemoteState = 'idle' | 'confirmed' | 'failed';

export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
  remoteState: GateRemoteState;
  remoteError?: string;
}

export interface ReleaseWindow {
  id: string;
  label: string;
  capacity: number;
}

export interface Blocker {
  id: string;
  title: string;
  severity: 'warning' | 'critical';
  resolved: boolean;
  repository?: string;
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  gates: RepositoryGate[];
  windows: ReleaseWindow[];
  blockers: Blocker[];
  audit: Array<{ id: string; at: string; text: string }>;
}

export interface TrainState {
  version: number;
  activeId: string;
  trains: ReleaseTrain[];
}

function now() {
  return new Date().toLocaleTimeString();
}

function defaultWindows(prefix: string): ReleaseWindow[] {
  return [1, 2, 3].map((i) => ({ id: `${prefix}-w${i}`, label: `第${i}窗`, capacity: 3 }));
}

const initial: TrainState = {
  version: STORAGE_VERSION,
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    windows: [
      { id: 'train-101-w1', label: '第1窗 · 10-08', capacity: 2 },
      { id: 'train-101-w2', label: '第2窗 · 10-09', capacity: 2 },
      { id: 'train-101-w3', label: '第3窗 · 10-10', capacity: 2 }
    ],
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0', remoteState: 'idle' },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0', remoteState: 'idle' },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4', remoteState: 'idle' },
      { id: 'g4', repository: 'console-ui', owner: '林岚', dependency: 'gateway@2.12', status: 'pending', version: '3.4.1', remoteState: 'idle' }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false, repository: 'data-sync' },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 4 个仓库、3 个发布窗口' }]
  }]
};

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({
        id,
        ...action.payload,
        status: 'preparing',
        windows: defaultWindows(id),
        gates: [],
        blockers: [],
        audit: [{ id: `a-${Date.now()}`, at: now(), text: '创建发布列车' }]
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `${gate.repository} 门禁由发布负责人确认` });
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `状态调整为 ${action.payload}` });
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `阻断项已关闭：${blocker.title}` });
    },
    addWindow(state, action: PayloadAction<{ trainId: string }>) {
      const train = state.trains.find((item) => item.id === action.payload.trainId);
      if (!train) return;
      const n = train.windows.length + 1;
      train.windows.push({ id: `${train.id}-w${Date.now()}`, label: `第${n}窗`, capacity: 3 });
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `新增发布窗口（第${n}窗），批次将按容量重算` });
    },
    updateWindow(state, action: PayloadAction<{ trainId: string; windowId: string; label?: string; capacity?: number }>) {
      const train = state.trains.find((item) => item.id === action.payload.trainId);
      const win = train?.windows.find((item) => item.id === action.payload.windowId);
      if (!train || !win) return;
      if (action.payload.label !== undefined) win.label = action.payload.label;
      if (action.payload.capacity !== undefined) win.capacity = Math.max(1, Math.round(Number(action.payload.capacity) || 1));
    },
    removeWindow(state, action: PayloadAction<{ trainId: string; windowId: string }>) {
      const train = state.trains.find((item) => item.id === action.payload.trainId);
      if (!train) return;
      const win = train.windows.find((item) => item.id === action.payload.windowId);
      train.windows = train.windows.filter((item) => item.id !== action.payload.windowId);
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `移除发布窗口${win ? `（${win.label}）` : ''}，批次将按容量重算` });
    },
    markRemoteConfirmed(state, action: PayloadAction<{ trainId: string; gateId: string }>) {
      const train = state.trains.find((item) => item.id === action.payload.trainId);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate) return;
      gate.remoteState = 'confirmed';
      gate.remoteError = undefined;
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `${gate.repository} 排期远端确认成功，所在批次已定` });
    },
    markRemoteFailed(state, action: PayloadAction<{ trainId: string; gateId: string; error: string }>) {
      const train = state.trains.find((item) => item.id === action.payload.trainId);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate) return;
      gate.remoteState = 'failed';
      gate.remoteError = action.payload.error;
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `${gate.repository} 排期远端确认失败：${action.payload.error}；已确认批次保留，仅重试未确定仓库` });
    },
    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; }
  }
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    }),
    confirmSchedule: builder.mutation<{ ok: boolean; gateId: string }, { trainId: string; gateId: string }>({
      async queryFn({ trainId, gateId }, api) {
        await delay(400 + Math.random() * 500);
        const root = api.getState() as { train: TrainState };
        const train = root.train.trains.find((item) => item.id === trainId);
        const gate = train?.gates.find((item) => item.id === gateId);
        if (!train || !gate) {
          return { error: { status: 404, data: { message: '仓库或列车不存在' } } };
        }
        // 远端门禁：仓库门禁未确认时不接受排期。失败时保留其他已定批次，仅重试本仓库。
        if (gate.status !== 'confirmed') {
          const message = '门禁未确认，远端不接受该仓库排期';
          api.dispatch(markRemoteFailed({ trainId, gateId, error: message }));
          return { error: { status: 409, data: { message } } };
        }
        api.dispatch(markRemoteConfirmed({ trainId, gateId }));
        return { data: { ok: true, gateId } };
      }
    })
  })
});

export const { useConfirmScheduleMutation, useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain,
  addWindow,
  confirmGate,
  createTrain,
  markRemoteConfirmed,
  markRemoteFailed,
  removeWindow,
  replaceState,
  resolveBlocker,
  setFreeze,
  updateWindow
} = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  try {
    const saved = localStorage.getItem('yf53-release-state');
    if (saved) {
      const migrated = migrateState(JSON.parse(saved));
      if (migrated) store.dispatch(replaceState(migrated));
    }
  } catch {
    // 旧稿损坏时回退到初始状态，不阻塞使用
  }
  store.subscribe(() => {
    try {
      localStorage.setItem('yf53-release-state', JSON.stringify(store.getState().train));
    } catch {
      // 存储不可用时忽略
    }
  });
}

export type RootState = ReturnType<typeof store.getState>;
