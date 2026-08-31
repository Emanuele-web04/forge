// FILE: providerUsage/index.ts
// Purpose: Orchestrate the live provider-usage fetchers — defensive batch fetch (one failure never
// blocks the others), per-provider snapshot caching with single-flight coalescing, and enrichment
// of Codex/Claude live snapshots with the locally-derived token-total usage lines. Exposes both a
// plain async API (for tests) and an Effect that reads ServerConfig (for the WS RPC handler).

import type {
  ProviderKind,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { Effect } from "effect";

import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";

import { ServerConfig } from "../config";
import { buildProviderChildEnvironment, type ProviderChildKind } from "../providerChildEnvironment";
import { ServerSettingsService } from "../serverSettings";
import { loadLocalProviderUsageLines } from "../providerUsageSnapshot";
import { errorSnapshot } from "./parse";
import { PROVIDER_USAGE_FETCHERS } from "./registry";
import type { ProviderUsageContext } from "./types";

// Providers whose live snapshot is enriched with on-disk token-total lines (24h/7d/30d).
const LOCAL_ARCHIVE_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["codex", "claudeAgent"]);

const providerChildKind = (provider: ProviderKind): ProviderChildKind =>
  provider === "claudeAgent" ? "claude" : provider;

function buildContext(): ProviderUsageContext {
  return {
    homeDir: "",
    env: process.env,
    platform: process.platform,
    nowMs: Date.now(),
  };
}

async function fetchProviderUsage(
  provider: ProviderKind,
  providerContext: ProviderUsageContext,
): Promise<ServerProviderUsageSnapshot | null> {
  const fetcher = PROVIDER_USAGE_FETCHERS[provider];
  if (!fetcher) {
    return null;
  }

  return fetcher
    .fetch(providerContext)
    .catch(() =>
      errorSnapshot(
        provider,
        providerContext.nowMs,
        "live-usage",
        "Usage fetch failed unexpectedly.",
      ),
    );
}

function buildProviderContext(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
): ProviderUsageContext {
  return {
    ...ctx,
    env: buildProviderChildEnvironment({
      provider: providerChildKind(provider),
      baseEnv: ctx.env,
    }),
  };
}

// Every UI surface (header chip, branch toolbar, settings panel) plus their periodic refetches
// funnels through this cache, so one browser tab doesn't hammer provider endpoints — or spawn
// `claude auth status` processes — once per surface. Fresh snapshots are served from memory,
// concurrent requests for the same provider coalesce into a single fetch, and `forceRefresh`
// (the settings panel's explicit refresh button) bypasses the TTL but still joins an in-flight
// fetch. Degraded snapshots (errors, re-served last-good data) expire faster so recovery is
// picked up quickly. Keyed by ProviderKind, so the cache is inherently bounded.
const SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_CACHE_DEGRADED_TTL_MS = 60 * 1000;

interface CachedSnapshot {
  snapshot: ServerProviderUsageSnapshot;
  fetchedAtMs: number;
  credentialKey: string;
}

interface InFlightSnapshot {
  credentialKey: string;
  promise: Promise<ServerProviderUsageSnapshot | null>;
}

const snapshotCache = new Map<ProviderKind, CachedSnapshot>();
const inFlightFetches = new Map<ProviderKind, InFlightSnapshot>();
const snapshotCacheGenerations = new Map<ProviderKind, number>();

const snapshotCacheTtlMs = (snapshot: ServerProviderUsageSnapshot): number =>
  snapshot.stale === true
    ? 0
    : (snapshot.status ?? "ok") === "error" || (snapshot.status ?? "ok") === "needs-auth"
      ? SNAPSHOT_CACHE_DEGRADED_TTL_MS
      : SNAPSHOT_CACHE_TTL_MS;

async function resolveCredentialKey(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
): Promise<string | null> {
  const fetcher = PROVIDER_USAGE_FETCHERS[provider];
  if (!fetcher?.cacheKey) {
    return provider;
  }
  try {
    return await fetcher.cacheKey(ctx);
  } catch {
    return null;
  }
}

/** Test-only: drop the snapshot cache and any in-flight coalescing state. */
export function __resetProviderUsageCacheForTests(): void {
  snapshotCache.clear();
  inFlightFetches.clear();
  snapshotCacheGenerations.clear();
}

function invalidateProviderUsageSnapshots(providers: ReadonlyArray<ProviderKind>): void {
  for (const provider of providers) {
    snapshotCache.delete(provider);
    inFlightFetches.delete(provider);
    snapshotCacheGenerations.set(provider, (snapshotCacheGenerations.get(provider) ?? 0) + 1);
  }
}

