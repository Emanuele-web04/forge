// FILE: providerUsage/providers/grok.test.ts
// Purpose: Covers Grok SuperGrok CLI-proxy billing, auth.json identity, and API-key fallback.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";

import {
  grokUsageFetcher,
  parseGrokApiKeyIdentity,
  parseGrokAuthRecord,
  parseGrokBilling,
} from "./grok";

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

function makeGrokHome(auth: Record<string, unknown>) {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-grok-usage-"));
  tempDirs.push(homeDir);
  const grokDir = nodePath.join(homeDir, ".grok");
  mkdirSync(grokDir, { recursive: true });
  writeFileSync(nodePath.join(grokDir, "auth.json"), JSON.stringify(auth), "utf8");
  return homeDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseGrokAuthRecord", () => {
  it("prefers the SuperGrok OIDC issuer entry", () => {
    const session = parseGrokAuthRecord({
      "https://accounts.x.ai/sign-in": { key: "legacy-token", email: "old@x.ai" },
      "https://auth.x.ai::openid": {
        key: "super-token",
        email: "user@x.ai",
        auth_mode: "oauth",
        expires_at: "2026-09-01T00:00:00Z",
        principal_type: "User",
      },
    });
    expect(session).toMatchObject({
      accessToken: "super-token",
      email: "user@x.ai",
      plan: "SuperGrok",
      principalType: "User",
    });
  });
});

describe("parseGrokBilling", () => {
  it("maps CLI-proxy credit percent, reset, and settings tier", () => {
    const snapshot = parseGrokBilling({
      billing: {
        config: {
          creditUsagePercent: 12,
          currentPeriod: { end: "2026-09-01T00:00:00Z" },
        },
      },
      settings: { subscription_tier_display: "SuperGrok Heavy" },
      session: { accessToken: "t", email: "user@x.ai" },
      nowMs: NOW_MS,
    });
    expect(snapshot.planName).toBe("SuperGrok Heavy");
    expect(snapshot.limits[0]).toMatchObject({
      window: "Credits",
      usedPercent: 12,
      resetsAt: "2026-09-01T00:00:00.000Z",
    });
    expect(snapshot.usageLines.find((line) => line.label === "Account")?.value).toBe("user@x.ai");
  });

  it("maps ACP billing totals when the proxy returns the RPC shape", () => {
    const snapshot = parseGrokBilling({
      billing: {
        billingCycle: { billingPeriodEnd: "2026-10-01T00:00:00Z" },
        monthlyLimit: { val: 100 },
        usage: { totalUsed: { val: 25 } },
      },
      nowMs: NOW_MS,
    });
    expect(snapshot.limits[0]?.usedPercent).toBe(25);
    expect(snapshot.limits[0]?.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("parseGrokApiKeyIdentity", () => {
  it("does not invent prepaid credit remaining from the api-key metadata endpoint", () => {
    const snapshot = parseGrokApiKeyIdentity({
      payload: { name: "My API Key", api_key_blocked: false },
      nowMs: NOW_MS,
    });
    expect(snapshot.planName).toBe("API key");
    expect(snapshot.limits).toEqual([]);
    expect(snapshot.usageLines.find((line) => line.label === "Key")?.value).toBe("My API Key");
  });
});

describe("grokUsageFetcher", () => {
  it("returns needs-auth when no SuperGrok session or API key is present", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-grok-empty-"));
    tempDirs.push(homeDir);
    const snapshot = await grokUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("needs-auth");
  });

  it("fetches CLI-proxy credits for a SuperGrok auth.json login", async () => {
    const homeDir = makeGrokHome({
      "https://auth.x.ai::openid": {
        key: "session-token",
        email: "user@x.ai",
        auth_mode: "oauth",
        expires_at: new Date(NOW_MS + 86_400_000).toISOString(),
      },
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer session-token");
      expect(headers["x-xai-token-auth"]).toBe("xai-grok-cli");
      if (target.includes("/v1/billing")) {
        return jsonResponse({
          config: { creditUsagePercent: 41, billingPeriodEnd: "2026-09-15T00:00:00Z" },
        });
      }
      if (target.includes("/v1/settings")) {
        return jsonResponse({ subscription_tier_display: "SuperGrok" });
      }
      throw new Error(`unexpected url ${target}`);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await grokUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("SuperGrok");
    expect(snapshot.limits[0]?.usedPercent).toBe(41);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps identity when billing fails for a team principal", async () => {
    const homeDir = makeGrokHome({
      "https://auth.x.ai::openid": {
        key: "team-token",
        email: "team@x.ai",
        principal_type: "Team",
        expires_at: new Date(NOW_MS + 86_400_000).toISOString(),
      },
    });
    stubOutboundFetch(async () => jsonResponse({ error: "No personal team" }, 400));

    const snapshot = await grokUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.usageLines.find((line) => line.label === "Account")?.value).toBe("team@x.ai");
    expect(snapshot.usageLines.find((line) => line.label === "Credits")?.value).toContain(
      "team usage",
    );
  });
});
