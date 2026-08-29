import type { NativeApi } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import {
  isLocalPreviewGrantUsable,
  LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS,
  localPreviewGrantRefetchIntervalMs,
  projectLocalPreviewGrantQueryOptions,
  projectQueryKeys,
  projectReadFileQueryOptions,
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
