import type {
  BatchWindow,
  DependencyCycle,
  ScheduleInput,
  SchedulePlan,
  UnscheduledGate,
  UnscheduledReason
} from './types';

/**
 * 在依赖图里找环（Tarjan 强连通分量）。
 * 大小 > 1 的分量、以及自环，都会阻断发布。
 */
export function findCycles(gateIds: string[], dependsOn: Map<string, string[]>): DependencyCycle[] {
  let nextIndex = 0;
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const visit = (v: string): void => {
    indexOf.set(v, nextIndex);
    low.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of (dependsOn.get(v) ?? []).slice().sort()) {
      if (!gateIds.includes(w)) continue; // 缺失依赖不算环，单独处理
      if (!indexOf.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indexOf.get(w)!));
      }
    }

    if (low.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      sccs.push(component);
    }
  };

  for (const id of [...gateIds].sort()) {
    if (!indexOf.has(id)) visit(id);
  }

  const cycles: DependencyCycle[] = [];
  for (const component of sccs) {
    const nodes = [...component].sort();
    const selfLoop = component.length === 1 && (dependsOn.get(component[0]) ?? []).includes(component[0]);
    if (component.length > 1 || selfLoop) {
      cycles.push({ nodes, path: describeCycle(nodes, dependsOn) });
    }
  }
  cycles.sort((a, b) => (a.nodes[0] < b.nodes[0] ? -1 : a.nodes[0] > b.nodes[0] ? 1 : 0));
  return cycles;
}

/** 在环内沿依赖边走一圈，给出 ["a", "b", "c", "a"] 的点名路径 */
function describeCycle(nodes: string[], dependsOn: Map<string, string[]>): string[] {
  const inCycle = new Set(nodes);
  const start = nodes[0];

  const dfs = (current: string, path: string[], visited: Set<string>): string[] | undefined => {
    for (const next of (dependsOn.get(current) ?? []).filter((id) => inCycle.has(id)).sort()) {
      if (next === start && path.length >= 1) return [...path, start];
      if (visited.has(next)) continue;
      const found = dfs(next, [...path, next], new Set(visited).add(next));
      if (found) return found;
    }
    return undefined;
  };

  return dfs(start, [start], new Set([start])) ?? [start, start];
}

/** Kahn 拓扑序；平局按 id 字典序，保证每次重算结果一致 */
export function topoOrder(gateIds: string[], dependsOn: Map<string, string[]>): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of gateIds) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of gateIds) {
    for (const dep of dependsOn.get(id) ?? []) {
      if (!gateIds.includes(dep)) continue;
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      dependents.get(dep)!.push(id);
    }
  }
  const ready = gateIds.filter((id) => (indegree.get(id) ?? 0) === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of (dependents.get(id) ?? []).slice().sort()) {
      const deg = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, deg);
      if (deg === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  return order;
}

export interface InternalGate {
  id: string;
  blocked: boolean;
  deps: string[];
}

/** 计算每个仓库不能进批次的根因（阻断问题 / 上游阻断 / 缺失依赖 / 环） */
export function classifyUnscheduled(
  gates: InternalGate[],
  cycles: DependencyCycle[]
): Map<string, UnscheduledGate> {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const onCycle = new Set(cycles.flatMap((cycle) => cycle.nodes));
  const result = new Map<string, UnscheduledGate>();
  const put = (gateId: string, reason: UnscheduledReason, causedBy?: string[]): void => {
    if (!result.has(gateId)) result.set(gateId, { gateId, reason, causedBy });
  };

  for (const gate of gates) {
    if (onCycle.has(gate.id)) put(gate.id, 'upstream-cycle', cycles.find((c) => c.nodes.includes(gate.id))!.nodes);
  }

  // 阻断沿依赖边向下游传播，给出直接责任仓库
  const resolve = (id: string, stack: Set<string>): UnscheduledGate | undefined => {
    if (result.has(id)) return result.get(id);
    if (stack.has(id)) return undefined; // 有环已在上面处理
    stack.add(id);

    const gate = byId.get(id);
    if (!gate) return undefined;
    if (gate.blocked) {
      put(id, 'open-blocker');
      return result.get(id);
    }
    for (const dep of gate.deps) {
      if (!byId.has(dep)) {
        put(id, 'upstream-missing', [dep]);
        continue;
      }
      if (onCycle.has(dep)) {
        put(id, 'upstream-cycle', [dep]);
        continue;
      }
      const up = resolve(dep, stack);
      if (up) {
        const reason: UnscheduledReason = up.reason === 'open-blocker' ? 'upstream-blocked' : up.reason;
        put(id, reason, [dep]);
      }
    }
    stack.delete(id);
    return result.get(id);
  };

  for (const gate of gates) resolve(gate.id, new Set());
  return result;
}

