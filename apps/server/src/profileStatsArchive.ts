// FILE: profileStatsArchive.ts
// Purpose: Snapshot a thread's profile-stat aggregates into the durable
// profile_stats_deleted_* tables, then hard-delete every row the thread owns
// (projections, events, checkpoints, session runtime). This is what lets a
// delete actually free disk space without shrinking the Profile page numbers.
// Layer: server maintenance service (SqlClient).

import {
  CheckpointRef,
  MessageId,
  ThreadId,
  TurnId,
  type ThreadEnvironmentMode,
} from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { Cause, Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { redactCreationPlanForPurgedCaller } from "./agentGateway/operationPlan.ts";

import { CheckpointStore } from "./checkpointing/Services/CheckpointStore";
import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurnStart,
  isManagedCheckpointRefForThread,
  resolveProjectCwdForKind,
} from "./checkpointing/Utils";
import { aggregateProfileSkillUsageRows, turnModelSelectionCte } from "./profileStats";
import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "./persistence/Services/OrchestrationEventDeliveries";
import { isProviderIntentEventType } from "./orchestration/providerIntentClassification";
import { THREAD_RETENTION_COMMAND_ID_PREFIX } from "./threadRetention";

interface PurgeThreadRow {
  readonly projectId: string | null;
  readonly modelSelectionJson: string | null;
  readonly deletedAt: string | null;
  readonly envMode: string | null;
  readonly worktreePath: string | null;
  readonly workingDirectory: string | null;
  readonly projectKind: string | null;
  readonly workspaceRoot: string | null;
}

interface TurnEventRow {
  readonly payloadJson: string | null;
}

interface TokenActivityRow {
  // Cumulative counter (totalProcessedTokens) and context-window counter
  // (usedTokens); which one drives the delta series is decided per thread,
  // mirroring profileStats.queryTokenActivity.
  readonly totalProcessedTokens: number | bigint | null;
  readonly usedTokens: number | bigint | null;
  // Per-turn attribution resolved in SQL (turn-start modelSelection); NULL when
  // the activity has no attributable turn, in which case the thread's own
  // selection applies as the fallback.
  readonly provider: string | null;
  readonly model: string | null;
  readonly dispatchOrigin?: string | null;
  readonly createdAt: string | null;
}

interface SkillMessageRow {
  readonly messageId: string | null;
  readonly text: string | null;
  readonly skillsJson: string | null;
  readonly mentionsJson: string | null;
}

interface CheckpointTurnRow {
  readonly turnId: string | null;
  readonly checkpointRef: string | null;
}

interface CheckpointMessageRow {
  readonly messageId: string | null;
}

