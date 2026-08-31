import { EventEmitter } from "node:events";

import { ThreadId } from "@synara/contracts";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

const { browserSession, fromId, webContentsViewConstructor, willDownloadListener } = vi.hoisted(
  () => {
    const willDownloadListener = {
      current: null as null | ((event: object, item: object, webContents: object) => void),
    };
    return {
      browserSession: {
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
        protocol: { handle: vi.fn(), unhandle: vi.fn() },
        on: vi.fn((event: string, listener: typeof willDownloadListener.current) => {
          if (event === "will-download") willDownloadListener.current = listener;
        }),
        removeListener: vi.fn(),
      },
      fromId: vi.fn(),
      webContentsViewConstructor: vi.fn(),
      willDownloadListener,
    };
  },
);
vi.mock("electron", () => ({
  app: {
    getName: () => "Synara",
    getPreferredSystemLanguages: () => ["en-US"],
    userAgentFallback: "Mozilla/5.0 Electron/40.0.0",
  },
  BrowserWindow: class {},
  clipboard: { writeImage: vi.fn(), writeText: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  session: {
    fromPartition: () => browserSession,
  },
  webContents: { fromId },
  WebContentsView: class {
    constructor() {
      return webContentsViewConstructor();
    }
  },
}));

import { DesktopBrowserManager } from "../browserManager";
import { dispatchTrustedClick } from "./trustedInput";

const THREAD_ID = ThreadId.makeUnsafe("thread-visible-runtime");

class FakeWebContents extends EventEmitter {
  constructor(readonly id = 17) {
    super();
  }
  readonly debugger = {
    isAttached: () => false,
    detach: vi.fn(),
  };
  isDestroyed = () => false;
  setUserAgent = vi.fn();
  windowOpenHandler:
    | ((details: { url: string; frameName: string; features: string; disposition: string }) => {
        action: "allow" | "deny";
      })
    | undefined;
  setWindowOpenHandler = vi.fn((handler: NonNullable<FakeWebContents["windowOpenHandler"]>) => {
    this.windowOpenHandler = handler;
  });
  getURL = () => "https://example.test/";
  getTitle = () => "Example";
  isLoading = () => false;
  canGoBack = () => false;
  canGoForward = () => false;
  close = vi.fn();
  loadURL = vi.fn(() => Promise.resolve());
  setZoomFactor = vi.fn();
}

describe("DesktopBrowserManager automation runtime boundary", () => {
  it("applies explicit page zoom to native and renderer guests, then resets it on hide", () => {
    const nativeWebContents = new FakeWebContents(101);
    const nativeView = {
      webContents: nativeWebContents,
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      setBorderRadius: vi.fn(),
    };
    webContentsViewConstructor.mockReturnValueOnce(nativeView);

    const nativeManager = new DesktopBrowserManager();
    nativeManager.setWindow({
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    } as never);
    nativeManager.open({ threadId: THREAD_ID });
    nativeManager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "native",
      bounds: { x: 0, y: 0, width: 480, height: 340 },
      pageZoomFactor: 0.375,
    });
    expect(nativeWebContents.setZoomFactor).toHaveBeenLastCalledWith(0.375);

    nativeManager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "native",
      bounds: { x: 0, y: 0, width: 640, height: 340 },
      pageZoomFactor: 0.5,
    });
    expect(nativeWebContents.setZoomFactor).toHaveBeenLastCalledWith(0.5);

    nativeManager.hide({ threadId: THREAD_ID });
    expect(nativeWebContents.setZoomFactor).toHaveBeenLastCalledWith(1);
    nativeManager.dispose();

    const rendererWebContents = Object.assign(new FakeWebContents(102), {
      getType: () => "webview",
      hostWebContents: { id: 41 },
      session: browserSession,
      debugger: { isAttached: () => false, detach: vi.fn() },
    });
    fromId.mockReturnValue(rendererWebContents);
    const rendererManager = new DesktopBrowserManager();
    const state = rendererManager.open({ threadId: THREAD_ID });
    const tabId = state.activeTabId!;
    rendererManager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: 102 }, 41);
    rendererManager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "renderer",
      bounds: { x: 0, y: 0, width: 480, height: 340 },
      pageZoomFactor: 0.375,
    });
    expect(rendererWebContents.setZoomFactor).toHaveBeenLastCalledWith(0.375);

    rendererManager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "renderer",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    expect(rendererWebContents.setZoomFactor).toHaveBeenLastCalledWith(1);
    rendererManager.dispose();
  });

  it("demotes a native runtime to renderer when the floating surface claims the tab", () => {
    const nativeWebContents = new FakeWebContents(201);
    const nativeView = {
      webContents: nativeWebContents,
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      setBorderRadius: vi.fn(),
    };
    webContentsViewConstructor.mockReturnValueOnce(nativeView);

    const manager = new DesktopBrowserManager();
    const hostWindow = {
      webContents: Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false }),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    };
    manager.setWindow(hostWindow as never);
    const opened = manager.open({ threadId: THREAD_ID });
    manager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "native",
      bounds: { x: 20, y: 40, width: 800, height: 600 },
    });
    expect(nativeWebContents.close).not.toHaveBeenCalled();

    manager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "renderer",
      bounds: { x: 40, y: 80, width: 320, height: 220 },
    });
    expect(nativeWebContents.close).not.toHaveBeenCalled();
    expect(nativeView.setVisible).toHaveBeenCalledWith(false);
    const next = manager.getState({ threadId: THREAD_ID });
    expect(next.tabs.find((tab) => tab.id === opened.activeTabId)?.runtimeSurface).toBe("renderer");

    const guest = Object.assign(new FakeWebContents(202), {
      getType: () => "webview",
      hostWebContents: hostWindow.webContents,
      session: browserSession,
    });
    fromId.mockReturnValue(guest);
    manager.attachWebview(
      { threadId: THREAD_ID, tabId: opened.activeTabId!, webContentsId: 202 },
      41,
    );
    expect(nativeWebContents.close).toHaveBeenCalled();
    expect(
      manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId: opened.activeTabId! })
        .webContents,
    ).toBe(guest);
    manager.dispose();
  });

  it("adopts a renderer guest even when attach races ahead of bounds promotion", () => {
    const nativeWebContents = new FakeWebContents(211);
    const nativeView = {
      webContents: nativeWebContents,
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      setBorderRadius: vi.fn(),
    };
    webContentsViewConstructor.mockReturnValueOnce(nativeView);

    const manager = new DesktopBrowserManager();
    const hostWindow = {
      webContents: Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false }),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    };
    manager.setWindow(hostWindow as never);
    const opened = manager.open({ threadId: THREAD_ID });
    manager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "native",
      bounds: { x: 20, y: 40, width: 800, height: 600 },
    });

    const guest = Object.assign(new FakeWebContents(212), {
      getType: () => "webview",
      hostWebContents: hostWindow.webContents,
      session: browserSession,
    });
    fromId.mockReturnValue(guest);
    const attached = manager.attachWebview(
      { threadId: THREAD_ID, tabId: opened.activeTabId!, webContentsId: 212 },
      41,
    );
    expect(attached.tabs.find((tab) => tab.id === opened.activeTabId)?.runtimeSurface).toBe(
      "renderer",
    );
    expect(nativeWebContents.close).toHaveBeenCalled();
    expect(
      manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId: opened.activeTabId! })
        .webContents,
    ).toBe(guest);
    manager.dispose();
  });

  it("creates a native background runtime after the renderer guest detaches", async () => {
    const manager = new DesktopBrowserManager();
    const hostWindow = {
      webContents: Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false }),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    };
    manager.setWindow(hostWindow as never);
    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId!;
    const guest = Object.assign(new FakeWebContents(213), {
      getType: () => "webview",
      hostWebContents: hostWindow.webContents,
      session: browserSession,
    });
    fromId.mockReturnValue(guest);
    manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: 213 }, 41);
    manager.selectAutomationTab({ threadId: THREAD_ID, tabId });
    manager.detachWebview({ threadId: THREAD_ID, tabId, webContentsId: 213 });

    const backgroundWebContents = new FakeWebContents(214);
    webContentsViewConstructor.mockReturnValueOnce({
      webContents: backgroundWebContents,
      setBounds: vi.fn(),
      setVisible: vi.fn(),
    });
    const runtime = await manager.getAutomationRuntime(
      { threadId: THREAD_ID, tabId },
      { restore: false },
    );
    expect(runtime.webContents).toBe(backgroundWebContents);
    expect(manager.getState({ threadId: THREAD_ID }).tabs[0]?.runtimeSurface).toBe("native");
    manager.dispose();
  });

  it("keeps the adopted renderer guest when agent tools claim the tab", async () => {
    const manager = new DesktopBrowserManager();
    const hostWindow = {
      webContents: Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false }),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    };
    manager.setWindow(hostWindow as never);
    const state = manager.open({ threadId: THREAD_ID });
    const tabId = state.activeTabId!;
    const guest = Object.assign(new FakeWebContents(203), {
      getType: () => "webview",
      hostWebContents: hostWindow.webContents,
      session: browserSession,
    });
    fromId.mockReturnValue(guest);
    manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: 203 }, 41);
    manager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "renderer",
      bounds: { x: 40, y: 80, width: 320, height: 220 },
    });

    manager.selectAutomationTab({ threadId: THREAD_ID, tabId });
    const runtime = await manager.getAutomationRuntime({ threadId: THREAD_ID, tabId });

    expect(runtime.webContents).toBe(guest);
    expect(guest.close).not.toHaveBeenCalled();
    expect(manager.getState({ threadId: THREAD_ID }).tabs[0]?.runtimeSurface).toBe("renderer");
    manager.dispose();
  });

  it("refuses a detached native fallback and returns an adopted renderer webview", () => {
    const manager = new DesktopBrowserManager();
    const state = manager.open({ threadId: THREAD_ID });
    const tabId = state.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const webContents = new FakeWebContents();
    const access = manager as unknown as {
      runtimes: Map<
        string,
        {
          key: string;
          threadId: typeof THREAD_ID;
          tabId: string;
          webContents: WebContents;
          view: object | null;
          ownsWebContents: boolean;
          listenerDisposers: Array<() => void>;
        }
      >;
    };
    const key = `${THREAD_ID}:${tabId}`;
    access.runtimes.set(key, {
      key,
      threadId: THREAD_ID,
      tabId,
      webContents: webContents as unknown as WebContents,
      view: {},
      ownsWebContents: true,
      listenerDisposers: [],
    });

    expect(() => manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId })).toThrow(
      /not currently visible/i,
    );

    access.runtimes.set(key, {
      key,
      threadId: THREAD_ID,
      tabId,
      webContents: webContents as unknown as WebContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    expect(manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId }).webContents).toBe(
      webContents,
    );
  });

  it("marks prepared agent tabs for a persistent native runtime", () => {
    const manager = new DesktopBrowserManager();
    const state = manager.prepareAutomationTab({
      threadId: THREAD_ID,
      url: "https://example.test",
      reuse: false,
    });

    expect(state.open).toBe(true);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs.at(-1)?.id);
    expect(state.tabs[0]?.runtimeSurface).toBe("native");
    expect(() =>
      manager.getVisibleAutomationRuntime({
        threadId: THREAD_ID,
        tabId: state.activeTabId!,
      }),
    ).toThrow(/not ready yet/i);
  });

  it("adopts only a webview owned by the exact Synara window and browser partition", () => {
    const manager = new DesktopBrowserManager();
    const state = manager.open({ threadId: THREAD_ID });
    const tabId = state.activeTabId!;
    const guest = Object.assign(new FakeWebContents(), {
      getType: () => "webview",
      hostWebContents: { id: 41 },
      session: browserSession,
    });
    fromId.mockReturnValue(guest);

    expect(
      manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: guest.id }, 41),
    ).toMatchObject({ activeTabId: tabId });
    expect(manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId }).webContents).toBe(
      guest,
    );

    fromId.mockReturnValue({ ...guest, getType: () => "window" });
    expect(() =>
      manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: guest.id }, 41),
    ).toThrow(/does not belong/i);
    fromId.mockReturnValue({ ...guest, hostWebContents: { id: 99 } });
    expect(() =>
      manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: guest.id }, 41),
    ).toThrow(/does not belong/i);
    fromId.mockReturnValue({ ...guest, session: {} });
    expect(() =>
      manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: guest.id }, 41),
    ).toThrow(/does not belong/i);
  });

  it("routes automation only after the adopted renderer guest is the visible panel surface", () => {
    const manager = new DesktopBrowserManager();
    const hostWindow = {
      webContents: Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false }),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    };
    manager.setWindow(hostWindow as never);
    const state = manager.open({ threadId: THREAD_ID });
    const tabId = state.activeTabId!;
    const guest = Object.assign(new FakeWebContents(), {
      getType: () => "webview",
      hostWebContents: hostWindow.webContents,
      session: browserSession,
    });
    fromId.mockReturnValue(guest);

    manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: guest.id }, 41);
    expect(() => manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId })).toThrow(
      /not currently visible/i,
    );

    manager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "renderer",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    expect(manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId }).webContents).toBe(
      guest,
    );

    // Overlay occlusion used to send bounds:null; the adopted <webview> must
    // stay the visible automation surface so resize/drag does not drop CDP.
    manager.setPanelBounds({ threadId: THREAD_ID, surface: "renderer", bounds: null });
    expect(manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId }).webContents).toBe(
      guest,
    );
  });

  it("rejects stale or duplicate renderer bindings instead of stealing visible tab affinity", () => {
    const manager = new DesktopBrowserManager();
    const state = manager.open({ threadId: THREAD_ID });
    const tabId = state.activeTabId!;
    const firstGuest = Object.assign(new FakeWebContents(17), {
      getType: () => "webview",
      hostWebContents: { id: 41 },
      session: browserSession,
    });
    const duplicateGuest = Object.assign(new FakeWebContents(18), {
      getType: () => "webview",
      hostWebContents: { id: 41 },
      session: browserSession,
    });
    fromId.mockReturnValue(firstGuest);
    manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: firstGuest.id }, 41);

    fromId.mockReturnValue(duplicateGuest);
    expect(() =>
      manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: duplicateGuest.id }, 41),
    ).toThrow(/already attached to another visible webview/i);
    expect(manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId }).webContents).toBe(
      firstGuest,
    );

    const second = manager.newTab({
      threadId: THREAD_ID,
      url: "https://second.example/",
    });
    const secondTabId = second.activeTabId!;
    expect(() =>
      manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: duplicateGuest.id }, 41),
    ).toThrow(/active tab/i);
    expect(secondTabId).not.toBe(tabId);
  });

  it("keeps the CDP session when one renderer webview is rebound to another tab", () => {
    const manager = new DesktopBrowserManager();
    const first = manager.open({ threadId: THREAD_ID });
    const firstTabId = first.activeTabId!;
    const detachDebugger = vi.fn();
    const guest = Object.assign(new FakeWebContents(), {
      debugger: { isAttached: () => true, detach: detachDebugger },
      getType: () => "webview",
      hostWebContents: { id: 41 },
      session: browserSession,
    });
    fromId.mockReturnValue(guest);
    manager.attachWebview(
      {
        threadId: THREAD_ID,
        tabId: firstTabId,
        webContentsId: guest.id,
      },
      41,
    );

    const second = manager.newTab({
      threadId: THREAD_ID,
      url: "https://second.example/",
    });
    const secondTabId = second.activeTabId!;
    manager.attachWebview(
      {
        threadId: THREAD_ID,
        tabId: secondTabId,
        webContentsId: guest.id,
      },
      41,
    );

    expect(detachDebugger).not.toHaveBeenCalled();
    expect(
      manager.getVisibleAutomationRuntime({
        threadId: THREAD_ID,
        tabId: secondTabId,
      }).webContents,
    ).toBe(guest);
  });

  it("detaches CDP and defers publication before removing the final renderer webview", async () => {
    const manager = new DesktopBrowserManager();
    const state = manager.open({ threadId: THREAD_ID });
    const tabId = state.activeTabId!;
    const detachDebugger = vi.fn();
    const guest = Object.assign(new FakeWebContents(), {
      debugger: { isAttached: () => true, detach: detachDebugger },
      getType: () => "webview",
      hostWebContents: { id: 41 },
      session: browserSession,
    });
    fromId.mockReturnValue(guest);
    manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: guest.id }, 41);
    const publication = vi.fn();
    manager.subscribe(publication);

    manager.closeAutomationTab({ threadId: THREAD_ID, tabId });

    expect(detachDebugger).toHaveBeenCalledOnce();
    expect(guest.close).not.toHaveBeenCalled();
    expect(guest.loadURL).not.toHaveBeenCalled();
    expect(publication).not.toHaveBeenCalled();
    expect(manager.getState({ threadId: THREAD_ID })).toMatchObject({
      activeTabId: null,
      tabs: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(guest.loadURL).toHaveBeenCalledWith("about:blank");
    expect(publication).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTabId: null,
        tabs: [],
      }),
    );
  });

  it("projects navigation from the blank launcher before a renderer guest attaches", () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.prepareAutomationTab({
      threadId: THREAD_ID,
      reuse: true,
    });
    const tabId = opened.activeTabId!;

    const projected = manager.prepareAutomationNavigation({
      threadId: THREAD_ID,
      tabId,
      url: "https://docs.example/path",
    });

    expect(projected.activeTabId).toBe(tabId);
    expect(projected.tabs[0]?.url).toBe("https://docs.example/path");
    expect(() => manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId })).toThrow(
      /not ready yet/i,
    );
  });

  it("separates dedicated agent projection from manual browser control epochs", () => {
    const manager = new DesktopBrowserManager();
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = prepared.activeTabId!;
    manager.prepareAutomationNavigation({
      threadId: THREAD_ID,
      tabId,
      url: "https://agent.example",
    });
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(0);

    // Mounting BrowserPanel hydrates the state already projected by the agent;
    // it is not a physical/manual browser action.
    manager.open({ threadId: THREAD_ID });
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(0);

    manager.navigate({ threadId: THREAD_ID, tabId, url: "https://human.example" });
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(1);
  });

  it("does not republish browser state when automation reselects the already active tab", () => {
    const manager = new DesktopBrowserManager();
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = prepared.activeTabId!;
    const publication = vi.fn();
    manager.subscribe(publication);

    const selected = manager.selectAutomationTab({ threadId: THREAD_ID, tabId });

    expect(selected.version).toBe(prepared.version);
    expect(publication).not.toHaveBeenCalled();
  });

  it("still treats hiding a manual browser panel as human takeover", () => {
    const manager = new DesktopBrowserManager();
    manager.open({ threadId: THREAD_ID });
    const beforeHide = manager.getAutomationHumanControlEpoch(THREAD_ID);

    manager.hide({ threadId: THREAD_ID });

    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(beforeHide + 1);
  });

  it("publishes direct native keyboard and mouse takeover from the visible guest", () => {
    const manager = new DesktopBrowserManager();
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = prepared.activeTabId!;
    const webContents = new FakeWebContents();
    const runtime = {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: webContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [] as Array<() => void>,
    };
    (
      manager as unknown as { configureRuntimeWebContents(value: typeof runtime): void }
    ).configureRuntimeWebContents(runtime);
    const takeover = vi.fn();
    const unsubscribe = manager.subscribeAutomationHumanControl(THREAD_ID, takeover);

    webContents.emit(
      "before-input-event",
      { preventDefault: vi.fn() },
      {
        type: "keyDown",
        key: "a",
        meta: false,
        control: false,
        shift: false,
        alt: false,
      },
    );
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(1);
    expect(takeover).toHaveBeenCalledTimes(1);

    webContents.emit("before-mouse-event", {}, { type: "mouseMove", x: 10, y: 10 });
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(1);
    webContents.emit(
      "before-mouse-event",
      {},
      {
        type: "mouseDown",
        button: "left",
        x: 10,
        y: 10,
      },
    );
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(2);
    expect(takeover).toHaveBeenCalledTimes(2);

    unsubscribe();
    webContents.emit("before-mouse-event", {}, { type: "mouseWheel", x: 10, y: 10 });
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(3);
    expect(takeover).toHaveBeenCalledTimes(2);
  });

  it("consumes only the exact short-lived native inputs registered by browser automation", () => {
    const manager = new DesktopBrowserManager();
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = prepared.activeTabId!;
    const webContents = new FakeWebContents();
    const runtime = {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: webContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [] as Array<() => void>,
    };
    const access = manager as unknown as {
      runtimes: Map<string, typeof runtime>;
      configureRuntimeWebContents(value: typeof runtime): void;
    };
    access.runtimes.set(runtime.key, runtime);
    access.configureRuntimeWebContents(runtime);
    const visible = manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId });

    const releaseKey = visible.expectAgentInput!({
      kind: "key",
      key: "a",
      alt: false,
      control: false,
      meta: false,
      shift: false,
    });
    webContents.emit(
      "before-input-event",
      { preventDefault: vi.fn() },
      {
        type: "keyDown",
        key: "a",
        meta: false,
        control: false,
        shift: false,
        alt: false,
      },
    );
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(0);
    releaseKey();

    const releasePointer = visible.expectAgentInput!({
      kind: "mouse",
      type: "mouseDown",
      button: "left",
      x: 40,
      y: 50,
    });
    webContents.emit(
      "before-mouse-event",
      {},
      {
        type: "mouseDown",
        button: "left",
        x: 40.4,
        y: 49.6,
      },
    );
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(0);
    releasePointer();

    // A different key and a click outside the coordinate tolerance remain
    // unambiguously human, even while another expected input is pending.
    const releaseUnmatched = visible.expectAgentInput!({
      kind: "key",
      key: "x",
      alt: false,
      control: false,
      meta: false,
      shift: false,
    });
    webContents.emit(
      "before-input-event",
      { preventDefault: vi.fn() },
      {
        type: "keyDown",
        key: "y",
        meta: false,
        control: false,
        shift: false,
        alt: false,
      },
    );
    webContents.emit(
      "before-mouse-event",
      {},
      {
        type: "mouseDown",
        button: "left",
        x: 400,
        y: 500,
      },
    );
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(2);
    releaseUnmatched();
  });

  it("keeps an agent-owned native runtime when its tab is reselected", async () => {
    const manager = new DesktopBrowserManager();
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = prepared.activeTabId!;
    const nativeWebContents = new FakeWebContents();
    const nativeRuntime = {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: nativeWebContents as unknown as WebContents,
      view: {},
      ownsWebContents: true as const,
      listenerDisposers: [] as Array<() => void>,
    };
    const access = manager as unknown as {
      runtimes: Map<string, typeof nativeRuntime>;
    };
    access.runtimes.set(nativeRuntime.key, nativeRuntime);

    manager.selectAutomationTab({ threadId: THREAD_ID, tabId });
    const acquired = await manager.getAutomationRuntime({ threadId: THREAD_ID, tabId });

    expect(acquired.webContents).toBe(nativeWebContents);
    expect(nativeWebContents.close).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("contains delayed agent downloads until human control advances the runtime epoch", () => {
    const manager = new DesktopBrowserManager();
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = prepared.activeTabId!;
    const webContents = new FakeWebContents();
    const runtime = {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: webContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [] as Array<() => void>,
    };
    const access = manager as unknown as {
      runtimes: Map<string, typeof runtime>;
      automationSideEffectProvenanceByRuntimeKey: Map<string, unknown>;
      configureRuntimeWebContents(value: typeof runtime): void;
    };
    access.runtimes.set(runtime.key, runtime);
    access.configureRuntimeWebContents(runtime);
    const observed = vi.fn();
    const release = manager.trackAutomationDownload({ threadId: THREAD_ID, tabId }, observed);
    const agentEvent = { preventDefault: vi.fn() };

    willDownloadListener.current?.(agentEvent, {}, webContents);

    expect(agentEvent.preventDefault).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith({ threadId: THREAD_ID, sourceTabId: tabId });
    expect(agentEvent.preventDefault.mock.invocationCallOrder[0]).toBeLessThan(
      observed.mock.invocationCallOrder[0]!,
    );

    const foreignEvent = { preventDefault: vi.fn() };
    willDownloadListener.current?.(foreignEvent, {}, new FakeWebContents(99));
    expect(foreignEvent.preventDefault).not.toHaveBeenCalled();

    release();
    expect(access.automationSideEffectProvenanceByRuntimeKey.size).toBe(1);
    const delayedAgentEvent = { preventDefault: vi.fn() };
    willDownloadListener.current?.(delayedAgentEvent, {}, webContents);
    expect(delayedAgentEvent.preventDefault).toHaveBeenCalledOnce();
    // The live host listener has ended, but containment provenance remains.
    expect(observed).toHaveBeenCalledOnce();

    webContents.emit(
      "before-mouse-event",
      {},
      {
        type: "mouseDown",
        button: "left",
        x: 200,
        y: 200,
      },
    );
    const afterHumanTakeoverEvent = { preventDefault: vi.fn() };
    willDownloadListener.current?.(afterHumanTakeoverEvent, {}, webContents);
    expect(afterHumanTakeoverEvent.preventDefault).not.toHaveBeenCalled();
    expect(access.automationSideEffectProvenanceByRuntimeKey.size).toBe(0);

    const releaseSecondAction = manager.trackAutomationDownload(
      { threadId: THREAD_ID, tabId },
      vi.fn(),
    );
    releaseSecondAction();
    expect(access.automationSideEffectProvenanceByRuntimeKey.size).toBe(1);
    manager.closeAutomationTab({ threadId: THREAD_ID, tabId });
    expect(access.automationSideEffectProvenanceByRuntimeKey.size).toBe(0);

    manager.dispose();
    expect(browserSession.removeListener).toHaveBeenCalledWith(
      "will-download",
      expect.any(Function),
    );
  });

  it("does not classify a native mouseDown delivered after CDP acknowledges the click as human", async () => {
    const manager = new DesktopBrowserManager();
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = prepared.activeTabId!;
    const webContents = new FakeWebContents();
    const sendCommand = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
        setImmediate(() => {
          webContents.emit(
            "before-mouse-event",
            {},
            {
              type: "mouseDown",
              button: params.button,
              x: params.x,
              y: params.y,
            },
          );
        });
      }
      return {};
    });
    Object.assign(webContents, {
      debugger: Object.assign(new EventEmitter(), {
        isAttached: () => true,
        detach: vi.fn(),
        sendCommand,
      }),
    });
    const runtime = {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: webContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [] as Array<() => void>,
    };
    const access = manager as unknown as {
      runtimes: Map<string, typeof runtime>;
      configureRuntimeWebContents(value: typeof runtime): void;
    };
    access.runtimes.set(runtime.key, runtime);
    access.configureRuntimeWebContents(runtime);
    const visible = manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId });

    await dispatchTrustedClick(visible, { x: 320, y: 48 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(0);

    // The expected native signal is one-shot. A second otherwise identical
    // click is genuine human input and must still interrupt automation.
    webContents.emit(
      "before-mouse-event",
      {},
      {
        type: "mouseDown",
        button: "left",
        x: 320,
        y: 48,
      },
    );
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(1);
  });

  it("expires a released native-input correlation instead of masking a later matching click", () => {
    const dateNow = vi.spyOn(Date, "now");
    let now = 10_000;
    dateNow.mockImplementation(() => now);
    try {
      const manager = new DesktopBrowserManager();
      const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
      const tabId = prepared.activeTabId!;
      const webContents = new FakeWebContents();
      const runtime = {
        key: `${THREAD_ID}:${tabId}`,
        threadId: THREAD_ID,
        tabId,
        webContents: webContents as unknown as WebContents,
        view: null,
        ownsWebContents: false as const,
        listenerDisposers: [] as Array<() => void>,
      };
      const access = manager as unknown as {
        runtimes: Map<string, typeof runtime>;
        configureRuntimeWebContents(value: typeof runtime): void;
      };
      access.runtimes.set(runtime.key, runtime);
      access.configureRuntimeWebContents(runtime);
      const visible = manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId });
      const release = visible.expectAgentInput!({
        kind: "mouse",
        type: "mouseDown",
        button: "left",
        x: 320,
        y: 48,
      });

      release();
      now += 101;
      webContents.emit(
        "before-mouse-event",
        {},
        {
          type: "mouseDown",
          button: "left",
          x: 320,
          y: 48,
        },
      );

      expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(1);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("routes an agent-triggered target=_blank tab after the native handler returns", async () => {
    const manager = new DesktopBrowserManager();
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const sourceTabId = prepared.activeTabId!;
    const webContents = new FakeWebContents();
    const runtime = {
      key: `${THREAD_ID}:${sourceTabId}`,
      threadId: THREAD_ID,
      tabId: sourceTabId,
      webContents: webContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [] as Array<() => void>,
    };
    const access = manager as unknown as {
      runtimes: Map<string, typeof runtime>;
      configureRuntimeWebContents(value: typeof runtime): void;
    };
    access.runtimes.set(runtime.key, runtime);
    access.configureRuntimeWebContents(runtime);
    const visible = manager.getVisibleAutomationRuntime({
      threadId: THREAD_ID,
      tabId: sourceTabId,
    });
    const releaseGesture = visible.expectAgentInput!({
      kind: "mouse",
      type: "mouseDown",
      button: "left",
      x: 10,
      y: 20,
    });
    const windowOpenEvents: Array<{ kind: string; openedTabId: string | null }> = [];
    const releaseWindowOpenTracking = manager.trackAutomationWindowOpen(
      { threadId: THREAD_ID, tabId: sourceTabId },
      (event) => {
        windowOpenEvents.push(event);
      },
    );
    // CDP can acknowledge mouseReleased before Electron delivers its
    // setWindowOpenHandler callback. The correlation lease must bridge that gap.
    releaseGesture();

    let windowOpenHandlerReturned = false;
    const reentrantStateEmission = vi.fn();
    const openedTabStateEmission = vi.fn();
    manager.subscribe((state) => {
      if (state.tabs.length <= 1) return;
      openedTabStateEmission();
      if (!windowOpenHandlerReturned) reentrantStateEmission();
    });
    expect(
      webContents.windowOpenHandler?.({
        url: "https://opened.example/path",
        frameName: "",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    windowOpenHandlerReturned = true;
    expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(1);

    // Duplicate native callbacks from the same activation are coalesced.
    webContents.windowOpenHandler?.({
      url: "https://opened.example/path",
      frameName: "",
      features: "",
      disposition: "foreground-tab",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(1);
    expect(windowOpenEvents).toEqual([
      expect.objectContaining({
        kind: "tab",
        sourceTabId,
        threadId: THREAD_ID,
      }),
    ]);
    releaseWindowOpenTracking();
    const afterAgentOpen = manager.getState({ threadId: THREAD_ID });
    expect(afterAgentOpen.tabs).toHaveLength(2);
    expect(afterAgentOpen.activeTabId).not.toBe(sourceTabId);
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(0);
    expect(windowOpenEvents).toEqual([
      {
        kind: "tab",
        openedTabId: afterAgentOpen.activeTabId,
        sourceTabId,
        threadId: THREAD_ID,
      },
    ]);
    expect(openedTabStateEmission).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(openedTabStateEmission).toHaveBeenCalledOnce();
    expect(reentrantStateEmission).not.toHaveBeenCalled();

    webContents.windowOpenHandler?.({
      url: "https://manual.example/path",
      frameName: "",
      features: "",
      disposition: "foreground-tab",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(1);
  });

  it("reports an agent-opened OAuth popup without converting it into a tab", () => {
    const manager = new DesktopBrowserManager();
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const sourceTabId = prepared.activeTabId!;
    const webContents = new FakeWebContents();
    const runtime = {
      key: `${THREAD_ID}:${sourceTabId}`,
      threadId: THREAD_ID,
      tabId: sourceTabId,
      webContents: webContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [] as Array<() => void>,
    };
    const access = manager as unknown as {
      runtimes: Map<string, typeof runtime>;
      configureRuntimeWebContents(value: typeof runtime): void;
    };
    access.runtimes.set(runtime.key, runtime);
    access.configureRuntimeWebContents(runtime);
    const observed = vi.fn();
    const release = manager.trackAutomationWindowOpen(
      { threadId: THREAD_ID, tabId: sourceTabId },
      observed,
    );

    expect(
      webContents.windowOpenHandler?.({
        url: "https://accounts.google.com/o/oauth2/auth",
        frameName: "_blank",
        features: "width=480,height=640",
        disposition: "foreground-tab",
      }),
    ).toMatchObject({ action: "allow" });
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      sourceTabId,
      kind: "popup",
      openedTabId: null,
    });
    expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(1);
    expect(manager.getState({ threadId: THREAD_ID }).activeTabId).toBe(sourceTabId);

    release();
    manager.dispose();
  });

  it("cancels a deferred window-open when its source tab or manager is torn down", async () => {
    for (const teardown of ["tab", "manager"] as const) {
      const manager = new DesktopBrowserManager();
      const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
      const sourceTabId = prepared.activeTabId!;
      const webContents = new FakeWebContents();
      const runtime = {
        key: `${THREAD_ID}:${sourceTabId}`,
        threadId: THREAD_ID,
        tabId: sourceTabId,
        webContents: webContents as unknown as WebContents,
        view: null,
        ownsWebContents: false as const,
        listenerDisposers: [] as Array<() => void>,
      };
      const access = manager as unknown as {
        runtimes: Map<string, typeof runtime>;
        pendingWindowOpenTasksByRuntimeKey: Map<string, unknown>;
        pendingAutomationWindowOpenCommitsByRuntimeKey: Map<string, unknown>;
        states: Map<typeof THREAD_ID, unknown>;
        configureRuntimeWebContents(value: typeof runtime): void;
      };
      access.runtimes.set(runtime.key, runtime);
      access.configureRuntimeWebContents(runtime);
      const opened = vi.fn();
      const releaseTracking = manager.trackAutomationWindowOpen(
        { threadId: THREAD_ID, tabId: sourceTabId },
        opened,
      );

      webContents.windowOpenHandler?.({
        url: "https://stale.example/",
        frameName: "",
        features: "",
        disposition: "foreground-tab",
      });
      expect(access.pendingWindowOpenTasksByRuntimeKey.size).toBe(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(access.pendingWindowOpenTasksByRuntimeKey.size).toBe(0);
      expect(access.pendingAutomationWindowOpenCommitsByRuntimeKey.size).toBe(1);
      expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(1);
      if (teardown === "tab") {
        manager.closeAutomationTab({ threadId: THREAD_ID, tabId: sourceTabId });
      } else {
        manager.dispose();
      }
      expect(access.pendingWindowOpenTasksByRuntimeKey.size).toBe(0);
      expect(access.pendingAutomationWindowOpenCommitsByRuntimeKey.size).toBe(0);

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(opened).toHaveBeenCalledOnce();
      if (teardown === "tab") {
        expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(0);
      } else {
        expect(access.states.size).toBe(0);
      }
      releaseTracking();
    }
  });

  it("creates a persistent native runtime without mounting the owning chat", async () => {
    webContentsViewConstructor.mockClear();
    const nativeWebContents = new FakeWebContents();
    const setBounds = vi.fn();
    webContentsViewConstructor.mockReturnValueOnce({
      webContents: nativeWebContents,
      setBounds,
    });
    const manager = new DesktopBrowserManager();
    const blank = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = blank.activeTabId!;
    manager.prepareAutomationNavigation({
      threadId: THREAD_ID,
      tabId,
      url: "https://agent.example/path",
    });
    const runtime = await manager.getAutomationRuntime(
      { threadId: THREAD_ID, tabId },
      { restore: false },
    );

    expect(webContentsViewConstructor).toHaveBeenCalledOnce();
    expect(runtime.webContents).toBe(nativeWebContents);
    expect(setBounds).toHaveBeenCalledWith({ x: -10_000, y: 0, width: 1_280, height: 800 });
    expect(manager.getState({ threadId: THREAD_ID }).tabs[0]?.runtimeSurface).toBe("native");
    manager.dispose();
  });

  it("does not race host navigation when the owning panel reveals first", async () => {
    const nativeWebContents = Object.assign(new FakeWebContents(), { getURL: () => "" });
    webContentsViewConstructor.mockReturnValueOnce({
      webContents: nativeWebContents,
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      setBorderRadius: vi.fn(),
    });
    const manager = new DesktopBrowserManager();
    manager.setWindow({
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    } as never);
    const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = prepared.activeTabId!;
    manager.prepareAutomationNavigation({
      threadId: THREAD_ID,
      tabId,
      url: "https://agent.example/path",
    });

    manager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "native",
      bounds: { x: 0, y: 40, width: 900, height: 700 },
    });

    expect(nativeWebContents.loadURL).not.toHaveBeenCalled();
    expect(manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId }).webContents).toBe(
      nativeWebContents,
    );
    await manager.getAutomationRuntime({ threadId: THREAD_ID, tabId }, { restore: false });
    expect(nativeWebContents.loadURL).toHaveBeenCalledOnce();
    expect(nativeWebContents.loadURL).toHaveBeenCalledWith("about:blank");
    manager.dispose();
  });

  it("does not suspend the active agent tab when its chat stays hidden", async () => {
    vi.useFakeTimers();
    try {
      const nativeWebContents = new FakeWebContents();
      webContentsViewConstructor.mockReturnValueOnce({
        webContents: nativeWebContents,
        setBounds: vi.fn(),
      });
      const manager = new DesktopBrowserManager();
      const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
      const tabId = prepared.activeTabId!;

      await manager.getAutomationRuntime({ threadId: THREAD_ID, tabId }, { restore: false });
      manager.hide({ threadId: THREAD_ID });
      await vi.runAllTimersAsync();

      expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(0);
      expect(nativeWebContents.close).not.toHaveBeenCalled();
      expect(manager.getState({ threadId: THREAD_ID }).tabs[0]).toMatchObject({
        id: tabId,
        runtimeSurface: "native",
        status: "live",
      });
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds hidden automation runtimes globally and restores an evicted tab on demand", async () => {
    vi.useFakeTimers();
    try {
      const nativeWebContents = Array.from(
        { length: 6 },
        (_, index) => new FakeWebContents(100 + index),
      );
      for (const webContents of nativeWebContents) {
        webContentsViewConstructor.mockReturnValueOnce({
          webContents,
          setBounds: vi.fn(),
          setVisible: vi.fn(),
          setBorderRadius: vi.fn(),
        });
      }

      const manager = new DesktopBrowserManager();
      const tabs = [] as Array<{ threadId: ThreadId; tabId: string }>;
      for (let index = 0; index < 5; index += 1) {
        const threadId = ThreadId.makeUnsafe(`thread-background-${index}`);
        const prepared = manager.prepareAutomationTab({ threadId, reuse: true });
        const tabId = prepared.activeTabId!;
        tabs.push({ threadId, tabId });
        await manager.getAutomationRuntime({ threadId, tabId }, { restore: false });
      }

      // Active browser calls receive a full tool-deadline grace period. Once it
      // expires, the least-recently-used hidden page is evicted to enforce the cap.
      expect(nativeWebContents.every((webContents) => !webContents.close.mock.calls.length)).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(31_001);

      expect(nativeWebContents[0]!.close).toHaveBeenCalledOnce();
      expect(
        nativeWebContents.slice(1, 5).every((webContents) => !webContents.close.mock.calls.length),
      ).toBe(true);
      expect(manager.getState({ threadId: tabs[0]!.threadId }).tabs[0]?.status).toBe("suspended");

      const restored = await manager.getAutomationRuntime(tabs[0]!, { restore: false });
      expect(restored.webContents).toBe(nativeWebContents[5]);
      expect(manager.getState({ threadId: tabs[0]!.threadId }).tabs[0]?.status).toBe("live");
      // Restoring the evicted tab keeps the total at four by evicting the next LRU page.
      expect(nativeWebContents[1]!.close).toHaveBeenCalledOnce();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
