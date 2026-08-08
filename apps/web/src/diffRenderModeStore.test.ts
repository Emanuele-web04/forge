// FILE: diffRenderModeStore.test.ts
// Purpose: Pins per-thread diff layout persistence separate from the Settings default.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useDiffRenderModeStore } from "./diffRenderModeStore";

const ORIGINAL_LOCAL_STORAGE = globalThis.localStorage;

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();
  return {
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
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  } as Storage;
}

describe("useDiffRenderModeStore", () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryStorage();
    useDiffRenderModeStore.setState({ modeByThreadId: {} });
  });

  afterEach(() => {
    globalThis.localStorage = ORIGINAL_LOCAL_STORAGE;
  });

  it("falls back to the settings default when a thread has no override", () => {
    expect(useDiffRenderModeStore.getState().getModeForThread("thread-a", "split")).toBe("split");
    expect(useDiffRenderModeStore.getState().getModeForThread(null, "stacked")).toBe("stacked");
  });

  it("remembers a per-thread override without affecting other threads", () => {
    useDiffRenderModeStore.getState().setModeForThread("thread-a", "stacked");

    expect(useDiffRenderModeStore.getState().getModeForThread("thread-a", "split")).toBe("stacked");
    expect(useDiffRenderModeStore.getState().getModeForThread("thread-b", "split")).toBe("split");
  });
});
