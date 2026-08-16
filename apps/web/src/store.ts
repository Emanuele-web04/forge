// FILE: store.ts
// Purpose: Public Zustand facade for normalized orchestration state and local UI actions.
// Exports: Stable store API plus pure transitions re-exported from focused modules.

import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type SpaceId,
  type ThreadId,
} from "@synara/contracts";
import { Debouncer } from "@tanstack/react-pacer";
import { resolveThreadBranchRegressionGuard } from "@synara/shared/git";
import { create } from "zustand";

import { resolveCreateBranchFlowCompletedMerge } from "./storeNormalization";
import {
  applySpaceOrder,
  applyShellEvent,
  applyThreadUpdate,
  clearThreadDetailSyncFailureInClientState,
  evictThreadDetailFromClientState,
  markThreadDetailSyncFailedInClientState,
  removeDeletedProjectFromClientState,
  removeDeletedThreadFromClientState,
  syncServerReadModel,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  syncServerThreadDetailHotPath,
} from "./storeProjection";
import { applyOrchestrationEvents, applyOrchestrationEventsHotPath } from "./storeEventReducer";
import {
  persistState,
  readPersistedState,
  rememberProjectLocalNames,
  rememberProjectUiState,
} from "./storePersistence";
import { initialState, type AppState } from "./storeState";
import type { Project, ThreadWorkspacePatch } from "./types";

type ReadModelThread = OrchestrationReadModel["threads"][number];

export type { AppState } from "./storeState";
export { EMPTY_THREAD_IDS } from "./storeState";
export {
  applySpaceOrder,
  applyShellEvent,
  clearThreadDetailSyncFailureInClientState,
  evictThreadDetailFromClientState,
  markThreadDetailSyncFailedInClientState,
  removeDeletedProjectFromClientState,
  removeDeletedThreadFromClientState,
  syncServerReadModel,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  syncServerThreadDetailHotPath,
} from "./storeProjection";
export { applyOrchestrationEvents, applyOrchestrationEventsHotPath } from "./storeEventReducer";

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

export function persistAppStateNow(state: AppState = useStore.getState()): void {
  persistState(state);
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  return applyThreadUpdate(state, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    return { ...thread, lastVisitedAt: at };
  });
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  return applyThreadUpdate(state, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    return { ...thread, lastVisitedAt: unreadVisitedAt };
  });
}

