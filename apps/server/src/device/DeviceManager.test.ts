import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceEvent } from "@synara/contracts";

import { DeviceBackendError } from "./DeviceBackend.ts";
import { DEVICE_IDLE_SHUTDOWN_MS, DeviceManager } from "./DeviceManager.ts";
import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";
const DEVICE_A = "FAKE-0001";
const DEVICE_B = "FAKE-0002";
const DEVICE_C = "FAKE-0003";
const DEVICE_D = "FAKE-0004";

function makeManager(backend = new FakeDeviceBackend()) {
  const events: DeviceEvent[] = [];
  const manager = new DeviceManager({ backend });
  manager.onEvent((event) => events.push(event));
  return { backend, manager, events };
}

describe("DeviceManager attachment", () => {
  it("attaches a thread to one device and streams it", async () => {
    const { backend, manager, events } = makeManager();
    await backend.boot(DEVICE_A);

    const state = await manager.attach(THREAD_A, DEVICE_A);

    expect(state.attachedDeviceUdid).toBe(DEVICE_A);
    expect(state.threadId).toBe(THREAD_A);
    expect(backend.hasStream(DEVICE_A)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "device.thread-state" });
  });

  it("versions thread snapshots monotonically so panes can drop stale pushes", async () => {
    const { backend, manager } = makeManager();
    await backend.boot(DEVICE_A);

    const first = await manager.attach(THREAD_A, DEVICE_A);
    const second = await manager.detach(THREAD_A);
    const third = await manager.attach(THREAD_A, DEVICE_A);

    expect(second.version).toBeGreaterThan(first.version);
    expect(third.version).toBeGreaterThan(second.version);
  });

  it("replaces the previous device when a thread attaches to another one", async () => {
    const { backend, manager } = makeManager();
    await backend.boot(DEVICE_A);
    await backend.boot(DEVICE_B);

    await manager.attach(THREAD_A, DEVICE_A);
    const state = await manager.attach(THREAD_A, DEVICE_B);

    expect(state.attachedDeviceUdid).toBe(DEVICE_B);
    expect(backend.hasStream(DEVICE_A)).toBe(false);
    expect(backend.hasStream(DEVICE_B)).toBe(true);
  });

  it("keeps the stream alive while another thread is still attached", async () => {
    const { backend, manager } = makeManager();
    await backend.boot(DEVICE_A);

    await manager.attach(THREAD_A, DEVICE_A);
    await manager.attach(THREAD_B, DEVICE_A);
    await manager.detach(THREAD_A);

    expect(backend.hasStream(DEVICE_A)).toBe(true);
  });

  it("keeps the attachment when the stream fails to start and records the error", async () => {
    const { backend, manager } = makeManager();
    await backend.boot(DEVICE_A);
    backend.failNext("attachStream", new DeviceBackendError("helper is not built"));

    const state = await manager.attach(THREAD_A, DEVICE_A);

    expect(state.attachedDeviceUdid).toBe(DEVICE_A);
    expect(state.lastError).toBe("helper is not built");
  });

  it("detaches and forgets a thread that gets archived", async () => {
    const { backend, manager } = makeManager();
    await backend.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);

    await manager.handleThreadArchived(THREAD_A);

    expect((await manager.getThreadState(THREAD_A)).attachedDeviceUdid).toBeNull();
    expect(backend.hasStream(DEVICE_A)).toBe(false);
  });
});

