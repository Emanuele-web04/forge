// FILE: providerUsage/providers/claude.test.ts
// Purpose: Covers Claude's CLI-delegated token lifecycle — expired/rejected credentials trigger
// a `claude auth status` nudge (never a direct OAuth token call, which would burn the CLI's
// single-use rotating refresh token) — plus source fallthrough and rate-limit resilience.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import {
  __resetClaudeUsageRateLimitState,
  __setClaudeAuthNudgeDepsForTests,
  claudeUsageFetcher,
} from "./claude";

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

function rateLimitedResponse(retryAfterSeconds?: number): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(retryAfterSeconds);
  }
  return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers });
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

function makeClaudeHome(creds: Record<string, unknown>) {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-claude-usage-"));
  tempDirs.push(homeDir);
  const claudeDir = nodePath.join(homeDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const credentialsPath = nodePath.join(claudeDir, ".credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: creds }), "utf8");
  return { homeDir, credentialsPath };
}

function makeClaudeConfigDir(creds: Record<string, unknown>) {
  const configDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-claude-config-"));
  tempDirs.push(configDir);
  const credentialsPath = nodePath.join(configDir, ".credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: creds }), "utf8");
  return { configDir, credentialsPath };
}

function writeClaudeCreds(credentialsPath: string, creds: Record<string, unknown>): void {
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: creds }), "utf8");
}

/** Install a nudge stub so no test can ever exec a real `claude` binary or take the shared
 * process-wide auth-status lock. */
