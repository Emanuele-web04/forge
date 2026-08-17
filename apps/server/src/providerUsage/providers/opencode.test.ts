// FILE: providerUsage/providers/opencode.test.ts
// Purpose: Covers the OpenCode Go usage fetcher — data-directory resolution, auth.json
// parsing, and the usage API lifecycle (ok meters, rejected key, no subscription, transport
// and parse failures). The HTTP layer is stubbed; auth.json fixtures live in temp dirs.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import {
  opencodeAuthFilePath,
  opencodeUsageFetcher,
  parseOpenCodeGoUsage,
  readOpenCodeGoKey,
} from "./opencode";

const NOW_MS = 1_780_000_000_000;

const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-opencode-usage-"));
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

const OK_BODY = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-08-13T15:45:38.284Z" },
    weekly: { status: "ok", percent: 7, resetsAt: "2026-08-17T00:00:00.284Z" },
    monthly: { status: "ok", percent: 13, resetsAt: "2026-09-02T20:35:22.284Z" },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("opencodeAuthFilePath", () => {
  it("prefers OPENCODE_DATA_DIR", () => {
    const ctx = makeCtx("/custom");
    expect(opencodeAuthFilePath(ctx)).toBe(nodePath.join("/custom", "auth.json"));
  });

  it("falls back to XDG_DATA_HOME/opencode", () => {
    const ctx = makeCtx("/ignored", { OPENCODE_DATA_DIR: "", XDG_DATA_HOME: "/xdg" });
    expect(opencodeAuthFilePath(ctx)).toBe(nodePath.join("/xdg", "opencode", "auth.json"));
  });

  it("falls back to ~/.local/share/opencode", () => {
    const ctx = makeCtx("/ignored", { OPENCODE_DATA_DIR: "", XDG_DATA_HOME: "" });
    expect(opencodeAuthFilePath(ctx)).toBe(
      nodePath.join(ctx.homeDir, ".local", "share", "opencode", "auth.json"),
    );
  });
});

describe("readOpenCodeGoKey", () => {
  it("returns the opencode-go key", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "opencode-go": { type: "api", key: "go-key-123" } });
    expect(await readOpenCodeGoKey(makeCtx(dir))).toBe("go-key-123");
  });

  it("returns null when the file is missing or unreadable", async () => {
    const dir = makeDataDir();
    expect(await readOpenCodeGoKey(makeCtx(dir))).toBeNull();
  });

  it("returns null when the go key is absent", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "minimax-coding-plan": { type: "api", key: "other" } });
    expect(await readOpenCodeGoKey(makeCtx(dir))).toBeNull();
  });
});

describe("parseOpenCodeGoUsage", () => {
  it("maps rolling/weekly/monthly windows to limits", () => {
    const limits = parseOpenCodeGoUsage(OK_BODY);
    expect(limits).toEqual([
      {
        window: "5h",
        usedPercent: 0,
        resetsAt: "2026-08-13T15:45:38.284Z",
        windowDurationMins: 300,
      },
      {
        window: "Weekly",
        usedPercent: 7,
        resetsAt: "2026-08-17T00:00:00.284Z",
        windowDurationMins: 10_080,
      },
      {
        window: "Monthly",
        usedPercent: 13,
        resetsAt: "2026-09-02T20:35:22.284Z",
        windowDurationMins: 43_200,
      },
    ]);
  });

  it("drops malformed windows and clamps percents", () => {
    const limits = parseOpenCodeGoUsage({
      usage: {
        rolling: { percent: 250, resetsAt: "2026-08-13T15:45:38.284Z" },
        weekly: { percent: "7", resetsAt: "2026-08-17T00:00:00.284Z" },
        monthly: { status: "error" },
      },
    });
    expect(limits).toEqual([
      {
        window: "5h",
        usedPercent: 100,
        resetsAt: "2026-08-13T15:45:38.284Z",
        windowDurationMins: 300,
      },
      {
        window: "Weekly",
        usedPercent: 7,
        resetsAt: "2026-08-17T00:00:00.284Z",
        windowDurationMins: 10_080,
      },
    ]);
  });

  it("returns [] for non-object payloads", () => {
    expect(parseOpenCodeGoUsage(null)).toEqual([]);
    expect(parseOpenCodeGoUsage({ noUsage: true })).toEqual([]);
  });
});

describe("opencodeUsageFetcher", () => {
  it("returns Go meters on a successful API call", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "opencode-go": { type: "api", key: "go-key-123" } });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://opencode.ai/zen/go/v1/usage");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer go-key-123");
      return jsonResponse(OK_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Go");
    expect(snapshot.limits).toHaveLength(3);
    expect(snapshot.limits[1]).toMatchObject({ window: "Weekly", usedPercent: 7 });
  });

  it("reports needs-auth when the key is missing", async () => {
    const dir = makeDataDir();
    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("needs-auth");
    expect(snapshot.limits).toEqual([]);
  });

  it("reports needs-auth when the API rejects the key", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "opencode-go": { type: "api", key: "stale-key" } });
    stubOutboundFetch(async () => jsonResponse({ error: "invalid key" }, 401));
    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("needs-auth");
    expect(snapshot.detail).toContain("rejected");
  });

  it("reports unsupported when the key has no Go subscription", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "opencode-go": { type: "api", key: "zen-only-key" } });
    stubOutboundFetch(async () => jsonResponse({ error: "EntitlementError" }, 403));
    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("unsupported");
    expect(snapshot.detail).toContain("no active Go subscription");
  });

  it("reports error on transport failure", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "opencode-go": { type: "api", key: "go-key" } });
    stubOutboundFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("error");
  });

  it("reports error when the response has no usable windows", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "opencode-go": { type: "api", key: "go-key" } });
    stubOutboundFetch(async () => jsonResponse({ usage: { rolling: { status: "error" } } }));
    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("error");
    expect(snapshot.detail).toContain("no usage windows");
  });

  it("never throws on unexpected payloads", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "opencode-go": { type: "api", key: "go-key" } });
    stubOutboundFetch(async () => jsonResponse("<html>proxy error</html>", 502));
    const snapshot = await opencodeUsageFetcher.fetch(makeCtx(dir));
    expect(snapshot.status).toBe("error");
  });

  it("cacheKey fingerprints the key and nulls without one", async () => {
    const dir = makeDataDir();
    writeAuthJson(dir, { "opencode-go": { type: "api", key: "go-key-123" } });
    const key = await opencodeUsageFetcher.cacheKey?.(makeCtx(dir));
    expect(key).toMatch(/^[A-Za-z0-9_-]{18}$/u);

    const emptyDir = makeDataDir();
    expect(await opencodeUsageFetcher.cacheKey?.(makeCtx(emptyDir))).toBeNull();
  });
});
