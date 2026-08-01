// FILE: storeAggregation.test.ts
// Purpose: Pins the environment-keyed store's routing and cross-environment merge rules.
// Layer: Web store unit tests
// Depends on: storeAggregation selectors and Vitest assertions.

import { describe, expect, it } from "vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import {
  environmentIdForProject,
  environmentIdForThread,
  selectEnvironment,
  selectLocalEnvironment,
  selectLocalThreadsHydrated,
  updateEnvironment,
  withAggregatedView,
  withEnvironment,
  withoutEnvironment,
} from "./storeAggregation";
import { initialEnvironmentState, type AppState, type EnvironmentState } from "./storeState";
import { makeProject, makeStoreState } from "./storeTestFixtures";
import type { ThreadShell } from "./types";

const REMOTE = EnvironmentId.makeUnsafe("environment-remote");
const OTHER_REMOTE = EnvironmentId.makeUnsafe("environment-other");
const LOCAL_THREAD = ThreadId.makeUnsafe("thread-local");
const REMOTE_THREAD = ThreadId.makeUnsafe("thread-remote");

function shell(id: ThreadId): ThreadShell {
  return { id, title: `Thread ${id}` } as ThreadShell;
}

function environment(overrides: Partial<EnvironmentState>): EnvironmentState {
  return { ...initialEnvironmentState, ...overrides };
}

function storeWith(records: Record<string, EnvironmentState>): AppState {
  return withAggregatedView({ environmentById: records } as AppState);
}

