// FILE: providerUsage/index.test.ts
// Purpose: Covers the orchestration layer's snapshot cache — TTL reuse, single-flight coalescing
// of concurrent requests, forceRefresh bypass, and the shorter expiry for degraded snapshots —
// so UI surfaces polling in parallel can't stampede the provider fetchers.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerProviderUsageSnapshot } from "@synara/contracts";

import { ServerConfig } from "../config";
import { ServerSettingsService } from "../serverSettings";
import {
  __resetProviderUsageCacheForTests,
  collectProviderUsageSnapshots,
  listProviderUsage,
} from "./index";
import type { ProviderUsageContext, ProviderUsageFetcher } from "./types";

const fetchMock = vi.fn<(ctx: ProviderUsageContext) => Promise<ServerProviderUsageSnapshot>>();
const cacheKeyMock = vi.fn<(ctx: ProviderUsageContext) => Promise<string>>();

vi.mock("./registry", () => ({
  PROVIDER_USAGE_FETCHERS: {
    codex: {
      provider: "codex",
      cacheKey: (ctx: ProviderUsageContext) => cacheKeyMock(ctx),
      fetch: (ctx: ProviderUsageContext) => fetchMock(ctx),
    } satisfies ProviderUsageFetcher,
  },
}));

const NOW_MS = 1_780_000_000_000;

function makeCtx(nowMs: number, account = "account-a"): ProviderUsageContext {
  return {
    homeDir: "/nonexistent-home",
    env: { TEST_USAGE_ACCOUNT: account },
    platform: "linux",
    nowMs,
  };
}

function okSnapshot(nowMs: number, source = "live"): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    updatedAt: new Date(nowMs).toISOString(),
    limits: [],
    usageLines: [],
    source,
    status: "ok",
  };
}

