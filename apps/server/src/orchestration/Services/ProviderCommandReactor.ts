/**
 * ProviderCommandReactor - Provider command reaction service interface.
 *
 * Owns background workers that react to orchestration intent events and
 * dispatch provider-side command execution.
 *
 * @module ProviderCommandReactor
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

import type { OrchestrationRegenerateThreadTitleResult, ThreadId } from "@synara/contracts";
import type {
  ProviderBlockingDeliveryEvidence,
  ProviderDeliveryReconciliationOutcome,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";

export interface ProviderDeliveryReconciliationResult {
  readonly eventSequence: number;
  readonly threadId: ThreadId;
  readonly outcome: ProviderDeliveryReconciliationOutcome;
  readonly state: "retry" | "succeeded" | "dead" | "uncertain";
  readonly reconciledAt: string;
}

/**
 * ProviderCommandReactorShape - Service API for provider command reactors.
 */
export interface ProviderCommandReactorShape {
  /**
   * Start reacting to provider-intent orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Filters orchestration domain events to provider-intent types before
   * processing.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  readonly listBlockingDeliveries: (input: {
    readonly threadId?: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ProviderBlockingDeliveryEvidence>, unknown>;

  readonly reconcileDelivery: (input: {
    readonly eventSequence: number;
    readonly threadId: ThreadId;
    readonly expectedState: "dead" | "uncertain";
    readonly outcome: ProviderDeliveryReconciliationOutcome;
    readonly reconciledBy: string;
    readonly note?: string | undefined;
  }) => Effect.Effect<ProviderDeliveryReconciliationResult | null, unknown>;

  readonly regenerateThreadTitle: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<OrchestrationRegenerateThreadTitleResult, unknown>;
}

/**
 * ProviderCommandReactor - Service tag for provider command reaction workers.
 */
export class ProviderCommandReactor extends ServiceMap.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()("synara/orchestration/Services/ProviderCommandReactor") {}
