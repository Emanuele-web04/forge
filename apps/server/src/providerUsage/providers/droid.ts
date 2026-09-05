// FILE: providerUsage/providers/droid.ts
// Purpose: Read Factory CLI credentials and fetch the same standard/core limits shown by Droid's
// `/limits` command. Credential access is read-only. An explicit FACTORY_API_KEY selects its own
// account; otherwise use the local CLI login without refreshing or modifying its credentials.

import type {
  ServerProviderUsageLimit,
  ServerProviderUsageLine,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";

import { getDroidApiKeyEnv } from "../../provider/acp/DroidAcpSupport";
import { credentialFingerprint } from "../credentials";
import { fetchJson, isAuthFailureStatus, isRateLimitStatus, parseRetryAfterMs } from "../http";
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
  type DroidCredentialResolution,
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
    ...(auth.activeOrganizationId ? { "X-Factory-Org-Id": auth.activeOrganizationId } : {}),
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

// Identity lookup failures never reuse billing data: the account/region has not been verified.
const droidIdentityResilience = createRateLimitResilience({
  provider: "droid",
  source: SOURCE,
  detail: (retryMins) =>
    `Factory account lookup is temporarily unavailable — retrying in ~${retryMins}m.`,
});

/** Test-only: clear remembered last-good usage and cooldowns. */
export function __resetDroidUsageRateLimitState(): void {
  droidResilience.reset();
  droidIdentityResilience.reset();
}

async function fetchDroidUsage(auth: DroidAuth) {
  const baseUrl = droidApiBaseUrl(auth);
  const url = `${baseUrl}/api/billing/limits`;
  return fetchJson({
    service: "provider-usage-droid",
    url,
    allowedOrigins: [GLOBAL_API_BASE_URL, EU_API_BASE_URL],
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
  return `${ctx.homeDir}:${auth.kind}:${credentialFingerprint(
    JSON.stringify([auth.accessToken, auth.activeOrganizationId ?? null, auth.region ?? "global"]),
  )}`;
}

// The orchestrator passes one context object to cacheKey/fetch. Consume the same credential
// snapshot, then let its post-fetch cacheKey call re-read storage. No A -> B -> A cache poisoning.
const preparedCredentials = new WeakMap<
  ProviderUsageContext,
  {
    resolution: DroidCredentialResolution;
    apiKey: string | undefined;
  }
>();

async function resolveSelection(ctx: ProviderUsageContext) {
  const apiKey = getDroidApiKeyEnv(ctx.env);
  return {
    apiKey,
    resolution: apiKey
      ? { credential: null, localLoginPresent: false }
      : await resolveDroidLocalCredential(ctx),
  };
}

export const droidUsageFetcher: ProviderUsageFetcher = {
  provider: "droid",
  async cacheKey(ctx) {
    const selection = await resolveSelection(ctx);
    preparedCredentials.set(ctx, selection);
    // API-key residency is resolved by whoami, so do not reuse the outer cache before it.
    return selection.apiKey ? null : droidCredentialCacheKey(ctx, selection.resolution, undefined);
  },
  async fetch(ctx) {
    const selection = preparedCredentials.get(ctx) ?? (await resolveSelection(ctx));
    preparedCredentials.delete(ctx);
    const { resolution, apiKey } = selection;
    let auth: DroidAuth | undefined;
    const local = resolution.credential;
    if (apiKey) {
      // Factory's CLI validates API keys at the global whoami endpoint and uses that
      // principal's org/region. Never copy a local WorkOS account's org or region.
      const identityKey = `${ctx.homeDir}:api:${credentialFingerprint(apiKey)}`;
      const identityCooldown = droidIdentityResilience.serveDuringCooldown(identityKey, ctx.nowMs);
      if (identityCooldown) return identityCooldown;
      try {
        const identity = await fetchJson({
          service: "provider-usage-droid",
          url: `${GLOBAL_API_BASE_URL}/api/cli/whoami`,
          allowedOrigins: [GLOBAL_API_BASE_URL],
          headers: { Authorization: `Bearer ${apiKey}`, "X-Factory-Whoami-Extended": "true" },
        });
        if (isAuthFailureStatus(identity.status))
          return needsAuthSnapshot("droid", ctx.nowMs, SOURCE);
        if (!identity.ok)
          return droidIdentityResilience.enterCooldown(
            identityKey,
            ctx.nowMs,
            parseRetryAfterMs(identity.headers, ctx.nowMs),
          );
        const data = asRecord(identity.json);
        const org = asString(data?.orgId);
        const user = asString(data?.userId);
        const region = data?.region ?? "global";
        if (
          !identity.ok ||
          !org ||
          !user ||
          (region !== "global" && region !== "eu") ||
          data?.isOnPrem === true ||
          data?.premBaseHost
        ) {
          return droidIdentityResilience.enterCooldown(identityKey, ctx.nowMs, undefined);
        }
        auth = {
          accessToken: apiKey,
          kind: "api-key",
          activeOrganizationId: org,
          region,
        };
      } catch {
        return droidIdentityResilience.enterCooldown(identityKey, ctx.nowMs, undefined);
      }
    } else if (local && local.expiresAtMs !== null && local.expiresAtMs > ctx.nowMs) {
      if (local.region && local.region !== "eu" && local.region !== "global") {
        return errorSnapshot(
          "droid",
          ctx.nowMs,
          SOURCE,
          "Factory credential region is unsupported.",
        );
      }
      auth = localAuth(local);
    }

    if (!auth) {
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

    const key = authKey(ctx, auth);
    const cooldown = droidResilience.serveDuringCooldown(key, ctx.nowMs);
    if (cooldown) {
      return cooldown;
    }
    try {
      const result = await fetchDroidUsage(auth);
      if (isAuthFailureStatus(result.status)) {
        return needsAuthSnapshot("droid", ctx.nowMs, SOURCE);
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
  },
};
