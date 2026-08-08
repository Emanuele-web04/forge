// FILE: diffRenderModeStore.ts
// Purpose: Persists per-thread stacked/split diff layout choices separately from the
//          Settings default, so in-panel toggles survive thread switches without
//          overwriting the configurable default.
// Layer: Web UI state store
// Exports: per-thread diff render mode store helpers

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DiffRenderMode } from "./appSettings";
import { sanitizeStringKeyedRecord } from "./persistedRecord";

const DIFF_RENDER_MODE_STORAGE_KEY = "synara:diff-render-mode-by-thread:v1";

function isDiffRenderMode(value: unknown): value is DiffRenderMode {
  return value === "stacked" || value === "split";
}

interface DiffRenderModeStore {
  modeByThreadId: Record<string, DiffRenderMode>;
  getModeForThread: (threadId: string | null, fallback: DiffRenderMode) => DiffRenderMode;
  setModeForThread: (threadId: string, mode: DiffRenderMode) => void;
}

export const useDiffRenderModeStore = create<DiffRenderModeStore>()(
  persist(
    (set, get) => ({
      modeByThreadId: {},
      getModeForThread: (threadId, fallback) => {
        if (!threadId) {
          return fallback;
        }
        return get().modeByThreadId[threadId] ?? fallback;
      },
      setModeForThread: (threadId, mode) =>
        set((state) => ({
          modeByThreadId: {
            ...state.modeByThreadId,
            [threadId]: mode,
          },
        })),
    }),
    {
      name: DIFF_RENDER_MODE_STORAGE_KEY,
      // Resolve storage through globalThis on each call so tests can replace
      // localStorage after this module has already been evaluated.
      storage: createJSONStorage(() => ({
        getItem: (name) => globalThis.localStorage.getItem(name),
        setItem: (name, value) => {
          globalThis.localStorage.setItem(name, value);
        },
        removeItem: (name) => {
          globalThis.localStorage.removeItem(name);
        },
      })),
      partialize: (state) => ({ modeByThreadId: state.modeByThreadId }),
      merge: (persisted, current) => {
        const persistedModes = (persisted as { modeByThreadId?: unknown } | undefined)
          ?.modeByThreadId;
        return {
          ...current,
          modeByThreadId: sanitizeStringKeyedRecord(persistedModes, (value) =>
            isDiffRenderMode(value) ? value : null,
          ),
        };
      },
    },
  ),
);
