import type {
  BrowserConsoleLogEntry,
  BrowserLogEntry,
  BrowserLogsInput,
  BrowserLogsOutput,
  BrowserNetworkLogEntry,
  BrowserTabId,
} from "@synara/contracts";
import type { WebContents } from "electron";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { sendCdpCommand, throwIfAborted } from "./cdpRuntime";

const MAX_CAPTURED_ENTRIES = 1_000;
const MAX_TRACKED_REQUESTS = 2_048;
// Reserve room under the 512 KiB wire contract for the host to append bounded
// dialog events without turning a successful diagnostics read into an invalid
// response.
const MAX_LOG_OUTPUT_BYTES = 320 * 1_024;

interface TrackedRequest {
  readonly url: string;
  readonly method: string;
  readonly startedAt: number;
}

interface DiagnosticsState {
  readonly threadId: string;
  readonly tabId: string;
  readonly startedAt: BrowserLogsOutput["startedAt"];
  readonly entries: BrowserLogEntry[];
  readonly requests: Map<string, TrackedRequest>;
  droppedCount: number;
  initialized: Promise<void>;
  readonly onMessage: (_event: unknown, method: string, params: unknown) => void;
  readonly dispose: () => void;
}

const boundedUtf8 = (value: unknown, maximumBytes: number, fallback = ""): string => {
  const clean = String(value ?? fallback)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.byteLength <= maximumBytes) return clean;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
};

const boundedUrl = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "about:blank";
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "ws:", "wss:", "about:"].includes(url.protocol)) {
      return boundedUtf8(`${url.protocol}[redacted]`, 8_192, "about:blank") || "about:blank";
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    const queryKeys = [...new Set(url.searchParams.keys())];
    for (const key of queryKeys) {
      const count = url.searchParams.getAll(key).length;
      url.searchParams.delete(key);
      for (let index = 0; index < count; index += 1) {
        url.searchParams.append(key, "[REDACTED]");
      }
    }
    return boundedUtf8(url.href, 8_192, "about:blank") || "about:blank";
  } catch {
    return "invalid:[redacted]";
  }
};
const boundedMethod = (value: unknown): string => boundedUtf8(value, 32, "GET") || "GET";
const nowIso = (): BrowserLogsOutput["capturedAt"] =>
  new Date().toISOString() as unknown as BrowserLogsOutput["capturedAt"];

const consoleLevel = (value: unknown): BrowserConsoleLogEntry["level"] => {
  switch (String(value).toLowerCase()) {
    case "debug":
    case "verbose":
      return "debug";
    case "info":
      return "info";
    case "warning":
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "exception":
      return "exception";
    default:
      return "log";
  }
};

const remoteObjectText = (raw: unknown): string => {
  if (!raw || typeof raw !== "object") return boundedUtf8(raw, 1_024);
  const object = raw as {
    readonly value?: unknown;
    readonly description?: unknown;
    readonly unserializableValue?: unknown;
  };
  if (typeof object.value === "string") return boundedUtf8(object.value, 1_024);
  if (object.value !== undefined) {
    try {
      return boundedUtf8(JSON.stringify(object.value), 1_024);
    } catch {
      // Fall through to the CDP preview description.
    }
  }
  return boundedUtf8(object.description ?? object.unserializableValue, 1_024);
};

const optionalInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(10_000_000, value)
    : undefined;

const optionalStatus = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

/**
 * Bounded, per-WebContents diagnostics recorder. It deliberately stores no
 * headers, cookies, post data, response bodies, initiator stacks or raw CDP
 * payloads, so browser_logs cannot become an accidental secret-exfiltration
 * channel.
 */
export class BrowserDiagnosticsStore {
  private readonly stateByWebContents = new WeakMap<WebContents, DiagnosticsState>();

