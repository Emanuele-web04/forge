/**
 * HelperClient - the only module that knows the native device-helper's wire
 * protocol.
 *
 * The helper is a Swift process compiled on demand against the user's Xcode
 * (private CoreSimulator/SimulatorKit frameworks, so it cannot ship prebuilt).
 * It speaks two channels:
 *
 * - Control: newline-delimited JSON-RPC 2.0 over stdin/stdout. Requests carry
 *   an integer id; responses carry `result` or `error`. It also emits a `ready`
 *   notification at startup.
 * - Frames: the server listens on a unix socket and passes its path to
 *   `stream.start`; the helper connects as a client and writes
 *   `u32 little-endian length` followed by that many bytes. Those bytes are
 *   already the `@synara/contracts` device-frame envelope, so this module only
 *   removes the length prefix and hands the envelope on untouched.
 *
 * Two protocol facts that shape callers:
 *
 * - The helper attaches to one simulator at a time (`attach`), and every input,
 *   read, and stream method acts on that attachment rather than taking a udid.
 * - Input coordinates are normalized to 0..1, not device points. Conversion
 *   uses the geometry `attach` returns.
 *
 * @module device/helperClient
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { decodeDeviceFrame } from "@synara/shared/deviceFrame";

import type { DeviceStreamFrame } from "./DeviceBackend.ts";
import { describeSandboxSuspicion, type HelperSandboxCommand } from "./helperSandbox.ts";

export const HELPER_METHODS = {
  ping: "ping",
  list: "list",
  attach: "attach",
  streamStart: "stream.start",
  streamStop: "stream.stop",
  streamStats: "stream.stats",
  tap: "tap",
  touch: "touch",
  swipe: "swipe",
  key: "key",
  text: "text",
  button: "button",
  screenshot: "screenshot",
  describeUi: "describe-ui",
} as const;

/** `u32 little-endian payload length`, then the contract frame envelope. */
const FRAME_LENGTH_PREFIX_BYTES = 4;
/** Refuse absurd length prefixes rather than allocating on a desynced stream. */
const FRAME_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONTROL_LINE_BYTES = 4 * 1024 * 1024;

export class DeviceHelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DeviceHelperError";
    this.code = code;
  }
}

/** Geometry from `attach`, used to convert device points into normalized input. */
export interface DeviceHelperAttachment {
  readonly udid: string;
  readonly pointWidth: number;
  readonly pointHeight: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly scale: number;
  readonly inputAvailable: boolean;
  readonly accessibilityAvailable: boolean;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface HelperClientOptions {
  readonly binaryPath: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly requestTimeoutMs?: number;
  readonly onExit?: (reason: string) => void;
  /**
   * The confined command to spawn instead of `binaryPath` directly.
   *
   * Resolved by the caller because building it reads the filesystem while
   * `start()` is synchronous. Absent means the helper runs unconfined, which is
   * also what happens off macOS or with the opt-out set.
   */
  readonly launch?: HelperSandboxCommand | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * One axis of a device-point coordinate as a 0..1 fraction of the screen.
 *
 * The error names both the offending value and the valid range, because the
 * overwhelmingly common cause is a caller passing frame pixels: seeing
 * "1019 is outside 0..402" makes the scale factor obvious immediately.
 */
function normalizeCoordinate(
  value: number,
  extent: number,
  axis: "x" | "y",
  attachment: DeviceHelperAttachment,
): number {
  if (!Number.isFinite(value) || value < 0 || value > extent) {
    throw new DeviceHelperError(
      "device_coordinate_out_of_bounds",
      `Device ${axis}=${value} is outside the screen bounds 0..${extent} device points ` +
        `(${attachment.pointWidth}x${attachment.pointHeight} points at ${attachment.scale}x; ` +
        `pass device points, not frame pixels).`,
    );
  }
  return extent === 0 ? 0 : value / extent;
}

function readNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Splits the helper's length-prefixed records out of an arbitrarily chunked
 * byte stream. The payload is passed through as-is: it is already the contract
 * envelope, and re-parsing it here would duplicate `decodeDeviceFrame`.
 */
export class DeviceFramePrefixParser {
  private buffer: Buffer = Buffer.alloc(0);

  /** Returns every complete payload now available, in order. */
  push(chunk: Uint8Array): readonly Uint8Array[] {
    this.buffer =
      this.buffer.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, Buffer.from(chunk)]);

    const payloads: Uint8Array[] = [];
    while (this.buffer.byteLength >= FRAME_LENGTH_PREFIX_BYTES) {
      const length = this.buffer.readUInt32LE(0);
      if (length > FRAME_MAX_PAYLOAD_BYTES) {
        throw new DeviceHelperError(
          "frame_stream_desync",
          `Helper frame record claims ${length} bytes`,
        );
      }
      const total = FRAME_LENGTH_PREFIX_BYTES + length;
      if (this.buffer.byteLength < total) break;
      // Copied: the payload outlives this parse and `this.buffer` is reassigned.
      payloads.push(
        Uint8Array.prototype.slice.call(
          this.buffer,
          FRAME_LENGTH_PREFIX_BYTES,
          total,
        ) as Uint8Array,
      );
      this.buffer = this.buffer.subarray(total);
    }
    return payloads;
  }
}

