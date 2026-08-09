/**
 * IosSimulatorBackend - the one DeviceBackend implementation today.
 *
 * Split by capability:
 *
 * - Discovery, boot/shutdown, install/launch/openurl, screenshots, and screen
 *   recordings go through `xcrun simctl`, which is public, stable, and needs
 *   no permissions.
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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import type {
  DeviceAvailability,
  DeviceCapabilityId,
  DeviceDescribeUiResult,
  DeviceDescriptor,
  DeviceGeometry,
  DeviceHardwareButton,
  DeviceInstallAppResult,
  DeviceKeyModifier,
  DeviceLaunchAppResult,
  DeviceScreenshotResult,
  DeviceSetupStep,
  DeviceStartRecordingResult,
  DeviceStopRecordingResult,
  DeviceUiNode,
  DeviceUiPoint,
} from "@synara/contracts";

import {
  DEVICE_HELPER_BINARY_NAME,
  DEVICE_HELPER_CACHE_SEGMENTS,
  DEVICE_HELPER_SOURCE_DIR_ENV,
  deviceHelperCacheKey,
  readDeviceHelperSourceRevision,
} from "@synara/shared/deviceHelperCache";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceFrameListener,
  type DeviceKeyEvent,
  type DeviceListOptions,
  type DeviceSwipeGesture,
} from "./DeviceBackend.ts";
import { readDeviceTypeCatalogue, type DeviceTypeCatalogue } from "./deviceTypeCatalogue.ts";
import {
  availabilityFromProbe,
  capabilityUnavailableMessage,
  parseHelperProbe,
  type HelperProbeResult,
} from "./helperCapabilities.ts";
import { HELPER_METHODS, HelperClient, type DeviceHelperError } from "./helperClient.ts";
import {
  SANDBOX_OPT_OUT_ENV,
  sandboxedHelperCommand,
  type HelperSandboxCommand,
} from "./helperSandbox.ts";

const SIMCTL_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 120_000;
const RECORDING_START_TIMEOUT_MS = 10_000;
const RECORDING_STOP_GRACE_MS = 15_000;
const RECORDING_KILL_GRACE_MS = 1_000;
const MAX_RECORDING_STDERR_LENGTH = 64 * 1024;
/** Screenshots are PNG on stdout-adjacent temp files; cap what we will read. */
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;

export const DEVICE_HELPER_CACHE_ROOT = path.join(homedir(), ...DEVICE_HELPER_CACHE_SEGMENTS);

/**
 * Resolve the helper sources in both execution layouts.
 *
 * Source modules live under `src/device`, while tsdown collapses the server into
 * `dist/index.*` and the build copies the helper beside that bundle. Checking
 * the bundled layout first makes packaged desktop and published CLI builds use
 * their staged asset without changing the development path.
 */
export function resolveDeviceHelperSourceDir(
  moduleDirectory: string,
  sourceExists: (candidate: string) => boolean = (candidate) =>
    existsSync(path.join(candidate, "build.sh")),
  configuredDirectory: string | undefined = process.env[DEVICE_HELPER_SOURCE_DIR_ENV],
): string {
  if (configuredDirectory) {
    const external = path.resolve(configuredDirectory);
    if (sourceExists(external)) return external;
  }
  const bundled = path.resolve(moduleDirectory, "device-helper");
  if (sourceExists(bundled)) return bundled;
  return path.resolve(moduleDirectory, "..", "..", "native", "device-helper");
}

export type SpawnRecordingProcess = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface IosSimulatorBackendOptions {
  /** Overridden in tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Absolute path to `apps/server/native/device-helper`. */
  readonly helperSourceDir?: string;
  readonly helperCacheRoot?: string;
  readonly run?: typeof runProcess;
  readonly makeHelperClient?: (
    binaryPath: string,
    env?: NodeJS.ProcessEnv,
    launch?: HelperSandboxCommand,
  ) => HelperClient;
  /** Keeps the long-lived simctl process controllable in tests. */
  readonly spawnProcess?: SpawnRecordingProcess;
  /** Tests isolate output without changing the user's normal save location. */
  readonly recordingDirectory?: string;
  readonly now?: () => number;
  /** Overridden in tests to exercise DEVELOPER_DIR without mutating process.env. */
  readonly processEnv?: NodeJS.ProcessEnv;
}

interface ActiveRecording {
  readonly child: ChildProcessWithoutNullStreams;
  readonly path: string;
  startedAt: string;
  stderr: string;
}

