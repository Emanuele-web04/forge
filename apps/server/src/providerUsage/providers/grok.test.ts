// FILE: providerUsage/providers/grok.test.ts
// Purpose: Covers Grok CLI auth-file resolution (GROK_HOME vs ~/.grok), team/API-key
// unsupported paths, and CLI-proxy billing/settings fetches. No real network.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import { grokUsageFetcher } from "./grok";

const NOW_MS = 1_780_000_000_000;
const WEEKLY_END = "2026-08-24T23:14:37.093714+00:00";
const AUTH_TOKEN = "test-access-token";

const WEEKLY_BILLING = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-17T23:14:37.093714+00:00",
      end: WEEKLY_END,
    },
    creditUsagePercent: 44,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodEnd: WEEKLY_END,
  },
};

const SETTINGS_BODY = {
  subscription_tier_display: "SuperGrok Heavy",
  subscriptionTierDisplay: "SuperGrok Heavy",
};

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

function rejectNetwork(): void {
  stubOutboundFetch(async () => {
    throw new Error("grok usage tests must not perform real network I/O");
  });
}

function writeGrokAuth(grokHome: string, entry: Record<string, unknown> = {}): void {
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(
    nodePath.join(grokHome, "auth.json"),
    JSON.stringify({
      "https://auth.x.ai::test-client": {
        key: AUTH_TOKEN,
        principal_type: "User",
        expires_at: new Date(NOW_MS + 8 * 24 * 60 * 60 * 1000).toISOString(),
        ...entry,
      },
    }),
    "utf8",
  );
}

function makeHomeDir(): string {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-grok-usage-"));
  tempDirs.push(homeDir);
  return homeDir;
}

function makeHomeWithAuth(entry: Record<string, unknown> = {}): string {
  const homeDir = makeHomeDir();
  writeGrokAuth(nodePath.join(homeDir, ".grok"), entry);
  return homeDir;
}

function makeCtx(homeDir: string, env: NodeJS.ProcessEnv = {}) {
  return {
    homeDir,
    env,
    platform: "linux" as const,
    nowMs: NOW_MS,
  };
}

function requestUrl(url: string | URL | Request): string {
  return String(url);
}

function isBillingUrl(url: string): boolean {
  return url.includes("/billing");
}

function isSettingsUrl(url: string): boolean {
  return url.includes("/settings");
}

function authorization(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (headers instanceof Headers) {
    return headers.get("Authorization") ?? undefined;
  }
  if (Array.isArray(headers)) {
    const match = headers.find((entry) => entry[0]?.toLowerCase() === "authorization");
    return match?.[1];
  }
  if (headers && typeof headers === "object") {
    return (headers as Record<string, string>).Authorization;
  }
  return undefined;
}

