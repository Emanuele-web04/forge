// FILE: providerUsage/providers/devin.test.ts
// Purpose: Covers Devin credential fallthrough (env key, stored `devin auth login`
// credentials) and GetUserStatus request/auth handling.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import { devinUsageFetcher } from "./devin";

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

function makeDevinHome(credentials: string) {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-devin-usage-"));
  tempDirs.push(homeDir);
  const credentialsDir = nodePath.join(homeDir, ".local", "share", "devin");
  mkdirSync(credentialsDir, { recursive: true });
  writeFileSync(nodePath.join(credentialsDir, "credentials.toml"), credentials, "utf8");
  return homeDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("devinUsageFetcher", () => {
  it("returns needs-auth when no API key is available", async () => {
    const snapshot = await devinUsageFetcher.fetch({
      homeDir: "/nonexistent-home",
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("needs-auth");
    expect(snapshot.detail).toContain("devin auth login");
  });

  it("prefers WINDSURF_API_KEY and posts GetUserStatus with the key", async () => {
    stubOutboundFetch(async (url, init) => {
      expect(String(url)).toBe(
        "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer env-key");
      const body = JSON.parse(String(init?.body)) as {
        metadata?: { apiKey?: string; ideName?: string };
      };
      expect(body.metadata?.apiKey).toBe("env-key");
      expect(body.metadata?.ideName).toBe("devin");
      return jsonResponse({
        userStatus: {
          planStatus: {
            planInfo: { planName: "teams" },
            dailyQuotaRemainingPercent: 80,
            weeklyQuotaRemainingPercent: 60,
          },
        },
      });
    });

    const snapshot = await devinUsageFetcher.fetch({
      homeDir: "/nonexistent-home",
      env: { WINDSURF_API_KEY: "env-key" },
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Teams");
    expect(snapshot.limits.find((limit) => limit.window === "Daily")?.usedPercent).toBe(20);
  });

  it("reads the stored Devin CLI API key when env is unset", async () => {
    const homeDir = makeDevinHome(`windsurf_api_key = "stored-key"\n`);
    stubOutboundFetch(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer stored-key");
      return jsonResponse({
        user_status: {
          plan_status: {
            acu_consumed: 1,
            acu_limit: 10,
          },
        },
      });
    });

    const snapshot = await devinUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.usageLines.find((line) => line.label === "ACU")?.value).toBe("1 of 10 ACU");
  });

  it("treats a 401 from GetUserStatus as needs-auth", async () => {
    stubOutboundFetch(async () => jsonResponse({ error: "unauthorized" }, 401));

    const snapshot = await devinUsageFetcher.fetch({
      homeDir: "/nonexistent-home",
      env: { DEVIN_API_KEY: "expired-key" },
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("needs-auth");
  });

  it("posts GetUserStatus to WINDSURF_API_SERVER_URL and pins that origin", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockImplementation(async (input) => {
      expect(String(input.url)).toBe(
        "https://api.example.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      );
      expect(input.policy.allowedOrigins).toEqual(["https://api.example.com"]);
      const response = jsonResponse({
        userStatus: { planStatus: { dailyQuotaRemainingPercent: 50 } },
      });
      return {
        status: response.status,
        headers: response.headers,
        body: new Uint8Array(await response.arrayBuffer()),
        url: String(input.url),
      };
    });

    const snapshot = await devinUsageFetcher.fetch({
      homeDir: "/nonexistent-home",
      env: {
        WINDSURF_API_KEY: "env-key",
        WINDSURF_API_SERVER_URL: "https://api.example.com/",
      },
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits.find((limit) => limit.window === "Daily")?.usedPercent).toBe(50);
  });

  it("uses the stored api_server_url when env does not override it", async () => {
    const homeDir = makeDevinHome(
      `windsurf_api_key = "stored-key"\napi_server_url = "https://enterprise.devin.example"\n`,
    );
    stubOutboundFetch(async (url, init) => {
      expect(String(url)).toBe(
        "https://enterprise.devin.example/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer stored-key");
      return jsonResponse({ user_status: { plan_status: { acu_consumed: 1 } } });
    });

    const snapshot = await devinUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
  });

  it("reports an error when the configured API server URL is invalid", async () => {
    const snapshot = await devinUsageFetcher.fetch({
      homeDir: "/nonexistent-home",
      env: {
        DEVIN_API_KEY: "env-key",
        DEVIN_API_SERVER_URL: "not-a-url",
      },
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("error");
    expect(snapshot.detail).toContain("API server URL is invalid");
  });
});
