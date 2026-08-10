import type {
  ModelSelection,
  OrchestrationSession,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import {
  providerTargetFromModelSelection,
  providerTargetsEqual,
} from "@synara/shared/providerTarget";

export function canAdoptFirstTurnTarget(input: {
  readonly hasLatestTurn: boolean;
  readonly hasSession: boolean;
  readonly messageCount: number;
}): boolean {
  return !input.hasLatestTurn && !input.hasSession && input.messageCount <= 1;
}

export function deriveTurnStartModelSelection(input: {
  readonly currentModelSelection: ModelSelection;
  readonly requestedModelSelection: ModelSelection | undefined;
  readonly canAdoptRequestedTarget: boolean;
}): ModelSelection {
  const requestedModelSelection = input.requestedModelSelection;
  return requestedModelSelection !== undefined &&
    (providerTargetsEqual(
      providerTargetFromModelSelection(requestedModelSelection),
      providerTargetFromModelSelection(input.currentModelSelection),
    ) ||
      input.canAdoptRequestedTarget)
    ? requestedModelSelection
    : input.currentModelSelection;
}

export function deriveTurnStartSession(input: {
  readonly threadId: ThreadId;
  readonly currentSession: OrchestrationSession | null;
  readonly providerName: OrchestrationSession["providerName"];
  readonly requestedRuntimeMode: RuntimeMode;
  readonly requestedAt: string;
}): OrchestrationSession | null {
  if (input.currentSession?.status === "starting" || input.currentSession?.status === "running") {
    return null;
  }

  return {
    threadId: input.threadId,
    status: "starting",
    providerName: input.currentSession?.providerName ?? input.providerName,
    runtimeMode: input.currentSession?.runtimeMode ?? input.requestedRuntimeMode,
    activeTurnId: null,
    lastError: null,
    updatedAt: input.requestedAt,
  };
}