interface SimctlDevice {
  readonly udid?: unknown;
  readonly name?: unknown;
  readonly state?: unknown;
  readonly isAvailable?: unknown;
  readonly deviceTypeIdentifier?: unknown;
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
export function parseSimctlDevices(
  json: string,
  catalogue: DeviceTypeCatalogue = new Map(),
): readonly DeviceDescriptor[] {
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
      const deviceType =
        typeof raw.deviceTypeIdentifier === "string"
          ? catalogue.get(raw.deviceTypeIdentifier)
          : undefined;
      devices.push({
        platform: "ios-simulator",
        udid,
        name,
        runtime,
        state: mapSimctlState(raw.state),
        // Discovery cannot attribute a boot; DeviceManager overrides the ones
        // it booted itself.
        bootSource: "user",
        // Known from the device type profile, so the pane can draw the right
        // chassis the moment a device is picked rather than after it streams.
        ...(deviceType ? { family: deviceType.family, geometry: deviceType.geometry } : {}),
      });
    }
  }
  return devices;
}

export function hasBootableIosRuntime(devices: readonly DeviceDescriptor[]): boolean {
  return devices.length > 0;
}

export async function selectRecordingDirectory(
  candidates: readonly string[],
  fallback: string,
): Promise<string> {
  for (const directory of candidates) {
    const usable = await stat(directory).then(
      async (info) => {
        if (!info.isDirectory()) return false;
        return await access(directory, fsConstants.W_OK).then(
          () => true,
          () => false,
        );
      },
      () => false,
    );
    if (usable) return directory;
  }
  return fallback;
}

export class IosSimulatorBackend implements DeviceBackend {
  readonly platform = "ios-simulator" as const;

  private readonly osPlatform: NodeJS.Platform;
  private readonly helperSourceDir: string;
  private readonly helperCacheRoot: string;
  private readonly run: typeof runProcess;
  private readonly makeHelperClient: (
    binaryPath: string,
    env?: NodeJS.ProcessEnv,
    launch?: HelperSandboxCommand,
  ) => HelperClient;
  /** One warning per backend when the helper runs unconfined. */
  private warnedUnsandboxed = false;
  private readonly spawnProcess: SpawnRecordingProcess;
  private readonly recordingDirectoryOverride: string | undefined;
  private readonly now: () => number;
  /** Injected so a test can set DEVELOPER_DIR without touching the real process. */
  private readonly processEnv: NodeJS.ProcessEnv;

  /** Geometry learned from helper attachments, keyed by udid. */
  private readonly deviceGeometry = new Map<string, DeviceGeometry>();
  /**
   * Screen geometry and product family per device type, read from the installed
   * simulator profiles. Cached for the process lifetime and shared by concurrent
   * callers: it only changes when a runtime is installed, and rebuilding it on
   * every listing would spawn a hundred processes per picker open.
   */
  private deviceTypes: Promise<DeviceTypeCatalogue> | null = null;
  private helper: HelperClient | null = null;
  private helperBuildFailure: string | null = null;
  private helperCompilation: Promise<string> | null = null;
  /** Keyed on the binary so a rebuilt helper is re-probed rather than assumed. */
  private helperProbe: { binaryPath: string; result: HelperProbeResult } | null = null;
  private readonly recordings = new Map<string, ActiveRecording>();
  private readonly recordingStarts = new Map<string, Promise<DeviceStartRecordingResult>>();
  private readonly recordingStops = new Map<string, Promise<DeviceStopRecordingResult>>();
  private readonly reservedRecordingPaths = new Set<string>();
  private disposed = false;

