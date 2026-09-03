import {
  EventId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PROVIDER_RUNTIME_EVENT_MAX_BYTES,
  PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../Services/ProviderRuntimeEvents.ts";
import {
  ProviderRuntimeEventRepositoryLive,
  truncateUtf8ToBytes,
} from "./ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { assignDerivedProviderRuntimeEventIds } from "../../provider/providerRuntimeEventIdentity.ts";

const layer = it.layer(
  ProviderRuntimeEventRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const runtimeEvent = (eventId: string, delta: string): ProviderRuntimeEvent => ({
  type: "content.delta",
  eventId: EventId.makeUnsafe(eventId),
  provider: "codex",
  createdAt: "2026-07-14T00:00:00.000Z",
  threadId: ThreadId.makeUnsafe("thread-runtime-journal"),
  turnId: TurnId.makeUnsafe("turn-runtime-journal"),
  payload: {
    streamKind: "assistant_text",
    delta,
  },
});

const insertLiveProjectionThread = (threadId: string, createdAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${threadId}, 'project-runtime-journal', 'Runtime journal', ${createdAt}, ${createdAt})
    `;
  });

const readOpenTurnReplayCount = (threadId: string) =>
  Effect.gen(function* () {
    const repository = yield* ProviderRuntimeEventRepository;
    const rows = yield* repository.readAcceptedOpenTurnEvents({
      consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
      sequenceExclusive: 0,
      limit: 50,
    });
    return rows.filter((row) => row.event.threadId === threadId).length;
  });

layer("ProviderRuntimeEventRepository", (it) => {
  it.effect("journals exact events and advances its consumer cursor contiguously", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const first = yield* repository.append(runtimeEvent("runtime-event-1", "hello"));
      const duplicate = yield* repository.append(runtimeEvent("runtime-event-1", "hello"));
      const second = yield* repository.append(runtimeEvent("runtime-event-2", " world"));

      assert.strictEqual(duplicate.sequence, first.sequence);
      assert.isAbove(second.sequence, first.sequence);
      assert.strictEqual(yield* repository.getHighWaterSequence, second.sequence);

      const rows = yield* repository.readAfter({
        sequenceExclusive: 0,
        throughSequenceInclusive: second.sequence,
        limit: 10,
      });
      assert.deepStrictEqual(
        rows.map((row) => [row.sequence, row.event.eventId]),
        [
          [first.sequence, "runtime-event-1"],
          [second.sequence, "runtime-event-2"],
        ],
      );
      assert.deepStrictEqual(yield* repository.getThreadCoverage("thread-runtime-journal"), {
        retainedCount: 2,
        oldestSequence: first.sequence,
        highWaterSequence: second.sequence,
      });
      assert.isTrue(
        yield* repository.hasPendingEventsForThreads({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          threadIds: ["thread-runtime-journal"],
        }),
      );
      assert.isFalse(
        yield* repository.hasPendingEventsForThreads({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          threadIds: ["thread-with-no-pending-events"],
        }),
      );
      assert.deepStrictEqual(
        (yield* repository.readThreadEvents({
          threadId: "thread-runtime-journal",
          throughSequenceInclusive: second.sequence,
          beforeSequenceExclusive: second.sequence,
          turnId: "turn-runtime-journal",
          eventTypes: ["content.delta"],
          limit: 10,
        })).map((row) => row.event.eventId),
        ["runtime-event-1"],
      );

      const skipped = yield* repository.advanceConsumerCursor({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        eventSequence: second.sequence,
        updatedAt: "2026-07-14T00:00:01.000Z",
      });
      assert.isFalse(skipped);
      const advanced = yield* repository.advanceConsumerCursor({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        eventSequence: first.sequence,
        updatedAt: "2026-07-14T00:00:01.000Z",
      });
      assert.isTrue(advanced);
      assert.strictEqual(
        yield* repository.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
        first.sequence,
      );
      assert.isTrue(
        yield* repository.hasPendingEventsForThreads({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          threadIds: ["thread-runtime-journal"],
        }),
      );
      assert.deepStrictEqual(
        (yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        })).map((row) => row.event.eventId),
        ["runtime-event-1"],
      );

      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: second.sequence,
          updatedAt: "2026-07-14T00:00:02.000Z",
        }),
      );
      assert.isFalse(
        yield* repository.hasPendingEventsForThreads({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          threadIds: ["thread-runtime-journal"],
        }),
      );
      const terminal = yield* repository.append({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("runtime-event-terminal"),
        provider: "codex",
        createdAt: "2026-07-14T00:00:03.000Z",
        threadId: ThreadId.makeUnsafe("thread-runtime-journal"),
        turnId: TurnId.makeUnsafe("turn-runtime-journal"),
        payload: { state: "completed" },
      });
      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: terminal.sequence,
          updatedAt: "2026-07-14T00:00:03.000Z",
        }),
      );
      assert.lengthOf(
        yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        }),
        0,
      );

      const conflict = yield* Effect.flip(
        repository.append(runtimeEvent("runtime-event-1", "different")),
      );
      assert.strictEqual(conflict._tag, "PersistenceDecodeError");
    }),
  );

  it.effect("prunes replay rows after their projected turn settles", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const sql = yield* SqlClient.SqlClient;
      const event = runtimeEvent("runtime-event-settled-turn", "stale replay");
      const persisted = yield* repository.append(event);

      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: persisted.sequence,
          updatedAt: "2026-07-14T00:01:00.000Z",
        }),
      );
      yield* insertLiveProjectionThread(event.threadId, event.createdAt);
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_files_json
        ) VALUES (
          ${event.threadId}, ${event.turnId}, 'running',
          ${event.createdAt}, '[]'
        )
      `;

      yield* repository.pruneSettledOpenTurns;
      assert.lengthOf(
        yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        }),
        1,
      );

      yield* sql`
        UPDATE projection_turns
        SET state = 'interrupted', completed_at = ${"2026-07-14T00:01:01.000Z"}
        WHERE thread_id = ${event.threadId} AND turn_id = ${event.turnId}
      `;
      yield* repository.pruneSettledOpenTurns;

      assert.lengthOf(
        yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        }),
        0,
      );
    }),
  );

  it.effect("prunes replay rows whose thread is purged, deleted, or archived", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const sql = yield* SqlClient.SqlClient;
      const orphanThreadId = ThreadId.makeUnsafe("thread-runtime-orphaned");
      const orphanTurnId = TurnId.makeUnsafe("turn-runtime-orphaned");
      const event: ProviderRuntimeEvent = {
        ...runtimeEvent("runtime-event-orphaned-turn", "orphaned replay"),
        threadId: orphanThreadId,
        turnId: orphanTurnId,
      };
      const persisted = yield* repository.append(event);
      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: persisted.sequence,
          updatedAt: "2026-07-14T00:01:00.000Z",
        }),
      );
      assert.strictEqual(yield* readOpenTurnReplayCount(orphanThreadId), 1);

      // No projection thread row at all (hard-purged): the open turn is dead.
      yield* repository.pruneSettledOpenTurns;
      assert.strictEqual(yield* readOpenTurnReplayCount(orphanThreadId), 0);

      // Re-open the turn under a live thread: the replay row must survive.
      const reopened = yield* repository.append({
        ...runtimeEvent("runtime-event-orphaned-turn-2", "live replay"),
        threadId: orphanThreadId,
        turnId: orphanTurnId,
      });
      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: reopened.sequence,
          updatedAt: "2026-07-14T00:01:01.000Z",
        }),
      );
      yield* insertLiveProjectionThread(event.threadId, event.createdAt);
      yield* repository.pruneSettledOpenTurns;
      assert.strictEqual(yield* readOpenTurnReplayCount(orphanThreadId), 1);

      // Archiving does not interrupt a turn the projection still considers
      // running, so that replay row must survive the archive.
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_files_json
        ) VALUES (
          ${orphanThreadId}, ${orphanTurnId}, 'running', ${event.createdAt}, '[]'
        )
      `;
      yield* sql`
        UPDATE projection_threads
        SET archived_at = ${"2026-07-14T00:02:00.000Z"}
        WHERE thread_id = ${event.threadId}
      `;
      yield* repository.pruneSettledOpenTurns;
      assert.strictEqual(yield* readOpenTurnReplayCount(orphanThreadId), 1);

      // An archived thread whose turn the projection never tracked (or has
      // settled) has nothing left to replay.
      yield* sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${orphanThreadId} AND turn_id = ${orphanTurnId}
      `;
      yield* repository.pruneSettledOpenTurns;
      assert.strictEqual(yield* readOpenTurnReplayCount(orphanThreadId), 0);
    }),
  );

  it.effect("compacts oversized raw provider payloads without losing the canonical event", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const oversized = {
        ...runtimeEvent("runtime-event-oversized-raw", "terminal-safe"),
        raw: {
          source: "codex.eventmsg" as const,
          method: "codex/event/task_complete",
          payload: {
            transcript: "x".repeat(PROVIDER_RUNTIME_EVENT_MAX_BYTES),
          },
        },
      } satisfies ProviderRuntimeEvent;

      const persisted = yield* repository.append(oversized);
      const rows = yield* repository.readAfter({
        sequenceExclusive: persisted.sequence - 1,
        throughSequenceInclusive: persisted.sequence,
        limit: 1,
      });

      assert.strictEqual(persisted.event.eventId, oversized.eventId);
      assert.deepStrictEqual(persisted.event.payload, oversized.payload);
      const compactedRaw = rows[0]?.event.raw?.payload as
        | {
            readonly synaraTruncated?: unknown;
            readonly reason?: unknown;
            readonly originalBytes?: unknown;
          }
        | undefined;
      assert.deepInclude(compactedRaw, {
        synaraTruncated: true,
        reason: "provider runtime event exceeded the durable journal size limit",
      });
      assert.isNumber(compactedRaw?.originalBytes);
    }),
  );

  it.effect("journals an oversized Pi item.completed by truncating payload string leaves", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const oversizedResult = "x".repeat(PROVIDER_RUNTIME_EVENT_MAX_BYTES * 2);
      const oversizedEvent = {
        type: "item.completed",
        eventId: EventId.makeUnsafe("runtime-event-oversized-pi"),
        provider: "pi",
        createdAt: "2026-07-14T00:03:00.000Z",
        threadId: ThreadId.makeUnsafe("thread-runtime-journal"),
        turnId: TurnId.makeUnsafe("turn-runtime-journal"),
        itemId: RuntimeItemId.makeUnsafe("item-oversized-pi"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Run bash",
          detail: oversizedResult,
          data: { toolCallId: "call-1", toolName: "bash", result: oversizedResult },
        },
        raw: {
          source: "pi.sdk.event",
          messageType: "tool_result",
          payload: { result: oversizedResult },
        },
      } satisfies ProviderRuntimeEvent;

      const persisted = yield* repository.append(oversizedEvent);
      assert.strictEqual(persisted.event.eventId, oversizedEvent.eventId);
      if (persisted.event.type === "item.completed") {
        const detail = persisted.event.payload.detail;
        assert.isString(detail);
        if (typeof detail === "string") {
          assert.isBelow(detail.length, oversizedResult.length);
        }
        const data = persisted.event.payload.data as { readonly result?: string } | undefined;
        const dataResult = data?.result;
        assert.isString(dataResult);
        if (typeof dataResult === "string") {
          assert.isBelow(dataResult.length, oversizedResult.length);
        }
      }
      const rawPayload = persisted.event.raw?.payload as
        | {
            readonly synaraTruncated?: unknown;
            readonly originalBytes?: unknown;
          }
        | undefined;
      assert.deepInclude(rawPayload, { synaraTruncated: true });
      const originalBytes = rawPayload?.originalBytes;
      assert.isNumber(originalBytes);
      if (typeof originalBytes === "number") {
        assert.isAbove(originalBytes, PROVIDER_RUNTIME_EVENT_MAX_BYTES);
      }

      const rows = yield* repository.readAfter({
        sequenceExclusive: persisted.sequence - 1,
        throughSequenceInclusive: persisted.sequence,
        limit: 1,
      });
      assert.strictEqual(rows[0]?.event.eventId, "runtime-event-oversized-pi");

      const duplicate = yield* repository.append(oversizedEvent);
      assert.strictEqual(duplicate.sequence, persisted.sequence);
    }),
  );

  it.effect("journals an oversized raw-less event by truncating its payload leaves", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const oversizedDelta = "y".repeat(PROVIDER_RUNTIME_EVENT_MAX_BYTES * 2);
      const oversizedEvent = runtimeEvent("runtime-event-oversized-payload", oversizedDelta);

      const persisted = yield* repository.append(oversizedEvent);
      assert.strictEqual(persisted.event.eventId, oversizedEvent.eventId);
      assert.strictEqual(persisted.event.raw, undefined);
      if (persisted.event.type === "content.delta") {
        assert.isBelow(persisted.event.payload.delta.length, oversizedDelta.length);
      }
    }),
  );

  it.effect("still rejects an event whose oversized bulk is not string leaves", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const oversizedEvent = {
        type: "item.completed",
        eventId: EventId.makeUnsafe("runtime-event-oversized-numbers"),
        provider: "pi",
        createdAt: "2026-07-14T00:04:00.000Z",
        threadId: ThreadId.makeUnsafe("thread-runtime-journal"),
        turnId: TurnId.makeUnsafe("turn-runtime-journal"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Number flood",
          data: {
            values: Array.from({ length: PROVIDER_RUNTIME_EVENT_MAX_BYTES / 5 }, (_, i) => i),
          },
        },
      } satisfies ProviderRuntimeEvent;

      const failure = yield* Effect.flip(repository.append(oversizedEvent));
      assert.strictEqual(failure._tag, "PersistenceDecodeError");
    }),
  );

  it("truncateUtf8ToBytes never splits a UTF-8 code point", () => {
    const emoji = "🙂".repeat(10_000);
    const truncated = truncateUtf8ToBytes(emoji, 999);
    assert.isBelow(Buffer.byteLength(truncated, "utf8"), 1_000);
    assert.isFalse(truncated.includes("\uFFFD"));
    assert.strictEqual(Buffer.from(truncated, "utf8").toString("utf8"), truncated);
  });

  it.effect("journals every canonical event derived from one provider notification", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const common = {
        eventId: EventId.makeUnsafe("native-task-complete"),
        provider: "codex" as const,
        createdAt: "2026-07-14T00:02:00.000Z",
        threadId: ThreadId.makeUnsafe("thread-derived-runtime-journal"),
        turnId: TurnId.makeUnsafe("turn-derived-runtime-journal"),
      };
      const derived = assignDerivedProviderRuntimeEventIds([
        {
          ...common,
          type: "task.completed",
          payload: { taskId: RuntimeTaskId.makeUnsafe("task-1"), status: "completed" },
        },
        {
          ...common,
          type: "turn.proposed.completed",
          payload: { planMarkdown: "# Plan" },
        },
      ]);

      const persisted = yield* Effect.forEach(derived, repository.append, {
        concurrency: 1,
      });
      assert.deepStrictEqual(
        persisted.map(({ event }) => event.eventId),
        ["native-task-complete:task.completed:0", "native-task-complete:turn.proposed.completed:1"],
      );
      assert.notStrictEqual(persisted[0]?.sequence, persisted[1]?.sequence);
    }),
  );
});

