import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";

import { DEVICE_WS_METHODS, ThreadId } from "@synara/contracts";

import { DeviceManager } from "./DeviceManager.ts";
import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";
import { makeWsDeviceHandlers } from "./wsDeviceHandlers.ts";

const THREAD = ThreadId.makeUnsafe("thread-a");
const DEVICE = "FAKE-0001";

async function setup() {
  const backend = new FakeDeviceBackend();
  const manager = new DeviceManager({ backend });
  await manager.boot(DEVICE);
  return { backend, manager, handlers: makeWsDeviceHandlers({ supported: true, manager }) };
}

describe("device WebSocket handlers", () => {
  it("handles every request method in the RPC group", async () => {
    const { handlers } = await setup();

    // The stream method is wired in wsRpc where the admission guard lives; the
    // other nineteen must all be present or the handler map is not exhaustive.
    const expected = Object.values(DEVICE_WS_METHODS).filter(
      (method) => method !== DEVICE_WS_METHODS.subscribeEvents,
    );
    expect(Object.keys(handlers).toSorted()).toEqual(expected.toSorted());
  });

  it("attaches a thread and reports the resulting state", async () => {
    const { handlers } = await setup();

    const state = await Effect.runPromise(
      handlers[DEVICE_WS_METHODS.attach]({ threadId: THREAD, udid: DEVICE }),
    );

    expect(state.attachedDeviceUdid).toBe(DEVICE);
    expect(state.availability).toEqual({ kind: "available" });
  });

  it("routes input through to the backend", async () => {
    const { backend, handlers } = await setup();

    await Effect.runPromise(handlers[DEVICE_WS_METHODS.tap]({ udid: DEVICE, x: 12, y: 34 }));
    await Effect.runPromise(
      handlers[DEVICE_WS_METHODS.pressButton]({ udid: DEVICE, button: "home" }),
    );

    expect(backend.callsOfKind("tap")[0]).toMatchObject({ x: 12, y: 34 });
    expect(backend.callsOfKind("pressButton")[0]).toMatchObject({ button: "home" });
  });

  it("delegates recording start and stop to the device manager", async () => {
    const { backend, handlers } = await setup();

    const started = await Effect.runPromise(
      handlers[DEVICE_WS_METHODS.startRecording]({ udid: DEVICE }),
    );
    const stopped = await Effect.runPromise(
      handlers[DEVICE_WS_METHODS.stopRecording]({ udid: DEVICE }),
    );

    expect(stopped.path).toBe(started.path);
    expect(backend.callsOfKind("startRecording")).toHaveLength(1);
    expect(backend.callsOfKind("stopRecording")).toHaveLength(1);
  });

  it("turns a backend failure into an RPC error carrying its message", async () => {
    const { handlers } = await setup();

    const exit = await Effect.runPromiseExit(
      handlers[DEVICE_WS_METHODS.tap]({ udid: "FAKE-0002", x: 1, y: 1 }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(JSON.stringify(exit.cause)).toContain("not booted");
  });
});

describe("device WebSocket handlers without a backend", () => {
  it("refuses control methods with a single clear message", async () => {
    const handlers = makeWsDeviceHandlers(undefined);

    const exit = await Effect.runPromiseExit(handlers[DEVICE_WS_METHODS.list]({}));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(JSON.stringify(exit.cause)).toContain("requires macOS");
  });

  it("exposes and refuses both recording methods", async () => {
    const handlers = makeWsDeviceHandlers(undefined);

    expect(typeof handlers[DEVICE_WS_METHODS.startRecording]).toBe("function");
    expect(typeof handlers[DEVICE_WS_METHODS.stopRecording]).toBe("function");
    const startExit = await Effect.runPromiseExit(
      handlers[DEVICE_WS_METHODS.startRecording]({ udid: DEVICE }),
    );
    const stopExit = await Effect.runPromiseExit(
      handlers[DEVICE_WS_METHODS.stopRecording]({ udid: DEVICE }),
    );
    expect(Exit.isFailure(startExit)).toBe(true);
    if (Exit.isFailure(startExit)) {
      expect(JSON.stringify(startExit.cause)).toContain("requires macOS");
    }
    expect(Exit.isFailure(stopExit)).toBe(true);
    if (Exit.isFailure(stopExit)) {
      expect(JSON.stringify(stopExit.cause)).toContain("requires macOS");
    }
  });

  it("still answers getThreadState so the pane can render its unsupported state", async () => {
    const handlers = makeWsDeviceHandlers(undefined);

    const state = await Effect.runPromise(
      handlers[DEVICE_WS_METHODS.getThreadState]({ threadId: THREAD }),
    );

    expect(state.availability.kind).toBe("unsupported-platform");
    expect(state.devices).toEqual([]);
  });
});