beforeEach(() => {
  rejectNetwork();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("grokUsageFetcher", () => {
  it("returns needs-auth when auth.json is missing", async () => {
    const snapshot = await grokUsageFetcher.fetch(makeCtx(makeHomeDir()));
    expect(snapshot.provider).toBe("grok");
    expect(snapshot.status).toBe("needs-auth");
    expect(outboundHttp.request).not.toHaveBeenCalled();
  });

  it("returns a weekly snapshot from billing and settings", async () => {
    const homeDir = makeHomeWithAuth();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(authorization(init)).toBe(`Bearer ${AUTH_TOKEN}`);
      const target = requestUrl(url);
      if (isBillingUrl(target)) {
        return jsonResponse(WEEKLY_BILLING);
      }
      if (isSettingsUrl(target)) {
        return jsonResponse(SETTINGS_BODY);
      }
      throw new Error(`unexpected grok usage URL: ${target}`);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await grokUsageFetcher.fetch(makeCtx(homeDir));

    expect(snapshot.status).toBe("ok");
    expect(snapshot.provider).toBe("grok");
    expect(snapshot.planName).toBe("SuperGrok Heavy");
    expect(snapshot.limits.find((entry) => entry.window === "Weekly")?.usedPercent).toBe(44);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("reads GROK_HOME instead of ~/.grok", async () => {
    const homeDir = makeHomeWithAuth({ key: "home-dir-token" });
    const grokHome = mkdtempSync(nodePath.join(os.tmpdir(), "synara-grok-home-"));
    tempDirs.push(grokHome);
    writeGrokAuth(grokHome, { key: "grok-home-token" });

    const authorizations: string[] = [];
    stubOutboundFetch(async (url, init) => {
      const header = authorization(init);
      if (header !== undefined) {
        authorizations.push(header);
      }
      const target = requestUrl(url);
      if (isBillingUrl(target)) {
        return jsonResponse(WEEKLY_BILLING);
      }
      if (isSettingsUrl(target)) {
        return jsonResponse(SETTINGS_BODY);
      }
      throw new Error(`unexpected grok usage URL: ${target}`);
    });

    const snapshot = await grokUsageFetcher.fetch(makeCtx(homeDir, { GROK_HOME: grokHome }));

    expect(snapshot.status).toBe("ok");
    expect(authorizations.length).toBeGreaterThan(0);
    expect(authorizations.every((header) => header === "Bearer grok-home-token")).toBe(true);
    expect(authorizations).not.toContain("Bearer home-dir-token");
  });

  it("returns unsupported for a Team principal", async () => {
    const homeDir = makeHomeWithAuth({ principal_type: "Team" });
    const snapshot = await grokUsageFetcher.fetch(makeCtx(homeDir));
    expect(snapshot.provider).toBe("grok");
    expect(snapshot.status).toBe("unsupported");
    expect(outboundHttp.request).not.toHaveBeenCalled();
  });

  it("returns unsupported when only XAI_API_KEY is set", async () => {
    const snapshot = await grokUsageFetcher.fetch(
      makeCtx(makeHomeDir(), { XAI_API_KEY: "xai-test-key" }),
    );
    expect(snapshot.provider).toBe("grok");
    expect(snapshot.status).toBe("unsupported");
    expect(outboundHttp.request).not.toHaveBeenCalled();
  });

  it("returns needs-auth when billing rejects the token", async () => {
    const homeDir = makeHomeWithAuth();
    stubOutboundFetch(async (url) => {
      const target = requestUrl(url);
      if (isBillingUrl(target)) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (isSettingsUrl(target)) {
        return jsonResponse(SETTINGS_BODY);
      }
      throw new Error(`unexpected grok usage URL: ${target}`);
    });

    const snapshot = await grokUsageFetcher.fetch(makeCtx(homeDir));
    expect(snapshot.provider).toBe("grok");
    expect(snapshot.status).toBe("needs-auth");
  });

  it("returns error when billing fails with a server error", async () => {
    const homeDir = makeHomeWithAuth();
    stubOutboundFetch(async (url) => {
      const target = requestUrl(url);
      if (isBillingUrl(target)) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      if (isSettingsUrl(target)) {
        return jsonResponse(SETTINGS_BODY);
      }
      throw new Error(`unexpected grok usage URL: ${target}`);
    });

    const snapshot = await grokUsageFetcher.fetch(makeCtx(homeDir));
    expect(snapshot.provider).toBe("grok");
    expect(snapshot.status).toBe("error");
  });

  it("keeps an ok billing snapshot when settings fail", async () => {
    const homeDir = makeHomeWithAuth();
    stubOutboundFetch(async (url) => {
      const target = requestUrl(url);
      if (isBillingUrl(target)) {
        return jsonResponse(WEEKLY_BILLING);
      }
      if (isSettingsUrl(target)) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      throw new Error(`unexpected grok usage URL: ${target}`);
    });

    const snapshot = await grokUsageFetcher.fetch(makeCtx(homeDir));
    expect(snapshot.provider).toBe("grok");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits.find((entry) => entry.window === "Weekly")?.usedPercent).toBe(44);
  });
});
