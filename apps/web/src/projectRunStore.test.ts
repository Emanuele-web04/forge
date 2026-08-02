// FILE: projectRunStore.test.ts
// Purpose: Proves one environment's dev-server snapshot cannot delete another
//          environment's tracked runs.
// Layer: Web UI state tests

import { EnvironmentId, type ProjectDevServer, type ProjectId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { applyProjectDevServerEvent, useProjectRunStore } from "./projectRunStore";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");
const LOCAL_PROJECT = "project-local" as ProjectId;
const REMOTE_PROJECT = "project-remote" as ProjectId;

function run(projectId: ProjectId): ProjectDevServer {
  return { projectId, status: "running" } as unknown as ProjectDevServer;
}

/** Positional ownership, stated the way the real store answers it. */
const ownerOf = (projectId: ProjectId): EnvironmentId =>
  projectId === REMOTE_PROJECT ? REMOTE_ENVIRONMENT_ID : LOCAL_ENVIRONMENT_ID;

describe("projectRunStore", () => {
  beforeEach(() => {
    useProjectRunStore.setState({ runsByProjectId: {} });
  });

  it("keeps another environment's runs when one environment snapshots", () => {
    // The bug: the local server's snapshot arrives on connect and after every
    // dev-server lifecycle event, and replacing the whole map deleted every
    // remote run. The remote dev server vanished from the sidebar while its
    // process kept running — and could no longer be stopped, because the row it
    // would have been stopped from was gone.
    const store = useProjectRunStore.getState();
    store.upsertRun(run(REMOTE_PROJECT));

    useProjectRunStore.getState().replaceAll([run(LOCAL_PROJECT)], LOCAL_ENVIRONMENT_ID, ownerOf);

    const runs = useProjectRunStore.getState().runsByProjectId;
    expect(runs[REMOTE_PROJECT]).toBeDefined();
    expect(runs[LOCAL_PROJECT]).toBeDefined();
  });

  it("still replaces the snapshotting environment's own runs", () => {
    // The other half: a snapshot IS authoritative for its own server, so a run
    // it no longer reports has genuinely stopped and must disappear.
    const store = useProjectRunStore.getState();
    store.upsertRun(run("project-local-stale" as ProjectId));

    useProjectRunStore.getState().replaceAll([run(LOCAL_PROJECT)], LOCAL_ENVIRONMENT_ID, ownerOf);

    const runs = useProjectRunStore.getState().runsByProjectId;
    expect(runs["project-local-stale" as ProjectId]).toBeUndefined();
    expect(runs[LOCAL_PROJECT]).toBeDefined();
  });

  it("lets a remote snapshot clear only remote runs", () => {
    const store = useProjectRunStore.getState();
    store.upsertRun(run(LOCAL_PROJECT));
    store.upsertRun(run(REMOTE_PROJECT));

    useProjectRunStore.getState().replaceAll([], REMOTE_ENVIRONMENT_ID, ownerOf);

    const runs = useProjectRunStore.getState().runsByProjectId;
    expect(runs[LOCAL_PROJECT]).toBeDefined();
    expect(runs[REMOTE_PROJECT]).toBeUndefined();
  });

  it("attributes a snapshot event to the environment whose stream delivered it", () => {
    // Pins the CALL SITE's decision, not just the store's scoping. The store
    // was already pinned while this was not, and a caller passing the wrong
    // environment reintroduces the whole bug with every store test still green.
    const replaceAll = vi.fn();
    applyProjectDevServerEvent({
      event: { type: "snapshot", servers: [run(REMOTE_PROJECT)] } as never,
      environmentId: REMOTE_ENVIRONMENT_ID,
      ownerOf,
      store: { replaceAll, upsertRun: vi.fn(), removeRun: vi.fn() },
    });

    expect(replaceAll).toHaveBeenCalledWith([run(REMOTE_PROJECT)], REMOTE_ENVIRONMENT_ID, ownerOf);
  });

  it("passes upsert and remove through untouched", () => {
    const upsertRun = vi.fn();
    const removeRun = vi.fn();
    const store = { replaceAll: vi.fn(), upsertRun, removeRun };

    applyProjectDevServerEvent({
      event: { type: "upserted", server: run(LOCAL_PROJECT) } as never,
      environmentId: LOCAL_ENVIRONMENT_ID,
      ownerOf,
      store,
    });
    applyProjectDevServerEvent({
      event: { type: "removed", projectId: LOCAL_PROJECT } as never,
      environmentId: LOCAL_ENVIRONMENT_ID,
      ownerOf,
      store,
    });

    expect(upsertRun).toHaveBeenCalledWith(run(LOCAL_PROJECT));
    expect(removeRun).toHaveBeenCalledWith(LOCAL_PROJECT);
  });

  it("is unchanged for a single-environment install", () => {
    // Everything resolves local, so a snapshot replaces everything exactly as
    // it always did — no migration, no behaviour change.
    const store = useProjectRunStore.getState();
    store.upsertRun(run("project-a" as ProjectId));
    store.upsertRun(run("project-b" as ProjectId));

    useProjectRunStore
      .getState()
      .replaceAll(
        [run("project-a" as ProjectId)],
        LOCAL_ENVIRONMENT_ID,
        () => LOCAL_ENVIRONMENT_ID,
      );

    const runs = useProjectRunStore.getState().runsByProjectId;
    expect(Object.keys(runs)).toEqual(["project-a"]);
  });
});