  constructor(options: IosSimulatorBackendOptions = {}) {
    this.osPlatform = options.platform ?? process.platform;
    this.processEnv = options.processEnv ?? process.env;
    this.helperSourceDir =
      options.helperSourceDir ??
      resolveDeviceHelperSourceDir(
        import.meta.dirname,
        undefined,
        this.processEnv[DEVICE_HELPER_SOURCE_DIR_ENV],
      );
    this.helperCacheRoot = options.helperCacheRoot ?? DEVICE_HELPER_CACHE_ROOT;
    this.run = options.run ?? runProcess;
    this.makeHelperClient =
      options.makeHelperClient ??
      ((binaryPath, env, launch) => new HelperClient({ binaryPath, env, launch }));
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args) => spawn(command, [...args], { stdio: "pipe", windowsHide: true }));
    this.recordingDirectoryOverride = options.recordingDirectory;
    this.now = options.now ?? Date.now;
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

    if (!steps.every((step) => step.done)) {
      return { kind: "setup-required", steps };
    }

    // Setup is complete, so the remaining question is whether the private
    // symbols the helper needs still exist on this Xcode. A failure there is
    // degraded, not setup-required: nothing is left for the user to install.
    const probe = await this.probeHelperCapabilities();
    return probe === null ? { kind: "available" } : availabilityFromProbe(probe);
  }

  /**
   * Run the built helper's per-capability preflight.
   *
   * Cached for the process lifetime, keyed on the helper binary path: the
   * answer only changes when the toolchain does, and a new toolchain produces a
   * different cache key and therefore a different path. Returns null when no
   * helper is built yet, since there is nothing to probe.
   */
  private async probeHelperCapabilities(): Promise<HelperProbeResult | null> {
    const binaryPath = await this.cachedHelperPath();
    if (binaryPath === null) return null;
    if (this.helperProbe?.binaryPath === binaryPath) return this.helperProbe.result;

    // Confined exactly like the real run: a preflight under looser privileges
    // would report capabilities the sandboxed helper cannot actually deliver.
    const env = await this.toolchainEnv();
    const launch = await this.sandboxFor([binaryPath, "--probe"], env);
    const result = await this.run(launch.command, [...launch.args], {
      timeoutMs: 30_000,
      allowNonZeroExit: true,
      env,
    }).catch(() => null);

    // A helper that will not launch is reported through the same shape, so
    // callers have one path to handle rather than two.
    const probe: HelperProbeResult =
      result === null
        ? {
            ok: false,
            capabilities: [],
            toolchain: undefined,
            error: "The device helper could not be launched.",
          }
        : parseHelperProbe(result.stdout);

    this.helperProbe = { binaryPath, result: probe };
    return probe;
  }

  /**
   * Throw when `capability` is broken on this machine, naming it and the Xcode
   * it broke on. Operations backed by a working capability never call this, so
   * one missing symbol cannot take the rest of the pane down.
   */
  async assertCapability(capability: DeviceCapabilityId): Promise<void> {
    const probe = await this.probeHelperCapabilities();
    if (probe === null) return;
    const status = probe.capabilities.find((entry) => entry.id === capability);
    if (!status || status.ok) return;
    throw new DeviceBackendError(capabilityUnavailableMessage(status, probe.toolchain));
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
    await this.stopRecordingForLifecycle(udid);
    await this.detachStream(udid);
    // The helper outlives the simulator, and its attachment holds a display
    // descriptor bound to this boot. Dropping it here means the next attach
    // rebinds instead of reusing a descriptor whose framebuffer is gone.
    this.helper?.invalidateAttachment(udid);
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

  async screenshot(
    udid: string,
    options: { readonly save?: boolean } = {},
  ): Promise<DeviceScreenshotResult> {
    // Captured to a temp file either way, because `simctl io screenshot` only
    // writes to a path. When the caller wants it kept, it is moved next to the
    // recordings afterwards rather than captured somewhere different.
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
      const savedPath = options.save === true ? await this.saveScreenshotFile(udid, bytes) : null;
      return {
        ...(savedPath ? { path: savedPath } : {}),
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

  /**
   * Keep a screenshot where the user will find it: the same Desktop/Downloads
   * directory recordings go to, named the same way, so one button's output does
   * not land somewhere different from the other's.
   */
  private async saveScreenshotFile(udid: string, bytes: Buffer): Promise<string> {
    const devices = await this.listDevicesUnchecked();
    const deviceName = devices.find((device) => device.udid === udid)?.name ?? udid;
    const target = await this.nextCapturePath(
      deviceName,
      new Date(this.now()).toISOString(),
      "png",
    );
    try {
      await writeFile(target, bytes);
      return target;
    } finally {
      // The reservation only guards against two captures in the same
      // millisecond choosing one name; the file on disk owns it from here.
      this.reservedRecordingPaths.delete(target);
    }
  }

  async startRecording(udid: string): Promise<DeviceStartRecordingResult> {
    if (this.disposed) throw new DeviceBackendError("The iOS simulator backend is disposed");
    if (this.recordings.has(udid) || this.recordingStarts.has(udid)) {
      throw new DeviceBackendError(`Device ${udid} is already recording`);
    }

    const starting = this.startRecordingProcess(udid);
    this.recordingStarts.set(udid, starting);
    try {
      return await starting;
    } finally {
      if (this.recordingStarts.get(udid) === starting) this.recordingStarts.delete(udid);
    }
  }

  async stopRecording(udid: string): Promise<DeviceStopRecordingResult> {
    const stopping = this.recordingStops.get(udid);
    if (stopping) return await stopping;

    const starting = this.recordingStarts.get(udid);
    if (starting) await starting;
    const resumedStopping = this.recordingStops.get(udid);
    if (resumedStopping) return await resumedStopping;
    const recording = this.recordings.get(udid);
    if (!recording) throw new DeviceBackendError(`Device ${udid} is not recording`);

    const pending = this.finishRecording(udid, recording);
    this.recordingStops.set(udid, pending);
    try {
      return await pending;
    } finally {
      if (this.recordingStops.get(udid) === pending) this.recordingStops.delete(udid);
    }
  }

  // ── Helper-backed capabilities ─────────────────────────────────────
  //
  // Each operation asserts only the capability it actually needs, so a symbol
  // Apple moved in one area cannot disable the others. Screenshots and screen
  // recordings are absent from this list on purpose: both run on public
  // `simctl io`, so they survive even a completely broken framebuffer path.

  /**
   * Send one HID injection, rebinding the helper's input client if the first
   * attempt was accepted but never reached the guest.
   *
   * The helper's HID client is bound to one boot of one simulator. When it goes
   * stale (the app under test relaunched, the device was rebooted outside
   * Synara, SimulatorKit dropped the connection) the injection silently
   * vanishes. The helper now reports that instead of acking it, and a forced
   * re-attach rebuilds the client, so the retry lands on a live one.
   */
  private async injectInput(
    udid: string,
    method: string,
    buildParams: (helper: HelperClient) => Record<string, unknown>,
  ): Promise<void> {
    await this.assertCapability("hid");
    const helper = await this.attachedHelper(udid);
    try {
      await this.helperRequest(method, buildParams(helper));
      return;
    } catch (error) {
      if (!isInputNotDeliveredError(error)) throw error;
    }
    const rebound = await this.attachedHelper(udid, { force: true });
    await this.helperRequest(method, buildParams(rebound));
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    await this.injectInput(udid, HELPER_METHODS.tap, (helper) => helper.normalize(x, y));
  }

  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    await this.injectInput(udid, HELPER_METHODS.swipe, (helper) => {
      const start = helper.normalize(gesture.fromX, gesture.fromY);
      const end = helper.normalize(gesture.toX, gesture.toY);
      return {
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
        durationMs: gesture.durationMs,
      };
    });
  }

  async typeText(udid: string, text: string): Promise<void> {
    await this.injectInput(udid, HELPER_METHODS.text, () => ({ text }));
  }

  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    // The helper takes one USB HID usage per call and tracks held modifiers
    // itself, so a chord is sent as its modifier keys around the main key.
    for (const modifier of event.modifiers) {
      const usage = HID_MODIFIER_USAGES[modifier];
      if (usage === undefined) continue;
      await this.injectInput(udid, HELPER_METHODS.key, () => ({
        usage,
        phase: event.direction,
      }));
    }
    await this.injectInput(udid, HELPER_METHODS.key, () => ({
      usage: event.keyCode,
      phase: event.direction,
    }));
  }

  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    if (button === "rotate") {
      // Rotation is a Simulator.app window command, not a HID button: there is
      // no HID usage for it and no simctl equivalent. Simulator.app posts a
      // Purple event through a category it compiles into its own executable,
      // and that port is not wired on a headless boot — calling it there is a
      // silent no-op (docs/device-pane-spec.md has the full probe). Refused
      // explicitly rather than pretending to work; the pane ships no rotate
      // control for the same reason, and this keeps the agent tool honest.
      throw new DeviceBackendError(
        "Rotating a headless simulator is not supported; rotate the device from inside the app or use Simulator.app.",
      );
    }
    await this.assertCapability("hid");
    await this.injectInput(udid, HELPER_METHODS.button, () => ({ name: button }));
  }

  async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    await this.assertCapability("accessibility");
    await this.attachedHelper(udid);
    const result = await this.helperRequest(HELPER_METHODS.describeUi, {});
    const tree = (result as { tree?: unknown } | null)?.tree;
    if (typeof tree !== "object" || tree === null) {
      throw new DeviceBackendError("Device helper returned no accessibility tree");
    }
    return {
      udid,
      capturedAt: new Date().toISOString(),
      root: normalizeUiNode(tree),
    };
  }

  geometry(udid: string): DeviceGeometry | null {
    return this.deviceGeometry.get(udid) ?? null;
  }

  async attachStream(udid: string, onFrame: DeviceFrameListener): Promise<void> {
    // Streaming needs both halves of the pipeline: the framebuffer to read and
    // the encoder to compress it.
    await this.assertCapability("framebuffer");
    await this.assertCapability("encoder");
    const helper = await this.attachedHelper(udid);
    await helper.startStream(udid, onFrame);
  }

  async detachStream(udid: string): Promise<void> {
    // The helper holds one attachment, so its stream is this device's stream.
    if (!this.helper || this.helper.attachedDevice?.udid !== udid) return;
    await this.helper.stopStream().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const active = Array.from(this.recordings.values());
    await Promise.all(active.map((recording) => this.interruptRecording(recording)));
    await Promise.allSettled(this.recordingStarts.values());
    this.recordings.clear();
    this.reservedRecordingPaths.clear();
    const helper = this.helper;
    this.helper = null;
    await helper?.dispose();
  }

  private async startRecordingProcess(udid: string): Promise<DeviceStartRecordingResult> {
    if (this.osPlatform !== "darwin") {
      throw new DeviceBackendError("iOS simulators are only available on macOS");
    }
    const devices = await this.listDevicesUnchecked();
    const deviceName = devices.find((device) => device.udid === udid)?.name ?? udid;
    const requestedAt = new Date(this.now()).toISOString();
    const outputPath = await this.nextCapturePath(deviceName, requestedAt, "mp4");
    if (this.disposed) {
      this.reservedRecordingPaths.delete(outputPath);
      throw new DeviceBackendError("The iOS simulator backend is disposed");
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess("xcrun", [
        "simctl",
        "io",
        udid,
        "recordVideo",
        "--codec=h264",
        outputPath,
      ]);
    } catch (cause) {
      this.reservedRecordingPaths.delete(outputPath);
      throw new DeviceBackendError(`Could not start simulator recording: ${errorText(cause)}`, {
        cause,
      });
    }

    const recording: ActiveRecording = {
      child,
      path: outputPath,
      startedAt: requestedAt,
      stderr: "",
    };
    this.recordings.set(udid, recording);
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer | string) => {
      recording.stderr = `${recording.stderr}${chunk.toString()}`.slice(
        -MAX_RECORDING_STDERR_LENGTH,
      );
    });
    child.once("close", () => {
      if (this.recordings.get(udid) === recording) this.recordings.delete(udid);
      this.reservedRecordingPaths.delete(outputPath);
    });

    try {
      await this.waitForRecordingStart(recording);
      if (processHasExited(child)) {
        throw new DeviceBackendError("simctl recordVideo exited as recording began");
      }
      recording.startedAt = new Date(this.now()).toISOString();
      return { udid, path: outputPath, startedAt: recording.startedAt };
    } catch (cause) {
      await this.interruptRecording(recording);
      if (this.recordings.get(udid) === recording) this.recordings.delete(udid);
      this.reservedRecordingPaths.delete(outputPath);
      await rm(outputPath, { force: true }).catch(() => undefined);
      if (cause instanceof DeviceBackendError) throw cause;
      throw new DeviceBackendError(`Could not start simulator recording: ${errorText(cause)}`, {
        cause,
      });
    }
  }

  private async finishRecording(
    udid: string,
    recording: ActiveRecording,
  ): Promise<DeviceStopRecordingResult> {
    await this.interruptRecording(recording);
    if (this.recordings.get(udid) === recording) this.recordings.delete(udid);
    this.reservedRecordingPaths.delete(recording.path);

    const info = await stat(recording.path).catch((cause: unknown) => {
      throw new DeviceBackendError(
        `Simulator recording finished without a readable file at ${recording.path}`,
        { cause },
      );
    });
    const stoppedAtMs = this.now();
    return {
      udid,
      path: recording.path,
      sizeBytes: info.size,
      durationMs: Math.max(0, Math.floor(stoppedAtMs - Date.parse(recording.startedAt))),
      stoppedAt: new Date(stoppedAtMs).toISOString(),
    };
  }

  private waitForRecordingStart(recording: ActiveRecording): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: { readonly error?: DeviceBackendError }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        recording.child.stderr.off("data", onStderr);
        recording.child.off("error", onError);
        recording.child.off("close", onClose);
        if (result.error) reject(result.error);
        else resolve();
      };
      const onStderr = (): void => {
        if (/Recording started/iu.test(recording.stderr)) finish({});
      };
      const onError = (cause: Error): void => {
        finish({
          error: new DeviceBackendError(
            `Could not start simulator recording: ${errorText(cause)}`,
            { cause },
          ),
        });
      };
      const onClose = (): void => {
        const detail = recording.stderr.trim();
        finish({
          error: new DeviceBackendError(
            `simctl recordVideo exited before recording started${detail ? `: ${detail}` : ""}`,
          ),
        });
      };
      const timer = setTimeout(() => {
        finish({
          error: new DeviceBackendError(
            `simctl recordVideo did not start within ${RECORDING_START_TIMEOUT_MS}ms`,
            { retryable: true },
          ),
        });
      }, RECORDING_START_TIMEOUT_MS);
      timer.unref?.();
      recording.child.stderr.on("data", onStderr);
      recording.child.once("error", onError);
      recording.child.once("close", onClose);
      if (processHasExited(recording.child)) onClose();
    });
  }

  private async interruptRecording(recording: ActiveRecording): Promise<void> {
    if (processHasExited(recording.child)) return;
    const gracefulExit = waitForProcessExit(recording.child, RECORDING_STOP_GRACE_MS);
    recording.child.kill("SIGINT");
    if (await gracefulExit) return;

    const forcedExit = waitForProcessExit(recording.child, RECORDING_KILL_GRACE_MS);
    recording.child.kill("SIGKILL");
    await forcedExit;
  }

  private async stopRecordingForLifecycle(udid: string): Promise<void> {
    const starting = this.recordingStarts.get(udid);
    if (starting) await starting.catch(() => undefined);
    if (!this.recordings.has(udid)) return;
    await this.stopRecording(udid).catch(() => undefined);
  }

  /** Unique path for a capture, shared by recordings (mp4) and screenshots (png). */
  private async nextCapturePath(
    deviceName: string,
    startedAt: string,
    extension: "mp4" | "png",
  ): Promise<string> {
    const directory = await this.recordingDirectory();
    const slug = slugDeviceName(deviceName);
    const timestamp = startedAt.replace(/[:.]/gu, "-");
    const base = `simulator-${slug}-${timestamp}`;
    for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
      const candidate = path.join(
        directory,
        `${base}${suffix === 1 ? "" : `-${suffix}`}.${extension}`,
      );
      if (this.reservedRecordingPaths.has(candidate)) continue;
      const exists = await stat(candidate).then(
        () => true,
        (cause: unknown) => {
          if (isMissingPathError(cause)) return false;
          throw new DeviceBackendError(`Could not inspect capture path ${candidate}`, { cause });
        },
      );
      if (exists) continue;
      this.reservedRecordingPaths.add(candidate);
      return candidate;
    }
    throw new DeviceBackendError(`Could not choose a unique capture path in ${directory}`);
  }

  private async recordingDirectory(): Promise<string> {
    if (this.recordingDirectoryOverride) return path.resolve(this.recordingDirectoryOverride);
    return await selectRecordingDirectory(
      [path.join(homedir(), "Desktop"), path.join(homedir(), "Downloads")],
      tmpdir(),
    );
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
      env: await this.toolchainEnv(),
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
    const [result, catalogue] = await Promise.all([
      this.simctl(["list", "devices", "--json"]).catch(() => null),
      this.deviceTypeCatalogue(),
    ]);
    if (!result || result.code !== 0) return [];
    try {
      return parseSimctlDevices(result.stdout, catalogue);
    } catch {
      return [];
    }
  }

  private async deviceTypeCatalogue(): Promise<DeviceTypeCatalogue> {
    if (this.osPlatform !== "darwin") return new Map();
    this.deviceTypes ??= readDeviceTypeCatalogue({
      run: this.run,
      env: await this.toolchainEnv(),
      // A failed read means no pre-boot geometry, not a broken pane, so it is
      // not remembered as a failure the way a helper build is.
    }).catch(() => new Map<string, never>());
    return await this.deviceTypes;
  }

  /**
   * The developer directory every simulator command runs against.
   *
   * `DEVELOPER_DIR` wins over the machine-wide selection, because that is how a
   * beta Xcode gets targeted: pointing one process at `Xcode-beta.app` is the
   * whole point, and `sudo xcode-select -s` would move every other build on the
   * machine onto the beta as well. Reading only `xcode-select -p` meant a user
   * who set the variable silently got the stable toolchain instead.
   */
  private developerDirOverride(): string | null {
    const override = this.processEnv.DEVELOPER_DIR?.trim();
    return override !== undefined && override.length > 0 ? override : null;
  }

  /**
   * Environment for `simctl`, `xcodebuild` and the helper build, pinning them
   * all to one toolchain. Without it a child process resolving `xcode-select -p`
   * for itself could pick a different Xcode than the one availability just
   * reported, which is how a beta run ends up half on each.
   */
  private async toolchainEnv(): Promise<NodeJS.ProcessEnv | undefined> {
    const developerDir = await this.xcodeSelectPath();
    return developerDir === null ? undefined : { ...this.processEnv, DEVELOPER_DIR: developerDir };
  }

  private async xcodeSelectPath(): Promise<string | null> {
    const override = this.developerDirOverride();
    if (override !== null) return override;
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
      env: await this.toolchainEnv(),
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
      throw this.helperError(error);
    }
  }

  private helperError(error: unknown): DeviceBackendError {
    const helperError = error as DeviceHelperError;
    return new DeviceBackendError(
      helperError?.message ?? "Device helper failed",
      // A timeout may still be progressing on the device; a refusal will not.
      { retryable: helperError?.code === "helper_timeout", cause: error },
    );
  }

  /**
   * The helper is bound to one simulator at a time and every input and read
   * method acts on that binding, so each call re-asserts it. `attach` is a
   * no-op when the device is already the attached one.
   */
  private async attachedHelper(
    udid: string,
    options: { readonly force?: boolean } = {},
  ): Promise<HelperClient> {
    const helper = await this.requireHelper();
    const remember = () => {
      const attachment = helper.attachedDevice;
      if (attachment?.udid === udid) {
        this.deviceGeometry.set(udid, {
          pointWidth: attachment.pointWidth,
          pointHeight: attachment.pointHeight,
          scale: attachment.scale,
        });
      }
    };
    try {
      await helper.attach(udid, options);
      remember();
    } catch (error) {
      // A device can also be rebooted outside Synara (Simulator.app, or simctl
      // in the agent's own shell), which no invalidation hook here can observe.
      // A dead-descriptor failure is therefore retried once with a forced
      // re-attach, which rebinds against the current boot.
      if (!isStaleDescriptorError(error)) throw this.helperError(error);
      try {
        await helper.attach(udid, { force: true });
        remember();
      } catch (retryError) {
        throw this.helperError(retryError);
      }
    }
    return helper;
  }

  private async requireHelper(): Promise<HelperClient> {
    if (this.helper?.running) return this.helper;
    const binaryPath = await this.compileHelperIfNeeded();
    // The helper resolves CoreSimulator out of DEVELOPER_DIR at runtime, so it
    // has to inherit the same toolchain the binary was built against.
    const env = await this.toolchainEnv();
    const helper = this.makeHelperClient(binaryPath, env, await this.sandboxFor([binaryPath], env));
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
      // The helper links this toolchain's private frameworks, so it must build
      // against the same Xcode the rest of the session talks to.
      env: await this.toolchainEnv(),
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
    const binaryPath = path.join(outputDirectory, DEVICE_HELPER_BINARY_NAME);
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
    const binaryPath = path.join(this.helperCacheRoot, key, DEVICE_HELPER_BINARY_NAME);
    return await stat(binaryPath).then(
      () => binaryPath,
      () => null,
    );
  }

  /**
   * The Seatbelt-wrapped command for a helper run, or the plain one.
   *
   * Shared by the long-lived RPC helper and the one-shot `--probe`: preflighting
   * unconfined while the real run is confined would let a broken profile pass
   * the setup checklist and then hang on attach. Logs once when confinement is
   * skipped, since a silently unconfined helper is the thing worth noticing.
   */
  private async sandboxFor(
    argv: readonly string[],
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<HelperSandboxCommand> {
    const binaryPath = argv[0] ?? "";
    const launch = await sandboxedHelperCommand(argv, {
      binaryPath,
      helperSourceDir: this.helperSourceDir,
      developerDir: await this.xcodeSelectPath(),
      env: env ?? this.processEnv,
    });
    if (launch.profilePath === null && process.platform === "darwin" && !this.warnedUnsandboxed) {
      this.warnedUnsandboxed = true;
      console.warn(
        `[device] the iOS Simulator helper is running WITHOUT its Seatbelt sandbox. It can read` +
          ` your files and open network sockets. Unset ${SANDBOX_OPT_OUT_ENV} to restore` +
          ` confinement.`,
      );
    }
    return launch;
  }

  /**
   * Digest of the helper's sources, so a helper fix invalidates the cache.
   *
   * Read fresh rather than memoised: it runs once per attach, and a stale
   * digest would reintroduce exactly the bug it exists to prevent. If the
   * sources cannot be read the digest is omitted, which falls back to keying on
   * the toolchain alone rather than failing the attach outright.
   */
  /**
   * Digest of the helper's sources, so a helper fix invalidates the cache.
   *
   * Derived through the shared reader that `scripts/device-helper-smoke.ts`
   * also uses: a second derivation here is what made the smoke run build into a
   * directory this backend never read.
   */
  private async helperSourceRevision(): Promise<string | undefined> {
    return await readDeviceHelperSourceRevision(this.helperSourceDir, {
      listSources: readdir,
      readFile: (file) => readFile(file, "utf8"),
      join: path.join,
    });
  }

  private async xcodeBuildKey(): Promise<string> {
    const result = await this.run("xcodebuild", ["-version"], {
      timeoutMs: 20_000,
      allowNonZeroExit: true,
      env: await this.toolchainEnv(),
    }).catch(() => null);
    // Derived by the shared helper so the smoke CLI writes the directory the
    // server reads; deriving it here independently is what let them diverge.
    const key =
      result?.code === 0
        ? deviceHelperCacheKey(result.stdout, await this.helperSourceRevision())
        : null;
    if (key === null) {
      throw this.recordHelperFailure(
        "Could not determine the Xcode version. Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
      );
    }
    return key;
  }
}

