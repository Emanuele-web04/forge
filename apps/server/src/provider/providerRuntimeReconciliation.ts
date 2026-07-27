/**
 * providerRuntimeReconciliation - Pure live runtime/projection convergence plan.
 *
 * Provider Adapter state is live evidence; the provider session directory is a
 * durable routing cache; orchestration is the UI read model. This planner finds
 * stale lifecycle divergence without inventing successful completion.
 *
 * @module providerRuntimeReconciliation
 */
import {
  TurnId,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ProviderSession,
  type ThreadId,
} from "@synara/contracts";
import { nonEmptyTrimmed } from "@synara/shared/text";

import type { ProviderRuntimeEventPumpHealth } from "./Services/ProviderService.ts";
import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";

export const DEFAULT_RUNTIME_RECONCILIATION_STALE_AFTER_MS = 15_000;

/**
 * Absolute upper bound on a single turn. Past this the turn is settled even
 * when the live runtime still claims to be running, because every other signal
 * this planner trusts (a settled session, a missing session, a failed binding)
 * can be absent when a provider wedges mid-turn. `thread.updatedAt` advances on
 * every appended message, so a legitimately long-running turn keeps resetting
 * this clock and is never affected.
 */
export const RUNTIME_RECONCILIATION_MAX_TURN_AGE_MS = 45 * 60_000;

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

/**
 * A turn id as `OrchestrationSession.activeTurnId` and activity `turnId` require
 * it: trimmed non-empty, or null.
 *
 * A blank id means "no turn"; it is not a turn named "". Both fields are branded
 * `TurnId`s whose schema rejects `""`, and every value fed to this planner
 * (projection rows, live Adapter sessions, durable binding payloads) is built in
 * code with `makeUnsafe` and never re-decoded, so nothing upstream guarantees it.
 */
function turnIdOrNull(value: TurnId | string | null | undefined): TurnId | null {
  const trimmed = nonEmptyTrimmed(value ?? undefined);
  return trimmed === undefined ? null : TurnId.makeUnsafe(trimmed);
}

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
      // Copied verbatim into `thread.session.set`, so it has to satisfy
      // `OrchestrationSession` on the way out even when the persisted row does
      // not: `providerName`/`lastError` are trimmed-non-empty-or-null.
      return {
        ...session,
        status: session.status,
        providerName: nonEmptyTrimmed(session.providerName ?? undefined) ?? null,
        lastError: nonEmptyTrimmed(session.lastError ?? undefined) ?? null,
        activeTurnId: turnIdOrNull(session.activeTurnId),
      };
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
    turnIdOrNull(session.activeTurnId) === null &&
    thread.latestTurn?.state !== "running"
  ) {
    return null;
  }
  // A blank projected id is an absent id, so it must fall through to the latest
  // running turn exactly like a missing one rather than short-circuiting on "".
  return (
    turnIdOrNull(session?.activeTurnId) ??
    (thread.latestTurn?.state === "running" ? turnIdOrNull(thread.latestTurn.turnId) : null)
  );
}

function projectedLifecycleAgeMs(thread: OrchestrationThreadShell, nowMs: number): number {
  const observedAt = Date.parse(thread.session?.updatedAt ?? thread.updatedAt);
  return Number.isFinite(observedAt) ? Math.max(0, nowMs - observedAt) : Number.POSITIVE_INFINITY;
}