interface ThreadCheckpointCleanup {
  readonly cwd: string | null;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface ThreadTurnSnapshotRow {
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly turnCount: number;
}

export interface ThreadTokenSnapshotRow {
  readonly createdAt: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly tokens: number;
}

// ── Pure helpers ───────────────────────────────────────────────────────

interface ModelSelectionLike {
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoning: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseModelSelection(value: unknown): ModelSelectionLike | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as { provider?: unknown; model?: unknown; options?: unknown };
  const options =
    record.options !== null && typeof record.options === "object"
      ? (record.options as { reasoningEffort?: unknown; effort?: unknown })
      : null;
  return {
    provider: readString(record.provider),
    model: readString(record.model),
    reasoning: readString(options?.reasoningEffort) ?? readString(options?.effort),
  };
}

function parseModelSelectionJson(json: string | null): ModelSelectionLike | null {
  if (json === null || json.trim().length === 0) {
    return null;
  }
  try {
    return parseModelSelection(JSON.parse(json));
  } catch {
    return null;
  }
}

function normalizeThreadEnvironmentMode(value: string | null): ThreadEnvironmentMode | undefined {
  return value === "local" || value === "worktree" ? value : undefined;
}

function threadWorkspaceCwdForCheckpointCleanup(thread: PurgeThreadRow): string | null {
  const projectCwd = resolveProjectCwdForKind({
    kind: thread.projectKind,
    workspaceRoot: thread.workspaceRoot,
    worktreePath: thread.worktreePath,
  });
  return resolveThreadWorkspaceCwd({
    projectCwd,
    envMode: normalizeThreadEnvironmentMode(thread.envMode),
    worktreePath: thread.worktreePath,
    workingDirectory: thread.workingDirectory,
  });
}

function checkpointRefsForThreadPurge(
  threadId: string,
  turnRows: ReadonlyArray<CheckpointTurnRow>,
  messageRows: ReadonlyArray<CheckpointMessageRow>,
): ReadonlyArray<CheckpointRef> {
  const refs = new Set<string>();
  const typedThreadId = ThreadId.makeUnsafe(threadId);

  const addRef = (checkpointRef: CheckpointRef | string | null | undefined) => {
    const raw = readString(checkpointRef);
    if (raw && isManagedCheckpointRefForThread(raw, typedThreadId)) {
      refs.add(raw);
    }
  };

  for (const row of turnRows) {
    const checkpointRef = readString(row.checkpointRef);
    addRef(checkpointRef);

    const turnId = readString(row.turnId);
    if (turnId) {
      addRef(checkpointRefForThreadTurnStart(typedThreadId, TurnId.makeUnsafe(turnId)));
    }
  }
  for (const row of messageRows) {
    const messageId = readString(row.messageId);
    if (messageId) {
      addRef(checkpointRefForThreadMessageStart(typedThreadId, MessageId.makeUnsafe(messageId)));
    }
  }

  return [...refs].map((checkpointRef) => CheckpointRef.makeUnsafe(checkpointRef));
}

function hasProfileStatsContribution(input: {
  readonly promptRows: ReadonlyArray<SkillMessageRow>;
  readonly turnRows: ReadonlyArray<ThreadTurnSnapshotRow>;
  readonly tokenRows: ReadonlyArray<ThreadTokenSnapshotRow>;
  readonly skillRows: ReturnType<typeof aggregateProfileSkillUsageRows>;
}): boolean {
  return (
    input.promptRows.length > 0 ||
    input.turnRows.some((row) => row.turnCount > 0) ||
    input.tokenRows.length > 0 ||
    input.skillRows.some((row) => row.runCount > 0)
  );
}

// Mirrors the per-turn extraction in profileStats.queryTurnInsights: the turn
// event's own modelSelection wins, otherwise the thread's selection applies.
export function aggregateThreadTurnSnapshotRows(
  events: ReadonlyArray<TurnEventRow>,
  threadModelSelectionJson: string | null,
): ThreadTurnSnapshotRow[] {
  const threadSelection = parseModelSelectionJson(threadModelSelectionJson);
  const counts = new Map<
    string,
    { provider: string | null; model: string | null; reasoning: string | null; turnCount: number }
  >();

  for (const event of events) {
    let eventSelection: ModelSelectionLike | null = null;
    if (event.payloadJson !== null) {
      try {
        const payload: unknown = JSON.parse(event.payloadJson);
        if (payload !== null && typeof payload === "object") {
          eventSelection = parseModelSelection(
            (payload as { modelSelection?: unknown }).modelSelection,
          );
        }
      } catch {
        // Malformed payload rows still count as a turn with the thread fallback.
      }
    }
    const selection = eventSelection ?? threadSelection;
    const provider = selection?.provider ?? null;
    const model = selection?.model ?? null;
    const reasoning = selection?.reasoning ?? null;
    const key = `${provider ?? ""}\u0000${model ?? ""}\u0000${reasoning ?? ""}`;
    const existing = counts.get(key);
    if (existing) {
      existing.turnCount += 1;
    } else {
      counts.set(key, { provider, model, reasoning, turnCount: 1 });
    }
  }

  return [...counts.values()];
}

function tokenCounterValue(value: number | bigint | null): number | null {
  const total = typeof value === "bigint" ? Number(value) : value;
  return total !== null && Number.isFinite(total) ? total : null;
}

function tokenProviderModelKey(provider: string | null, model: string | null): string {
  return `${provider ?? ""}\u0000${model ?? ""}`;
}

function resolveTokenProviderModel(
  row: TokenActivityRow,
  fallbackSelection?: { readonly provider: string | null; readonly model: string | null },
): { readonly provider: string | null; readonly model: string | null } {
  const stampedProvider = readString(row.provider);
  const provider = stampedProvider ?? fallbackSelection?.provider ?? null;
  const model =
    readString(row.model) ??
    (stampedProvider === null || stampedProvider === fallbackSelection?.provider
      ? (fallbackSelection?.model ?? null)
      : null);
  return { provider, model };
}

function addTokenSnapshotRow(
  rows: Map<string, ThreadTokenSnapshotRow>,
  row: ThreadTokenSnapshotRow,
): void {
  const key = `${row.createdAt}\u0000${tokenProviderModelKey(row.provider, row.model)}`;
  const existing = rows.get(key);
  if (existing) {
    rows.set(key, { ...existing, tokens: existing.tokens + row.tokens });
  } else {
    rows.set(key, row);
  }
}

// Mirrors the LAG-based delta in profileStats.queryTokenActivity: rows must be
// ordered the same way that query orders them, and the first total counts fully.
// Cumulative rows stay thread-wide; usedTokens rows are counted only for
// provider/model groups that never emit cumulative totals.
// Deltas keep the original activity timestamp (raw, unparsed) so read-time
// DATETIME(created_at, tz) bucketing stays identical to the live query for any
// client UTC offset, and are keyed by the row's per-turn provider/model (the
// thread's own selection fills in rows without turn attribution).
export function aggregateThreadTokenRows(
  rows: ReadonlyArray<TokenActivityRow>,
  fallbackSelection?: { readonly provider: string | null; readonly model: string | null },
): ThreadTokenSnapshotRow[] {
  const tokensByKey = new Map<string, ThreadTokenSnapshotRow>();
  const cumulativeProviderModels = new Set<string>();
  for (const row of rows) {
    if (tokenCounterValue(row.totalProcessedTokens) === null) {
      continue;
    }
    const { provider, model } = resolveTokenProviderModel(row, fallbackSelection);
    cumulativeProviderModels.add(tokenProviderModelKey(provider, model));
  }

  let previousCumulativeTotal: number | null = null;
  for (const row of rows) {
    const total = tokenCounterValue(row.totalProcessedTokens);
    if (total === null) {
      continue;
    }
    const delta =
      previousCumulativeTotal === null || total < previousCumulativeTotal
        ? total
        : Math.max(0, total - previousCumulativeTotal);
    previousCumulativeTotal = total;
    if (
      delta <= 0 ||
      row.createdAt === null ||
      (row.dispatchOrigin != null && row.dispatchOrigin !== "user")
    ) {
      continue;
    }
    const { provider, model } = resolveTokenProviderModel(row, fallbackSelection);
    addTokenSnapshotRow(tokensByKey, {
      createdAt: row.createdAt,
      provider,
      model,
      tokens: delta,
    });
  }

  let previousUsedTotal: number | null = null;
  let previousUsedProviderModelKey: string | null = null;
  for (const row of rows) {
    const { provider, model } = resolveTokenProviderModel(row, fallbackSelection);
    const providerModelKey = tokenProviderModelKey(provider, model);
    if (cumulativeProviderModels.has(providerModelKey)) {
      continue;
    }
    const total = tokenCounterValue(row.usedTokens);
    if (total === null) {
      continue;
    }
    const delta =
      previousUsedTotal === null ||
      (total < previousUsedTotal && providerModelKey !== previousUsedProviderModelKey)
        ? total
        : Math.max(0, total - previousUsedTotal);
    previousUsedTotal = total;
    previousUsedProviderModelKey = providerModelKey;
    if (
      delta <= 0 ||
      row.createdAt === null ||
      (row.dispatchOrigin != null && row.dispatchOrigin !== "user")
    ) {
      continue;
    }
    addTokenSnapshotRow(tokensByKey, {
      createdAt: row.createdAt,
      provider,
      model,
      tokens: delta,
    });
  }
  return [...tokensByKey.values()];
}

// ── Service ────────────────────────────────────────────────────────────

export interface ProfileStatsArchiveShape {
  /** True while hard deletion would erase unresolved provider delivery evidence. */
  readonly hasThreadPurgeFence: (input: {
    readonly threadId: string;
  }) => Effect.Effect<boolean, unknown>;
  // Snapshots the thread's stat aggregates and hard-deletes all of its rows in
  // one transaction. Returns false when the thread row is already gone.
  readonly purgeThreadWithStatsSnapshot: (input: {
    readonly threadId: string;
  }) => Effect.Effect<boolean, unknown>;
  // Purges every soft-deleted thread that a recorded delete event proves was a
  // manual delete; retention hides and threads with unknown provenance are kept.
  // Catches per-thread failures so one bad thread cannot stall the sweep;
  // returns how many threads were purged.
  readonly purgeSoftDeletedManualThreads: (input?: {
    readonly beforePurge?: (threadId: string) => Effect.Effect<boolean, unknown>;
  }) => Effect.Effect<number, unknown>;
}

export class ProfileStatsArchive extends ServiceMap.Service<
  ProfileStatsArchive,
  ProfileStatsArchiveShape
>()("synara/profileStats/ProfileStatsArchive") {}

const makeProfileStatsArchive = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const checkpointStore = yield* CheckpointStore;
  const threadDeletedAutomationRunResultJson = JSON.stringify({
    outcome: "needs-attention",
    summary: "Automation run was interrupted because its thread was deleted.",
    severity: "warning",
    unread: true,
    archivedAt: null,
  });

