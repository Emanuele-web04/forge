/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderBackgroundTaskInput,
  ProviderForkThreadInput,
  ProviderForkThreadResult,
  ProviderInterruptTurnInput,
  ProviderKind,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderStartReviewInput,
  ProviderSteerTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSteerSubagentInput,
  ProviderStopSessionInput,
  ProviderStopTaskInput,
  ThreadId,
  ProviderTurnStartResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";

export type ProviderRuntimeEventPumpStatus = "starting" | "healthy" | "recovering" | "degraded";

export interface ProviderRuntimeEventPumpHealth {
  readonly provider: ProviderKind;
  readonly status: ProviderRuntimeEventPumpStatus;
  readonly consecutiveFailures: number;
  readonly updatedAt: string;
  readonly lastEventAt?: string;
  readonly lastError?: string;
  readonly quarantinedEvents?: number;
  readonly lastQuarantinedEventId?: string;
  readonly lastQuarantinedAt?: string;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Redirect an active provider turn toward a new prompt when supported.
   */
  readonly steerTurn: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Start a native provider review run when supported by the routed adapter.
   */
  readonly startReview: (
    input: ProviderStartReviewInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Fork a provider thread natively when the underlying adapter supports it.
   *
   * Returns a persisted provider-native fork binding when available, otherwise
   * `null` so callers can fall back to orchestration-only history.
   */
  readonly forkThread?: (
    input: ProviderForkThreadInput,
  ) => Effect.Effect<ProviderForkThreadResult | null, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider-native background task. No-op when the routed adapter does
   * not support task control.
   */
  readonly stopTask: (input: ProviderStopTaskInput) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Move an in-flight foreground task to the background. No-op when the routed
   * adapter does not support task control.
   */
  readonly backgroundTask: (
    input: ProviderBackgroundTaskInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Deliver a mid-task user message to a running subagent of an active session.
   */
  readonly steerSubagent: (
    input: ProviderSteerSubagentInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop only the live adapter process/session while preserving the persisted
   * provider binding and resume cursor for a subsequent restart.
   */
  readonly stopRuntimeSession?: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Whether provider-native background tasks are currently keeping the
   * thread's runtime alive. Restart-oriented recovery paths must check this
   * before stopRuntimeSession: killing the shared subprocess silently
   * terminates those tasks.
   */
  readonly hasLiveRuntimeTasks?: (input: { readonly threadId: ThreadId }) => Effect.Effect<boolean>;

  /**
   * Forget a stale provider-native resume cursor while preserving local routing
   * metadata such as provider options and runtime mode.
   */
  readonly clearSessionResumeCursor?: (input: {
    readonly threadId: ThreadId;
    /** Clear only persisted resume state without stopping a runtime that owns live tasks. */
    readonly preserveActiveRuntime?: boolean;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read static capabilities for a provider adapter.
   */
  readonly getCapabilities: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Trigger provider-native context compaction for a thread.
   */
  readonly compactThread: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop provider event producers, drain the lossless fan-out while subscribers
   * are still live, and then close the publication bus. Safe to call repeatedly.
   */
  readonly closeRuntimeEvents: Effect.Effect<void>;

  /**
   * Snapshot the supervised runtime-event pumps. The state is operational
   * evidence for reconciliation and diagnostics, not provider availability.
   */
  readonly getRuntimeEventPumpHealth?: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeEventPumpHealth>
  >;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends ServiceMap.Service<ProviderService, ProviderServiceShape>()(
  "synara/provider/Services/ProviderService",
) {}
