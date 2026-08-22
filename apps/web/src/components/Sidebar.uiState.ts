// FILE: Sidebar.uiState.ts
// Purpose: Persists sidebar-only UI preferences plus the last chat route for restore flows.
// Layer: Browser storage helper
// Exports: sidebar UI state read/write helpers.

import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";
import type { LastThreadRoute } from "../chatRouteRestore";

const SIDEBAR_UI_STATE_STORAGE_KEY = "synara:sidebar-ui:v1";

export type SidebarUiState = {
  chatSectionExpanded: boolean;
  chatThreadListExtraPages: number;
  projectThreadListExtraPagesByCwd: Record<string, number>;
  dismissedThreadStatusKeyByThreadId: Record<string, string>;
  lastThreadRoute: LastThreadRoute | null;
  /** Swaps the Projects surface for the flat task-feed Activity view. */
  activityViewEnabled: boolean;
};

const DEFAULT_SIDEBAR_UI_STATE: SidebarUiState = {
  chatSectionExpanded: false,
  chatThreadListExtraPages: 0,
  projectThreadListExtraPagesByCwd: {},
  dismissedThreadStatusKeyByThreadId: {},
  lastThreadRoute: null,
  activityViewEnabled: false,
};

// Persisted paging is a request, not a promise: render-time clamping trims it to the real
// thread count, so the cap here only guards against absurd/corrupted stored values.
const MAX_PERSISTED_THREAD_LIST_EXTRA_PAGES = 1000;

export function normalizeSidebarProjectThreadListCwd(cwd: string): string {
  return normalizeWorkspaceRootForComparison(cwd);
}

function sanitizeThreadListExtraPages(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(0, Math.floor(value)), MAX_PERSISTED_THREAD_LIST_EXTRA_PAGES);
}

function sanitizeProjectThreadListExtraPagesByCwd(
  value: Record<string, unknown> | undefined,
): Record<string, number> {
  const extraPagesByCwd: Record<string, number> = {};
  for (const [cwd, rawExtraPages] of Object.entries(value ?? {})) {
    if (typeof cwd !== "string") {
      continue;
    }
    const normalizedCwd = normalizeSidebarProjectThreadListCwd(cwd);
    const extraPages = sanitizeThreadListExtraPages(rawExtraPages);
    if (normalizedCwd.length === 0 || extraPages <= 0) {
      continue;
    }
    // Duplicate cwds that normalize to the same key keep the deepest paging.
    extraPagesByCwd[normalizedCwd] = Math.max(extraPagesByCwd[normalizedCwd] ?? 0, extraPages);
  }
  return extraPagesByCwd;
}

export function readSidebarUiState(): SidebarUiState {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_UI_STATE;
  }

  try {
    const raw = window.localStorage.getItem(SIDEBAR_UI_STATE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SIDEBAR_UI_STATE;
    }

    const parsed = JSON.parse(raw) as {
      chatSectionExpanded?: boolean;
      chatThreadListExtraPages?: number;
      projectThreadListExtraPagesByCwd?: Record<string, unknown>;
      /** Legacy (pre-paging) all-or-nothing "Show more" flags, migrated to one extra page. */
      chatThreadListExpanded?: boolean;
      expandedProjectThreadListCwds?: string[];
      dismissedThreadStatusKeyByThreadId?: Record<string, string>;
      lastThreadRoute?: {
        threadId?: unknown;
        splitViewId?: unknown;
      } | null;
      activityViewEnabled?: boolean;
    };

    const lastThreadRoute =
      parsed.lastThreadRoute &&
      typeof parsed.lastThreadRoute.threadId === "string" &&
      parsed.lastThreadRoute.threadId.length > 0
        ? {
            threadId: parsed.lastThreadRoute.threadId,
            ...(typeof parsed.lastThreadRoute.splitViewId === "string" &&
            parsed.lastThreadRoute.splitViewId.length > 0
              ? { splitViewId: parsed.lastThreadRoute.splitViewId }
              : {}),
          }
        : null;

    const projectThreadListExtraPagesByCwd = sanitizeProjectThreadListExtraPagesByCwd(
      parsed.projectThreadListExtraPagesByCwd,
    );
    // Legacy state expanded whole lists at once; the closest paged equivalent is one extra page.
    for (const legacyCwd of parsed.expandedProjectThreadListCwds ?? []) {
      if (typeof legacyCwd !== "string") {
        continue;
      }
      const normalizedCwd = normalizeSidebarProjectThreadListCwd(legacyCwd);
      if (normalizedCwd.length === 0 || projectThreadListExtraPagesByCwd[normalizedCwd]) {
        continue;
      }
      projectThreadListExtraPagesByCwd[normalizedCwd] = 1;
    }

    return {
      chatSectionExpanded: parsed.chatSectionExpanded === true,
      chatThreadListExtraPages:
        parsed.chatThreadListExtraPages === undefined && parsed.chatThreadListExpanded === true
          ? 1
          : sanitizeThreadListExtraPages(parsed.chatThreadListExtraPages),
      projectThreadListExtraPagesByCwd,
      dismissedThreadStatusKeyByThreadId: Object.fromEntries(
        Object.entries(parsed.dismissedThreadStatusKeyByThreadId ?? {}).filter(
          ([threadId, statusKey]) =>
            typeof threadId === "string" &&
            threadId.length > 0 &&
            typeof statusKey === "string" &&
            statusKey.length > 0,
        ),
      ),
      lastThreadRoute,
      activityViewEnabled: parsed.activityViewEnabled === true,
    };
  } catch {
    return DEFAULT_SIDEBAR_UI_STATE;
  }
}

/**
 * Notifies when another tab rewrites the persisted sidebar UI state. Every tab
 * persists this key wholesale from its in-memory state, so without adopting
 * external writes a two-tab session silently fights over fields like the
 * Activity view toggle (last writer wins and the toggle feels "stuck").
 */
export function subscribeSidebarUiState(listener: (state: SidebarUiState) => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== SIDEBAR_UI_STATE_STORAGE_KEY) return;
    listener(readSidebarUiState());
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}

export function persistSidebarUiState(input: SidebarUiState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      SIDEBAR_UI_STATE_STORAGE_KEY,
      JSON.stringify({
        chatSectionExpanded: input.chatSectionExpanded,
        chatThreadListExtraPages: sanitizeThreadListExtraPages(input.chatThreadListExtraPages),
        projectThreadListExtraPagesByCwd: sanitizeProjectThreadListExtraPagesByCwd(
          input.projectThreadListExtraPagesByCwd,
        ),
        dismissedThreadStatusKeyByThreadId: Object.fromEntries(
          Object.entries(input.dismissedThreadStatusKeyByThreadId).filter(
            ([threadId, statusKey]) => threadId.length > 0 && statusKey.length > 0,
          ),
        ),
        lastThreadRoute: input.lastThreadRoute
          ? {
              threadId: input.lastThreadRoute.threadId,
              ...(input.lastThreadRoute.splitViewId
                ? { splitViewId: input.lastThreadRoute.splitViewId }
                : {}),
            }
          : null,
        activityViewEnabled: input.activityViewEnabled,
      }),
    );
  } catch {
    // Ignore storage errors so sidebar rendering keeps working when persistence is unavailable.
  }
}
