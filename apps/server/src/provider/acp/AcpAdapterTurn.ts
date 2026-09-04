// FILE: AcpAdapterTurn.ts
// Purpose: Shared ACP turn lifecycle skeleton reused by ACP adapters.
// Layer: Provider ACP adapter support
// Exports: AcpTurnContext, runAcpTurn, and turn-completion helpers.
//
// Cursor, Droid, and Grok each carry their own copy of the
// turn.started → prompt → drain queued events → turn.completed skeleton,
// differing only in provider-specific decoration (plan capture, nested tasks,
// resume replay gates). This module factors out the shared lifecycle so the
// external adapter (and future adapters) do not duplicate it. Existing adapters
// keep their inlined copies in this change to avoid regression risk.

import type * as Acp from "@agentclientprotocol/sdk";
import {
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";
import { Effect, Fiber, type Scope } from "effect";

import { cancelAgentGatewayTurn, type AgentGatewaySessionLease } from "../../agentGateway/sessionLease.ts";
import { classifyAcpPromptTurnCompletion, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";
import { clearAcpActiveTurn, finalizeAcpActiveTurnCost } from "./AcpAdapterSessionSupport.ts";
import type * as AcpErrors from "./AcpErrors.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import { ProviderAdapterSessionNotFoundError } from "../Errors.ts";

/**
 * The mutable per-turn/per-session state the shared turn loop reads and writes.
 * Adapters implement this against their own session context; the fields mirror
 * the union of what Cursor/Droid/Grok track so the skeleton stays generic.
 */
export interface AcpTurnContext {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly lifecycleGeneration: string | undefined;
  readonly acp: AcpSessionRuntimeShape;
  readonly gatewaySessionLease: AgentGatewaySessionLease | undefined;
  readonly scope: Scope.Closeable;
  session: {
    readonly provider: ProviderKind;
    status: "connecting" | "ready" | "running" | "error" | "closed";
    runtimeMode: RuntimeMode;
    readonly threadId: ThreadId;
    model: string | undefined;
    activeTurnId: TurnId | undefined;
    updatedAt: string;
    lastError: string | undefined;
  };
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: {
    has(id: string): boolean;
    delete(id: string): void;
    clear(): void;
  };
  activeTurnFailedToolDetail: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  lastTurnActivityAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

/** Offer one runtime event, stamped with the session lifecycle generation. */
export type AcpTurnOfferEvent = (
  lifecycleGeneration: string | undefined,
  event: ProviderRuntimeEvent,
) => Effect.Effect<void>;

/** Returns a fresh `{ eventId, createdAt }` stamp for a runtime event. */
export type AcpTurnEventStamp = () => Effect.Effect<{
  readonly eventId: string;
  readonly createdAt: string;
}>;

/** Blocks until every session/update event received during the turn is handled. */
export type AcpTurnDrainQueuedEvents = (ctx: AcpTurnContext) => Effect.Effect<void>;

export interface AcpTurnOptions {
  readonly ctx: AcpTurnContext;
  readonly turnId: TurnId;
  /** The assembled prompt content blocks (text + image + harness policy). */
  readonly promptParts: ReadonlyArray<Acp.ContentBlock>;
  /** The model name to record on the turn (may be undefined). */
  readonly model: string | undefined;
  readonly interactionMode: ProviderInteractionMode;
  readonly offerRuntimeEvent: AcpTurnOfferEvent;
  readonly makeEventStamp: AcpTurnEventStamp;
  readonly nowIso: Effect.Effect<string>;
  /** Optional gate the turn waits on before dispatching (e.g. resume replay). */
  readonly awaitStartGate?: Effect.Effect<void>;
  /**
   * Drain queued events after the prompt settles. Adapters that track enqueued
   * counts supply this so late tool updates keep their turn attribution.
   */
  readonly drainQueuedEvents?: AcpTurnDrainQueuedEvents;
  /**
   * Provider-specific hook invoked when the prompt fails, after the turn is
   * cleared but before the session is stopped. Defaults to stopping the session
   * on transport/prompt failures (the child is unusable after a transport break).
   */
  readonly onPromptFailure?: (ctx: AcpTurnContext, detail: string) => Effect.Effect<void>;
  /**
   * Called when the turn completes normally with no assistant content and a
   * non-cancelled stop reason, so adapters can warn (mirrors Cursor/Droid).
   */
  readonly onTurnCompletedWithoutContent?: (
    ctx: AcpTurnContext,
    stopReason: string | null,
  ) => Effect.Effect<void>;
}

/**
 * Runs one ACP turn end-to-end: publishes turn.started, dispatches the prompt,
 * drains queued events, classifies the outcome, and emits turn.completed.
 *
 * Failure handling matches every built-in adapter: a transport/prompt failure
 * makes the ACP child unusable, so the session is retired and the turn fails.
 */
export const runAcpTurn = (
  options: AcpTurnOptions,
): Effect.Effect<ProviderRuntimeEvent, Error> =>
  Effect.gen(function* () {
    const { ctx, turnId, promptParts, model, interactionMode, offerRuntimeEvent, makeEventStamp, nowIso } = options;
    if (options.awaitStartGate !== undefined) {
      yield* options.awaitStartGate;
    }
    if (ctx.stopped) {
      return yield* Effect.fail(
        new ProviderAdapterSessionNotFoundError({ provider: ctx.provider, threadId: ctx.threadId }),
      );
    }

    ctx.activeTurnId = turnId;
    ctx.activeTurnHadAssistantContent = false;
    ctx.activeAssistantItemsWithContent.clear();
    ctx.activeTurnFailedToolDetail = undefined;
    ctx.activeInteractionMode = interactionMode;
    ctx.lastTurnActivityAt = Date.now();
    const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
    ctx.session = {
      ...sessionWithoutLastError,
      status: "running",
      activeTurnId: turnId,
      updatedAt: yield* nowIso,
    };

    const startedEvent: ProviderRuntimeEvent = {
      type: "turn.started",
      ...(yield* makeEventStamp()),
      provider: ctx.provider,
      threadId: ctx.threadId,
      turnId,
      payload: { ...(model ? { model } : {}) },
    };
    yield* offerRuntimeEvent(ctx.lifecycleGeneration, startedEvent);

    const result = yield* ctx.acp.prompt({ prompt: [...promptParts] }).pipe(
      Effect.mapError((error) =>
        mapAcpToAdapterError(ctx.provider, ctx.threadId, "session/prompt", error),
      ),
    );

    return yield* handleAcpPromptResult({ ...options, result });
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        if (error instanceof ProviderAdapterSessionNotFoundError) {
          return yield* Effect.fail(error);
        }
        return yield* handleAcpPromptFailure({ ...options, error: error as Error });
      }),
    ),
  );

/**
 * Handles a settled prompt result by draining queued events, classifying the
 * outcome, and emitting the terminal turn.completed event. Returns the emitted
 * event (or a placeholder when the turn was already cleared by another path).
 */
export const handleAcpPromptResult = (
  options: AcpTurnOptions & { readonly result: Acp.PromptResponse },
): Effect.Effect<ProviderRuntimeEvent> =>
  Effect.gen(function* () {
    const { ctx, turnId, promptParts, model, offerRuntimeEvent, makeEventStamp, nowIso, result } = options;
    if (options.drainQueuedEvents !== undefined) {
      yield* options.drainQueuedEvents(ctx);
    }
    const hadAssistantContent = ctx.activeTurnHadAssistantContent;
    const failedToolDetail = ctx.activeTurnFailedToolDetail;
    if (ctx.activeTurnId !== turnId) {
      return terminalEventPlaceholder(ctx.provider, ctx.threadId, turnId);
    }
    yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
    if (!clearAcpActiveTurn(ctx, turnId)) {
      return terminalEventPlaceholder(ctx.provider, ctx.threadId, turnId);
    }
    const completedCost = finalizeAcpActiveTurnCost(ctx);
    ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
    const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
    ctx.session = {
      ...sessionWithoutLastError,
      status: "ready",
      updatedAt: yield* nowIso,
      ...(model ? { model } : {}),
    };
    if (!hadAssistantContent && result.stopReason !== "cancelled") {
      if (options.onTurnCompletedWithoutContent !== undefined) {
        yield* options.onTurnCompletedWithoutContent(ctx, result.stopReason ?? null);
      }
    }
    const completion = classifyAcpPromptTurnCompletion({
      stopReason: result.stopReason,
      ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
    });
    const completedEvent: ProviderRuntimeEvent = {
      type: "turn.completed",
      ...(yield* makeEventStamp()),
      provider: ctx.provider,
      threadId: ctx.threadId,
      turnId,
      payload: {
        state: completion.state,
        stopReason: result.stopReason ?? null,
        ...(completion.errorMessage !== undefined ? { errorMessage: completion.errorMessage } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...completedCost,
      },
    };
    yield* offerRuntimeEvent(ctx.lifecycleGeneration, completedEvent);
    return completedEvent;
  });

/**
 * Handles a failed prompt: drains, clears the turn, emits a failed
 * turn.completed, then invokes the provider-specific retirement hook. Mirrors
 * the failure path every built-in adapter shares.
 */
export const handleAcpPromptFailure = (
  options: AcpTurnOptions & { readonly error: Error; readonly promptParts: ReadonlyArray<Acp.ContentBlock> },
): Effect.Effect<ProviderRuntimeEvent> =>
  Effect.gen(function* () {
    const { ctx, turnId, promptParts, model, offerRuntimeEvent, makeEventStamp, nowIso, error } = options;
    if (options.drainQueuedEvents !== undefined) {
      yield* options.drainQueuedEvents(ctx);
    }
    if (ctx.activeTurnId !== turnId) {
      return terminalEventPlaceholder(ctx.provider, ctx.threadId, turnId);
    }
    yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
    if (!clearAcpActiveTurn(ctx, turnId)) {
      return terminalEventPlaceholder(ctx.provider, ctx.threadId, turnId);
    }
    const completedCost = finalizeAcpActiveTurnCost(ctx);
    ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
    const detail = error.message;
    const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
    ctx.session = {
      ...sessionWithoutLastError,
      status: "error",
      updatedAt: yield* nowIso,
      ...(model ? { model } : {}),
      lastError: detail,
    };
    const failedEvent: ProviderRuntimeEvent = {
      type: "turn.completed",
      ...(yield* makeEventStamp()),
      provider: ctx.provider,
      threadId: ctx.threadId,
      turnId,
      payload: {
        state: "failed",
        stopReason: null,
        errorMessage: detail,
        ...completedCost,
      },
    };
    yield* offerRuntimeEvent(ctx.lifecycleGeneration, failedEvent);
    if (options.onPromptFailure !== undefined) {
      yield* options.onPromptFailure(ctx, detail);
    }
    return failedEvent;
  });

/**
 * Handles turn interruption: clears the turn and emits a cancelled
 * turn.completed, matching the shared onInterrupt path.
 */
export const handleAcpTurnInterrupt = (
  options: AcpTurnOptions & { readonly promptParts: ReadonlyArray<Acp.ContentBlock> },
): Effect.Effect<ProviderRuntimeEvent> =>
  Effect.gen(function* () {
    const { ctx, turnId, promptParts, model, offerRuntimeEvent, makeEventStamp, nowIso } = options;
    if (!clearAcpActiveTurn(ctx, turnId)) {
      return terminalEventPlaceholder(ctx.provider, ctx.threadId, turnId);
    }
    const completedCost = finalizeAcpActiveTurnCost(ctx);
    ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
    const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
    ctx.session = {
      ...sessionWithoutLastError,
      status: "ready",
      updatedAt: yield* nowIso,
      ...(model ? { model } : {}),
    };
    const cancelledEvent: ProviderRuntimeEvent = {
      type: "turn.completed",
      ...(yield* makeEventStamp()),
      provider: ctx.provider,
      threadId: ctx.threadId,
      turnId,
      payload: {
        state: "cancelled",
        stopReason: "cancelled",
        ...completedCost,
      },
    };
    yield* offerRuntimeEvent(ctx.lifecycleGeneration, cancelledEvent);
    return cancelledEvent;
  });

// A terminal event placeholder is never emitted to subscribers: callers that
// detect an already-cleared turn return early. It exists only to satisfy the
// Effect return type when the turn was settled by another path.
function terminalEventPlaceholder(
  provider: ProviderKind,
  threadId: ThreadId,
  turnId: TurnId,
): ProviderRuntimeEvent {
  return {
    type: "turn.completed",
    eventId: "" as never,
    createdAt: "",
    provider,
    threadId,
    turnId,
    payload: { state: "cancelled", stopReason: "cancelled" },
  };
}

/** True when the session has at least one unresolved approval or elicitation. */
export function isAcpTurnAwaitingHuman(
  pendingApprovals: ReadonlyMap<unknown, unknown>,
  pendingUserInputs: ReadonlyMap<unknown, unknown>,
): boolean {
  return pendingApprovals.size > 0 || pendingUserInputs.size > 0;
}

export type { AcpErrors };
