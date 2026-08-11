import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import {
  formatRuntimeIdentifier,
  IosSimulatorBackend,
  normalizeUiNode,
  parseSimctlDevices,
  readPngDimensions,
  resolveDeviceHelperSourceDir,
  selectRecordingDirectory,
} from "./IosSimulatorBackend.ts";

const RECORDING_DEVICE = "AAAA-1111";
const fixedRecordingTime = () => Date.parse("2026-08-04T12:34:56.789Z");

const recordingDeviceList = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      {
        udid: RECORDING_DEVICE,
        name: "iPhone 17 Pro",
        state: "Booted",
        isAvailable: true,
      },
    ],
  },
});

const successfulProcessResult = (stdout = ""): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

describe("device helper source resolution", () => {
  it("prefers a physical helper directory supplied by packaged desktop", () => {
    const external = "/Applications/Synara.app/Contents/Resources/device-helper";

    expect(
      resolveDeviceHelperSourceDir(
        "/Applications/Synara.app/Contents/Resources/app.asar/apps/server/dist",
        (candidate) => candidate === external,
        external,
      ),
    ).toBe(external);
  });

  it("uses the helper copied beside a bundled server entry", () => {
    const distDir = "/app/apps/server/dist";
    const bundled = path.join(distDir, "device-helper");

    expect(resolveDeviceHelperSourceDir(distDir, (candidate) => candidate === bundled)).toBe(
      bundled,
    );
  });

  it("falls back to the source-tree helper during development", () => {
    const sourceModuleDir = "/repo/apps/server/src/device";

    expect(resolveDeviceHelperSourceDir(sourceModuleDir, () => false)).toBe(
      "/repo/apps/server/native/device-helper",
    );
  });
});

class FakeRecordingProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    queueMicrotask(() => this.finish(0, signal));
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stderr.end();
    this.stdout.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

async function makeRecordingBackend(options: {
  readonly autoStart?: boolean;
  readonly now?: () => number;
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "synara-recording-test-"));
  const children: FakeRecordingProcess[] = [];
  const spawnCalls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  const backend = new IosSimulatorBackend({
    platform: "darwin",
    recordingDirectory: directory,
    ...(options.now ? { now: options.now } : {}),
    run: async (command, args) =>
      command === "xcrun" && args[1] === "list"
        ? successfulProcessResult(recordingDeviceList)
        : successfulProcessResult(),
    spawnProcess: (command, args) => {
      const child = new FakeRecordingProcess();
      children.push(child);
      spawnCalls.push({ command, args });
      if (options.autoStart !== false) {
        const outputPath = args.at(-1)!;
        void writeFile(outputPath, "fake h264 video").then(() => {
          child.stderr.write("Recording started\n");
        });
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  return { backend, children, directory, spawnCalls };
}

const SIMCTL_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      {
        udid: "AAAA-1111",
        name: "iPhone 17 Pro",
        state: "Booted",
        isAvailable: true,
      },
      {
        udid: "BBBB-2222",
        name: "iPhone 17",
        state: "Shutdown",
        isAvailable: true,
      },
      {
        udid: "CCCC-3333",
        name: "iPhone 12",
        state: "Shutdown",
        // Runtime was deleted; booting this would only fail.
        isAvailable: false,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-11-2": [
      { udid: "DDDD-4444", name: "Apple Watch", state: "Shutting Down", isAvailable: true },
    ],
  },
});

