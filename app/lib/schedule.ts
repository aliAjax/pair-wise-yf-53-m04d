// 发布窗口排期：按仓库门禁依赖做拓扑排序，再按各窗口容量分批。
// 被依赖的上游进前窗；满窗时排队顺延下一窗，依赖关系始终保持。

import type { ReleaseTrain, RepositoryGate } from '../store';

export interface HeldGate {
  gateId: string;
  reason: string;
}

export interface ScheduleBatch {
  windowId: string;
  gateIds: string[];
}

export interface ScheduleResult {
  /** 拓扑排序后的仓库 id（被依赖的上游在前） */
  order: string[];
  /** 每个窗口的批次（已跳过空窗） */
  batches: ScheduleBatch[];
  /** 未进批次的仓库：窗口容量不足，排队顺延 */
  queued: string[];
  /** 不进批次的仓库：有未关闭阻断问题（含被连带拖住的下游） */
  held: HeldGate[];
  /** 环上的仓库名；无环为 null */
  cycle: string[] | null;
}

/** 解析 "name@version" 依赖声明，返回 { name, version }；非法返回 null。 */
export function parseDependency(dep: string): { name: string; version: string } | null {
  const text = (dep ?? '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0) return null;
  const name = text.slice(0, at).trim();
  const version = text.slice(at + 1).trim();
  if (!name || !version) return null;
  return { name, version };
}

/** gateId -> 该仓库依赖的上游 gateId 列表（仅列本列车内的仓库）。 */
function dependencyEdges(gates: RepositoryGate[]): Map<string, string[]> {
  const byName = new Map(gates.map((g) => [g.repository, g]));
  const edges = new Map<string, string[]>();
  for (const g of gates) {
    const parsed = parseDependency(g.dependency);
    if (!parsed) {
      edges.set(g.id, []);
      continue;
    }
    const upstream = byName.get(parsed.name);
    edges.set(g.id, upstream ? [upstream.id] : []);
  }
  return edges;
}

/** 用 DFS 找环，返回环上的仓库名列表；无环返回 null。 */
export function findCycle(gates: RepositoryGate[]): string[] | null {
  const edges = dependencyEdges(gates);
  const color = new Map<string, number>(gates.map((g) => [g.id, 0])); // 0=白 1=灰 2=黑
  const stack: string[] = [];
  let cycle: string[] | null = null;
  function dfs(u: string) {
    if (cycle) return;
    color.set(u, 1);
    stack.push(u);
    for (const v of edges.get(u) ?? []) {
      const c = color.get(v);
      if (c === 1) {
        const start = stack.indexOf(v);
        cycle = stack.slice(start).map((id) => gates.find((g) => g.id === id)?.repository ?? id);
        return;
      }
      if (c === 0) dfs(v);
      if (cycle) return;
    }
    stack.pop();
    color.set(u, 2);
  }
  for (const g of gates) {
    if (color.get(g.id) === 0) dfs(g.id);
  }
  return cycle;
}

/** Kahn 拓扑排序；并列项保持仓库原始次序，结果稳定可复现。 */
export function topoOrder(gates: RepositoryGate[]): string[] {
  const edges = dependencyEdges(gates);
  const indeg = new Map<string, number>();
  for (const g of gates) indeg.set(g.id, 0);
  for (const [u, ups] of edges) {
    for (const v of ups) indeg.set(u, (indeg.get(u) ?? 0) + 1);
  }
  const position = new Map(gates.map((g, i) => [g.id, i]));
  const ready = gates.filter((g) => (indeg.get(g.id) ?? 0) === 0).map((g) => g.id);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    const u = ready.shift()!;
    order.push(u);
    for (const [w, ups] of edges) {
      if (ups.includes(u)) {
        const next = (indeg.get(w) ?? 0) - 1;
        indeg.set(w, next);
        if (next === 0) ready.push(w);
      }
    }
  }
  return order;
}

/** 有未关闭阻断问题的仓库不进批次；依赖传递：上游被阻断时下游同样暂缓。 */
export function heldGates(train: ReleaseTrain): HeldGate[] {
  const reasons = new Map<string, string>();
  for (const g of train.gates) {
    if (g.status === 'blocked') {
      reasons.set(g.id, '门禁状态为 blocked');
      continue;
    }
    const blocker = train.blockers.find(
      (b) => !b.resolved && (b.repository === g.repository || (!b.repository && b.title.includes(g.repository)))
    );
    if (blocker) reasons.set(g.id, `未关闭阻断：${blocker.title}`);
  }
  const edges = dependencyEdges(train.gates);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of train.gates) {
      if (reasons.has(g.id)) continue;
      if ((edges.get(g.id) ?? []).some((u) => reasons.has(u))) {
        reasons.set(g.id, '依赖的上游仓库被阻断');
        changed = true;
      }
    }
  }
  return train.gates.filter((g) => reasons.has(g.id)).map((g) => ({ gateId: g.id, reason: reasons.get(g.id)! }));
}

/**
 * 按窗口容量分批：先拓扑排序，再顺序装窗。
 * 上游进前一窗，当前窗装满后顺延下一窗；窗口不足时剩余仓库排队。
 */
export function computeSchedule(train: ReleaseTrain): ScheduleResult {
  const held = heldGates(train);
  const heldIds = new Set(held.map((h) => h.gateId));
  const active = train.gates.filter((g) => !heldIds.has(g.id));

  const cycle = findCycle(active);
  if (cycle) return { order: [], batches: [], queued: [], held, cycle };

  const order = topoOrder(active);
  const batches: ScheduleBatch[] = [];
  const queued: string[] = [];
  let wi = 0;
  let used = 0;
  for (const id of order) {
    while (wi < train.windows.length && used >= train.windows[wi].capacity) {
      wi += 1;
      used = 0;
    }
    if (wi >= train.windows.length) {
      queued.push(id);
      continue;
    }
    if (!batches[wi]) batches[wi] = { windowId: train.windows[wi].id, gateIds: [] };
    batches[wi].gateIds.push(id);
    used += 1;
  }
  return { order, batches: batches.filter((b) => b && b.gateIds.length > 0), queued, held, cycle: null };
}
