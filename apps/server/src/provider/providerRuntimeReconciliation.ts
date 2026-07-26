/**
 * providerRuntimeReconciliation - Pure live runtime/projection convergence plan.
 *
 * Provider Adapter state is live evidence; the provider session directory is a
 * durable routing cache; orchestration is the UI read model. This planner finds
 * stale lifecycle divergence without inventing successful completion.
 *
 * @module providerRuntimeReconciliation
 */
import type {
  OrchestrationSession,
  OrchestrationThreadShell,
  ProviderSession,
  ThreadId,
  TurnId,
} from "@synara/contracts";

import type { ProviderRuntimeEventPumpHealth } from "./Services/ProviderService.ts";
import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";

export const DEFAULT_RUNTIME_RECONCILIATION_STALE_AFTER_MS = 15_000;

export type ProviderRuntimeReconciliationPlan =
  | {
      readonly action: "align-running-turn";
      readonly threadId: ThreadId;
      readonly provider: ProviderRuntimeBinding["provider"];
      readonly projectedTurnId: TurnId | null;
      readonly runtimeTurnId: TurnId;
      readonly reason: string;
    }
  | {
      readonly action: "settle-interrupted";
      readonly threadId: ThreadId;
      readonly provider: ProviderRuntimeBinding["provider"];
      readonly projectedTurnId: TurnId | null;
      readonly runtimeTurnId: null;
      readonly reason: string;
    }
  | {
      readonly action: "settle-terminal-projection";
      readonly threadId: ThreadId;
      readonly provider: ProviderRuntimeBinding["provider"];
      readonly projectedTurnId: TurnId;
      readonly runtimeTurnId: null;
      readonly terminalSession: TerminalProjectedSession;
      readonly reason: string;
    }
  | {
      readonly action: "settle-error";
      readonly threadId: ThreadId;
      readonly provider: ProviderRuntimeBinding["provider"];
      readonly projectedTurnId: TurnId;
      readonly runtimeTurnId: null;
      readonly errorMessage: string;
      readonly reason: string;
    };

type TerminalProjectedSession = Omit<OrchestrationSession, "status"> & {
  readonly status: "ready" | "interrupted" | "stopped" | "error";
};

function terminalProjectedSession(
  thread: OrchestrationThreadShell,
): TerminalProjectedSession | null {
  const session = thread.session;
  if (session === null) return null;

  switch (session.status) {
    case "ready":
    case "interrupted":
    case "stopped":
    case "error":
      return { ...session, status: session.status };
    case "idle":
    case "starting":
    case "running":
      return null;
  }
}

function projectedInFlightTurnId(thread: OrchestrationThreadShell): TurnId | null {
  const session = thread.session;
  // A queued start has no provider turn yet. Falling back to latestTurn here
  // can attach the new request to an older terminal (or ingestion-lagged) turn.
  if (
    session?.status === "starting" &&
    session.activeTurnId === null &&
    thread.latestTurn?.state !== "running"
  ) {
    return null;
  }
  return session?.activeTurnId ?? (thread.latestTurn?.state === "running"
    ? thread.latestTurn.turnId
    : null);
}

function projectedLifecycleAgeMs(thread: OrchestrationThreadShell, nowMs: number): number {
  const observedAt = Date.parse(thread.session?.updatedAt ?? thread.updatedAt);
  return Number.isFinite(observedAt) ? Math.max(0, nowMs - observedAt) : Number.POSITIVE_INFINITY;
}

function pumpDetail(
  provider: ProviderRuntimeBinding["provider"],
  healthByProvider: ReadonlyMap<ProviderRuntimeBinding["provider"], ProviderRuntimeEventPumpHealth>,
): string {
  const health = healthByProvider.get(provider);
  if (!health || health.status === "healthy") return "";
  return ` The ${provider} runtime-event pump is ${health.status}.`;
}

function bindingLastError(binding: ProviderRuntimeBinding): string | null {
  const payload = binding.runtimePayload;
  if (typeof payload !== "object" || payload === null || !("lastError" in payload)) {
    return null;
  }
  const lastError = payload.lastError;
  return typeof lastError === "string" && lastError.trim().length > 0
    ? lastError.trim()
    : null;
}

function bindingActiveTurnId(binding: ProviderRuntimeBinding): string | null {
  const payload = binding.runtimePayload;
  if (typeof payload !== "object" || payload === null || !("activeTurnId" in payload)) {
    return null;
  }
  return typeof payload.activeTurnId === "string" ? payload.activeTurnId : null;
}

