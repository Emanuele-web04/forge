import {
  JSONRPC_STDIO_MAX_FRAME_BYTES,
  JSONRPC_STDIO_MAX_QUEUED_STDIN_BYTES,
  JsonRpcStdioFramer,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
  type JsonRpcStdioTransportErrorReason,
} from "@synara/shared/jsonrpc-stdio";

export const CODEX_APP_SERVER_MAX_FRAME_BYTES = JSONRPC_STDIO_MAX_FRAME_BYTES;
export const CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES = JSONRPC_STDIO_MAX_QUEUED_STDIN_BYTES;

export type CodexAppServerTransportErrorReason = JsonRpcStdioTransportErrorReason;

type CodexTransportErrorInput = {
  readonly reason: CodexAppServerTransportErrorReason;
  readonly maxBytes: number;
  readonly observedBytes: number;
  readonly cause?: unknown;
};

export class CodexAppServerTransportError extends JsonRpcStdioTransportError {
  constructor(input: CodexTransportErrorInput) {
    super({ ...input, message: transportErrorMessage(input) });
    this.name = "CodexAppServerTransportError";
  }
}

/** Codex-compatible name for the shared raw-byte JSONL framer. */
export class CodexJsonlFramer extends JsonRpcStdioFramer {
  constructor(maxFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES) {
    super(maxFrameBytes);
  }

  protected override makeTransportError(
    input: CodexTransportErrorInput,
  ): CodexAppServerTransportError {
    return new CodexAppServerTransportError(input);
  }
}

/** Codex-compatible name for the shared bounded, drain-aware JSONL writer. */
export class CodexJsonlWriter extends JsonRpcStdioWriter {
  constructor(
    writable: ConstructorParameters<typeof JsonRpcStdioWriter>[0],
    maxFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES,
    maxQueuedBytes = CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES,
  ) {
    super(writable, maxFrameBytes, maxQueuedBytes);
  }

  protected override makeTransportError(
    input: CodexTransportErrorInput,
  ): CodexAppServerTransportError {
    return new CodexAppServerTransportError(input);
  }

  protected override serializationError(cause?: unknown): Error {
    if (cause instanceof Error) return cause;
    if (cause !== undefined) return new Error(String(cause));
    return new TypeError("Codex app-server message is not JSON serializable");
  }

  protected override stdinClosedDuringWriteError(): Error {
    return new Error("Codex app-server stdin closed during write");
  }

  protected override stdinWriteAbortedError(): Error {
    return new Error("Codex app-server stdin write aborted");
  }
}

function transportErrorMessage(input: CodexTransportErrorInput): string {
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
