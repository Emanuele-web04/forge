import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { makeKeyedLock } from "./keyedLock.ts";

describe("makeKeyedLock", () => {
  it("serializes callers for one key and releases the entry after the final waiter", async () => {
    const lock = makeKeyedLock<string>();
    const release = await Effect.runPromise(Deferred.make<void>());
    const order: string[] = [];

    const first = Effect.runFork(
      lock.withLock(
        "thread-1",
        Effect.sync(() => order.push("first-start")).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => order.push("first-end"))),
        ),
      ),
    );
    await Effect.runPromise(Effect.yieldNow);
    const second = Effect.runFork(
      lock.withLock(
        "thread-1",
        Effect.sync(() => order.push("second")),
      ),
    );
    await Effect.runPromise(Effect.yieldNow);

    expect(lock.activeKeyCount()).toBe(1);
    expect(order).toEqual(["first-start"]);

    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(first));
    await Effect.runPromise(Fiber.join(second));

    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(lock.activeKeyCount()).toBe(0);
  });

  it("releases entries after failures", async () => {
    const lock = makeKeyedLock<string>();

    await Effect.runPromise(Effect.exit(lock.withLock("thread-1", Effect.fail("boom"))));

    expect(lock.activeKeyCount()).toBe(0);
  });
});