export function toggleProject(state: AppState, projectId: Project["id"]): AppState {
  return {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, expanded: !p.expanded } : p)),
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
): AppState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId || p.expanded === expanded) return p;
    changed = true;
    return { ...p, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function setAllProjectsExpanded(state: AppState, expanded: boolean): AppState {
  let changed = false;
  const projects = state.projects.map((project) => {
    if (project.expanded === expanded) return project;
    changed = true;
    return { ...project, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function collapseProjectsExcept(
  state: AppState,
  activeProjectId: Project["id"] | null,
): AppState {
  let changed = false;
  const projects = state.projects.map((project) => {
    const nextExpanded = activeProjectId !== null && project.id === activeProjectId;
    if (project.expanded === nextExpanded) return project;
    changed = true;
    return { ...project, expanded: nextExpanded };
  });
  return changed ? { ...state, projects } : state;
}

export function reorderProjects(
  state: AppState,
  draggedProjectId: Project["id"],
  targetProjectId: Project["id"],
): AppState {
  if (draggedProjectId === targetProjectId) return state;
  const draggedIndex = state.projects.findIndex((project) => project.id === draggedProjectId);
  const targetIndex = state.projects.findIndex((project) => project.id === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) return state;
  const projects = [...state.projects];
  const [draggedProject] = projects.splice(draggedIndex, 1);
  if (!draggedProject) return state;
  projects.splice(targetIndex, 0, draggedProject);
  return { ...state, projects };
}

export function renameProjectLocally(
  state: AppState,
  projectId: Project["id"],
  name: string | null,
): AppState {
  const normalizedName = name?.trim() ?? null;
  let changed = false;
  const projects = state.projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const nextLocalName = normalizedName && normalizedName.length > 0 ? normalizedName : null;
    const nextName = nextLocalName ?? project.remoteName;
    if (project.localName === nextLocalName && project.name === nextName) {
      return project;
    }
    changed = true;
    return {
      ...project,
      name: nextName,
      localName: nextLocalName,
    };
  });
  return changed ? { ...state, projects } : state;
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  return applyThreadUpdate(state, threadId, (thread) => {
    if (thread.error === error) return thread;
    return { ...thread, error };
  });
}

export function setThreadWorkspace(
  state: AppState,
  threadId: ThreadId,
  patch: ThreadWorkspacePatch,
): AppState {
  return applyThreadUpdate(state, threadId, (t) => {
    const nextEnvMode = patch.envMode !== undefined ? patch.envMode : t.envMode;
    const nextBranch = resolveThreadBranchRegressionGuard({
      currentBranch: t.branch,
      nextBranch: patch.branch !== undefined ? patch.branch : t.branch,
    });
    const nextWorktreePath = patch.worktreePath !== undefined ? patch.worktreePath : t.worktreePath;
    const nextWorkingDirectory =
      patch.workingDirectory !== undefined ? patch.workingDirectory : (t.workingDirectory ?? null);
    const nextAssociatedWorktreePath =
      patch.associatedWorktreePath !== undefined
        ? patch.associatedWorktreePath
        : (t.associatedWorktreePath ?? null);
    const nextAssociatedWorktreeBranch =
      patch.associatedWorktreeBranch !== undefined
        ? patch.associatedWorktreeBranch
        : (t.associatedWorktreeBranch ?? null);
    const nextAssociatedWorktreeRef =
      patch.associatedWorktreeRef !== undefined
        ? patch.associatedWorktreeRef
        : (t.associatedWorktreeRef ?? null);
    const nextCreateBranchFlowCompleted = resolveCreateBranchFlowCompletedMerge({
      currentBranch: t.branch,
      nextBranch,
      currentWorktreePath: t.worktreePath,
      nextWorktreePath,
      currentAssociatedWorktreePath: t.associatedWorktreePath,
      nextAssociatedWorktreePath,
      currentAssociatedWorktreeBranch: t.associatedWorktreeBranch,
      nextAssociatedWorktreeBranch,
      currentAssociatedWorktreeRef: t.associatedWorktreeRef,
      nextAssociatedWorktreeRef,
      currentCreateBranchFlowCompleted: t.createBranchFlowCompleted,
      nextCreateBranchFlowCompleted: patch.createBranchFlowCompleted,
    });
    if (
      t.envMode === nextEnvMode &&
      t.branch === nextBranch &&
      t.worktreePath === nextWorktreePath &&
      (t.workingDirectory ?? null) === nextWorkingDirectory &&
      (t.associatedWorktreePath ?? null) === nextAssociatedWorktreePath &&
      (t.associatedWorktreeBranch ?? null) === nextAssociatedWorktreeBranch &&
      (t.associatedWorktreeRef ?? null) === nextAssociatedWorktreeRef &&
      (t.createBranchFlowCompleted ?? false) === nextCreateBranchFlowCompleted
    ) {
      return t;
    }
    const cwdChanged =
      t.worktreePath !== nextWorktreePath || (t.workingDirectory ?? null) !== nextWorkingDirectory;
    return {
      ...t,
      envMode: nextEnvMode,
      branch: nextBranch,
      worktreePath: nextWorktreePath,
      workingDirectory: nextWorkingDirectory,
      associatedWorktreePath: nextAssociatedWorktreePath,
      associatedWorktreeBranch: nextAssociatedWorktreeBranch,
      associatedWorktreeRef: nextAssociatedWorktreeRef,
      createBranchFlowCompleted: nextCreateBranchFlowCompleted,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
  syncServerThreadDetail: (thread: ReadModelThread) => void;
  syncServerThreadDetailHotPath: (thread: ReadModelThread) => void;
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyShellEvent: (event: OrchestrationShellStreamEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  applyOrchestrationEventsHotPath: (events: ReadonlyArray<OrchestrationEvent>) => void;
  evictThreadDetail: (threadId: ThreadId) => void;
  evictThreadDetails: (threadIds: readonly ThreadId[]) => void;
  markThreadDetailSyncFailed: (threadId: ThreadId) => void;
  clearThreadDetailSyncFailure: (threadId: ThreadId) => void;
  removeDeletedProjectFromClientState: (projectId: Project["id"]) => void;
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  setAllProjectsExpanded: (expanded: boolean) => void;
  collapseProjectsExcept: (activeProjectId: Project["id"] | null) => void;
  reorderProjects: (draggedProjectId: Project["id"], targetProjectId: Project["id"]) => void;
  reorderSpacesLocally: (orderedSpaceIds: ReadonlyArray<SpaceId>) => void;
  renameProjectLocally: (projectId: Project["id"], name: string | null) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadWorkspace: (threadId: ThreadId, patch: ThreadWorkspacePatch) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(initialState),
  syncServerShellSnapshot: (snapshot) => set((state) => syncServerShellSnapshot(state, snapshot)),
  syncServerThreadDetail: (thread) => set((state) => syncServerThreadDetail(state, thread)),
  syncServerThreadDetailHotPath: (thread) =>
    set((state) => syncServerThreadDetailHotPath(state, thread)),
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyShellEvent: (event) => set((state) => applyShellEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  applyOrchestrationEventsHotPath: (events) =>
    set((state) =>
      applyOrchestrationEventsHotPath(state, events, {
        updateSidebarSummary: false,
      }),
    ),
  evictThreadDetail: (threadId) =>
    set((state) => evictThreadDetailFromClientState(state, threadId)),
  // Dropping a batch of leases evicts several threads at once. Every store update
  // re-runs the retention reconcile, so folding them into one write keeps that at
  // a single pass instead of one per thread.
  evictThreadDetails: (threadIds) =>
    set((state) => {
      let nextState: AppState = state;
      for (const threadId of threadIds) {
        nextState = evictThreadDetailFromClientState(nextState, threadId);
      }
      return nextState;
    }),
  markThreadDetailSyncFailed: (threadId) =>
    set((state) => markThreadDetailSyncFailedInClientState(state, threadId)),
  clearThreadDetailSyncFailure: (threadId) =>
    set((state) => clearThreadDetailSyncFailureInClientState(state, threadId)),
  removeDeletedProjectFromClientState: (projectId) =>
    set((state) => removeDeletedProjectFromClientState(state, projectId)),
  removeDeletedThreadFromClientState: (threadId) =>
    set((state) => removeDeletedThreadFromClientState(state, threadId)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) => set((state) => markThreadUnread(state, threadId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  setAllProjectsExpanded: (expanded) => set((state) => setAllProjectsExpanded(state, expanded)),
  collapseProjectsExcept: (activeProjectId) =>
    set((state) => collapseProjectsExcept(state, activeProjectId)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
  reorderSpacesLocally: (orderedSpaceIds) =>
    set((state) => applySpaceOrder(state, orderedSpaceIds)),
  renameProjectLocally: (projectId, name) => {
    set((state) => renameProjectLocally(state, projectId, name));
    persistAppStateNow();
  },
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadWorkspace: (threadId, patch) =>
    set((state) => setThreadWorkspace(state, threadId, patch)),
}));

// Persist state changes with debouncing to avoid localStorage thrashing.
// Project snapshots only depend on `state.projects` (immutable — every project mutation
// produces a new array), so skip them on the streaming hot path where only thread slices move.
let lastRememberedProjects: readonly Project[] | undefined;
useStore.subscribe((state) => {
  if (state.projects !== lastRememberedProjects) {
    lastRememberedProjects = state.projects;
    rememberProjectUiState(state.projects);
    rememberProjectLocalNames(state.projects);
  }
  debouncedPersistState.maybeExecute(state);
});

// Flush pending writes synchronously before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    persistAppStateNow();
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistAppStateNow();
  }, []);
  return createElement(Fragment, null, children);
}
