// FILE: BrowserPanel.logic.ts
// Purpose: Holds address-bar rules plus renderer lifecycle guards for the in-app browser panel.
// Layer: Component logic helper
// Exports: address helpers, panel hide scheduling, and one-shot renderer-loss recovery
// Depends on: shared browser URL rules, browser tab metadata, and thread-local browser history

import {
  BROWSER_BLANK_URL,
  BROWSER_SEARCH_URL_PREFIX,
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
  readonly cancel: (threadId: string) => void;
  readonly schedule: (threadId: string, hide: () => void) => void;
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

  function cancel(threadId: string): void {
    const pending = pendingByThreadId.get(threadId);
    if (pending === undefined) return;
    pendingByThreadId.delete(threadId);
    clearTimer(pending);
  }

  function schedule(threadId: string, hide: () => void): void {
    cancel(threadId);
    const pending = setTimer(() => {
      if (pendingByThreadId.get(threadId) !== pending) return;
      pendingByThreadId.delete(threadId);
      hide();
    });
    pendingByThreadId.set(threadId, pending);
  }

  return { cancel, schedule };
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
    surface: resolvedBrowserAnnotationColor(root, "--composer-surface", fallback.surface),
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