  async observe(runtime: BrowserAutomationVisibleRuntime, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const existing = this.stateByWebContents.get(runtime.webContents);
    if (existing) {
      if (existing.threadId === runtime.threadId && existing.tabId === runtime.tabId) {
        await existing.initialized;
        throwIfAborted(signal);
        return;
      }
      existing.dispose();
    }

    let state!: DiagnosticsState;
    const push = (entry: BrowserLogEntry): void => {
      state.entries.push(entry);
      if (state.entries.length > MAX_CAPTURED_ENTRIES) {
        const removed = state.entries.length - MAX_CAPTURED_ENTRIES;
        state.entries.splice(0, removed);
        state.droppedCount = Math.min(1_000_000_000, state.droppedCount + removed);
      }
    };
    const onMessage = (_event: unknown, method: string, raw: unknown): void => {
      if (!raw || typeof raw !== "object") return;
      const params = raw as Record<string, unknown>;
      if (method === "Runtime.consoleAPICalled") {
        const frames = (
          params.stackTrace as
            | { readonly callFrames?: readonly Record<string, unknown>[] }
            | undefined
        )?.callFrames;
        const frame = frames?.[0];
        const args = Array.isArray(params.args) ? params.args : [];
        const lineNumber = optionalInteger(frame?.lineNumber);
        const columnNumber = optionalInteger(frame?.columnNumber);
        push({
          kind: "console",
          timestamp: nowIso(),
          level: consoleLevel(params.type),
          text: boundedUtf8(args.map(remoteObjectText).filter(Boolean).join(" "), 4_096),
          ...(frame && typeof frame.url === "string" ? { url: boundedUrl(frame.url) } : {}),
          ...(lineNumber === undefined ? {} : { lineNumber }),
          ...(columnNumber === undefined ? {} : { columnNumber }),
        });
        return;
      }
      if (method === "Runtime.exceptionThrown") {
        const details = params.exceptionDetails as Record<string, unknown> | undefined;
        const exception = details?.exception as Record<string, unknown> | undefined;
        const lineNumber = optionalInteger(details?.lineNumber);
        const columnNumber = optionalInteger(details?.columnNumber);
        push({
          kind: "console",
          timestamp: nowIso(),
          level: "exception",
          text: boundedUtf8(exception?.description ?? details?.text ?? "Page exception", 4_096),
          ...(typeof details?.url === "string" ? { url: boundedUrl(details.url) } : {}),
          ...(lineNumber === undefined ? {} : { lineNumber }),
          ...(columnNumber === undefined ? {} : { columnNumber }),
        });
        return;
      }
      if (method === "Log.entryAdded") {
        const entry = params.entry as Record<string, unknown> | undefined;
        if (!entry) return;
        const lineNumber = optionalInteger(entry.lineNumber);
        push({
          kind: "console",
          timestamp: nowIso(),
          level: consoleLevel(entry.level),
          text: boundedUtf8(entry.text, 4_096),
          ...(typeof entry.url === "string" ? { url: boundedUrl(entry.url) } : {}),
          ...(lineNumber === undefined ? {} : { lineNumber }),
        });
        return;
      }
      if (method === "Network.requestWillBeSent") {
        const requestId = boundedUtf8(params.requestId, 256);
        const request = params.request as Record<string, unknown> | undefined;
        if (!requestId || !request) return;
        const tracked = {
          url: boundedUrl(request.url),
          method: boundedMethod(request.method),
          startedAt: performance.now(),
        };
        state.requests.delete(requestId);
        state.requests.set(requestId, tracked);
        while (state.requests.size > MAX_TRACKED_REQUESTS) {
          state.requests.delete(state.requests.keys().next().value as string);
        }
        push({
          kind: "network",
          timestamp: nowIso(),
          phase: "request",
          requestId,
          url: tracked.url,
          method: tracked.method,
        });
        return;
      }
      if (method === "Network.responseReceived") {
        const requestId = boundedUtf8(params.requestId, 256);
        const response = params.response as Record<string, unknown> | undefined;
        const tracked = state.requests.get(requestId);
        if (!requestId || !response) return;
        const duration = tracked ? Math.max(0, performance.now() - tracked.startedAt) : undefined;
        const status = optionalStatus(response.status);
        const entry: BrowserNetworkLogEntry = {
          kind: "network",
          timestamp: nowIso(),
          phase: "response",
          requestId,
          url: boundedUrl(response.url ?? tracked?.url),
          method: boundedMethod(tracked?.method),
          ...(status === undefined ? {} : { status }),
          ...(typeof response.mimeType === "string"
            ? { mimeType: boundedUtf8(response.mimeType, 256) }
            : {}),
          ...(duration === undefined ? {} : { durationMs: Math.min(3_600_000, duration) }),
        };
        push(entry);
        return;
      }
      if (method === "Network.loadingFailed") {
        const requestId = boundedUtf8(params.requestId, 256);
        const tracked = state.requests.get(requestId);
        if (!requestId) return;
        const duration = tracked ? Math.max(0, performance.now() - tracked.startedAt) : undefined;
        push({
          kind: "network",
          timestamp: nowIso(),
          phase: "failure",
          requestId,
          url: boundedUrl(tracked?.url),
          method: boundedMethod(tracked?.method),
          errorText: boundedUtf8(params.errorText, 1_024, "Network request failed"),
          ...(duration === undefined ? {} : { durationMs: Math.min(3_600_000, duration) }),
        });
        state.requests.delete(requestId);
        return;
      }
      if (method === "Network.loadingFinished") {
        const requestId = boundedUtf8(params.requestId, 256);
        if (requestId) state.requests.delete(requestId);
      }
    };
    const debuggerSession = runtime.webContents.debugger;
    const lifecycle = runtime.webContents as WebContents & {
      once?: (event: "destroyed", listener: () => void) => void;
      removeListener?: (event: "destroyed", listener: () => void) => void;
    };
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      if (!runtime.webContents.isDestroyed()) {
        debuggerSession.removeListener("message", onMessage);
        lifecycle.removeListener?.("destroyed", dispose);
      }
      disposed = true;
      this.stateByWebContents.delete(runtime.webContents);
      state.entries.length = 0;
      state.requests.clear();
    };
    state = {
      threadId: runtime.threadId,
      tabId: runtime.tabId,
      startedAt: nowIso(),
      entries: [],
      requests: new Map(),
      droppedCount: 0,
      onMessage,
      dispose,
      initialized: Promise.resolve(),
    };
    this.stateByWebContents.set(runtime.webContents, state);
    debuggerSession.on("message", onMessage);
    lifecycle.once?.("destroyed", dispose);
    state.initialized = (async () => {
      await sendCdpCommand(runtime, "Runtime.enable", {}, signal);
      await sendCdpCommand(runtime, "Log.enable", {}, signal);
      await sendCdpCommand(
        runtime,
        "Network.enable",
        {
          maxTotalBufferSize: 1_048_576,
          maxResourceBufferSize: 262_144,
          maxPostDataSize: 0,
        },
        signal,
      );
    })().catch((error) => {
      dispose();
      throw error;
    });
    await state.initialized;
    throwIfAborted(signal);
  }

  async read(
    runtime: BrowserAutomationVisibleRuntime,
    input: Pick<BrowserLogsInput, "includeConsole" | "includeNetwork" | "limit">,
    signal?: AbortSignal,
  ): Promise<BrowserLogsOutput> {
    await this.observe(runtime, signal);
    const state = this.stateByWebContents.get(runtime.webContents);
    if (!state) throw new Error("Browser diagnostics are unavailable.");
    throwIfAborted(signal);
    const matchingEntries = state.entries.filter(
      (entry) =>
        (entry.kind === "console" && input.includeConsole) ||
        (entry.kind === "network" && input.includeNetwork),
    );
    let entries = matchingEntries.slice(-(input.limit ?? 100));
    let truncated = state.droppedCount > 0 || matchingEntries.length > entries.length;
    const base = {
      tabId: runtime.tabId as BrowserTabId,
      startedAt: state.startedAt,
      capturedAt: nowIso(),
      droppedCount: state.droppedCount,
    };
    if (
      entries.length > 0 &&
      Buffer.byteLength(
        JSON.stringify({
          ...base,
          entries,
          truncated,
        }),
        "utf8",
      ) > MAX_LOG_OUTPUT_BYTES
    ) {
      truncated = true;
      let bytes = Buffer.byteLength(JSON.stringify({ ...base, entries: [], truncated }), "utf8");
      let firstEntry = entries.length;
      // JSON arrays add only commas between their independently serialized
      // entries. Count the newest suffix once instead of repeatedly encoding
      // the shrinking response on the Electron main thread. An oversized
      // response always dropped at least one entry, even when changing
      // truncated from false to true would save the one byte needed to fit.
      for (let index = entries.length - 1; index > 0; index -= 1) {
        const entryBytes = Buffer.byteLength(JSON.stringify(entries[index]), "utf8");
        const nextBytes = bytes + entryBytes + (firstEntry < entries.length ? 1 : 0);
        if (nextBytes > MAX_LOG_OUTPUT_BYTES) break;
        bytes = nextBytes;
        firstEntry = index;
      }
      entries = entries.slice(firstEntry);
    }
    return { ...base, entries, truncated };
  }

  dispose(runtime: BrowserAutomationVisibleRuntime): void {
    this.stateByWebContents.get(runtime.webContents)?.dispose();
  }
}