beforeEach(() => {
  __resetProviderUsageCacheForTests();
  fetchMock.mockReset();
  cacheKeyMock.mockReset();
  cacheKeyMock.mockImplementation(async (ctx) => ctx.env.TEST_USAGE_ACCOUNT ?? "account-a");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectProviderUsageSnapshots caching", () => {
  it("serves a fresh snapshot from cache without re-fetching", async () => {
    fetchMock.mockResolvedValue(okSnapshot(NOW_MS));

    const first = await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const second = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 60_000));

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cache TTL expires", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const later = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 6 * 60_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(later[0]?.updatedAt).toBe(new Date(NOW_MS + 6 * 60_000).toISOString());
  });

  it("coalesces concurrent requests into a single fetch", async () => {
    let release: (snapshot: ServerProviderUsageSnapshot) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<ServerProviderUsageSnapshot>((resolve) => (release = resolve)),
    );

    const firstPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const secondPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(okSnapshot(NOW_MS));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("bypasses the TTL on forceRefresh", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const refreshed = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), {
      forceRefresh: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed[0]?.updatedAt).toBe(new Date(NOW_MS + 1_000).toISOString());
  });

  it("joins an in-flight refresh instead of serving the previous cached snapshot", async () => {
    fetchMock.mockResolvedValueOnce(okSnapshot(NOW_MS, "cached"));
    await collectProviderUsageSnapshots(makeCtx(NOW_MS));

    let release: (snapshot: ServerProviderUsageSnapshot) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<ServerProviderUsageSnapshot>((resolve) => (release = resolve)),
    );
    const refreshPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), {
      forceRefresh: true,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const pollPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS + 2_000));
    release(okSnapshot(NOW_MS + 1_000, "refreshed"));
    const [refreshed, polled] = await Promise.all([refreshPromise, pollPromise]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed[0]?.source).toBe("refreshed");
    expect(polled).toEqual(refreshed);
  });

  it("invalidates a fresh snapshot when the selected credentials change", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs, ctx.env.TEST_USAGE_ACCOUNT));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS, "account-a"));
    const switched = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000, "account-b"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(switched[0]?.source).toBe("account-b");
  });

  it("does not cache a snapshot when credentials change during the fetch", async () => {
    let account = "account-a";
    let release: (snapshot: ServerProviderUsageSnapshot) => void = () => {};
    cacheKeyMock.mockImplementation(async () => account);
    fetchMock.mockImplementationOnce(
      () => new Promise<ServerProviderUsageSnapshot>((resolve) => (release = resolve)),
    );

    const firstPromise = collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    account = "account-b";
    release(okSnapshot(NOW_MS, "account-a"));
    await firstPromise;

    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs, account));
    const second = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second[0]?.source).toBe("account-b");
  });

  it("expires degraded snapshots faster than healthy ones", async () => {
    fetchMock.mockImplementation(async (ctx) => ({
      ...okSnapshot(ctx.nowMs),
      status: "error",
      detail: "Usage fetch failed unexpectedly.",
    }));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    // Within the degraded TTL: still served from cache.
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 30_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Past the degraded TTL (but well within the healthy one): re-fetched.
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 90_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a fresh healthy cache entry when a refresh fails", async () => {
    fetchMock.mockResolvedValueOnce(okSnapshot(NOW_MS, "healthy")).mockResolvedValueOnce({
      ...okSnapshot(NOW_MS + 1_000, "failed-refresh"),
      status: "error",
      detail: "Usage fetch failed unexpectedly.",
    });

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    const failedRefresh = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), {
      forceRefresh: true,
    });
    const polled = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 2_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failedRefresh[0]?.source).toBe("healthy");
    expect(polled[0]?.source).toBe("healthy");
  });

  it("replaces a healthy cache entry when refresh discovers authentication is required", async () => {
    fetchMock.mockResolvedValueOnce(okSnapshot(NOW_MS, "healthy")).mockResolvedValueOnce({
      ...okSnapshot(NOW_MS + 1_000, "auth-required"),
      status: "needs-auth",
    });

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), { forceRefresh: true });
    const polled = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 2_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(polled[0]?.source).toBe("auth-required");
  });

  it("expires a stale refresh instead of restoring the previous healthy cache entry", async () => {
    fetchMock
      .mockResolvedValueOnce(okSnapshot(NOW_MS, "healthy"))
      .mockResolvedValueOnce({ ...okSnapshot(NOW_MS + 1_000, "throttled"), stale: true })
      .mockResolvedValueOnce(okSnapshot(NOW_MS + 2_000, "recovered"));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000), { forceRefresh: true });
    const polled = await collectProviderUsageSnapshots(makeCtx(NOW_MS + 2_000));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(polled[0]?.source).toBe("recovered");
  });

  it("does not retain stale snapshots in the outer cache", async () => {
    fetchMock.mockImplementation(async (ctx) => ({ ...okSnapshot(ctx.nowMs), stale: true }));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 1_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("expires needs-auth snapshots on the degraded TTL", async () => {
    fetchMock.mockImplementation(async (ctx) => ({
      ...okSnapshot(ctx.nowMs),
      status: "needs-auth",
    }));

    await collectProviderUsageSnapshots(makeCtx(NOW_MS));
    await collectProviderUsageSnapshots(makeCtx(NOW_MS + 90_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("omits disabled providers and invalidates their cached snapshots", async () => {
    fetchMock.mockImplementation(async (ctx) => okSnapshot(ctx.nowMs));
    const configLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
      Layer.provide(NodeServices.layer),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      configLayer,
      ServerSettingsService.layerTest(),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        const first = yield* listProviderUsage({});

        yield* serverSettings.updateSettings({ providers: { codex: { enabled: false } } });
        const disabled = yield* listProviderUsage({ forceRefresh: true });

        yield* serverSettings.updateSettings({ providers: { codex: { enabled: true } } });
        const reenabled = yield* listProviderUsage({});
        return { first, disabled, reenabled };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(result.first).toHaveLength(1);
    expect(result.disabled).toEqual([]);
    expect(result.reenabled).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