async function getProviderUsageSnapshot(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
  forceRefresh: boolean,
): Promise<ServerProviderUsageSnapshot | null> {
  const cacheGeneration = snapshotCacheGenerations.get(provider) ?? 0;
  const providerContext = buildProviderContext(provider, ctx);
  const credentialKey = await resolveCredentialKey(provider, providerContext);
  const pending = inFlightFetches.get(provider);
  if (credentialKey !== null && pending?.credentialKey === credentialKey) {
    return pending.promise;
  }

  if (!forceRefresh && credentialKey !== null) {
    const cached = snapshotCache.get(provider);
    if (
      cached &&
      cached.credentialKey === credentialKey &&
      ctx.nowMs - cached.fetchedAtMs < snapshotCacheTtlMs(cached.snapshot)
    ) {
      return cached.snapshot;
    }
  }

  const fetchPromise = (async () => {
    const snapshot = await fetchProviderUsage(provider, providerContext);
    const enriched = snapshot ? await enrichWithLocalUsage(snapshot, ctx) : null;
    const refreshedCredentialKey = await resolveCredentialKey(provider, providerContext);
    if (
      enriched &&
      credentialKey !== null &&
      refreshedCredentialKey === credentialKey &&
      (snapshotCacheGenerations.get(provider) ?? 0) === cacheGeneration
    ) {
      const current = snapshotCache.get(provider);
      const hasFreshHealthySnapshot =
        current?.credentialKey === credentialKey &&
        snapshotCacheTtlMs(current.snapshot) === SNAPSHOT_CACHE_TTL_MS &&
        ctx.nowMs - current.fetchedAtMs < SNAPSHOT_CACHE_TTL_MS;
      const fetchedFailedSnapshot = (enriched.status ?? "ok") === "error";
      if (fetchedFailedSnapshot && hasFreshHealthySnapshot && current) {
        return current.snapshot;
      }
      snapshotCache.set(provider, {
        snapshot: enriched,
        fetchedAtMs: ctx.nowMs,
        credentialKey,
      });
    }
    return enriched;
  })();
  if (credentialKey !== null) {
    inFlightFetches.set(provider, { credentialKey, promise: fetchPromise });
  }
  try {
    return await fetchPromise;
  } finally {
    if (inFlightFetches.get(provider)?.promise === fetchPromise) {
      inFlightFetches.delete(provider);
    }
  }
}

async function enrichWithLocalUsage(
  snapshot: ServerProviderUsageSnapshot,
  ctx: ProviderUsageContext,
): Promise<ServerProviderUsageSnapshot> {
  if ((snapshot.status ?? "ok") !== "ok" || !LOCAL_ARCHIVE_PROVIDERS.has(snapshot.provider)) {
    return snapshot;
  }
  const localLines = await loadLocalProviderUsageLines({
    provider: snapshot.provider,
    homeDir: ctx.homeDir,
  });
  if (localLines.length === 0) {
    return snapshot;
  }
  return { ...snapshot, usageLines: [...snapshot.usageLines, ...localLines] };
}

/** Plain async batch fetch for supported providers. Never throws. */
export async function collectProviderUsageSnapshots(
  ctx: ProviderUsageContext,
  options: {
    forceRefresh?: boolean;
    provider?: ProviderKind;
    providers?: ReadonlyArray<ProviderKind>;
  } = {},
): Promise<ServerProviderUsageSnapshot[]> {
  const providers = options.provider
    ? ([options.provider] as ProviderKind[])
    : options.providers
      ? [...options.providers]
      : PROVIDER_USAGE_PROVIDERS.filter(
          (provider) => PROVIDER_USAGE_FETCHERS[provider] !== undefined,
        );
  const settled = await Promise.allSettled(
    providers.map((provider) =>
      getProviderUsageSnapshot(provider, ctx, options.forceRefresh === true),
    ),
  );

  return settled
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter((snapshot): snapshot is ServerProviderUsageSnapshot => snapshot !== null);
}

export const listProviderUsage = Effect.fn(function* (input: ServerListProviderUsageInput) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const supportedProviders = PROVIDER_USAGE_PROVIDERS.filter(
    (provider) => PROVIDER_USAGE_FETCHERS[provider] !== undefined,
  );
  const enabledProviders = supportedProviders.filter(
    (provider) => settings.providers[provider].enabled,
  );
  invalidateProviderUsageSnapshots(
    supportedProviders.filter((provider) => !settings.providers[provider].enabled),
  );

  if (input.provider && !settings.providers[input.provider].enabled) {
    return [];
  }

  return yield* Effect.tryPromise({
    try: () =>
      collectProviderUsageSnapshots(
        {
          ...buildContext(),
          homeDir: serverConfig.homeDir,
          claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
        },
        {
          forceRefresh: input.forceRefresh === true,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(!input.provider ? { providers: enabledProviders } : {}),
        },
      ),
    catch: () => [] as unknown as ServerListProviderUsageResult,
  });
});
