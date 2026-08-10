// FILE: providerUsage/providers/opencode.ts
// Purpose: Native OpenCode usage fetcher. OpenCode (the Go CLI) keeps per-message token totals
// and model costs in a local SQLite database (`opencode.db`), so unlike Codex/Claude/Cursor there
// is no remote endpoint to call and nothing to authenticate against. We read the DB read-only and
// roll per-message `tokens.total`/`cost` up into the shared 24h/7d/30d usage-line shape.
//
// Defensive by design: a missing DB just means "no local usage yet" (ok snapshot, no lines),
// while an unreadable DB surfaces as an error snapshot so a corrupted file isn't mistaken for an
// unused CLI. The snapshot cache in the orchestrator bounds how often we touch a potentially large
// DB file.

import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";

import type { ServerProviderUsageLine, ServerProviderUsageSnapshot } from "@synara/contracts";

import { createLogger } from "../../logger";
import { buildUsageLines } from "../../providerUsageSnapshot";
import { asNonNegativeNumber, buildSnapshot, errorSnapshot, formatUsd } from "../parse";
import { readSqliteRows } from "../sqlite";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const log = createLogger("provider-usage:opencode");

const SOURCE = "opencode-native-db";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_7D_MS = 7 * ONE_DAY_MS;
const LOOKBACK_30D_MS = 30 * ONE_DAY_MS;

/** Per-message usage row lifted out of the OpenCode `message` table. */
export interface OpenCodeMessageUsageRow {
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly tokens: number;
  readonly cost: number;
}

function resolveOpenCodeDbPaths(ctx: ProviderUsageContext): string[] {
  const paths: string[] = [];
  const xdgDataHome = ctx.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    paths.push(nodePath.join(xdgDataHome, "opencode", "opencode.db"));
  }
  if (ctx.platform === "win32") {
    const appData = ctx.env.APPDATA?.trim() ?? ctx.env.LOCALAPPDATA?.trim();
    if (appData) {
      paths.push(nodePath.join(appData, "opencode", "opencode.db"));
    }
    return paths;
  }
  paths.push(nodePath.join(ctx.homeDir, ".local", "share", "opencode", "opencode.db"));
  return paths;
}

async function safeStat(path: string): Promise<Stats | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

async function findOpenCodeDbPath(ctx: ProviderUsageContext): Promise<string | null> {
  for (const path of resolveOpenCodeDbPaths(ctx)) {
    if ((await safeStat(path))?.isFile()) {
      return path;
    }
  }
  return null;
}

// Rows are read within the 30d window only; the 24h/7d buckets are derived in JS so the SQL
// stays a single scan regardless of how many windows we report. `time_created` is epoch ms,
// which is what the OpenCode Go CLI writes for the same field.
const MESSAGE_USAGE_SQL = `
  SELECT session_id, time_created,
         json_extract(data, '$.tokens.total') AS tokens,
         json_extract(data, '$.cost') AS cost
  FROM message
  WHERE json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.tokens.total') > 0
    AND time_created >= ?
  ORDER BY time_created
`;

function coerceSessionId(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/** Map raw SQLite rows into the usage-row shape, dropping rows that carry no usable data. */
export function normalizeOpenCodeMessageRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): OpenCodeMessageUsageRow[] {
  const normalized: OpenCodeMessageUsageRow[] = [];
  for (const row of rows) {
    const timestampMs = asNonNegativeNumber(row.time_created);
    const tokens = asNonNegativeNumber(row.tokens);
    if (timestampMs === undefined || tokens === undefined) {
      continue;
    }
    const cost = asNonNegativeNumber(row.cost);
    normalized.push({
      sessionId: coerceSessionId(row.session_id),
      timestampMs,
      tokens,
      cost: cost ?? 0,
    });
  }
  return normalized;
}

/**
 * Roll per-message usage into the shared 24h/7d/30d usage-line shape. Exported for tests:
 * pure aggregation over an already-fetched row set.
 */
export function buildOpenCodeUsageLines(input: {
  rows: ReadonlyArray<OpenCodeMessageUsageRow>;
  nowMs: number;
}): ReadonlyArray<ServerProviderUsageLine> {
  const { rows, nowMs } = input;
  if (rows.length === 0) {
    return [];
  }

  const cutoffs = {
    "24h": nowMs - ONE_DAY_MS,
    "7d": nowMs - LOOKBACK_7D_MS,
    "30d": nowMs - LOOKBACK_30D_MS,
  } as const;

  const recent24h: OpenCodeMessageUsageRow[] = [];
  const recent7d: OpenCodeMessageUsageRow[] = [];
  const recent30d: OpenCodeMessageUsageRow[] = [];
  for (const row of rows) {
    if (row.timestampMs >= cutoffs["24h"]) {
      recent24h.push(row);
    }
    if (row.timestampMs >= cutoffs["7d"]) {
      recent7d.push(row);
    }
    if (row.timestampMs >= cutoffs["30d"]) {
      recent30d.push(row);
    }
  }

  const cost30d = recent30d.reduce((total, row) => total + row.cost, 0);
  const lines = [
    ...buildUsageLines({
      tokens24h: recent24h.reduce((total, row) => total + row.tokens, 0),
      tokens7d: recent7d.reduce((total, row) => total + row.tokens, 0),
      tokens30d: recent30d.reduce((total, row) => total + row.tokens, 0),
      sessions24h: new Set(recent24h.map((row) => row.sessionId)).size,
      sessions7d: new Set(recent7d.map((row) => row.sessionId)).size,
      sessions30d: new Set(recent30d.map((row) => row.sessionId)).size,
    }),
  ];
  if (cost30d > 0) {
    lines.push({ label: "Spend", value: formatUsd(cost30d), subtitle: "last 30d" });
  }
  return lines;
}

export const opencodeUsageFetcher: ProviderUsageFetcher = {
  provider: "opencode",
  async cacheKey(ctx) {
    return `${ctx.homeDir}:${(await findOpenCodeDbPath(ctx)) ?? "none"}`;
  },
  async fetch(ctx): Promise<ServerProviderUsageSnapshot> {
    const dbPath = await findOpenCodeDbPath(ctx);
    if (!dbPath) {
      // No database on disk yet: the CLI is either not installed or has never recorded a
      // message. Report a healthy-but-empty snapshot rather than an auth/error state.
      return buildSnapshot({
        provider: "opencode",
        nowMs: ctx.nowMs,
        status: "ok",
        source: SOURCE,
      });
    }

    try {
      const rows = normalizeOpenCodeMessageRows(
        await readSqliteRows({
          dbPath,
          sql: MESSAGE_USAGE_SQL,
          params: [ctx.nowMs - LOOKBACK_30D_MS],
        }),
      );
      return buildSnapshot({
        provider: "opencode",
        nowMs: ctx.nowMs,
        status: "ok",
        source: SOURCE,
        usageLines: buildOpenCodeUsageLines({ rows, nowMs: ctx.nowMs }),
      });
    } catch (cause) {
      log.warn("could not read the OpenCode usage database", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return errorSnapshot(
        "opencode",
        ctx.nowMs,
        SOURCE,
        "Could not read OpenCode's local usage database.",
      );
    }
  },
};
