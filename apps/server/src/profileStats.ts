// FILE: profileStats.ts
// Purpose: Compute Profile-page stats from Synara's local projection DB only.
// The share card never reads provider archives or cloud services for metrics.
// Stats are lifetime numbers: deleting a thread purges its rows but snapshots
// the aggregates into profile_stats_deleted_* first (profileStatsArchive.ts),
// and every query here merges live projections with those archived aggregates.
// Layer: server stats query service (SqlClient + ServerConfig).

import nodePath from "node:path";

import type {
  ProfileQuota,
  ProfileStats,
  ProfileTokenStats,
  ProviderKind,
  StatsGetProfileStatsInput,
  StatsGetProfileTokenStatsInput,
} from "@synara/contracts";
import { isBuiltInComposerSlashCommandName } from "@synara/shared/composerSlashCommands";
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "./config";

const HEATMAP_WINDOW_DAYS = 274; // ~9 months, GitHub-style contribution grid.
const SKILL_RESULT_LIMIT = 12;
const PROVIDER_KINDS = new Set<ProviderKind>([
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "opencode",
  "pi",
  "devin",
]);

type HeatmapCell = ProfileStats["activity"]["heatmap"][number];
type ProviderModelUsage = ProfileStats["providerModels"][number];
type SkillUsage = ProfileStats["skills"][number];
type MostWorkedProject = ProfileStats["mostWorkedProject"];

interface CountRow {
  readonly count: number;
}

interface PromptActivityRow extends CountRow {
  readonly day: string | null;
  readonly hour: number | null;
}

interface TurnInsightRow extends CountRow {
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoning: string | null;
}

interface SkillUsageMessageRow {
  readonly messageId: string | null;
  readonly text: string | null;
  readonly skillsJson: string | null;
  readonly mentionsJson: string | null;
}

// Pre-aggregated usage snapshotted from purged threads (profile_stats_deleted_skills).
interface ArchivedSkillUsageRow {
  readonly name: string | null;
  readonly kind: string | null;
  readonly runCount: number;
}

interface MostWorkedProjectRow {
  readonly projectId: string | null;
  readonly title: string | null;
  readonly workspaceRoot: string | null;
  readonly promptCount: number;
  readonly threadCount: number;
  readonly activeDays: number;
  readonly lastWorkedAt: string | null;
}

interface TokenDayRow {
  readonly day: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly tokens: number;
}

type UsageKind = "skill" | "agent";

interface UsageCount {
  name: string;
  kind: UsageKind;
  runCount: number;
}

// ── Pure helpers ───────────────────────────────────────────────────────

// SQLite DATETIME() modifier that shifts UTC timestamps into the caller's LOCAL
// wall-clock time (for example "+02:00" / "-05:00").
export function sqliteModifierFromUtcOffsetMinutes(offsetMinutes: number): string {
  const safe = Number.isFinite(offsetMinutes) ? Math.trunc(offsetMinutes) : 0;
  const sign = safe < 0 ? "-" : "+";
  const abs = Math.abs(safe);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function localToday(utcOffsetMinutes: number): string {
  return new Date(Date.now() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function num(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const PROFILE_SKILL_NAME_TOKEN =
  "[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?::[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)*";
const PROFILE_SKILL_TOKEN_REGEX = new RegExp(
  `(^|[\\s([{<])([$/])(${PROFILE_SKILL_NAME_TOKEN})(?=$|[\\s.,!?;)\\]}>])`,
  "giu",
);
const PROFILE_TRAILING_PROMPT_BLOCK_PATTERNS = [
  /\n*<pasted_text>\n[\s\S]*?\n<\/pasted_text>\s*$/u,
  /\n*<file_comments>\n[\s\S]*?\n<\/file_comments>\s*$/u,
  /\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*$/u,
  /\n*<assistant_selection>\n[\s\S]*?\n<\/assistant_selection>\s*$/u,
] as const;

function normalizeUsageName(value: unknown): string | null {
  const name = nonEmptyString(value);
  if (!name) {
    return null;
  }
  const withoutPrefix = name.replace(/^[$/@]+/u, "").trim();
  return withoutPrefix.length > 0 ? withoutPrefix : null;
}

function usageKey(kind: UsageKind, name: string): string {
  return `${kind}\u0000${name.toLowerCase()}`;
}

function usageKindSortOrder(kind: UsageKind): number {
  return kind === "skill" ? 0 : 1;
}

function isObviousNonSkillDollarToken(name: string): boolean {
  return /^\d/u.test(name) || /^[A-Z_][A-Z0-9_]*$/u.test(name);
}

function stripProfileTrailingPromptBlocks(prompt: string): string {
  let visiblePrompt = prompt;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const pattern of PROFILE_TRAILING_PROMPT_BLOCK_PATTERNS) {
      const nextPrompt = visiblePrompt.replace(pattern, "").replace(/\n+$/u, "");
      if (nextPrompt !== visiblePrompt) {
        visiblePrompt = nextPrompt;
        stripped = true;
        break;
      }
    }
  }
  return visiblePrompt;
}

function parseReferenceNames(json: string | null): string[] {
  const value = nonEmptyString(json);
  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry) => {
      if (entry && typeof entry === "object" && "name" in entry) {
        const name = normalizeUsageName((entry as { readonly name?: unknown }).name);
        return name ? [name] : [];
      }
      return [];
    });
  } catch {
    return [];
  }
}

