/**
 * MacComputerHelperClient — the only server module that knows the native macOS
 * computer-use helper's wire protocol.
 *
 * Packaged builds ship a signed universal Swift helper. Source builds retain a
 * compile-and-cache fallback for development. Private Quartz/AppKit SPI such as
 * `CGEventSetWindowLocation` is resolved at runtime so OS drift is reported as
 * a capability failure rather than a loader crash. It speaks one channel:
 *
 * - Control: newline-delimited JSON-RPC 2.0 over stdin/stdout. Requests carry
 *   an integer id; responses carry `result` or `error`. It also emits a `ready`
 *   notification at startup.
 *
 * Unlike the iOS device helper there is no frame socket: Tier-1 macOS capture
 * is a whole-desktop PNG still, and the backend publishes those on a timer the
 * same way the KWin backend does, so a burst of video can never share a pipe
 * with a command response because there is no video pipe at all.
 *
 * This reuses the shared `@synara/shared/jsonrpc-stdio` transport primitives —
 * the same ones the Codex app-server and device helper are built on — so the
 * framing, request correlation, and timeout logic are not a third copy.
 *
 * @module computer/macComputerHelperClient
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  JsonRpcStdioFramer,
  type JsonRpcPendingRequest,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
} from "@synara/shared/jsonrpc-stdio";

/** The methods the Swift helper serves. Kept in one place so the backend and its tests agree. */
export const MAC_HELPER_METHODS = {
  capabilities: "capabilities",
  /**
   * Asks macOS for the TCC grants this helper is missing and answers with the
   * same report `capabilities` does. The prompt is attributed to the responsible
   * process — the Synara app — so this is how a missing grant is asked for at
   * the moment an agent needs it, rather than only from a settings button.
   */
  requestPermissions: "request-permissions",
  listWindows: "list-windows",
  screenSize: "screen-size",
  describeUi: "describe-ui",
  checkInputReady: "check-input-ready",
  capture: "capture",
  launchApp: "launch-app",
  move: "move",
  click: "click",
  doubleClick: "double-click",
  /**
   * Three clicks with the click state carried through as one gesture, which is
   * what selects a line or a paragraph. Not expressible as three `click` calls:
   * the count reaches the target as a number on the event, and three separate
   * events are three carets.
   */
  tripleClick: "triple-click",
  rightClick: "right-click",
  drag: "drag",
  scroll: "scroll",
  type: "type",
  pressKey: "press-key",
  hotkey: "hotkey",
  setValue: "set-value",
  performAction: "perform-action",
  focusWindow: "focus-window",
  /**
   * `AXRaise` on the matching AX window: brings it forward inside its own
   * application without activating that application, and aims the keyboard at
   * it once the raise is observed. `notDelivered` when the window is still not
   * frontmost afterwards, because there is deliberately no activation fallback
   * that would pull the human's front application out from under them.
   */
  raiseWindow: "raise-window",
  readClipboard: "read-clipboard",
  writeClipboard: "write-clipboard",
  setAgentCursor: "set-agent-cursor",
} as const;

/** A long turn can hold the helper (a slow AX walk, a Screen Recording prompt), so the default is generous. */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * The control line carries a whole-desktop capture as base64, so this bounds a
 * picture, not a command. A 1680x1050 desktop measures ~1.4 MB encoded; a
 * Retina multi-display workspace at the 2048px capture ceiling is several times
 * that, and 4 MB put the cap inside the range of an ordinary screenshot. Base64
 * costs a third on top of the PNG, which the margin here accounts for.
 */
const MAX_CONTROL_LINE_BYTES = 24 * 1024 * 1024;
/** How long a helper gets to exit on its own before SIGKILL. Exported so a test can advance exactly this far. */
export const HELPER_SHUTDOWN_GRACE_MS = 2_000;

export class MacComputerHelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MacComputerHelperError";
    this.code = code;
  }
}

