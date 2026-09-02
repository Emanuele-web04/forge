import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("098_MigrateKiloToOpenCode", (it) => {
  it.effect("rewrites persisted kilo provider values to opencode", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 97 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at,
          model_selection_json, handoff_json
        )
        VALUES
          (
            'thread-kilo', 'project-1', 'Kilo thread', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
            '{"provider":"kilo","model":"kilo/kilo-auto/free","options":{"kilo":{"variant":"thread-variant","agent":"thread-agent"}}}',
            '{"sourceThreadId":"thread-src","sourceProvider":"kilo","importedAt":"2026-01-01T00:00:00Z","bootstrapStatus":"completed"}'
          ),
          (
            'thread-codex', 'project-1', 'Codex thread', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
            '{"provider":"codex","model":"gpt-5.5"}',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at,
          default_model_selection_json
        )
        VALUES (
          'project-1', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
          '{"provider":"kilo","model":"kilo/kilo-auto/free","options":{"kilo":{"variant":"project-variant"}}}'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, provider_name, updated_at)
        VALUES
          ('thread-kilo', 'idle', 'kilo', '2026-01-01T00:00:00Z'),
          ('thread-codex', 'idle', 'codex', '2026-01-01T00:00:00Z')
      `;

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, status, runtime_payload_json, last_seen_at
        )
        VALUES (
          'thread-kilo', 'kilo', 'kilo', 'stopped',
          '{"modelSelection":{"provider":"kilo","model":"kilo/kilo-auto/free","options":{"kilo":{"variant":"runtime-variant"}}},"providerOptions":{"kilo":{"binaryPath":"/runtime/kilo"},"opencode":{"binaryPath":"/runtime/opencode"}},"cwd":"/tmp/project"}',
          '2026-01-01T00:00:00Z'
        )
      `;

      yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled,
          model_selection_json, provider_options_json, runtime_mode, interaction_mode, worktree_mode,
          mode, stop_on_error, minimum_interval_seconds, retry_policy_json,
          misfire_policy, acknowledged_risks_json, iteration_count,
          created_at, updated_at
        )
        VALUES (
          'automation-1', 'project-1', 'Kilo automation', 'do things',
          '{"type":"interval","everySeconds":3600}', 1,
          '{"provider":"kilo","model":"kilo/kilo-auto/free","options":{"kilo":{"agent":"automation-agent"}}}',
          '{"kilo":{"binaryPath":"/opt/kilo","serverUrl":"http://127.0.0.1:4096"}}',
          'full-access', 'default',
          'disabled', 'standalone', 0, 60, '{"type":"none"}', 'coalesce', '[]', 0,
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        )
      `;

      yield* sql`
        INSERT INTO provider_runtime_events (
          event_id, thread_id, event_type, event_json, persisted_at
        )
        VALUES (
          'runtime-event-1', 'thread-kilo', 'session.started',
          '{"eventId":"runtime-event-1","provider":"kilo","threadId":"thread-kilo","createdAt":"2026-01-01T00:00:00Z","type":"session.started","payload":{},"raw":{"source":"kilo.sdk.event","payload":{}}}',
          '2026-01-01T00:00:00Z'
        )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        )
        VALUES
          (
            'event-1', 'thread', 'thread-kilo', 1, 'thread.created',
            '2026-01-01T00:00:00Z', 'client',
            '{"threadId":"thread-kilo","modelSelection":{"provider":"kilo","model":"kilo/kilo-auto/free","options":{"kilo":{"variant":"event-variant"}}},"providerOptions":{"kilo":{"binaryPath":"/event/kilo"}},"handoff":{"sourceThreadId":"thread-src","sourceProvider":"kilo","importedAt":"2026-01-01T00:00:00Z","bootstrapStatus":"completed"}}',
            '{}'
          ),
          (
            'event-2', 'project', 'project-1', 1, 'project.meta-updated',
            '2026-01-01T00:00:00Z', 'client',
            '{"projectId":"project-1","defaultModelSelection":{"provider":"kilo","model":"kilo/kilo-auto/free","options":{"kilo":{"agent":"event-agent"}}}}',
            '{}'
          ),
          (
            'event-3', 'thread', 'thread-kilo', 2, 'thread.token-usage-updated',
            '2026-01-01T00:00:00Z', 'provider',
            '{"threadId":"thread-kilo","provider":"kilo","providerName":"kilo","usedTokens":10}',
            '{}'
          ),
          (
            'event-4', 'thread', 'thread-codex', 1, 'thread.created',
            '2026-01-01T00:00:00Z', 'client',
            '{"threadId":"thread-codex","modelSelection":{"provider":"codex","model":"gpt-5.5"},"providerOptions":{"kilo":{"binaryPath":"/unused/kilo"},"opencode":{"binaryPath":"/keep/opencode"}}}',
            '{}'
          ),
          (
            'event-5', 'thread', 'thread-kilo', 3, 'thread.session-set',
            '2026-01-01T00:00:01Z', 'server',
            '{"threadId":"thread-kilo","session":{"providerName":"kilo"}}',
            '{}'
          ),
          (
            'event-6', 'thread', 'thread-kilo', 4, 'thread.activity-appended',
            '2026-01-01T00:00:02Z', 'provider',
            '{"threadId":"thread-kilo","activity":{"payload":{"provider":"kilo"}}}',
            '{}'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'activity-1', 'thread-kilo', 'info', 'usage', 'Kilo usage',
          '{"provider":"kilo"}', '2026-01-01T00:00:02Z'
        )
      `;

      yield* sql`
        INSERT INTO profile_stats_deleted_turns (thread_id, provider, model, reasoning, turn_count)
        VALUES ('deleted-kilo', 'kilo', 'kilo/kilo-auto/free', NULL, 1)
      `;
      yield* sql`
        INSERT INTO profile_stats_deleted_tokens (thread_id, created_at, provider, tokens)
        VALUES ('deleted-kilo', '2026-01-01T00:00:00Z', 'kilo', 10)
      `;

      yield* runMigrations();

      const [kiloThread] = yield* sql<{
        readonly modelSelection: string;
        readonly handoff: string;
      }>`
        SELECT
          model_selection_json AS "modelSelection",
          json_extract(handoff_json, '$.sourceProvider') AS "handoff"
        FROM projection_threads WHERE thread_id = 'thread-kilo'
      `;
      assert.deepStrictEqual(JSON.parse(kiloThread?.modelSelection ?? "null"), {
        provider: "opencode",
        model: "kilo/kilo-auto/free",
        options: { variant: "thread-variant", agent: "thread-agent" },
      });
      assert.strictEqual(kiloThread?.handoff, "opencode");

      const [codexThread] = yield* sql<{ readonly provider: string }>`
        SELECT json_extract(model_selection_json, '$.provider') AS "provider"
        FROM projection_threads WHERE thread_id = 'thread-codex'
      `;
      assert.strictEqual(codexThread?.provider, "codex");

      const [project] = yield* sql<{ readonly modelSelection: string }>`
        SELECT default_model_selection_json AS "modelSelection"
        FROM projection_projects WHERE project_id = 'project-1'
      `;
      assert.deepStrictEqual(JSON.parse(project?.modelSelection ?? "null"), {
        provider: "opencode",
        model: "kilo/kilo-auto/free",
        options: { variant: "project-variant" },
      });

      const [session] = yield* sql<{ readonly provider: string }>`
        SELECT provider_name AS "provider"
        FROM projection_thread_sessions WHERE thread_id = 'thread-kilo'
      `;
      assert.strictEqual(session?.provider, "opencode");

      const [runtimeBinding] = yield* sql<{
        readonly provider: string;
        readonly adapterKey: string;
        readonly runtimePayload: string;
      }>`
        SELECT provider_name AS "provider", adapter_key AS "adapterKey",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime WHERE thread_id = 'thread-kilo'
      `;
      assert.strictEqual(runtimeBinding?.provider, "opencode");
      assert.strictEqual(runtimeBinding?.adapterKey, "opencode");
      assert.deepStrictEqual(JSON.parse(runtimeBinding?.runtimePayload ?? "null"), {
        modelSelection: {
          provider: "opencode",
          model: "kilo/kilo-auto/free",
          options: { variant: "runtime-variant" },
        },
        providerOptions: { opencode: { binaryPath: "/runtime/opencode" } },
        cwd: "/tmp/project",
      });

      const [automation] = yield* sql<{
        readonly modelSelection: string;
        readonly providerOptions: string;
      }>`
        SELECT
          model_selection_json AS "modelSelection",
          provider_options_json AS "providerOptions"
        FROM automation_definitions WHERE automation_id = 'automation-1'
      `;
      assert.deepStrictEqual(JSON.parse(automation?.modelSelection ?? "null"), {
        provider: "opencode",
        model: "kilo/kilo-auto/free",
        options: { agent: "automation-agent" },
      });
      assert.deepStrictEqual(JSON.parse(automation?.providerOptions ?? "null"), {});

      const [runtimeEvent] = yield* sql<{ readonly provider: string; readonly rawSource: string }>`
        SELECT json_extract(event_json, '$.provider') AS "provider",
          json_extract(event_json, '$.raw.source') AS "rawSource"
        FROM provider_runtime_events WHERE event_id = 'runtime-event-1'
      `;
      assert.strictEqual(runtimeEvent?.provider, "opencode");
      assert.strictEqual(runtimeEvent?.rawSource, "opencode.sdk.event");

      const eventProviders = yield* sql<{
        readonly eventId: string;
        readonly payload: string;
      }>`
        SELECT event_id AS "eventId", payload_json AS "payload"
        FROM orchestration_events ORDER BY sequence
      `;
      const payloads = new Map(
        eventProviders.map((row) => [row.eventId, JSON.parse(row.payload) as Record<string, any>]),
      );
      assert.strictEqual(payloads.get("event-1")?.modelSelection.provider, "opencode");
      assert.deepStrictEqual(payloads.get("event-1")?.modelSelection.options, {
        variant: "event-variant",
      });
      assert.deepStrictEqual(payloads.get("event-1")?.providerOptions, {});
      assert.strictEqual(payloads.get("event-1")?.handoff.sourceProvider, "opencode");
      assert.strictEqual(payloads.get("event-2")?.defaultModelSelection.provider, "opencode");
      assert.deepStrictEqual(payloads.get("event-2")?.defaultModelSelection.options, {
        agent: "event-agent",
      });
      assert.strictEqual(payloads.get("event-3")?.provider, "opencode");
      assert.strictEqual(payloads.get("event-3")?.providerName, "opencode");
      assert.strictEqual(payloads.get("event-4")?.modelSelection.provider, "codex");
      assert.deepStrictEqual(payloads.get("event-4")?.providerOptions, {
        opencode: { binaryPath: "/keep/opencode" },
      });
      assert.strictEqual(payloads.get("event-5")?.session.providerName, "opencode");
      assert.strictEqual(payloads.get("event-6")?.activity.payload.provider, "opencode");

      const [activity] = yield* sql<{ readonly provider: string }>`
        SELECT json_extract(payload_json, '$.provider') AS "provider"
        FROM projection_thread_activities WHERE activity_id = 'activity-1'
      `;
      assert.strictEqual(activity?.provider, "opencode");
      const [deletedTurn] = yield* sql<{ readonly provider: string }>`
        SELECT provider FROM profile_stats_deleted_turns WHERE thread_id = 'deleted-kilo'
      `;
      const [deletedTokens] = yield* sql<{ readonly provider: string }>`
        SELECT provider FROM profile_stats_deleted_tokens WHERE thread_id = 'deleted-kilo'
      `;
      assert.strictEqual(deletedTurn?.provider, "opencode");
      assert.strictEqual(deletedTokens?.provider, "opencode");
    }),
  );

  it.effect("leaves migrated databases stable across reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runMigrations();

      const [row] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM projection_threads
        WHERE json_extract(model_selection_json, '$.provider') = 'kilo'
      `;
      assert.strictEqual(row?.count, 0);
    }),
  );
});
