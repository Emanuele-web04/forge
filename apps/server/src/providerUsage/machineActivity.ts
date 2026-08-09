// FILE: providerUsage/machineActivity.ts
// Purpose: Read provider-owned local history without reading credentials or sending telemetry.
// The first structured scanner targets OpenCode's SQLite history and the compatible Kilo data
// directory. Account limits remain a separate plane in providerUsage/registry.ts.

import type {
  ProviderKind,
  ServerProviderUsageActivity,
  ServerProviderUsageActivityBreakdown,
  ServerProviderUsageActivityPeriod,
  ServerProviderUsageTokenCounts,
} from "@synara/contracts";
import fs from "node:fs/promises";
import nodePath from "node:path";

import { asRecord, asString } from "./parse";
import { readSqliteRows } from "./sqlite";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DATABASES = 12;
const MAX_MESSAGES_PER_DATABASE = 50_000;

// Detected `time_created` unit per database, keyed by path. The probe (a single
// `MAX(time_created)` pass) is cached while the file's mtime is unchanged so
// refreshes do not re-probe unchanged databases.
const timestampUnitCache = new Map<string, { unit: "seconds" | "milliseconds"; mtimeMs: number }>();
let timestampUnitProbeCount = 0;

interface DatabaseFiles {
  readonly paths: ReadonlyArray<string>;
  readonly truncated: boolean;
}

interface OpenCodeMessage {
  readonly messageId: string;
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly providerId: string | undefined;
  readonly modelId: string;
  readonly tokens: ServerProviderUsageTokenCounts;
  readonly costUsd: number | undefined;
}

export interface MachineActivitySample {
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly model?: string | null;
  readonly upstreamProviderId?: string | null;
  readonly tokens: ServerProviderUsageTokenCounts;
  readonly recordedCostUsd?: number | null;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function asTimestampMs(value: unknown): number | undefined {
  const parsed = asNonNegativeNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  // OpenCode stores epoch milliseconds. Accommodate seconds for old exports.
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function tokenCounts(value: unknown): ServerProviderUsageTokenCounts | null {
  const tokens = asRecord(value);
  if (!tokens) {
    return null;
  }
  const cache = asRecord(tokens.cache);
  const input = asNonNegativeNumber(tokens.input);
  const cachedInput = asNonNegativeNumber(tokens.cacheRead ?? cache?.read);
  const output = asNonNegativeNumber(tokens.output);
  const reasoning = asNonNegativeNumber(tokens.reasoning);
  const total =
    asNonNegativeNumber(tokens.total) ??
    (input ?? 0) +
      (cachedInput ?? 0) +
      (output ?? 0) +
      (reasoning ?? 0) +
      (asNonNegativeNumber(tokens.cacheWrite ?? cache?.write) ?? 0);
  if (total <= 0 && input === undefined && cachedInput === undefined && output === undefined) {
    return null;
  }
  const cacheWrite = asNonNegativeNumber(tokens.cacheWrite ?? cache?.write);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(cachedInput !== undefined ? { cachedInput } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    total: Math.trunc(total),
  };
}

function readMessage(row: Record<string, unknown>): OpenCodeMessage | null {
  const data = asJsonRecord(row.data);
  if (!data || data.role !== "assistant") {
    return null;
  }
  const messageId = asString(row.messageId) ?? asString(data.id);
  const sessionId = asString(row.sessionId);
  const dataTime = asRecord(data.time);
  const timestampMs = asTimestampMs(row.timeCreated ?? data.time ?? dataTime?.created);
  const tokens = tokenCounts(data.tokens);
  const modelId = asString(data.modelID ?? data.modelId ?? data.model) ?? "unknown";
  if (!messageId || !sessionId || timestampMs === undefined || !tokens) {
    return null;
  }
  const providerId = asString(data.providerID ?? data.providerId ?? data.provider);
  const cost = asNonNegativeNumber(data.cost);
  return {
    messageId,
    sessionId,
    timestampMs,
    providerId,
    modelId,
    tokens,
    costUsd: cost,
  };
}

async function databaseFiles(input: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  provider: "opencode" | "kilo";
}): Promise<DatabaseFiles> {
  const family = input.provider;
  const dataEnv = input.env[family === "opencode" ? "OPENCODE_DATA_DIR" : "KILO_DATA_DIR"];
  const xdgData = input.env.XDG_DATA_HOME?.trim();
  const xdgConfig = input.env.XDG_CONFIG_HOME?.trim();
  const roots = [
    dataEnv?.trim(),
    xdgData
      ? nodePath.join(xdgData, family)
      : nodePath.join(input.homeDir, ".local", "share", family),
    xdgConfig ? nodePath.join(xdgConfig, family) : nodePath.join(input.homeDir, ".config", family),
    input.env.APPDATA ? nodePath.join(input.env.APPDATA, family) : null,
    input.env.LOCALAPPDATA ? nodePath.join(input.env.LOCALAPPDATA, family) : null,
    nodePath.join(input.homeDir, "AppData", "Roaming", family),
    nodePath.join(input.homeDir, "AppData", "Local", family),
    nodePath.join(input.homeDir, "Library", "Application Support", family),
  ].filter((path): path is string => Boolean(path));
  const results = new Set<string>();
  for (const root of roots) {
    let entries: ReadonlyArray<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(family) || !entry.name.endsWith(".db")) {
        continue;
      }
      results.add(nodePath.join(root, entry.name));
    }
  }
  return {
    paths: [...results].slice(0, MAX_DATABASES),
    truncated: results.size > MAX_DATABASES,
  };
}

