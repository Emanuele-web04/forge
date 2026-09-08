import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  JsonRpcStdioFramer,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
} from "@synara/shared/jsonrpc-stdio";

import type { ComputerWindow } from "@synara/contracts";
import type { AtspiWindowTree } from "./atspiTreeTargeting.ts";

const HELPER_READ_TREE_METHOD = "read-tree";
const HELPER_SET_TEXT_METHOD = "set-text";
const HELPER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HELPER_REQUEST_TIMEOUT_MS = 10_000;
const HELPER_RECONNECT_BASE_DELAY_MS = 250;
const HELPER_RECONNECT_MAX_DELAY_MS = 5_000;
/** How long a SIGTERM'd helper has to exit before dispose escalates to SIGKILL. */
const ATSPI_KILL_GRACE_MS = 1_000;

/**
 * A semantic text write addressed the same way the tree was read: the window
 * descriptor the helper matched, plus the child-index path it emitted. The
 * helper re-resolves both on every call, so nothing depends on the process that
 * produced the tree still being alive.
 */
export interface AtspiTextWrite {
  readonly window: ComputerWindow;
  readonly path: readonly number[];
  readonly text: string;
  /** Checked against the live node so tree drift cannot redirect the write. */
  readonly role?: string;
  readonly label?: string | null;
}

/**
 * The helper answering "no", as opposed to the helper being gone.
 *
 * A JSON-RPC error envelope is a well-formed response from a live process: a
 * window that closed while its tree was being walked, an unknown method on an
 * older helper build. Killing the process over one turns every routine
 * semantic-target miss into a respawn and ratchets the reconnect backoff to five
 * seconds, so the next few perception requests are slow for no reason.
 */
class AtspiHelperMethodError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "AtspiHelperMethodError";
    this.code = code;
  }
}

export interface AtspiTreeReader {
  readonly readTrees: (windows: readonly ComputerWindow[]) => Promise<readonly AtspiWindowTree[]>;
  /** Resolves `false` when the helper refused the write; rejects when it failed. */
  readonly setText: (write: AtspiTextWrite) => Promise<boolean>;
  readonly dispose: () => Promise<void>;
}

export interface AtspiHelperClientOptions {
  readonly pythonPath?: string;
  readonly scriptPath?: string;
  readonly requestTimeoutMs?: number;
  /**
   * Environment overrides for the helper process, including its
   * `DBUS_SESSION_BUS_ADDRESS` when required by the session.
   */
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
  ) => ChildProcessWithoutNullStreams;
}

/**
 * Supervises the small PyGObject AT-SPI reader. The helper is deliberately
 * stateless: a crashed process loses only one perception request and the next
 * request starts a fresh process after a bounded backoff.
 */
