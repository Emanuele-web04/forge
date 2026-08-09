// FILE: profileStats.test.ts
// Purpose: Focused coverage for Profile stats SQL aggregation against the migrated SQLite schema.
// Layer: Server stats tests
// Exports: Vitest coverage for ProfileStatsQuery.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import {
  aggregateProfileSkillUsageRows,
  heatmapIntensity,
  ProfileStatsQuery,
  ProfileStatsQueryLive,
} from "./profileStats";

const testLayer = ProfileStatsQueryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-profile-stats-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

function runProfileStatsTest<A, E>(
  effect: Effect.Effect<A, E, ProfileStatsQuery | SqlClient.SqlClient>,
) {
  return effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
}

function sorted(counts: readonly number[]): number[] {
  return counts.toSorted((left, right) => left - right);
}

describe("heatmapIntensity", () => {
  it("returns level 0 for empty days and for an empty distribution", () => {
    expect(heatmapIntensity(0, [1, 2, 3])).toBe(0);
    expect(heatmapIntensity(500, [])).toBe(0);
  });

  it("spreads skewed token counts across all levels instead of collapsing to level 1", () => {
    // One spike day plus many small days: percent-of-max bucketing would put every
    // day except the spike at level 1.
    const counts = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 4_000_000];
    const levels = counts.map((count) => heatmapIntensity(count, sorted(counts)));
    expect(levels).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("keeps the busiest day at the top level and ranks quartiles in order", () => {
    const counts = Array.from({ length: 100 }, (_, index) => index + 1);
    const active = sorted(counts);
    expect(heatmapIntensity(1, active)).toBe(1);
    expect(heatmapIntensity(25, active)).toBe(1);
    expect(heatmapIntensity(26, active)).toBe(2);
    expect(heatmapIntensity(75, active)).toBe(3);
    expect(heatmapIntensity(76, active)).toBe(4);
    expect(heatmapIntensity(100, active)).toBe(4);
  });

  it("gives tied days the same level and renders a uniform window at full intensity", () => {
    const active = sorted([500, 500, 500, 500]);
    expect(active.map((count) => heatmapIntensity(count, active))).toEqual([4, 4, 4, 4]);
  });
});

describe("ProfileStatsQuery", () => {
  it("normalizes profile skill usage from structured refs plus slash and dollar prompt tokens", () => {
    expect(
      aggregateProfileSkillUsageRows([
        {
          messageId: "message-1",
          text: "Use $check-code and /refactor-code",
          skillsJson: JSON.stringify([
            { name: "check-code", path: "/skills/check-code/SKILL.md" },
            { name: "refactor-code", path: "/skills/refactor-code/SKILL.md" },
          ]),
          mentionsJson: null,
        },
        {
          messageId: "message-2",
          text: "Use /check-code again, but keep /plan plain, ignore /Users/test and $PATH",
          skillsJson: null,
          mentionsJson: JSON.stringify([{ name: "reviewer", path: "agent://reviewer" }]),
        },
        {
          messageId: "message-3",
          text: "Pi style /skill:planner should group as planner; shell $HOME and cost $100 do not",
          skillsJson: null,
          mentionsJson: null,
        },
      ]),
    ).toEqual([
      { name: "check-code", displayName: "$check-code", kind: "skill", runCount: 2 },
      { name: "planner", displayName: "$planner", kind: "skill", runCount: 1 },
      { name: "refactor-code", displayName: "$refactor-code", kind: "skill", runCount: 1 },
      { name: "reviewer", displayName: "@reviewer", kind: "agent", runCount: 1 },
    ]);
  });

  it("counts repeated slash and dollar skill tokens without double-counting structured echoes", () => {
    expect(
      aggregateProfileSkillUsageRows([
        {
          messageId: "message-repeat",
          text: "Use $check-code, /check-code, and /logic-consolidator /logic-consolidator",
          skillsJson: JSON.stringify([
            { name: "check-code", path: "/skills/check-code/SKILL.md" },
            { name: "logic-consolidator", path: "/skills/logic-consolidator/SKILL.md" },
          ]),
          mentionsJson: null,
        },
      ]),
    ).toEqual([
      { name: "check-code", displayName: "$check-code", kind: "skill", runCount: 2 },
      {
        name: "logic-consolidator",
        displayName: "$logic-consolidator",
        kind: "skill",
        runCount: 2,
      },
    ]);
  });

  it("does not count serialized prompt block closing tags as slash skills", () => {
    expect(
      aggregateProfileSkillUsageRows([
        {
          messageId: "message-blocks",
          text: [
            "Use /check-code for the actual request.",
            "<terminal_context>",
            "npm test",
            "</terminal_context>",
            "<file_comments>",
            "src/app.ts: leave this as-is",
            "</file_comments>",
            "<pasted_text>",
            '[{"text":"const value = $foo;\\nrun /deploy now"}]',
            "</pasted_text>",
          ].join("\n"),
          skillsJson: null,
          mentionsJson: null,
        },
      ]),
    ).toEqual([{ name: "check-code", displayName: "$check-code", kind: "skill", runCount: 1 }]);
  });

  it("aggregates prompts, model usage, provider usage, and reasoning from local projections", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'thread-codex',
              'project-profile',
              'Codex Thread',
              '{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              NULL
            ),
            (
              'thread-claude',
              'project-profile',
              'Claude Thread',
              '{"provider":"claudeAgent","model":"claude-sonnet-4-6","options":{"effort":"max"}}',
              'full-access',
              'default',
              'local',
              '2026-06-13T10:00:00.000Z',
              '2026-06-13T10:00:00.000Z',
              NULL
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            is_streaming,
            source,
            created_at,
            updated_at
          )
          VALUES
            (
              'message-codex-1',
              'thread-codex',
              'turn-codex-1',
              'user',
              'first',
              0,
              'native',
              '2026-06-13T09:05:00.000Z',
              '2026-06-13T09:05:00.000Z'
            ),
            (
              'message-codex-2',
              'thread-codex',
              'turn-codex-2',
              'user',
              'second',
              0,
              'native',
              '2026-06-13T09:35:00.000Z',
              '2026-06-13T09:35:00.000Z'
            ),
            (
              'message-claude-1',
              'thread-claude',
              'turn-claude-1',
              'user',
              'third',
              0,
              'native',
              '2026-06-14T10:05:00.000Z',
              '2026-06-14T10:05:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES
            (
              'event-codex-1',
              'thread',
              'thread-codex',
              1,
              'thread.turn-start-requested',
              '2026-06-13T09:05:00.000Z',
              'client',
              '{"threadId":"thread-codex","modelSelection":{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}}',
              '{}'
            ),
            (
              'event-codex-2',
              'thread',
              'thread-codex',
              2,
              'thread.turn-start-requested',
              '2026-06-13T09:35:00.000Z',
              'client',
              '{"threadId":"thread-codex","modelSelection":{"provider":"codex","model":"gpt-5-codex","options":{"reasoningEffort":"high"}}}',
              '{}'
            ),
            (
              'event-claude-1',
              'thread',
              'thread-claude',
              1,
              'thread.turn-start-requested',
              '2026-06-14T10:05:00.000Z',
              'client',
              '{"threadId":"thread-claude","modelSelection":{"provider":"claudeAgent","model":"claude-sonnet-4-6","options":{"effort":"max"}}}',
              '{}'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });

        expect(stats.activity.totalPromptsSent).toBe(3);
        expect(stats.activity.totalThreads).toBe(2);
        expect(stats.activeHours.startHour).toBe(9);
        expect(stats.activeHours.turnCount).toBe(2);
        expect(stats.insights.topProvider).toBe("codex");
        expect(stats.insights.topProviderPercent).toBeCloseTo(66.7);
        expect(stats.insights.topReasoning).toBe("high");
        expect(stats.insights.topReasoningPercent).toBeCloseTo(66.7);
        expect(stats.providerModels[0]).toMatchObject({
          provider: "codex",
          model: "gpt-5-codex",
          turnCount: 2,
        });
      }),
    );
  });

  it("scopes dispatch-origin joins when different threads reuse a message id", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES
            (
              'thread-reused-user', 'project-profile', 'User Thread',
              '{"provider":"codex","model":"gpt-5-codex"}', 'full-access',
              'default', 'local', '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z', NULL
            ),
            (
              'thread-reused-agent', 'project-profile', 'Agent Thread',
              '{"provider":"claudeAgent","model":"claude-sonnet-4-6"}', 'full-access',
              'default', 'local', '2026-06-13T10:00:00.000Z',
              '2026-06-13T10:00:00.000Z', NULL
            )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, dispatch_origin,
            is_streaming, source, created_at, updated_at
          ) VALUES
            (
              'shared-message-id', 'thread-reused-user', 'turn-user', 'user', 'human prompt',
              NULL, 0, 'native', '2026-06-13T09:05:00.000Z', '2026-06-13T09:05:00.000Z'
            ),
            (
              'shared-message-id', 'thread-reused-agent', 'turn-agent', 'user', 'agent prompt',
              'agent', 0, 'native', '2026-06-13T10:05:00.000Z', '2026-06-13T10:05:00.000Z'
            )
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json
          ) VALUES
            (
              'event-reused-user', 'thread', 'thread-reused-user', 1,
              'thread.turn-start-requested', '2026-06-13T09:05:00.000Z', 'client',
              '{"threadId":"thread-reused-user","messageId":"shared-message-id","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}'
            ),
            (
              'event-reused-agent', 'thread', 'thread-reused-agent', 1,
              'thread.turn-start-requested', '2026-06-13T10:05:00.000Z', 'system',
              '{"threadId":"thread-reused-agent","messageId":"shared-message-id","modelSelection":{"provider":"claudeAgent","model":"claude-sonnet-4-6"}}', '{}'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        expect(stats.insights.topProvider).toBe("codex");
        expect(stats.insights.topProviderPercent).toBe(100);
        expect(stats.providerModels).toEqual([
          expect.objectContaining({ provider: "codex", model: "gpt-5-codex", turnCount: 1 }),
        ]);
      }),
    );
  });

  it("reports token-based provider ranking separately from turn-count profile stats", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'thread-codex',
              'project-profile',
              'Codex Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              NULL
            ),
            (
              'thread-claude',
              'project-profile',
              'Claude Thread',
              '{"provider":"claudeAgent","model":"claude-sonnet-4-6"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T10:00:00.000Z',
              '2026-06-13T10:00:00.000Z',
              NULL
            )
        `;

        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES
            (
              'event-codex-1',
              'thread',
              'thread-codex',
              1,
              'thread.turn-start-requested',
              '2026-06-13T09:05:00.000Z',
              'client',
              '{"threadId":"thread-codex","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}',
              '{}'
            ),
            (
              'event-codex-2',
              'thread',
              'thread-codex',
              2,
              'thread.turn-start-requested',
              '2026-06-13T09:35:00.000Z',
              'client',
              '{"threadId":"thread-codex","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}',
              '{}'
            ),
            (
              'event-claude-1',
              'thread',
              'thread-claude',
              1,
              'thread.turn-start-requested',
              '2026-06-13T10:05:00.000Z',
              'client',
              '{"threadId":"thread-claude","modelSelection":{"provider":"claudeAgent","model":"claude-sonnet-4-6"}}',
              '{}'
            )
        `;

        // Codex has more turns (2 vs 1) but Claude processed far more tokens,
        // so core stats stay turn-ranked while token stats report Claude on top.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES
            (
              'activity-codex-1',
              'thread-codex',
              'turn-codex-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"totalProcessedTokens":1000}',
              1,
              '2026-06-13T09:06:00.000Z'
            ),
            (
              'activity-claude-1',
              'thread-claude',
              'turn-claude-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"totalProcessedTokens":5000}',
              1,
              '2026-06-13T10:06:00.000Z'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });
        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });

        expect(stats.insights.topProvider).toBe("codex");
        expect(stats.insights.topProviderPercent).toBeCloseTo(66.7);
        expect(tokenStats.topProvider).toBe("claudeAgent");
        expect(tokenStats.topProviderPercent).toBeCloseTo(83.3);
        expect(tokenStats.providers).toEqual(["claudeAgent", "codex"]);
        // Token-based model mix mirrors the token ranking, not the turn counts.
        expect(tokenStats.models).toEqual([
          { provider: "claudeAgent", model: "claude-sonnet-4-6", tokens: 5000, percent: 83.3 },
          { provider: "codex", model: "gpt-5-codex", tokens: 1000, percent: 16.7 },
        ]);
        // Turn-based provider/model mix is unchanged by the token ranking.
        expect(stats.providerModels[0]).toMatchObject({ provider: "codex", turnCount: 2 });
      }),
    );
  });

  it("attributes token deltas to the model selected for each turn, including usedTokens-only adapters", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        // thread-switch is currently on Opus, but the first turn ran on Fable.
        // Attributing by the thread's latest selection would hand every token to
        // Opus. thread-mixed reports BOTH counters: only the cumulative rows may
        // drive its series, or the dip recovery would double-count.
        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'thread-switch',
              'project-profile',
              'Switch Thread',
              '{"provider":"claudeAgent","model":"claude-opus-4-8"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              NULL
            ),
            (
              'thread-mixed',
              'project-profile',
              'Mixed Counters Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T11:00:00.000Z',
              '2026-06-13T11:00:00.000Z',
              NULL
            )
        `;

        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES
            (
              'event-switch-1',
              'thread',
              'thread-switch',
              1,
              'thread.turn-start-requested',
              '2026-06-13T09:01:00.000Z',
              'client',
              '{"threadId":"thread-switch","messageId":"message-switch-1","modelSelection":{"provider":"claudeAgent","model":"claude-fable-5"}}',
              '{}'
            ),
            (
              'event-switch-2',
              'thread',
              'thread-switch',
              2,
              'thread.turn-start-requested',
              '2026-06-13T09:20:00.000Z',
              'client',
              '{"threadId":"thread-switch","messageId":"message-switch-2","modelSelection":{"provider":"claudeAgent","model":"claude-opus-4-8"}}',
              '{}'
            )
        `;

        yield* sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            pending_message_id,
            state,
            requested_at,
            checkpoint_files_json
          )
          VALUES
            (
              'thread-switch',
              'turn-switch-1',
              'message-switch-1',
              'completed',
              '2026-06-13T09:01:00.000Z',
              '[]'
            ),
            (
              'thread-switch',
              'turn-switch-2',
              'message-switch-2',
              'completed',
              '2026-06-13T09:20:00.000Z',
              '[]'
            )
        `;

        // thread-switch never reports the cumulative counter (like the Claude
        // adapter below the context window), so usedTokens drives its series.
        // thread-mixed dips to context scale mid-thread and recovers: only the
        // cumulative rows count (6000 total, not 6000 + the dip recovery).
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES
            (
              'activity-switch-1',
              'thread-switch',
              'turn-switch-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":1000}',
              1,
              '2026-06-13T09:02:00.000Z'
            ),
            (
              'activity-switch-2',
              'thread-switch',
              'turn-switch-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":3000}',
              2,
              '2026-06-13T09:03:00.000Z'
            ),
            (
              'activity-switch-3',
              'thread-switch',
              'turn-switch-2',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":5000}',
              3,
              '2026-06-13T09:21:00.000Z'
            ),
            (
              'activity-mixed-1',
              'thread-mixed',
              'turn-mixed-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":3000,"totalProcessedTokens":4000}',
              1,
              '2026-06-13T11:02:00.000Z'
            ),
            (
              'activity-mixed-2',
              'thread-mixed',
              'turn-mixed-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":500}',
              2,
              '2026-06-13T11:03:00.000Z'
            ),
            (
              'activity-mixed-3',
              'thread-mixed',
              'turn-mixed-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":4500,"totalProcessedTokens":6000}',
              3,
              '2026-06-13T11:04:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });

        expect(tokenStats.available).toBe(true);
        expect(tokenStats.lifetimeTotalTokens).toBe(11000);
        expect(tokenStats.topProvider).toBe("codex");
        expect(tokenStats.models).toEqual([
          { provider: "codex", model: "gpt-5-codex", tokens: 6000, percent: 54.5 },
          { provider: "claudeAgent", model: "claude-fable-5", tokens: 3000, percent: 27.3 },
          { provider: "claudeAgent", model: "claude-opus-4-8", tokens: 2000, percent: 18.2 },
        ]);
      }),
    );
  });

  it("counts usedTokens-only model groups in threads that also have cumulative telemetry", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'thread-hybrid',
            'project-profile',
            'Hybrid Telemetry Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            'local',
            '2026-06-13T12:00:00.000Z',
            '2026-06-13T12:00:00.000Z',
            NULL
          )
        `;

        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES
            (
              'event-hybrid-codex',
              'thread',
              'thread-hybrid',
              1,
              'thread.turn-start-requested',
              '2026-06-13T12:01:00.000Z',
              'client',
              '{"threadId":"thread-hybrid","messageId":"message-hybrid-codex","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}',
              '{}'
            ),
            (
              'event-hybrid-claude',
              'thread',
              'thread-hybrid',
              2,
              'thread.turn-start-requested',
              '2026-06-13T12:10:00.000Z',
              'client',
              '{"threadId":"thread-hybrid","messageId":"message-hybrid-claude","modelSelection":{"provider":"claudeAgent","model":"claude-haiku-4-5"}}',
              '{}'
            )
        `;

        yield* sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            pending_message_id,
            state,
            requested_at,
            checkpoint_files_json
          )
          VALUES
            (
              'thread-hybrid',
              'turn-hybrid-codex',
              'message-hybrid-codex',
              'completed',
              '2026-06-13T12:01:00.000Z',
              '[]'
            ),
            (
              'thread-hybrid',
              'turn-hybrid-claude',
              'message-hybrid-claude',
              'completed',
              '2026-06-13T12:10:00.000Z',
              '[]'
            )
        `;

        // Codex has cumulative totals, so its usedTokens-only dip is ignored.
        // Claude never reports cumulative totals in this thread, so its own
        // usedTokens series is still counted instead of being dropped.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES
            (
              'activity-hybrid-codex-1',
              'thread-hybrid',
              'turn-hybrid-codex',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":1200,"totalProcessedTokens":2000}',
              1,
              '2026-06-13T12:02:00.000Z'
            ),
            (
              'activity-hybrid-codex-dip',
              'thread-hybrid',
              'turn-hybrid-codex',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":300}',
              2,
              '2026-06-13T12:03:00.000Z'
            ),
            (
              'activity-hybrid-codex-2',
              'thread-hybrid',
              'turn-hybrid-codex',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":1500,"totalProcessedTokens":2500}',
              3,
              '2026-06-13T12:04:00.000Z'
            ),
            (
              'activity-hybrid-codex-completed',
              'thread-hybrid',
              'turn-hybrid-codex',
              'info',
              'turn.completed',
              'Turn completed',
              '{"modelUsage":{"gpt-5-codex":{"totalTokens":2500}}}',
              6,
              '2026-06-13T12:05:00.000Z'
            ),
            (
              'activity-hybrid-claude-1',
              'thread-hybrid',
              'turn-hybrid-claude',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":700}',
              4,
              '2026-06-13T12:11:00.000Z'
            ),
            (
              'activity-hybrid-claude-2',
              'thread-hybrid',
              'turn-hybrid-claude',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"usedTokens":1700}',
              5,
              '2026-06-13T12:12:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });

        expect(tokenStats.lifetimeTotalTokens).toBe(4200);
        expect(tokenStats.models).toEqual([
          { provider: "codex", model: "gpt-5-codex", tokens: 2500, percent: 59.5 },
          { provider: "claudeAgent", model: "claude-haiku-4-5", tokens: 1700, percent: 40.5 },
        ]);
      }),
    );
  });

  it("counts slash skill invocations from projected thread message text and groups them with dollar usage", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'thread-skills',
              'project-profile',
              'Skill Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-14T09:00:00.000Z',
              '2026-06-14T09:00:00.000Z',
              NULL
            ),
            (
              'thread-retention-hidden',
              'project-profile',
              'Retention Hidden Skill Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-08T09:00:00.000Z',
              '2026-06-08T09:00:00.000Z',
              '2026-06-15T09:00:00.000Z'
            ),
            (
              'thread-manual-deleted',
              'project-profile',
              'Manual Deleted Skill Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-08T10:00:00.000Z',
              '2026-06-08T10:00:00.000Z',
              '2026-06-15T10:00:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES
            (
              'event-retention-hidden-delete',
              'thread',
              'thread-retention-hidden',
              1,
              'thread.deleted',
              '2026-06-15T09:00:00.000Z',
              'thread-retention:test-hidden',
              'system',
              '{"threadId":"thread-retention-hidden","deletedAt":"2026-06-15T09:00:00.000Z"}',
              '{}'
            ),
            (
              'event-manual-delete',
              'thread',
              'thread-manual-deleted',
              1,
              'thread.deleted',
              '2026-06-15T10:00:00.000Z',
              'manual-delete:test-hidden',
              'user',
              '{"threadId":"thread-manual-deleted","deletedAt":"2026-06-15T10:00:00.000Z"}',
              '{}'
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            skills_json,
            mentions_json,
            is_streaming,
            source,
            created_at,
            updated_at
          )
          VALUES
            (
              'message-skill-1',
              'thread-skills',
              'turn-skill-1',
              'user',
              'Use $check-code and /refactor-code',
              '[{"name":"check-code","path":"/skills/check-code/SKILL.md"},{"name":"refactor-code","path":"/skills/refactor-code/SKILL.md"}]',
              NULL,
              0,
              'native',
              '2026-06-14T09:05:00.000Z',
              '2026-06-14T09:05:00.000Z'
            ),
            (
              'message-skill-2',
              'thread-skills',
              'turn-skill-2',
              'user',
              'Use /check-code and /skill:planner, ignore /plan, /Users/test, $PATH, and $100',
              NULL,
              '[{"name":"reviewer","path":"agent://reviewer"}]',
              0,
              'native',
              '2026-06-14T09:35:00.000Z',
              '2026-06-14T09:35:00.000Z'
            ),
            (
              'message-skill-retention-hidden',
              'thread-retention-hidden',
              'turn-skill-retention-hidden',
              'user',
              'Retention-hidden /check-code and $check-code should still count',
              '[{"name":"check-code","path":"/skills/check-code/SKILL.md"}]',
              NULL,
              0,
              'native',
              '2026-06-08T09:05:00.000Z',
              '2026-06-08T09:05:00.000Z'
            ),
            (
              'message-skill-manual-deleted',
              'thread-manual-deleted',
              'turn-skill-manual-deleted',
              'user',
              'Manual deleted /openai-docs should still count',
              '[{"name":"openai-docs","path":"/skills/openai-docs/SKILL.md"}]',
              NULL,
              0,
              'native',
              '2026-06-08T10:05:00.000Z',
              '2026-06-08T10:05:00.000Z'
            ),
            (
              'message-skill-import',
              'thread-skills',
              'turn-skill-import',
              'user',
              'Imported /imported-skill should not count',
              '[{"name":"imported-skill","path":"/skills/imported-skill/SKILL.md"}]',
              NULL,
              0,
              'handoff-import',
              '2026-06-14T09:45:00.000Z',
              '2026-06-14T09:45:00.000Z'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });

        // Retention-hidden and manually deleted threads both keep contributing:
        // profile stats are lifetime totals and deletion is only a soft hide.
        expect(stats.insights.skillsExplored).toBe(5);
        expect(stats.insights.totalSkillsUsed).toBe(8);
        expect(stats.activity.totalPromptsSent).toBe(4);
        expect(stats.activity.totalThreads).toBe(3);
        expect(stats.skills.slice(0, 5)).toEqual([
          { name: "check-code", displayName: "$check-code", kind: "skill", runCount: 4 },
          { name: "openai-docs", displayName: "$openai-docs", kind: "skill", runCount: 1 },
          { name: "planner", displayName: "$planner", kind: "skill", runCount: 1 },
          { name: "refactor-code", displayName: "$refactor-code", kind: "skill", runCount: 1 },
          { name: "reviewer", displayName: "@reviewer", kind: "agent", runCount: 1 },
        ]);
      }),
    );
  });

  it("keeps deleted threads and deleted projects in the most-worked ranking", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'project-alpha',
              'Alpha',
              '/work/alpha',
              '{}',
              '2026-06-12T09:00:00.000Z',
              '2026-06-12T09:00:00.000Z',
              NULL
            ),
            (
              'project-beta',
              'Beta',
              '/work/beta',
              '{}',
              '2026-06-12T09:00:00.000Z',
              '2026-06-12T09:00:00.000Z',
              NULL
            ),
            (
              'project-deleted',
              'Deleted',
              '/work/deleted',
              '{}',
              '2026-06-12T09:00:00.000Z',
              '2026-06-12T09:00:00.000Z',
              '2026-06-14T09:00:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'thread-alpha',
              'project-alpha',
              'Alpha Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              NULL
            ),
            (
              'thread-beta',
              'project-beta',
              'Beta Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              NULL
            ),
            (
              'thread-alpha-deleted',
              'project-alpha',
              'Deleted Alpha Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              '2026-06-14T09:00:00.000Z'
            ),
            (
              'thread-deleted-project',
              'project-deleted',
              'Deleted Project Thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              'local',
              '2026-06-13T09:00:00.000Z',
              '2026-06-13T09:00:00.000Z',
              NULL
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            is_streaming,
            source,
            created_at,
            updated_at
          )
          VALUES
            (
              'message-alpha-1',
              'thread-alpha',
              'turn-alpha-1',
              'user',
              'alpha one',
              0,
              'native',
              '2026-06-13T09:05:00.000Z',
              '2026-06-13T09:05:00.000Z'
            ),
            (
              'message-alpha-2',
              'thread-alpha',
              'turn-alpha-2',
              'user',
              'alpha two',
              0,
              'native',
              '2026-06-13T09:35:00.000Z',
              '2026-06-13T09:35:00.000Z'
            ),
            (
              'message-beta-1',
              'thread-beta',
              'turn-beta-1',
              'user',
              'beta one',
              0,
              'native',
              '2026-06-13T10:05:00.000Z',
              '2026-06-13T10:05:00.000Z'
            ),
            (
              'message-beta-2',
              'thread-beta',
              'turn-beta-2',
              'user',
              'beta two',
              0,
              'native',
              '2026-06-14T10:05:00.000Z',
              '2026-06-14T10:05:00.000Z'
            ),
            (
              'message-beta-3',
              'thread-beta',
              'turn-beta-3',
              'user',
              'beta three',
              0,
              'native',
              '2026-06-14T10:35:00.000Z',
              '2026-06-14T10:35:00.000Z'
            ),
            (
              'message-alpha-deleted-thread',
              'thread-alpha-deleted',
              'turn-alpha-deleted',
              'user',
              'deleted thread still counts',
              0,
              'native',
              '2026-06-14T11:05:00.000Z',
              '2026-06-14T11:05:00.000Z'
            ),
            (
              'message-deleted-project',
              'thread-deleted-project',
              'turn-deleted-project',
              'user',
              'deleted project still counts',
              0,
              'native',
              '2026-06-14T11:35:00.000Z',
              '2026-06-14T11:35:00.000Z'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });

        // Lifetime totals: deleted threads/projects keep their contribution.
        expect(stats.activity.totalPromptsSent).toBe(7);
        expect(stats.activity.totalThreads).toBe(4);
        // Alpha and Beta tie on prompts (3) and active days (2); the deleted
        // Alpha thread's later prompt breaks the tie via lastWorkedAt.
        expect(stats.mostWorkedProject).toEqual({
          projectId: "project-alpha",
          title: "Alpha",
          workspaceRoot: "/work/alpha",
          promptCount: 3,
          threadCount: 2,
          activeDays: 2,
          lastWorkedAt: "2026-06-14T11:05:00.000Z",
        });
      }),
    );
  });

  it("computes longest streak from all prompt days instead of only the heatmap window", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'project-streak',
            'Streak',
            '/work/streak',
            '{}',
            '2025-01-01T09:00:00.000Z',
            '2025-01-01T09:00:00.000Z',
            NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'thread-streak',
            'project-streak',
            'Streak Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            'local',
            '2025-01-01T09:00:00.000Z',
            '2025-01-03T09:00:00.000Z',
            NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            is_streaming,
            source,
            created_at,
            updated_at
          )
          VALUES
            (
              'message-streak-1',
              'thread-streak',
              'turn-streak-1',
              'user',
              'day one',
              0,
              'native',
              '2025-01-01T09:05:00.000Z',
              '2025-01-01T09:05:00.000Z'
            ),
            (
              'message-streak-2',
              'thread-streak',
              'turn-streak-2',
              'user',
              'day two',
              0,
              'native',
              '2025-01-02T09:05:00.000Z',
              '2025-01-02T09:05:00.000Z'
            ),
            (
              'message-streak-3',
              'thread-streak',
              'turn-streak-3',
              'user',
              'day three',
              0,
              'native',
              '2025-01-03T09:05:00.000Z',
              '2025-01-03T09:05:00.000Z'
            )
        `;

        const stats = yield* statsQuery.getProfileStats({ utcOffsetMinutes: 0 });

        expect(stats.activity.totalPromptsSent).toBe(3);
        expect(stats.activity.longestStreakDays).toBe(3);
      }),
    );
  });

  it("delta-calculates cumulative turn costs and counts a day thread once", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-provider-usage-cost', 'project-profile', 'Provider usage cost',
            '{"provider":"opencode","model":"openai/gpt-5"}',
            'full-access', 'default', 'local',
            '2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z', NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            (
              'activity-provider-usage-turn-1', 'thread-provider-usage-cost', 'turn-provider-usage-1',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":1.25,"modelUsage":{"openai/gpt-5":{"totalTokens":75}}}', 1,
              '2026-06-15T09:05:00.000Z'
            ),
            (
              'activity-provider-usage-turn-2', 'thread-provider-usage-cost', 'turn-provider-usage-2',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":3.75,"modelUsage":{"anthropic/claude-sonnet-4-6":{"totalTokens":125}}}', 2,
              '2026-06-15T09:15:00.000Z'
            ),
            (
              'activity-provider-usage-tokens-1', 'thread-provider-usage-cost', 'turn-provider-usage-1',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":100,"provider":"opencode"}', 3,
              '2026-06-15T09:06:00.000Z'
            ),
            (
              'activity-provider-usage-tokens-2', 'thread-provider-usage-cost', 'turn-provider-usage-2',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":220,"provider":"opencode"}', 4,
              '2026-06-15T09:16:00.000Z'
            ),
            (
              'activity-provider-usage-turn-3', 'thread-provider-usage-cost', 'turn-provider-usage-3',
              'info', 'turn.completed', 'Turn completed',
              '{}', 5,
              '2026-06-15T09:25:00.000Z'
            ),
            (
              'activity-provider-usage-turn-4', 'thread-provider-usage-cost', 'turn-provider-usage-4',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":5.00}', 6,
              '2026-06-15T09:35:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        const usage = tokenStats.providerUsage?.find((entry) => entry.provider === "opencode");

        expect(usage).toMatchObject({
          tokens: 200,
          tokensReported: true,
          tokenCoverage: "partial",
          turnCount: 4,
          threadCount: 1,
          costUsd: 5,
          costCoverage: "partial",
        });
        expect(usage?.history).toEqual([
          {
            day: "2026-06-15",
            tokens: 200,
            turnCount: 4,
            threadCount: 1,
            costUsd: 5,
          },
        ]);
        expect(usage?.models).toEqual([
          expect.objectContaining({
            model: "anthropic/claude-sonnet-4-6",
            tokens: 125,
            upstreamProviderId: "anthropic",
          }),
          expect.objectContaining({
            model: "openai/gpt-5",
            tokens: 75,
            upstreamProviderId: "openai",
          }),
        ]);
      }),
    );
  });

  it("uses the activity provider stamp when a legacy thread has malformed model JSON", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            env_mode,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'thread-legacy-bad-json',
            'project-profile',
            'Legacy Bad JSON',
            '{bad-json',
            'full-access',
            'default',
            'local',
            '2026-06-14T09:00:00.000Z',
            '2026-06-14T09:00:00.000Z',
            NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES
            (
              'activity-token-1',
              'thread-legacy-bad-json',
              'turn-legacy-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"totalProcessedTokens":1000,"provider":"claudeAgent"}',
              1,
              '2026-06-14T09:05:00.000Z'
            ),
            (
              'activity-token-2',
              'thread-legacy-bad-json',
              'turn-legacy-1',
              'info',
              'context-window.updated',
              'tokens updated',
              '{"totalProcessedTokens":1500,"provider":"claudeAgent"}',
              2,
              '2026-06-14T09:10:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });

        expect(tokenStats.available).toBe(true);
        expect(tokenStats.lifetimeTotalTokens).toBe(1500);
        expect(tokenStats.providers).toEqual(["claudeAgent"]);
        expect(tokenStats.models).toEqual([
          { provider: "claudeAgent", model: "unknown", tokens: 1500, percent: 100 },
        ]);
      }),
    );
  });

  it("reports token coverage per provider as complete, partial, or not-reported", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES
            (
              'thread-coverage-complete', 'project-profile', 'Complete',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access', 'default', 'local',
              '2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z', NULL
            ),
            (
              'thread-coverage-mixed', 'project-profile', 'Mixed',
              '{"provider":"cursor","model":"cursor-model"}',
              'full-access', 'default', 'local',
              '2026-06-15T10:00:00.000Z', '2026-06-15T10:00:00.000Z', NULL
            ),
            (
              'thread-coverage-none', 'project-profile', 'None',
              '{"provider":"claudeAgent","model":"claude-sonnet-4-6"}',
              'full-access', 'default', 'local',
              '2026-06-15T11:00:00.000Z', '2026-06-15T11:00:00.000Z', NULL
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            (
              'coverage-complete-1', 'thread-coverage-complete', 'turn-complete-1',
              'info', 'turn.completed', 'Turn completed',
              '{"modelUsage":{"openai/gpt-5":{"totalTokens":50}}}', 1,
              '2026-06-15T09:05:00.000Z'
            ),
            (
              'coverage-complete-2', 'thread-coverage-complete', 'turn-complete-2',
              'info', 'turn.completed', 'Turn completed',
              '{"modelUsage":{"anthropic/claude-sonnet-4-6":{"totalTokens":50}}}', 2,
              '2026-06-15T09:10:00.000Z'
            ),
            (
              'coverage-mixed-1', 'thread-coverage-mixed', 'turn-mixed-1',
              'info', 'turn.completed', 'Turn completed',
              '{"modelUsage":{"openai/gpt-5":{"totalTokens":30}}}', 1,
              '2026-06-15T10:05:00.000Z'
            ),
            (
              'coverage-mixed-2', 'thread-coverage-mixed', 'turn-mixed-2',
              'info', 'turn.completed', 'Turn completed',
              '{}', 2,
              '2026-06-15T10:10:00.000Z'
            ),
            (
              'coverage-none-1', 'thread-coverage-none', 'turn-none-1',
              'info', 'turn.completed', 'Turn completed',
              '{}', 1,
              '2026-06-15T11:05:00.000Z'
            ),
            (
              'coverage-none-2', 'thread-coverage-none', 'turn-none-2',
              'info', 'turn.completed', 'Turn completed',
              '{}', 2,
              '2026-06-15T11:10:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        const usage = tokenStats.providerUsage;
        expect(usage?.find((entry) => entry.provider === "codex")?.tokenCoverage).toBe("complete");
        expect(usage?.find((entry) => entry.provider === "cursor")?.tokenCoverage).toBe("partial");
        expect(usage?.find((entry) => entry.provider === "claudeAgent")?.tokenCoverage).toBe(
          "not-reported",
        );
      }),
    );
  });

  it("marks a provider partial when evidenced and non-evidenced turns land in different model rows", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-coverage-split', 'project-profile', 'Coverage Split',
            '{"provider":"cursor","model":"cursor-base"}',
            'full-access', 'default', 'local',
            '2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z', NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
          ) VALUES
            ('thread-coverage-split', 'turn-split-a', 'message-split-a', 'completed', '2026-06-15T09:01:00.000Z', '[]'),
            ('thread-coverage-split', 'turn-split-b', 'message-split-b', 'completed', '2026-06-15T09:11:00.000Z', '[]')
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, dispatch_origin,
            is_streaming, source, created_at, updated_at
          ) VALUES
            ('message-split-a', 'thread-coverage-split', 'turn-split-a', 'user', 'a', NULL, 0, 'native', '2026-06-15T09:01:00.000Z', '2026-06-15T09:01:00.000Z'),
            ('message-split-b', 'thread-coverage-split', 'turn-split-b', 'user', 'b', NULL, 0, 'native', '2026-06-15T09:11:00.000Z', '2026-06-15T09:11:00.000Z')
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json
          ) VALUES
            (
              'event-split-a', 'thread', 'thread-coverage-split', 1,
              'thread.turn-start-requested', '2026-06-15T09:01:00.000Z', 'client',
              '{"threadId":"thread-coverage-split","messageId":"message-split-a","modelSelection":{"provider":"cursor","model":"cursor-model-a"}}', '{}'
            ),
            (
              'event-split-b', 'thread', 'thread-coverage-split', 2,
              'thread.turn-start-requested', '2026-06-15T09:11:00.000Z', 'client',
              '{"threadId":"thread-coverage-split","messageId":"message-split-b","modelSelection":{"provider":"cursor","model":"cursor-model-b"}}', '{}'
            )
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            (
              'split-turn-a', 'thread-coverage-split', 'turn-split-a',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":1.00}', 1, '2026-06-15T09:05:00.000Z'
            ),
            (
              'split-evidence-a', 'thread-coverage-split', 'turn-split-a',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":100,"provider":"cursor"}', 2, '2026-06-15T09:06:00.000Z'
            ),
            (
              'split-turn-b', 'thread-coverage-split', 'turn-split-b',
              'info', 'turn.completed', 'Turn completed',
              '{}', 3, '2026-06-15T09:15:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        const usage = tokenStats.providerUsage?.find((entry) => entry.provider === "cursor");
        // turn-split-a (cursor-model-a) reports tokens; turn-split-b
        // (cursor-model-b) does not. They land in different rows, so the
        // provider must still aggregate to partial — never complete.
        expect(usage).toMatchObject({ turnCount: 2, tokenCoverage: "partial" });
      }),
    );
  });

  it("computes cumulative token deltas before replacing modelUsage turns so nothing is double counted", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-delta-order', 'project-profile', 'Delta Order',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access', 'default', 'local',
            '2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z', NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            (
              'delta-order-a', 'thread-delta-order', 'turn-delta-a',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":100,"provider":"codex"}', 1,
              '2026-06-15T09:05:00.000Z'
            ),
            (
              'delta-order-m', 'thread-delta-order', 'turn-delta-m',
              'info', 'turn.completed', 'Turn completed',
              '{"modelUsage":{"openai/gpt-5":{"totalTokens":80}}}', 2,
              '2026-06-15T09:15:00.000Z'
            ),
            (
              'delta-order-m-row', 'thread-delta-order', 'turn-delta-m',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":180,"provider":"codex"}', 3,
              '2026-06-15T09:16:00.000Z'
            ),
            (
              'delta-order-b', 'thread-delta-order', 'turn-delta-b',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":300,"provider":"codex"}', 4,
              '2026-06-15T09:25:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        // 100 (A) + 80 (modelUsage) + 120 (B minus the kept M-row baseline 180) = 300.
        expect(tokenStats.lifetimeTotalTokens).toBe(300);
        const usage = tokenStats.providerUsage?.find((entry) => entry.provider === "codex");
        expect(usage?.tokens).toBe(300);
        expect(usage?.models.find((model) => model.model === "openai/gpt-5")?.tokens).toBe(80);
      }),
    );
  });

  it("excludes automation turn costs after computing the cumulative delta", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-cost-dispatch', 'project-profile', 'Cost Dispatch',
            '{"provider":"opencode","model":"openai/gpt-5"}',
            'full-access', 'default', 'local',
            '2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z', NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
          ) VALUES
            ('thread-cost-dispatch', 'turn-cost-1', 'message-user-1', 'completed', '2026-06-15T09:01:00.000Z', '[]'),
            ('thread-cost-dispatch', 'turn-cost-2', 'message-agent-1', 'completed', '2026-06-15T09:11:00.000Z', '[]'),
            ('thread-cost-dispatch', 'turn-cost-3', 'message-user-2', 'completed', '2026-06-15T09:21:00.000Z', '[]')
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, dispatch_origin,
            is_streaming, source, created_at, updated_at
          ) VALUES
            ('message-user-1', 'thread-cost-dispatch', 'turn-cost-1', 'user', 'first', NULL, 0, 'native', '2026-06-15T09:01:00.000Z', '2026-06-15T09:01:00.000Z'),
            ('message-agent-1', 'thread-cost-dispatch', 'turn-cost-2', 'user', 'agent run', 'agent', 0, 'native', '2026-06-15T09:11:00.000Z', '2026-06-15T09:11:00.000Z'),
            ('message-user-2', 'thread-cost-dispatch', 'turn-cost-3', 'user', 'second', NULL, 0, 'native', '2026-06-15T09:21:00.000Z', '2026-06-15T09:21:00.000Z')
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            (
              'cost-dispatch-1', 'thread-cost-dispatch', 'turn-cost-1',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":1.00}', 1, '2026-06-15T09:05:00.000Z'
            ),
            (
              'cost-dispatch-2', 'thread-cost-dispatch', 'turn-cost-2',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":1.60}', 2, '2026-06-15T09:15:00.000Z'
            ),
            (
              'cost-dispatch-3', 'thread-cost-dispatch', 'turn-cost-3',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":2.00}', 3, '2026-06-15T09:25:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        const usage = tokenStats.providerUsage?.find((entry) => entry.provider === "opencode");
        // Deltas run over the full sequence (1.00 + 0.60 + 0.40); the agent turn
        // is then filtered, so the provider total is 1.40, not the session's
        // final cumulative value 2.00.
        expect(usage).toMatchObject({ turnCount: 2, costUsd: 1.4, costCoverage: "complete" });
      }),
    );
  });

  it("sums per-message OpenCode/Kilo token totals instead of delta-differencing them", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES
            (
              'thread-opencode-pm', 'project-profile', 'OpenCode Per Message',
              '{"provider":"opencode","model":"openai/gpt-5"}',
              'full-access', 'default', 'local',
              '2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z', NULL
            ),
            (
              'thread-kilo-pm', 'project-profile', 'Kilo Per Message',
              '{"provider":"kilo","model":"openai/gpt-5"}',
              'full-access', 'default', 'local',
              '2026-06-15T10:00:00.000Z', '2026-06-15T10:00:00.000Z', NULL
            ),
            (
              'thread-cursor-pm', 'project-profile', 'Cursor Cumulative',
              '{"provider":"cursor","model":"cursor-model"}',
              'full-access', 'default', 'local',
              '2026-06-15T11:00:00.000Z', '2026-06-15T11:00:00.000Z', NULL
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            (
              'opencode-pm-1', 'thread-opencode-pm', 'turn-opencode-1',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":190,"provider":"opencode"}', 1, '2026-06-15T09:05:00.000Z'
            ),
            (
              'opencode-pm-2', 'thread-opencode-pm', 'turn-opencode-2',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":325,"provider":"opencode"}', 2, '2026-06-15T09:10:00.000Z'
            ),
            (
              'kilo-pm-1', 'thread-kilo-pm', 'turn-kilo-1',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":190,"provider":"kilo"}', 1, '2026-06-15T10:05:00.000Z'
            ),
            (
              'kilo-pm-2', 'thread-kilo-pm', 'turn-kilo-2',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":325,"provider":"kilo"}', 2, '2026-06-15T10:10:00.000Z'
            ),
            (
              'cursor-pm-1', 'thread-cursor-pm', 'turn-cursor-1',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":190,"provider":"cursor"}', 1, '2026-06-15T11:05:00.000Z'
            ),
            (
              'cursor-pm-2', 'thread-cursor-pm', 'turn-cursor-2',
              'info', 'context-window.updated', 'Tokens updated',
              '{"totalProcessedTokens":325,"provider":"cursor"}', 2, '2026-06-15T11:10:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        const usage = tokenStats.providerUsage;
        // OpenCode/Kilo per-message totals sum raw (190 + 325 = 515); a
        // cumulative provider stays delta-based (190 + 135 = 325).
        expect(usage?.find((entry) => entry.provider === "opencode")?.tokens).toBe(515);
        expect(usage?.find((entry) => entry.provider === "kilo")?.tokens).toBe(515);
        expect(usage?.find((entry) => entry.provider === "cursor")?.tokens).toBe(325);
      }),
    );
  });

  it("resets cumulative cost baselines across provider switches inside one thread", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-cost-collision', 'project-profile', 'Cost Collision',
            '{"provider":"cursor","model":"cursor-base"}',
            'full-access', 'default', 'local',
            '2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z', NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
          ) VALUES
            ('thread-cost-collision', 'turn-collision-a1', 'message-collision-a1', 'completed', '2026-06-15T09:01:00.000Z', '[]'),
            ('thread-cost-collision', 'turn-collision-b1', 'message-collision-b1', 'completed', '2026-06-15T09:11:00.000Z', '[]'),
            ('thread-cost-collision', 'turn-collision-a2', 'message-collision-a2', 'completed', '2026-06-15T09:21:00.000Z', '[]')
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, dispatch_origin,
            is_streaming, source, created_at, updated_at
          ) VALUES
            ('message-collision-a1', 'thread-cost-collision', 'turn-collision-a1', 'user', 'a1', NULL, 0, 'native', '2026-06-15T09:01:00.000Z', '2026-06-15T09:01:00.000Z'),
            ('message-collision-b1', 'thread-cost-collision', 'turn-collision-b1', 'user', 'b1', NULL, 0, 'native', '2026-06-15T09:11:00.000Z', '2026-06-15T09:11:00.000Z'),
            ('message-collision-a2', 'thread-cost-collision', 'turn-collision-a2', 'user', 'a2', NULL, 0, 'native', '2026-06-15T09:21:00.000Z', '2026-06-15T09:21:00.000Z')
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json
          ) VALUES
            (
              'event-collision-a1', 'thread', 'thread-cost-collision', 1,
              'thread.turn-start-requested', '2026-06-15T09:01:00.000Z', 'client',
              '{"threadId":"thread-cost-collision","messageId":"message-collision-a1","modelSelection":{"provider":"cursor","model":"cursor-model"}}', '{}'
            ),
            (
              'event-collision-b1', 'thread', 'thread-cost-collision', 2,
              'thread.turn-start-requested', '2026-06-15T09:11:00.000Z', 'client',
              '{"threadId":"thread-cost-collision","messageId":"message-collision-b1","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}', '{}'
            ),
            (
              'event-collision-a2', 'thread', 'thread-cost-collision', 3,
              'thread.turn-start-requested', '2026-06-15T09:21:00.000Z', 'client',
              '{"threadId":"thread-cost-collision","messageId":"message-collision-a2","modelSelection":{"provider":"cursor","model":"cursor-model"}}', '{}'
            )
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            (
              'collision-a1', 'thread-cost-collision', 'turn-collision-a1',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":1.00}', 1, '2026-06-15T09:05:00.000Z'
            ),
            (
              'collision-b1', 'thread-cost-collision', 'turn-collision-b1',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":2.00}', 2, '2026-06-15T09:15:00.000Z'
            ),
            (
              'collision-a2', 'thread-cost-collision', 'turn-collision-a2',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":3.00}', 3, '2026-06-15T09:25:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        const usage = tokenStats.providerUsage;
        // A's sequence (1.00 → 3.00) keeps its own baseline: 1.00 + 2.00 = 3.00.
        // B's first sample is a fresh baseline: 2.00.
        expect(usage?.find((entry) => entry.provider === "cursor")?.costUsd).toBe(3);
        expect(usage?.find((entry) => entry.provider === "codex")?.costUsd).toBe(2);
      }),
    );
  });

  it("resets cumulative cost baselines when a new provider session marker appears", async () => {
    await runProfileStatsTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statsQuery = yield* ProfileStatsQuery;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-cost-sessions', 'project-profile', 'Cost Sessions',
            '{"provider":"cursor","model":"cursor-model"}',
            'full-access', 'default', 'local',
            '2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z', NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            (
              'session-1a', 'thread-cost-sessions', 'turn-session-1a',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":1.00,"providerThreadId":"session-1"}', 1, '2026-06-15T09:05:00.000Z'
            ),
            (
              'session-1b', 'thread-cost-sessions', 'turn-session-1b',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":3.00,"providerThreadId":"session-1"}', 2, '2026-06-15T09:15:00.000Z'
            ),
            (
              'session-2a', 'thread-cost-sessions', 'turn-session-2a',
              'info', 'turn.completed', 'Turn completed',
              '{"cumulativeCostUsd":5.00,"providerThreadId":"session-2"}', 3, '2026-06-15T09:25:00.000Z'
            )
        `;

        const tokenStats = yield* statsQuery.getProfileTokenStats({ utcOffsetMinutes: 0 });
        const usage = tokenStats.providerUsage?.find((entry) => entry.provider === "cursor");
        // Session 1: 1.00 + 2.00; session 2's first cumulative (5.00) is a fresh
        // baseline instead of inheriting session 1's end.
        expect(usage).toMatchObject({ turnCount: 3, costUsd: 8 });
      }),
    );
  });
});
