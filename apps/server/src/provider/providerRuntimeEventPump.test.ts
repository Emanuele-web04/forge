import { Cause, Deferred, Effect, Fiber, Option, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@synara/contracts";

import {
  makeProviderRuntimeEventPumpHealthRegistry,
  runProviderRuntimeEventPump,
} from "./providerRuntimeEventPump.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-runtime-pump");
const TURN_ID = TurnId.makeUnsafe("turn-runtime-pump");

function completedEvent(eventId: string): ProviderRuntimeEvent {
  return {
    type: "turn.completed",
    eventId: EventId.makeUnsafe(eventId),
    provider: "codex",
    createdAt: "2026-07-23T20:00:00.000Z",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: { state: "completed" },
  };
}

describe("providerRuntimeEventPump", () => {
  it("retries the current event before consuming the next queue item", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          const processed: string[] = [];
          let attempts = 0;

          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              Effect.gen(function* () {
                attempts += 1;
                if (attempts === 1) {
                  return yield* Effect.fail(new Error("sqlite busy"));
                }
                processed.push(event.eventId);
                yield* Deferred.succeed(completed, undefined);
              }),
            updateHealth: health.update,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          yield* Queue.offer(queue, completedEvent("event-retried"));
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(attempts).toBe(2);
          expect(processed).toEqual(["event-retried"]);
          expect(health.snapshot()[0]).toMatchObject({
            provider: "codex",
            status: "healthy",
            consecutiveFailures: 0,
          });
        }),
      ),
    );
  });

  it("restarts an Adapter stream that dies unexpectedly", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          let subscriptions = 0;

          const stream = Stream.unwrap(
            Effect.sync(() => {
              subscriptions += 1;
              return subscriptions === 1
                ? Stream.die(new Error("adapter stream defect"))
                : Stream.fromQueue(queue);
            }),
          );
          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream,
            processEvent: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
            updateHealth: health.update,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          yield* Queue.offer(queue, completedEvent("event-after-restart"));
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(subscriptions).toBeGreaterThanOrEqual(2);
          expect(health.snapshot()[0]?.status).toBe("healthy");
        }),
      ),
    );
  });

  it("quarantines a permanent event failure and continues with later events", async () => {
    class PermanentEventError extends Error {}

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          const processed: string[] = [];
          const quarantined: string[] = [];

          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              event.eventId === "event-poison"
                ? Effect.fail(new PermanentEventError("invalid canonical event"))
                : Effect.sync(() => processed.push(event.eventId)).pipe(
                    Effect.andThen(Deferred.succeed(completed, undefined)),
                    Effect.asVoid,
                  ),
            updateHealth: health.update,
            isPermanentFailure: (cause) =>
              Option.match(Cause.findErrorOption(cause), {
                onNone: () => false,
                onSome: (error) => error instanceof PermanentEventError,
              }),
            quarantineEvent: (event) =>
              Effect.sync(() => {
                quarantined.push(event.eventId);
              }),
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          yield* Queue.offerAll(queue, [
            completedEvent("event-poison"),
            completedEvent("event-after-poison"),
          ]);
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(processed).toEqual(["event-after-poison"]);
          expect(quarantined).toEqual(["event-poison"]);
          expect(health.snapshot()[0]).toMatchObject({
            status: "degraded",
            quarantinedEvents: 1,
            lastQuarantinedEventId: "event-poison",
          });
        }),
      ),
    );
  });

  it("heals a degraded pump after sustained successful processing", async () => {
    class PermanentEventError extends Error {}

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          const processed: string[] = [];

          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              event.eventId === "event-poison"
                ? Effect.fail(new PermanentEventError("invalid canonical event"))
                : Effect.sync(() => {
                    processed.push(event.eventId);
                  }).pipe(
                    Effect.andThen(
                      event.eventId === "event-heal-3"
                        ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
            updateHealth: health.update,
            isPermanentFailure: (cause) =>
              Option.match(Cause.findErrorOption(cause), {
                onNone: () => false,
                onSome: (error) => error instanceof PermanentEventError,
              }),
            quarantineEvent: () => Effect.void,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
            degradedHealAfterSuccesses: 3,
          }).pipe(Effect.forkScoped);

          yield* Queue.offerAll(queue, [
            completedEvent("event-poison"),
            completedEvent("event-heal-1"),
            completedEvent("event-heal-2"),
            completedEvent("event-heal-3"),
          ]);
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(processed).toEqual(["event-heal-1", "event-heal-2", "event-heal-3"]);
          // Healed: no longer degraded, but the quarantine forensics survive.
          expect(health.snapshot()[0]).toMatchObject({
            status: "healthy",
            quarantinedEvents: 0,
            lastQuarantinedEventId: "event-poison",
          });
        }),
      ),
    );
  });
});
