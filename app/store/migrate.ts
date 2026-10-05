// localStorage 旧稿升级：浏览器里存的草稿升级后要能继续用。
// 历史版本：v1 只有 gates/blockers/audit；v2 增加 windows、gate.remoteState、blocker.repository。

import type { ReleaseTrain, TrainState } from '../store';

export const STORAGE_VERSION = 2;

const DEFAULT_WINDOW_CAPACITY = 3;

function defaultWindows(prefix: string): ReleaseTrain['windows'] {
  return [1, 2, 3].map((i) => ({ id: `${prefix}-w${i}`, label: `第${i}窗`, capacity: DEFAULT_WINDOW_CAPACITY }));
}

/** 旧稿的阻断项没有关联仓库，用标题中出现的仓库名猜测关联。 */
function guessRepository(title: string, gates: ReleaseTrain['gates']): string | undefined {
  return gates.find((g) => title.includes(g.repository))?.repository;
}

function migrateV1ToV2(state: TrainState): TrainState {
  return {
    ...state,
    trains: state.trains.map((t) => ({
      ...t,
      windows:
        Array.isArray(t.windows) && t.windows.length > 0
          ? t.windows
          : defaultWindows(t.id),
      gates: t.gates.map((g) => ({ ...g, remoteState: g.remoteState ?? 'idle' })),
      blockers: t.blockers.map((b) => ({
        ...b,
        repository: b.repository ?? guessRepository(b.title, t.gates)
      }))
    }))
  };
}

/** 补齐缺失字段、收敛非法值，保证任意半残旧稿都能被规范化。 */
function normalize(state: TrainState): TrainState {
  const trainIds = new Set(state.trains.map((t) => t.id));
  return {
    ...state,
    activeId: trainIds.has(state.activeId) ? state.activeId : state.trains[0]?.id ?? state.activeId,
    trains: state.trains.map((t) => ({
      ...t,
      windows:
        Array.isArray(t.windows) && t.windows.length > 0
          ? t.windows.map((w) => ({ ...w, capacity: Math.max(1, Math.round(Number(w.capacity) || 1)) }))
          : defaultWindows(t.id),
      gates: t.gates.map((g) => ({ ...g, remoteState: g.remoteState ?? 'idle' })),
      blockers: t.blockers.map((b) => ({ ...b })),
      audit: Array.isArray(t.audit) ? t.audit : []
    }))
  };
}

/** 把任意解析出的旧状态升级为当前版本；无法识别时返回 null（调用方回退到初始状态）。 */
export function migrateState(raw: unknown): TrainState | null {
  try {
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.trains)) return null;
    let state = obj as unknown as TrainState;
    const version = typeof obj.version === 'number' ? obj.version : 1;
    if (version < STORAGE_VERSION) state = migrateV1ToV2(state);
    state = normalize(state);
    state.version = STORAGE_VERSION;
    return state;
  } catch {
    return null;
  }
}
