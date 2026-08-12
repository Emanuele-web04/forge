/**
 * accountUsageReporter - event-driven sync of per-minute usage buckets to the
 * account service (`POST /api/v1/usage`).
 *
 * The reporter never counts incrementally: every flush recomputes the buckets
 * for a recent window straight from the local projections and pushes ABSOLUTE
 * values, which the service upserts. Correctness therefore never depends on
 * exactly-once delivery — a retry, an overlap between two flushes, or the same
 * minute growing across pushes all land on the same rows.
 *
 * Fully inert when signed out, and silent best-effort when signed in: a failed
 * push records a backoff timestamp and waits for the next activity; it can
 * never break the server.
 *
 * Bucket derivation deliberately mirrors profileStats.ts (the canonical
 * sibling for token-delta and attribution SQL) and profileStatsArchive.ts,
 * adapted from local-day buckets to fixed UTC minutes.
 *
 * @module accountUsageReporter
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  EnvironmentId,
  USAGE_DIMENSION_MAX_LENGTH,
  USAGE_PUSH_MAX_BUCKETS,
  type PushUsageRequest,
  type UsageModelBucket,
  type UsageSkillBucket,
} from "@synara/contracts";
import { createAccountClient, resolveAccountUrl, type AccountClient } from "@synara/shared/account";

import {
  readAccountCredentials,
  readAccountFile,
  resolveEnvironmentId,
  withFreshAccessToken,
} from "./accountAuth";
import { aggregateProfileSkillUsageRows, turnModelSelectionCte } from "./profileStats";

/** Activity is coalesced for this long before a flush recomputes and pushes. */
const DEFAULT_DEBOUNCE_MS = 5_000;
/** After a failed push, nothing retries until activity arrives past this. */
const DEFAULT_FAILURE_BACKOFF_MS = 60_000;
/**
 * First sync (no watermark) backfills ALL local history: signing in on a
 * machine with months of existing traces must bring the stats those traces
 * already earned. The bound exists only as an injectable test seam; the
 * default reaches back before any real installation.
 */
const DEFAULT_BACKFILL_DAYS = 20 * 365;

/**
 * Pause between pushes when a flush needs many of them (a first-sync
 * backfill). The service budgets ~30 usage pushes a minute per client;
 * pacing keeps a large history under it instead of burning retries on 429s.
 */
const MULTI_PUSH_PACE_MS = 2_100;
/**
 * Recompute overlap behind the watermark. Buckets are absolute and upserted,
 * so re-deriving already-pushed minutes is free — the lap absorbs projection
 * writes that landed after the minute they belong to was already pushed.
 */
const WATERMARK_SAFETY_LAP_MS = 2 * 60_000;

// Domain events whose effects can change a usage bucket: turn starts (turns +
// prompt/turn attribution), user messages (prompts, skills), and activity
// records (token counters). notifyActivity is cheap and debounced, so this
// filter only exists to skip the obviously irrelevant bulk (deltas, meta).
const USAGE_RELEVANT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread.turn-start-requested",
  "thread.message-sent",
  "thread.activity-appended",
]);

export function isAccountUsageRelevantEventType(eventType: string): boolean {
  return USAGE_RELEVANT_EVENT_TYPES.has(eventType);
}

export interface AccountUsageReporter {
  /**
   * Signals that local usage may have changed. Debounced; never throws;
   * a no-op while signed out or inside the failure backoff window.
   */
  notifyActivity(): void;
  /**
   * Runs a flush immediately (bypassing debounce and failure backoff).
   * Resolves once the flush settles; never rejects — failures are recorded
   * exactly as a scheduled flush records them.
   */
  flushNow(): Promise<void>;
  /** Cancels any pending flush timer and stops scheduling new ones. */
  stop(): void;
}

