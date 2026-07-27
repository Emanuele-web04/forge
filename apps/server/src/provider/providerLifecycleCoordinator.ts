import { randomUUID } from "node:crypto";

import type { ThreadId } from "@synara/contracts";
import { Duration, Effect, Exit, Option } from "effect";
import * as Semaphore from "effect/Semaphore";

export interface ProviderLifecycleLease {
  readonly generation: string;
  readonly isCurrent: () => boolean;
  readonly adopt: (generation: string) => void;
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

/** Serializes provider lifecycle mutations per thread and gives each mutation a unique epoch. */
export function makeProviderLifecycleCoordinator(): ProviderLifecycleCoordinator {
  const locks = new Map<ThreadId, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  const currentGenerations = new Map<ThreadId, string>();

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

  const run: ProviderLifecycleCoordinator["run"] = (threadId, operation) =>
    withThreadLock(
      threadId,
      Effect.suspend(() => {
        const generation = randomUUID();
        const previousGeneration = currentGenerations.get(threadId);
        currentGenerations.set(threadId, generation);
        let ownedGeneration: string = generation;
        const isCurrent = () => currentGenerations.get(threadId) === ownedGeneration;
        return operation({
          generation,
          isCurrent,
          adopt: (adoptedGeneration) => {
            if (isCurrent()) {
              ownedGeneration = adoptedGeneration;
              currentGenerations.set(threadId, adoptedGeneration);
            }
          },
          retire: () => {
            if (isCurrent()) currentGenerations.delete(threadId);
          },
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && isCurrent()
              ? Effect.sync(() => {
                  if (previousGeneration === undefined) {
                    currentGenerations.delete(threadId);
                  } else {
                    currentGenerations.set(threadId, previousGeneration);
                  }
                })
              : Effect.void,
          ),
        );
      }),
    );

  return {
    run,
    runCurrent: (threadId, operation) =>
      withThreadLock(
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
