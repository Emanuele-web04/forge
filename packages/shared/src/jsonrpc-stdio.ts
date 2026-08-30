import type { Writable } from "node:stream";

/** Default byte budgets shared by the Codex and native helper transports. */
export const JSONRPC_STDIO_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const JSONRPC_STDIO_MAX_QUEUED_STDIN_BYTES = 32 * 1024 * 1024;

export type JsonRpcStdioTransportErrorReason =
  | "frame-too-large"
  | "invalid-utf8"
  | "unterminated-frame"
  | "read-closed"
  | "write-overloaded"
  | "write-closed";

export class JsonRpcStdioTransportError extends Error {
  readonly reason: JsonRpcStdioTransportErrorReason;
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(input: {
    readonly reason: JsonRpcStdioTransportErrorReason;
    readonly maxBytes: number;
    readonly observedBytes: number;
    readonly cause?: unknown;
    readonly message?: string;
  }) {
    super(
      input.message ?? jsonRpcStdioTransportErrorMessage(input),
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "JsonRpcStdioTransportError";
    this.reason = input.reason;
    this.maxBytes = input.maxBytes;
    this.observedBytes = input.observedBytes;
  }
}

export class JsonRpcStdioRequestTimeoutError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`Timed out waiting for ${method}.`);
    this.name = "JsonRpcStdioRequestTimeoutError";
    this.method = method;
  }
}

/**
 * Notified for each line the framer had to drop, either because it outgrew the
 * frame budget or because it was not valid UTF-8.
 *
 * By the time this runs the framer has already resynchronized past the offending
 * line, so a handler that returns normally lets framing continue with the next
 * one. The default handler rethrows, which keeps a framing failure fatal for the
 * callers that treat transport errors as session-ending.
 */
export type JsonRpcStdioLineErrorHandler = (error: JsonRpcStdioTransportError) => void;

function rethrowLineError(error: JsonRpcStdioTransportError): never {
  throw error;
}

/** Raw-byte JSONL framing. Retaining bytes until newline keeps split UTF-8 safe. */
export class JsonRpcStdioFramer {
  private readonly chunks: Buffer[] = [];
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private frameBytes = 0;
  private ended = false;
  /** Set while the remainder of a dropped line is being skipped to its newline. */
  private skipping = false;

