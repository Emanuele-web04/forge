import { Deferred, Effect } from "effect";

export interface KeyedLock<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly withLockQueued: <A, E, R>(
    key: Key,
    effect: Effect.Effect<A, E, R>,
    queued: Deferred.Deferred<void>,
  ) => Effect.Effect<A, E, R>;
  readonly activeKeyCount: () => number;
}

/**
 * Serialize work per key without retaining one semaphore for every key ever seen.
 * The user count includes queued callers, so cleanup waits for the final holder
 * or waiter to leave the critical section.
 */
export function makeKeyedLock<Key>(): KeyedLock<Key> {
  const entries = new Map<Key, { tail: Deferred.Deferred<void>; users: number }>();

  const queueWithLock = <A, E, R>(
    key: Key,
    effect: Effect.Effect<A, E, R>,
    queued?: Deferred.Deferred<void>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let entry = entries.get(key);
      if (entry === undefined) {
        const available = Deferred.makeUnsafe<void>();
        Deferred.doneUnsafe(available, Effect.void);
        entry = { tail: available, users: 0 };
        entries.set(key, entry);
      }
      const previous = entry.tail;
      const completed = Deferred.makeUnsafe<void>();
      entry.tail = completed;
      entry.users += 1;
      const acquiredEntry = entry;
      if (queued !== undefined) {
        Deferred.doneUnsafe(queued, Effect.void);
      }
      return Effect.uninterruptibleMask((restore) =>
        Deferred.await(previous).pipe(
          Effect.andThen(restore(effect)),
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(completed, Effect.void);
              acquiredEntry.users -= 1;
              if (acquiredEntry.users === 0 && entries.get(key) === acquiredEntry) {
                entries.delete(key);
              }
            }),
          ),
        ),
      );
    });

  const withLock: KeyedLock<Key>["withLock"] = (key, effect) => queueWithLock(key, effect);
  const withLockQueued: KeyedLock<Key>["withLockQueued"] = (key, effect, queued) =>
    queueWithLock(key, effect, queued);

  return {
    withLock,
    withLockQueued,
    activeKeyCount: () => entries.size,
  };
}
