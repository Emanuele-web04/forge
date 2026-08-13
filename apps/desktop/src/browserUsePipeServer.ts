// FILE: browserUsePipeServer.ts
// Purpose: Exposes the canonical high-level browser host over a private local RPC pipe.
// Layer: Desktop browser automation bridge

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import type { BrowserToolName, ThreadId } from "@synara/contracts";

import {
  DesktopBrowserAutomationHost,
  type BrowserAutomationToolRequest,
} from "./browserAutomation/desktopBrowserAutomationHost";
import { BrowserAutomationHostError } from "./browserAutomation/hostErrors";
import type { DesktopBrowserManager } from "./browserManager";

const FRAME_HEADER_BYTES = 4;
// 8 MiB PNG sidecars expand to about 10.7 MiB in base64; 12 MiB keeps the
// contract maximum plus bounded structured content inside one correlated frame.
const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
// The gateway accepts JSON-RPC batches of up to 50 messages and currently
// opens one short-lived pipe connection per browser call. Keep enough room for
// a full batch plus control traffic while retaining a finite local bound.
const MAX_CLIENTS = 64;
const MAX_IN_FLIGHT_REQUESTS = 16;
const MAX_QUEUED_OUTPUT_BYTES = 1024 * 1024;
const MAX_WORKSPACE_ROOT_BYTES = 4_096;
const PIPE_DIR = "synara-browser-host";
const PIPE_NAME_PREFIX = "synara-browser-host";

export const SYNARA_BROWSER_HOST_PIPE_ENV = "SYNARA_BROWSER_HOST_PIPE_PATH";
export const SYNARA_BROWSER_HOST_CAPABILITY_ENV = "SYNARA_BROWSER_HOST_CAPABILITY";
export const SYNARA_BROWSER_HOST_CAPABILITY_FD_ENV = "SYNARA_BROWSER_HOST_CAPABILITY_FD";
/** @deprecated Read/written only while old backend builds are still supported. */
export const SYNARA_BROWSER_USE_PIPE_ENV = "SYNARA_BROWSER_USE_PIPE_PATH";

type RpcId = string | number;
type WriteResult = "written" | "overflow" | "closed";

interface RpcRequest {
  readonly id?: RpcId;
  readonly method?: string;
  readonly params?: unknown;
}

interface PipeClient {
  readonly socket: Net.Socket;
  pending: Buffer;
  inFlightRequests: number;
  sessionId: string | null;
  threadId: ThreadId | null;
  outputBackpressured: boolean;
  readonly abortControllers: Map<RpcId, AbortController>;
}

export interface BrowserHostPipeServerOptions {
  readonly pipePath?: string;
  readonly capability?: string;
  readonly platform?: NodeJS.Platform;
  readonly requestOpenPanel?: (threadId: ThreadId) => void | Promise<void>;
  readonly automationHost?: Pick<DesktopBrowserAutomationHost, "executeTool">;
  readonly maxInFlightRequests?: number;
  readonly maxQueuedOutputBytes?: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asWorkspaceRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_ROOT_BYTES ||
    value.includes("\u0000") ||
    !Path.isAbsolute(value)
  ) {
    throw new BrowserAutomationHostError({ code: "BrowserInputUnsupported" });
  }
  return value;
}

function parseRpcRequest(raw: string): RpcRequest | null {
  try {
    return asObject(JSON.parse(raw)) as RpcRequest | null;
  } catch {
    return null;
  }
}

export function resolveDefaultBrowserHostPipePath(
  platform = process.platform,
  pid = process.pid,
): string {
  const suffix = `${pid}-${Crypto.randomUUID()}`;
  if (platform === "win32") {
    return `\\\\.\\pipe\\${PIPE_NAME_PREFIX}-${suffix}`;
  }
  // Darwin limits sockaddr_un paths to roughly 104 bytes, while OS.tmpdir()
  // normally expands to a long /var/folders/... path. /tmp keeps the address
  // bounded; the per-user directory is still created and verified as 0700.
  const uid = process.getuid?.();
  const privateDirectory = uid === undefined ? PIPE_DIR : `${PIPE_DIR}-${uid}`;
  return Path.join("/tmp", privateDirectory, `${suffix}.sock`);
}