// Detect the epoch unit stored in a provider database's `message.time_created`
// column with a cheap one-row probe, cached per database while its mtime is
// unchanged. Most OpenCode/Kilo databases store milliseconds; seconds-unit
// exports are accommodated by branching the main query (below) on the detected
// unit so an index on `time_created` can serve both the predicate and the sort.
// A NULL/errored probe falls back to the millisecond branch (the historical
// behavior); the probe failure is not cached so a later successful read can
// still detect the real unit. A pathological database mixing both units would
// mis-filter one tail — the dominant unit (per MAX) wins, same as the
// conversion comment above `asTimestampMs`.
async function detectTimestampUnit(dbPath: string): Promise<"seconds" | "milliseconds"> {
  let mtimeMs: number | null = null;
  try {
    const stats = await fs.stat(dbPath);
    mtimeMs = stats.mtimeMs;
  } catch {
    return "milliseconds";
  }
  const cached = timestampUnitCache.get(dbPath);
  if (cached !== undefined && mtimeMs === cached.mtimeMs) {
    return cached.unit;
  }
  timestampUnitProbeCount += 1;
  const probe = await readSqliteRows({
    dbPath,
    sql: "SELECT MAX(time_created) AS maxTime FROM message",
  });
  const rawMax = probe.error === undefined ? probe.rows[0]?.maxTime : undefined;
  if (rawMax === undefined || rawMax === null) {
    return "milliseconds";
  }
  const maxTime = Number(rawMax);
  const unit = Number.isFinite(maxTime) && maxTime < 10_000_000_000 ? "seconds" : "milliseconds";
  timestampUnitCache.set(dbPath, { unit, mtimeMs });
  return unit;
}

/** Test-only: number of timestamp-unit probes run in this process. */
export function __timestampUnitProbeCountForTests(): number {
  return timestampUnitProbeCount;
}

async function readDatabaseMessages(
  dbPath: string,
  startMs: number,
): Promise<{
  messages: ReadonlyArray<OpenCodeMessage>;
  truncated: boolean;
  error?: string;
}> {
  const unit = await detectTimestampUnit(dbPath);
  const threshold = unit === "seconds" ? Math.floor(startMs / 1000) : startMs;
  // The predicate and sort use the raw column in the database's own unit so an
  // index on `time_created` can serve both. Mixed/historical rows still parse
  // because `asTimestampMs` normalizes on the TS side.
  const result = await readSqliteRows({
    dbPath,
    sql: `
      SELECT
        m.id AS messageId,
        m.session_id AS sessionId,
        m.time_created AS timeCreated,
        m.data AS data
      FROM message AS m
      WHERE m.time_created >= ?
      ORDER BY m.time_created DESC
      LIMIT ${MAX_MESSAGES_PER_DATABASE + 1}
    `,
    params: [threshold],
  });
  if (result.error !== undefined) {
    return { messages: [], truncated: false, error: result.error };
  }
  const rows = result.rows;
  const truncated = rows.length > MAX_MESSAGES_PER_DATABASE;
  const boundedRows = truncated ? rows.slice(0, MAX_MESSAGES_PER_DATABASE) : rows;
  return {
    messages: boundedRows
      .map(readMessage)
      .filter((message): message is OpenCodeMessage => message !== null),
    truncated,
  };
}

