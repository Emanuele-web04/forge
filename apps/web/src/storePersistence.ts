// FILE: storePersistence.ts
// Purpose: Persists project-only renderer preferences without depending on the Zustand facade.
// Exports: Persistence I/O plus read-only remembered project UI state.

import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";

import type { AppState } from "./storeState";
import type { Project } from "./types";

export const PERSISTED_STATE_KEY = "synara:renderer-state:v8";
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderByCwd = new Map<string, number>();
const persistedProjectNamesByCwd = new Map<string, string>();
let persistedExpandedProjectCwdsDefined = false;

export interface RememberedProjectUiState {
  expandedProjectCount: number;
  hasLegacyExpandedCwds: boolean;
  isProjectExpanded: (cwdKey: string) => boolean;
  projectOrderCount: number;
  projectOrderIndexForCwd: (cwdKey: string) => number | undefined;
  projectNameForCwd: (cwdKey: string) => string | undefined;
}

const rememberedProjectUiState: RememberedProjectUiState = {
  get expandedProjectCount() {
    return persistedExpandedProjectCwds.size;
  },
  get hasLegacyExpandedCwds() {
    return persistedExpandedProjectCwdsDefined;
  },
  isProjectExpanded: (cwdKey) => persistedExpandedProjectCwds.has(cwdKey),
  get projectOrderCount() {
    return persistedProjectOrderByCwd.size;
  },
  projectOrderIndexForCwd: (cwdKey) => persistedProjectOrderByCwd.get(cwdKey),
  projectNameForCwd: (cwdKey) => persistedProjectNamesByCwd.get(cwdKey),
};

export function projectCwdKey(cwd: string): string {
  return normalizeWorkspaceRootForComparison(cwd);
}

export function getRememberedProjectUiState(): RememberedProjectUiState {
  return rememberedProjectUiState;
}

export function rememberProjectState(
  projects: ReadonlyArray<Pick<Project, "cwd" | "expanded" | "localName">>,
): void {
  for (const project of projects) {
    const cwdKey = projectCwdKey(project.cwd);
    if (project.expanded) {
      persistedExpandedProjectCwds.add(cwdKey);
    } else {
      persistedExpandedProjectCwds.delete(cwdKey);
    }
    if (!persistedProjectOrderByCwd.has(cwdKey)) {
      persistedProjectOrderByCwd.set(cwdKey, persistedProjectOrderByCwd.size);
    }
    const localName = project.localName?.trim() ?? "";
    if (localName.length > 0) {
      persistedProjectNamesByCwd.set(cwdKey, localName);
    } else {
      persistedProjectNamesByCwd.delete(cwdKey);
    }
  }
}

export function forgetProjectState(cwd: string): void {
  const cwdKey = projectCwdKey(cwd);
  persistedExpandedProjectCwds.delete(cwdKey);
  persistedProjectOrderByCwd.delete(cwdKey);
  persistedProjectNamesByCwd.delete(cwdKey);
}

export function readPersistedState(initialState: AppState): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    // SAFETY: localStorage is only writable by same-origin scripts. We validate the
    // persisted shape below, discarding any malformed entries and falling back to defaults.
    const parsed = JSON.parse(raw) as {
      expandedProjectCwds?: string[];
      projectOrderCwds?: string[];
      projectNamesByCwd?: Record<string, string>;
    };
    persistedExpandedProjectCwds.clear();
    persistedProjectOrderByCwd.clear();
    persistedProjectNamesByCwd.clear();
    persistedExpandedProjectCwdsDefined =
      Array.isArray(parsed.expandedProjectCwds) && parsed.projectOrderCwds === undefined;
    for (const cwd of Array.isArray(parsed.expandedProjectCwds) ? parsed.expandedProjectCwds : []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(projectCwdKey(cwd));
      }
    }
    for (const cwd of Array.isArray(parsed.projectOrderCwds) ? parsed.projectOrderCwds : []) {
      const cwdKey = typeof cwd === "string" ? projectCwdKey(cwd) : "";
      if (cwdKey.length > 0 && !persistedProjectOrderByCwd.has(cwdKey)) {
        persistedProjectOrderByCwd.set(cwdKey, persistedProjectOrderByCwd.size);
      }
    }
    const projectNamesByCwd =
      typeof parsed.projectNamesByCwd === "object" &&
      parsed.projectNamesByCwd !== null &&
      !Array.isArray(parsed.projectNamesByCwd)
        ? parsed.projectNamesByCwd
        : {};
    for (const [cwd, name] of Object.entries(projectNamesByCwd)) {
      if (typeof cwd !== "string" || cwd.length === 0 || typeof name !== "string") continue;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) continue;
      persistedProjectNamesByCwd.set(projectCwdKey(cwd), trimmedName);
    }
    return { ...initialState };
  } catch {
    persistedExpandedProjectCwds.clear();
    persistedProjectOrderByCwd.clear();
    persistedProjectNamesByCwd.clear();
    persistedExpandedProjectCwdsDefined = false;
    return initialState;
  }
}

export function persistState(state: AppState): void {
  if (typeof window === "undefined" || !state.threadsHydrated) return;
  try {
    const projectNamesByCwd: Record<string, string> = {};
    for (const project of state.projects) {
      const localName = project.localName?.trim();
      if (localName && localName.length > 0) {
        projectNamesByCwd[projectCwdKey(project.cwd)] = localName;
      }
    }
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: state.projects
          .filter((project) => project.expanded)
          .map((project) => projectCwdKey(project.cwd)),
        projectOrderCwds: state.projects.map((project) => projectCwdKey(project.cwd)),
        projectNamesByCwd,
      }),
    );
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
