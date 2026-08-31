// FILE: storePersistence.test.ts
// Purpose: Unit-test the renderer-state persistence layer for project UI.

import { ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

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
  it("has no remembered project UI state on a fresh profile (no persisted key)", async () => {
    const storage = new Map<string, string>();
    try {
      const { readPersistedState, getRememberedProjectUiState } =
        await importStorePersistence(storage);
      expect(() => readPersistedState(initialState)).not.toThrow();
      const remembered = getRememberedProjectUiState();
      expect(remembered.expandedProjectCount).toBe(0);
      expect(remembered.projectOrderCount).toBe(0);
      expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads with all projects expanded and does not throw when the stored value is corrupt", async () => {
    const storage = new Map<string, string>();
    storage.set(PERSISTED_STATE_KEY, '"{"');
    try {
      const { readPersistedState, getRememberedProjectUiState } =
        await importStorePersistence(storage);
      expect(() => readPersistedState(initialState)).not.toThrow();
      const remembered = getRememberedProjectUiState();
      expect(remembered.expandedProjectCount).toBe(0);
      expect(remembered.projectOrderCount).toBe(0);
      expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
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
    try {
      const { readPersistedState, getRememberedProjectUiState } =
        await importStorePersistence(storage);
      readPersistedState(initialState);
      const remembered = getRememberedProjectUiState();
      expect(remembered.projectOrderCount).toBe(2);
      expect(remembered.expandedProjectCount).toBe(0);
      expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
      expect(remembered.isProjectExpanded("/tmp/project-2")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
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
    try {
      const { readPersistedState, getRememberedProjectUiState } =
        await importStorePersistence(storage);
      readPersistedState(initialState);
      const remembered = getRememberedProjectUiState();
      expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(true);
      expect(remembered.isProjectExpanded("/tmp/project-2")).toBe(false);
      expect(remembered.isProjectExpanded("/tmp/project-3")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
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
    try {
      const { readPersistedState, getRememberedProjectUiState } =
        await importStorePersistence(storage);
      readPersistedState(initialState);
      const remembered = getRememberedProjectUiState();
      expect(remembered.projectOrderIndexForCwd("/tmp/project-new")).toBeUndefined();
      expect(remembered.isProjectExpanded("/tmp/project-new")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves legacy payloads that contain only expandedProjectCwds", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: ["/tmp/project-1"],
      }),
    );
    try {
      const { readPersistedState, getRememberedProjectUiState } =
        await importStorePersistence(storage);
      readPersistedState(initialState);
      const remembered = getRememberedProjectUiState();
      expect(remembered.projectOrderCount).toBe(0);
      expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(true);
      expect(remembered.isProjectExpanded("/tmp/project-2")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("detects a legacy payload with an empty expandedProjectCwds list as all collapsed", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: [],
      }),
    );
    try {
      const { readPersistedState, getRememberedProjectUiState } =
        await importStorePersistence(storage);
      readPersistedState(initialState);
      const remembered = getRememberedProjectUiState();
      expect(remembered.hasLegacyExpandedCwds).toBe(true);
      expect(remembered.expandedProjectCount).toBe(0);
      expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
      expect(remembered.isProjectExpanded("/tmp/project-2")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("writes projectOrderCwds for every project and expandedProjectCwds only for expanded projects", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    const setItem = fakeWindow.localStorage.setItem;
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    try {
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
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("removes a deleted project from both persisted project lists on the next write", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    try {
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
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not call localStorage.setItem while threadsHydrated is false", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    const setItem = fakeWindow.localStorage.setItem;
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    try {
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
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
