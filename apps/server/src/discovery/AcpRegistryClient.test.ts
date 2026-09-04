// Tests the AcpRegistryClient freshness-caching + offline-degradation policy
// (AC #4). The network fetch is injected so no outbound request ever happens;
// the cache write/read uses the real FileSystem under a temp state dir so
// multi-call cache persistence can be observed.
import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { Effect, Layer } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { AcpRegistryClient } from "./AcpRegistryClient.ts";
import { makeAcpRegistryClient } from "./AcpRegistryClient.ts";
import { ACP_REGISTRY_TTL_MS } from "./AcpRegistryClient.ts";
import { decodeAcpRegistryDocument } from "./acpRegistry.ts";
import type { AcpRegistryCatalogResult, AcpRegistrySnapshot } from "./AcpRegistryClient.ts";
import { ServerConfig } from "../config.ts";

const snapshotAt = (version: string, fetchedAt: string): AcpRegistrySnapshot => ({
  document: decodeAcpRegistryDocument({
    version,
    agents: [{ id: `agent-${version}`, name: `Agent ${version}` }],
  }),
  fetchedAt,
});

describe("AcpRegistryClient — freshness caching + offline degradation (AC #4)", () => {
  // One fresh state dir per test (except cache-persistence tests, which opt
  // into a shared dir below). Keeps every test free of cross-test cache bleed.
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  const freshEnvLayer = () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "synara-registry-client-"));
    dirs.push(baseDir);
    return ServerConfig.layerTest(process.cwd(), baseDir).pipe(
      Layer.provideMerge(NodeServices.layer),
    );
  };

  const runGetSnapshot = (
    envLayer: ReturnType<typeof freshEnvLayer>,
    input: {
      readonly fetchNetwork?: () => Effect.Effect<AcpRegistrySnapshot | undefined>;
      readonly now?: () => number;
    },
  ): Effect.Effect<AcpRegistryCatalogResult, PlatformError> =>
    Effect.gen(function* () {
      const svc = yield* AcpRegistryClient;
      return yield* svc.getSnapshot;
    }).pipe(
      Effect.provide(envLayer),
      Effect.provide(
        Layer.succeed(
          AcpRegistryClient,
          makeAcpRegistryClient({
            ...(input.fetchNetwork !== undefined ? { fetchNetwork: input.fetchNetwork } : {}),
            ...(input.now !== undefined ? { now: input.now } : {}),
          }),
        ),
      ),
    );

  it("serves a fresh network snapshot and writes it to the cache", async () => {
    const result = await Effect.runPromise(
      runGetSnapshot(freshEnvLayer(), {
        fetchNetwork: () => Effect.succeed(snapshotAt("1.0.0", "2026-08-16T00:00:00.000Z")),
      }),
    );
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.fromCache).toBe(false);
      expect(result.snapshot.document.version).toBe("1.0.0");
    }
  });

  it("serves fresh cache without a network round-trip while the TTL is unelapsed", async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "synara-registry-client-shared-"));
    dirs.push(baseDir);
    const envLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
      Layer.provideMerge(NodeServices.layer),
    );

    let networkCalls = 0;
    const fetchNetwork = () => {
      networkCalls += 1;
      return Effect.succeed(snapshotAt("2.0.0", "2026-08-16T00:00:00.000Z"));
    };

    // First call populates the cache with fetchedAt = base time.
    const first = await Effect.runPromise(
      runGetSnapshot(envLayer, { fetchNetwork, now: () => Date.parse("2026-08-16T00:00:00.000Z") }),
    );
    expect(first).toMatchObject({ status: "available", fromCache: false });
    expect(networkCalls).toBe(1);

    // Second call within the TTL uses the cache: no network round-trip.
    const second = await Effect.runPromise(
      runGetSnapshot(envLayer, {
        fetchNetwork,
        now: () => Date.parse("2026-08-16T05:00:00.000Z"), // +5h, still < TTL (24h)
      }),
    );
    expect(second).toMatchObject({ status: "available", fromCache: true });
    expect(networkCalls).toBe(1);
  });

  it("re-fetches after the TTL elapses and degrades to the stale cache when offline", async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "synara-registry-client-shared-"));
    dirs.push(baseDir);
    const envLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
      Layer.provideMerge(NodeServices.layer),
    );

    const base = Date.parse("2026-08-16T00:00:00.000Z");
    let current = base;
    const now = () => current;

    // Seed cache at base time.
    const fetchNetwork = () => Effect.succeed(snapshotAt("3.0.0", new Date(current).toISOString()));
    const first = await Effect.runPromise(runGetSnapshot(envLayer, { fetchNetwork, now }));
    expect(first).toMatchObject({ status: "available", fromCache: false });

    // Move past the TTL and make the network fail.
    current = base + ACP_REGISTRY_TTL_MS + 1_000;
    const offlineResult = await Effect.runPromise(
      runGetSnapshot(envLayer, { fetchNetwork: () => Effect.succeed(undefined), now }),
    );
    // Stale-but-cached snapshot still surfaces (offline degradation).
    expect(offlineResult).toMatchObject({ status: "available", fromCache: true });
    expect(offlineResult.status === "available" && offlineResult.snapshot.document.version).toBe(
      "3.0.0",
    );
  });

  it("returns unavailable when there is neither a fresh network snapshot nor a cache", async () => {
    const result = await Effect.runPromise(
      runGetSnapshot(freshEnvLayer(), {
        fetchNetwork: () => Effect.succeed(undefined),
        now: () => Date.parse("2026-08-16T00:00:00.000Z"),
      }),
    );
    expect(result).toMatchObject({ status: "unavailable" });
    expect(result.status === "unavailable" && result.error.length > 0).toBe(true);
  });
});
