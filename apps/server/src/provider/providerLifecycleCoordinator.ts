import { randomUUID } from "node:crypto";

import type { ThreadId } from "@synara/contracts";
import { Duration, Effect, Option } from "effect";
import * as Semaphore from "effect/Semaphore";

import { makeKeyedLock } from "./keyedLock.ts";

export interface ProviderLifecycleLease {
  readonly generation: string;
  readonly isCurrent: () => boolean;
  /**
   * Takes lasting ownership of {@link ProviderLifecycleLease.generation}.
   *
   * A run publishes its generation eagerly (runtime events emitted *while* a
   * provider starts must not look stale), but that publication is provisional:
   * it survives the run only if the run says it took ownership. Call this once
   * the generation is observable outside the coordinator — i.e. a session was
   * started with it or a binding was persisted with it.
   */
  readonly commit: () => void;
  /** Takes lasting ownership of an existing generation instead of this run's. */
  readonly adopt: (generation: string) => Effect.Effect<void>;
  /**
   * Holds generation ownership stable while coordinating another per-thread
   * write. The callback adopts without reacquiring the stability fence, which
   * preserves the global stability -> binding lock order.
   */
  readonly withStableGeneration: <A, E, R>(
    operation: (adopt: (generation: string) => void) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Takes lasting ownership of "this thread has no provider generation". */
  readonly retire: () => void;
}

export interface ProviderLifecycleCoordinator {
  readonly run: <A, E, R>(
    threadId: ThreadId,
    operation: (lease: ProviderLifecycleLease) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly runCurrent: <A, E, R>(
    threadId: ThreadId,
    operation: (generation: string | undefined) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /**
   * Holds the thread's generation stable for the full operation without
   * excluding current-generation control work.
   */
  readonly runStable: <A, E, R>(
    threadId: ThreadId,
    operation: (generation: string | undefined) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /**
   * Control-plane variant of {@link ProviderLifecycleCoordinator.runCurrent}:
   * waits a bounded time for the per-thread lock and then proceeds without it.
   * A wedged lifecycle mutation (a provider start that never returns) must not
   * be able to hold an interrupt hostage forever; the operation still validates
   * the current generation, so a racing replacement is rejected downstream.
   */
  readonly runCurrentUrgent: <A, E, R>(
    threadId: ThreadId,
    operation: (generation: string | undefined) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly adoptCurrent: (threadId: ThreadId, generation: string) => void;
  readonly currentGeneration: (threadId: ThreadId) => string | undefined;
}

/** How long an urgent control-plane operation waits for the per-thread lock. */
const URGENT_LOCK_WAIT = Duration.seconds(5);
const URGENT_LOCK_POLL = Duration.millis(25);

interface ProviderLifecycleCoordinatorOptions {
  readonly onGenerationPublished?: (input: {
    readonly threadId: ThreadId;
    readonly generation: string;
  }) => Effect.Effect<void>;
}

/** Serializes provider lifecycle mutations per thread and gives each mutation a unique epoch. */
export function makeProviderLifecycleCoordinator(
  options?: ProviderLifecycleCoordinatorOptions,
): ProviderLifecycleCoordinator {
  const locks = new Map<ThreadId, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  const currentGenerations = new Map<ThreadId, string>();
  const generationStabilityLock = makeKeyedLock<ThreadId>();

  type LockEntry = { readonly semaphore: Semaphore.Semaphore; users: number };

  const referenceEntry = (threadId: ThreadId): LockEntry => {
    let entry = locks.get(threadId);
    if (entry === undefined) {
      entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      locks.set(threadId, entry);
    }
    entry.users += 1;
    return entry;
  };

  const releaseEntry = (threadId: ThreadId, entry: LockEntry) =>
    Effect.sync(() => {
      entry.users -= 1;
      if (entry.users === 0 && locks.get(threadId) === entry) {
        locks.delete(threadId);
      }
    });

  const withThreadLock = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const entry = referenceEntry(threadId);
      return entry.semaphore
        .withPermits(1)(effect)
        .pipe(Effect.ensuring(releaseEntry(threadId, entry)));
    });

  const withThreadLockOrBypass = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const entry = referenceEntry(threadId);
      const deadlineMs = Date.now() + Duration.toMillis(URGENT_LOCK_WAIT);
      // Polling `withPermitsIfAvailable` instead of racing a timeout against a
      // pending acquisition: a timed-out `take` can strand a permit and wedge
      // the thread's lifecycle for the life of the process.
      const attempt: Effect.Effect<A, E, R> = Effect.suspend(() =>
        entry.semaphore
          .withPermitsIfAvailable(1)(effect)
          .pipe(
            Effect.flatMap((result) => {
              if (Option.isSome(result)) return Effect.succeed(result.value);
              if (Date.now() < deadlineMs) {
                return Effect.sleep(URGENT_LOCK_POLL).pipe(Effect.andThen(attempt));
              }
              return Effect.logWarning(
                "provider lifecycle lock bypassed for an urgent control-plane operation",
                { threadId, waitedMs: Duration.toMillis(URGENT_LOCK_WAIT) },
              ).pipe(Effect.andThen(effect));
            }),
          ),
      );
      return attempt.pipe(Effect.ensuring(releaseEntry(threadId, entry)));
    });