export function resolveConfiguredBrowserHostPipePath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  const configured =
    env[SYNARA_BROWSER_HOST_PIPE_ENV]?.trim() || env[SYNARA_BROWSER_USE_PIPE_ENV]?.trim();
  return configured || resolveDefaultBrowserHostPipePath(platform);
}

/** @deprecated Compatibility export for callers using the former IAB name. */
export const resolveDefaultBrowserUsePipePath = resolveDefaultBrowserHostPipePath;
/** @deprecated Compatibility export for callers using the former IAB name. */
export const resolveConfiguredBrowserUsePipePath = resolveConfiguredBrowserHostPipePath;

export const SYNARA_BROWSER_HOST_PIPE_PATH = resolveConfiguredBrowserHostPipePath();
/** @deprecated Compatibility alias for old packaged backend builds. */
export const SYNARA_BROWSER_USE_PIPE_PATH = SYNARA_BROWSER_HOST_PIPE_PATH;

export function resolveBrowserHostPipeBackendEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  activePipePath: string | null | undefined,
  capabilityFd?: number | null,
): NodeJS.ProcessEnv {
  const backendEnv = { ...inheritedEnv };
  delete backendEnv[SYNARA_BROWSER_HOST_PIPE_ENV];
  delete backendEnv[SYNARA_BROWSER_USE_PIPE_ENV];
  delete backendEnv[SYNARA_BROWSER_HOST_CAPABILITY_ENV];
  delete backendEnv[SYNARA_BROWSER_HOST_CAPABILITY_FD_ENV];
  const pipePath = activePipePath?.trim();
  if (pipePath && Number.isInteger(capabilityFd) && (capabilityFd ?? 0) >= 3) {
    backendEnv[SYNARA_BROWSER_HOST_PIPE_ENV] = pipePath;
    backendEnv[SYNARA_BROWSER_USE_PIPE_ENV] = pipePath;
    backendEnv[SYNARA_BROWSER_HOST_CAPABILITY_FD_ENV] = String(capabilityFd);
  }
  return backendEnv;
}

