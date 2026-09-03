// FILE: providerUsage/providers/droid.test.ts
// Purpose: Covers Factory CLI v2 credential decryption, live billing-limit parsing, and
// FACTORY_API_KEY fallback without redeeming or modifying rotating Factory refresh tokens.

import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";

import {
  __resetDroidUsageRateLimitState,
  droidUsageFetcher,
  parseDroidUsage,
} from "./droid";
import {
  decryptDroidCredentialFile,
  resolveDroidLocalCredential,
} from "./droidCredentials";

const NOW_MS = 1_780_000_000_000;
const tempDirs: string[] = [];

function makeHome(): string {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-droid-usage-"));
  tempDirs.push(homeDir);
  mkdirSync(nodePath.join(homeDir, ".factory"), { recursive: true });
  return homeDir;
}

function tokenWithExpiry(expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

function encryptCredential(value: unknown, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64"))
    .join(":");
}

function writeKeyfileCredential(homeDir: string, value: unknown): void {
  const key = randomBytes(32);
  const factoryHome = nodePath.join(homeDir, ".factory");
  writeFileSync(nodePath.join(factoryHome, "auth.v2.key"), key.toString("base64"), "utf8");
  writeFileSync(
    nodePath.join(factoryHome, "auth.v2.file"),
    encryptCredential(value, key),
    "utf8",
  );
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const LIMITS_PAYLOAD = {
  usesTokenRateLimitsBilling: true,
  limits: {
    standard: {
      fiveHour: {
        usedPercent: 15,
        windowEnd: "2026-09-04T02:36:34.535Z",
        secondsRemaining: 17_674,
      },
      weekly: {
        usedPercent: 9,
        windowEnd: "2026-09-06T19:23:10.458Z",
        secondsRemaining: 250_870,
      },
      monthly: {
        usedPercent: 3,
        windowEnd: "2026-09-29T00:04:31.648Z",
        secondsRemaining: 2_168_551,
      },
    },
    core: {
      fiveHour: {
        usedPercent: 1,
        windowEnd: "2026-09-04T03:00:00.000Z",
        secondsRemaining: 19_000,
      },
      weekly: {
        usedPercent: 2,
        windowEnd: "2026-09-07T00:00:00.000Z",
        secondsRemaining: 260_000,
      },
      monthly: {
        usedPercent: 3,
        windowEnd: "2026-10-01T00:00:00.000Z",
        secondsRemaining: 2_300_000,
      },
    },
  },
  extraUsageBalanceCents: 1250,
  overagePreference: "droidCore",
};

afterEach(() => {
  vi.restoreAllMocks();
  __resetDroidUsageRateLimitState();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Droid v2 credentials", () => {
  it("decrypts Factory's AES-256-GCM credential format", () => {
    const key = randomBytes(32);
    const value = { access_token: "token", active_organization_id: "org_123" };
    expect(decryptDroidCredentialFile(encryptCredential(value, key), key)).toEqual(value);
    expect(decryptDroidCredentialFile("invalid", key)).toBeNull();
  });

  it("reads secure-keyring credentials through an injected keytar reader", async () => {
    const homeDir = makeHome();
    const key = randomBytes(32);
    const accessToken = tokenWithExpiry(NOW_MS + 60_000);
    writeFileSync(
      nodePath.join(homeDir, ".factory", "auth.v2.keyring"),
      encryptCredential(
        { access_token: accessToken, active_organization_id: "org_123", region: "eu" },
        key,
      ),
      "utf8",
    );

    const resolution = await resolveDroidLocalCredential(
      { homeDir },
      { readSecureKey: async () => key },
    );
    expect(resolution.localLoginPresent).toBe(true);
    expect(resolution.credential).toMatchObject({
      accessToken,
      activeOrganizationId: "org_123",
      region: "eu",
      source: "keyring",
    });
  });

  it("recognizes a modern login marker even when its credential cannot be read", async () => {
    const homeDir = makeHome();
    writeFileSync(nodePath.join(homeDir, ".factory", "auth.v2.keyring"), "unreadable", "utf8");
    const resolution = await resolveDroidLocalCredential(
      { homeDir },
      { readSecureKey: async () => null },
    );
    expect(resolution).toEqual({ credential: null, localLoginPresent: true });
  });
});

describe("parseDroidUsage", () => {
  it("maps standard windows, core usage, and extra balance", () => {
    const snapshot = parseDroidUsage({ json: LIMITS_PAYLOAD, nowMs: NOW_MS });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([
      {
        window: "5h",
        usedPercent: 15,
        resetsAt: "2026-09-04T02:36:34.535Z",
        windowDurationMins: 300,
      },
      {
        window: "Weekly",
        usedPercent: 9,
        resetsAt: "2026-09-06T19:23:10.458Z",
        windowDurationMins: 10_080,
      },
      {
        window: "Monthly",
        usedPercent: 3,
        resetsAt: "2026-09-29T00:04:31.648Z",
        windowDurationMins: 43_200,
      },
      {
        window: "Core 5h",
        usedPercent: 1,
        resetsAt: "2026-09-04T03:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        window: "Core Weekly",
        usedPercent: 2,
        resetsAt: "2026-09-07T00:00:00.000Z",
        windowDurationMins: 10_080,
      },
      {
        window: "Core Monthly",
        usedPercent: 3,
        resetsAt: "2026-10-01T00:00:00.000Z",
        windowDurationMins: 43_200,
      },
    ]);
    expect(snapshot.usageLines).toContainEqual({
      label: "Extra Usage",
      value: "$12.50",
    });
    expect(snapshot.usageLines).toContainEqual({
      label: "When Limited",
      value: "Switch to Core",
    });
  });

  it("uses a friendly label for pay-per-token overage", () => {
    const snapshot = parseDroidUsage({
      json: { ...LIMITS_PAYLOAD, overagePreference: "extraUsage" },
      nowMs: NOW_MS,
    });
    expect(snapshot.usageLines).toContainEqual({
      label: "When Limited",
      value: "Use Paid Credits",
    });
  });

  it("reports unsupported organizations without standard limits", () => {
    expect(
      parseDroidUsage({
        json: { usesTokenRateLimitsBilling: false, limits: {} },
        nowMs: NOW_MS,
      }).status,
    ).toBe("unsupported");
  });
});

describe("droidUsageFetcher", () => {
  it("uses a valid local credential and sends its organization and region", async () => {
    const homeDir = makeHome();
    const accessToken = tokenWithExpiry(NOW_MS + 60_000);
    writeKeyfileCredential(homeDir, {
      access_token: accessToken,
      active_organization_id: "org_123",
      region: "eu",
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.eu.factory.ai/api/billing/limits");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${accessToken}`);
      expect(headers["X-Factory-Org-Id"]).toBe("org_123");
      return jsonResponse(LIMITS_PAYLOAD);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await droidUsageFetcher.fetch({
      homeDir,
      env: { FACTORY_API_KEY: "fk-fallback" },
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits[0]?.usedPercent).toBe(15);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to FACTORY_API_KEY when the local token is expired", async () => {
    const homeDir = makeHome();
    writeKeyfileCredential(homeDir, {
      access_token: tokenWithExpiry(NOW_MS - 60_000),
      active_organization_id: "org_old",
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer fk-fallback");
      expect(headers["X-Factory-Org-Id"]).toBeUndefined();
      return jsonResponse(LIMITS_PAYLOAD);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await droidUsageFetcher.fetch({
      homeDir,
      env: { FACTORY_API_KEY: "fk-fallback" },
      platform: "win32",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries with FACTORY_API_KEY when the local token is rejected", async () => {
    const homeDir = makeHome();
    const localToken = tokenWithExpiry(NOW_MS + 60_000);
    writeKeyfileCredential(homeDir, { access_token: localToken });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>).Authorization;
      return authorization === `Bearer ${localToken}`
        ? jsonResponse({ error: "expired" }, 401)
        : jsonResponse(LIMITS_PAYLOAD);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await droidUsageFetcher.fetch({
      homeDir,
      env: { FACTORY_API_KEY: "fk-fallback" },
      platform: "win32",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good local values after the token expires", async () => {
    const homeDir = makeHome();
    const expiresAtMs = NOW_MS + 60_000;
    writeKeyfileCredential(homeDir, { access_token: tokenWithExpiry(expiresAtMs) });
    stubOutboundFetch(async () => jsonResponse(LIMITS_PAYLOAD));

    const fresh = await droidUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "win32",
      nowMs: NOW_MS,
    });
    const stale = await droidUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "win32",
      nowMs: expiresAtMs + 1,
    });

    expect(fresh.status).toBe("ok");
    expect(stale.status).toBe("ok");
    expect(stale.stale).toBe(true);
    expect(stale.limits).toEqual(fresh.limits);
    expect(stale.detail).toContain("Run Droid");
  });
});
