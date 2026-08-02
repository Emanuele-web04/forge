// FILE: storePersistence.test.ts
// Purpose: Pins persisted project preferences to the LOCAL environment only.
// Layer: Web store unit tests
// Depends on: storePersistence I/O and Vitest assertions.

import { EnvironmentId, ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { withAggregatedView } from "./storeAggregation";
import { initialEnvironmentState, type AppState, type EnvironmentState } from "./storeState";
import { makeProject } from "./storeTestFixtures";

const REMOTE = EnvironmentId.makeUnsafe("environment-remote");
const SHARED_CWD = "/tmp/shared-checkout";
const PERSISTED_STATE_KEY = "synara:renderer-state:v8";

function environment(overrides: Partial<EnvironmentState>): EnvironmentState {
  return { ...initialEnvironmentState, ...overrides };
}

function storeWith(records: Record<string, EnvironmentState>): AppState {
  return withAggregatedView({ environmentById: records } as AppState);
}

/**
 * Two servers pointing at the SAME checkout path. This is the whole failure
 * mode: the persisted maps are keyed by normalized cwd alone, so both rows
 * compete for one entry. Their ids differ, which is why the aggregate — which
 * de-duplicates by `project.id` — keeps both and hands both to persistence.
 */
function storeWithSharedCwdAcrossEnvironments(input: {
  readonly localExpanded: boolean;
  readonly remoteExpanded: boolean;
  readonly localName?: string | null;
  readonly remoteLocalName?: string | null;
}): AppState {
  return storeWith({
    [LOCAL_ENVIRONMENT_ID]: environment({
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-local"),
          cwd: SHARED_CWD,
          expanded: input.localExpanded,
          localName: input.localName ?? null,
        }),
      ],
    }),
    [REMOTE]: environment({
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-remote"),
          cwd: SHARED_CWD,
          expanded: input.remoteExpanded,
          localName: input.remoteLocalName ?? null,
        }),
      ],
    }),
  });
}

function withFakeWindow<T>(run: (storage: Map<string, string>) => T): T {
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    },
    addEventListener: vi.fn(),
  });
  return run(storage);
}