function slugDeviceName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "device"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function processHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (processHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(exited);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
  });
}

/**
 * Does this failure mean the helper is holding a display descriptor from a
 * previous boot? The helper reports it as a missing framebuffer surface, since
 * from its side the descriptor is valid but has nothing behind it.
 */
/**
 * Did the helper accept an injection it could not deliver? Distinct from a
 * stale descriptor: the attachment is live enough to answer, but its HID client
 * is bound to a boot that is gone, so the fix is to rebind and retry once.
 */
export function isInputNotDeliveredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not delivered to the simulator/iu.test(message);
}

export function isStaleDescriptorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /framebuffer surface|display has no|not attached/iu.test(message);
}

/** USB HID keyboard usage codes for the modifiers the contract exposes. */
const HID_MODIFIER_USAGES: Partial<Record<DeviceKeyModifier, number>> = {
  control: 0xe0,
  shift: 0xe1,
  option: 0xe2,
  command: 0xe3,
};

/**
 * The helper omits absent accessibility attributes rather than sending nulls,
 * and its frames are in display coordinates. Fill in the contract's shape so
 * the pane and the agent see one predictable node type.
 */
export function normalizeUiNode(raw: unknown): DeviceUiNode {
  const node = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const frame =
    typeof node.frame === "object" && node.frame !== null
      ? (node.frame as Record<string, unknown>)
      : {};
  const readFrameValue = (key: string): number => {
    const value = frame[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const readText = (key: string): string | null => {
    const value = node[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  // Only a complete pair of finite coordinates is worth surfacing: half a point
  // would aim taps at (0, y) instead of the control.
  const readActivationPoint = (): DeviceUiPoint | null => {
    const raw = node.activationPoint;
    if (typeof raw !== "object" || raw === null) return null;
    const { x, y } = raw as Record<string, unknown>;
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    if (typeof y !== "number" || !Number.isFinite(y)) return null;
    return { x, y };
  };
  return {
    role: typeof node.role === "string" ? node.role : "Unknown",
    subrole: readText("subrole"),
    label: readText("label"),
    value: readText("value"),
    frame: {
      x: readFrameValue("x"),
      y: readFrameValue("y"),
      width: Math.max(0, readFrameValue("width")),
      height: Math.max(0, readFrameValue("height")),
    },
    activationPoint: readActivationPoint(),
    children: Array.isArray(node.children) ? node.children.map(normalizeUiNode) : [],
  };
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
