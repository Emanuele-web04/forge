// FILE: providerUsage/providers/opencode.ts
// Purpose: Live OpenCode Go usage fetcher. Reads the `opencode-go` API key from the OpenCode
// CLI's auth.json (the same key the CLI uses for the Go gateway) and calls the official Go
// usage API, mapping the rolling 5h / weekly / monthly plan windows into the shared snapshot
// shape. No cookie, no workspace lookup — the key alone authenticates. This mirrors what
// OpenUsage documents for the same endpoint.

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
  errorSnapshot,
  needsAuthSnapshot,
  unsupportedSnapshot,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const log = createLogger("provider-usage:opencode");

const SOURCE = "opencode-go-usage";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const GO_CREDENTIAL_KEY = "opencode-go";
const GO_KEY_REJECTED_DETAIL =
  "OpenCode Go key was rejected. Run `opencode auth login` (OpenCode Go) to sign in again.";
const NO_SUBSCRIPTION_DETAIL = "This OpenCode Go key is valid but has no active Go subscription.";

// The Go plan's three windows: $12 per rolling 5h, $30 per week, $60 per month.
const WINDOW_MINUTES: ReadonlyArray<{
  readonly key: string;
  readonly window: string;
  readonly minutes: number;
}> = [
  { key: "rolling", window: "5h", minutes: 300 },
  { key: "weekly", window: "Weekly", minutes: 10_080 },
  { key: "monthly", window: "Monthly", minutes: 43_200 },
];

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

export function opencodeAuthFilePath(ctx: ProviderUsageContext): string {
  return nodePath.join(opencodeDataDir(ctx), "auth.json");
}

/** Read the raw `opencode-go` API key (never logs it). */
export async function readOpenCodeGoKey(ctx: ProviderUsageContext): Promise<string | null> {
  const record = asRecord(await readJsonFile(opencodeAuthFilePath(ctx)));
  if (!record) {
    return null;
  }
  return asString(asRecord(record[GO_CREDENTIAL_KEY])?.key) ?? null;
}

export interface OpenCodeGoWindow {
  readonly percent?: number;
  readonly resetsAt?: string;
}

export function parseOpenCodeGoUsage(json: unknown): ReadonlyArray<ServerProviderUsageLimit> {
  const usage = asRecord(asRecord(json)?.usage);
  if (!usage) {
    return [];
  }
  const limits: ServerProviderUsageLimit[] = [];
  for (const { key, window, minutes } of WINDOW_MINUTES) {
    const entry = asRecord(usage[key]);
    if (!entry) {
      continue;
    }
    const percent = asFiniteNumber(entry.percent);
    const resetsAt = asString(entry.resetsAt);
    if (percent === undefined || !resetsAt) {
      continue;
    }
    limits.push({
      window,
      usedPercent: Math.min(100, Math.max(0, percent)),
      resetsAt,
      windowDurationMins: minutes,
    });
  }
  return limits;
}

export const opencodeUsageFetcher: ProviderUsageFetcher = {
  provider: "opencode",
  cacheKey: async (ctx) => {
    const key = await readOpenCodeGoKey(ctx);
    return key ? credentialFingerprint(key) : null;
  },
  fetch: async (ctx): Promise<ServerProviderUsageSnapshot> => {
    const key = await readOpenCodeGoKey(ctx);
    if (!key) {
      log.warn("opencode-go key missing from auth.json", {
        authPath: opencodeAuthFilePath(ctx),
      });
      return needsAuthSnapshot("opencode", ctx.nowMs, SOURCE);
    }

    let result: Awaited<ReturnType<typeof fetchJson>>;
    try {
      result = await fetchJson({
        service: "opencode",
        url: USAGE_URL,
        allowedOrigins: ["https://opencode.ai"],
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch {
      log.warn("opencode usage request failed", { error: "transport" });
      return errorSnapshot(
        "opencode",
        ctx.nowMs,
        SOURCE,
        "Could not reach the OpenCode usage API.",
      );
    }

    if (result.status === 401) {
      log.warn("opencode usage key rejected", { status: result.status });
      return buildSnapshot({
        provider: "opencode",
        nowMs: ctx.nowMs,
        status: "needs-auth",
        source: SOURCE,
        detail: GO_KEY_REJECTED_DETAIL,
      });
    }
    if (result.status === 403) {
      log.warn("opencode usage: no Go subscription", { status: result.status });
      return unsupportedSnapshot("opencode", ctx.nowMs, SOURCE, NO_SUBSCRIPTION_DETAIL);
    }
    if (!result.ok) {
      log.warn("opencode usage fetch failed", { status: result.status });
      return errorSnapshot("opencode", ctx.nowMs, SOURCE, "OpenCode usage API request failed.");
    }

    const limits = parseOpenCodeGoUsage(result.json);
    if (limits.length === 0) {
      log.warn("opencode usage response contained no recognizable windows");
      return errorSnapshot(
        "opencode",
        ctx.nowMs,
        SOURCE,
        "OpenCode usage response contained no usage windows.",
      );
    }

    return buildSnapshot({
      provider: "opencode",
      nowMs: ctx.nowMs,
      status: "ok",
      source: SOURCE,
      planName: "Go",
      limits,
    });
  },
};
