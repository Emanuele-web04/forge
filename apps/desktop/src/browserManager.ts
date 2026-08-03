// FILE: browserManager.ts
// Purpose: Owns the desktop in-app browser runtime and maps thread/tab state onto Electron views.
// Layer: Desktop runtime manager
// Depends on: Electron BrowserWindow/WebContentsView, shared browser IPC contracts

import * as Crypto from "node:crypto";

import {
  BrowserWindow,
  clipboard,
  nativeImage,
  session as electronSession,
  webContents as electronWebContents,
  WebContentsView,
} from "electron";
import type { WebContents } from "electron";
import type {
  BrowserAnnotationCancelInput,
  BrowserAnnotationEvent,
  BrowserAnnotationSession,
  BrowserAnnotationStartInput,
  BrowserAnnotationSyncMarkersInput,
  BrowserAttachWebviewInput,
  BrowserCaptureScreenshotResult,
  BrowserCopyLinkEvent,
  BrowserDetachWebviewInput,
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserOpenInput,
  BrowserPanelBounds,
  BrowserSetPanelBoundsInput,
  BrowserTabInput,
  BrowserTabState,
  BrowserThreadInput,
  ThreadBrowserState,
  ThreadId,
} from "@synara/contracts";
import { isBrowserCopyLinkChord } from "@synara/shared/browserShortcuts";
import {
  BROWSER_BLANK_URL as ABOUT_BLANK_URL,
  classifyBrowserWindowOpen,
  isBlankBrowserTabUrl,
  normalizeBrowserUrlInput as normalizeUrlInput,
  resolveCopyableBrowserTabUrl,
} from "@synara/shared/browserSession";
import {
  BROWSER_SESSION_PARTITION,
  BrowserSessionPolicy,
  type BrowserSessionDownloadEvent,
} from "./browserSessionPolicy";
import {
  BrowserAnnotationCoordinator,
  type BrowserAnnotationRuntime,
} from "./browserAnnotations/coordinator";
import {
  isLocalFileUrl,
  isLocalHtmlPreviewUrl,
  isSameLocalHtmlPreviewGrant,
} from "./localHtmlPreviewProtocol";

export { BROWSER_SESSION_PARTITION } from "./browserSessionPolicy";
const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS = 1_500;
const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS = 400;
const BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD = 1;
const BROWSER_THREAD_SUSPEND_DELAY_MS = 30_000;
const BROWSER_AUTOMATION_WINDOW_OPEN_FALLBACK_MS = 2_000;
const BROWSER_DEFERRED_PUBLICATION_DELAY_MS = 16;
const BROWSER_AUTOMATION_INPUT_RELEASE_GRACE_MS = 100;
const BROWSER_ERROR_ABORTED = -3;

type BrowserStateListener = (state: ThreadBrowserState) => void;
type BrowserCopyLinkListener = (event: BrowserCopyLinkEvent) => void;
type BrowserHumanControlListener = () => void;
type BrowserAutomationWindowOpenListener = (event: BrowserAutomationWindowOpenEvent) => void;
type BrowserAutomationDownloadListener = (event: BrowserAutomationDownloadEvent) => void;

export type BrowserAutomationExpectedInput =
  | {
      readonly kind: "key";
      readonly key: string;
      readonly alt: boolean;
      readonly control: boolean;
      readonly meta: boolean;
      readonly shift: boolean;
    }
  | {
      readonly kind: "mouse";
      readonly type: "mouseDown" | "mouseWheel" | "contextMenu";
      readonly x: number;
      readonly y: number;
      readonly button?: "left" | "middle" | "right";
    };

interface PendingBrowserAutomationInput {
  readonly signal: BrowserAutomationExpectedInput;
  expiresAt: number;
}

interface BrowserAutomationDownloadLease {
  readonly listener: BrowserAutomationDownloadListener;
  readonly humanControlEpoch: number;
}

interface BrowserAutomationSideEffectProvenance {
  readonly threadId: ThreadId;
  readonly humanControlEpoch: number;
}

interface LiveTabRuntime {
  key: string;
  threadId: ThreadId;
  tabId: string;
  webContents: WebContents;
  view: WebContentsView | null;
  ownsWebContents: boolean;
  listenerDisposers: Array<() => void>;
}

interface OAuthPopupContext {
  threadId: ThreadId;
  tabId: string;
}

interface OAuthPopupRuntime extends OAuthPopupContext {
  window: BrowserWindow;
  listenerDisposers: Array<() => void>;
}

interface NativeBrowserViewVisibility {
  setVisible?: (visible: boolean) => void;
}

interface PendingRuntimeSync {
  threadId: ThreadId;
  tabId: string;
  faviconUrls?: string[];
}

interface PendingWindowOpenTask {
  readonly handle: ReturnType<typeof setImmediate>;
  readonly sourceWebContents: WebContents;
}

interface PendingAutomationWindowOpenCommit {
  readonly threadId: ThreadId;
  readonly sourceTabId: string;
  readonly sourceWebContents: WebContents;
  readonly tab: BrowserTabState;
  readonly fallbackTimer: ReturnType<typeof setTimeout>;
}

interface PendingStatePublication {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly threadId: ThreadId;
  readonly reattachActiveTab: boolean;
  readonly rendererGuestToReset?: WebContents;
}

const LIVE_TAB_STATUS: BrowserTabState["status"] = "live";
const SUSPENDED_TAB_STATUS: BrowserTabState["status"] = "suspended";

interface BrowserPerformanceSnapshot {
  counters: {
    setPanelBoundsCalls: number;
    setPanelBoundsNoopSkips: number;
    setPanelBoundsViewportUpdates: number;
    stateEmitCalls: number;
    stateEmitSkips: number;
    stateCloneCount: number;
    runtimeSyncQueueFlushes: number;
    syncRuntimeStateCalls: number;
    inactiveTabSuspendScheduled: number;
    inactiveTabSuspendCancelled: number;
    inactiveTabBudgetEvictions: number;
    warmInactiveRuntimeCount: number;
  };
  trackedProcessIds: number[];
}

export interface BrowserAutomationVisibleRuntime {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly webContents: WebContents;
  /**
   * Classifies one imminent native input as agent-generated. The returned
   * disposer must be called once the dispatch has drained so a stale expected
   * signal can never mask a later human action.
   */
  readonly expectAgentInput?: (signal: BrowserAutomationExpectedInput) => () => void;
}

export interface BrowserAutomationPrepareTabInput {
  readonly threadId: ThreadId;
  readonly url?: string;
  readonly reuse: boolean;
}

export interface BrowserAutomationPrepareNavigationInput extends BrowserTabInput {
  readonly url: string;
}

export interface BrowserAutomationWindowOpenEvent {
  readonly threadId: ThreadId;
  readonly sourceTabId: string;
  readonly kind: "tab" | "popup" | "blocked";
  readonly openedTabId: string | null;
}

export interface BrowserAutomationDownloadEvent {
  readonly threadId: ThreadId;
  readonly sourceTabId: string;
}

export interface DesktopBrowserManagerOptions {
  beforeInputEvent?: (event: Electron.Event, input: Electron.Input) => boolean;
}

function createBrowserTab(url = ABOUT_BLANK_URL): BrowserTabState {
  return {
    id: Crypto.randomUUID(),
    url,
    title: defaultTitleForUrl(url),
    status: SUSPENDED_TAB_STATUS,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: null,
    lastError: null,
  };
}

function defaultThreadBrowserState(threadId: ThreadId): ThreadBrowserState {
  return {
    threadId,
    version: 0,
    open: false,
    activeTabId: null,
    tabs: [],
    lastError: null,
  };
}

function cloneThreadState(state: ThreadBrowserState): ThreadBrowserState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  };
}

function defaultTitleForUrl(url: string): string {
  if (url === ABOUT_BLANK_URL) {
    return "New tab";
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function screenshotFileNameForUrl(url: string): string {
  const fallback = "browser";
  try {
    const hostname = new URL(url).hostname.trim().toLowerCase();
    const normalizedHost = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `${normalizedHost || fallback}-${Date.now()}.png`;
  } catch {
    return `${fallback}-${Date.now()}.png`;
  }
}

function normalizeBounds(bounds: BrowserPanelBounds | null): BrowserPanelBounds | null {
  if (!bounds) return null;
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    return null;
  }

  const width = Math.max(0, Math.floor(bounds.width));
  const height = Math.max(0, Math.floor(bounds.height));
  if (width === 0 || height === 0) {
    return null;
  }

  return {
    x: Math.max(0, Math.floor(bounds.x)),
    y: Math.max(0, Math.floor(bounds.y)),
    width,
    height,
  };
}

function isAbortedNavigationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /ERR_ABORTED|\(-3\)/i.test(error.message);
}

function mapBrowserLoadError(errorCode: number): string {
  switch (errorCode) {
    case -102:
      return "Connection refused.";
    case -105:
      return "Couldn't resolve this address.";
    case -106:
      return "You're offline.";
    case -118:
      return "This page took too long to respond.";
    case -137:
      return "A secure connection couldn't be established.";
    case -200:
      return "A secure connection couldn't be established.";
    default:
      return "Couldn't open this page.";
  }
}

function buildRuntimeKey(threadId: ThreadId, tabId: string): string {
  return `${threadId}:${tabId}`;
}

function browserBoundsSignature(bounds: BrowserPanelBounds | null): string {
  if (!bounds) {
    return "hidden";
  }

  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
}

function isAllowedBrowserRuntimeNavigation(url: string, currentUrl: string): boolean {
  if (url === ABOUT_BLANK_URL) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return true;
    }
    return isLocalHtmlPreviewUrl(url) && isSameLocalHtmlPreviewGrant(currentUrl, url);
  } catch {
    return false;
  }
}

function normalizeAutomationKey(value: string): string {
  if (value === "Space" || value === " ") {
    return " ";
  }
  return value.length === 1 ? value.toLocaleLowerCase("en-US") : value;
}

function browserAutomationInputMatches(
  expected: BrowserAutomationExpectedInput,
  actual: BrowserAutomationExpectedInput,
): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === "key" && actual.kind === "key") {
    return (
      normalizeAutomationKey(expected.key) === normalizeAutomationKey(actual.key) &&
      expected.alt === actual.alt &&
      expected.control === actual.control &&
      expected.meta === actual.meta &&
      expected.shift === actual.shift
    );
  }
  if (expected.kind !== "mouse" || actual.kind !== "mouse") return false;
  return (
    expected.type === actual.type &&
    (expected.button === undefined || expected.button === actual.button) &&
    Math.abs(expected.x - actual.x) <= 1.5 &&
    Math.abs(expected.y - actual.y) <= 1.5
  );
}

export class DesktopBrowserManager {
  private window: BrowserWindow | null = null;
  private activeThreadId: ThreadId | null = null;
  private activeBounds: BrowserPanelBounds | null = null;
  private activeBoundsThreadId: ThreadId | null = null;
  private attachedRuntimeKey: string | null = null;
  private attachedBoundsSignature: string | null = null;
  private readonly states = new Map<ThreadId, ThreadBrowserState>();
  private readonly threadVersionById = new Map<ThreadId, number>();
  private readonly snapshotCacheByThreadId = new Map<
    ThreadId,
    { version: number; snapshot: ThreadBrowserState }
  >();
  private readonly lastEmittedVersionByThreadId = new Map<ThreadId, number>();
  private readonly humanControlEpochByThreadId = new Map<ThreadId, number>();
  private readonly humanControlListenersByThreadId = new Map<
    ThreadId,
    Set<BrowserHumanControlListener>
  >();
  private readonly expectedAutomationInputsByRuntimeKey = new Map<
    string,
    ReadonlyArray<PendingBrowserAutomationInput>
  >();
  private readonly automationGestureDepthByRuntimeKey = new Map<string, number>();
  private readonly automationWindowOpenListenersByRuntimeKey = new Map<
    string,
    Set<BrowserAutomationWindowOpenListener>
  >();
  private readonly automationDownloadListenersByRuntimeKey = new Map<
    string,
    Set<BrowserAutomationDownloadLease>
  >();
  private readonly automationSideEffectProvenanceByRuntimeKey = new Map<
    string,
    BrowserAutomationSideEffectProvenance
  >();
  private readonly pendingWindowOpenTasksByRuntimeKey = new Map<string, PendingWindowOpenTask>();
  private readonly pendingAutomationWindowOpenCommitsByRuntimeKey = new Map<
    string,
    PendingAutomationWindowOpenCommit
  >();
  private readonly pendingStatePublicationsByKey = new Map<string, PendingStatePublication>();
  private readonly runtimes = new Map<string, LiveTabRuntime>();
  private readonly rendererOnlyRuntimeKeys = new Set<string>();
  private readonly runtimeLastActiveAtByKey = new Map<string, number>();
  private readonly pendingRuntimeSyncs = new Map<string, PendingRuntimeSync>();
  private readonly listeners = new Set<BrowserStateListener>();
  private readonly copyLinkListeners = new Set<BrowserCopyLinkListener>();
  private readonly annotations: BrowserAnnotationCoordinator;
  // OAuth/sign-in popups opened by pages via `window.open`. Tracked so they can be sized over
  // the panel and torn down cleanly without leaking native windows.
  private readonly popupRuntimes = new Map<BrowserWindow, OAuthPopupRuntime>();
  private readonly sessionPolicy: BrowserSessionPolicy;
  private readonly tabSuspendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly suspendTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  private runtimeSyncFlushScheduled = false;
  private disposed = false;
  private readonly perfCounters = {
    setPanelBoundsCalls: 0,
    setPanelBoundsNoopSkips: 0,
    setPanelBoundsViewportUpdates: 0,
    stateEmitCalls: 0,
    stateEmitSkips: 0,
    stateCloneCount: 0,
    runtimeSyncQueueFlushes: 0,
    syncRuntimeStateCalls: 0,
    inactiveTabSuspendScheduled: 0,
    inactiveTabSuspendCancelled: 0,
    inactiveTabBudgetEvictions: 0,
    warmInactiveRuntimeCount: 0,
  };

