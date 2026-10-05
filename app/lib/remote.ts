import type { BatchWindow } from './types';

export interface RemoteConfirmRequest {
  trainId: string;
  gateId: string;
  windowIndex: number;
}

export interface RemoteConfirmResponse {
  gateId: string;
  windowIndex: number;
  confirmedAt: string;
}

export type RemoteConfirm = (request: RemoteConfirmRequest) => Promise<RemoteConfirmResponse>;

/**
 * 模拟远端排期系统。failNext 次调用会失败，用于演示
 * “远端确认失败后保留已定批次，只重试没定下来的仓库”。
 */
export function createRemoteScheduler(options?: { failNext?: () => boolean; delayMs?: number }): RemoteConfirm {
  const delayMs = options?.delayMs ?? 350;
  return async (request) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (options?.failNext?.()) {
      throw new Error(`远端排期确认失败：仓库 ${request.gateId} 的窗口 ${request.windowIndex + 1} 未被受理`);
    }
    return { gateId: request.gateId, windowIndex: request.windowIndex, confirmedAt: new Date().toISOString() };
  };
}

/** 只收集当前未敲定（unconfirmed/failed）的仓库；confirmed 不重复提交 */
export function pendingFromWindows(
  windows: BatchWindow[],
  isPending: (gateId: string) => boolean
): RemoteConfirmRequest[] {
  const requests: RemoteConfirmRequest[] = [];
  for (const win of windows) {
    for (const assignment of win.assignments) {
      if (isPending(assignment.gateId)) {
        requests.push({ trainId: '', gateId: assignment.gateId, windowIndex: win.index });
      }
    }
  }
  return requests;
}

/** 测试/演示用：替换远端实现（如立即失败、零延迟）。经 globalThis 桥接，避免不同模块实例各持一份 */
export function _setRemoteSchedulerForTest(scheduler: RemoteConfirm | undefined): void {
  (globalThis as { __yf53RemoteScheduler__?: RemoteConfirm }).__yf53RemoteScheduler__ = scheduler;
}

export function resolveRemoteScheduler(defaultScheduler: RemoteConfirm): RemoteConfirm {
  return (globalThis as { __yf53RemoteScheduler__?: RemoteConfirm }).__yf53RemoteScheduler__ ?? defaultScheduler;
}
