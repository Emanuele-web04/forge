import { Deferred, Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  evaluateAcpTurnIdleTick,
  forkAcpTurnIdleWatchdog,
  isAcpTurnProgressEventTag,
  resolveAcpTurnIdleTimeoutMs,
} from "./AcpTurnIdleWatchdog.ts";

describe("isAcpTurnProgressEventTag", () => {
  it("classifies genuine turn-progress events as progress", () => {
    expect(isAcpTurnProgressEventTag("ContentDelta")).toBe(true);
    expect(isAcpTurnProgressEventTag("ToolCallUpdated")).toBe(true);
    expect(isAcpTurnProgressEventTag("PlanUpdated")).toBe(true);
    expect(isAcpTurnProgressEventTag("AssistantItemStarted")).toBe(true);
    expect(isAcpTurnProgressEventTag("AssistantItemCompleted")).toBe(true);
  });
  it("does not treat heartbeats or unknown tags as progress", () => {
    expect(isAcpTurnProgressEventTag("ModeChanged")).toBe(false);
    expect(isAcpTurnProgressEventTag("UsageUpdated")).toBe(false);
    expect(isAcpTurnProgressEventTag("unknown")).toBe(false);
  });
});

describe("evaluateAcpTurnIdleTick", () => {
  it("stops once the turn is no longer active, regardless of idle state", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: false,
        isAwaitingHuman: false,
        idleMs: 10_000_000,
        idleTimeoutMs: 1,
      }),
    ).toBe("stop");
  });

  it("refreshes the clock while the turn is legitimately blocked on a human", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: true,
        idleMs: 10_000_000,
        idleTimeoutMs: 1,
      }),
    ).toBe("touch");
  });

  it("keeps watching while the turn is still within the idle budget", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 5_000,
        idleTimeoutMs: 600_000,
      }),
    ).toBe("continue");
  });

  it("times out at or past the threshold", () => {
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 600_000,
        idleTimeoutMs: 600_000,
      }),
    ).toBe("timeout");
    expect(
      evaluateAcpTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 600_001,
        idleTimeoutMs: 600_000,
      }),
    ).toBe("timeout");
  });
});

describe("resolveAcpTurnIdleTimeoutMs", () => {
  const envVar = "SYNARA_TEST_TURN_IDLE_TIMEOUT_MS";
  const defaultMs = 600_000;

  it("falls back to the default when unset, blank, or non-numeric", () => {
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: {} })).toBe(defaultMs);
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "   " } })).toBe(
      defaultMs,
    );
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "soon" } })).toBe(
      defaultMs,
    );
  });

  it("rejects non-positive overrides so a typo cannot disable the backstop", () => {
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "0" } })).toBe(
      defaultMs,
    );
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "-5000" } })).toBe(
      defaultMs,
    );
  });

  it("accepts a positive numeric override (trimmed)", () => {
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "30000" } })).toBe(
      30_000,
    );
    expect(resolveAcpTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "  45000  " } })).toBe(
      45_000,
    );
  });
});

describe("forkAcpTurnIdleWatchdog", () => {
  it("force-fails a turn that has been idle past the threshold", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fired = yield* Deferred.make<number>();
      let active = true;

      yield* forkAcpTurnIdleWatchdog({
        idleTimeoutMs: 1,
        checkIntervalMs: 1,
        scope,
        isTurnActive: () => active,
        isAwaitingHuman: () => false,
        // Epoch baseline → the turn reads as effectively infinitely idle.
        lastActivityAt: () => 0,
        touchActivity: () => {},
        onIdleTimeout: (idleMs) =>
          Effect.gen(function* () {
            active = false;
            yield* Deferred.succeed(fired, idleMs);
          }),
      });

      const idleMs = yield* Deferred.await(fired);
      yield* Scope.close(scope, Exit.void);
      return idleMs;
    });

    const idleMs = await Effect.runPromise(program);
    expect(idleMs).toBeGreaterThan(0);
  });

  it("does not fire while the turn keeps reporting fresh activity", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      let fired = false;

      yield* forkAcpTurnIdleWatchdog({
        idleTimeoutMs: 60_000,
        checkIntervalMs: 1,
        scope,
        isTurnActive: () => true,
        isAwaitingHuman: () => false,
        // Always "just now" → never crosses the 60s threshold.
        lastActivityAt: () => Date.now(),
        touchActivity: () => {},
        onIdleTimeout: () =>
          Effect.sync(() => {
            fired = true;
          }),
      });

      yield* Effect.sleep(25);
      yield* Scope.close(scope, Exit.void);
      return fired;
    });

    const fired = await Effect.runPromise(program);
    expect(fired).toBe(false);
  });

  it("uses the live timeout override for provider work hidden from the parent stream", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      let fired = false;
      let nestedWorkActive = true;

      yield* forkAcpTurnIdleWatchdog({
        idleTimeoutMs: 1,
        currentIdleTimeoutMs: () => (nestedWorkActive ? 60_000 : 1),
        checkIntervalMs: 1,
        scope,
        isTurnActive: () => true,
        isAwaitingHuman: () => false,
        lastActivityAt: () => Date.now() - 100,
        touchActivity: () => {},
        onIdleTimeout: () =>
          Effect.sync(() => {
            fired = true;
          }),
      });

      yield* Effect.sleep(10);
      const stayedAliveDuringNestedWork = !fired;
      nestedWorkActive = false;
      yield* Effect.sleep(10);
      yield* Scope.close(scope, Exit.void);
      return { fired, stayedAliveDuringNestedWork };
    });

    await expect(Effect.runPromise(program)).resolves.toEqual({
      fired: true,
      stayedAliveDuringNestedWork: true,
    });
  });
});