/** Frame the way the helper does. Used by the tests. */
export function encodeFrameRecord(payload: Uint8Array): Buffer {
  const record = Buffer.alloc(FRAME_LENGTH_PREFIX_BYTES + payload.byteLength);
  record.writeUInt32LE(payload.byteLength, 0);
  record.set(payload, FRAME_LENGTH_PREFIX_BYTES);
  return record;
}

/**
 * Owns one helper process: spawn, JSON-RPC over stdio, and the unix socket the
 * helper connects back to with frames.
 */
export class HelperClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private stderrTail = "";
  private exited = false;

  private attachment: DeviceHelperAttachment | null = null;
  private frameServer: Server | null = null;
  private frameSocket: Socket | null = null;
  private frameSocketDirectory: string | null = null;

  constructor(private readonly options: HelperClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get running(): boolean {
    return this.process !== null && !this.exited;
  }

  /** The simulator this helper is currently bound to, if any. */
  get attachedDevice(): DeviceHelperAttachment | null {
    return this.attachment;
  }

  start(): void {
    if (this.process) return;
    const launch = this.options.launch;
    const [command, args] = launch
      ? [launch.command, [...launch.args]]
      : [this.options.binaryPath, [...(this.options.args ?? [])]];
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env ?? process.env,
    });
    this.process = child;
    this.exited = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep only a tail: helper diagnostics belong in the failure message but
      // must never grow without bound over a long-lived session.
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_096);
    });
    child.on("error", (error) =>
      this.fail(new DeviceHelperError("helper_spawn_failed", error.message)),
    );
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.attachment = null;
      const reason = `device helper exited (code=${code ?? "null"}, signal=${signal ?? "null"})${
        this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""
      }`;
      this.fail(new DeviceHelperError("helper_exited", reason));
      this.options.onExit?.(reason);
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.process) this.start();
    const child = this.process;
    if (!child || this.exited) {
      throw new DeviceHelperError("helper_unavailable", "Device helper is not running");
    }

    const id = this.nextRequestId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A denied sandbox rule does not raise: CoreSimulator swallows it and
        // the helper simply never answers, which is indistinguishable from a
        // hang. Name the profile here so that is the first thing checked.
        reject(
          new DeviceHelperError(
            "helper_timeout",
            `Device helper ${method} timed out.${describeSandboxSuspicion(
              this.options.launch?.profilePath ?? null,
            )}`,
          ),
        );
      }, this.requestTimeoutMs);
      // `unref` so a stuck request cannot hold the process open at exit.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload, (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        reject(new DeviceHelperError("helper_write_failed", error.message));
      });
    });
  }

  /**
   * Bind the helper to one simulator. The helper holds a single attachment, so
   * attaching to a different device implicitly replaces the previous one.
   */
  async attach(
    udid: string,
    options: { readonly force?: boolean } = {},
  ): Promise<DeviceHelperAttachment> {
    if (!options.force && this.attachment?.udid === udid) return this.attachment;
    // Cleared before the request: a failed re-attach must not leave the caller
    // believing the previous, now-dead attachment is still good.
    this.attachment = null;
    const result = asRecord(await this.request(HELPER_METHODS.attach, { udid }));
    const capabilities = asRecord(result.capabilities);
    const pixelWidth = readNumber(result, "pixelWidth", 0);
    const pixelHeight = readNumber(result, "pixelHeight", 0);
    const scale = readNumber(result, "scale", 3);
    const attachment: DeviceHelperAttachment = {
      udid,
      pixelWidth,
      pixelHeight,
      scale,
      pointWidth: readNumber(result, "pointWidth", pixelWidth / scale),
      pointHeight: readNumber(result, "pointHeight", pixelHeight / scale),
      inputAvailable: capabilities.input === true,
      accessibilityAvailable: capabilities.accessibility === true,
    };
    if (attachment.pointWidth <= 0 || attachment.pointHeight <= 0) {
      throw new DeviceHelperError(
        "helper_malformed_response",
        "Device helper reported no usable screen geometry",
      );
    }
    this.attachment = attachment;
    return attachment;
  }

  /**
   * Forget the cached attachment for a device.
   *
   * The helper's attachment holds a display descriptor tied to one boot of the
   * simulator. Shutting the device down invalidates that descriptor, but the
   * helper process outlives the simulator, so without this the next `attach`
   * would short-circuit on the matching udid and every call would fail against
   * a dead framebuffer.
   */
  invalidateAttachment(udid: string): void {
    if (this.attachment?.udid === udid) this.attachment = null;
  }

  /**
   * Convert device points to the normalized 0..1 coordinates the helper's input
   * methods expect.
   *
   * Out-of-bounds coordinates are rejected, never clamped. Clamping looked
   * forgiving but was the worst possible behaviour: a caller sending frame
   * pixels instead of points (1206x2622 rather than 402x874) had every tap
   * pinned to the screen edge and acked as success, hiding a real
   * coordinate-space bug behind a green result. A caller wrong about the
   * coordinate space has to hear about it.
   */
  normalize(x: number, y: number): { readonly x: number; readonly y: number } {
    const attachment = this.attachment;
    if (!attachment) {
      throw new DeviceHelperError(
        "helper_not_attached",
        "Device helper is not attached to a device",
      );
    }
    return {
      x: normalizeCoordinate(x, attachment.pointWidth, "x", attachment),
      y: normalizeCoordinate(y, attachment.pointHeight, "y", attachment),
    };
  }

  /**
   * Start capture for the attached device. The server owns the socket: it
   * listens first and passes the path, so the helper never has to guess where
   * to connect and a stale socket file cannot be reused.
   */
  async startStream(udid: string, onFrame: (frame: DeviceStreamFrame) => void): Promise<void> {
    await this.stopStream();
    await this.attach(udid);

    const directory = await mkdtemp(path.join(tmpdir(), "synara-device-frames-"));
    const socketPath = path.join(directory, "frames.sock");
    this.frameSocketDirectory = directory;

    const server = createServer();
    this.frameServer = server;
    server.on("connection", (socket) => {
      this.frameSocket = socket;
      const parser = new DeviceFramePrefixParser();
      socket.on("data", (chunk: Buffer) => {
        let payloads: readonly Uint8Array[];
        try {
          payloads = parser.push(chunk);
        } catch {
          // A desynced stream cannot resynchronize: drop it rather than
          // emitting garbage NALs into the decoder.
          socket.destroy();
          return;
        }
        for (const record of payloads) {
          const decoded = decodeDeviceFrame(record);
          if (!decoded.ok) continue;
          const { header, payload } = decoded.frame;
          onFrame({
            sequence: header.sequence,
            timestampMs: header.timestampMs,
            keyframe: header.keyframe,
            codecConfig: header.codecConfig,
            // Envelope stripped: the transport re-encodes one with the routing
            // device id it already has, so forwarding the record whole would
            // leave a second header in front of the access unit and every frame
            // would fail to decode.
            data: payload,
          });
        }
      });
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        if (this.frameSocket === socket) this.frameSocket = null;
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      await this.request(HELPER_METHODS.streamStart, { socketPath });
    } catch (error) {
      await this.closeFrameSocket();
      throw error;
    }
  }

  async stopStream(): Promise<void> {
    if (this.running && this.frameServer !== null) {
      await this.request(HELPER_METHODS.streamStop).catch(() => undefined);
    }
    await this.closeFrameSocket();
  }

  async dispose(): Promise<void> {
    await this.stopStream().catch(() => undefined);
    this.fail(new DeviceHelperError("helper_disposed", "Device helper was shut down"));
    const child = this.process;
    this.process = null;
    this.attachment = null;
    this.exited = true;
    child?.stdin.end();
    child?.kill("SIGTERM");
  }

  // ── Internals ──────────────────────────────────────────────────────

  private async closeFrameSocket(): Promise<void> {
    this.frameSocket?.destroy();
    this.frameSocket = null;
    const server = this.frameServer;
    this.frameServer = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const directory = this.frameSocketDirectory;
    this.frameSocketDirectory = null;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_CONTROL_LINE_BYTES) {
      this.stdoutBuffer = "";
      this.fail(
        new DeviceHelperError("helper_protocol_error", "Device helper control line exceeded limit"),
      );
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.handleControlLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleControlLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Helper logs that are not JSON are ignored.
      return;
    }
    const record = asRecord(message);
    // Notifications (`ready`, diagnostics) carry no id and need no reply.
    if (typeof record.id !== "number") return;
    const request = this.pending.get(record.id);
    if (!request) return;
    this.pending.delete(record.id);
    clearTimeout(request.timer);
    if (record.error !== undefined && record.error !== null) {
      const error = asRecord(record.error);
      request.reject(
        new DeviceHelperError(
          typeof error.code === "number" ? `helper_${error.code}` : "helper_error",
          typeof error.message === "string" ? error.message : "Device helper reported an error",
        ),
      );
      return;
    }
    request.resolve(record.result ?? null);
  }

  /** Reject everything in flight; used on exit, spawn failure, and disposal. */
  private fail(error: DeviceHelperError): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
