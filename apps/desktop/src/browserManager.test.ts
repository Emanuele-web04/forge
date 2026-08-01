import { EventEmitter } from "node:events";

import { ThreadId } from "@synara/contracts";
import type { BrowserWindow, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  browserSession,
  rendererWebContentsById,
  rendererWebContentsFromId,
  rendererWebContentsFromFrame,
  sessionFromPartition,
  showMessageBox,
} = vi.hoisted(() => {
  const rendererWebContentsById = new Map<number, unknown>();
  return {
    browserSession: {
      setUserAgent: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
      on: vi.fn(),
      removeListener: vi.fn(),
      clearStorageData: vi.fn(),
      clearCache: vi.fn(),
      flushStorageData: vi.fn(),
    },
    sessionFromPartition: vi.fn((_partition: string) => browserSession),
    rendererWebContentsById,
    rendererWebContentsFromId: vi.fn((id: number) => rendererWebContentsById.get(id) ?? null),
    rendererWebContentsFromFrame: vi.fn((frame: { contents?: unknown }) => frame.contents ?? null),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  };
});

vi.mock("electron", () => ({
  app: {
    getName: () => "Synara",
    getPreferredSystemLanguages: () => ["en-US"],
    userAgentFallback:
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Electron/40.0.0 Safari/537.36",
  },
  BrowserWindow: class {},
  clipboard: { writeImage: vi.fn(), writeText: vi.fn() },
  dialog: { showMessageBox },
  nativeImage: { createFromBuffer: vi.fn() },
  session: {
    fromPartition: sessionFromPartition,
  },
  webContents: { fromId: rendererWebContentsFromId, fromFrame: rendererWebContentsFromFrame },
  WebContentsView: class {},
}));

import { DesktopBrowserManager } from "./browserManager";
import { BrowserProfileStore } from "./browserProfiles";

interface WindowOpenDetails {
  url: string;
  frameName: string;
  features: string;
  disposition: string;
}

type WindowOpenHandler = (details: WindowOpenDetails) => {
  action: "allow" | "deny";
  overrideBrowserWindowOptions?: object;
};

class FakeWebContents extends EventEmitter {
  constructor(readonly id = 1) {
    super();
  }

  windowOpenHandler: WindowOpenHandler | null = null;

  setUserAgent = vi.fn();
  reload = vi.fn();
  isDestroyed = () => false;

  setWindowOpenHandler(handler: WindowOpenHandler): void {
    this.windowOpenHandler = handler;
  }
}

class FakeRendererWebContents extends FakeWebContents {
  private destroyed = false;

  readonly debugger = {
    isAttached: () => false,
    detach: vi.fn(),
  };
  readonly hostWebContents = { id: 41 };
  session: unknown = browserSession;
  url = "about:blank";

  override isDestroyed = () => this.destroyed;
  getType = () => "webview";
  getURL = () => this.url;
  getTitle = () => "New tab";
  isLoading = () => false;
  canGoBack = () => false;
  canGoForward = () => false;

