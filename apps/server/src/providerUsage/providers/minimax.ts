// FILE: providerUsage/providers/minimax.ts
// Purpose: Live MiniMax usage fetcher. Reads the `minimax-coding-plan` API key from the
// OpenCode CLI's auth.json (MiniMax has no standalone Synara CLI; the key is stored when the
// user connects the MiniMax Coding/Token plan through OpenCode) and calls MiniMax's official
// remains endpoint, mapping the rolling 5h (and weekly, when the plan tier has one) windows
// into the shared snapshot shape. Mirrors the flow OpenChamber uses for the same endpoint.

import nodePath from "node:path";

import type { ServerProviderUsageLimit, ServerProviderUsageSnapshot } from "@synara/contracts";

import { createLogger } from "../../logger";
import { credentialFingerprint, readJsonFile } from "../credentials";
import { fetchJson } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  needsAuthSnapshot,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const log = createLogger("provider-usage:minimax");

const SOURCE = "minimax-usage";
const TOKEN_PLAN_URL = "https://api.minimax.io/v1/token_plan/remains";
const CODING_PLAN_URL = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const CREDENTIAL_KEY = "minimax-coding-plan";
const GO_CREDENTIAL_REJECTED_DETAIL =
  "MiniMax key was rejected. Re-connect the MiniMax Coding Plan through `opencode` to sign in again.";

// MiniMax marks a window as not applicable for the current plan tier with status 3.
const WINDOW_STATUS_INACTIVE = 3;

/** The OpenCode data directory: OPENCODE_DATA_DIR, else XDG_DATA_HOME/opencode, else ~/.local/share/opencode. */
function opencodeDataDir(ctx: ProviderUsageContext): string {
  if (ctx.env.OPENCODE_DATA_DIR) {
    return ctx.env.OPENCODE_DATA_DIR;
  }
  if (ctx.env.XDG_DATA_HOME) {
    return nodePath.join(ctx.env.XDG_DATA_HOME, "opencode");
  }
  return nodePath.join(ctx.homeDir, ".local", "share", "opencode");
}

export function minimaxAuthFilePath(ctx: ProviderUsageContext): string {
  return nodePath.join(opencodeDataDir(ctx), "auth.json");
}

/** Read the raw `minimax-coding-plan` API key (never logs it). */
export async function readMinimaxKey(ctx: ProviderUsageContext): Promise<string | null> {
  const record = asRecord(await readJsonFile(minimaxAuthFilePath(ctx)));
  if (!record) {
    return null;
  }
  return asString(asRecord(record[CREDENTIAL_KEY])?.key) ?? null;
}

interface MiniMaxWindowFields {
  percent: number | undefined;
  totalCount: number | undefined;
  usageCount: number | undefined;
  startTimeMs: number | undefined;
  endTimeMs: number | undefined;
  remainsTimeMs: number | undefined;
  status: number | undefined;
}

function readWindow(entry: Record<string, unknown> | null): MiniMaxWindowFields | null {
  if (!entry) {
    return null;
  }
  return {
    percent: asFiniteNumber(entry.current_interval_remaining_percent),
    totalCount: asFiniteNumber(entry.current_interval_total_count),
    usageCount: asFiniteNumber(entry.current_interval_usage_count),
    startTimeMs: asFiniteNumber(entry.start_time),
    endTimeMs: asFiniteNumber(entry.end_time),
    remainsTimeMs: asFiniteNumber(entry.remains_time),
    status: asFiniteNumber(entry.current_interval_status),
  };
}

function readWeeklyWindow(entry: Record<string, unknown> | null): MiniMaxWindowFields | null {
  if (!entry) {
    return null;
  }
  return {
    percent: asFiniteNumber(entry.current_weekly_remaining_percent),
    totalCount: asFiniteNumber(entry.current_weekly_total_count),
    usageCount: asFiniteNumber(entry.current_weekly_usage_count),
    startTimeMs: asFiniteNumber(entry.weekly_start_time),
    endTimeMs: asFiniteNumber(entry.weekly_end_time),
    remainsTimeMs: asFiniteNumber(entry.weekly_remains_time),
    status: asFiniteNumber(entry.current_weekly_status),
  };
}

function windowDurationMins(window: MiniMaxWindowFields): number | undefined {
  if (window.startTimeMs && window.endTimeMs && window.endTimeMs > window.startTimeMs) {
    return Math.floor((window.endTimeMs - window.startTimeMs) / (60 * 1000));
  }
  if (window.remainsTimeMs && window.remainsTimeMs > 0) {
    return Math.floor(window.remainsTimeMs / (60 * 1000));
  }
  return undefined;
}

function usedPercent(window: MiniMaxWindowFields, isTokenPlan: boolean): number | undefined {
  if (window.percent !== undefined) {
    return clampPercent(100 - window.percent);
  }
  if (window.totalCount && window.totalCount > 0 && window.usageCount !== undefined) {
    const used = isTokenPlan
      ? Math.max(0, window.totalCount - window.usageCount)
      : window.usageCount;
    return clampPercent((used / window.totalCount) * 100);
  }
  return undefined;
}

function windowIsActive(window: MiniMaxWindowFields | null): boolean {
  return (
    window !== null && (window.status === undefined || window.status !== WINDOW_STATUS_INACTIVE)
  );
}