export function planProviderRuntimeReconciliation(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly bindings: ReadonlyArray<ProviderRuntimeBinding>;
  readonly liveSessions: ReadonlyArray<ProviderSession>;
  readonly pumpHealth: ReadonlyArray<ProviderRuntimeEventPumpHealth>;
  readonly nowMs: number;
  readonly staleAfterMs?: number;
}): ReadonlyArray<ProviderRuntimeReconciliationPlan> {
  const staleAfterMs = Math.max(
    1,
    input.staleAfterMs ?? DEFAULT_RUNTIME_RECONCILIATION_STALE_AFTER_MS,
  );
  const bindingByThreadId = new Map(input.bindings.map((binding) => [binding.threadId, binding]));
  const liveSessionByThreadId = new Map(
    input.liveSessions.map((session) => [session.threadId, session]),
  );
  const healthByProvider = new Map(input.pumpHealth.map((health) => [health.provider, health]));
  const plans: ProviderRuntimeReconciliationPlan[] = [];

  for (const thread of input.threads) {
    if (projectedLifecycleAgeMs(thread, input.nowMs) < staleAfterMs) continue;

    // Native child threads share a parent session and intentionally have no
    // directory binding of their own. Their parent terminal events settle them.
    const binding = bindingByThreadId.get(thread.id);
    if (!binding) continue;

    const projectedTurnId = projectedInFlightTurnId(thread);
    const liveSession = liveSessionByThreadId.get(thread.id);
    const liveTurnId = liveSession?.activeTurnId ?? null;
    const detail = pumpDetail(binding.provider, healthByProvider);

    if (liveSession?.status === "running" && liveTurnId !== null) {
      if (liveTurnId === projectedTurnId) continue;
      plans.push({
        action: "align-running-turn",
        threadId: thread.id,
        provider: binding.provider,
        projectedTurnId,
        runtimeTurnId: liveTurnId,
        reason:
          `The live provider owns turn '${liveTurnId}', while the projection still points to ` +
          `'${projectedTurnId ?? "none"}'.${detail}`,
      });
      continue;
    }

    // Settling a projection is only safe when it names a concrete in-flight
    // turn. ProviderCommandReactor owns failures before a start acquires one.
    if (projectedTurnId === null) continue;
    if (liveSession?.status === "connecting") continue;

    const liveSessionSettled =
      liveSession !== undefined &&
      (liveSession.status === "ready" ||
        liveSession.status === "closed" ||
        liveSession.status === "error");
    const missingLiveSession = liveSession === undefined;
    const bindingSettled =
      missingLiveSession && (binding.status === "stopped" || binding.status === "error");

    if (!liveSessionSettled && !missingLiveSession && !bindingSettled) continue;

    if (liveSession?.status === "error" || (missingLiveSession && binding.status === "error")) {
      const errorTurnId =
        liveSession?.status === "error"
          ? (liveSession.activeTurnId ?? null)
          : bindingActiveTurnId(binding);
      if (errorTurnId !== projectedTurnId) {
        plans.push({
          action: "settle-interrupted",
          threadId: thread.id,
          provider: binding.provider,
          projectedTurnId,
          runtimeTurnId: null,
          reason:
            `The provider reported an error for turn '${errorTurnId ?? "unknown"}', which cannot ` +
            `be safely attributed to projected turn '${projectedTurnId}'.${detail}`,
        });
        continue;
      }
      const errorMessage =
        liveSession?.lastError ??
        bindingLastError(binding) ??
        "Provider runtime reported an error while reconciling a stale turn.";
      plans.push({
        action: "settle-error",
        threadId: thread.id,
        provider: binding.provider,
        projectedTurnId,
        runtimeTurnId: null,
        errorMessage,
        reason:
          liveSession?.status === "error"
            ? `The live provider session failed while the projection still had running turn '${projectedTurnId}'.${detail}`
            : `The durable provider binding failed while the projection still had running turn '${projectedTurnId}'.${detail}`,
      });
      continue;
    }

    const terminalSession = terminalProjectedSession(thread);
    if (terminalSession !== null) {
      plans.push({
        action: "settle-terminal-projection",
        threadId: thread.id,
        provider: binding.provider,
        projectedTurnId,
        runtimeTurnId: null,
        terminalSession,
        reason: liveSessionSettled
          ? `The live provider session is '${liveSession.status}', but terminal projection '${terminalSession.status}' still has a running turn.${detail}`
          : bindingSettled
            ? `The durable provider binding is '${binding.status}', but terminal projection '${terminalSession.status}' still has a running turn.${detail}`
            : `Terminal projection '${terminalSession.status}' still has a running turn, but the provider Adapter no longer owns a live session.${detail}`,
      });
      continue;
    }

    plans.push({
      action: "settle-interrupted",
      threadId: thread.id,
      provider: binding.provider,
      projectedTurnId,
      runtimeTurnId: null,
      reason: liveSessionSettled
        ? `The live provider session is '${liveSession.status}', but the projection is still running.${detail}`
        : bindingSettled
          ? `The durable provider binding is '${binding.status}', but the projection is still running.${detail}`
          : `The projection is still running, but the provider Adapter no longer owns a live session.${detail}`,
    });
  }

  return plans;
}
