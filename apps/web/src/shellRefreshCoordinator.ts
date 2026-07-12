// FILE: shellRefreshCoordinator.ts
// Purpose: Single sequence-aware shell refresh entry owned by EventRouter.
// Layer: Client orchestration bridge

export type ShellRefreshResult = {
  applied: boolean;
  shellThreadCount: number;
  reason: "ok" | "empty" | "stale" | "unavailable" | "error";
};

export type ShellRefreshOptions = {
  includeReadModel?: boolean;
};

type ShellRefreshFn = (options?: ShellRefreshOptions) => Promise<ShellRefreshResult>;

let registeredRefresh: ShellRefreshFn | null = null;
let epoch = 0;
const epochListeners = new Set<() => void>();

export function registerShellRefreshRequest(fn: ShellRefreshFn | null): void {
  registeredRefresh = fn;
}

export function requestShellRefresh(options?: ShellRefreshOptions): Promise<ShellRefreshResult> {
  if (!registeredRefresh) {
    return Promise.resolve({
      applied: false,
      shellThreadCount: 0,
      reason: "unavailable",
    });
  }
  return registeredRefresh(options);
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
