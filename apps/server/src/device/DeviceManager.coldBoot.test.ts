import { describe, expect, it } from "vitest";

import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";
import { DeviceManager } from "./DeviceManager.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";

/** The cold-boot failure: booted, but no display published yet. */
const NO_DISPLAY = "display has no framebuffer surface yet";

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Never observed: ${what}`);
}

async function waitForError(manager: DeviceManager): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const state = await manager.getThreadState(THREAD);
    if (state.lastError !== null) return state.lastError;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("No error was ever recorded");
}

describe("cold-boot attach", () => {
  it("waits out a display that has not been published yet", async () => {
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend, attachDeadlineMs: 5_000, attachRetryMs: 1 });
    const device = (await backend.listDevices({ includeShutdown: true }))[0]!;
    await backend.boot(device.udid);
    backend.failNextStream(NO_DISPLAY);

    const attached = await manager.attach(THREAD, device.udid);
    expect(attached.attachedDeviceUdid).toBe(device.udid);

    await waitFor(() => backend.hasStream(device.udid), "the retried attach to succeed");
    const settled = await manager.getThreadState(THREAD);
    // The retry worked, so nothing about the transient failure survives it.
    expect(settled.lastError).toBeNull();
    expect(settled.attachPhase).toBeNull();
    expect(backend.callsOfKind("attachStream").length).toBeGreaterThan(1);
  });

  it("tells the pane it is waiting on the display rather than spinning silently", async () => {
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend, attachDeadlineMs: 5_000, attachRetryMs: 50 });
    const device = (await backend.listDevices({ includeShutdown: true }))[0]!;
    await backend.boot(device.udid);
    backend.failEveryStream(NO_DISPLAY);

    await manager.attach(THREAD, device.udid);

    let phase: string | null | undefined;
    for (let attempt = 0; attempt < 500 && phase !== "waiting-for-display"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      phase = (await manager.getThreadState(THREAD)).attachPhase;
    }
    expect(phase).toBe("waiting-for-display");
  });

  it("gives up with an actionable message when the display never appears", async () => {
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend, attachDeadlineMs: 0, attachRetryMs: 1 });
    const device = (await backend.listDevices({ includeShutdown: true }))[0]!;
    await backend.boot(device.udid);
    backend.failEveryStream(NO_DISPLAY);

    await manager.attach(THREAD, device.udid);

    // Names what to do instead of repeating the helper's complaint about a
    // framebuffer surface, which tells the user nothing they can act on.
    expect(await waitForError(manager)).toContain("never published a screen");
    const state = await manager.getThreadState(THREAD);
    expect(state.attachPhase).toBeNull();
    // The attachment survives: input and the agent's tools still work, so the
    // device stays selected rather than making the user pick it again.
    expect(state.attachedDeviceUdid).toBe(device.udid);
  });

  it("reports a permanent refusal immediately instead of retrying it for a minute", async () => {
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend, attachDeadlineMs: 60_000, attachRetryMs: 1 });
    const device = (await backend.listDevices({ includeShutdown: true }))[0]!;
    await backend.boot(device.udid);
    backend.failEveryStream("the device helper could not be built");

    await manager.attach(THREAD, device.udid);

    expect(await waitForError(manager)).toContain("could not be built");
    // One attempt: a helper that will not compile will not compile in a second.
    expect(backend.callsOfKind("attachStream")).toHaveLength(1);
  });

  it("stops retrying once the thread moves to another device", async () => {
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend, attachDeadlineMs: 5_000, attachRetryMs: 5 });
    const devices = await backend.listDevices({ includeShutdown: true });
    const [first, second] = [devices[0]!, devices[1]!];
    await backend.boot(first.udid);
    await backend.boot(second.udid);
    backend.failEveryStream(NO_DISPLAY);

    await manager.attach(THREAD, first.udid);
    backend.clearStreamFailures();
    await manager.attach(THREAD, second.udid);

    await waitFor(() => backend.hasStream(second.udid), "the second device to stream");
    // A superseded retry loop must not write a phase or an error onto the
    // device the user actually switched to.
    const state = await manager.getThreadState(THREAD);
    expect(state.attachedDeviceUdid).toBe(second.udid);
    expect(state.lastError).toBeNull();
    expect(state.attachPhase).toBeNull();
  });
});