function extractTextSkillNames(text: string | null): string[] {
  const prompt = nonEmptyString(text);
  if (!prompt) {
    return [];
  }
  const visiblePrompt = stripProfileTrailingPromptBlocks(prompt);
  if (visiblePrompt.trim().length === 0) {
    return [];
  }

  const names: string[] = [];
  PROFILE_SKILL_TOKEN_REGEX.lastIndex = 0;
  for (const match of visiblePrompt.matchAll(PROFILE_SKILL_TOKEN_REGEX)) {
    const leadingBoundary = match[1] ?? "";
    const prefix = match[2] ?? "";
    const rawName = match[3] ?? "";
    // Serialized prompt blocks end with XML-style tags like </pasted_text>.
    // Those slashes are structural delimiters, not user-invoked slash skills.
    if (leadingBoundary === "<" && prefix === "/") {
      continue;
    }
    if (prefix === "/" && isBuiltInComposerSlashCommandName(rawName)) {
      continue;
    }

    const hasExplicitSkillPrefix = rawName.toLowerCase().startsWith("skill:");
    const normalizedRawName = rawName.toLowerCase().startsWith("skill:")
      ? rawName.slice("skill:".length)
      : rawName;
    const name = normalizeUsageName(normalizedRawName);
    if (name) {
      // `$...` also appears in shell snippets and prices. Keep the legacy
      // text backfill, but avoid the most common non-skill dollar tokens.
      if (prefix === "$" && !hasExplicitSkillPrefix && isObviousNonSkillDollarToken(name)) {
        continue;
      }
      names.push(name);
    }
  }
  return names;
}

// Builds profile skill rows from every stored Synara user message, plus the
// pre-aggregated counts snapshotted from purged threads. Structured references
// stay authoritative, while text tokens backfill older or partial rows.
export function aggregateProfileSkillUsageRows(
  rows: ReadonlyArray<SkillUsageMessageRow>,
  archivedRows: ReadonlyArray<ArchivedSkillUsageRow> = [],
): SkillUsage[] {
  const counts = new Map<string, UsageCount>();

  for (const row of rows) {
    const messageSkillCounts = new Map<
      string,
      { name: string; structuredCount: number; textCount: number }
    >();
    const messageAgentUsages = new Map<string, { name: string; kind: UsageKind }>();
    const addMessageSkillUsage = (rawName: string, source: "structured" | "text") => {
      const name = normalizeUsageName(rawName);
      if (!name) {
        return;
      }
      const key = usageKey("skill", name);
      const next = messageSkillCounts.get(key) ?? {
        name,
        structuredCount: 0,
        textCount: 0,
      };
      if (source === "structured") {
        next.structuredCount += 1;
      } else {
        next.textCount += 1;
      }
      messageSkillCounts.set(key, next);
    };
    const addMessageAgentUsage = (rawName: string) => {
      const name = normalizeUsageName(rawName);
      if (!name) {
        return;
      }
      const key = usageKey("agent", name);
      if (!messageAgentUsages.has(key)) {
        messageAgentUsages.set(key, { name, kind: "agent" });
      }
    };

    for (const name of parseReferenceNames(row.skillsJson)) {
      addMessageSkillUsage(name, "structured");
    }
    for (const name of extractTextSkillNames(row.text)) {
      addMessageSkillUsage(name, "text");
    }
    for (const name of parseReferenceNames(row.mentionsJson)) {
      addMessageAgentUsage(name);
    }

    for (const usage of messageSkillCounts.values()) {
      // Selected skills can appear both as structured refs and visible text.
      // Count repeated user tokens, but do not double-count the structured echo.
      const increment = Math.max(usage.structuredCount, usage.textCount);
      if (increment <= 0) {
        continue;
      }
      const key = usageKey("skill", usage.name);
      const existing = counts.get(key);
      if (existing) {
        existing.runCount += increment;
      } else {
        counts.set(key, { name: usage.name, kind: "skill", runCount: increment });
      }
    }

    for (const usage of messageAgentUsages.values()) {
      const key = usageKey(usage.kind, usage.name);
      const existing = counts.get(key);
      if (existing) {
        existing.runCount += 1;
      } else {
        counts.set(key, { ...usage, runCount: 1 });
      }
    }
  }

  for (const row of archivedRows) {
    const name = normalizeUsageName(row.name);
    const kind: UsageKind | null = row.kind === "skill" || row.kind === "agent" ? row.kind : null;
    const runCount = Math.trunc(num(row.runCount));
    if (!name || !kind || runCount <= 0) {
      continue;
    }
    const key = usageKey(kind, name);
    const existing = counts.get(key);
    if (existing) {
      existing.runCount += runCount;
    } else {
      counts.set(key, { name, kind, runCount });
    }
  }

  return [...counts.values()]
    .toSorted(
      (left, right) =>
        right.runCount - left.runCount ||
        usageKindSortOrder(left.kind) - usageKindSortOrder(right.kind) ||
        left.name.localeCompare(right.name),
    )
    .map((row) => ({
      name: row.name,
      displayName: `${row.kind === "skill" ? "$" : "@"}${row.name}`,
      kind: row.kind,
      runCount: row.runCount,
    }));
}

function addDaysIso(day: string, delta: number): string {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date) + delta * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(day: string): number {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

// Number of non-empty intensity levels (1–4); level 0 is reserved for empty days.
const HEATMAP_LEVELS = 4;

// Rank a day against the distribution of active days instead of against the window
// max. Percent-of-max bucketing collapses on skewed data — token counts routinely
// span orders of magnitude, so one spike day drops every other day below 25% of the
// max and flattens the entire grid to level 1. Ranking spreads active days across
// all four levels regardless of scale, and ties share a level (a window where every
// active day is identical renders uniformly at level 4).
export function heatmapIntensity(count: number, sortedActiveCounts: readonly number[]): number {
  if (count <= 0 || sortedActiveCounts.length === 0) {
    return 0;
  }
  // Days with a count <= this one, i.e. this day's rank in the active-day distribution.
  let low = 0;
  let high = sortedActiveCounts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sortedActiveCounts[mid]! <= count) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const level = Math.ceil((low * HEATMAP_LEVELS) / sortedActiveCounts.length);
  return Math.min(HEATMAP_LEVELS, Math.max(1, level));
}

