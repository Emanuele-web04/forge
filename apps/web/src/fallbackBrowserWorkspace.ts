// FILE: fallbackBrowserWorkspace.ts
// Purpose: In-memory thread browser workspace used when no desktop bridge exists.
// Layer: Web transport adapter support
// Exports: createFallbackBrowserWorkspace plus the pure browser-state helpers.

import type { ThreadBrowserState, ThreadId } from "@synara/contracts";

type FallbackBrowserTab = ThreadBrowserState["tabs"][number];

export function defaultBrowserTitle(url: string): string {
  if (url === "about:blank") {
    return "New tab";
  }
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function createFallbackTab(url = "about:blank"): FallbackBrowserTab {
  return {
    id: crypto.randomUUID(),
    url,
    title: defaultBrowserTitle(url),
    status: "live" as const,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: url,
    lastError: null,
  };
}

export function cloneBrowserState(state: ThreadBrowserState): ThreadBrowserState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  };
}

function defaultBrowserState(threadId: ThreadId): ThreadBrowserState {
  return {
    threadId,
    version: 0,
    open: false,
    activeTabId: null,
    tabs: [],
    lastError: null,
  };
}

export interface FallbackBrowserWorkspace {
  getState(threadId: ThreadId): ThreadBrowserState;
  /** Opens the workspace, creating a tab when none exists. Returns live state. */
  ensureWorkspace(threadId: ThreadId): ThreadBrowserState;
  resolveTab(state: ThreadBrowserState, tabId?: string): FallbackBrowserTab;
  markChanged(state: ThreadBrowserState): void;
  /** Publishes a defensive copy to state listeners and returns it. */
  emit(threadId: ThreadId): ThreadBrowserState;
  onState(listener: (state: ThreadBrowserState) => void): () => void;
  clear(): void;
}

export function createFallbackBrowserWorkspace(): FallbackBrowserWorkspace {
  const statesByThreadId = new Map<ThreadId, ThreadBrowserState>();
  const listeners = new Set<(state: ThreadBrowserState) => void>();

  const getState = (threadId: ThreadId): ThreadBrowserState => {
    const existing = statesByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const initial = defaultBrowserState(threadId);
    statesByThreadId.set(threadId, initial);
    return initial;
  };

  return {
    getState,
    ensureWorkspace(threadId) {
      const state = getState(threadId);
      if (state.tabs.length === 0) {
        const tab = createFallbackTab();
        state.tabs = [tab];
        state.activeTabId = tab.id;
      }
      state.open = true;
      return state;
    },
    resolveTab(state, tabId) {
      const existing =
        (tabId ? state.tabs.find((tab) => tab.id === tabId) : undefined) ??
        (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
        state.tabs[0];
      if (existing) {
        return existing;
      }
      const tab = createFallbackTab();
      state.tabs = [tab];
      state.activeTabId = tab.id;
      state.open = true;
      return tab;
    },
    markChanged(state) {
      state.version += 1;
    },
    emit(threadId) {
      const state = cloneBrowserState(getState(threadId));
      for (const listener of listeners) {
        try {
          listener(state);
        } catch {
          // A listener must not prevent delivery to the remaining subscribers.
        }
      }
      return state;
    },
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      statesByThreadId.clear();
      listeners.clear();
    },
  };
}
