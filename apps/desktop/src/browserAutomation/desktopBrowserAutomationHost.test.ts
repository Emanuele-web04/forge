import { ThreadId, type BrowserElementRef, type BrowserSnapshotId } from "@synara/contracts";
import type { WebContents } from "electron";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime, DesktopBrowserManager } from "../browserManager";
import { DesktopBrowserAutomationHost } from "./desktopBrowserAutomationHost";
import { BrowserAutomationHostError } from "./hostErrors";
import { resolveBrowserTarget } from "./targets";
import { configureWorkspaceUploadForTests } from "./workspaceUpload";

vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: () => null },
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-automation-1");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-automation-2");
const TAB_ID = "b33b993d-6ac0-4a39-978a-824c12d47e8b";
const OPENED_TAB_ID = "018f4f7a-4b2a-7c10-8d6e-4c1ac7b92f31";
const SNAPSHOT_ID = "948eed8d-dd27-41a7-842b-32ed221f434e" as BrowserSnapshotId;
const ELEMENT_REF = "e1" as BrowserElementRef;

type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createWebContents = () => {
  let url = "https://example.test/";
  const history = ["https://example.test/", "https://example.test/next"];
  let historyIndex = 0;
  const debuggerEvents = new EventEmitter();
  const webContentsEvents = new EventEmitter();
  const emitNavigation = (nextUrl: string) => {
    const loaderId = `loader-${crypto.randomUUID()}`;
    queueMicrotask(() => {
      url = nextUrl;
      debuggerEvents.emit("message", {}, "Network.requestWillBeSent", {
        requestId: loaderId,
        frameId: "main-frame",
        loaderId,
        type: "Document",
        request: { url: nextUrl },
      });
      debuggerEvents.emit("message", {}, "Page.frameNavigated", {
        frame: { id: "main-frame", loaderId, url: nextUrl },
      });
      debuggerEvents.emit("message", {}, "Page.lifecycleEvent", {
        frameId: "main-frame",
        loaderId,
        name: "DOMContentLoaded",
      });
      debuggerEvents.emit("message", {}, "Page.lifecycleEvent", {
        frameId: "main-frame",
        loaderId,
        name: "load",
      });
      debuggerEvents.emit("message", {}, "Network.loadingFinished", { requestId: loaderId });
    });
    return { frameId: "main-frame", loaderId };
  };
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseMoved" &&
      params.buttons === 1
    ) {
      queueMicrotask(() =>
        debuggerEvents.emit("message", {}, "Input.dragIntercepted", {
          data: { items: [], dragOperationsMask: 1 },
        }),
      );
      return {};
    }
    if (method === "Page.navigate") {
      const nextUrl = String(params?.url ?? url);
      const existingIndex = history.indexOf(nextUrl);
      if (existingIndex >= 0) historyIndex = existingIndex;
      else {
        history.splice(historyIndex + 1, history.length, nextUrl);
        historyIndex = history.length - 1;
      }
      return emitNavigation(nextUrl);
    }
    if (method === "Page.getNavigationHistory") {
      return {
        currentIndex: historyIndex,
        entries: history.map((entryUrl, index) => ({ id: index + 1, url: entryUrl })),
      };
    }
    if (method === "Page.navigateToHistoryEntry") {
      historyIndex = Number(params?.entryId) - 1;
      return emitNavigation(history[historyIndex] ?? url);
    }
    if (method === "Page.reload") {
      emitNavigation(url);
      return {};
    }
    if (method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } };
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (expression === "globalThis.__synaraWebMcpBridgeV1") {
        return { result: { objectId: "webmcp-bridge", type: "object" } };
      }
      if (expression.includes("performance.getEntriesByType")) return { result: { value: 0 } };
      if (
        expression.includes('const key = "__synaraBrowserAutomationV1"') &&
        expression.includes("elements = []")
      ) {
        return {
          result: {
            value: {
              generation: 1,
              elements: [
                {
                  ref: "e1",
                  role: "button",
                  name: "Save",
                  bounds: { x: 10, y: 20, width: 100, height: 40 },
                  states: [],
                },
              ],
              visibleText: "Ready",
              semanticTruncated: false,
              visibleTextTruncated: false,
            },
          },
        };
      }
      if (
        expression.includes("state.currentTarget =") ||
        expression.includes("const matches = []")
      ) {
        return { result: { value: { count: 1, generation: 1 } } };
      }
      if (expression.includes("globalThis.__synaraBrowserAutomationV1.currentTarget")) {
        return { result: { objectId: "target-1", type: "object", subtype: "node" } };
      }
      if (expression.includes("document.activeElement || document.body")) {
        return { result: { objectId: "active-element", type: "object", subtype: "node" } };
      }
      if (expression.includes("document.body?.innerText")) return { result: { value: true } };
      if (expression.trim() === "({answer: 42})") return { result: { value: { answer: 42 } } };
      if (expression.includes("elementFromPoint")) {
        return { result: { objectId: "point-target", type: "object", subtype: "node" } };
      }
      if (expression.includes("document.documentElement")) {
        return { result: { objectId: "document-element", type: "object", subtype: "node" } };
      }
      return {
        result: {
          value: {
            url,
            title: "Example",
            readyState: "complete",
            deviceScaleFactor: 1,
          },
        },
      };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame", url } } };
    }
    if (method === "Page.createIsolatedWorld") return { executionContextId: 12 };
    if (method === "Runtime.callFunctionOn") {
      const declaration = String(params?.functionDeclaration ?? "");
      if (declaration.includes("return await this.list()")) {
        return {
          result: {
            value: {
              available: true,
              implementation: "compatibility",
              skippedToolCount: 0,
              tools: [
                {
                  index: 0,
                  signature: "a".repeat(64),
                  name: "search",
                  description: "Search this page.",
                  inputSchema: { type: "object", properties: {} },
                  origin: "https://example.test",
                  annotations: { readOnlyHint: true, untrustedContentHint: true },
                },
              ],
            },
          },
        };
      }
      if (declaration.includes("return await this.invoke")) {
        return { result: { value: { status: "completed", result: { ok: true } } } };
      }
      if (declaration.includes("const timeoutMs =") && declaration.includes("receivesEvents")) {
        const actionOptions = (
          params?.arguments as
            | Array<{
                value?: { point?: { x: number; y: number } };
              }>
            | undefined
        )?.[0]?.value;
        const point = actionOptions?.point ?? { x: 60, y: 40 };
        return {
          result: {
            value: {
              ok: true,
              target: {
                point,
                rect: { x: 10, y: 20, width: 100, height: 40 },
              },
            },
          },
        };
      }
      if (declaration.includes("document.activeElement !== this")) {
        return { result: { value: true } };
      }
      if (declaration.includes("const raw = this.isContentEditable")) {
        return { result: { value: { kind: "text", length: 5, value: "hello" } } };
      }
      if (declaration.includes("this instanceof HTMLSelectElement")) {
        return { result: { value: { ok: true, selectedValues: ["primary"] } } };
      }
      if (declaration.includes("this instanceof HTMLInputElement")) {
        return { result: { value: { ok: true, enabled: true, multiple: false } } };
      }
      if (declaration.includes("const scrollable =")) {
        const waitForSettle =
          (params?.arguments as Array<{ value?: boolean }> | undefined)?.[0]?.value === true;
        return {
          result: {
            value: {
              before: { x: 0, y: waitForSettle ? 100 : 0 },
              maxX: 0,
              maxY: 1_000,
              width: 1_024,
              height: 768,
            },
          },
        };
      }
      if (declaration.includes("getBoundingClientRect")) {
        return {
          result: {
            value: {
              attached: true,
              visible: true,
              enabled: true,
              editable: true,
              role: "button",
              name: "Save",
              point: { x: 60, y: 40 },
            },
          },
        };
      }
      return { result: { type: "undefined" } };
    }
    return {};
  });
  return {
    once: webContentsEvents.once.bind(webContentsEvents),
    removeListener: webContentsEvents.removeListener.bind(webContentsEvents),
    isDestroyed: () => false,
    id: 101,
    focus: vi.fn(),
    getURL: () => url,
    loadURL: vi.fn(async (nextUrl: string) => {
      url = nextUrl;
    }),
    insertText: vi.fn(async () => undefined),
    reload: vi.fn(() => {
      emitNavigation(url);
    }),
    reloadIgnoringCache: vi.fn(() => {
      emitNavigation(url);
    }),
    stop: vi.fn(),
    capturePage: vi.fn(async () => {
      const png = Buffer.alloc(24);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
      png.write("IHDR", 12, "ascii");
      png.writeUInt32BE(1_024, 16);
      png.writeUInt32BE(768, 20);
      const image = {
        toPNG: () => png,
        getSize: () => ({ width: 1_024, height: 768 }),
        resize: vi.fn(() => image),
      };
      return image;
    }),
    sendInputEvent: vi.fn(),
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand,
      on: debuggerEvents.on.bind(debuggerEvents),
      off: debuggerEvents.off.bind(debuggerEvents),
      removeListener: debuggerEvents.removeListener.bind(debuggerEvents),
    },
    emitDebuggerMessage: (method: string, params: Record<string, unknown>) => {
      debuggerEvents.emit("message", {}, method, params);
    },
  } as unknown as WebContents & {
    loadURL: ReturnType<typeof vi.fn>;
    emitDebuggerMessage(method: string, params: Record<string, unknown>): void;
  };
};

