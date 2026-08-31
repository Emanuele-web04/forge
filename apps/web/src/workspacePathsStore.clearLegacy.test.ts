// FILE: workspacePathsStore.clearLegacy.test.ts
// Purpose: Verifies clearing cached workspace paths cannot resurrect the legacy fallback.

import { afterEach, describe, expect, it, vi } from "vitest";

const CURRENT_STORAGE_KEY = "synara:workspace-paths:v1";
const LEGACY_STORAGE_KEY = "synara:workspace-pages:v2";

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

describe("workspace path storage clearing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("removes the legacy fallback when cached paths are cleared", async () => {
    installMemoryLocalStorage();
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        state: {
          homeDir: "/Users/legacy",
          chatWorkspaceRoot: "/Users/legacy/Documents/Synara",
        },
        version: 2,
      }),
    );
    vi.resetModules();

    let workspaceModule = await import("./workspacePathsStore");
    expect(workspaceModule.useWorkspacePathsStore.getState().homeDir).toBe("/Users/legacy");

    await workspaceModule.useWorkspacePathsStore.persist.clearStorage();

    expect(localStorage.getItem(CURRENT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();

    vi.resetModules();
    workspaceModule = await import("./workspacePathsStore");
    const reloadedState = workspaceModule.useWorkspacePathsStore.getState();
    expect(reloadedState.homeDir ?? null).toBeNull();
    expect(reloadedState.chatWorkspaceRoot ?? null).toBeNull();
  });
});
