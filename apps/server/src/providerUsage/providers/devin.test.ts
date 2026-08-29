// FILE: providerUsage/providers/devin.test.ts
// Purpose: Covers Devin credential fallthrough (env key, stored `devin auth login`
// credentials) and GetUserStatus request/auth handling.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp, type OutboundHttpPolicy } from "@synara/shared/outboundHttp";
import { devinUsageFetcher, parseDevinUsage } from "./devin";

const NOW_MS = 1_780_000_000_000;
const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubOutboundFetch(
  fetchMock: (
    url: string | URL | Request,
    init?: RequestInit,
    policy?: OutboundHttpPolicy,
  ) => Promise<Response>,
): void {
  vi.spyOn(outboundHttp, "request").mockImplementation(async (input) => {
    const init: RequestInit = {
      headers: input.headers,
    };
    if (input.method !== undefined) {
      init.method = input.method;
    }
    if (input.body !== undefined) {
      init.body = input.body;
    }
    const response = await fetchMock(input.url, init, input.policy);
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
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer env-key");
      // SAFETY: devinUsageFetcher constructs the body from the resolved auth, so
      // JSON.parse of the captured request body yields the metadata object below.
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
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer stored-key");
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
      expect(input.policy.requirePublicAddress).toBe(true);
      expect(input.policy.allowLoopbackHttp).toBeUndefined();
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
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer stored-key");
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

  it.each([
    ["localhost", "http://localhost:3000"],
    ["IPv4 loopback", "http://127.0.0.1:3000"],
    ["IPv6 loopback", "http://[::1]:3000"],
  ])("allows HTTP for %s", async (_hostKind, apiServerUrl) => {
    stubOutboundFetch(async (url, _init, policy) => {
      expect(String(url)).toBe(
        `${apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      );
      expect(policy?.allowLoopbackHttp).toBe(true);
      expect(policy?.requirePublicAddress).toBe(true);
      return jsonResponse({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 50 } } });
    });

    const snapshot = await devinUsageFetcher.fetch({
      homeDir: "/nonexistent-home",
      env: {
        DEVIN_API_KEY: "env-key",
        DEVIN_API_SERVER_URL: apiServerUrl,
      },
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
  });

  it.each([
    ["non-loopback HTTP", "http://api.example.com"],
    ["an unsupported protocol", "ftp://localhost:3000"],
  ])("rejects %s API server URLs", async (_case, apiServerUrl) => {
    const request = vi.spyOn(outboundHttp, "request");
    const snapshot = await devinUsageFetcher.fetch({
      homeDir: "/nonexistent-home",
      env: {
        DEVIN_API_KEY: "env-key",
        DEVIN_API_SERVER_URL: apiServerUrl,
      },
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(request).not.toHaveBeenCalled();
    expect(snapshot.status).toBe("error");
    expect(snapshot.detail).toContain("API server URL is invalid");
  });
});

describe("parseDevinUsage", () => {
  it("falls back to the daily quota for the weekly limit when the daily quota is hidden", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: {
            dailyQuotaRemainingPercent: 70,
            weeklyQuotaResetAtUnix: 1_790_000_000,
            planInfo: { hideDailyQuota: true },
          },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([
      {
        window: "Weekly",
        usedPercent: 30,
        resetsAt: "2026-09-21T14:13:20.000Z",
        windowDurationMins: 10_080,
      },
    ]);
    expect(snapshot.usageLines).toEqual([]);
  });

  it("uses the weekly quota directly when present even with a hidden daily quota", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: {
            dailyQuotaRemainingPercent: 70,
            weeklyQuotaRemainingPercent: 40,
            planInfo: { hide_daily_quota: true },
          },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.limits.find((limit) => limit.window === "Weekly")?.usedPercent).toBe(60);
    expect(snapshot.limits.find((limit) => limit.window === "Daily")).toBeUndefined();
  });

  it("formats prompt and flex credits into usage lines", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: {
            usedPromptCredits: 150,
            availablePromptCredits: 350,
            usedFlexCredits: 25,
          },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.usageLines).toEqual([
      { label: "Prompt credits", value: "150 of 500" },
      { label: "Flex credits", value: "25 used" },
    ]);
    expect(snapshot.limits).toEqual([]);
  });

  it("rounds fractional credit amounts to two decimals", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: {
            usedPromptCredits: 12.5,
            availablePromptCredits: 87.5,
          },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.usageLines.find((line) => line.label === "Prompt credits")?.value).toBe(
      "12.5 of 100",
    );
  });

  it("suppresses credit lines for negative available credits", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: {
            usedPromptCredits: 10,
            availablePromptCredits: -5,
          },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.usageLines).toEqual([]);
  });

  it("formats the overage balance in micros as a USD remaining line", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: { overageBalanceMicros: 5_000_000 },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.usageLines).toEqual([
      { label: "Extra usage balance", value: "$5.00 remaining" },
    ]);
  });

  it("adds a Current limit from planEnd when no other quota limits exist", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: { planEnd: 1_790_000_000 },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.limits).toEqual([{ window: "Current", resetsAt: "2026-09-21T14:13:20.000Z" }]);
  });

  it("falls back to a string end_date on plan info for the Current limit", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: { plan_info: { end_date: "2026-10-01T00:00:00Z" } },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.limits).toEqual([{ window: "Current", resetsAt: "2026-10-01T00:00:00.000Z" }]);
  });

  it("renders no credit lines for a free plan with zero credits", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: {
            usedPromptCredits: 0,
            availablePromptCredits: 0,
            usedFlexCredits: 0,
            availableFlexCredits: 0,
          },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.usageLines).toEqual([]);
    expect(snapshot.limits).toEqual([]);
  });

  it("tolerates malformed numeric and date fields", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: {
            dailyQuotaRemainingPercent: "not-a-number",
            planEnd: "not-a-date",
          },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([]);
    expect(snapshot.usageLines).toEqual([]);
  });

  it("tolerates a non-object payload", () => {
    const snapshot = parseDevinUsage({ json: 42, nowMs: NOW_MS });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([]);
    expect(snapshot.usageLines).toEqual([]);
  });

  it("maps 100% remaining to 0% used", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: { dailyQuotaRemainingPercent: 100 },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.limits.find((limit) => limit.window === "Daily")?.usedPercent).toBe(0);
  });

  it("maps 0% remaining to 100% used", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: { dailyQuotaRemainingPercent: 0 },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.limits.find((limit) => limit.window === "Daily")?.usedPercent).toBe(100);
  });

  it("clamps remaining above 100% to 0% used", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: { weeklyQuotaRemainingPercent: 150 },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.limits.find((limit) => limit.window === "Weekly")?.usedPercent).toBe(0);
  });

  it("clamps negative remaining to 100% used", () => {
    const snapshot = parseDevinUsage({
      json: {
        userStatus: {
          planStatus: { weeklyQuotaRemainingPercent: -50 },
        },
      },
      nowMs: NOW_MS,
    });

    expect(snapshot.limits.find((limit) => limit.window === "Weekly")?.usedPercent).toBe(100);
  });
});
