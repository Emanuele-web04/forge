// FILE: threadRuntimeStop.ts
// Purpose: Client helpers for stopping an idle thread's provider runtime process.
// Layer: Web provider helper
// Exports: stopIdleRuntimeSessionFromClient, canOfferStopAgentProcess,
//          isStopAgentProcessBlockedByActiveTurn

import type { NativeApi, ThreadId, TurnId } from "@synara/contracts";

import { isSessionRunningTurn } from "../session-logic";

type StopIdleRuntimeSessionApi = Pick<NativeApi["provider"], "stopIdleRuntimeSession">;

type StopAgentProcessSessionView = {
  status: string;
  activeTurnId?: TurnId | null | undefined;
};

/**
 * True when the thread's projected session might still own a live agent CLI.
 * Disconnected/closed/error sessions have nothing useful to stop.
 */
export function canOfferStopAgentProcess(
  session: StopAgentProcessSessionView | null | undefined,
): boolean {
  if (!session) return false;
  return (
    session.status === "ready" || session.status === "running" || session.status === "connecting"
  );
}

/** Mid-flight turns must be interrupted first; stopping the process is refused. */
export function isStopAgentProcessBlockedByActiveTurn(
  session: StopAgentProcessSessionView | null | undefined,
): boolean {
  return isSessionRunningTurn(session);
}

/** Ask the server to stop an idle-ready agent process while preserving resume. */
export async function stopIdleRuntimeSessionFromClient(
  api: StopIdleRuntimeSessionApi,
  threadId: ThreadId,
): Promise<void> {
  await api.stopIdleRuntimeSession({ threadId });
}
