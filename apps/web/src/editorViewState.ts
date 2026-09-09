// FILE: editorViewState.ts
// Purpose: Persists per-thread editor workspace view state (expanded explorer
//          directories, center mode) so re-entering the editor view restores it.
// Layer: Web UI state persistence

import type { ProjectId, ProviderKind, ThreadId } from "@synara/contracts";
import { isProviderKind } from "./providerOrdering";

const EDITOR_VIEW_STATE_STORAGE_KEY = "synara.editor.viewStateByThreadId";
const EDITOR_RAIL_CHAT_TABS_STORAGE_KEY = "synara.editor.railChatTabsByProjectId";
const MAX_PERSISTED_THREADS = 50;
const MAX_EDITOR_RAIL_CHAT_TABS = 8;

export interface EditorViewStateSnapshot {
  expandedDirectories: ReadonlyArray<string>;
  centerMode: "file" | "diff";
}

interface PersistedEditorViewState extends EditorViewStateSnapshot {
  updatedAt: number;
}

type PersistedEditorViewStateMap = Record<string, PersistedEditorViewState>;

export interface EditorRailChatTabSnapshot {
  id: ThreadId;
  title: string;
  provider: ProviderKind;
}

type PersistedEditorRailChatTabsMap = Record<string, ReadonlyArray<EditorRailChatTabSnapshot>>;

function readPersistedMap(): PersistedEditorViewStateMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as PersistedEditorViewStateMap;
  } catch {
    return {};
  }
}

export function readEditorViewState(threadId: string): EditorViewStateSnapshot | null {
  const entry = readPersistedMap()[threadId];
  if (!entry) {
    return null;
  }
  return {
    expandedDirectories: Array.isArray(entry.expandedDirectories)
      ? entry.expandedDirectories.filter((path): path is string => typeof path === "string")
      : [],
    centerMode: entry.centerMode === "file" ? "file" : "diff",
  };
}

export function storeEditorViewState(threadId: string, snapshot: EditorViewStateSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const map = readPersistedMap();
    map[threadId] = { ...snapshot, updatedAt: Date.now() };
    const entries = Object.entries(map);
    if (entries.length > MAX_PERSISTED_THREADS) {
      entries
        .toSorted((left, right) => (left[1]?.updatedAt ?? 0) - (right[1]?.updatedAt ?? 0))
        .slice(0, entries.length - MAX_PERSISTED_THREADS)
        .forEach(([staleThreadId]) => {
          delete map[staleThreadId];
        });
    }
    window.localStorage.setItem(EDITOR_VIEW_STATE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort preference persistence only.
  }
}

function normalizeEditorRailChatTabs(
  tabs: ReadonlyArray<EditorRailChatTabSnapshot>,
): ReadonlyArray<EditorRailChatTabSnapshot> {
  const seen = new Set<ThreadId>();
  const normalized: EditorRailChatTabSnapshot[] = [];
  for (const tab of tabs) {
    if (seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    normalized.push({
      id: tab.id,
      title: tab.title.trim() || "New thread",
      provider: tab.provider,
    });
    if (normalized.length >= MAX_EDITOR_RAIL_CHAT_TABS) {
      break;
    }
  }
  return normalized;
}

function readEditorRailChatTabsMap(): PersistedEditorRailChatTabsMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(EDITOR_RAIL_CHAT_TABS_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const map: PersistedEditorRailChatTabsMap = {};
    for (const [projectId, rawTabs] of Object.entries(parsed)) {
      if (!Array.isArray(rawTabs)) {
        continue;
      }
      map[projectId] = normalizeEditorRailChatTabs(
        rawTabs.flatMap((rawTab): EditorRailChatTabSnapshot[] => {
          if (typeof rawTab !== "object" || rawTab === null || Array.isArray(rawTab)) {
            return [];
          }
          const candidate = rawTab as Record<string, unknown>;
          const provider =
            typeof candidate.provider === "string"
              ? candidate.provider === "kilo"
                ? "opencode"
                : candidate.provider
              : null;
          if (
            typeof candidate.id !== "string" ||
            typeof candidate.title !== "string" ||
            provider === null ||
            !isProviderKind(provider)
          ) {
            return [];
          }
          return [
            {
              id: candidate.id as ThreadId,
              title: candidate.title,
              provider,
            },
          ];
        }),
      );
    }
    return map;
  } catch {
    return {};
  }
}

export function readEditorRailChatTabs(
  projectId: ProjectId,
): ReadonlyArray<EditorRailChatTabSnapshot> {
  return readEditorRailChatTabsMap()[projectId] ?? [];
}

export function storeEditorRailChatTabs(
  projectId: ProjectId,
  tabs: ReadonlyArray<EditorRailChatTabSnapshot>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const map = readEditorRailChatTabsMap();
    const normalizedTabs = normalizeEditorRailChatTabs(tabs);
    if (normalizedTabs.length === 0) {
      delete map[projectId];
    } else {
      map[projectId] = normalizedTabs;
    }
    window.localStorage.setItem(EDITOR_RAIL_CHAT_TABS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort preference persistence only.
  }
}
