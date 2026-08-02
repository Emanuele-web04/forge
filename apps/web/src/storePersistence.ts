// FILE: storePersistence.ts
// Purpose: Persists project-only renderer preferences without depending on the Zustand facade.
// Exports: Persistence I/O plus read-only remembered project UI state.

import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import type { AppState } from "./storeState";
import type { Project } from "./types";

const PERSISTED_STATE_KEY = "synara:renderer-state:v8";
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const persistedProjectOrderByCwd = new Map<string, number>();
const persistedProjectNamesByCwd = new Map<string, string>();

export interface RememberedProjectUiState {
  expandedProjectCount: number;
  isProjectExpanded: (cwdKey: string) => boolean;
  projectOrderCount: number;
  projectOrderIndexForCwd: (cwdKey: string) => number | undefined;
  projectNameForCwd: (cwdKey: string) => string | undefined;
}

const rememberedProjectUiState: RememberedProjectUiState = {
  get expandedProjectCount() {
    return persistedExpandedProjectCwds.size;
  },
  isProjectExpanded: (cwdKey) => persistedExpandedProjectCwds.has(cwdKey),
  get projectOrderCount() {
    return persistedProjectOrderCwds.length;
  },
  projectOrderIndexForCwd: (cwdKey) => persistedProjectOrderByCwd.get(cwdKey),
  projectNameForCwd: (cwdKey) => persistedProjectNamesByCwd.get(cwdKey),
};

export function projectCwdKey(cwd: string): string {
  return normalizeWorkspaceRootForComparison(cwd);
}

/**
 * The LOCAL environment's projects — the only ones whose UI preferences this
 * module may record.
 *
 * These maps are keyed by normalized cwd ALONE, while `AppState.projects` is
 * the aggregate concatenated across every registered environment. Two servers
 * can legitimately point at the same checkout path, so two Project rows sharing
 * a cwd both land on one cwd-keyed entry and the later one wins: a remote copy
 * that happens to be collapsed deletes the local copy's expansion, and the
 * project reopens collapsed after reload. The aggregate de-duplicates by
 * `project.id`, not by cwd, so both copies genuinely arrive here.
 *
 * Scoping to local rather than widening the keys is deliberate. These are local
 * renderer preferences about how THIS browser draws its sidebar; a remote
 * server's collapse state is not the user's preference for it. It also leaves
 * the persisted schema — and the v8 storage key — untouched, so no migration.
 *
 * A remote project still renders sensibly: `normalizeProject` defaults it to
 * expanded and uses its server-provided title.
 */
export function selectPersistableProjects(state: AppState): ReadonlyArray<Project> {
  return state.environmentById[LOCAL_ENVIRONMENT_ID]?.projects ?? EMPTY_PERSISTABLE_PROJECTS;
}

const EMPTY_PERSISTABLE_PROJECTS: ReadonlyArray<Project> = [];

export function getRememberedProjectUiState(): RememberedProjectUiState {
  return rememberedProjectUiState;
}

export function rememberProjectUiState(
  projects: ReadonlyArray<Pick<Project, "cwd" | "expanded">>,
): void {
  for (const project of projects) {
    const cwdKey = projectCwdKey(project.cwd);
    if (project.expanded) {
      persistedExpandedProjectCwds.add(cwdKey);
    } else {
      persistedExpandedProjectCwds.delete(cwdKey);
    }
    if (!persistedProjectOrderByCwd.has(cwdKey)) {
      persistedProjectOrderByCwd.set(cwdKey, persistedProjectOrderCwds.length);
      persistedProjectOrderCwds.push(cwdKey);
    }
  }
}

export function rememberProjectLocalNames(
  projects: ReadonlyArray<Pick<Project, "cwd" | "localName">>,
): void {
  for (const project of projects) {
    const cwdKey = projectCwdKey(project.cwd);
    const localName = project.localName?.trim() ?? "";
    if (localName.length > 0) {
      persistedProjectNamesByCwd.set(cwdKey, localName);
    } else {
      persistedProjectNamesByCwd.delete(cwdKey);
    }
  }
}

export function readPersistedState(initialState: AppState): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      expandedProjectCwds?: string[];
      projectOrderCwds?: string[];
      projectNamesByCwd?: Record<string, string>;
    };
    persistedExpandedProjectCwds.clear();
    persistedProjectOrderCwds.length = 0;
    persistedProjectOrderByCwd.clear();
    persistedProjectNamesByCwd.clear();
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(projectCwdKey(cwd));
      }
    }
    for (const cwd of parsed.projectOrderCwds ?? []) {
      const cwdKey = typeof cwd === "string" ? projectCwdKey(cwd) : "";
      if (cwdKey.length > 0 && !persistedProjectOrderByCwd.has(cwdKey)) {
        persistedProjectOrderByCwd.set(cwdKey, persistedProjectOrderCwds.length);
        persistedProjectOrderCwds.push(cwdKey);
      }
    }
    for (const [cwd, name] of Object.entries(parsed.projectNamesByCwd ?? {})) {
      if (typeof cwd !== "string" || cwd.length === 0 || typeof name !== "string") continue;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) continue;
      persistedProjectNamesByCwd.set(projectCwdKey(cwd), trimmedName);
    }
    return { ...initialState };
  } catch {
    return initialState;
  }
}

export function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    // Local only, never the cross-environment aggregate: see
    // `selectPersistableProjects`.
    const projects = selectPersistableProjects(state);
    rememberProjectUiState(projects);
    rememberProjectLocalNames(projects);
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: projects
          .filter((project) => project.expanded)
          .map((project) => project.cwd),
        projectOrderCwds: projects.map((project) => project.cwd),
        projectNamesByCwd: Object.fromEntries(persistedProjectNamesByCwd),
      }),
    );
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