  destroyGuest(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakePopupWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  isDestroyed = () => false;
  destroy = vi.fn();
}

interface BrowserManagerCharacterizationAccess {
  runtimes: Map<
    string,
    {
      key: string;
      threadId: ThreadId;
      tabId: string;
      webContents: WebContents;
      view: null;
      ownsWebContents: false;
      listenerDisposers: Array<() => void>;
    }
  >;
  popupRuntimes: Map<
    BrowserWindow,
    {
      threadId: ThreadId;
      tabId: string;
      window: BrowserWindow;
      listenerDisposers: Array<() => void>;
    }
  >;
  configureRuntimeWebContents(runtime: {
    key: string;
    threadId: ThreadId;
    tabId: string;
    webContents: WebContents;
    view: null;
    ownsWebContents: false;
    listenerDisposers: Array<() => void>;
  }): void;
  configureOAuthPopupRuntime(runtime: {
    threadId: ThreadId;
    tabId: string;
    window: BrowserWindow;
    listenerDisposers: Array<() => void>;
  }): void;
}

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function asCharacterizationAccess(
  manager: DesktopBrowserManager,
): BrowserManagerCharacterizationAccess {
  return manager as unknown as BrowserManagerCharacterizationAccess;
}

describe("DesktopBrowserManager repeated workflow characterization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rendererWebContentsById.clear();
    // Keep partition and storage behaviour identical for every test regardless
    // of the implementations an earlier test installed.
    sessionFromPartition.mockImplementation(() => browserSession);
    browserSession.clearStorageData.mockImplementation(() => undefined);
    showMessageBox.mockImplementation(async () => ({ response: 0 }));
  });

  it("invalidates a destroyed renderer and reattaches the same tab to a new guest", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const firstGuest = new FakeRendererWebContents(17);
    rendererWebContentsById.set(firstGuest.id, firstGuest);
    manager.attachWebview(
      { threadId: THREAD_ID, tabId, webContentsId: firstGuest.id },
      firstGuest.hostWebContents.id,
    );
    await Promise.resolve();
    const attachedSnapshot = manager.getState({ threadId: THREAD_ID });
    const publication = vi.fn();
    manager.subscribe(publication);

    firstGuest.destroyGuest();

    const crashedSnapshot = manager.getState({ threadId: THREAD_ID });
    expect(crashedSnapshot).not.toBe(attachedSnapshot);
    expect(crashedSnapshot.version).toBeGreaterThan(attachedSnapshot.version);
    expect(crashedSnapshot).toMatchObject({
      activeTabId: tabId,
      tabs: [{ id: tabId, status: "suspended", isLoading: false }],
    });
    expect(() => manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId })).toThrow(
      /has not attached yet/i,
    );

    // A duplicate terminal signal for the same physical guest must not publish
    // or clean up the logical tab a second time.
    firstGuest.emit("render-process-gone");
    expect(publication).toHaveBeenCalledOnce();
    expect(manager.getState({ threadId: THREAD_ID })).toBe(crashedSnapshot);
    expect(firstGuest.listenerCount("destroyed")).toBe(0);
    expect(firstGuest.listenerCount("render-process-gone")).toBe(0);

    const replacementGuest = new FakeRendererWebContents(18);
    rendererWebContentsById.set(replacementGuest.id, replacementGuest);
    const recoveredSnapshot = manager.attachWebview(
      { threadId: THREAD_ID, tabId, webContentsId: replacementGuest.id },
      replacementGuest.hostWebContents.id,
    );

    expect(replacementGuest.id).not.toBe(firstGuest.id);
    expect(recoveredSnapshot).not.toBe(crashedSnapshot);
    expect(recoveredSnapshot.version).toBeGreaterThan(crashedSnapshot.version);
    expect(recoveredSnapshot).toMatchObject({
      activeTabId: tabId,
      tabs: [{ id: tabId, status: "live", lastError: null }],
    });
    expect(manager.getVisibleAutomationRuntime({ threadId: THREAD_ID, tabId }).webContents).toBe(
      replacementGuest,
    );
  });

  it("emits one state change when a different tab becomes active", () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID });
    const firstTabId = initial.activeTabId;
    const withSecondTab = manager.newTab({
      threadId: THREAD_ID,
      url: "https://second.example",
      activate: false,
    });
    const secondTabId = withSecondTab.tabs.at(-1)?.id;
    const states = vi.fn();
    manager.subscribe(states);

    expect(firstTabId).not.toBeNull();
    expect(secondTabId).toBeDefined();
    if (!secondTabId) return;
    expect(withSecondTab.activeTabId).toBe(firstTabId);

    const selected = manager.selectTab({ threadId: THREAD_ID, tabId: secondTabId });
    expect(selected.activeTabId).toBe(secondTabId);
    expect(states).toHaveBeenCalledTimes(1);

    manager.selectTab({ threadId: THREAD_ID, tabId: secondTabId });
    expect(states).toHaveBeenCalledTimes(1);
  });

  it("applies the same popup, tab-open, and scheme-denial policy to tabs and popups", async () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID });
    const tabId = initial.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    const popup = new FakePopupWindow();
    const access = asCharacterizationAccess(manager);
    const tabRuntime = {
      key: `thread-1:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null as null,
      ownsWebContents: false as const,
      listenerDisposers: [],
    };
    access.runtimes.set(tabRuntime.key, tabRuntime);
    access.configureRuntimeWebContents(tabRuntime);
    const popupRuntime = {
      threadId: THREAD_ID,
      tabId,
      window: popup as unknown as BrowserWindow,
      listenerDisposers: [],
    };
    access.popupRuntimes.set(popupRuntime.window, popupRuntime);
    access.configureOAuthPopupRuntime(popupRuntime);

    const handlers = [tabContents.windowOpenHandler, popup.webContents.windowOpenHandler];
    expect(handlers.every(Boolean)).toBe(true);
    for (const handler of handlers) {
      if (!handler) continue;
      expect(
        handler({
          url: "https://auth.example",
          frameName: "auth",
          features: "width=480,height=640",
          disposition: "new-window",
        }),
      ).toMatchObject({ action: "allow", overrideBrowserWindowOptions: expect.any(Object) });

      const beforeTabOpen = manager.getState({ threadId: THREAD_ID }).tabs.length;
      expect(
        handler({
          url: "https://docs.example",
          frameName: "",
          features: "",
          disposition: "foreground-tab",
        }),
      ).toEqual({ action: "deny" });
      expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(beforeTabOpen);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const afterTabOpen = manager.getState({ threadId: THREAD_ID });
      expect(afterTabOpen.tabs).toHaveLength(beforeTabOpen + 1);
      expect(afterTabOpen.tabs.find((tab) => tab.id === afterTabOpen.activeTabId)?.url).toBe(
        "https://docs.example/",
      );

      const beforeSchemeDenial = afterTabOpen.tabs.length;
      expect(
        handler({
          url: "synara://unsafe",
          frameName: "",
          features: "",
          disposition: "foreground-tab",
        }),
      ).toEqual({ action: "deny" });
      expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(beforeSchemeDenial);
    }
  });

  it("blocks page-driven main-frame navigations and redirects outside web schemes", () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID });
    const tabId = initial.activeTabId!;
    const tabContents = new FakeWebContents();
    const popup = new FakePopupWindow();
    const access = asCharacterizationAccess(manager);
    access.configureRuntimeWebContents({
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    access.configureOAuthPopupRuntime({
      threadId: THREAD_ID,
      tabId,
      window: popup as unknown as BrowserWindow,
      listenerDisposers: [],
    });

    for (const contents of [tabContents, popup.webContents]) {
      const blockedNavigation = {
        url: "file:///etc/passwd",
        isMainFrame: true,
        preventDefault: vi.fn(),
      };
      contents.emit("will-navigate", blockedNavigation);
      expect(blockedNavigation.preventDefault).toHaveBeenCalledOnce();

      const allowedNavigation = {
        url: "https://example.test/path",
        isMainFrame: true,
        preventDefault: vi.fn(),
      };
      contents.emit("will-navigate", allowedNavigation);
      expect(allowedNavigation.preventDefault).not.toHaveBeenCalled();

      const subframeNavigation = {
        url: "data:text/html,subframe",
        isMainFrame: false,
        preventDefault: vi.fn(),
      };
      contents.emit("will-navigate", subframeNavigation);
      expect(subframeNavigation.preventDefault).not.toHaveBeenCalled();

      const blockedRedirect = {
        url: "custom-protocol://unsafe",
        isMainFrame: true,
        preventDefault: vi.fn(),
      };
      contents.emit("will-redirect", blockedRedirect);
      expect(blockedRedirect.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it("treats keyboard and pointer interaction inside an OAuth popup as human control", () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID });
    const tabId = initial.activeTabId!;
    const popup = new FakePopupWindow();
    asCharacterizationAccess(manager).configureOAuthPopupRuntime({
      threadId: THREAD_ID,
      tabId,
      window: popup as unknown as BrowserWindow,
      listenerDisposers: [],
    });

    const initialEpoch = manager.getAutomationHumanControlEpoch(THREAD_ID);
    popup.webContents.emit(
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
    popup.webContents.emit(
      "before-mouse-event",
      {},
      {
        type: "mouseDown",
        button: "left",
        x: 10,
        y: 20,
      },
    );
    popup.webContents.emit(
      "before-mouse-event",
      {},
      {
        type: "mouseWheel",
        x: 10,
        y: 20,
      },
    );

    expect(manager.getAutomationHumanControlEpoch(THREAD_ID)).toBe(initialEpoch + 3);
  });

  it("gives the shell first refusal on browser guest keyboard input", () => {
    const beforeInputEvent = vi.fn((event: Electron.Event) => {
      event.preventDefault();
      return true;
    });
    const manager = new DesktopBrowserManager({ beforeInputEvent });
    const initial = manager.open({ threadId: THREAD_ID });
    const tabId = initial.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    asCharacterizationAccess(manager).configureRuntimeWebContents({
      key: `thread-1:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    const event = {
      preventDefault: vi.fn(),
      defaultPrevented: false,
    };
    const input = {
      type: "keyDown",
      key: "-",
      code: "Minus",
      isAutoRepeat: false,
      isComposing: false,
      shift: false,
      control: true,
      alt: false,
      meta: false,
      location: 0,
      modifiers: ["control"],
    };

    tabContents.emit("before-input-event", event, input);

    expect(beforeInputEvent).toHaveBeenCalledWith(event, input);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("switches thread browser identities without sharing the old profile session", async () => {
    const profileStore = new BrowserProfileStore({
      createId: () => "e7a0a2ef-5a6d-4f70-a15d-7e6d3b27a1a9",
    });
    const workProfile = profileStore.create("Work");
    const workSession = {
      ...browserSession,
      clearStorageData: vi.fn(),
      clearCache: vi.fn(),
      flushStorageData: vi.fn(),
    };
    sessionFromPartition.mockImplementation((partition: string) =>
      partition === workProfile.partition ? workSession : browserSession,
    );
    const manager = new DesktopBrowserManager({ profileStore });

    const initiallyOpened = manager.open({ threadId: THREAD_ID });
    expect(initiallyOpened.profile).toMatchObject({ id: "temporary", kind: "temporary" });

    const switched = manager.setThreadProfile({ threadId: THREAD_ID, profileId: workProfile.id });
    expect(switched).toMatchObject({
      open: true,
      profile: { id: workProfile.id, partition: workProfile.partition },
    });
    expect(manager.getProfileState({ threadId: THREAD_ID })).toMatchObject({
      threadProfile: { id: workProfile.id },
      profiles: expect.arrayContaining([expect.objectContaining({ id: workProfile.id })]),
    });
    expect(sessionFromPartition).toHaveBeenCalledWith(workProfile.partition);
    await manager.clearProfileData({ profileId: workProfile.id, clearCache: true });

    expect(workSession.clearStorageData).toHaveBeenCalledWith();
    expect(workSession.clearCache).toHaveBeenCalledOnce();

    await manager.deleteProfile({ profileId: workProfile.id });
    expect(manager.getState({ threadId: THREAD_ID }).profile).toMatchObject({
      id: "temporary",
      kind: "temporary",
    });
  });

  it("rotates a reopened temporary partition away from an unfinished cleanup", async () => {
    const manager = new DesktopBrowserManager();
    let finishCleanup = (): void => {};
    browserSession.clearStorageData.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );

    const opened = manager.open({ threadId: THREAD_ID });
    const temporaryPartition = opened.profile.partition;
    expect(opened.profile).toMatchObject({ id: "temporary", kind: "temporary" });
    expect(manager.isManagedProfilePartition(temporaryPartition)).toBe(true);

    manager.close({ threadId: THREAD_ID });
    expect(browserSession.clearStorageData).toHaveBeenCalledOnce();

    // Reopening while the previous session is still being cleared must never
    // land on the partition that cleanup is about to wipe.
    const reopened = manager.open({ threadId: THREAD_ID });
    expect(reopened.profile.partition).not.toBe(temporaryPartition);
    expect(reopened.profile.partition.startsWith(`${temporaryPartition}-`)).toBe(true);
    expect(manager.isManagedProfilePartition(reopened.profile.partition)).toBe(true);
    expect(sessionFromPartition).toHaveBeenCalledWith(reopened.profile.partition);
    expect(manager.getProfileState({ threadId: THREAD_ID }).profiles).toContainEqual(
      expect.objectContaining({ id: "temporary", partition: reopened.profile.partition }),
    );

    finishCleanup();
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The abandoned partition drops its session policy listeners once cleared.
    expect(browserSession.removeListener).toHaveBeenCalledWith(
      "select-webauthn-account",
      expect.any(Function),
    );
    expect(manager.getState({ threadId: THREAD_ID }).profile.partition).toBe(
      reopened.profile.partition,
    );
  });

  it("keeps the temporary partition stable once its cleanup has settled", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({ threadId: THREAD_ID });

    manager.close({ threadId: THREAD_ID });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(manager.open({ threadId: THREAD_ID }).profile.partition).toBe(opened.profile.partition);
  });

  it("reloads the pages still running on a profile whose data was cleared", async () => {
    const profileStore = new BrowserProfileStore({
      createId: () => "c41b8f5d-1a2e-4b3c-9d8e-6f5a4b3c2d1e",
    });
    const workProfile = profileStore.create("Work");
    const workSession = {
      ...browserSession,
      on: vi.fn(),
      removeListener: vi.fn(),
      clearStorageData: vi.fn(),
      clearCache: vi.fn(),
      flushStorageData: vi.fn(),
    };
    sessionFromPartition.mockImplementation((partition: string) =>
      partition === workProfile.partition ? workSession : browserSession,
    );
    const manager = new DesktopBrowserManager({ profileStore });
    manager.setThreadProfile({ threadId: THREAD_ID, profileId: workProfile.id });

    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;
    const guest = new FakeRendererWebContents(21);
    guest.session = workSession;
    guest.url = "https://mail.example/inbox";
    rendererWebContentsById.set(guest.id, guest);
    manager.attachWebview(
      { threadId: THREAD_ID, tabId, webContentsId: guest.id },
      guest.hostWebContents.id,
    );

    const otherThreadId = ThreadId.makeUnsafe("thread-2");
    const otherOpened = manager.open({ threadId: otherThreadId });
    const otherTabId = otherOpened.activeTabId;
    expect(otherTabId).not.toBeNull();
    if (!otherTabId) return;
    const otherGuest = new FakeRendererWebContents(22);
    otherGuest.url = "https://mail.example/inbox";
    rendererWebContentsById.set(otherGuest.id, otherGuest);
    manager.attachWebview(
      { threadId: otherThreadId, tabId: otherTabId, webContentsId: otherGuest.id },
      otherGuest.hostWebContents.id,
    );

    await manager.clearProfileData({ profileId: workProfile.id, clearCache: true });

    expect(workSession.clearStorageData).toHaveBeenCalledWith();
    expect(guest.reload).toHaveBeenCalledOnce();
    // A page on a different profile keeps its session.
    expect(otherGuest.reload).not.toHaveBeenCalled();

    guest.reload.mockClear();
    await manager.clearProfileData({
      profileId: workProfile.id,
      clearCache: false,
      origin: "https://other.example",
    });
    expect(guest.reload).not.toHaveBeenCalled();

    await manager.clearProfileData({
      profileId: workProfile.id,
      clearCache: false,
      origin: "https://mail.example/settings",
    });
    expect(guest.reload).toHaveBeenCalledOnce();
  });

  it("scopes passkey prompts to the requesting frame instead of the top-level page", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;
    const guest = new FakeRendererWebContents(31);
    // The top-level page is a third-party site embedding an identity provider.
    guest.url = "https://news.example/article";
    rendererWebContentsById.set(guest.id, guest);
    manager.attachWebview(
      { threadId: THREAD_ID, tabId, webContentsId: guest.id },
      guest.hostWebContents.id,
    );

    const selectAccount = browserSession.on.mock.calls
      .filter(([event]) => event === "select-webauthn-account")
      .at(-1)?.[1] as
      | ((
          event: unknown,
          details: unknown,
          callback: (credentialId?: string | null) => void,
        ) => void)
      | undefined;
    expect(selectAccount).toBeDefined();
    if (!selectAccount) return;

    const accounts = [{ credentialId: "cred-1", name: "user", displayName: "User" }];
    const requestPasskey = async (frame: object, relyingPartyId = "idp.example") => {
      const callback = vi.fn();
      selectAccount({}, { relyingPartyId, accounts, frame }, callback);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return callback;
    };

    // Cross-origin sign-in frame: the relying party matches the frame's origin.
    showMessageBox.mockImplementation(async () => ({ response: 1 }));
    const accepted = await requestPasskey({
      origin: "https://login.idp.example",
      url: "https://login.idp.example/webauthn",
      contents: guest,
    });
    expect(accepted).toHaveBeenCalledWith("cred-1");
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("https://login.idp.example is asking from inside"),
      }),
    );

    showMessageBox.mockClear();
    const spoofed = await requestPasskey({
      origin: "https://evil.example",
      url: "https://evil.example/steal",
      contents: guest,
    });
    expect(spoofed).toHaveBeenCalledWith(undefined);
    expect(showMessageBox).not.toHaveBeenCalled();

    // An opaque (sandboxed) frame origin can never be matched to a relying party.
    const opaque = await requestPasskey({
      origin: "null",
      url: "https://idp.example/webauthn",
      contents: guest,
    });
    expect(opaque).toHaveBeenCalledWith(undefined);
    expect(showMessageBox).not.toHaveBeenCalled();

    const unknownFrame = await requestPasskey({
      origin: "https://idp.example",
      url: "https://idp.example/webauthn",
      contents: null,
    });
    expect(unknownFrame).toHaveBeenCalledWith(undefined);
    expect(showMessageBox).not.toHaveBeenCalled();
  });
});
