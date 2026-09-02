// FILE: providerDiscoveryReactQuery.test.ts
// Purpose: Locks provider model discovery query semantics — retry policy,
//          stale-catalog preservation, and initial-vs-background pending (#103).
// Layer: Web data fetching tests

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as providerModelCatalogCache from "./providerModelCatalogCache";
import {
  isInitialModelDiscoveryPending,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";
import * as nativeApi from "../nativeApi";

const baseInputs: {
  binaryPath: string | null;
  apiEndpoint: string | null;
  agentDir: string | null;
  cwd: string | null;
} = {
  binaryPath: "/usr/local/bin/opencode",
  apiEndpoint: null,
  agentDir: "/tmp/opencode",
  cwd: "/ignored",
};

function mockListModels(listModels: ReturnType<typeof vi.fn>) {
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue(
    // @ts-expect-error test-only partial NativeApi mock; only provider.listModels is used
    { provider: { listModels } },
  );
  return listModels;
}

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

describe("isInitialModelDiscoveryPending", () => {
  it("is pending only for the first fetch (loading or placeholder fetch)", () => {
    expect(
      isInitialModelDiscoveryPending({
        isLoading: true,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    // Settled catalog + background refetch must not blank the picker (#103).
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: false,
      }),
    ).toBe(false);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: false,
        isPlaceholderData: false,
      }),
    ).toBe(false);
  });
});

