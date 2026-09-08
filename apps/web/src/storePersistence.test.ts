// FILE: storePersistence.test.ts
// Purpose: Unit-test the renderer-state persistence layer for project UI.

import { ProjectId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFakeWindow, makeProject } from "./storeTestFixtures";
import { initialState } from "./storeState";
import type { AppState } from "./storeState";
import { PERSISTED_STATE_KEY } from "./storePersistence";

async function importStorePersistence(storage: Map<string, string>) {
  vi.stubGlobal("window", makeFakeWindow(storage));
  vi.resetModules();
  return import("./storePersistence");
}

describe("storePersistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has no remembered project UI state on a fresh profile (no persisted key)", async () => {
    const storage = new Map<string, string>();
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    expect(() => readPersistedState(initialState)).not.toThrow();
    const remembered = getRememberedProjectUiState();
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
  });

  it("resets remembered state when the stored value is corrupt", async () => {
    const storage = new Map<string, string>();
    storage.set(PERSISTED_STATE_KEY, '"{"');
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    expect(() => readPersistedState(initialState)).not.toThrow();
    const remembered = getRememberedProjectUiState();
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
  });

  it("ignores malformed persisted shapes and falls back to defaults", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: "not-an-array",
        expandedProjectCwds: "also-not-an-array",
        projectNamesByCwd: ["not-a-record"],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    expect(() => readPersistedState(initialState)).not.toThrow();
    const remembered = getRememberedProjectUiState();
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.projectNameForCwd("/tmp/project-1")).toBeUndefined();
  });

  it("remembers a fully collapsed project set", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: ["/tmp/project-1", "/tmp/project-2"],
        expandedProjectCwds: [],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(2);
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
    expect(remembered.isProjectExpanded("/tmp/project-2")).toBe(false);
  });

  it("remembers mixed expansion state per project", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: ["/tmp/project-1", "/tmp/project-2", "/tmp/project-3"],
        expandedProjectCwds: ["/tmp/project-1", "/tmp/project-3"],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(true);
    expect(remembered.isProjectExpanded("/tmp/project-2")).toBe(false);
    expect(remembered.isProjectExpanded("/tmp/project-3")).toBe(true);
  });

  it("treats a new project cwd as unknown (not in persisted order) when every persisted project is collapsed", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: ["/tmp/project-1", "/tmp/project-2"],
        expandedProjectCwds: [],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderIndexForCwd("/tmp/project-new")).toBeUndefined();
  });

  it("preserves legacy payloads that contain only expandedProjectCwds", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: ["/tmp/project-1"],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(true);
    expect(remembered.isProjectExpanded("/tmp/project-2")).toBe(false);
  });

  it("detects a legacy payload with an empty expandedProjectCwds list as all collapsed", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: [],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.isLegacyExpansionPayload).toBe(true);
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
    expect(remembered.isProjectExpanded("/tmp/project-2")).toBe(false);
  });

  it("does not treat a modern empty persisted payload as a legacy all-collapsed list", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: [],
        expandedProjectCwds: [],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.isLegacyExpansionPayload).toBe(false);
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.expandedProjectCount).toBe(0);
  });

  it("writes projectOrderCwds for every project and expandedProjectCwds only for expanded projects", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    const setItem = fakeWindow.localStorage.setItem;
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    const { persistState } = await import("./storePersistence");
    const state: AppState = {
      ...initialState,
      threadsHydrated: true,
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          cwd: "/tmp/project-1",
          expanded: true,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          cwd: "/tmp/project-2",
          expanded: false,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-3"),
          cwd: "/tmp/project-3",
          expanded: true,
        }),
      ],
    };
    persistState(state);
    expect(setItem).toHaveBeenCalledOnce();
    const payload = JSON.parse(storage.get(PERSISTED_STATE_KEY) ?? "{}");
    expect(payload.projectOrderCwds).toEqual([
      "/tmp/project-1",
      "/tmp/project-2",
      "/tmp/project-3",
    ]);
    expect(payload.expandedProjectCwds).toEqual(["/tmp/project-1", "/tmp/project-3"]);
  });

  it("removes a deleted project from both persisted project lists on the next write", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    const { persistState } = await import("./storePersistence");
    const state: AppState = {
      ...initialState,
      threadsHydrated: true,
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          cwd: "/tmp/project-1",
          expanded: true,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          cwd: "/tmp/project-2",
          expanded: false,
        }),
      ],
    };
    persistState(state);

    const next: AppState = {
      ...initialState,
      threadsHydrated: true,
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          cwd: "/tmp/project-1",
          expanded: true,
        }),
      ],
    };
    persistState(next);

    const payload = JSON.parse(storage.get(PERSISTED_STATE_KEY) ?? "{}");
    expect(payload.projectOrderCwds).not.toContain("/tmp/project-2");
    expect(payload.expandedProjectCwds).not.toContain("/tmp/project-2");
    expect(payload.projectOrderCwds).toEqual(["/tmp/project-1"]);
    expect(payload.expandedProjectCwds).toEqual(["/tmp/project-1"]);
  });

  it("forgetProjectState removes a project from all remembered UI state", async () => {
    const storage = new Map<string, string>();
    const { rememberProjectState, forgetProjectState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    rememberProjectState([
      makeProject({
        id: ProjectId.makeUnsafe("project-1"),
        cwd: "/tmp/project-1",
        expanded: true,
        localName: "alpha",
      }),
      makeProject({
        id: ProjectId.makeUnsafe("project-2"),
        cwd: "/tmp/project-2",
        expanded: false,
        localName: "beta",
      }),
    ]);

    const before = getRememberedProjectUiState();
    expect(before.projectOrderIndexForCwd("/tmp/project-1")).toBe(0);
    expect(before.projectNameForCwd("/tmp/project-1")).toBe("alpha");

    forgetProjectState("/tmp/project-1");

    const after = getRememberedProjectUiState();
    expect(after.projectOrderIndexForCwd("/tmp/project-1")).toBeUndefined();
    expect(after.projectNameForCwd("/tmp/project-1")).toBeUndefined();
    expect(after.isProjectExpanded("/tmp/project-1")).toBe(false);
    expect(after.projectOrderIndexForCwd("/tmp/project-2")).toBe(1);
    expect(after.projectNameForCwd("/tmp/project-2")).toBe("beta");
  });

  it("reindexes a known project to match its current position", async () => {
    const storage = new Map<string, string>();
    const { rememberProjectState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    const project = (id: string, cwd: string) => makeProject({ id: ProjectId.makeUnsafe(id), cwd });
    rememberProjectState([
      project("project-1", "/tmp/project-1"),
      project("project-2", "/tmp/project-2"),
    ]);
    expect(getRememberedProjectUiState().projectOrderIndexForCwd("/tmp/project-1")).toBe(0);

    rememberProjectState([
      project("project-2", "/tmp/project-2"),
      project("project-1", "/tmp/project-1"),
    ]);

    expect(getRememberedProjectUiState().projectOrderIndexForCwd("/tmp/project-2")).toBe(0);
    expect(getRememberedProjectUiState().projectOrderIndexForCwd("/tmp/project-1")).toBe(1);
  });

  it("resets remembered state when the incoming project set shares no cwd with it", async () => {
    const storage = new Map<string, string>();
    const { rememberProjectState, resetStaleRememberedProjectState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    rememberProjectState([
      makeProject({
        id: ProjectId.makeUnsafe("project-1"),
        cwd: "/tmp/project-1",
        expanded: true,
        localName: "alpha",
      }),
    ]);
    expect(getRememberedProjectUiState().projectOrderCount).toBe(1);

    resetStaleRememberedProjectState(new Set(["/tmp/project-2"]));

    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.projectNameForCwd("/tmp/project-1")).toBeUndefined();
    expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
  });

  it("keeps only overlapping project preferences from an authoritative snapshot", async () => {
    const storage = new Map<string, string>();
    const { rememberProjectState, resetStaleRememberedProjectState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    rememberProjectState([
      makeProject({
        id: ProjectId.makeUnsafe("project-1"),
        cwd: "/tmp/project-1",
        expanded: true,
        localName: "alpha",
      }),
      makeProject({
        id: ProjectId.makeUnsafe("project-2"),
        cwd: "/tmp/project-2",
        expanded: false,
      }),
    ]);

    resetStaleRememberedProjectState(new Set(["/tmp/project-2", "/tmp/project-3"]));

    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(1);
    expect(remembered.projectOrderIndexForCwd("/tmp/project-2")).toBe(0);
    expect(remembered.projectNameForCwd("/tmp/project-1")).toBeUndefined();
    expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
  });

  it("resets remembered state when the incoming project set is empty", async () => {
    const storage = new Map<string, string>();
    const { rememberProjectState, resetStaleRememberedProjectState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    rememberProjectState([
      makeProject({
        id: ProjectId.makeUnsafe("project-1"),
        cwd: "/tmp/project-1",
        expanded: true,
      }),
    ]);

    resetStaleRememberedProjectState(new Set());

    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.expandedProjectCount).toBe(0);
  });

  it("does not call localStorage.setItem while threadsHydrated is false", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    const setItem = fakeWindow.localStorage.setItem;
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    const { persistState } = await import("./storePersistence");
    const state: AppState = {
      ...initialState,
      threadsHydrated: false,
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          cwd: "/tmp/project-1",
          expanded: true,
        }),
      ],
    };
    persistState(state);
    expect(setItem).not.toHaveBeenCalled();
    expect(storage.has(PERSISTED_STATE_KEY)).toBe(false);
  });

  it("stops treating the payload as legacy once modern order state is remembered", async () => {
    const storage = new Map<string, string>();
    storage.set(PERSISTED_STATE_KEY, JSON.stringify({ expandedProjectCwds: [] }));
    const {
      readPersistedState,
      rememberProjectState,
      forgetProjectState,
      getRememberedProjectUiState,
    } = await importStorePersistence(storage);
    readPersistedState(initialState);
    expect(getRememberedProjectUiState().isLegacyExpansionPayload).toBe(true);

    rememberProjectState([
      makeProject({
        id: ProjectId.makeUnsafe("project-1"),
        cwd: "/tmp/project-1",
        expanded: false,
      }),
    ]);
    expect(getRememberedProjectUiState().isLegacyExpansionPayload).toBe(false);

    forgetProjectState("/tmp/project-1");
    expect(getRememberedProjectUiState().projectOrderCount).toBe(0);
    expect(getRememberedProjectUiState().isLegacyExpansionPayload).toBe(false);
  });

  it("resets remembered state when the persisted key disappears on a later read", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: ["/tmp/project-1"],
        expandedProjectCwds: ["/tmp/project-1"],
        projectNamesByCwd: { "/tmp/project-1": "alpha" },
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    expect(getRememberedProjectUiState().projectOrderCount).toBe(1);

    storage.delete(PERSISTED_STATE_KEY);
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.projectNameForCwd("/tmp/project-1")).toBeUndefined();
    expect(remembered.isLegacyExpansionPayload).toBe(false);
  });

  it("resets remembered state when the stored value becomes corrupt on a later read", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectOrderCwds: ["/tmp/project-1"],
        expandedProjectCwds: ["/tmp/project-1"],
      }),
    );
    const { readPersistedState, getRememberedProjectUiState } =
      await importStorePersistence(storage);
    readPersistedState(initialState);
    expect(getRememberedProjectUiState().projectOrderCount).toBe(1);

    storage.set(PERSISTED_STATE_KEY, '"{"');
    readPersistedState(initialState);
    const remembered = getRememberedProjectUiState();
    expect(remembered.projectOrderCount).toBe(0);
    expect(remembered.expandedProjectCount).toBe(0);
    expect(remembered.isLegacyExpansionPayload).toBe(false);
  });

  it("swallows localStorage write failures instead of breaking the caller", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    fakeWindow.localStorage.setItem.mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    const { persistState } = await import("./storePersistence");
    const state: AppState = {
      ...initialState,
      threadsHydrated: true,
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          cwd: "/tmp/project-1",
          expanded: true,
        }),
      ],
    };
    expect(() => persistState(state)).not.toThrow();
    expect(storage.has(PERSISTED_STATE_KEY)).toBe(false);
  });
});
