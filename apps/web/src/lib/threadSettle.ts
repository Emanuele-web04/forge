// FILE: threadSettle.ts
// Purpose: Dispatches the thread settle/unsettle toggle from the client.
// Layer: Web orchestration helper
// Exports: setThreadSettledFromClient

import type { NativeApi, ThreadId } from "@synara/contracts";

import { newCommandId } from "./utils";

type ThreadCommandDispatcher = Pick<NativeApi["orchestration"], "dispatchCommand">;

export interface OptimisticSettledMutation {
  readonly desiredSettled: boolean;
  /** Durable sequence returned after the latest settle command is accepted. */
  readonly commandSequence: number | null;
  /**
   * True once the projection has represented a state different from the latest
   * desired value. This prevents Done → Undo from treating the pre-Done snapshot
   * as acknowledgement of Undo before either command has projected.
   */
  readonly observedDifferentState: boolean;
}

export function createOptimisticSettledMutation(input: {
  desiredSettled: boolean;
  serverSettledAtDispatch: boolean;
}): OptimisticSettledMutation {
  return {
    desiredSettled: input.desiredSettled,
    commandSequence: null,
    observedDifferentState: input.serverSettledAtDispatch !== input.desiredSettled,
  };
}

export function recordOptimisticSettledMutationSequence(
  mutation: OptimisticSettledMutation,
  commandSequence: number,
): OptimisticSettledMutation {
  if (mutation.commandSequence === commandSequence) return mutation;
  return { ...mutation, commandSequence };
}

export function reconcileOptimisticSettledMutation(
  mutation: OptimisticSettledMutation,
  serverSettled: boolean,
  projectionSequence: number = 0,
): { acknowledged: boolean; mutation: OptimisticSettledMutation } {
  // Reconnect replay can fold Done -> Undo into one store update, so the UI may
  // never render the intermediate boolean. The durable sequence proves that the
  // latest command has passed through the projection even in that batched case.
  if (mutation.commandSequence !== null && projectionSequence >= mutation.commandSequence) {
    return { acknowledged: true, mutation };
  }
  if (serverSettled === mutation.desiredSettled) {
    return { acknowledged: mutation.observedDifferentState, mutation };
  }
  if (mutation.observedDifferentState) {
    return { acknowledged: false, mutation };
  }
  return {
    acknowledged: false,
    mutation: { ...mutation, observedDifferentState: true },
  };
}

// Marks a thread settled (done, dimmed at the bottom of the Activity view) or
// restores it. The server stamps the authoritative `settledAt` timestamp from
// the `isSettled` intent, so two clients toggling concurrently converge on the
// last write instead of racing on client clocks.
export async function setThreadSettledFromClient(
  api: ThreadCommandDispatcher,
  threadId: ThreadId,
  isSettled: boolean,
): Promise<number> {
  const result = await api.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    isSettled,
  });
  return result.sequence;
}