/** Time since anything at all was projected onto the thread (messages included). */
function threadActivityAgeMs(thread: OrchestrationThreadShell, nowMs: number): number {
  const observedAt = Date.parse(thread.updatedAt);
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

function bindingLastError(binding: ProviderRuntimeBinding | undefined): string | null {
  const payload = binding?.runtimePayload;
  if (typeof payload !== "object" || payload === null || !("lastError" in payload)) {
    return null;
  }
  const lastError = payload.lastError;
  return typeof lastError === "string" ? (nonEmptyTrimmed(lastError) ?? null) : null;
}

export function bindingActiveTurnId(binding: ProviderRuntimeBinding | undefined): string | null {
  if (binding === undefined) return null;
  const payload = binding.runtimePayload;
  if (typeof payload !== "object" || payload === null || !("activeTurnId" in payload)) {
    return null;
  }
  // A binding advertising a blank turn id owns no turn, and comparing it against
  // a normalized projected turn id must not report spurious divergence.
  return typeof payload.activeTurnId === "string" ? turnIdOrNull(payload.activeTurnId) : null;
}

export function planProviderRuntimeReconciliation(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly bindings: ReadonlyArray<ProviderRuntimeBinding>;
  readonly liveSessions: ReadonlyArray<ProviderSession>;
  readonly pumpHealth: ReadonlyArray<ProviderRuntimeEventPumpHealth>;
  readonly nowMs: number;
  readonly staleAfterMs?: number;
  readonly maxTurnAgeMs?: number;
}): ReadonlyArray<ProviderRuntimeReconciliationPlan> {
  const staleAfterMs = Math.max(
    1,
    input.staleAfterMs ?? DEFAULT_RUNTIME_RECONCILIATION_STALE_AFTER_MS,
  );
  const maxTurnAgeMs = Math.max(
    staleAfterMs,
    input.maxTurnAgeMs ?? RUNTIME_RECONCILIATION_MAX_TURN_AGE_MS,
  );
  const bindingByThreadId = new Map(input.bindings.map((binding) => [binding.threadId, binding]));
  const liveSessionByThreadId = new Map(
    input.liveSessions.map((session) => [session.threadId, session]),
  );
  const healthByProvider = new Map(input.pumpHealth.map((health) => [health.provider, health]));
  const plans: ProviderRuntimeReconciliationPlan[] = [];

  for (const thread of input.threads) {
    const lifecycleAgeMs = projectedLifecycleAgeMs(thread, input.nowMs);
    if (lifecycleAgeMs < staleAfterMs) continue;

    const binding = bindingByThreadId.get(thread.id);
    const liveSession = liveSessionByThreadId.get(thread.id);
    // The binding row can be gone entirely (a stop that removed it, a crashed
    // start) - which is precisely the thread most likely to be stuck with
    // nothing left that could ever settle it - so fall back to the thread's own
    // provider instead of dropping the candidate.
    const provider = binding?.provider ?? thread.modelSelection.provider;
    const detail = pumpDetail(provider, healthByProvider);
    const abandoned =
      lifecycleAgeMs >= maxTurnAgeMs && threadActivityAgeMs(thread, input.nowMs) >= maxTurnAgeMs;
    const abandonedDetail = ` Nothing has progressed on this thread for over ${Math.round(maxTurnAgeMs / 60_000)} minutes.${detail}`;

    // Native child threads share a parent session and intentionally have no
    // directory binding of their own; their parent's terminal events settle
    // them. Only step in once the turn is abandoned outright.
    if (!binding && !abandoned) continue;

    const projectedTurnId = projectedInFlightTurnId(thread);
    const liveTurnId = turnIdOrNull(liveSession?.activeTurnId);

    if (liveSession?.status === "running" && liveTurnId !== null && !abandoned) {
      if (liveTurnId === projectedTurnId) continue;
      plans.push({
        action: "align-running-turn",
        threadId: thread.id,
        provider,
        projectedTurnId,
        runtimeTurnId: liveTurnId,
        reason:
          `The live provider owns turn '${liveTurnId}', while the projection still points to ` +
          `'${projectedTurnId ?? "none"}'.${detail}`,
      });
      continue;
    }

    // Settling a projection is normally only safe when it names a concrete
    // in-flight turn; ProviderCommandReactor owns failures before a start
    // acquires one. An abandoned lifecycle is the exception: a session pinned in
    // `starting`/`running` with no turn to name hangs the UI just as hard.
    if (projectedTurnId === null) {
      const session = thread.session;
      if (!abandoned || session === null) continue;
      if (session.status !== "starting" && session.status !== "running") continue;
      plans.push({
        action: "settle-interrupted",
        threadId: thread.id,
        provider,
        projectedTurnId: null,
        runtimeTurnId: null,
        reason: `The session is stuck in '${session.status}' with no provider turn to settle.${abandonedDetail}`,
      });
      continue;
    }

    if (liveSession?.status === "connecting" && !abandoned) continue;

    const liveSessionSettled =
      liveSession !== undefined &&
      (liveSession.status === "ready" ||
        liveSession.status === "closed" ||
        liveSession.status === "error");
    const missingLiveSession = liveSession === undefined;
    const bindingSettled =
      missingLiveSession &&
      binding !== undefined &&
      (binding.status === "stopped" || binding.status === "error");

    if (!liveSessionSettled && !missingLiveSession && !bindingSettled && !abandoned) continue;

    if (liveSession?.status === "error" || (missingLiveSession && binding?.status === "error")) {
      const errorTurnId =
        liveSession?.status === "error"
          ? turnIdOrNull(liveSession.activeTurnId)
          : bindingActiveTurnId(binding);
      if (errorTurnId !== projectedTurnId) {
        plans.push({
          action: "settle-interrupted",
          threadId: thread.id,
          provider,
          projectedTurnId,
          runtimeTurnId: null,
          reason:
            `The provider reported an error for turn '${errorTurnId ?? "unknown"}', which cannot ` +
            `be safely attributed to projected turn '${projectedTurnId}'.${detail}`,
        });
        continue;
      }
      // `lastError` is trimmed-non-empty-or-null on the session command, and `??`
      // does not fall back on "". A provider that reported failure without a
      // message still has to say so rather than settle with a blank error.
      const errorMessage =
        nonEmptyTrimmed(liveSession?.lastError) ??
        bindingLastError(binding) ??
        "Provider runtime reported an error while reconciling a stale turn.";
      plans.push({
        action: "settle-error",
        threadId: thread.id,
        provider,
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

    const settledEvidenceDetail = liveSessionSettled
      ? `The live provider session is '${liveSession.status}'`
      : bindingSettled && binding !== undefined
        ? `The durable provider binding is '${binding.status}'`
        : missingLiveSession
          ? "The provider Adapter no longer owns a live session"
          : `The provider session is '${liveSession?.status ?? "unknown"}' but made no progress`;

    const terminalSession = terminalProjectedSession(thread);
    if (terminalSession !== null) {
      plans.push({
        action: "settle-terminal-projection",
        threadId: thread.id,
        provider,
        projectedTurnId,
        runtimeTurnId: null,
        terminalSession,
        reason: `${settledEvidenceDetail}, but terminal projection '${terminalSession.status}' still has a running turn.${liveSessionSettled || bindingSettled || missingLiveSession ? detail : abandonedDetail}`,
      });
      continue;
    }

    plans.push({
      action: "settle-interrupted",
      threadId: thread.id,
      provider,
      projectedTurnId,
      runtimeTurnId: null,
      reason: `${settledEvidenceDetail}, but the projection is still running.${liveSessionSettled || bindingSettled || missingLiveSession ? detail : abandonedDetail}`,
    });
  }

  return plans;
}
