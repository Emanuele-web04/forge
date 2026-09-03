import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useSyncExternalStore: (
    _subscribe: (listener: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => getSnapshot(),
}));

import { setFeatureFlagEnabled, useFeatureFlags } from "./featureFlags";

const FEATURE_FLAG_STORAGE_KEY = "synara:feature-flags";

function createLocalStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("feature flag storage recovery", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("does not resurrect cached flags after malformed storage is read twice", () => {
    const localStorage = createLocalStorage();
    vi.stubGlobal("window", { localStorage });

    setFeatureFlagEnabled("show-debug-task-banner", true);
    localStorage.setItem(FEATURE_FLAG_STORAGE_KEY, "{malformed");

    expect(useFeatureFlags()["show-debug-task-banner"]).toBe(false);
    expect(useFeatureFlags()["show-debug-task-banner"]).toBe(false);
  });
});
