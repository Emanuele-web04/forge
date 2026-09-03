// FILE: providerDiscoveryReactQuery.test.ts
// Purpose: Locks provider model discovery query semantics — admission, retry policy,
//          stale-catalog preservation, and initial-vs-background pending (#103).
// Layer: Web data fetching tests

import type { NativeApi } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isInitialModelDiscoveryPending,
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
    expect(providerModelsQueryOptions({ provider: "devin" }).retry).toBe(3);
    expect(providerModelsQueryOptions({ provider: "devin" }).staleTime).toBe(30_000);
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

  it("retries degraded static fallbacks instead of caching them as discoveries", async () => {
    const degraded = {
      models: [{ slug: "sonnet", name: "Sonnet" }],
      source: "devin.static",
      cached: false,
      error: "Devin CLI temporarily failed",
    };
    const dynamic = {
      models: [{ slug: "custom-devin-model", name: "Custom Devin Model" }],
      source: "devin-cli",
      cached: false,
    };
    const listModels = mockListModels(
      vi.fn().mockResolvedValueOnce(degraded).mockResolvedValueOnce(dynamic),
    );
    const options = {
      ...providerModelsQueryOptions({ provider: "devin" }),
      retry: 1,
      retryDelay: 0,
    };
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).resolves.toEqual(dynamic);
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(options.queryKey)).toEqual(dynamic);
  });

  it("rejects an unexplained empty catalog instead of caching it", async () => {
    const listModels = mockListModels(
      vi.fn().mockResolvedValue({ models: [], source: "pi.sdk", cached: false }),
    );
    const options = { ...providerModelsQueryOptions({ provider: "pi" }), retry: 0 };
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "pi model discovery returned no models",
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
