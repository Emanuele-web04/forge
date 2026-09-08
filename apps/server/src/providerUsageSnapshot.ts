// FILE: providerUsageSnapshot.ts
// Purpose: Read provider-specific local usage archives for recent usage snapshots. Account limits
// and machine activity remain separate fields even when they share one provider card.

import { createReadStream, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { createInterface } from "node:readline";

import type {
  ProviderKind,
  ServerGetProviderUsageSnapshotInput,
  ServerGetProviderUsageSnapshotResult,
  ServerProviderUsageLimit,
  ServerProviderUsageLine,
} from "@synara/contracts";
import { Effect } from "effect";

import { ServerConfig } from "./config";
import {
  buildMachineUsageActivity,
  scanLocalProviderActivity,
  type MachineActivitySample,
} from "./providerUsage/machineActivity";
import { ServerSettingsService } from "./serverSettings";

const LOOKBACK_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_7D_MS = 7 * ONE_DAY_MS;
const LOOKBACK_30D_MS = LOOKBACK_DAYS * ONE_DAY_MS;
const USAGE_CACHE_TTL_MS = 30_000;
// Keep enough recent archives to make the 30d summary materially different from 7d
// for heavy local usage without scanning the full historical archive every refresh.
const MAX_RECENT_USAGE_FILES = 2_000;
const PROVIDER_USAGE_FILE_READ_CONCURRENCY = 16;
// A malformed or unexpectedly large transcript must not turn a refresh into a
// multi-gigabyte allocation. The provider archives currently observed by
// Synara are well below this bound; oversized files are skipped as partial
// evidence instead of being presented as complete usage.
const MAX_USAGE_FILE_BYTES = 64 * 1024 * 1024;

type UsageSnapshot = Exclude<ServerGetProviderUsageSnapshotResult, null>;

interface CachedUsageSnapshot {
  expiresAtMs: number;
  value: ServerGetProviderUsageSnapshotResult;
  pending: Promise<ServerGetProviderUsageSnapshotResult> | null;
}

interface RecentFiles {
  readonly paths: ReadonlyArray<string>;
  readonly truncated: boolean;
  readonly oversized: boolean;
}

interface FileWithStats {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size?: number;
}

interface CodexTokenEvent {
  readonly timestampMs: number;
  readonly totalTokens: number;
}

interface CodexSessionSeries {
  sessionId: string;
  // Chronological token_count events for one session file.
  events: ReadonlyArray<CodexTokenEvent>;
  // Limits come from the last (most recent) event of the file.
  limits: ReadonlyArray<ServerProviderUsageLimit>;
}

interface ClaudeUsageSample {
  sessionId: string;
  timestampMs: number;
  totalTokens: number;
  model: string | null;
}

const usageSnapshotCache = new Map<string, CachedUsageSnapshot>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function toIsoString(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function formatCompactNumber(value: number): string {
  const absoluteValue = Math.abs(value);
  if (absoluteValue < 1_000) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: absoluteValue < 1_000_000 ? 1 : 0,
  }).format(value);
}

function formatTokenValue(tokens: number): string {
  return `${formatCompactNumber(tokens)} tokens`;
}

function formatRecentSessionsSubtitle(sessionCount: number): string | undefined {
  if (sessionCount <= 0) {
    return undefined;
  }
  return `${new Intl.NumberFormat(undefined).format(sessionCount)} recent ${sessionCount === 1 ? "session" : "sessions"}`;
}

async function safeReadDir(path: string): Promise<ReadonlyArray<Dirent>> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(path: string): Promise<Stats | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

// Bounds archive reads so a cold stats load does useful parallel work without
// flooding the filesystem with thousands of simultaneous readFile calls.
async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: Array<{ index: number; value: R }> = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        const item = items[index];
        if (item === undefined) {
          continue;
        }
        results.push({ index, value: await mapper(item) });
      }
    }),
  );

  return results.toSorted((left, right) => left.index - right.index).map((entry) => entry.value);
}

async function listRecentFiles(
  paths: ReadonlyArray<string>,
  maxFiles: number = MAX_RECENT_USAGE_FILES,
): Promise<RecentFiles> {
  const filesWithStats = await mapWithConcurrency(
    paths,
    PROVIDER_USAGE_FILE_READ_CONCURRENCY,
    async (path) => {
      const stats = await safeStat(path);
      return {
        path,
        mtimeMs: stats?.mtimeMs ?? 0,
        ...(stats ? { size: stats.size } : {}),
      };
    },
  );

  return selectRecentFiles(filesWithStats, maxFiles);
}

