// FILE: providerUsage/providers/minimax.test.ts
// Purpose: Covers the MiniMax usage fetcher — auth.json key discovery, model-entry picking,
// window parsing (5h + weekly, status-3 weekly skip), and the HTTP lifecycle (token-plan
// success, coding-plan fallback, rejected key, unusable payload) with a stubbed outbound client.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import {
  minimaxAuthFilePath,
  minimaxUsageFetcher,
  parseMiniMaxUsage,
  pickMiniMaxModelEntry,
  readMinimaxKey,
} from "./minimax";

const NOW_MS = 1_780_000_000_000;

const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-minimax-usage-"));
  tempDirs.push(dir);
  return dir;
}

function writeAuthJson(dataDir: string, record: Record<string, unknown>): void {
  writeFileSync(nodePath.join(dataDir, "auth.json"), JSON.stringify(record), "utf8");
}

function makeCtx(dataDir: string, env: NodeJS.ProcessEnv = {}) {
  return {
    homeDir: nodePath.join(dataDir, "no-home"),
    env: { OPENCODE_DATA_DIR: dataDir, ...env },
    platform: "linux" as const,
    nowMs: NOW_MS,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubOutboundFetch(
  fetchMock: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  vi.spyOn(outboundHttp, "request").mockImplementation(async (input) => {
    const response = await fetchMock(input.url, {
      ...(input.method === undefined ? {} : { method: input.method }),
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
      url: String(input.url),
    };
  });
}

const TOKEN_PLAN_BODY = {
  base_resp: { status_code: 0, status_msg: "success" },
  model_remains: [
    {
      start_time: 1786633200000,
      end_time: 1786651200000,
      remains_time: 17_693_326,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: "general",
      current_interval_status: 1,
      current_interval_remaining_percent: 98,
      current_weekly_status: 3,
      current_weekly_remaining_percent: 100,
    },
    {
      start_time: 1786579200000,
      end_time: 1786665600000,
      model_name: "video",
      current_interval_status: 3,
      current_interval_remaining_percent: 100,
      current_weekly_status: 3,
    },
  ],
};

const CODING_PLAN_BODY = {
  base_resp: { status_code: 0 },
  model_remains: [
    {
      start_time: 1786633200000,
      end_time: 1786651200000,
      remains_time: 9_000_000,
      model_name: "MiniMax-M3",
      current_interval_total_count: 100,
      current_interval_usage_count: 12,
      current_interval_status: 1,
      current_interval_remaining_percent: 88,
      weekly_start_time: 1786320000000,
      weekly_end_time: 1786924800000,
      current_weekly_total_count: 300,
      current_weekly_usage_count: 30,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 90,
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("minimaxAuthFilePath", () => {
  it("resolves under the opencode data directory", () => {
    expect(minimaxAuthFilePath(makeCtx("/custom"))).toBe(nodePath.join("/custom", "auth.json"));
    expect(
      minimaxAuthFilePath(makeCtx("/ignored", { OPENCODE_DATA_DIR: "", XDG_DATA_HOME: "/xdg" })),
    ).toBe(nodePath.join("/xdg", "opencode", "auth.json"));
  });
});

describe("readMinimaxKey", () => {
  it("returns the minimax-coding-plan key", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "minimax-coding-plan": { type: "api", key: "mm-key-123" } });
    expect(await readMinimaxKey(makeCtx(dir))).toBe("mm-key-123");
  });

  it("returns null when the key is absent", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "opencode-go": { type: "api", key: "other" } });
    expect(await readMinimaxKey(makeCtx(dir))).toBeNull();
  });
});