  constructor(
    readonly maxFrameBytes = JSONRPC_STDIO_MAX_FRAME_BYTES,
    private readonly onLineError: JsonRpcStdioLineErrorHandler = rethrowLineError,
  ) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("JSON-RPC stdio frame budget must be a positive safe integer");
    }
  }

  /**
   * Frames a chunk, returning every complete line it completed.
   *
   * A line that cannot be framed costs exactly that line: its bytes are dropped,
   * the scan continues to the next newline (across chunks if the line is still
   * arriving), and the failure is reported through `onLineError` once the whole
   * chunk has been consumed. Reporting last is what keeps a throwing handler
   * from leaving unread bytes behind and desynchronizing the next chunk.
   */
  push(chunk: Buffer | Uint8Array | string): ReadonlyArray<string> {
    if (this.ended) {
      throw this.makeTransportError({
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
    const errors: JsonRpcStdioTransportError[] = [];
    let start = 0;

    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline === -1 ? bytes.length : newline;
      if (!this.skipping) {
        const overflow = this.append(bytes.subarray(start, end));
        if (overflow) {
          this.discardFrame();
          this.skipping = true;
          errors.push(overflow);
        }
      }
      if (newline === -1) break;
      start = newline + 1;
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      const frame = this.takeFrame();
      if (typeof frame === "string") frames.push(frame);
      else errors.push(frame);
    }

    for (const error of errors) this.onLineError(error);
    return frames;
  }

  finish(): void {
    this.ended = true;
    if (this.frameBytes > 0) {
      throw this.makeTransportError({
        reason: "unterminated-frame",
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      });
    }
  }

  /** Discards buffered bytes and permanently closes this framer. */
  close(): void {
    this.discardFrame();
    this.skipping = false;
    this.ended = true;
  }

  get bufferedBytes(): number {
    return this.frameBytes;
  }

  protected makeTransportError(input: {
    readonly reason: JsonRpcStdioTransportErrorReason;
    readonly maxBytes: number;
    readonly observedBytes: number;
    readonly cause?: unknown;
  }): JsonRpcStdioTransportError {
    return new JsonRpcStdioTransportError(input);
  }

  private discardFrame(): void {
    this.chunks.length = 0;
    this.frameBytes = 0;
  }

  /** Returns the overflow error instead of throwing, so the caller can resync. */
  private append(chunk: Buffer): JsonRpcStdioTransportError | undefined {
    if (chunk.length === 0) return undefined;
    const observedBytes = this.frameBytes + chunk.length;
    if (observedBytes > this.maxFrameBytes) {
      return this.makeTransportError({
        reason: "frame-too-large",
        maxBytes: this.maxFrameBytes,
        observedBytes,
      });
    }
    this.chunks.push(Buffer.from(chunk));
    this.frameBytes = observedBytes;
    return undefined;
  }

  /** The decoded line, or the decode failure. Either way the bytes are consumed. */
  private takeFrame(): string | JsonRpcStdioTransportError {
    let frame = Buffer.concat(this.chunks, this.frameBytes);
    if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
    this.discardFrame();
    try {
      return this.decoder.decode(frame);
    } catch (cause) {
      return this.makeTransportError({
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
export class JsonRpcStdioWriter {
  private readonly pending: PendingWrite[] = [];
  private queuedBytes = 0;
  private pumping = false;
  private closed = false;
  private activeAbort: AbortController | undefined;

  constructor(
    private readonly writable: Writable,
    readonly maxFrameBytes = JSONRPC_STDIO_MAX_FRAME_BYTES,
    readonly maxQueuedBytes = JSONRPC_STDIO_MAX_QUEUED_STDIN_BYTES,
  ) {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes <= 0 ||
      !Number.isSafeInteger(maxQueuedBytes) ||
      maxQueuedBytes < maxFrameBytes
    ) {
      throw new RangeError("JSON-RPC stdio budgets must be positive and queue >= frame");
    }
  }

  write(message: unknown): Promise<void> {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(message);
    } catch (cause) {
      return Promise.reject(this.serializationError(cause));
    }
    if (encoded === undefined) {
      return Promise.reject(this.serializationError());
    }

    const frame = Buffer.from(`${encoded}\n`);
    if (frame.length > this.maxFrameBytes) {
      return Promise.reject(
        this.makeTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxFrameBytes,
          observedBytes: frame.length,
        }),
      );
    }
    if (this.closed || this.writable.writable === false) {
      return Promise.reject(this.closedError(frame.length));
    }
    if (this.queuedBytes + frame.length > this.maxQueuedBytes) {
      return Promise.reject(
        this.makeTransportError({
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

  protected makeTransportError(input: {
    readonly reason: JsonRpcStdioTransportErrorReason;
    readonly maxBytes: number;
    readonly observedBytes: number;
    readonly cause?: unknown;
  }): JsonRpcStdioTransportError {
    return new JsonRpcStdioTransportError(input);
  }

  protected closedError(observedBytes: number, cause?: unknown): JsonRpcStdioTransportError {
    return this.makeTransportError({
      reason: "write-closed",
      maxBytes: this.maxQueuedBytes,
      observedBytes,
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  protected serializationError(cause?: unknown): Error {
    if (cause instanceof Error) return cause;
    if (cause !== undefined) return new Error(String(cause));
    return new TypeError("JSON-RPC stdio message is not JSON serializable");
  }

  protected stdinClosedDuringWriteError(): Error {
    return new Error("JSON-RPC stdio stdin closed during write");
  }

  protected stdinWriteAbortedError(): Error {
    return new Error("JSON-RPC stdio stdin write aborted");
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
          await writeWithDrain(
            this.writable,
            next.frame,
            activeAbort.signal,
            this.stdinClosedDuringWriteError(),
            this.stdinWriteAbortedError(),
          );
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
    }
  }
}

export type JsonRpcId = string | number;

export interface JsonRpcResponse {
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly data?: unknown;
  };
}

export interface JsonRpcPendingRequest {
  readonly method: string;
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface JsonRpcStdioLifecycleHooks {
  readonly onSpawn?: (generation: number) => void;
  readonly onRespawn?: (generation: number) => void;
  readonly onExit?: (error: Error) => void;
}

export interface JsonRpcStdioRequestRegistryOptions {
  readonly pending?: Map<string, JsonRpcPendingRequest>;
  readonly requestTimeoutMs?: number;
  readonly includeJsonRpcVersion?: boolean;
  readonly nextRequestId?: number;
  readonly timeoutError?: (method: string) => Error;
  readonly responseError?: (input: {
    readonly method: string;
    readonly id: JsonRpcId;
    readonly error: NonNullable<JsonRpcResponse["error"]>;
  }) => Error;
  readonly lifecycle?: JsonRpcStdioLifecycleHooks;
}

/** Correlates requests with responses and provides process lifecycle hooks. */
export class JsonRpcStdioRequestRegistry {
  private readonly pending: Map<string, JsonRpcPendingRequest>;
  private readonly requestTimeoutMs: number;
  private readonly includeJsonRpcVersion: boolean;
  private readonly timeoutError: (method: string) => Error;
  private readonly responseError: NonNullable<JsonRpcStdioRequestRegistryOptions["responseError"]>;
  private readonly lifecycle: JsonRpcStdioLifecycleHooks;
  private nextId: number;
  private generation = 0;
  private processActive = false;

  constructor(options: JsonRpcStdioRequestRegistryOptions = {}) {
    this.pending = options.pending ?? new Map();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new RangeError("JSON-RPC request timeout must be a positive safe integer");
    }
    this.includeJsonRpcVersion = options.includeJsonRpcVersion ?? false;
    this.nextId = options.nextRequestId ?? 1;
    this.timeoutError =
      options.timeoutError ?? ((method) => new JsonRpcStdioRequestTimeoutError(method));
    this.responseError =
      options.responseError ??
      ((input) =>
        new Error(
          `${input.method} failed: ${input.error.message ?? "JSON-RPC peer reported an error"}`,
        ));
    this.lifecycle = options.lifecycle ?? {};
  }

  get size(): number {
    return this.pending.size;
  }

  get nextRequestId(): number {
    return this.nextId;
  }

  request(
    method: string,
    params: unknown,
    write: (message: unknown) => Promise<void> | void,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const id = this.nextId++;
    return this.requestWithId(id, method, params, write, timeoutMs);
  }

  requestWithId(
    id: JsonRpcId,
    method: string,
    params: unknown,
    write: (message: unknown) => Promise<void> | void,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new RangeError("JSON-RPC request timeout must be a positive safe integer"),
      );
    }
    const key = String(id);
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`Duplicate JSON-RPC request id ${JSON.stringify(id)}.`));
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(this.timeoutError(method));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(key, { method, timeout, resolve, reject });
      const message = {
        ...(this.includeJsonRpcVersion ? { jsonrpc: "2.0" as const } : {}),
        id,
        method,
        params,
      };
      const rejectPending = (cause: unknown) => {
        const request = this.pending.get(key);
        if (!request) return;
        this.pending.delete(key);
        clearTimeout(request.timeout);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      };
      try {
        Promise.resolve(write(message)).catch(rejectPending);
      } catch (cause) {
        rejectPending(cause);
      }
    });
  }

  /** Resolve a response. Returns false for an unknown or notification-shaped id. */
  handleResponse(response: JsonRpcResponse): boolean {
    const key = String(response.id);
    const request = this.pending.get(key);
    if (!request) return false;
    this.pending.delete(key);
    clearTimeout(request.timeout);
    if (response.error !== undefined) {
      request.reject(
        this.responseError({
          method: request.method,
          id: response.id,
          error: response.error,
        }),
      );
    } else {
      request.resolve(response.result);
    }
    return true;
  }

  rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }

  processStarted(): void {
    const wasStarted = this.generation > 0;
    this.generation += 1;
    this.processActive = true;
    this.lifecycle.onSpawn?.(this.generation);
    if (wasStarted) this.lifecycle.onRespawn?.(this.generation);
  }

  processExited(error: Error): void {
    this.rejectAll(error);
    if (!this.processActive) return;
    this.processActive = false;
    this.lifecycle.onExit?.(error);
  }
}

function writeWithDrain(
  writable: Writable,
  frame: Buffer,
  signal: AbortSignal,
  closedError: Error,
  abortedError: Error,
): Promise<void> {
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
    const onClose = () => fail(closedError);
    const onAbort = () => fail(signal.reason ?? abortedError);
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
    if (!accepted && !settled) writable.once("drain", onDrain);
    settle();
  });
}

function jsonRpcStdioTransportErrorMessage(input: {
  readonly reason: JsonRpcStdioTransportErrorReason;
  readonly maxBytes: number;
  readonly observedBytes: number;
}): string {
  switch (input.reason) {
    case "invalid-utf8":
      return `JSON-RPC stdio emitted invalid UTF-8 (${input.observedBytes} bytes).`;
    case "read-closed":
      return "JSON-RPC stdio stdout closed before process shutdown.";
    case "unterminated-frame":
      return `JSON-RPC stdio ended with an unterminated JSONL frame (${input.observedBytes}/${input.maxBytes} bytes).`;
    case "frame-too-large":
      return `JSON-RPC stdio JSONL frame exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-overloaded":
      return `JSON-RPC stdio stdin queue exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-closed":
      return "JSON-RPC stdio stdin closed before the frame was written.";
  }
}
