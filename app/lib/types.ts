/** 仓库门禁：发布列车上的最小排期单元 */
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  /** 该仓库依赖的上游仓库 id 列表（边：dependsOn -> 当前仓库） */
  dependsOn: string[];
  /** 存在未关闭阻断问题时为 true，排期引擎会把这样的仓库排除在批次之外 */
  blocked: boolean;
  blockerReason?: string;
  version: string;
}

/** 远端排期确认状态 */
export type ConfirmStatus = 'unconfirmed' | 'confirming' | 'confirmed' | 'failed';

export interface Confirmation {
  status: ConfirmStatus;
  /** 确认时锁定的窗口下标；confirmed/failed 会保留，重试只针对未定的仓库 */
  windowIndex?: number;
  message?: string;
  at?: string;
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  /** 每个发布窗口的容量：满了就顺延到下一窗 */
  capacity: number;
  gates: RepositoryGate[];
  /** key: gate.id；只记录非默认（unconfirmed）的确认信息 */
  confirmations: Record<string, Confirmation>;
  audit: AuditEntry[];
}

export interface AuditEntry {
  id: string;
  at: string;
  text: string;
}

/** 环上的一个仓库集合（强连通分量） */
export interface DependencyCycle {
  /** 按 id 排序的环上仓库 id */
  nodes: string[];
  /** 形如 "a -> b -> a" 的环路径点名 */
  path: string[];
}

export interface BatchAssignment {
  gateId: string;
  /** 稳定拓扑序（id 平局），仅用于批次内稳定排序 */
  order: number;
}

export interface BatchWindow {
  index: number;
  assignments: BatchAssignment[];
  capacity: number;
  /** 已锁定的确认占掉的容量把窗口顶爆时为 true */
  overflow: boolean;
}

export type UnscheduledReason =
  | 'open-blocker'
  | 'upstream-blocked'
  | 'upstream-missing'
  | 'upstream-cycle';

export interface UnscheduledGate {
  gateId: string;
  reason: UnscheduledReason;
  /** 造成顺延的直接原因仓库 id，便于 UI 点名 */
  causedBy?: string[];
}

export interface SchedulePlan {
  ok: boolean;
  cycles: DependencyCycle[];
  windows: BatchWindow[];
  unscheduled: UnscheduledGate[];
  /** 确认锁定与当前依赖/容量不一致的仓库（仍保留锁定批次，但显式告警） */
  lockConflicts: Array<{ gateId: string; windowIndex: number; upstream: string; upstreamWindow: number }>;
}

export interface ScheduleInput {
  gates: RepositoryGate[];
  capacity: number;
  /** key: gate.id -> 已与远端定好的窗口；排期时优先保留 */
  locks?: Record<string, number>;
}
