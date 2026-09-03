// Runs independent shutdown work together without letting one failure cancel the rest.

import { Effect, Exit } from "effect";

export function settleConcurrentTeardowns<Item, E, R>(
  items: Iterable<Item>,
  teardown: (item: Item) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> {
  return Effect.gen(function* () {
    const results = yield* Effect.forEach(
      Array.from(items),
      (item) => Effect.exit(teardown(item)),
      { concurrency: "unbounded" },
    );
    const failed = results.find(Exit.isFailure);
    if (failed) {
      return yield* Effect.failCause(failed.cause);
    }
  });
}
