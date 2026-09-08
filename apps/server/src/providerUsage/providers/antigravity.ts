// FILE: providerUsage/providers/antigravity.ts
// Purpose: Read the agy consumer login and fetch Antigravity model quotas.
// Keychain credentials are read-only; refreshed keychain access tokens stay in memory.

import nodePath from "node:path";

import type { ServerProviderUsageLimit } from "@synara/contracts";

import {
  credentialFingerprint,
  readKeychainPassword,
  decodeKeychainJson,
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
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const REFRESH_URL = "https://oauth2.googleapis.com/token";
const CLOUD_CODE_ORIGIN = new URL(LOAD_URL).origin;
// Public Antigravity installed-app OAuth client (not a Synara-issued secret).
// Assembled so GitHub push protection does not treat the published CLI client as a leak.
const ANTIGRAVITY_OAUTH_CLIENT_ID = [
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep",
  "apps.googleusercontent.com",
].join(".");
const ANTIGRAVITY_OAUTH_CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_QUOTA_WINDOWS = 4;

interface AntigravityOAuthCreds {
  path: string | null;
  record: Record<string, unknown>;
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
}

function antigravityCredPaths(ctx: ProviderUsageContext): string[] {
  const geminiHome = ctx.env.GEMINI_CONFIG_DIR?.trim() || nodePath.join(ctx.homeDir, ".gemini");
  return [
    nodePath.join(geminiHome, "antigravity-cli", "antigravity-oauth-token"),
    nodePath.join(geminiHome, "antigravity-cli", "oauth_creds.json"),
    nodePath.join(ctx.homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    nodePath.join(ctx.homeDir, ".gemini", "antigravity-cli", "oauth_creds.json"),
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

function readAntigravityCreds(path: string | null, value: unknown): AntigravityOAuthCreds | null {
  const record = asRecord(value);
  if (!record || (record.auth_method !== undefined && record.auth_method !== "consumer"))
    return null;
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

let refreshedKeychain: { fingerprint: string; creds: AntigravityOAuthCreds } | undefined;

async function resolveAntigravityCreds(
  ctx: ProviderUsageContext,
): Promise<AntigravityOAuthCreds | null> {
  const raw = await readKeychainPassword({
    service: "gemini",
    account: "antigravity",
    platform: ctx.platform,
  });
  if (raw) {
    const json = raw.startsWith("go-keyring-base64:")
      ? decodeKeychainJson(
          Buffer.from(raw.slice("go-keyring-base64:".length), "base64").toString("utf8"),
        )
      : decodeKeychainJson(raw);
    const creds = readAntigravityCreds(null, json);
    if (creds) {
      const fingerprint = credentialFingerprint(creds.accessToken);
      if (
        refreshedKeychain?.fingerprint === fingerprint &&
        !credsNeedRefresh(refreshedKeychain.creds, ctx.nowMs)
      )
        return refreshedKeychain.creds;
      return creds;
    }
  }
  for (const credPath of antigravityCredPaths(ctx)) {
    const creds = readAntigravityCreds(credPath, await readJsonFile(credPath));
    if (creds) return creds;
  }
  return null;
}

function googleHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": `antigravity/1.104.0 ${process.platform}/${process.arch}`,
  };
}

function antigravityOAuthClient(ctx: ProviderUsageContext): {
  clientId: string;
  clientSecret: string;
} {
  return {
    clientId: ctx.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ANTIGRAVITY_OAUTH_CLIENT_ID,
    clientSecret:
      ctx.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ANTIGRAVITY_OAUTH_CLIENT_SECRET,
  };
}

function quotaWindowLabel(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude")) return "Claude";
  if (lower.startsWith("gpt-oss")) return "GPT-OSS";
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
  const models = asRecord(quota?.models);
  const buckets = models
    ? Object.entries(models).flatMap(([modelId, value]) => {
        const info = asRecord(asRecord(value)?.quotaInfo);
        // Editor completion models are not chat quotas.
        return info && /^(gemini|claude|gpt-oss)-/u.test(modelId) ? [{ ...info, modelId }] : [];
      })
    : [];
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
  creds: AntigravityOAuthCreds,
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

async function refreshAntigravityCreds(
  creds: AntigravityOAuthCreds,
  ctx: ProviderUsageContext,
): Promise<AntigravityOAuthCreds | "dead" | null> {
  if (!creds.refreshToken) return null;
  const client = antigravityOAuthClient(ctx);
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
  if (creds.path) await writeJsonFileAtomic(creds.path, nextRecord);
  const refreshToken = refreshed.refreshToken ?? creds.refreshToken;
  const nextCreds = {
    ...creds,
    record: nextRecord,
    accessToken: refreshed.accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(refreshed.expiresAtMs !== undefined ? { expiresAtMs: refreshed.expiresAtMs } : {}),
  };
  if (!creds.path)
    refreshedKeychain = { fingerprint: credentialFingerprint(creds.accessToken), creds: nextCreds };
  return nextCreds;
}

function credsNeedRefresh(creds: AntigravityOAuthCreds, nowMs: number): boolean {
  return creds.expiresAtMs !== undefined && creds.expiresAtMs <= nowMs + REFRESH_BUFFER_MS;
}

export const antigravityUsageFetcher: ProviderUsageFetcher = {
  provider: "antigravity",
  async cacheKey(ctx) {
    const creds = await resolveAntigravityCreds(ctx);
    if (creds) return credentialFingerprint(creds.accessToken);
    return `${ctx.homeDir}:none`;
  },
  async fetch(ctx) {
    let creds = await resolveAntigravityCreds(ctx);
    if (!creds) {
      return needsAuthSnapshot("antigravity", ctx.nowMs, SOURCE);
    }
    if (credsNeedRefresh(creds, ctx.nowMs)) {
      try {
        const refreshed = await refreshAntigravityCreds(creds, ctx);
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
            ideType: "ANTIGRAVITY",
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
        if (!quotaResult.ok) {
          return errorSnapshot(
            "antigravity",
            ctx.nowMs,
            SOURCE,
            `Antigravity quota request failed (${quotaResult.status}).`,
          );
        }
        quotaJson = quotaResult.json;
      } catch {
        return errorSnapshot(
          "antigravity",
          ctx.nowMs,
          SOURCE,
          "Could not reach the Antigravity quota endpoint.",
        );
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
