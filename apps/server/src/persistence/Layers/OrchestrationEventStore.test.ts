import { CommandId, EventId, ProjectId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import {
  buildReadEventRowsFromSequenceQuery,
  OrchestrationEventStoreLive,
} from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("projector replay pages keep the primary-key range scan for every filter shape", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const baseRequest = {
        sequenceExclusive: 10,
        throughSequenceInclusive: 1_000,
        limit: 500,
      };
      // One request per replayFilter branch in buildReadEventRowsFromSequenceQuery.
      const requests = [
        {
          ...baseRequest,
          filterEnabled: false,
          includeBoundaryEvent: false,
          eventTypes: [],
          activityKinds: [],
        },
        {
          ...baseRequest,
          filterEnabled: true,
          includeBoundaryEvent: true,
          eventTypes: ["thread.activity-appended", "thread.created"],
          activityKinds: [],
        },
        {
          ...baseRequest,
          filterEnabled: true,
          includeBoundaryEvent: true,
          eventTypes: ["thread.activity-appended"],
          activityKinds: ["approval.requested"],
        },
        // Empty eventTypes yields the constant-0 predicate (checkpoints projector).
        {
          ...baseRequest,
          filterEnabled: true,
          includeBoundaryEvent: true,
          eventTypes: [],
          activityKinds: [],
        },
        {
          ...baseRequest,
          filterEnabled: true,
          includeBoundaryEvent: false,
          eventTypes: ["thread.activity-appended"],
          activityKinds: ["approval.requested"],
        },
      ];

      for (const request of requests) {
        const [query, params] = buildReadEventRowsFromSequenceQuery(sql, request).compile();
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${query}`,
          params,
        );
        const details = plan.map((row) => row.detail).join("\n");
        // The boundary OR must never demote the sequence cursor to a
        // MULTI-INDEX OR plan: with a large event log that plan rescans the
        // whole event_type index per page and turns projection bootstrap
        // into minutes of startup time.
        //
        // EXPLAIN QUERY PLAN text is not a stable format across SQLite
        // releases, so assert independent fragments of the required plan
        // (table search, integer PK usage, both rowid range bounds) instead
        // of one exact phrase.
        for (const fragment of [
          /SEARCH orchestration_events/,
          /USING INTEGER PRIMARY KEY/,
          /rowid>/,
          /rowid</,
        ]) {
          assert.match(
            details,
            fragment,
            `expected PK range scan (${fragment}), got plan:\n${details}\nfor request: ${JSON.stringify(request)}`,
          );
        }
        assert.notMatch(
          details,
          /MULTI-INDEX OR|TEMP B-TREE/,
          `plan regressed to index-OR or temp sort:\n${details}\nfor request: ${JSON.stringify(request)}`,
        );
      }
    }),
  );

  it.effect("reads stable newest-first pages from one thread stream", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const now = "2026-07-20T12:00:00.000Z";
      const threadId = ThreadId.makeUnsafe("thread-diagnostic-page");
      const first = yield* eventStore.append({
        type: "thread.archived",
        eventId: EventId.makeUnsafe("evt-thread-diagnostic-first"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, archivedAt: now, updatedAt: now },
      });
      yield* eventStore.append({
        type: "thread.archived",
        eventId: EventId.makeUnsafe("evt-thread-diagnostic-unrelated"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-diagnostic-unrelated"),
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-diagnostic-unrelated"),
          archivedAt: now,
          updatedAt: now,
        },
      });
      const sameThreadNonDetail = yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("evt-thread-diagnostic-non-detail"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, deletedAt: now },
      });
      const second = yield* eventStore.append({
        type: "thread.unarchived",
        eventId: EventId.makeUnsafe("evt-thread-diagnostic-second"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, updatedAt: now },
      });

      assert.equal(yield* eventStore.getThreadHighWaterSequence(threadId), second.sequence);
      const latest = yield* eventStore.readThreadEvents({
        threadId,
        throughSequenceInclusive: second.sequence,
        limit: 1,
      });
      assert.deepEqual(
        latest.map((event) => event.sequence),
        [second.sequence],
      );
      const older = yield* eventStore.readThreadEvents({
        threadId,
        throughSequenceInclusive: second.sequence,
        beforeSequenceExclusive: second.sequence,
        limit: 10,
        eventTypes: ["thread.archived"],
      });
      assert.deepEqual(
        older.map((event) => event.sequence),
        [first.sequence],
      );
      const catchup = yield* Stream.runCollect(
        eventStore.readThreadEventsFromSequence(threadId, first.sequence, 10, second.sequence),
      ).pipe(Effect.map((events) => Array.from(events)));
      assert.deepEqual(
        catchup.map((event) => event.sequence),
        [sameThreadNonDetail.sequence, second.sequence],
      );
      const detailCatchup = yield* Stream.runCollect(
        eventStore.readThreadEventsFromSequence(threadId, first.sequence, 1, second.sequence, [
          "thread.unarchived",
        ]),
      ).pipe(Effect.map((events) => Array.from(events)));
      assert.deepEqual(
        detailCatchup.map((event) => event.sequence),
        [second.sequence],
      );
    }),
  );

  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const startSequence = yield* eventStore.getHighWaterSequence();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.makeUnsafe("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");
      assert.equal(JSON.parse(storedRows[0]!.metadataJson).persistedEventSchemaVersion, 1);

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(startSequence, 10),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("filters sparse projector replay before decoding unrelated activity payloads", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const now = "2026-08-09T00:00:00.000Z";
      const threadId = ThreadId.makeUnsafe("thread-filtered-replay");
      const appendActivity = (eventId: string, kind: string) =>
        eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.makeUnsafe(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.makeUnsafe(`${eventId}-activity`),
              tone: "info",
              kind,
              summary: kind,
              payload: {},
              turnId: null,
              createdAt: now,
            },
          },
        } as Parameters<typeof eventStore.append>[0]);

      yield* appendActivity("evt-filtered-replay-noise", "context-window.updated");
      const relevant = yield* appendActivity("evt-filtered-replay-relevant", "approval.requested");
      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(0, Number.MAX_SAFE_INTEGER, relevant.sequence, {
          eventTypes: ["thread.activity-appended"],
          activityKinds: ["approval.requested"],
        }),
      ).pipe(Effect.map((events) => Array.from(events)));

      assert.deepEqual(
        replayed.map((event) => event.eventId),
        [relevant.eventId],
      );
    }),
  );

  it.effect("normalizes imported Synara model-selection shapes during replay", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-05-05T14:39:18.000Z";

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
        (
          ${EventId.makeUnsafe("evt-import-project-created")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-imported")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-import-project-created")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            projectId: "project-imported",
            title: "Imported Project",
            workspaceRoot: "/tmp/imported",
            defaultModelSelection: {
              instanceId: "codex",
              model: "imported-project-model",
            },
            scripts: [],
            createdAt: now,
            updatedAt: now,
          })},
          ${"{}"}
        ),
        (
          ${EventId.makeUnsafe("evt-import-thread-created")},
          ${"thread"},
          ${ThreadId.makeUnsafe("thread-imported")},
          ${0},
          ${"thread.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-import-thread-created")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            threadId: "thread-imported",
            projectId: "project-imported",
            title: "Imported Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.5",
              options: [{ id: "reasoningEffort", value: "medium" }],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          })},
          ${"{}"}
        ),
        (
          ${EventId.makeUnsafe("evt-import-turn-start")},
          ${"thread"},
          ${ThreadId.makeUnsafe("thread-imported")},
          ${1},
          ${"thread.turn-start-requested"},
          ${now},
          ${CommandId.makeUnsafe("cmd-import-turn-start")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            threadId: "thread-imported",
            messageId: "message-imported",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.5",
              options: [{ id: "reasoningEffort", value: "medium" }],
            },
            dispatchMode: "queue",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          })},
          ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const projectCreated = replayed.find(
        (event) => event.eventId === EventId.makeUnsafe("evt-import-project-created"),
      );
      const threadCreated = replayed.find(
        (event) => event.eventId === EventId.makeUnsafe("evt-import-thread-created"),
      );
      const turnStartRequested = replayed.find(
        (event) => event.eventId === EventId.makeUnsafe("evt-import-turn-start"),
      );

      assert.deepStrictEqual(
        projectCreated?.type === "project.created"
          ? projectCreated.payload.defaultModelSelection
          : null,
        {
          provider: "codex",
          model: "imported-project-model",
        },
      );
      assert.deepStrictEqual(
        threadCreated?.type === "thread.created" ? threadCreated.payload.modelSelection : null,
        {
          provider: "codex",
          model: "gpt-5.5",
          options: {
            reasoningEffort: "medium",
          },
        },
      );
      assert.deepStrictEqual(
        turnStartRequested?.type === "thread.turn-start-requested"
          ? turnStartRequested.payload.modelSelection
          : null,
        {
          provider: "codex",
          model: "gpt-5.5",
          options: {
            reasoningEffort: "medium",
          },
        },
      );
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const startSequence = yield* eventStore.getHighWaterSequence();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(startSequence, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.match(
          replayResult.failure.operation,
          /OrchestrationEventStore\.readFromSequence:rowToEvent\(sequence=\d+, type=project\.created\)/,
        );
      }
    }),
  );

  it.effect("rejects future event schema versions with exact row diagnostics", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const startSequence = yield* eventStore.getHighWaterSequence();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-future-schema")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-future-schema")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-future-schema")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            projectId: "project-future-schema",
            title: "Future schema",
            workspaceRoot: "/tmp/project-future-schema",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          })},
          ${JSON.stringify({ persistedEventSchemaVersion: 2 })}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(startSequence, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.match(replayResult.failure.operation, /sequence=\d+, type=project\.created/);
        assert.ok(
          replayResult.failure.issue.includes("Unsupported persisted event schema version 2"),
          replayResult.failure.issue,
        );
      }
    }),
  );
});