const createManager = () => {
  const webContents = createWebContents();
  const getVisibleAutomationRuntime = vi.fn(
    (_input: { threadId: ThreadId; tabId: string }) =>
      ({
        threadId: THREAD_ID,
        tabId: TAB_ID,
        webContents,
      }) satisfies BrowserAutomationVisibleRuntime,
  );
  const state = {
    threadId: THREAD_ID,
    version: 1,
    open: true,
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        url: "https://example.test/",
        title: "Example",
        status: "live" as const,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        lastCommittedUrl: "https://example.test/" as string | null,
        lastError: null,
      },
    ],
    lastError: null,
  };
  const manager = {
    isAnnotationInteractive: vi.fn(() => false),
    getState: vi.fn(() => state),
    getAutomationHumanControlEpoch: vi.fn(() => 0),
    subscribeAutomationHumanControl: vi.fn(
      (_threadId: ThreadId, _listener: () => void) => () => undefined,
    ),
    trackAutomationWindowOpen: vi.fn(
      (_input: { threadId: ThreadId; tabId: string }, _listener: (event: unknown) => void) => () =>
        undefined,
    ),
    trackAutomationDownload: vi.fn(
      (_input: { threadId: ThreadId; tabId: string }, _listener: (event: unknown) => void) => () =>
        undefined,
    ),
    selectAutomationTab: vi.fn(() => state),
    prepareAutomationTab: vi.fn(() => state),
    prepareAutomationNavigation: vi.fn(() => state),
    resolveAnnotationNavigationTarget: vi.fn(({ annotationId }: { annotationId: string }) =>
      annotationId === "annotation-page"
        ? {
            tabId: TAB_ID,
            url: "https://example.test/private?token=local-only",
          }
        : null,
    ),
    getVisibleAutomationRuntime,
    getAutomationRuntime: vi.fn((input: { threadId: ThreadId; tabId: string }) =>
      Promise.resolve(getVisibleAutomationRuntime(input)),
    ),
    closeAutomationTab: vi.fn(() => ({ ...state, activeTabId: null, tabs: [] })),
  };
  return { manager: manager as unknown as DesktopBrowserManager, raw: manager, webContents };
};

