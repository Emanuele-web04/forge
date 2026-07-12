// FILE: shellRefreshCoordinator.ts
// Purpose: Single sequence-aware shell refresh entry owned by EventRouter.
// Layer: Client orchestration bridge

import type {
  NativeApi,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
} from "@synara/contracts";

export type ShellRefreshResult = {
  applied: boolean;
  shellThreadCount: number;
  reason: "ok" | "empty" | "stale" | "unavailable" | "error" | "confirmed-empty";
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

export function isShellSnapshotApplyRegistered(): boolean {
  return registeredApply !== null;
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

/** Skip shell thread upsert/remove when detail fence is at least as new as the event. */
export function shouldSkipShellThreadMutation(
  detailSequence: number | undefined,
  eventSequence: number,
  eventKind: "thread-upserted" | "thread-removed" = "thread-upserted",
): boolean {
  if (detailSequence === undefined) {
    return false;
  }
  return eventKind === "thread-removed"
    ? detailSequence > eventSequence
    : detailSequence >= eventSequence;
}

let mutationLease = 0;

/** Bump when recovery effects cancel so in-flight refresh awaits discard apply/repair. */
export function bumpRecoveryMutationLease(): void {
  mutationLease += 1;
}

export function getRecoveryMutationLease(): number {
  return mutationLease;
}

let inFlightRepair: Promise<OrchestrationReadModel> | null = null;

/** Request a server-side repairState, coalescing concurrent callers so only one
 *  projection repair is in flight at a time. The RPC itself cannot be aborted once
 *  submitted; callers must still use the mutation lease to discard stale results. */
export function requestRepairState(api: NativeApi): Promise<OrchestrationReadModel> {
  if (inFlightRepair) {
    return inFlightRepair;
  }
  const promise = api.orchestration.repairState().finally(() => {
    if (inFlightRepair === promise) {
      inFlightRepair = null;
    }
  });
  inFlightRepair = promise;
  return promise;
}
