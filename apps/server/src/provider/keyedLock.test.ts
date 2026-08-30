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

  it("signals after a waiter is queued without waiting for the current holder", async () => {
    const lock = makeKeyedLock<string>();
    const release = await Effect.runPromise(Deferred.make<void>());
    const queued = await Effect.runPromise(Deferred.make<void>());
    const order: string[] = [];

    const first = Effect.runFork(lock.withLock("thread-1", Deferred.await(release)));
    await Effect.runPromise(Effect.yieldNow);
    const second = Effect.runFork(
      lock.withLockQueued(
        "thread-1",
        Effect.sync(() => order.push("second")),
        queued,
      ),
    );

    await Effect.runPromise(Deferred.await(queued));
    const third = Effect.runFork(
      lock.withLock(
        "thread-1",
        Effect.sync(() => order.push("third")),
      ),
    );
    expect(order).toEqual([]);

    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(first));
    await Effect.runPromise(Fiber.join(second));
    await Effect.runPromise(Fiber.join(third));

    expect(order).toEqual(["second", "third"]);
    expect(lock.activeKeyCount()).toBe(0);
  });

  it("interrupts a queued waiter without letting later callers overtake the holder", async () => {
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
    const second = Effect.runFork(lock.withLock("thread-1", Effect.void));
    await Effect.runPromise(Effect.yieldNow);

    const interrupted = Effect.runPromise(Fiber.interrupt(second));
    await expect(
      Promise.race([
        interrupted.then(() => "interrupted"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 500)),
      ]),
    ).resolves.toBe("interrupted");

    const third = Effect.runFork(
      lock.withLock(
        "thread-1",
        Effect.sync(() => order.push("third")),
      ),
    );
    await Effect.runPromise(Effect.yieldNow);
    expect(order).toEqual(["first-start"]);

    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(first));
    await Effect.runPromise(Fiber.join(third));

    expect(order).toEqual(["first-start", "first-end", "third"]);
    expect(lock.activeKeyCount()).toBe(0);
  });
});