/**
 * The slice of a helper client the backend depends on. Narrowed to an interface
 * so a test can substitute a scripted transport without a real process, the way
 * the KWin backend takes an injectable D-Bus surface.
 */
export interface MacHelperTransport {
  readonly running: boolean;
  /**
   * Spawns the helper process. Idempotent, and optional in the sense that
   * `request` starts a client that has not been started — the backend calls it
   * anyway so a connect pays the spawn instead of the first agent action.
   */
  start(): void;
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface MacComputerHelperClientOptions {
  readonly binaryPath: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly requestTimeoutMs?: number;
  readonly onExit?: (reason: string) => void;
  /**
   * Where a transport-level diagnostic goes. A dropped stdout line is invisible
   * to callers — the helper is still running and the next request still works —
   * so without a sink the only symptom is a request that mysteriously times out
   * fifteen seconds later. Injected so a test can assert on what was reported;
   * production passes nothing and the message reaches the server log.
   */
  readonly onDiagnostic?: (message: string) => void;
  /**
   * Spawns the child. Injected so a test can stand in a fake process without a
   * real binary on disk; production passes nothing and gets `child_process.spawn`.
   */
  readonly spawn?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams;
  /**
   * Overrides the control-line byte budget. Test-only injection in the same
   * spirit as `spawn`: the production ceiling sizes a whole-desktop capture, and
   * a test cannot afford to build a 24 MB line just to reach the oversized-line
   * path. Production passes nothing and gets `MAX_CONTROL_LINE_BYTES`.
   */
  readonly maxControlLineBytes?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Owns one helper process: spawn, JSON-RPC over stdio, and the stderr tail that
 * turns a helper crash into a diagnosable failure message rather than a bare
 * exit code. There is no per-attachment state — a macOS desktop has no "attach"
 * step, every call names its own target — so this is thinner than the device
 * helper client.
 */
export class MacComputerHelperClient implements MacHelperTransport {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutFramer: JsonRpcStdioFramer | null = null;
  private stdinWriter: JsonRpcStdioWriter | null = null;
  private requestRegistry: JsonRpcStdioRequestRegistry | null = null;
  /**
   * The registry's own pending-request map, handed to it rather than read back
   * out of it: when a line is dropped the ids it carried are already gone, and
   * naming the requests that died with it is the only trace an operator gets.
   * One map outlives every registry generation, which is safe because a registry
   * is only replaced after its predecessor rejected and cleared its entries.
   */
  private readonly pendingRequests = new Map<string, JsonRpcPendingRequest>();
  private readonly requestTimeoutMs: number;
  private stderrTail = "";
  private exited = false;
  /**
   * Why this helper stopped being usable, kept so a request that arrives
   * afterwards can be told the real reason instead of a generic "not running".
   *
   * The first one wins: a spawn failure is followed by a `close` whose only
   * content is "code=null", and answering `spawn ENOENT` with that would throw
   * away the one line that says what to fix.
   */
  private terminalError: MacComputerHelperError | undefined;
  /** Terminal. `dispose()` is not a pause: a later request must not respawn. */
  private disposed = false;

  constructor(private readonly options: MacComputerHelperClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get running(): boolean {
    return this.process !== null && !this.exited;
  }

  start(): void {
    if (this.disposed || this.process) return;
    const spawnFn =
      this.options.spawn ??
      ((command, args, env) => spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env }));
    const child = spawnFn(
      this.options.binaryPath,
      this.options.args ?? [],
      this.options.env ?? process.env,
    );
    this.process = child;
    this.exited = false;
    this.terminalError = undefined;
    this.stdoutFramer = new JsonRpcStdioFramer(
      this.options.maxControlLineBytes ?? MAX_CONTROL_LINE_BYTES,
      (error) => this.handleControlLineError(error),
    );
    this.stdinWriter = new JsonRpcStdioWriter(child.stdin);
    this.requestRegistry = new JsonRpcStdioRequestRegistry({
      pending: this.pendingRequests,
      requestTimeoutMs: this.requestTimeoutMs,
      includeJsonRpcVersion: true,
      timeoutError: (method) =>
        new MacComputerHelperError("helper_timeout", `Computer helper ${method} timed out.`),
      responseError: ({ error }) =>
        new MacComputerHelperError(
          typeof error.code === "number" ? `helper_${error.code}` : "helper_error",
          typeof error.message === "string" ? error.message : "Computer helper reported an error",
        ),
    });
    this.requestRegistry.processStarted();

    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep only a tail: helper diagnostics belong in the failure message but
      // must never grow without bound over a long-lived session.
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_096);
    });
    child.on("error", (error) =>
      this.fail(new MacComputerHelperError("helper_spawn_failed", error.message)),
    );
    child.on("exit", (code, signal) => this.terminate("exited", code, signal));
    // `exit` alone is not enough. A spawn that never produced a process — a
    // missing binary, a quarantined helper — emits `error` and then `close`, and
    // no `exit` at all, so a client listening only for `exit` went on reporting
    // itself as running over a child that does not exist: the next request
    // reached a closed stdin and failed as `helper_write_failed`, a fault code
    // that says nothing about the actual `spawn ENOENT`. `close` is the one
    // event both paths always deliver; the guard inside `terminate` keeps the
    // ordinary case (exit, then close) from being counted twice.
    child.on("close", (code, signal) => this.terminate("closed", code, signal));
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<unknown> {
    // `dispose()` clears `process` and sets `exited`, so without this a request
    // arriving afterwards took the "not started yet" path and spawned a fresh
    // child that nothing owned or would ever shut down.
    if (this.disposed) {
      throw new MacComputerHelperError("helper_disposed", "Computer helper was shut down");
    }
    if (!this.process) this.start();
    const child = this.process;
    if (!child || this.exited) {
      // The recorded cause where there is one: "not running" is true of a
      // helper that died of `spawn ENOENT` and of one that crashed on an AX
      // call, and only the recorded error tells the two apart.
      throw (
        this.terminalError ??
        new MacComputerHelperError("helper_unavailable", "Computer helper is not running")
      );
    }
    const registry = this.requestRegistry;
    const writer = this.stdinWriter;
    if (!registry || !writer) {
      throw new MacComputerHelperError(
        "helper_unavailable",
        "Computer helper transport is not ready",
      );
    }
    const signal = options.signal;
    signal?.throwIfAborted();
    let requestId: unknown;
    const cancel = () => {
      if (requestId !== undefined) {
        void writer
          .write({ jsonrpc: "2.0", method: "cancel-request", params: { id: requestId } })
          .catch(() => undefined);
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    // Input budgets include the requested gesture plus acknowledgement/AX overhead.
    const duration =
      method === "drag" && typeof params.durationMs === "number"
        ? Math.min(30_000, Math.max(0, params.durationMs))
        : method === "type" && typeof params.text === "string"
          ? params.text.length * 16
          : 0;
    try {
      const result = await registry.request(
        method,
        params,
        (message) => {
          requestId = (message as { id: unknown }).id;
          const written = writer.write(message);
          if (signal?.aborted) cancel();
          return written;
        },
        this.requestTimeoutMs + duration,
      );
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted || error instanceof MacComputerHelperError) throw error;
      throw new MacComputerHelperError(
        "helper_write_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new MacComputerHelperError("helper_disposed", "Computer helper was shut down"));
    const child = this.process;
    this.process = null;
    this.exited = true;
    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
    // Closed stdin and SIGTERM are both clean-exit paths the helper handles, but
    // neither is a guarantee: a helper wedged in a synchronous AX or capture call
    // answers no signal, and a leaked helper holds the Accessibility grant and
    // keeps drawing its cursor overlay. Escalate rather than leak.
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, HELPER_SHUTDOWN_GRACE_MS);
      // Node keeps the loop alive for this timer otherwise, delaying every exit.
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ── Internals ──────────────────────────────────────────────────────

  private consumeStdout(chunk: Buffer): void {
    const framer = this.stdoutFramer;
    if (!framer) return;
    try {
      for (const line of framer.push(chunk)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) this.handleControlLine(trimmed);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.rejectInFlight(
        new MacComputerHelperError("helper_protocol_error", message, { cause: error }),
      );
    }
  }

  /**
   * A line the framer had to drop. The framer has already resynchronized past
   * it, so this only decides how loudly to react — the helper is still there and
   * the next request has to be able to reach it, so neither branch touches the
   * process or the write path.
   *
   * An oversized line is the loud case: the framer discards the offending bytes
   * before reporting, so the JSON-RPC id that line carried is unrecoverable and
   * there is no way to fail only the request it answered. Every in-flight
   * request is rejected instead, so callers fail fast rather than sitting out
   * the full timeout, and the diagnostic names them because it is the only
   * record of what was lost. Any other reason — undecodable bytes, most often a
   * helper log line that is not valid UTF-8 — costs exactly that line, so it is
   * reported and nothing else: rejecting there would turn a stray log write into
   * a failed agent action.
   */
  private handleControlLineError(error: JsonRpcStdioTransportError): void {
    if (error.reason !== "frame-too-large") {
      this.diagnostic(
        `dropped a control line (${error.reason}, ${error.observedBytes} bytes): ${error.message}`,
      );
      return;
    }
    const dropped = [...this.pendingRequests.entries()].map(
      ([id, request]) => `${request.method}#${id}`,
    );
    this.diagnostic(
      `control line exceeded limit (${error.observedBytes}/${error.maxBytes} bytes); failing ${dropped.length} in-flight request(s): ${dropped.length > 0 ? dropped.join(", ") : "none"}`,
    );
    this.rejectInFlight(
      new MacComputerHelperError(
        "helper_protocol_error",
        "Computer helper control line exceeded limit",
        { cause: error },
      ),
    );
  }

  private handleControlLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Helper logs that are not JSON are ignored, same as the device helper.
      return;
    }
    const record = asRecord(message);
    // Notifications (`ready`, diagnostics) carry no id and need no reply.
    if (typeof record.id !== "number") return;
    const error =
      record.error === undefined || record.error === null ? undefined : asRecord(record.error);
    this.requestRegistry?.handleResponse({
      id: record.id,
      result: record.result ?? null,
      ...(error
        ? {
            error: {
              ...(typeof error.code === "number" ? { code: error.code } : {}),
              ...(typeof error.message === "string" ? { message: error.message } : {}),
            },
          }
        : {}),
    });
  }

  private diagnostic(message: string): void {
    (this.options.onDiagnostic ?? ((text: string) => console.warn(text)))(
      `[computer] mac helper ${message}`,
    );
  }

  private rejectInFlight(error: MacComputerHelperError): void {
    this.requestRegistry?.rejectAll(error);
  }

  /**
   * The child is gone, whichever event said so. Runs once: `exit` and `close`
   * both fire for an ordinary termination, and reporting that twice would put a
   * second `onExit` through the backend's invalidation for a helper it has
   * already replaced.
   */
  private terminate(verb: "exited" | "closed", code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    const tail = this.stderrTail.trim();
    const reason = `computer helper ${verb} (code=${code ?? "null"}, signal=${signal ?? "null"})${
      tail ? `: ${tail}` : ""
    }`;
    this.fail(new MacComputerHelperError("helper_exited", reason));
    this.options.onExit?.(reason);
  }

  private fail(error: MacComputerHelperError): void {
    this.terminalError ??= error;
    this.requestRegistry?.processExited(error);
    this.stdinWriter?.close(error);
  }
}
