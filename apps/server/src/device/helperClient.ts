/**
 * HelperClient - the only module that knows the native device-helper's wire
 * protocol.
 *
 * The helper is a Swift process compiled on demand against the user's Xcode
 * (private CoreSimulator/SimulatorKit frameworks, so it cannot ship prebuilt).
 * It speaks two channels:
 *
 * - Control: newline-delimited JSON-RPC 2.0 over stdin/stdout. Requests carry
 *   an integer id; responses carry `result` or `error`.
 * - Frames: length-prefixed encoded video over a unix socket the helper creates
 *   and whose path it reports in the `attachStream` result. Each record is
 *   `u32 payloadLength | u8 flags | f64 timestampMs | payload`, little-endian,
 *   with flag bit 0 = keyframe and bit 1 = codec config.
 *
 * ADAPTATION POINT: the helper is being built in parallel. If its final wire
 * format differs, every change belongs in this file — `FRAME_RECORD_*` and the
 * `HELPER_METHODS` map are the two places to touch, and nothing above this
 * layer parses helper bytes.
 *
 * @module device/helperClient
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";

import type { DeviceFrameListener, DeviceStreamFrame } from "./DeviceBackend.ts";

export const HELPER_METHODS = {
  ping: "ping",
  tap: "input.tap",
  swipe: "input.swipe",
  typeText: "input.typeText",
  keyEvent: "input.keyEvent",
  pressButton: "input.pressButton",
  describeUi: "accessibility.describe",
  attachStream: "stream.attach",
  detachStream: "stream.detach",
} as const;

/** `u32 payloadLength | u8 flags | f64 timestampMs`, then the payload. */
const FRAME_RECORD_HEADER_BYTES = 13;
const FRAME_RECORD_FLAG_KEYFRAME = 0b0000_0001;
const FRAME_RECORD_FLAG_CODEC_CONFIG = 0b0000_0010;
/** Refuse absurd length prefixes rather than allocating on a desynced stream. */
const FRAME_RECORD_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

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

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface HelperClientOptions {
  readonly binaryPath: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  /** Injected in tests so the frame socket can be faked without a filesystem. */
  readonly connectFrameSocket?: (socketPath: string) => Socket;
  readonly onExit?: (reason: string) => void;
}

/**
 * Decodes the helper's length-prefixed frame records out of an arbitrarily
 * chunked byte stream. Split out from the socket so framing is unit-testable.
 */
export class DeviceFrameRecordParser {
  private buffer: Buffer = Buffer.alloc(0);
  private sequence = 0;

  /** Returns every complete record now available, in order. */
  push(chunk: Uint8Array): readonly DeviceStreamFrame[] {
    this.buffer =
      this.buffer.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, Buffer.from(chunk)]);

    const frames: DeviceStreamFrame[] = [];
    while (this.buffer.byteLength >= FRAME_RECORD_HEADER_BYTES) {
      const payloadLength = this.buffer.readUInt32LE(0);
      if (payloadLength > FRAME_RECORD_MAX_PAYLOAD_BYTES) {
        throw new DeviceHelperError(
          "frame_stream_desync",
          `Helper frame record claims ${payloadLength} bytes`,
        );
      }
      const total = FRAME_RECORD_HEADER_BYTES + payloadLength;
      if (this.buffer.byteLength < total) break;

      const flags = this.buffer.readUInt8(4);
      const timestampMs = this.buffer.readDoubleLE(5);
      // Copy: the payload outlives this parse and `this.buffer` gets reassigned.
      const data = Uint8Array.prototype.slice.call(
        this.buffer,
        FRAME_RECORD_HEADER_BYTES,
        total,
      ) as Uint8Array;
      this.buffer = this.buffer.subarray(total);
      this.sequence += 1;
      frames.push({
        sequence: this.sequence,
        timestampMs,
        keyframe: (flags & FRAME_RECORD_FLAG_KEYFRAME) !== 0,
        codecConfig: (flags & FRAME_RECORD_FLAG_CODEC_CONFIG) !== 0,
        data,
      });
    }
    return frames;
  }
}

