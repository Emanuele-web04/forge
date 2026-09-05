// FILE: providerDiscoveryReactQuery.test.ts
// Purpose: Locks provider model discovery query semantics — admission, retry policy,
//          stale-catalog preservation, and initial-vs-background pending (#103).
// Layer: Web data fetching tests

import type { NativeApi, ProviderListModelsResult } from "@synara/contracts";
import { hashKey, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isInitialModelDiscoveryPending,
  prioritizeProviderModelDiscovery,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";
import * as nativeApi from "../nativeApi";

function mockListModels(listModels: ReturnType<typeof vi.fn>) {
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    provider: { listModels },
  } as unknown as NativeApi);
  return listModels;
}

afterEach(() => {
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

  it("fails fast only for Cursor and retries transient Droid discovery", () => {
    expect(providerModelsQueryOptions({ provider: "codex" }).retry).toBe(3);
    const devinOptions = providerModelsQueryOptions({ provider: "devin" });
    expect(devinOptions.retry).toBe(3);
    expect(typeof devinOptions.staleTime).toBe("function");
    expect(providerModelsQueryOptions({ provider: "droid" }).retry).toBe(2);
    expect(providerModelsQueryOptions({ provider: "droid" }).staleTime).toBe(5 * 60_000);
    expect(providerModelsQueryOptions({ provider: "cursor" }).retry).toBe(0);
    expect(providerModelsQueryOptions({ provider: "cursor" }).staleTime).toBe(30_000);
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

  it("serializes different provider catalogs before they reach native admission", async () => {
    let activeDiscoveries = 0;
    let maxActiveDiscoveries = 0;
    const releases: Array<() => void> = [];
    const listModels = mockListModels(
      vi.fn().mockImplementation(async ({ provider }: { provider: string }) => {
        activeDiscoveries += 1;
        maxActiveDiscoveries = Math.max(maxActiveDiscoveries, activeDiscoveries);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeDiscoveries -= 1;
        return {
          models: [{ slug: `${provider}-dynamic`, name: `${provider} dynamic` }],
          source: `${provider}.dynamic`,
          cached: false,
        };
      }),
    );
    const queryClient = new QueryClient();
    const requests = (["opencode", "pi", "devin"] as const).map((provider) =>
      queryClient.fetchQuery(providerModelsQueryOptions({ provider })),
    );

    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await Promise.all(requests);

    expect(maxActiveDiscoveries).toBe(1);
  });

  it("keeps every active pane selection ahead of speculative prefetch", async () => {
    let releaseCurrent: (() => void) | undefined;
    const listModels = mockListModels(
      vi.fn().mockImplementation(
        ({ provider }: { provider: string }) =>
          new Promise((resolve) => {
            releaseCurrent = () =>
              resolve({
                models: [{ slug: `${provider}-dynamic`, name: `${provider} dynamic` }],
                source: `${provider}.dynamic`,
                cached: false,
              });
          }),
      ),
    );
    const queryClient = new QueryClient();
    const activeOptions = providerModelsQueryOptions({ provider: "opencode" });
    const firstPaneOptions = providerModelsQueryOptions({ provider: "cursor" });
    const secondPaneOptions = providerModelsQueryOptions({ provider: "pi" });
    const hoverOptions = providerModelsQueryOptions({ provider: "devin" });
    const requests = [
      queryClient.fetchQuery(activeOptions),
      queryClient.fetchQuery(firstPaneOptions),
      queryClient.fetchQuery(secondPaneOptions),
      queryClient.fetchQuery(hoverOptions),
    ];

    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    const releaseFirstPane = prioritizeProviderModelDiscovery(firstPaneOptions.queryKey);
    const releaseSecondPane = prioritizeProviderModelDiscovery(secondPaneOptions.queryKey);
    prioritizeProviderModelDiscovery(hoverOptions.queryKey, "prefetch");
    releaseCurrent?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    expect(listModels.mock.calls[1]?.[0]).toMatchObject({ provider: "pi" });
    releaseCurrent?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(3));
    expect(listModels.mock.calls[2]?.[0]).toMatchObject({ provider: "cursor" });
    releaseCurrent?.();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(4));
    expect(listModels.mock.calls[3]?.[0]).toMatchObject({ provider: "devin" });
    releaseCurrent?.();
    await Promise.all(requests);
    releaseFirstPane?.();
    releaseSecondPane?.();
  });

  it.each([false, true])(
    "releases obsolete selections (all shared owners released: %s)",
    async (releaseAll) => {
      let releaseActive: (() => void) | undefined;
      const catalog = {
        models: [{ slug: "auto", name: "Auto" }],
        source: "runtime",
        cached: false,
      };
      const listModels = mockListModels(
        vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                releaseActive = () => resolve(catalog);
              }),
          )
          .mockResolvedValue(catalog),
      );
      const client = new QueryClient();
      const active = client.fetchQuery(providerModelsQueryOptions({ provider: "codex" }));
      await vi.waitFor(() => expect(releaseActive).toBeDefined());
      const abandoned = providerModelsQueryOptions({ provider: "cursor" });
      const shared = providerModelsQueryOptions({ provider: "pi" });
      const hover = providerModelsQueryOptions({ provider: "devin", priority: "prefetch" });
      const releaseAbandoned = prioritizeProviderModelDiscovery(abandoned.queryKey);
      const releaseSharedA = prioritizeProviderModelDiscovery(shared.queryKey);
      const releaseSharedB = prioritizeProviderModelDiscovery(shared.queryKey);
      // Ownership predates enqueue: a prefetch for the shared key still belongs
      // to the active pane even if its fetch options say background.
      const requests = [
        active,
        client.fetchQuery(abandoned),
        client.fetchQuery(shared),
        client.fetchQuery(hover),
      ];
      releaseAbandoned?.();
      releaseSharedA?.();
      if (releaseAll) releaseSharedB?.();
      releaseActive?.();
      await Promise.all(requests);
      expect(listModels.mock.calls.map(([input]) => input.provider)).toEqual(
        releaseAll ? ["codex", "devin", "cursor", "pi"] : ["codex", "pi", "devin", "cursor"],
      );
      releaseSharedB?.();
      client.clear();
    },
  );

  it("skips a queued catalog when its inactive prefetch is cancelled", async () => {
    let releaseFirst: (() => void) | undefined;
    const listModels = mockListModels(
      vi.fn().mockImplementation(
        ({ provider }: { provider: string }) =>
          new Promise((resolve) => {
            if (provider !== "opencode") {
              throw new Error(`Unexpected stale discovery for ${provider}`);
            }
            releaseFirst = () =>
              resolve({
                models: [{ slug: "opencode-dynamic", name: "OpenCode Dynamic" }],
                source: "opencode",
                cached: false,
              });
          }),
      ),
    );
    const queryClient = new QueryClient();
    const firstOptions = providerModelsQueryOptions({ provider: "opencode", cwd: "/first" });
    const staleOptions = providerModelsQueryOptions({ provider: "pi", cwd: "/stale" });
    const firstRequest = queryClient.fetchQuery(firstOptions);

    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    const staleRequest = queryClient.fetchQuery(staleOptions).then(
      () => "resolved",
      () => "cancelled",
    );
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(staleOptions.queryKey)?.fetchStatus).toBe("fetching"),
    );
    await queryClient.cancelQueries({ queryKey: staleOptions.queryKey, exact: true });
    releaseFirst?.();

    await expect(firstRequest).resolves.toMatchObject({ source: "opencode" });
    await expect(staleRequest).resolves.toBe("cancelled");
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("keeps an initial Devin fallback usable but immediately stale for recovery", async () => {
    const degraded = {
      models: [{ slug: "sonnet", name: "Sonnet" }],
      source: "devin.static",
      cached: false,
      error: "Devin CLI temporarily failed",
    };
    const listModels = mockListModels(vi.fn().mockResolvedValue(degraded));
    const options = providerModelsQueryOptions({ provider: "devin" });
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).resolves.toEqual(degraded);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(options.queryKey)).toEqual(degraded);

    const staleTime = options.staleTime as (query: {
      state: { data: ProviderListModelsResult };
    }) => number;
    const refetchInterval = options.refetchInterval as (query: {
      state: { data: ProviderListModelsResult };
    }) => number | false;
    expect(staleTime({ state: { data: degraded } })).toBe(0);
    expect(refetchInterval({ state: { data: degraded } })).toBe(30_000);
    const healthy = {
      models: [{ slug: "custom-devin-model", name: "Custom Devin Model" }],
      source: "devin-cli",
      cached: false,
    };
    expect(staleTime({ state: { data: healthy } })).toBe(30_000);
    expect(refetchInterval({ state: { data: healthy } })).toBe(false);
  });

  it.each([
    ["opencode", "opencode"],
    ["opencode", "opencode-cli"],
    ["pi", "pi.sdk"],
    ["pi", "pi.sdk+extensions"],
  ] as const)("accepts an authoritative empty %s catalog from %s", async (provider, source) => {
    const listModels = mockListModels(
      vi.fn().mockResolvedValue({ models: [], source, cached: false }),
    );
    const options = { ...providerModelsQueryOptions({ provider }), retry: 0 };
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).resolves.toEqual({
      models: [],
      source,
      cached: false,
    });
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("rejects an unexplained empty runtime catalog instead of caching it", async () => {
    const listModels = mockListModels(
      vi.fn().mockResolvedValue({ models: [], source: "antigravity.cli", cached: false }),
    );
    const options = { ...providerModelsQueryOptions({ provider: "antigravity" }), retry: 0 };
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "antigravity model discovery returned no models",
    );
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
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

  it("preserves a cached dynamic catalog when refresh returns a degraded fallback", async () => {
    const catalog = {
      models: [{ slug: "custom-devin-model", name: "Custom Devin Model" }],
      source: "devin-cli",
      cached: false,
    };
    const degraded = {
      models: [{ slug: "sonnet", name: "Sonnet" }],
      source: "devin.static",
      cached: false,
      error: "Devin CLI temporarily failed",
    };
    const listModels = mockListModels(
      vi.fn().mockResolvedValueOnce(catalog).mockResolvedValueOnce(degraded),
    );
    const options = { ...providerModelsQueryOptions({ provider: "devin" }), retry: 0 };
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).resolves.toEqual(catalog);
    await queryClient.refetchQueries({ queryKey: options.queryKey });

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(options.queryKey)).toEqual(catalog);
    expect(queryClient.getQueryState(options.queryKey)?.error).toEqual(
      new Error("Devin CLI temporarily failed"),
    );
    const interval = options.refetchInterval;
    if (typeof interval !== "function") throw new Error("Expected recovery polling");
    const query = queryClient
      .getQueryCache()
      .get<
        ProviderListModelsResult,
        Error,
        ProviderListModelsResult,
        Parameters<typeof interval>[0]["queryKey"]
      >(hashKey(options.queryKey));
    if (!query) throw new Error("Missing Devin query");
    expect(interval(query)).toBe(30_000);
    listModels.mockResolvedValue(catalog);
    await queryClient.refetchQueries({ queryKey: options.queryKey });
    expect(queryClient.getQueryData(options.queryKey)).toEqual(catalog);
    expect(query.state.error).toBeNull();
    expect(interval(query)).toBe(false);
    queryClient.clear();
  });

  it("returns successful catalogs unchanged", async () => {
    const catalog = {
      models: [
        {
          slug: "openai/gpt-5.5",
          name: "GPT-5.5",
          upstreamProviderId: "openai",
          supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
          defaultReasoningEffort: "medium",
          supportsFastMode: true,
        },
      ],
      source: "pi.sdk",
      cached: false,
    };
    mockListModels(vi.fn().mockResolvedValue(catalog));
    const options = providerModelsQueryOptions({ provider: "pi", enabled: true });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).resolves.toEqual(catalog);
  });
});
