// FILE: profileStatsArchive.test.ts
// Purpose: Coverage for the snapshot-then-purge flow: purging a thread must
// free its rows while leaving every Profile stat unchanged.
// Layer: Server stats tests
// Exports: Vitest coverage for ProfileStatsArchive.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "./checkpointing/Services/CheckpointStore";
import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurnStart,
} from "./checkpointing/Utils";
import { ServerConfig } from "./config";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "./persistence/Services/OrchestrationEventDeliveries";
import { ProfileStatsQuery, ProfileStatsQueryLive } from "./profileStats";
import {
  aggregateThreadTokenRows,
  ProfileStatsArchive,
  ProfileStatsArchiveLive,
} from "./profileStatsArchive";

interface DeletedCheckpointRefCall {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<string>;
}

const deletedCheckpointRefCalls: DeletedCheckpointRefCall[] = [];

function recordDeletedCheckpointRefs(
  input: Parameters<CheckpointStoreShape["deleteCheckpointRefs"]>[0],
) {
  deletedCheckpointRefCalls.push({
    cwd: input.cwd,
    checkpointRefs: input.checkpointRefs.map((checkpointRef) => String(checkpointRef)),
  });
}

let isGitRepositoryImpl: CheckpointStoreShape["isGitRepository"] = () => Effect.succeed(true);
let deleteCheckpointRefsImpl: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
  Effect.sync(() => recordDeletedCheckpointRefs(input));

const checkpointStoreTestLayer = Layer.succeed(CheckpointStore, {
  isGitRepository: (cwd) => isGitRepositoryImpl(cwd),
  captureCheckpoint: () => Effect.die("unused checkpoint store test method"),
  copyCheckpointRef: () => Effect.die("unused checkpoint store test method"),
  hasCheckpointRef: () => Effect.die("unused checkpoint store test method"),
  restoreCheckpoint: () => Effect.die("unused checkpoint store test method"),
  reverseCheckpointDiff: () => Effect.die("unused checkpoint store test method"),
  diffCheckpoints: () => Effect.die("unused checkpoint store test method"),
  deleteCheckpointRefs: (input) => deleteCheckpointRefsImpl(input),
} satisfies CheckpointStoreShape);

const testLayer = Layer.mergeAll(ProfileStatsQueryLive, ProfileStatsArchiveLive).pipe(
  Layer.provideMerge(checkpointStoreTestLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-profile-stats-archive-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

function runArchiveTest<A, E>(
  effect: Effect.Effect<A, E, ProfileStatsQuery | ProfileStatsArchive | SqlClient.SqlClient>,
) {
  return effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
}

const seedTwoThreadsWithActivity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    )
    VALUES (
      'project-archive',
      'Archive',
      '/work/archive',
      '{}',
      '2026-06-12T09:00:00.000Z',
      '2026-06-12T09:00:00.000Z',
      NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, env_mode, created_at, updated_at, deleted_at
    )
    VALUES
      (
        'thread-keep',
        'project-archive',
        'Kept Thread',
        '{"provider":"claudeAgent","model":"claude-sonnet-4-6","options":{"effort":"max"}}',
        'full-access', 'default', 'local',
        '2026-06-13T08:00:00.000Z', '2026-06-13T08:00:00.000Z', NULL
      ),
      (
        'thread-purge',
        'project-archive',
        'Purged Thread',
        '{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}',
        'full-access', 'default', 'local',
        '2026-06-13T09:00:00.000Z', '2026-06-13T09:00:00.000Z', NULL
      )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, skills_json, mentions_json,
      is_streaming, source, dispatch_origin, created_at, updated_at
    )
    VALUES
      (
        'message-keep-1', 'thread-keep', 'turn-keep-1', 'user',
        'keep one', NULL, NULL,
        0, 'native', 'user', '2026-06-13T08:05:00.000Z', '2026-06-13T08:05:00.000Z'
      ),
      (
        'message-purge-1', 'thread-purge', 'turn-purge-1', 'user',
        'Use /check-code here',
        '[{"name":"check-code","path":"/skills/check-code/SKILL.md"}]', NULL,
        0, 'native', 'user', '2026-06-13T09:05:00.000Z', '2026-06-13T09:05:00.000Z'
      ),
      (
        'message-purge-2', 'thread-purge', 'turn-purge-2', 'user',
        'purge two', NULL, '[{"name":"reviewer","path":"agent://reviewer"}]',
        0, 'native', 'agent', '2026-06-14T10:05:00.000Z', '2026-06-14T10:05:00.000Z'
      )
  `;

  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, command_id, actor_kind, payload_json, metadata_json
    )
    VALUES
      (
        'event-keep-1', 'thread', 'thread-keep', 1, 'thread.turn-start-requested',
        '2026-06-13T08:05:00.000Z', 'cmd-keep-turn', 'client',
        '{"threadId":"thread-keep","modelSelection":{"provider":"claudeAgent","model":"claude-sonnet-4-6","options":{"effort":"max"}}}',
        '{}'
      ),
      (
        'event-purge-create', 'thread', 'thread-purge', 1, 'thread.created',
        '2026-06-13T09:00:00.000Z', 'cmd-purge-create', 'client',
        '{"threadId":"thread-purge","projectId":"project-archive","title":"Purged Thread"}',
        '{}'
      ),
      (
        'event-purge-1', 'thread', 'thread-purge', 2, 'thread.turn-start-requested',
        '2026-06-13T09:05:00.000Z', 'cmd-purge-turn', 'client',
        '{"threadId":"thread-purge","modelSelection":{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}}',
        '{}'
      ),
      (
        'event-purge-2', 'thread', 'thread-purge', 3, 'thread.turn-start-requested',
        '2026-06-14T10:05:00.000Z', NULL, 'client',
        '{"threadId":"thread-purge"}',
        '{}'
      ),
      (
        'event-purge-delete', 'thread', 'thread-purge', 4, 'thread.deleted',
        '2026-06-14T10:10:00.000Z', 'cmd-purge-delete', 'user',
        '{"threadId":"thread-purge","deletedAt":"2026-06-14T10:10:00.000Z"}',
        '{}'
      )
  `;

  yield* sql`
    INSERT INTO orchestration_command_receipts (
      command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
    )
    VALUES
      (
        'cmd-keep-turn', 'thread', 'thread-keep',
        '2026-06-13T08:05:00.000Z', 1, 'accepted', NULL
      ),
      (
        'cmd-purge-create', 'thread', 'thread-purge',
        '2026-06-13T09:00:00.000Z', 2, 'accepted', NULL
      ),
      (
        'cmd-purge-turn', 'thread', 'thread-purge',
        '2026-06-13T09:05:00.000Z', 2, 'accepted', NULL
      ),
      (
        'cmd-purge-delete', 'thread', 'thread-purge',
        '2026-06-14T10:10:00.000Z', 3, 'accepted', NULL
      )
  `;

  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    )
    VALUES
      (
        'activity-keep-1', 'thread-keep', 'turn-keep-1', 'info',
        'context-window.updated', 'tokens updated',
        '{"totalProcessedTokens":1000}', 1, '2026-06-13T08:06:00.000Z'
      ),
      (
        'activity-purge-1', 'thread-purge', 'turn-purge-1', 'info',
        'context-window.updated', 'tokens updated',
        '{"totalProcessedTokens":3000}', 1, '2026-06-13T09:06:00.000Z'
      ),
      (
        'activity-purge-2', 'thread-purge', 'turn-purge-2', 'info',
        'context-window.updated', 'tokens updated',
        '{"totalProcessedTokens":5000}', 2, '2026-06-13T18:45:00.000Z'
      )
  `;

  yield* sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, assistant_message_id, state,
      requested_at, started_at, completed_at, checkpoint_turn_count,
      checkpoint_ref, checkpoint_status, checkpoint_files_json
    )
    VALUES
      (
        'thread-keep', 'turn-keep-1', 'message-keep-1', NULL, 'completed',
        '2026-06-13T08:05:00.000Z', '2026-06-13T08:05:10.000Z',
        '2026-06-13T08:06:00.000Z', 1,
        'refs/historical/checkpoints/dGhyZWFkLWtlZXA/turn/1', 'captured', '[]'
      ),
      (
        'thread-purge', 'turn-purge-1', 'message-purge-1', NULL, 'completed',
        '2026-06-13T09:05:00.000Z', '2026-06-13T09:05:10.000Z',
        '2026-06-13T09:06:00.000Z', 1,
        'refs/historical/checkpoints/dGhyZWFkLXB1cmdl/turn/1', 'captured', '[]'
      ),
      (
        'thread-purge', 'turn-purge-2', 'message-purge-2', NULL, 'completed',
        '2026-06-14T10:05:00.000Z', '2026-06-14T10:05:10.000Z',
        '2026-06-14T10:06:00.000Z', 2,
        'provider-diff:event-purge-2', 'captured', '[]'
      )
  `;
});

