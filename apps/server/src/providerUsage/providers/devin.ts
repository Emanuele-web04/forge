// FILE: providerUsage/providers/devin.ts
// Purpose: Live Devin usage fetcher. Reads WINDSURF_API_KEY / DEVIN_API_KEY or the
// API key stored by `devin auth login`, then calls SeatManagementService/GetUserStatus
// on the configured Devin/Windsurf API server (default server.codeium.com).

import type { ServerProviderUsageLimit, ServerProviderUsageLine } from "@synara/contracts";

import {
  getDevinApiKeyEnv,
  getDevinApiServerUrlEnv,
  readDevinStoredCredentials,
  validateDevinApiServerUrl,
} from "../../provider/acp/DevinAcpSupport";
import { credentialFingerprint } from "../credentials";
import { fetchJson, isAuthFailureStatus } from "../http";
import {
  asFiniteNumber,
  asNonNegativeNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  formatUsd,
  isoFromString,
  isoFromUnixSeconds,
  needsAuthSnapshot,
  titleCase,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "devin-get-user-status";
const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

interface DevinUsageAuth {
  apiKey: string;
  apiServerUrl: string;
  allowLoopbackHttp: boolean;
}

function homeAwareEnv(ctx: ProviderUsageContext): NodeJS.ProcessEnv {
  return {
    ...ctx.env,
    HOME: ctx.env.HOME?.trim() || ctx.homeDir,
    USERPROFILE: ctx.env.USERPROFILE?.trim() || ctx.homeDir,
  };
}

function normalizeDevinApiServerUrl(raw: string | undefined): string | null {
  const validation = validateDevinApiServerUrl(raw?.trim() || DEFAULT_API_SERVER_URL);
  return validation.kind === "url" ? validation.url : null;
}

async function resolveDevinUsageAuth(
  ctx: ProviderUsageContext,
): Promise<DevinUsageAuth | "invalid-server" | null> {
  const env = homeAwareEnv(ctx);
  const stored = await readDevinStoredCredentials(env, ctx.platform);
  const apiKey = getDevinApiKeyEnv(env) ?? stored?.apiKey;
  if (!apiKey) {
    return null;
  }
  const apiServerUrl = normalizeDevinApiServerUrl(
    getDevinApiServerUrlEnv(env) ?? stored?.apiServerUrl,
  );
  if (!apiServerUrl) {
    return "invalid-server";
  }
  return {
    apiKey,
    apiServerUrl,
    allowLoopbackHttp: new URL(apiServerUrl).protocol === "http:",
  };
}

function remainingPercentToUsed(remainingPercent: number | undefined): number | undefined {
  if (remainingPercent === undefined) {
    return undefined;
  }
  return clampPercent(100 - remainingPercent);
}

function formatCredits(
  used: number | undefined,
  available: number | undefined,
): string | undefined {
  if (used === undefined && available === undefined) {
    return undefined;
  }
  const usedCredits = used ?? 0;
  if (available !== undefined && available < 0) {
    return undefined;
  }
  if (available !== undefined) {
    const total = usedCredits + available;
    if (total <= 0) {
      return undefined;
    }
    return `${formatCreditAmount(usedCredits)} of ${formatCreditAmount(total)}`;
  }
  return `${formatCreditAmount(usedCredits)} used`;
}

function formatCreditAmount(value: number): string {
  const scaled = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(scaled);
}

function formatAcu(consumed: number, limit: number | undefined): string {
  if (limit !== undefined && limit > 0) {
    return `${formatCreditAmount(consumed)} of ${formatCreditAmount(limit)} ACU`;
  }
  return `${formatCreditAmount(consumed)} ACU used`;
}

function formatOverageBalanceMicros(micros: number): string {
  return `${formatUsd(micros / 1_000_000)} remaining`;
}

function firstRecord(...values: ReadonlyArray<unknown>): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) {
      return record;
    }
  }
  return null;
}

