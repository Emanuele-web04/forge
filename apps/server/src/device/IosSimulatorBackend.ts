/**
 * IosSimulatorBackend - the one DeviceBackend implementation today.
 *
 * Split by capability:
 *
 * - Discovery, boot/shutdown, install/launch/openurl, and screenshots go
 *   through `xcrun simctl`, which is public, stable, and needs no permissions.
 * - Input injection, the accessibility tree, and the video stream need private
 *   CoreSimulator/SimulatorKit APIs, so they go through the native helper
 *   (see `helperClient.ts`), compiled on demand against the user's Xcode.
 *
 * Availability is modelled rather than inferred from errors: the pane renders a
 * checklist (`DeviceAvailability`) instead of a stack trace, so every probe
 * here maps onto exactly one setup step.
 *
 * @module device/IosSimulatorBackend
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import * as path from "node:path";

import type {
  DeviceAvailability,
  DeviceDescribeUiResult,
  DeviceDescriptor,
  DeviceHardwareButton,
  DeviceInstallAppResult,
  DeviceLaunchAppResult,
  DeviceScreenshotResult,
  DeviceSetupStep,
} from "@synara/contracts";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceFrameListener,
  type DeviceKeyEvent,
  type DeviceListOptions,
  type DeviceSwipeGesture,
} from "./DeviceBackend.ts";
import { HELPER_METHODS, HelperClient, type DeviceHelperError } from "./helperClient.ts";

const SIMCTL_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 120_000;
/** Screenshots are PNG on stdout-adjacent temp files; cap what we will read. */
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;

export const DEVICE_HELPER_CACHE_ROOT = path.join(
  homedir(),
  "Library",
  "Caches",
  "synara",
  "device-helper",
);

export interface IosSimulatorBackendOptions {
  /** Overridden in tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Absolute path to `apps/server/native/device-helper`. */
  readonly helperSourceDir?: string;
  readonly helperCacheRoot?: string;
  readonly run?: typeof runProcess;
  readonly makeHelperClient?: (binaryPath: string) => HelperClient;
}

interface SimctlDevice {
  readonly udid?: unknown;
  readonly name?: unknown;
  readonly state?: unknown;
  readonly isAvailable?: unknown;
}

