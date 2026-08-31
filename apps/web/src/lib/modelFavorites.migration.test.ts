// FILE: modelFavorites.migration.test.ts
// Purpose: Verifies Kilo favorite models survive the provider migration to OpenCode.

import { describe, expect, it } from "vitest";

import { FAVORITE_MODEL_STORAGE_KEYS, migrateLegacyKiloFavoriteModelSlugs } from "./modelFavorites";

const LEGACY_KILO_KEY = "synara:kilo-favourite-models:v1";

function makeMemoryStorage(initial: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("migrateLegacyKiloFavoriteModelSlugs", () => {
  it("merges Kilo favorites into OpenCode without duplicates", () => {
    const storage = makeMemoryStorage({
      [FAVORITE_MODEL_STORAGE_KEYS.opencode]: JSON.stringify(["openai/gpt-5", "shared/model"]),
      [LEGACY_KILO_KEY]: JSON.stringify(["shared/model", "anthropic/claude-sonnet", ""]),
    });

    migrateLegacyKiloFavoriteModelSlugs(storage);

    expect(JSON.parse(storage.getItem(FAVORITE_MODEL_STORAGE_KEYS.opencode) ?? "null")).toEqual([
      "openai/gpt-5",
      "shared/model",
      "anthropic/claude-sonnet",
    ]);
    expect(storage.getItem(LEGACY_KILO_KEY)).toBeNull();
  });

  it("keeps invalid legacy data for a later recovery attempt", () => {
    const storage = makeMemoryStorage({ [LEGACY_KILO_KEY]: "not-json" });

    migrateLegacyKiloFavoriteModelSlugs(storage);

    expect(storage.getItem(LEGACY_KILO_KEY)).toBe("not-json");
    expect(storage.getItem(FAVORITE_MODEL_STORAGE_KEYS.opencode)).toBeNull();
  });
});
