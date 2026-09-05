import { Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ExecutableNotFoundError } from "@synara/shared/platformProcess";
import {
  classifyProviderStartupFailure,
  observeProviderStartup,
  ProviderStartupLifecycle,
  startupPhaseDurations,
} from "./providerStartupLifecycle";

function handshakingLifecycle(): ProviderStartupLifecycle {
  const lifecycle = new ProviderStartupLifecycle({ now: () => 1 });
  lifecycle.transition("starting");
  lifecycle.transition("handshaking");
  return lifecycle;
}

describe("ProviderStartupLifecycle", () => {
  it("records deterministic transitions and rejects illegal ones", () => {
    const lifecycle = handshakingLifecycle();
    lifecycle.transition("ready");
    lifecycle.transition("running");
    expect(lifecycle.snapshot().transitions.map((entry) => entry.phase)).toEqual([
      "discovering",
      "starting",
      "handshaking",
      "ready",
      "running",
    ]);
    expect(() => lifecycle.transition("starting")).toThrow(/Invalid provider startup transition/);
  });

  it("attributes elapsed time to each phase and totals the span", () => {
    let now = 1_000;
    const lifecycle = new ProviderStartupLifecycle({ now: () => now });
    now += 100;
    lifecycle.transition("starting");
    now += 250;
    lifecycle.transition("handshaking");
    now += 600;
    lifecycle.transition("ready");
    now += 50;
    lifecycle.transition("running");
    expect(startupPhaseDurations(lifecycle.snapshot())).toEqual({
      totalMs: 1_000,
      byPhase: { discovering: 100, starting: 250, handshaking: 600, ready: 50 },
    });
  });

  it("reports zero durations for an empty snapshot", () => {
    expect(startupPhaseDurations({ phase: "discovering", transitions: [] })).toEqual({
      totalMs: 0,
      byPhase: {},
    });
  });

  it("keeps the first terminal outcome", () => {
    const lifecycle = handshakingLifecycle();
    lifecycle.stop("Cancelled");
    lifecycle.fail("HandshakeTimeout");
    expect(lifecycle.snapshot()).toMatchObject({ phase: "stopped", failureReason: "Cancelled" });
  });

  it("classifies a missing executable ahead of message heuristics", () => {
    expect(classifyProviderStartupFailure(new ExecutableNotFoundError("provider"))).toBe(
      "ExecutableNotFound",
    );
    expect(classifyProviderStartupFailure(new Error("provider exited during startup"))).toBe(
      "ExitedDuringStartup",
    );
  });
});

describe("observeProviderStartup", () => {
  it("passes a ready session through without touching the lifecycle", async () => {
    const lifecycle = handshakingLifecycle();
    const started = await Effect.runPromise(
      observeProviderStartup(Effect.succeed("session"), { lifecycle, timeout: "1 second" }),
    );
    expect(started).toEqual(Option.some("session"));
    expect(lifecycle.phase).toBe("handshaking");
  });

  it("records an expired deadline as HandshakeTimeout, not as a cancellation", async () => {
    const lifecycle = handshakingLifecycle();
    const started = await Effect.runPromise(
      observeProviderStartup(Effect.never, { lifecycle, timeout: "10 millis" }),
    );
    expect(Option.isNone(started)).toBe(true);
    expect(lifecycle.snapshot()).toMatchObject({
      phase: "failed",
      failureReason: "HandshakeTimeout",
    });
  });

  it("records a start failure with its classified reason", async () => {
    const lifecycle = handshakingLifecycle();
    const failure = await Effect.runPromise(
      observeProviderStartup(Effect.fail(new ExecutableNotFoundError("provider")), {
        lifecycle,
        timeout: "1 second",
      }).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(ExecutableNotFoundError);
    expect(lifecycle.snapshot()).toMatchObject({
      phase: "failed",
      failureReason: "ExecutableNotFound",
    });
  });

  it("records an external interruption as Cancelled", async () => {
    const lifecycle = handshakingLifecycle();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          observeProviderStartup(Effect.never, { lifecycle, timeout: "1 minute" }),
        );
        yield* Effect.sleep("1 millis");
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(lifecycle.snapshot()).toMatchObject({ phase: "stopped", failureReason: "Cancelled" });
  });
});