/** Encode one frame record the way the helper does. Used by the helper tests. */
export function encodeFrameRecord(frame: {
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
  readonly data: Uint8Array;
}): Buffer {
  const record = Buffer.alloc(FRAME_RECORD_HEADER_BYTES + frame.data.byteLength);
  record.writeUInt32LE(frame.data.byteLength, 0);
  let flags = 0;
  if (frame.keyframe) flags |= FRAME_RECORD_FLAG_KEYFRAME;
  if (frame.codecConfig) flags |= FRAME_RECORD_FLAG_CODEC_CONFIG;
  record.writeUInt8(flags, 4);
  record.writeDoubleLE(frame.timestampMs, 5);
  record.set(frame.data, FRAME_RECORD_HEADER_BYTES);
  return record;
}

/**
 * Owns one helper process: spawn, JSON-RPC over stdio, and the frame socket per
 * streaming device.
 */
export class HelperClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly frameSockets = new Map<string, Socket>();
  private readonly requestTimeoutMs: number;
  private stderrTail = "";
  private exited = false;

  constructor(private readonly options: HelperClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get running(): boolean {
    return this.process !== null && !this.exited;
  }

  start(): void {
    if (this.process) return;
    const child = spawn(this.options.binaryPath, [...(this.options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env ?? process.env,
    });
    this.process = child;
    this.exited = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep only a tail: helper diagnostics are useful in the failure message
      // but must never grow without bound over a long-lived session.
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_096);
    });
    child.on("error", (error) =>
      this.fail(new DeviceHelperError("helper_spawn_failed", error.message)),
    );
    child.on("exit", (code, signal) => {
      this.exited = true;
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
        reject(new DeviceHelperError("helper_timeout", `Device helper ${method} timed out`));
      }, this.requestTimeoutMs);
      // `unref` so a stuck helper request cannot hold the process open at exit.
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
   * Ask the helper to start capturing and pipe its frame socket to `onFrame`.
   * The helper answers with `{ socketPath }`.
   */
  async attachStream(udid: string, onFrame: DeviceFrameListener): Promise<void> {
    await this.detachStream(udid);
    const result = await this.request(HELPER_METHODS.attachStream, { udid });
    const socketPath =
      typeof result === "object" && result !== null
        ? (result as { socketPath?: unknown }).socketPath
        : undefined;
    if (typeof socketPath !== "string" || socketPath.length === 0) {
      throw new DeviceHelperError(
        "helper_malformed_response",
        "Device helper did not return a frame socket path",
      );
    }

    const socket = (this.options.connectFrameSocket ?? ((path: string) => connect(path)))(
      socketPath,
    );
    const parser = new DeviceFrameRecordParser();
    socket.on("data", (chunk: Buffer) => {
      let frames: readonly DeviceStreamFrame[];
      try {
        frames = parser.push(chunk);
      } catch {
        // A desynced stream cannot resynchronize: drop the socket and let the
        // manager surface the detach rather than emitting garbage NALs.
        socket.destroy();
        return;
      }
      for (const frame of frames) onFrame(frame);
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.frameSockets.get(udid) === socket) this.frameSockets.delete(udid);
    });
    this.frameSockets.set(udid, socket);
  }

  async detachStream(udid: string): Promise<void> {
    const socket = this.frameSockets.get(udid);
    if (socket) {
      this.frameSockets.delete(udid);
      socket.destroy();
    }
    if (this.running) {
      await this.request(HELPER_METHODS.detachStream, { udid }).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    for (const [udid] of this.frameSockets) await this.detachStream(udid);
    this.fail(new DeviceHelperError("helper_disposed", "Device helper was shut down"));
    const child = this.process;
    this.process = null;
    this.exited = true;
    child?.stdin.end();
    child?.kill("SIGTERM");
  }

  // ── Internals ──────────────────────────────────────────────────────

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
      // Helper logs that are not JSON are ignored; the protocol is responses only.
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof record.id !== "number") return;
    const request = this.pending.get(record.id);
    if (!request) return;
    this.pending.delete(record.id);
    clearTimeout(request.timer);
    if (record.error !== undefined && record.error !== null) {
      const error = record.error as { code?: unknown; message?: unknown };
      request.reject(
        new DeviceHelperError(
          typeof error.code === "string" ? error.code : "helper_error",
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
