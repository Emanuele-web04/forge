// FILE: stagedDraftNavigation.ts
// Purpose: Serializes draft-route creation per project slot and finalizes staged drafts only
//          after their destination route actually commits.
// Layer: Web navigation orchestration

import type { ThreadId } from "@synara/contracts";

const inFlightDraftNavigationBySlot = new Map<string, Promise<unknown>>();
const inFlightDraftThreadIds = new Set<ThreadId>();

export function draftNavigationSlotKey(projectId: string, entryPoint: string): string {
  return `${projectId}\u0000${entryPoint}`;
}

/** Returns the set of draft thread ids currently between `stage` and `finalize`/`rollback`. */
export function getInFlightDraftThreadIds(): ReadonlySet<ThreadId> {
  return inFlightDraftThreadIds;
}

/** Coalesces repeated clicks/shortcuts that target the same project + entry-point slot. */
export function runDraftNavigationOnce<T>(slotKey: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlightDraftNavigationBySlot.get(slotKey) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }

  const operation = Promise.resolve().then(run);
  inFlightDraftNavigationBySlot.set(slotKey, operation);
  const clearOperation = () => {
    if (inFlightDraftNavigationBySlot.get(slotKey) === operation) {
      inFlightDraftNavigationBySlot.delete(slotKey);
    }
  };
  void operation.then(clearOperation, clearOperation);
  return operation;
}

/**
 * Keeps the previous routed draft alive while the destination loads. A superseding navigation
 * rolls the staged draft back without treating the user's newer navigation as an error.
 */
export async function stageDraftNavigation(input: {
  readonly draftThreadId?: ThreadId;
  readonly stage: () => void;
  readonly navigate: () => Promise<void>;
  readonly isDestinationActive: () => boolean;
  readonly finalize: () => void;
  readonly rollback: () => void;
}): Promise<boolean> {
  const { draftThreadId } = input;
  if (draftThreadId) {
    inFlightDraftThreadIds.add(draftThreadId);
  }

  let rolledBack = false;
  const rollbackOnce = () => {
    if (rolledBack) {
      return;
    }
    rolledBack = true;
    input.rollback();
    if (draftThreadId) {
      inFlightDraftThreadIds.delete(draftThreadId);
    }
  };

  try {
    input.stage();
    await input.navigate();
    if (!input.isDestinationActive()) {
      rollbackOnce();
      return false;
    }
    input.finalize();
    if (draftThreadId) {
      inFlightDraftThreadIds.delete(draftThreadId);
    }
    return true;
  } catch (error) {
    rollbackOnce();
    throw error;
  }
}