describe("DesktopBrowserAutomationHost", () => {
  it("releases another session's WebMCP discovery before navigating the shared tab", async () => {
    const { manager, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);

    await host.executeTool({
      sessionId: "session-webmcp-owner",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_webmcp_tools",
      arguments: {},
    });
    await host.executeTool({
      sessionId: "session-shared-navigation",
      provider: "claude",
      threadId: THREAD_ID,
      name: "browser_navigate",
      arguments: { url: "https://example.test/next" },
    });

    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "webmcp-bridge",
    });
  });

  it("invalidates WebMCP discovery when the page navigates outside a browser tool", async () => {
    const { manager, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);
    const discovery = (await host.executeTool({
      sessionId: "session-webmcp-spontaneous-navigation",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_webmcp_tools",
      arguments: {},
    })) as {
      readonly discoveryId: string;
      readonly tools: readonly [{ readonly toolId: string }];
    };

    webContents.emitDebuggerMessage("Page.frameNavigated", {
      frame: { id: "main-frame", url: "https://example.test/delayed" },
    });
    await Promise.resolve();

    await expect(
      host.executeTool({
        sessionId: "session-webmcp-spontaneous-navigation",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_webmcp_call",
        arguments: {
          discoveryId: discovery.discoveryId,
          toolId: discovery.tools[0].toolId,
          arguments: {},
        },
      }),
    ).rejects.toMatchObject({ browserError: { code: "BrowserWebMcpDiscoveryStale" } });
  });

  it("preserves the current WebMCP discovery after mismatched caller tokens", async () => {
    const { manager, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);
    const discovery = (await host.executeTool({
      sessionId: "session-webmcp-mismatch",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_webmcp_tools",
      arguments: {},
    })) as {
      readonly discoveryId: string;
      readonly tools: readonly [{ readonly toolId: string }];
    };
    const call = (discoveryId: string, toolId: string) =>
      host.executeTool({
        sessionId: "session-webmcp-mismatch",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_webmcp_call",
        arguments: { discoveryId, toolId, arguments: {} },
      });

    await expect(call(crypto.randomUUID(), discovery.tools[0].toolId)).rejects.toMatchObject({
      browserError: { code: "BrowserWebMcpDiscoveryStale" },
    });
    await expect(call(discovery.discoveryId, "w2")).rejects.toMatchObject({
      browserError: { code: "BrowserWebMcpDiscoveryStale" },
    });
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "webmcp-bridge",
    });
    await expect(call(discovery.discoveryId, discovery.tools[0].toolId)).resolves.toMatchObject({
      status: "completed",
      result: { ok: true },
    });
  });

  it("preserves an ambiguous WebMCP invocation error after navigation starts", async () => {
    const { manager, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);
    const discovery = (await host.executeTool({
      sessionId: "session-webmcp-ambiguous",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_webmcp_tools",
      arguments: {},
    })) as {
      readonly discoveryId: string;
      readonly tools: readonly [{ readonly toolId: string }];
    };
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const declaration = String(params?.functionDeclaration ?? "");
      if (method === "Runtime.callFunctionOn" && declaration.includes("return await this.invoke")) {
        webContents.reload();
        await Promise.resolve();
        throw new Error("execution context was destroyed");
      }
      return original(method, params);
    });

    await expect(
      host.executeTool({
        sessionId: "session-webmcp-ambiguous",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_webmcp_call",
        arguments: {
          discoveryId: discovery.discoveryId,
          toolId: discovery.tools[0].toolId,
          arguments: {},
        },
      }),
    ).rejects.toMatchObject({
      browserError: {
        code: "BrowserAmbiguousResult",
        retryable: false,
        effectMayHaveCommitted: true,
      },
    });
  });

  it("waits for draining CDP work before releasing WebMCP discoveries on disposal", async () => {
    const { manager, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);
    await host.executeTool({
      sessionId: "session-webmcp-dispose",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_webmcp_tools",
      arguments: {},
    });

    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    const evaluation = deferred<unknown>();
    sendCommand.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate" && params?.expression === "({answer: 42})") {
        return evaluation.promise;
      }
      return original(method, params);
    });
    const controller = new AbortController();
    const operation = host.executeTool({
      sessionId: "session-webmcp-dispose",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_evaluate",
      arguments: { expression: "({answer: 42})" },
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith(
        "Runtime.evaluate",
        expect.objectContaining({ expression: "({answer: 42})" }),
      ),
    );
    controller.abort();
    await expect(operation).rejects.toMatchObject({
      browserError: { code: "BrowserCancelled" },
    });

    const disposed = host.dispose();
    await Promise.resolve();
    expect(disposed).not.toBe(undefined);
    expect(sendCommand).not.toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "webmcp-bridge",
    });

    evaluation.resolve({ result: { value: { answer: 42 } } });
    await disposed;
    expect(sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "webmcp-bridge",
    });
    await expect(
      host.executeTool({
        sessionId: "session-after-dispose",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).rejects.toMatchObject({ browserError: { code: "BrowserHostUnavailable" } });
  });

  it("blocks new DOM tools while a human annotation picker is interactive", async () => {
    const { manager, raw } = createManager();
    raw.isAnnotationInteractive.mockReturnValue(true);
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "annotation-takeover",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_snapshot",
        arguments: {},
      }),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserInterruptedByHuman" },
    });
    await expect(
      host.executeTool({
        sessionId: "annotation-status",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).resolves.toMatchObject({ available: true });
  });

  it("allows scoped browser tools without an authorization prompt", async () => {
    const { manager } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-1",
        provider: "claude",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).resolves.toMatchObject({ authorization: "not-required", assignedTabId: null });
    for (let index = 0; index < 2; index += 1) {
      await expect(
        host.executeTool({
          sessionId: "session-1",
          provider: "claude",
          threadId: THREAD_ID,
          name: "browser_tabs",
          arguments: {},
        }),
      ).resolves.toMatchObject({ activeTabId: TAB_ID });
    }
  });

  it("resolves annotation navigation locally and rejects stale annotation ids", async () => {
    const { manager, raw } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "annotation-navigation",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_navigate",
        arguments: {
          annotationId: "annotation-page",
          idempotencyKey: "annotation-navigation-valid",
        },
      }),
    ).resolves.toMatchObject({
      tabId: TAB_ID,
      finalUrl: "https://example.test/private?token=local-only",
    });
    expect(raw.resolveAnnotationNavigationTarget).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      annotationId: "annotation-page",
    });
    expect(raw.prepareAutomationNavigation).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      tabId: TAB_ID,
      url: "https://example.test/private?token=local-only",
    });

    await expect(
      host.executeTool({
        sessionId: "annotation-navigation",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_navigate",
        arguments: {
          annotationId: "annotation-stale",
          idempotencyKey: "annotation-navigation-stale",
        },
      }),
    ).rejects.toMatchObject({
      browserError: {
        code: "BrowserNavigationBlocked",
        effectMayHaveCommitted: false,
      },
    });
  });

  it("binds one provider session to exactly one thread", async () => {
    const { manager } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);
    await host.executeTool({
      sessionId: "session-1",
      provider: "cursor",
      threadId: THREAD_ID,
      name: "browser_status",
      arguments: {},
    });

    await expect(
      host.executeTool({
        sessionId: "session-1",
        provider: "cursor",
        threadId: OTHER_THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserTabScopeViolation" },
    });
  });

  it("never evicts or rebinds an authenticated provider-session identity", async () => {
    const { manager } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);
    await host.executeTool({
      sessionId: "session-permanent",
      provider: "cursor",
      threadId: THREAD_ID,
      name: "browser_status",
      arguments: {},
    });
    for (let index = 0; index < 300; index += 1) {
      await host.executeTool({
        sessionId: `session-filler-${index}`,
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      });
    }

    await expect(
      host.executeTool({
        sessionId: "session-permanent",
        provider: "cursor",
        threadId: OTHER_THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).rejects.toMatchObject({ browserError: { code: "BrowserTabScopeViolation" } });
    await expect(
      host.executeTool({
        sessionId: "session-permanent",
        provider: "claude",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).rejects.toMatchObject({ browserError: { code: "BrowserProviderProcessMismatch" } });
  });

  it("opens the requested thread, keeps tab affinity and deduplicates an identical intention", async () => {
    const { manager, raw } = createManager();
    const openPanel = vi.fn(async () => undefined);
    const host = new DesktopBrowserAutomationHost(manager, {
      requestOpenPanel: openPanel,
    });
    const request = {
      sessionId: "session-1",
      provider: "gemini",
      threadId: THREAD_ID,
      name: "browser_open" as const,
      arguments: { idempotencyKey: "open-1", url: "https://example.test" },
    };

    const first = await host.executeTool(request);
    const second = await host.executeTool(request);
    expect(first).toEqual(second);
    expect(raw.prepareAutomationTab).toHaveBeenCalledTimes(1);
    expect(openPanel).toHaveBeenCalledWith(THREAD_ID);
    await expect(
      host.executeTool({
        sessionId: "session-1",
        provider: "gemini",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).resolves.toMatchObject({ assignedTabId: TAB_ID, authorization: "not-required" });
  });

  it("treats timeout budget as transport metadata when deduplicating an intention", async () => {
    const { manager, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);
    const base = {
      sessionId: "session-timeout-fingerprint",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_resize" as const,
    };

    await host.executeTool({
      ...base,
      arguments: {
        idempotencyKey: "resize-same-intention",
        width: 800,
        height: 600,
        timeoutMs: 200,
      },
    });
    await expect(
      host.executeTool({
        ...base,
        arguments: {
          idempotencyKey: "resize-same-intention",
          width: 800,
          height: 600,
          timeoutMs: 300,
        },
      }),
    ).resolves.toMatchObject({ requested: { width: 800, height: 600 } });
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Emulation.setDeviceMetricsOverride",
      expect.anything(),
    );
    expect(
      (webContents.debugger.sendCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([method]) => method === "Emulation.setDeviceMetricsOverride",
      ),
    ).toHaveLength(1);
  });

  it("never evicts an in-flight idempotent operation under settled-cache pressure", async () => {
    const { manager, webContents } = createManager();
    const layout = deferred<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
    }>();
    const layoutStarted = deferred<void>();
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    let holdFirstLayout = true;
    sendCommand.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getLayoutMetrics" && holdFirstLayout) {
        holdFirstLayout = false;
        layoutStarted.resolve();
        return layout.promise;
      }
      return original(method, params);
    });
    const host = new DesktopBrowserAutomationHost(manager);
    const request = {
      sessionId: "session-cache-pressure",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_resize" as const,
      arguments: { idempotencyKey: "resize-in-flight", width: 800, height: 600 },
    };
    const first = host.executeTool(request);
    await layoutStarted.promise;

    for (let index = 0; index < 512; index += 1) {
      await host.executeTool({
        sessionId: `session-cache-filler-${index}`,
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: { idempotencyKey: `settled-${index}` },
      });
    }
    const replay = host.executeTool(request);
    layout.resolve({ cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } });

    await expect(first).resolves.toMatchObject({ requested: { width: 800, height: 600 } });
    await expect(replay).resolves.toMatchObject({ requested: { width: 800, height: 600 } });
    expect(
      sendCommand.mock.calls.filter(([method]) => method === "Emulation.setDeviceMetricsOverride"),
    ).toHaveLength(1);
  });

  it("reconciles an evicted mutating result instead of duplicating its effect", async () => {
    const { manager, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);
    const request = {
      sessionId: "session-evicted-effect",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_resize" as const,
      arguments: { idempotencyKey: "resize-evicted-effect", width: 800, height: 600 },
    };
    await host.executeTool(request);
    for (let index = 0; index < 512; index += 1) {
      await host.executeTool({
        sessionId: `session-eviction-filler-${index}`,
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: { idempotencyKey: `eviction-settled-${index}` },
      });
    }

    await expect(host.executeTool(request)).rejects.toMatchObject({
      browserError: {
        code: "BrowserAmbiguousResult",
        retryable: false,
        effectMayHaveCommitted: true,
      },
    });
    expect(
      (webContents.debugger.sendCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([method]) => method === "Emulation.setDeviceMetricsOverride",
      ),
    ).toHaveLength(1);
  });

  it("rejects replay of a snapshot superseded by a newer semantic observation", async () => {
    const { manager } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);
    const firstRequest = {
      sessionId: "session-snapshot-replay",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_snapshot" as const,
      arguments: { idempotencyKey: "snapshot-old", includeImage: false },
    };
    const first = (await host.executeTool(firstRequest)) as {
      structuredContent: { snapshotId: string };
    };
    const second = (await host.executeTool({
      ...firstRequest,
      arguments: { idempotencyKey: "snapshot-new", includeImage: false },
    })) as { structuredContent: { snapshotId: string } };
    expect(second.structuredContent.snapshotId).not.toBe(first.structuredContent.snapshotId);

    await expect(host.executeTool(firstRequest)).rejects.toMatchObject({
      browserError: {
        code: "BrowserStaleReference",
        retryable: false,
        effectMayHaveCommitted: false,
      },
    });
  });

  it("executes the complete 22-tool catalogue against one shared visible runtime", async () => {
    const { manager, raw, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager, {
      requestOpenPanel: async () => undefined,
    });
    let sequence = 0;
    const call = (
      name: Parameters<typeof host.executeTool>[0]["name"],
      arguments_: Record<string, unknown>,
      workspaceRoot?: string,
    ) =>
      host.executeTool({
        sessionId: "session-all-tools",
        provider: "opencode",
        threadId: THREAD_ID,
        name,
        arguments: arguments_,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      });
    const key = () => `intent-${++sequence}`;

    await expect(call("browser_status", {})).resolves.toMatchObject({ available: true });
    await expect(call("browser_tabs", {})).resolves.toMatchObject({ tabs: [{ tabId: TAB_ID }] });
    await expect(
      call("browser_open", {
        idempotencyKey: key(),
        url: "https://example.test/",
        reuse: true,
      }),
    ).resolves.toMatchObject({ tabId: TAB_ID, disposition: "reused" });
    raw.prepareAutomationNavigation.mockClear();
    raw.getVisibleAutomationRuntime.mockClear();
    await expect(
      call("browser_navigate", {
        idempotencyKey: key(),
        url: "https://example.test/next",
      }),
    ).resolves.toMatchObject({ tabId: TAB_ID, finalUrl: "https://example.test/next" });
    expect(raw.prepareAutomationNavigation).toHaveBeenCalledBefore(raw.getVisibleAutomationRuntime);
    await expect(
      call("browser_back", {
        idempotencyKey: key(),
        waitUntil: "domcontentloaded",
      }),
    ).resolves.toMatchObject({ finalUrl: "https://example.test/" });
    await expect(
      call("browser_forward", {
        idempotencyKey: key(),
        waitUntil: "domcontentloaded",
      }),
    ).resolves.toMatchObject({ finalUrl: "https://example.test/next" });
    await expect(
      call("browser_reload", {
        idempotencyKey: key(),
        waitUntil: "domcontentloaded",
        ignoreCache: true,
      }),
    ).resolves.toMatchObject({ finalUrl: "https://example.test/next" });
    await expect(
      call("browser_resize", {
        idempotencyKey: key(),
        width: 1024,
        height: 768,
      }),
    ).resolves.toMatchObject({ requested: { width: 1024, height: 768 } });
    const snapshot = await call("browser_snapshot", { includeImage: false });
    expect(snapshot).toMatchObject({
      structuredContent: { tabId: TAB_ID, elements: [{ ref: "e1", role: "button" }] },
    });
    await expect(call("browser_screenshot", { fullPage: false })).resolves.toMatchObject({
      structuredContent: {
        tabId: TAB_ID,
        mode: "viewport",
        image: { width: 1_024, height: 768 },
      },
      image: { mimeType: "image/png", data: expect.any(String) },
    });
    await expect(
      call("browser_logs", {
        includeConsole: true,
        includeNetwork: true,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      tabId: TAB_ID,
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "network", phase: "request" }),
      ]),
    });
    await expect(
      call("browser_click", {
        idempotencyKey: key(),
        target: { selector: "#save" },
      }),
    ).resolves.toMatchObject({ tabId: TAB_ID, point: { x: 60, y: 40 } });
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 60, y: 40 }),
    );
    await expect(
      call("browser_hover", {
        idempotencyKey: key(),
        target: { selector: "#save" },
      }),
    ).resolves.toMatchObject({ tabId: TAB_ID, point: { x: 60, y: 40 } });
    await expect(
      call("browser_drag", {
        idempotencyKey: key(),
        source: { selector: "#source" },
        target: { selector: "#target" },
        steps: 2,
      }),
    ).resolves.toMatchObject({
      tabId: TAB_ID,
      source: { point: { x: 60, y: 40 } },
      target: { point: { x: 60, y: 40 } },
    });
    await expect(
      call("browser_type", {
        idempotencyKey: key(),
        target: { selector: "#field" },
        text: "hello",
      }),
    ).resolves.toMatchObject({ resultingValue: { kind: "text", value: "hello" } });
    expect(webContents.insertText).toHaveBeenCalledWith("hello");
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      "Input.insertText",
      expect.anything(),
    );
    await expect(
      call("browser_select", {
        idempotencyKey: key(),
        target: { selector: "#choice" },
        values: ["primary"],
      }),
    ).resolves.toMatchObject({ selectedValues: ["primary"] });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "synara-browser-host-upload-"));
    const uploadUserDataRoot = await mkdtemp(join(tmpdir(), "synara-browser-host-user-data-"));
    configureWorkspaceUploadForTests(webContents, { userDataRoot: uploadUserDataRoot });
    await writeFile(join(workspaceRoot, "avatar.txt"), "avatar");
    try {
      await expect(
        call(
          "browser_upload",
          {
            idempotencyKey: key(),
            target: { selector: "#upload" },
            paths: ["avatar.txt"],
          },
          workspaceRoot,
        ),
      ).resolves.toMatchObject({
        tabId: TAB_ID,
        files: [{ name: "avatar.txt", byteLength: 6 }],
      });
    } finally {
      await Promise.all([
        rm(workspaceRoot, { recursive: true, force: true }),
        rm(uploadUserDataRoot, { recursive: true, force: true }),
      ]);
    }
    await expect(
      call("browser_press", {
        idempotencyKey: key(),
        keys: ["Enter"],
      }),
    ).resolves.toMatchObject({ emitted: ["Enter"], modifiersReleased: true });
    expect(webContents.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "keyDown", keyCode: "Enter", skipIfUnhandled: true }),
    );
    await expect(
      call("browser_scroll", {
        idempotencyKey: key(),
        mode: "pixels",
        deltaY: 100,
      }),
    ).resolves.toMatchObject({ before: { y: 0 }, after: { y: 100 } });
    await expect(
      call("browser_wait", {
        conditions: [{ kind: "text", text: "Ready", state: "present" }],
      }),
    ).resolves.toMatchObject({ satisfiedConditionIndexes: [0] });
    await expect(
      call("browser_evaluate", {
        idempotencyKey: key(),
        expression: "({answer: 42})",
      }),
    ).resolves.toMatchObject({ value: { answer: 42 } });
    await expect(
      call("browser_close", {
        idempotencyKey: key(),
      }),
    ).resolves.toMatchObject({ closedTabId: TAB_ID, activeTabId: null });
  });

  it("opens the blank launcher without waiting for a guest webview that does not exist", async () => {
    const { manager, raw } = createManager();
    const blankState = raw.getState();
    blankState.tabs[0]!.url = "about:blank";
    blankState.tabs[0]!.lastCommittedUrl = null;
    raw.getVisibleAutomationRuntime.mockImplementation(() => {
      throw new Error("no guest for about:blank");
    });
    const openPanel = vi.fn(async () => undefined);
    const host = new DesktopBrowserAutomationHost(manager, {
      requestOpenPanel: openPanel,
    });

    await expect(
      host.executeTool({
        sessionId: "session-blank",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_open",
        arguments: { idempotencyKey: "open-blank" },
      }),
    ).resolves.toMatchObject({ tabId: TAB_ID, finalUrl: "about:blank" });
    expect(openPanel).toHaveBeenCalledWith(THREAD_ID);
    expect(raw.getVisibleAutomationRuntime).not.toHaveBeenCalled();
  });

  it("reuses an attached tab for a hidden no-URL open", async () => {
    const { manager, raw } = createManager();
    const openPanel = vi.fn(async () => undefined);
    const host = new DesktopBrowserAutomationHost(manager, { requestOpenPanel: openPanel });

    await expect(
      host.executeTool({
        sessionId: "session-hidden-attached",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_open",
        arguments: { idempotencyKey: "open-hidden-attached", show: false },
      }),
    ).resolves.toMatchObject({
      tabId: TAB_ID,
      finalUrl: "https://example.test/",
      disposition: "reused",
    });
    expect(raw.getVisibleAutomationRuntime).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    expect(raw.prepareAutomationTab).not.toHaveBeenCalled();
    expect(openPanel).not.toHaveBeenCalled();
  });

  it("never prepares browser state for a hidden open with a URL", async () => {
    const { manager, raw } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-hidden-navigation",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_open",
        arguments: {
          idempotencyKey: "open-hidden-navigation",
          show: false,
          url: "https://example.test/next",
        },
      }),
    ).resolves.toMatchObject({
      tabId: TAB_ID,
      finalUrl: "https://example.test/next",
      disposition: "reused",
    });
    expect(raw.prepareAutomationTab).not.toHaveBeenCalled();
    expect(raw.prepareAutomationNavigation).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      tabId: TAB_ID,
      url: "https://example.test/next",
    });
  });

  it("rejects a hidden navigation when another session changes the visible tab during validation", async () => {
    const { manager, raw, webContents } = createManager();
    const state = raw.getState();
    state.tabs.push({
      id: OPENED_TAB_ID,
      url: "https://other.example/",
      title: "Other",
      status: "live",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastCommittedUrl: "https://other.example/",
      lastError: null,
    });
    raw.prepareAutomationTab.mockImplementation(() => {
      state.activeTabId = OPENED_TAB_ID;
      return state;
    });
    const diagnosticsStarted = deferred<void>();
    const releaseDiagnostics = deferred<void>();
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    let suspendFirstDiagnostics = true;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.enable" && suspendFirstDiagnostics) {
        suspendFirstDiagnostics = false;
        diagnosticsStarted.resolve();
        await releaseDiagnostics.promise;
      }
      return original(method, params);
    });
    const host = new DesktopBrowserAutomationHost(manager);
    const hiddenNavigation = host.executeTool({
      sessionId: "session-hidden-race-a",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_open",
      arguments: {
        idempotencyKey: "open-hidden-race-a",
        show: false,
        url: "https://example.test/next",
      },
    });
    await diagnosticsStarted.promise;

    await expect(
      host.executeTool({
        sessionId: "session-hidden-race-b",
        provider: "claude",
        threadId: THREAD_ID,
        name: "browser_open",
        arguments: {
          idempotencyKey: "open-hidden-race-b",
          show: true,
          reuse: false,
        },
      }),
    ).resolves.toMatchObject({ tabId: OPENED_TAB_ID });
    expect(state.activeTabId).toBe(OPENED_TAB_ID);
    releaseDiagnostics.resolve();

    await expect(hiddenNavigation).rejects.toMatchObject({
      browserError: {
        code: "BrowserHostUnavailable",
        effectMayHaveCommitted: false,
        tabId: TAB_ID,
      },
    });
    expect(state.activeTabId).toBe(OPENED_TAB_ID);
    expect(webContents.getURL()).toBe("https://example.test/");
    expect(raw.prepareAutomationNavigation).not.toHaveBeenCalled();
    await expect(
      host.executeTool({
        sessionId: "session-hidden-race-a",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).resolves.toMatchObject({ assignedTabId: null });
    await expect(
      host.executeTool({
        sessionId: "session-hidden-race-b",
        provider: "claude",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).resolves.toMatchObject({ assignedTabId: OPENED_TAB_ID });
  });

  it("keeps a visible navigation selected until its CDP action finishes", async () => {
    const { manager, raw, webContents } = createManager();
    const state = raw.getState();
    state.tabs.push({
      id: OPENED_TAB_ID,
      url: "https://other.example/",
      title: "Other",
      status: "live",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastCommittedUrl: "https://other.example/",
      lastError: null,
    });
    raw.prepareAutomationTab.mockImplementation(() => {
      state.activeTabId = OPENED_TAB_ID;
      return state;
    });
    const navigationStarted = deferred<void>();
    const releaseNavigation = deferred<void>();
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    let suspendFirstNavigation = true;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.navigate" && suspendFirstNavigation) {
        suspendFirstNavigation = false;
        navigationStarted.resolve();
        await releaseNavigation.promise;
      }
      return original(method, params);
    });
    const host = new DesktopBrowserAutomationHost(manager);
    const navigation = host.executeTool({
      sessionId: "session-visible-race-a",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_navigate",
      arguments: {
        idempotencyKey: "navigate-visible-race-a",
        url: "https://example.test/next",
      },
    });
    await navigationStarted.promise;

    const competingOpen = host.executeTool({
      sessionId: "session-visible-race-b",
      provider: "claude",
      threadId: THREAD_ID,
      name: "browser_open",
      arguments: {
        idempotencyKey: "open-visible-race-b",
        show: true,
        reuse: false,
      },
    });
    let competingOpenSettled = false;
    void competingOpen.then(
      () => {
        competingOpenSettled = true;
      },
      () => {
        competingOpenSettled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const competingOpenSettledDuringNavigation = competingOpenSettled;
    const preparedDuringNavigation = raw.prepareAutomationTab.mock.calls.length;
    const activeDuringNavigation = state.activeTabId;
    releaseNavigation.resolve();

    await expect(navigation).resolves.toMatchObject({
      tabId: TAB_ID,
      finalUrl: "https://example.test/next",
    });
    await expect(competingOpen).resolves.toMatchObject({ tabId: OPENED_TAB_ID });
    expect(competingOpenSettledDuringNavigation).toBe(false);
    expect(preparedDuringNavigation).toBe(0);
    expect(activeDuringNavigation).toBe(TAB_ID);
    expect(state.activeTabId).toBe(OPENED_TAB_ID);
  });

  it("reports an unavailable hidden runtime without creating a new tab", async () => {
    const { manager, raw } = createManager();
    raw.getVisibleAutomationRuntime.mockImplementation(() => {
      throw new Error("guest not attached");
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-hidden-unattached",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_open",
        arguments: { idempotencyKey: "open-hidden-unattached", show: false },
      }),
    ).rejects.toMatchObject({
      browserError: {
        code: "BrowserHostUnavailable",
        effectMayHaveCommitted: false,
      },
    });
    expect(raw.prepareAutomationTab).not.toHaveBeenCalled();
    expect(raw.selectAutomationTab).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    await expect(
      host.executeTool({
        sessionId: "session-hidden-unattached",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).resolves.toMatchObject({ assignedTabId: null });
  });

  it("resolves the requested navigation milestone from CDP without awaiting loadURL", async () => {
    const { manager, webContents } = createManager();
    webContents.loadURL = vi.fn(() => new Promise<void>(() => undefined));
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method !== "Page.navigate") return original(method, params);
      const requestedUrl = String(params?.url);
      queueMicrotask(() => {
        webContents.emitDebuggerMessage("Network.requestWillBeSent", {
          requestId: "document-1",
          frameId: "main-frame",
          loaderId: "loader-redirect",
          type: "Document",
          request: { url: requestedUrl },
        });
        webContents.emitDebuggerMessage("Network.requestWillBeSent", {
          requestId: "document-1",
          frameId: "main-frame",
          loaderId: "loader-redirect",
          type: "Document",
          request: { url: "https://redirect.example/step" },
          redirectResponse: { url: requestedUrl },
        });
        webContents.emitDebuggerMessage("Network.requestWillBeSent", {
          requestId: "document-1",
          frameId: "main-frame",
          loaderId: "loader-redirect",
          type: "Document",
          request: { url: "https://final.example/landing" },
          redirectResponse: { url: "https://redirect.example/step" },
        });
        webContents.emitDebuggerMessage("Page.frameNavigated", {
          frame: {
            id: "main-frame",
            loaderId: "loader-redirect",
            url: "https://final.example/landing",
          },
        });
        webContents.emitDebuggerMessage("Page.lifecycleEvent", {
          frameId: "main-frame",
          loaderId: "loader-redirect",
          name: "DOMContentLoaded",
        });
      });
      return { frameId: "main-frame", loaderId: "loader-redirect" };
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-navigation-events",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_navigate",
        arguments: {
          idempotencyKey: "navigate-events",
          url: "https://start.example/",
          waitUntil: "domcontentloaded",
          timeoutMs: 100,
        },
      }),
    ).resolves.toMatchObject({
      finalUrl: "https://final.example/landing",
      redirects: ["https://start.example/", "https://redirect.example/step"],
      loadState: "domcontentloaded",
    });
    expect(webContents.loadURL).not.toHaveBeenCalled();
  });

  it("closes a restore-held tab without requiring an attached renderer guest", async () => {
    const { manager, raw } = createManager();
    raw.getVisibleAutomationRuntime.mockImplementation(() => {
      throw new Error("restore-held tabs have no guest");
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-close-held",
        provider: "cursor",
        threadId: THREAD_ID,
        name: "browser_close",
        arguments: { idempotencyKey: "close-held" },
      }),
    ).resolves.toMatchObject({ closedTabId: TAB_ID, activeTabId: null });
    expect(raw.getVisibleAutomationRuntime).not.toHaveBeenCalled();
    expect(raw.closeAutomationTab).toHaveBeenCalledWith({ threadId: THREAD_ID, tabId: TAB_ID });
  });

  it("resolves a scroll point to the element under the cursor", async () => {
    const { manager, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-scroll-point",
        provider: "gemini",
        threadId: THREAD_ID,
        name: "browser_scroll",
        arguments: {
          idempotencyKey: "scroll-point",
          mode: "pixels",
          deltaY: 100,
          target: { point: { x: 50, y: 60 } },
        },
      }),
    ).resolves.toMatchObject({ after: { y: 100 } });

    const commands = (webContents.debugger.sendCommand as ReturnType<typeof vi.fn>).mock.calls;
    expect(commands).toContainEqual([
      "Runtime.callFunctionOn",
      expect.objectContaining({ objectId: "point-target" }),
    ]);
  });

  it("clicks the exact guest element and coordinates resolved from a viewport point", async () => {
    const { manager, webContents } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-click-point",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_click",
        arguments: {
          idempotencyKey: "click-point",
          target: { point: { x: 50, y: 60 } },
        },
      }),
    ).resolves.toMatchObject({ point: { x: 50, y: 60 } });

    const commands = (webContents.debugger.sendCommand as ReturnType<typeof vi.fn>).mock.calls;
    expect(commands).toContainEqual([
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "point-target",
        functionDeclaration: expect.stringContaining("requestedPoint"),
        arguments: [
          {
            value: expect.objectContaining({ point: { x: 50, y: 60 } }),
          },
        ],
      }),
    ]);
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 50, y: 60 }),
    );
  });

  it("rejects the originating agent action when its download is contained", async () => {
    const { manager, raw, webContents } = createManager();
    let reportDownload: ((event: { threadId: ThreadId; sourceTabId: string }) => void) | undefined;
    const releaseTracking = vi.fn();
    raw.trackAutomationDownload.mockImplementation((_input, listener) => {
      reportDownload = listener as typeof reportDownload;
      return releaseTracking;
    });
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params);
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        reportDownload?.({ threadId: THREAD_ID, sourceTabId: TAB_ID });
      }
      return result;
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-download",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_click",
        arguments: {
          idempotencyKey: "click-download",
          target: { selector: "#download" },
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserAutomationHostError &&
        error.browserError.code === "BrowserDownloadApprovalRequired" &&
        error.browserError.retryable === false &&
        error.browserError.phase === "input" &&
        error.browserError.effectMayHaveCommitted === true &&
        error.browserError.tabId === TAB_ID,
    );
    expect(raw.trackAutomationDownload).toHaveBeenCalledWith(
      { threadId: THREAD_ID, tabId: TAB_ID },
      expect.any(Function),
    );
    // The public abort is immediate, while the tab lock deliberately drains
    // the native input operation before releasing its correlation lease.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(releaseTracking).toHaveBeenCalledOnce();
  });

  it("guards a downloadable browser_open response before projecting its URL", async () => {
    const { manager, raw } = createManager();
    let reportDownload: ((event: { threadId: ThreadId; sourceTabId: string }) => void) | undefined;
    raw.trackAutomationDownload.mockImplementation((_input, listener) => {
      reportDownload = listener as typeof reportDownload;
      return () => {
        reportDownload = undefined;
      };
    });
    const state = raw.getState();
    raw.prepareAutomationNavigation.mockImplementation(() => {
      queueMicrotask(() => {
        reportDownload?.({ threadId: THREAD_ID, sourceTabId: TAB_ID });
      });
      return state;
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-open-download",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_open",
        arguments: {
          idempotencyKey: "open-download",
          url: "https://example.test/archive.zip",
          reuse: true,
        },
      }),
    ).rejects.toMatchObject({
      browserError: {
        code: "BrowserDownloadApprovalRequired",
        retryable: false,
        effectMayHaveCommitted: true,
      },
    });
    expect(raw.trackAutomationDownload).toHaveBeenCalledBefore(raw.prepareAutomationNavigation);
  });

  it("does not attribute downloads to read-only observation tools", async () => {
    const { manager, raw } = createManager();
    const host = new DesktopBrowserAutomationHost(manager);

    await host.executeTool({
      sessionId: "session-read-only",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_snapshot",
      arguments: { includeImage: false },
    });

    expect(raw.trackAutomationDownload).not.toHaveBeenCalled();
  });

  it("adopts a target=_blank tab created during a reconciled agent gesture", async () => {
    const { manager, raw, webContents } = createManager();
    const state = raw.getState();
    const tabOpened = deferred<void>();
    let reportWindowOpen:
      | ((event: {
          threadId: ThreadId;
          sourceTabId: string;
          kind: "tab";
          openedTabId: string;
        }) => void)
      | undefined;
    raw.trackAutomationWindowOpen.mockImplementation((_input, listener) => {
      reportWindowOpen = listener as typeof reportWindowOpen;
      return () => {
        reportWindowOpen = undefined;
      };
    });
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params);
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        setTimeout(() => {
          state.tabs.push({
            ...state.tabs[0]!,
            id: OPENED_TAB_ID,
            url: "https://opened.example/",
            lastCommittedUrl: "https://opened.example/",
          });
          state.activeTabId = OPENED_TAB_ID;
          reportWindowOpen?.({
            threadId: THREAD_ID,
            sourceTabId: TAB_ID,
            kind: "tab",
            openedTabId: OPENED_TAB_ID,
          });
          tabOpened.resolve();
        }, 0);
      }
      return result;
    });
    const host = new DesktopBrowserAutomationHost(manager);

    const result = await host.executeTool({
      sessionId: "session-opened-tab",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_click",
      arguments: {
        idempotencyKey: "click-opens-tab",
        target: { selector: "#external" },
      },
    });
    await tabOpened.promise;
    expect(result).toMatchObject({ openedTabId: OPENED_TAB_ID });
    await expect(
      host.executeTool({
        sessionId: "session-opened-tab",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).resolves.toMatchObject({ assignedTabId: OPENED_TAB_ID });
  });

  it("commits and adopts a target=_blank tab opened by a keyboard activation", async () => {
    const { manager, raw, webContents } = createManager();
    const state = raw.getState();
    let reportWindowOpen:
      | ((event: {
          threadId: ThreadId;
          sourceTabId: string;
          kind: "tab";
          openedTabId: string;
        }) => void)
      | undefined;
    const releaseTracking = vi.fn(() => {
      state.tabs.push({
        ...state.tabs[0]!,
        id: OPENED_TAB_ID,
        url: "https://opened.example/",
        lastCommittedUrl: "https://opened.example/",
      });
      state.activeTabId = OPENED_TAB_ID;
      reportWindowOpen = undefined;
      return undefined;
    });
    raw.trackAutomationWindowOpen.mockImplementation((_input, listener) => {
      reportWindowOpen = listener as typeof reportWindowOpen;
      return releaseTracking;
    });
    let dispatched = false;
    (webContents.sendInputEvent as ReturnType<typeof vi.fn>).mockImplementation((event) => {
      if (dispatched || event.type !== "keyDown") return;
      dispatched = true;
      webContents.emitDebuggerMessage("Page.windowOpen", {});
      setImmediate(() => {
        reportWindowOpen?.({
          threadId: THREAD_ID,
          sourceTabId: TAB_ID,
          kind: "tab",
          openedTabId: OPENED_TAB_ID,
        });
      });
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-press-opened-tab",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_press",
        arguments: {
          idempotencyKey: "press-opens-tab",
          keys: ["Enter"],
        },
      }),
    ).resolves.toMatchObject({
      emitted: ["Enter"],
      openedTabId: OPENED_TAB_ID,
    });
    expect(releaseTracking).toHaveBeenCalledOnce();
    await expect(
      host.executeTool({
        sessionId: "session-press-opened-tab",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_status",
        arguments: {},
      }),
    ).resolves.toMatchObject({ assignedTabId: OPENED_TAB_ID });
  });

  it("hands an OAuth popup to the user and stops automated follow-up", async () => {
    const { manager, raw, webContents } = createManager();
    let reportWindowOpen:
      | ((event: {
          threadId: ThreadId;
          sourceTabId: string;
          kind: "popup";
          openedTabId: null;
        }) => void)
      | undefined;
    raw.trackAutomationWindowOpen.mockImplementation((_input, listener) => {
      reportWindowOpen = listener as typeof reportWindowOpen;
      return () => {
        reportWindowOpen = undefined;
      };
    });
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params);
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        reportWindowOpen?.({
          threadId: THREAD_ID,
          sourceTabId: TAB_ID,
          kind: "popup",
          openedTabId: null,
        });
      }
      return result;
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-oauth-popup",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_click",
        arguments: {
          idempotencyKey: "click-oauth-popup",
          target: { selector: "#sign-in" },
        },
      }),
    ).resolves.toMatchObject({
      tabId: TAB_ID,
      humanActionRequired: {
        kind: "oauth_popup",
        instruction: "Complete sign-in in the visible popup before continuing.",
      },
    });
    expect(raw.getState().activeTabId).toBe(TAB_ID);
  });

  it("hands a keyboard-opened OAuth popup to the user", async () => {
    const { manager, raw, webContents } = createManager();
    let reportWindowOpen:
      | ((event: {
          threadId: ThreadId;
          sourceTabId: string;
          kind: "popup";
          openedTabId: null;
        }) => void)
      | undefined;
    raw.trackAutomationWindowOpen.mockImplementation((_input, listener) => {
      reportWindowOpen = listener as typeof reportWindowOpen;
      return () => {
        reportWindowOpen = undefined;
      };
    });
    let dispatched = false;
    (webContents.sendInputEvent as ReturnType<typeof vi.fn>).mockImplementation((event) => {
      if (dispatched || event.type !== "keyDown") return;
      dispatched = true;
      reportWindowOpen?.({
        threadId: THREAD_ID,
        sourceTabId: TAB_ID,
        kind: "popup",
        openedTabId: null,
      });
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-press-oauth-popup",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_press",
        arguments: {
          idempotencyKey: "press-oauth-popup",
          keys: ["Enter"],
        },
      }),
    ).resolves.toMatchObject({
      tabId: TAB_ID,
      humanActionRequired: {
        kind: "oauth_popup",
        instruction: "Complete sign-in in the visible popup before continuing.",
      },
    });
    expect(raw.getState().activeTabId).toBe(TAB_ID);
  });

  it("reports a clean error when page code requests a blocked native popup", async () => {
    const { manager, raw, webContents } = createManager();
    let reportWindowOpen:
      | ((event: {
          threadId: ThreadId;
          sourceTabId: string;
          kind: "blocked";
          openedTabId: null;
        }) => void)
      | undefined;
    raw.trackAutomationWindowOpen.mockImplementation((_input, listener) => {
      reportWindowOpen = listener as typeof reportWindowOpen;
      return () => {
        reportWindowOpen = undefined;
      };
    });
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params);
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        reportWindowOpen?.({
          threadId: THREAD_ID,
          sourceTabId: TAB_ID,
          kind: "blocked",
          openedTabId: null,
        });
      }
      return result;
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-blocked-popup",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_click",
        arguments: {
          idempotencyKey: "click-blocked-popup",
          target: { selector: "#native-handler" },
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserAutomationHostError &&
        error.browserError.code === "BrowserPopupBlocked" &&
        error.browserError.retryable === false &&
        error.browserError.phase === "navigation" &&
        error.browserError.effectMayHaveCommitted === true,
    );
  });

  it("reports a blocked native popup requested by a keyboard activation", async () => {
    const { manager, raw, webContents } = createManager();
    let reportWindowOpen:
      | ((event: {
          threadId: ThreadId;
          sourceTabId: string;
          kind: "blocked";
          openedTabId: null;
        }) => void)
      | undefined;
    raw.trackAutomationWindowOpen.mockImplementation((_input, listener) => {
      reportWindowOpen = listener as typeof reportWindowOpen;
      return () => {
        reportWindowOpen = undefined;
      };
    });
    let dispatched = false;
    (webContents.sendInputEvent as ReturnType<typeof vi.fn>).mockImplementation((event) => {
      if (dispatched || event.type !== "keyDown") return;
      dispatched = true;
      reportWindowOpen?.({
        threadId: THREAD_ID,
        sourceTabId: TAB_ID,
        kind: "blocked",
        openedTabId: null,
      });
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-press-blocked-popup",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_press",
        arguments: {
          idempotencyKey: "press-blocked-popup",
          keys: ["Enter"],
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserAutomationHostError &&
        error.browserError.code === "BrowserPopupBlocked" &&
        error.browserError.retryable === false &&
        error.browserError.phase === "navigation" &&
        error.browserError.effectMayHaveCommitted === true,
    );
  });

  it("reports the committed destination when a click navigates the current tab", async () => {
    const { manager, webContents } = createManager();
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params);
      if (
        method === "Runtime.callFunctionOn" &&
        String(params?.functionDeclaration ?? "").includes("requestedPoint")
      ) {
        webContents.emitDebuggerMessage("Network.requestWillBeSent", {
          requestId: "clicked-document",
          frameId: "main-frame",
          loaderId: "clicked-loader",
          type: "Document",
          request: { url: "https://destination.example/" },
          redirectResponse: { url: "https://example.test/redirect" },
        });
        webContents.emitDebuggerMessage("Page.frameNavigated", {
          frame: {
            id: "main-frame",
            loaderId: "clicked-loader",
            url: "https://destination.example/",
          },
        });
      }
      return result;
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-click-navigation",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_click",
        arguments: {
          idempotencyKey: "click-navigation",
          target: { selector: "#navigate" },
        },
      }),
    ).resolves.toMatchObject({
      finalUrl: "https://destination.example/",
      redirects: ["https://example.test/redirect"],
      loadState: "commit",
    });
  });

  it("waits for a delayed commit after a click starts a main-frame document request", async () => {
    const { manager, webContents } = createManager();
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    let navigationStarted = false;
    sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params);
      if (
        !navigationStarted &&
        method === "Runtime.callFunctionOn" &&
        String(params?.functionDeclaration ?? "").includes("requestedPoint")
      ) {
        navigationStarted = true;
        webContents.emitDebuggerMessage("Network.requestWillBeSent", {
          requestId: "delayed-clicked-document",
          frameId: "main-frame",
          loaderId: "delayed-clicked-loader",
          type: "Document",
          request: { url: "https://delayed-destination.example/" },
        });
        setTimeout(() => {
          webContents.emitDebuggerMessage("Page.frameNavigated", {
            frame: {
              id: "main-frame",
              loaderId: "delayed-clicked-loader",
              url: "https://delayed-destination.example/",
            },
          });
        }, 40);
      }
      return result;
    });
    const host = new DesktopBrowserAutomationHost(manager);

    await expect(
      host.executeTool({
        sessionId: "session-click-delayed-navigation",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_click",
        arguments: {
          idempotencyKey: "click-delayed-navigation",
          target: { selector: "#navigate-later" },
        },
      }),
    ).resolves.toMatchObject({
      finalUrl: "https://delayed-destination.example/",
      loadState: "commit",
    });
  });

  it("reports human takeover when manual control changes during an agent action", async () => {
    const { manager, raw } = createManager();
    raw.getAutomationHumanControlEpoch.mockReturnValueOnce(10).mockReturnValue(11);
    const host = new DesktopBrowserAutomationHost(manager, {
      requestOpenPanel: async () => undefined,
    });

    await expect(
      host.executeTool({
        sessionId: "session-human",
        provider: "claude",
        threadId: THREAD_ID,
        name: "browser_resize",
        arguments: { idempotencyKey: "resize-human", width: 800, height: 600 },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserAutomationHostError &&
        error.browserError.code === "BrowserInterruptedByHuman",
    );
  });

  it("invalidates a stored snapshot when the user acted between agent calls", async () => {
    const { manager, raw } = createManager();
    let epoch = 0;
    raw.getAutomationHumanControlEpoch.mockImplementation(() => epoch);
    const host = new DesktopBrowserAutomationHost(manager);
    const snapshot = (await host.executeTool({
      sessionId: "session-human-between-calls",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_snapshot",
      arguments: { includeImage: false },
    })) as { structuredContent: { snapshotId: string } };

    epoch += 1;
    await expect(
      host.executeTool({
        sessionId: "session-human-between-calls",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_click",
        arguments: {
          idempotencyKey: "click-after-human",
          target: { ref: "e1", snapshotId: snapshot.structuredContent.snapshotId },
        },
      }),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserStaleReference" },
    });
  });

  it("releases the session lock after a timed-out native navigation has drained", async () => {
    const { manager, webContents } = createManager();
    const navigation = deferred<never>();
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    sendCommand.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Page.navigate") return navigation.promise;
      if (method === "Page.stopLoading") {
        navigation.reject(new Error("ERR_ABORTED (-3)"));
        return Promise.resolve({});
      }
      return original(method, params);
    });
    const host = new DesktopBrowserAutomationHost(manager, {
      requestOpenPanel: async () => undefined,
    });

    await expect(
      host.executeTool({
        sessionId: "session-timeout",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_open",
        arguments: {
          idempotencyKey: "open-timeout",
          url: "https://example.test/hangs",
          timeoutMs: 100,
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserAutomationHostError && error.browserError.code === "BrowserTimeout",
    );

    await expect(
      host.executeTool({
        sessionId: "session-timeout",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_tabs",
        arguments: { timeoutMs: 100 },
      }),
    ).resolves.toMatchObject({ activeTabId: TAB_ID });
    expect(sendCommand).toHaveBeenCalledWith("Page.stopLoading");
  });

  it("keeps the lock until an aborted CDP command drains and issues no later command", async () => {
    const { manager, webContents } = createManager();
    const layout = deferred<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
    }>();
    const layoutStarted = deferred<void>();
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    let blocked = true;
    sendCommand.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getLayoutMetrics" && blocked) {
        blocked = false;
        layoutStarted.resolve();
        return layout.promise;
      }
      return original(method, params);
    });
    const host = new DesktopBrowserAutomationHost(manager);
    const controller = new AbortController();
    const first = host.executeTool({
      sessionId: "session-drain",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_resize",
      arguments: { idempotencyKey: "resize-drain", width: 800, height: 600 },
      signal: controller.signal,
    });

    await layoutStarted.promise;
    controller.abort();
    await expect(first).rejects.toMatchObject({ browserError: { code: "BrowserCancelled" } });

    const retryArguments = {
      idempotencyKey: "resize-after-queued-timeout",
      width: 700,
      height: 500,
    };
    await expect(
      host.executeTool({
        sessionId: "session-inner-lock-timeout",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_resize",
        arguments: { ...retryArguments, timeoutMs: 100 },
      }),
    ).rejects.toMatchObject({
      browserError: {
        code: "BrowserTimeout",
        phase: "queue",
        effectMayHaveCommitted: false,
      },
    });

    layout.resolve({ cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } });
    await expect(
      host.executeTool({
        sessionId: "session-inner-lock-timeout",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_resize",
        arguments: retryArguments,
      }),
    ).resolves.toBeDefined();
    expect(sendCommand).toHaveBeenCalledWith(
      "Emulation.setDeviceMetricsOverride",
      expect.objectContaining({ width: 700, height: 500 }),
    );
  });

  it("interrupts the active chain immediately when the user takes native control", async () => {
    const { manager, raw, webContents } = createManager();
    const layout = deferred<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
    }>();
    const layoutStarted = deferred<void>();
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    let blocked = true;
    sendCommand.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getLayoutMetrics" && blocked) {
        blocked = false;
        layoutStarted.resolve();
        return layout.promise;
      }
      return original(method, params);
    });
    let epoch = 0;
    let takeControl!: () => void;
    raw.getAutomationHumanControlEpoch.mockImplementation(() => epoch);
    raw.subscribeAutomationHumanControl.mockImplementation((_threadId, listener) => {
      takeControl = () => {
        epoch += 1;
        listener();
      };
      return () => undefined;
    });
    const host = new DesktopBrowserAutomationHost(manager);
    const operation = host.executeTool({
      sessionId: "session-human-native",
      provider: "claude",
      threadId: THREAD_ID,
      name: "browser_resize",
      arguments: { idempotencyKey: "resize-human-native", width: 800, height: 600 },
    });

    await layoutStarted.promise;
    takeControl();
    await expect(operation).rejects.toMatchObject({
      browserError: { code: "BrowserInterruptedByHuman" },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setDeviceMetricsOverride",
      expect.anything(),
    );

    layout.resolve({ cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } });
    await expect(
      host.executeTool({
        sessionId: "session-human-native",
        provider: "claude",
        threadId: THREAD_ID,
        name: "browser_tabs",
        arguments: {},
      }),
    ).resolves.toMatchObject({ activeTabId: TAB_ID });
  });

  it("cancels a pending background runtime acquisition", async () => {
    const { manager, raw } = createManager();
    const runtime = raw.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId: TAB_ID });
    raw.getVisibleAutomationRuntime.mockClear();
    const acquisition = deferred<typeof runtime>();
    raw.getAutomationRuntime.mockReturnValue(acquisition.promise);
    const host = new DesktopBrowserAutomationHost(manager);
    const controller = new AbortController();
    const operation = host.executeTool({
      sessionId: "session-runtime-abort",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_snapshot",
      arguments: { includeImage: false },
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(raw.getAutomationRuntime).toHaveBeenCalledOnce();
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ browserError: { code: "BrowserCancelled" } });
    acquisition.resolve(runtime);
  });

  it("does not block background execution on a pending panel reveal", async () => {
    const { manager } = createManager();
    const panelReveal = deferred<void>();
    const requestOpenPanel = vi.fn(() => panelReveal.promise);
    const host = new DesktopBrowserAutomationHost(manager, { requestOpenPanel });
    const operation = host.executeTool({
      sessionId: "session-panel-abort",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_snapshot",
      arguments: { includeImage: false },
    });

    await vi.waitFor(() => {
      expect(requestOpenPanel).toHaveBeenCalledWith(THREAD_ID);
    });
    await expect(operation).resolves.toMatchObject({
      structuredContent: { tabId: TAB_ID },
    });
    await expect(
      host.executeTool({
        sessionId: "session-panel-abort",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_tabs",
        arguments: {},
      }),
    ).resolves.toMatchObject({ activeTabId: TAB_ID });
    panelReveal.resolve();
  });

  it("terminates an in-flight page evaluation when the request is aborted", async () => {
    const { manager, webContents } = createManager();
    const evaluation = deferred<never>();
    const evaluationStarted = deferred<void>();
    const sendCommand = webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const original = sendCommand.getMockImplementation() as SendCommand;
    sendCommand.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate" && params?.expression === "new Promise(() => {})") {
        evaluationStarted.resolve();
        return evaluation.promise;
      }
      if (method === "Runtime.terminateExecution") {
        evaluation.reject(new Error("Execution was terminated"));
        return Promise.resolve({});
      }
      return original(method, params);
    });
    const host = new DesktopBrowserAutomationHost(manager);
    const controller = new AbortController();
    const operation = host.executeTool({
      sessionId: "session-evaluate-abort",
      provider: "codex",
      threadId: THREAD_ID,
      name: "browser_evaluate",
      arguments: { idempotencyKey: "evaluate-abort", expression: "new Promise(() => {})" },
      signal: controller.signal,
    });

    await evaluationStarted.promise;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ browserError: { code: "BrowserCancelled" } });
    await expect(
      host.executeTool({
        sessionId: "session-evaluate-abort",
        provider: "codex",
        threadId: THREAD_ID,
        name: "browser_tabs",
        arguments: {},
      }),
    ).resolves.toMatchObject({ activeTabId: TAB_ID });
    expect(sendCommand).toHaveBeenCalledWith("Runtime.terminateExecution");
    const terminationIndex = sendCommand.mock.calls.findIndex(
      ([method]) => method === "Runtime.terminateExecution",
    );
    const commandsAfterTermination = sendCommand.mock.calls.slice(terminationIndex + 1);
    expect(commandsAfterTermination).toHaveLength(1);
    expect(commandsAfterTermination[0]?.[0]).toBe("Runtime.evaluate");
    expect(String(commandsAfterTermination[0]?.[1]?.expression)).toContain("delete window[key]");
  });
});