function selectRecentFiles(
  filesWithStats: ReadonlyArray<FileWithStats>,
  maxFiles: number,
): RecentFiles {
  const sortedFiles = filesWithStats.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
  const selectedFiles = sortedFiles.slice(0, maxFiles);
  return {
    paths: selectedFiles.map((entry) => entry.path),
    truncated: sortedFiles.length > maxFiles,
    oversized: selectedFiles.some(
      (entry) => entry.size !== undefined && entry.size > MAX_USAGE_FILE_BYTES,
    ),
  };
}

function archivePartialDetail(provider: string, files: RecentFiles): string | undefined {
  const reasons = [
    ...(files.truncated
      ? [`the local archive scan is limited to ${MAX_RECENT_USAGE_FILES.toLocaleString()} files`]
      : []),
    ...(files.oversized
      ? [
          `at least one selected local archive file exceeds ${MAX_USAGE_FILE_BYTES / (1024 * 1024)} MiB`,
        ]
      : []),
  ];
  return reasons.length > 0
    ? `The ${provider} history is partial because ${reasons.join(" and ")}.`
    : undefined;
}

/** Test-only: verify that bounded archive discovery reports omitted candidates. */
export function __selectRecentFilesForTests(
  filesWithStats: ReadonlyArray<FileWithStats>,
  maxFiles: number,
): RecentFiles {
  return selectRecentFiles(filesWithStats, maxFiles);
}

/** Test-only: verify the Claude transcript roots used by the local reader. */
export function __resolveClaudeProjectsRootsForTests(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  return resolveClaudeProjectsRoots(homeDir, env);
}

function buildUsageLines(input: {
  tokens24h: number;
  tokens7d: number;
  tokens30d: number;
  sessions24h: number;
  sessions7d: number;
  sessions30d: number;
}): ReadonlyArray<ServerProviderUsageLine> {
  return [
    {
      label: "24h",
      value: formatTokenValue(input.tokens24h),
      ...(formatRecentSessionsSubtitle(input.sessions24h)
        ? { subtitle: formatRecentSessionsSubtitle(input.sessions24h) }
        : {}),
    },
    {
      label: "7d",
      value: formatTokenValue(input.tokens7d),
      ...(formatRecentSessionsSubtitle(input.sessions7d)
        ? { subtitle: formatRecentSessionsSubtitle(input.sessions7d) }
        : {}),
    },
    {
      label: "30d",
      value: formatTokenValue(input.tokens30d),
      ...(formatRecentSessionsSubtitle(input.sessions30d)
        ? { subtitle: formatRecentSessionsSubtitle(input.sessions30d) }
        : {}),
    },
  ];
}

function normalizeCodexUsageLimits(value: unknown): ReadonlyArray<ServerProviderUsageLimit> {
  const rateLimits = asRecord(value);
  if (!rateLimits) {
    return [];
  }

  const parseLimit = (
    label: string,
    source: Record<string, unknown> | null,
  ): ServerProviderUsageLimit | null => {
    if (!source) {
      return null;
    }

    const usedPercent = asNonNegativeNumber(source.used_percent ?? source.usedPercent);
    const windowDurationMins = asNonNegativeNumber(source.window_minutes ?? source.windowMinutes);
    const resetsAt =
      asString(source.resets_at ?? source.resetsAt) ??
      asString(source.next_reset_at ?? source.nextResetAt);
    if (usedPercent === undefined && windowDurationMins === undefined && !resetsAt) {
      return null;
    }

    return {
      window: label,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    };
  };

  const primary = parseLimit("5h", asRecord(rateLimits.primary));
  const secondary = parseLimit("Weekly", asRecord(rateLimits.secondary));

  return [primary, secondary].filter((limit): limit is ServerProviderUsageLimit => limit !== null);
}

