// FILE: BrowserPanel.logic.ts
// Purpose: Holds address-bar rules plus renderer lifecycle guards for the in-app browser panel.
// Layer: Component logic helper
// Exports: address helpers, panel hide scheduling, and one-shot renderer-loss recovery
// Depends on: shared browser URL rules, browser tab metadata, and thread-local browser history

import {
  BROWSER_BLANK_URL,
  BROWSER_SEARCH_URL_PREFIX,
  FLOATING_BROWSER_CHROME_PARTITION,
  normalizeBrowserPageZoomFactor,
  normalizeBrowserUrlInput,
} from "@synara/shared/browserSession";
import type {
  BrowserAnnotationEvent,
  BrowserAnnotationMarker,
  BrowserAnnotationTheme,
  BrowserTabState,
  ThreadId,
} from "@synara/contracts";
import type { BrowserHistoryEntry } from "../browserStateStore";
import type { BrowserAnnotationDraft } from "../lib/browserAnnotations";

const BROWSER_SUGGESTION_LIMIT = 6;

export interface BrowserRendererRecovery {
  readonly tabId: string;
  readonly generation: number;
}

interface BrowserRendererLossHandlerInput<TRenderer> {
  readonly renderer: TRenderer;
  readonly rendererGeneration: number;
  readonly tabId: string;
  readonly isCurrent: (renderer: TRenderer) => boolean;
  readonly detach: (renderer: TRenderer) => void;
  readonly recover: (recovery: BrowserRendererRecovery) => void;
}

/**
 * Coalesces Electron's overlapping guest-loss signals into one renderer
 * replacement. The current-renderer guard also makes a queued event from an
 * older guest harmless after its successor has attached.
 */
export function createBrowserRendererLossHandler<TRenderer>({
  renderer,
  rendererGeneration,
  tabId,
  isCurrent,
  detach,
  recover,
}: BrowserRendererLossHandlerInput<TRenderer>): () => void {
  let handled = false;
  return () => {
    if (handled || !isCurrent(renderer)) {
      return;
    }
    handled = true;
    try {
      detach(renderer);
    } finally {
      recover({ tabId, generation: rendererGeneration + 1 });
    }
  };
}

export interface BrowserPanelHideScheduler {
  /** Claims the thread's live browser surface until the returned release function is called. */
  readonly acquire: (threadId: string) => () => void;
  readonly cancel: (threadId: string) => void;
  readonly schedule: (threadId: string, hide: () => void) => void;
}

export const BROWSER_RENDERER_GUEST_PARK_MS = 8_000;
export const BROWSER_RENDERER_PARKING_CONTAINER_ID = "synara-browser-renderer-parking";
export const BROWSER_RENDERER_GUEST_THREAD_ATTRIBUTE = "data-browser-guest-thread";

export interface ParkedBrowserRendererGuest {
  readonly tabId: string;
  readonly webContentsId: number | null;
  readonly stage: HTMLElement;
  readonly webview: HTMLElement;
  readonly dispose: () => void;
}

export interface BrowserPanelRendererHandoff {
  readonly trackDetach: (threadId: string, detach: Promise<unknown>) => void;
  readonly waitForDetach: (threadId: string) => Promise<void>;
  readonly parkGuest: (threadId: string, guest: ParkedBrowserRendererGuest) => void;
  readonly takeParkedGuest: (threadId: string) => ParkedBrowserRendererGuest | null;
}

interface BrowserPanelRendererHandoffOptions {
  readonly parkUntilMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => BrowserPanelHideTimer;
  readonly clearTimer?: (timer: BrowserPanelHideTimer) => void;
}

export const BROWSER_RENDERER_GUEST_SLOT_Z_INDEX = "40";
export const FLOATING_BROWSER_CHROME_SLOT_Z_INDEX = "50";
export const FLOATING_BROWSER_CHROME_THREAD_ATTRIBUTE = "data-floating-browser-chrome-thread";
export const FLOATING_BROWSER_CHROME_EXPANDED_ATTRIBUTE = "data-floating-browser-chrome-expanded";
export const FLOATING_BROWSER_CHROME_COLLAPSED_WIDTH_PX = 32;
export const FLOATING_BROWSER_CHROME_EXPANDED_WIDTH_PX = 86;
export const FLOATING_BROWSER_CHROME_WIDTH_PX = FLOATING_BROWSER_CHROME_EXPANDED_WIDTH_PX;
export const FLOATING_BROWSER_CHROME_HEIGHT_PX = 32;
export const FLOATING_BROWSER_CHROME_INSET_PX = 8;

