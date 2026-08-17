// FILE: providerUsageSnapshot.ts
// Purpose: Read provider-specific local usage archives for recent usage snapshots.

import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";

import type {
  ProviderKind,
  ServerGetProviderUsageSnapshotInput,
  ServerGetProviderUsageSnapshotResult,
  ServerProviderUsageLimit,
  ServerProviderUsageLine,
} from "@synara/contracts";
import { Effect } from "effect";

import { ServerConfig } from "./config";

const LOOKBACK_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_7D_MS = 7 * ONE_DAY_MS;
const LOOKBACK_30D_MS = LOOKBACK_DAYS * ONE_DAY_MS;
const USAGE_CACHE_TTL_MS = 30_000;
// Keep enough recent archives to make the 30d summary materially different from 7d
// for heavy local usage without scanning the full historical archive every refresh.
const MAX_RECENT_USAGE_FILES = 2_000;
const PROVIDER_USAGE_FILE_READ_CONCURRENCY = 16;
const CODEX_SESSION_READ_CHUNK_BYTES = 64 * 1024;
const MAX_CODEX_SESSION_LINE_BYTES = 1024 * 1024;

type UsageSnapshot = Exclude<ServerGetProviderUsageSnapshotResult, null>;

interface CachedUsageSnapshot {
  expiresAtMs: number;
  value: ServerGetProviderUsageSnapshotResult;
  pending: Promise<ServerGetProviderUsageSnapshotResult> | null;
}

