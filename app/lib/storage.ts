import type { ReleaseTrain, RepositoryGate } from './types';

/**
 * localStorage 持久化与版本迁移。
 * 升级后浏览器里存的旧稿必须能继续用：loadDraft 按 version 逐版升级。
 */
export const STORAGE_KEY = 'yf53-release-state-v2';
/** 上一版（骨架期手工排序）使用的 key */
const LEGACY_KEY = 'yf53-release-state';
export const STATE_VERSION = 2;

export interface PersistedStateV2 {
  version: 2;
  activeId: string;
  trains: ReleaseTrain[];
}

/** v1 结构（骨架版本，只有 dependency 单个字符串，无 capacity/批次概念） */
interface LegacyGateV1 {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: 'pending' | 'confirmed' | 'blocked';
  version: string;
}
interface LegacyTrainV1 {
  id: string;
  name: string;
  freezeAt: string;
  status: ReleaseTrain['status'];
  gates: LegacyGateV1[];
  blockers: Array<{ id: string; title: string; severity: string; resolved: boolean }>;
  audit: ReleaseTrain['audit'];
}
interface LegacyStateV1 {
  activeId: string;
  trains: LegacyTrainV1[];
}

export const DEFAULT_CAPACITY = 3;

function migrateV1Gate(gate: LegacyGateV1, all: LegacyGateV1[]): RepositoryGate {
  // v1 的 dependency 形如 "gateway@2.12"，按仓库名前缀匹配到具体仓库 id
  const depName = gate.dependency.split('@')[0]?.trim();
  const match = depName ? all.find((other) => other.repository === depName) : undefined;
  return {
    id: gate.id,
    repository: gate.repository,
    owner: gate.owner,
    dependsOn: match && match.id !== gate.id ? [match.id] : [],
    blocked: gate.status === 'blocked',
    blockerReason: gate.status === 'blocked' ? '旧稿迁移：门禁处于 blocked 状态' : undefined,
    version: gate.version
  };
}

export function migrateV1(raw: LegacyStateV1): PersistedStateV2 {
  return {
    version: 2,
    activeId: raw.activeId,
    trains: raw.trains.map((train) => {
      const gates = train.gates.map((gate) => migrateV1Gate(gate, train.gates));
      // 旧稿里已经 confirmed 的门禁视为已与远端定好：v2 下没有批次信息，
      // 迁移后需要由负责人重新确认排期（状态保留为 unconfirmed，但审计有迹可循）。
      const migratedCount = train.gates.filter((gate) => gate.status === 'confirmed').length;
      return {
        id: train.id,
        name: train.name,
        freezeAt: train.freezeAt,
        status: train.status,
        capacity: DEFAULT_CAPACITY,
        gates,
        confirmations: {},
        audit: [
          {
            id: `a-migrate-${train.id}-${Date.now()}`,
            at: new Date().toLocaleTimeString(),
            text: `旧稿已从 v1 升级：${gates.length} 个仓库、${migratedCount} 个历史确认需按新批次重新确认`
          },
          ...train.audit
        ]
      };
    })
  };
}

/** 容错读取：损坏的 JSON 或无法识别的结构返回 undefined，由调用方回退初始数据 */
export function loadDraft(fallback: PersistedStateV2): PersistedStateV2 {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedStateV2> & LegacyStateV1;

    if ((parsed as PersistedStateV2).version === 2 && Array.isArray(parsed.trains)) {
      return normalizeV2(parsed as PersistedStateV2);
    }
    // 无 version 字段的一律视为 v1 旧稿
    if (Array.isArray(parsed.trains)) {
      return migrateV1(parsed as LegacyStateV1);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** 补齐后续小版本可能缺失的字段，保证旧稿在新版代码下不崩 */
function normalizeV2(state: PersistedStateV2): PersistedStateV2 {
  return {
    version: 2,
    activeId: state.activeId,
    trains: state.trains.map((train) => ({
      ...train,
      capacity: Number.isFinite(train.capacity) ? train.capacity : DEFAULT_CAPACITY,
      gates: train.gates.map((gate) => ({
        ...gate,
        dependsOn: Array.isArray(gate.dependsOn) ? [...new Set(gate.dependsOn)] : []
      })),
      confirmations: train.confirmations ?? {}
    }))
  };
}

export function saveDraft(state: PersistedStateV2): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
