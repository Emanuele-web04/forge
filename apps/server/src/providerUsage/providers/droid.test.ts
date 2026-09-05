// FILE: providerUsage/providers/droid.test.ts
// Purpose: Covers Factory CLI v2 credential decryption, live billing-limit parsing, and
// FACTORY_API_KEY fallback without redeeming or modifying rotating Factory refresh tokens.

import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import fs from "node:fs/promises";
import { readDroidSecureKey } from "./droidSecureStorage";

vi.mock("./droidSecureStorage", () => ({ readDroidSecureKey: vi.fn(async () => null) }));
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";

import { __resetDroidUsageRateLimitState, droidUsageFetcher, parseDroidUsage } from "./droid";
import { decryptDroidCredentialFile, resolveDroidLocalCredential } from "./droidCredentials";

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
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")).join(":");
}

function writeKeyfileCredential(homeDir: string, value: unknown): void {
  const key = randomBytes(32);
  const factoryHome = nodePath.join(homeDir, ".factory");
  writeFileSync(nodePath.join(factoryHome, "auth.v2.key"), key.toString("base64"), "utf8");
  writeFileSync(nodePath.join(factoryHome, "auth.v2.file"), encryptCredential(value, key), "utf8");
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
  vi.mocked(readDroidSecureKey).mockReset();
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
      { homeDir, platform: "linux", env: {} },
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
      { homeDir, platform: "linux", env: {} },
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
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits[0]?.usedPercent).toBe(15);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("selects the explicit API key with its own org and EU region", async () => {
    const homeDir = makeHome();
    writeKeyfileCredential(homeDir, {
      access_token: tokenWithExpiry(NOW_MS + 60_000),
      active_organization_id: "org_local",
      region: "global",
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer fk-selected");
      if (String(url).endsWith("/whoami")) {
        expect(headers["X-Factory-Org-Id"]).toBeUndefined();
        return jsonResponse({ userId: "user_key", orgId: "org_key", region: "eu" });
      }
      expect(String(url)).toBe("https://api.eu.factory.ai/api/billing/limits");
      expect(headers["X-Factory-Org-Id"]).toBe("org_key");
      return jsonResponse(LIMITS_PAYLOAD);
    });
    stubOutboundFetch(fetchMock);
    const snapshot = await droidUsageFetcher.fetch({
      homeDir,
      env: { FACTORY_API_KEY: "fk-selected" },
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to a local account when the explicit API key is rejected", async () => {
    const homeDir = makeHome();
    writeKeyfileCredential(homeDir, { access_token: tokenWithExpiry(NOW_MS + 60_000) });
    const fetchMock = vi.fn(async () => jsonResponse({}, 401));
    stubOutboundFetch(fetchMock);
    const snapshot = await droidUsageFetcher.fetch({
      homeDir,
      env: { FACTORY_API_KEY: "fk-invalid" },
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("needs-auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe("Droid account isolation regressions", () => {
  it.each(["active_organization_id", "region"])(
    "invalidates both caches when %s changes",
    async (field) => {
      const homeDir = makeHome();
      const credential = {
        access_token: tokenWithExpiry(NOW_MS + 60_000),
        active_organization_id: "org_a",
        region: "global",
      };
      const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };
      writeKeyfileCredential(homeDir, credential);
      const before = await droidUsageFetcher.cacheKey!(ctx);
      stubOutboundFetch(async () => jsonResponse(LIMITS_PAYLOAD));
      await droidUsageFetcher.fetch(ctx);
      writeKeyfileCredential(homeDir, {
        ...credential,
        [field]: field === "region" ? "eu" : "org_b",
      });
      expect(await droidUsageFetcher.cacheKey!({ ...ctx })).not.toBe(before);
      stubOutboundFetch(async () => jsonResponse({}, 429));
      const changed = await droidUsageFetcher.fetch({ ...ctx });
      expect(changed.status).toBe("error");
      expect(changed.limits).toEqual([]);
    },
  );

  it("does not return the local account's cached values for a newly supplied API key", async () => {
    const homeDir = makeHome();
    writeKeyfileCredential(homeDir, { access_token: tokenWithExpiry(NOW_MS + 60_000) });
    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };
    stubOutboundFetch(async () => jsonResponse(LIMITS_PAYLOAD));
    await droidUsageFetcher.fetch(ctx);
    stubOutboundFetch(async () => jsonResponse({}, 429));
    const next = await droidUsageFetcher.fetch({ ...ctx, env: { FACTORY_API_KEY: "fk-new-user" } });
    expect(next.limits).toEqual([]);
    expect(next.status).not.toBe("ok");
  });
});

describe("Droid credential integrity", () => {
  it("reads the macOS login-keychain file using its distinct key account", async () => {
    const homeDir = makeHome();
    const key = randomBytes(32);
    writeFileSync(
      nodePath.join(homeDir, ".factory/auth.v2.loginkeychain"),
      encryptCredential({ access_token: "fixture" }, key),
    );
    const readSecureKey = vi.fn(async () => key);
    const result = await resolveDroidLocalCredential(
      { homeDir, platform: "darwin", env: {} },
      { readSecureKey },
    );
    expect(result.credential?.source).toBe("login-keychain");
    expect(readSecureKey).toHaveBeenCalledWith(
      nodePath.join(homeDir, ".factory"),
      "login-keychain",
    );
  });

  it("does not select a leftover keyfile account when secure storage is unreadable", async () => {
    const homeDir = makeHome();
    writeKeyfileCredential(homeDir, { access_token: "old-user" });
    writeFileSync(nodePath.join(homeDir, ".factory/auth.v2.loginkeychain"), "corrupt");
    const result = await resolveDroidLocalCredential(
      { homeDir, platform: "darwin", env: {} },
      { readSecureKey: async () => null },
    );
    expect(result).toEqual({ credential: null, localLoginPresent: true });
  });

  it("rejects modified ciphertext, key, tags, and malformed base64 with one null result", () => {
    const key = Buffer.alloc(32, 17);
    const encrypted = encryptCredential({ access_token: "fixture" }, key);
    expect(decryptDroidCredentialFile(encrypted, Buffer.alloc(32, 18))).toBeNull();
    const parts = encrypted.split(":");
    for (const index of [0, 1, 2]) {
      const modified = [...parts];
      const bytes = Buffer.from(modified[index]!, "base64");
      bytes[0] = bytes[0]! ^ 1;
      modified[index] = bytes.toString("base64");
      expect(decryptDroidCredentialFile(modified.join(":"), key)).toBeNull();
    }
    expect(decryptDroidCredentialFile(`!${encrypted}`, key)).toBeNull();
  });

  it("uses the credential captured for the cache key even if storage changes before fetch", async () => {
    const homeDir = makeHome();
    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };
    const access_token = tokenWithExpiry(NOW_MS + 60_000);
    writeKeyfileCredential(homeDir, { access_token, active_organization_id: "org_a" });
    const key = await droidUsageFetcher.cacheKey!(ctx);
    writeKeyfileCredential(homeDir, { access_token, active_organization_id: "org_b" });
    stubOutboundFetch(async (_url, init) => {
      expect((init?.headers as Record<string, string>)["X-Factory-Org-Id"]).toBe("org_a");
      return jsonResponse(LIMITS_PAYLOAD);
    });
    expect((await droidUsageFetcher.fetch(ctx)).status).toBe("ok");
    expect(await droidUsageFetcher.cacheKey!(ctx)).not.toBe(key);
  });
});

describe("Droid unavailable identities", () => {
  it.each(["https://attacker.invalid", "unknown"])(
    "does not send local credentials to an unsupported region %s",
    async (region) => {
      const homeDir = makeHome();
      writeKeyfileCredential(homeDir, { access_token: tokenWithExpiry(NOW_MS + 60_000), region });
      const fetchMock = vi.fn(async () => jsonResponse(LIMITS_PAYLOAD));
      stubOutboundFetch(fetchMock);
      expect(
        (await droidUsageFetcher.fetch({ homeDir, platform: "linux", env: {}, nowMs: NOW_MS }))
          .status,
      ).toBe("error");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("marks expired-token data stale without changing its update time", async () => {
    const homeDir = makeHome();
    writeKeyfileCredential(homeDir, { access_token: tokenWithExpiry(NOW_MS + 60_000) });
    stubOutboundFetch(async () => jsonResponse(LIMITS_PAYLOAD));
    const ctx = { homeDir, platform: "linux" as const, env: {}, nowMs: NOW_MS };
    const fresh = await droidUsageFetcher.fetch(ctx);
    const stale = await droidUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 120_000 });
    expect(stale.stale).toBe(true);
    expect(stale.updatedAt).toBe(fresh.updatedAt);
  });
  it("separates resilience by API key identity and resolved org/region", async () => {
    const homeDir = makeHome();
    const ctx = {
      homeDir,
      platform: "linux" as const,
      env: { FACTORY_API_KEY: "fk-a" },
      nowMs: NOW_MS,
    };
    stubOutboundFetch(async (url) =>
      jsonResponse(
        String(url).endsWith("/whoami")
          ? { userId: "a", orgId: "a", region: "global" }
          : LIMITS_PAYLOAD,
      ),
    );
    expect(await droidUsageFetcher.cacheKey!(ctx)).toBeNull();
    expect((await droidUsageFetcher.fetch(ctx)).status).toBe("ok");
    stubOutboundFetch(async (url) =>
      String(url).endsWith("/whoami")
        ? jsonResponse({ userId: "b", orgId: "b", region: "eu" })
        : jsonResponse({}, 429),
    );
    expect((await droidUsageFetcher.fetch({ ...ctx })).limits).toEqual([]);
    expect(
      (await droidUsageFetcher.fetch({ ...ctx, env: { FACTORY_API_KEY: "fk-b" } })).limits,
    ).toEqual([]);
  });
});

describe("Droid storage boundaries", () => {
  it.each(["keyfile", "keyring"])("accepts canonical base64 only in %s storage", async (source) => {
    const homeDir = makeHome();
    const key = Buffer.alloc(32, 17);
    const path = nodePath.join(
      homeDir,
      ".factory",
      source === "keyfile" ? "auth.v2.file" : "auth.v2.keyring",
    );
    writeFileSync(path, encryptCredential({ access_token: "fixture" }, key));
    const ctx = { homeDir, platform: "linux" as const, env: {} };
    for (const representation of [
      key.toString("base64"),
      key.toString("hex"),
      key.toString("base64").replace("=", ""),
      "!" + key.toString("base64"),
    ]) {
      if (source === "keyfile")
        writeFileSync(nodePath.join(homeDir, ".factory/auth.v2.key"), representation);
      else vi.mocked(readDroidSecureKey).mockResolvedValue(representation);
      const resolved = await resolveDroidLocalCredential(ctx);
      expect(resolved.credential?.accessToken ?? null).toBe(
        representation === key.toString("base64") ? "fixture" : null,
      );
    }
  });
  it("does not mistake an inaccessible current store for an absent store", async () => {
    const homeDir = makeHome();
    writeKeyfileCredential(homeDir, { access_token: "old-user" });
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).endsWith("auth.v2.loginkeychain"))
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      return lstat(...args);
    }) as typeof fs.lstat);
    expect(await resolveDroidLocalCredential({ homeDir, platform: "darwin", env: {} })).toEqual({
      credential: null,
      localLoginPresent: true,
    });
  });
  it("does not retry whoami during Retry-After or reuse another API key's failure", async () => {
    const homeDir = makeHome();
    const fetchMock = vi.fn(
      async () => new Response("{}", { status: 429, headers: { "Retry-After": "120" } }),
    );
    stubOutboundFetch(fetchMock);
    const ctx = {
      homeDir,
      env: { FACTORY_API_KEY: "fk-a" },
      platform: "linux" as const,
      nowMs: NOW_MS,
    };
    expect((await droidUsageFetcher.fetch(ctx)).status).toBe("error");
    await droidUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await droidUsageFetcher.fetch({ ...ctx, env: { FACTORY_API_KEY: "fk-b" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await droidUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 120_001 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
