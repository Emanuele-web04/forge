// FILE: useLocalStorage.browser.tsx
// Purpose: Verifies cross-window localStorage clear events reset subscribed hook state.

import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useLocalStorage } from "~/hooks/useLocalStorage";

const STORAGE_KEY = "synara:test:use-local-storage-clear";

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("useLocalStorage cross-window synchronization", () => {
  it("returns to its fallback after another window clears localStorage", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify("persisted"));
    const hook = await renderHook(() => useLocalStorage(STORAGE_KEY, "fallback", Schema.String));
    expect(hook.result.current[0]).toBe("persisted");

    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));

    await vi.waitFor(() => expect(hook.result.current[0]).toBe("fallback"));
    await hook.unmount();
  });
});
