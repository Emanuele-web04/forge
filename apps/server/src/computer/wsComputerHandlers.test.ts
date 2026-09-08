import { COMPUTER_WS_METHODS } from "@synara/contracts";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { ComputerManager } from "./ComputerManager.ts";
import { desktopOperationSignal, withDesktopOperationSignal } from "./DesktopOperationQueue.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { makeWsComputerHandlers } from "./wsComputerHandlers.ts";

function setup() {
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager({ backend });
  const handlers = makeWsComputerHandlers({
    supported: true,
    availability: { kind: "available", backend: "fake" },
    manager,
  });
  return { backend, manager, handlers };
}

describe("computer WebSocket handlers", () => {
  it("refuses pane targeting inherited from a completed operation before reentering the queue", async () => {
    const { backend, manager } = setup();
    const release = Promise.withResolvers<void>();
    let detached: Promise<unknown> | undefined;
    await withDesktopOperationSignal(new AbortController().signal, async () => {
      detached = release.promise.then(() =>
        manager.withUserPointTarget({ x: 10, y: 20 }, (target) => manager.click(undefined, target)),
      );
    });
    const refused = expect(detached).rejects.toThrow("operation has ended");
    release.resolve();
    try {
      await refused;
      expect(backend.callsFor("click")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it.each(["click", "scroll", "key"] as const)(
    "does not dispatch queued pane %s after its RPC is interrupted",
    async (kind) => {
      const { backend, manager, handlers } = setup();
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const blocking = manager.withAgentActivity("owner", async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;
      const request =
        kind === "click"
          ? handlers[COMPUTER_WS_METHODS.inputClick]({ x: 400, y: 250 })
          : kind === "scroll"
            ? handlers[COMPUTER_WS_METHODS.inputScroll]({ x: 100, y: 120, deltaX: 0, deltaY: 48 })
            : handlers[COMPUTER_WS_METHODS.inputKey]({ key: "enter" });
      const fiber = Effect.runFork(request);
      try {
        // Let the RPC enter the manager while the first transaction owns the queue.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await Effect.runPromise(Fiber.interrupt(fiber));
        held.resolve();
        await blocking;
        // A subsequent admitted operation proves the cancelled queue entry drained.
        await manager.withAgentActivity("observer", async () => undefined);
        expect(backend.callsFor("click")).toHaveLength(0);
        expect(backend.callsFor("scroll")).toHaveLength(0);
        expect(backend.callsFor("pressKey")).toHaveLength(0);
      } finally {
        held.resolve();
        await blocking;
        await manager.dispose();
      }
    },
  );

  it("delivers RPC cancellation to active input and holds the queue until native cleanup settles", async () => {
    const { backend, manager, handlers } = setup();
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const pressKey = backend.pressKey.bind(backend);
    let activeSignal: AbortSignal | undefined;
    backend.pressKey = async (key) => {
      if (key !== "a") return pressKey(key);
      const signal = desktopOperationSignal();
      activeSignal = signal;
      entered.resolve();
      if (!signal) throw new Error("Missing native input cancellation signal");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      cancelled.resolve();
      await cleanup.promise;
      signal.throwIfAborted();
      return pressKey(key);
    };
    const fiber = Effect.runFork(handlers[COMPUTER_WS_METHODS.inputKey]({ key: "a" }));
    try {
      await entered.promise;
      expect(activeSignal).toBeDefined();
      await Effect.runPromise(Fiber.interrupt(fiber));
      await cancelled.promise;
      expect(activeSignal?.aborted).toBe(true);
      const next = Effect.runPromise(handlers[COMPUTER_WS_METHODS.inputKey]({ key: "b" }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(backend.callsFor("pressKey")).toHaveLength(0);
      cleanup.resolve();
      await next;
      expect(backend.callsFor("pressKey").map((call) => call.args)).toEqual([["b"]]);
    } finally {
      cleanup.resolve();
      await manager.dispose();
    }
  });

  it("handles every request method in the RPC group", () => {
    const { handlers } = setup();

    // The stream method is wired in wsRpc where the admission guard lives.
    const expected = Object.values(COMPUTER_WS_METHODS).filter(
      (method) => method !== COMPUTER_WS_METHODS.subscribeEvents,
    );
    expect(Object.keys(handlers).toSorted()).toEqual(expected.toSorted());
  });

  it("sends a pane click straight to the backend coordinate path", async () => {
    const { backend, handlers } = setup();

    const result = await Effect.runPromise(
      handlers[COMPUTER_WS_METHODS.inputClick]({ x: 400, y: 250 }),
    );

    expect(result.action).toBe("computer_click");
    expect(result.point).toEqual({ x: 400, y: 250 });
    expect(backend.callsFor("click").map((call) => call.args)).toEqual([[{ x: 400, y: 250 }]]);
    // A coordinate click must never pay for an accessibility tree read.
    expect(backend.callsFor("getState")).toHaveLength(0);
  });

  it("scopes a perception read to the requested window", async () => {
    const { backend, handlers } = setup();
    await Effect.runPromise(
      handlers[COMPUTER_WS_METHODS.getState]({ windowId: "w1", includeText: true }),
    );
    expect(backend.callsFor("getState").map((call) => call.args)).toEqual([
      [{ windowId: "w1", includeTree: true }],
    ]);
  });

  it("routes the right button and the double click to their own backend actions", async () => {
    const { backend, handlers } = setup();

    await Effect.runPromise(
      handlers[COMPUTER_WS_METHODS.inputClick]({ x: 10, y: 20, button: "right" }),
    );
    await Effect.runPromise(
      handlers[COMPUTER_WS_METHODS.inputClick]({ x: 30, y: 40, clickCount: 2 }),
    );

    expect(backend.callsFor("rightClick").map((call) => call.args)).toEqual([[{ x: 10, y: 20 }]]);
    expect(backend.callsFor("doubleClick").map((call) => call.args)).toEqual([[{ x: 30, y: 40 }]]);
    expect(backend.callsFor("click")).toHaveLength(0);
  });

  it("scrolls at the pointer position", async () => {
    const { backend, handlers } = setup();

    const result = await Effect.runPromise(
      handlers[COMPUTER_WS_METHODS.inputScroll]({ x: 100, y: 120, deltaX: -12, deltaY: 48 }),
    );

    expect(result.action).toBe("computer_scroll");
    expect(backend.callsFor("scroll").map((call) => call.args)).toEqual([
      [{ x: 100, y: 120 }, -12, 48],
    ]);
  });

  it("presses a bare key and turns modifiers into a held chord", async () => {
    const { backend, handlers } = setup();

    await Effect.runPromise(handlers[COMPUTER_WS_METHODS.inputKey]({ key: "enter" }));
    await Effect.runPromise(
      handlers[COMPUTER_WS_METHODS.inputKey]({ key: "c", modifiers: ["ctrl", "shift"] }),
    );
    // A duplicated modifier must not be pressed and released twice.
    await Effect.runPromise(
      handlers[COMPUTER_WS_METHODS.inputKey]({ key: "t", modifiers: ["alt", "alt"] }),
    );

    expect(backend.callsFor("pressKey").map((call) => call.args)).toEqual([["enter"]]);
    expect(backend.callsFor("hotkey").map((call) => call.args)).toEqual([
      [["ctrl", "shift", "c"]],
      [["alt", "t"]],
    ]);
  });

  it("reports a backend failure as an RPC error instead of dying", async () => {
    const { backend, handlers } = setup();
    backend.failNext("click");

    const exit = await Effect.runPromiseExit(
      handlers[COMPUTER_WS_METHODS.inputClick]({ x: 5, y: 5 }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? exit.cause : undefined;
    expect(JSON.stringify(failure)).toContain("click failed");
  });

  it("rejects a point outside the screen without touching the seat", async () => {
    const { backend, handlers } = setup();

    const exit = await Effect.runPromiseExit(
      handlers[COMPUTER_WS_METHODS.inputClick]({ x: 5_000, y: 5_000 }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(0);
  });

  it("refuses user input when no computer backend is supported", async () => {
    const handlers = makeWsComputerHandlers(undefined);

    const exit = await Effect.runPromiseExit(
      handlers[COMPUTER_WS_METHODS.inputKey]({ key: "escape" }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