export class AtspiHelperClient implements AtspiTreeReader {
  private process: ChildProcessWithoutNullStreams | null = null;
  private framer: JsonRpcStdioFramer | null = null;
  private writer: JsonRpcStdioWriter | null = null;
  private registry: JsonRpcStdioRequestRegistry | null = null;
  private readonly requestTimeoutMs: number;
  private reconnectFailures = 0;
  private startPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: AtspiHelperClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? HELPER_REQUEST_TIMEOUT_MS;
  }

  async readTrees(windows: readonly ComputerWindow[]): Promise<readonly AtspiWindowTree[]> {
    if (windows.length === 0) return [];
    const result = await this.request(HELPER_READ_TREE_METHOD, {
      windows: windows.map(helperWindow),
    });
    if (!isRecord(result) || !Array.isArray(result.trees)) {
      throw new Error("AT-SPI helper returned no tree list.");
    }
    return result.trees.filter(isAtspiWindowTree);
  }

  async setText(write: AtspiTextWrite): Promise<boolean> {
    const result = await this.request(HELPER_SET_TEXT_METHOD, {
      window: helperWindow(write.window),
      path: [...write.path],
      text: write.text,
      ...(write.role ? { role: write.role } : {}),
      ...(write.label ? { label: write.label } : {}),
    });
    return isRecord(result) && result.ok === true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const process = this.process;
    this.process = null;
    this.framer?.close();
    this.writer?.close(new Error("AT-SPI helper disposed"));
    this.registry?.processExited(new Error("AT-SPI helper disposed"));
    this.framer = null;
    this.writer = null;
    this.registry = null;
    process?.stdin.end();
    process?.kill("SIGTERM");
    // SIGTERM is a request; a helper wedged in an uninterruptible read would
    // ignore it and linger attached to the compositor. A short grace, then the
    // kill that cannot be declined.
    if (process) {
      const survivor = setTimeout(() => process.kill("SIGKILL"), ATSPI_KILL_GRACE_MS);
      survivor.unref?.();
      void process.once("exit", () => clearTimeout(survivor));
    }
    await this.startPromise?.catch(() => undefined);
    this.startPromise = null;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new Error("AT-SPI helper is disposed.");
    await this.ensureStarted();
    const registry = this.registry;
    const writer = this.writer;
    if (!registry || !writer) throw new Error("AT-SPI helper transport is unavailable.");
    try {
      const result = await registry.request(
        method,
        params,
        (message) => writer.write(message),
        this.requestTimeoutMs,
      );
      this.reconnectFailures = 0;
      return result;
    } catch (error) {
      // The peer answered, so the transport is healthy and the backoff is
      // cleared exactly as it would be for a success. Only the request failed.
      if (error instanceof AtspiHelperMethodError) {
        this.reconnectFailures = 0;
        throw error;
      }
      this.resetProcess(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.process !== null && this.registry !== null && this.writer !== null) return;
    if (this.startPromise) return this.startPromise;

    const delay =
      this.reconnectFailures === 0
        ? 0
        : Math.min(
            HELPER_RECONNECT_MAX_DELAY_MS,
            HELPER_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectFailures,
          );
    const wait =
      delay === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            // A pending reconnect is not work the process should be kept
            // alive for; the next request re-arms it.
            timer.unref?.();
          });
    this.startPromise = wait
      .then(() => {
        if (this.disposed) return;
        this.startProcess();
      })
      .finally(() => {
        this.startPromise = null;
      });
    await this.startPromise;
  }

  private startProcess(): void {
    const command = this.options.pythonPath ?? process.env.SYNARA_ATSPI_PYTHON ?? "python3";
    const scriptPath =
      this.options.scriptPath ??
      process.env.SYNARA_ATSPI_HELPER ??
      fileURLToPath(new URL("./atspi_helper.py", import.meta.url));
    const spawnProcess =
      this.options.spawnProcess ??
      ((spawnCommand, args) =>
        spawn(spawnCommand, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...this.options.env, PYTHONUNBUFFERED: "1" },
        }));
    const child = spawnProcess(command, ["-u", scriptPath]);
    this.process = child;
    this.framer = new JsonRpcStdioFramer(HELPER_MAX_FRAME_BYTES);
    this.writer = new JsonRpcStdioWriter(child.stdin, HELPER_MAX_FRAME_BYTES);
    this.registry = new JsonRpcStdioRequestRegistry({
      requestTimeoutMs: this.requestTimeoutMs,
      includeJsonRpcVersion: true,
      // Only a well-formed response envelope carrying an error reaches this
      // hook; timeouts and transport failures come through their own paths. The
      // distinct type is how `request` tells the two apart.
      responseError: ({ error }) =>
        new AtspiHelperMethodError(
          typeof error.message === "string" ? error.message : "AT-SPI helper request failed",
          typeof error.code === "number" ? error.code : undefined,
        ),
    });
    this.registry.processStarted();
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.resume();
    child.on("error", (error) => this.resetProcess(error));
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.resetProcess(
        new Error(`AT-SPI helper exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`),
      );
    });
  }

  private consumeStdout(chunk: Buffer): void {
    const framer = this.framer;
    if (!framer) return;
    try {
      for (const line of framer.push(chunk)) {
        const message = parseJson(line);
        if (!isRecord(message) || !("id" in message)) continue;
        const id = message.id;
        if (typeof id !== "number" && typeof id !== "string") continue;
        const error = isRecord(message.error) ? message.error : undefined;
        this.registry?.handleResponse({
          id,
          result: message.result,
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
    } catch (error) {
      if (error instanceof JsonRpcStdioTransportError) this.resetProcess(error);
    }
  }

  private resetProcess(error: Error): void {
    const child = this.process;
    this.process = null;
    this.framer?.close();
    this.writer?.close(error);
    this.registry?.processExited(error);
    this.framer = null;
    this.writer = null;
    this.registry = null;
    this.reconnectFailures = Math.min(this.reconnectFailures + 1, 5);
    if (child && !child.killed) child.kill("SIGTERM");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The window descriptor the helper matches against the live AT-SPI desktop. */
function helperWindow(window: ComputerWindow): Record<string, unknown> {
  return {
    id: window.id,
    title: window.title,
    appName: window.appName ?? null,
    pid: window.pid ?? null,
    bounds: window.bounds,
  };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isAtspiWindowTree(value: unknown): value is AtspiWindowTree {
  if (!isRecord(value)) return false;
  return (
    typeof value.windowId === "string" && isClientSize(value.clientSize) && isAtspiNode(value.root)
  );
}

function isClientSize(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

function isAtspiNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.role === "string" &&
    (value.label === null || typeof value.label === "string") &&
    (value.value === null || typeof value.value === "string") &&
    (value.description === null || typeof value.description === "string") &&
    isRect(value.frame) &&
    isNodePath(value.path) &&
    (value.editable === undefined || typeof value.editable === "boolean") &&
    Array.isArray(value.children) &&
    value.children.every(isAtspiNode)
  );
}

/** A helper build without semantic addressing simply omits the path. */
function isNodePath(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every((index) => typeof index === "number" && Number.isInteger(index) && index >= 0)
  );
}

function isRect(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width >= 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height >= 0
  );
}