function stubAuthNudge(
  runAuthStatus: (input: {
    binaryPath: string;
    homeDir: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<void> = async () => {},
) {
  const runMock = vi.fn(runAuthStatus);
  __setClaudeAuthNudgeDepsForTests({
    acquireLock: async () => () => {},
    runAuthStatus: runMock,
  });
  return runMock;
}

beforeEach(() => {
  __resetClaudeUsageRateLimitState();
  readKeychainPasswordMock.mockReset();
  readKeychainPasswordMock.mockResolvedValue(null);
  stubAuthNudge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetClaudeUsageRateLimitState();
  __setClaudeAuthNudgeDepsForTests(null);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claudeUsageFetcher", () => {
  it("prefers the current macOS account before the service-only keychain fallback", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-claude-keychain-"));
    tempDirs.push(homeDir);
    readKeychainPasswordMock.mockResolvedValueOnce(null).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "keychain-access-token",
          expiresAt: NOW_MS + 60 * 60 * 1000,
          scopes: ["user:profile"],
        },
      }),
    );
    stubOutboundFetch(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer keychain-access-token",
      );
      return jsonResponse({ five_hour: { utilization: 7 } });
    });

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: { USER: "current-user" },
      platform: "darwin",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(readKeychainPasswordMock).toHaveBeenNthCalledWith(1, {
      service: "Claude Code-credentials",
      account: "current-user",
      platform: "darwin",
    });
    expect(readKeychainPasswordMock).toHaveBeenNthCalledWith(2, {
      service: "Claude Code-credentials",
      platform: "darwin",
    });
  });

  it("delegates an expired credential to the Claude CLI and never calls the OAuth token endpoint", async () => {
    const { homeDir, credentialsPath } = makeClaudeHome({
      accessToken: "expired-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: NOW_MS - 60_000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });

    // The CLI refreshes and persists its own rotated credential when nudged.
    const runMock = stubAuthNudge(async () => {
      writeClaudeCreds(credentialsPath, {
        accessToken: "fresh-access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt: NOW_MS + 8 * 60 * 60 * 1000,
        scopes: ["user:profile"],
        subscriptionType: "pro",
      });
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/oauth/token")) {
        throw new Error("must never call the OAuth token endpoint for Claude");
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer fresh-access-token");
      return jsonResponse({
        five_hour: { utilization: 12, resets_at: "2026-06-09T12:00:00Z" },
      });
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
      claudeBinaryPath: "/custom/bin/claude",
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(12);
    expect(snapshot.planName).toBe("Pro");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/custom/bin/claude", homeDir }),
    );
  });

  it("nudges the CLI and retries once when the usage endpoint rejects a stale token", async () => {
    const { homeDir, credentialsPath } = makeClaudeHome({
      accessToken: "stale-access-token",
      refreshToken: "refresh-after-401",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
    });

    const runMock = stubAuthNudge(async () => {
      writeClaudeCreds(credentialsPath, {
        accessToken: "retried-access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt: NOW_MS + 8 * 60 * 60 * 1000,
        scopes: ["user:profile"],
      });
    });

    let usageCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/oauth/token")) {
        throw new Error("must never call the OAuth token endpoint for Claude");
      }
      usageCalls += 1;
      if (usageCalls === 1) {
        return jsonResponse({ error: "invalid_token" }, 401);
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer retried-access-token");
      return jsonResponse({
        seven_day: { utilization: 45, resets_at: "2026-06-15T12:00:00Z" },
      });
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits.find((limit) => limit.window === "Weekly")?.usedPercent).toBe(45);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("returns needs-auth without hitting the API when the CLI cannot refresh an expired credential", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "expired-access-token",
      refreshToken: "dead-refresh-token",
      expiresAt: NOW_MS - 60_000,
      scopes: ["user:profile"],
    });

    const runMock = stubAuthNudge(async () => {
      throw new Error("Not logged in");
    });
    const fetchMock = vi.fn(async () => jsonResponse({}));
    stubOutboundFetch(fetchMock);

    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };
    const snapshot = await claudeUsageFetcher.fetch(ctx);
    expect(snapshot.status).toBe("needs-auth");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledTimes(1);

    // Within the nudge cooldown, further polls do not re-spawn the CLI.
    const again = await claudeUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 30_000 });
    expect(again.status).toBe("needs-auth");
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next credential source when the first token is rejected", async () => {
    const { configDir } = makeClaudeConfigDir({
      accessToken: "shadowing-stale-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });
    const { homeDir } = makeClaudeHome({
      accessToken: "valid-home-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "max",
      rateLimitTier: "claude_max_subscription_5x",
    });

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers.Authorization === "Bearer shadowing-stale-access-token") {
        return jsonResponse({ error: "invalid_token" }, 401);
      }
      expect(headers.Authorization).toBe("Bearer valid-home-access-token");
      return jsonResponse({
        five_hour: { utilization: 56, resets_at: "2026-06-09T12:00:00Z" },
      });
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Max (5x)");
    expect(snapshot.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(56);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good usage when Anthropic rate-limits the usage endpoint", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "rate-limit-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });

    let throttle = false;
    const fetchMock = vi.fn(async () =>
      throttle
        ? rateLimitedResponse(120)
        : jsonResponse({ five_hour: { utilization: 33, resets_at: "2026-06-09T12:00:00Z" } }),
    );
    stubOutboundFetch(fetchMock);

    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };

    const first = await claudeUsageFetcher.fetch(ctx);
    expect(first.status).toBe("ok");
    expect(first.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);

    // Next poll is throttled: keep the last values, mark them stale, and honor Retry-After (~2m).
    throttle = true;
    const throttled = await claudeUsageFetcher.fetch(ctx);
    expect(throttled.status).toBe("ok");
    expect(throttled.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);
    expect(throttled.detail).toContain("rate-limiting");
    expect(throttled.detail).toContain("~2m");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // While the cooldown is active, subsequent polls serve the cache without re-hitting Anthropic.
    const cached = await claudeUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 30_000 });
    expect(cached.status).toBe("ok");
    expect(cached.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serve cached cooldown usage after Claude credentials switch", async () => {
    const { homeDir, credentialsPath } = makeClaudeHome({
      accessToken: "first-rate-limit-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });

    let throttle = false;
    const authorizations: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (authorization === undefined) {
        throw new Error("Claude usage request did not include an Authorization header");
      }
      authorizations.push(authorization);
      return throttle
        ? rateLimitedResponse(120)
        : jsonResponse({ five_hour: { utilization: 33, resets_at: "2026-06-09T12:00:00Z" } });
    });
    stubOutboundFetch(fetchMock);

    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };

    const first = await claudeUsageFetcher.fetch(ctx);
    expect(first.status).toBe("ok");
    expect(first.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);

    throttle = true;
    const throttled = await claudeUsageFetcher.fetch(ctx);
    expect(throttled.status).toBe("ok");
    expect(throttled.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);

    writeClaudeCreds(credentialsPath, {
      accessToken: "second-rate-limit-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });

    const afterSwitch = await claudeUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 30_000 });
    expect(afterSwitch.status).toBe("error");
    expect(afterSwitch.limits).toHaveLength(0);
    expect(afterSwitch.detail).toContain("rate-limiting");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(authorizations).toEqual([
      "Bearer first-rate-limit-access-token",
      "Bearer first-rate-limit-access-token",
      "Bearer second-rate-limit-access-token",
    ]);
  });

  it("surfaces a rate-limit error when throttled before any successful fetch", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "cold-rate-limit-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
    });

    const fetchMock = vi.fn(async () => rateLimitedResponse());
    stubOutboundFetch(fetchMock);

    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };
    const snapshot = await claudeUsageFetcher.fetch(ctx);

    expect(snapshot.status).toBe("error");
    expect(snapshot.detail).toContain("rate-limiting");
    expect(snapshot.limits).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Even with no cached usage to show, the cooldown must stop us from hammering the throttled
    // endpoint on every poll.
    const duringCooldown = await claudeUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 30_000 });
    expect(duringCooldown.status).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
