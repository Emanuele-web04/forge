// FILE: AcpLoadReplayGate.test.ts
// Purpose: Proves load-replay suppression waits for quiet, stays bounded, and releases waiters.
// Layer: Provider ACP helper tests

import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";

import { makeAcpLoadReplayGate } from "./AcpLoadReplayGate.ts";

describe("AcpLoadReplayGate", () => {
  it.effect("keeps an immediate first operation blocked until late replay goes quiet", () =>
    Effect.gen(function* () {
      const gate = yield* makeAcpLoadReplayGate({
        quietMs: 100,
        hardTimeoutMs: 1_000,
        onHardTimeout: () => Effect.void,
      });
      const settling = yield* gate.settle.pipe(Effect.forkChild);
      const firstOperation = yield* gate.awaitReady.pipe(Effect.forkChild);
      yield* gate.attachConsumer;

      yield* TestClock.adjust("90 millis");
      expect(yield* gate.isSuppressing).toBe(true);
      expect(yield* gate.suppressUpdate).toBe(true);

      yield* TestClock.adjust("90 millis");
      expect(yield* gate.isSuppressing).toBe(true);
      expect(yield* gate.suppressUpdate).toBe(true);

      yield* TestClock.adjust("100 millis");
      expect(yield* Fiber.join(firstOperation)).toBe("ready");
      yield* Fiber.join(settling);

      expect(yield* gate.isSuppressing).toBe(false);
      expect(yield* gate.suppressUpdate).toBe(false);
      yield* gate.release;
      expect(yield* gate.awaitReady).toBe("ready");
    }),
  );

  it.effect("opens at the hard cap and reports observable timeout evidence", () => {
    const evidence: Array<{ readonly elapsedMs: number }> = [];
    return Effect.gen(function* () {
      const gate = yield* makeAcpLoadReplayGate({
        quietMs: 1_000,
        hardTimeoutMs: 300,
        onHardTimeout: (timeout) =>
          Effect.sync(() => {
            evidence.push(timeout);
          }),
      });
      const settling = yield* gate.settle.pipe(Effect.forkChild);
      yield* gate.attachConsumer;

      yield* TestClock.adjust("250 millis");
      expect(yield* gate.suppressUpdate).toBe(true);
      yield* TestClock.adjust("50 millis");
      yield* Fiber.join(settling);

      expect(yield* gate.isSuppressing).toBe(false);
      expect(evidence).toEqual([{ elapsedMs: 300 }]);
    });
  });

  it.effect("starts its quiet and hard-cap clocks only after the consumer attaches", () => {
    const evidence: Array<{ readonly elapsedMs: number }> = [];
    return Effect.gen(function* () {
      const gate = yield* makeAcpLoadReplayGate({
        quietMs: 100,
        hardTimeoutMs: 300,
        onHardTimeout: (timeout) =>
          Effect.sync(() => {
            evidence.push(timeout);
          }),
      });
      const settling = yield* gate.settle.pipe(Effect.forkChild);

      yield* TestClock.adjust("5 seconds");
      expect(yield* gate.isSuppressing).toBe(true);

      yield* gate.attachConsumer;
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(settling);

      expect(evidence).toEqual([]);
      expect(yield* gate.isSuppressing).toBe(false);
    });
  });

  it.effect("releases every blocked waiter when startup fails or the session stops", () =>
    Effect.gen(function* () {
      const gate = yield* makeAcpLoadReplayGate({
        quietMs: 100,
        hardTimeoutMs: 1_000,
        onHardTimeout: () => Effect.void,
      });
      const firstWaiter = yield* gate.awaitReady.pipe(Effect.forkChild);
      const secondWaiter = yield* gate.awaitReady.pipe(Effect.forkChild);
      const settling = yield* gate.settle.pipe(Effect.forkChild);

      yield* gate.release;
      expect(yield* Fiber.join(firstWaiter)).toBe("released");
      expect(yield* Fiber.join(secondWaiter)).toBe("released");
      yield* Fiber.join(settling);
      yield* gate.release;

      expect(yield* gate.isSuppressing).toBe(false);
      expect(yield* gate.suppressUpdate).toBe(true);
    }),
  );
});
