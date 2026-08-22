// FILE: providerUsage/providers/opencode.test.ts
// Purpose: Covers OpenCode Go auth discovery on Windows XDG paths and the /zen/go/v1/usage parser.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";

import { opencodeUsageFetcher, parseOpenCodeGoUsage } from "./opencode";

const NOW_MS = 1_780_000_000_000;
const tempDirs: string[] = [];

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

function makeHome(relativeAuthPath: string, auth: Record<string, unknown>) {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-opencode-usage-"));
  tempDirs.push(homeDir);
  const authPath = nodePath.join(homeDir, ...relativeAuthPath.split("/"));
  mkdirSync(nodePath.dirname(authPath), { recursive: true });
  writeFileSync(authPath, JSON.stringify(auth), "utf8");
  return homeDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseOpenCodeGoUsage", () => {
  it("maps rolling, weekly, and monthly Go windows", () => {
    const snapshot = parseOpenCodeGoUsage({
      json: {
        usage: {
          rolling: { status: "ok", percent: 9, resetsAt: "2026-08-14T07:20:04.810Z" },
          weekly: { status: "ok", percent: 12, resetsAt: "2026-08-17T00:00:00.810Z" },
          monthly: { status: "ok", percent: 6, resetsAt: "2026-09-09T00:41:03.810Z" },
        },
      },
      nowMs: NOW_MS,
    });
    expect(snapshot.planName).toBe("Go");
    expect(snapshot.limits.map((limit) => [limit.window, limit.usedPercent])).toEqual([
      ["5h", 9],
      ["Weekly", 12],
      ["Monthly", 6],
    ]);
  });
});

describe("opencodeUsageFetcher", () => {
  it("returns needs-auth when no OpenCode auth.json exists", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-opencode-empty-"));
    tempDirs.push(homeDir);
    const snapshot = await opencodeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "win32",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("needs-auth");
  });

  it("finds OpenCode Go auth on the Windows XDG path, not only %APPDATA%", async () => {
    const homeDir = makeHome(".local/share/opencode/auth.json", {
      "opencode-go": { type: "api", key: "sk-opencode-test" },
    });
    stubOutboundFetch(async (url, init) => {
      expect(String(url)).toBe("https://opencode.ai/zen/go/v1/usage");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer sk-opencode-test",
      );
      return jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 20, resetsAt: "2026-08-20T00:00:00Z" },
          weekly: { status: "ok", percent: 40, resetsAt: "2026-08-24T00:00:00Z" },
        },
      });
    });

    const snapshot = await opencodeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "win32",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Go");
    expect(snapshot.limits[0]).toMatchObject({ window: "5h", usedPercent: 20 });
  });

  it("still shows a connected card when auth.json has no OpenCode Go key", async () => {
    const homeDir = makeHome(".local/share/opencode/auth.json", {
      custom1: { type: "api", key: "sk-other" },
    });
    const snapshot = await opencodeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "win32",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([]);
    expect(snapshot.usageLines[0]?.value).toContain("OpenCode Go");
  });

  it("finds OpenCode Go auth on Linux and macOS at ~/.local/share", async () => {
    const homeDir = makeHome(".local/share/opencode/auth.json", {
      "opencode-go": { type: "api", key: "sk-opencode-linux" },
    });
    stubOutboundFetch(async () =>
      jsonResponse({
        usage: { rolling: { status: "ok", percent: 5, resetsAt: "2026-08-20T00:00:00Z" } },
      }),
    );
    for (const platform of ["linux", "darwin"] as const) {
      const snapshot = await opencodeUsageFetcher.fetch({
        homeDir,
        env: {},
        platform,
        nowMs: NOW_MS,
      });
      expect(snapshot.status).toBe("ok");
      expect(snapshot.planName).toBe("Go");
    }
  });

  it("still finds a Windows login that only exists under %APPDATA%", async () => {
    const homeDir = makeHome("AppData/Roaming/opencode/auth.json", {
      "opencode-go": { type: "api", key: "sk-opencode-appdata" },
    });
    stubOutboundFetch(async (url, init) => {
      expect(String(url)).toBe("https://opencode.ai/zen/go/v1/usage");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer sk-opencode-appdata",
      );
      return jsonResponse({
        usage: { rolling: { status: "ok", percent: 11, resetsAt: "2026-08-20T00:00:00Z" } },
      });
    });
    const snapshot = await opencodeUsageFetcher.fetch({
      homeDir,
      env: { APPDATA: nodePath.join(homeDir, "AppData", "Roaming") },
      platform: "win32",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits[0]).toMatchObject({ window: "5h", usedPercent: 11 });
  });
});