// Fresh (isolated in-memory) database: retention behaviour is asserted through
// exact row counts, which only hold when no other test shares the journal.
const retentionLayer = it.layer(
  Layer.fresh(ProviderRuntimeEventRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
);

retentionLayer("ProviderRuntimeEventRepository retention", (it) => {
  const threadId = ThreadId.makeUnsafe("thread-retention");
  const deltaEvent = (turn: string, index: number): ProviderRuntimeEvent => ({
    type: "content.delta",
    eventId: EventId.makeUnsafe(`retention-${turn}-${index}`),
    provider: "codex",
    createdAt: "2026-07-14T01:00:00.000Z",
    threadId,
    turnId: TurnId.makeUnsafe(`turn-retention-${turn}`),
    payload: { streamKind: "assistant_text", delta: `chunk-${index}` },
  });
  const terminalEvent = (turn: string): ProviderRuntimeEvent => ({
    type: "turn.completed",
    eventId: EventId.makeUnsafe(`retention-${turn}-terminal`),
    provider: "codex",
    createdAt: "2026-07-14T01:00:01.000Z",
    threadId,
    turnId: TurnId.makeUnsafe(`turn-retention-${turn}`),
    payload: { state: "completed" },
  });

  it.effect("retains open-turn replay while throttling retention scans", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const sql = yield* SqlClient.SqlClient;
      const journalSize = Effect.map(
        sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM provider_runtime_events`,
        (rows) => rows[0]?.count ?? 0,
      );
      const replayable = Effect.map(
        repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10_000,
        }),
        (rows) => rows.length,
      );
      const acceptEvent = (event: ProviderRuntimeEvent) =>
        Effect.gen(function* () {
          const persisted = yield* repository.append(event);
          const accepted = yield* repository.advanceConsumerCursor({
            consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
            eventSequence: persisted.sequence,
            updatedAt: event.createdAt,
          });
          assert.isTrue(accepted);
        });

      // A long open turn: every accepted event must stay replayable, including
      // the ones that crossed a throttled scan boundary.
      const openTurnEvents = PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED + 88;
      for (let index = 0; index < openTurnEvents; index += 1) {
        yield* acceptEvent(deltaEvent("a", index));
      }
      assert.strictEqual(yield* replayable, openTurnEvents);
      assert.strictEqual(yield* journalSize, openTurnEvents);

      // The terminal event settles the turn and forces a scan, leaving exactly
      // the bounded diagnostic tail behind.
      yield* acceptEvent(terminalEvent("a"));
      assert.strictEqual(yield* replayable, 0);
      assert.strictEqual(yield* journalSize, PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED);

      // A shorter follow-up turn stays below the scan interval: no scan runs,
      // which is exactly the quadratic-delete behaviour this throttle removes.
      const followUpEvents = 300;
      for (let index = 0; index < followUpEvents; index += 1) {
        yield* acceptEvent(deltaEvent("b", index));
      }
      assert.strictEqual(yield* replayable, followUpEvents);
      assert.strictEqual(
        yield* journalSize,
        PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED + followUpEvents,
      );

      // Settling the follow-up turn releases the deferred backlog immediately.
      yield* acceptEvent(terminalEvent("b"));
      assert.strictEqual(yield* replayable, 0);
      assert.strictEqual(yield* journalSize, PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED);
    }),
  );
});
