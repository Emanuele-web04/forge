import type { BrowserTabId } from "@synara/contracts";
import type { WebContents } from "electron";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import {
  abortReason,
  loadStateForReadyState,
  observePage,
  sendCdpCommand,
  throwIfAborted,
} from "./cdpRuntime";
import { browserHostError } from "./hostErrors";

export type BrowserLoadMilestone = "commit" | "domcontentloaded" | "load" | "networkidle";

const NETWORK_IDLE_WINDOW_MS = 500;
const POLL_INTERVAL_MS = 25;
const MAX_EVENTS = 256;
const MAX_IN_FLIGHT_REQUESTS = 2_048;

interface NavigationEvent {
  readonly sequence: number;
  readonly kind: "commit" | "domcontentloaded" | "load" | "networkidle" | "request";
  readonly at: number;
  readonly url?: string | undefined;
  readonly frameId?: string | undefined;
  readonly loaderId?: string | undefined;
  readonly redirectUrl?: string | undefined;
}

interface TrackedRequest {
  readonly url: string;
  readonly frameId?: string | undefined;
  readonly loaderId?: string | undefined;
  readonly document: boolean;
}

export interface BrowserNavigationMark {
  readonly sequence: number;
  readonly startedAt: number;
  readonly initialUrl: string;
  readonly frameId?: string;
  readonly loaderId?: string;
}

export interface BrowserNavigationObservation {
  readonly url: string;
  readonly state: BrowserLoadMilestone;
  readonly redirects: readonly string[];
}

interface DebuggerMessageParams {
  readonly requestId?: string;
  readonly frameId?: string;
  readonly loaderId?: string;
  readonly type?: string;
  readonly request?: { readonly url?: string };
  readonly redirectResponse?: { readonly url?: string };
  readonly frame?: {
    readonly id?: string;
    readonly parentId?: string;
    readonly loaderId?: string;
    readonly url?: string;
  };
  readonly name?: string;
  readonly url?: string;
}

const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

const milestoneRank = (state: BrowserLoadMilestone): number =>
  ({
    commit: 0,
    domcontentloaded: 1,
    load: 2,
    networkidle: 3,
  })[state];

function lifecycleEventMilestone(name: string | undefined): BrowserLoadMilestone | null {
  switch (name?.toLowerCase()) {
    case "domcontentloaded":
      return "domcontentloaded";
    case "load":
      return "load";
    case "networkidle":
      return "networkidle";
    default:
      return null;
  }
}

export const browserLoadMilestoneSatisfied = (
  observed: BrowserLoadMilestone,
  expected: BrowserLoadMilestone,
): boolean => milestoneRank(observed) >= milestoneRank(expected);