function readCodexTotalTokens(payload: Record<string, unknown>): number {
  const info = asRecord(payload.info);
  const totalUsage =
    asRecord(info?.total_token_usage) ??
    asRecord(info?.totalTokenUsage) ??
    asRecord(info?.total) ??
    asRecord(payload.total_token_usage) ??
    asRecord(payload.totalTokenUsage) ??
    asRecord(payload.total);

  return (
    asNonNegativeNumber(totalUsage?.total_tokens) ??
    asNonNegativeNumber(totalUsage?.totalTokens) ??
    asNonNegativeNumber(info?.total_tokens) ??
    asNonNegativeNumber(info?.totalTokens) ??
    asNonNegativeNumber(payload.total_tokens) ??
    asNonNegativeNumber(payload.totalTokens) ??
    0
  );
}

async function listRecentCodexSessionFiles(
  sessionsRoot: string,
  nowMs: number,
): Promise<RecentFiles> {
  const now = new Date(nowMs);
  const candidates: string[] = [];

  for (let offset = 0; offset <= LOOKBACK_DAYS; offset += 1) {
    const current = new Date(now);
    current.setDate(now.getDate() - offset);
    const dayDir = nodePath.join(
      sessionsRoot,
      `${current.getFullYear()}`,
      `${String(current.getMonth() + 1).padStart(2, "0")}`,
      `${String(current.getDate()).padStart(2, "0")}`,
    );
    const entries = await safeReadDir(dayDir);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        candidates.push(nodePath.join(dayDir, entry.name));
      }
    }
  }

  return listRecentFiles(candidates);
}

async function readCodexSessionSeries(path: string): Promise<CodexSessionSeries | null> {
  try {
    const stats = await fs.stat(path);
    if (!stats.isFile() || stats.size > MAX_USAGE_FILE_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const events: CodexTokenEvent[] = [];
  let latestLimits: ReadonlyArray<ServerProviderUsageLimit> = [];
  try {
    for await (const line of lines) {
      if (stream.bytesRead > MAX_USAGE_FILE_BYTES) {
        return null;
      }
      if (!line || !line.trim()) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const record = asRecord(parsed);
      if (!record || record.type !== "event_msg") {
        continue;
      }

      const payload = asRecord(record.payload);
      if (!payload || payload.type !== "token_count") {
        continue;
      }

      const timestampMs = parseTimestampMs(record.timestamp ?? payload.timestamp);
      if (timestampMs === null) {
        continue;
      }

      events.push({
        timestampMs,
        totalTokens: readCodexTotalTokens(payload),
      });
      // Codex session JSONL is chronological; the last token_count event is
      // the latest quota snapshot for the file.
      latestLimits = normalizeCodexUsageLimits(payload.rate_limits ?? payload.rateLimits);
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  if (events.length === 0) {
    return null;
  }
  return {
    sessionId: nodePath.basename(path, ".jsonl"),
    events,
    limits: latestLimits,
  };
}

/** Test-only: read one Codex session file as its full token event series. */
export function __readCodexSessionSeriesForTests(path: string): Promise<CodexSessionSeries | null> {
  return readCodexSessionSeries(path);
}

function readClaudeTotalTokens(value: unknown): number {
  const usage = asRecord(value);
  if (!usage) {
    return 0;
  }

  const inputTokens =
    (asNonNegativeNumber(usage.input_tokens) ?? 0) +
    (asNonNegativeNumber(usage.cache_creation_input_tokens) ?? 0) +
    (asNonNegativeNumber(usage.cache_read_input_tokens) ?? 0);
  const outputTokens = asNonNegativeNumber(usage.output_tokens) ?? 0;
  return asNonNegativeNumber(usage.total_tokens) ?? inputTokens + outputTokens;
}

function readClaudeAssistantSample(input: {
  record: Record<string, unknown>;
  fallbackKey: string;
}): { dedupeKey: string; sample: ClaudeUsageSample } | null {
  if (input.record.type !== "assistant") {
    return null;
  }

  const message = asRecord(input.record.message);
  const usage = asRecord(message?.usage);
  const totalTokens = readClaudeTotalTokens(usage);
  const timestampMs = parseTimestampMs(input.record.timestamp);
  if (!usage || totalTokens <= 0 || timestampMs === null) {
    return null;
  }

  const sessionId = asString(input.record.sessionId) ?? input.fallbackKey;
  const model = asString(message?.model) ?? null;
  const dedupeKey =
    `${sessionId}:assistant:` +
    (asString(input.record.requestId) ??
      asString(message?.id) ??
      asString(input.record.uuid) ??
      input.fallbackKey);

  return {
    dedupeKey,
    sample: {
      sessionId,
      timestampMs,
      totalTokens,
      model,
    },
  };
}

function readClaudeToolResultSample(input: {
  record: Record<string, unknown>;
  fallbackKey: string;
}): { dedupeKey: string; sample: ClaudeUsageSample } | null {
  const toolUseResult = asRecord(input.record.toolUseResult);
  const usage = asRecord(toolUseResult?.usage);
  const totalTokens = readClaudeTotalTokens(usage);
  const timestampMs = parseTimestampMs(input.record.timestamp);
  if (!toolUseResult || !usage || totalTokens <= 0 || timestampMs === null) {
    return null;
  }

  const sessionId = asString(input.record.sessionId) ?? input.fallbackKey;
  const dedupeKey =
    `${sessionId}:tool-result:` +
    (asString(input.record.uuid) ??
      asString(toolUseResult.agentId) ??
      asString(input.record.requestId) ??
      input.fallbackKey);

  return {
    dedupeKey,
    sample: {
      sessionId,
      timestampMs,
      totalTokens,
      model: null,
    },
  };
}

// Claude Code stores transcripts under `<CLAUDE_CONFIG_DIR>/projects`. Without an
// override, support both roots used by Claude installations and local history tools.
function resolveClaudeProjectsRoots(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) {
    return [nodePath.join(configDir, "projects")];
  }
  const configRoot = env.XDG_CONFIG_HOME?.trim() || nodePath.join(homeDir, ".config");
  return [
    nodePath.join(configRoot, "claude", "projects"),
    nodePath.join(homeDir, ".claude", "projects"),
  ];
}

async function listRecentClaudeTranscriptFiles(
  projectsRoots: ReadonlyArray<string>,
  maxFiles: number = MAX_RECENT_USAGE_FILES,
): Promise<RecentFiles> {
  const candidates = new Set<string>();
  for (const projectsRoot of projectsRoots) {
    const projectEntries = await safeReadDir(projectsRoot);

    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }

      const projectDir = nodePath.join(projectsRoot, projectEntry.name);
      const transcriptEntries = await safeReadDir(projectDir);
      for (const transcriptEntry of transcriptEntries) {
        if (transcriptEntry.isFile() && transcriptEntry.name.endsWith(".jsonl")) {
          candidates.add(nodePath.join(projectDir, transcriptEntry.name));
        }
      }
    }
  }

  // The two configured roots can expose the same transcript (e.g. one is a
  // symlink to the other after a migration). Collapse file identity through
  // realpath so the same file is only ever scanned once.
  const resolvedCandidates = new Set<string>();
  for (const candidate of candidates) {
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      // The transcript vanished between readdir and realpath; skip it.
      continue;
    }
    resolvedCandidates.add(real);
  }

  return listRecentFiles([...resolvedCandidates], maxFiles);
}

