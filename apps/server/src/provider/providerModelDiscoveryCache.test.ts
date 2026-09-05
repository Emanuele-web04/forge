// FILE: providerModelDiscoveryCache.test.ts
// Purpose: Locks the shared model discovery cache semantics: fresh hits,
//          stale-while-revalidate, single-flight, project isolation, failure
//          replay, the timeout ceiling, and detachment from caller interrupts.
// Layer: Server provider tests

import type { ProviderListModelsResult } from "@synara/contracts";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderAdapterRequestError } from "./Errors.ts";
import {
  makeProviderModelDiscoveryCache,
  type ProviderModelDiscoveryCacheKey,
} from "./providerModelDiscoveryCache.ts";

const KEY: ProviderModelDiscoveryCacheKey = {
  provider: "opencode",
  binaryPath: "/bin/opencode",
  apiEndpoint: null,
  agentDir: null,
  cwd: "/repo/a",
};

const CATALOG: ProviderListModelsResult = {
  models: [{ slug: "gpt-5", name: "GPT-5" }],
  source: "opencode-cli",
  cached: false,
};

const failure = (detail: string) =>
  new ProviderAdapterRequestError({ provider: "opencode", method: "models/list", detail });

function makeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("makeProviderModelDiscoveryCache", () => {
  it("serves a fresh catalog without re-running discovery", async () => {
    const clock = makeClock();
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({
      now: clock.now,
    });
    let calls = 0;
    const discover = Effect.sync(() => {
      calls += 1;
      return CATALOG;
    });

    const first = await Effect.runPromise(cache.lookup(KEY, discover));
    clock.advance(60_000);
    const second = await Effect.runPromise(cache.lookup(KEY, discover));

    expect(first).toEqual({ ...CATALOG, cached: false });
    expect(second).toEqual({ ...CATALOG, cached: true });
    expect(calls).toBe(1);
  });

  it("serves a stale catalog immediately and revalidates in the background", async () => {
    const clock = makeClock();
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({
      now: clock.now,
      freshTtlMs: 1_000,
    });
    const refreshed: ProviderListModelsResult = {
      models: [{ slug: "gpt-6", name: "GPT-6" }],
      source: "opencode-cli",
      cached: false,
    };
    let calls = 0;
    const discover = Effect.sync(() => {
      calls += 1;
      return calls === 1 ? CATALOG : refreshed;
    });

    await Effect.runPromise(cache.lookup(KEY, discover));
    clock.advance(5_000);
    const stale = await Effect.runPromise(cache.lookup(KEY, discover));
    await flush();
    const afterRefresh = await Effect.runPromise(cache.lookup(KEY, discover));

    expect(stale.models).toEqual(CATALOG.models);
    expect(stale.cached).toBe(true);
    expect(afterRefresh.models).toEqual(refreshed.models);
    expect(calls).toBe(2);
  });

  it("single-flights concurrent discovery for the same key", async () => {
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>();
    const gate = Deferred.makeUnsafe<void>();
    let calls = 0;
    const discover = Effect.gen(function* () {
      calls += 1;
      yield* Deferred.await(gate);
      return CATALOG;
    });

    const results = Effect.runPromise(
      Effect.all([cache.lookup(KEY, discover), cache.lookup(KEY, discover)], {
        concurrency: "unbounded",
      }),
    );
    await flush();
    Deferred.doneUnsafe(gate, Effect.void);
    const [first, second] = await results;

    expect(calls).toBe(1);
    expect(first.models).toEqual(CATALOG.models);
    expect(second.models).toEqual(CATALOG.models);
  });

  it.each([false, true])("isolates a new cwd for concurrent callers (fails: %s)", async (fails) => {
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>();
    await Effect.runPromise(cache.lookup(KEY, Effect.succeed(CATALOG)));
    const gate = Deferred.makeUnsafe<void>();
    const otherCatalog = { ...CATALOG, models: [{ slug: "project-b", name: "Project B" }] };
    let calls = 0;
    let completed = 0;
    const discover = Effect.gen(function* () {
      calls += 1;
      yield* Deferred.await(gate);
      return yield* fails
        ? Effect.fail(failure("project B unavailable"))
        : Effect.succeed(otherCatalog);
    });
    const lookup = () =>
      Effect.runPromiseExit(cache.lookup({ ...KEY, cwd: "/repo/b" }, discover)).then((exit) => {
        completed += 1;
        return exit;
      });
    const first = lookup();
    await flush();
    const second = lookup();
    await flush();
    const completedBeforeDiscovery = completed;
    Deferred.doneUnsafe(gate, Effect.void);
    const results = await Promise.all([first, second]);

    expect(completedBeforeDiscovery).toBe(0);
    expect(calls).toBe(1);
    for (const result of results) {
      expect(Exit.isFailure(result)).toBe(fails);
      if (Exit.isSuccess(result)) expect(result.value).toEqual(otherCatalog);
    }
  });

  it("does not reuse a catalog from a different binary path", async () => {
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>();
    let calls = 0;
    const discover = Effect.sync(() => {
      calls += 1;
      return CATALOG;
    });

    await Effect.runPromise(cache.lookup(KEY, discover));
    const other = await Effect.runPromise(
      cache.lookup({ ...KEY, binaryPath: "/other/opencode" }, discover),
    );

    expect(other.cached).toBe(false);
    expect(calls).toBe(2);
  });

  it("replays a failure briefly instead of re-spawning discovery", async () => {
    const clock = makeClock();
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({
      now: clock.now,
      failureTtlMs: 1_000,
    });
    let calls = 0;
    const discover = Effect.suspend(() => {
      calls += 1;
      return Effect.fail(failure("opencode missing"));
    });

    const first = await Effect.runPromiseExit(cache.lookup(KEY, discover));
    const replayed = await Effect.runPromiseExit(cache.lookup(KEY, discover));
    clock.advance(2_000);
    await Effect.runPromiseExit(cache.lookup(KEY, discover));

    expect(Exit.isFailure(first)).toBe(true);
    expect(Exit.isFailure(replayed)).toBe(true);
    expect(calls).toBe(2);
  });

  it("replays error-tagged catalogs briefly before retrying", async () => {
    const clock = makeClock();
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({
      now: clock.now,
      failureTtlMs: 1_000,
    });
    const degraded: ProviderListModelsResult = {
      models: [{ slug: "static", name: "Static" }],
      source: "devin.static",
      cached: false,
      error: "Devin CLI failed",
    };
    let calls = 0;
    const discover = Effect.sync(() => {
      calls += 1;
      return calls === 1 ? degraded : CATALOG;
    });

    const first = await Effect.runPromise(cache.lookup(KEY, discover));
    const replayed = await Effect.runPromise(cache.lookup(KEY, discover));
    clock.advance(2_000);
    const recovered = await Effect.runPromise(cache.lookup(KEY, discover));

    expect(first.error).toBe("Devin CLI failed");
    expect(replayed.error).toBe("Devin CLI failed");
    expect(calls).toBe(2);
    expect(recovered.models).toEqual(CATALOG.models);
    expect(cache.size()).toBe(1);
  });

  it.each(["rejected", "degraded"])(
    "honors cooldown after a %s refresh with a stale catalog",
    async (kind) => {
      const clock = makeClock();
      const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({
        now: clock.now,
        freshTtlMs: 1_000,
        failureTtlMs: 10_000,
      });
      let calls = 0;
      const discover = Effect.suspend(() => {
        calls += 1;
        if (calls === 1) return Effect.succeed(CATALOG);
        return kind === "rejected"
          ? Effect.fail(failure("flaky"))
          : Effect.succeed({ ...CATALOG, models: [], error: "flaky" });
      });

      await Effect.runPromise(cache.lookup(KEY, discover));
      clock.advance(5_000);
      await Effect.runPromise(cache.lookup(KEY, discover));
      await flush();
      const results = await Effect.runPromise(
        Effect.all([cache.lookup(KEY, discover), cache.lookup(KEY, discover)], {
          concurrency: "unbounded",
        }),
      );
      await flush();
      expect(results).toEqual(Array(2).fill({ ...CATALOG, cached: true }));
      expect(calls).toBe(2);

      clock.advance(10_001);
      await Effect.runPromise(cache.lookup(KEY, discover));
      await flush();
      expect(calls).toBe(3);
    },
  );

  it("replaces a stale catalog with an authoritative empty response and replays it briefly", async () => {
    const clock = makeClock();
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({
      now: clock.now,
      freshTtlMs: 1_000,
      failureTtlMs: 10_000,
    });
    const empty = { ...CATALOG, models: [] };
    let calls = 0;
    const discover = Effect.sync(() => {
      calls += 1;
      return calls === 2 ? empty : CATALOG;
    });
    await Effect.runPromise(cache.lookup(KEY, discover));
    clock.advance(5_000);
    await Effect.runPromise(cache.lookup(KEY, discover));
    await flush();
    const results = await Effect.runPromise(
      Effect.all([cache.lookup(KEY, discover), cache.lookup(KEY, discover)], {
        concurrency: "unbounded",
      }),
    );
    expect(results).toEqual([empty, empty]);
    expect(cache.size()).toBe(0);
    expect(calls).toBe(2);

    clock.advance(10_001);
    expect(await Effect.runPromise(cache.lookup(KEY, discover))).toEqual(CATALOG);
    expect(calls).toBe(3);
  });

  it("fails with a request error when discovery exceeds the timeout ceiling", async () => {
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({
      timeoutMs: 10,
    });
    const discover = Effect.never as Effect.Effect<
      ProviderListModelsResult,
      ProviderAdapterRequestError
    >;

    const exit = await Effect.runPromiseExit(cache.lookup(KEY, discover));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("timed out");
    }
  });

  it("completes discovery for other waiters when the first caller is interrupted", async () => {
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>();
    const gate = Deferred.makeUnsafe<void>();
    let calls = 0;
    const discover = Effect.gen(function* () {
      calls += 1;
      yield* Deferred.await(gate);
      return CATALOG;
    });

    const firstFiber = Effect.runFork(cache.lookup(KEY, discover));
    await flush();
    const second = Effect.runPromise(cache.lookup(KEY, discover));
    await flush();
    await Effect.runPromise(Fiber.interrupt(firstFiber));
    Deferred.doneUnsafe(gate, Effect.void);

    await expect(second).resolves.toMatchObject({ models: CATALOG.models });
    expect(calls).toBe(1);
    expect(cache.size()).toBe(1);
  });

  it("evicts the least recently stored catalogs beyond maxEntries", async () => {
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({ maxEntries: 2 });
    const discover = Effect.succeed(CATALOG);

    await Effect.runPromise(cache.lookup({ ...KEY, cwd: "/1" }, discover));
    await Effect.runPromise(cache.lookup({ ...KEY, cwd: "/2" }, discover));
    await Effect.runPromise(cache.lookup({ ...KEY, cwd: "/3" }, discover));
    await flush();

    expect(cache.size()).toBe(2);
  });
});
