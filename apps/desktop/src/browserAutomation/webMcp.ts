import { randomUUID } from "node:crypto";

import {
  type BrowserBoundedJson,
  type BrowserBoundedJsonObject,
  type BrowserTabId,
  type BrowserWebMcpCallInput,
  type BrowserWebMcpDiscoveryId,
  type BrowserWebMcpToolId,
  type BrowserWebMcpToolsInput,
  type BrowserWebMcpToolsOutput,
} from "@synara/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BrowserAutomationHostError, browserHostError } from "./hostErrors";
import { callFunctionOn, evaluateInContext, observePage, throwIfAborted } from "./cdpRuntime";

const WEB_MCP_BRIDGE_EXPRESSION = "globalThis.__synaraWebMcpBridgeV1";
const MAX_DISCOVERED_TOOLS = 128;
const WEB_MCP_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u;
// Discovery is model context, not a bulk transport. Keep enough room for
// several useful schemas without allowing one page to consume a large part of
// the turn context merely by advertising tools.
const MAX_DISCOVERY_CONTENT_BYTES = 20 * 1024;

interface BridgeTool {
  readonly index: number;
  readonly signature: string;
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: BrowserBoundedJsonObject;
  readonly origin: string;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly untrustedContentHint: boolean;
  };
}

interface WebMcpDiscoveryEntry {
  readonly toolId: BrowserWebMcpToolId;
  readonly index: number;
  readonly signature: string;
  readonly name: string;
}

export interface WebMcpDiscoveryHandle {
  readonly discoveryId: BrowserWebMcpDiscoveryId;
  readonly tabId: string;
  readonly contextObjectId: string;
  readonly humanControlEpoch: number;
  readonly entries: ReadonlyMap<BrowserWebMcpToolId, WebMcpDiscoveryEntry>;
  readonly onInvalidated: (listener: () => void) => () => void;
  readonly release: () => Promise<void>;
}

interface WebMcpDiscovery {
  readonly output: BrowserWebMcpToolsOutput;
  readonly handle: WebMcpDiscoveryHandle | null;
}

