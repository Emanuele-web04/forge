// FILE: providerModelCatalogCache.test.ts
// Purpose: Unit tests for the persisted provider model catalog cache.
// Layer: Web local storage / discovery cache tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCatalogCacheInputsKey,
  CATALOG_CACHE_TTL_MS,
  CATALOG_CACHE_VERSION,
  readCatalogCacheEntry,
  writeCatalogCache,
} from "./providerModelCatalogCache";

function catalogCacheKey(provider: string) {
  return `synara:provider-models-cache:${CATALOG_CACHE_VERSION}:${provider}`;
}

const baseInputs = {
  binaryPath: "/usr/local/bin/opencode",
  apiEndpoint: null as string | null,
  agentDir: "/tmp/opencode",
  cwd: "/ignored" as string | null,
};
const inputsKey = buildCatalogCacheInputsKey(baseInputs);

const nonEmptyResult = {
  models: [{ slug: "openai/gpt-5", name: "GPT-5" }],
  source: "opencode",
  cached: false,
};

function installMemoryLocalStorage(): void {
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

beforeEach(installMemoryLocalStorage);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("providerModelCatalogCache", () => {
  it("round-trips a non-empty catalog for a matching inputsKey", () => {
    writeCatalogCache("opencode", inputsKey, nonEmptyResult);
    expect(readCatalogCacheEntry("opencode", inputsKey)?.result).toEqual(nonEmptyResult);
  });

  it("rejects entries older than 7 days", () => {
    const expired = {
      inputsKey,
      fetchedAt: Date.now() - CATALOG_CACHE_TTL_MS - 1,
      result: nonEmptyResult,
    };
    globalThis.localStorage.setItem(catalogCacheKey("opencode"), JSON.stringify(expired));

    expect(readCatalogCacheEntry("opencode", inputsKey)).toBeUndefined();
  });

  it("rejects entries with a mismatched inputsKey", () => {
    writeCatalogCache("opencode", inputsKey, nonEmptyResult);

    const otherKey = buildCatalogCacheInputsKey({
      ...baseInputs,
      binaryPath: "/other/opencode",
    });
    expect(readCatalogCacheEntry("opencode", otherKey)).toBeUndefined();
  });

  it("ignores malformed localStorage values", () => {
    globalThis.localStorage.setItem(catalogCacheKey("opencode"), "not-json");
    expect(readCatalogCacheEntry("opencode", inputsKey)).toBeUndefined();

    globalThis.localStorage.setItem(catalogCacheKey("opencode"), JSON.stringify({ wrong: true }));
    expect(readCatalogCacheEntry("opencode", inputsKey)).toBeUndefined();
  });

  it("ignores entries whose fetchedAt is not a positive finite number", () => {
    writeCatalogCache("opencode", inputsKey, nonEmptyResult);
    const raw = globalThis.localStorage.getItem(catalogCacheKey("opencode"));
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw!) as { fetchedAt: number | null };
    globalThis.localStorage.setItem(
      catalogCacheKey("opencode"),
      JSON.stringify({ ...payload, fetchedAt: null }),
    );
    expect(readCatalogCacheEntry("opencode", inputsKey)).toBeUndefined();

    globalThis.localStorage.setItem(
      catalogCacheKey("opencode"),
      JSON.stringify({ ...payload, fetchedAt: 0 }),
    );
    expect(readCatalogCacheEntry("opencode", inputsKey)).toBeUndefined();
  });

  it("never persists a fallback-populated result", () => {
    globalThis.localStorage.removeItem(catalogCacheKey("opencode"));
    writeCatalogCache("opencode", inputsKey, { ...nonEmptyResult, error: "discovery failed" });
    expect(globalThis.localStorage.getItem(catalogCacheKey("opencode"))).toBeNull();
  });

  it("refuses to cache empty, disabled, or unsupported sources and preserves the previous value", () => {
    writeCatalogCache("opencode", inputsKey, nonEmptyResult);

    const badResults = [
      { models: [{ slug: "x", name: "X" }], source: "empty" as const, cached: false },
      { models: [{ slug: "x", name: "X" }], source: "disabled" as const, cached: false },
      { models: [{ slug: "x", name: "X" }], source: "unsupported" as const, cached: false },
      { models: [], source: "empty" as const, cached: false },
      { models: [], source: "disabled" as const, cached: false },
      { models: [], source: "unsupported" as const, cached: false },
    ];

    for (const bad of badResults) {
      writeCatalogCache("opencode", inputsKey, bad);
      expect(readCatalogCacheEntry("opencode", inputsKey)?.result).toEqual(nonEmptyResult);
    }
  });

  it("refuses to cache a result with an undefined source even when models are non-empty", () => {
    writeCatalogCache("opencode", inputsKey, {
      models: [{ slug: "openai/gpt-5", name: "GPT-5" }],
      source: undefined,
      cached: false,
    });

    expect(readCatalogCacheEntry("opencode", inputsKey)).toBeUndefined();
  });

  it("refuses to cache a result with an empty source even when models are non-empty", () => {
    writeCatalogCache("opencode", inputsKey, {
      models: [{ slug: "openai/gpt-5", name: "GPT-5" }],
      source: "",
      cached: false,
    });

    expect(readCatalogCacheEntry("opencode", inputsKey)).toBeUndefined();
  });

  it("swallows localStorage write errors so the picker stays usable", () => {
    globalThis.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };

    expect(() => writeCatalogCache("opencode", inputsKey, nonEmptyResult)).not.toThrow();
    expect(readCatalogCacheEntry("opencode", inputsKey)).toBeUndefined();
  });
});
