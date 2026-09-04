// FILE: AcpRegistryClient.ts
// Purpose: Fetches the upstream ACP Registry over the pinned outbound HTTP
//          boundary, validates it, and serves it with freshness caching +
//          offline degradation. NEVER a Synara-owned registry: the only
//          allowed network origin is the canonical CDN URL below.
// Layer: Server discovery
// Depends on: outboundHttp (shared security boundary), ServerConfig (stateDir).
import { Effect, FileSystem, Layer, Option, Path, ServiceMap } from "effect";

import { decodeOutboundJson, outboundHttp } from "@synara/shared/outboundHttp";
import { ServerConfig } from "../config.ts";
import { decodeAcpRegistryDocument, type AcpRegistryDocument } from "./acpRegistry.ts";

/**
 * The canonical upstream registry. Never fork it; this is the single allowed
 * source URL (stop/escalate rule in KAR-525).
 */
export const ACP_REGISTRY_SOURCE_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/**
 * Registry freshness window. Within this window a cached snapshot is served
 * without a network round-trip; past it we re-fetch and fall back to the cache
 * when the network is unavailable (offline degradation, AC #4).
 */
export const ACP_REGISTRY_TTL_MS = 24 * 60 * 60 * 1_000;

/** Hard bounds for the untrusted upstream document. */
const ACP_REGISTRY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ACP_REGISTRY_MAX_JSON_DEPTH = 32;
const ACP_REGISTRY_MAX_JSON_NODES = 100_000;

export interface AcpRegistrySnapshot {
  readonly document: AcpRegistryDocument;
  readonly fetchedAt: string;
}

export type AcpRegistryCatalogResult =
  | {
      readonly status: "available";
      readonly snapshot: AcpRegistrySnapshot;
      /** True when served from the local cache because the TTL had not elapsed. */
      readonly fromCache: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly error: string;
    };

export interface AcpRegistryClientShape {
  /** Best-effort catalog snapshot; never fails (offline degrades). */
  readonly getSnapshot: Effect.Effect<
    AcpRegistryCatalogResult,
    never,
    FileSystem.FileSystem | Path.Path | ServerConfig
  >;
}

export class AcpRegistryClient extends ServiceMap.Service<
  AcpRegistryClient,
  AcpRegistryClientShape
>()("synara/discovery/AcpRegistryClient") {}

const registryCachePath = () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return path.join(config.stateDir, "acp-registry.json");
  });

const readCachedSnapshot = (): Effect.Effect<
  AcpRegistrySnapshot | undefined,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cachePath = yield* registryCachePath();
    const content = yield* fileSystem
      .readFileString(cachePath)
      .pipe(Effect.option, Effect.map(Option.getOrUndefined));
    if (content === undefined) return undefined;
    try {
      const parsed = JSON.parse(content) as {
        _synara?: { fetchedAt?: unknown };
        version?: unknown;
        agents?: unknown;
      };
      const document = decodeAcpRegistryDocument(parsed);
      const fetchedAt =
        typeof parsed._synara?.fetchedAt === "string"
          ? parsed._synara.fetchedAt
          : new Date(0).toISOString();
      return { document, fetchedAt };
    } catch {
      return undefined;
    }
  });

const writeCachedSnapshot = (snapshot: AcpRegistrySnapshot) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cachePath = yield* registryCachePath();
    const payload = JSON.stringify({
      _synara: { fetchedAt: snapshot.fetchedAt },
      ...(snapshot.document as object),
    });
    yield* fileSystem
      .writeFileString(cachePath, payload)
      .pipe(Effect.orElseSucceed(() => undefined));
  });

const fetchNetworkSnapshot = (): Effect.Effect<AcpRegistrySnapshot | undefined> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      outboundHttp.request({
        url: ACP_REGISTRY_SOURCE_URL,
        policy: {
          service: "acp-registry",
          allowedOrigins: [new URL(ACP_REGISTRY_SOURCE_URL).origin],
          timeoutMs: 10_000,
          maxRequestBytes: 0,
          maxResponseBytes: ACP_REGISTRY_MAX_RESPONSE_BYTES,
          maxRedirects: 2,
          maxConcurrent: 4,
          maxQueued: 8,
          requirePublicAddress: true,
        },
        headers: { Accept: "application/json" },
      }),
    ).pipe(Effect.option);
    const okResponse = Option.getOrUndefined(response);
    if (okResponse === undefined || okResponse.status < 200 || okResponse.status >= 300) {
      return undefined;
    }
    const decoded = yield* Effect.try({
      try: () =>
        decodeOutboundJson(okResponse, {
          maxDepth: ACP_REGISTRY_MAX_JSON_DEPTH,
          maxNodes: ACP_REGISTRY_MAX_JSON_NODES,
        }),
      catch: () => undefined,
    }).pipe(Effect.option);
    const json = Option.getOrUndefined(decoded);
    if (json === undefined) return undefined;
    const document = yield* Effect.try({
      try: () => decodeAcpRegistryDocument(json),
      catch: () => undefined,
    }).pipe(Effect.option);
    const doc = Option.getOrUndefined(document);
    if (doc === undefined) return undefined;
    return { document: doc, fetchedAt: new Date().toISOString() };
  });

export interface AcpRegistryClientOptions {
  /**
   * Injectable network fetch used by tests. Defaults to the real pinned
   * outbound HTTP fetch of `ACP_REGISTRY_SOURCE_URL`. When omitted in tests,
   * network calls are never made; only TTL/offline behavior is exercised.
   */
  readonly fetchNetwork?: () => Effect.Effect<AcpRegistrySnapshot | undefined>;
  /** Injectable clock (milliseconds since epoch) for TTL tests. Defaults to Date.now. */
  readonly now?: () => number;
}

export const makeAcpRegistryClient = (options: AcpRegistryClientOptions = {}) => {
  const fetchNetwork = options.fetchNetwork ?? fetchNetworkSnapshot;
  const now = options.now ?? Date.now;

  const getSnapshot: AcpRegistryClientShape["getSnapshot"] = Effect.gen(function* () {
    const cached = yield* readCachedSnapshot();
    if (cached !== undefined && now() - Date.parse(cached.fetchedAt) < ACP_REGISTRY_TTL_MS) {
      return { status: "available", snapshot: cached, fromCache: true };
    }

    const refreshed = yield* fetchNetwork().pipe(Effect.option);
    const snapshot = Option.getOrUndefined(refreshed);
    if (snapshot !== undefined) {
      yield* writeCachedSnapshot(snapshot);
      return { status: "available", snapshot, fromCache: false };
    }

    if (cached !== undefined) {
      return { status: "available", snapshot: cached, fromCache: true };
    }

    return {
      status: "unavailable",
      error: "Unable to load the ACP Registry (network unavailable and no cached copy).",
    };
  });

  return { getSnapshot } satisfies AcpRegistryClientShape;
};

export const AcpRegistryClientLive = Layer.succeed(AcpRegistryClient, makeAcpRegistryClient());
