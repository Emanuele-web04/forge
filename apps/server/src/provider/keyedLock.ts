import { Effect, Semaphore } from "effect";

export interface KeyedLock<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly activeKeyCount: () => number;
}

/**
 * Serialize work per key without retaining one semaphore for every key ever seen.
 * The user count includes queued callers, so cleanup waits for the final holder
 * or waiter to leave the critical section.
 */
export function makeKeyedLock<Key>(): KeyedLock<Key> {
  const entries = new Map<Key, { readonly semaphore: Semaphore.Semaphore; users: number }>();

  const withLock: KeyedLock<Key>["withLock"] = (key, effect) =>
    Effect.suspend(() => {
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        entries.set(key, entry);
      }
      entry.users += 1;
      const acquiredEntry = entry;
      return acquiredEntry.semaphore
        .withPermits(1)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              acquiredEntry.users -= 1;
              if (acquiredEntry.users === 0 && entries.get(key) === acquiredEntry) {
                entries.delete(key);
              }
            }),
          ),
        );
    });

  return {
    withLock,
    activeKeyCount: () => entries.size,
  };
}