describe("DeviceManager discovery before the helper exists", () => {
  /** A fresh machine: simctl works, the helper has not been built yet. */
  const setupRequired = {
    kind: "setup-required" as const,
    steps: [
      { id: "install-xcode" as const, label: "Install Xcode", done: true },
      { id: "build-device-helper" as const, label: "Build the Synara device helper", done: false },
    ],
  };

  it("lists devices while the helper build is still outstanding", async () => {
    const backend = new FakeDeviceBackend({ availability: setupRequired });
    const { manager } = makeManager(backend);

    const result = await manager.list({ includeShutdown: true });

    // The helper is only built on first attach, and attaching needs a udid from
    // this list. Returning nothing here made that unreachable on a fresh
    // machine: empty picker, so no attach, so no helper, forever.
    expect(result.devices.map((device) => device.udid)).toContain(DEVICE_A);
    expect(result.availability).toEqual(setupRequired);
  });

  it("puts the devices in the thread snapshot too", async () => {
    const backend = new FakeDeviceBackend({ availability: setupRequired });
    const { manager } = makeManager(backend);

    const state = await manager.getThreadState(THREAD_A);

    expect(state.devices.map((device) => device.udid)).toContain(DEVICE_A);
    expect(state.availability).toEqual(setupRequired);
  });

  it("still lists devices when a previous helper build failed", async () => {
    const backend = new FakeDeviceBackend({
      availability: { kind: "helper-unavailable", message: "build failed" },
    });
    const { manager } = makeManager(backend);

    // The user can still see and boot devices; the pane explains why input and
    // video are unavailable.
    expect((await manager.list({ includeShutdown: true })).devices).not.toHaveLength(0);
  });

  it("reports no devices off a supported platform", async () => {
    const backend = new FakeDeviceBackend({
      availability: { kind: "unsupported-platform", platform: "linux" },
    });
    const { manager } = makeManager(backend);

    // The one case where discovery genuinely cannot run.
    expect((await manager.list({ includeShutdown: true })).devices).toEqual([]);
    expect((await manager.getThreadState(THREAD_A)).devices).toEqual([]);
  });

  it("degrades to an empty list when discovery itself fails", async () => {
    const backend = new FakeDeviceBackend({ availability: setupRequired });
    backend.listDevices = () => Promise.reject(new Error("xcrun exploded"));
    const { manager } = makeManager(backend);

    const result = await manager.list();

    expect(result.devices).toEqual([]);
    expect(result.availability).toEqual(setupRequired);
  });
});

describe("DeviceManager keyframe resync", () => {
  it("rebuilds the capture session so the encoder emits new parameter sets", async () => {
    const { backend, manager } = makeManager();
    await backend.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);

    await manager.requestKeyframe(DEVICE_A);

    // A fresh compression session is the only way to force an IDR: the helper
    // has no "keyframe now" call and the natural interval is seconds away.
    expect(backend.callsOfKind("detachStream")).toHaveLength(1);
    expect(backend.callsOfKind("attachStream")).toHaveLength(2);
    expect(backend.hasStream(DEVICE_A)).toBe(true);
  });

  it("does not restart the stream on a plain re-attach", async () => {
    const { backend, manager } = makeManager();
    await backend.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);

    await manager.attach(THREAD_A, DEVICE_A);

    // Re-attaching an already-attached device is a no-op, so a client cannot
    // use it to recover a stalled decoder; requestKeyframe exists for that.
    expect(backend.callsOfKind("attachStream")).toHaveLength(1);
  });

  it("drops cached frames so a late subscriber cannot get a stale keyframe", async () => {
    const { backend, manager } = makeManager();
    await backend.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    backend.emitFrame(DEVICE_A, { keyframe: true });

    await manager.requestKeyframe(DEVICE_A);
    const received: number[] = [];
    manager.subscribeFrames(DEVICE_A, {
      send: () => received.push(1),
      bufferedAmount: () => 0,
      isOpen: () => true,
    });

    expect(received).toHaveLength(0);
  });

  it("is a no-op for a device that is not streaming", async () => {
    const { backend, manager } = makeManager();
    await backend.boot(DEVICE_A);

    await manager.requestKeyframe(DEVICE_A);

    expect(backend.callsOfKind("attachStream")).toHaveLength(0);
  });
});

