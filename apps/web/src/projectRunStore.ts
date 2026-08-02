// FILE: projectRunStore.ts
// Purpose: Client-side projection of the server-owned dev-server registry, keyed by project id.
// Layer: Web UI state
// Exports: useProjectRunStore plus helpers for syncing dev-server lifecycle events.

import type {
  EnvironmentId,
  ProjectDevServer,
  ProjectDevServerEvent,
  ProjectId,
} from "@synara/contracts";

/**
 * A tracked dev server as projected from the server. This mirrors the
 * `ProjectDevServer` contract exactly — the client no longer owns thread or
 * terminal identifiers, because dev servers are first-class server processes.
 */
export type ProjectRunState = ProjectDevServer;

interface ProjectRunStoreState {
  runsByProjectId: Record<ProjectId, ProjectRunState>;
  /**
   * Replace ONE environment's runs from its authoritative snapshot.
   *
   * Scoped because a snapshot is only authoritative about the server that sent
   * it. Replacing the whole map meant the LOCAL server's snapshot — which
   * arrives on connect and after every dev-server lifecycle event — deleted
   * every remote environment's runs: a remote dev server vanished from the
   * sidebar while its process kept running, and could no longer be stopped
   * from the UI because the row it was stopped from was gone.
   *
   * Ownership is resolved through `ownerOf` rather than stored on the run, so
   * this stays positional and no new side table appears.
   */
  replaceAll: (
    servers: ReadonlyArray<ProjectDevServer>,
    environmentId: EnvironmentId,
    ownerOf: (projectId: ProjectId) => EnvironmentId,
  ) => void;
  /** Insert or update a single tracked dev server. */
  upsertRun: (server: ProjectDevServer) => void;
  /** Drop a tracked dev server by project id. */
  removeRun: (projectId: ProjectId) => void;
}

import { create } from "zustand";

function indexByProjectId(
  servers: ReadonlyArray<ProjectDevServer>,
): Record<ProjectId, ProjectRunState> {
  const next: Record<ProjectId, ProjectRunState> = {};
  for (const server of servers) {
    next[server.projectId] = server;
  }
  return next;
}

export const useProjectRunStore = create<ProjectRunStoreState>((set) => ({
  runsByProjectId: {},
  replaceAll: (servers, environmentId, ownerOf) =>
    set((state) => {
      // Keep every run this snapshot does not speak for: another environment's
      // runs are not absent, they are simply not this server's to report.
      const retained: Record<ProjectId, ProjectRunState> = {};
      for (const [projectId, run] of Object.entries(state.runsByProjectId) as Array<
        [ProjectId, ProjectRunState]
      >) {
        if (ownerOf(projectId) !== environmentId) retained[projectId] = run;
      }
      return { runsByProjectId: { ...retained, ...indexByProjectId(servers) } };
    }),
  upsertRun: (server) =>
    set((state) => ({
      runsByProjectId: {
        ...state.runsByProjectId,
        [server.projectId]: server,
      },
    })),
  removeRun: (projectId) =>
    set((state) => {
      if (!state.runsByProjectId[projectId]) {
        return state;
      }
      const nextRunsByProjectId = { ...state.runsByProjectId };
      delete nextRunsByProjectId[projectId];
      return { runsByProjectId: nextRunsByProjectId };
    }),
}));

/**
 * Applies one environment's dev-server event to the store.
 *
 * Extracted from the root effect so the ENVIRONMENT ATTRIBUTION is testable.
 * The store's scoping was pinned while this decision — which environment a
 * given stream speaks for — was not, and a call site passing the wrong
 * environment reintroduces the whole bug while every store test still passes.
 */
export function applyProjectDevServerEvent(input: {
  readonly event: ProjectDevServerEvent;
  /** The environment whose stream delivered this event. */
  readonly environmentId: EnvironmentId;
  readonly ownerOf: (projectId: ProjectId) => EnvironmentId;
  readonly store: Pick<ProjectRunStoreState, "replaceAll" | "upsertRun" | "removeRun">;
}): void {
  const { event, environmentId, ownerOf, store } = input;
  if (event.type === "snapshot") {
    store.replaceAll(event.servers, environmentId, ownerOf);
    return;
  }
  if (event.type === "upserted") {
    store.upsertRun(event.server);
    return;
  }
  store.removeRun(event.projectId);
}
