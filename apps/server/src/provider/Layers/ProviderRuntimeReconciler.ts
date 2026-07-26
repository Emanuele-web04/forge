/**
 * ProviderRuntimeReconcilerLive - Repairs live runtime/projection divergence.
 *
 * This is the same-process counterpart to startupTurnReconciliation. It uses
 * Adapter sessions as live evidence and always settles ambiguous missing-event
 * cases as interrupted rather than inventing successful completion.
 *
 * @module ProviderRuntimeReconcilerLive
 */
import { CommandId, EventId, type RuntimeMode } from "@synara/contracts";
import { Cause, Duration, Effect, Layer, Option, Schedule } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../../orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  DEFAULT_RUNTIME_RECONCILIATION_STALE_AFTER_MS,
  planProviderRuntimeReconciliation,
  type ProviderRuntimeReconciliationPlan,
} from "../providerRuntimeReconciliation.ts";
import {
  ProviderRuntimeReconciler,
  type ProviderRuntimeReconcilerShape,
} from "../Services/ProviderRuntimeReconciler.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";

const DEFAULT_RECONCILIATION_INTERVAL_MS = 5_000;
const DEFAULT_RECONCILIATION_CANDIDATE_LIMIT = 256;

export interface ProviderRuntimeReconcilerLiveOptions {
  readonly intervalMs?: number;
  readonly staleAfterMs?: number;
  readonly candidateLimit?: number;
}

function reconciliationKey(plan: ProviderRuntimeReconciliationPlan): string {
  return `provider-runtime-reconcile:${JSON.stringify([
    plan.provider,
    plan.action,
    plan.threadId,
    plan.projectedTurnId,
    plan.runtimeTurnId,
  ])}`;
}

const make = (options?: ProviderRuntimeReconcilerLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const orchestrationReactor = yield* OrchestrationReactor;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const intervalMs = Math.max(
      250,
      Math.floor(options?.intervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS),
    );
    const staleAfterMs = Math.max(
      1,
      Math.floor(options?.staleAfterMs ?? DEFAULT_RUNTIME_RECONCILIATION_STALE_AFTER_MS),
    );
    const candidateLimit = Math.max(
      1,
      Math.min(
        1_000,
        Math.floor(options?.candidateLimit ?? DEFAULT_RECONCILIATION_CANDIDATE_LIMIT),
      ),
    );

    const applyPlan = Effect.fnUntraced(function* (
      plan: ProviderRuntimeReconciliationPlan,
      runtimeMode: RuntimeMode,
      now: string,
    ) {
      const key = reconciliationKey(plan);
      // Command ids identify attempts because timestamps can legitimately
      // change between retries. The activity id identifies the semantic repair,
      // allowing projectors to suppress a repeated visible recovery while a
      // failed or lagging session update remains safe to retry.
      const attemptKey = `${key}:${crypto.randomUUID()}`;
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`${attemptKey}:activity`),
        threadId: plan.threadId,
        activity: {
          id: EventId.makeUnsafe(`${key}:activity`),
          tone: "info",
          kind: "provider.runtime.reconciled",
          summary:
            plan.action === "align-running-turn"
              ? "Synara realigned the active provider turn"
              : "Synara recovered a stale running state",
          payload: {
            provider: plan.provider,
            action: plan.action,
            reason: plan.reason,
            projectedTurnId: plan.projectedTurnId,
            runtimeTurnId: plan.runtimeTurnId,
          },
          turnId: plan.projectedTurnId,
          createdAt: now,
        },
        createdAt: now,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`${attemptKey}:session`),
        threadId: plan.threadId,
        session: {
          threadId: plan.threadId,
          status:
            plan.action === "align-running-turn"
              ? "running"
              : plan.action === "settle-error"
                ? "error"
                : plan.action === "settle-terminal-projection"
                  ? plan.terminalSession.status
                  : "interrupted",
          providerName:
            plan.action === "settle-terminal-projection"
              ? plan.terminalSession.providerName
              : plan.provider,
          runtimeMode:
            plan.action === "settle-terminal-projection"
              ? plan.terminalSession.runtimeMode
              : runtimeMode,
          activeTurnId:
            plan.action === "align-running-turn"
              ? plan.runtimeTurnId
              : plan.action === "settle-error"
                ? plan.projectedTurnId
                : plan.action === "settle-terminal-projection" &&
                    plan.terminalSession.status === "error"
                  ? plan.terminalSession.activeTurnId
                  : null,
          lastError:
            plan.action === "settle-error"
              ? plan.errorMessage
              : plan.action === "settle-terminal-projection"
                ? plan.terminalSession.lastError
                : null,
          updatedAt:
            plan.action === "settle-terminal-projection"
              ? plan.terminalSession.updatedAt
              : now,
        },
        createdAt: now,
      });
    });

    const reconcileNow = Effect.gen(function* () {
      const nowMs = Date.now();
      const [candidateThreadIds, bindings, liveSessions, pumpHealth] = yield* Effect.all(
        [
          projectionSnapshotQuery.listStaleInFlightThreadIds({
            updatedBefore: new Date(nowMs - staleAfterMs).toISOString(),
            limit: candidateLimit,
          }),
          directory.listBindings(),
          providerService.listSessions(),
          providerService.getRuntimeEventPumpHealth?.() ?? Effect.succeed([]),
        ],
        { concurrency: 5 },
      );
      if (candidateThreadIds.length === 0) return;
      const threads = (yield* Effect.forEach(
        candidateThreadIds,
        (threadId) => projectionSnapshotQuery.getThreadShellById(threadId),
        { concurrency: 8 },
      )).flatMap(Option.toArray);
      const threadById = new Map(threads.map((thread) => [thread.id, thread]));
      const plans = planProviderRuntimeReconciliation({
        threads,
        bindings,
        liveSessions,
        pumpHealth,
        nowMs,
        staleAfterMs,
      });
      if (plans.length === 0) return;

      const now = new Date().toISOString();
      yield* Effect.logWarning("provider.runtime_reconciliation.started", {
        planCount: plans.length,
        threadIds: plans.map((plan) => plan.threadId),
      });
      yield* Effect.forEach(
        plans,
        (plan) => {
          const thread = threadById.get(plan.threadId);
          if (!thread) return Effect.void;
          return applyPlan(plan, thread.session?.runtimeMode ?? thread.runtimeMode, now).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.runtime_reconciliation.plan_failed", {
                threadId: plan.threadId,
                provider: plan.provider,
                action: plan.action,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        },
        { concurrency: 1, discard: true },
      );
      yield* orchestrationReactor.reconcileSettledOpenTurns;
    });

    const reconcileSafely = reconcileNow.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("provider.runtime_reconciliation.failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );

    const start = () =>
      Effect.forkScoped(
        reconcileSafely.pipe(Effect.repeat(Schedule.spaced(Duration.millis(intervalMs)))),
      ).pipe(Effect.asVoid);

    return { reconcileNow, start } satisfies ProviderRuntimeReconcilerShape;
  });

export const makeProviderRuntimeReconcilerLive = (options?: ProviderRuntimeReconcilerLiveOptions) =>
  Layer.effect(ProviderRuntimeReconciler, make(options));

export const ProviderRuntimeReconcilerLive = makeProviderRuntimeReconcilerLive();
