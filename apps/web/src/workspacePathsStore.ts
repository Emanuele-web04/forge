// FILE: workspacePathsStore.ts
// Purpose: Cache server-reported filesystem roots needed before the welcome payload arrives.
// Layer: Server configuration state
// Exports: useWorkspacePathsStore

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import {
  normalizeServerWorkspacePaths,
  type ServerWorkspacePaths,
} from "./lib/serverWorkspacePaths";

interface WorkspacePathsStoreState {
  homeDir: string | null;
  chatWorkspaceRoot: string | null;
  studioWorkspaceRoot: string | null;
  setHomeDir: (homeDir: string | null | undefined) => void;
  setChatWorkspaceRoot: (chatWorkspaceRoot: string | null | undefined) => void;
  setStudioWorkspaceRoot: (studioWorkspaceRoot: string | null | undefined) => void;
  setServerWorkspacePaths: (paths: ServerWorkspacePaths) => void;
}

const WORKSPACE_PATHS_STORAGE_KEY = "synara:workspace-paths:v1";
const LEGACY_WORKSPACE_PAGES_STORAGE_KEY = "synara:workspace-pages:v2";

function createWorkspacePathsStorage(): StateStorage {
  return {
    getItem: (name) =>
      localStorage.getItem(name) ?? localStorage.getItem(LEGACY_WORKSPACE_PAGES_STORAGE_KEY),
    setItem: (name, value) => {
      localStorage.setItem(name, value);
      localStorage.removeItem(LEGACY_WORKSPACE_PAGES_STORAGE_KEY);
    },
    removeItem: (name) => {
      localStorage.removeItem(name);
      localStorage.removeItem(LEGACY_WORKSPACE_PAGES_STORAGE_KEY);
    },
  };
}

export const useWorkspacePathsStore = create<WorkspacePathsStoreState>()(
  persist(
    (set) => ({
      homeDir: null,
      chatWorkspaceRoot: null,
      studioWorkspaceRoot: null,
      setHomeDir: (homeDir) =>
        set((state) => {
          // `undefined` means server config has not arrived yet; keep the last known value.
          if (homeDir === undefined) {
            return state;
          }
          const normalizedHomeDir = homeDir?.trim() ?? null;
          return state.homeDir === normalizedHomeDir ? state : { homeDir: normalizedHomeDir };
        }),
      setChatWorkspaceRoot: (chatWorkspaceRoot) =>
        set((state) => {
          // `undefined` means server config has not arrived yet; keep the last known value.
          if (chatWorkspaceRoot === undefined) {
            return state;
          }
          const normalizedChatWorkspaceRoot = chatWorkspaceRoot?.trim() ?? null;
          return state.chatWorkspaceRoot === normalizedChatWorkspaceRoot
            ? state
            : { chatWorkspaceRoot: normalizedChatWorkspaceRoot };
        }),
      setStudioWorkspaceRoot: (studioWorkspaceRoot) =>
        set((state) => {
          // `undefined` means server config has not arrived yet; keep the last known value.
          if (studioWorkspaceRoot === undefined) {
            return state;
          }
          const normalizedStudioWorkspaceRoot = studioWorkspaceRoot?.trim() ?? null;
          return state.studioWorkspaceRoot === normalizedStudioWorkspaceRoot
            ? state
            : { studioWorkspaceRoot: normalizedStudioWorkspaceRoot };
        }),
      setServerWorkspacePaths: (paths) =>
        set((state) => {
          const normalizedPaths = normalizeServerWorkspacePaths(paths);
          const next: Partial<WorkspacePathsStoreState> = {};
          if (paths.homeDir !== undefined && state.homeDir !== normalizedPaths.homeDir) {
            next.homeDir = normalizedPaths.homeDir;
          }
          if (
            paths.chatWorkspaceRoot !== undefined &&
            state.chatWorkspaceRoot !== normalizedPaths.chatWorkspaceRoot
          ) {
            next.chatWorkspaceRoot = normalizedPaths.chatWorkspaceRoot;
          }
          if (
            paths.studioWorkspaceRoot !== undefined &&
            state.studioWorkspaceRoot !== normalizedPaths.studioWorkspaceRoot
          ) {
            next.studioWorkspaceRoot = normalizedPaths.studioWorkspaceRoot;
          }
          return Object.keys(next).length > 0 ? next : state;
        }),
    }),
    {
      name: WORKSPACE_PATHS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createWorkspacePathsStorage),
      partialize: (state) => ({
        homeDir: state.homeDir,
        chatWorkspaceRoot: state.chatWorkspaceRoot,
      }),
      migrate: (persistedState) => persistedState as Partial<WorkspacePathsStoreState>,
      merge: (persistedState, currentState) => {
        const candidate = (persistedState as Partial<WorkspacePathsStoreState> | undefined) ?? {};
        return {
          ...currentState,
          homeDir: candidate.homeDir?.trim() ?? null,
          chatWorkspaceRoot: candidate.chatWorkspaceRoot?.trim() ?? null,
        };
      },
    },
  ),
);
