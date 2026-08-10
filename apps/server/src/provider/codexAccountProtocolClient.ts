import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";

import { buildCodexInitializeParams } from "../codexAppServerInitialize";
import {
  CodexAppServerTransportError,
  CodexJsonlFramer,
  CodexJsonlWriter,
} from "../codexAppServerTransport";
import {
  teardownChildProcessTree,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown";
import {
  buildCodexAccountProcessEnv,
  resolveCodexAccountHomePath,
} from "./codexAccountProcessEnv";
import type { CodexProviderLaunchContext } from "./codexProviderLaunchContext";
import { assertExistingManagedCodexAuthFilePrivate } from "./codexManagedProfileHome";
import {
  compareCodexCliVersions,
  parseCodexCliVersion,
} from "./codexCliVersion";

const ACCOUNT_REQUEST_TIMEOUT_MS = 20_000;
const ACCOUNT_USER_AGENT_MAX_LENGTH = 512;
export const MINIMUM_CODEX_ACCOUNT_CONTROL_VERSION = "0.144.0";

type NotificationListener = (notification: CodexAccountProtocolNotification) => void;

interface PendingRequest {
  readonly method: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface CodexAccountProtocolNotification {
  readonly method: string;
  readonly params: unknown;
}

export class CodexAccountProtocolRequestError extends Error {
  constructor(
    readonly method: string,
    readonly rpcCode: number | null,
  ) {
    super(`Codex app-server rejected ${method}.`);
    this.name = "CodexAccountProtocolRequestError";
  }
}

export class CodexAccountProtocolVersionError extends Error {
  constructor(readonly installedVersion: string | null) {
    super(
      installedVersion
        ? `Codex CLI v${installedVersion} does not support account control.`
        : "The Codex CLI version could not be determined for account control.",
    );
    this.name = "CodexAccountProtocolVersionError";
  }
}

export class CodexAccountProtocolOpenError extends Error {
  constructor(
    readonly unretiredClient: CodexAccountProtocolClient,
    cause: unknown,
  ) {
    super("Codex account process initialization failed and its process tree was not retired.", {
      cause,
    });
    this.name = "CodexAccountProtocolOpenError";
  }
}

export interface CodexAccountProtocolClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onNotification(listener: NotificationListener): () => void;
  onUnexpectedClose(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export type SpawnCodexAccountProcess = (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}) => ChildProcessWithoutNullStreams;

function spawnCodexAccountProcess(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): ChildProcessWithoutNullStreams {
  const prepared = prepareWindowsSafeProcess(input.binaryPath, ["app-server"], {
    cwd: input.cwd,
    env: input.env,
  });
  return spawn(prepared.command, prepared.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: prepared.shell,
    windowsHide: prepared.windowsHide,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
}

class LiveCodexAccountProtocolClient implements CodexAccountProtocolClient {
  private readonly framer = new CodexJsonlFramer();
  private readonly writer: CodexJsonlWriter;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly unexpectedCloseListeners = new Set<(error: Error) => void>();
  private nextRequestId = 1;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private terminalError: Error | undefined;
  private readonly spawnOutcome: Promise<"spawned" | "not-spawned">;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly teardownProcessTree: typeof teardownProviderProcessTree,
    private readonly expectedCodexHomePath: string,
  ) {
    this.writer = new CodexJsonlWriter(child.stdin);
    this.spawnOutcome = observeSpawnOutcome(child);
    this.attachListeners();
  }

  async initialize(): Promise<void> {
    const response = await this.request("initialize", buildCodexInitializeParams());
    await this.assertCompatibleInitialization(response);
    await this.writer.write({ method: "initialized" });
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs = ACCOUNT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("Codex account process is closing."));
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(new Error(`Timed out waiting for Codex account operation ${method}.`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(String(id), { method, timeout, resolve, reject });
      const message = params === undefined ? { method, id } : { method, id, params };
      void this.writer.write(message).catch((cause) => {
        this.fail(asError(cause));
      });
    });
  }

  private async assertCompatibleInitialization(response: unknown): Promise<void> {
    const record = asRecord(response);
    const codexHome = record?.codexHome;
    if (typeof codexHome !== "string") {
      throw new Error("Codex account process initialized with an unexpected home directory.");
    }
    const [actualHome, expectedHome] = await Promise.all([
      fs.realpath(codexHome),
      fs.realpath(this.expectedCodexHomePath),
    ]);
    if (actualHome !== expectedHome) {
      throw new Error("Codex account process initialized with an unexpected home directory.");
    }

    const userAgent = record?.userAgent;
    if (
      typeof userAgent !== "string" ||
      userAgent.length === 0 ||
      userAgent.length > ACCOUNT_USER_AGENT_MAX_LENGTH
    ) {
      throw new CodexAccountProtocolVersionError(null);
    }
    const version = parseCodexCliVersion(userAgent);
    if (
      version === null ||
      compareCodexCliVersions(version, MINIMUM_CODEX_ACCOUNT_CONTROL_VERSION) < 0
    ) {
      throw new CodexAccountProtocolVersionError(version);
    }
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onUnexpectedClose(listener: (error: Error) => void): () => void {
    this.unexpectedCloseListeners.add(listener);
    if (this.terminalError) {
      queueMicrotask(() => {
        if (this.unexpectedCloseListeners.has(listener) && this.terminalError) {
          listener(this.terminalError);
        }
      });
    }
    return () => this.unexpectedCloseListeners.delete(listener);
  }

  close(): Promise<void> {
    this.closing = true;
    const stopped = new Error("Codex account process stopped.");
    this.writer.close(stopped);
    this.rejectPending(stopped);
    this.detachStdout();
    return this.teardown();
  }

  private readonly onStdoutData = (chunk: Buffer): void => {
    if (this.closing) return;
    try {
      for (const line of this.framer.push(chunk)) this.handleLine(line);
    } catch (cause) {
      this.fail(asError(cause));
    }
  };

  private readonly onStdoutEnd = (): void => {
    if (this.closing) return;
    try {
      this.framer.finish();
      this.fail(
        new CodexAppServerTransportError({
          reason: "read-closed",
          maxBytes: this.framer.maxFrameBytes,
          observedBytes: 0,
        }),
      );
    } catch (cause) {
      this.fail(asError(cause));
    }
  };

  private readonly onStdioError = (error: Error): void => {
    if (this.closing) return;
    this.fail(asError(error));
  };

  private attachListeners(): void {
    this.child.stdout.on("data", this.onStdoutData);
    this.child.stdout.once("end", this.onStdoutEnd);
    // Keep permanent error listeners on all stdio streams. Removing them at
    // close would let a late stream error become an unhandled EventEmitter
    // error and terminate the Synara server.
    this.child.stdin.on("error", this.onStdioError);
    this.child.stdout.on("error", this.onStdioError);
    this.child.stderr.on("error", this.onStdioError);
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      if (this.closing) return;
      this.fail(
        new Error(
          `Codex account process exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });
    this.child.stderr.resume();
  }

  private detachStdout(): void {
    this.child.stdout.off("data", this.onStdoutData);
    this.child.stdout.off("end", this.onStdoutEnd);
    this.framer.reset();
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const envelope = asRecord(message);
    if (!envelope) return;
    if (isResponse(envelope)) {
      this.handleResponse(envelope);
      return;
    }
    if (isNotification(envelope)) {
      const notification = { method: envelope.method, params: envelope.params };
      for (const listener of this.notificationListeners) listener(notification);
      return;
    }
    if (isServerRequest(envelope)) {
      void this.writer.write({
        id: envelope.id,
        error: { code: -32601, message: "Unsupported account-control server request." },
      }).catch((cause) => this.fail(asError(cause)));
    }
  }

  private handleResponse(response: Record<string, unknown>): void {
    const pending = this.pending.get(String(response.id));
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(String(response.id));
    const rpcError = asRecord(response.error);
    if (rpcError) {
      pending.reject(
        new CodexAccountProtocolRequestError(
          pending.method,
          typeof rpcError.code === "number" ? rpcError.code : null,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private fail(error: Error): void {
    if (this.closing) return;
    this.closing = true;
    this.terminalError = error;
    this.writer.close(error);
    this.rejectPending(error);
    this.detachStdout();
    for (const listener of this.unexpectedCloseListeners) {
      try {
        listener(error);
      } catch {
        // Listener failures must not prevent process-tree teardown.
      }
    }
    void this.teardown().catch(() => undefined);
  }

  private teardown(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // A second teardown would recapture the numeric PID after the original
    // root may have exited. Keep the first ownership verdict sticky so PID
    // reuse can never redirect signals at an unrelated process.
    this.closePromise = this.spawnOutcome.then(async (outcome) => {
      if (outcome === "not-spawned") return;
      await teardownChildProcessTree(this.child, this.teardownProcessTree);
    });
    return this.closePromise;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function openCodexAccountProtocolClient(input: {
  readonly launchContext: CodexProviderLaunchContext;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnCodexAccountProcess;
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
}): Promise<CodexAccountProtocolClient> {
  if (input.launchContext.home.strategy === "managed-direct") {
    assertExistingManagedCodexAuthFilePrivate(input.launchContext.home.codexHomePath);
  }
  const processCwd =
    input.launchContext.home.strategy === "managed-direct"
      ? path.dirname(input.launchContext.home.codexHomePath)
      : input.cwd;
  const env = buildCodexAccountProcessEnv({
    launchContext: input.launchContext,
    cwd: processCwd,
    ...(input.env ? { env: input.env } : {}),
  });
  const child = (input.spawnProcess ?? spawnCodexAccountProcess)({
    binaryPath: input.launchContext.binaryPath,
    cwd: processCwd,
    env,
  });
  const client = new LiveCodexAccountProtocolClient(
    child,
    input.teardownProcessTree ?? teardownProviderProcessTree,
    resolveCodexAccountHomePath(
      input.launchContext,
      input.env ?? process.env,
      processCwd,
    ),
  );
  try {
    await client.initialize();
    return client;
  } catch (cause) {
    try {
      await client.close();
    } catch (closeCause) {
      throw new CodexAccountProtocolOpenError(client, closeCause);
    }
    throw cause;
  }
}

function observeSpawnOutcome(
  child: ChildProcessWithoutNullStreams,
): Promise<"spawned" | "not-spawned"> {
  if (child.pid !== undefined) return Promise.resolve("spawned");
  return new Promise((resolve) => {
    const onSpawn = () => settle("spawned");
    const onError = () => settle(child.pid === undefined ? "not-spawned" : "spawned");
    const onExit = () => settle(child.pid === undefined ? "not-spawned" : "spawned");
    const settle = (outcome: "spawned" | "not-spawned") => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      resolve(outcome);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Codex account process failed.");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isResponse(envelope: Record<string, unknown>): boolean {
  return (typeof envelope.id === "string" || typeof envelope.id === "number") &&
    ("result" in envelope || "error" in envelope);
}

function isNotification(
  envelope: Record<string, unknown>,
): envelope is Record<string, unknown> & { method: string } {
  return typeof envelope.method === "string" && !("id" in envelope);
}

function isServerRequest(
  envelope: Record<string, unknown>,
): envelope is Record<string, unknown> & { id: string | number; method: string } {
  return (
    typeof envelope.method === "string" &&
    (typeof envelope.id === "string" || typeof envelope.id === "number")
  );
}
