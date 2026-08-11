/**
 * Degraded-capability behavior at the backend boundary.
 *
 * The point of the per-capability probe is that one moved symbol costs exactly
 * one feature. These tests drive a real `IosSimulatorBackend` with a stubbed
 * process runner so a broken capability can be simulated without an Xcode that
 * actually broke.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import {
  DEVICE_HELPER_BINARY_NAME,
  deviceHelperCacheKey,
  deviceHelperSourceRevision,
} from "@synara/shared/deviceHelperCache";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";
import type { HelperClient } from "./helperClient.ts";

/** The real helper sources, whose digest forms part of the cache key. */
const HELPER_SOURCE_DIR = path.resolve(import.meta.dirname, "..", "..", "native", "device-helper");

const DEVICE = "AAAA-1111";

const ok = (stdout: string): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

const DEVICE_LIST_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { udid: DEVICE, name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
    ],
  },
});

const probePayload = (capabilities: Record<string, unknown>): string =>
  JSON.stringify({
    ok: Object.values(capabilities).every((value) => value === "ok"),
    protocolVersion: 1,
    capabilities,
    toolchain: { xcodeVersion: "26.3", xcodeBuild: "17D1", macOS: "Version 26.3" },
  });

const ALL_OK = {
  framebuffer: "ok",
  hid: "ok",
  accessibility: "ok",
  encoder: "ok",
} as const;

/** A helper whose attach always succeeds; capability gating runs before it. */
class StubHelper {
  get attachedDevice() {
    return {
      udid: DEVICE,
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
  invalidateAttachment(): void {}
  async attach() {
    return this.attachedDevice;
  }
  normalize(x: number, y: number) {
    return { x, y };
  }
  async request() {
    return { tree: { role: "Application" } };
  }
  async startStream() {}
  async stopStream() {}
  async dispose() {}
}

/**
 * The cache directory name the backend will look for, derived rather than
 * hardcoded so this fixture keeps matching when the helper sources change.
 */
async function capabilityCacheKey(): Promise<string> {
  const sourcesDir = path.join(HELPER_SOURCE_DIR, "Sources");
  const names = await readdir(sourcesDir);
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      contents: await readFile(path.join(sourcesDir, name), "utf8"),
    })),
  );
  const script = await readFile(path.join(HELPER_SOURCE_DIR, "build.sh"), "utf8");
  const revision = deviceHelperSourceRevision([...files, { name: "build.sh", contents: script }]);
  return deviceHelperCacheKey("Xcode 26.3\nBuild version 17D1", revision)!;
}

/**
 * A backend wired to a cache directory containing a fake helper binary, so
 * `cachedHelperPath()` resolves and the probe runs.
 */
async function makeBackend(capabilities: Record<string, unknown>) {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "synara-capability-"));
  // The directory name must match the key the backend derives, or the cache
  // lookup misses and no probe runs. That key is the stubbed `xcodebuild
  // -version` output plus a digest of the helper sources, so it is derived here
  // the same way rather than hardcoded — a helper change must move the cache.
  const binaryDir = path.join(cacheRoot, await capabilityCacheKey());
  await mkdir(binaryDir, { recursive: true });
  const binaryPath = path.join(binaryDir, DEVICE_HELPER_BINARY_NAME);
  await writeFile(binaryPath, "#!/bin/sh\n");

  const probeCalls: (readonly string[])[] = [];

  const backend = new IosSimulatorBackend({
    platform: "darwin",
    helperCacheRoot: cacheRoot,
    makeHelperClient: () => new StubHelper() as unknown as HelperClient,
    run: async (command, args) => {
      // The probe is confined like the real run, so on macOS it arrives as
      // `sandbox-exec ... <binary> --probe`. Match either shape and record the
      // helper's own argv, so this asserts on the probe rather than the wrapper.
      const probeIndex = args.indexOf(binaryPath);
      if (command === binaryPath || (command.endsWith("sandbox-exec") && probeIndex !== -1)) {
        probeCalls.push(command === binaryPath ? args : args.slice(probeIndex + 1));
        return ok(probePayload(capabilities));
      }
      if (command === "xcode-select") return ok("/Applications/Xcode.app/Contents/Developer");
      if (command === "xcodebuild") {
        return args.includes("-license") ? ok("") : ok("Xcode 26.3\nBuild version 17D1");
      }
      if (command === "xcrun") return ok(DEVICE_LIST_JSON);
      return ok("");
    },
  });

  return { backend, probeCalls };
}