describe("pickMiniMaxModelEntry", () => {
  it("prefers a MiniMax M* model with recorded usage", () => {
    const picked = pickMiniMaxModelEntry([
      { model_name: "general", current_interval_total_count: 0 },
      { model_name: "MiniMax-M3", current_interval_total_count: 42 },
      { model_name: "video" },
    ] as Record<string, unknown>[]);
    expect(picked?.model_name).toBe("MiniMax-M3");
  });

  it("falls back to general/chat/text models", () => {
    const picked = pickMiniMaxModelEntry([
      { model_name: "video" },
      { model_name: "general", current_interval_total_count: 0 },
    ] as Record<string, unknown>[]);
    expect(picked?.model_name).toBe("general");
  });

  it("returns null for an empty list", () => {
    expect(pickMiniMaxModelEntry([])).toBeNull();
  });
});

describe("parseMiniMaxUsage", () => {
  it("maps the token-plan 5h window and skips the inactive weekly window", () => {
    const limits = parseMiniMaxUsage(TOKEN_PLAN_BODY, true);
    expect(limits).toEqual([
      {
        window: "5h",
        usedPercent: 2,
        resetsAt: "2026-08-13T20:00:00.000Z",
        windowDurationMins: 300,
      },
    ]);
  });

  it("maps both windows for a coding-plan tier", () => {
    const limits = parseMiniMaxUsage(CODING_PLAN_BODY, false);
    expect(limits).toEqual([
      {
        window: "5h",
        usedPercent: 12,
        resetsAt: "2026-08-13T20:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        window: "Weekly",
        usedPercent: 10,
        resetsAt: "2026-08-17T00:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("returns [] for errored payloads", () => {
    expect(parseMiniMaxUsage({ base_resp: { status_code: 1301 } }, true)).toEqual([]);
    expect(parseMiniMaxUsage(null, true)).toEqual([]);
  });
});

describe("minimaxUsageFetcher", () => {
  it("uses the token-plan endpoint first", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "minimax-coding-plan": { type: "api", key: "mm-key" } });
    const calledUrls: string[] = [];
    stubOutboundFetch(async (url, init) => {
      calledUrls.push(String(url));
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer mm-key");
      return String(url).includes("token_plan")
        ? jsonResponse(TOKEN_PLAN_BODY)
        : jsonResponse(CODING_PLAN_BODY);
    });
    const snapshot = await minimaxUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Token Plan");
    expect(snapshot.limits).toHaveLength(1);
    expect(calledUrls).toHaveLength(1);
  });

  it("falls back to the coding-plan endpoint", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "minimax-coding-plan": { type: "api", key: "mm-key" } });
    stubOutboundFetch(async (url) =>
      String(url).includes("token_plan")
        ? jsonResponse({ base_resp: { status_code: 1301 } }, 200)
        : jsonResponse(CODING_PLAN_BODY),
    );
    const snapshot = await minimaxUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Coding Plan");
    expect(snapshot.limits).toHaveLength(2);
  });

  it("reports needs-auth when the key is missing", async () => {
    const snapshot = await minimaxUsageFetcher.fetch(makeCtx(makeDataDir()));
    expect(snapshot.status).toBe("needs-auth");
  });

  it("reports needs-auth when the API rejects the key", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "minimax-coding-plan": { type: "api", key: "stale" } });
    stubOutboundFetch(async () => jsonResponse({ error: "unauthorized" }, 401));
    const snapshot = await minimaxUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("needs-auth");
    expect(snapshot.detail).toContain("rejected");
  });

  it("reports error when no endpoint returns usable quota", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "minimax-coding-plan": { type: "api", key: "mm-key" } });
    stubOutboundFetch(async () => jsonResponse({ base_resp: { status_code: 1301 } }, 200));
    const snapshot = await minimaxUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("error");
  });

  it("never throws on transport failure", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "minimax-coding-plan": { type: "api", key: "mm-key" } });
    stubOutboundFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const snapshot = await minimaxUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("error");
  });

  it("cacheKey fingerprints the key and nulls without one", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "minimax-coding-plan": { type: "api", key: "mm-key-123" } });
    const key = await minimaxUsageFetcher.cacheKey?.(makeCtx(dir));
    expect(key).toMatch(/^[A-Za-z0-9_-]{18}$/u);
    expect(await minimaxUsageFetcher.cacheKey?.(makeCtx(makeDataDir()))).toBeNull();
  });
});