class BrowserNavigationTracker {
  private sequence = 0;
  private readonly events: NavigationEvent[] = [];
  private readonly inFlight = new Map<string, TrackedRequest>();
  private lastNetworkActivityAt = performance.now();
  private mainFrameId: string | undefined;
  private mainFrameUrl: string;
  private initialized: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly webContents: WebContents) {
    this.mainFrameUrl = webContents.getURL();
    webContents.debugger.on("message", this.onMessage);
    const lifecycle = webContents as WebContents & {
      once?: (event: "destroyed", listener: () => void) => void;
    };
    lifecycle.once?.("destroyed", this.dispose);
  }

  ensure(runtime: BrowserAutomationVisibleRuntime, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!this.initialized) {
      this.initialized = this.initialize(runtime, signal).catch((error) => {
        this.initialized = undefined;
        throw error;
      });
    }
    return this.initialized;
  }

  mark(loaderId?: string, frameId?: string): BrowserNavigationMark {
    return {
      sequence: this.sequence,
      startedAt: performance.now(),
      initialUrl: this.mainFrameUrl || this.webContents.getURL(),
      ...(frameId ? { frameId } : {}),
      ...(loaderId ? { loaderId } : {}),
    };
  }

  withNavigationIdentity(
    mark: BrowserNavigationMark,
    loaderId?: string,
    frameId?: string,
  ): BrowserNavigationMark {
    return {
      ...mark,
      ...(frameId ? { frameId } : {}),
      ...(loaderId ? { loaderId } : {}),
    };
  }

  hasNavigationStartedSince(mark: BrowserNavigationMark): boolean {
    return this.events.some(
      (event) =>
        event.sequence > mark.sequence &&
        (event.kind === "request" || event.kind === "commit") &&
        this.matches(mark, event),
    );
  }

  async wait(
    runtime: BrowserAutomationVisibleRuntime,
    expected: BrowserLoadMilestone,
    timeoutMs: number,
    signal?: AbortSignal,
    mark?: BrowserNavigationMark,
  ): Promise<BrowserNavigationObservation> {
    await this.ensure(runtime, signal);
    const startedAt = performance.now();
    const deadline = startedAt + Math.max(0, timeoutMs);
    let activeMark = mark;
    while (performance.now() <= deadline) {
      throwIfAborted(signal);
      if (activeMark) {
        const previousMark = activeMark;
        const firstCommit = this.events.find(
          (event) =>
            event.kind === "commit" &&
            event.sequence > previousMark.sequence &&
            this.matches(previousMark, event),
        );
        if (firstCommit) {
          // A script can replace the document before it finishes loading. Follow
          // that main frame's newest commit, never the old loader's late events.
          const latestCommit =
            this.events.findLast(
              (event) =>
                event.kind === "commit" &&
                event.sequence >= firstCommit.sequence &&
                event.frameId === firstCommit.frameId,
            ) ?? firstCommit;
          activeMark = this.withNavigationIdentity(
            {
              sequence: latestCommit.sequence - 1,
              startedAt: previousMark.startedAt,
              initialUrl: previousMark.initialUrl,
            },
            latestCommit.loaderId ?? previousMark.loaderId,
            latestCommit.frameId ?? previousMark.frameId,
          );
        }
      }
      const currentMark = activeMark;
      const matching = currentMark
        ? this.events.filter(
            (event) => event.sequence > currentMark.sequence && this.matches(currentMark, event),
          )
        : this.events;
      const committed = mark ? matching.some((event) => event.kind === "commit") : true;
      let state: BrowserLoadMilestone = "commit";
      if (matching.some((event) => event.kind === "domcontentloaded")) {
        state = "domcontentloaded";
      }
      if (matching.some((event) => event.kind === "load")) state = "load";
      if (matching.some((event) => event.kind === "networkidle")) state = "networkidle";

      // When there is no explicit navigation mark, readyState supplies only
      // document lifecycle state. Network idleness itself comes from CDP's
      // lifecycle signal or Network domain below, never ResourceTiming.
      if (!mark) {
        const page = await observePage(runtime, signal);
        this.mainFrameUrl = page.url;
        state = loadStateForReadyState(page.readyState);
      }
      if (
        state !== "networkidle" &&
        committed &&
        this.inFlight.size === 0 &&
        performance.now() - this.lastNetworkActivityAt >= NETWORK_IDLE_WINDOW_MS &&
        milestoneRank(state) >= milestoneRank("commit")
      ) {
        state = "networkidle";
      }
      if (committed && browserLoadMilestoneSatisfied(state, expected)) {
        const redirects: string[] = [];
        for (const event of this.events) {
          if (mark && event.sequence <= mark.sequence) continue;
          if (mark?.frameId && event.frameId && mark.frameId !== event.frameId) continue;
          if (!event.redirectUrl || redirects.includes(event.redirectUrl)) continue;
          redirects.push(event.redirectUrl);
          if (redirects.length >= 20) break;
        }
        const eventUrl = [...matching].reverse().find((event) => event.url)?.url;
        return {
          url: eventUrl ?? this.mainFrameUrl ?? this.webContents.getURL(),
          state,
          redirects,
        };
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - performance.now())), signal);
    }
    browserHostError({
      code: "BrowserTimeout",
      retryable: true,
      phase: "navigation",
      effectMayHaveCommitted: mark ? this.hasNavigationStartedSince(mark) : false,
      tabId: runtime.tabId as BrowserTabId,
    });
  }

  networkIdle(): boolean {
    return (
      this.inFlight.size === 0 &&
      performance.now() - this.lastNetworkActivityAt >= NETWORK_IDLE_WINDOW_MS
    );
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    // A destroyed WebContents also invalidates Electron's debugger wrapper;
    // Chromium has already released its listeners in that case.
    if (!this.webContents.isDestroyed()) {
      this.webContents.debugger.removeListener("message", this.onMessage);
      this.webContents.removeListener("destroyed", this.dispose);
    }
    trackerByWebContents.delete(this.webContents);
    this.events.length = 0;
    this.inFlight.clear();
  };

  private async initialize(
    runtime: BrowserAutomationVisibleRuntime,
    signal?: AbortSignal,
  ): Promise<void> {
    const frameTree = await sendCdpCommand<{
      readonly frameTree?: { readonly frame?: { readonly id?: string; readonly url?: string } };
    }>(runtime, "Page.getFrameTree", {}, signal);
    this.mainFrameId = frameTree.frameTree?.frame?.id;
    this.mainFrameUrl = frameTree.frameTree?.frame?.url ?? this.webContents.getURL();
    // Sequential enabling avoids releasing an operation lock while a sibling
    // command is still settling after cancellation.
    await sendCdpCommand(runtime, "Page.enable", {}, signal);
    await sendCdpCommand(runtime, "Page.setLifecycleEventsEnabled", { enabled: true }, signal);
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
    this.lastNetworkActivityAt = performance.now();
  }

  private readonly onMessage = (
    _event: unknown,
    method: string,
    rawParams: unknown,
    sessionId?: string,
  ): void => {
    if (sessionId || this.disposed || !rawParams || typeof rawParams !== "object") return;
    const params = rawParams as DebuggerMessageParams;
    const now = performance.now();
    if (method === "Network.requestWillBeSent" && params.requestId && params.request?.url) {
      const redirectUrl = params.redirectResponse?.url;
      const document =
        params.type === "Document" &&
        (!this.mainFrameId || !params.frameId || params.frameId === this.mainFrameId);
      // WebSockets are reported through their own Network events and should
      // not keep an otherwise settled document permanently non-idle.
      if (params.type !== "WebSocket") {
        this.inFlight.delete(params.requestId);
        this.inFlight.set(params.requestId, {
          url: params.request.url,
          frameId: params.frameId,
          loaderId: params.loaderId,
          document,
        });
        while (this.inFlight.size > MAX_IN_FLIGHT_REQUESTS) {
          this.inFlight.delete(this.inFlight.keys().next().value as string);
        }
        this.lastNetworkActivityAt = now;
      }
      if (document) {
        this.push({
          kind: "request",
          at: now,
          url: params.request.url,
          frameId: params.frameId,
          loaderId: params.loaderId,
          ...(redirectUrl ? { redirectUrl } : {}),
        });
      }
      return;
    }
    if (
      (method === "Network.loadingFinished" || method === "Network.loadingFailed") &&
      params.requestId
    ) {
      if (this.inFlight.delete(params.requestId)) this.lastNetworkActivityAt = now;
      return;
    }
    if (method === "Page.frameNavigated" && params.frame && !params.frame.parentId) {
      const nextLoaderId = params.frame.loaderId;
      let discardedStaleRequest = false;
      for (const [requestId, request] of this.inFlight) {
        // A new main document invalidates unfinished requests owned by the
        // previous loader. Chromium does not guarantee a loadingFailed event
        // for every request when a reused WebView swaps documents/tabs.
        if (nextLoaderId && request.loaderId === nextLoaderId) continue;
        this.inFlight.delete(requestId);
        discardedStaleRequest = true;
      }
      if (discardedStaleRequest) this.lastNetworkActivityAt = now;
      this.mainFrameId = params.frame.id ?? this.mainFrameId;
      this.mainFrameUrl = params.frame.url ?? this.mainFrameUrl;
      this.push({
        kind: "commit",
        at: now,
        url: params.frame.url,
        frameId: params.frame.id,
        loaderId: params.frame.loaderId,
      });
      return;
    }
    if (method === "Page.navigatedWithinDocument") {
      if (params.frameId && this.mainFrameId && params.frameId !== this.mainFrameId) return;
      this.mainFrameUrl = params.url ?? this.mainFrameUrl;
      this.push({
        kind: "commit",
        at: now,
        url: params.url,
        frameId: params.frameId,
      });
      // Hash/history-API navigation reuses the already loaded document and
      // therefore emits no new DOMContentLoaded/load lifecycle events. Treat
      // the existing document lifecycle as complete so the default
      // domcontentloaded wait cannot hang on a successfully committed URL.
      this.push({
        kind: "load",
        at: now,
        url: params.url,
        frameId: params.frameId,
      });
      return;
    }
    if (method === "Page.lifecycleEvent") {
      const kind = lifecycleEventMilestone(params.name);
      if (kind) {
        this.push({
          kind,
          at: now,
          frameId: params.frameId,
          loaderId: params.loaderId,
        });
      }
    }
  };

  private matches(mark: BrowserNavigationMark, event: NavigationEvent): boolean {
    if (mark.loaderId && event.loaderId && event.loaderId !== mark.loaderId) return false;
    if (mark.frameId && event.frameId && event.frameId !== mark.frameId) return false;
    return true;
  }

  private push(event: Omit<NavigationEvent, "sequence">): void {
    this.events.push({ ...event, sequence: ++this.sequence });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }
}