export function isBrowserRendererGuestHitTarget(element: { tagName?: string; closest?: (selector: string) => Element | null }): boolean {
  const tagName = element.tagName?.toLowerCase();
  if (tagName === "webview") {
    return true;
  }
  return (
    element.closest?.(`[${BROWSER_RENDERER_GUEST_THREAD_ATTRIBUTE}]`) != null ||
    element.closest?.(`#${BROWSER_RENDERER_PARKING_CONTAINER_ID}`) != null ||
    element.closest?.(`[${FLOATING_BROWSER_CHROME_THREAD_ATTRIBUTE}]`) != null
  );
}

export interface BrowserRendererGuestSlotBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserRendererGuestSlotStyle {
  readonly left: string;
  readonly top: string;
  readonly width: string;
  readonly height: string;
  readonly pointerEvents: "auto" | "none";
  readonly borderRadius: string;
  readonly clipPath: string;
}

/**
 * Electron recreates a <webview> when its DOM parent changes, which reloads the
 * page and drops in-memory form state. Keep the guest in one body slot and only
 * change its fixed rectangle.
 */
export function resolveBrowserRendererGuestSlotStyle(
  host: BrowserRendererGuestSlotBox | null,
  options: { borderRadius?: string } = {},
): BrowserRendererGuestSlotStyle {
  const borderRadius = options.borderRadius ?? "0px";
  if (!host || host.width <= 0 || host.height <= 0) {
    return {
      left: "-10000px",
      top: "0px",
      width: "1280px",
      height: "800px",
      pointerEvents: "none",
      borderRadius,
      clipPath: "none",
    };
  }
  return {
    left: `${host.left}px`,
    top: `${host.top}px`,
    width: `${host.width}px`,
    height: `${host.height}px`,
    pointerEvents: "auto",
    borderRadius,
    clipPath: borderRadius === "0px" ? "none" : `inset(0 round ${borderRadius})`,
  };
}

export function applyBrowserRendererGuestSlotStyle(
  slot: HTMLElement,
  host: BrowserRendererGuestSlotBox | null,
  options: { borderRadius?: string } = {},
): void {
  const next = resolveBrowserRendererGuestSlotStyle(host, options);
  slot.style.position = "fixed";
  slot.style.margin = "0";
  slot.style.overflow = host ? "hidden" : "visible";
  slot.style.zIndex = BROWSER_RENDERER_GUEST_SLOT_Z_INDEX;
  slot.style.left = next.left;
  slot.style.top = next.top;
  slot.style.width = next.width;
  slot.style.height = next.height;
  slot.style.pointerEvents = next.pointerEvents;
  slot.style.borderRadius = next.borderRadius;
  slot.style.clipPath = next.clipPath;
}

export function readFloatingBrowserPanelBorderRadius(host: HTMLElement): string {
  const panel = host.closest("[data-floating-browser-panel]");
  if (!(panel instanceof HTMLElement)) {
    return "0px";
  }
  const radius = window.getComputedStyle(panel).borderTopLeftRadius.trim();
  return radius.length > 0 ? radius : "0px";
}

export function shouldAssignBrowserWebviewSrc(input: {
  activeTabId: string;
  boundTabId: string | null;
  guestTabId: string | null;
}): boolean {
  const inferredBoundTabId = input.boundTabId ?? input.guestTabId;
  return inferredBoundTabId !== input.activeTabId;
}

/**
 * Serializes renderer guest replacement across dock/floating BrowserPanel instances.
 * React can mount the replacement before the old panel's IPC cleanup has completed;
 * waiting here keeps browserManager's duplicate-runtime guard from stranding the guest.
 *
 * Park/take keeps the same <webview> WebContents alive across hosts so a sidebar
 * handoff does not reload the page and drop in-memory form state. The guest node
 * must stay under one parent: Electron destroys <webview> on reparent.
 */
export function createBrowserPanelRendererHandoff(
  options: BrowserPanelRendererHandoffOptions = {},
): BrowserPanelRendererHandoff {
  const parkUntilMs = options.parkUntilMs ?? BROWSER_RENDERER_GUEST_PARK_MS;
  const setTimer =
    options.setTimer ??
    ((callback, delayMs) => globalThis.setTimeout(callback, delayMs) as BrowserPanelHideTimer);
  const clearTimer =
    options.clearTimer ??
    ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>));
  const pendingByThreadId = new Map<string, Promise<void>>();
  const parkedByThreadId = new Map<
    string,
    { guest: ParkedBrowserRendererGuest; timer: BrowserPanelHideTimer }
  >();

  function trackDetach(threadId: string, detach: Promise<unknown>): void {
    const previous = pendingByThreadId.get(threadId);
    const completion = Promise.all([previous ?? Promise.resolve(), detach]).then(
      () => undefined,
      () => undefined,
    );
    pendingByThreadId.set(threadId, completion);
    void completion.then(() => {
      if (pendingByThreadId.get(threadId) === completion) {
        pendingByThreadId.delete(threadId);
      }
    });
  }

  function waitForDetach(threadId: string): Promise<void> {
    return pendingByThreadId.get(threadId) ?? Promise.resolve();
  }

  function clearParked(threadId: string): ParkedBrowserRendererGuest | null {
    const parked = parkedByThreadId.get(threadId);
    if (!parked) {
      return null;
    }
    parkedByThreadId.delete(threadId);
    clearTimer(parked.timer);
    return parked.guest;
  }

  function parkGuest(threadId: string, guest: ParkedBrowserRendererGuest): void {
    const replaced = clearParked(threadId);
    if (replaced && replaced.webview !== guest.webview) {
      replaced.dispose();
    }
    const timer = setTimer(() => {
      parkedByThreadId.delete(threadId);
      guest.dispose();
    }, parkUntilMs);
    parkedByThreadId.set(threadId, { guest, timer });
  }

  function takeParkedGuest(threadId: string): ParkedBrowserRendererGuest | null {
    return clearParked(threadId);
  }

  return { trackDetach, waitForDetach, parkGuest, takeParkedGuest };
}

