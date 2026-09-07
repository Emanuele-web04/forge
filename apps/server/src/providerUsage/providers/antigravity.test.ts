// FILE: providerUsage/providers/antigravity.test.ts
// Purpose: Covers Antigravity/agy OAuth files, Google refresh write-back, and Cloud Code quota.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import * as credentials from "../credentials";

import { antigravityUsageFetcher, parseAntigravityQuota } from "./antigravity";

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

function makeGeminiHome(relativePath: string, creds: Record<string, unknown>) {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-usage-"));
  tempDirs.push(homeDir);
  const credPath = nodePath.join(homeDir, ...relativePath.split("/"));
  mkdirSync(nodePath.dirname(credPath), { recursive: true });
  writeFileSync(credPath, JSON.stringify(creds), "utf8");
  return { homeDir, credPath };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseAntigravityQuota", () => {
  it("collapses model buckets into Pro/Flash and prefers paidTier.name", () => {
    const snapshot = parseAntigravityQuota({
      loadAssist: {
        paidTier: { name: "Google AI Pro" },
        currentTier: { id: "free-tier" },
        cloudaicompanionProject: "gen-lang-client-1",
      },
      quota: {
        models: Object.fromEntries(
          [
            {
              modelId: "gemini-2.5-pro",
              remainingFraction: 0.4,
              resetTime: "2026-09-01T00:00:00Z",
            },
            {
              modelId: "gemini-2.5-pro-preview",
              remainingFraction: 0.1,
              resetTime: "2026-09-01T00:00:00Z",
            },
            {
              modelId: "gemini-2.5-flash",
              remainingFraction: 0.8,
              resetTime: "2026-08-20T12:00:00Z",
            },
          ].map(({ modelId, ...quotaInfo }) => [modelId, { quotaInfo }]),
        ),
      },
      nowMs: NOW_MS,
    });
    expect(snapshot.planName).toBe("Google AI Pro");
    expect(snapshot.limits.map((limit) => limit.window)).toEqual(["Pro", "Flash"]);
    expect(snapshot.limits[0]?.usedPercent).toBe(90);
    expect(snapshot.limits[1]?.usedPercent).toBe(20);
  });
});

describe("antigravityUsageFetcher", () => {
  it("does not reuse a Gemini CLI login as an Antigravity account", async () => {
    const { homeDir } = makeGeminiHome(".gemini/oauth_creds.json", {
      access_token: "unrelated-gemini-token",
    });
    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("needs-auth");
  });

  it("reads the agy keychain account before fallback files, including Go keyring encoding", async () => {
    const { homeDir } = makeGeminiHome(".gemini/antigravity-cli/antigravity-oauth-token", {
      access_token: "old-file",
    });
    const record = {
      auth_method: "consumer",
      token: { access_token: "keychain-token", expiry: new Date(NOW_MS + 3600000).toISOString() },
    };
    const keychain = vi
      .spyOn(credentials, "readKeychainPassword")
      .mockResolvedValue(
        "go-keyring-base64:" + Buffer.from(JSON.stringify(record)).toString("base64"),
      );
    stubOutboundFetch(async (_url, init) => {
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer keychain-token",
      );
      return jsonResponse({
        models: {
          "claude-sonnet": { quotaInfo: { remainingFraction: 0.6 } },
          tab_flash: { quotaInfo: { remainingFraction: 0 } },
        },
      });
    });
    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "darwin",
      nowMs: NOW_MS,
    });
    expect(keychain).toHaveBeenCalledWith({
      service: "gemini",
      account: "antigravity",
      platform: "darwin",
    });
    expect(snapshot.limits).toEqual([{ window: "Claude", usedPercent: 40 }]);
  });

  it("refreshes keychain tokens in memory without writing credentials back", async () => {
    const { homeDir } = makeGeminiHome(".gemini/oauth_creds.json", { access_token: "unrelated" });
    vi.spyOn(credentials, "readKeychainPassword").mockResolvedValue(
      JSON.stringify({
        auth_method: "consumer",
        token: {
          access_token: "expired-keychain",
          refresh_token: "keychain-refresh",
          expiry: new Date(NOW_MS - 1000).toISOString(),
        },
      }),
    );
    const write = vi.spyOn(credentials, "writeJsonFileAtomic");
    let refreshCount = 0;
    stubOutboundFetch(async (url, init) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        refreshCount++;
        expect(new URLSearchParams(String(init?.body)).get("client_id")).toMatch(/^1071006060591-/);
        return jsonResponse({ access_token: "refreshed-keychain", expires_in: 3600 });
      }
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer refreshed-keychain",
      );
      return jsonResponse({ models: { "gemini-pro": { quotaInfo: { remainingFraction: 1 } } } });
    });
    const ctx = { homeDir, env: {}, platform: "darwin" as const, nowMs: Date.now() };
    expect((await antigravityUsageFetcher.fetch(ctx)).status).toBe("ok");
    expect((await antigravityUsageFetcher.fetch(ctx)).status).toBe("ok");
    expect(refreshCount).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });
  it("returns needs-auth when no Gemini/agy credential is present", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-empty-"));
    tempDirs.push(homeDir);
    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("needs-auth");
  });

  it("reads the agy oauth token file and fetches Cloud Code quota", async () => {
    const { homeDir } = makeGeminiHome(".gemini/antigravity-cli/antigravity-oauth-token", {
      auth_method: "consumer",
      token: {
        access_token: "ya29-access",
        refresh_token: "1//refresh",
        expiry: new Date(NOW_MS + 3_600_000).toISOString(),
      },
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ya29-access");
      expect(headers["User-Agent"]).toMatch(/^antigravity\//);
      if (target.includes("loadCodeAssist")) {
        return jsonResponse({
          currentTier: { id: "standard-tier", name: "Paid" },
          cloudaicompanionProject: "gen-lang-client-9",
        });
      }
      if (target.includes("fetchAvailableModels")) {
        expect(String(init?.body)).toContain("gen-lang-client-9");
        return jsonResponse({
          models: { "gemini-2.5-pro": { quotaInfo: { remainingFraction: 0.75 } } },
        });
      }
      throw new Error(`unexpected url ${target}`);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Paid");
    expect(snapshot.limits[0]).toMatchObject({ window: "Pro", usedPercent: 25 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired nested token and persists the rotation", async () => {
    const { homeDir, credPath } = makeGeminiHome(
      ".gemini/antigravity-cli/antigravity-oauth-token",
      {
        auth_method: "consumer",
        token: {
          access_token: "ya29-old",
          refresh_token: "1//old-refresh",
          expiry: new Date(NOW_MS - 60_000).toISOString(),
        },
      },
    );
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("oauth2.googleapis.com/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("1//old-refresh");
        expect(body.get("client_id")).toMatch(/^1071006060591-/);
        expect(body.get("client_secret")).toBeTruthy();
        return jsonResponse({
          access_token: "ya29-new",
          refresh_token: "1//new-refresh",
          expires_in: 3600,
        });
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ya29-new");
      if (target.includes("loadCodeAssist")) {
        return jsonResponse({ currentTier: { id: "free-tier" } });
      }
      if (target.includes("fetchAvailableModels")) {
        return jsonResponse({ models: {} });
      }
      throw new Error(`unexpected url ${target}`);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Free");
    const saved = JSON.parse(readFileSync(credPath, "utf8")) as {
      token: { access_token: string; refresh_token: string };
    };
    expect(saved.token.access_token).toBe("ya29-new");
    expect(saved.token.refresh_token).toBe("1//new-refresh");
  });
});