const trackerByWebContents = new WeakMap<WebContents, BrowserNavigationTracker>();

export const getBrowserNavigationTracker = async (
  runtime: BrowserAutomationVisibleRuntime,
  signal?: AbortSignal,
): Promise<BrowserNavigationTracker> => {
  let tracker = trackerByWebContents.get(runtime.webContents);
  if (!tracker) {
    tracker = new BrowserNavigationTracker(runtime.webContents);
    trackerByWebContents.set(runtime.webContents, tracker);
  }
  await tracker.ensure(runtime, signal);
  return tracker;
};

export const beginBrowserNavigation = async (
  runtime: BrowserAutomationVisibleRuntime,
  url: string,
  signal?: AbortSignal,
): Promise<{
  readonly tracker: BrowserNavigationTracker;
  readonly mark: BrowserNavigationMark;
}> => {
  const tracker = await getBrowserNavigationTracker(runtime, signal);
  const initialMark = tracker.mark();
  const response = await sendCdpCommand<{
    readonly frameId?: string;
    readonly loaderId?: string;
    readonly errorText?: string;
    readonly isDownload?: boolean;
  }>(runtime, "Page.navigate", { url }, signal, {
    effectMayHaveCommitted: true,
    onAbort: () => stopBrowserNavigation(runtime),
  });
  if (response.errorText || response.isDownload) {
    browserHostError({
      code: "BrowserNavigationFailed",
      retryable: !response.isDownload,
      phase: "navigation",
      effectMayHaveCommitted: true,
      tabId: runtime.tabId as BrowserTabId,
    });
  }
  return {
    tracker,
    mark: tracker.withNavigationIdentity(initialMark, response.loaderId, response.frameId),
  };
};

export const stopBrowserNavigation = async (
  runtime: BrowserAutomationVisibleRuntime,
): Promise<void> => {
  if (runtime.webContents.isDestroyed() || !runtime.webContents.debugger.isAttached()) return;
  await runtime.webContents.debugger.sendCommand("Page.stopLoading").then(
    () => undefined,
    () => undefined,
  );
};