function readPersisted(storage: Map<string, string>): {
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  projectNamesByCwd?: Record<string, string>;
} {
  return JSON.parse(storage.get(PERSISTED_STATE_KEY) ?? "{}");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("selectPersistableProjects", () => {
  it("returns the local environment's projects and excludes every remote one", async () => {
    const { selectPersistableProjects } = await import("./storePersistence");
    const state = storeWithSharedCwdAcrossEnvironments({
      localExpanded: true,
      remoteExpanded: false,
    });

    // The aggregate holds BOTH copies — that is what makes the cwd-keyed maps
    // collide. If this stops being true the bug is unreachable and these tests
    // would pass for the wrong reason.
    expect(state.projects).toHaveLength(2);
    expect(selectPersistableProjects(state).map((project) => project.id)).toEqual([
      "project-local",
    ]);
  });

  it("returns an empty list when the local environment has not connected", async () => {
    const { selectPersistableProjects } = await import("./storePersistence");
    const state = storeWith({
      [REMOTE]: environment({
        projects: [makeProject({ id: ProjectId.makeUnsafe("project-remote"), cwd: SHARED_CWD })],
      }),
    });

    expect(state.projects).toHaveLength(1);
    expect(selectPersistableProjects(state)).toEqual([]);
  });
});

describe("persistState environment scoping", () => {
  it("keeps a locally expanded project expanded when a remote copy is collapsed", async () => {
    await withFakeWindow(async (storage) => {
      const { persistState } = await import("./storePersistence");

      persistState(
        storeWithSharedCwdAcrossEnvironments({ localExpanded: true, remoteExpanded: false }),
      );

      // The reported failure: the remote's collapsed copy overwrote the local
      // one, so the project reopened collapsed after reload.
      expect(readPersisted(storage).expandedProjectCwds).toEqual([SHARED_CWD]);
    });
  });

  it("does not record a remote project as expanded when the local copy is collapsed", async () => {
    await withFakeWindow(async (storage) => {
      const { persistState } = await import("./storePersistence");

      persistState(
        storeWithSharedCwdAcrossEnvironments({ localExpanded: false, remoteExpanded: true }),
      );

      expect(readPersisted(storage).expandedProjectCwds).toEqual([]);
    });
  });

  it("persists one cwd entry per local project, never the remote duplicate", async () => {
    await withFakeWindow(async (storage) => {
      const { persistState } = await import("./storePersistence");

      persistState(
        storeWithSharedCwdAcrossEnvironments({ localExpanded: true, remoteExpanded: true }),
      );

      expect(readPersisted(storage).projectOrderCwds).toEqual([SHARED_CWD]);
    });
  });

  it("keeps the local alias when a remote copy of the same cwd has none", async () => {
    await withFakeWindow(async (storage) => {
      const { persistState } = await import("./storePersistence");

      persistState(
        storeWithSharedCwdAcrossEnvironments({
          localExpanded: true,
          remoteExpanded: true,
          localName: "my-checkout",
          remoteLocalName: null,
        }),
      );

      // rememberProjectLocalNames DELETES on an empty name, so an unaliased
      // remote copy erased the local alias outright.
      expect(readPersisted(storage).projectNamesByCwd).toEqual({ [SHARED_CWD]: "my-checkout" });
    });
  });

  /**
   * The CALL SITE, not the persist function. `syncServerShellSnapshotInEnvironment`
   * runs for EVERY environment and recorded `state.projects` into the cwd-keyed
   * caches directly, without going through `persistState`.
   *
   * The alias map is what makes that durable. `expandedProjectCwds` and
   * `projectOrderCwds` are rebuilt from the local project list on every
   * `persistState`, so a polluted expansion entry is overwritten moments later
   * — but `projectNamesByCwd` is serialized WHOLESALE from the accumulated map,
   * so an alias belonging to a remote-only project is written to this browser's
   * storage and survives reload. Scoping `persistState` alone does not close
   * this path; only the guard at the call site does.
   */
  it("ignores a remote environment's shell snapshot when remembering project aliases", async () => {
    await withFakeWindow(async (storage) => {
      const { persistState } = await import("./storePersistence");
      const { syncServerShellSnapshot } = await import("./storeProjection");
      const { makeShellSnapshot, makeThread } = await import("./storeTestFixtures");

      // The remote slice must ALREADY hold the project: `rememberProjectLocalNames`
      // runs against the environment's state as it was BEFORE the snapshot is
      // merged, so an empty remote environment has nothing to leak.
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({
          projects: [
            makeProject({ id: ProjectId.makeUnsafe("project-local"), cwd: "/tmp/local-only" }),
          ],
        }),
        [REMOTE]: environment({
          projects: [
            makeProject({
              id: ProjectId.makeUnsafe("project-remote"),
              cwd: "/tmp/remote-only",
              localName: "remote-alias",
            }),
          ],
        }),
      });

      const afterRemoteSnapshot = syncServerShellSnapshot(
        state,
        makeShellSnapshot({
          ...makeThread({ id: ThreadId.makeUnsafe("thread-remote") }),
          projectId: ProjectId.makeUnsafe("project-1"),
        } as never),
        REMOTE,
      );

      persistState(afterRemoteSnapshot);

      expect(readPersisted(storage).projectNamesByCwd ?? {}).not.toHaveProperty("/tmp/remote-only");
    });
  });

  /**
   * The OTHER call site: the store's own subscription, which records project ui
   * state on every store write before the debounced `persistState` ever runs.
   * It read the merged `state.projects` too, so a remote-only project's alias
   * entered the wholesale-serialized alias map from here as well — independently
   * of both `persistState` and the projection guard.
   */
  it("does not record a remote project's alias through the store subscription", async () => {
    await withFakeWindow(async (storage) => {
      const freshStore = await import("./store");
      const { persistState } = await import("./storePersistence");

      freshStore.useStore.setState(
        storeWith({
          [LOCAL_ENVIRONMENT_ID]: environment({
            projects: [
              makeProject({ id: ProjectId.makeUnsafe("project-local"), cwd: "/tmp/local-only" }),
            ],
          }),
          [REMOTE]: environment({
            projects: [
              makeProject({
                id: ProjectId.makeUnsafe("project-remote"),
                cwd: "/tmp/remote-only",
                localName: "remote-alias",
              }),
            ],
          }),
        }),
      );

      persistState(freshStore.useStore.getState());

      expect(readPersisted(storage).projectNamesByCwd ?? {}).not.toHaveProperty("/tmp/remote-only");
    });
  });

  it("never persists a remote-only project", async () => {
    await withFakeWindow(async (storage) => {
      const { persistState } = await import("./storePersistence");

      persistState(
        storeWith({
          [LOCAL_ENVIRONMENT_ID]: environment({
            projects: [
              makeProject({ id: ProjectId.makeUnsafe("project-local"), cwd: "/tmp/local-only" }),
            ],
          }),
          [REMOTE]: environment({
            projects: [
              makeProject({ id: ProjectId.makeUnsafe("project-remote"), cwd: "/tmp/remote-only" }),
            ],
          }),
        }),
      );

      expect(readPersisted(storage).projectOrderCwds).toEqual(["/tmp/local-only"]);
    });
  });
});
