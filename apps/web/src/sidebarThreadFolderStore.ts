// FILE: sidebarThreadFolderStore.ts
// Purpose: Persists visual-only thread folders for the normal Projects sidebar.
// Layer: UI state store
// Exports: useSidebarThreadFolderStore and folder view-model helpers.

import type { ProjectId, ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface SidebarThreadFolder {
  id: string;
  projectId: ProjectId;
  name: string;
  createdAt: string;
  archivedAt: string | null;
}

interface SidebarThreadFolderState {
  folders: SidebarThreadFolder[];
  folderIdByThreadId: Record<string, string>;
  collapsedFolderIds: Record<string, true>;
  createFolder: (input: {
    id: string;
    projectId: ProjectId;
    name: string;
    threadIds?: readonly ThreadId[];
    createdAt?: string;
  }) => void;
  renameFolder: (folderId: string, name: string) => void;
  assignThreads: (folderId: string | null, threadIds: readonly ThreadId[]) => void;
  setFolderCollapsed: (folderId: string, collapsed: boolean) => void;
  archiveFolder: (folderId: string, archivedAt?: string) => void;
  restoreFolder: (folderId: string) => void;
  deleteFolder: (folderId: string) => void;
  pruneProjects: (projectIds: readonly ProjectId[]) => void;
}

const STORAGE_KEY = "synara:sidebar-thread-folders:v1";
const unavailableStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

function normalizedFolderName(name: string): string {
  return name.trim().slice(0, 80);
}

function sanitizeFolders(value: unknown): SidebarThreadFolder[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const folders: SidebarThreadFolder[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const projectId = typeof row.projectId === "string" ? row.projectId.trim() : "";
    const name = typeof row.name === "string" ? normalizedFolderName(row.name) : "";
    if (!id || !projectId || !name || seen.has(id)) continue;
    seen.add(id);
    folders.push({
      id,
      projectId: projectId as ProjectId,
      name,
      createdAt:
        typeof row.createdAt === "string" && row.createdAt.length > 0
          ? row.createdAt
          : new Date(0).toISOString(),
      archivedAt:
        typeof row.archivedAt === "string" && row.archivedAt.length > 0 ? row.archivedAt : null,
    });
  }
  return folders;
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) => key.length > 0 && typeof entry === "string" && entry.length > 0,
    ),
  );
}

function sanitizeCollapsedRecord(value: unknown): Record<string, true> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => key.length > 0 && entry === true)
      .map(([key]) => [key, true] as const),
  );
}

export function getProjectThreadFolders(
  folders: readonly SidebarThreadFolder[],
  projectId: ProjectId,
  options?: { includeArchived?: boolean },
): SidebarThreadFolder[] {
  return folders.filter(
    (folder) =>
      folder.projectId === projectId && (options?.includeArchived || folder.archivedAt === null),
  );
}

export function getThreadIdsInFolder(
  folderIdByThreadId: Readonly<Record<string, string>>,
  folderId: string,
): ThreadId[] {
  return Object.entries(folderIdByThreadId)
    .filter(([, assignedFolderId]) => assignedFolderId === folderId)
    .map(([threadId]) => threadId as ThreadId);
}

export function groupThreadFolderEntries<T extends { readonly rootRowId: ThreadId }>(input: {
  entries: readonly T[];
  activeFolderIds: ReadonlySet<string>;
  folderIdByThreadId: Readonly<Record<string, string>>;
  collapsedFolderIds?: Readonly<Record<string, true>>;
}): { rootEntries: T[]; entriesByFolderId: Map<string, T[]>; visibleEntries: T[] } {
  const rootEntries: T[] = [];
  const entriesByFolderId = new Map<string, T[]>();
  for (const entry of input.entries) {
    // A subagent row follows the top-level parent represented by rootRowId.
    const folderId = input.folderIdByThreadId[entry.rootRowId];
    if (!folderId || !input.activeFolderIds.has(folderId)) {
      rootEntries.push(entry);
      continue;
    }
    const folderEntries = entriesByFolderId.get(folderId) ?? [];
    folderEntries.push(entry);
    entriesByFolderId.set(folderId, folderEntries);
  }

  const visibleEntries: T[] = [];
  // The active-folder set is created from the rendered folder list, so its insertion order
  // is the visual order. Root rows render after every visual folder.
  for (const folderId of input.activeFolderIds) {
    if (input.collapsedFolderIds?.[folderId] === true) continue;
    visibleEntries.push(...(entriesByFolderId.get(folderId) ?? []));
  }
  visibleEntries.push(...rootEntries);

  return { rootEntries, entriesByFolderId, visibleEntries };
}