  const hasThreadPurgeFence: ProfileStatsArchiveShape["hasThreadPurgeFence"] = ({ threadId }) =>
    Effect.gen(function* () {
      const durableRows = yield* sql<{ readonly fenced: number }>`
        SELECT CASE WHEN
          EXISTS (
            SELECT 1
            FROM orchestration_event_deliveries
            WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
              AND thread_id = ${threadId}
              AND state IN ('inflight', 'retry', 'dead', 'uncertain')
          )
          OR EXISTS (
            SELECT 1
            FROM queued_turn_promotions
            WHERE thread_id = ${threadId}
              AND state IN ('queued', 'promoting')
          )
        THEN 1 ELSE 0 END AS fenced
      `;
      if ((durableRows[0]?.fenced ?? 0) === 1) return true;

      const unconsumedRows = yield* sql<{ readonly eventType: string }>`
        SELECT e.event_type AS "eventType"
        FROM orchestration_events e
        WHERE e.sequence > COALESCE(
          (
            SELECT last_acked_sequence
            FROM orchestration_consumer_state
            WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
          ),
          0
        )
          AND e.aggregate_kind = 'thread'
          AND (
            e.stream_id = ${threadId}
            OR json_extract(e.payload_json, '$.threadId') = ${threadId}
          )
      `;
      return unconsumedRows.some((row) => isProviderIntentEventType(row.eventType));
    });

