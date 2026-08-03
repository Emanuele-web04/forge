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
        webRequest: { onBeforeSendHeaders: vi.fn() },
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
      webContentsViewConstructor();
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
}

describe("DesktopBrowserManager automation runtime boundary", () => {
  it("refuses a native fallback and returns only an adopted renderer webview", () => {
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
      /refuses a native or fallback/i,
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

  it("prepares a renderer tab without constructing a WebContentsView fallback", () => {
    const manager = new DesktopBrowserManager();
    const state = manager.prepareAutomationTab({
      threadId: THREAD_ID,
      url: "https://example.test",
      reuse: false,
    });

    expect(state.open).toBe(true);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs.at(-1)?.id);
    expect(() =>
      manager.getVisibleAutomationRuntime({
        threadId: THREAD_ID,
        tabId: state.activeTabId!,
      }),
    ).toThrow(/has not attached yet/i);
  });

  it("adopts only a webview owned by the exact Synara window and browser partition", () => {
    const manager = new DesktopBrowserManager();
    const state = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
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
    const state = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
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

    manager.setPanelBounds({ threadId: THREAD_ID, surface: "renderer", bounds: null });
    expect(() => manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId })).toThrow(
      /not currently visible/i,
    );
  });

  it("rejects stale or duplicate renderer bindings instead of stealing visible tab affinity", () => {
    const manager = new DesktopBrowserManager();
    const state = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
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

    const second = manager.prepareAutomationTab({
      threadId: THREAD_ID,
      url: "https://second.example/",
      reuse: false,
    });
    const secondTabId = second.activeTabId!;
    expect(() =>
      manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: duplicateGuest.id }, 41),
    ).toThrow(/active tab/i);
    expect(secondTabId).not.toBe(tabId);
  });

  it("keeps the CDP session when one renderer webview is rebound to another tab", () => {
    const manager = new DesktopBrowserManager();
    const first = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
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

    const second = manager.prepareAutomationTab({
      threadId: THREAD_ID,
      url: "https://second.example/",
      reuse: false,
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
    const state = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
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
      /has not attached yet/i,
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

  it("still treats a real panel hide as human takeover", () => {
    const manager = new DesktopBrowserManager();
    manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(0);

    manager.hide({ threadId: THREAD_ID });

    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(1);
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

  it.each([
    ["while the action listener is active", false],
    ["after the action listener is released", true],
  ] as const)(
    "preserves download containment across native-to-renderer migration %s",
    (_, releaseBeforeMigration) => {
      const manager = new DesktopBrowserManager();
      const prepared = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
      const tabId = prepared.activeTabId!;
      const nativeWebContents = new FakeWebContents();
      const nativeRuntime = {
        key: `${THREAD_ID}:${tabId}`,
        threadId: THREAD_ID,
        tabId,
        webContents: nativeWebContents as unknown as WebContents,
        view: null,
        ownsWebContents: true as const,
        listenerDisposers: [] as Array<() => void>,
      };
      const access = manager as unknown as {
        runtimes: Map<string, typeof nativeRuntime>;
      };
      access.runtimes.set(nativeRuntime.key, nativeRuntime);
      const observed = vi.fn();
      const release = manager.trackAutomationDownload({ threadId: THREAD_ID, tabId }, observed);
      if (releaseBeforeMigration) release();

      manager.selectAutomationTab({ threadId: THREAD_ID, tabId });
      expect(nativeWebContents.close).toHaveBeenCalledOnce();

      const rendererWebContents = Object.assign(new FakeWebContents(18), {
        getType: () => "webview",
        hostWebContents: { id: 41 },
        session: browserSession,
      });
      fromId.mockReturnValue(rendererWebContents);
      manager.attachWebview(
        { threadId: THREAD_ID, tabId, webContentsId: rendererWebContents.id },
        41,
      );
      const migratedDownload = { preventDefault: vi.fn() };
      willDownloadListener.current?.(migratedDownload, {}, rendererWebContents);

      expect(migratedDownload.preventDefault).toHaveBeenCalledOnce();
      if (releaseBeforeMigration) {
        expect(observed).not.toHaveBeenCalled();
      } else {
        expect(observed).toHaveBeenCalledWith({ threadId: THREAD_ID, sourceTabId: tabId });
        release();
      }

      manager.dispose();
    },
  );

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

  it("does not create a transient fallback when the renderer opens a projected agent URL", () => {
    webContentsViewConstructor.mockClear();
    const manager = new DesktopBrowserManager();
    const blank = manager.prepareAutomationTab({ threadId: THREAD_ID, reuse: true });
    const tabId = blank.activeTabId!;
    manager.prepareAutomationNavigation({
      threadId: THREAD_ID,
      tabId,
      url: "https://agent.example/path",
    });
    manager.setPanelBounds({
      threadId: THREAD_ID,
      surface: "renderer",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });

    manager.open({ threadId: THREAD_ID });

    expect(webContentsViewConstructor).not.toHaveBeenCalled();
    expect(() => manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId })).toThrow(
      /has not attached yet/i,
    );
  });
});
