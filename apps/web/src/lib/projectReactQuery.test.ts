import { describe, expect, it } from "vitest";

import {
  isLocalPreviewGrantUsable,
  LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS,
  localPreviewGrantRefetchIntervalMs,
  projectLocalPreviewGrantQueryOptions,
  projectReadFileQueryOptions,
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

describe("project read file capacity retry", () => {
  const capacityError = {
    code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
    retryable: true,
    retryAfterMs: 375,
  };

  it("honors retryAfterMs and self-heals only while the read is in a capacity error", () => {
    const options = projectReadFileQueryOptions({
      cwd: "/repo",
      relativePath: "src/app.ts",
    });
    expect(typeof options.retry).toBe("function");
    expect(typeof options.retryDelay).toBe("function");
    expect(typeof options.refetchInterval).toBe("function");
    if (
      typeof options.retry !== "function" ||
      typeof options.retryDelay !== "function" ||
      typeof options.refetchInterval !== "function"
    ) {
      throw new Error("Expected capacity retry options on projectReadFileQueryOptions.");
    }

    expect(options.retry(0, capacityError as never)).toBe(true);
    expect(options.retry(12, capacityError as never)).toBe(false);
    expect(options.retry(0, new Error("Workspace file not found"))).toBe(false);
    expect(options.retryDelay(0, capacityError as never)).toBe(375);
    expect(options.refetchInterval({ state: { error: capacityError } } as never)).toBe(375);
    expect(options.refetchInterval({ state: { error: null } } as never)).toBe(false);
    expect(options.refetchInterval({ state: { error: new Error("ENOENT") } } as never)).toBe(false);
  });
});
