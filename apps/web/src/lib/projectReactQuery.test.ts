import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import {
  isLocalPreviewGrantUsable,
  LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS,
  localPreviewGrantRefetchIntervalMs,
  projectLocalPreviewGrantQueryOptions,
  projectQueryKeys,
  projectReadFileQueryOptions,
  refetchFreshProjectFileQuery,
  projectSearchEntriesQueryOptions,
} from "./projectReactQuery";

describe("local preview grant query options", () => {
  it("refreshes active preview grants before the server-side token expires", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs + 120_000).toISOString() },
        nowMs,
      ),
    ).toBe(LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS);
    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs + 20_000).toISOString() },
        nowMs,
      ),
    ).toBe(5_000);
    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs - 1_000).toISOString() },
        nowMs,
      ),
    ).toBe(1_000);
  });

  it("does not treat expired cached grants as usable preview URLs", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(
      isLocalPreviewGrantUsable({ expiresAt: new Date(nowMs + 2_000).toISOString() }, nowMs),
    ).toBe(true);
    expect(
      isLocalPreviewGrantUsable({ expiresAt: new Date(nowMs + 500).toISOString() }, nowMs),
    ).toBe(false);
  });

  it("wires the refresh interval into the React Query options", () => {
    const options = projectLocalPreviewGrantQueryOptions({ path: "/Users/me/Downloads/shot.png" });
    const refetchInterval = options.refetchInterval;

    expect(typeof refetchInterval).toBe("function");
    if (typeof refetchInterval !== "function") {
      throw new Error("Expected refetchInterval to be a function.");
    }
    expect(
      refetchInterval({
        state: { data: { grant: "grant-token", expiresAt: "not-a-date" } },
      } as never),
    ).toBe(LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project read file capacity retry", () => {
  const capacityError = {
    code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
    retryable: true,
    retryAfterMs: 375,
  };

  it("does not stack query-level capacity retries on top of transport", () => {
    const options = projectReadFileQueryOptions({
      cwd: "/repo",
      relativePath: "src/app.ts",
    });
    expect(options.retry).toBe(false);
    expect(typeof options.refetchInterval).toBe("function");
    if (typeof options.refetchInterval !== "function") {
      throw new Error("Expected error-only refetchInterval on projectReadFileQueryOptions.");
    }

    expect(
      options.refetchInterval({ state: { error: capacityError, errorUpdateCount: 1 } } as never),
    ).toBe(375);
    expect(
      options.refetchInterval({ state: { error: capacityError, errorUpdateCount: 2 } } as never),
    ).toBe(750);
    expect(options.refetchInterval({ state: { error: null } } as never)).toBe(false);
    expect(options.refetchInterval({ state: { error: new Error("ENOENT") } } as never)).toBe(false);
  });

  it("aborts an in-flight read when the query is cancelled", async () => {
    let seenSignal: AbortSignal | undefined;
    const readFile = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
      seenSignal = options?.signal;
      return new Promise(() => undefined);
    });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      projects: { readFile },
    } as unknown as NativeApi);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchPromise = queryClient.fetchQuery(
      projectReadFileQueryOptions({ cwd: "/repo", relativePath: "src/app.ts" }),
    );
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    expect(seenSignal?.aborted).toBe(false);

    await queryClient.cancelQueries({
      queryKey: projectQueryKeys.readFile("/repo", "src/app.ts"),
    });

    expect(seenSignal?.aborted).toBe(true);
    await expect(fetchPromise).rejects.toBeDefined();
    queryClient.clear();
  });

  it("cancels a cold in-flight read before revalidating an active file query", async () => {
    let firstSignal: AbortSignal | undefined;
    const readFile = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
      if (readFile.mock.calls.length === 1) {
        firstSignal = options?.signal;
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(firstSignal?.reason), {
            once: true,
          });
        });
      }
      return Promise.resolve({
        relativePath: "src/app.ts",
        contents: "fresh\n",
        truncated: false,
        version: null,
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      });
    });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      projects: { readFile },
    } as unknown as NativeApi);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const options = projectReadFileQueryOptions({ cwd: "/repo", relativePath: "src/app.ts" });
    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => undefined);

    try {
      await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      await refetchFreshProjectFileQuery(queryClient, {
        cwd: "/repo",
        relativePath: "src/app.ts",
      });

      expect(firstSignal?.aborted).toBe(true);
      expect(readFile).toHaveBeenCalledTimes(2);
      expect(queryClient.getQueryData(options.queryKey)).toMatchObject({ contents: "fresh\n" });
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it("coalesces a watcher event into a manual refresh and waits for the newest read", async () => {
    const seenSignals: AbortSignal[] = [];
    const readFile = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
      const call = readFile.mock.calls.length;
      const signal = options?.signal;
      if (signal) seenSignals.push(signal);
      if (call < 3) {
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      return Promise.resolve({
        relativePath: "src/app.ts",
        contents: "newest\n",
        truncated: false,
        version: null,
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      });
    });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      projects: { readFile },
    } as unknown as NativeApi);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const options = projectReadFileQueryOptions({ cwd: "/repo", relativePath: "src/app.ts" });
    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => undefined);

    try {
      await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      const manualRefresh = refetchFreshProjectFileQuery(queryClient, {
        cwd: "/repo",
        relativePath: "src/app.ts",
      });
      await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
      const watcherRefresh = refetchFreshProjectFileQuery(queryClient, {
        cwd: "/repo",
        relativePath: "src/app.ts",
      });

      expect(watcherRefresh).toBe(manualRefresh);
      await Promise.all([manualRefresh, watcherRefresh]);
      expect(readFile).toHaveBeenCalledTimes(3);
      expect(seenSignals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
      expect(queryClient.getQueryData(options.queryKey)).toMatchObject({ contents: "newest\n" });
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});

describe("project search capacity retry", () => {
  const capacityError = {
    code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
    retryable: true,
    retryAfterMs: 375,
  };

  it("retries generic search failures without stacking capacity retries", () => {
    const options = projectSearchEntriesQueryOptions({ cwd: "/repo", query: "app" });
    expect(typeof options.retry).toBe("function");
    if (typeof options.retry !== "function") {
      throw new Error("Expected retry on projectSearchEntriesQueryOptions.");
    }
    expect(options.retry(0, capacityError as never)).toBe(false);
    expect(options.retry(0, new Error("network"))).toBe(true);
    expect(options.retry(3, new Error("network"))).toBe(false);
  });
});
