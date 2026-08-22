// FILE: device-helper-smoke.ts
// Purpose: End-to-end smoke test for the native device helper against a real iOS Simulator.
// Layer: Release/CI smoke check (macOS + Xcode only; not part of normal CI).
// Depends on: apps/server/native/device-helper/build.sh and `xcrun simctl`.
//
// Compiles the helper with the user's toolchain, boots (or reuses) a simulator,
// attaches, streams frames, injects input, dumps the accessibility tree and
// takes a screenshot. Any simulator this script booted is shut down again; one
// that was already running is left alone.

import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { decodeDeviceFrame } from "@synara/shared/deviceFrame";
import {
  DEVICE_HELPER_CACHE_SEGMENTS,
  deviceHelperCacheKey,
  readDeviceHelperSourceRevision,
} from "@synara/shared/deviceHelperCache";
import { sandboxedHelperCommand } from "../apps/server/src/device/helperSandbox.ts";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperDir = join(repoRoot, "apps/server/native/device-helper");

/** Minimum frames the stream must deliver before the run is considered healthy. */
const REQUIRED_FRAMES = 30;
/** Preferred simulator device types, most modern first. */
const PREFERRED_DEVICE_TYPES = ["iPhone 17 Pro", "iPhone 16 Pro", "iPhone 15 Pro", "iPhone"];

let stepIndex = 0;

function step(message: string): void {
  stepIndex += 1;
  console.log(`[device-smoke] ${stepIndex}. ${message}`);
}

function info(message: string): void {
  console.log(`[device-smoke]    ${message}`);
}

function fail(message: string, detail?: unknown): never {
  console.error(`[device-smoke] FAIL: ${message}`);
  if (detail !== undefined) {
    console.error(detail instanceof Error ? (detail.stack ?? detail.message) : String(detail));
  }
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

// ── Environment ──────────────────────────────────────────────────────

interface SimctlDevice {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
  readonly isAvailable?: boolean;
  readonly runtime: string;
}

/**
 * The Xcode this run targets. `DEVELOPER_DIR` wins over the machine-wide
 * selection, matching how `xcrun` and the helper resolve it, so a sweep can
 * point successive runs at different toolchains without `sudo xcode-select`.
 */
function resolveDeveloperDirectory(): string {
  const override = process.env.DEVELOPER_DIR?.trim();
  if (override) return override;
  try {
    return execFileSync("xcode-select", ["-p"], { encoding: "utf8" }).trim();
  } catch (error) {
    fail("xcode-select is unavailable; install Xcode or set DEVELOPER_DIR", error);
  }
}

function listDevices(env: NodeJS.ProcessEnv): SimctlDevice[] {
  const raw = execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    encoding: "utf8",
    env,
  });
  const parsed = JSON.parse(raw) as { devices: Record<string, Omit<SimctlDevice, "runtime">[]> };
  const devices: SimctlDevice[] = [];
  for (const [runtime, entries] of Object.entries(parsed.devices)) {
    // iOS only: the pane targets iPhone/iPad simulators.
    if (!runtime.includes("iOS")) continue;
    for (const entry of entries) {
      devices.push({ ...entry, runtime });
    }
  }
  return devices;
}

/** Prefers an already-booted device so a developer's session is reused. */
function chooseDevice(devices: SimctlDevice[]): { device: SimctlDevice; wasBooted: boolean } {
  const booted = devices.find((device) => device.state === "Booted");
  if (booted) {
    return { device: booted, wasBooted: true };
  }
  for (const preference of PREFERRED_DEVICE_TYPES) {
    const match = devices.find((device) => device.name.startsWith(preference));
    if (match) return { device: match, wasBooted: false };
  }
  if (devices.length > 0) {
    return { device: devices[0]!, wasBooted: false };
  }
  fail("no available iOS simulators; install a runtime via Xcode > Settings > Components");
}

// ── Helper process ───────────────────────────────────────────────────

interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

/** A JSON-RPC client over the helper's stdio. */
class HelperClient {
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private nextId = 1;
  readonly stderr: string[] = [];

  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) this.stderr.push(line);
      }
    });
    child.on("exit", (code, signal) => {
      const error = new Error(`helper exited early (code ${code}, signal ${signal})`);
      for (const [, request] of this.pending) request.reject(error);
      this.pending.clear();
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = message["id"];
      if (typeof id !== "number") continue; // A notification.
      const request = this.pending.get(id);
      if (!request) continue;
      this.pending.delete(id);
      const error = message["error"] as { message?: string } | undefined;
      if (error) {
        request.reject(new Error(error.message ?? "unknown helper error"));
        return;
      }
      request.resolve((message["result"] ?? {}) as Record<string, unknown>);
    }
  }

  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 45_000,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`helper method '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
}

/** Collects length-prefixed frames from the helper's Unix socket. */
class FrameCollector {
  readonly frames: {
    keyframe: boolean;
    codecConfig: boolean;
    sequence: number;
    payload: Uint8Array;
  }[] = [];
  private buffer = Buffer.alloc(0);
  private server: Server | undefined;
  private socket: Socket | undefined;

  async listen(path: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const server = createServer((socket) => {
        this.socket = socket;
        socket.on("data", (chunk) => this.consume(chunk));
      });
      server.on("error", rejectPromise);
      server.listen(path, () => {
        this.server = server;
        resolvePromise();
      });
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      const message = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      const decoded = decodeDeviceFrame(new Uint8Array(message));
      if (!decoded.ok) {
        fail(`frame failed to decode: ${decoded.reason}`);
      }
      this.frames.push({
        keyframe: decoded.frame.header.keyframe,
        codecConfig: decoded.frame.header.codecConfig,
        sequence: decoded.frame.header.sequence,
        payload: decoded.frame.payload,
      });
    }
  }

  close(): void {
    this.socket?.destroy();
    this.server?.close();
  }
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** The NAL unit types present in an Annex B payload. */
function naluTypes(payload: Uint8Array): number[] {
  const types: number[] = [];
  for (let index = 0; index + 4 < payload.length; index += 1) {
    if (
      payload[index] === 0x00 &&
      payload[index + 1] === 0x00 &&
      payload[index + 2] === 0x00 &&
      payload[index + 3] === 0x01
    ) {
      types.push(payload[index + 4]! & 0x1f);
    }
  }
  return types;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    fail("the device helper is macOS only");
  }

  const probeOnly = process.argv.includes("--probe-only");

  step("Checking Xcode");
  // DEVELOPER_DIR is how the whole toolchain is redirected: xcode-select,
  // xcodebuild, xcrun and the helper itself all honour it, so pointing it at
  // another Xcode.app is enough to build and probe against that toolchain
  // without touching the machine-wide selection. This is what lets the sweep
  // and the CI matrix cover several Xcodes in one run.
  const developerDir = resolveDeveloperDirectory();
  if (!developerDir.endsWith("/Contents/Developer")) {
    fail(
      `the active developer directory is '${developerDir}', which is not a full Xcode; ` +
        "run 'sudo xcode-select -s /Applications/Xcode.app' or set DEVELOPER_DIR",
    );
  }
  // Every toolchain invocation from here inherits the same override, so the
  // build, the probe and the simulator all agree on which Xcode is in play.
  const toolchainEnv = { ...process.env, DEVELOPER_DIR: developerDir };
  const xcodeVersion = execFileSync("xcodebuild", ["-version"], {
    encoding: "utf8",
    env: toolchainEnv,
  }).trim();
  // Same key the server derives: toolchain plus a digest of the helper sources.
  // Deriving it from the toolchain alone here would build into a directory the
  // server never reads, so a passing smoke run would prove nothing about it.
  const sourceRevision = await readDeviceHelperSourceRevision(helperDir, {
    listSources: (dir) => readdir(dir),
    readFile: (file) => readFile(file, "utf8"),
    join,
  });
  const cacheKey = deviceHelperCacheKey(xcodeVersion, sourceRevision);
  assert(cacheKey !== null, "cannot determine Xcode build version");
  info(`${xcodeVersion.replace("\n", " / ")} (${developerDir})`);

  step("Compiling the helper");
  // Cached by Xcode version: private API surface moves with the toolchain, so a
  // binary built against one Xcode must not be reused after an upgrade. The key
  // comes from @synara/shared so this build lands in the same directory the
  // server reads; deriving it here separately meant a passing smoke run
  // populated a directory the server never looked in. Because the key is
  // derived from the *overridden* toolchain, sweeping Xcodes fills one cache
  // directory per toolchain instead of overwriting a single one.
  const cacheDir = join(homedir(), ...DEVICE_HELPER_CACHE_SEGMENTS, cacheKey);
  mkdirSync(cacheDir, { recursive: true });
  const buildStarted = Date.now();
  let helperPath: string;
  try {
    const { stdout } = await execFileAsync(join(helperDir, "build.sh"), [cacheDir], {
      maxBuffer: 8 * 1024 * 1024,
      env: toolchainEnv,
    });
    helperPath = stdout.trim().split("\n").at(-1)!;
  } catch (error) {
    fail("helper failed to compile", error);
  }
  assert(statSync(helperPath).isFile(), `compiled helper missing at ${helperPath}`);
  info(`${helperPath} (${Date.now() - buildStarted}ms)`);

  step("Preflighting the helper");
  // A probe that finds a missing symbol exits non-zero, and its JSON body names
  // which capability broke — exactly the signal this check exists to surface.
  // Reading stdout off the thrown error keeps that detail instead of letting it
  // die inside a child_process stack trace.
  let probeRaw: string;
  try {
    probeRaw = execFileSync(helperPath, ["--probe"], {
      encoding: "utf8",
      env: toolchainEnv,
    }).trim();
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout?.trim();
    if (!stdout) fail("helper preflight produced no output", error);
    probeRaw = stdout;
  }
  // Written before the assertion so a failing probe is still uploaded as the
  // CI artifact; that JSON is the whole diagnostic for a broken toolchain.
  const probeJsonPath = process.env.DEVICE_HELPER_PROBE_JSON;
  if (probeJsonPath) {
    writeFileSync(probeJsonPath, `${probeRaw}\n`);
    info(`probe JSON written to ${probeJsonPath}`);
  }
  const probe = JSON.parse(probeRaw) as {
    ok: boolean;
    deviceCount?: number;
    error?: string;
    capabilities?: Record<string, unknown>;
    toolchain?: { xcodeVersion?: string; xcodeBuild?: string; macOS?: string };
  };

  // Every capability is printed, passing or not: a green run is the record of
  // which symbols still resolve on this toolchain, which is what makes the next
  // Xcode's regression obvious by comparison.
  const capabilities = Object.entries(probe.capabilities ?? {});
  if (capabilities.length === 0) {
    info("helper reported no per-capability detail (older helper)");
  }
  for (const [name, status] of capabilities) {
    info(
      status === "ok" ? `capability ${name}: ok` : `capability ${name}: ${JSON.stringify(status)}`,
    );
  }
  if (probe.toolchain) {
    const { xcodeVersion, xcodeBuild, macOS } = probe.toolchain;
    info(`toolchain: Xcode ${xcodeVersion ?? "?"} (${xcodeBuild ?? "?"}), macOS ${macOS ?? "?"}`);
  }

  // The smoke run is strict where the app is forgiving: the app degrades around
  // a broken capability, but a release check that tolerated one would let the
  // regression ship.
  const broken = capabilities.filter(([, status]) => status !== "ok").map(([name]) => name);
  if (broken.length > 0) {
    fail(`helper capabilities unavailable: ${broken.join(", ")}`);
  }
  if (!probe.ok) {
    fail(`helper preflight failed: ${probe.error ?? "see capabilities above"}`);
  }
  info(`CoreSimulator reachable, ${probe.deviceCount} devices`);

  // Compile + probe is the symbol tripwire: it catches a private API that moved
  // under a new Xcode, which is the failure this whole matrix exists to find,
  // and it needs no simulator runtime. CI runs this first and on every runner;
  // the booted-simulator run below is the expensive part.
  if (probeOnly) {
    console.log("\n[device-smoke] PASS (probe only; no simulator was booted)");
    return;
  }

  step("Selecting a simulator");
  const { device, wasBooted } = chooseDevice(listDevices(toolchainEnv));
  info(`${device.name} (${device.udid}) ${wasBooted ? "already booted" : "shutdown"}`);

  let bootedByUs = false;
  const cleanupPaths: string[] = [];
  let client: HelperClient | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  const collector = new FrameCollector();

  try {
    if (!wasBooted) {
      step("Booting the simulator");
      execFileSync("xcrun", ["simctl", "boot", device.udid], {
        stdio: "inherit",
        env: toolchainEnv,
      });
      bootedByUs = true;
      execFileSync("xcrun", ["simctl", "bootstatus", device.udid, "-b"], {
        stdio: "inherit",
        env: toolchainEnv,
      });
      // SpringBoard needs a moment past bootstatus before accessibility answers.
      await sleep(3000);
    }

    step("Starting the helper");
    // Through the same wrapper the server uses: a smoke run that spawned the
    // helper directly would exercise none of the confinement it is meant to
    // validate, and the sandbox is exactly the thing that fails as a hang.
    const launch = await sandboxedHelperCommand([helperPath], {
      binaryPath: helperPath,
      helperSourceDir: helperDir,
      developerDir: toolchainEnv.DEVELOPER_DIR ?? null,
      env: toolchainEnv,
    });
    console.log(
      launch.profilePath === null
        ? "  sandbox: OFF (unconfined)"
        : `  sandbox: ON (${launch.profilePath})`,
    );
    child = spawn(launch.command, [...launch.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: toolchainEnv,
    });
    client = new HelperClient(child);

    step("Attaching");
    const attached = await client.call("attach", { udid: device.udid });
    const capabilities = attached["capabilities"] as { input: boolean; accessibility: boolean };
    info(
      `${attached["name"]} ${attached["pixelWidth"]}x${attached["pixelHeight"]} @${attached["scale"]}x, ` +
        `input=${capabilities.input} accessibility=${capabilities.accessibility}`,
    );
    assert(typeof attached["udid"] === "string", "attach returned no udid");
    assert(Number(attached["pixelWidth"]) > 0, "attach returned a zero-width display");

    step(`Streaming at least ${REQUIRED_FRAMES} frames`);
    const socketDir = mkdtempSync(join(tmpdir(), "synara-device-smoke-"));
    cleanupPaths.push(socketDir);
    const socketPath = join(socketDir, "frames.sock");
    await collector.listen(socketPath);
    const stream = await client.call("stream.start", { socketPath });
    info(`codec=${stream["codec"]} ${stream["pixelWidth"]}x${stream["pixelHeight"]}`);

    // The display only posts damage callbacks when something changes, so the
    // stream is driven with swipes rather than waiting on an idle home screen.
    const deadline = Date.now() + 60_000;
    while (collector.frames.length < REQUIRED_FRAMES && Date.now() < deadline) {
      await client.call("swipe", {
        startX: 0.8,
        startY: 0.5,
        endX: 0.2,
        endY: 0.5,
        durationMs: 350,
      });
      await sleep(400);
      await client.call("swipe", {
        startX: 0.2,
        startY: 0.5,
        endX: 0.8,
        endY: 0.5,
        durationMs: 350,
      });
      await sleep(400);
    }

    const stats = await client.call("stream.stats");
    const keyframes = collector.frames.filter((frame) => frame.keyframe);
    const codecConfigs = collector.frames.filter((frame) => frame.codecConfig);
    info(
      `${collector.frames.length} frames, ${keyframes.length} keyframes, ` +
        `${codecConfigs.length} codec-config, dropped(busy)=${stats["droppedBusyFrames"]} ` +
        `dropped(socket)=${stats["droppedSocketFrames"]}`,
    );

    assert(
      collector.frames.length >= REQUIRED_FRAMES,
      `expected >= ${REQUIRED_FRAMES} frames, got ${collector.frames.length}`,
    );
    assert(keyframes.length >= 1, "stream contained no keyframe");
    assert(codecConfigs.length >= 1, "stream contained no codec-config (SPS/PPS) message");

    // Structural check: every payload must be Annex B, and a codec-config
    // message must actually carry an SPS (NAL type 7).
    for (const frame of collector.frames) {
      const [b0, b1, b2, b3] = frame.payload;
      assert(
        b0 === 0x00 && b1 === 0x00 && b2 === 0x00 && b3 === 0x01,
        `frame ${frame.sequence} does not start with an Annex B start code`,
      );
    }
    const sps = codecConfigs.find((frame) => naluTypes(frame.payload).includes(7));
    assert(Boolean(sps), "no codec-config message carried an SPS NAL unit");
    // A keyframe usually leads with SEI, so every NAL unit is scanned rather
    // than only the first.
    const idr = keyframes.find((frame) => naluTypes(frame.payload).includes(5));
    assert(Boolean(idr), "no keyframe carried an IDR NAL unit");
    info("NAL structure verified (Annex B start codes, SPS present, IDR present)");

    step("Injecting a tap");
    await client.call("tap", { x: 0.5, y: 0.92 });
    await sleep(500);
    info("tap accepted");

    step("Pressing the home button");
    await client.call("button", { name: "home" });
    await sleep(1200);

    step("Dumping the accessibility tree");
    const described = await client.call("describe-ui", { maxDepth: 6 });
    const tree = described["tree"] as { role?: string; children?: unknown[] } | undefined;
    assert(Boolean(tree), "describe-ui returned no tree");
    const children = tree!.children ?? [];
    info(`root role=${tree!.role} children=${children.length}`);
    assert(children.length > 0, "accessibility tree has no children");

    step("Taking a screenshot");
    const screenshotPath = join(socketDir, "screen.png");
    const screenshot = await client.call("screenshot", { path: screenshotPath });
    const png = readFileSync(screenshotPath);
    // PNG magic: \x89PNG\r\n\x1a\n
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let index = 0; index < magic.length; index += 1) {
      assert(png[index] === magic[index], "screenshot is not a PNG");
    }
    info(`${screenshot["bytes"]} bytes, PNG magic verified`);

    step("Stopping the stream");
    const stopped = await client.call("stream.stop");
    assert(stopped["running"] === false, "stream did not report stopped");

    console.log("\n[device-smoke] PASS");
  } catch (error) {
    if (client && client.stderr.length > 0) {
      console.error("[device-smoke] helper stderr:");
      for (const line of client.stderr.slice(-20)) console.error(`  ${line}`);
    }
    fail("smoke run failed", error);
  } finally {
    collector.close();
    child?.stdin.end();
    child?.kill();
    for (const path of cleanupPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    // Only shut down what this script started; a developer's own simulator stays up.
    if (bootedByUs) {
      console.log("[device-smoke] shutting down the simulator this run booted");
      try {
        execFileSync("xcrun", ["simctl", "shutdown", device.udid], {
          stdio: "inherit",
          env: toolchainEnv,
        });
      } catch (error) {
        console.error("[device-smoke] warning: shutdown failed", error);
      }
    }
  }
}

void main();
