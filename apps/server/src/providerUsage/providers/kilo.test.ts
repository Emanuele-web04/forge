// FILE: providerUsage/providers/kilo.test.ts
// Purpose: Covers Kilo's CLI-auth read and tRPC usage parsing — credit blocks,
// Kilo Pass state, and auto top-up — plus auth-failure/error mapping. The batch
// response shape mirrors the Kilo CLI's own tRPC batch endpoint.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import { __authFilePathsForTests, kiloUsageFetcher, parseKiloUsage } from "./kilo";

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

function makeKiloHome(auth: Record<string, unknown> | null) {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-kilo-usage-"));
  tempDirs.push(homeDir);
  if (auth !== null) {
    const authDir = nodePath.join(homeDir, ".local", "share", "kilo");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(nodePath.join(authDir, "auth.json"), JSON.stringify(auth), "utf8");
  }
  return homeDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeContext(homeDir: string) {
  return {
    homeDir,
    env: {},
    platform: "darwin" as NodeJS.Platform,
    nowMs: NOW_MS,
  };
}

const batchEntries = [
  {
    result: {
      data: {
        creditBlocks: [{ amount_mUsd: 5_000_000 }],
        deductions: [],
        totalBalance_mUsd: 1_250_000,
        isFirstPurchase: false,
        autoTopUpEnabled: false,
      },
    },
  },
  {
    result: {
      data: {
        subscription: {
          name: "Kilo Pro",
          total_mUsd: 20_000_000,
          used_mUsd: 8_000_000,
          renewalAt: "2026-09-01T00:00:00.000Z",
        },
      },
    },
  },
  {
    result: {
      data: {
        enabled: true,
        amountCents: 5_000,
        paymentMethod: null,
      },
    },
  },
];

describe("parseKiloUsage", () => {
  it("maps credit blocks, pass state, and auto top-up into limits and lines", () => {
    const snapshot = parseKiloUsage({ entries: batchEntries, nowMs: NOW_MS });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.source).toBe("kilo-trpc-usage");
    expect(snapshot.planName).toBe("Kilo Pro");
    expect(snapshot.limits).toHaveLength(1);
    expect(snapshot.limits[0]?.window).toBe("Credits");
    expect(snapshot.limits[0]?.usedPercent).toBeCloseTo(25, 2);
    const lines = snapshot.usageLines.map((line) => line.label);
    expect(lines).toContain("Credits");
    expect(lines).toContain("Plan");
    expect(lines).toContain("Kilo Pass");
    expect(lines).toContain("Auto top-up");
  });

  it("keeps credits visible when only a used balance is reported", () => {
    const entries = [
      { result: { data: { creditBlocks: [], deductions: [], totalBalance_mUsd: 250_000 } } },
      { result: { data: { subscription: null } } },
      { result: { data: { enabled: false } } },
    ];
    const snapshot = parseKiloUsage({ entries, nowMs: NOW_MS });
    expect(snapshot.limits).toHaveLength(0);
    expect(snapshot.usageLines.some((line) => line.label === "Credits")).toBe(true);
    expect(snapshot.planName).toBeUndefined();
  });

  it("does not invent limits when the batch has no usage payloads", () => {
    const snapshot = parseKiloUsage({ entries: [{}, {}], nowMs: NOW_MS });
    expect(snapshot.limits).toHaveLength(0);
    expect(snapshot.usageLines).toHaveLength(0);
  });
});

describe("kiloUsageFetcher", () => {
  it("resolves auth from the CLI auth.json and fetches the tRPC batch", async () => {
    const homeDir = makeKiloHome({ kilo: { access: "kilo-test-token" } });
    let seenUrl: string | null = null;
    let seenAuth: string | null = null;
    stubOutboundFetch(async (url, init) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse(batchEntries);
    });

    const snapshot = await kiloUsageFetcher.fetch(makeContext(homeDir));
    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Kilo Pro");
    expect(seenUrl).toContain("user.getCreditBlocks");
    expect(seenUrl).toContain("kiloPass.getState");
    expect(seenUrl).toContain("user.getAutoTopUpPaymentMethod");
    expect(seenUrl).toContain("batch=1");
    expect(seenAuth).toBe("Bearer kilo-test-token");
  });

  it("returns needs-auth when the CLI auth file is missing", async () => {
    const homeDir = makeKiloHome(null);
    const snapshot = await kiloUsageFetcher.fetch(makeContext(homeDir));
    expect(snapshot.status).toBe("needs-auth");
    expect(snapshot.detail).toContain("kilo login");
  });

  it("maps a 401 to needs-auth without reading a refresh token", async () => {
    const homeDir = makeKiloHome({ kilo: { access: "expired-token" } });
    stubOutboundFetch(async () => jsonResponse({ error: "unauthorized" }, 401));
    const snapshot = await kiloUsageFetcher.fetch(makeContext(homeDir));
    expect(snapshot.status).toBe("needs-auth");
    expect(snapshot.detail).toContain("re-authenticate");
  });

  it("maps unexpected failures to an error snapshot, never throwing", async () => {
    const homeDir = makeKiloHome({ kilo: { access: "token" } });
    stubOutboundFetch(async () => jsonResponse({}, 503));
    const snapshot = await kiloUsageFetcher.fetch(makeContext(homeDir));
    expect(snapshot.status).toBe("error");
    expect(snapshot.detail).toContain("503");
  });

  it("uses the Kilo data dir auth file when home has none", () => {
    const ctx = makeContext("/home/none");
    const paths = __authFilePathsForTests({ ...ctx, env: { KILO_DATA_DIR: "/custom/kilo" } });
    expect(paths[0]).toBe(nodePath.join("/home/none", ".local", "share", "kilo", "auth.json"));
    expect(paths[1]).toBe(nodePath.join("/custom/kilo", "auth.json"));
  });
});
