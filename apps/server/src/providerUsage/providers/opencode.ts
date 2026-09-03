// FILE: providerUsage/providers/opencode.ts
// Purpose: Live OpenCode usage fetcher. Finds auth.json on the XDG path OpenCode Go uses
// even on Windows (`~/.local/share/opencode`), reads the `opencode-go` API key, and calls
// GET https://opencode.ai/zen/go/v1/usage for the 5h / weekly / monthly Go plan windows.

import type { ServerProviderUsageLimit } from "@synara/contracts";

import { resolveOpenCodeCompatibleAuthPaths } from "../../provider/openCodeAuthPaths";
import { credentialFingerprint, readJsonFile } from "../credentials";
import { fetchJson } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  isoFromString,
  needsAuthSnapshot,
  unsupportedSnapshot,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "opencode-go-usage";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const USAGE_ORIGIN = new URL(USAGE_URL).origin;
const GO_CREDENTIAL_KEYS = ["opencode-go", "opencode"] as const;

const WINDOW_MINUTES = [
  { key: "rolling", window: "5h", minutes: 300 },
  { key: "weekly", window: "Weekly", minutes: 10_080 },
  { key: "monthly", window: "Monthly", minutes: 43_200 },
] as const;

async function readAuthRecord(
  ctx: ProviderUsageContext,
): Promise<{ path: string; record: Record<string, unknown> } | null> {
  for (const authPath of resolveOpenCodeCompatibleAuthPaths({
    homeDir: ctx.homeDir,
    env: ctx.env,
    platform: ctx.platform,
    dataDirectoryName: "opencode",
  })) {
    const record = asRecord(await readJsonFile(authPath));
    if (record && Object.keys(record).length > 0) {
      return { path: authPath, record };
    }
  }
  return null;
}

function readOpenCodeGoKey(record: Record<string, unknown>): string | undefined {
  for (const credentialKey of GO_CREDENTIAL_KEYS) {
    const key = asString(asRecord(record[credentialKey])?.key);
    if (key) return key;
  }
  return undefined;
}

export function parseOpenCodeGoUsage(input: { json: unknown; nowMs: number }) {
  const usage = asRecord(asRecord(input.json)?.usage);
  const limits: ServerProviderUsageLimit[] = [];
  for (const { key, window, minutes } of WINDOW_MINUTES) {
    const entry = asRecord(usage?.[key]);
    if (!entry) continue;
    const percent = clampPercent(asFiniteNumber(entry.percent));
    const resetsAt = isoFromString(entry.resetsAt);
    if (percent === undefined && !resetsAt) continue;
    limits.push({
      window,
      ...(percent !== undefined ? { usedPercent: percent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins: minutes,
    });
  }
  return buildSnapshot({
    provider: "opencode",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    planName: "Go",
    limits,
  });
}

function signedInWithoutGoQuota(nowMs: number) {
  return buildSnapshot({
    provider: "opencode",
    nowMs,
    status: "ok",
    source: SOURCE,
    usageLines: [
      {
        label: "Limits",
        value:
          "OpenCode is signed in locally. Live 5h / weekly / monthly bars need an OpenCode Go login (`opencode auth login`).",
      },
    ],
  });
}

export const opencodeUsageFetcher: ProviderUsageFetcher = {
  provider: "opencode",
  async cacheKey(ctx) {
    const auth = await readAuthRecord(ctx);
    if (!auth) return `${ctx.homeDir}:none`;
    const goKey = readOpenCodeGoKey(auth.record);
    return goKey ? `go:${credentialFingerprint(goKey)}` : `file:${auth.path}`;
  },
  async fetch(ctx) {
    const auth = await readAuthRecord(ctx);
    if (!auth) {
      return needsAuthSnapshot("opencode", ctx.nowMs, SOURCE);
    }
    const goKey = readOpenCodeGoKey(auth.record);
    if (!goKey) {
      return signedInWithoutGoQuota(ctx.nowMs);
    }

    try {
      const result = await fetchJson({
        service: "provider-usage-opencode",
        url: USAGE_URL,
        allowedOrigins: [USAGE_ORIGIN],
        headers: { Authorization: `Bearer ${goKey}` },
      });
      if (result.status === 401) {
        return needsAuthSnapshot("opencode", ctx.nowMs, SOURCE);
      }
      if (result.status === 403) {
        return unsupportedSnapshot(
          "opencode",
          ctx.nowMs,
          SOURCE,
          "This OpenCode Go key is valid but has no active Go subscription.",
        );
      }
      if (!result.ok) {
        return errorSnapshot(
          "opencode",
          ctx.nowMs,
          SOURCE,
          `OpenCode usage request failed (${result.status}).`,
        );
      }
      const snapshot = parseOpenCodeGoUsage({ json: result.json, nowMs: ctx.nowMs });
      if (snapshot.limits.length === 0) {
        return errorSnapshot(
          "opencode",
          ctx.nowMs,
          SOURCE,
          "OpenCode usage response contained no usage windows.",
        );
      }
      return snapshot;
    } catch {
      return errorSnapshot(
        "opencode",
        ctx.nowMs,
        SOURCE,
        "Could not reach the OpenCode usage API.",
      );
    }
  },
};
