// FILE: providerUsage/providers/cursor.ts
// Purpose: Live Cursor usage fetcher. Reads the Cursor access token from its VS Code-style
// state.vscdb (key cursorAuth/accessToken) or the macOS keychain ("cursor-access-token")
// read-only, then calls the Cursor DashboardService (Connect RPC) for the current billing
// period usage + credit grants.

import nodePath from "node:path";

import type { ServerProviderUsageLimit, ServerProviderUsageLine } from "@synara/contracts";

import { credentialFingerprint, decodeJwtExpMs, readKeychainPassword } from "../credentials";
import { fetchJson, isAuthFailureStatus } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  formatUsd,
  isoFromUnixMillis,
  needsAuthSnapshot,
  titleCase,
} from "../parse";
import { readItemTableValues } from "../sqlite";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "cursor-dashboard";
const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CREDITS_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance";
const KEYCHAIN_SERVICE = "cursor-access-token";
const ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const PLAN_KEY = "cursorAuth/stripeMembershipType";

interface CursorAuth {
  accessToken: string;
  plan?: string;
}

export function cursorStateDbPaths(
  ctx: Pick<ProviderUsageContext, "homeDir" | "env" | "platform">,
): string[] {
  const segments = ["Cursor", "User", "globalStorage", "state.vscdb"];
  if (ctx.platform === "darwin") {
    return [nodePath.join(ctx.homeDir, "Library", "Application Support", ...segments)];
  }
  if (ctx.platform === "win32") {
    const roaming = ctx.env.APPDATA?.trim() || nodePath.join(ctx.homeDir, "AppData", "Roaming");
    return [nodePath.join(roaming, ...segments)];
  }
  const configHome = ctx.env.XDG_CONFIG_HOME?.trim() || nodePath.join(ctx.homeDir, ".config");
  return [nodePath.join(configHome, ...segments)];
}

async function resolveCursorAuth(ctx: ProviderUsageContext): Promise<CursorAuth | null> {
  for (const dbPath of cursorStateDbPaths(ctx)) {
    const values = await readItemTableValues({ dbPath, keys: [ACCESS_TOKEN_KEY, PLAN_KEY] });
    const accessToken = asString(values[ACCESS_TOKEN_KEY]);
    if (accessToken) {
      const plan = asString(values[PLAN_KEY]);
      return { accessToken, ...(plan ? { plan } : {}) };
    }
  }

  const keychain = await readKeychainPassword({
    service: KEYCHAIN_SERVICE,
    platform: ctx.platform,
  });
  const token = keychain ? asString(keychain) : undefined;
  return token ? { accessToken: token } : null;
}

function cursorHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Connect-Protocol-Version": "1",
  };
}

function cursorAuthCacheKey(ctx: ProviderUsageContext, auth: CursorAuth | null): string {
  return auth ? `${ctx.homeDir}:${credentialFingerprint(auth.accessToken)}` : `${ctx.homeDir}:none`;
}

export function parseCursorUsage(input: {
  usage: unknown;
  credits?: unknown;
  planName?: string;
  nowMs: number;
}) {
  const usage = asRecord(input.usage);
  const planUsage = asRecord(usage?.planUsage);
  const spendLimit = asRecord(usage?.spendLimitUsage);
  const limits: ServerProviderUsageLimit[] = [];
  const usageLines: ServerProviderUsageLine[] = [];

  const totalPercent = clampPercent(asFiniteNumber(planUsage?.totalPercentUsed));
  const resetsAt = isoFromUnixMillis(usage?.billingCycleEnd);
  if (totalPercent !== undefined || resetsAt) {
    limits.push({
      window: "Current",
      ...(totalPercent !== undefined ? { usedPercent: totalPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const individualLimit = asFiniteNumber(spendLimit?.individualLimit);
  const individualRemaining = asFiniteNumber(spendLimit?.individualRemaining);
  if (individualLimit !== undefined && individualLimit > 0) {
    const used =
      individualRemaining !== undefined
        ? Math.max(0, individualLimit - individualRemaining)
        : undefined;
    usageLines.push({
      label: "On-demand",
      value:
        used !== undefined
          ? `${formatUsd(used / 100)} of ${formatUsd(individualLimit / 100)}`
          : `${formatUsd(individualLimit / 100)} limit`,
    });
  }

  const credits = asRecord(input.credits);
  if (credits && credits.hasCreditGrants !== false) {
    const totalCents = asFiniteNumber(credits.totalCents);
    const usedCents = asFiniteNumber(credits.usedCents);
    if (totalCents !== undefined && totalCents > 0) {
      const remaining = usedCents !== undefined ? Math.max(0, totalCents - usedCents) : totalCents;
      usageLines.push({
        label: "Credits",
        value: `${formatUsd(remaining / 100)} of ${formatUsd(totalCents / 100)} remaining`,
      });
    }
  }

  return buildSnapshot({
    provider: "cursor",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    usageLines,
    ...(input.planName ? { planName: input.planName } : {}),
  });
}

export const cursorUsageFetcher: ProviderUsageFetcher = {
  provider: "cursor",
  async cacheKey(ctx) {
    return cursorAuthCacheKey(ctx, await resolveCursorAuth(ctx));
  },
  async fetch(ctx) {
    const auth = await resolveCursorAuth(ctx);
    if (!auth) {
      return needsAuthSnapshot("cursor", ctx.nowMs, SOURCE);
    }
    const expMs = decodeJwtExpMs(auth.accessToken);
    if (expMs !== null && expMs <= ctx.nowMs) {
      return needsAuthSnapshot("cursor", ctx.nowMs, SOURCE);
    }

    try {
      const usageResult = await fetchJson({
        service: "provider-usage-cursor",
        url: USAGE_URL,
        allowedOrigins: [new URL(USAGE_URL).origin],
        method: "POST",
        headers: cursorHeaders(auth.accessToken),
        body: {},
      });
      if (isAuthFailureStatus(usageResult.status)) {
        return needsAuthSnapshot("cursor", ctx.nowMs, SOURCE);
      }
      if (!usageResult.ok) {
        return errorSnapshot(
          "cursor",
          ctx.nowMs,
          SOURCE,
          `Cursor usage request failed (${usageResult.status}).`,
        );
      }

      // Credit grants are best-effort — absence shouldn't fail the snapshot.
      let creditsJson: unknown;
      try {
        const creditsResult = await fetchJson({
          service: "provider-usage-cursor",
          url: CREDITS_URL,
          allowedOrigins: [new URL(CREDITS_URL).origin],
          method: "POST",
          headers: cursorHeaders(auth.accessToken),
          body: {},
        });
        if (creditsResult.ok) {
          creditsJson = creditsResult.json;
        }
      } catch {
        creditsJson = undefined;
      }

      return parseCursorUsage({
        usage: usageResult.json,
        credits: creditsJson,
        nowMs: ctx.nowMs,
        ...(auth.plan ? { planName: titleCase(auth.plan) } : {}),
      });
    } catch {
      return errorSnapshot("cursor", ctx.nowMs, SOURCE, "Could not reach the Cursor dashboard.");
    }
  },
};