describe("DeviceManager boot ownership", () => {
  it("marks devices it booted as synara-owned and leaves discovered ones alone", async () => {
    const { backend, manager } = makeManager();
    backend.bootExternally(DEVICE_B);

    const booted = await manager.boot(DEVICE_A);
    const listed = await manager.list();

    expect(booted).toMatchObject({ kind: "booted" });
    expect(listed.devices.find((device) => device.udid === DEVICE_A)?.bootSource).toBe("synara");
    expect(listed.devices.find((device) => device.udid === DEVICE_B)?.bootSource).toBe("user");
  });

  it("refuses to boot past the cap and hands back the shutdown candidates", async () => {
    const { manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.boot(DEVICE_B);
    await manager.boot(DEVICE_C);

    const result = await manager.boot(DEVICE_D);

    expect(result.kind).toBe("boot-limit-reached");
    if (result.kind !== "boot-limit-reached") throw new Error("expected boot-limit-reached");
    expect(result.limit).toBe(3);
    expect(result.synaraBooted.map((device) => device.udid)).toEqual([
      DEVICE_A,
      DEVICE_B,
      DEVICE_C,
    ]);
  });

  it("does not count an already-booted device against the cap", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.boot(DEVICE_B);
    await manager.boot(DEVICE_C);
    backend.bootExternally(DEVICE_D);

    const result = await manager.boot(DEVICE_D);

    expect(result).toMatchObject({ kind: "booted" });
    expect(backend.callsOfKind("boot").map((call) => call.udid)).not.toContain(DEVICE_D);
  });

  it("frees a cap slot when a synara-booted device is shut down", async () => {
    const { manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.boot(DEVICE_B);
    await manager.boot(DEVICE_C);

    await manager.shutdown(DEVICE_A);

    expect(await manager.boot(DEVICE_D)).toMatchObject({ kind: "booted" });
  });

  it("drops the attachment of every thread watching a device that shuts down", async () => {
    const { manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    await manager.attach(THREAD_B, DEVICE_A);

    await manager.shutdown(DEVICE_A);

    expect((await manager.getThreadState(THREAD_A)).attachedDeviceUdid).toBeNull();
    expect((await manager.getThreadState(THREAD_B)).attachedDeviceUdid).toBeNull();
  });
});

describe("DeviceManager idle shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shuts down a synara-booted device after the idle timeout following detach", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    await manager.detach(THREAD_A);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(backend.callsOfKind("shutdown").map((call) => call.udid)).toEqual([DEVICE_A]);
  });

  it("never auto-shuts down a device the user booted", async () => {
    const { backend, manager } = makeManager();
    backend.bootExternally(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    await manager.detach(THREAD_A);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 4);

    expect(backend.callsOfKind("shutdown")).toHaveLength(0);
  });

  it("cancels the countdown when a thread re-attaches in time", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    await manager.detach(THREAD_A);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS / 2);
    await manager.attach(THREAD_B, DEVICE_A);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 2);

    expect(backend.callsOfKind("shutdown")).toHaveLength(0);
  });

  it("does not fire for a device that is still attached elsewhere", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    await manager.attach(THREAD_B, DEVICE_A);

    await manager.detach(THREAD_A);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 2);

    expect(backend.callsOfKind("shutdown")).toHaveLength(0);
  });
});

describe("DeviceManager lifecycle and agent activity", () => {
  it("shuts down only synara-booted devices on dispose", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    backend.bootExternally(DEVICE_B);
    await manager.attach(THREAD_A, DEVICE_B);

    await manager.dispose();

    expect(backend.callsOfKind("shutdown").map((call) => call.udid)).toEqual([DEVICE_A]);
    expect(backend.disposed).toBe(true);
  });

  it("reports agentActive for the span of an agent action and clears it after", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);

    let duringAction = false;
    await manager.withAgentActivity(THREAD_A, async () => {
      duringAction = (await manager.getThreadState(THREAD_A)).agentActive;
    });

    expect(duringAction).toBe(true);
    expect((await manager.getThreadState(THREAD_A)).agentActive).toBe(false);
    expect(backend.hasStream(DEVICE_A)).toBe(true);
  });

  it("keeps the badge lit until the last overlapping agent action finishes", async () => {
    const { manager } = makeManager();
    let innerFinished = false;

    await manager.withAgentActivity(THREAD_A, async () => {
      await manager.withAgentActivity(THREAD_A, async () => {
        innerFinished = true;
      });
      expect((await manager.getThreadState(THREAD_A)).agentActive).toBe(true);
    });

    expect(innerFinished).toBe(true);
    expect((await manager.getThreadState(THREAD_A)).agentActive).toBe(false);
  });

  it("emits an open-pane request carrying the owning thread", async () => {
    const { manager, events } = makeManager();

    manager.requestOpenPane(THREAD_A, DEVICE_A, "agent-launch");

    expect(events.at(-1)).toEqual({
      type: "device.open-pane-requested",
      threadId: THREAD_A,
      udid: DEVICE_A,
      reason: "agent-launch",
    });
  });

  it("reports unavailability without listing devices", async () => {
    const backend = new FakeDeviceBackend({
      availability: { kind: "unsupported-platform", platform: "linux" },
    });
    const { manager } = makeManager(backend);

    const result = await manager.list();

    expect(result.devices).toEqual([]);
    expect(result.availability).toEqual({ kind: "unsupported-platform", platform: "linux" });
  });
});