describe("snapshot target validity", () => {
  it("keeps a ref valid across unrelated page mutation generations", async () => {
    const webContents = createWebContents();
    (webContents.debugger.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "");
          if (expression.includes("state.refs.get")) {
            return { result: { value: { count: 1, generation: 999, stale: false } } };
          }
          if (expression.includes("globalThis.__synaraBrowserAutomationV1.currentTarget")) {
            return { result: { objectId: "target-1", type: "object", subtype: "node" } };
          }
        }
        if (method === "Runtime.callFunctionOn") {
          return {
            result: {
              value: {
                attached: true,
                visible: true,
                enabled: true,
                editable: false,
                role: "button",
                name: "Save",
                point: { x: 50, y: 20 },
              },
            },
          };
        }
        return {};
      },
    );
    const runtime = { threadId: THREAD_ID, tabId: TAB_ID, webContents };

    await expect(
      resolveBrowserTarget(
        runtime,
        { ref: ELEMENT_REF, snapshotId: SNAPSHOT_ID },
        {
          snapshotId: SNAPSHOT_ID,
          tabId: TAB_ID,
          contextId: 12,
          generation: 1,
          humanControlEpoch: 0,
        },
      ),
    ).resolves.toMatchObject({ attached: true, info: { ref: "e1" } });
  });

  it("rejects a ref whose exact node was detached or changed identity", async () => {
    const webContents = createWebContents();
    (webContents.debugger.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) =>
        method === "Runtime.evaluate" ? { result: { value: { count: 0, stale: true } } } : {},
    );
    const runtime = { threadId: THREAD_ID, tabId: TAB_ID, webContents };

    await expect(
      resolveBrowserTarget(
        runtime,
        { ref: ELEMENT_REF, snapshotId: SNAPSHOT_ID },
        {
          snapshotId: SNAPSHOT_ID,
          tabId: TAB_ID,
          contextId: 12,
          generation: 1,
          humanControlEpoch: 0,
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserAutomationHostError &&
        error.browserError.code === "BrowserStaleReference",
    );
  });
});
