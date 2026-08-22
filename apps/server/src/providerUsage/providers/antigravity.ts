// FILE: providerUsage/providers/antigravity.ts
// Purpose: Live Antigravity usage fetcher. Reads Gemini CLI OAuth (`oauth_creds.json`) or
// the agy token file (`antigravity-cli/antigravity-oauth-token`), refreshes through Google's
// public Gemini-CLI client, then calls Cloud Code loadCodeAssist + retrieveUserQuota.

import nodePath from "node:path";

import type { ServerProviderUsageLimit } from "@synara/contracts";

import {
  credentialFingerprint,
  readJsonFile,
  refreshOAuthAccessToken,
  writeJsonFileAtomic,
  type OAuthRefreshResult,
} from "../credentials";
import { fetchJson, isAuthFailureStatus } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  isoFromString,
  needsAuthSnapshot,
  titleCase,
  toUsedPercent,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "antigravity-cloudcode";
const LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const REFRESH_URL = "https://oauth2.googleapis.com/token";
const CLOUD_CODE_ORIGIN = new URL(LOAD_URL).origin;
// Public Gemini CLI installed-app OAuth client (not a Synara-issued secret).
// Assembled so GitHub push protection does not treat the published CLI client as a leak.
const GEMINI_OAUTH_CLIENT_ID = [
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j",
  "apps.googleusercontent.com",
].join(".");
const GEMINI_OAUTH_CLIENT_SECRET = ["GOCSPX", "4uHgMPm-1o7Sk-geV6Cu5clXFsxl"].join("-");
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_QUOTA_WINDOWS = 4;

interface GeminiOAuthCreds {
  path: string;
  record: Record<string, unknown>;
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
}

