// FILE: providerUsage/providers/codex.test.ts
// Purpose: Covers Codex's token lifecycle — JWT-exp-gated refresh with atomic write-back of the
// rotated pair (single-use rotating refresh tokens must never be redeemed without persisting),
// adoption of out-of-band rotations on `refresh_token_reused`, and the dead-token taxonomy.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import { codexUsageFetcher } from "./codex";

const { readKeychainPasswordMock } = vi.hoisted(() => ({
  readKeychainPasswordMock: vi.fn(),
}));

vi.mock("../credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentials")>()),
  readKeychainPassword: readKeychainPasswordMock,
}));

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

/** An unsigned JWT carrying only `exp`, enough for expiry-window checks. */
function makeJwt(expMs: number): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(expMs / 1000) })}.sig`;
}

function makeCodexHome(auth: Record<string, unknown>) {
  const codexHome = mkdtempSync(nodePath.join(os.tmpdir(), "synara-codex-usage-"));
  tempDirs.push(codexHome);
  mkdirSync(codexHome, { recursive: true });
  const authPath = nodePath.join(codexHome, "auth.json");
  writeFileSync(authPath, JSON.stringify(auth), "utf8");
  return { codexHome, authPath };
}

function readAuthFile(authPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
}

function makeCtx(codexHome: string, homeDir?: string) {
  return {
    homeDir: homeDir ?? nodePath.join(codexHome, "no-home"),
    env: { CODEX_HOME: codexHome },
    platform: "linux" as const,
    nowMs: NOW_MS,
  };
}

const USAGE_BODY = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 41, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 12, limit_window_seconds: 604_800 },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  readKeychainPasswordMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("codexUsageFetcher", () => {
  it("tries a still-valid keychain token when read-only refresh cannot rotate it", async () => {
    const codexHome = mkdtempSync(nodePath.join(os.tmpdir(), "synara-codex-keychain-"));
    tempDirs.push(codexHome);
    const staleJwt = makeJwt(NOW_MS + 60_000);
    readKeychainPasswordMock.mockResolvedValue(
      JSON.stringify({
        tokens: { access_token: staleJwt, refresh_token: "keychain-refresh-token" },
      }),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).not.toContain("auth.openai.com/oauth/token");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${staleJwt}`);
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch({
      homeDir: nodePath.join(codexHome, "no-home"),
      env: { CODEX_HOME: codexHome },
      platform: "darwin",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readKeychainPasswordMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired token form-encoded and persists the rotated pair to auth.json", async () => {
    const freshJwt = makeJwt(NOW_MS + 8 * 24 * 60 * 60 * 1000);
    const { codexHome, authPath } = makeCodexHome({
      tokens: {
        id_token: "old-id-token",
        access_token: makeJwt(NOW_MS - 60_000),
        refresh_token: "old-refresh-token",
        account_id: "acct-1",
      },
      last_refresh: "2026-07-01T00:00:00.000Z",
      custom_field: "keep-me",
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("auth.openai.com/oauth/token")) {
        const headers = init?.headers as Record<string, string>;
        expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh-token");
        expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
        return jsonResponse({
          access_token: freshJwt,
          refresh_token: "rotated-refresh-token",
          id_token: "rotated-id-token",
        });
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${freshJwt}`);
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Plus");
    expect(snapshot.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(41);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The rotation is on disk: single-use refresh tokens must survive our redemption.
    const saved = readAuthFile(authPath);
    const tokens = saved.tokens as Record<string, unknown>;
    expect(tokens.access_token).toBe(freshJwt);
    expect(tokens.refresh_token).toBe("rotated-refresh-token");
    expect(tokens.id_token).toBe("rotated-id-token");
    expect(tokens.account_id).toBe("acct-1");
    expect(saved.custom_field).toBe("keep-me");
    expect(saved.last_refresh).toBe(new Date(NOW_MS).toISOString());
  });

  it("adopts the CLI's rotation when the refresh token was already redeemed", async () => {
    const staleJwt = makeJwt(NOW_MS - 60_000);
    const cliRotatedJwt = makeJwt(NOW_MS + 8 * 24 * 60 * 60 * 1000);
    const { codexHome, authPath } = makeCodexHome({
      tokens: {
        access_token: staleJwt,
        refresh_token: "already-redeemed-refresh-token",
        account_id: "acct-1",
      },
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("auth.openai.com/oauth/token")) {
        // The codex CLI redeemed this token first and left its rotation on disk.
        writeFileSync(
          authPath,
          JSON.stringify({
            tokens: {
              access_token: cliRotatedJwt,
              refresh_token: "cli-rotated-refresh-token",
              account_id: "acct-1",
            },
            last_refresh: new Date(NOW_MS).toISOString(),
          }),
          "utf8",
        );
        return jsonResponse({ error: { code: "refresh_token_reused" } }, 400);
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${cliRotatedJwt}`);
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));

    expect(snapshot.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The CLI's rotation stays untouched on disk.
    const tokens = readAuthFile(authPath).tokens as Record<string, unknown>;
    expect(tokens.refresh_token).toBe("cli-rotated-refresh-token");
  });

  it("returns needs-auth without fetching usage when the refresh token is dead", async () => {
    const { codexHome } = makeCodexHome({
      tokens: {
        access_token: makeJwt(NOW_MS - 60_000),
        refresh_token: "expired-refresh-token",
      },
    });

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("auth.openai.com/oauth/token")) {
        return jsonResponse({ error: { code: "refresh_token_expired" } }, 400);
      }
      throw new Error("must not fetch usage with a dead credential");
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));
    expect(snapshot.status).toBe("needs-auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps using the stored token when the refresh endpoint is unavailable", async () => {
    const staleJwt = makeJwt(NOW_MS + 60_000); // inside the 5-minute refresh window, still valid
    const { codexHome, authPath } = makeCodexHome({
      tokens: { access_token: staleJwt, refresh_token: "refresh-token" },
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("auth.openai.com/oauth/token")) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${staleJwt}`);
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));
    expect(snapshot.status).toBe("ok");
    // A failed refresh must not corrupt the stored credential.
    const tokens = readAuthFile(authPath).tokens as Record<string, unknown>;
    expect(tokens.refresh_token).toBe("refresh-token");
  });

  it("refreshes and retries once when the usage endpoint rejects an unexpired token", async () => {
    const currentJwt = makeJwt(NOW_MS + 60 * 60 * 1000); // not due for proactive refresh
    const freshJwt = makeJwt(NOW_MS + 8 * 24 * 60 * 60 * 1000);
    const { codexHome, authPath } = makeCodexHome({
      tokens: { access_token: currentJwt, refresh_token: "refresh-after-401" },
    });

    let usageCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("auth.openai.com/oauth/token")) {
        return jsonResponse({ access_token: freshJwt, refresh_token: "rotated-refresh-token" });
      }
      usageCalls += 1;
      if (usageCalls === 1) {
        return jsonResponse({ detail: "Unauthorized" }, 401);
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${freshJwt}`);
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));
    expect(snapshot.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const tokens = readAuthFile(authPath).tokens as Record<string, unknown>;
    expect(tokens.access_token).toBe(freshJwt);
    expect(tokens.refresh_token).toBe("rotated-refresh-token");
  });
});