function percent1(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function compareNullableText(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  return (left ?? "").localeCompare(right ?? "");
}

function deriveInitials(name: string): string {
  const parts = name.split(/[\s._-]+/u).filter((part) => part.length > 0);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase() || "SY";
  }
  const single = parts[0] ?? name;
  return (single.slice(0, 2) || "SY").toUpperCase();
}

function sanitizeHandle(basename: string): string {
  const slug = basename.toLowerCase().replace(/[^a-z0-9_]/gu, "");
  return `@${slug || "synara"}`;
}

function formatHour(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  if (normalized === 0) return "12 AM";
  if (normalized === 12) return "12 PM";
  return normalized < 12 ? `${normalized} AM` : `${normalized - 12} PM`;
}

function arcName(startHour: number): string {
  if (startHour < 5) return "Late-Night Dev Arc";
  if (startHour < 9) return "Early Bird Arc";
  if (startHour < 12) return "Morning Arc";
  if (startHour < 17) return "Afternoon Arc";
  if (startHour < 21) return "Evening Arc";
  return "Night Owl Arc";
}

function normalizeProviderKind(value: unknown): ProviderKind | "unknown" {
  const provider = nonEmptyString(value);
  return provider && PROVIDER_KINDS.has(provider as ProviderKind)
    ? (provider as ProviderKind)
    : "unknown";
}

interface TokenModelUsageCount {
  readonly provider: ProviderKind | "unknown";
  readonly model: string;
  tokens: number;
}

interface TokenActivityAggregate {
  readonly tokensByDay: Map<string, number>;
  readonly tokensByProvider: Map<ProviderKind, number>;
  readonly tokensByProviderModel: Map<string, TokenModelUsageCount>;
  readonly lifetime: number;
}

function aggregateTokenActivity(rows: ReadonlyArray<TokenDayRow>): TokenActivityAggregate {
  const tokensByDay = new Map<string, number>();
  const tokensByProvider = new Map<ProviderKind, number>();
  const tokensByProviderModel = new Map<string, TokenModelUsageCount>();
  let lifetime = 0;
  for (const row of rows) {
    const day = nonEmptyString(row.day);
    const tokens = num(row.tokens);
    if (!day || tokens <= 0) {
      continue;
    }
    tokensByDay.set(day, (tokensByDay.get(day) ?? 0) + tokens);
    lifetime += tokens;
    const provider = normalizeProviderKind(row.provider);
    if (provider !== "unknown") {
      tokensByProvider.set(provider, (tokensByProvider.get(provider) ?? 0) + tokens);
    }
    const model = nonEmptyString(row.model) ?? "unknown";
    const providerModelKey = `${provider}\u0000${model}`;
    const existing = tokensByProviderModel.get(providerModelKey);
    if (existing) {
      existing.tokens += tokens;
    } else {
      tokensByProviderModel.set(providerModelKey, { provider, model, tokens });
    }
  }
  return { tokensByDay, tokensByProvider, tokensByProviderModel, lifetime };
}

function computeStreaks(
  activeDaysAsc: ReadonlyArray<string>,
  todayKey: string,
): { current: number; longest: number } {
  if (activeDaysAsc.length === 0) {
    return { current: 0, longest: 0 };
  }
  const set = new Set(activeDaysAsc);

  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of activeDaysAsc) {
    run = previous && addDaysIso(previous, 1) === day ? run + 1 : 1;
    if (run > longest) {
      longest = run;
    }
    previous = day;
  }

  // Keep the streak alive through the current local day: if yesterday was active
  // but today is still empty, the user still has today to extend it.
  let anchor: string | null = set.has(todayKey)
    ? todayKey
    : set.has(addDaysIso(todayKey, -1))
      ? addDaysIso(todayKey, -1)
      : null;
  let current = 0;
  while (anchor && set.has(anchor)) {
    current += 1;
    anchor = addDaysIso(anchor, -1);
  }

  return { current, longest };
}

// Rolling 6-month window ending today.
function buildHeatmap(countByDay: ReadonlyMap<string, number>, todayKey: string): HeatmapCell[] {
  const windowStart = addDaysIso(todayKey, -(HEATMAP_WINDOW_DAYS - 1));

  const activeCounts: number[] = [];
  for (const [day, count] of countByDay) {
    if (day >= windowStart && day <= todayKey && count > 0) {
      activeCounts.push(count);
    }
  }
  activeCounts.sort((left, right) => left - right);

  const heatmap: HeatmapCell[] = [];
  for (let offset = 0; offset < HEATMAP_WINDOW_DAYS; offset += 1) {
    const day = addDaysIso(windowStart, offset);
    const count = countByDay.get(day) ?? 0;
    heatmap.push({
      day,
      count,
      weekday: weekdayOf(day),
      intensity: heatmapIntensity(count, activeCounts),
    });
  }
  return heatmap;
}

function emptyQuota(): ProfileQuota {
  return {
    status: "unavailable",
    provider: null,
    window: null,
    usedPercent: null,
    resetsAt: null,
    planName: null,
  };
}

function buildMostWorkedProject(row: MostWorkedProjectRow | undefined): MostWorkedProject {
  if (!row) {
    return null;
  }

  const projectId = nonEmptyString(row.projectId);
  const title = nonEmptyString(row.title);
  const workspaceRoot = nonEmptyString(row.workspaceRoot);
  const lastWorkedAt = nonEmptyString(row.lastWorkedAt);
  if (!projectId || !title || !workspaceRoot || !lastWorkedAt) {
    return null;
  }

  return {
    projectId,
    title,
    workspaceRoot,
    promptCount: num(row.promptCount),
    threadCount: num(row.threadCount),
    activeDays: num(row.activeDays),
    lastWorkedAt,
  };
}