function pickNumber(
  record: Record<string, unknown> | null,
  ...keys: ReadonlyArray<string>
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = asFiniteNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pickString(
  record: Record<string, unknown> | null,
  ...keys: ReadonlyArray<string>
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function parseDevinUsage(input: { json: unknown; nowMs: number }) {
  const root = asRecord(input.json);
  const userStatus = firstRecord(root?.userStatus, root?.user_status, root);
  const planStatus = firstRecord(userStatus?.planStatus, userStatus?.plan_status, userStatus);
  const planInfo = firstRecord(planStatus?.planInfo, planStatus?.plan_info, userStatus?.plan_info);

  const limits: ServerProviderUsageLimit[] = [];
  const usageLines: ServerProviderUsageLine[] = [];

  const planEnd =
    isoFromUnixSeconds(pickNumber(planStatus, "planEnd", "plan_end")) ??
    isoFromUnixSeconds(pickNumber(planInfo, "planEnd", "plan_end", "end_date")) ??
    isoFromString(pickString(planStatus, "planEnd", "plan_end")) ??
    isoFromString(pickString(planInfo, "planEnd", "plan_end", "end_date"));
  const dailyRemaining = pickNumber(
    planStatus,
    "dailyQuotaRemainingPercent",
    "daily_quota_remaining_percent",
  );
  const weeklyRemaining = pickNumber(
    planStatus,
    "weeklyQuotaRemainingPercent",
    "weekly_quota_remaining_percent",
  );
  const dailyUsed = remainingPercentToUsed(dailyRemaining);
  const weeklyUsed = remainingPercentToUsed(weeklyRemaining);
  const hideDailyQuota = planInfo?.hideDailyQuota === true || planInfo?.hide_daily_quota === true;
  const dailyResetsAt = isoFromUnixSeconds(
    pickNumber(planStatus, "dailyQuotaResetAtUnix", "daily_quota_reset_at_unix"),
  );
  const weeklyResetsAt = isoFromUnixSeconds(
    pickNumber(planStatus, "weeklyQuotaResetAtUnix", "weekly_quota_reset_at_unix"),
  );

  if (!hideDailyQuota && (dailyUsed !== undefined || dailyResetsAt)) {
    limits.push({
      window: "Daily",
      usedPercent: dailyUsed,
      resetsAt: dailyResetsAt,
      windowDurationMins: 1_440,
    });
  }
  const effectiveWeeklyUsed = weeklyUsed ?? (hideDailyQuota ? dailyUsed : undefined);
  if (effectiveWeeklyUsed !== undefined || weeklyResetsAt) {
    limits.push({
      window: "Weekly",
      usedPercent: effectiveWeeklyUsed,
      resetsAt: weeklyResetsAt,
      windowDurationMins: 10_080,
    });
  }

  const usedPromptCredits = asNonNegativeNumber(
    pickNumber(planStatus, "usedPromptCredits", "used_prompt_credits"),
  );
  const availablePromptCredits = asFiniteNumber(
    pickNumber(planStatus, "availablePromptCredits", "available_prompt_credits"),
  );
  const promptCredits = formatCredits(usedPromptCredits, availablePromptCredits);
  if (promptCredits) {
    usageLines.push({ label: "Prompt credits", value: promptCredits });
  }

  const usedFlexCredits = asNonNegativeNumber(
    pickNumber(planStatus, "usedFlexCredits", "used_flex_credits"),
  );
  const availableFlexCredits = asFiniteNumber(
    pickNumber(planStatus, "availableFlexCredits", "available_flex_credits"),
  );
  const flexCredits = formatCredits(usedFlexCredits, availableFlexCredits);
  if (flexCredits) {
    usageLines.push({ label: "Flex credits", value: flexCredits });
  }

  const acuConsumed = asNonNegativeNumber(pickNumber(planStatus, "acuConsumed", "acu_consumed"));
  const acuLimit = asNonNegativeNumber(pickNumber(planStatus, "acuLimit", "acu_limit"));
  if (acuConsumed !== undefined) {
    usageLines.push({ label: "ACU", value: formatAcu(acuConsumed, acuLimit) });
  } else if (acuLimit !== undefined && acuLimit > 0) {
    usageLines.push({ label: "ACU", value: `${formatCreditAmount(acuLimit)} ACU limit` });
  }

  const overageBalanceMicros = asNonNegativeNumber(
    pickNumber(planStatus, "overageBalanceMicros", "overage_balance_micros"),
  );
  if (overageBalanceMicros !== undefined) {
    usageLines.push({
      label: "Extra usage balance",
      value: formatOverageBalanceMicros(overageBalanceMicros),
    });
  }

  if (limits.length === 0 && planEnd) {
    limits.push({ window: "Current", resetsAt: planEnd });
  }

  const planName = pickString(planInfo, "planName", "plan_name");
  return buildSnapshot({
    provider: "devin",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    usageLines,
    ...(planName ? { planName: titleCase(planName) } : {}),
  });
}

export function devinUsageCacheKey(
  ctx: ProviderUsageContext,
  auth: DevinUsageAuth | "invalid-server" | null,
): string {
  if (auth === null) {
    return `${ctx.homeDir}:none`;
  }
  if (auth === "invalid-server") {
    return `${ctx.homeDir}:invalid-server`;
  }
  return `${ctx.homeDir}:${auth.apiServerUrl}:${credentialFingerprint(auth.apiKey)}`;
}

export const devinUsageFetcher: ProviderUsageFetcher = {
  provider: "devin",
  async cacheKey(ctx) {
    return devinUsageCacheKey(ctx, await resolveDevinUsageAuth(ctx));
  },
  async fetch(ctx) {
    const auth = await resolveDevinUsageAuth(ctx);
    if (auth === null) {
      return needsAuthSnapshot("devin", ctx.nowMs, SOURCE);
    }
    if (auth === "invalid-server") {
      return errorSnapshot("devin", ctx.nowMs, SOURCE, "Devin API server URL is invalid.");
    }

    const url = `${auth.apiServerUrl}${GET_USER_STATUS_PATH}`;
    try {
      const result = await fetchJson({
        service: "provider-usage-devin",
        url,
        allowedOrigins: [new URL(auth.apiServerUrl).origin],
        method: "POST",
        ...(auth.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: {
          metadata: {
            apiKey: auth.apiKey,
            ideName: "devin",
            ideVersion: "0.0.0",
            extensionName: "devin",
            extensionVersion: "0.0.0",
            locale: "en",
          },
        },
      });
      if (isAuthFailureStatus(result.status)) {
        return needsAuthSnapshot("devin", ctx.nowMs, SOURCE);
      }
      if (!result.ok) {
        return errorSnapshot(
          "devin",
          ctx.nowMs,
          SOURCE,
          `Devin usage request failed (${result.status}).`,
        );
      }
      return parseDevinUsage({ json: result.json, nowMs: ctx.nowMs });
    } catch {
      return errorSnapshot("devin", ctx.nowMs, SOURCE, "Could not reach the Devin usage endpoint.");
    }
  },
};