describe("simctl device parsing", () => {
  it("maps simctl states onto the contract's runtime states", () => {
    const devices = parseSimctlDevices(SIMCTL_JSON);

    expect(devices.map((device) => [device.udid, device.state])).toEqual([
      ["AAAA-1111", "booted"],
      ["BBBB-2222", "shutdown"],
      ["DDDD-4444", "shutting-down"],
    ]);
  });

  it("drops devices whose runtime is unavailable", () => {
    expect(parseSimctlDevices(SIMCTL_JSON).map((device) => device.udid)).not.toContain("CCCC-3333");
  });

  it("reports every discovered device as user-booted", () => {
    // Discovery cannot attribute a boot; DeviceManager overrides the field for
    // devices it booted itself.
    expect(parseSimctlDevices(SIMCTL_JSON).every((device) => device.bootSource === "user")).toBe(
      true,
    );
  });

  it("carries chassis and geometry from the device type catalogue", () => {
    const devices = parseSimctlDevices(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
            {
              udid: "AAAA-1111",
              name: "iPad (A16)",
              state: "Shutdown",
              isAvailable: true,
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
            },
          ],
        },
      }),
      new Map([
        [
          "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
          { family: "tablet" as const, geometry: { pointWidth: 820, pointHeight: 1180, scale: 2 } },
        ],
      ]),
    );

    // Known with the device shut down, which is what lets the pane draw an iPad
    // the moment it is picked rather than an iPhone that resizes on first frame.
    expect(devices[0]).toMatchObject({
      family: "tablet",
      geometry: { pointWidth: 820, pointHeight: 1180, scale: 2 },
    });
  });

  it("omits geometry for a device type the catalogue does not cover", () => {
    const [device] = parseSimctlDevices(SIMCTL_JSON);

    expect(device?.family).toBeUndefined();
    expect(device?.geometry).toBeUndefined();
  });

  it("renders a readable runtime label", () => {
    expect(formatRuntimeIdentifier("com.apple.CoreSimulator.SimRuntime.iOS-26-0")).toBe("iOS 26.0");
    expect(formatRuntimeIdentifier("com.apple.CoreSimulator.SimRuntime.watchOS-11-2")).toBe(
      "watchOS 11.2",
    );
  });

  it("returns nothing rather than throwing on an empty or shapeless payload", () => {
    expect(parseSimctlDevices(JSON.stringify({}))).toEqual([]);
    expect(parseSimctlDevices(JSON.stringify({ devices: null }))).toEqual([]);
  });

  it("throws on output that is not JSON at all", () => {
    expect(() => parseSimctlDevices("xcrun: error: unable to find utility")).toThrow();
  });
});

describe("accessibility tree normalization", () => {
  it("fills in the attributes the helper omits rather than sending as null", () => {
    // The helper leaves absent accessibility attributes out of the object
    // entirely; the contract wants explicit nulls and a complete frame.
    expect(normalizeUiNode({ role: "Button" })).toEqual({
      role: "Button",
      subrole: null,
      label: null,
      value: null,
      frame: { x: 0, y: 0, width: 0, height: 0 },
      activationPoint: null,
      children: [],
    });
  });

  it("keeps a switch's own activation point, which is not its row centre", () => {
    // The exact shape of a UIKit settings row: one merged element whose frame
    // spans the row, so tapping the frame centre (x=201) does nothing and only
    // the activation point (x=336.5) flips the switch.
    const node = normalizeUiNode({
      role: "CheckBox",
      subrole: "Switch",
      label: "Dark Appearance",
      value: "0",
      frame: { x: 36, y: 184, width: 330, height: 28 },
      activationPoint: { x: 336.5, y: 198 },
    });

    expect(node).toMatchObject({
      role: "CheckBox",
      subrole: "Switch",
      value: "0",
      activationPoint: { x: 336.5, y: 198 },
    });
  });

  it("drops an activation point that is not a complete pair of coordinates", () => {
    // Half a point would aim taps at (0, y): worse than having none at all.
    expect(normalizeUiNode({ activationPoint: { x: 12 } }).activationPoint).toBeNull();
    expect(
      normalizeUiNode({ activationPoint: { x: Number.NaN, y: 4 } }).activationPoint,
    ).toBeNull();
    expect(normalizeUiNode({ activationPoint: "336,198" }).activationPoint).toBeNull();
  });

  it("keeps the attributes the helper does send", () => {
    const node = normalizeUiNode({
      role: "TextField",
      label: "Email",
      value: "a@b.c",
      frame: { x: 12, y: 34, width: 200, height: 44 },
    });

    expect(node).toMatchObject({
      role: "TextField",
      label: "Email",
      value: "a@b.c",
      frame: { x: 12, y: 34, width: 200, height: 44 },
    });
  });

  it("normalizes the whole subtree", () => {
    const node = normalizeUiNode({
      role: "Window",
      children: [{ role: "Button", children: [{ label: "Deep" }] }],
    });

    expect(node.children[0]?.children[0]).toMatchObject({ role: "Unknown", label: "Deep" });
  });

  it("clamps negative sizes and survives a shapeless node", () => {
    expect(normalizeUiNode({ frame: { width: -5, height: 10 } }).frame).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 10,
    });
    expect(normalizeUiNode(null).role).toBe("Unknown");
  });
});