export interface AccountUsageReporterDeps {
  readonly sql: SqlClient.SqlClient;
  readonly baseDir: string;
  readonly devUrl?: URL | undefined;
  /** Configured account URL; the stored credential file's URL wins over it. */
  readonly accountUrl?: string | undefined;
  /** Injectable account client (tests); production builds one per flush. */
  readonly client?: AccountClient;
  /** Full auth+push seam for tests; default is withFreshAccessToken + pushUsage. */
  readonly push?: (request: PushUsageRequest) => Promise<void>;
  /** Signed-in probe; default reads the credential file. */
  readonly isSignedIn?: () => Promise<boolean>;
  /** Environment id seam; default resolves/persists `<stateDir>/environment-id`. */
  readonly environmentId?: () => Promise<string>;
  /**
   * Signed-in identity seam (`${accountUrl}#${organizationId}`); default
   * derives it from the credential file. Null when it cannot be determined.
   */
  readonly accountIdentity?: () => Promise<string | null>;
  readonly debounceMs?: number;
  readonly failureBackoffMs?: number;
  readonly backfillDays?: number;
  readonly now?: () => number;
  /** One line per failure streak; default console.warn, injectable for tests. */
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

// ── Minute helpers ─────────────────────────────────────────────────────

/** Floors a Unix-ms timestamp to its UTC minute as `YYYY-MM-DDTHH:MM:00Z`. */
export function minuteStartIso(ms: number): string {
  return `${new Date(ms - (ms % 60_000)).toISOString().slice(0, 17)}00Z`;
}

// ── Row shapes ─────────────────────────────────────────────────────────

interface MinuteModelRow {
  readonly minute: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly count: number | bigint;
}

interface MinuteSkillMessageRow {
  readonly minute: string | null;
  readonly messageId: string | null;
  readonly text: string | null;
  readonly skillsJson: string | null;
  readonly mentionsJson: string | null;
}

interface SyncStateRow {
  readonly watermarkMinute: string | null;
  readonly lastFailureAt: string | null;
  readonly accountIdentity: string | null;
}

interface MinuteSkillRow {
  readonly minute: string | null;
  readonly name: string | null;
  readonly kind: string | null;
  readonly count: number | bigint;
}

// ── Pure helpers ───────────────────────────────────────────────────────

function toCount(value: number | bigint): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

/** Clamps an attribution dimension into the contract's bounded string. */
function dimension(value: string | null, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return (trimmed.length > 0 ? trimmed : fallback).slice(0, USAGE_DIMENSION_MAX_LENGTH);
}

function reasoningDimension(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed.slice(0, USAGE_DIMENSION_MAX_LENGTH) : null;
}

function modelBucketKey(
  minute: string,
  provider: string,
  model: string,
  reasoning: string | null,
): string {
  return [minute, provider, model, reasoning ?? "\u0000"].join("\u0000");
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Chunks buckets by complete minutes to preserve the minute-replacement
 * contract: each chunk must contain ALL buckets for any minute it mentions,
 * never splitting a minute's buckets across chunks. Starts a new chunk when
 * adding the next complete minute would exceed `maxBuckets`.
 */
function chunkByMinute<T extends { readonly minute: string }>(
  buckets: readonly T[],
  maxBuckets: number,
): T[][] {
  const chunks: T[][] = [];
  let currentChunk: T[] = [];
  let currentMinute: string | undefined;
  const minuteGroup: T[] = [];

  for (const bucket of buckets) {
    if (currentMinute !== bucket.minute) {
      // Flush the completed minute group to the current chunk if it fits
      if (minuteGroup.length > 0) {
        if (currentChunk.length + minuteGroup.length > maxBuckets && currentChunk.length > 0) {
          // Current chunk would overflow; finalize it and start fresh
          chunks.push(currentChunk);
          currentChunk = [...minuteGroup];
        } else {
          currentChunk.push(...minuteGroup);
        }
        minuteGroup.length = 0;
      }
      currentMinute = bucket.minute;
    }
    minuteGroup.push(bucket);
  }

  // Flush the final minute group
  if (minuteGroup.length > 0) {
    if (currentChunk.length + minuteGroup.length > maxBuckets && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [...minuteGroup];
    } else {
      currentChunk.push(...minuteGroup);
    }
  }

  // Finalize the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ── Bucket derivation ──────────────────────────────────────────────────

/**
 * Recomputes every model bucket and skill bucket for UTC minutes >=
 * `fromMinute`. Exported for direct test coverage of the derivation SQL.
 *
 * Token deltas are computed over each thread's FULL activity history and only
 * filtered to the window afterwards: a cumulative counter's first row inside
 * the window would otherwise count the whole pre-window total as one delta.
 */
export function collectUsageBuckets(
  sql: SqlClient.SqlClient,
  fromMinute: string,
): Effect.Effect<
  { readonly models: UsageModelBucket[]; readonly skills: UsageSkillBucket[] },
  unknown
> {
  return Effect.gen(function* () {
    // Tokens per minute — the per-minute variant of profileStats.ts's
    // queryTokenActivity (the canonical sibling); same counter-scale choice
    // per (thread, provider, model), same LAG delta, same attribution
    // (turn-start modelSelection via the shared CTE, thread selection as the
    // legacy fallback), plus the reasoning dimension the account buckets key on.
    const tokenRows = yield* sql<MinuteModelRow>`
      WITH turn_model AS (
        ${turnModelSelectionCte(sql)}
      ),
      ev AS (
        SELECT
          a.thread_id AS thread_id,
          STRFTIME('%Y-%m-%dT%H:%M:00Z', a.created_at) AS minute,
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
          COALESCE(
            tm.reasoning,
            CASE
              WHEN tm.model IS NULL
                AND th.model_selection_json IS NOT NULL
                AND json_valid(th.model_selection_json)
              THEN COALESCE(
                json_extract(th.model_selection_json, '$.options.reasoningEffort'),
                json_extract(th.model_selection_json, '$.options.effort')
              )
            END
          ) AS reasoning,
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
      cumulative_delta AS (
        SELECT
          minute,
          provider,
          model,
          reasoning,
          dispatch_origin,
          CASE
            WHEN previous_tot IS NULL OR tot < previous_tot THEN tot
            ELSE MAX(0, tot - previous_tot)
          END AS d
        FROM (
          SELECT
            minute,
            provider,
            model,
            reasoning,
            dispatch_origin,
            tp AS tot,
            LAG(tp) OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                sequence ASC,
                created_at ASC,
                activity_id ASC
            ) AS previous_tot
          FROM ev
          WHERE tp IS NOT NULL
        )
      ),
      used_only_delta AS (
        SELECT
          minute,
          provider,
          model,
          reasoning,
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
            ev.minute AS minute,
            ev.provider AS provider,
            ev.model AS model,
            ev.reasoning AS reasoning,
            ev.dispatch_origin AS dispatch_origin,
            ev.ut AS tot,
            LAG(ev.ut) OVER (
              PARTITION BY ev.thread_id
              ORDER BY
                CASE WHEN ev.sequence IS NULL THEN 0 ELSE 1 END ASC,
                ev.sequence ASC,
                ev.created_at ASC,
                ev.activity_id ASC
            ) AS previous_tot,
            LAG(ev.provider) OVER (
              PARTITION BY ev.thread_id
              ORDER BY
                CASE WHEN ev.sequence IS NULL THEN 0 ELSE 1 END ASC,
                ev.sequence ASC,
                ev.created_at ASC,
                ev.activity_id ASC
            ) AS previous_provider,
            LAG(ev.model) OVER (
              PARTITION BY ev.thread_id
              ORDER BY
                CASE WHEN ev.sequence IS NULL THEN 0 ELSE 1 END ASC,
                ev.sequence ASC,
                ev.created_at ASC,
                ev.activity_id ASC
            ) AS previous_model
          FROM ev
          JOIN provider_model_scale pms
            ON pms.thread_id = ev.thread_id
           AND pms.provider = ev.provider
           AND pms.model = ev.model
          WHERE ev.tp IS NULL
            AND ev.ut IS NOT NULL
            AND NOT pms.has_cumulative
        )
      ),
      all_tokens AS (
        SELECT minute, provider, model, reasoning, d FROM cumulative_delta
        WHERE dispatch_origin IS NULL OR dispatch_origin = 'user'
        UNION ALL
        SELECT minute, provider, model, reasoning, d FROM used_only_delta
        WHERE dispatch_origin IS NULL OR dispatch_origin = 'user'
      )
      SELECT minute, provider, model, reasoning, SUM(d) AS count
      FROM all_tokens
      WHERE minute >= ${fromMinute}
      GROUP BY minute, provider, model, reasoning
      HAVING SUM(d) > 0
    `;

    // Turns per minute — per-minute variant of profileStats.ts's
    // queryTurnInsights: turn-start events bucketed by their own timestamp,
    // attributed to the event's modelSelection with the thread's current
    // selection as the legacy fallback, agent-dispatched prompts excluded.
    const turnRows = yield* sql<MinuteModelRow>`
      WITH per_turn AS (
        SELECT
          STRFTIME('%Y-%m-%dT%H:%M:00Z', e.occurred_at) AS minute,
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
      )
      SELECT minute, provider, model, reasoning, COUNT(*) AS count
      FROM per_turn
      WHERE minute >= ${fromMinute}
      GROUP BY minute, provider, model, reasoning
    `;

    // Prompts per minute — the same native-user-prompt filter as
    // profileStats.ts's queryPromptActivity, attributed to the turn the prompt
    // started (turn-start events carry the pending messageId) so the prompt
    // count lands on the same bucket key as the turn it produced.
    const promptRows = yield* sql<MinuteModelRow>`
      WITH per_prompt AS (
        SELECT
          STRFTIME('%Y-%m-%dT%H:%M:00Z', m.created_at) AS minute,
          COALESCE(
            MAX(CASE
              WHEN json_type(e.payload_json, '$.modelSelection') = 'object'
              THEN json_extract(e.payload_json, '$.modelSelection.provider')
            END),
            CASE
              WHEN t.model_selection_json IS NOT NULL AND json_valid(t.model_selection_json)
              THEN json_extract(t.model_selection_json, '$.provider')
            END
          ) AS provider,
          COALESCE(
            MAX(CASE
              WHEN json_type(e.payload_json, '$.modelSelection') = 'object'
              THEN json_extract(e.payload_json, '$.modelSelection.model')
            END),
            CASE
              WHEN t.model_selection_json IS NOT NULL AND json_valid(t.model_selection_json)
              THEN json_extract(t.model_selection_json, '$.model')
            END
          ) AS model,
          COALESCE(
            MAX(CASE
              WHEN json_type(e.payload_json, '$.modelSelection') = 'object'
              THEN COALESCE(
                json_extract(e.payload_json, '$.modelSelection.options.reasoningEffort'),
                json_extract(e.payload_json, '$.modelSelection.options.effort')
              )
            END),
            CASE
              WHEN t.model_selection_json IS NOT NULL AND json_valid(t.model_selection_json)
              THEN COALESCE(
                json_extract(t.model_selection_json, '$.options.reasoningEffort'),
                json_extract(t.model_selection_json, '$.options.effort')
              )
            END
          ) AS reasoning
        FROM projection_thread_messages m
        JOIN projection_threads t ON t.thread_id = m.thread_id
        LEFT JOIN orchestration_events e
          ON e.event_type = 'thread.turn-start-requested'
         AND COALESCE(json_extract(e.payload_json, '$.threadId'), e.stream_id) = m.thread_id
         AND json_extract(e.payload_json, '$.messageId') = m.message_id
        WHERE m.role = 'user'
          AND m.source = 'native'
          AND (m.dispatch_origin IS NULL OR m.dispatch_origin = 'user')
          AND STRFTIME('%Y-%m-%dT%H:%M:00Z', m.created_at) >= ${fromMinute}
        GROUP BY m.thread_id, m.message_id
      )
      SELECT minute, provider, model, reasoning, COUNT(*) AS count
      FROM per_prompt
      GROUP BY minute, provider, model, reasoning
    `;

    // Skills per minute — the same message rows profileStats.ts's
    // querySkillUsageMessages feeds into aggregateProfileSkillUsageRows,
    // filtered to the window (safe: skill counts have no cross-row deltas) and
    // aggregated per minute with the exact same shared function.
    const skillMessageRows = yield* sql<MinuteSkillMessageRow>`
      SELECT
        STRFTIME('%Y-%m-%dT%H:%M:00Z', m.created_at) AS minute,
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
        AND STRFTIME('%Y-%m-%dT%H:%M:00Z', m.created_at) >= ${fromMinute}
        AND (
          (m.skills_json IS NOT NULL AND TRIM(m.skills_json) NOT IN ('', '[]'))
          OR (m.mentions_json IS NOT NULL AND TRIM(m.mentions_json) NOT IN ('', '[]'))
          OR m.text GLOB '*$[A-Za-z0-9]*'
          OR m.text GLOB '*/[A-Za-z0-9]*'
        )
      ORDER BY m.created_at ASC, m.message_id ASC
    `;

    // ── Archived (purged-thread) aggregates ────────────────────────────
    //
    // Threads deleted BEFORE their history was ever synced live only in the
    // profile_stats_deleted_* tables (profileStatsArchive.ts) and are
    // invisible to every projection query above. The local dashboard folds
    // them in (profileStats.ts merges each query with its deleted_* sibling);
    // the account totals must match it, so the same aggregates fold into the
    // pushed buckets here.

    // Archived token deltas carry the original activity timestamp, so they
    // bucket by minute exactly like the live path. The archive has no
    // reasoning dimension — those buckets key on null reasoning, matching the
    // local dashboard's model split, which does not key tokens on reasoning.
    const archivedTokenRows = yield* sql<MinuteModelRow>`
      SELECT
        STRFTIME('%Y-%m-%dT%H:%M:00Z', a.created_at) AS minute,
        a.provider AS provider,
        a.model AS model,
        NULL AS reasoning,
        SUM(a.tokens) AS count
      FROM profile_stats_deleted_tokens a
      WHERE STRFTIME('%Y-%m-%dT%H:%M:00Z', a.created_at) >= ${fromMinute}
      GROUP BY minute, a.provider, a.model
    `;

    // Archived prompts carry only their timestamp (no model attribution, as
    // in the local prompt-activity query); they land on the 'unknown' bucket.
    const archivedPromptRows = yield* sql<MinuteModelRow>`
      SELECT
        STRFTIME('%Y-%m-%dT%H:%M:00Z', d.created_at) AS minute,
        NULL AS provider,
        NULL AS model,
        NULL AS reasoning,
        COUNT(*) AS count
      FROM profile_stats_deleted_prompts d
      WHERE STRFTIME('%Y-%m-%dT%H:%M:00Z', d.created_at) >= ${fromMinute}
      GROUP BY minute
    `;

    // Archived turns and skills carry NO timestamp — they are pre-aggregated
    // per thread. Attribute each thread's counts to one synthetic minute: the
    // thread's most recent archived token timestamp, falling back to its most
    // recent archived prompt. A thread with neither has no timestamp evidence
    // at all, so its (timestampless) turn/skill counts are skipped — there is
    // no minute they could truthfully land on.
    const archivedTurnRows = yield* sql<MinuteModelRow>`
      WITH thread_minute AS (
        SELECT
          d.thread_id AS thread_id,
          STRFTIME('%Y-%m-%dT%H:%M:00Z', COALESCE(
            (
              SELECT MAX(t.created_at)
              FROM profile_stats_deleted_tokens t
              WHERE t.thread_id = d.thread_id
            ),
            (
              SELECT MAX(p.created_at)
              FROM profile_stats_deleted_prompts p
              WHERE p.thread_id = d.thread_id
            )
          )) AS minute
        FROM (SELECT DISTINCT thread_id FROM profile_stats_deleted_turns) d
      )
      SELECT
        tm.minute AS minute,
        dt.provider AS provider,
        dt.model AS model,
        dt.reasoning AS reasoning,
        SUM(dt.turn_count) AS count
      FROM profile_stats_deleted_turns dt
      JOIN thread_minute tm ON tm.thread_id = dt.thread_id
      WHERE tm.minute IS NOT NULL
        AND tm.minute >= ${fromMinute}
      GROUP BY tm.minute, dt.provider, dt.model, dt.reasoning
    `;

    const archivedSkillRows = yield* sql<MinuteSkillRow>`
      WITH thread_minute AS (
        SELECT
          d.thread_id AS thread_id,
          STRFTIME('%Y-%m-%dT%H:%M:00Z', COALESCE(
            (
              SELECT MAX(t.created_at)
              FROM profile_stats_deleted_tokens t
              WHERE t.thread_id = d.thread_id
            ),
            (
              SELECT MAX(p.created_at)
              FROM profile_stats_deleted_prompts p
              WHERE p.thread_id = d.thread_id
            )
          )) AS minute
        FROM (SELECT DISTINCT thread_id FROM profile_stats_deleted_skills) d
      )
      SELECT
        tm.minute AS minute,
        ds.name AS name,
        ds.kind AS kind,
        SUM(ds.run_count) AS count
      FROM profile_stats_deleted_skills ds
      JOIN thread_minute tm ON tm.thread_id = ds.thread_id
      WHERE tm.minute IS NOT NULL
        AND tm.minute >= ${fromMinute}
      GROUP BY tm.minute, ds.name, ds.kind
    `;

    // Merge tokens, turns, and prompts onto one bucket key.
    const modelBuckets = new Map<
      string,
      { minute: string; provider: string; model: string; reasoning: string | null } & {
        tokens: number;
        turns: number;
        prompts: number;
      }
    >();
    const add = (row: MinuteModelRow, field: "tokens" | "turns" | "prompts"): void => {
      const minute = row.minute;
      const count = toCount(row.count);
      if (!minute || count <= 0) return;
      const provider = dimension(row.provider, "unknown");
      const model = dimension(row.model, "unknown");
      const reasoning = reasoningDimension(row.reasoning);
      const key = modelBucketKey(minute, provider, model, reasoning);
      const bucket = modelBuckets.get(key) ?? {
        minute,
        provider,
        model,
        reasoning,
        tokens: 0,
        turns: 0,
        prompts: 0,
      };
      bucket[field] += count;
      modelBuckets.set(key, bucket);
    };
    for (const row of tokenRows) add(row, "tokens");
    for (const row of turnRows) add(row, "turns");
    for (const row of promptRows) add(row, "prompts");
    for (const row of archivedTokenRows) add(row, "tokens");
    for (const row of archivedTurnRows) add(row, "turns");
    for (const row of archivedPromptRows) add(row, "prompts");

    const models: UsageModelBucket[] = [...modelBuckets.values()]
      .toSorted((left, right) => left.minute.localeCompare(right.minute))
      .map((bucket) => ({
        minute: bucket.minute,
        provider: bucket.provider,
        model: bucket.model,
        reasoning: bucket.reasoning,
        tokens: bucket.tokens,
        turns: bucket.turns,
        prompts: bucket.prompts,
      }));

    // Group skill message rows per minute, then reuse the canonical aggregator.
    const skillRowsByMinute = new Map<string, MinuteSkillMessageRow[]>();
    for (const row of skillMessageRows) {
      if (!row.minute) continue;
      const rows = skillRowsByMinute.get(row.minute) ?? [];
      rows.push(row);
      skillRowsByMinute.set(row.minute, rows);
    }
    // Live and archived skill runs merge on the same (minute, name, kind)
    // key; a purged thread's aggregate lands on its synthetic minute.
    const skillBuckets = new Map<
      string,
      { minute: string; name: string; kind: "skill" | "agent"; runs: number }
    >();
    const addSkill = (
      minute: string,
      name: string,
      kind: "skill" | "agent",
      runs: number,
    ): void => {
      if (runs <= 0) return;
      const boundedName = name.slice(0, USAGE_DIMENSION_MAX_LENGTH);
      const key = [minute, boundedName, kind].join("\u0000");
      const bucket = skillBuckets.get(key) ?? { minute, name: boundedName, kind, runs: 0 };
      bucket.runs += runs;
      skillBuckets.set(key, bucket);
    };
    for (const [minute, rows] of skillRowsByMinute) {
      for (const usage of aggregateProfileSkillUsageRows(rows)) {
        addSkill(minute, usage.name, usage.kind, usage.runCount);
      }
    }
    for (const row of archivedSkillRows) {
      const name = row.name?.trim();
      if (!row.minute || !name || (row.kind !== "skill" && row.kind !== "agent")) continue;
      addSkill(row.minute, name, row.kind, toCount(row.count));
    }
    const skills: UsageSkillBucket[] = [...skillBuckets.values()].toSorted((left, right) =>
      left.minute.localeCompare(right.minute),
    );

    return { models, skills };
  });
}

// ── Reporter ───────────────────────────────────────────────────────────

export function createAccountUsageReporter(deps: AccountUsageReporterDeps): AccountUsageReporter {
  const { sql, baseDir } = deps;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const failureBackoffMs = deps.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
  const backfillMs = (deps.backfillDays ?? DEFAULT_BACKFILL_DAYS) * 86_400_000;
  const now = deps.now ?? Date.now;
  const log =
    deps.log ??
    ((message: string, data?: Record<string, unknown>) => {
      console.warn(message, data ?? {});
    });

  const isSignedIn =
    deps.isSignedIn ?? (async () => (await readAccountCredentials(baseDir)) !== undefined);

  const resolveEnvironment =
    deps.environmentId ?? (() => resolveEnvironmentId(baseDir, deps.devUrl));

  // The identity the watermark belongs to. The watermark claims "this account
  // has everything up to minute X" — a claim about one account and workspace,
  // so it is keyed by both: sign out of A, sign in to B, and B must NOT
  // inherit A's watermark (it would skip the full-history backfill it never
  // received). Same URL resolution as the default push above.
  const resolveAccountIdentity =
    deps.accountIdentity ??
    (async (): Promise<string | null> => {
      const stored = await readAccountFile(baseDir);
      if (!stored?.organizationId) return null;
      return `${stored.accountUrl}#${stored.organizationId}`;
    });

  const push =
    deps.push ??
    (async (request: PushUsageRequest) => {
      // Same URL resolution as accountSession.ts: the URL stored at sign-in
      // wins so the reporter always talks to the account the session belongs
      // to, with the configured/default URL as the signed-out fallback.
      const stored = await readAccountFile(baseDir);
      const accountUrl = stored?.accountUrl ?? deps.accountUrl ?? resolveAccountUrl();
      const client = deps.client ?? createAccountClient({ baseUrl: accountUrl });
      await withFreshAccessToken({ baseDir, client }, async (accessToken) => {
        await client.pushUsage(accessToken, request);
      });
    });

  const readSyncState = () =>
    Effect.runPromise(
      sql<SyncStateRow>`
        SELECT
          watermark_minute AS watermarkMinute,
          last_failure_at AS lastFailureAt,
          account_identity AS accountIdentity
        FROM account_usage_sync
        WHERE id = 1
      `.pipe(Effect.map((rows) => rows[0])),
    );

  const writeSuccess = (watermarkMinute: string, accountIdentity: string | null) =>
    Effect.runPromise(
      sql`
        INSERT INTO account_usage_sync (id, watermark_minute, last_failure_at, account_identity)
        VALUES (1, ${watermarkMinute}, NULL, ${accountIdentity})
        ON CONFLICT (id) DO UPDATE SET
          watermark_minute = ${watermarkMinute},
          last_failure_at = NULL,
          account_identity = ${accountIdentity}
      `,
    );

  const writeFailure = (lastFailureAt: string) =>
    Effect.runPromise(
      sql`
        INSERT INTO account_usage_sync (id, watermark_minute, last_failure_at)
        VALUES (1, NULL, ${lastFailureAt})
        ON CONFLICT (id) DO UPDATE SET last_failure_at = ${lastFailureAt}
      `,
    );

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let rerunAfterFlight = false;
  let failureStreak = 0;
  let cachedEnvironmentId: string | undefined;

  async function flush(options: { readonly bypassBackoff: boolean }): Promise<void> {
    try {
      if (!(await isSignedIn())) return;

      const state = await readSyncState();
      if (!options.bypassBackoff && state?.lastFailureAt) {
        const failedAtMs = Date.parse(state.lastFailureAt);
        if (Number.isFinite(failedAtMs) && now() - failedAtMs < failureBackoffMs) {
          // Inside the backoff window: nothing retries until activity arrives
          // again past it. The recompute-from-watermark design means no data
          // is lost by skipping — the next flush covers this window too.
          return;
        }
      }

      const flushStartedAtMs = now();
      // The watermark belongs to ONE identity. A stored watermark whose
      // identity differs from the current one — or predates the identity
      // column (NULL) — proves nothing about what THIS account has received,
      // so it is ignored and the flush takes the full-backfill path. Buckets
      // are absolute and upserted, so over-covering is merely redundant.
      const currentIdentity = await resolveAccountIdentity();
      const watermarkIsForCurrentIdentity =
        state?.accountIdentity != null && state.accountIdentity === currentIdentity;
      const watermarkMs =
        watermarkIsForCurrentIdentity && state?.watermarkMinute
          ? Date.parse(state.watermarkMinute)
          : Number.NaN;
      const fromMinute = Number.isFinite(watermarkMs)
        ? minuteStartIso(watermarkMs - WATERMARK_SAFETY_LAP_MS)
        : minuteStartIso(flushStartedAtMs - backfillMs);

      const { models, skills } = await Effect.runPromise(collectUsageBuckets(sql, fromMinute));

      if (models.length > 0 || skills.length > 0) {
        cachedEnvironmentId ??= await resolveEnvironment();
        const environmentId = EnvironmentId.makeUnsafe(cachedEnvironmentId);
        const modelChunks = chunkByMinute(models, USAGE_PUSH_MAX_BUCKETS);
        const skillChunks = chunkByMinute(skills, USAGE_PUSH_MAX_BUCKETS);
        const pushCount = Math.max(modelChunks.length, skillChunks.length);
        // The newest minute known fully pushed for one stream after its chunk
        // `index` lands: the minute just before the NEXT chunk's first bucket.
        // Both streams are minute-ascending (sorted in collectUsageBuckets),
        // but a single minute's buckets can straddle a chunk boundary, so the
        // boundary minute itself is not yet fully covered. A stream with no
        // next chunk is complete and constrains nothing.
        const chunkProgressMs = (
          chunks: readonly (readonly { readonly minute: string }[])[],
          index: number,
        ): number => {
          const nextMinute = chunks[index + 1]?.[0]?.minute;
          return nextMinute === undefined
            ? Number.POSITIVE_INFINITY
            : Date.parse(nextMinute) - 60_000;
        };
        for (let index = 0; index < pushCount; index += 1) {
          if (stopped) return;
          // Paced under the service's per-client push budget; a single-push
          // flush (the steady state) never waits.
          if (index > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, MULTI_PUSH_PACE_MS));
            if (stopped) return;
          }
          await push({
            environmentId,
            models: modelChunks[index] ?? [],
            skills: skillChunks[index] ?? [],
          });
          // Persist backfill progress after every chunk, not only at the end:
          // a 429 halfway through a large first sync must resume from the
          // failed chunk, not replay the whole history (which, under a
          // sustained rate limit, could keep it from ever reaching the later
          // chunks). Sound because both streams enumerate minutes ascending —
          // everything before the recorded minute is durably on the account.
          if (index < pushCount - 1) {
            const progressMs = Math.min(
              chunkProgressMs(modelChunks, index),
              chunkProgressMs(skillChunks, index),
            );
            if (Number.isFinite(progressMs)) {
              await writeSuccess(minuteStartIso(progressMs), currentIdentity);
            }
          }
        }
      }

      // Full success: everything through the newest fully elapsed minute (as
      // of flush start) is durably on the account. The still-growing current
      // minute is re-covered by the safety lap on the next flush.
      await writeSuccess(minuteStartIso(flushStartedAtMs - 60_000), currentIdentity);
      failureStreak = 0;
    } catch (error) {
      failureStreak += 1;
      if (failureStreak === 1) {
        log("account usage push failed; backing off until new activity", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await writeFailure(new Date(now()).toISOString());
      } catch {
        // Even recording the failure is best-effort; the in-memory streak
        // still throttles logging, and the next flush re-reads real state.
      }
    }
  }

  function runFlush(options: { readonly bypassBackoff: boolean }): Promise<void> {
    if (inFlight) {
      rerunAfterFlight = true;
      return inFlight;
    }
    inFlight = flush(options).finally(() => {
      inFlight = undefined;
      if (rerunAfterFlight && !stopped) {
        rerunAfterFlight = false;
        schedule();
      }
    });
    return inFlight;
  }

  function schedule(): void {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runFlush({ bypassBackoff: false });
    }, debounceMs);
    timer.unref?.();
  }

  const reporter: AccountUsageReporter = {
    notifyActivity() {
      if (stopped) return;
      try {
        schedule();
      } catch {
        // notifyActivity must never throw into event-dispatch paths.
      }
    },
    async flushNow() {
      if (stopped) return;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await runFlush({ bypassBackoff: true });
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };

  // Startup catch-up: activity that happened while the server was down (or
  // that a crash left unsynced) is behind the watermark's safety lap, so one
  // ordinary debounced flush covers it. Only when signed in — signed out, the
  // reporter is fully inert until something calls notifyActivity after sign-in.
  void isSignedIn()
    .then((signedIn) => {
      if (signedIn) reporter.notifyActivity();
    })
    .catch(() => {});

  return reporter;
}