  const loadThreadCheckpointCleanup = (threadId: string) =>
    Effect.gen(function* () {
      const threadRows = yield* sql<PurgeThreadRow>`
        SELECT
          t.project_id AS projectId,
          t.model_selection_json AS modelSelectionJson,
          t.deleted_at AS deletedAt,
          t.env_mode AS envMode,
          t.worktree_path AS worktreePath,
          t.working_directory AS workingDirectory,
          p.kind AS projectKind,
          p.workspace_root AS workspaceRoot
        FROM projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.thread_id = ${threadId}
      `;
      const thread = threadRows[0];
      if (!thread) {
        return null;
      }

      const checkpointTurnRows = yield* sql<CheckpointTurnRow>`
        SELECT
          turn_id AS turnId,
          checkpoint_ref AS checkpointRef
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND (
            turn_id IS NOT NULL
            OR checkpoint_ref IS NOT NULL
          )
        ORDER BY row_id ASC
      `;
      const checkpointMessageRows = yield* sql<CheckpointMessageRow>`
        SELECT message_id AS messageId
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND message_id IS NOT NULL
        ORDER BY message_id ASC
      `;

      const cwd = threadWorkspaceCwdForCheckpointCleanup(thread);
      const typedThreadId = ThreadId.makeUnsafe(threadId);
      const hasPersistedCheckpointRef = checkpointTurnRows.some((row) => {
        const checkpointRef = readString(row.checkpointRef);
        return checkpointRef
          ? isManagedCheckpointRefForThread(checkpointRef, typedThreadId)
          : false;
      });
      const checkpointRefs =
        cwd !== null || hasPersistedCheckpointRef
          ? checkpointRefsForThreadPurge(threadId, checkpointTurnRows, checkpointMessageRows)
          : [];

      return {
        cwd,
        checkpointRefs,
      } satisfies ThreadCheckpointCleanup;
    });

