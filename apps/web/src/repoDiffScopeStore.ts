// FILE: repoDiffScopeStore.ts
// Purpose: Persists the active repo diff scope shared by the diff panel and header badge.
// Layer: Web UI state store
// Exports: repo diff scope labels, validation, and a persisted Zustand store.

import type { GitReadWorkingTreeDiffInput } from "@synara/contracts";
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type RepoDiffScope = NonNullable<GitReadWorkingTreeDiffInput["scope"]>;

export const DEFAULT_REPO_DIFF_SCOPE: RepoDiffScope = "workingTree";

export const REPO_DIFF_SCOPE_LABELS: Record<RepoDiffScope, string> = {
  workingTree: "Working tree",
  unstaged: "Unstaged",
  staged: "Staged",
  branch: "Branch",
  ref: "Compare with",
};

const COMPARE_REF_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMPARE_REF_MAX_LABEL_LENGTH = 24;

export function formatCompareRefLabel(compareRef: string | null): string {
  const trimmed = compareRef?.trim() ?? "";
  if (trimmed.length === 0) {
    return REPO_DIFF_SCOPE_LABELS.ref;
  }
  const shortened = COMPARE_REF_SHA_PATTERN.test(trimmed) ? trimmed.slice(0, 7) : trimmed;
  return shortened.length > COMPARE_REF_MAX_LABEL_LENGTH
    ? `${shortened.slice(0, COMPARE_REF_MAX_LABEL_LENGTH - 1)}…`
    : shortened;
}

export function resolveRepoDiffScopeLabel(scope: RepoDiffScope, compareRef: string | null): string {
  if (scope === "ref") {
    return `vs ${formatCompareRefLabel(compareRef)}`;
  }
  return REPO_DIFF_SCOPE_LABELS[scope];
}

export function isRepoDiffScope(value: string): value is RepoDiffScope {
  return (
    value === "workingTree" ||
    value === "unstaged" ||
    value === "staged" ||
    value === "branch" ||
    value === "ref"
  );
}

interface RepoDiffScopeStore {
  scope: RepoDiffScope;
  /**
   * Compare refs are repository-specific: a branch or SHA picked for one
   * project is usually meaningless in another, so they are keyed by cwd.
   */
  compareRefs: Readonly<Record<string, string>>;
  setScope: (scope: RepoDiffScope) => void;
  setCompareRef: (cwd: string, compareRef: string | null) => void;
}

export interface RepoDiffScopeSelection {
  scope: RepoDiffScope;
  compareRef: string | null;
}

const REPO_DIFF_SCOPE_STORAGE_KEY = "synara:repo-diff-scope:v1";

export function sanitizeRepoDiffCompareRefs(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const compareRefs: Record<string, string> = {};
  for (const [cwd, compareRef] of Object.entries(value)) {
    if (typeof compareRef === "string" && compareRef.trim().length > 0) {
      compareRefs[cwd] = compareRef;
    }
  }
  return compareRefs;
}

/**
 * The ref scope only makes sense with a ref for the repository being shown;
 * a repository without one falls back to the default scope.
 */
export function resolveRepoDiffScopeSelection(
  scope: RepoDiffScope,
  compareRef: string | null,
): RepoDiffScopeSelection {
  return scope === "ref" && compareRef === null
    ? { scope: DEFAULT_REPO_DIFF_SCOPE, compareRef: null }
    : { scope, compareRef };
}

export const useRepoDiffScopeStore = create<RepoDiffScopeStore>()(
  persist(
    (set) => ({
      scope: DEFAULT_REPO_DIFF_SCOPE,
      compareRefs: {},
      setScope: (scope) => set({ scope }),
      setCompareRef: (cwd, compareRef) =>
        set((state) => {
          const trimmed = compareRef?.trim() ?? "";
          const compareRefs = Object.fromEntries(
            Object.entries(state.compareRefs).filter(([key]) => key !== cwd),
          );
          return {
            compareRefs: trimmed.length > 0 ? { ...compareRefs, [cwd]: trimmed } : compareRefs,
          };
        }),
    }),
    {
      name: REPO_DIFF_SCOPE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ scope: state.scope, compareRefs: state.compareRefs }),
      // Validate the persisted state on rehydrate: an unknown/legacy value would
      // otherwise flow into the diff request and the label lookup unchecked.
      merge: (persisted, current) => {
        const persistedState = persisted as { scope?: unknown; compareRefs?: unknown } | undefined;
        const persistedScope = persistedState?.scope;
        return {
          ...current,
          scope:
            typeof persistedScope === "string" && isRepoDiffScope(persistedScope)
              ? persistedScope
              : DEFAULT_REPO_DIFF_SCOPE,
          compareRefs: sanitizeRepoDiffCompareRefs(persistedState?.compareRefs),
        };
      },
    },
  ),
);

/**
 * Reads the scope for one repository. Every mounted consumer resolves its own
 * cwd here, so split panes showing different repositories never contend over
 * a single "active" repository.
 */
export function useRepoDiffScope(cwd: string | null): RepoDiffScopeSelection {
  const scope = useRepoDiffScopeStore((store) => store.scope);
  const compareRef = useRepoDiffScopeStore((store) =>
    cwd === null ? null : (store.compareRefs[cwd] ?? null),
  );
  return useMemo(() => resolveRepoDiffScopeSelection(scope, compareRef), [compareRef, scope]);
}