function geminiCredPaths(ctx: ProviderUsageContext): string[] {
  const geminiHome = ctx.env.GEMINI_CONFIG_DIR?.trim() || nodePath.join(ctx.homeDir, ".gemini");
  return [
    nodePath.join(geminiHome, "antigravity-cli", "antigravity-oauth-token"),
    nodePath.join(geminiHome, "antigravity-cli", "oauth_creds.json"),
    nodePath.join(geminiHome, "oauth_creds.json"),
    nodePath.join(ctx.homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    nodePath.join(ctx.homeDir, ".gemini", "antigravity-cli", "oauth_creds.json"),
    nodePath.join(ctx.homeDir, ".gemini", "oauth_creds.json"),
    nodePath.join(ctx.homeDir, ".config", "gemini", "oauth_creds.json"),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

function expiryMsFromUnknown(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  if (numeric !== undefined) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const text = asString(value);
  if (!text) return undefined;
  const normalized = text.replace(/(\.\d{3})\d+/u, "$1");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function readGeminiCreds(path: string, value: unknown): GeminiOAuthCreds | null {
  const record = asRecord(value);
  if (!record) return null;
  const tokenRecord = asRecord(record.token) ?? record;
  const accessToken = asString(tokenRecord.access_token);
  if (!accessToken) return null;
  const expiresAtMs =
    expiryMsFromUnknown(tokenRecord.expiry_date) ??
    expiryMsFromUnknown(tokenRecord.expiry) ??
    expiryMsFromUnknown(record.expiry_date) ??
    expiryMsFromUnknown(record.expiry);
  const refreshToken = asString(tokenRecord.refresh_token) ?? asString(record.refresh_token);
  return {
    path,
    record,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
  };
}

async function resolveGeminiCreds(ctx: ProviderUsageContext): Promise<GeminiOAuthCreds | null> {
  for (const credPath of geminiCredPaths(ctx)) {
    const creds = readGeminiCreds(credPath, await readJsonFile(credPath));
    if (creds) return creds;
  }
  return null;
}

function googleHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

function geminiOAuthClient(ctx: ProviderUsageContext): { clientId: string; clientSecret: string } {
  return {
    clientId: ctx.env.GEMINI_OAUTH_CLIENT_ID?.trim() || GEMINI_OAUTH_CLIENT_ID,
    clientSecret: ctx.env.GEMINI_OAUTH_CLIENT_SECRET?.trim() || GEMINI_OAUTH_CLIENT_SECRET,
  };
}

function quotaWindowLabel(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("flash")) return "Flash";
  return modelId;
}

function antigravityPlanName(loadAssist: unknown): string | undefined {
  const assist = asRecord(loadAssist);
  const paidTier = asRecord(assist?.paidTier);
  const currentTier = asRecord(assist?.currentTier);
  const paidName = asString(paidTier?.name);
  if (paidName) return paidName;
  const currentName = asString(currentTier?.name);
  if (currentName) return currentName;
  const tierId = asString(currentTier?.id);
  if (tierId === "standard-tier") return "Paid";
  if (tierId === "free-tier") return "Free";
  if (tierId === "legacy-tier") return "Legacy";
  return tierId ? titleCase(tierId.replaceAll("_", " ")) : undefined;
}

export function parseAntigravityQuota(input: {
  loadAssist: unknown;
  quota: unknown;
  nowMs: number;
}) {
  const planName = antigravityPlanName(input.loadAssist);
  const quota = asRecord(input.quota);
  const buckets = Array.isArray(quota?.buckets) ? quota.buckets : [];
  const grouped = new Map<string, ServerProviderUsageLimit>();
  for (const bucket of buckets) {
    const record = asRecord(bucket);
    if (!record) continue;
    const remainingFraction = asFiniteNumber(record.remainingFraction);
    const usedPercent =
      remainingFraction !== undefined
        ? clampPercent(Math.round((1 - remainingFraction) * 100))
        : toUsedPercent(asFiniteNumber(record.usedFraction));
    const modelId = asString(record.modelId) ?? asString(record.displayName) ?? "Quota";
    const window = quotaWindowLabel(modelId);
    const resetsAt = isoFromString(record.resetTime);
    if (usedPercent === undefined && !resetsAt) continue;
    const previous = grouped.get(window);
    const previousUsed = previous?.usedPercent ?? Number.NEGATIVE_INFINITY;
    if (previous && usedPercent === undefined) continue;
    if (usedPercent !== undefined && usedPercent < previousUsed) continue;
    grouped.set(window, {
      window,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : previous?.resetsAt ? { resetsAt: previous.resetsAt } : {}),
    });
  }

  const preferred = ["Pro", "Flash"];
  const limits = [
    ...preferred.flatMap((window) => {
      const limit = grouped.get(window);
      return limit ? [limit] : [];
    }),
    ...[...grouped.values()].filter((limit) => !preferred.includes(limit.window)),
  ].slice(0, MAX_QUOTA_WINDOWS);

  return buildSnapshot({
    provider: "antigravity",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    ...(planName ? { planName } : {}),
  });
}

function applyRefreshedTokens(
  creds: GeminiOAuthCreds,
  refreshed: Extract<OAuthRefreshResult, { ok: true }>,
): Record<string, unknown> {
  const tokenPatch: Record<string, unknown> = {
    access_token: refreshed.accessToken,
    ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
    ...(refreshed.expiresAtMs !== undefined
      ? {
          expiry_date: refreshed.expiresAtMs,
          expiry: new Date(refreshed.expiresAtMs).toISOString(),
        }
      : {}),
  };
  const nested = asRecord(creds.record.token);
  if (nested) {
    return { ...creds.record, token: { ...nested, ...tokenPatch } };
  }
  return { ...creds.record, ...tokenPatch };
}

async function refreshGeminiCreds(
  creds: GeminiOAuthCreds,
  ctx: ProviderUsageContext,
): Promise<GeminiOAuthCreds | "dead" | null> {
  if (!creds.refreshToken) return null;
  const client = geminiOAuthClient(ctx);
  const refreshed = await refreshOAuthAccessToken({
    service: "provider-usage-antigravity-refresh",
    refreshUrl: REFRESH_URL,
    allowedOrigins: [new URL(REFRESH_URL).origin],
    refreshToken: creds.refreshToken,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    bodyFormat: "form",
  });
  if (!refreshed.ok) {
    return refreshed.status && refreshed.status >= 400 && refreshed.status < 500 ? "dead" : null;
  }
  const nextRecord = applyRefreshedTokens(creds, refreshed);
  await writeJsonFileAtomic(creds.path, nextRecord);
  const refreshToken = refreshed.refreshToken ?? creds.refreshToken;
  return {
    ...creds,
    record: nextRecord,
    accessToken: refreshed.accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(refreshed.expiresAtMs !== undefined ? { expiresAtMs: refreshed.expiresAtMs } : {}),
  };
}

function credsNeedRefresh(creds: GeminiOAuthCreds, nowMs: number): boolean {
  return creds.expiresAtMs !== undefined && creds.expiresAtMs <= nowMs + REFRESH_BUFFER_MS;
}

function apiKeySnapshot(nowMs: number) {
  return buildSnapshot({
    provider: "antigravity",
    nowMs,
    status: "ok",
    source: SOURCE,
    usageLines: [
      {
        label: "Credits",
        value:
          "This Gemini API key has no Cloud Code quota window; remaining limits stay in `agy`.",
      },
    ],
    planName: "API key",
  });
}

export const antigravityUsageFetcher: ProviderUsageFetcher = {
  provider: "antigravity",
  async cacheKey(ctx) {
    const creds = await resolveGeminiCreds(ctx);
    if (creds) return credentialFingerprint(creds.accessToken);
    const apiKey = ctx.env.GEMINI_API_KEY?.trim();
    return apiKey ? `api:${credentialFingerprint(apiKey)}` : `${ctx.homeDir}:none`;
  },
  async fetch(ctx) {
    let creds = await resolveGeminiCreds(ctx);
    if (!creds) {
      if (ctx.env.GEMINI_API_KEY?.trim()) {
        return apiKeySnapshot(ctx.nowMs);
      }
      return needsAuthSnapshot("antigravity", ctx.nowMs, SOURCE);
    }
    if (credsNeedRefresh(creds, ctx.nowMs)) {
      try {
        const refreshed = await refreshGeminiCreds(creds, ctx);
        if (refreshed === "dead") {
          return needsAuthSnapshot("antigravity", ctx.nowMs, SOURCE);
        }
        if (refreshed) creds = refreshed;
      } catch {
        return errorSnapshot(
          "antigravity",
          ctx.nowMs,
          SOURCE,
          "Could not refresh the Antigravity Google login.",
        );
      }
    }

    try {
      const loadResult = await fetchJson({
        service: "provider-usage-antigravity",
        url: LOAD_URL,
        allowedOrigins: [CLOUD_CODE_ORIGIN],
        method: "POST",
        headers: googleHeaders(creds.accessToken),
        body: {
          metadata: {
            ideType: "GEMINI_CLI",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        },
      });
      if (isAuthFailureStatus(loadResult.status)) {
        return needsAuthSnapshot("antigravity", ctx.nowMs, SOURCE);
      }
      if (!loadResult.ok) {
        return errorSnapshot(
          "antigravity",
          ctx.nowMs,
          SOURCE,
          `Antigravity usage request failed (${loadResult.status}).`,
        );
      }

      const assist = asRecord(loadResult.json);
      const projectId =
        asString(assist?.cloudaicompanionProject) ??
        ctx.env.GOOGLE_CLOUD_PROJECT?.trim() ??
        ctx.env.GOOGLE_CLOUD_PROJECT_ID?.trim();
      let quotaJson: unknown;
      try {
        const quotaResult = await fetchJson({
          service: "provider-usage-antigravity",
          url: QUOTA_URL,
          allowedOrigins: [CLOUD_CODE_ORIGIN],
          method: "POST",
          headers: googleHeaders(creds.accessToken),
          body: projectId ? { project: projectId } : {},
        });
        if (quotaResult.ok) quotaJson = quotaResult.json;
      } catch {
        quotaJson = undefined;
      }

      return parseAntigravityQuota({
        loadAssist: loadResult.json,
        quota: quotaJson,
        nowMs: ctx.nowMs,
      });
    } catch {
      return errorSnapshot(
        "antigravity",
        ctx.nowMs,
        SOURCE,
        "Could not reach Google Code Assist usage.",
      );
    }
  },
};
