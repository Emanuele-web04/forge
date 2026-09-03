// FILE: providerUsage/providers/droid.ts
// Purpose: Read Factory CLI credentials and fetch the same standard/core limits shown by Droid's
// `/limits` command. Credential access is read-only; FACTORY_API_KEY is the fallback when the local
// token is unavailable, expired, or rejected.

import type {
  ServerProviderUsageLimit,
  ServerProviderUsageLine,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";

import { getDroidApiKeyEnv } from "../../provider/acp/DroidAcpSupport";
import { credentialFingerprint } from "../credentials";
import {
  fetchJson,
  isAuthFailureStatus,
  isRateLimitStatus,
  parseRetryAfterMs,
} from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  formatUsd,
  isoFromString,
  needsAuthSnapshot,
  unsupportedSnapshot,
} from "../parse";
import { createRateLimitResilience } from "../rateLimitResilience";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";
import {
  droidCredentialCacheKey,
  resolveDroidLocalCredential,
  type DroidCredential,
} from "./droidCredentials";

const SOURCE = "factory-billing-limits";
const GLOBAL_API_BASE_URL = "https://api.factory.ai";
const EU_API_BASE_URL = "https://api.eu.factory.ai";
const FIVE_HOUR_MINS = 5 * 60;
const WEEKLY_MINS = 7 * 24 * 60;
const MONTHLY_MINS = 30 * 24 * 60;

interface DroidAuth {
  accessToken: string;
  activeOrganizationId?: string;
  region?: string;
  kind: "local" | "api-key";
}

function droidApiBaseUrl(auth: DroidAuth): string {
  return auth.region?.toLowerCase() === "eu" ? EU_API_BASE_URL : GLOBAL_API_BASE_URL;
}

function droidHeaders(auth: DroidAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    "X-Factory-Client": "cli",
    ...(auth.activeOrganizationId
      ? { "X-Factory-Org-Id": auth.activeOrganizationId }
      : {}),
  };
}

function parseLimit(
  label: string,
  value: unknown,
  windowDurationMins: number,
): ServerProviderUsageLimit | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const usedPercent = clampPercent(asFiniteNumber(record.usedPercent));
  const resetsAt = isoFromString(record.windowEnd);
  if (usedPercent === undefined && !resetsAt) {
    return null;
  }
  return {
    window: label,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    windowDurationMins,
  };
}

function overagePreferenceLabel(value: string): string {
  switch (value) {
    case "droidCore":
      return "Switch to Core";
    case "extraUsage":
      return "Use Paid Credits";
    default:
      return value;
  }
}

export function parseDroidUsage(input: {
  json: unknown;
  nowMs: number;
}): ServerProviderUsageSnapshot {
  const root = asRecord(input.json);
  const limits = asRecord(root?.limits);
  const standard = asRecord(limits?.standard);
  if (root?.usesTokenRateLimitsBilling === false || !standard) {
    return unsupportedSnapshot(
      "droid",
      input.nowMs,
      SOURCE,
      "This Factory organization does not expose personal token-rate limits.",
    );
  }

  const core = asRecord(limits?.core);
  const parsedLimits = [
    parseLimit("5h", standard.fiveHour, FIVE_HOUR_MINS),
    parseLimit("Weekly", standard.weekly, WEEKLY_MINS),
    parseLimit("Monthly", standard.monthly, MONTHLY_MINS),
    parseLimit("Core 5h", core?.fiveHour, FIVE_HOUR_MINS),
    parseLimit("Core Weekly", core?.weekly, WEEKLY_MINS),
    parseLimit("Core Monthly", core?.monthly, MONTHLY_MINS),
  ].filter((limit): limit is ServerProviderUsageLimit => limit !== null);

  const usageLines: ServerProviderUsageLine[] = [];

  const extraUsageBalanceCents = asFiniteNumber(root?.extraUsageBalanceCents);
  if (extraUsageBalanceCents !== undefined) {
    usageLines.push({
      label: "Extra Usage",
      value: formatUsd(Math.max(0, extraUsageBalanceCents) / 100),
    });
  }
  const overagePreference = asString(root?.overagePreference);
  if (overagePreference) {
    usageLines.push({
      label: "When Limited",
      value: overagePreferenceLabel(overagePreference),
    });
  }

  return buildSnapshot({
    provider: "droid",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits: parsedLimits,
    usageLines,
  });
}

