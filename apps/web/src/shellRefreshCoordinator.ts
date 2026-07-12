// FILE: shellRefreshCoordinator.ts
// Purpose: Single sequence-aware shell refresh entry owned by EventRouter.
// Layer: Client orchestration bridge

import type { OrchestrationShellSnapshot } from "@synara/contracts";

export type ShellRefreshResult = {
  applied: boolean;
  shellThreadCount: number;
  reason: "ok" | "empty" | "stale" | "unavailable" | "error";
};

type ShellRefreshFn = () => Promise<ShellRefreshResult>;

let registeredRefresh: ShellRefreshFn | null = null;
let epoch = 0;
const epochListeners = new Set<() => void>();

export function registerShellRefreshRequest(fn: ShellRefreshFn | null): void {
  registeredRefresh = fn;
}

export function requestShellRefresh(): Promise<ShellRefreshResult> {
  if (!registeredRefresh) {
    return Promise.resolve({
      applied: false,
      shellThreadCount: 0,
      reason: "unavailable",
    });
  }
  return registeredRefresh();
}

type ShellSnapshotApplyFn = (snapshot: OrchestrationShellSnapshot) => boolean;

let registeredApply: ShellSnapshotApplyFn | null = null;

export function registerShellSnapshotApply(fn: ShellSnapshotApplyFn | null): void {
  registeredApply = fn;
}

/** Sequence-fenced apply owned by EventRouter; no-ops if unregistered. */
export function tryApplyShellSnapshot(snapshot: OrchestrationShellSnapshot): boolean {
  return registeredApply?.(snapshot) ?? false;
}

export function bumpShellRefreshEpoch(): void {
  epoch += 1;
  for (const listener of epochListeners) {
    listener();
  }
}

export function getShellRefreshEpoch(): number {
  return epoch;
}

export function subscribeShellRefreshEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
}

/** Reject snapshots older than the already-applied shell fence. */
export function shouldAcceptShellSnapshotSequence(
  currentFence: number,
  incomingSequence: number,
): boolean {
  if (currentFence < 0) {
    return true;
  }
  return incomingSequence >= currentFence;
}