describe("providerModelsQueryOptions", () => {
  it("fails fast for Cursor so a missing CLI settles instead of spinning (#103)", async () => {
    const listModels = mockListModels(
      vi.fn().mockRejectedValue(new Error("Cursor CLI is not installed or not on PATH")),
    );
    const options = providerModelsQueryOptions({ provider: "cursor", enabled: true });
    expect(options.retry).toBe(0);

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "Cursor CLI is not installed or not on PATH",
    );
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(options.queryKey)?.status).toBe("error");
  });

  it("uses the provider-specific retry counts", () => {
    expect(providerModelsQueryOptions({ provider: "codex" }).retry).toBe(3);
    expect(providerModelsQueryOptions({ provider: "claudeAgent" }).retry).toBe(3);
    expect(providerModelsQueryOptions({ provider: "droid" }).retry).toBe(0);
    expect(providerModelsQueryOptions({ provider: "cursor" }).retry).toBe(0);
    expect(providerModelsQueryOptions({ provider: "opencode" }).retry).toBe(1);
    expect(providerModelsQueryOptions({ provider: "devin" }).retry).toBe(2);
  });

  it("bounds retry delay and revalidates after reconnect", () => {
    const options = providerModelsQueryOptions({ provider: "devin" });
    const retryDelay = options.retryDelay;
    expect(typeof retryDelay).toBe("function");
    if (typeof retryDelay !== "function") {
      throw new Error("Expected model discovery retry delay to be a function.");
    }

    expect(retryDelay(0, new Error("transient"))).toBe(200);
    expect(retryDelay(8, new Error("transient"))).toBe(2_000);
    expect(options.refetchOnReconnect).toBe(true);
  });

  it("treats an errored fallback result as a failure for every provider", async () => {
    mockListModels(
      vi.fn().mockResolvedValue({
        models: [{ slug: "claude-sonnet-5", name: "Claude Sonnet 5" }],
        source: "claude.cli",
        cached: false,
        error: "Claude CLI discovery failed; serving static fallback",
      }),
    );
    const options = providerModelsQueryOptions({ provider: "claudeAgent", enabled: true });
    Object.assign(options, { retry: 0 });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "Claude CLI discovery failed; serving static fallback",
    );
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
  });

  it("recovers Devin discovery after a transient failure without duplicate requests", async () => {
    const catalog = {
      models: [{ slug: "adaptive", name: "Adaptive" }],
      source: "devin-acp",
      cached: false,
    };
    const listModels = mockListModels(
      vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary ACP startup failure"))
        .mockResolvedValue(catalog),
    );
    const options = providerModelsQueryOptions({ provider: "devin", enabled: true });
    Object.assign(options, { retryDelay: 0 });
    const queryClient = new QueryClient();

    await expect(
      Promise.all([queryClient.fetchQuery(options), queryClient.fetchQuery(options)]),
    ).resolves.toEqual([catalog, catalog]);
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("keeps Droid discovery cached for five minutes and ignores focus", () => {
    const options = providerModelsQueryOptions({ provider: "droid" });

    expect(options.staleTime).toBe(5 * 60_000);
    expect(options.refetchOnWindowFocus).toBe(false);
  });

  it("deduplicates concurrent catalog requests for the same provider key", async () => {
    const catalog = {
      models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      source: "codex",
      cached: false,
    };
    const listModels = mockListModels(vi.fn().mockResolvedValue(catalog));
    const options = providerModelsQueryOptions({ provider: "codex", enabled: true });
    const queryClient = new QueryClient();

    await Promise.all([queryClient.fetchQuery(options), queryClient.fetchQuery(options)]);

    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("surfaces real errors instead of masking them as empty catalogs", async () => {
    mockListModels(vi.fn().mockRejectedValue(new Error("discovery exploded")));
    const options = providerModelsQueryOptions({ provider: "cursor", enabled: true });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).rejects.toThrow("discovery exploded");
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
  });

  it("preserves the cached catalog when a background refetch fails", async () => {
    const catalog = {
      models: [{ slug: "auto", name: "Auto" }],
      source: "cursor.cli",
      cached: false,
    };
    const listModels = mockListModels(
      vi.fn().mockResolvedValueOnce(catalog).mockRejectedValue(new Error("cursor went away")),
    );
    const options = providerModelsQueryOptions({ provider: "cursor", enabled: true });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).resolves.toEqual(catalog);
    await queryClient.refetchQueries({ queryKey: options.queryKey });

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(options.queryKey)).toEqual(catalog);
  });

  it("returns successful catalogs unchanged", async () => {
    const catalog = {
      models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      source: "codex",
      cached: false,
    };
    mockListModels(vi.fn().mockResolvedValue(catalog));
    const options = providerModelsQueryOptions({ provider: "codex", enabled: true });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).resolves.toEqual(catalog);
  });

  it("sets initialData and initialDataUpdatedAt from the persisted cache for a discovery-owned provider", () => {
    const catalog = {
      models: [{ slug: "openai/gpt-5", name: "GPT-5" }],
      source: "opencode",
      cached: false,
    };
    const inputsKey = providerModelCatalogCache.buildCatalogCacheInputsKey(baseInputs);
    providerModelCatalogCache.writeCatalogCache("opencode", inputsKey, catalog);

    const cached = providerModelCatalogCache.readCatalogCacheEntry("opencode", inputsKey);
    expect(cached).toBeDefined();

    const options = providerModelsQueryOptions({
      provider: "opencode",
      ...baseInputs,
      enabled: true,
    });

    expect(typeof options.initialData).toBe("function");
    expect((options.initialData as () => typeof catalog)()).toEqual(catalog);
    expect(options.initialDataUpdatedAt).toBe(cached!.fetchedAt);

    // With a fresh cached entry and staleTime set to Infinity, the observer should
    // hydrate from initialData and never call listModels.
    const listModels = mockListModels(vi.fn().mockResolvedValue(catalog));
    const queryClient = new QueryClient();
    const observer = new QueryObserver(queryClient, {
      ...options,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    const current = observer.getCurrentResult();
    expect(current.isPlaceholderData).toBe(false);
    expect(current.data).toEqual(catalog);
    expect(listModels).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("omits initialData when no persisted cache entry exists", () => {
    const options = providerModelsQueryOptions({
      provider: "opencode",
      ...baseInputs,
      enabled: true,
    });

    expect(options.initialData).toBeUndefined();
    expect(options.initialDataUpdatedAt).toBeUndefined();
  });

  it("writes real-source results to the cache for discovery-owned providers only", async () => {
    const writeCache = vi
      .spyOn(providerModelCatalogCache, "writeCatalogCache")
      .mockImplementation(() => undefined);
    vi.spyOn(providerModelCatalogCache, "readCatalogCacheEntry").mockReturnValue(undefined);

    const opencodeCatalog = {
      models: [{ slug: "openai/gpt-5", name: "GPT-5" }],
      source: "opencode",
      cached: false,
    };
    const opencodeListModels = mockListModels(vi.fn().mockResolvedValue(opencodeCatalog));

    const opencodeOptions = providerModelsQueryOptions({ provider: "opencode", enabled: true });
    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(opencodeOptions)).resolves.toEqual(opencodeCatalog);

    expect(opencodeListModels).toHaveBeenCalledTimes(1);
    expect(writeCache).toHaveBeenCalledTimes(1);
    expect(writeCache).toHaveBeenLastCalledWith(
      "opencode",
      providerModelCatalogCache.buildCatalogCacheInputsKey({}),
      opencodeCatalog,
    );

    vi.clearAllMocks();

    const codexCatalog = {
      models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      source: "codex",
      cached: false,
    };
    const codexListModels = mockListModels(vi.fn().mockResolvedValue(codexCatalog));

    const codexOptions = providerModelsQueryOptions({ provider: "codex", enabled: true });
    await expect(queryClient.fetchQuery(codexOptions)).resolves.toEqual(codexCatalog);

    expect(codexListModels).toHaveBeenCalledTimes(1);
    expect(writeCache).not.toHaveBeenCalled();
  });
});
