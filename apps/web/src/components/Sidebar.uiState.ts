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
  /** Paging keyed by stable project id; preferred over the legacy cwd map. */
  projectThreadListExtraPagesById: Record<string, number>;
  dismissedThreadStatusKeyByThreadId: Record<string, string>;
  lastThreadRoute: LastThreadRoute | null;
  /** Swaps the Projects surface for the flat task-feed Activity view. */
  activityViewEnabled: boolean;
  /**
   * Explicitly expanded hierarchy branches, shared by both sidebars, Chats,
   * Studio and Pinned. Branches start closed; only explicit opens persist.
   * Ids of temporarily absent threads are kept so hydration and undo restore
   * them; changing presentation or groups never resets them.
   */
  expandedThreadIds: string[];
};

const DEFAULT_SIDEBAR_UI_STATE: SidebarUiState = {
  chatSectionExpanded: false,
  chatThreadListExtraPages: 0,
  projectThreadListExtraPagesByCwd: {},
  projectThreadListExtraPagesById: {},
  dismissedThreadStatusKeyByThreadId: {},
  lastThreadRoute: null,
  activityViewEnabled: false,
  expandedThreadIds: [],
};

// Persisted paging is a request, not a promise: render-time clamping trims it to the real
// thread count, so the cap here only guards against absurd/corrupted stored values.
const MAX_PERSISTED_THREAD_LIST_EXTRA_PAGES = 1000;

// Expanded branches are explicit user preference shared across views; the cap
// only guards storage against absurd/corrupted values, never trims valid opens
// during a session. Missing threads are kept so hydration/undo restore them.
const MAX_PERSISTED_EXPANDED_THREAD_IDS = 500;

export function sanitizeExpandedThreadIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      continue;
    }
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    sanitized.push(entry);
    if (sanitized.length >= MAX_PERSISTED_EXPANDED_THREAD_IDS) {
      break;
    }
  }
  return sanitized;
}

/** Toggle one branch open/closed, preserving order and the storage cap. */
export function toggleExpandedThreadId(
  expandedThreadIds: readonly string[],
  threadId: string,
): string[] {
  if (threadId.length === 0) {
    return [...expandedThreadIds];
  }
  if (expandedThreadIds.includes(threadId)) {
    return expandedThreadIds.filter((id) => id !== threadId);
  }
  const next = [...expandedThreadIds, threadId];
  if (next.length <= MAX_PERSISTED_EXPANDED_THREAD_IDS) {
    return next;
  }
  return next.slice(next.length - MAX_PERSISTED_EXPANDED_THREAD_IDS);
}

/** In-memory per-branch child paging shared during the Sidebar mount (not persisted). */
export function resolveChildExtraPages(
  childExtraPagesByParentId: ReadonlyMap<string, number> | undefined,
  parentId: string,
): number {
  if (!childExtraPagesByParentId) {
    return 0;
  }
  const pages = childExtraPagesByParentId.get(parentId);
  if (typeof pages !== "number" || !Number.isFinite(pages)) {
    return 0;
  }
  return Math.max(0, Math.floor(pages));
}

export function normalizeSidebarProjectThreadListCwd(cwd: string): string {
  return normalizeWorkspaceRootForComparison(cwd);
}

function sanitizeThreadListExtraPages(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(0, Math.floor(value)), MAX_PERSISTED_THREAD_LIST_EXTRA_PAGES);
}

function sanitizeProjectThreadListExtraPagesById(
  value: Record<string, unknown> | undefined,
): Record<string, number> {
  const extraPagesById: Record<string, number> = {};
  for (const [projectId, rawExtraPages] of Object.entries(value ?? {})) {
    if (projectId.length === 0) {
      continue;
    }
    const extraPages = sanitizeThreadListExtraPages(rawExtraPages);
    if (extraPages <= 0) {
      continue;
    }
    extraPagesById[projectId] = Math.max(extraPagesById[projectId] ?? 0, extraPages);
  }
  return extraPagesById;
}

/**
 * Paging lookup that survives project rename/move: the stable project id wins,
 * and pre-migration entries persisted by normalized cwd still apply as fallback.
 */
function isExtraPagesMap(
  value: Readonly<Record<string, number>> | ReadonlyMap<string, number>,
): value is ReadonlyMap<string, number> {
  return value instanceof Map;
}

export function resolveProjectThreadListExtraPages(input: {
  extraPagesById: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
  legacyExtraPagesByCwd: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
  projectId: string;
  projectCwd: string;
}): number {
  const byId = isExtraPagesMap(input.extraPagesById)
    ? (input.extraPagesById.get(input.projectId) ?? 0)
    : (input.extraPagesById[input.projectId] ?? 0);
  if (byId > 0) {
    return byId;
  }
  const normalizedCwd = normalizeSidebarProjectThreadListCwd(input.projectCwd);
  if (normalizedCwd.length === 0) {
    return 0;
  }
  return isExtraPagesMap(input.legacyExtraPagesByCwd)
    ? (input.legacyExtraPagesByCwd.get(normalizedCwd) ?? 0)
    : (input.legacyExtraPagesByCwd[normalizedCwd] ?? 0);
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
      projectThreadListExtraPagesById?: Record<string, unknown>;
      /** Legacy (pre-paging) all-or-nothing "Show more" flags, migrated to one extra page. */
      chatThreadListExpanded?: boolean;
      expandedProjectThreadListCwds?: string[];
      dismissedThreadStatusKeyByThreadId?: Record<string, string>;
      lastThreadRoute?: {
        threadId?: unknown;
        splitViewId?: unknown;
      } | null;
      activityViewEnabled?: boolean;
      expandedThreadIds?: unknown;
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
      projectThreadListExtraPagesById: sanitizeProjectThreadListExtraPagesById(
        parsed.projectThreadListExtraPagesById,
      ),
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
      // v1-compatible: missing or corrupt expansion defaults to all branches closed.
      expandedThreadIds: sanitizeExpandedThreadIds(parsed.expandedThreadIds),
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
        projectThreadListExtraPagesById: sanitizeProjectThreadListExtraPagesById(
          input.projectThreadListExtraPagesById,
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
        expandedThreadIds: sanitizeExpandedThreadIds(input.expandedThreadIds),
      }),
    );
  } catch {
    // Ignore storage errors so sidebar rendering keeps working when persistence is unavailable.
  }
}
