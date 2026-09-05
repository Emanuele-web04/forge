// FILE: providerModelDiscoveryCache.ts
// Purpose: Provider-agnostic model catalog cache shared by every adapter's
//          listModels dispatch. Serves fresh entries instantly, serves stale
//          entries immediately while revalidating in the background, single-
//          flights concurrent discovery per key, applies a hard timeout ceiling,
//          and short-circuits repeated failures so UI retries cannot fan out
//          into CLI/ACP spawn storms.
// Layer: Server provider runtime
// Exports: makeProviderModelDiscoveryCache, ProviderModelDiscoveryCache,
//          providerModelDiscoveryCacheKey, PROVIDER_MODEL_DISCOVERY_* defaults

import type { ProviderListModelsInput, ProviderListModelsResult } from "@synara/contracts";
import { Deferred, Effect, Exit, Option } from "effect";

import { ProviderAdapterRequestError } from "./Errors.ts";

/** A successful catalog is served without touching the adapter for this long. */
export const PROVIDER_MODEL_DISCOVERY_FRESH_TTL_MS = 10 * 60_000;
/**
 * After the fresh window a catalog is still served immediately (marked
 * `cached: true`) while a background revalidation runs. Entries older than
 * this are dropped so a long-uninstalled CLI does not haunt the picker forever.
 */
export const PROVIDER_MODEL_DISCOVERY_STALE_TTL_MS = 24 * 60 * 60_000;
/**
 * A failed or empty discovery is replayed for this long instead of re-spawning
 * the provider. This turns "retry 3 times with backoff" from four process
 * spawns into one.
 */
export const PROVIDER_MODEL_DISCOVERY_FAILURE_TTL_MS = 30_000;
/**
 * Hard ceiling on a single discovery run. Some adapters (Pi, OpenCode CLI) have
 * no internal timeout; this keeps every provider under the 60s WebSocket RPC
 * timeout so the client sees a real error instead of a transport timeout.
 */
export const PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS = 45_000;
export const PROVIDER_MODEL_DISCOVERY_CACHE_MAX_ENTRIES = 64;

export interface ProviderModelDiscoveryCacheKey {
  readonly provider: ProviderListModelsInput["provider"];
  readonly binaryPath: string | null;
  readonly apiEndpoint: string | null;
  readonly agentDir: string | null;
  readonly cwd: string | null;
}

export interface ProviderModelDiscoveryCache<E> {
  /**
   * Resolve a model catalog for `key`, running `discover` only when the cache
   * cannot answer. `discover` always runs detached from the caller so a
   * disconnecting client never aborts a discovery other callers wait on.
   */
  readonly lookup: (
    key: ProviderModelDiscoveryCacheKey,
    discover: Effect.Effect<ProviderListModelsResult, E>,
  ) => Effect.Effect<ProviderListModelsResult, E | ProviderAdapterRequestError>;
  /** Forget every entry (settings changes, tests). */
  readonly clear: () => void;
  /** Number of catalog entries currently retained (tests/diagnostics). */
  readonly size: () => number;
}

interface CatalogEntry {
  readonly result: ProviderListModelsResult;
  readonly storedAt: number;
}

interface FailureEntry {
  readonly exit: Exit.Exit<ProviderListModelsResult, unknown>;
  readonly storedAt: number;
}

type DiscoveryExit<E> = Exit.Exit<ProviderListModelsResult, E | ProviderAdapterRequestError>;

export function providerModelDiscoveryCacheKey(
  input: ProviderListModelsInput,
): ProviderModelDiscoveryCacheKey {
  return {
    provider: input.provider,
    binaryPath: input.binaryPath ?? null,
    apiEndpoint: input.apiEndpoint ?? null,
    agentDir: input.agentDir ?? null,
    cwd: input.cwd ?? null,
  };
}

const serializeKey = (key: ProviderModelDiscoveryCacheKey): string =>
  JSON.stringify([key.provider, key.binaryPath, key.apiEndpoint, key.agentDir, key.cwd]);

/**
 * Only a non-empty, error-free catalog is worth remembering as "good". Static
 * fallbacks that carry `error` (e.g. `devin.static`) and empty lists are
 * replayed briefly as failures so the next real attempt is not delayed by the
 * fresh window.
 */
const isUsableCatalog = (result: ProviderListModelsResult): boolean =>
  result.models.length > 0 && result.error === undefined;