/** Test-only: verify Claude transcript discovery collapses symlinked roots. */
export function __listRecentClaudeTranscriptFilesForTests(
  projectsRoots: ReadonlyArray<string>,
  maxFiles: number = MAX_RECENT_USAGE_FILES,
): Promise<RecentFiles> {
  return listRecentClaudeTranscriptFiles(projectsRoots, maxFiles);
}

async function readClaudeUsageSamples(
  path: string,
  sharedSeenKeys: Set<string>,
): Promise<ReadonlyArray<ClaudeUsageSample>> {
  try {
    const stats = await fs.stat(path);
    if (!stats.isFile() || stats.size > MAX_USAGE_FILE_BYTES) {
      return [];
    }
  } catch {
    return [];
  }
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const samples: ClaudeUsageSample[] = [];
  try {
    let index = 0;
    for await (const line of lines) {
      if (stream.bytesRead > MAX_USAGE_FILE_BYTES) {
        return [];
      }
      if (!line || !line.trim()) {
        index += 1;
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        index += 1;
        continue;
      }

      const record = asRecord(parsed);
      if (!record) {
        index += 1;
        continue;
      }

      const fallbackKey = `${path}:${index}`;
      const assistantSample = readClaudeAssistantSample({ record, fallbackKey });
      if (assistantSample && !sharedSeenKeys.has(assistantSample.dedupeKey)) {
        sharedSeenKeys.add(assistantSample.dedupeKey);
        samples.push(assistantSample.sample);
      }

      const toolResultSample = readClaudeToolResultSample({ record, fallbackKey });
      if (toolResultSample && !sharedSeenKeys.has(toolResultSample.dedupeKey)) {
        sharedSeenKeys.add(toolResultSample.dedupeKey);
        samples.push(toolResultSample.sample);
      }
      index += 1;
    }
  } catch {
    return [];
  } finally {
    lines.close();
    stream.destroy();
  }
  return samples;
}

