import { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { makeSessionTeardownGate } from "./SessionTeardownGate.ts";

describe("SessionTeardownGate", () => {
  it("blocks replacement work until the tracked teardown completes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeSessionTeardownGate();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const completion = yield* Deferred.make<void>();
        let replacementStarted = false;
        gate.track(threadId, completion);
        expect(gate.isPending(threadId)).toBe(true);

        const replacement = yield* gate.awaitPending(threadId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              replacementStarted = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(replacementStarted).toBe(false);

        yield* gate.complete(threadId, completion);
        yield* Fiber.join(replacement);
        expect(replacementStarted).toBe(true);
        expect(gate.isPending(threadId)).toBe(false);
      }),
    );
  });

  it("does not let stale cleanup clear a newer teardown gate", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeSessionTeardownGate();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const oldCompletion = yield* Deferred.make<void>();
        const newCompletion = yield* Deferred.make<void>();
        let replacementStarted = false;
        gate.track(threadId, oldCompletion);
        gate.track(threadId, newCompletion);

        yield* gate.complete(threadId, oldCompletion);
        expect(gate.isPending(threadId)).toBe(true);
        const replacement = yield* gate.awaitPending(threadId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              replacementStarted = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(replacementStarted).toBe(false);

        yield* gate.complete(threadId, newCompletion);
        yield* Fiber.join(replacement);
        expect(replacementStarted).toBe(true);
      }),
    );
  });
});
