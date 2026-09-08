import type { Writable } from "node:stream";

export const CODEX_APP_SERVER_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES = 32 * 1024 * 1024;

export type CodexAppServerTransportErrorReason =
  | "frame-too-large"
  | "invalid-utf8"
  | "unterminated-frame"
  | "read-closed"
  | "write-overloaded"
  | "write-closed";

export class CodexAppServerTransportError extends Error {
  readonly reason: CodexAppServerTransportErrorReason;
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(input: {
    readonly reason: CodexAppServerTransportErrorReason;
    readonly maxBytes: number;
    readonly observedBytes: number;
    readonly cause?: unknown;
  }) {
    super(transportErrorMessage(input), {
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });
    this.name = "CodexAppServerTransportError";
    this.reason = input.reason;
    this.maxBytes = input.maxBytes;
    this.observedBytes = input.observedBytes;
  }
}

/** Raw-byte JSONL framing so split UTF-8 sequences never decode prematurely. */
export class CodexJsonlFramer {
  private readonly chunks: Buffer[] = [];
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private frameBytes = 0;
  private ended = false;

  constructor(readonly maxFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("Codex JSONL frame budget must be a positive safe integer");
    }
  }

  push(chunk: Buffer | Uint8Array | string): ReadonlyArray<string> {
    if (this.ended) {
      throw new CodexAppServerTransportError({
        reason: "unterminated-frame",
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      });
    }

    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: string[] = [];
    let start = 0;

    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline === -1 ? bytes.length : newline;
      this.append(bytes.subarray(start, end));
      if (newline === -1) break;
      frames.push(this.takeFrame());
      start = newline + 1;
    }

    return frames;
  }

  finish(): void {
    this.ended = true;
    if (this.frameBytes > 0) {
      throw new CodexAppServerTransportError({
        reason: "unterminated-frame",
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      });
    }
  }

  reset(): void {
    this.chunks.length = 0;
    this.frameBytes = 0;
    this.ended = true;
  }

  get bufferedBytes(): number {
    return this.frameBytes;
  }

  private append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const observedBytes = this.frameBytes + chunk.length;
    if (observedBytes > this.maxFrameBytes) {
      const error = new CodexAppServerTransportError({
        reason: "frame-too-large",
        maxBytes: this.maxFrameBytes,
        observedBytes,
      });
      // Oversize input is terminal for this stream. Release already-buffered
      // chunks immediately instead of retaining them until process teardown.
      this.reset();
      throw error;
    }
    // Do not retain a large source chunk through one small trailing slice.
    this.chunks.push(Buffer.from(chunk));
    this.frameBytes = observedBytes;
  }

  private takeFrame(): string {
    let frame = Buffer.concat(this.chunks, this.frameBytes);
    if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
    this.chunks.length = 0;
    this.frameBytes = 0;
    try {
      return this.decoder.decode(frame);
    } catch (cause) {
      throw new CodexAppServerTransportError({
        reason: "invalid-utf8",
        maxBytes: this.maxFrameBytes,
        observedBytes: frame.length,
        cause,
      });
    }
  }
}