/** @deprecated Compatibility export for the former function name. */
export const resolveBrowserUsePipeBackendEnv = resolveBrowserHostPipeBackendEnv;

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  if (OS.endianness() === "LE") {
    header.writeUInt32LE(payload.length, 0);
  } else {
    header.writeUInt32BE(payload.length, 0);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(
  buffer: Buffer,
): { readonly messages: string[]; readonly remaining: Buffer } | null {
  let offset = 0;
  const messages: string[] = [];
  while (buffer.length - offset >= FRAME_HEADER_BYTES) {
    const length =
      OS.endianness() === "LE" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (length > MAX_MESSAGE_BYTES) return null;
    const frameLength = FRAME_HEADER_BYTES + length;
    if (buffer.length - offset < frameLength) break;
    messages.push(
      buffer.subarray(offset + FRAME_HEADER_BYTES, offset + frameLength).toString("utf8"),
    );
    offset += frameLength;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

function ensureUnixPipeParent(pipePath: string): void {
  const parent = Path.dirname(pipePath);
  try {
    FS.mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = FS.lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Browser host pipe parent is not a private directory: ${parent}`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`Browser host pipe parent is not owned by this user: ${parent}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Browser host pipe parent permissions are not private: ${parent}`);
  }
}

function cleanupUnixPipe(pipePath: string): void {
  try {
    const stat = FS.lstatSync(pipePath);
    if (stat.isSymbolicLink() || (!stat.isSocket() && !stat.isFile())) {
      throw new Error(`Refusing to replace unsafe browser host pipe path: ${pipePath}`);
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error(`Refusing to replace browser host pipe not owned by this user: ${pipePath}`);
    }
    FS.unlinkSync(pipePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class BrowserHostPipeServer {
  private readonly sockets = new Set<Net.Socket>();
  private readonly clients = new Map<Net.Socket, PipeClient>();
  private readonly server: Net.Server;
  private readonly pipePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly automationHost: Pick<DesktopBrowserAutomationHost, "executeTool">;
  private readonly maxInFlightRequests: number;
  private readonly maxQueuedOutputBytes: number;
  private readonly capability: string;
  private started = false;

  constructor(
    browserManager: DesktopBrowserManager,
    options: BrowserHostPipeServerOptions | string = SYNARA_BROWSER_HOST_PIPE_PATH,
  ) {
    const normalized = typeof options === "string" ? { pipePath: options } : options;
    this.platform = normalized.platform ?? process.platform;
    this.pipePath = normalized.pipePath ?? SYNARA_BROWSER_HOST_PIPE_PATH;
    const capability = normalized.capability?.trim();
    if (!capability || Buffer.byteLength(capability, "utf8") < 32) {
      throw new Error("Browser host requires a private backend capability.");
    }
    this.capability = capability;
    this.maxInFlightRequests = normalized.maxInFlightRequests ?? MAX_IN_FLIGHT_REQUESTS;
    this.maxQueuedOutputBytes = normalized.maxQueuedOutputBytes ?? MAX_QUEUED_OUTPUT_BYTES;
    const hostOptions = normalized.requestOpenPanel
      ? { requestOpenPanel: normalized.requestOpenPanel }
      : {};
    this.automationHost =
      normalized.automationHost ?? new DesktopBrowserAutomationHost(browserManager, hostOptions);
    this.server = Net.createServer((socket) => this.handleConnection(socket));
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.platform !== "win32") {
      ensureUnixPipeParent(this.pipePath);
      cleanupUnixPipe(this.pipePath);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ path: this.pipePath, readableAll: false, writableAll: false }, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    if (this.platform !== "win32") FS.chmodSync(this.pipePath, 0o600);
    this.started = true;
  }

  async dispose(): Promise<void> {
    const wasStarted = this.started;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    for (const client of this.clients.values()) {
      for (const controller of client.abortControllers.values()) {
        controller.abort();
      }
      client.abortControllers.clear();
    }
    this.sockets.clear();
    this.clients.clear();
    if (this.started) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.started = false;
    }
    if (wasStarted && this.platform !== "win32") cleanupUnixPipe(this.pipePath);
  }

  private handleConnection(socket: Net.Socket): void {
    if (this.sockets.size >= MAX_CLIENTS) {
      socket.destroy();
      return;
    }
    const client: PipeClient = {
      socket,
      pending: Buffer.alloc(0),
      inFlightRequests: 0,
      sessionId: null,
      threadId: null,
      outputBackpressured: false,
      abortControllers: new Map(),
    };
    this.sockets.add(socket);
    this.clients.set(socket, client);
    socket.on("data", (chunk) => this.handleData(client, chunk));
    const release = () => {
      for (const controller of client.abortControllers.values()) controller.abort();
      client.abortControllers.clear();
      this.sockets.delete(socket);
      this.clients.delete(socket);
    };
    socket.on("close", release);
    socket.on("error", release);
  }

  private handleData(client: PipeClient, chunk: Buffer): void {
    const decoded = decodeFrames(Buffer.concat([client.pending, chunk]));
    if (!decoded) {
      client.socket.destroy();
      return;
    }
    client.pending = decoded.remaining;
    for (const raw of decoded.messages) {
      if (client.inFlightRequests >= this.maxInFlightRequests) {
        const id = parseRpcRequest(raw)?.id;
        if (id !== undefined) {
          this.write(client, {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32_001,
              message: "Too many in-flight browser host requests",
            },
          });
        }
        continue;
      }
      client.inFlightRequests += 1;
      void this.handleMessage(client, raw).finally(() => {
        client.inFlightRequests -= 1;
      });
    }
  }

  private async handleMessage(client: PipeClient, raw: string): Promise<void> {
    const request = parseRpcRequest(raw);
    if (!request || request.id === undefined || typeof request.method !== "string") return;
    if (client.abortControllers.has(request.id)) {
      this.write(client, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32_001,
          message: "Duplicate in-flight browser host request id",
        },
      });
      return;
    }
    const controller = new AbortController();
    client.abortControllers.set(request.id, controller);
    try {
      const result = await this.handleRequest(
        client,
        request.method,
        request.params,
        controller.signal,
      );
      this.write(client, { jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.write(client, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: error instanceof BrowserAutomationHostError ? -32_010 : -32_000,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof BrowserAutomationHostError ? { data: error.envelope } : {}),
        },
      });
    } finally {
      client.abortControllers.delete(request.id);
    }
  }

  private handleRequest(
    client: PipeClient,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> | unknown {
    switch (method) {
      case "ping":
        return "pong";
      case "getInfo":
        return this.getInfo(client, params);
      case "executeTool":
        return this.executeTool(client, params, signal);
      default:
        throw new Error(`No handler registered for method: ${method}`);
    }
  }

  private getInfo(client: PipeClient, params: unknown): unknown {
    const request = asObject(params);
    const sessionId = asString(request?.session_id);
    if (!sessionId) throw new Error("getInfo requires session_id");
    const suppliedCapability = asString(request?.capability);
    const expectedBytes = Buffer.from(this.capability, "utf8");
    const suppliedBytes = Buffer.from(suppliedCapability ?? "", "utf8");
    if (
      suppliedBytes.byteLength !== expectedBytes.byteLength ||
      !Crypto.timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      throw new BrowserAutomationHostError({
        code: "BrowserAuthorizationDenied",
        retryable: false,
        phase: "auth",
        effectMayHaveCommitted: false,
      });
    }
    if (client.sessionId && client.sessionId !== sessionId) {
      throw new Error("Browser session does not belong to this pipe connection");
    }
    client.sessionId = sessionId;
    return {
      name: "Synara Browser Host",
      version: "1.0.0",
      type: "synara-browser-host",
      metadata: {
        sessionId,
        protocolVersion: 1,
        physicalScope: "visible-shared-electron-webview",
        methods: ["executeTool"],
      },
    };
  }

  private executeTool(client: PipeClient, params: unknown, signal: AbortSignal): Promise<unknown> {
    const request = asObject(params);
    const sessionId = asString(request?.session_id);
    const provider = asString(request?.provider);
    const threadId = asString(request?.thread_id);
    const name = asString(request?.name);
    const workspaceRoot = asWorkspaceRoot(request?.workspace_root);
    if (!sessionId || sessionId !== client.sessionId || !provider || !threadId || !name) {
      throw new BrowserAutomationHostError({ code: "BrowserInputUnsupported" });
    }
    if (client.threadId && client.threadId !== threadId) {
      throw new BrowserAutomationHostError({
        code: "BrowserTabScopeViolation",
        retryable: false,
        phase: "routing",
        effectMayHaveCommitted: false,
      });
    }
    client.threadId = threadId as ThreadId;
    return this.automationHost.executeTool({
      sessionId,
      provider,
      threadId: threadId as ThreadId,
      name: name as BrowserToolName,
      arguments: request?.arguments ?? {},
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      signal,
    } satisfies BrowserAutomationToolRequest);
  }

  private write(client: PipeClient, message: unknown): WriteResult {
    const { socket } = client;
    if (socket.destroyed || socket.writableEnded) return "closed";
    const frame = encodeFrame(message);
    if (frame.byteLength > MAX_MESSAGE_BYTES) {
      socket.destroy();
      return "overflow";
    }
    const isResponse = asObject(message)?.id !== undefined;
    if (!isResponse && socket.writableLength + frame.length > this.maxQueuedOutputBytes) {
      return "overflow";
    }
    const accepted = socket.write(frame);
    if (!accepted && !client.outputBackpressured) {
      client.outputBackpressured = true;
      socket.pause();
      socket.once("drain", () => {
        client.outputBackpressured = false;
        if (!socket.destroyed) socket.resume();
      });
    }
    return "written";
  }
}

/** @deprecated Compatibility alias for callers using the former browser-use name. */
export { BrowserHostPipeServer as BrowserUsePipeServer };