/**
 * Pick the chat model entry whose window best represents plan usage: prefer a MiniMax M*
 * model with recorded interval usage, then any general/chat/text model, then the first
 * entry carrying a numeric percent. Mirrors OpenChamber's selection heuristic.
 */
export function pickMiniMaxModelEntry(
  entries: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (entries.length === 0) {
    return null;
  }
  const textModels = new Set(["general", "chat", "text"]);
  const mCandidate = entries.find(
    (entry) =>
      asString(entry.model_name)?.toLowerCase().startsWith("minimax-m") &&
      asFiniteNumber(entry.current_interval_total_count) !== undefined &&
      (asFiniteNumber(entry.current_interval_total_count) ?? 0) > 0,
  );
  if (mCandidate) {
    return mCandidate;
  }
  const textCandidate = entries.find((entry) =>
    textModels.has(asString(entry.model_name)?.toLowerCase() ?? ""),
  );
  if (textCandidate) {
    return textCandidate;
  }
  return (
    entries.find(
      (entry) => asFiniteNumber(entry.current_interval_remaining_percent) !== undefined,
    ) ?? entries[0]!
  );
}

export function parseMiniMaxUsage(
  json: unknown,
  isTokenPlan: boolean,
): ReadonlyArray<ServerProviderUsageLimit> {
  const payload = asRecord(json);
  if (!payload) {
    return [];
  }
  const baseResp = asRecord(payload.base_resp);
  if (baseResp && asFiniteNumber(baseResp.status_code) !== 0) {
    return [];
  }
  const modelRemains = Array.isArray(payload.model_remains)
    ? payload.model_remains.filter(
        (entry): entry is Record<string, unknown> => asRecord(entry) !== null,
      )
    : [];
  const entry = pickMiniMaxModelEntry(modelRemains);
  if (!entry) {
    return [];
  }

  const interval = readWindow(entry);
  const weekly = readWeeklyWindow(entry);
  const limits: ServerProviderUsageLimit[] = [];

  if (interval && windowIsActive(interval)) {
    const percent = usedPercent(interval, true);
    const resetsAt = interval.endTimeMs ? new Date(interval.endTimeMs).toISOString() : undefined;
    const durationMins = windowDurationMins(interval);
    if (percent !== undefined) {
      limits.push({
        window: "5h",
        usedPercent: percent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(durationMins ? { windowDurationMins: durationMins } : {}),
      });
    }
  }

  if (weekly && windowIsActive(weekly)) {
    const percent = usedPercent(weekly, isTokenPlan);
    const resetsAt = weekly.endTimeMs ? new Date(weekly.endTimeMs).toISOString() : undefined;
    const durationMins = windowDurationMins(weekly);
    if (percent !== undefined) {
      limits.push({
        window: "Weekly",
        usedPercent: percent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(durationMins ? { windowDurationMins: durationMins } : {}),
      });
    }
  }

  return limits;
}

export const minimaxUsageFetcher: ProviderUsageFetcher = {
  provider: "minimax",
  cacheKey: async (ctx) => {
    const key = await readMinimaxKey(ctx);
    return key ? credentialFingerprint(key) : null;
  },
  fetch: async (ctx): Promise<ServerProviderUsageSnapshot> => {
    const key = await readMinimaxKey(ctx);
    if (!key) {
      log.warn("minimax key missing from opencode auth.json", {
        authPath: minimaxAuthFilePath(ctx),
      });
      return needsAuthSnapshot("minimax", ctx.nowMs, SOURCE);
    }

    let result: Awaited<ReturnType<typeof fetchJson>> | null = null;
    let planName: string | undefined;
    let isTokenPlan = true;
    for (const [url, label, tokenPlan] of [
      [TOKEN_PLAN_URL, "Token Plan", true],
      [CODING_PLAN_URL, "Coding Plan", false],
    ] as const) {
      try {
        const candidate = await fetchJson({
          service: "minimax",
          url,
          allowedOrigins: ["https://api.minimax.io"],
          headers: { Authorization: `Bearer ${key}` },
        });
        if (candidate.status === 401) {
          return buildSnapshot({
            provider: "minimax",
            nowMs: ctx.nowMs,
            status: "needs-auth",
            source: SOURCE,
            detail: GO_CREDENTIAL_REJECTED_DETAIL,
          });
        }
        if (candidate.ok && parseMiniMaxUsage(candidate.json, tokenPlan).length > 0) {
          result = candidate;
          planName = label;
          isTokenPlan = tokenPlan;
          break;
        }
      } catch {
        log.warn("minimax usage request failed", { url });
      }
    }

    if (!result) {
      log.warn("minimax usage fetch failed or returned no usable quota");
      return errorSnapshot(
        "minimax",
        ctx.nowMs,
        SOURCE,
        "MiniMax usage API returned no usable quota data.",
      );
    }

    const limits = parseMiniMaxUsage(result.json, isTokenPlan);
    return buildSnapshot({
      provider: "minimax",
      nowMs: ctx.nowMs,
      status: "ok",
      source: SOURCE,
      ...(planName ? { planName } : {}),
      limits,
    });
  },
};