function sumTokens(messages: ReadonlyArray<OpenCodeMessage>): ServerProviderUsageTokenCounts {
  const totals = {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
  for (const message of messages) {
    totals.input += message.tokens.input ?? 0;
    totals.cachedInput += message.tokens.cachedInput ?? 0;
    totals.cacheWrite += message.tokens.cacheWrite ?? 0;
    totals.output += message.tokens.output ?? 0;
    totals.reasoning += message.tokens.reasoning ?? 0;
    totals.total += message.tokens.total;
  }
  return totals;
}

function optionalCost(messages: ReadonlyArray<OpenCodeMessage>): number | null {
  const values = messages
    .map((message) => message.costUsd)
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function buildPeriod(
  id: "24h" | "7d" | "30d",
  startMs: number,
  endMs: number,
  messages: ReadonlyArray<OpenCodeMessage>,
): ServerProviderUsageActivityPeriod {
  const recordedCostUsd = optionalCost(messages);
  return {
    id,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    sessions: new Set(messages.map((message) => message.sessionId)).size,
    tokens: sumTokens(messages),
    ...(recordedCostUsd !== null ? { recordedCostUsd } : { recordedCostUsd: null }),
  };
}

function buildBreakdown(
  messages: ReadonlyArray<OpenCodeMessage>,
): ReadonlyArray<ServerProviderUsageActivityBreakdown> {
  const groups = new Map<string, OpenCodeMessage[]>();
  for (const message of messages) {
    const key = `${message.providerId ?? ""}\u0000${message.modelId}`;
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group): ServerProviderUsageActivityBreakdown | null => {
      const first = group[0];
      if (!first) return null;
      const recordedCostUsd = optionalCost(group);
      return {
        model: first.modelId,
        ...(first.providerId ? { upstreamProviderId: first.providerId } : {}),
        sessions: new Set(group.map((message) => message.sessionId)).size,
        tokens: sumTokens(group),
        recordedCostUsd,
      };
    })
    .filter((entry): entry is ServerProviderUsageActivityBreakdown => entry !== null)
    .toSorted((left, right) => right.tokens.total - left.tokens.total)
    .slice(0, 40);
}

function buildActivityFromMessages(input: {
  provider: ProviderKind;
  source: string;
  nowMs: number;
  messages: ReadonlyArray<OpenCodeMessage>;
  partial?: boolean;
  partialDetail?: string;
  // Present only when every database failed to read; renders as a definitive
  // `error` state instead of a believable "no activity".
  failedDetail?: string;
}): ServerProviderUsageActivity {
  const startMs = input.nowMs - 30 * ONE_DAY_MS;
  if (input.messages.length === 0) {
    if (input.failedDetail) {
      return {
        status: "error",
        scope: "machine",
        source: input.source,
        capturedAt: new Date(input.nowMs).toISOString(),
        periods: [],
        breakdown: [],
        detail: input.failedDetail,
      };
    }
    return {
      status: input.partial ? "partial" : "unavailable",
      scope: "machine",
      source: input.source,
      capturedAt: new Date(input.nowMs).toISOString(),
      periods: [],
      breakdown: [],
      detail: input.partial
        ? (input.partialDetail ??
          `The ${input.provider} history scan hit its per-database row cap before it found usable token messages.`)
        : `No token-bearing ${input.provider} messages were found in the last 30 days.`,
    };
  }
  const periods = [
    buildPeriod(
      "24h",
      input.nowMs - ONE_DAY_MS,
      input.nowMs,
      input.messages.filter((message) => message.timestampMs >= input.nowMs - ONE_DAY_MS),
    ),
    buildPeriod(
      "7d",
      input.nowMs - 7 * ONE_DAY_MS,
      input.nowMs,
      input.messages.filter((message) => message.timestampMs >= input.nowMs - 7 * ONE_DAY_MS),
    ),
    buildPeriod("30d", startMs, input.nowMs, input.messages),
  ];
  return {
    status: input.partial ? "partial" : "ok",
    scope: "machine",
    source: input.source,
    capturedAt: new Date(input.nowMs).toISOString(),
    periods,
    breakdown: buildBreakdown(input.messages),
    ...(input.partial
      ? {
          detail:
            input.partialDetail ??
            `The ${input.provider} history is partial because at least one local database exceeded the ${MAX_MESSAGES_PER_DATABASE.toLocaleString()}-message scan cap.`,
        }
      : {}),
  };
}

function databasePartialDetail(input: {
  provider: ProviderKind;
  databaseListTruncated: boolean;
  rowTruncated: boolean;
}): string | undefined {
  if (input.databaseListTruncated && input.rowTruncated) {
    return `The ${input.provider} history is partial because more than ${MAX_DATABASES} local databases were found and at least one database exceeded the ${MAX_MESSAGES_PER_DATABASE.toLocaleString()}-message scan cap.`;
  }
  if (input.databaseListTruncated) {
    return `The ${input.provider} history is partial because the scan is limited to ${MAX_DATABASES} local databases.`;
  }
  if (input.rowTruncated) {
    return `The ${input.provider} history is partial because at least one local database exceeded the ${MAX_MESSAGES_PER_DATABASE.toLocaleString()}-message scan cap.`;
  }
  return undefined;
}

export function buildMachineUsageActivity(input: {
  provider: ProviderKind;
  source: string;
  nowMs: number;
  samples: ReadonlyArray<MachineActivitySample>;
  partial?: boolean;
  partialDetail?: string;
}): ServerProviderUsageActivity {
  const messages = input.samples.map(
    (sample, index) =>
      ({
        messageId: `${sample.sessionId}:${sample.timestampMs}:${index}`,
        sessionId: sample.sessionId,
        timestampMs: sample.timestampMs,
        providerId: sample.upstreamProviderId ?? undefined,
        modelId: sample.model?.trim() || "unknown",
        tokens: sample.tokens,
        costUsd: sample.recordedCostUsd ?? undefined,
      }) satisfies OpenCodeMessage,
  );
  return buildActivityFromMessages({
    provider: input.provider,
    source: input.source,
    nowMs: input.nowMs,
    messages,
    ...(input.partial !== undefined ? { partial: input.partial } : {}),
    ...(input.partialDetail ? { partialDetail: input.partialDetail } : {}),
  });
}

export async function scanLocalProviderActivity(input: {
  provider: ProviderKind;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  databasePaths?: ReadonlyArray<string>;
}): Promise<ServerProviderUsageActivity | null> {
  if (input.provider !== "opencode" && input.provider !== "kilo") {
    return null;
  }
  const nowMs = input.nowMs ?? Date.now();
  const databaseSelection = input.databasePaths
    ? { paths: input.databasePaths, truncated: false }
    : await databaseFiles({
        provider: input.provider,
        homeDir: input.homeDir,
        env: input.env ?? process.env,
      });
  if (databaseSelection.paths.length === 0) {
    return null;
  }

  const startMs = nowMs - 30 * ONE_DAY_MS;
  const databaseResults = await Promise.all(
    databaseSelection.paths.map(async (dbPath) => readDatabaseMessages(dbPath, startMs)),
  );
  // Failed reads are a status, not an absence: a locked/corrupt database must
  // not render as "no activity". Paths are shown only when every database
  // failed; the partial case states just the count.
  const failedDatabases = databaseResults
    .map((result, index): { path: string; error: string } | null =>
      result.error === undefined
        ? null
        : { path: databaseSelection.paths[index] ?? "?", error: result.error },
    )
    .filter((entry): entry is { path: string; error: string } => entry !== null);
  const failedCount = failedDatabases.length;
  const allFailed = failedCount === databaseResults.length;
  const messages = [
    ...new Map(
      databaseResults
        .flatMap((result) => result.messages)
        .map((message) => [message.messageId, message]),
    ).values(),
  ]
    .filter((message) => message.timestampMs <= nowMs)
    .toSorted((left, right) => left.timestampMs - right.timestampMs);
  const rowTruncated = databaseResults.some((result) => result.truncated);
  const partialDetail = databasePartialDetail({
    provider: input.provider,
    databaseListTruncated: databaseSelection.truncated,
    rowTruncated,
  });
  const failureDetail = allFailed
    ? `${failedCount} local database${failedCount === 1 ? "" : "s"} could not be read (locked or corrupt): ${failedDatabases.map((entry) => entry.path).join(", ")}.`
    : undefined;
  const failureCountNote =
    failedCount > 0 && !allFailed
      ? `${failedCount} local database${failedCount === 1 ? "" : "s"} could not be read; totals may be incomplete.`
      : undefined;
  const effectivePartialDetail = [partialDetail, failureCountNote]
    .filter((detail): detail is string => detail !== undefined)
    .join(" ");
  return buildActivityFromMessages({
    provider: input.provider,
    source: `${input.provider}-local-sqlite`,
    nowMs,
    messages: messages.filter((message) => message.timestampMs >= startMs),
    partial: databaseSelection.truncated || rowTruncated || (failedCount > 0 && !allFailed),
    ...(effectivePartialDetail ? { partialDetail: effectivePartialDetail } : {}),
    ...(failureDetail ? { failedDetail: failureDetail } : {}),
  });
}
