import type {
  ModelSelection,
  OrchestrationSession,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";

export function deriveTurnStartModelSelection(input: {
  readonly currentModelSelection: ModelSelection;
  readonly requestedModelSelection: ModelSelection | undefined;
  readonly canAdoptRequestedProvider: boolean;
}): ModelSelection {
  const requestedModelSelection = input.requestedModelSelection;
  return requestedModelSelection !== undefined &&
    (requestedModelSelection.provider === input.currentModelSelection.provider ||
      input.canAdoptRequestedProvider)
    ? requestedModelSelection
    : input.currentModelSelection;
}

export function deriveTurnStartSession(input: {
  readonly threadId: ThreadId;
  readonly currentSession: OrchestrationSession | null;
  readonly providerName: OrchestrationSession["providerName"];
  readonly requestedRuntimeMode: RuntimeMode;
  readonly requestedAt: string;
  /**
   * Whether the projected session's provider binding is established (running,
   * ready, or has already produced a turn). A pre-turn optimistic placeholder
   * row can carry a stale provider; when this is false the session's own
   * providerName is ignored in favor of input.providerName.
   */
  readonly sessionProviderEstablished?: boolean;
}): OrchestrationSession | null {
  if (input.currentSession?.status === "starting" || input.currentSession?.status === "running") {
    return null;
  }

  const sessionProviderName =
    input.currentSession?.providerName != null && input.sessionProviderEstablished !== false
      ? input.currentSession.providerName
      : undefined;

  return {
    threadId: input.threadId,
    status: "starting",
    providerName: sessionProviderName ?? input.providerName,
    runtimeMode: input.currentSession?.runtimeMode ?? input.requestedRuntimeMode,
    activeTurnId: null,
    lastError: null,
    updatedAt: input.requestedAt,
  };
}