export const useSidebarThreadFolderStore = create<SidebarThreadFolderState>()(
  persist(
    (set) => ({
      folders: [],
      folderIdByThreadId: {},
      collapsedFolderIds: {},
      createFolder: ({ id, projectId, name, threadIds = [], createdAt }) => {
        const normalizedName = normalizedFolderName(name);
        if (!id.trim() || !normalizedName) return;
        set((state) => {
          if (state.folders.some((folder) => folder.id === id)) return state;
          const folderIdByThreadId = { ...state.folderIdByThreadId };
          for (const threadId of threadIds) folderIdByThreadId[threadId] = id;
          return {
            folders: [
              ...state.folders,
              {
                id,
                projectId,
                name: normalizedName,
                createdAt: createdAt ?? new Date().toISOString(),
                archivedAt: null,
              },
            ],
            folderIdByThreadId,
          };
        });
      },
      renameFolder: (folderId, name) => {
        const normalizedName = normalizedFolderName(name);
        if (!normalizedName) return;
        set((state) => ({
          folders: state.folders.map((folder) =>
            folder.id === folderId ? { ...folder, name: normalizedName } : folder,
          ),
        }));
      },
      assignThreads: (folderId, threadIds) => {
        if (threadIds.length === 0) return;
        set((state) => {
          const next = { ...state.folderIdByThreadId };
          for (const threadId of threadIds) {
            if (folderId === null) delete next[threadId];
            else next[threadId] = folderId;
          }
          return { folderIdByThreadId: next };
        });
      },
      setFolderCollapsed: (folderId, collapsed) =>
        set((state) => {
          const next = { ...state.collapsedFolderIds };
          if (collapsed) next[folderId] = true;
          else delete next[folderId];
          return { collapsedFolderIds: next };
        }),
      archiveFolder: (folderId, archivedAt) =>
        set((state) => ({
          folders: state.folders.map((folder) =>
            folder.id === folderId
              ? { ...folder, archivedAt: archivedAt ?? new Date().toISOString() }
              : folder,
          ),
        })),
      restoreFolder: (folderId) =>
        set((state) => ({
          folders: state.folders.map((folder) =>
            folder.id === folderId ? { ...folder, archivedAt: null } : folder,
          ),
        })),
      deleteFolder: (folderId) =>
        set((state) => ({
          folders: state.folders.filter((folder) => folder.id !== folderId),
          folderIdByThreadId: Object.fromEntries(
            Object.entries(state.folderIdByThreadId).filter(
              ([, assignedFolderId]) => assignedFolderId !== folderId,
            ),
          ),
          collapsedFolderIds: Object.fromEntries(
            Object.entries(state.collapsedFolderIds).filter(([id]) => id !== folderId),
          ),
        })),
      pruneProjects: (projectIds) =>
        set((state) => {
          const validProjectIds = new Set(projectIds);
          const folders = state.folders.filter((folder) => validProjectIds.has(folder.projectId));
          if (folders.length === state.folders.length) return state;
          const validFolderIds = new Set(folders.map((folder) => folder.id));
          return {
            folders,
            folderIdByThreadId: Object.fromEntries(
              Object.entries(state.folderIdByThreadId).filter(([, id]) => validFolderIds.has(id)),
            ),
            collapsedFolderIds: Object.fromEntries(
              Object.entries(state.collapsedFolderIds).filter(([id]) => validFolderIds.has(id)),
            ),
          };
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined" ? unavailableStorage : localStorage,
      ),
      partialize: (state) => ({
        folders: state.folders,
        folderIdByThreadId: state.folderIdByThreadId,
        collapsedFolderIds: state.collapsedFolderIds,
      }),
      merge: (persisted, current) => {
        const candidate = (persisted ?? {}) as Record<string, unknown>;
        const folders = sanitizeFolders(candidate.folders);
        const folderIds = new Set(folders.map((folder) => folder.id));
        return {
          ...current,
          folders,
          folderIdByThreadId: Object.fromEntries(
            Object.entries(sanitizeStringRecord(candidate.folderIdByThreadId)).filter(([, id]) =>
              folderIds.has(id),
            ),
          ),
          collapsedFolderIds: Object.fromEntries(
            Object.entries(sanitizeCollapsedRecord(candidate.collapsedFolderIds)).filter(([id]) =>
              folderIds.has(id),
            ),
          ),
        };
      },
    },
  ),
);