interface CodexSessionSummary {
  timestampMs: number;
  totalTokens: number;
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
): Promise<ReadonlyArray<string>> {
  const filesWithStats = await mapWithConcurrency(
    paths,
    PROVIDER_USAGE_FILE_READ_CONCURRENCY,
    async (path) => ({
      path,
      mtimeMs: (await safeStat(path))?.mtimeMs ?? 0,
    }),
  );

  return filesWithStats
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .map((entry) => entry.path);
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

async function listRecentCodexSessionFiles(sessionsRoot: string): Promise<ReadonlyArray<string>> {
  const now = new Date();
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

async function readFileRange(
  handle: Awaited<ReturnType<typeof fs.open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

function parseCodexSessionSummaryLine(line: string): CodexSessionSummary | null {
  if (!line.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (!record || record.type !== "event_msg") {
    return null;
  }

  const payload = asRecord(record.payload);
  if (!payload || payload.type !== "token_count") {
    return null;
  }

  const timestampMs = parseTimestampMs(record.timestamp ?? payload.timestamp);
  if (timestampMs === null) {
    return null;
  }

  return {
    timestampMs,
    totalTokens: readCodexTotalTokens(payload),
    limits: normalizeCodexUsageLimits(payload.rate_limits ?? payload.rateLimits),
  };
}

export async function readCodexSessionSummary(path: string): Promise<CodexSessionSummary | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return null;
  }

  try {
    const { size } = await handle.stat();
    let position = size;
    let partialLine = Buffer.alloc(0);
    let skippingOversizedLine = false;

    while (position > 0) {
      const length = Math.min(CODEX_SESSION_READ_CHUNK_BYTES, position);
      position -= length;
      const bytes = await readFileRange(handle, position, length);
      let lineEnd = bytes.length;

      for (let index = bytes.length - 1; index >= 0; index -= 1) {
        if (bytes[index] !== 0x0a) {
          continue;
        }

        const linePrefix = bytes.subarray(index + 1, lineEnd);
        if (skippingOversizedLine) {
          skippingOversizedLine = false;
        } else {
          const lineLength = linePrefix.length + partialLine.length;
          if (lineLength <= MAX_CODEX_SESSION_LINE_BYTES) {
            const summary = parseCodexSessionSummaryLine(
              Buffer.concat([linePrefix, partialLine], lineLength).toString("utf8"),
            );
            if (summary) {
              return summary;
            }
          }
        }

        partialLine = Buffer.alloc(0);
        lineEnd = index;
      }

      if (skippingOversizedLine) {
        continue;
      }

      const linePrefix = bytes.subarray(0, lineEnd);
      const lineLength = linePrefix.length + partialLine.length;
      if (lineLength > MAX_CODEX_SESSION_LINE_BYTES) {
        partialLine = Buffer.alloc(0);
        skippingOversizedLine = true;
        continue;
      }
      partialLine = Buffer.concat([linePrefix, partialLine], lineLength);
    }

    return skippingOversizedLine
      ? null
      : parseCodexSessionSummaryLine(partialLine.toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
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

// Claude Code stores transcripts under `<CLAUDE_CONFIG_DIR>/projects`, defaulting to
// `~/.claude/projects`. Honor the override so the Profile reads the SAME transcripts
// the active Claude provider does (the adapter inherits `process.env`).
function resolveClaudeProjectsRoot(homeDir: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return nodePath.join(configDir || nodePath.join(homeDir, ".claude"), "projects");
}

async function listRecentClaudeTranscriptFiles(
  projectsRoot: string,
  maxFiles: number = MAX_RECENT_USAGE_FILES,
): Promise<ReadonlyArray<string>> {
  const candidates: string[] = [];
  const projectEntries = await safeReadDir(projectsRoot);

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }

    const projectDir = nodePath.join(projectsRoot, projectEntry.name);
    const transcriptEntries = await safeReadDir(projectDir);
    for (const transcriptEntry of transcriptEntries) {
      if (transcriptEntry.isFile() && transcriptEntry.name.endsWith(".jsonl")) {
        candidates.push(nodePath.join(projectDir, transcriptEntry.name));
      }
    }
  }

  return listRecentFiles(candidates, maxFiles);
}

async function readClaudeUsageSamples(path: string): Promise<ReadonlyArray<ClaudeUsageSample>> {
  let fileContents: string;
  try {
    fileContents = await fs.readFile(path, "utf8");
  } catch {
    return [];
  }

  const samples: ClaudeUsageSample[] = [];
  const seenKeys = new Set<string>();
  const lines = fileContents.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
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
    if (!record) {
      continue;
    }

    const fallbackKey = `${path}:${index}`;
    const assistantSample = readClaudeAssistantSample({ record, fallbackKey });
    if (assistantSample && !seenKeys.has(assistantSample.dedupeKey)) {
      seenKeys.add(assistantSample.dedupeKey);
      samples.push(assistantSample.sample);
    }

    const toolResultSample = readClaudeToolResultSample({ record, fallbackKey });
    if (toolResultSample && !seenKeys.has(toolResultSample.dedupeKey)) {
      seenKeys.add(toolResultSample.dedupeKey);
      samples.push(toolResultSample.sample);
    }
  }

  return samples;
}

async function loadCodexUsageSnapshot(input: {
  homeDir: string;
  homePath?: string;
}): Promise<UsageSnapshot | null> {
  const codexHomeDir =
    input.homePath?.trim() || process.env.CODEX_HOME || nodePath.join(input.homeDir, ".codex");
  const sessionsRoot = nodePath.join(codexHomeDir, "sessions");
  const sessionFiles = await listRecentCodexSessionFiles(sessionsRoot);
  if (sessionFiles.length === 0) {
    return null;
  }

  const sessionSummaries = (
    await mapWithConcurrency(
      sessionFiles,
      PROVIDER_USAGE_FILE_READ_CONCURRENCY,
      readCodexSessionSummary,
    )
  ).filter((summary): summary is CodexSessionSummary => summary !== null);

  if (sessionSummaries.length === 0) {
    return null;
  }

  const latestSummary = sessionSummaries.reduce((latest, current) =>
    current.timestampMs > latest.timestampMs ? current : latest,
  );
  const nowMs = Date.now();
  const cutoff24h = nowMs - ONE_DAY_MS;
  const cutoff7d = nowMs - LOOKBACK_7D_MS;
  const cutoff30d = nowMs - LOOKBACK_30D_MS;

  const recent24h = sessionSummaries.filter((summary) => summary.timestampMs >= cutoff24h);
  const recent7d = sessionSummaries.filter((summary) => summary.timestampMs >= cutoff7d);
  const recent30d = sessionSummaries.filter((summary) => summary.timestampMs >= cutoff30d);

  return {
    provider: "codex",
    updatedAt: toIsoString(latestSummary.timestampMs),
    limits: latestSummary.limits,
    usageLines: buildUsageLines({
      tokens24h: recent24h.reduce((total, summary) => total + summary.totalTokens, 0),
      tokens7d: recent7d.reduce((total, summary) => total + summary.totalTokens, 0),
      tokens30d: recent30d.reduce((total, summary) => total + summary.totalTokens, 0),
      sessions24h: recent24h.length,
      sessions7d: recent7d.length,
      sessions30d: recent30d.length,
    }),
    source: "codex-session-archive",
  };
}

async function loadClaudeUsageSnapshot(input: { homeDir: string }): Promise<UsageSnapshot | null> {
  const projectsRoot = resolveClaudeProjectsRoot(input.homeDir);
  const transcriptFiles = await listRecentClaudeTranscriptFiles(projectsRoot);
  if (transcriptFiles.length === 0) {
    return null;
  }

  const usageSamples = (
    await mapWithConcurrency(
      transcriptFiles,
      PROVIDER_USAGE_FILE_READ_CONCURRENCY,
      readClaudeUsageSamples,
    )
  ).flat();

  if (usageSamples.length === 0) {
    return null;
  }

  const nowMs = Date.now();
  const cutoff24h = nowMs - ONE_DAY_MS;
  const cutoff7d = nowMs - LOOKBACK_7D_MS;
  const cutoff30d = nowMs - LOOKBACK_30D_MS;
  const recent24h = usageSamples.filter((sample) => sample.timestampMs >= cutoff24h);
  const recent7d = usageSamples.filter((sample) => sample.timestampMs >= cutoff7d);
  const recent30d = usageSamples.filter((sample) => sample.timestampMs >= cutoff30d);
  const latestSample = usageSamples.reduce((latest, current) =>
    current.timestampMs > latest.timestampMs ? current : latest,
  );

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
  };
}

async function loadProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  switch (input.provider) {
    case "codex":
      return loadCodexUsageSnapshot({
        homeDir: input.homeDir,
        ...(input.homePath ? { homePath: input.homePath } : {}),
      });
    case "claudeAgent":
      return loadClaudeUsageSnapshot({ homeDir: input.homeDir });
    default:
      return null;
  }
}

async function getCachedProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  const cacheKey = `${input.provider}:${input.homeDir}:${input.homePath?.trim() ?? ""}:${process.env.CLAUDE_CONFIG_DIR?.trim() ?? ""}`;
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

export const getProviderUsageSnapshot = Effect.fn(function* (
  input: ServerGetProviderUsageSnapshotInput,
) {
  const serverConfig = yield* ServerConfig;
  return yield* Effect.tryPromise({
    try: () =>
      getCachedProviderUsageSnapshot({
        provider: input.provider,
        homeDir: serverConfig.homeDir,
        ...(input.homePath ? { homePath: input.homePath } : {}),
      }),
    catch: () => null,
  });
});

// Reused by the live-usage batch (providerUsage/index.ts) to enrich live snapshots with the
// locally-derived 24h/7d/30d token-total lines for providers that keep on-disk archives.
export async function loadLocalProviderUsageLines(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
}): Promise<ReadonlyArray<ServerProviderUsageLine>> {
  try {
    const snapshot = await getCachedProviderUsageSnapshot(input);
    return snapshot?.usageLines ?? [];
  } catch {
    return [];
  }
}
