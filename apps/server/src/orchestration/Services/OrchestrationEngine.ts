/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and lightweight command-state updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `ServiceMap.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type {
  OrchestrationEventStoreError,
  ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import type { ManagedAttachmentPrincipal } from "../../managedAttachmentPrincipal.ts";

export interface OrchestrationDispatchContext {
  readonly attachmentPrincipal?: ManagedAttachmentPrincipal;
}

export interface OrchestrationProjectionCatchUpStatus {
  /**
   * "unknown" means the lag probe itself failed (journal or cursor read
   * error): the projection may be fine or badly broken, and reporting either
   * extreme would mislead — a monitor must treat it as not-healthy.
   */
  readonly state: "healthy" | "degraded" | "unknown";
  readonly inFlight: boolean;
  readonly retryAttempts: number;
  readonly lastFailure: string | null;
  /** Journal head the per-projector lag below is measured against. */
  readonly highWaterSequence: number;
  /** Events behind the journal head, per projector cursor; only lagging projectors appear. */
  readonly lagByProjector: Readonly<Record<string, number>>;
  /** Projector cursors absent from a non-empty projection_state table (interrupted repair). */
  readonly missingProjectors: ReadonlyArray<string>;
}

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /** Reject new normal mutations while retaining reserved lifecycle progress. */
  readonly quiesce: Effect.Effect<void>;

  /** Resolve after every command admitted before the current idle fence settles. */
  readonly drain: Effect.Effect<void>;

  /** Reject all admission, drain queued commands, and stop the command worker. */
  readonly stop: Effect.Effect<void>;

  /** Current deferred-projection recovery state for health and diagnostics. */
  readonly getProjectionCatchUpStatus: Effect.Effect<OrchestrationProjectionCatchUpStatus>;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /** Read a durable, inclusive high-water-fenced event range for transport catch-up. */
  readonly readEventsThrough: (
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /** Replay one thread's persisted events from an exclusive global cursor. */
  readonly readThreadEvents: (
    threadId: string,
    fromSequenceExclusive: number,
    eventTypes?: ReadonlyArray<string>,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /** Read one thread's inclusive high-water-fenced event range. */
  readonly readThreadEventsThrough: (
    threadId: string,
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
    eventTypes?: ReadonlyArray<string>,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /** Capture the durable orchestration event-log high-water sequence. */
  readonly getEventHighWaterSequence: Effect.Effect<number, OrchestrationEventStoreError>;

  /**
   * Register a domain-event subscriber before returning its stream. Transport
   * snapshot handshakes use this exact attachment boundary to close replay gaps.
   */
  readonly subscribeDomainEvents: Effect.Effect<
    Stream.Stream<OrchestrationEvent>,
    never,
    Scope.Scope
  >;

  /**
   * Read the command-oriented in-memory model used by orchestration tests and
   * compatibility callers. Runtime snapshot reads should prefer
   * ProjectionSnapshotQuery.
   */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
    context?: OrchestrationDispatchContext,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Repair project-facing projection state for older installs without clearing
   * existing chat rows.
   *
   * Replays the snapshot-related projector cursors and refreshes the in-memory
   * command model from projection state.
   */
  readonly repairState: () => Effect.Effect<
    OrchestrationReadModel,
    OrchestrationDispatchError | OrchestrationEventStoreError,
    never
  >;

  /**
   * Reload the command-facing read model from projection tables after
   * maintenance code mutates projection state outside the command queue.
   */
  readonly refreshCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    OrchestrationDispatchError | ProjectionRepositoryError,
    never
  >;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 */
export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("synara/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