describe("availability from the capability probe", () => {
  it("is available when every capability passes", async () => {
    const { backend } = await makeBackend(ALL_OK);

    const availability = await backend.availability();

    expect(availability.kind).toBe("available");
  });

  it("is degraded — not setup-required — when one capability fails", async () => {
    const { backend } = await makeBackend({
      ...ALL_OK,
      accessibility: { missingSymbol: "AXPTranslator" },
    });

    const availability = await backend.availability();

    expect(availability.kind).toBe("degraded");
    if (availability.kind !== "degraded") throw new Error("expected degraded");
    expect(availability.capabilities.filter((capability) => !capability.ok)).toEqual([
      { id: "accessibility", ok: false, missingSymbol: "AXPTranslator", detail: undefined },
    ]);
    expect(availability.toolchain?.xcodeVersion).toBe("26.3");
  });

  it("probes once per helper binary rather than on every availability check", async () => {
    const { backend, probeCalls } = await makeBackend(ALL_OK);

    await backend.availability();
    await backend.availability();

    // The answer only changes when the toolchain does, and that produces a
    // different binary path.
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]).toEqual(["--probe"]);
  });
});

describe("operations backed by a broken capability", () => {
  let backend: IosSimulatorBackend;

  beforeEach(async () => {
    ({ backend } = await makeBackend({
      ...ALL_OK,
      accessibility: { missingSymbol: "AXPTranslator" },
    }));
  });

  it("fails describeUi with the capability and the Xcode that broke it", async () => {
    await expect(backend.describeUi(DEVICE)).rejects.toThrow(
      /Accessibility inspection is unavailable with Xcode 26\.3 \(17D1\).*AXPTranslator/u,
    );
  });

  it("leaves input working when only accessibility is broken", async () => {
    await expect(backend.tap(DEVICE, 10, 10)).resolves.toBeUndefined();
    await expect(backend.typeText(DEVICE, "hello")).resolves.toBeUndefined();
  });

  it("leaves streaming working when only accessibility is broken", async () => {
    await expect(backend.attachStream(DEVICE, () => {})).resolves.toBeUndefined();
  });
});

describe("hardware buttons", () => {
  it("presses every button the chassis draws", async () => {
    const { backend } = await makeBackend(ALL_OK);

    // Volume reaches the guest as a HID Consumer-page event (page 0x0C,
    // 0xE9/0xEA) rather than an Indigo button source, which is the encoding
    // Simulator.app's own Increase/Decrease Volume menu items use. Verified on
    // a booted iPhone 17 Pro by the volume HUD appearing in the framebuffer.
    for (const button of ["home", "lock", "volume-up", "volume-down"] as const) {
      await expect(backend.pressButton(DEVICE, button)).resolves.toBeUndefined();
    }
  });
});

describe("a broken input path", () => {
  it("fails tap precisely while accessibility keeps working", async () => {
    const { backend } = await makeBackend({
      ...ALL_OK,
      hid: { missingSymbol: "IndigoHIDMessageForButton" },
    });

    await expect(backend.tap(DEVICE, 1, 1)).rejects.toThrow(
      /Touch and keyboard input is unavailable.*IndigoHIDMessageForButton/u,
    );
    await expect(backend.describeUi(DEVICE)).resolves.toMatchObject({ udid: DEVICE });
  });

  it("keeps screenshots working even when the framebuffer path is broken", async () => {
    // Screenshots run on `simctl io`, so they are deliberately not gated on the
    // helper's framebuffer capability.
    const { backend } = await makeBackend({
      ...ALL_OK,
      framebuffer: { missingSymbol: "SimServiceContext" },
    });

    await expect(backend.attachStream(DEVICE, () => {})).rejects.toThrow(
      /Screen capture is unavailable/u,
    );
  });
});