  // Stale/missing workspaces cannot contain reachable refs for us to delete; keep
  // the DB purge moving, but fail normally once a usable Git repo is confirmed.
  const deleteCheckpointRefsForPurge = (input: {
    readonly threadId: string;
    readonly cwd: string | null;
    readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  }) => {
    if (input.checkpointRefs.length === 0) {
      return Effect.void;
    }
    const cwd = input.cwd;
    if (cwd === null) {
      return Effect.logWarning(
        "profile stats archive skipped checkpoint ref cleanup because workspace is unavailable",
        { threadId: input.threadId, checkpointRefCount: input.checkpointRefs.length },
      );
    }

    return Effect.gen(function* () {
      const isGitRepository = yield* checkpointStore.isGitRepository(cwd).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "profile stats archive could not verify checkpoint cleanup workspace",
            {
              threadId: input.threadId,
              cwd,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.as(false));
        }),
      );
      if (!isGitRepository) {
        yield* Effect.logWarning(
          "profile stats archive skipped checkpoint ref cleanup because workspace is not a git repository",
          { threadId: input.threadId, cwd },
        );
        return;
      }

      yield* checkpointStore.deleteCheckpointRefs({
        cwd,
        checkpointRefs: input.checkpointRefs,
      });
    });
  };

  const deleteCheckpointRefsAfterCommittedPurge = (input: {
    readonly threadId: string;
    readonly cwd: string | null;
    readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  }) =>
    deleteCheckpointRefsForPurge(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning(
          "profile stats archive could not delete checkpoint refs after purge",
          {
            threadId: input.threadId,
            checkpointRefCount: input.checkpointRefs.length,
            cause: Cause.pretty(cause),
          },
        );
      }),
    );

  const snapshotAndPurgeThread = (threadId: string) =>
    Effect.gen(function* () {
      const threadRows = yield* sql<PurgeThreadRow>`
        SELECT
          t.project_id AS projectId,
          t.model_selection_json AS modelSelectionJson,
          t.deleted_at AS deletedAt,
          t.env_mode AS envMode,
          t.worktree_path AS worktreePath,
          t.working_directory AS workingDirectory,
          p.kind AS projectKind,
          p.workspace_root AS workspaceRoot
        FROM projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.thread_id = ${threadId}
      `;
      const thread = threadRows[0];
      if (!thread) {
        return false;
      }
      if (yield* hasThreadPurgeFence({ threadId })) {
        return false;
      }
      const deletedAt = thread.deletedAt ?? new Date().toISOString();
      const projectId = thread.projectId ?? null;

      const turnEventRows = yield* sql<TurnEventRow>`
        SELECT e.payload_json AS payloadJson
        FROM orchestration_events e
        LEFT JOIN projection_thread_messages m
          ON m.message_id = json_extract(e.payload_json, '$.messageId')
        WHERE e.event_type = 'thread.turn-start-requested'
          AND COALESCE(json_extract(e.payload_json, '$.threadId'), e.stream_id) = ${threadId}
          AND (m.dispatch_origin IS NULL OR m.dispatch_origin = 'user')
      `;
      // Same counters and per-turn attribution as the live
      // profileStats.queryTokenActivity: both token counters come back raw so
      // aggregateThreadTokenRows can split cumulative and used-only fallback
      // series, and the turn join pins each delta to the selected model.
      const tokenActivityRows = yield* sql<TokenActivityRow>`
        WITH turn_model AS (
          ${turnModelSelectionCte(sql, { threadId })}
        )
        SELECT
          CAST(json_extract(a.payload_json, '$.totalProcessedTokens') AS INTEGER)
            AS totalProcessedTokens,
          CAST(json_extract(a.payload_json, '$.usedTokens') AS INTEGER) AS usedTokens,
          COALESCE(tm.provider, json_extract(a.payload_json, '$.provider')) AS provider,
          tm.model AS model,
          pm.dispatch_origin AS dispatchOrigin,
          a.created_at AS createdAt
        FROM projection_thread_activities a
        LEFT JOIN turn_model tm
          ON tm.thread_id = a.thread_id
         AND tm.turn_id = a.turn_id
        LEFT JOIN projection_turns pt
          ON pt.thread_id = a.thread_id
         AND pt.turn_id = a.turn_id
        LEFT JOIN projection_thread_messages pm
          ON pm.thread_id = pt.thread_id
         AND pm.message_id = pt.pending_message_id
        WHERE a.thread_id = ${threadId}
          AND a.kind = 'context-window.updated'
          AND COALESCE(
            json_extract(a.payload_json, '$.totalProcessedTokens'),
            json_extract(a.payload_json, '$.usedTokens')
          ) IS NOT NULL
        ORDER BY
          CASE WHEN a.sequence IS NULL THEN 0 ELSE 1 END ASC,
          a.sequence ASC,
          a.created_at ASC,
          a.activity_id ASC
      `;
      const skillMessageRows = yield* sql<SkillMessageRow>`
        SELECT
          message_id AS messageId,
          text,
          skills_json AS skillsJson,
          mentions_json AS mentionsJson
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role = 'user'
          AND source = 'native'
          AND (dispatch_origin IS NULL OR dispatch_origin = 'user')
        ORDER BY created_at ASC, message_id ASC
      `;

      const turnRows = aggregateThreadTurnSnapshotRows(turnEventRows, thread.modelSelectionJson);
      const threadSelection = parseModelSelectionJson(thread.modelSelectionJson);
      const tokenRows = aggregateThreadTokenRows(tokenActivityRows, {
        provider: threadSelection?.provider ?? null,
        model: threadSelection?.model ?? null,
      });
      const skillRows = aggregateProfileSkillUsageRows(skillMessageRows);
      const hasStatsContribution = hasProfileStatsContribution({
        promptRows: skillMessageRows,
        turnRows,
        tokenRows,
        skillRows,
      });

      // Snapshot writes are idempotent per thread so an interrupted purge can
      // safely re-run: wipe any partial snapshot before inserting the new one.
      yield* sql`DELETE FROM profile_stats_deleted_threads WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM profile_stats_deleted_prompts WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM profile_stats_deleted_turns WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM profile_stats_deleted_skills WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM profile_stats_deleted_tokens WHERE thread_id = ${threadId}`;

      if (hasStatsContribution) {
        yield* sql`
          INSERT INTO profile_stats_deleted_threads (thread_id, project_id, deleted_at)
          VALUES (${threadId}, ${projectId}, ${deletedAt})
        `;
        yield* sql`
          INSERT INTO profile_stats_deleted_prompts (thread_id, project_id, created_at)
          SELECT thread_id, ${projectId}, created_at
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND role = 'user'
            AND source = 'native'
            AND (dispatch_origin IS NULL OR dispatch_origin = 'user')
        `;
        yield* Effect.forEach(
          turnRows,
          (row) => sql`
            INSERT INTO profile_stats_deleted_turns (thread_id, provider, model, reasoning, turn_count)
            VALUES (${threadId}, ${row.provider}, ${row.model}, ${row.reasoning}, ${row.turnCount})
          `,
          { concurrency: 1, discard: true },
        );
        yield* Effect.forEach(
          skillRows,
          (row) => sql`
            INSERT INTO profile_stats_deleted_skills (thread_id, name, kind, run_count)
            VALUES (${threadId}, ${row.name}, ${row.kind}, ${row.runCount})
          `,
          { concurrency: 1, discard: true },
        );
        yield* Effect.forEach(
          tokenRows,
          (row) => sql`
            INSERT INTO profile_stats_deleted_tokens (thread_id, created_at, provider, model, tokens)
            VALUES (${threadId}, ${row.createdAt}, ${row.provider}, ${row.model}, ${row.tokens})
          `,
          { concurrency: 1, discard: true },
        );
      }

      // Hard delete: every table that stores rows for this thread. The delete
      // receipts stay as tiny idempotency tombstones for command retries after
      // the bulky event/projection rows are gone.
      // The event delete mirrors the snapshot scope above (stream id OR
      // payload threadId, thread aggregate only) so no snapshotted event can
      // survive the purge.
      // Settled delivery rows are no longer recovery evidence. Remove them
      // before their source events; unresolved rows were fenced above.
      yield* sql`
        DELETE FROM orchestration_event_deliveries
        WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
          AND thread_id = ${threadId}
          AND state = 'succeeded'
      `;
      yield* sql`
        DELETE FROM queued_turn_promotions
        WHERE thread_id = ${threadId}
          AND state IN ('promoted', 'cancelled')
      `;
      // Completed/failed/reliably-unstarted gateway operations no longer have
      // recovery value once their caller is explicitly purged. In-flight rows
      // retain only deterministic ids and git ownership evidence until startup
      // or live compensation terminalizes them; repository terminal writes
      // then delete the caller-purged row atomically.
      // External MCP task ownership outlives the projection for authorization
      // and audit. Terminalize it in the same transaction before its projected
      // turn disappears so durable capacity cannot be stranded by a purge.
      yield* sql`
        UPDATE external_mcp_tasks
        SET status = 'failed', updated_at = ${deletedAt}
        WHERE thread_id = ${threadId}
          AND status IN ('planned', 'created')
      `;
      yield* sql`
        DELETE FROM agent_gateway_operations
        WHERE caller_thread_id = ${threadId}
          AND status IN ('reserved', 'completed', 'failed')
      `;
      const liveGatewayOperations = yield* sql<{
        readonly operationId: string;
        readonly planJson: string;
      }>`
        SELECT operation_id AS "operationId", plan_json AS "planJson"
        FROM agent_gateway_operations
        WHERE caller_thread_id = ${threadId}
          AND status IN ('dispatching', 'compensating')
      `;
      yield* Effect.forEach(
        liveGatewayOperations,
        (operation) => {
          const recoveryPlanJson = redactCreationPlanForPurgedCaller({
            planJson: operation.planJson,
            operationId: operation.operationId,
          });
          return sql`
            UPDATE agent_gateway_operations
            SET plan_json = ${recoveryPlanJson},
                caller_thread_id = 'purged-thread:' || operation_id,
                caller_turn_id = 'purged-turn:' || operation_id,
                request_id = operation_id,
                fingerprint = operation_id,
                result_json = NULL,
                error_json = NULL,
                caller_purged_at = ${deletedAt},
                updated_at = ${deletedAt}
            WHERE operation_id = ${operation.operationId}
              AND status IN ('dispatching', 'compensating')
          `;
        },
        { concurrency: 1, discard: true },
      );
      yield* sql`
        DELETE FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND (
            stream_id = ${threadId}
            OR json_extract(payload_json, '$.threadId') = ${threadId}
          )
      `;
      yield* sql`DELETE FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_pending_interactions WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
      yield* sql`
        UPDATE automation_runs
        SET status = 'interrupted',
            error = 'Automation run was interrupted because its thread was deleted.',
            result_json = ${threadDeletedAutomationRunResultJson},
            finished_at = COALESCE(finished_at, ${deletedAt}),
            updated_at = ${deletedAt},
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE thread_id = ${threadId}
          AND status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'skipped')
      `;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;

      return true;
    });

  const purgeThreadWithStatsSnapshot: ProfileStatsArchiveShape["purgeThreadWithStatsSnapshot"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const checkpointCleanup = yield* loadThreadCheckpointCleanup(input.threadId);
      if (checkpointCleanup === null) {
        return false;
      }
      const purged = yield* sql.withTransaction(snapshotAndPurgeThread(input.threadId));
      if (purged) {
        yield* deleteCheckpointRefsAfterCommittedPurge({
          threadId: input.threadId,
          cwd: checkpointCleanup.cwd,
          checkpointRefs: checkpointCleanup.checkpointRefs,
        });
      }
      return purged;
    });

  const purgeSoftDeletedManualThreads: ProfileStatsArchiveShape["purgeSoftDeletedManualThreads"] = (
    input,
  ) =>
    Effect.gen(function* () {
      // Classify by the LATEST thread.deleted event's command id, which is the
      // only delete provenance that survives this purge. Purging is irreversible,
      // so it requires positive evidence of a manual delete: a soft-deleted thread
      // with no recorded delete event (legacy import, truncated event log) is kept
      // rather than guessed at.
      const candidates = yield* sql<{ readonly threadId: string }>`
          SELECT t.thread_id AS threadId
          FROM projection_threads t
          WHERE t.deleted_at IS NOT NULL
            AND (
              SELECT td.command_id
              FROM orchestration_events td
              WHERE td.event_type = 'thread.deleted'
                AND td.stream_id = t.thread_id
              ORDER BY td.sequence DESC
              LIMIT 1
            ) NOT LIKE ${`${THREAD_RETENTION_COMMAND_ID_PREFIX}%`}
        `;

      let purgedCount = 0;
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            const shouldPurge = input?.beforePurge
              ? yield* input.beforePurge(candidate.threadId)
              : true;
            if (!shouldPurge) {
              return;
            }
            const purged = yield* purgeThreadWithStatsSnapshot({
              threadId: candidate.threadId,
            });
            if (purged) {
              purgedCount += 1;
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("profile stats archive failed to purge soft-deleted thread", {
                threadId: candidate.threadId,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      return purgedCount;
    });

  return {
    hasThreadPurgeFence,
    purgeThreadWithStatsSnapshot,
    purgeSoftDeletedManualThreads,
  } satisfies ProfileStatsArchiveShape;
});

export const ProfileStatsArchiveLive = Layer.effect(ProfileStatsArchive, makeProfileStatsArchive);