// ── Shared SQL ─────────────────────────────────────────────────────────

// Maps every turn to the provider/model selected when it was started: turn-start
// events carry the pending messageId, which projection_turns links back to the
// turn_id that token activities reference. Shared by the live token stats query
// and the delete-time archive snapshot so both attribute token deltas the same
// way. Pass `scope` to restrict the CTE to a single thread (archive path).
export function turnModelSelectionCte(
  sql: SqlClient.SqlClient,
  scope?: { readonly threadId: string },
) {
  const turnThreadMatch = scope
    ? sql`${scope.threadId}`
    : sql.literal("json_extract(e.payload_json, '$.threadId')");
  const eventThreadScope = scope
    ? sql`AND COALESCE(json_extract(e.payload_json, '$.threadId'), e.stream_id) = ${scope.threadId}`
    : sql.literal("");
  return sql`
    SELECT
      pt.thread_id AS thread_id,
      pt.turn_id AS turn_id,
      MAX(json_extract(e.payload_json, '$.modelSelection.provider')) AS provider,
      MAX(json_extract(e.payload_json, '$.modelSelection.model')) AS model
    FROM orchestration_events e
    JOIN projection_turns pt
      ON pt.thread_id = ${turnThreadMatch}
     AND pt.pending_message_id = json_extract(e.payload_json, '$.messageId')
    WHERE e.event_type = 'thread.turn-start-requested'
      ${eventThreadScope}
      AND pt.turn_id IS NOT NULL
      AND json_type(e.payload_json, '$.modelSelection') = 'object'
    GROUP BY pt.thread_id, pt.turn_id
  `;
}

// ── Service ────────────────────────────────────────────────────────────

export interface ProfileStatsQueryShape {
  readonly getProfileStats: (
    input: StatsGetProfileStatsInput,
  ) => Effect.Effect<ProfileStats, unknown>;
  readonly getProfileTokenStats: (
    input: StatsGetProfileTokenStatsInput,
  ) => Effect.Effect<ProfileTokenStats, unknown>;
}

export class ProfileStatsQuery extends ServiceMap.Service<
  ProfileStatsQuery,
  ProfileStatsQueryShape
>()("synara/profileStats/ProfileStatsQuery") {}

const makeProfileStatsQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;

  function profileStatsErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function isMissingLegacyColumnError(error: unknown): boolean {
    return /\bno such column\b/iu.test(profileStatsErrorMessage(error));
  }

  // Imported legacy databases can briefly miss columns added after their original
  // lineage. Only that compatibility case degrades; real SQL failures should reach
  // the UI retry path instead of producing believable zero-stats.
  const legacyCompatibleQuery = <T>(
    operation: string,
    query: Effect.Effect<ReadonlyArray<T>, unknown>,
  ) =>
    query.pipe(
      Effect.catchIf(isMissingLegacyColumnError, (error) =>
        Effect.logWarning("profile stats query skipped due to missing legacy column", {
          error: profileStatsErrorMessage(error),
          operation,
        }).pipe(Effect.as([] as ReadonlyArray<T>)),
      ),
    );

  // Profile history counts all work ever done. Active and archived thread rows
  // feed these queries directly; explicit deletes purge the thread's rows AFTER
  // snapshotting the aggregates that matter into the profile_stats_deleted_*
  // tables (see profileStatsArchive.ts), so every query below merges current
  // projections with those deleted-thread aggregates.
  // ── SQL helpers ──────────────────────────────────────────────────────

  // Activity = days/hours the user actually sent a Synara prompt. One day-hour
  // grouping gives day totals, hour totals, and lifetime prompt count in TS.
  const queryPromptActivity = (tz: string) =>
    legacyCompatibleQuery(
      "profileStats.promptActivity",
      sql<PromptActivityRow>`
        WITH prompt_events AS (
          -- The thread join (no deleted_at filter) keeps archived and not-yet-
          -- purged rows counting while excluding orphan message rows of purged
          -- threads, which are already counted from the archive tables.
          SELECT m.created_at AS created_at
          FROM projection_thread_messages m
          JOIN projection_threads t ON t.thread_id = m.thread_id
          WHERE m.role = 'user'
            AND m.source = 'native'
            AND (m.dispatch_origin IS NULL OR m.dispatch_origin = 'user')
          UNION ALL
          SELECT d.created_at AS created_at
          FROM profile_stats_deleted_prompts d
        )
        SELECT
          STRFTIME('%Y-%m-%d', DATETIME(created_at, ${tz})) AS day,
          CAST(STRFTIME('%H', DATETIME(created_at, ${tz})) AS INTEGER) AS hour,
          COUNT(*) AS count
        FROM prompt_events
        GROUP BY day, hour
        ORDER BY day ASC, hour ASC
      `,
    );

  // Token usage for EVERY provider, straight from Synara's own DB (no external
  // ~/.codex/~/.claude archives, so it is provider-agnostic AND per-instance). Each
  // `context-window.updated` activity carries a running per-thread token counter;
  // the positive delta is the tokens processed in that step, bucketed by the
  // caller's local day. Deltas are attributed to the provider/model selected for
  // the turn that processed them (activity turn_id → turn's pending message →
  // turn-start modelSelection); the thread's current selection is only a fallback
  // for legacy rows, so switching models mid-thread keeps history accurate.
  // Counter scale: totalProcessedTokens is the preferred cumulative counter.
  // Some provider/model groups only emit usedTokens; keep those as separate
  // fallback series so a mixed-provider thread does not drop their tokens.
  const queryTokenActivity = (tz: string) =>
    legacyCompatibleQuery(
      "profileStats.tokenActivity",
      sql<TokenDayRow>`
        WITH turn_model AS (
          ${turnModelSelectionCte(sql)}
        ),
        ev AS (
          SELECT
            a.thread_id AS thread_id,
            STRFTIME('%Y-%m-%d', DATETIME(a.created_at, ${tz})) AS day,
            COALESCE(
              tm.provider,
              json_extract(a.payload_json, '$.provider'),
              CASE
                WHEN th.model_selection_json IS NOT NULL AND json_valid(th.model_selection_json)
                THEN json_extract(th.model_selection_json, '$.provider')
              END,
              'unknown'
            ) AS provider,
            COALESCE(
              tm.model,
              CASE
                WHEN th.model_selection_json IS NOT NULL
                  AND json_valid(th.model_selection_json)
                  AND (
                    json_extract(a.payload_json, '$.provider') IS NULL
                    OR json_extract(a.payload_json, '$.provider') =
                      json_extract(th.model_selection_json, '$.provider')
                  )
                THEN json_extract(th.model_selection_json, '$.model')
              END,
              'unknown'
            ) AS model,
            CAST(json_extract(a.payload_json, '$.totalProcessedTokens') AS INTEGER) AS tp,
            CAST(json_extract(a.payload_json, '$.usedTokens') AS INTEGER) AS ut,
            pm.dispatch_origin AS dispatch_origin,
            a.sequence AS sequence,
            a.created_at AS created_at,
            a.activity_id AS activity_id
          FROM projection_thread_activities a
          JOIN projection_threads th ON th.thread_id = a.thread_id
          LEFT JOIN turn_model tm
            ON tm.thread_id = a.thread_id
           AND tm.turn_id = a.turn_id
          LEFT JOIN projection_turns pt
            ON pt.thread_id = a.thread_id
           AND pt.turn_id = a.turn_id
          LEFT JOIN projection_thread_messages pm
            ON pm.thread_id = pt.thread_id
           AND pm.message_id = pt.pending_message_id
          WHERE a.kind = 'context-window.updated'
            AND COALESCE(
              json_extract(a.payload_json, '$.totalProcessedTokens'),
              json_extract(a.payload_json, '$.usedTokens')
            ) IS NOT NULL
        ),
        provider_model_scale AS (
          SELECT thread_id, provider, model, MAX(tp IS NOT NULL) AS has_cumulative
          FROM ev
          GROUP BY thread_id, provider, model
        ),
        cumulative_kept AS (
          SELECT
            day,
            provider,
            model,
            thread_id,
            tp AS tot,
            dispatch_origin,
            sequence,
            created_at,
            activity_id
          FROM ev
          WHERE tp IS NOT NULL
        ),
        cumulative_delta AS (
          SELECT
            day,
            provider,
            model,
            dispatch_origin,
            CASE
              WHEN previous_tot IS NULL OR tot < previous_tot THEN tot
              ELSE MAX(0, tot - previous_tot)
            END AS d
          FROM (
            SELECT
              day,
              provider,
              model,
              dispatch_origin,
              tot,
              LAG(tot) OVER (
                PARTITION BY thread_id
                ORDER BY
                  CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                  sequence ASC,
                  created_at ASC,
                  activity_id ASC
              ) AS previous_tot
            FROM cumulative_kept
          )
        ),
        used_only_kept AS (
          SELECT
            ev.day AS day,
            ev.provider AS provider,
            ev.model AS model,
            ev.thread_id AS thread_id,
            ev.ut AS tot,
            ev.dispatch_origin AS dispatch_origin,
            ev.sequence AS sequence,
            ev.created_at AS created_at,
            ev.activity_id AS activity_id
          FROM ev
          JOIN provider_model_scale pms
            ON pms.thread_id = ev.thread_id
           AND pms.provider = ev.provider
           AND pms.model = ev.model
          WHERE ev.tp IS NULL
            AND ev.ut IS NOT NULL
            AND NOT pms.has_cumulative
        ),
        used_only_delta AS (
          SELECT
            day,
            provider,
            model,
            dispatch_origin,
            CASE
              WHEN previous_tot IS NULL THEN tot
              WHEN tot < previous_tot
                AND (provider != previous_provider OR model != previous_model)
              THEN tot
              ELSE MAX(0, tot - previous_tot)
            END AS d
          FROM (
            SELECT
              day,
              provider,
              model,
              dispatch_origin,
              tot,
              LAG(tot) OVER (
                PARTITION BY thread_id
                ORDER BY
                  CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                  sequence ASC,
                  created_at ASC,
                  activity_id ASC
              ) AS previous_tot,
              LAG(provider) OVER (
                PARTITION BY thread_id
                ORDER BY
                  CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                  sequence ASC,
                  created_at ASC,
                  activity_id ASC
              ) AS previous_provider,
              LAG(model) OVER (
                PARTITION BY thread_id
                ORDER BY
                  CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                  sequence ASC,
                  created_at ASC,
                  activity_id ASC
              ) AS previous_model
            FROM used_only_kept
          )
        ),
        all_tokens AS (
          SELECT day, provider, model, d FROM cumulative_delta
          WHERE dispatch_origin IS NULL OR dispatch_origin = 'user'
          UNION ALL
          SELECT day, provider, model, d FROM used_only_delta
          WHERE dispatch_origin IS NULL OR dispatch_origin = 'user'
          UNION ALL
          SELECT
            STRFTIME('%Y-%m-%d', DATETIME(a.created_at, ${tz})) AS day,
            COALESCE(a.provider, 'unknown') AS provider,
            COALESCE(a.model, 'unknown') AS model,
            a.tokens AS d
          FROM profile_stats_deleted_tokens a
        )
        SELECT day, provider, model, SUM(d) AS tokens
        FROM all_tokens
        GROUP BY day, provider, model
      `,
    );

  const queryTotalThreads = () =>
    legacyCompatibleQuery(
      "profileStats.totalThreads",
      sql<CountRow>`
        SELECT
          (SELECT COUNT(*) FROM projection_threads)
          + (SELECT COUNT(*) FROM profile_stats_deleted_threads) AS count
      `,
    );

  const queryTurnInsights = () =>
    legacyCompatibleQuery(
      "profileStats.turnInsights",
      sql<TurnInsightRow>`
        WITH per_turn AS (
          SELECT
            CASE
              WHEN json_type(e.payload_json, '$.modelSelection') = 'object'
              THEN json_extract(e.payload_json, '$.modelSelection.provider')
              ELSE CASE
                WHEN t.model_selection_json IS NOT NULL AND json_valid(t.model_selection_json)
                THEN json_extract(t.model_selection_json, '$.provider')
              END
            END AS provider,
            CASE
              WHEN json_type(e.payload_json, '$.modelSelection') = 'object'
              THEN json_extract(e.payload_json, '$.modelSelection.model')
              ELSE CASE
                WHEN t.model_selection_json IS NOT NULL AND json_valid(t.model_selection_json)
                THEN json_extract(t.model_selection_json, '$.model')
              END
            END AS model,
            CASE
              WHEN json_type(e.payload_json, '$.modelSelection') = 'object'
              THEN COALESCE(
                json_extract(e.payload_json, '$.modelSelection.options.reasoningEffort'),
                json_extract(e.payload_json, '$.modelSelection.options.effort')
              )
              ELSE CASE
                WHEN t.model_selection_json IS NOT NULL AND json_valid(t.model_selection_json)
                THEN COALESCE(
                  json_extract(t.model_selection_json, '$.options.reasoningEffort'),
                  json_extract(t.model_selection_json, '$.options.effort')
                )
              END
            END AS reasoning
          FROM orchestration_events e
          JOIN projection_threads t
            ON t.thread_id = COALESCE(json_extract(e.payload_json, '$.threadId'), e.stream_id)
          LEFT JOIN projection_thread_messages um
            ON um.thread_id = COALESCE(json_extract(e.payload_json, '$.threadId'), e.stream_id)
           AND um.message_id = json_extract(e.payload_json, '$.messageId')
          WHERE e.event_type = 'thread.turn-start-requested'
            AND (um.dispatch_origin IS NULL OR um.dispatch_origin = 'user')
        ),
        turn_counts AS (
          SELECT provider, model, reasoning, COUNT(*) AS count
          FROM per_turn
          GROUP BY provider, model, reasoning
          UNION ALL
          SELECT provider, model, reasoning, turn_count AS count
          FROM profile_stats_deleted_turns
        )
        SELECT provider, model, reasoning, SUM(count) AS count
        FROM turn_counts
        GROUP BY provider, model, reasoning
        ORDER BY count DESC, provider ASC, model ASC, reasoning ASC
      `,
    );

  const querySkillUsageMessages = () =>
    sql<SkillUsageMessageRow>`
      SELECT
        m.message_id AS messageId,
        CASE
          WHEN m.text GLOB '*$[A-Za-z0-9]*'
            OR m.text GLOB '*/[A-Za-z0-9]*'
          THEN m.text
          ELSE NULL
        END AS text,
        m.skills_json AS skillsJson,
        m.mentions_json AS mentionsJson
      FROM projection_thread_messages m
      JOIN projection_threads t ON t.thread_id = m.thread_id
      WHERE m.role = 'user'
        AND m.source = 'native'
        AND (m.dispatch_origin IS NULL OR m.dispatch_origin = 'user')
        AND (
          (m.skills_json IS NOT NULL AND TRIM(m.skills_json) NOT IN ('', '[]'))
          OR (m.mentions_json IS NOT NULL AND TRIM(m.mentions_json) NOT IN ('', '[]'))
          OR m.text GLOB '*$[A-Za-z0-9]*'
          OR m.text GLOB '*/[A-Za-z0-9]*'
        )
      ORDER BY m.created_at ASC, m.message_id ASC
    `.pipe(
      Effect.catchIf(isMissingLegacyColumnError, (error) =>
        Effect.logWarning("profile stats skill usage fell back to text-only legacy scan", {
          error: profileStatsErrorMessage(error),
          operation: "profileStats.skillUsage",
        }).pipe(
          Effect.flatMap(
            () => sql<SkillUsageMessageRow>`
              SELECT
                m.message_id AS messageId,
                m.text AS text,
                NULL AS skillsJson,
                NULL AS mentionsJson
              FROM projection_thread_messages m
              JOIN projection_threads t ON t.thread_id = m.thread_id
              WHERE m.role = 'user'
                AND (
                  m.text GLOB '*$[A-Za-z0-9]*'
                  OR m.text GLOB '*/[A-Za-z0-9]*'
                )
              ORDER BY m.created_at ASC, m.message_id ASC
            `,
          ),
        ),
      ),
    );

  const queryArchivedSkillUsage = () =>
    legacyCompatibleQuery(
      "profileStats.archivedSkillUsage",
      sql<ArchivedSkillUsageRow>`
        SELECT name, kind, run_count AS runCount
        FROM profile_stats_deleted_skills
      `,
    );

  const queryMostWorkedProject = (tz: string) =>
    legacyCompatibleQuery(
      "profileStats.mostWorkedProject",
      sql<MostWorkedProjectRow>`
        WITH project_prompts AS (
          SELECT
            t.project_id AS project_id,
            m.thread_id AS thread_id,
            m.created_at AS created_at
          FROM projection_thread_messages m
          JOIN projection_threads t ON t.thread_id = m.thread_id
          WHERE m.role = 'user'
            AND m.source = 'native'
            AND (m.dispatch_origin IS NULL OR m.dispatch_origin = 'user')
          UNION ALL
          SELECT
            d.project_id AS project_id,
            d.thread_id AS thread_id,
            d.created_at AS created_at
          FROM profile_stats_deleted_prompts d
        )
        SELECT
          p.project_id AS projectId,
          p.title AS title,
          p.workspace_root AS workspaceRoot,
          COUNT(*) AS promptCount,
          COUNT(DISTINCT e.thread_id) AS threadCount,
          COUNT(DISTINCT STRFTIME('%Y-%m-%d', DATETIME(e.created_at, ${tz}))) AS activeDays,
          MAX(e.created_at) AS lastWorkedAt
        FROM project_prompts e
        JOIN projection_projects p ON p.project_id = e.project_id
        GROUP BY p.project_id, p.title, p.workspace_root
        ORDER BY
          promptCount DESC,
          activeDays DESC,
          lastWorkedAt DESC,
          p.title ASC
        LIMIT 1
      `,
    );

  // ── Result builders ─────────────────────────────────────────────────

  const getProfileStats = (
    input: StatsGetProfileStatsInput,
  ): Effect.Effect<ProfileStats, unknown> =>
    Effect.gen(function* () {
      const tz = sqliteModifierFromUtcOffsetMinutes(input.utcOffsetMinutes);
      const todayKey = localToday(input.utcOffsetMinutes);

      const promptActivityRows = yield* queryPromptActivity(tz);
      const totalThreadRows = yield* queryTotalThreads();
      const turnInsightRows = yield* queryTurnInsights();
      const skillMessageRows = yield* querySkillUsageMessages();
      const archivedSkillRows = yield* queryArchivedSkillUsage();
      const mostWorkedProjectRows = yield* queryMostWorkedProject(tz);

      // ── Activity / heatmap / streaks ──
      const countByDay = new Map<string, number>();
      const hourCounts = Array.from({ length: 24 }, () => 0);
      let totalPromptsSent = 0;
      for (const row of promptActivityRows) {
        const day = nonEmptyString(row.day);
        const count = num(row.count);
        if (day) {
          countByDay.set(day, (countByDay.get(day) ?? 0) + count);
        }
        const hour = ((Math.trunc(num(row.hour)) % 24) + 24) % 24;
        hourCounts[hour] = (hourCounts[hour] ?? 0) + count;
        totalPromptsSent += count;
      }
      const heatmap = buildHeatmap(countByDay, todayKey);
      const activeDaysAsc = [...countByDay.entries()]
        .filter(([, count]) => count > 0)
        .map(([day]) => day)
        .toSorted();
      const { current: currentStreakDays, longest: longestStreakDays } = computeStreaks(
        activeDaysAsc,
        todayKey,
      );

      // ── Peak hour (single highest local-hour bucket) ──
      const totalHourTurns = hourCounts.reduce((sum, value) => sum + value, 0);
      let bestHour: number | null = null;
      let bestHourCount = 0;
      if (totalHourTurns > 0) {
        for (let hour = 0; hour < 24; hour += 1) {
          const hourCount = hourCounts[hour] ?? 0;
          if (hourCount > bestHourCount) {
            bestHourCount = hourCount;
            bestHour = hour;
          }
        }
      }
      const activeHours =
        bestHour === null
          ? { startHour: null, endHour: null, turnCount: 0, label: null }
          : {
              startHour: bestHour,
              endHour: null,
              turnCount: bestHourCount,
              label: `${formatHour(bestHour)} · ${arcName(bestHour)}`,
            };

      // ── Provider / model mix ──
      const providerModelCounts = new Map<
        string,
        { readonly provider: string | null; readonly model: string | null; count: number }
      >();
      const reasoningCounts = new Map<string, { readonly reasoning: string; count: number }>();

      for (const row of turnInsightRows) {
        const count = num(row.count);
        const provider = nonEmptyString(row.provider);
        const model = nonEmptyString(row.model);
        const providerModelKey = `${provider ?? ""}\u0000${model ?? ""}`;
        const existingProviderModel = providerModelCounts.get(providerModelKey);
        if (existingProviderModel) {
          existingProviderModel.count += count;
        } else {
          providerModelCounts.set(providerModelKey, { provider, model, count });
        }

        const reasoning = nonEmptyString(row.reasoning);
        if (reasoning) {
          const existingReasoning = reasoningCounts.get(reasoning);
          if (existingReasoning) {
            existingReasoning.count += count;
          } else {
            reasoningCounts.set(reasoning, { reasoning, count });
          }
        }
      }

      const providerModelRows = [...providerModelCounts.values()].toSorted(
        (left, right) =>
          right.count - left.count ||
          compareNullableText(left.provider, right.provider) ||
          compareNullableText(left.model, right.model),
      );
      const totalModelTurns = providerModelRows.reduce((sum, row) => sum + num(row.count), 0);
      const providerModels: ProviderModelUsage[] = providerModelRows.slice(0, 8).map((row) => {
        const count = num(row.count);
        return {
          provider: normalizeProviderKind(row.provider),
          model: nonEmptyString(row.model) ?? "unknown",
          turnCount: count,
          percent: percent1(count, totalModelTurns),
        };
      });

      const providerTurnCounts = new Map<ProviderKind, number>();
      // Turn-based ranking: the token-based one lives on ProfileTokenStats so the
      // heavy token query runs once, and clients prefer it when available.
      for (const row of providerModelRows) {
        const provider = normalizeProviderKind(row.provider);
        if (provider === "unknown") {
          continue;
        }
        providerTurnCounts.set(provider, (providerTurnCounts.get(provider) ?? 0) + num(row.count));
      }
      const totalKnownProviderTurns = [...providerTurnCounts.values()].reduce(
        (sum, count) => sum + count,
        0,
      );
      let topProvider: ProviderKind | null = null;
      let topProviderTurns = 0;
      for (const [provider, count] of providerTurnCounts) {
        if (count > topProviderTurns) {
          topProvider = provider;
          topProviderTurns = count;
        }
      }

      // ── Insights (top provider, top reasoning) ──
      const topProviderPercent =
        topProvider && totalKnownProviderTurns > 0
          ? percent1(topProviderTurns, totalKnownProviderTurns)
          : null;

      const reasoningRows = [...reasoningCounts.values()].toSorted(
        (left, right) =>
          right.count - left.count || compareNullableText(left.reasoning, right.reasoning),
      );
      const totalReasonedSelections = reasoningRows.reduce((sum, row) => sum + num(row.count), 0);
      const topReasoningRow = reasoningRows[0];
      const topReasoning = topReasoningRow?.reasoning ?? null;
      // Denominator excludes null reasoning values; those turns had no reasoning option set.
      const topReasoningPercent =
        topReasoningRow && totalReasonedSelections > 0
          ? percent1(num(topReasoningRow.count), totalReasonedSelections)
          : null;

      // ── Skills and agent mentions ──
      const allSkillUsages = aggregateProfileSkillUsageRows(skillMessageRows, archivedSkillRows);
      const skills = allSkillUsages.slice(0, SKILL_RESULT_LIMIT);
      const totalSkillsUsed = allSkillUsages.reduce((sum, row) => sum + row.runCount, 0);

      // ── Identity ──
      const homeDirBasename = nodePath.basename(config.homeDir) || "synara";

      return {
        generatedAt: new Date().toISOString(),
        timezone: { utcOffsetMinutes: input.utcOffsetMinutes, today: todayKey },
        identity: {
          homeDirBasename,
          initials: deriveInitials(homeDirBasename),
          defaultHandle: sanitizeHandle(homeDirBasename),
        },
        activity: {
          currentStreakDays,
          longestStreakDays,
          totalPromptsSent,
          totalThreads: num(totalThreadRows[0]?.count),
          promptsToday: countByDay.get(todayKey) ?? 0,
          heatmapMetric: "prompts",
          heatmap,
        },
        activeHours,
        insights: {
          topProvider,
          topProviderPercent,
          topReasoning,
          topReasoningPercent,
          skillsExplored: allSkillUsages.length,
          totalSkillsUsed,
        },
        providerModels,
        skills,
        mostUsedSkill: skills[0] ?? null,
        mostWorkedProject: buildMostWorkedProject(mostWorkedProjectRows[0]),
        quota: emptyQuota(),
      } satisfies ProfileStats;
    });

  const getProfileTokenStats = (
    input: StatsGetProfileTokenStatsInput,
  ): Effect.Effect<ProfileTokenStats, unknown> =>
    Effect.gen(function* () {
      const tz = sqliteModifierFromUtcOffsetMinutes(input.utcOffsetMinutes);
      const todayKey = localToday(input.utcOffsetMinutes);
      const rows = yield* queryTokenActivity(tz);
      const turnInsightRows = yield* queryTurnInsights();
      const { tokensByDay, tokensByProvider, tokensByProviderModel, lifetime } =
        aggregateTokenActivity(rows);

      let peakDay: string | null = null;
      let peakDayTokens: number | null = null;
      for (const [day, tokens] of tokensByDay) {
        if (peakDayTokens === null || tokens > peakDayTokens) {
          peakDayTokens = tokens;
          peakDay = day;
        }
      }

      const providers = [...tokensByProvider.entries()]
        .filter(([, tokens]) => tokens > 0)
        .toSorted((a, b) => b[1] - a[1])
        .map(([provider]) => provider);
      const available = lifetime > 0;

      // Providers the user actually ran turns with but whose adapters never emit
      // token telemetry — they cannot participate in token-based rankings, and the
      // UI uses this list to say so instead of silently under-reporting them.
      const providersWithTurns = new Set<ProviderKind>();
      for (const row of turnInsightRows) {
        const provider = normalizeProviderKind(row.provider);
        if (provider !== "unknown") {
          providersWithTurns.add(provider);
        }
      }
      const unavailableProviders = [...providersWithTurns]
        .filter((provider) => !tokensByProvider.has(provider))
        .toSorted();

      // "Most used provider" by tokens processed: one heavy turn is more work than
      // many tiny ones. Percent is the share among providers with token telemetry.
      const totalProviderTokens = [...tokensByProvider.values()].reduce(
        (sum, tokens) => sum + tokens,
        0,
      );
      const topProvider = providers[0] ?? null;
      const topProviderPercent =
        topProvider && totalProviderTokens > 0
          ? percent1(tokensByProvider.get(topProvider) ?? 0, totalProviderTokens)
          : null;

      // Token-based model mix, same shape/cap as the turn-based providerModels.
      // Percent is the share of ALL counted tokens (lifetime), unknowns included,
      // so the list always sums to ~100%.
      const models = [...tokensByProviderModel.values()]
        .filter((row) => row.tokens > 0)
        .toSorted(
          (left, right) =>
            right.tokens - left.tokens ||
            compareNullableText(left.provider, right.provider) ||
            compareNullableText(left.model, right.model),
        )
        .slice(0, 8)
        .map((row) => ({
          provider: row.provider,
          model: row.model,
          tokens: row.tokens,
          percent: percent1(row.tokens, lifetime),
        }));

      return {
        available,
        lifetimeTotalTokens: available ? lifetime : null,
        peakDayTokens,
        peakDay,
        providers,
        unavailableProviders,
        topProvider,
        topProviderPercent,
        models,
        heatmapMetric: "tokens",
        heatmap: buildHeatmap(tokensByDay, todayKey),
      } satisfies ProfileTokenStats;
    });

  return { getProfileStats, getProfileTokenStats } satisfies ProfileStatsQueryShape;
});

export const ProfileStatsQueryLive = Layer.effect(ProfileStatsQuery, makeProfileStatsQuery);