const acknowledgeProviderCommandJournal = (sql: SqlClient.SqlClient) =>
  sql`
    UPDATE orchestration_consumer_state
    SET last_acked_sequence = (
      SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events
    ),
    updated_at = '2026-07-14T00:00:00.000Z'
    WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
  `;

describe("ProfileStatsArchive", () => {
  beforeEach(() => {
    deletedCheckpointRefCalls.length = 0;
    isGitRepositoryImpl = () => Effect.succeed(true);
    deleteCheckpointRefsImpl = (input) => Effect.sync(() => recordDeletedCheckpointRefs(input));
  });

  it("archives usedTokens-only model groups even when another group has cumulative telemetry", () => {
    const rows = aggregateThreadTokenRows([
      {
        totalProcessedTokens: 2000,
        usedTokens: 1200,
        provider: "codex",
        model: "gpt-5-codex",
        createdAt: "2026-06-13T12:02:00.000Z",
      },
      {
        totalProcessedTokens: null,
        usedTokens: 300,
        provider: "codex",
        model: "gpt-5-codex",
        createdAt: "2026-06-13T12:03:00.000Z",
      },
      {
        totalProcessedTokens: 2500,
        usedTokens: 1500,
        provider: "codex",
        model: "gpt-5-codex",
        createdAt: "2026-06-13T12:04:00.000Z",
      },
      {
        totalProcessedTokens: null,
        usedTokens: 700,
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        createdAt: "2026-06-13T12:11:00.000Z",
      },
      {
        totalProcessedTokens: null,
        usedTokens: 1700,
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        createdAt: "2026-06-13T12:12:00.000Z",
      },
    ]);

    expect(rows).toEqual([
      {
        createdAt: "2026-06-13T12:02:00.000Z",
        provider: "codex",
        model: "gpt-5-codex",
        tokens: 2000,
      },
      {
        createdAt: "2026-06-13T12:04:00.000Z",
        provider: "codex",
        model: "gpt-5-codex",
        tokens: 500,
      },
      {
        createdAt: "2026-06-13T12:11:00.000Z",
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        tokens: 700,
      },
      {
        createdAt: "2026-06-13T12:12:00.000Z",
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        tokens: 1000,
      },
    ]);
  });

  it("computes cumulative deltas across agent turns before excluding their usage", () => {
    const rows = aggregateThreadTokenRows([
      {
        totalProcessedTokens: 1_000,
        usedTokens: null,
        provider: "codex",
        model: "gpt-5.5",
        dispatchOrigin: "user",
        createdAt: "2026-06-13T12:00:00.000Z",
      },
      {
        totalProcessedTokens: 2_500,
        usedTokens: null,
        provider: "codex",
        model: "gpt-5.5",
        dispatchOrigin: "agent",
        createdAt: "2026-06-13T12:01:00.000Z",
      },
      {
        totalProcessedTokens: 3_000,
        usedTokens: null,
        provider: "codex",
        model: "gpt-5.5",
        dispatchOrigin: "user",
        createdAt: "2026-06-13T12:02:00.000Z",
      },
    ]);

    expect(rows.map(({ createdAt, tokens }) => ({ createdAt, tokens }))).toEqual([
      { createdAt: "2026-06-13T12:00:00.000Z", tokens: 1_000 },
      { createdAt: "2026-06-13T12:02:00.000Z", tokens: 500 },
    ]);
  });

  it("keeps a stamped activity provider instead of a mismatched thread fallback", () => {
    const rows = aggregateThreadTokenRows(
      [
        {
          totalProcessedTokens: 1_500,
          usedTokens: null,
          provider: "claudeAgent",
          model: null,
          createdAt: "2026-06-13T12:00:00.000Z",
        },
      ],
      { provider: "codex", model: "gpt-5.5" },
    );

    expect(rows).toEqual([
      {
        createdAt: "2026-06-13T12:00:00.000Z",
        provider: "claudeAgent",
        model: null,
        tokens: 1_500,
      },
    ]);
  });

  it("purges a thread's rows while keeping every profile stat unchanged", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;
        const archive = yield* ProfileStatsArchive;

        yield* seedTwoThreadsWithActivity;
        yield* acknowledgeProviderCommandJournal(sql);
        yield* sql`
          INSERT INTO external_mcp_integrations (
            integration_id, name, audience, client_kind, credential_hash,
            capabilities_json, created_at, expires_at, rate_limit_per_minute,
            concurrency_limit
          ) VALUES (
            'integration-purge', 'Purge integration', 'synara.external-mcp', 'other',
            'credential-purge', '["tasks.create","tasks.read"]',
            '2026-06-13T17:00:00.000Z', '2027-06-13T17:00:00.000Z', 60, 1
          )
        `;
        yield* sql`
          INSERT INTO external_mcp_operations (
            operation_id, integration_id, request_id, fingerprint, requested_count,
            plan_json, status, result_json, created_at, updated_at
          ) VALUES (
            'operation-purge', 'integration-purge', 'request-purge', 'fingerprint-purge', 1,
            '[]', 'completed', '{}', '2026-06-13T17:00:00.000Z',
            '2026-06-13T17:01:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO external_mcp_tasks (
            integration_id, operation_id, request_id, thread_id, project_id,
            status, created_at, updated_at
          ) VALUES (
            'integration-purge', 'operation-purge', 'request-purge', 'thread-purge',
            'project-archive', 'created', '2026-06-13T17:00:00.000Z',
            '2026-06-13T17:01:00.000Z'
          )
        `;

        const statsBefore = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        const tokenStatsBefore = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        // Half-hour offset: the 18:45Z token activity lands on the NEXT local
        // day for +05:30, so this catches any archive-side day re-bucketing drift.
        const statsBeforeIst = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 330 });
        const tokenStatsBeforeIst = yield* statsQuery.getProfileTokenStats({
          utcOffsetMinutes: 330,
        });

        const purged = yield* archive.purgeThreadWithStatsSnapshot({ threadId: "thread-purge" });
        expect(purged).toBe(true);

        // Every row the purged thread owned is gone.
        const remaining = yield* sql<{
          readonly threads: number;
          readonly messages: number;
          readonly turns: number;
        }>`
          SELECT
            (SELECT COUNT(*) FROM projection_threads WHERE thread_id = 'thread-purge') AS threads,
            (
              SELECT COUNT(*)
              FROM projection_thread_messages
              WHERE thread_id = 'thread-purge'
            ) AS messages,
            (SELECT COUNT(*) FROM projection_turns WHERE thread_id = 'thread-purge') AS turns
        `;
        expect(remaining[0]).toMatchObject({ threads: 0, messages: 0, turns: 0 });
        expect(
          yield* sql<{ readonly status: string; readonly activeClaims: number }>`
            SELECT
              tasks.status,
              (
                SELECT COUNT(*)
                FROM external_mcp_active_capacity_claims
                WHERE integration_id = 'integration-purge'
              ) AS activeClaims
            FROM external_mcp_tasks AS tasks
            WHERE tasks.thread_id = 'thread-purge'
          `,
        ).toEqual([{ status: "failed", activeClaims: 0 }]);
        expect(deletedCheckpointRefCalls).toEqual([
          {
            cwd: "/work/archive",
            checkpointRefs: [
              "refs/historical/checkpoints/dGhyZWFkLXB1cmdl/turn/1",
              String(
                checkpointRefForThreadTurnStart(
                  ThreadId.makeUnsafe("thread-purge"),
                  TurnId.makeUnsafe("turn-purge-1"),
                ),
              ),
              String(
                checkpointRefForThreadTurnStart(
                  ThreadId.makeUnsafe("thread-purge"),
                  TurnId.makeUnsafe("turn-purge-2"),
                ),
              ),
              String(
                checkpointRefForThreadMessageStart(
                  ThreadId.makeUnsafe("thread-purge"),
                  MessageId.makeUnsafe("message-purge-1"),
                ),
              ),
              String(
                checkpointRefForThreadMessageStart(
                  ThreadId.makeUnsafe("thread-purge"),
                  MessageId.makeUnsafe("message-purge-2"),
                ),
              ),
            ],
          },
        ]);
        const remainingEvents = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = 'thread-purge'
        `;
        expect(remainingEvents[0]?.count).toBe(0);
        const remainingReceipts = yield* sql<{ readonly commandId: string }>`
          SELECT command_id AS commandId
          FROM orchestration_command_receipts
          WHERE command_id IN (
            'cmd-keep-turn',
            'cmd-purge-create',
            'cmd-purge-turn',
            'cmd-purge-delete'
          )
          ORDER BY command_id ASC
        `;
        expect(remainingReceipts.map((row) => row.commandId)).toEqual([
          "cmd-keep-turn",
          "cmd-purge-create",
          "cmd-purge-delete",
          "cmd-purge-turn",
        ]);
        const remainingActivities = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_thread_activities
          WHERE thread_id = 'thread-purge'
        `;
        expect(remainingActivities[0]?.count).toBe(0);

        // The Profile numbers do not move: the archive snapshot replaces the rows.
        const statsAfter = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        const tokenStatsAfter = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        expect(statsAfter.activity).toEqual(statsBefore.activity);
        expect(statsAfter.activeHours).toEqual(statsBefore.activeHours);
        expect(statsAfter.insights).toEqual(statsBefore.insights);
        expect(statsAfter.providerModels).toEqual(statsBefore.providerModels);
        expect(statsAfter.skills).toEqual(statsBefore.skills);
        expect(statsAfter.mostWorkedProject).toEqual(statsBefore.mostWorkedProject);
        expect(tokenStatsAfter).toEqual(tokenStatsBefore);

        const statsAfterIst = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 330 });
        const tokenStatsAfterIst = yield* statsQuery.getProfileTokenStats({
          utcOffsetMinutes: 330,
        });
        expect(statsAfterIst.activity).toEqual(statsBeforeIst.activity);
        expect(statsAfterIst.activeHours).toEqual(statsBeforeIst.activeHours);
        expect(tokenStatsAfterIst).toEqual(tokenStatsBeforeIst);

        // Re-purging an already purged thread is a no-op.
        const purgedAgain = yield* archive.purgeThreadWithStatsSnapshot({
          threadId: "thread-purge",
        });
        expect(purgedAgain).toBe(false);
        const statsAfterRepurge = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        expect(statsAfterRepurge.activity).toEqual(statsBefore.activity);
      }),
    );
  });

  it("keeps modelUsage attribution and baselines when archiving deleted threads", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;
        const archive = yield* ProfileStatsArchive;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
          )
          VALUES (
            'project-archive-modelusage',
            'Archive Model Usage',
            '/work/archive-modelusage',
            '{}',
            '2026-06-12T09:00:00.000Z',
            '2026-06-12T09:00:00.000Z',
            NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          )
          VALUES (
            'thread-archive-modelusage',
            'project-archive-modelusage',
            'Archive Model Usage',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access', 'default', 'local',
            '2026-06-15T09:00:00.000Z',
            '2026-06-15T09:00:00.000Z',
            NULL
          )
        `;
        // The modelUsage turn (M) sits between two context-window rows (A, B)
        // AND has its own context-window row (M-row): the archive must keep the
        // M-row in the LAG baseline (contribution zero) and add the modelUsage
        // tokens, exactly like the live query.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            (
              'archive-mu-a', 'thread-archive-modelusage', 'turn-archive-a',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":100,"provider":"codex"}', 1, '2026-06-15T09:05:00.000Z'
            ),
            (
              'archive-mu-m', 'thread-archive-modelusage', 'turn-archive-m',
              'info', 'turn.completed', 'Turn completed',
              '{"modelUsage":{"openai/gpt-5":{"totalTokens":80}}}', 2, '2026-06-15T09:15:00.000Z'
            ),
            (
              'archive-mu-m-row', 'thread-archive-modelusage', 'turn-archive-m',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":180,"provider":"codex"}', 3, '2026-06-15T09:16:00.000Z'
            ),
            (
              'archive-mu-b', 'thread-archive-modelusage', 'turn-archive-b',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":300,"provider":"codex"}', 4, '2026-06-15T09:25:00.000Z'
            ),
            (
              'archive-mu-b-turn', 'thread-archive-modelusage', 'turn-archive-b',
              'info', 'turn.completed', 'Turn completed',
              '{}', 5, '2026-06-15T09:26:00.000Z'
            )
        `;

        const statsBefore = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        expect(statsBefore.lifetimeTotalTokens).toBe(300);
        expect(statsBefore.models).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ model: "gpt-5-codex", tokens: 220 }),
            expect.objectContaining({ model: "openai/gpt-5", tokens: 80 }),
          ]),
        );

        const purged = yield* archive.purgeThreadWithStatsSnapshot({
          threadId: "thread-archive-modelusage",
        });
        expect(purged).toBe(true);

        // The archived snapshot keeps the same totals AND the modelUsage-attributed
        // model: no double count and no fallback shift to the selected model.
        const statsAfter = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        expect(statsAfter.lifetimeTotalTokens).toBe(300);
        expect(statsAfter.models).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ model: "gpt-5-codex", tokens: 220 }),
            expect.objectContaining({ model: "openai/gpt-5", tokens: 80 }),
          ]),
        );
      }),
    );
  });

  it("deletes terminal gateway plans and redacts live recovery plans with a purged caller", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const archive = yield* ProfileStatsArchive;
        yield* seedTwoThreadsWithActivity;
        yield* acknowledgeProviderCommandJournal(sql);

        const livePlan = JSON.stringify([
          {
            index: 0,
            spec: { prompt: "private live prompt", branchName: "agent/private" },
            projectId: "project-archive",
            workspaceRoot: "/work/archive",
            environment: "worktree",
            runtimeMode: "full-access",
            baseBranch: "main",
            newBranch: "agent/private",
            plannedWorktreePath: "/worktrees/private",
            ownershipPreflightPassed: true,
            worktreeOwnership: {
              operationId: "operation-live",
              path: "/worktrees/private",
              branch: "agent/private",
              token: "private-owner-token",
              gitDir: "/repo/.git/worktrees/private",
              head: "0123456789abcdef",
              recordedAt: "2026-06-14T10:06:00.000Z",
            },
            ids: {
              threadId: "agent-private-child",
              compensateCommandId: "delete-agent-private-child",
            },
          },
        ]);
        yield* sql`
          INSERT INTO agent_gateway_operations (
            operation_id, caller_thread_id, caller_turn_id, operation_kind,
            request_id, fingerprint, requested_count, plan_json, status,
            result_json, error_json, created_at, updated_at
          ) VALUES
            (
              'operation-terminal', 'thread-purge', 'turn-purge-terminal', 'create_threads',
              'terminal-request', 'terminal-fingerprint', 1,
              '[{"spec":{"prompt":"private terminal prompt"}}]', 'completed',
              '{"workspaceRoot":"/private/result"}', NULL,
              '2026-06-14T10:05:00.000Z', '2026-06-14T10:05:00.000Z'
            ),
            (
              'operation-live', 'thread-purge', 'turn-purge-live', 'create_threads',
              'private-request-id', 'private-fingerprint', 1,
              ${livePlan}, 'dispatching', NULL, '{"path":"/private/error"}',
              '2026-06-14T10:06:00.000Z', '2026-06-14T10:06:00.000Z'
            )
        `;

        expect(yield* archive.purgeThreadWithStatsSnapshot({ threadId: "thread-purge" })).toBe(
          true,
        );
        const rows = yield* sql<{
          readonly operationId: string;
          readonly callerThreadId: string;
          readonly callerTurnId: string;
          readonly requestId: string;
          readonly fingerprint: string;
          readonly planJson: string;
          readonly status: string;
          readonly resultJson: string | null;
          readonly errorJson: string | null;
          readonly callerPurgedAt: string | null;
        }>`
          SELECT
            operation_id AS "operationId", caller_thread_id AS "callerThreadId",
            caller_turn_id AS "callerTurnId", request_id AS "requestId", fingerprint,
            plan_json AS "planJson", status, result_json AS "resultJson",
            error_json AS "errorJson", caller_purged_at AS "callerPurgedAt"
          FROM agent_gateway_operations
          WHERE operation_id = 'operation-live'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          operationId: "operation-live",
          callerThreadId: "purged-thread:operation-live",
          callerTurnId: "purged-turn:operation-live",
          requestId: "operation-live",
          fingerprint: "operation-live",
          status: "dispatching",
          resultJson: null,
          errorJson: null,
          callerPurgedAt: expect.any(String),
        });
        const retainedCallerIds = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM agent_gateway_operations
          WHERE caller_thread_id = 'thread-purge'
             OR caller_turn_id IN ('turn-purge-terminal', 'turn-purge-live')
        `;
        expect(retainedCallerIds[0]?.count).toBe(0);
        expect(rows[0]!.planJson).not.toContain("private live prompt");
        expect(rows[0]!.planJson).not.toContain("project-archive");
        expect(JSON.parse(rows[0]!.planJson)[0]).toEqual({
          workspaceRoot: "/work/archive",
          environment: "worktree",
          newBranch: "agent/private",
          plannedWorktreePath: "/worktrees/private",
          ownershipPreflightPassed: true,
          worktreeOwnership: {
            operationId: "operation-live",
            path: "/worktrees/private",
            branch: "agent/private",
            token: "private-owner-token",
            gitDir: "/repo/.git/worktrees/private",
            head: "0123456789abcdef",
            recordedAt: "2026-06-14T10:06:00.000Z",
          },
          ids: {
            threadId: "agent-private-child",
            compensateCommandId: "delete-agent-private-child",
          },
        });
      }),
    );
  });

  it("retains unresolved delivery evidence and purges only after explicit settlement", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const archive = yield* ProfileStatsArchive;

        yield* seedTwoThreadsWithActivity;
        yield* acknowledgeProviderCommandJournal(sql);
        const sourceRows = yield* sql<{ readonly sequence: number }>`
          SELECT sequence
          FROM orchestration_events
          WHERE stream_id = 'thread-purge'
          ORDER BY sequence ASC
          LIMIT 1
        `;
        const sourceSequence = sourceRows[0]!.sequence;
        yield* sql`
          INSERT INTO orchestration_event_deliveries (
            consumer_name, event_sequence, thread_id, state,
            claim_owner, claimed_at, claim_expires_at, attempt_count,
            last_error, completed_at, updated_at
          ) VALUES (
            ${PROVIDER_COMMAND_REACTOR_CONSUMER}, ${sourceSequence}, 'thread-purge', 'uncertain',
            NULL, NULL, NULL, 1,
            'Provider outcome requires reconciliation.', NULL, '2026-07-14T00:00:00.000Z'
          )
        `;

        expect(yield* archive.hasThreadPurgeFence({ threadId: "thread-purge" })).toBe(true);
        expect(yield* archive.purgeThreadWithStatsSnapshot({ threadId: "thread-purge" })).toBe(
          false,
        );
        const retained = yield* sql<{ readonly threads: number; readonly deliveries: number }>`
          SELECT
            (SELECT COUNT(*) FROM projection_threads WHERE thread_id = 'thread-purge') AS threads,
            (
              SELECT COUNT(*) FROM orchestration_event_deliveries
              WHERE thread_id = 'thread-purge' AND state = 'uncertain'
            ) AS deliveries
        `;
        expect(retained[0]).toEqual({ threads: 1, deliveries: 1 });

        yield* sql`
          UPDATE orchestration_event_deliveries
          SET state = 'succeeded', completed_at = '2026-07-14T00:00:01.000Z',
              updated_at = '2026-07-14T00:00:01.000Z'
          WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
            AND event_sequence = ${sourceSequence}
        `;
        yield* sql`
          INSERT INTO queued_turn_promotions (
            queued_event_sequence, thread_id, message_id, dispatch_mode, state,
            claim_owner, claimed_at, claim_expires_at, attempt_count,
            created_at, updated_at, promoted_at
          ) VALUES (
            ${sourceSequence}, 'thread-purge', 'message-settled-promotion', 'queue', 'promoted',
            NULL, NULL, NULL, 1,
            '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:01.000Z',
            '2026-07-14T00:00:01.000Z'
          )
        `;

        expect(yield* archive.hasThreadPurgeFence({ threadId: "thread-purge" })).toBe(false);
        expect(yield* archive.purgeThreadWithStatsSnapshot({ threadId: "thread-purge" })).toBe(
          true,
        );
        const purgedEvidence = yield* sql<{
          readonly deliveries: number;
          readonly promotions: number;
        }>`
          SELECT
            (
              SELECT COUNT(*) FROM orchestration_event_deliveries
              WHERE thread_id = 'thread-purge'
            ) AS deliveries,
            (
              SELECT COUNT(*) FROM queued_turn_promotions
              WHERE thread_id = 'thread-purge'
            ) AS promotions
        `;
        expect(purgedEvidence[0]).toEqual({ deliveries: 0, promotions: 0 });
      }),
    );
  });

  it("hard-deletes empty cleanup threads without archiving a lifetime tombstone", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;
        const archive = yield* ProfileStatsArchive;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
          )
          VALUES (
            'project-empty-cleanup',
            'Empty Cleanup',
            '/work/empty-cleanup',
            '{}',
            '2026-06-12T09:00:00.000Z',
            '2026-06-12T09:00:00.000Z',
            NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          )
          VALUES (
            'thread-empty-cleanup',
            'project-empty-cleanup',
            'Empty Cleanup',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access', 'default', 'local',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:05:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO profile_stats_deleted_threads (thread_id, project_id, deleted_at)
          VALUES (
            'thread-empty-cleanup',
            'project-empty-cleanup',
            '2026-06-13T09:05:00.000Z'
          )
        `;

        const statsBefore = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        expect(statsBefore.activity.totalThreads).toBe(2);

        const purged = yield* archive.purgeThreadWithStatsSnapshot({
          threadId: "thread-empty-cleanup",
        });
        expect(purged).toBe(true);

        const rows = yield* sql<{ readonly threads: number; readonly tombstones: number }>`
          SELECT
            (
              SELECT COUNT(*)
              FROM projection_threads
              WHERE thread_id = 'thread-empty-cleanup'
            ) AS threads,
            (
              SELECT COUNT(*)
              FROM profile_stats_deleted_threads
              WHERE thread_id = 'thread-empty-cleanup'
            ) AS tombstones
        `;
        expect(rows[0]).toEqual({ threads: 0, tombstones: 0 });

        const statsAfter = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        expect(statsAfter.activity.totalThreads).toBe(0);
        expect(deletedCheckpointRefCalls).toEqual([]);
      }),
    );
  });

  it("deletes message-start checkpoint refs when no turn checkpoint row exists yet", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const archive = yield* ProfileStatsArchive;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
          )
          VALUES (
            'project-message-checkpoint',
            'Message Checkpoint',
            '/work/message-checkpoint',
            '{}',
            '2026-06-12T09:00:00.000Z',
            '2026-06-12T09:00:00.000Z',
            NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          )
          VALUES (
            'thread-message-checkpoint',
            'project-message-checkpoint',
            'Message Checkpoint',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access', 'default', 'local',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:05:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, source,
            created_at, updated_at
          )
          VALUES (
            'message-pending-checkpoint',
            'thread-message-checkpoint',
            NULL,
            'user',
            'pending turn',
            0,
            'native',
            '2026-06-13T09:01:00.000Z',
            '2026-06-13T09:01:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_turn_count,
            checkpoint_ref, checkpoint_status, checkpoint_files_json
          )
          VALUES (
            'thread-message-checkpoint', NULL, 'message-pending-checkpoint', NULL, 'pending',
            '2026-06-13T09:01:00.000Z', NULL, NULL, NULL,
            NULL, NULL, '[]'
          )
        `;

        const purged = yield* archive.purgeThreadWithStatsSnapshot({
          threadId: "thread-message-checkpoint",
        });

        expect(purged).toBe(true);
        expect(deletedCheckpointRefCalls).toEqual([
          {
            cwd: "/work/message-checkpoint",
            checkpointRefs: [
              String(
                checkpointRefForThreadMessageStart(
                  ThreadId.makeUnsafe("thread-message-checkpoint"),
                  MessageId.makeUnsafe("message-pending-checkpoint"),
                ),
              ),
            ],
          },
        ]);
        const remainingRows = yield* sql<{ readonly messages: number; readonly turns: number }>`
          SELECT
            (
              SELECT COUNT(*)
              FROM projection_thread_messages
              WHERE thread_id = 'thread-message-checkpoint'
            ) AS messages,
            (
              SELECT COUNT(*)
              FROM projection_turns
              WHERE thread_id = 'thread-message-checkpoint'
            ) AS turns
        `;
        expect(remainingRows[0]).toEqual({ messages: 0, turns: 0 });
      }),
    );
  });

  it("purges thread rows when checkpoint cleanup workspace is stale", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const archive = yield* ProfileStatsArchive;
        isGitRepositoryImpl = () => Effect.succeed(false);

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
          )
          VALUES (
            'project-stale-checkpoint',
            'Stale Checkpoint',
            '/work/missing-checkpoint',
            '{}',
            '2026-06-12T09:00:00.000Z',
            '2026-06-12T09:00:00.000Z',
            NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          )
          VALUES (
            'thread-stale-checkpoint',
            'project-stale-checkpoint',
            'Stale Checkpoint',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access', 'default', 'local',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:05:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, source,
            created_at, updated_at
          )
          VALUES (
            'message-stale-checkpoint',
            'thread-stale-checkpoint',
            'turn-stale-checkpoint',
            'user',
            'stale checkpoint purge',
            0,
            'native',
            '2026-06-13T09:01:00.000Z',
            '2026-06-13T09:01:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_turn_count,
            checkpoint_ref, checkpoint_status, checkpoint_files_json
          )
          VALUES (
            'thread-stale-checkpoint',
            'turn-stale-checkpoint',
            NULL,
            NULL,
            'completed',
            '2026-06-13T09:01:00.000Z',
            '2026-06-13T09:01:10.000Z',
            '2026-06-13T09:02:00.000Z',
            1,
            'refs/historical/checkpoints/dGhyZWFkLXN0YWxlLWNoZWNrcG9pbnQ/turn/1',
            'captured',
            '[]'
          )
        `;
        yield* sql`
          INSERT INTO checkpoint_diff_blobs (
            thread_id, from_turn_count, to_turn_count, diff, created_at
          )
          VALUES (
            'thread-stale-checkpoint',
            0,
            1,
            'diff --git a/file b/file',
            '2026-06-13T09:02:00.000Z'
          )
        `;

        const purged = yield* archive.purgeThreadWithStatsSnapshot({
          threadId: "thread-stale-checkpoint",
        });

        expect(purged).toBe(true);
        expect(deletedCheckpointRefCalls).toEqual([]);
        const rows = yield* sql<{
          readonly threads: number;
          readonly messages: number;
          readonly turns: number;
          readonly diffBlobs: number;
        }>`
          SELECT
            (
              SELECT COUNT(*)
              FROM projection_threads
              WHERE thread_id = 'thread-stale-checkpoint'
            ) AS threads,
            (
              SELECT COUNT(*)
              FROM projection_thread_messages
              WHERE thread_id = 'thread-stale-checkpoint'
            ) AS messages,
            (
              SELECT COUNT(*)
              FROM projection_turns
              WHERE thread_id = 'thread-stale-checkpoint'
            ) AS turns,
            (
              SELECT COUNT(*)
              FROM checkpoint_diff_blobs
              WHERE thread_id = 'thread-stale-checkpoint'
            ) AS diffBlobs
        `;
        expect(rows[0]).toEqual({ threads: 0, messages: 0, turns: 0, diffBlobs: 0 });
      }),
    );
  });

  it("keeps checkpoint refs when the database purge transaction fails", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const archive = yield* ProfileStatsArchive;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
          )
          VALUES (
            'project-failed-purge',
            'Failed Purge',
            '/work/failed-purge',
            '{}',
            '2026-06-12T09:00:00.000Z',
            '2026-06-12T09:00:00.000Z',
            NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          )
          VALUES (
            'thread-failed-purge',
            'project-failed-purge',
            'Failed Purge',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access', 'default', 'local',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:05:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_turn_count,
            checkpoint_ref, checkpoint_status, checkpoint_files_json
          )
          VALUES (
            'thread-failed-purge',
            'turn-failed-purge',
            NULL,
            NULL,
            'completed',
            '2026-06-13T09:01:00.000Z',
            '2026-06-13T09:01:10.000Z',
            '2026-06-13T09:02:00.000Z',
            1,
            'refs/historical/checkpoints/dGhyZWFkLWZhaWxlZC1wdXJnZQ/turn/1',
            'captured',
            '[]'
          )
        `;

        yield* sql`DROP TABLE profile_stats_deleted_threads`;
        const exit = yield* Effect.exit(
          archive.purgeThreadWithStatsSnapshot({ threadId: "thread-failed-purge" }),
        );

        expect(exit._tag).toBe("Failure");
        expect(deletedCheckpointRefCalls).toEqual([]);
        const rows = yield* sql<{ readonly threads: number; readonly turns: number }>`
          SELECT
            (
              SELECT COUNT(*)
              FROM projection_threads
              WHERE thread_id = 'thread-failed-purge'
            ) AS threads,
            (
              SELECT COUNT(*)
              FROM projection_turns
              WHERE thread_id = 'thread-failed-purge'
            ) AS turns
        `;
        expect(rows[0]).toEqual({ threads: 1, turns: 1 });
      }),
    );
  });

  it("interrupts active automation runs before deleting the thread shell", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const archive = yield* ProfileStatsArchive;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
          )
          VALUES (
            'project-automation-purge',
            'Automation Purge',
            '/work/automation-purge',
            '{}',
            '2026-06-12T09:00:00.000Z',
            '2026-06-12T09:00:00.000Z',
            NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          )
          VALUES (
            'thread-automation-purge',
            'project-automation-purge',
            'Automation Purge',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access', 'default', 'local',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:05:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO automation_definitions (
            automation_id, project_id, source_thread_id, name, prompt, schedule_json,
            enabled, next_run_at, model_selection_json, provider_options_json, runtime_mode,
            interaction_mode, worktree_mode, mode, target_thread_id, max_iterations,
            stop_on_error, completion_policy_json, completion_policy_version,
            completion_policy_updated_at, minimum_interval_seconds, max_runtime_seconds,
            retry_policy_json, misfire_policy, acknowledged_risks_json, iteration_count,
            created_at, updated_at, archived_at
          )
          VALUES (
            'automation-purge',
            'project-automation-purge',
            NULL,
            'Automation Purge',
            'run it',
            '{"type":"manual"}',
            1,
            NULL,
            '{"provider":"codex","model":"gpt-5-codex"}',
            NULL,
            'full-access',
            'default',
            'reuse',
            'heartbeat',
            'thread-automation-purge',
            NULL,
            1,
            '{"type":"none"}',
            0,
            NULL,
            60,
            NULL,
            '{"type":"none"}',
            'skip',
            '[]',
            1,
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:00:00.000Z',
            NULL
          )
        `;
        yield* sql`
          INSERT INTO automation_runs (
            run_id, automation_id, project_id, thread_id, turn_id, trigger_type, status,
            scheduled_for, claimed_by, claimed_at, lease_expires_at, started_at, finished_at,
            thread_create_command_id, turn_start_command_id, message_id, error, result_json,
            permission_snapshot_json, created_at, updated_at
          )
          VALUES (
            'run-automation-purge',
            'automation-purge',
            'project-automation-purge',
            'thread-automation-purge',
            NULL,
            'scheduled',
            'running',
            '2026-06-13T09:00:00.000Z',
            'worker-1',
            '2026-06-13T09:00:05.000Z',
            '2026-06-13T09:10:00.000Z',
            '2026-06-13T09:00:10.000Z',
            NULL,
            NULL,
            'cmd-turn',
            'message-run',
            NULL,
            NULL,
            '{}',
            '2026-06-13T09:00:00.000Z',
            '2026-06-13T09:00:10.000Z'
          )
        `;

        const purged = yield* archive.purgeThreadWithStatsSnapshot({
          threadId: "thread-automation-purge",
        });

        expect(purged).toBe(true);
        const rows = yield* sql<{
          readonly threads: number;
          readonly runStatus: string;
          readonly error: string | null;
          readonly resultJson: string | null;
          readonly finishedAt: string | null;
          readonly claimedBy: string | null;
          readonly leaseExpiresAt: string | null;
        }>`
          SELECT
            (
              SELECT COUNT(*)
              FROM projection_threads
              WHERE thread_id = 'thread-automation-purge'
            ) AS threads,
            status AS runStatus,
            error,
            result_json AS resultJson,
            finished_at AS finishedAt,
            claimed_by AS claimedBy,
            lease_expires_at AS leaseExpiresAt
          FROM automation_runs
          WHERE run_id = 'run-automation-purge'
        `;
        const result = JSON.parse(rows[0]?.resultJson ?? "null") as {
          readonly outcome?: string;
          readonly severity?: string;
          readonly summary?: string;
        } | null;
        expect(rows[0]).toMatchObject({
          threads: 0,
          runStatus: "interrupted",
          error: "Automation run was interrupted because its thread was deleted.",
          finishedAt: "2026-06-13T09:05:00.000Z",
          claimedBy: null,
          leaseExpiresAt: null,
        });
        expect(result).toMatchObject({
          outcome: "needs-attention",
          severity: "warning",
          summary: "Automation run was interrupted because its thread was deleted.",
        });
      }),
    );
  });

  it("sweeps manually soft-deleted threads but leaves retention-hidden ones in place", async () => {
    await runArchiveTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;
        const archive = yield* ProfileStatsArchive;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          )
          VALUES
            (
              'thread-live', 'project-sweep', 'Live', '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access', 'default', 'local',
              '2026-06-13T09:00:00.000Z', '2026-06-13T09:00:00.000Z', NULL
            ),
            (
              'thread-manual', 'project-sweep', 'Manual',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access', 'default', 'local',
              '2026-06-13T09:00:00.000Z', '2026-06-13T09:00:00.000Z', '2026-06-15T10:00:00.000Z'
            ),
            (
              'thread-retention', 'project-sweep', 'Retention',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access', 'default', 'local',
              '2026-06-08T09:00:00.000Z', '2026-06-08T09:00:00.000Z', '2026-06-15T09:00:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, source,
            created_at, updated_at
          )
          VALUES
            (
              'message-manual-1', 'thread-manual', 'turn-manual-1', 'user', 'manual work',
              0, 'native', '2026-06-13T09:05:00.000Z', '2026-06-13T09:05:00.000Z'
            ),
            (
              'message-retention-1', 'thread-retention', 'turn-retention-1', 'user',
              'retention work',
              0, 'native', '2026-06-08T09:05:00.000Z', '2026-06-08T09:05:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, actor_kind, payload_json, metadata_json
          )
          VALUES
            (
              'event-manual-delete', 'thread', 'thread-manual', 1, 'thread.deleted',
              '2026-06-15T10:00:00.000Z', 'manual-delete:sweep-test', 'user',
              '{"threadId":"thread-manual","deletedAt":"2026-06-15T10:00:00.000Z"}', '{}'
            ),
            (
              'event-retention-delete', 'thread', 'thread-retention', 1, 'thread.deleted',
              '2026-06-15T09:00:00.000Z', 'thread-retention:sweep-test', 'system',
              '{"threadId":"thread-retention","deletedAt":"2026-06-15T09:00:00.000Z"}', '{}'
            )
        `;
        // The purge fence blocks while provider-intent events (thread.deleted
        // included) are still unconsumed; a real sweep only runs after the
        // reactor has acked them.
        yield* acknowledgeProviderCommandJournal(sql);

        const statsBefore = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        expect(statsBefore.activity.totalPromptsSent).toBe(2);
        expect(statsBefore.activity.totalThreads).toBe(3);

        const deferredThreadIds: string[] = [];
        const deferredCount = yield* archive.purgeSoftDeletedManualThreads({
          beforePurge: (threadId) =>
            Effect.sync(() => {
              deferredThreadIds.push(threadId);
              return false;
            }),
        });
        expect(deferredCount).toBe(0);
        expect(deferredThreadIds).toEqual(["thread-manual"]);

        const threadsAfterDeferred = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS threadId FROM projection_threads ORDER BY thread_id ASC
        `;
        expect(threadsAfterDeferred.map((row) => row.threadId)).toEqual([
          "thread-live",
          "thread-manual",
          "thread-retention",
        ]);

        const purgedCount = yield* archive.purgeSoftDeletedManualThreads();
        expect(purgedCount).toBe(1);

        const threadRows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS threadId FROM projection_threads ORDER BY thread_id ASC
        `;
        expect(threadRows.map((row) => row.threadId)).toEqual(["thread-live", "thread-retention"]);
        const tombstones = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS threadId FROM profile_stats_deleted_threads
        `;
        expect(tombstones.map((row) => row.threadId)).toEqual(["thread-manual"]);

        // Lifetime totals survive: retention rows stay live, manual work is archived.
        const statsAfter = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        expect(statsAfter.activity.totalPromptsSent).toBe(2);
        expect(statsAfter.activity.totalThreads).toBe(3);
      }),
    );
  });
});