describe("png dimension reading", () => {
  it("reads width and height from the IHDR chunk", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    expect(readPngDimensions(png)).toEqual({ width: 1, height: 1 });
  });

  it("returns null for bytes that are not a PNG", () => {
    expect(readPngDimensions(Buffer.alloc(64))).toBeNull();
    expect(readPngDimensions(Buffer.from("nope"))).toBeNull();
  });
});

describe("saving a screenshot", () => {
  const SCREENSHOT_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  /** A backend whose `simctl io screenshot` writes a real PNG to the given path. */
  async function makeScreenshotBackend() {
    const directory = await mkdtemp(path.join(tmpdir(), "synara-screenshot-test-"));
    const backend = new IosSimulatorBackend({
      platform: "darwin",
      recordingDirectory: directory,
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      run: async (command, args) => {
        if (command === "xcrun" && args[1] === "list") {
          return successfulProcessResult(recordingDeviceList);
        }
        if (command === "xcrun" && args.includes("screenshot")) {
          // `simctl io <udid> screenshot <path>`: the path is the last argument.
          await writeFile(args.at(-1)!, SCREENSHOT_PNG);
        }
        return successfulProcessResult();
      },
    });
    return { backend, directory };
  }

  it("writes the PNG beside the recordings and reports its path", async () => {
    const { backend, directory } = await makeScreenshotBackend();

    const shot = await backend.screenshot(RECORDING_DEVICE, { save: true });

    // The pane's save button used to route through a browser download, which
    // put the file wherever the browser chose — or nowhere at all. It has to
    // land in the same directory the record button writes to.
    expect(shot.path).toBe(
      path.join(directory, "simulator-iphone-17-pro-2026-08-04T12-00-00-000Z.png"),
    );
    expect(await readFile(shot.path!)).toEqual(SCREENSHOT_PNG);
  });

  it("still returns the bytes so an agent can read the screen", async () => {
    const { backend } = await makeScreenshotBackend();

    const shot = await backend.screenshot(RECORDING_DEVICE, { save: true });

    expect(Buffer.from(shot.bytesBase64, "base64")).toEqual(SCREENSHOT_PNG);
    expect(shot.mimeType).toBe("image/png");
  });

  it("writes nothing when the caller only wants the bytes", async () => {
    const { backend, directory } = await makeScreenshotBackend();

    const shot = await backend.screenshot(RECORDING_DEVICE);

    // The composer attachment and the agent's own tool take this path; neither
    // should litter the user's Desktop.
    expect(shot.path).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("simulator screen recording", () => {
  it("starts an h264 simctl recording and waits for its first frame", async () => {
    let nowMs = Date.parse("2026-08-04T12:00:00.000Z");
    const { backend, children, directory, spawnCalls } = await makeRecordingBackend({
      autoStart: false,
      now: () => nowMs,
    });
    const starting = backend.startRecording(RECORDING_DEVICE);
    let settled = false;
    void starting.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(settled).toBe(false);
    const outputPath = spawnCalls[0]!.args.at(-1)!;
    await writeFile(outputPath, "fake h264 video");
    nowMs += 2_000;
    children[0]!.stderr.write("Recording started\n");
    const result = await starting;

    expect(spawnCalls[0]).toEqual({
      command: "xcrun",
      args: ["simctl", "io", RECORDING_DEVICE, "recordVideo", "--codec=h264", result.path],
    });
    expect(path.dirname(result.path)).toBe(directory);
    expect(path.basename(result.path)).toMatch(/^simulator-iphone-17-pro-.+\.mp4$/u);
    expect(result.startedAt).toBe("2026-08-04T12:00:02.000Z");

    await backend.stopRecording(RECORDING_DEVICE);
    await rm(directory, { recursive: true, force: true });
  });

  it("uses SIGINT and waits for simctl to finalise before reporting the file", async () => {
    const { backend, children, directory } = await makeRecordingBackend({});
    const started = await backend.startRecording(RECORDING_DEVICE);

    const stopped = await backend.stopRecording(RECORDING_DEVICE);

    expect(children[0]!.killSignals).toEqual(["SIGINT"]);
    expect(stopped).toMatchObject({
      udid: RECORDING_DEVICE,
      path: started.path,
      sizeBytes: Buffer.byteLength("fake h264 video"),
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("shares finalisation when two stops arrive while recording is still starting", async () => {
    const { backend, children, directory, spawnCalls } = await makeRecordingBackend({
      autoStart: false,
    });
    const starting = backend.startRecording(RECORDING_DEVICE);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const firstStop = backend.stopRecording(RECORDING_DEVICE);
    const secondStop = backend.stopRecording(RECORDING_DEVICE);
    const outputPath = spawnCalls[0]!.args.at(-1)!;
    await writeFile(outputPath, "fake h264 video");

    children[0]!.stderr.write("Recording started\n");
    await starting;
    const [first, second] = await Promise.all([firstStop, secondStop]);

    expect(children[0]!.killSignals).toEqual(["SIGINT"]);
    expect(second).toEqual(first);
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps an existing timestamped file and chooses a unique path", async () => {
    const { backend, directory } = await makeRecordingBackend({ now: fixedRecordingTime });
    const occupied = path.join(directory, "simulator-iphone-17-pro-2026-08-04T12-34-56-789Z.mp4");
    await writeFile(occupied, "keep me");

    const started = await backend.startRecording(RECORDING_DEVICE);
    await backend.stopRecording(RECORDING_DEVICE);

    expect(started.path).not.toBe(occupied);
    expect(await readFile(occupied, "utf8")).toBe("keep me");
    await rm(directory, { recursive: true, force: true });
  });

  it("falls back when an earlier recording directory exists but is not writable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-recording-directory-test-"));
    const desktop = path.join(root, "Desktop");
    const downloads = path.join(root, "Downloads");
    await mkdir(desktop);
    await mkdir(downloads);
    await chmod(desktop, 0o500);

    const selected = await selectRecordingDirectory([desktop, downloads], tmpdir());

    expect(selected).toBe(downloads);
    await chmod(desktop, 0o700);
    await rm(root, { recursive: true, force: true });
  });

  it("surfaces stderr when simctl exits before recording begins", async () => {
    const { backend, children, directory } = await makeRecordingBackend({ autoStart: false });
    const starting = backend.startRecording(RECORDING_DEVICE);
    await vi.waitFor(() => expect(children).toHaveLength(1));

    children[0]!.stderr.write("Invalid device state");
    children[0]!.finish(1, null);

    await expect(starting).rejects.toThrow(/Invalid device state/u);
    await rm(directory, { recursive: true, force: true });
  });

  it("interrupts an in-flight recording when the backend disposes", async () => {
    const { backend, children, directory } = await makeRecordingBackend({});
    await backend.startRecording(RECORDING_DEVICE);

    await backend.dispose();

    expect(children[0]!.killSignals).toEqual(["SIGINT"]);
    await rm(directory, { recursive: true, force: true });
  });
});