export function getBrowserRendererParkingContainer(): HTMLElement {
  const existing = document.getElementById(BROWSER_RENDERER_PARKING_CONTAINER_ID);
  if (existing) {
    return existing;
  }
  const container = document.createElement("div");
  container.id = BROWSER_RENDERER_PARKING_CONTAINER_ID;
  container.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${FLOATING_BROWSER_CHROME_SLOT_Z_INDEX};`;
  document.body.append(container);
  return container;
}

export function getBrowserRendererGuestSlot(threadId: string): HTMLElement {
  const container = getBrowserRendererParkingContainer();
  for (const child of container.children) {
    if (
      child instanceof HTMLElement &&
      child.getAttribute(BROWSER_RENDERER_GUEST_THREAD_ATTRIBUTE) === threadId
    ) {
      return child;
    }
  }
  const slot = document.createElement("div");
  slot.setAttribute(BROWSER_RENDERER_GUEST_THREAD_ATTRIBUTE, threadId);
  applyBrowserRendererGuestSlotStyle(slot, null);
  container.append(slot);
  return slot;
}

function floatingBrowserChromeSlotWidth(slot: HTMLElement): number {
  return slot.getAttribute(FLOATING_BROWSER_CHROME_EXPANDED_ATTRIBUTE) === "true"
    ? FLOATING_BROWSER_CHROME_EXPANDED_WIDTH_PX
    : FLOATING_BROWSER_CHROME_COLLAPSED_WIDTH_PX;
}

export function applyFloatingBrowserChromeSlotStyle(
  slot: HTMLElement,
  panel: BrowserRendererGuestSlotBox | null,
  options: { expanded?: boolean } = {},
): void {
  if (options.expanded != null) {
    slot.setAttribute(FLOATING_BROWSER_CHROME_EXPANDED_ATTRIBUTE, options.expanded ? "true" : "false");
  }
  const width = floatingBrowserChromeSlotWidth(slot);
  slot.style.position = "fixed";
  slot.style.margin = "0";
  slot.style.overflow = "visible";
  slot.style.zIndex = FLOATING_BROWSER_CHROME_SLOT_Z_INDEX;
  slot.style.width = `${width}px`;
  slot.style.height = `${FLOATING_BROWSER_CHROME_HEIGHT_PX}px`;
  if (!panel || panel.width <= 0 || panel.height <= 0) {
    slot.style.left = "-10000px";
    slot.style.top = "0px";
    slot.style.pointerEvents = "none";
    return;
  }
  slot.style.left = `${panel.left + panel.width - FLOATING_BROWSER_CHROME_INSET_PX - width}px`;
  slot.style.top = `${panel.top + FLOATING_BROWSER_CHROME_INSET_PX}px`;
  slot.style.pointerEvents = "auto";
}

export function getFloatingBrowserChromeSlot(threadId: string): HTMLElement {
  const container = getBrowserRendererParkingContainer();
  for (const child of container.children) {
    if (
      child instanceof HTMLElement &&
      child.getAttribute(FLOATING_BROWSER_CHROME_THREAD_ATTRIBUTE) === threadId
    ) {
      return child;
    }
  }
  const slot = document.createElement("div");
  slot.setAttribute(FLOATING_BROWSER_CHROME_THREAD_ATTRIBUTE, threadId);
  applyFloatingBrowserChromeSlotStyle(slot, null);
  container.append(slot);
  return slot;
}

export const FLOATING_BROWSER_CHROME_SRCDOC = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        background: transparent;
        overflow: hidden;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }
      .pill {
        position: absolute;
        top: 0;
        right: 0;
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 2px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, #fff 18%, transparent);
        background: color-mix(in srgb, #18181b 90%, transparent);
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
        backdrop-filter: blur(12px);
        pointer-events: auto;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 2px;
        width: 0;
        overflow: hidden;
        transition: width 220ms ease-out;
      }
      body.open .actions { width: 50px; }
      @media (prefers-reduced-motion: reduce) {
        .actions { transition: none; }
      }
      button {
        width: 24px;
        height: 24px;
        flex: 0 0 24px;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: #a1a1aa;
        display: grid;
        place-items: center;
        cursor: pointer;
      }
      button:hover { background: rgb(255 255 255 / 0.08); color: #fafafa; }
      #drag { cursor: grab; }
      #drag:active { cursor: grabbing; }
      svg { width: 14px; height: 14px; }
    </style>
  </head>
  <body>
    <div class="pill">
      <button id="drag" type="button" title="Drag to move, click for actions" aria-label="Floating browser actions" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>
      </button>
      <div class="actions" id="actions">
        <button id="pop" type="button" title="Open browser in sidebar" aria-label="Open browser in sidebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M11 12H8"/><path d="m10 9-3 3 3 3"/></svg>
        </button>
        <button id="close" type="button" title="Close floating browser" aria-label="Close floating browser">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
    </div>
    <script>
      const api = window.synaraFloatingChrome;
      const send = (type, payload) => api && api.send(type, payload);
      const drag = document.getElementById("drag");
      window.__synaraSetFloatingChrome = (open) => {
        document.body.classList.toggle("open", Boolean(open));
        drag.setAttribute("aria-expanded", open ? "true" : "false");
        return Boolean(open);
      };
      window.__synaraToggleFloatingChrome = () =>
        window.__synaraSetFloatingChrome(!document.body.classList.contains("open"));
      if (api && api.onHost) {
        api.onHost((payload) => {
          if (payload && typeof payload.open === "boolean") {
            window.__synaraSetFloatingChrome(payload.open);
          }
        });
      }
      drag.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        send("drag", { x: event.clientX, y: event.clientY, button: event.button });
      });
      document.getElementById("pop").addEventListener("click", (event) => {
        event.stopPropagation();
        document.body.classList.remove("open");
        drag.setAttribute("aria-expanded", "false");
        send("pop");
      });
      document.getElementById("close").addEventListener("click", (event) => {
        event.stopPropagation();
        send("close");
      });
    </script>
  </body>
</html>`;

function floatingBrowserChromeGuest(
  webview: HTMLElement,
): HTMLElement & {
  executeJavaScript?: (code: string) => Promise<unknown>;
  send?: (channel: string, ...args: unknown[]) => void;
} {
  return webview as HTMLElement & {
    executeJavaScript?: (code: string) => Promise<unknown>;
    send?: (channel: string, ...args: unknown[]) => void;
  };
}

export function setFloatingBrowserChromeMenuOpen(webview: HTMLElement, open: boolean): void {
  const guest = floatingBrowserChromeGuest(webview);
  guest.send?.("synara-floating-chrome-host", { open });
  void guest.executeJavaScript?.(
    `window.__synaraSetFloatingChrome && window.__synaraSetFloatingChrome(${open ? "true" : "false"})`,
  );
}

export function nudgeElectronWebviewNativeView(slot: HTMLElement): void {
  const webview = slot.querySelector("webview");
  if (!webview || !("style" in webview)) {
    return;
  }
  const guest = webview as HTMLElement;
  guest.style.transform =
    guest.style.transform === "translateZ(0px)" ? "translateZ(0.01px)" : "translateZ(0px)";
}

export function nudgeFloatingBrowserChromeNativeView(slot: HTMLElement): void {
  nudgeElectronWebviewNativeView(slot);
}

export function handoffBrowserGuestToDockedSurface(input: {
  slot: HTMLElement;
  host: BrowserRendererGuestSlotBox;
  stage?: HTMLElement | null;
  webview?: HTMLElement | null;
}): void {
  applyBrowserRendererGuestSlotStyle(input.slot, input.host, { borderRadius: "0px" });
  input.slot.style.border = "";
  input.slot.style.boxShadow = "";
  const stage =
    input.stage ??
    input.slot.querySelector<HTMLElement>("[data-floating-browser-stage='true']");
  if (stage) {
    applyBrowserWebviewPresentation(stage, {
      floating: false,
      slotWidth: input.host.width,
      slotHeight: input.host.height,
    });
  }
  const webview = input.webview ?? input.slot.querySelector("webview");
  if (webview && "style" in webview) {
    const guest = webview as HTMLElement;
    guest.style.width = "100%";
    guest.style.height = "100%";
    guest.style.overflow = "";
    guest.style.clipPath = "";
    guest.style.borderRadius = "";
    applyBrowserWebviewPageZoom(guest, 1);
  }
  nudgeElectronWebviewNativeView(input.slot);
}

export function ensureFloatingBrowserChromeWebview(slot: HTMLElement): HTMLElement {
  let webview = slot.querySelector("webview");
  if (webview instanceof HTMLElement) {
    return webview;
  }
  webview = document.createElement("webview");
  webview.setAttribute("partition", FLOATING_BROWSER_CHROME_PARTITION);
  webview.setAttribute("allowtransparency", "on");
  webview.style.cssText = "display:flex;width:100%;height:100%;background:transparent;";
  webview.setAttribute("src", `data:text/html;charset=utf-8,${encodeURIComponent(FLOATING_BROWSER_CHROME_SRCDOC)}`);
  slot.append(webview);
  return webview;
}

type BrowserPanelHideTimer = ReturnType<typeof globalThis.setTimeout>;

/**
 * Defers renderer teardown by one task so React StrictMode's development-only
 * setup/cleanup/setup cycle can cancel the passive hide before it reaches the
 * desktop human-control boundary. A real unmount has no matching setup and
 * therefore still calls hide on the next task.
 */
export function createBrowserPanelHideScheduler(
  setTimer: (callback: () => void) => BrowserPanelHideTimer = (callback) =>
    globalThis.setTimeout(callback, 0),
  clearTimer: (timer: BrowserPanelHideTimer) => void = (timer) => globalThis.clearTimeout(timer),
): BrowserPanelHideScheduler {
  const pendingByThreadId = new Map<string, BrowserPanelHideTimer>();
  const liveHostCountByThreadId = new Map<string, number>();

  function cancel(threadId: string): void {
    const pending = pendingByThreadId.get(threadId);
    if (pending === undefined) return;
    pendingByThreadId.delete(threadId);
    clearTimer(pending);
  }

  function acquire(threadId: string): () => void {
    // A new live host takes over before the previous host's cleanup necessarily runs.
    // Cancelling here also handles the opposite React commit order, where cleanup queued
    // the hide before the replacement host mounted.
    cancel(threadId);
    liveHostCountByThreadId.set(threadId, (liveHostCountByThreadId.get(threadId) ?? 0) + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const nextCount = (liveHostCountByThreadId.get(threadId) ?? 1) - 1;
      if (nextCount > 0) {
        liveHostCountByThreadId.set(threadId, nextCount);
      } else {
        liveHostCountByThreadId.delete(threadId);
      }
    };
  }

  function schedule(threadId: string, hide: () => void): void {
    cancel(threadId);
    const pending = setTimer(() => {
      if (pendingByThreadId.get(threadId) !== pending) return;
      pendingByThreadId.delete(threadId);
      if ((liveHostCountByThreadId.get(threadId) ?? 0) > 0) return;
      hide();
    });
    pendingByThreadId.set(threadId, pending);
  }

  return { acquire, cancel, schedule };
}

/**
 * Electron guest surfaces can paint above React portals regardless of CSS
 * z-index. Hide the guest while browser-owned chrome or another app overlay is
 * open so that the DOM surface remains the topmost interactive layer.
 */
export function shouldOccludeBrowserWebview(input: {
  showLocalServersHome: boolean;
  browserActionsMenuOpen: boolean;
  hasObscuringOverlay: boolean;
}): boolean {
  return input.showLocalServersHome || input.browserActionsMenuOpen || input.hasObscuringOverlay;
}

/**
 * Checks only the hit-test entries above a browser surface.
 *
 * `document.elementsFromPoint()` continues past the surface into its ancestors
 * and then into sibling content behind it. Treating every visible entry as an
 * obstruction makes an overlaid browser hide itself whenever the chat behind it
 * is also hit-testable. The first surface/descendant entry is the compositor
 * boundary; anything after it is not eligible to occlude the browser.
 */
export function hasObscuringHitStackElementAboveSurface<TElement>(
  hitElements: readonly TElement[],
  input: {
    isSurfaceBoundary: (element: TElement) => boolean;
    isNonObscuring: (element: TElement) => boolean;
    isVisible: (element: TElement) => boolean;
  },
): boolean {
  let hasVisibleElementAboveSurface = false;
  for (const hitElement of hitElements) {
    if (input.isSurfaceBoundary(hitElement)) {
      return hasVisibleElementAboveSurface;
    }
    if (input.isNonObscuring(hitElement)) {
      continue;
    }
    if (input.isVisible(hitElement)) {
      hasVisibleElementAboveSurface = true;
    }
  }

  // If the surface is absent from the hit-test stack, the remaining entries are
  // ambiguous (and commonly represent content behind the floating panel). Do
  // not hide the browser based on that incomplete stack.
  return false;
}

interface ResolveBrowserAddressSyncInput {
  activeTabId: string | null;
  previousActiveTabId: string | null;
  savedDraft: string | undefined;
  nextDisplayValue: string;
  lastSyncedValue: string | undefined;
  isEditing: boolean;
}

type BrowserAddressSyncDecision =
  | {
      type: "keep";
    }
  | {
      type: "replace";
      value: string;
      syncedValue: string | undefined;
    };

export interface BrowserAddressSuggestion {
  id: string;
  kind: "navigate" | "tab" | "history";
  title: string;
  detail: string;
  url: string;
  tabId?: string;
  faviconUrl?: string | null;
}

interface BuildBrowserAddressSuggestionsInput {
  query: string;
  activeTabId: string | null;
  tabs: Array<Pick<BrowserTabState, "id" | "title" | "url" | "faviconUrl" | "lastCommittedUrl">>;
  recentHistory: BrowserHistoryEntry[];
}

export interface BrowserChromeStatus {
  tone: "default" | "error";
  label: string;
}

export function browserAnnotationDraftFromCommittedEvent(
  event: Extract<BrowserAnnotationEvent, { kind: "committed" }>,
): Omit<BrowserAnnotationDraft, "ordinal"> {
  return {
    id: event.annotation.id,
    tabId: event.tabId,
    documentKey: event.document.key,
    source: event.annotation.source,
    selector: event.annotation.selector,
    tagName: event.annotation.tagName,
    role: event.annotation.role,
    name: event.annotation.name,
    text: event.annotation.text,
    fingerprint: event.annotation.fingerprint,
    comment: event.annotation.comment,
    capturedAt: event.annotation.capturedAt,
  };
}

export function browserAnnotationMarkers(
  annotations: readonly BrowserAnnotationDraft[],
  tabId: string,
): BrowserAnnotationMarker[] {
  return annotations
    .filter(
      (annotation): annotation is BrowserAnnotationDraft & { documentKey: string } =>
        annotation.tabId === tabId && typeof annotation.documentKey === "string",
    )
    .map((annotation) => ({
      id: annotation.id,
      ordinal: annotation.ordinal,
      documentKey: annotation.documentKey,
      source: annotation.source,
      selector: annotation.selector,
      fingerprint: annotation.fingerprint,
    }));
}

export function isBrowserAnnotationEventInScope(
  event: BrowserAnnotationEvent,
  input: {
    threadId: ThreadId;
    tabId: string | null;
    sessionId?: string | null;
    documentToken?: string | null;
  },
): boolean {
  if (event.threadId !== input.threadId || event.tabId !== input.tabId) {
    return false;
  }
  if (
    input.sessionId !== undefined &&
    "sessionId" in event &&
    event.sessionId !== null &&
    event.sessionId !== input.sessionId
  ) {
    return false;
  }
  if (
    input.documentToken !== undefined &&
    input.documentToken !== null &&
    event.document.token !== input.documentToken
  ) {
    return false;
  }
  return true;
}

const SAFE_RESOLVED_BROWSER_ANNOTATION_COLOR =
  /^(?:(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([+\-0-9.eE,%\s/]+\)|color\(srgb(?:-linear)?[+\-0-9.eE,%\s/]+\))$/u;

const BROWSER_ANNOTATION_THEME_FALLBACKS = {
  light: {
    mode: "light",
    accent: "rgb(82, 111, 255)",
    surface: "rgb(255, 255, 255)",
    text: "rgb(23, 23, 23)",
    mutedText: "rgb(113, 113, 122)",
    border: "rgb(212, 212, 216)",
    focusBorder: "rgb(82, 111, 255)",
    primary: "rgb(23, 23, 23)",
    primaryText: "rgb(255, 255, 255)",
  },
  dark: {
    mode: "dark",
    accent: "rgb(96, 115, 204)",
    surface: "rgb(27, 27, 29)",
    text: "rgb(250, 250, 250)",
    mutedText: "rgb(161, 161, 170)",
    border: "rgb(63, 63, 70)",
    focusBorder: "rgb(96, 115, 204)",
    primary: "rgb(250, 250, 250)",
    primaryText: "rgb(24, 24, 27)",
  },
} as const satisfies Record<BrowserAnnotationTheme["mode"], BrowserAnnotationTheme>;

function resolvedBrowserAnnotationColor(
  root: Pick<HTMLElement, "classList">,
  property: string,
  fallback: string,
): string {
  const element = root as HTMLElement;
  const ownerDocument = element.ownerDocument;
  const view = element.ownerDocument?.defaultView;
  if (!ownerDocument || !view || typeof element.append !== "function") return fallback;
  const probe = ownerDocument.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;inset:0 auto auto 0;visibility:hidden;pointer-events:none;";
  probe.style.color = `var(${property}, ${fallback})`;
  try {
    element.append(probe);
    const value = view.getComputedStyle(probe).color.trim();
    return value.length <= 64 && SAFE_RESOLVED_BROWSER_ANNOTATION_COLOR.test(value)
      ? value
      : fallback;
  } catch {
    return fallback;
  } finally {
    probe.remove();
  }
}

export function browserAnnotationTheme(
  root: Pick<HTMLElement, "classList">,
): BrowserAnnotationTheme {
  const mode = root.classList.contains("dark") ? "dark" : "light";
  const fallback = BROWSER_ANNOTATION_THEME_FALLBACKS[mode];
  return {
    mode,
    accent: resolvedBrowserAnnotationColor(root, "--color-text-accent", fallback.accent),
    // The overlay renders inside the guest page without the backdrop blur the
    // composer sits on, so a translucent surface (--composer-surface is ~14%
    // transparent in light mode) would let page content show through the cards.
    // The opaque control token is the same fill without the glass assumption.
    surface: resolvedBrowserAnnotationColor(
      root,
      "--color-background-control-opaque",
      fallback.surface,
    ),
    text: resolvedBrowserAnnotationColor(root, "--color-text-foreground", fallback.text),
    mutedText: resolvedBrowserAnnotationColor(
      root,
      "--color-text-foreground-secondary",
      fallback.mutedText,
    ),
    border: resolvedBrowserAnnotationColor(root, "--color-border-heavy", fallback.border),
    focusBorder: resolvedBrowserAnnotationColor(root, "--color-border-focus", fallback.focusBorder),
    primary: resolvedBrowserAnnotationColor(
      root,
      "--color-background-button-primary",
      fallback.primary,
    ),
    primaryText: resolvedBrowserAnnotationColor(
      root,
      "--color-text-button-primary",
      fallback.primaryText,
    ),
  };
}

export function formatBrowserAnnotationActionError(
  error: unknown,
  action: "start" | "cancel" | "sync",
): string {
  const message = error instanceof Error ? error.message : "";
  if (/not (?:currently )?visible|must be visible/i.test(message)) {
    return "Bring the browser tab into view before annotating.";
  }
  if (/document.*not ready|page.*not ready|still loading/i.test(message)) {
    return "This page is still loading. Try annotating again in a moment.";
  }
  if (/guest.*(?:missing|unavailable|not found)|tab.*not found/i.test(message)) {
    return "This browser tab isn't available for annotation.";
  }
  if (/session.*active|already.*annotat/i.test(message)) {
    return "Annotation mode is already active.";
  }
  if (action === "cancel") {
    return "Couldn't close annotation mode. Try again.";
  }
  if (action === "sync") {
    return "Couldn't refresh annotation markers.";
  }
  return "Couldn't start annotation mode. Try again.";
}

// Hides about:blank from the address bar so new tabs behave like real browsers.
export function browserAddressDisplayValue(
  tab: Pick<BrowserTabState, "url"> | null | undefined,
): string {
  const nextUrl = tab?.url?.trim() ?? "";
  return nextUrl === BROWSER_BLANK_URL ? "" : nextUrl;
}

// Component-facing alias for the shared desktop/web browser URL normalizer.
export const normalizeBrowserAddressInput = normalizeBrowserUrlInput;

// A raw file:// URL must never reach Electron's renderer-owned <webview>. Main translates it
// to Synara's directory-scoped preview protocol after adopting the guest.
export function browserWebviewInitialUrl(url: string): string {
  try {
    return new URL(url).protocol === "file:" ? BROWSER_BLANK_URL : url;
  } catch {
    return url;
  }
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function displaySuggestionUrl(value: string): string {
  return value.trim().replace(/^about:blank$/i, "");
}

function suggestionMatches(query: string, candidate: string): boolean {
  if (query.length === 0) {
    return true;
  }
  return normalizeQuery(candidate).includes(query);
}

function pushSuggestion(
  suggestions: BrowserAddressSuggestion[],
  seenUrls: Set<string>,
  suggestion: BrowserAddressSuggestion,
): void {
  if (suggestions.length >= BROWSER_SUGGESTION_LIMIT || seenUrls.has(suggestion.url)) {
    return;
  }

  seenUrls.add(suggestion.url);
  suggestions.push(suggestion);
}

// Builds browser-like suggestions from the typed query, open tabs, and recent history.
export function buildBrowserAddressSuggestions(
  input: BuildBrowserAddressSuggestionsInput,
): BrowserAddressSuggestion[] {
  const query = normalizeQuery(input.query);
  const suggestions: BrowserAddressSuggestion[] = [];
  const seenUrls = new Set<string>();
  const directTarget = normalizeBrowserAddressInput(input.query);

  if (query.length > 0) {
    const directTitle = directTarget.startsWith(BROWSER_SEARCH_URL_PREFIX)
      ? `Search the web for "${input.query.trim()}"`
      : `Open ${directTarget}`;
    pushSuggestion(suggestions, seenUrls, {
      id: `direct:${directTarget}`,
      kind: "navigate",
      title: directTitle,
      detail: directTarget,
      url: directTarget,
    });
  }

  for (const tab of input.tabs) {
    const tabUrl = displaySuggestionUrl(tab.lastCommittedUrl ?? tab.url);
    if (tabUrl.length === 0 || tab.id === input.activeTabId) {
      continue;
    }
    if (!suggestionMatches(query, `${tab.title} ${tabUrl}`)) {
      continue;
    }
    pushSuggestion(suggestions, seenUrls, {
      id: `tab:${tab.id}`,
      kind: "tab",
      title: tab.title || tabUrl,
      detail: tabUrl,
      url: tabUrl,
      tabId: tab.id,
      faviconUrl: tab.faviconUrl,
    });
  }

  for (const entry of input.recentHistory) {
    const entryUrl = displaySuggestionUrl(entry.url);
    if (entryUrl.length === 0) {
      continue;
    }
    if (!suggestionMatches(query, `${entry.title} ${entryUrl}`)) {
      continue;
    }
    pushSuggestion(suggestions, seenUrls, {
      id: `history:${entry.url}`,
      kind: "history",
      title: entry.title || entryUrl,
      detail: entryUrl,
      url: entryUrl,
    });
  }

  return suggestions.slice(0, BROWSER_SUGGESTION_LIMIT);
}

// Only shows transient browser state; the address field already reflects the active URL.
export function resolveBrowserChromeStatus(input: {
  localError: string | null;
  threadLastError: string | null | undefined;
  activeTabStatus: string;
  hasActiveTab: boolean;
  workspaceReady: boolean;
}): BrowserChromeStatus | null {
  if (input.localError) {
    return {
      tone: "error",
      label: input.localError,
    };
  }

  if (input.threadLastError) {
    return {
      tone: "error",
      label: input.threadLastError,
    };
  }

  if (!input.hasActiveTab) {
    return {
      tone: "default",
      label: input.workspaceReady ? "No tabs open" : "Starting browser...",
    };
  }

  if (input.activeTabStatus === "suspended") {
    return {
      tone: "default",
      label: "Restoring tab...",
    };
  }

  return null;
}

// Decides when browser state should replace the visible address input.
export function resolveBrowserAddressSync(
  input: ResolveBrowserAddressSyncInput,
): BrowserAddressSyncDecision {
  if (!input.activeTabId) {
    return {
      type: "replace",
      value: "",
      syncedValue: undefined,
    };
  }

  if (input.activeTabId !== input.previousActiveTabId) {
    if (input.savedDraft !== undefined) {
      return {
        type: "replace",
        value: input.savedDraft,
        syncedValue: input.lastSyncedValue,
      };
    }

    return {
      type: "replace",
      value: input.nextDisplayValue,
      syncedValue: input.nextDisplayValue,
    };
  }

  if (input.isEditing || input.lastSyncedValue === input.nextDisplayValue) {
    return { type: "keep" };
  }

  return {
    type: "replace",
    value: input.nextDisplayValue,
    syncedValue: input.nextDisplayValue,
  };
}

// Bounds keys used to include a bare ":hidden" suffix. Hidden keys now carry a
// zoom token (`renderer:hidden:zoom-1`), so callers must not use endsWith(":hidden").
export function isBrowserPanelBoundsHiddenKey(key: string): boolean {
  return key.includes(":hidden");
}

export function applyBrowserWebviewPresentation(
  stage: HTMLElement,
  input: {
    floating: boolean;
    slotWidth: number;
    slotHeight: number;
    borderRadius?: string;
  },
): void {
  // Keep the <webview> sized to its slot. Scaling the native guest with a CSS
  // transform leaves an unclipped 1280×800 surface that ignores the card radius.
  stage.style.position = "absolute";
  stage.style.inset = "0";
  stage.style.left = "";
  stage.style.top = "";
  stage.style.width = "100%";
  stage.style.height = "100%";
  stage.style.transform = "";
  stage.style.transformOrigin = "";
  stage.style.overflow = "hidden";
  if (!input.floating) {
    stage.style.borderRadius = "";
    stage.style.clipPath = "";
    const webview = stage.firstElementChild;
    if (webview && "style" in webview) {
      const guest = webview as HTMLElement;
      guest.style.borderRadius = "";
      guest.style.clipPath = "";
      guest.style.overflow = "";
    }
    return;
  }
  const borderRadius = input.borderRadius ?? "12px";
  stage.style.borderRadius = borderRadius;
  stage.style.clipPath = `inset(0 round ${borderRadius})`;
  const webview = stage.firstElementChild;
  if (webview && "style" in webview) {
    const guest = webview as HTMLElement;
    guest.style.borderRadius = borderRadius;
    guest.style.overflow = "hidden";
    guest.style.clipPath = `inset(0 round ${borderRadius})`;
  }
}

export function applyBrowserWebviewPageZoom(
  webview: HTMLElement | null | undefined,
  pageZoomFactor: number,
): void {
  if (!webview) {
    return;
  }
  const factor = normalizeBrowserPageZoomFactor(pageZoomFactor);
  const guest = webview as HTMLElement & { setZoomFactor?: (value: number) => void };
  try {
    guest.setZoomFactor?.(factor);
  } catch {
    // The guest may not be attached yet; the next load or bounds sync retries.
  }
}