function mapSimctlState(raw: unknown): DeviceDescriptor["state"] {
  switch (String(raw)) {
    case "Booted":
      return "booted";
    case "Booting":
      return "booting";
    case "Shutting Down":
      return "shutting-down";
    default:
      return "shutdown";
  }
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-0` -> `iOS 26.0`. */
export function formatRuntimeIdentifier(identifier: string): string {
  const tail = identifier.split(".").pop() ?? identifier;
  const match = /^([A-Za-z]+)-(.+)$/u.exec(tail);
  if (!match) return tail;
  return `${match[1]} ${match[2]!.replace(/-/gu, ".")}`;
}

/**
 * Parse `simctl list devices --json`. Unavailable devices (runtime deleted,
 * profile missing) are dropped: showing them in the picker only produces boots
 * that fail.
 */
export function parseSimctlDevices(json: string): readonly DeviceDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DeviceBackendError("Could not parse simctl device list");
  }
  const devicesByRuntime = (parsed as { devices?: unknown }).devices;
  if (typeof devicesByRuntime !== "object" || devicesByRuntime === null) return [];

  const devices: DeviceDescriptor[] = [];
  for (const [runtimeIdentifier, rawList] of Object.entries(
    devicesByRuntime as Record<string, unknown>,
  )) {
    if (!Array.isArray(rawList)) continue;
    const runtime = formatRuntimeIdentifier(runtimeIdentifier);
    for (const raw of rawList as readonly SimctlDevice[]) {
      if (raw.isAvailable === false) continue;
      const udid = typeof raw.udid === "string" ? raw.udid : null;
      const name = typeof raw.name === "string" ? raw.name : null;
      if (!udid || !name) continue;
      devices.push({
        platform: "ios-simulator",
        udid,
        name,
        runtime,
        state: mapSimctlState(raw.state),
        // Discovery cannot attribute a boot; DeviceManager overrides the ones
        // it booted itself.
        bootSource: "user",
      });
    }
  }
  return devices;
}

export function hasBootableIosRuntime(devices: readonly DeviceDescriptor[]): boolean {
  return devices.length > 0;
}

export class IosSimulatorBackend implements DeviceBackend {
  readonly platform = "ios-simulator" as const;

  private readonly osPlatform: NodeJS.Platform;
  private readonly helperSourceDir: string;
  private readonly helperCacheRoot: string;
  private readonly run: typeof runProcess;
  private readonly makeHelperClient: (binaryPath: string) => HelperClient;

  private helper: HelperClient | null = null;
  private helperBuildFailure: string | null = null;
  private helperCompilation: Promise<string> | null = null;

  constructor(options: IosSimulatorBackendOptions = {}) {
    this.osPlatform = options.platform ?? process.platform;
    this.helperSourceDir =
      options.helperSourceDir ??
      path.resolve(import.meta.dirname, "..", "..", "native", "device-helper");
    this.helperCacheRoot = options.helperCacheRoot ?? DEVICE_HELPER_CACHE_ROOT;
    this.run = options.run ?? runProcess;
    this.makeHelperClient =
      options.makeHelperClient ?? ((binaryPath) => new HelperClient({ binaryPath }));
  }

  // ── Availability ───────────────────────────────────────────────────

  async availability(): Promise<DeviceAvailability> {
    if (this.osPlatform !== "darwin") {
      return { kind: "unsupported-platform", platform: this.osPlatform };
    }
    if (this.helperBuildFailure !== null) {
      return { kind: "helper-unavailable", message: this.helperBuildFailure };
    }

    const steps: DeviceSetupStep[] = [];
    const developerDir = await this.xcodeSelectPath();
    const xcodeInstalled = developerDir !== null && !developerDir.includes("CommandLineTools");
    steps.push({
      id: "install-xcode",
      label: "Install Xcode",
      done: xcodeInstalled,
      detail: xcodeInstalled ? undefined : "Install Xcode from the App Store, then open it once.",
    });
    steps.push({
      id: "select-xcode-command-line-tools",
      label: "Point the command line tools at Xcode",
      done: xcodeInstalled,
      detail: xcodeInstalled
        ? undefined
        : "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
    });

    const licenseAccepted = xcodeInstalled ? await this.xcodeLicenseAccepted() : false;
    steps.push({
      id: "accept-xcode-license",
      label: "Accept the Xcode license",
      done: licenseAccepted,
      detail: licenseAccepted ? undefined : "sudo xcodebuild -license accept",
    });

    const devices = licenseAccepted ? await this.listDevicesUnchecked() : [];
    const runtimeInstalled = hasBootableIosRuntime(devices);
    steps.push({
      id: "install-ios-runtime",
      label: "Install an iOS simulator runtime",
      done: runtimeInstalled,
      detail: runtimeInstalled ? undefined : "xcodebuild -downloadPlatform iOS",
    });

    // The helper is only built at first attach, so this step reports the cache
    // rather than forcing a compile during a routine availability probe.
    const helperBuilt = runtimeInstalled ? await this.cachedHelperPath().then(Boolean) : false;
    steps.push({
      id: "build-device-helper",
      label: "Build the Synara device helper",
      done: helperBuilt,
      detail: helperBuilt ? undefined : "Built automatically the first time you attach a device.",
    });

    return steps.every((step) => step.done)
      ? { kind: "available" }
      : { kind: "setup-required", steps };
  }

  // ── Discovery and lifecycle ────────────────────────────────────────

  async listDevices(options: DeviceListOptions = {}): Promise<readonly DeviceDescriptor[]> {
    const devices = await this.listDevicesUnchecked();
    return options.includeShutdown === true
      ? devices
      : devices.filter((device) => device.state !== "shutdown");
  }

  async boot(udid: string): Promise<DeviceDescriptor> {
    const result = await this.simctl(["boot", udid], { timeoutMs: BOOT_TIMEOUT_MS });
    // Booting an already-booted device is success, not failure: the pane and an
    // agent can race on the same device and neither should see an error.
    if (result.code !== 0 && !/current state: Booted/iu.test(result.stderr)) {
      throw this.simctlError("boot", result);
    }
    await this.simctl(["bootstatus", udid], { timeoutMs: BOOT_TIMEOUT_MS });
    const devices = await this.listDevicesUnchecked();
    const device = devices.find((candidate) => candidate.udid === udid);
    if (!device) throw new DeviceBackendError(`Device ${udid} disappeared after boot`);
    return { ...device, state: "booted" };
  }

  async shutdown(udid: string): Promise<void> {
    await this.detachStream(udid);
    const result = await this.simctl(["shutdown", udid]);
    if (result.code !== 0 && !/current state: Shutdown/iu.test(result.stderr)) {
      throw this.simctlError("shutdown", result);
    }
  }

  async install(udid: string, appPath: string): Promise<DeviceInstallAppResult> {
    const bundleId = await this.readBundleIdentifier(appPath);
    const result = await this.simctl(["install", udid, appPath]);
    if (result.code !== 0) throw this.simctlError("install", result);
    return { udid, bundleId };
  }

  async launch(
    udid: string,
    bundleId: string,
    launchArguments: readonly string[] = [],
  ): Promise<DeviceLaunchAppResult> {
    const result = await this.simctl(["launch", udid, bundleId, ...launchArguments]);
    if (result.code !== 0) throw this.simctlError("launch", result);
    // `simctl launch` prints `<bundleId>: <pid>`.
    const match = /:\s*(\d+)\s*$/u.exec(result.stdout.trim());
    return { udid, bundleId, pid: match ? Number.parseInt(match[1]!, 10) : null };
  }

  async openUrl(udid: string, url: string): Promise<void> {
    const result = await this.simctl(["openurl", udid, url]);
    if (result.code !== 0) throw this.simctlError("openurl", result);
  }

  async screenshot(udid: string): Promise<DeviceScreenshotResult> {
    const directory = await mkdtemp(path.join(tmpdir(), "synara-device-"));
    const file = path.join(directory, "screenshot.png");
    try {
      const result = await this.simctl(["io", udid, "screenshot", file]);
      if (result.code !== 0) throw this.simctlError("screenshot", result);
      const info = await stat(file);
      if (info.size > MAX_SCREENSHOT_BYTES) {
        throw new DeviceBackendError("Screenshot exceeded the maximum supported size");
      }
      const bytes = await readFile(file);
      const dimensions = readPngDimensions(bytes);
      return {
        udid,
        name: `simulator-${udid}.png`,
        mimeType: "image/png",
        width: dimensions?.width ?? 1,
        height: dimensions?.height ?? 1,
        sizeBytes: bytes.byteLength,
        bytesBase64: bytes.toString("base64"),
        capturedAt: new Date().toISOString(),
      };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── Helper-backed capabilities ─────────────────────────────────────

  async tap(udid: string, x: number, y: number): Promise<void> {
    await this.helperRequest(HELPER_METHODS.tap, { udid, x, y });
  }

  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    await this.helperRequest(HELPER_METHODS.swipe, { udid, ...gesture });
  }

  async typeText(udid: string, text: string): Promise<void> {
    await this.helperRequest(HELPER_METHODS.typeText, { udid, text });
  }

  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    await this.helperRequest(HELPER_METHODS.keyEvent, { udid, ...event });
  }

  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    await this.helperRequest(HELPER_METHODS.pressButton, { udid, button });
  }

  async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    const result = await this.helperRequest(HELPER_METHODS.describeUi, { udid });
    const root = (result as { root?: unknown } | null)?.root;
    if (typeof root !== "object" || root === null) {
      throw new DeviceBackendError("Device helper returned no accessibility tree");
    }
    return {
      udid,
      capturedAt: new Date().toISOString(),
      root: root as DeviceDescribeUiResult["root"],
    };
  }

  async attachStream(udid: string, onFrame: DeviceFrameListener): Promise<void> {
    const helper = await this.requireHelper();
    await helper.attachStream(udid, onFrame);
  }

  async detachStream(udid: string): Promise<void> {
    if (!this.helper) return;
    await this.helper.detachStream(udid).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    const helper = this.helper;
    this.helper = null;
    await helper?.dispose();
  }

  // ── simctl plumbing ────────────────────────────────────────────────

  private async simctl(
    args: readonly string[],
    options: { readonly timeoutMs?: number } = {},
  ): Promise<ProcessRunResult> {
    if (this.osPlatform !== "darwin") {
      throw new DeviceBackendError("iOS simulators are only available on macOS");
    }
    return await this.run("xcrun", ["simctl", ...args], {
      timeoutMs: options.timeoutMs ?? SIMCTL_TIMEOUT_MS,
      allowNonZeroExit: true,
      outputMode: "truncate",
    });
  }

  private simctlError(action: string, result: ProcessRunResult): DeviceBackendError {
    const detail = result.stderr.trim() || result.stdout.trim();
    return new DeviceBackendError(
      `simctl ${action} failed${detail ? `: ${detail}` : ""}`,
      // A timeout may still be progressing on the device; a refusal will not.
      { retryable: result.timedOut },
    );
  }

  private async listDevicesUnchecked(): Promise<readonly DeviceDescriptor[]> {
    if (this.osPlatform !== "darwin") return [];
    const result = await this.simctl(["list", "devices", "--json"]).catch(() => null);
    if (!result || result.code !== 0) return [];
    try {
      return parseSimctlDevices(result.stdout);
    } catch {
      return [];
    }
  }

  private async xcodeSelectPath(): Promise<string | null> {
    const result = await this.run("xcode-select", ["-p"], {
      timeoutMs: 10_000,
      allowNonZeroExit: true,
    }).catch(() => null);
    if (!result || result.code !== 0) return null;
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async xcodeLicenseAccepted(): Promise<boolean> {
    const result = await this.run("xcodebuild", ["-version"], {
      timeoutMs: 20_000,
      allowNonZeroExit: true,
    }).catch(() => null);
    return result !== null && result.code === 0;
  }

  private async readBundleIdentifier(appPath: string): Promise<string> {
    const plist = path.join(appPath, "Info.plist");
    const result = await this.run(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", plist],
      { timeoutMs: 10_000, allowNonZeroExit: true },
    ).catch(() => null);
    const bundleId = result?.code === 0 ? result.stdout.trim() : "";
    if (bundleId.length === 0) {
      throw new DeviceBackendError(`Could not read CFBundleIdentifier from ${plist}`);
    }
    return bundleId;
  }

  // ── Helper lifecycle ───────────────────────────────────────────────

  private async helperRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const helper = await this.requireHelper();
    try {
      return await helper.request(method, params);
    } catch (error) {
      const helperError = error as DeviceHelperError;
      throw new DeviceBackendError(helperError.message, {
        retryable: helperError.code === "helper_timeout",
        cause: error,
      });
    }
  }

  private async requireHelper(): Promise<HelperClient> {
    if (this.helper?.running) return this.helper;
    const binaryPath = await this.compileHelperIfNeeded();
    const helper = this.makeHelperClient(binaryPath);
    helper.start();
    this.helper = helper;
    return helper;
  }

  /**
   * Build the helper against the current Xcode, or reuse the cached binary.
   *
   * Keyed by the Xcode build number because the helper links private
   * frameworks whose symbols move between releases: a cache hit from a previous
   * Xcode would crash at runtime rather than fail to compile. Concurrent
   * callers share one compilation.
   */
  async compileHelperIfNeeded(): Promise<string> {
    const cached = await this.cachedHelperPath();
    if (cached) return cached;
    this.helperCompilation ??= this.compileHelper().finally(() => {
      this.helperCompilation = null;
    });
    return await this.helperCompilation;
  }

  private async compileHelper(): Promise<string> {
    const buildScript = path.join(this.helperSourceDir, "build.sh");
    const outputDirectory = path.join(this.helperCacheRoot, await this.xcodeBuildKey());
    const result = await this.run("/bin/sh", [buildScript, outputDirectory], {
      timeoutMs: 300_000,
      allowNonZeroExit: true,
      outputMode: "truncate",
    }).catch((error: unknown) => {
      throw this.recordHelperFailure(
        error instanceof Error ? error.message : "Device helper build could not start",
      );
    });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw this.recordHelperFailure(
        `Device helper build failed${detail ? `: ${detail}` : ""}. Verify Xcode is installed and its license accepted.`,
      );
    }
    const binaryPath = path.join(outputDirectory, "synara-device-helper");
    const exists = await stat(binaryPath).then(
      () => true,
      () => false,
    );
    if (!exists) {
      throw this.recordHelperFailure("Device helper build produced no binary");
    }
    this.helperBuildFailure = null;
    return binaryPath;
  }

  private recordHelperFailure(message: string): DeviceBackendError {
    // Remembered so `availability()` reports `helper-unavailable` instead of
    // the pane retrying a build that will keep failing the same way.
    this.helperBuildFailure = message;
    return new DeviceBackendError(message);
  }

  private async cachedHelperPath(): Promise<string | null> {
    if (this.osPlatform !== "darwin") return null;
    const key = await this.xcodeBuildKey().catch(() => null);
    if (key === null) return null;
    const binaryPath = path.join(this.helperCacheRoot, key, "synara-device-helper");
    return await stat(binaryPath).then(
      () => binaryPath,
      () => null,
    );
  }

  private async xcodeBuildKey(): Promise<string> {
    const result = await this.run("xcodebuild", ["-version"], {
      timeoutMs: 20_000,
      allowNonZeroExit: true,
    }).catch(() => null);
    if (!result || result.code !== 0) {
      throw this.recordHelperFailure(
        "Could not determine the Xcode version. Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
      );
    }
    // `Xcode 26.0\nBuild version 17A123` -> `26.0-17A123`.
    const version = /Xcode\s+([\d.]+)/u.exec(result.stdout)?.[1] ?? "unknown";
    const build = /Build version\s+(\S+)/u.exec(result.stdout)?.[1] ?? "unknown";
    return `${version}-${build}`;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width/height live in the IHDR chunk at a fixed offset; no decoder needed. */
export function readPngDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | null {
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
