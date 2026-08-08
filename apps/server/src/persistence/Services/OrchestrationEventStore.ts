/**
 * OrchestrationEventStore - Event store interface for orchestration events.
 *
 * Owns durable append/replay access to the orchestration event stream. It does
 * not reduce events into read models or apply command validation rules.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import { OrchestrationEvent } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { OrchestrationEventStoreError } from "../Errors.ts";

export interface OrchestrationEventReplayFilter {
  readonly eventTypes: ReadonlyArray<OrchestrationEvent["type"]>;
  readonly activityKinds?: ReadonlyArray<string>;
  readonly includeBoundaryEvent?: boolean;
}

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   *
   * Actor kind is inferred from command/metadata before persistence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Capture the latest durable sequence for a finite replay fence. */
  readonly getHighWaterSequence: () => Effect.Effect<number, OrchestrationEventStoreError>;

  /** Capture the latest durable sequence for one thread stream. */
  readonly getThreadHighWaterSequence: (
    threadId: string,
  ) => Effect.Effect<number, OrchestrationEventStoreError>;

  /** Read one stable, newest-first page from a thread's durable event stream. */
  readonly readThreadEvents: (input: {
    readonly threadId: string;
    readonly throughSequenceInclusive: number;
    readonly beforeSequenceExclusive?: number;
    readonly limit: number;
    readonly eventTypes?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, OrchestrationEventStoreError>;

  /** Replay one thread's events after an exclusive global sequence cursor. */
  readonly readThreadEventsFromSequence: (
    threadId: string,
    sequenceExclusive: number,
    limit?: number,
    throughSequenceInclusive?: number,
    eventTypes?: ReadonlyArray<string>,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @param throughSequenceInclusive - Optional captured high-water fence.
   * @returns Stream containing ordered events.
   *
   * Reads in fixed-size pages and normalizes non-integer/negative limits.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
    throughSequenceInclusive?: number,
    filter?: OrchestrationEventReplayFilter,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Stream containing all stored events.
   */
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends ServiceMap.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("synara/persistence/Services/OrchestrationEventStore") {}