export function makeProviderModelDiscoveryCache<E>(options?: {
  readonly now?: () => number;
  readonly freshTtlMs?: number;
  readonly staleTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly timeoutMs?: number;
  readonly maxEntries?: number;
}): ProviderModelDiscoveryCache<E> {
  const now = options?.now ?? (() => Date.now());
  const freshTtlMs = options?.freshTtlMs ?? PROVIDER_MODEL_DISCOVERY_FRESH_TTL_MS;
  const staleTtlMs = options?.staleTtlMs ?? PROVIDER_MODEL_DISCOVERY_STALE_TTL_MS;
  const failureTtlMs = options?.failureTtlMs ?? PROVIDER_MODEL_DISCOVERY_FAILURE_TTL_MS;
  const timeoutMs = options?.timeoutMs ?? PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS;
  const maxEntries = options?.maxEntries ?? PROVIDER_MODEL_DISCOVERY_CACHE_MAX_ENTRIES;

  const catalogs = new Map<string, CatalogEntry>();
  const failures = new Map<string, FailureEntry>();
  const inflight = new Map<string, Deferred.Deferred<ProviderListModelsResult, unknown>>();

  const readCatalog = (serialized: string, at: number): CatalogEntry | undefined => {
    const entry = catalogs.get(serialized);
    if (entry === undefined) return undefined;
    if (at - entry.storedAt > staleTtlMs) {
      catalogs.delete(serialized);
      return undefined;
    }
    return entry;
  };

  const readFailure = (serialized: string, at: number): FailureEntry | undefined => {
    const entry = failures.get(serialized);
    if (entry === undefined) return undefined;
    if (at - entry.storedAt > failureTtlMs) {
      failures.delete(serialized);
      return undefined;
    }
    return entry;
  };

  const storeCatalog = (serialized: string, result: ProviderListModelsResult, at: number) => {
    failures.delete(serialized);
    // Re-insert so Map iteration order doubles as an LRU order.
    catalogs.delete(serialized);
    catalogs.set(serialized, { result: { ...result, cached: false }, storedAt: at });
    while (catalogs.size > maxEntries) {
      const oldest = catalogs.keys().next().value;
      if (oldest === undefined) break;
      catalogs.delete(oldest);
    }
  };

  const storeFailure = (
    serialized: string,
    exit: Exit.Exit<ProviderListModelsResult, unknown>,
    at: number,
  ) => {
    failures.set(serialized, { exit, storedAt: at });
    while (failures.size > maxEntries) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
  };

  const applyExit = (serialized: string, exit: DiscoveryExit<E>) => {
    const at = now();
    if (Exit.isSuccess(exit) && isUsableCatalog(exit.value)) {
      storeCatalog(serialized, exit.value, at);
      return;
    }
    // An error-free empty response is authoritative: do not keep offering
    // models the provider has removed. Replay it briefly before rediscovery.
    if (Exit.isSuccess(exit) && exit.value.error === undefined) {
      catalogs.delete(serialized);
    }
    storeFailure(serialized, exit, at);
  };

  /**
   * Start (or join) the single in-flight discovery for `serialized`. The work
   * runs on a detached fiber so it outlives the requesting RPC and so every
   * concurrent caller observes the same exit.
   */
  const startDiscovery = (
    key: ProviderModelDiscoveryCacheKey,
    serialized: string,
    discover: Effect.Effect<ProviderListModelsResult, E>,
  ): Effect.Effect<Deferred.Deferred<ProviderListModelsResult, unknown>> =>
    Effect.gen(function* () {
      const existing = inflight.get(serialized);
      if (existing !== undefined) return existing;
      const deferred = yield* Deferred.make<ProviderListModelsResult, unknown>();
      inflight.set(serialized, deferred);
      const run = discover.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: key.provider,
                  method: "models/list",
                  detail: `Model discovery timed out after ${Math.round(timeoutMs / 1000)}s.`,
                }),
              ),
        ),
        Effect.exit,
        Effect.flatMap((exit) => {
          inflight.delete(serialized);
          applyExit(serialized, exit as DiscoveryExit<E>);
          return Deferred.done(deferred, exit);
        }),
      );
      yield* Effect.forkDetach(run);
      return deferred;
    });

  const awaitDiscovery = (
    deferred: Deferred.Deferred<ProviderListModelsResult, unknown>,
  ): Effect.Effect<ProviderListModelsResult, E | ProviderAdapterRequestError> =>
    Deferred.await(deferred) as Effect.Effect<
      ProviderListModelsResult,
      E | ProviderAdapterRequestError
    >;

  const lookup: ProviderModelDiscoveryCache<E>["lookup"] = (key, discover) =>
    Effect.gen(function* () {
      const serialized = serializeKey(key);
      const at = now();
      const entry = readCatalog(serialized, at);
      const failure = readFailure(serialized, at);
      if (entry !== undefined) {
        if (at - entry.storedAt <= freshTtlMs) {
          return { ...entry.result, cached: true };
        }
        // Stale-while-revalidate: answer now, refresh behind the caller.
        if (failure === undefined) {
          yield* startDiscovery(key, serialized, discover);
        }
        return { ...entry.result, cached: true };
      }
      const pending = inflight.get(serialized);
      if (pending !== undefined) {
        return yield* awaitDiscovery(pending);
      }
      if (failure !== undefined) {
        return yield* failure.exit as DiscoveryExit<E>;
      }
      const deferred = yield* startDiscovery(key, serialized, discover);
      return yield* awaitDiscovery(deferred);
    });

  return {
    lookup,
    clear: () => {
      catalogs.clear();
      failures.clear();
    },
    size: () => catalogs.size,
  };
}