/**
 * 发布列车排期核心：
 * 1. 依赖成环 -> 拦下发布，点名环上仓库；
 * 2. 有未关闭阻断问题的仓库不进批次，其下游标记原因；
 * 3. 被依赖的上游必须落在严格更早的窗口；
 * 4. 窗口容量满则顺延下一窗；
 * 5. 已确认锁定的批次优先保留，容量/依赖改动后只重算未定的仓库。
 */
export function planSchedule(input: ScheduleInput): SchedulePlan {
  const { gates, locks = {} } = input;
  const capacity = Math.max(1, Math.floor(input.capacity) || 1);

  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const gateIds = gates.map((gate) => gate.id);
  const dependsOn = new Map<string, string[]>(
    gates.map((gate) => [gate.id, [...new Set(gate.dependsOn)].sort()])
  );

  const cycles = findCycles(gateIds, dependsOn);
  if (cycles.length) {
    const unscheduled = classifyUnscheduled(
      gates.map((gate) => ({ id: gate.id, blocked: gate.blocked, deps: dependsOn.get(gate.id)! })),
      cycles
    );
    return {
      ok: false,
      cycles,
      windows: [],
      unscheduled: [...unscheduled.values()].sort(compareGate),
      lockConflicts: []
    };
  }

  const unscheduled = classifyUnscheduled(
    gates.map((gate) => ({ id: gate.id, blocked: gate.blocked, deps: dependsOn.get(gate.id)! })),
    []
  );

  const order = topoOrder(gateIds, dependsOn);
  const orderIndex = new Map(order.map((id, i) => [id, i]));

  // 锁定仓库：只保留仍可发布的；原批次窗口不动
  const windowOf = new Map<string, number>();
  const windows: BatchWindow[] = [];
  for (const [gateId, rawIndex] of Object.entries(locks)) {
    if (!byId.has(gateId) || unscheduled.has(gateId)) continue;
    const index = Math.max(0, Math.floor(rawIndex) || 0);
    windowOf.set(gateId, index);
    if (!windows[index]) windows[index] = { index, assignments: [], capacity, overflow: false };
    windows[index].assignments.push({ gateId: gateId, order: orderIndex.get(gateId) ?? Number.MAX_SAFE_INTEGER });
  }

  // 未锁定的仓库按拓扑序贪心放入「晚于所有上游」的第一个有空位窗口
  for (const id of order) {
    if (windowOf.has(id) || unscheduled.has(id)) continue;
    let earliest = 0;
    for (const dep of dependsOn.get(id) ?? []) {
      const depWindow = windowOf.get(dep);
      if (depWindow !== undefined) earliest = Math.max(earliest, depWindow + 1);
    }
    let index = earliest;
    while ((windows[index]?.assignments.length ?? 0) >= capacity) index += 1;
    if (!windows[index]) windows[index] = { index, assignments: [], capacity, overflow: false };
    windows[index].assignments.push({ gateId: id, order: orderIndex.get(id) ?? Number.MAX_SAFE_INTEGER });
    windowOf.set(id, index);
  }

  const resultWindows = windows.filter(Boolean);
  for (const win of resultWindows) {
    win.capacity = capacity;
    win.assignments.sort((a, b) => a.order - b.order || (a.gateId < b.gateId ? -1 : a.gateId > b.gateId ? 1 : 0));
    win.overflow = win.assignments.length > capacity;
  }

  // 依赖/容量改动后，锁定批次若不再早于上游，保留但点名告警，由负责人撤回确认
  const lockConflicts: SchedulePlan['lockConflicts'] = [];
  for (const [gateId, index] of Object.entries(locks)) {
    if (!byId.has(gateId) || unscheduled.has(gateId)) continue;
    for (const dep of dependsOn.get(gateId) ?? []) {
      const depWindow = windowOf.get(dep);
      if (depWindow !== undefined && depWindow >= index) {
        lockConflicts.push({ gateId, windowIndex: index, upstream: dep, upstreamWindow: depWindow });
      }
    }
  }

  return {
    ok: true,
    cycles: [],
    windows: resultWindows,
    unscheduled: [...unscheduled.values()].sort(compareGate),
    lockConflicts
  };
}

function compareGate(a: UnscheduledGate, b: UnscheduledGate): number {
  return a.gateId < b.gateId ? -1 : a.gateId > b.gateId ? 1 : 0;
}
