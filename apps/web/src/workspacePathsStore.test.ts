// FILE: workspacePathsStore.test.ts
// Purpose: Verifies persisted server workspace paths and hydration behavior.
// Layer: Server configuration state tests

import { afterEach, describe, expect, it, vi } from "vitest";

function installMemoryLocalStorage() {
  const entries = new Map<string, string>();

  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    clear: vi.fn(() => {
      entries.clear();
    }),
    key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    get length() {
      return entries.size;
    },
  });
}

describe("workspacePathsStore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the current home directory while server config is still loading", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspacePathsStore } = await import("./workspacePathsStore");

    useWorkspacePathsStore.getState().setHomeDir("/Users/tester");
    useWorkspacePathsStore.getState().setHomeDir(undefined);

    expect(useWorkspacePathsStore.getState().homeDir).toBe("/Users/tester");
  });

  it("still allows explicitly clearing the home directory", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspacePathsStore } = await import("./workspacePathsStore");

    useWorkspacePathsStore.getState().setHomeDir("/Users/tester");
    useWorkspacePathsStore.getState().setHomeDir(null);

    expect(useWorkspacePathsStore.getState().homeDir).toBeNull();
  });

  it("keeps chat workspace root while server config is still loading", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspacePathsStore } = await import("./workspacePathsStore");

    useWorkspacePathsStore.getState().setChatWorkspaceRoot("/Users/tester/Documents/Synara");
    useWorkspacePathsStore.getState().setChatWorkspaceRoot(undefined);

    expect(useWorkspacePathsStore.getState().chatWorkspaceRoot).toBe(
      "/Users/tester/Documents/Synara",
    );
  });

  it("keeps studio workspace root while server config is still loading", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspacePathsStore } = await import("./workspacePathsStore");

    useWorkspacePathsStore
      .getState()
      .setStudioWorkspaceRoot("/Users/tester/Documents/Synara/Studio");
    useWorkspacePathsStore.getState().setStudioWorkspaceRoot(undefined);

    expect(useWorkspacePathsStore.getState().studioWorkspaceRoot).toBe(
      "/Users/tester/Documents/Synara/Studio",
    );
  });

  it("updates home, chat, and studio workspace roots together from server paths", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspacePathsStore } = await import("./workspacePathsStore");

    useWorkspacePathsStore.getState().setServerWorkspacePaths({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });

    expect(useWorkspacePathsStore.getState().homeDir).toBe("/Users/tester");
    expect(useWorkspacePathsStore.getState().chatWorkspaceRoot).toBe(
      "/Users/tester/Documents/Synara",
    );
    expect(useWorkspacePathsStore.getState().studioWorkspaceRoot).toBe(
      "/Users/tester/Documents/Synara/Studio",
    );
  });

  it("persists the chat workspace root with the home directory but not the studio root", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    let workspaceModule = await import("./workspacePathsStore");
    workspaceModule.useWorkspacePathsStore.getState().setServerWorkspacePaths({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });

    vi.resetModules();
    workspaceModule = await import("./workspacePathsStore");

    expect(workspaceModule.useWorkspacePathsStore.getState().homeDir).toBe("/Users/tester");
    expect(workspaceModule.useWorkspacePathsStore.getState().chatWorkspaceRoot).toBe(
      "/Users/tester/Documents/Synara",
    );
    expect(workspaceModule.useWorkspacePathsStore.getState().studioWorkspaceRoot).toBeNull();
  });

  it("migrates cached paths without retaining legacy workspace pages", async () => {
    installMemoryLocalStorage();
    localStorage.setItem(
      "synara:workspace-pages:v2",
      JSON.stringify({
        state: {
          homeDir: "/Users/legacy",
          chatWorkspaceRoot: "/Users/legacy/Documents/Synara",
          workspacePages: [{ id: "retired-workspace", title: "Workspace 1" }],
        },
        version: 2,
      }),
    );
    vi.resetModules();

    const { useWorkspacePathsStore } = await import("./workspacePathsStore");

    expect(useWorkspacePathsStore.getState().homeDir).toBe("/Users/legacy");
    expect(useWorkspacePathsStore.getState().chatWorkspaceRoot).toBe(
      "/Users/legacy/Documents/Synara",
    );
    expect(useWorkspacePathsStore.getState()).not.toHaveProperty("workspacePages");

    useWorkspacePathsStore.getState().setHomeDir("/Users/current");
    expect(localStorage.getItem("synara:workspace-pages:v2")).toBeNull();
    expect(localStorage.getItem("synara:workspace-paths:v1")).not.toBeNull();
  });
});