const droidResilience = createRateLimitResilience({
  provider: "droid",
  source: SOURCE,
  detail: (retryMins) =>
    `Factory usage is temporarily unavailable — showing the last values, retrying in ~${retryMins}m.`,
});

/** Test-only: clear remembered last-good usage and cooldowns. */
export function __resetDroidUsageRateLimitState(): void {
  droidResilience.reset();
}

async function fetchDroidUsage(auth: DroidAuth) {
  const baseUrl = droidApiBaseUrl(auth);
  const url = `${baseUrl}/api/billing/limits`;
  return fetchJson({
    service: "provider-usage-droid",
    url,
    allowedOrigins: [new URL(url).origin],
    headers: droidHeaders(auth),
  });
}

function localAuth(credential: DroidCredential): DroidAuth {
  return {
    accessToken: credential.accessToken,
    kind: "local",
    ...(credential.activeOrganizationId
      ? { activeOrganizationId: credential.activeOrganizationId }
      : {}),
    ...(credential.region ? { region: credential.region } : {}),
  };
}

function authKey(ctx: ProviderUsageContext, auth: DroidAuth): string {
  return `${ctx.homeDir}:${auth.kind}:${credentialFingerprint(auth.accessToken)}`;
}

export const droidUsageFetcher: ProviderUsageFetcher = {
  provider: "droid",
  async cacheKey(ctx) {
    const resolution = await resolveDroidLocalCredential(ctx);
    return droidCredentialCacheKey(ctx, resolution, getDroidApiKeyEnv(ctx.env));
  },
  async fetch(ctx) {
    const resolution = await resolveDroidLocalCredential(ctx);
    const apiKey = getDroidApiKeyEnv(ctx.env);
    const candidates: DroidAuth[] = [];
    const local = resolution.credential;
    if (local && (local.expiresAtMs === null || local.expiresAtMs > ctx.nowMs)) {
      candidates.push(localAuth(local));
    }
    if (apiKey) {
      candidates.push({ accessToken: apiKey, kind: "api-key" });
    }

    if (candidates.length === 0) {
      if (local?.expiresAtMs !== null && local?.expiresAtMs !== undefined) {
        const stale = droidResilience.enterCooldown(
          authKey(ctx, localAuth(local)),
          ctx.nowMs,
          undefined,
        );
        return stale.status === "ok"
          ? {
              ...stale,
              detail:
                "The local Factory token expired — showing the last values. Run Droid to refresh its login.",
            }
          : needsAuthSnapshot("droid", ctx.nowMs, SOURCE);
      }
      return resolution.localLoginPresent
        ? errorSnapshot(
            "droid",
            ctx.nowMs,
            SOURCE,
            "Factory CLI is signed in, but Synara could not read its local credential.",
          )
        : needsAuthSnapshot("droid", ctx.nowMs, SOURCE);
    }

    for (const auth of candidates) {
      const key = authKey(ctx, auth);
      const cooldown = droidResilience.serveDuringCooldown(key, ctx.nowMs);
      if (cooldown) {
        return cooldown;
      }
      try {
        const result = await fetchDroidUsage(auth);
        if (isAuthFailureStatus(result.status)) {
          continue;
        }
        if (isRateLimitStatus(result.status)) {
          return droidResilience.enterCooldown(
            key,
            ctx.nowMs,
            parseRetryAfterMs(result.headers, ctx.nowMs),
          );
        }
        if (!result.ok) {
          return droidResilience.enterCooldown(key, ctx.nowMs, undefined);
        }
        const snapshot = parseDroidUsage({ json: result.json, nowMs: ctx.nowMs });
        if (snapshot.status === "ok") {
          droidResilience.rememberLastGood(key, snapshot, ctx.nowMs);
        }
        return snapshot;
      } catch {
        return droidResilience.enterCooldown(key, ctx.nowMs, undefined);
      }
    }

    return needsAuthSnapshot("droid", ctx.nowMs, SOURCE);
  },
};