  constructor(private readonly options: DesktopBrowserManagerOptions = {}) {
    this.sessionPolicy = new BrowserSessionPolicy((event) => {
      this.handleSessionDownload(event);
    });
    this.annotations = new BrowserAnnotationCoordinator({
      resolveVisibleRuntime: (input) => {
        const runtime = this.getVisibleAutomationRuntime(input);
        return {
          threadId: runtime.threadId,
          tabId: runtime.tabId,
          webContents: runtime.webContents,
        };
      },
      resolveRuntimeByWebContentsId: (webContentsId) =>
        this.toAnnotationRuntime(this.findRendererRuntimeByWebContentsId(webContentsId)),
      markHumanControl: (threadId) => this.markHumanControl(threadId),
    });
  }

  setWindow(window: BrowserWindow | null): void {
    const previousWindow = this.window;
    if (previousWindow && previousWindow !== window) {
      // Detach while the old BrowserWindow is still addressable; clearing the
      // field first leaves native child views orphaned over the next renderer.
      this.detachAttachedRuntime();
      this.destroyAllRuntimes();
      this.closeAllPopupWindows();
    }
    this.window = window;
    if (window) {
      const bounds = this.activeThreadId
        ? this.getVisibleBoundsForThread(this.activeThreadId)
        : null;
      if (this.activeThreadId && bounds) {
        this.attachActiveTab(this.activeThreadId, bounds);
      }
      return;
    }
  }

