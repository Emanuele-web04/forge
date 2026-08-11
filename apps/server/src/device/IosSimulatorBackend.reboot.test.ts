import { describe, expect, it } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import {
  IosSimulatorBackend,
  isInputNotDeliveredError,
  isStaleDescriptorError,
} from "./IosSimulatorBackend.ts";
import type { HelperClient } from "./helperClient.ts";

const DEVICE = "AAAA-1111";

function simctlResult(stdout: string, code = 0): ProcessRunResult {
  return { stdout, stderr: "", code, signal: null, timedOut: false };
}

const DEVICE_LIST_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { udid: DEVICE, name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
    ],
  },
});

/**
 * Stands in for the helper process. It models the one behavior this defect is
 * about: an attachment is bound to a boot generation, and a descriptor from a
 * previous boot fails the way the real helper fails.
 */
class FakeHelper {
  attachCalls: Array<{ readonly udid: string; readonly force: boolean }> = [];
  /** Bumped by the test to simulate the simulator rebooting underneath us. */
  bootGeneration = 1;
  running = true;

  private attachment: { udid: string; generation: number } | null = null;

  get attachedDevice() {
    return this.attachment === null
      ? null
      : {
          udid: this.attachment.udid,
          pointWidth: 393,
          pointHeight: 852,
          pixelWidth: 1179,
          pixelHeight: 2556,
          scale: 3,
          inputAvailable: true,
          accessibilityAvailable: true,
        };
  }

  start(): void {}

  invalidateAttachment(udid: string): void {
    if (this.attachment?.udid === udid) this.attachment = null;
  }

  async attach(udid: string, options: { readonly force?: boolean } = {}) {
    this.attachCalls.push({ udid, force: options.force === true });
    if (!options.force && this.attachment?.udid === udid) {
      if (this.attachment.generation !== this.bootGeneration) {
        throw new Error("display has no framebuffer surface yet");
      }
      return this.attachedDevice!;
    }
    this.attachment = { udid, generation: this.bootGeneration };
    return this.attachedDevice!;
  }

  /** Set by a test to make the next N injections report non-delivery. */
  undeliverableCalls = 0;
  requestCalls: string[] = [];

  async request(method = "unknown") {
    this.requestCalls.push(method);
    if (this.attachment === null) throw new Error("not attached");
    if (this.attachment.generation !== this.bootGeneration) {
      throw new Error("display has no framebuffer surface yet");
    }
    if (this.undeliverableCalls > 0) {
      this.undeliverableCalls -= 1;
      throw new Error("1 HID event(s) were not delivered to the simulator; re-attach and retry");
    }
    return { ok: true };
  }

  normalize(x: number, y: number) {
    return { x: x / 393, y: y / 852 };
  }

  async startStream() {}
  async stopStream() {}
  async dispose() {}
}

function makeBackend() {
  const helper = new FakeHelper();
  const backend = new IosSimulatorBackend({
    platform: "darwin",
    helperCacheRoot: "/tmp/synara-device-test-cache",
    makeHelperClient: () => helper as unknown as HelperClient,
    run: async (command, args) => {
      if (command === "xcrun" && args[1] === "list") return simctlResult(DEVICE_LIST_JSON);
      if (command === "xcodebuild") return simctlResult("Xcode 26.2\nBuild version 17C52");
      return simctlResult("");
    },
  });
  // The helper is normally compiled on first attach; the fake stands in for the
  // compiled binary so these tests never touch the toolchain.
  Object.defineProperty(backend, "compileHelperIfNeeded", {
    value: async () => "/tmp/synara-device-test-cache/synara-device-helper",
  });
  return { backend, helper };
}

describe("stale descriptor detection", () => {
  it("recognizes the helper's dead-framebuffer failures", () => {
    expect(isStaleDescriptorError(new Error("display has no framebuffer surface yet"))).toBe(true);
    expect(isStaleDescriptorError(new Error("not attached to a simulator"))).toBe(true);
  });

  it("does not treat unrelated failures as stale descriptors", () => {
    // A genuine refusal must surface, not trigger a silent re-attach loop.
    expect(isStaleDescriptorError(new Error("simulator is not booted"))).toBe(false);
    expect(isStaleDescriptorError(new Error("unknown method 'tap'"))).toBe(false);
  });
});

describe("simulator reboot", () => {
  it("re-attaches after a Synara-driven shutdown and reboot", async () => {
    const { backend, helper } = makeBackend();
    await backend.tap(DEVICE, 10, 10);

    await backend.shutdown(DEVICE);
    helper.bootGeneration = 2;
    await backend.tap(DEVICE, 20, 20);

    // The shutdown dropped the cached attachment, so this is a clean re-attach
    // rather than a forced retry.
    expect(helper.attachCalls).toEqual([
      { udid: DEVICE, force: false },
      { udid: DEVICE, force: false },
    ]);
  });

  it("recovers when the device was rebooted outside Synara", async () => {
    const { backend, helper } = makeBackend();
    await backend.tap(DEVICE, 10, 10);

    // No shutdown call to observe: Simulator.app or the agent's own shell did
    // it, so the only signal is the failure itself.
    helper.bootGeneration = 2;
    await backend.tap(DEVICE, 20, 20);

    expect(helper.attachCalls.at(-1)).toEqual({ udid: DEVICE, force: true });
  });

  it("survives repeated boot, attach, shutdown cycles", async () => {
    const { backend, helper } = makeBackend();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      helper.bootGeneration = cycle;
      await backend.tap(DEVICE, 5, 5);
      await backend.shutdown(DEVICE);
    }

    // Every cycle worked; none fell into the permanent-failure state.
    expect(helper.attachCalls).toHaveLength(3);
    expect(helper.attachCalls.every((call) => !call.force)).toBe(true);
  });

  it("surfaces a non-descriptor failure instead of retrying it", async () => {
    const { backend, helper } = makeBackend();
    helper.attach = async () => {
      throw new Error("simulator is not booted");
    };

    await expect(backend.tap(DEVICE, 1, 1)).rejects.toThrow("not booted");
  });
});

describe("undelivered input recovery", () => {
  it("recognizes the helper's non-delivery report", () => {
    expect(
      isInputNotDeliveredError(
        new Error("1 HID event(s) were not delivered to the simulator; re-attach and retry"),
      ),
    ).toBe(true);
  });

  it("does not confuse it with unrelated failures", () => {
    expect(isInputNotDeliveredError(new Error("simulator is not booted"))).toBe(false);
    expect(isInputNotDeliveredError(new Error("display has no framebuffer surface"))).toBe(false);
  });

  it("rebinds the HID client and retries once when input does not reach the guest", async () => {
    const { backend, helper } = makeBackend();
    await backend.tap(DEVICE, 10, 10);
    helper.attachCalls.length = 0;

    // A stale HID client accepts the call but the event never lands. Before the
    // fix the helper acked this as success and the tap silently vanished.
    helper.undeliverableCalls = 1;
    await backend.tap(DEVICE, 20, 20);

    // The recovery path re-asserts the attachment and then forces a rebind, so
    // the retry lands on a freshly built HID client.
    expect(helper.attachCalls.some((call) => call.force)).toBe(true);
  });

  it("surfaces the failure when the retry also fails to deliver", async () => {
    const { backend, helper } = makeBackend();
    helper.undeliverableCalls = 5;

    await expect(backend.tap(DEVICE, 1, 1)).rejects.toThrow("not delivered");
  });
});