export type WebMcpInvocationResult =
  | { readonly status: "completed"; readonly result: BrowserBoundedJson }
  | {
      readonly status: "failed";
      readonly error: { readonly name: string; readonly message: string };
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBridgeTool(value: unknown): value is BridgeTool {
  const tool = asRecord(value);
  const annotations = asRecord(tool?.annotations);
  const inputSchema = asRecord(tool?.inputSchema);
  return (
    tool !== null &&
    Number.isSafeInteger(tool.index) &&
    (tool.index as number) >= 0 &&
    (tool.index as number) < MAX_DISCOVERED_TOOLS &&
    typeof tool.signature === "string" &&
    WEB_MCP_SIGNATURE_PATTERN.test(tool.signature) &&
    typeof tool.name === "string" &&
    typeof tool.description === "string" &&
    (tool.title === undefined || typeof tool.title === "string") &&
    inputSchema !== null &&
    typeof tool.origin === "string" &&
    annotations !== null &&
    typeof annotations.readOnlyHint === "boolean" &&
    annotations.untrustedContentHint === true
  );
}

const queryTokens = (value: string): readonly string[] =>
  [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (token) => token.length > 1,
  );

function toolRelevance(tool: BridgeTool, query: string): number {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return 0;
  const name = tool.name.toLocaleLowerCase();
  const title = tool.title?.toLocaleLowerCase() ?? "";
  const description = tool.description.toLocaleLowerCase();
  const schemaKeys = JSON.stringify(tool.inputSchema).toLocaleLowerCase();
  let score = name === normalizedQuery ? 100 : name.includes(normalizedQuery) ? 50 : 0;
  if (title.includes(normalizedQuery)) score += 30;
  if (description.includes(normalizedQuery)) score += 15;
  for (const token of queryTokens(normalizedQuery)) {
    if (name.includes(token)) score += 12;
    if (title.includes(token)) score += 8;
    if (description.includes(token)) score += 4;
    if (schemaKeys.includes(token)) score += 2;
  }
  return score;
}

function unavailableOutput(
  runtime: BrowserAutomationVisibleRuntime,
  url: string,
): BrowserWebMcpToolsOutput {
  return {
    tabId: runtime.tabId as BrowserTabId,
    url,
    contentTrust: "untrusted-web-page",
    available: false,
    implementation: "unavailable",
    discoveryId: null,
    tools: [],
    totalToolCount: 0,
    skippedToolCount: 0,
    truncated: false,
  };
}

function createRemoteObjectRelease(
  runtime: BrowserAutomationVisibleRuntime,
  objectId: string,
): Pick<WebMcpDiscoveryHandle, "onInvalidated" | "release"> {
  let released = false;
  let releasePromise: Promise<void> | null = null;
  const invalidationListeners = new Set<() => void>();
  const debuggerInstance = runtime.webContents.debugger;
  const onDebuggerMessage = (_event: unknown, method: string, rawParams: unknown) => {
    const params = asRecord(rawParams);
    const frame = asRecord(params?.frame);
    const mainFrameNavigated = method === "Page.frameNavigated" && frame && !frame.parentId;
    if (method === "Runtime.executionContextsCleared" || mainFrameNavigated) void release();
  };
  const onDebuggerDetach = () => void release();
  const onWebContentsDestroyed = () => void release();
  const detachLifecycleListeners = () => {
    debuggerInstance.removeListener("message", onDebuggerMessage);
    debuggerInstance.removeListener("detach", onDebuggerDetach);
    runtime.webContents.removeListener("destroyed", onWebContentsDestroyed);
  };
  const release = (): Promise<void> => {
    if (releasePromise) return releasePromise;
    if (released) return Promise.resolve();
    released = true;
    detachLifecycleListeners();
    for (const listener of invalidationListeners) listener();
    invalidationListeners.clear();
    releasePromise =
      runtime.webContents.isDestroyed() || !debuggerInstance.isAttached()
        ? Promise.resolve()
        : debuggerInstance.sendCommand("Runtime.releaseObject", { objectId }).then(
            () => undefined,
            () => undefined,
          );
    return releasePromise;
  };
  debuggerInstance.on("message", onDebuggerMessage);
  debuggerInstance.on("detach", onDebuggerDetach);
  runtime.webContents.once("destroyed", onWebContentsDestroyed);
  return {
    release,
    onInvalidated: (listener) => {
      if (released) {
        listener();
        return () => undefined;
      }
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
  };
}

export async function discoverWebMcpTools(
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserWebMcpToolsInput,
  humanControlEpoch: number,
  signal: AbortSignal,
): Promise<WebMcpDiscovery> {
  throwIfAborted(signal);
  const page = await observePage(runtime, signal);
  let contextObjectId: string | undefined;
  try {
    const bridge = await evaluateInContext(runtime, WEB_MCP_BRIDGE_EXPRESSION, {
      awaitPromise: false,
      returnByValue: false,
      effectMayHaveCommitted: false,
      signal,
    });
    contextObjectId = bridge.objectId;
  } catch (error) {
    if (error instanceof BrowserAutomationHostError) throw error;
  }
  if (!contextObjectId) {
    return { output: unavailableOutput(runtime, page.url), handle: null };
  }
  const lease = createRemoteObjectRelease(runtime, contextObjectId);

  let rawList: unknown;
  try {
    rawList = (
      await callFunctionOn<unknown>(
        runtime,
        contextObjectId,
        "async function() { return await this.list(); }",
        {
          effectMayHaveCommitted: false,
          returnByValue: true,
          signal,
        },
      )
    ).value;
  } catch (error) {
    await lease.release();
    if (error instanceof BrowserAutomationHostError) throw error;
    return { output: unavailableOutput(runtime, page.url), handle: null };
  }
  const list = asRecord(rawList);
  if (!list || list.available !== true || !Array.isArray(list.tools)) {
    await lease.release();
    return { output: unavailableOutput(runtime, page.url), handle: null };
  }
  const bridgeTools = list.tools.slice(0, MAX_DISCOVERED_TOOLS).filter(isBridgeTool);
  const skippedToolCount =
    (typeof list.skippedToolCount === "number" && Number.isSafeInteger(list.skippedToolCount)
      ? Math.max(0, list.skippedToolCount)
      : 0) +
    (list.tools.length - bridgeTools.length);
  const query = input.query ?? "";
  const ranked = bridgeTools
    .map((tool, order) => ({ tool, order, score: toolRelevance(tool, query) }))
    .sort((left, right) => right.score - left.score || left.order - right.order);
  const discoveryId = randomUUID() as BrowserWebMcpDiscoveryId;
  const entries = new Map<BrowserWebMcpToolId, WebMcpDiscoveryEntry>();
  const tools: BrowserWebMcpToolsOutput["tools"][number][] = [];
  let contentBytes = 0;
  for (const { tool } of ranked) {
    if (tools.length >= (input.limit ?? 8)) break;
    const exposedTool = {
      toolId: `w${tools.length + 1}` as BrowserWebMcpToolId,
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      origin: tool.origin,
      annotations: tool.annotations,
    };
    const toolBytes = Buffer.byteLength(JSON.stringify(exposedTool), "utf8");
    if (contentBytes + toolBytes > MAX_DISCOVERY_CONTENT_BYTES) continue;
    contentBytes += toolBytes;
    tools.push(exposedTool);
    const toolId = exposedTool.toolId;
    entries.set(toolId, {
      toolId,
      index: tool.index,
      signature: tool.signature,
      name: tool.name,
    });
  }
  const implementation = list.implementation === "native" ? "native" : "compatibility";
  return {
    output: {
      tabId: runtime.tabId as BrowserTabId,
      url: page.url,
      contentTrust: "untrusted-web-page",
      available: true,
      implementation,
      discoveryId,
      tools,
      totalToolCount: bridgeTools.length,
      skippedToolCount,
      truncated: tools.length < bridgeTools.length || skippedToolCount > 0,
    },
    handle: {
      discoveryId,
      tabId: runtime.tabId,
      contextObjectId,
      humanControlEpoch,
      entries,
      ...lease,
    },
  };
}

export async function invokeWebMcpTool(
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserWebMcpCallInput,
  handle: WebMcpDiscoveryHandle,
  signal: AbortSignal,
): Promise<WebMcpInvocationResult> {
  const entry = handle.entries.get(input.toolId);
  if (!entry || handle.discoveryId !== input.discoveryId || handle.tabId !== runtime.tabId) {
    browserHostError({ code: "BrowserWebMcpDiscoveryStale" });
  }
  const invocationId = randomUUID();
  const cancel = async () => {
    if (runtime.webContents.isDestroyed() || !runtime.webContents.debugger.isAttached()) return;
    const expression = `${WEB_MCP_BRIDGE_EXPRESSION}?.cancel(${JSON.stringify(invocationId)})`;
    await runtime.webContents.debugger
      .sendCommand("Runtime.evaluate", {
        expression,
        awaitPromise: false,
        returnByValue: true,
        userGesture: false,
      })
      .then(
        () => undefined,
        () => undefined,
      );
  };
  const value = (
    await callFunctionOn<unknown>(
      runtime,
      handle.contextObjectId,
      "async function(index, signature, inputJson, invocationId) { return await this.invoke(index, signature, inputJson, invocationId); }",
      {
        arguments: [
          entry.index,
          entry.signature,
          JSON.stringify(input.arguments ?? {}),
          invocationId,
        ],
        effectMayHaveCommitted: true,
        onAbort: cancel,
        returnByValue: true,
        signal,
      },
    )
  ).value;
  const result = asRecord(value);
  if (result?.status === "stale") {
    browserHostError({ code: "BrowserWebMcpDiscoveryStale" });
  }
  if (result?.status === "completed") {
    return { status: "completed", result: (result.result ?? null) as BrowserBoundedJson };
  }
  const error = asRecord(result?.error);
  if (
    result?.status === "failed" &&
    typeof error?.name === "string" &&
    typeof error.message === "string"
  ) {
    return { status: "failed", error: { name: error.name, message: error.message } };
  }
  browserHostError({
    code: "BrowserMalformedResponse",
    retryable: false,
    phase: "runtime",
    effectMayHaveCommitted: true,
    tabId: runtime.tabId as BrowserTabId,
  });
}