type PendingWrite = {
  readonly frame: Buffer;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

/** Serializes JSONL writes, bounds retained frames, and honors stream drain. */
export class CodexJsonlWriter {
  private readonly pending: PendingWrite[] = [];
  private queuedBytes = 0;
  private pumping = false;
  private closed = false;
  private activeAbort: AbortController | undefined;

  constructor(
    private readonly writable: Writable,
    readonly maxFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES,
    readonly maxQueuedBytes = CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES,
  ) {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes <= 0 ||
      !Number.isSafeInteger(maxQueuedBytes) ||
      maxQueuedBytes < maxFrameBytes
    ) {
      throw new RangeError("Codex stdin budgets must be positive and queue >= frame");
    }
  }

  write(message: unknown): Promise<void> {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(message);
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
    if (encoded === undefined) {
      return Promise.reject(new TypeError("Codex app-server message is not JSON serializable"));
    }

    const frame = Buffer.from(`${encoded}\n`);
    if (frame.length > this.maxFrameBytes) {
      return Promise.reject(
        new CodexAppServerTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxFrameBytes,
          observedBytes: frame.length,
        }),
      );
    }
    if (this.closed || !this.writable.writable) {
      return Promise.reject(this.closedError(frame.length));
    }
    if (this.queuedBytes + frame.length > this.maxQueuedBytes) {
      return Promise.reject(
        new CodexAppServerTransportError({
          reason: "write-overloaded",
          maxBytes: this.maxQueuedBytes,
          observedBytes: this.queuedBytes + frame.length,
        }),
      );
    }

    this.queuedBytes += frame.length;
    const result = new Promise<void>((resolve, reject) => {
      this.pending.push({ frame, resolve, reject });
    });
    void this.pump();
    return result;
  }

  get bufferedBytes(): number {
    return this.queuedBytes;
  }

  close(cause?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const error = cause instanceof Error ? cause : this.closedError(this.queuedBytes, cause);
    this.activeAbort?.abort(error);
    for (const pending of this.pending.splice(0)) pending.reject(error);
    this.queuedBytes = 0;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed) {
        const next = this.pending.shift();
        if (!next) break;
        const activeAbort = new AbortController();
        this.activeAbort = activeAbort;
        try {
          await writeWithDrain(this.writable, next.frame, activeAbort.signal);
          next.resolve();
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          next.reject(error);
          this.close(error);
        } finally {
          if (this.activeAbort === activeAbort) this.activeAbort = undefined;
          this.queuedBytes = Math.max(0, this.queuedBytes - next.frame.length);
        }
      }
    } finally {
      this.pumping = false;
      if (!this.closed && this.pending.length > 0) void this.pump();
    }
  }

  private closedError(observedBytes: number, cause?: unknown): CodexAppServerTransportError {
    return new CodexAppServerTransportError({
      reason: "write-closed",
      maxBytes: this.maxQueuedBytes,
      observedBytes,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

function writeWithDrain(writable: Writable, frame: Buffer, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let callbackComplete = false;
    let drainComplete = true;
    let writeReturned = false;
    let settled = false;

    const cleanup = () => {
      writable.off("error", onError);
      writable.off("close", onClose);
      writable.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = () => {
      if (settled || !writeReturned || !callbackComplete || !drainComplete) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error("Codex app-server stdin closed during write"));
    const onAbort = () => fail(signal.reason ?? new Error("Codex app-server stdin write aborted"));
    const onDrain = () => {
      drainComplete = true;
      settle();
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    writable.once("error", onError);
    writable.once("close", onClose);
    let accepted: boolean;
    try {
      accepted = writable.write(frame, (error?: Error | null) => {
        if (error) {
          fail(error);
          return;
        }
        callbackComplete = true;
        settle();
      });
    } catch (cause) {
      fail(cause);
      return;
    }
    drainComplete = accepted;
    writeReturned = true;
    if (!accepted && !settled) {
      writable.once("drain", onDrain);
    }
    settle();
  });
}

function transportErrorMessage(input: {
  readonly reason: CodexAppServerTransportErrorReason;
  readonly maxBytes: number;
  readonly observedBytes: number;
}): string {
  switch (input.reason) {
    case "invalid-utf8":
      return `Codex app-server emitted invalid UTF-8 (${input.observedBytes} bytes).`;
    case "read-closed":
      return "Codex app-server stdout closed before process shutdown.";
    case "unterminated-frame":
      return `Codex app-server stdout ended with an unterminated JSONL frame (${input.observedBytes}/${input.maxBytes} bytes).`;
    case "frame-too-large":
      return `Codex app-server JSONL frame exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-overloaded":
      return `Codex app-server stdin queue exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-closed":
      return "Codex app-server stdin closed before the frame was written.";
  }
}