  type FinalOwnership =
    | { readonly _tag: "generation"; readonly generation: string }
    | { readonly _tag: "retired" };
  interface PublishedGeneration {
    readonly generation: string;
    readonly previousGeneration: string | undefined;
    ownedGeneration: string;
    finalOwnership: FinalOwnership | undefined;
  }

  const publishGeneration = (threadId: ThreadId): Effect.Effect<PublishedGeneration> =>
    generationStabilityLock.withLock(
      threadId,
      Effect.sync(() => {
        const generation = randomUUID();
        const previousGeneration = currentGenerations.get(threadId);
        currentGenerations.set(threadId, generation);
        return {
          generation,
          previousGeneration,
          ownedGeneration: generation,
          finalOwnership: undefined,
        };
      }),
    );

  const settleGeneration = (
    threadId: ThreadId,
    published: PublishedGeneration,
  ): Effect.Effect<void> =>
    // Lock ordering is lifecycle -> generation stability. `runStable` never
    // takes the lifecycle lock, so event ingestion cannot form a cycle with
    // control work that waits for runtime task settlement.
    generationStabilityLock.withLock(
      threadId,
      Effect.sync(() => {
        if (currentGenerations.get(threadId) !== published.ownedGeneration) return;
        if (published.finalOwnership?._tag === "generation") {
          currentGenerations.set(threadId, published.finalOwnership.generation);
        } else if (published.finalOwnership?._tag === "retired") {
          currentGenerations.delete(threadId);
        } else if (published.previousGeneration === undefined) {
          currentGenerations.delete(threadId);
        } else {
          currentGenerations.set(threadId, published.previousGeneration);
        }
      }),
    );

  const usePublishedGeneration = <A, E, R>(
    threadId: ThreadId,
    published: PublishedGeneration,
    operation: (lease: ProviderLifecycleLease) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    const isCurrent = () =>
      currentGenerations.get(threadId) === published.ownedGeneration;
    const adoptCurrentGeneration = (adoptedGeneration: string) => {
      if (!isCurrent()) return;
      currentGenerations.set(threadId, adoptedGeneration);
      published.ownedGeneration = adoptedGeneration;
      published.finalOwnership = {
        _tag: "generation",
        generation: adoptedGeneration,
      };
    };
    const withStableGeneration: ProviderLifecycleLease["withStableGeneration"] =
      (stableOperation) =>
        generationStabilityLock.withLock(
          threadId,
          Effect.suspend(() => stableOperation(adoptCurrentGeneration)),
        );
    const lease: ProviderLifecycleLease = {
      generation: published.generation,
      isCurrent,
      commit: () => {
        if (isCurrent()) {
          published.finalOwnership = {
            _tag: "generation",
            generation: published.generation,
          };
        }
      },
      adopt: (adoptedGeneration) =>
        withStableGeneration((adopt) =>
          Effect.sync(() => {
            adopt(adoptedGeneration);
          }),
        ),
      withStableGeneration,
      retire: () => {
        if (isCurrent()) {
          published.finalOwnership = { _tag: "retired" };
        }
      },
    };
    const publicationHook = options?.onGenerationPublished
      ? options.onGenerationPublished({
          threadId,
          generation: published.generation,
        })
      : Effect.void;
    return publicationHook.pipe(Effect.andThen(Effect.suspend(() => operation(lease))));
  };

  const run: ProviderLifecycleCoordinator["run"] = (threadId, operation) =>
    withThreadLock(
      threadId,
      Effect.acquireUseRelease(
        publishGeneration(threadId),
        (published) => usePublishedGeneration(threadId, published, operation),
        (published) => settleGeneration(threadId, published),
      ),
    );

  return {
    run,
    runCurrent: (threadId, operation) =>
      withThreadLock(
        threadId,
        Effect.suspend(() => operation(currentGenerations.get(threadId))),
      ),
    runStable: (threadId, operation) =>
      generationStabilityLock.withLock(
        threadId,
        Effect.suspend(() => operation(currentGenerations.get(threadId))),
      ),
    runCurrentUrgent: (threadId, operation) =>
      withThreadLockOrBypass(
        threadId,
        Effect.suspend(() => operation(currentGenerations.get(threadId))),
      ),
    adoptCurrent: (threadId, generation) => currentGenerations.set(threadId, generation),
    currentGeneration: (threadId) => currentGenerations.get(threadId),
  };
}