/** Test-only: read one Claude transcript with a caller-owned dedup key set. */
export function __readClaudeUsageSamplesForTests(
  path: string,
  sharedSeenKeys: Set<string>,
): Promise<ReadonlyArray<ClaudeUsageSample>> {
  return readClaudeUsageSamples(path, sharedSeenKeys);
}

async function loadCodexUsageSnapshot(input: {
  homeDir: string;
  homePath?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<UsageSnapshot | null> {
  const codexHomeDir =
    input.homePath?.trim() || input.env?.CODEX_HOME || nodePath.join(input.homeDir, ".codex");
  const sessionsRoot = nodePath.join(codexHomeDir, "sessions");
  const nowMs = input.nowMs ?? Date.now();
  const sessionFiles = await listRecentCodexSessionFiles(sessionsRoot, nowMs);
  const partial = sessionFiles.truncated || sessionFiles.oversized;
  const partialDetail = archivePartialDetail("Codex", sessionFiles);
  if (sessionFiles.paths.length === 0) {
    return null;
  }

  const sessionSeries = (
    await mapWithConcurrency(
      sessionFiles.paths,
      PROVIDER_USAGE_FILE_READ_CONCURRENCY,
      readCodexSessionSeries,
    )
  ).filter((series): series is CodexSessionSeries => series !== null);

  if (sessionSeries.length === 0) {
    if (!partial) {
      return null;
    }
    const activity = buildMachineUsageActivity({
      provider: "codex",
      source: "codex-session-archive",
      nowMs,
      samples: [],
      partial: true,
      ...(partialDetail ? { partialDetail } : {}),
    });
    return {
      provider: "codex",
      updatedAt: toIsoString(nowMs),
      limits: [],
      usageLines: [],
      source: "codex-session-archive",
      activity,
    };
  }

  const cutoff24h = nowMs - ONE_DAY_MS;
  const cutoff7d = nowMs - LOOKBACK_7D_MS;
  const cutoff30d = nowMs - LOOKBACK_30D_MS;

  // Each token_count event carries a running session total. Attribute each
  // event's positive delta to its own timestamp so a long/resumed session
  // never over-reports every window that contains its final event.
  interface CodexDelta {
    readonly sessionId: string;
    readonly timestampMs: number;
    readonly tokens: number;
  }
  const deltas: CodexDelta[] = [];
  for (const series of sessionSeries) {
    let previous: number | undefined;
    for (const event of series.events) {
      const delta = previous === undefined ? event.totalTokens : event.totalTokens - previous;
      previous = event.totalTokens;
      if (delta > 0) {
        deltas.push({ sessionId: series.sessionId, timestampMs: event.timestampMs, tokens: delta });
      }
    }
  }

  const latestSeries = sessionSeries.reduce((latest, series) => {
    const lastEvent = series.events[series.events.length - 1];
    const latestEvent = latest.events[latest.events.length - 1];
    if (!lastEvent) {
      return latest;
    }
    if (!latestEvent || lastEvent.timestampMs > latestEvent.timestampMs) {
      return series;
    }
    return latest;
  }, sessionSeries[0]!);
  const latestEventTimestamp =
    latestSeries.events[latestSeries.events.length - 1]?.timestampMs ?? nowMs;

  const tokensIn = (cutoff: number) =>
    deltas
      .filter((delta) => delta.timestampMs >= cutoff)
      .reduce((total, delta) => total + delta.tokens, 0);
  const sessionsIn = (cutoff: number) =>
    new Set(deltas.filter((delta) => delta.timestampMs >= cutoff).map((delta) => delta.sessionId))
      .size;

  // The machine card only covers the recent 30-day window; older event deltas
  // must not inflate the "30 days" period.
  const activitySamples: MachineActivitySample[] = deltas
    .filter((delta) => delta.timestampMs >= cutoff30d)
    .map((delta) => ({
      sessionId: delta.sessionId,
      timestampMs: delta.timestampMs,
      tokens: { total: delta.tokens },
    }));
  const activity = buildMachineUsageActivity({
    provider: "codex",
    source: "codex-session-archive",
    nowMs,
    samples: activitySamples,
    partial,
    ...(partialDetail ? { partialDetail } : {}),
  });

  return {
    provider: "codex",
    updatedAt: toIsoString(latestEventTimestamp),
    limits: latestSeries.limits,
    usageLines: buildUsageLines({
      tokens24h: tokensIn(cutoff24h),
      tokens7d: tokensIn(cutoff7d),
      tokens30d: tokensIn(cutoff30d),
      sessions24h: sessionsIn(cutoff24h),
      sessions7d: sessionsIn(cutoff7d),
      sessions30d: sessionsIn(cutoff30d),
    }),
    source: "codex-session-archive",
    activity,
  };
}

async function loadClaudeUsageSnapshot(input: {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<UsageSnapshot | null> {
  const projectsRoots = resolveClaudeProjectsRoots(input.homeDir, input.env ?? process.env);
  const transcriptFiles = await listRecentClaudeTranscriptFiles(projectsRoots);
  const partial = transcriptFiles.truncated || transcriptFiles.oversized;
  const partialDetail = archivePartialDetail("Claude", transcriptFiles);
  if (transcriptFiles.paths.length === 0) {
    return null;
  }

  // One shared dedup-key set across every transcript: sample keys derive from
  // sessionId + requestId/messageId/uuid, so a transcript copied or hardlinked
  // into a second root is only ever counted once.
  const sharedSeenKeys = new Set<string>();
  const usageSamples = (
    await mapWithConcurrency(transcriptFiles.paths, PROVIDER_USAGE_FILE_READ_CONCURRENCY, (path) =>
      readClaudeUsageSamples(path, sharedSeenKeys),
    )
  ).flat();

  if (usageSamples.length === 0) {
    if (!partial) {
      return null;
    }
    const nowMs = input.nowMs ?? Date.now();
    const activity = buildMachineUsageActivity({
      provider: "claudeAgent",
      source: "claude-project-transcripts",
      nowMs,
      samples: [],
      partial: true,
      ...(partialDetail ? { partialDetail } : {}),
    });
    return {
      provider: "claudeAgent",
      updatedAt: toIsoString(nowMs),
      limits: [],
      usageLines: [],
      source: "claude-project-transcripts",
      activity,
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const cutoff24h = nowMs - ONE_DAY_MS;
  const cutoff7d = nowMs - LOOKBACK_7D_MS;
  const cutoff30d = nowMs - LOOKBACK_30D_MS;
  const recent24h = usageSamples.filter((sample) => sample.timestampMs >= cutoff24h);
  const recent7d = usageSamples.filter((sample) => sample.timestampMs >= cutoff7d);
  const recent30d = usageSamples.filter((sample) => sample.timestampMs >= cutoff30d);
  const latestSample = usageSamples.reduce((latest, current) =>
    current.timestampMs > latest.timestampMs ? current : latest,
  );
  // The machine card only covers the recent 30-day window; months-old samples
  // must not inflate the "30 days" period.
  const claudeSamples: MachineActivitySample[] = usageSamples
    .filter((sample) => sample.timestampMs >= cutoff30d)
    .map((sample): MachineActivitySample => {
      const tokens = { total: sample.totalTokens };
      if (sample.model) {
        return {
          sessionId: sample.sessionId,
          timestampMs: sample.timestampMs,
          model: sample.model,
          tokens,
        };
      }
      return { sessionId: sample.sessionId, timestampMs: sample.timestampMs, tokens };
    });
  const activity = buildMachineUsageActivity({
    provider: "claudeAgent",
    source: "claude-project-transcripts",
    nowMs,
    samples: claudeSamples,
    partial,
    ...(partialDetail ? { partialDetail } : {}),
  });

  return {
    provider: "claudeAgent",
    updatedAt: toIsoString(latestSample.timestampMs),
    limits: [],
    usageLines: buildUsageLines({
      tokens24h: recent24h.reduce((total, sample) => total + sample.totalTokens, 0),
      tokens7d: recent7d.reduce((total, sample) => total + sample.totalTokens, 0),
      tokens30d: recent30d.reduce((total, sample) => total + sample.totalTokens, 0),
      sessions24h: new Set(recent24h.map((sample) => sample.sessionId)).size,
      sessions7d: new Set(recent7d.map((sample) => sample.sessionId)).size,
      sessions30d: new Set(recent30d.map((sample) => sample.sessionId)).size,
    }),
    source: "claude-project-transcripts",
    activity,
  };
}

/** Test-only: run the Codex archive loader with a fixed reference time. */
export function __loadCodexUsageSnapshotForTests(input: {
  homeDir: string;
  homePath?: string;
  env?: NodeJS.ProcessEnv;
  nowMs: number;
}): Promise<UsageSnapshot | null> {
  return loadCodexUsageSnapshot(input);
}

/** Test-only: run the Claude archive loader with a fixed reference time. */
export function __loadClaudeUsageSnapshotForTests(input: {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  nowMs: number;
}): Promise<UsageSnapshot | null> {
  return loadClaudeUsageSnapshot(input);
}

async function loadMachineActivitySnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<UsageSnapshot | null> {
  const activity = await scanLocalProviderActivity({
    provider: input.provider,
    homeDir: input.homeDir,
    ...(input.env ? { env: input.env } : {}),
  });
  if (!activity) {
    return null;
  }
  return {
    provider: input.provider,
    updatedAt: activity.capturedAt,
    limits: [],
    // Machine activity is exposed through `activity` only. Account usageLines
    // belong to provider-owned limit/usage sources and must not be mixed with
    // local history in the account-usage surface.
    usageLines: [],
    source: activity.source,
    status: activity.status === "error" ? "error" : "ok",
    ...(activity.detail ? { detail: activity.detail } : {}),
    activity,
  };
}

async function loadProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  switch (input.provider) {
    case "codex":
      return loadCodexUsageSnapshot({
        homeDir: input.homeDir,
        ...(input.homePath ? { homePath: input.homePath } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
    case "claudeAgent":
      return loadClaudeUsageSnapshot({
        homeDir: input.homeDir,
        ...(input.env ? { env: input.env } : {}),
      });
    case "opencode":
    case "grok":
      return loadMachineActivitySnapshot({
        provider: input.provider,
        homeDir: input.homeDir,
        ...(input.env ? { env: input.env } : {}),
      });
    default:
      return null;
  }
}

async function getCachedProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  const cacheKey =
    `${input.provider}:${input.homeDir}:${input.homePath?.trim() ?? ""}:` +
    `${input.env?.CODEX_HOME?.trim() ?? ""}:${input.env?.CLAUDE_CONFIG_DIR?.trim() ?? ""}`;
  const nowMs = Date.now();
  const existing = usageSnapshotCache.get(cacheKey);

  if (existing && existing.expiresAtMs > nowMs) {
    return existing.value;
  }
  if (existing?.pending) {
    return existing.pending;
  }

  const pending = loadProviderUsageSnapshot(input)
    .catch(() => null)
    .then((value) => {
      usageSnapshotCache.set(cacheKey, {
        expiresAtMs: Date.now() + USAGE_CACHE_TTL_MS,
        value,
        pending: null,
      });
      return value;
    });

  usageSnapshotCache.set(cacheKey, {
    expiresAtMs: existing?.expiresAtMs ?? 0,
    value: existing?.value ?? null,
    pending,
  });

  return pending;
}

// Exposed as the `serverGetProviderUsageSnapshot` WS RPC. The web client no
// longer calls it (enrichment is server-side via loadLocalProviderUsageSnapshot
// and the batch all-provider fetch), but the endpoint is retained deliberately
// for API stability and diagnostics.
export const getProviderUsageSnapshot = Effect.fn(function* (
  input: ServerGetProviderUsageSnapshotInput,
) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  return yield* Effect.tryPromise({
    try: () =>
      getCachedProviderUsageSnapshot({
        provider: input.provider,
        homeDir: serverConfig.homeDir,
        // Keep the legacy request field, but never let a client choose an
        // arbitrary local path to scan. The configured Codex home is server-owned.
        ...(input.provider === "codex" && settings.providers.codex.homePath
          ? { homePath: settings.providers.codex.homePath }
          : {}),
        env: process.env,
      }),
    catch: () => null,
  });
});

export async function loadLocalProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  try {
    return await getCachedProviderUsageSnapshot(input);
  } catch {
    return null;
  }
}
