import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const cdp = vi.hoisted(() => ({
  callFunctionOn: vi.fn(),
  evaluateInContext: vi.fn(),
  observePage: vi.fn(),
  throwIfAborted: vi.fn((signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason;
  }),
}));

vi.mock("./cdpRuntime", () => cdp);

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { discoverWebMcpTools, invokeWebMcpTool } from "./webMcp";

const TAB_ID = "11111111-1111-4111-8111-111111111111";
const debuggerEvents = new EventEmitter();
const webContentsEvents = new EventEmitter();
const runtime = {
  tabId: TAB_ID,
  webContents: Object.assign(webContentsEvents, {
    isDestroyed: () => false,
    debugger: Object.assign(debuggerEvents, {
      isAttached: () => true,
      sendCommand: vi.fn(() => Promise.resolve()),
    }),
  }),
} as unknown as BrowserAutomationVisibleRuntime;

const bridgeTool = (input: {
  readonly index: number;
  readonly name: string;
  readonly description: string;
}) => ({
  ...input,
  signature: "a".repeat(64),
  inputSchema: { type: "object", properties: {} },
  origin: "https://shop.example",
  annotations: { readOnlyHint: false, untrustedContentHint: true },
});

describe("WebMCP browser bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    debuggerEvents.removeAllListeners();
    webContentsEvents.removeAllListeners();
    cdp.observePage.mockResolvedValue({ url: "https://shop.example", title: "Shop" });
    cdp.evaluateInContext.mockResolvedValue({ objectId: "bridge-object" });
  });

  it("ranks a compact discovery by the current user goal", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: [
          bridgeTool({ index: 0, name: "search", description: "Search products." }),
          bridgeTool({
            index: 1,
            name: "checkout",
            description: "Complete checkout for the current cart.",
          }),
        ],
      },
    });

    const discovery = await discoverWebMcpTools(
      runtime,
      { query: "complete checkout", limit: 1 },
      7,
      new AbortController().signal,
    );

    expect(discovery.output).toMatchObject({
      available: true,
      contentTrust: "untrusted-web-page",
      totalToolCount: 2,
      truncated: true,
      tools: [{ toolId: "w1", name: "checkout" }],
    });
    expect(discovery.handle?.humanControlEpoch).toBe(7);
    expect(discovery.handle?.entries.get("w1" as never)?.index).toBe(1);
  });

  it("returns at most eight tools by default", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: Array.from({ length: 10 }, (_, index) =>
          bridgeTool({
            index,
            name: `tool_${index}`,
            description: `Page tool ${index}.`,
          }),
        ),
      },
    });

    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);

    expect(discovery.output.tools).toHaveLength(8);
    expect(discovery.output.truncated).toBe(true);
  });

  it("reserves model-context room for the discovery envelope", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: Array.from({ length: 2 }, (_, index) => ({
          ...bridgeTool({
            index,
            name: `large_tool_${index}`,
            description: `Large page tool ${index}.`,
          }),
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "s".repeat(12_000) },
            },
          },
        })),
      },
    });

    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);

    expect(discovery.output.tools).toHaveLength(1);
    expect(discovery.output.truncated).toBe(true);
  });

  it("invokes only the exact tool definition from the discovery", async () => {
    cdp.callFunctionOn
      .mockResolvedValueOnce({
        value: {
          available: true,
          implementation: "native",
          skippedToolCount: 0,
          tools: [bridgeTool({ index: 0, name: "checkout", description: "Complete checkout." })],
        },
      })
      .mockResolvedValueOnce({ value: { status: "completed", result: { orderId: "order-1" } } });
    const signal = new AbortController().signal;
    const discovery = await discoverWebMcpTools(runtime, { limit: 12 }, 1, signal);
    const handle = discovery.handle!;

    await expect(
      invokeWebMcpTool(
        runtime,
        {
          discoveryId: handle.discoveryId,
          toolId: "w1" as never,
          arguments: { acceptTerms: true },
        },
        handle,
        signal,
      ),
    ).resolves.toEqual({ status: "completed", result: { orderId: "order-1" } });
    expect(cdp.callFunctionOn).toHaveBeenLastCalledWith(
      runtime,
      "bridge-object",
      expect.stringContaining("this.invoke"),
      expect.objectContaining({
        arguments: [
          0,
          expect.any(String),
          JSON.stringify({ acceptTerms: true }),
          expect.any(String),
        ],
        effectMayHaveCommitted: true,
      }),
    );
  });

  it("rejects a page tool that changed after discovery", async () => {
    cdp.callFunctionOn
      .mockResolvedValueOnce({
        value: {
          available: true,
          implementation: "native",
          skippedToolCount: 0,
          tools: [bridgeTool({ index: 0, name: "checkout", description: "Checkout." })],
        },
      })
      .mockResolvedValueOnce({ value: { status: "stale" } });
    const signal = new AbortController().signal;
    const discovery = await discoverWebMcpTools(runtime, {}, 1, signal);
    const handle = discovery.handle!;

    await expect(
      invokeWebMcpTool(
        runtime,
        { discoveryId: handle.discoveryId, toolId: "w1" as never, arguments: {} },
        handle,
        signal,
      ),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserWebMcpDiscoveryStale" },
    });
  });

  it("releases the retained bridge object exactly once", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: [bridgeTool({ index: 0, name: "search", description: "Search." })],
      },
    });
    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);

    await discovery.handle!.release();
    await discovery.handle!.release();

    expect(runtime.webContents.debugger.sendCommand).toHaveBeenCalledTimes(1);
    expect(runtime.webContents.debugger.sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "bridge-object",
    });
  });

  it("invalidates and releases a discovery on spontaneous main-frame navigation", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: [bridgeTool({ index: 0, name: "search", description: "Search." })],
      },
    });
    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);
    const invalidated = vi.fn();
    discovery.handle!.onInvalidated(invalidated);

    debuggerEvents.emit("message", {}, "Page.frameNavigated", {
      frame: { id: "main-frame", url: "https://shop.example/next" },
    });
    await discovery.handle!.release();

    expect(invalidated).toHaveBeenCalledOnce();
    expect(runtime.webContents.debugger.sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "bridge-object",
    });
  });

  it("releases the bridge object when discovery is unavailable", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: { available: false, implementation: "unavailable", tools: [] },
    });

    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);

    expect(discovery.handle).toBeNull();
    expect(runtime.webContents.debugger.sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "bridge-object",
    });
  });
});
