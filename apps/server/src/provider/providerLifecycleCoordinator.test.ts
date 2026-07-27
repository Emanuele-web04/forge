// FILE: providerLifecycleCoordinator.test.ts
// Purpose: Verifies per-thread lifecycle serialization and generation ownership rules.
// Layer: Provider lifecycle unit tests
// Depends on: makeProviderLifecycleCoordinator.

import { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { makeProviderLifecycleCoordinator } from "./providerLifecycleCoordinator.ts";

const threadId = ThreadId.makeUnsafe("thread-lifecycle-coordinator");

describe("makeProviderLifecycleCoordinator", () => {
  it("publishes the run generation for the duration of a committed run", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const started = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            expect(coordinator.currentGeneration(threadId)).toBe(lease.generation);
            lease.commit();
            return lease.generation;
          }),
        );

        expect(coordinator.currentGeneration(threadId)).toBe(started);
      }),
    );
  });

  it("keeps the live generation when a run succeeds without taking ownership", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const live = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            lease.commit();
            return lease.generation;
          }),
        );

        // A superseded lifecycle mutation (e.g. an idle stop that lost its race
        // with new work) returns successfully without touching the provider.
        // It must not leave behind a generation the live runtime never emits:
        // that would silently drop every later runtime event for the thread.
        const observed = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            expect(coordinator.currentGeneration(threadId)).toBe(lease.generation);
            return "superseded" as const;
          }),
        );

        expect(observed).toBe("superseded");
        expect(coordinator.currentGeneration(threadId)).toBe(live);
      }),
    );
  });

  it("clears the generation when an uncommitted run succeeds on a fresh thread", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        yield* coordinator.run(threadId, () => Effect.void);

        expect(coordinator.currentGeneration(threadId)).toBeUndefined();
      }),
    );
  });

  it("restores the previous generation when a run fails before taking ownership", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const live = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            lease.commit();
            return lease.generation;
          }),
        );

        const result = yield* Effect.result(
          coordinator.run(threadId, () => Effect.fail("start failed" as const)),
        );

        expect(result._tag).toBe("Failure");
        expect(coordinator.currentGeneration(threadId)).toBe(live);
      }),
    );
  });

  it("keeps an owned generation when the run is interrupted after committing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const committed = yield* Deferred.make<string>();
        const fiber = yield* coordinator
          .run(threadId, (lease) =>
            Effect.sync(() => lease.commit()).pipe(
              Effect.andThen(Deferred.succeed(committed, lease.generation)),
              Effect.andThen(Effect.never),
            ),
          )
          .pipe(Effect.forkChild);

        const generation = yield* Deferred.await(committed);
        yield* Fiber.interrupt(fiber);

        // The started runtime outlives the interrupted request, so rewinding
        // here would orphan it exactly like an uncommitted run.
        expect(coordinator.currentGeneration(threadId)).toBe(generation);
      }),
    );
  });

  it("keeps an adopted generation and reports it as current", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            lease.adopt("legacy");
            expect(lease.isCurrent()).toBe(true);
          }),
        );

        expect(coordinator.currentGeneration(threadId)).toBe("legacy");
      }),
    );
  });

  it("retires the generation for a stopped thread", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        yield* coordinator.run(threadId, (lease) => Effect.sync(() => lease.commit()));
        yield* coordinator.run(threadId, (lease) => Effect.sync(() => lease.retire()));

        expect(coordinator.currentGeneration(threadId)).toBeUndefined();
      }),
    );
  });

  it("serializes runs per thread and exposes the newest committed generation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const release = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const order: Array<string> = [];

        const first = yield* coordinator
          .run(threadId, (lease) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  order.push("first");
                  lease.commit();
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        const second = yield* coordinator
          .run(threadId, (lease) =>
            Effect.sync(() => {
              order.push("second");
              lease.commit();
              return lease.generation;
            }),
          )
          .pipe(Effect.forkChild);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        const secondGeneration = yield* Fiber.join(second);

        expect(order).toEqual(["first", "second"]);
        expect(coordinator.currentGeneration(threadId)).toBe(secondGeneration);
      }),
    );
  });

  it("runs current-generation operations with the committed generation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const live = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            lease.commit();
            return lease.generation;
          }),
        );

        const seen = yield* coordinator.runCurrent(threadId, (generation) =>
          Effect.succeed(generation),
        );
        const seenUrgent = yield* coordinator.runCurrentUrgent(threadId, (generation) =>
          Effect.succeed(generation),
        );

        expect(seen).toBe(live);
        expect(seenUrgent).toBe(live);
      }),
    );
  });
});