  subscribe(listener: BrowserStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeCopyLink(listener: BrowserCopyLinkListener): () => void {
    this.copyLinkListeners.add(listener);
    return () => {
      this.copyLinkListeners.delete(listener);
    };
  }

  subscribeAnnotationEvents(listener: (event: BrowserAnnotationEvent) => void): () => void {
    return this.annotations.subscribe(listener);
  }

  startAnnotation(input: BrowserAnnotationStartInput): BrowserAnnotationSession {
    return this.annotations.start(input);
  }

  cancelAnnotation(input: BrowserAnnotationCancelInput): void {
    this.annotations.cancel(input);
  }

  syncAnnotationMarkers(input: BrowserAnnotationSyncMarkersInput): void {
    const state = this.states.get(input.threadId);
    if (!state?.tabs.some((tab) => tab.id === input.tabId)) {
      throw new Error("The requested browser tab is not available in this thread.");
    }
    this.annotations.syncMarkers(input);
  }

  resolveAnnotationNavigationTarget(input: {
    threadId: ThreadId;
    tabId?: string;
    annotationId: string;
  }): { readonly tabId: string; readonly url: string } | null {
    const state = this.states.get(input.threadId);
    if (!state) {
      return null;
    }
    const target = this.annotations.resolveNavigationTarget(
      input.threadId,
      input.annotationId,
      input.tabId,
    );
    if (!target || !state.tabs.some((tab) => tab.id === target.tabId)) {
      return null;
    }
    return { tabId: target.tabId, url: target.liveUrl };
  }

  handleAnnotationGuestMessage(sender: WebContents, payload: unknown): void {
    this.annotations.handleGuestMessage(sender, payload);
  }

  isAnnotationInteractive(threadId: ThreadId): boolean {
    return this.annotations.isInteractive(threadId);
  }

  isTrustedRenderer(webContentsId: number): boolean {
    return Boolean(
      this.window && !this.window.isDestroyed() && this.window.webContents.id === webContentsId,
    );
  }

  /**
   * Correlates a page-created window with the agent input that caused it. The
   * short-lived gesture lease stays active until the caller disposes it, so an
   * Electron window-open callback delivered just after the input transport is
   * acknowledged is still classified as agent-owned.
   */
  trackAutomationWindowOpen(
    input: BrowserTabInput,
    listener: BrowserAutomationWindowOpenListener,
  ): () => void {
    const key = buildRuntimeKey(input.threadId, input.tabId);
    const listeners = this.automationWindowOpenListenersByRuntimeKey.get(key) ?? new Set();
    listeners.add(listener);
    this.automationWindowOpenListenersByRuntimeKey.set(key, listeners);
    this.beginAutomationGesture(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      listeners.delete(listener);
      if (listeners.size === 0) this.automationWindowOpenListenersByRuntimeKey.delete(key);
      this.endAutomationGesture(key);
      if (listeners.size === 0) this.commitPendingAutomationWindowOpen(key);
    };
  }

  /**
   * Observes downloads while a host action is live and records their runtime
   * provenance. Releasing the observer ends host notification, while the
   * provenance remains until human control or runtime teardown so a deferred
   * page side effect still cannot write to disk.
   */
  trackAutomationDownload(
    input: BrowserTabInput,
    listener: BrowserAutomationDownloadListener,
  ): () => void {
    const key = buildRuntimeKey(input.threadId, input.tabId);
    const listeners = this.automationDownloadListenersByRuntimeKey.get(key) ?? new Set();
    const humanControlEpoch = this.getAutomationHumanControlEpoch(input.threadId);
    const lease: BrowserAutomationDownloadLease = {
      listener,
      humanControlEpoch,
    };
    listeners.add(lease);
    this.automationDownloadListenersByRuntimeKey.set(key, listeners);
    // A page can defer the actual navigation/download beyond the native input
    // acknowledgement and the host listener's lifetime. Retain one provenance
    // marker per logical runtime until genuine human input advances the epoch
    // or the runtime is destroyed.
    this.automationSideEffectProvenanceByRuntimeKey.set(key, {
      threadId: input.threadId,
      humanControlEpoch,
    });
    this.beginAutomationGesture(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      listeners.delete(lease);
      if (listeners.size === 0) this.automationDownloadListenersByRuntimeKey.delete(key);
      this.endAutomationGesture(key);
    };
  }

  private beginAutomationGesture(key: string): void {
    this.automationGestureDepthByRuntimeKey.set(
      key,
      (this.automationGestureDepthByRuntimeKey.get(key) ?? 0) + 1,
    );
  }

  private endAutomationGesture(key: string): void {
    const nextDepth = Math.max(0, (this.automationGestureDepthByRuntimeKey.get(key) ?? 1) - 1);
    if (nextDepth === 0) {
      this.automationGestureDepthByRuntimeKey.delete(key);
      return;
    }
    this.automationGestureDepthByRuntimeKey.set(key, nextDepth);
  }

  private configureWindowOpenHandling(
    webContents: WebContents,
    context: OAuthPopupContext,
    listenerDisposers: Array<() => void>,
  ): void {
    const { threadId, tabId } = context;

    const blockUnsafeMainFrameNavigation = (
      details: Electron.Event<
        Electron.WebContentsWillNavigateEventParams | Electron.WebContentsWillRedirectEventParams
      >,
      legacyUrl?: string,
      _legacyIsSameDocument?: boolean,
      legacyIsMainFrame?: boolean,
    ) => {
      const url = typeof details.url === "string" ? details.url : (legacyUrl ?? "");
      const isMainFrame =
        typeof details.isMainFrame === "boolean"
          ? details.isMainFrame
          : legacyIsMainFrame !== false;
      if (isMainFrame && !isAllowedBrowserRuntimeNavigation(url, webContents.getURL())) {
        details.preventDefault();
      }
    };
    webContents.on("will-navigate", blockUnsafeMainFrameNavigation);
    webContents.on("will-redirect", blockUnsafeMainFrameNavigation);
    listenerDisposers.push(() => {
      webContents.removeListener("will-navigate", blockUnsafeMainFrameNavigation);
      webContents.removeListener("will-redirect", blockUnsafeMainFrameNavigation);
    });

    // Auth providers can chain web popups (provider -> consent). Page-controlled custom
    // schemes are denied here: browser content must never launch an OS handler implicitly.
    webContents.setWindowOpenHandler((details) => {
      const { url } = details;
      const automationGestureActive = this.isAutomationGestureActive(threadId, tabId);
      const isWebUrl =
        url.startsWith("http://") || url.startsWith("https://") || url === ABOUT_BLANK_URL;
      if (!isWebUrl) {
        if (automationGestureActive) {
          this.emitAutomationWindowOpen({
            threadId,
            sourceTabId: tabId,
            kind: "blocked",
            openedTabId: null,
          });
        }
        return { action: "deny" };
      }

      const kind = classifyBrowserWindowOpen({
        url,
        frameName: details.frameName,
        features: details.features,
        disposition: details.disposition,
      });
      if (kind === "popup") {
        if (automationGestureActive) {
          this.emitAutomationWindowOpen({
            threadId,
            sourceTabId: tabId,
            kind: "popup",
            openedTabId: null,
          });
        }
        // Allow (don't deny) so Electron creates a real child window that keeps
        // `window.opener`, which the OAuth callback needs to message the page back.
        return {
          action: "allow",
          overrideBrowserWindowOptions: this.sessionPolicy.buildOAuthPopupWindowOptions(
            this.window,
          ),
        };
      }

      // Electron is waiting synchronously for this decision. Updating state here
      // can make the renderer remove the source <webview> re-entrantly while its
      // WebContents is still opening the window. Defer the canonical tab
      // transition until after the handler has returned to Electron.
      this.scheduleWindowOpenTab({
        threadId,
        sourceTabId: tabId,
        sourceWebContents: webContents,
        url,
        automationGestureActive,
      });
      return { action: "deny" };
    });

    const didCreateWindow = (childWindow: BrowserWindow) => {
      this.registerOAuthPopupWindow(childWindow, { threadId, tabId });
    };
    webContents.on("did-create-window", didCreateWindow);
    listenerDisposers.push(() => {
      webContents.removeListener("did-create-window", didCreateWindow);
    });
  }

  private findRuntimeContext(webContents: WebContents): OAuthPopupContext | null {
    for (const runtime of this.runtimes.values()) {
      if (runtime.webContents === webContents) {
        return { threadId: runtime.threadId, tabId: runtime.tabId };
      }
    }
    for (const popup of this.popupRuntimes.values()) {
      if (!popup.window.isDestroyed() && popup.window.webContents === webContents) {
        return { threadId: popup.threadId, tabId: popup.tabId };
      }
    }
    return null;
  }

  private handleSessionDownload(input: BrowserSessionDownloadEvent): void {
    if (this.disposed) return;
    const context = this.findRuntimeContext(input.webContents);
    if (!context) {
      return;
    }
    const runtimeKey = buildRuntimeKey(context.threadId, context.tabId);
    const currentHumanEpoch = this.getAutomationHumanControlEpoch(context.threadId);
    const provenance = this.automationSideEffectProvenanceByRuntimeKey.get(runtimeKey);
    if (!provenance || provenance.humanControlEpoch !== currentHumanEpoch) {
      // A manual download after genuine user input remains native Electron
      // behavior. In particular, no global partition policy blocks it.
      return;
    }

    // Electron guarantees that preventing `will-download` cancels before a
    // target path is selected or bytes are written. Notify the host only after
    // the side effect has been contained so listener failures cannot leak it.
    input.event.preventDefault();
    this.emitAutomationDownload({
      threadId: context.threadId,
      sourceTabId: context.tabId,
    });
  }

  private scheduleWindowOpenTab(input: {
    readonly threadId: ThreadId;
    readonly sourceTabId: string;
    readonly sourceWebContents: WebContents;
    readonly url: string;
    readonly automationGestureActive: boolean;
  }): void {
    if (this.disposed) return;
    const key = buildRuntimeKey(input.threadId, input.sourceTabId);
    // One native activation can surface duplicate callbacks in embedded guest
    // runtimes. Only the first decision may create a canonical Synara tab.
    if (
      this.pendingWindowOpenTasksByRuntimeKey.has(key) ||
      this.pendingAutomationWindowOpenCommitsByRuntimeKey.has(key)
    )
      return;

    const handle = setImmediate(() => {
      const pending = this.pendingWindowOpenTasksByRuntimeKey.get(key);
      if (!pending || pending.handle !== handle) return;
      this.pendingWindowOpenTasksByRuntimeKey.delete(key);
      if (
        this.disposed ||
        input.sourceWebContents.isDestroyed() ||
        !this.isCurrentWindowOpenSource(input.threadId, input.sourceTabId, input.sourceWebContents)
      ) {
        return;
      }
      const sourceState = this.states.get(input.threadId);
      if (!sourceState?.open || !sourceState.tabs.some((tab) => tab.id === input.sourceTabId)) {
        return;
      }

      if (input.automationGestureActive) {
        const tab = createBrowserTab(normalizeUrlInput(input.url));
        const fallbackTimer = setTimeout(() => {
          this.commitPendingAutomationWindowOpen(key);
        }, BROWSER_AUTOMATION_WINDOW_OPEN_FALLBACK_MS);
        fallbackTimer.unref?.();
        this.pendingAutomationWindowOpenCommitsByRuntimeKey.set(key, {
          threadId: input.threadId,
          sourceTabId: input.sourceTabId,
          sourceWebContents: input.sourceWebContents,
          tab,
          fallbackTimer,
        });
        this.emitAutomationWindowOpen({
          threadId: input.threadId,
          sourceTabId: input.sourceTabId,
          kind: "tab",
          openedTabId: tab.id,
        });
      } else {
        this.newTab({
          threadId: input.threadId,
          url: input.url,
          activate: true,
        });
      }
      if (!input.automationGestureActive) {
        const bounds = this.getVisibleBoundsForThread(input.threadId);
        if (this.activeThreadId === input.threadId && bounds) {
          this.attachActiveTab(input.threadId, bounds);
        }
      }
    });
    handle.unref?.();
    this.pendingWindowOpenTasksByRuntimeKey.set(key, {
      handle,
      sourceWebContents: input.sourceWebContents,
    });
  }

  private isCurrentWindowOpenSource(
    threadId: ThreadId,
    tabId: string,
    webContents: WebContents,
  ): boolean {
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    if (runtime?.webContents === webContents) return true;
    for (const popup of this.popupRuntimes.values()) {
      if (
        popup.threadId === threadId &&
        popup.tabId === tabId &&
        popup.window.webContents === webContents
      ) {
        return true;
      }
    }
    return false;
  }

  private commitPendingAutomationWindowOpen(key: string): void {
    const pending = this.pendingAutomationWindowOpenCommitsByRuntimeKey.get(key);
    if (!pending) return;
    this.pendingAutomationWindowOpenCommitsByRuntimeKey.delete(key);
    clearTimeout(pending.fallbackTimer);
    if (
      this.disposed ||
      pending.sourceWebContents.isDestroyed() ||
      !this.isCurrentWindowOpenSource(
        pending.threadId,
        pending.sourceTabId,
        pending.sourceWebContents,
      )
    ) {
      return;
    }
    const state = this.states.get(pending.threadId);
    if (
      !state?.open ||
      !state.tabs.some((tab) => tab.id === pending.sourceTabId) ||
      state.tabs.some((tab) => tab.id === pending.tab.id)
    ) {
      return;
    }

    state.tabs = [...state.tabs, pending.tab];
    state.activeTabId = pending.tab.id;
    this.rendererOnlyRuntimeKeys.add(buildRuntimeKey(pending.threadId, pending.tab.id));
    syncThreadLastError(state);
    this.markThreadStateChanged(pending.threadId);
    // The host can now reconcile openedTabId from canonical state, but the
    // renderer must not remove the source guest until Electron has completely
    // unwound the native window-open activation and the click response.
    this.scheduleDeferredStatePublication(key, pending.threadId, true);
  }

  private scheduleDeferredStatePublication(
    key: string,
    threadId: ThreadId,
    reattachActiveTab: boolean,
    rendererGuestToReset?: WebContents,
  ): void {
    if (this.disposed || this.pendingStatePublicationsByKey.has(key)) return;
    const handle = setTimeout(() => {
      const pending = this.pendingStatePublicationsByKey.get(key);
      if (!pending || pending.handle !== handle) return;
      this.pendingStatePublicationsByKey.delete(key);
      if (this.disposed || !this.states.has(threadId)) return;
      if (pending.rendererGuestToReset && !pending.rendererGuestToReset.isDestroyed()) {
        void pending.rendererGuestToReset.loadURL(ABOUT_BLANK_URL).catch(() => {
          // The logical tab is already closed and unroutable. A guest destroyed
          // concurrently by the renderer needs no further cleanup here.
        });
      }
      this.emitState(threadId);
      const bounds = pending.reattachActiveTab ? this.getVisibleBoundsForThread(threadId) : null;
      if (pending.reattachActiveTab && this.activeThreadId === threadId && bounds) {
        this.attachActiveTab(threadId, bounds);
      }
    }, BROWSER_DEFERRED_PUBLICATION_DELAY_MS);
    // This timer is part of the observable close/window-open handshake. Keep it
    // referenced: an unref'ed Node timer does not reliably wake Electron's main
    // loop once the triggering IPC request has drained, which can leave the
    // renderer displaying a WebView for a tab that is already closed.
    this.pendingStatePublicationsByKey.set(key, {
      handle,
      threadId,
      reattachActiveTab,
      ...(rendererGuestToReset ? { rendererGuestToReset } : {}),
    });
  }

  private discardPendingAutomationWindowOpen(key: string): void {
    const pending = this.pendingAutomationWindowOpenCommitsByRuntimeKey.get(key);
    if (!pending) return;
    clearTimeout(pending.fallbackTimer);
    this.pendingAutomationWindowOpenCommitsByRuntimeKey.delete(key);
  }

  private clearPendingWindowOpenTask(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    const pending = this.pendingWindowOpenTasksByRuntimeKey.get(key);
    if (pending) {
      clearImmediate(pending.handle);
      this.pendingWindowOpenTasksByRuntimeKey.delete(key);
    }
    this.discardPendingAutomationWindowOpen(key);
    const publication = this.pendingStatePublicationsByKey.get(key);
    if (publication) {
      clearTimeout(publication.handle);
      this.pendingStatePublicationsByKey.delete(key);
    }
  }

  private clearAllPendingWindowOpenTasks(): void {
    for (const pending of this.pendingWindowOpenTasksByRuntimeKey.values()) {
      clearImmediate(pending.handle);
    }
    this.pendingWindowOpenTasksByRuntimeKey.clear();
    for (const pending of this.pendingAutomationWindowOpenCommitsByRuntimeKey.values()) {
      clearTimeout(pending.fallbackTimer);
    }
    this.pendingAutomationWindowOpenCommitsByRuntimeKey.clear();
    for (const pending of this.pendingStatePublicationsByKey.values()) {
      clearTimeout(pending.handle);
    }
    this.pendingStatePublicationsByKey.clear();
  }

  private registerOAuthPopupWindow(popup: BrowserWindow, context: OAuthPopupContext): void {
    if (this.popupRuntimes.has(popup)) {
      return;
    }
    const runtime: OAuthPopupRuntime = {
      ...context,
      window: popup,
      listenerDisposers: [],
    };
    this.popupRuntimes.set(popup, runtime);
    popup.setMenuBarVisibility(false);
    this.configureOAuthPopupRuntime(runtime);
    this.centerPopupWindow(runtime);
  }

  private configureOAuthPopupRuntime(runtime: OAuthPopupRuntime): void {
    const { window: popup } = runtime;
    const { webContents } = popup;
    this.sessionPolicy.applyUserAgent(webContents);
    const closeOnInput = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== "keyDown") {
        return;
      }
      this.markHumanControl(runtime.threadId);
      const key = input.key.toLowerCase();
      const isCloseChord =
        key === "escape" ||
        (key === "w" && !input.shift && !input.alt && (input.meta || input.control));
      if (!isCloseChord) {
        return;
      }
      event.preventDefault();
      this.closePopupRuntime(runtime);
    };
    webContents.on("before-input-event", closeOnInput);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("before-input-event", closeOnInput);
    });

    const markPopupPointerControl = (_event: Electron.Event, input: Electron.MouseInputEvent) => {
      if (
        input.type === "mouseDown" ||
        input.type === "mouseWheel" ||
        input.type === "contextMenu"
      ) {
        this.markHumanControl(runtime.threadId);
      }
    };
    webContents.on("before-mouse-event", markPopupPointerControl);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("before-mouse-event", markPopupPointerControl);
    });

    this.configureWindowOpenHandling(webContents, runtime, runtime.listenerDisposers);

    popup.once("closed", () => {
      this.removePopupRuntime(runtime);
    });
  }

  private removePopupRuntime(runtime: OAuthPopupRuntime): void {
    if (this.popupRuntimes.get(runtime.window) !== runtime) {
      return;
    }
    for (const dispose of runtime.listenerDisposers.splice(0)) {
      dispose();
    }
    this.popupRuntimes.delete(runtime.window);
  }

  private closePopupRuntime(runtime: OAuthPopupRuntime): void {
    this.removePopupRuntime(runtime);
    if (!runtime.window.isDestroyed()) {
      runtime.window.destroy();
    }
  }

  private centerPopupWindow(runtime: OAuthPopupRuntime): void {
    const parent = this.window;
    const popup = runtime.window;
    if (!parent || parent.isDestroyed() || popup.isDestroyed()) {
      return;
    }
    const parentBounds = parent.getBounds();
    const popupBounds = popup.getBounds();
    const nextBounds = {
      x: Math.round(parentBounds.x + (parentBounds.width - popupBounds.width) / 2),
      y: Math.round(parentBounds.y + (parentBounds.height - popupBounds.height) / 2),
      width: popupBounds.width,
      height: popupBounds.height,
    };
    if (
      popupBounds.x === nextBounds.x &&
      popupBounds.y === nextBounds.y &&
      popupBounds.width === nextBounds.width &&
      popupBounds.height === nextBounds.height
    ) {
      return;
    }
    popup.setBounds(nextBounds);
  }

  private updatePopupWindowsForThread(threadId: ThreadId): void {
    for (const runtime of this.popupRuntimes.values()) {
      if (runtime.threadId === threadId) {
        this.centerPopupWindow(runtime);
      }
    }
  }

  private closePopupWindowsWhere(shouldClose: (runtime: OAuthPopupRuntime) => boolean): void {
    for (const runtime of [...this.popupRuntimes.values()]) {
      if (shouldClose(runtime)) {
        this.closePopupRuntime(runtime);
      }
    }
  }

  private closePopupWindowsForThread(threadId: ThreadId): void {
    this.closePopupWindowsWhere((runtime) => runtime.threadId === threadId);
  }

  private closePopupWindowsForTab(threadId: ThreadId, tabId: string): void {
    this.closePopupWindowsWhere(
      (runtime) => runtime.threadId === threadId && runtime.tabId === tabId,
    );
  }

  private closeAllPopupWindows(): void {
    this.closePopupWindowsWhere(() => true);
  }

  dispose(): void {
    this.disposed = true;
    this.annotations.dispose();
    this.sessionPolicy.dispose();
    this.clearAllPendingWindowOpenTasks();
    for (const timer of this.suspendTimers.values()) {
      clearTimeout(timer);
    }
    this.suspendTimers.clear();
    for (const timer of this.tabSuspendTimers.values()) {
      clearTimeout(timer);
    }
    this.tabSuspendTimers.clear();
    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
    this.closeAllPopupWindows();
    this.pendingRuntimeSyncs.clear();
    this.runtimeLastActiveAtByKey.clear();
    this.rendererOnlyRuntimeKeys.clear();
    this.listeners.clear();
    this.copyLinkListeners.clear();
    this.states.clear();
    this.threadVersionById.clear();
    this.snapshotCacheByThreadId.clear();
    this.lastEmittedVersionByThreadId.clear();
    this.humanControlEpochByThreadId.clear();
    this.humanControlListenersByThreadId.clear();
    this.expectedAutomationInputsByRuntimeKey.clear();
    this.automationGestureDepthByRuntimeKey.clear();
    this.automationWindowOpenListenersByRuntimeKey.clear();
    this.automationDownloadListenersByRuntimeKey.clear();
    this.automationSideEffectProvenanceByRuntimeKey.clear();
    this.window = null;
    this.activeThreadId = null;
    this.activeBounds = null;
    this.activeBoundsThreadId = null;
    this.attachedBoundsSignature = null;
    this.runtimeSyncFlushScheduled = false;
  }

  getPerformanceSnapshot(): BrowserPerformanceSnapshot {
    this.perfCounters.warmInactiveRuntimeCount = this.countWarmInactiveRuntimes();
    return {
      counters: { ...this.perfCounters },
      trackedProcessIds: this.getTrackedProcessIds(),
    };
  }

  getAutomationHumanControlEpoch(threadId: ThreadId): number {
    return this.humanControlEpochByThreadId.get(threadId) ?? 0;
  }

  subscribeAutomationHumanControl(
    threadId: ThreadId,
    listener: BrowserHumanControlListener,
  ): () => void {
    let listeners = this.humanControlListenersByThreadId.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.humanControlListenersByThreadId.set(threadId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.humanControlListenersByThreadId.delete(threadId);
    };
  }

  /**
   * Prepares browser state for the renderer-owned browser surface without ever
   * creating or waking a native WebContentsView. The renderer observes the
   * emitted state, mounts its visible <webview>, then calls attachWebview.
   */
  prepareAutomationTab(input: BrowserAutomationPrepareTabInput): ThreadBrowserState {
    const hadExistingTab = (this.states.get(input.threadId)?.tabs.length ?? 0) > 0;
    const state = this.ensureWorkspace(input.threadId, input.url);
    let tab = input.reuse || !hadExistingTab ? this.getActiveTab(state) : null;
    if (!tab) {
      tab = createBrowserTab(normalizeUrlInput(input.url));
      state.tabs = [...state.tabs, tab];
    }

    const key = buildRuntimeKey(input.threadId, tab.id);
    this.rendererOnlyRuntimeKeys.add(key);
    const existing = this.runtimes.get(key);
    if (existing?.ownsWebContents) {
      // A native fallback can never be an automation target. Drop it so the
      // renderer can adopt the canonical visible guest for this tab.
      this.destroyRuntime(input.threadId, tab.id, {
        preserveAutomationDownloadTracking: true,
      });
    }

    if (input.url !== undefined) {
      const nextUrl = normalizeUrlInput(input.url);
      tab.url = nextUrl;
      tab.title = defaultTitleForUrl(nextUrl);
      tab.lastCommittedUrl = null;
      tab.lastError = null;
    }
    state.open = true;
    state.activeTabId = tab.id;
    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  /** Selects a scoped tab for automation without resuming a native fallback. */
  selectAutomationTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.states.get(input.threadId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    if (!state?.open || !tab) {
      throw new Error("The requested browser tab is not available in this thread.");
    }

    const key = buildRuntimeKey(input.threadId, tab.id);
    const runtime = this.runtimes.get(key);
    this.rendererOnlyRuntimeKeys.add(key);
    let didChange = false;
    if (runtime?.ownsWebContents) {
      this.destroyRuntime(input.threadId, tab.id, {
        preserveAutomationDownloadTracking: true,
      });
      didChange = suspendTabState(tab) || didChange;
    }
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      didChange = true;
    }
    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }
    return this.snapshotThreadState(input.threadId, state);
  }

  /** Projects a navigation into renderer state before waiting for its guest. */
  prepareAutomationNavigation(input: BrowserAutomationPrepareNavigationInput): ThreadBrowserState {
    const state = this.states.get(input.threadId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    if (!state?.open || !tab) {
      throw new Error("The requested browser tab is not available in this thread.");
    }
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, tab.id));
    this.rendererOnlyRuntimeKeys.add(buildRuntimeKey(input.threadId, tab.id));
    if (runtime?.ownsWebContents) {
      this.destroyRuntime(input.threadId, tab.id, {
        preserveAutomationDownloadTracking: true,
      });
      suspendTabState(tab);
    }
    const nextUrl = normalizeUrlInput(input.url);
    tab.url = nextUrl;
    tab.title = defaultTitleForUrl(nextUrl);
    tab.lastCommittedUrl = null;
    tab.lastError = null;
    state.activeTabId = tab.id;
    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  /**
   * Returns only the renderer-owned guest that is currently selected in the
   * requested thread. Callers must treat failure as host-unavailable; this API
   * intentionally never calls ensureLiveRuntime().
   */
  getVisibleAutomationRuntime(input: BrowserTabInput): BrowserAutomationVisibleRuntime {
    const state = this.states.get(input.threadId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    if (!state?.open || !tab) {
      throw new Error("The requested browser tab is not available in this thread.");
    }
    if (state.activeTabId !== tab.id) {
      throw new Error("The requested browser tab is not the visible tab for this thread.");
    }

    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, tab.id));
    if (!runtime || runtime.webContents.isDestroyed()) {
      throw new Error("The visible browser webview has not attached yet.");
    }
    if (runtime.ownsWebContents || runtime.view !== null) {
      throw new Error("Browser automation refuses a native or fallback browser runtime.");
    }
    // A renderer guest can remain alive briefly while its panel is hidden or a
    // different thread is becoming active. It is not the user-visible browser
    // during that interval, so routing CDP to it would create exactly the split
    // brain this boundary exists to prevent.
    if (
      this.window &&
      (this.activeThreadId !== input.threadId ||
        this.attachedRuntimeKey !== runtime.key ||
        this.getVisibleBoundsForThread(input.threadId) === null ||
        runtime.webContents.hostWebContents?.id !== this.window.webContents.id)
    ) {
      throw new Error("The requested browser webview is not currently visible.");
    }
    return {
      threadId: input.threadId,
      tabId: tab.id,
      webContents: runtime.webContents,
      expectAgentInput: (signal) => this.expectAutomationInput(input.threadId, tab.id, signal),
    };
  }

  /** Closes a tab without selecting or constructing a native fallback. */
  closeAutomationTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.states.get(input.threadId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    if (!state?.open || !tab) {
      throw new Error("The requested browser tab is not available in this thread.");
    }

    this.closePopupWindowsForTab(input.threadId, input.tabId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    const preservesRendererGuest = Boolean(
      runtime &&
      !runtime.ownsWebContents &&
      state.tabs.some((candidate) => candidate.id !== input.tabId),
    );
    const defersFinalRendererRemoval = Boolean(
      runtime && !runtime.ownsWebContents && !preservesRendererGuest,
    );
    this.destroyRuntime(input.threadId, input.tabId, {
      preserveRendererDebugger: preservesRendererGuest,
    });
    this.annotations.clearProjection(input.threadId, input.tabId);
    this.rendererOnlyRuntimeKeys.delete(buildRuntimeKey(input.threadId, input.tabId));
    state.tabs = state.tabs.filter((candidate) => candidate.id !== input.tabId);
    if (state.activeTabId === input.tabId) {
      state.activeTabId = state.tabs.at(-1)?.id ?? null;
    }
    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    if (defersFinalRendererRemoval) {
      // Removing a live <webview> from an IPC state callback while the close
      // request is still unwinding can deadlock Electron. Publish on the next
      // frame after the debugger has detached and the tool response can drain.
      this.scheduleDeferredStatePublication(
        buildRuntimeKey(input.threadId, input.tabId),
        input.threadId,
        false,
        runtime?.webContents,
      );
    } else {
      this.emitState(input.threadId);
    }
    return this.snapshotThreadState(input.threadId, state);
  }

  open(input: BrowserOpenInput): ThreadBrowserState {
    const previousState = this.states.get(input.threadId);
    const nextInitialUrl = input.initialUrl ? normalizeUrlInput(input.initialUrl) : null;
    const previousActiveTab = previousState ? this.getActiveTab(previousState) : null;
    const willNavigateExistingTab =
      nextInitialUrl !== null &&
      previousActiveTab !== null &&
      previousActiveTab.url !== nextInitialUrl;
    // BrowserPanel mounts by hydrating state already prepared by browser_open.
    // That renderer lifecycle is agent-caused, not a human takeover. Manual
    // opens that change visibility still advance the epoch; URL changes flow
    // through navigate(), which advances it exactly once.
    if (previousState?.open !== true && !willNavigateExistingTab) {
      this.markHumanControl(input.threadId);
    }
    const state = this.ensureWorkspace(input.threadId, input.initialUrl);
    const didChange = !state.open;
    state.open = true;
    const activeTab = nextInitialUrl ? this.getActiveTab(state) : null;
    if (nextInitialUrl && activeTab && activeTab.url !== nextInitialUrl) {
      return this.navigate({
        threadId: input.threadId,
        tabId: activeTab.id,
        url: nextInitialUrl,
      });
    }

    const nextDidChange = syncThreadLastError(state) || didChange;

    if (
      this.activeBounds &&
      this.activeBoundsThreadId === input.threadId &&
      (this.activeThreadId === null || this.activeThreadId === input.threadId)
    ) {
      const visibleTab = this.getActiveTab(state);
      if (!isBlankBrowserTabUrl(visibleTab)) {
        this.activateThread(input.threadId, this.activeBounds);
      }
    }

    if (nextDidChange) {
      this.markThreadStateChanged(input.threadId);
    }
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  close(input: BrowserThreadInput): ThreadBrowserState {
    this.markHumanControl(input.threadId);
    this.clearSuspendTimer(input.threadId);

    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }
    this.clearActiveBoundsForThread(input.threadId);
    this.closePopupWindowsForThread(input.threadId);

    const existingState = this.states.get(input.threadId);
    this.destroyThreadRuntimes(input.threadId);
    for (const tab of existingState?.tabs ?? []) {
      this.annotations.clearProjection(input.threadId, tab.id);
      this.rendererOnlyRuntimeKeys.delete(buildRuntimeKey(input.threadId, tab.id));
    }

    const state = this.getOrCreateState(input.threadId);
    state.open = false;
    state.activeTabId = null;
    state.tabs = [];
    state.lastError = null;
    this.markThreadStateChanged(input.threadId);
    this.lastEmittedVersionByThreadId.delete(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  hide(input: BrowserThreadInput): void {
    this.markHumanControl(input.threadId);
    const state = this.states.get(input.threadId);
    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }

    if (!state?.open) {
      return;
    }

    this.scheduleThreadSuspend(input.threadId);
  }

  getState(input: BrowserThreadInput): ThreadBrowserState {
    return this.snapshotThreadState(input.threadId);
  }

  setPanelBounds(input: BrowserSetPanelBoundsInput): void {
    this.perfCounters.setPanelBoundsCalls += 1;
    const state = this.getOrCreateState(input.threadId);
    const nextBounds = normalizeBounds(input.bounds);
    const nextBoundsSignature = browserBoundsSignature(nextBounds);
    const activeTabId = this.getActiveTab(state)?.id ?? null;
    const activeRuntimeKey = activeTabId ? buildRuntimeKey(input.threadId, activeTabId) : null;
    const activeRuntime = activeRuntimeKey ? this.runtimes.get(activeRuntimeKey) : null;
    const requiresRenderer = activeRuntimeKey
      ? this.rendererOnlyRuntimeKeys.has(activeRuntimeKey)
      : false;
    this.setActiveBounds(input.threadId, nextBounds);

    if (!state.open || nextBounds === null) {
      if (this.activeThreadId === input.threadId) {
        this.detachAttachedRuntime();
        this.activeThreadId = null;
        this.scheduleThreadSuspend(input.threadId);
      }
      return;
    }

    if (
      input.surface === "native" &&
      !requiresRenderer &&
      activeTabId &&
      activeRuntime &&
      !activeRuntime.ownsWebContents
    ) {
      // Sheet mode renders more reliably with the native WebContentsView than a translated <webview>.
      this.destroyRuntime(input.threadId, activeTabId);
      const activeTab = this.getTab(state, activeTabId);
      if (activeTab) {
        suspendTabState(activeTab);
        this.markThreadStateChanged(input.threadId);
      }
      this.attachedRuntimeKey = null;
      this.attachedBoundsSignature = null;
    }

    if ((input.surface === "renderer" || requiresRenderer) && activeTabId && !activeRuntime) {
      this.activateThreadForPendingRenderer(input.threadId, nextBounds);
      return;
    }

    // Bounds sync fires often during panel motion. If the visible runtime and
    // applied viewport are already current, avoid waking the browser stack again.
    if (
      this.activeThreadId === input.threadId &&
      this.attachedRuntimeKey === activeRuntimeKey &&
      this.attachedBoundsSignature === nextBoundsSignature
    ) {
      this.perfCounters.setPanelBoundsNoopSkips += 1;
      return;
    }

    this.updatePopupWindowsForThread(input.threadId);

    if (this.activeThreadId === input.threadId) {
      if (activeRuntimeKey && this.attachedRuntimeKey === activeRuntimeKey) {
        const runtime = this.runtimes.get(activeRuntimeKey);
        if (runtime) {
          this.perfCounters.setPanelBoundsViewportUpdates += 1;
          this.attachRuntime(runtime, nextBounds);
          return;
        }
      }
      this.attachActiveTab(input.threadId, nextBounds);
      return;
    }

    this.activateThread(input.threadId, nextBounds);
  }

  // Adopts the renderer-owned <webview> so the visible page and browser host tools
  // share one WebContents instead of racing a hidden native WebContentsView.
  attachWebview(input: BrowserAttachWebviewInput, hostWebContentsId: number): ThreadBrowserState {
    const state = this.states.get(input.threadId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    if (!state?.open || !tab) {
      throw new Error("The requested browser tab is not available in this thread.");
    }
    if (state.activeTabId !== tab.id) {
      throw new Error("A visible browser webview can only attach to the active tab.");
    }
    const webContents = electronWebContents.fromId(input.webContentsId);
    if (!webContents || webContents.isDestroyed()) {
      throw new Error("The visible browser webview is not available.");
    }
    if (
      webContents.getType() !== "webview" ||
      webContents.hostWebContents?.id !== hostWebContentsId ||
      (this.window !== null && hostWebContentsId !== this.window.webContents.id) ||
      webContents.session !== electronSession.fromPartition(BROWSER_SESSION_PARTITION)
    ) {
      throw new Error("The browser webview does not belong to this Synara window and partition.");
    }

    const key = buildRuntimeKey(input.threadId, tab.id);
    const existingRendererRuntime = this.findRendererRuntimeByWebContentsId(webContents.id);
    if (existingRendererRuntime && existingRendererRuntime.key !== key) {
      this.destroyRuntime(existingRendererRuntime.threadId, existingRendererRuntime.tabId, {
        preserveRendererDebugger: true,
        annotationReason: "replaced",
      });
    }

    const existing = this.runtimes.get(key);
    if (existing?.webContents.id !== webContents.id) {
      if (existing) {
        if (!existing.ownsWebContents && !existing.webContents.isDestroyed()) {
          // Never let a late dom-ready/invoke from a duplicate hidden WebView
          // steal a live logical tab from the guest already bound to it. A real
          // renderer replacement first detaches the old guest (or Electron has
          // destroyed it during a shell reload), after which retries may bind.
          throw new Error("This browser tab is already attached to another visible webview.");
        }
        this.destroyRuntime(input.threadId, tab.id, {
          preserveAutomationDownloadTracking: true,
          annotationReason: "replaced",
        });
      }
      const runtime: LiveTabRuntime = {
        key,
        threadId: input.threadId,
        tabId: tab.id,
        webContents,
        view: null,
        ownsWebContents: false,
        listenerDisposers: [],
      };
      this.configureRuntimeWebContents(runtime);
      this.runtimes.set(key, runtime);
    }
    this.rendererOnlyRuntimeKeys.add(key);

    const bounds = this.getVisibleBoundsForThread(input.threadId);
    const runtime = this.runtimes.get(key);
    if (runtime && bounds) {
      this.attachRuntime(runtime, bounds);
    }

    const expectedUrl = normalizeUrlInput(tab.lastCommittedUrl ?? tab.url);
    const requiresLocalPreviewBootstrap =
      isLocalFileUrl(expectedUrl) &&
      this.sessionPolicy.resolveDisplayUrl(webContents.getURL()) !== expectedUrl;
    if (requiresLocalPreviewBootstrap) {
      void this.loadTab(input.threadId, tab.id, {
        force: true,
        ...(runtime ? { runtime } : {}),
      });
      return this.snapshotThreadState(input.threadId, state);
    }

    const didChange = tab.status !== LIVE_TAB_STATUS || tab.lastError !== null;
    tab.status = LIVE_TAB_STATUS;
    tab.lastError = null;
    const nextDidChange = syncThreadLastError(state) || didChange;
    if (nextDidChange) {
      this.markThreadStateChanged(input.threadId);
    }
    this.queueRuntimeStateSync(input.threadId, tab.id);
    if (nextDidChange) {
      this.emitState(input.threadId);
    }
    return this.snapshotThreadState(input.threadId, state);
  }

  // Drops main-process ownership of a renderer-owned <webview> that React removed.
  // The webContents id guard keeps stale cleanup calls from tearing down a newly attached view.
  detachWebview(input: BrowserDetachWebviewInput): void {
    const state = this.states.get(input.threadId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    if (!state || !tab) {
      return;
    }

    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (!runtime || runtime.ownsWebContents || runtime.webContents.id !== input.webContentsId) {
      return;
    }

    this.destroyRuntime(input.threadId, input.tabId);
    const didChange = suspendTabState(tab) || syncThreadLastError(state);
    if (didChange) {
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }
  }

  navigate(input: BrowserNavigateInput): ThreadBrowserState {
    this.markHumanControl(input.threadId);
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const nextUrl = normalizeUrlInput(input.url);
    tab.url = nextUrl;
    tab.title = defaultTitleForUrl(nextUrl);
    tab.lastCommittedUrl = null;
    tab.lastError = null;
    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);

    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, tab.id));
    if (runtime) {
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.attachRuntime(runtime, bounds);
      }
      void this.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else if (
      this.activeThreadId === input.threadId &&
      !this.rendererOnlyRuntimeKeys.has(buildRuntimeKey(input.threadId, tab.id))
    ) {
      // Load the target tab directly so we don't clobber its pending URL with a
      // thread-wide runtime sync from the old live page state.
      const nextRuntime = this.ensureLiveRuntime(input.threadId, tab.id);
      this.clearSuspendTimer(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.attachRuntime(nextRuntime, bounds);
      }
      void this.loadTab(input.threadId, tab.id, { force: true, runtime: nextRuntime });
    }

    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  reload(input: BrowserTabInput): ThreadBrowserState {
    this.markHumanControl(input.threadId);
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, tab.id));
    if (runtime) {
      runtime.webContents.reload();
    } else if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      void this.loadTab(input.threadId, tab.id, { force: true });
    }
    return this.snapshotThreadState(input.threadId, state);
  }

  goBack(input: BrowserTabInput): ThreadBrowserState {
    this.markHumanControl(input.threadId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (runtime && canWebContentsGoBack(runtime.webContents)) {
      runtime.webContents.goBack();
    }
    return this.getState({ threadId: input.threadId });
  }

  goForward(input: BrowserTabInput): ThreadBrowserState {
    this.markHumanControl(input.threadId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (runtime && canWebContentsGoForward(runtime.webContents)) {
      runtime.webContents.goForward();
    }
    return this.getState({ threadId: input.threadId });
  }

  newTab(input: BrowserNewTabInput): ThreadBrowserState {
    this.markHumanControl(input.threadId);
    const state = this.ensureWorkspace(input.threadId);
    const tab = createBrowserTab(normalizeUrlInput(input.url));
    state.tabs = [...state.tabs, tab];
    if (input.activate !== false || !state.activeTabId) {
      state.activeTabId = tab.id;
    }

    if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.attachActiveTab(input.threadId, bounds, { forceLoad: true });
      }
    } else {
      tab.status = "suspended";
    }

    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  closeTab(input: BrowserTabInput): ThreadBrowserState {
    this.markHumanControl(input.threadId);
    const state = this.ensureWorkspace(input.threadId);
    const nextTabs = state.tabs.filter((tab) => tab.id !== input.tabId);
    if (nextTabs.length === state.tabs.length) {
      return this.snapshotThreadState(input.threadId, state);
    }

    this.closePopupWindowsForTab(input.threadId, input.tabId);
    this.destroyRuntime(input.threadId, input.tabId);
    this.annotations.clearProjection(input.threadId, input.tabId);
    this.rendererOnlyRuntimeKeys.delete(buildRuntimeKey(input.threadId, input.tabId));
    state.tabs = nextTabs;

    if (nextTabs.length === 0) {
      // Closing the last tab keeps the browser open on a fresh blank tab (the same state
      // as a brand-new browser session) so the user can type a new URL in the search box,
      // instead of tearing the whole panel down.
      const replacementTab = createBrowserTab();
      state.tabs = [replacementTab];
      state.activeTabId = replacementTab.id;
      state.lastError = null;

      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
      return this.snapshotThreadState(input.threadId, state);
    }

    if (!state.activeTabId || state.activeTabId === input.tabId) {
      state.activeTabId = nextTabs[Math.max(0, nextTabs.length - 1)]?.id ?? null;
    }

    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (this.activeThreadId === input.threadId && bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  selectTab(input: BrowserTabInput): ThreadBrowserState {
    this.markHumanControl(input.threadId);
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    this.activateTab(input.threadId, state, tab);

    if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (bounds) {
        this.attachActiveTab(input.threadId, bounds);
      }
    }

    return this.snapshotThreadState(input.threadId, state);
  }

  openDevTools(input: BrowserTabInput): void {
    this.markHumanControl(input.threadId);
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    this.activateTab(input.threadId, state, tab);

    this.resumeThread(input.threadId);
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }
    runtime.webContents.openDevTools({ mode: "detach" });
  }

  // Ensures the requested tab is active/live, then returns a fresh PNG capture
  // from the native browser surface for whichever destination needs it next.
  private async captureScreenshotPng(input: BrowserTabInput): Promise<{
    name: string;
    pngBytes: Buffer;
  }> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    this.activateTab(input.threadId, state, tab);

    this.resumeThread(input.threadId);
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const webContents = runtime.webContents;
    const expectedUrl = normalizeUrlInput(tab.lastCommittedUrl ?? tab.url);
    const currentUrl = this.sessionPolicy.resolveDisplayUrl(webContents.getURL());
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    if (wasSuspended || currentUrl.length === 0 || currentUrl !== expectedUrl) {
      await this.loadTab(input.threadId, tab.id, { runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    const pngBytes = (await webContents.capturePage()).toPNG();
    if (pngBytes.byteLength === 0) {
      throw new Error("Couldn't capture a browser screenshot.");
    }

    return {
      name: screenshotFileNameForUrl(tab.lastCommittedUrl ?? tab.url),
      pngBytes,
    };
  }

  // Captures the current browser viewport as a PNG so the renderer can attach
  // it directly to the composer without introducing temp-file disk churn.
  async captureScreenshot(input: BrowserTabInput): Promise<BrowserCaptureScreenshotResult> {
    const { name, pngBytes } = await this.captureScreenshotPng(input);

    return {
      name,
      mimeType: "image/png",
      sizeBytes: pngBytes.byteLength,
      bytes: Uint8Array.from(pngBytes),
    };
  }

  // Copies the active tab's URL via the native clipboard and emits the copy-link
  // event, mirroring the keyboard-chord path. The renderer's navigator.clipboard
  // can reject with "Document is not focused" while the native page view holds
  // focus, so the React toolbar button routes through here for reliability.
  copyLink(input: BrowserTabInput): void {
    this.copyTabLink(input.threadId, input.tabId);
  }

  // Writes the current browser viewport screenshot straight to the native
  // clipboard so the renderer does not have to ferry image payloads over IPC.
  async copyScreenshotToClipboard(input: BrowserTabInput): Promise<void> {
    const { pngBytes } = await this.captureScreenshotPng(input);
    const image = nativeImage.createFromBuffer(pngBytes);
    if (image.isEmpty()) {
      throw new Error("Couldn't copy a browser screenshot to the clipboard.");
    }
    clipboard.writeImage(image);
  }

  private activateThread(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    const previousThreadId = this.activeThreadId;
    if (this.activeThreadId && this.activeThreadId !== threadId) {
      this.scheduleThreadSuspend(this.activeThreadId);
    }

    this.activeThreadId = threadId;
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
    if (previousThreadId && previousThreadId !== threadId) {
      this.updatePopupWindowsForThread(previousThreadId);
    }
    this.resumeThread(threadId);
    this.attachActiveTab(threadId, bounds);
    this.updatePopupWindowsForThread(threadId);
  }

  // Renderer panels create their own <webview>; keep active-thread bookkeeping current while
  // waiting for attachWebview so startup does not create a duplicate native WebContentsView.
  private activateThreadForPendingRenderer(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    const previousThreadId = this.activeThreadId;
    if (previousThreadId && previousThreadId !== threadId) {
      this.scheduleThreadSuspend(previousThreadId);
      this.updatePopupWindowsForThread(previousThreadId);
    }
    this.activeThreadId = threadId;
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
    this.clearSuspendTimer(threadId);
    this.updatePopupWindowsForThread(threadId);
  }

  private setActiveBounds(threadId: ThreadId, bounds: BrowserPanelBounds | null): void {
    if (!bounds) {
      this.clearActiveBoundsForThread(threadId);
      return;
    }
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
  }

  private clearActiveBoundsForThread(threadId: ThreadId): void {
    if (this.activeBoundsThreadId !== threadId) {
      return;
    }
    this.activeBounds = null;
    this.activeBoundsThreadId = null;
  }

  private getVisibleBoundsForThread(threadId: ThreadId): BrowserPanelBounds | null {
    return this.activeBoundsThreadId === threadId ? this.activeBounds : null;
  }

  private resumeThread(threadId: ThreadId): void {
    const state = this.ensureWorkspace(threadId);
    if (!state.open) {
      return;
    }

    this.clearSuspendTimer(threadId);
    const activeTab = this.getActiveTab(state);
    let didChange = this.suspendInactiveTabs(threadId, activeTab?.id ?? null);

    // Only resume the visible tab. Waking every tab can fan out into several
    // Chromium renderer processes and background page activity at once.
    for (const tab of state.tabs) {
      if (tab.id !== activeTab?.id) {
        continue;
      }
      const runtimeKey = buildRuntimeKey(threadId, tab.id);
      if (this.rendererOnlyRuntimeKeys.has(runtimeKey)) {
        const rendererRuntime = this.runtimes.get(runtimeKey);
        if (!rendererRuntime || rendererRuntime.ownsWebContents) {
          if (rendererRuntime?.ownsWebContents) this.destroyRuntime(threadId, tab.id);
          continue;
        }
      }
      const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
      const runtime = this.ensureLiveRuntime(threadId, tab.id);
      if (wasSuspended) {
        void this.loadTab(threadId, tab.id, { force: true, runtime });
      } else {
        didChange =
          syncTabStateFromRuntime(state, tab, runtime.webContents, (url) =>
            this.sessionPolicy.resolveDisplayUrl(url),
          ) || didChange;
      }
    }

    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private suspendInactiveTabs(threadId: ThreadId, activeTabId: string | null): boolean {
    const state = this.states.get(threadId);
    if (!state) {
      return false;
    }

    let didChange = false;
    const inactiveRuntimeTabIds = state.tabs
      .filter((tab) => tab.id !== activeTabId)
      .filter((tab) => this.runtimes.has(buildRuntimeKey(threadId, tab.id)))
      .sort((left, right) => {
        const leftKey = buildRuntimeKey(threadId, left.id);
        const rightKey = buildRuntimeKey(threadId, right.id);
        return (
          (this.runtimeLastActiveAtByKey.get(rightKey) ?? 0) -
          (this.runtimeLastActiveAtByKey.get(leftKey) ?? 0)
        );
      });
    const warmRuntimeTabIds = new Set(
      inactiveRuntimeTabIds
        .slice(0, BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD)
        .map((tab) => tab.id),
    );

    for (const tab of state.tabs) {
      if (tab.id === activeTabId) {
        this.clearTabSuspendTimer(threadId, tab.id);
        continue;
      }

      const runtime = this.runtimes.get(buildRuntimeKey(threadId, tab.id));
      if (runtime) {
        if (warmRuntimeTabIds.has(tab.id)) {
          this.scheduleInactiveTabSuspend(threadId, tab.id);
          continue;
        }

        this.perfCounters.inactiveTabBudgetEvictions += 1;
        this.destroyRuntime(threadId, tab.id);
        didChange = suspendTabState(tab) || didChange;
        continue;
      }

      didChange = suspendTabState(tab) || didChange;
    }

    return didChange;
  }

  private scheduleThreadSuspend(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state?.open || this.activeThreadId === threadId) {
      return;
    }

    this.clearSuspendTimer(threadId);
    const timer = setTimeout(() => {
      this.suspendThread(threadId);
      this.suspendTimers.delete(threadId);
    }, BROWSER_THREAD_SUSPEND_DELAY_MS);
    timer.unref();
    this.suspendTimers.set(threadId, timer);
  }

  private suspendThread(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state || this.activeThreadId === threadId) {
      return;
    }

    let didChange = false;
    for (const tab of state.tabs) {
      this.destroyRuntime(threadId, tab.id);
      didChange = suspendTabState(tab) || didChange;
    }

    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private clearSuspendTimer(threadId: ThreadId): void {
    const existing = this.suspendTimers.get(threadId);
    if (!existing) {
      return;
    }
    clearTimeout(existing);
    this.suspendTimers.delete(threadId);
  }

  private scheduleInactiveTabSuspend(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    if (this.tabSuspendTimers.has(key)) {
      return;
    }

    this.perfCounters.inactiveTabSuspendScheduled += 1;
    const delayMs = this.resolveInactiveTabSuspendDelay(threadId);
    const timer = setTimeout(() => {
      this.tabSuspendTimers.delete(key);
      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      if (!state || !tab) {
        return;
      }

      this.destroyRuntime(threadId, tabId);
      const didChange = suspendTabState(tab) || syncThreadLastError(state);
      if (didChange) {
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      }
    }, delayMs);
    timer.unref();
    this.tabSuspendTimers.set(key, timer);
  }

  private clearTabSuspendTimer(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    const existing = this.tabSuspendTimers.get(key);
    if (!existing) {
      return;
    }

    clearTimeout(existing);
    this.tabSuspendTimers.delete(key);
    this.perfCounters.inactiveTabSuspendCancelled += 1;
  }

  private attachActiveTab(
    threadId: ThreadId,
    bounds: BrowserPanelBounds,
    options: { forceLoad?: boolean } = {},
  ): void {
    const state = this.ensureWorkspace(threadId);
    const activeTab = this.getActiveTab(state);
    if (!activeTab) {
      return;
    }

    this.suspendInactiveTabs(threadId, activeTab.id);
    const runtimeKey = buildRuntimeKey(threadId, activeTab.id);
    if (this.rendererOnlyRuntimeKeys.has(runtimeKey)) {
      const rendererRuntime = this.runtimes.get(runtimeKey);
      if (!rendererRuntime || rendererRuntime.ownsWebContents) {
        if (rendererRuntime?.ownsWebContents) this.destroyRuntime(threadId, activeTab.id);
        this.activateThreadForPendingRenderer(threadId, bounds);
        return;
      }
    }
    const wasSuspended = activeTab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.ensureLiveRuntime(threadId, activeTab.id);
    this.attachRuntime(runtime, bounds);
    if (options.forceLoad || wasSuspended) {
      void this.loadTab(threadId, activeTab.id, {
        force: options.forceLoad || wasSuspended,
        runtime,
      });
    } else {
      this.syncRuntimeState(threadId, activeTab.id);
    }
  }

  private attachRuntime(runtime: LiveTabRuntime, bounds: BrowserPanelBounds): void {
    const window = this.window;
    if (!window) {
      return;
    }

    const nextBoundsSignature = browserBoundsSignature(bounds);
    this.runtimeLastActiveAtByKey.set(runtime.key, Date.now());
    // Renderer-owned <webview> runtimes are already visible in React; keep any
    // old native view detached so it cannot cover the real browser surface.
    if (!runtime.ownsWebContents) {
      if (this.attachedRuntimeKey && this.attachedRuntimeKey !== runtime.key) {
        this.detachAttachedRuntime();
      }
      this.attachedRuntimeKey = runtime.key;
      this.attachedBoundsSignature = nextBoundsSignature;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }
    if (!runtime.view) {
      this.attachedRuntimeKey = runtime.key;
      this.attachedBoundsSignature = nextBoundsSignature;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }
    if (this.attachedRuntimeKey === runtime.key) {
      this.setRuntimeViewHidden(runtime, false);
      this.bringRuntimeViewToFront(runtime);
      if (this.attachedBoundsSignature === nextBoundsSignature) {
        return;
      }
      runtime.view.setBounds(bounds);
      this.attachedBoundsSignature = nextBoundsSignature;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }

    this.detachAttachedRuntime();
    this.setRuntimeViewHidden(runtime, false);
    this.bringRuntimeViewToFront(runtime);
    runtime.view.setBounds(bounds);
    this.attachedRuntimeKey = runtime.key;
    this.attachedBoundsSignature = nextBoundsSignature;
    this.updatePopupWindowsForThread(runtime.threadId);
  }

  private bringRuntimeViewToFront(runtime: LiveTabRuntime): void {
    const window = this.window;
    if (!window || !runtime.view) {
      return;
    }

    try {
      window.contentView.removeChildView(runtime.view);
    } catch {
      // Electron throws when the view is not attached yet; adding it below is the desired state.
    }
    window.contentView.addChildView(runtime.view);
  }

  private detachAttachedRuntime(): void {
    if (!this.window || !this.attachedRuntimeKey) {
      this.attachedRuntimeKey = null;
      this.attachedBoundsSignature = null;
      return;
    }

    const runtime = this.runtimes.get(this.attachedRuntimeKey);
    if (runtime?.view) {
      this.setRuntimeViewHidden(runtime, true);
      this.window.contentView.removeChildView(runtime.view);
    }
    this.attachedRuntimeKey = null;
    this.attachedBoundsSignature = null;
  }

  private setRuntimeViewHidden(runtime: LiveTabRuntime, hidden: boolean): void {
    if (!runtime.view) {
      return;
    }
    const nativeView = runtime.view as typeof runtime.view & NativeBrowserViewVisibility;
    nativeView.setVisible?.(!hidden);
    if (hidden) {
      runtime.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  private ensureLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const key = buildRuntimeKey(threadId, tabId);
    this.clearTabSuspendTimer(threadId, tabId);
    const existing = this.runtimes.get(key);
    if (existing) {
      if (existing.webContents.isDestroyed()) {
        this.destroyRuntime(threadId, tabId);
      } else {
        return existing;
      }
    }

    if (this.rendererOnlyRuntimeKeys.has(key)) {
      throw new Error("This tab requires its renderer-owned browser webview.");
    }

    const runtime = this.createLiveRuntime(threadId, tabId);
    this.runtimes.set(key, runtime);
    const state = this.ensureWorkspace(threadId);
    const tab = this.getTab(state, tabId);
    if (tab) {
      const didChange = tab.status !== "live" || tab.lastError !== null;
      tab.status = "live";
      tab.lastError = null;
      syncThreadLastError(state);
      if (didChange) {
        this.markThreadStateChanged(threadId);
      }
    }
    return runtime;
  }

  private createLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const runtime: LiveTabRuntime = {
      key: buildRuntimeKey(threadId, tabId),
      threadId,
      tabId,
      webContents: view.webContents,
      view,
      ownsWebContents: true,
      listenerDisposers: [],
    };
    this.configureRuntimeWebContents(runtime);
    return runtime;
  }

  private configureRuntimeWebContents(runtime: LiveTabRuntime): void {
    const { threadId, tabId, webContents } = runtime;

    // Belt-and-suspenders alongside the session-level UA: also covers an adopted renderer
    // <webview> for any navigation after it attaches.
    this.sessionPolicy.applyUserAgent(webContents);

    this.configureWindowOpenHandling(webContents, runtime, runtime.listenerDisposers);

    // The native page owns keyboard focus while browsing, so the renderer never sees the
    // shell's physical zoom fallback or copy-link chord. Give the shell first refusal,
    // then handle browser-local chords here.
    const beforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
      if (this.options.beforeInputEvent?.(event, input)) {
        return;
      }
      if (input.type !== "keyDown") {
        return;
      }
      if (
        this.consumeExpectedAutomationInput(threadId, tabId, {
          kind: "key",
          key: input.key,
          alt: input.alt === true,
          control: input.control === true,
          meta: input.meta === true,
          shift: input.shift === true,
        })
      ) {
        return;
      }
      this.markHumanControl(threadId);
      const matches = isBrowserCopyLinkChord(
        {
          meta: input.meta,
          ctrl: input.control,
          shift: input.shift,
          alt: input.alt,
          key: input.key,
        },
        process.platform === "darwin",
      );
      if (!matches) {
        return;
      }
      event.preventDefault();
      this.copyTabLink(threadId, tabId);
    };
    webContents.on("before-input-event", beforeInputEvent);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("before-input-event", beforeInputEvent);
    });

    const beforeMouseEvent = (_event: Electron.Event, input: Electron.MouseInputEvent) => {
      if (
        input.type === "mouseDown" ||
        input.type === "mouseWheel" ||
        input.type === "contextMenu"
      ) {
        if (
          this.consumeExpectedAutomationInput(threadId, tabId, {
            kind: "mouse",
            type: input.type,
            x: input.x,
            y: input.y,
            ...(input.button === undefined ? {} : { button: input.button }),
          })
        ) {
          return;
        }
        this.markHumanControl(threadId);
      }
    };
    webContents.on("before-mouse-event", beforeMouseEvent);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("before-mouse-event", beforeMouseEvent);
    });

    const pageTitleUpdated = (event: Electron.Event) => {
      event.preventDefault();
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("page-title-updated", pageTitleUpdated);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("page-title-updated", pageTitleUpdated);
    });

    const pageFaviconUpdated = (_event: Electron.Event, faviconUrls: string[]) => {
      this.queueRuntimeStateSync(threadId, tabId, faviconUrls);
    };
    webContents.on("page-favicon-updated", pageFaviconUpdated);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("page-favicon-updated", pageFaviconUpdated);
    });

    const didStartLoading = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-start-loading", didStartLoading);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-start-loading", didStartLoading);
    });

    const didStopLoading = () => {
      this.queueRuntimeStateSync(threadId, tabId);
      this.annotations.recoverNavigation(threadId, tabId, webContents.id);
    };
    webContents.on("did-stop-loading", didStopLoading);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-stop-loading", didStopLoading);
    });

    const didNavigate = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-navigate", didNavigate);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-navigate", didNavigate);
    });

    const didStartNavigation = (
      _event: Electron.Event,
      _url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && !_isInPlace) {
        this.annotations.handleNavigation(threadId, tabId, webContents.id);
      }
    };
    webContents.on("did-start-navigation", didStartNavigation);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-start-navigation", didStartNavigation);
    });

    const didNavigateInPage = () => {
      this.queueRuntimeStateSync(threadId, tabId);
      this.annotations.handleInPageNavigation(threadId, tabId, webContents.id);
    };
    webContents.on("did-navigate-in-page", didNavigateInPage);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-navigate-in-page", didNavigateInPage);
    });

    const didFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      _errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) {
        return;
      }
      this.annotations.recoverNavigation(threadId, tabId, webContents.id);
      if (errorCode === BROWSER_ERROR_ABORTED) return;

      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      if (!state || !tab) {
        return;
      }

      tab.url = validatedURL ? this.sessionPolicy.resolveDisplayUrl(validatedURL) : tab.url;
      tab.title = defaultTitleForUrl(tab.url);
      tab.isLoading = false;
      tab.lastError = mapBrowserLoadError(errorCode);
      syncThreadLastError(state);
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    };
    webContents.on("did-fail-load", didFailLoad);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-fail-load", didFailLoad);
    });

    let runtimeLossHandled = false;
    const handleRuntimeLoss = () => {
      // Electron can report both a crashed process and the eventual
      // WebContents destruction. Only the runtime that installed this handler
      // may invalidate the logical tab; a late event from an old guest must not
      // tear down a replacement already stored under the same runtime key.
      if (runtimeLossHandled || this.runtimes.get(runtime.key) !== runtime) {
        return;
      }
      runtimeLossHandled = true;
      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      this.destroyRuntime(threadId, tabId);
      if (state && tab) {
        tab.status = "suspended";
        tab.isLoading = false;
        tab.lastError = "This tab stopped unexpectedly.";
        syncThreadLastError(state);
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      }
      const bounds = this.getVisibleBoundsForThread(threadId);
      if (this.activeThreadId === threadId && bounds) {
        this.attachActiveTab(threadId, bounds);
      }
    };
    webContents.on("render-process-gone", handleRuntimeLoss);
    webContents.on("destroyed", handleRuntimeLoss);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("render-process-gone", handleRuntimeLoss);
      webContents.removeListener("destroyed", handleRuntimeLoss);
    });
  }

  private async loadTab(
    threadId: ThreadId,
    tabId: string,
    options: { force?: boolean; runtime?: LiveTabRuntime } = {},
  ): Promise<void> {
    const state = this.ensureWorkspace(threadId);
    const tab = this.getTab(state, tabId);
    if (!tab) {
      return;
    }

    const runtime = options.runtime ?? this.ensureLiveRuntime(threadId, tabId);
    const webContents = runtime.webContents;
    const nextUrl = normalizeUrlInput(
      options.force === true ? tab.url : (tab.lastCommittedUrl ?? tab.url),
    );
    const currentUrl = this.sessionPolicy.resolveDisplayUrl(webContents.getURL());
    const shouldLoad = options.force === true || currentUrl !== nextUrl || currentUrl.length === 0;

    if (!shouldLoad) {
      this.queueRuntimeStateSync(threadId, tabId);
      return;
    }

    tab.url = nextUrl;
    tab.status = "live";
    tab.isLoading = true;
    tab.lastError = null;
    syncThreadLastError(state);
    this.markThreadStateChanged(threadId);
    this.emitState(threadId);

    try {
      await webContents.loadURL(this.sessionPolicy.resolveRuntimeUrl(nextUrl));
      this.queueRuntimeStateSync(threadId, tabId);
    } catch (error) {
      if (isAbortedNavigationError(error)) {
        this.queueRuntimeStateSync(threadId, tabId);
        return;
      }

      tab.isLoading = false;
      tab.lastError = "Couldn't open this page.";
      syncThreadLastError(state);
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private syncRuntimeState(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    this.perfCounters.syncRuntimeStateCalls += 1;
    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    if (!state || !tab || !runtime) {
      return;
    }

    const didChange = syncTabStateFromRuntime(
      state,
      tab,
      runtime.webContents,
      (url) => this.sessionPolicy.resolveDisplayUrl(url),
      faviconUrls,
    );
    const nextDidChange = syncThreadLastError(state) || didChange;
    if (nextDidChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private queueRuntimeStateSync(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    const key = buildRuntimeKey(threadId, tabId);
    const existing = this.pendingRuntimeSyncs.get(key);
    const nextPendingSync: PendingRuntimeSync = {
      threadId,
      tabId,
    };
    const nextFaviconUrls = faviconUrls ?? existing?.faviconUrls;
    if (nextFaviconUrls !== undefined) {
      nextPendingSync.faviconUrls = nextFaviconUrls;
    }
    this.pendingRuntimeSyncs.set(key, nextPendingSync);

    if (this.runtimeSyncFlushScheduled) {
      return;
    }

    this.runtimeSyncFlushScheduled = true;
    queueMicrotask(() => {
      this.runtimeSyncFlushScheduled = false;
      if (this.pendingRuntimeSyncs.size === 0) {
        return;
      }

      this.perfCounters.runtimeSyncQueueFlushes += 1;
      const pendingSyncs = [...this.pendingRuntimeSyncs.values()];
      this.pendingRuntimeSyncs.clear();
      for (const pendingSync of pendingSyncs) {
        this.syncRuntimeState(pendingSync.threadId, pendingSync.tabId, pendingSync.faviconUrls);
      }
    });
  }

  private destroyThreadRuntimes(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state) {
      return;
    }

    for (const tab of state.tabs) {
      this.destroyRuntime(threadId, tab.id);
    }
  }

  private destroyAllRuntimes(): void {
    for (const runtime of this.runtimes.values()) {
      this.destroyRuntime(runtime.threadId, runtime.tabId);
    }
  }

  private destroyRuntime(
    threadId: ThreadId,
    tabId: string,
    options: {
      readonly preserveRendererDebugger?: boolean;
      readonly preserveAutomationDownloadTracking?: boolean;
      readonly annotationReason?: "detached" | "destroyed" | "replaced";
    } = {},
  ): void {
    const key = buildRuntimeKey(threadId, tabId);
    const preserveAutomationDownloadTracking =
      options.preserveAutomationDownloadTracking === true &&
      (this.automationDownloadListenersByRuntimeKey.has(key) ||
        this.automationSideEffectProvenanceByRuntimeKey.has(key));
    this.clearPendingWindowOpenTask(threadId, tabId);
    this.clearTabSuspendTimer(threadId, tabId);
    this.pendingRuntimeSyncs.delete(key);
    this.runtimeLastActiveAtByKey.delete(key);
    this.expectedAutomationInputsByRuntimeKey.delete(key);
    this.automationWindowOpenListenersByRuntimeKey.delete(key);
    if (!preserveAutomationDownloadTracking) {
      this.automationGestureDepthByRuntimeKey.delete(key);
      this.automationDownloadListenersByRuntimeKey.delete(key);
      this.automationSideEffectProvenanceByRuntimeKey.delete(key);
    }
    const runtime = this.runtimes.get(key);
    if (!runtime) {
      return;
    }
    this.annotations.handleRuntimeDetached(
      threadId,
      tabId,
      runtime.webContents.id,
      options.annotationReason ?? (runtime.webContents.isDestroyed() ? "destroyed" : "detached"),
    );

    if (this.attachedRuntimeKey === key) {
      this.detachAttachedRuntime();
    }

    // Bookkeeping should normally identify the attached native view, but an
    // interrupted renderer transition must not be able to leave an untracked
    // WebContentsView over the canonical renderer WebView. Remove it from the
    // window hierarchy defensively before closing its WebContents.
    if (runtime.view && this.window) {
      this.setRuntimeViewHidden(runtime, true);
      try {
        this.window.contentView.removeChildView(runtime.view);
      } catch {
        // The view was already detached, which is the desired final state.
      }
    }

    this.runtimes.delete(key);
    const webContents = runtime.webContents;
    for (const disposeListener of runtime.listenerDisposers.splice(0)) {
      disposeListener();
    }
    if (!webContents.isDestroyed()) {
      if (
        webContents.debugger.isAttached() &&
        (runtime.ownsWebContents || !options.preserveRendererDebugger)
      ) {
        try {
          webContents.debugger.detach();
        } catch {
          // The guest/runtime is being torn down anyway; ignore stale cleanup noise.
        }
      }
      if (runtime.ownsWebContents) {
        webContents.close({ waitForBeforeUnload: false });
      }
      // A renderer-owned WebView may be rebound to another logical tab without
      // replacing its physical WebContents. That explicit path preserves CDP.
      // Final logical close detaches CDP and resets the pooled guest to blank in
      // the deferred publication handshake; forcing physical destruction here
      // can wedge Electron while the tool IPC is still unwinding.
    }
  }

  private findRendererRuntimeByWebContentsId(webContentsId: number): LiveTabRuntime | null {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.ownsWebContents && runtime.webContents.id === webContentsId) {
        return runtime;
      }
    }
    return null;
  }

  private toAnnotationRuntime(runtime: LiveTabRuntime | null): BrowserAnnotationRuntime | null {
    if (!runtime || runtime.ownsWebContents || runtime.webContents.isDestroyed()) return null;
    return {
      threadId: runtime.threadId,
      tabId: runtime.tabId,
      webContents: runtime.webContents,
    };
  }

  private getOrCreateState(threadId: ThreadId): ThreadBrowserState {
    const existing = this.states.get(threadId);
    if (existing) {
      return existing;
    }

    const initial = defaultThreadBrowserState(threadId);
    this.states.set(threadId, initial);
    this.threadVersionById.set(threadId, 0);
    return initial;
  }

  private markThreadStateChanged(threadId: ThreadId): void {
    const nextVersion = (this.threadVersionById.get(threadId) ?? 0) + 1;
    this.threadVersionById.set(threadId, nextVersion);
    const state = this.states.get(threadId);
    if (state) {
      state.version = nextVersion;
    }
  }

  private markHumanControl(threadId: ThreadId): void {
    this.humanControlEpochByThreadId.set(
      threadId,
      (this.humanControlEpochByThreadId.get(threadId) ?? 0) + 1,
    );
    for (const [key, provenance] of this.automationSideEffectProvenanceByRuntimeKey) {
      if (provenance.threadId === threadId) {
        this.automationSideEffectProvenanceByRuntimeKey.delete(key);
      }
    }
    for (const listener of [...(this.humanControlListenersByThreadId.get(threadId) ?? [])]) {
      try {
        listener();
      } catch {
        // Input delivery must never be disrupted by an automation observer.
      }
    }
  }

  private expectAutomationInput(
    threadId: ThreadId,
    tabId: string,
    signal: BrowserAutomationExpectedInput,
  ): () => void {
    const key = buildRuntimeKey(threadId, tabId);
    const now = Date.now();
    const pending: PendingBrowserAutomationInput = {
      signal,
      expiresAt: now + 1_000,
    };
    const current = (this.expectedAutomationInputsByRuntimeKey.get(key) ?? [])
      .filter((entry) => entry.expiresAt > now)
      .slice(-63);
    this.expectedAutomationInputsByRuntimeKey.set(key, [...current, pending]);
    this.beginAutomationGesture(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const releaseTime = Date.now();
      const remaining = (this.expectedAutomationInputsByRuntimeKey.get(key) ?? []).filter(
        (entry) => entry.expiresAt > releaseTime,
      );
      if (remaining.includes(pending)) {
        // debugger.sendCommand() resolves when CDP accepts the event, while
        // Electron may publish the corresponding before-mouse-event on the
        // following main-loop turn. Keep only this exact, one-shot signal alive
        // for that bounded delivery gap. Gesture/window-open correlation still
        // ends immediately below, so unrelated agent attribution cannot leak.
        pending.expiresAt = Math.min(
          pending.expiresAt,
          releaseTime + BROWSER_AUTOMATION_INPUT_RELEASE_GRACE_MS,
        );
      }
      if (remaining.length === 0) this.expectedAutomationInputsByRuntimeKey.delete(key);
      else this.expectedAutomationInputsByRuntimeKey.set(key, remaining);
      this.endAutomationGesture(key);
    };
  }

  private isAutomationGestureActive(threadId: ThreadId, tabId: string): boolean {
    return (this.automationGestureDepthByRuntimeKey.get(buildRuntimeKey(threadId, tabId)) ?? 0) > 0;
  }

  private emitAutomationWindowOpen(event: BrowserAutomationWindowOpenEvent): void {
    const key = buildRuntimeKey(event.threadId, event.sourceTabId);
    for (const listener of [...(this.automationWindowOpenListenersByRuntimeKey.get(key) ?? [])]) {
      try {
        listener(event);
      } catch {
        // Window creation must not be disrupted by an automation observer.
      }
    }
  }

  private emitAutomationDownload(event: BrowserAutomationDownloadEvent): void {
    const key = buildRuntimeKey(event.threadId, event.sourceTabId);
    const humanControlEpoch = this.getAutomationHumanControlEpoch(event.threadId);
    for (const lease of [...(this.automationDownloadListenersByRuntimeKey.get(key) ?? [])]) {
      if (lease.humanControlEpoch !== humanControlEpoch) continue;
      try {
        lease.listener(event);
      } catch {
        // The download was already prevented. Observer failures must never
        // destabilize the shared browser session or re-enable the side effect.
      }
    }
  }

  private consumeExpectedAutomationInput(
    threadId: ThreadId,
    tabId: string,
    signal: BrowserAutomationExpectedInput,
  ): boolean {
    const key = buildRuntimeKey(threadId, tabId);
    const now = Date.now();
    const pending = (this.expectedAutomationInputsByRuntimeKey.get(key) ?? []).filter(
      (entry) => entry.expiresAt > now,
    );
    const matchedIndex = pending.findIndex((entry) =>
      browserAutomationInputMatches(entry.signal, signal),
    );
    if (matchedIndex < 0) {
      if (pending.length === 0) this.expectedAutomationInputsByRuntimeKey.delete(key);
      else this.expectedAutomationInputsByRuntimeKey.set(key, pending);
      return false;
    }
    pending.splice(matchedIndex, 1);
    if (pending.length === 0) this.expectedAutomationInputsByRuntimeKey.delete(key);
    else this.expectedAutomationInputsByRuntimeKey.set(key, pending);
    return true;
  }

  private snapshotThreadState(
    threadId: ThreadId,
    state = this.getOrCreateState(threadId),
  ): ThreadBrowserState {
    const version = state.version;
    const cached = this.snapshotCacheByThreadId.get(threadId);
    if (cached && cached.version === version) {
      return cached.snapshot;
    }

    const snapshot = cloneThreadState(state);
    this.perfCounters.stateCloneCount += 1;
    this.snapshotCacheByThreadId.set(threadId, {
      version,
      snapshot,
    });
    return snapshot;
  }

  private getTrackedProcessIds(): number[] {
    const processIds = new Set<number>();
    for (const runtime of this.runtimes.values()) {
      const webContents = runtime.webContents;
      if (webContents.isDestroyed()) {
        continue;
      }
      processIds.add(webContents.getProcessId());
    }
    return [...processIds];
  }

  private countWarmInactiveRuntimes(): number {
    let count = 0;
    for (const [key] of this.tabSuspendTimers) {
      if (this.runtimes.has(key)) {
        count += 1;
      }
    }
    return count;
  }

  private resolveInactiveTabSuspendDelay(threadId: ThreadId): number {
    const threadRuntimeCount = [...this.runtimes.values()].filter(
      (runtime) => runtime.threadId === threadId,
    ).length;
    if (
      threadRuntimeCount > BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD + 1 ||
      this.runtimes.size > 4
    ) {
      return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS;
    }

    return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS;
  }

  private ensureWorkspace(threadId: ThreadId, initialUrl?: string): ThreadBrowserState {
    this.sessionPolicy.ensureConfigured();
    const state = this.getOrCreateState(threadId);
    if (state.tabs.length === 0) {
      const initialTab = createBrowserTab(normalizeUrlInput(initialUrl));
      state.tabs = [initialTab];
      state.activeTabId = initialTab.id;
    }

    if (!state.activeTabId || !state.tabs.some((tab) => tab.id === state.activeTabId)) {
      state.activeTabId = state.tabs[0]?.id ?? null;
    }

    return state;
  }

  private resolveTab(state: ThreadBrowserState, tabId?: string): BrowserTabState {
    const resolvedTabId = tabId ?? state.activeTabId;
    const existing =
      (resolvedTabId ? state.tabs.find((tab) => tab.id === resolvedTabId) : undefined) ??
      state.tabs[0];
    if (existing) {
      return existing;
    }

    const fallback = createBrowserTab();
    state.tabs = [fallback];
    state.activeTabId = fallback.id;
    return fallback;
  }

  private activateTab(threadId: ThreadId, state: ThreadBrowserState, tab: BrowserTabState): void {
    if (state.activeTabId === tab.id) {
      return;
    }

    state.activeTabId = tab.id;
    syncThreadLastError(state);
    this.markThreadStateChanged(threadId);
    this.emitState(threadId);
  }

  private getActiveTab(state: ThreadBrowserState): BrowserTabState | null {
    if (!state.activeTabId) {
      return state.tabs[0] ?? null;
    }
    return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
  }

  private getTab(state: ThreadBrowserState, tabId: string): BrowserTabState | null {
    return state.tabs.find((tab) => tab.id === tabId) ?? null;
  }

  // Resolves the most accurate URL for a tab, preferring the live page over cached state and
  // ignoring blank placeholders so the copy-link chord never yields "about:blank".
  private resolveCopyableTabUrl(
    threadId: ThreadId,
    tabId: string,
    runtime: LiveTabRuntime | undefined,
  ): string | null {
    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    const liveUrl =
      runtime && !runtime.webContents.isDestroyed() ? runtime.webContents.getURL() : null;
    return resolveCopyableBrowserTabUrl(tab, liveUrl);
  }

  private copyTabLink(threadId: ThreadId, tabId: string): void {
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    const url = this.resolveCopyableTabUrl(threadId, tabId, runtime);
    if (!url) {
      return;
    }
    clipboard.writeText(url);
    const event: BrowserCopyLinkEvent = { threadId, url };
    for (const listener of this.copyLinkListeners) {
      listener(event);
    }
  }

  private emitState(threadId: ThreadId): void {
    this.perfCounters.stateEmitCalls += 1;
    const state = this.getOrCreateState(threadId);
    const nextVersion = state.version;
    if (this.lastEmittedVersionByThreadId.get(threadId) === nextVersion) {
      this.perfCounters.stateEmitSkips += 1;
      return;
    }
    this.lastEmittedVersionByThreadId.set(threadId, nextVersion);
    const snapshot = this.snapshotThreadState(threadId, state);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function setIfChanged<T>(current: T, next: T, apply: (value: T) => void): boolean {
  if (Object.is(current, next)) {
    return false;
  }
  apply(next);
  return true;
}

function suspendTabState(tab: BrowserTabState): boolean {
  let didChange = false;
  didChange =
    setIfChanged(tab.status, SUSPENDED_TAB_STATUS, (value) => {
      tab.status = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.isLoading, false, (value) => {
      tab.isLoading = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoBack, false, (value) => {
      tab.canGoBack = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoForward, false, (value) => {
      tab.canGoForward = value;
    }) || didChange;
  return didChange;
}

function syncTabStateFromRuntime(
  state: ThreadBrowserState,
  tab: BrowserTabState,
  webContents: WebContents,
  resolveDisplayUrl: (url: string) => string,
  faviconUrls?: string[],
): boolean {
  const currentUrl = resolveDisplayUrl(webContents.getURL());
  const nextUrl = currentUrl || tab.url;
  const nextTitle = webContents.getTitle();
  let didChange = false;
  didChange =
    setIfChanged(tab.status, LIVE_TAB_STATUS, (value) => {
      tab.status = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.url, nextUrl, (value) => {
      tab.url = value;
    }) || didChange;
  const resolvedTitle =
    !nextTitle || nextTitle === ABOUT_BLANK_URL ? defaultTitleForUrl(nextUrl) : nextTitle;
  didChange =
    setIfChanged(tab.title, resolvedTitle, (value) => {
      tab.title = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.isLoading, webContents.isLoading(), (value) => {
      tab.isLoading = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoBack, canWebContentsGoBack(webContents), (value) => {
      tab.canGoBack = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoForward, canWebContentsGoForward(webContents), (value) => {
      tab.canGoForward = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.lastCommittedUrl, currentUrl || tab.lastCommittedUrl, (value) => {
      tab.lastCommittedUrl = value;
    }) || didChange;
  if (faviconUrls) {
    didChange =
      setIfChanged(tab.faviconUrl, faviconUrls[0] ?? tab.faviconUrl, (value) => {
        tab.faviconUrl = value;
      }) || didChange;
  }
  if (tab.lastError && !tab.isLoading) {
    tab.lastError = null;
    didChange = true;
  }
  didChange = syncThreadLastError(state) || didChange;
  return didChange;
}

function canWebContentsGoBack(webContents: WebContents): boolean {
  return webContents.navigationHistory?.canGoBack() ?? webContents.canGoBack();
}

function canWebContentsGoForward(webContents: WebContents): boolean {
  return webContents.navigationHistory?.canGoForward() ?? webContents.canGoForward();
}

function syncThreadLastError(state: ThreadBrowserState): boolean {
  const activeTab =
    (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
    state.tabs[0];
  const nextLastError = activeTab?.lastError ?? null;
  if (state.lastError === nextLastError) {
    return false;
  }
  state.lastError = nextLastError;
  return true;
}