describe("storeAggregation", () => {
  describe("environment access", () => {
    it("returns a stable empty slice for an environment that has not connected", () => {
      // "Not connected yet" must read as an empty environment rather than
      // undefined, so no caller has to re-derive the "absent means local"
      // defaulting that the deleted ownership side tables spread everywhere.
      const state = makeStoreState();

      expect(selectEnvironment(state, REMOTE)).toBe(initialEnvironmentState);
      expect(selectEnvironment(state, REMOTE).threadsHydrated).toBe(false);
    });

    it("defaults to the local environment", () => {
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({ threadsHydrated: true }),
        [REMOTE]: environment({ threadIds: [REMOTE_THREAD] }),
      });

      expect(selectEnvironment(state)).toBe(selectLocalEnvironment(state));
      expect(selectEnvironment(state).threadsHydrated).toBe(true);
    });

    it("writes reach exactly one environment record", () => {
      // The core structural claim: a transition routed to one environment
      // cannot touch another's rows, because it never receives them.
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({ threadIds: [LOCAL_THREAD] }),
        [REMOTE]: environment({ threadIds: [REMOTE_THREAD] }),
      });

      const next = updateEnvironment(state, REMOTE, (record) => ({ ...record, threadIds: [] }));

      expect(selectEnvironment(next, REMOTE).threadIds).toEqual([]);
      expect(selectLocalEnvironment(next).threadIds).toEqual([LOCAL_THREAD]);
      // Untouched records keep their identity, so selectors memoizing on them
      // do not recompute because a different server changed.
      expect(next.environmentById[LOCAL_ENVIRONMENT_ID]).toBe(
        state.environmentById[LOCAL_ENVIRONMENT_ID],
      );
    });

    it("returns the same state when a write changes nothing", () => {
      const state = storeWith({ [LOCAL_ENVIRONMENT_ID]: environment({}) });

      expect(withEnvironment(state, LOCAL_ENVIRONMENT_ID, selectLocalEnvironment(state))).toBe(
        state,
      );
    });

    it("drops an environment and everything it owned in one step", () => {
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({
          threadIds: [LOCAL_THREAD],
          shellSnapshotSequence: 42,
        }),
        [REMOTE]: environment({
          threadIds: [REMOTE_THREAD],
          threadShellById: { [REMOTE_THREAD]: shell(REMOTE_THREAD) },
          shellSnapshotSequence: 500,
        }),
      });

      const next = withoutEnvironment(state, REMOTE);

      // Teardown cannot leak rows: there is no per-collection retain to forget,
      // only the record itself.
      expect(next.environmentById[REMOTE]).toBeUndefined();
      expect(next.threadIds).toEqual([LOCAL_THREAD]);
      expect(next.threadShellById?.[REMOTE_THREAD]).toBeUndefined();
      // And the surviving environment's fence is untouched.
      expect(selectLocalEnvironment(next).shellSnapshotSequence).toBe(42);
    });
  });

  describe("cross-environment merge", () => {
    it("concatenates lists local-first and deterministically", () => {
      // Order must not depend on Record enumeration, or every aggregate would
      // churn its array identity and re-render the sidebar for nothing.
      const state = storeWith({
        [OTHER_REMOTE]: environment({ threadIds: [ThreadId.makeUnsafe("thread-other")] }),
        [REMOTE]: environment({ threadIds: [REMOTE_THREAD] }),
        [LOCAL_ENVIRONMENT_ID]: environment({ threadIds: [LOCAL_THREAD] }),
      });

      expect(state.threadIds).toEqual([
        LOCAL_THREAD,
        ThreadId.makeUnsafe("thread-other"),
        REMOTE_THREAD,
      ]);
    });

    it("merges records from every environment", () => {
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({
          threadShellById: { [LOCAL_THREAD]: shell(LOCAL_THREAD) },
        }),
        [REMOTE]: environment({ threadShellById: { [REMOTE_THREAD]: shell(REMOTE_THREAD) } }),
      });

      expect(Object.keys(state.threadShellById ?? {}).toSorted()).toEqual([
        LOCAL_THREAD,
        REMOTE_THREAD,
      ]);
    });

    it("reuses aggregate references when nothing changed", () => {
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({ projects: [makeProject()] }),
      });

      const next = withAggregatedView(state);

      expect(next.projects).toBe(state.projects);
      expect(next.threadShellById).toBe(state.threadShellById);
    });

    it("does not invalidate unrelated aggregates when one environment changes", () => {
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({ projects: [makeProject()] }),
        [REMOTE]: environment({}),
      });

      const next = updateEnvironment(state, REMOTE, (record) => ({
        ...record,
        threadIds: [REMOTE_THREAD],
      }));

      expect(next.threadIds).toEqual([REMOTE_THREAD]);
      expect(next.projects).toBe(state.projects);
    });
  });

  describe("local-only fields", () => {
    it("takes threadsHydrated from the local environment alone", () => {
      // The pinned-data bug: a remote snapshot must never flip hydration,
      // because the pruners that read it delete persisted pins whose targets
      // have merely not loaded yet.
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({ threadsHydrated: false }),
        [REMOTE]: environment({ threadsHydrated: true }),
      });

      expect(state.threadsHydrated).toBe(false);
      expect(selectLocalThreadsHydrated(state)).toBe(false);
    });

    it("hydrates once the local environment reports, regardless of remotes", () => {
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({ threadsHydrated: true }),
        [REMOTE]: environment({ threadsHydrated: false }),
      });

      expect(selectLocalThreadsHydrated(state)).toBe(true);
    });

    it("never merges a fence across environments", () => {
      // Two servers' sequences are unrelated counters. The aggregate exposes
      // the LOCAL fence only; a max or a sum here would recreate the bug that
      // made one server's snapshots look stale against another's.
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({ shellSnapshotSequence: 3 }),
        [REMOTE]: environment({ shellSnapshotSequence: 5000 }),
      });

      expect(state.shellSnapshotSequence).toBe(3);
      expect(selectEnvironment(state, REMOTE).shellSnapshotSequence).toBe(5000);
    });
  });

  describe("colliding ids across environments", () => {
    // Two servers can hold the same id: a clone, or a restore from another
    // server's backup, sharing database UUIDs. The merge and the ownership
    // lookups must then agree, or the row on screen belongs to one server
    // while a delete on it writes into another's sequence space.
    // REMOTE is inserted FIRST on purpose: raw `Record` enumeration would then
    // resolve ownership to it, while the aggregate renders local's row. Only an
    // adversarial insertion order can catch a lookup that forgets to sort.
    const collided = () =>
      storeWith({
        [REMOTE]: environment({
          threadIds: [LOCAL_THREAD],
          threadShellById: { [LOCAL_THREAD]: { ...shell(LOCAL_THREAD), title: "remote copy" } },
          projects: [makeProject({ name: "remote copy" })],
        }),
        [LOCAL_ENVIRONMENT_ID]: environment({
          threadIds: [LOCAL_THREAD],
          threadShellById: { [LOCAL_THREAD]: { ...shell(LOCAL_THREAD), title: "local copy" } },
          projects: [makeProject({ name: "local copy" })],
        }),
      });

    it("renders the row belonging to the environment that owns it", () => {
      const state = collided();

      expect(state.threadShellById?.[LOCAL_THREAD]?.title).toBe("local copy");
      expect(environmentIdForThread(state, LOCAL_THREAD)).toBe(LOCAL_ENVIRONMENT_ID);
    });

    it("resolves project ownership to the environment whose project is rendered", () => {
      const state = collided();
      const projectId = ProjectId.makeUnsafe("project-1");

      expect(state.projects.find((project) => project.id === projectId)?.name).toBe("local copy");
      expect(environmentIdForProject(state, projectId)).toBe(LOCAL_ENVIRONMENT_ID);
    });

    it("keeps the first environment's copy when three environments collide", () => {
      // Two environments exercise only the merge's initial pairing; a third is
      // what drives the accumulating branch, where a last-wins Object.assign
      // would silently take over.
      const state = storeWith({
        [OTHER_REMOTE]: environment({
          threadIds: [LOCAL_THREAD],
          threadShellById: { [LOCAL_THREAD]: { ...shell(LOCAL_THREAD), title: "other copy" } },
        }),
        [REMOTE]: environment({
          threadIds: [LOCAL_THREAD],
          threadShellById: { [LOCAL_THREAD]: { ...shell(LOCAL_THREAD), title: "remote copy" } },
        }),
        [LOCAL_ENVIRONMENT_ID]: environment({
          threadIds: [LOCAL_THREAD],
          threadShellById: { [LOCAL_THREAD]: { ...shell(LOCAL_THREAD), title: "local copy" } },
        }),
      });

      expect(state.threadShellById?.[LOCAL_THREAD]?.title).toBe("local copy");
      expect(environmentIdForThread(state, LOCAL_THREAD)).toBe(LOCAL_ENVIRONMENT_ID);
      expect(state.threadIds).toEqual([LOCAL_THREAD]);
    });

    it("lists a colliding id once, not once per environment", () => {
      // A duplicate here rendered the sidebar row twice and made every
      // flatMap over threadIds emit the thread twice.
      expect(collided().threadIds).toEqual([LOCAL_THREAD]);
      expect(collided().projects.map((project) => project.id)).toEqual([
        ProjectId.makeUnsafe("project-1"),
      ]);
    });
  });

  describe("positional ownership lookup", () => {
    it("finds the environment holding a thread", () => {
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({
          threadShellById: { [LOCAL_THREAD]: shell(LOCAL_THREAD) },
        }),
        [REMOTE]: environment({ threadShellById: { [REMOTE_THREAD]: shell(REMOTE_THREAD) } }),
      });

      expect(environmentIdForThread(state, REMOTE_THREAD)).toBe(REMOTE);
      expect(environmentIdForThread(state, LOCAL_THREAD)).toBe(LOCAL_ENVIRONMENT_ID);
    });

    it("finds the environment holding a project", () => {
      const remoteProjectId = ProjectId.makeUnsafe("project-remote");
      const state = storeWith({
        [LOCAL_ENVIRONMENT_ID]: environment({ projects: [makeProject()] }),
        [REMOTE]: environment({ projects: [makeProject({ id: remoteProjectId })] }),
      });

      expect(environmentIdForProject(state, remoteProjectId)).toBe(REMOTE);
      expect(environmentIdForProject(state, ProjectId.makeUnsafe("project-1"))).toBe(
        LOCAL_ENVIRONMENT_ID,
      );
    });

    it("falls back to local for an unknown id", () => {
      // Optimistic creates write before any snapshot claims the row, so an
      // unclaimed id has to land somewhere; local is the only safe default.
      const state = storeWith({ [REMOTE]: environment({}) });

      expect(environmentIdForThread(state, ThreadId.makeUnsafe("thread-unknown"))).toBe(
        LOCAL_ENVIRONMENT_ID,
      );
      expect(environmentIdForProject(state, ProjectId.makeUnsafe("project-unknown"))).toBe(
        LOCAL_ENVIRONMENT_ID,
      );
    });
  });
});
