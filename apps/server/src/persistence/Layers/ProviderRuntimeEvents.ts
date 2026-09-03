import { NonNegativeInt, ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PersistenceDecodeError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  PROVIDER_RUNTIME_EVENT_MAX_BYTES,
  PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
  ProviderRuntimeEventRepository,
  type PersistedProviderRuntimeEvent,
  type ProviderRuntimeEventRepositoryShape,
} from "../Services/ProviderRuntimeEvents.ts";

/**
 * How far the consumer cursor may advance between journal retention scans.
 *
 * Retention keeps every event of an open turn plus a trailing diagnostic tail,
 * so while a turn streams there is nothing new to delete, yet the scan has no
 * lower bound and re-probes the whole retained backlog on every single event —
 * quadratic in the length of a turn (measured: 1.38 ms/event at 8k events,
 * 3.07 ms/event at 16k events, ~25 s cumulative).
 *
 * Scanning once per interval instead makes that cost linear-ish while changing
 * nothing about what is retained: skipping a scan can only delay a delete, and
 * every event that settles a turn forces a scan immediately, so the backlog of
 * a finished turn is still released as soon as it becomes deletable. The bound
 * on extra retained rows is one interval's worth of accepted events.
 *
 * Deliberately matched to PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED: roughly one
 * scan per tail-length of accepted events falling out of the diagnostic tail.
 */
const PROVIDER_RUNTIME_EVENT_RETENTION_SCAN_INTERVAL = PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED;

const ProviderRuntimeEventJson = Schema.fromJsonString(ProviderRuntimeEvent);
const encodeEvent = Schema.encodeEffect(ProviderRuntimeEventJson);
const decodeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEventJson);

const StoredRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventJson: Schema.String,
});
const decodeStoredRow = Schema.decodeUnknownEffect(StoredRowSchema);
const SequenceRowSchema = Schema.Struct({ sequence: NonNegativeInt });
const decodeSequenceRow = Schema.decodeUnknownEffect(SequenceRowSchema);

/**
 * Longest-prefix string truncation that never splits a UTF-8 code point.
 * Returns the whole string when it already fits.
 */
export const truncateUtf8ToBytes = (value: string, maxBytes: number): string => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let prefixEnd = maxBytes;
  while (prefixEnd > 0 && ((encoded[prefixEnd] ?? 0) & 0xc0) === 0x80) {
    prefixEnd -= 1;
  }
  return encoded.subarray(0, prefixEnd).toString("utf8");
};

/**
 * Budget assigned to every string leaf so a single oversized field (typically a
 * provider tool result copied verbatim into `payload.detail` or `payload.data`)
 * never exhausts the durable journal budget by itself.
 */
const JOURNAL_STRING_LEAF_BUDGET_BYTES = 64 * 1024;

/**
 * Shrink every string leaf inside a runtime event payload to the per-leaf
 * budget, recursing through records and arrays. Non-string leaves are kept:
 * they are either small structural fields or values with no safe truncation.
 */
export const shrinkRuntimeEventStrings = (value: unknown): unknown => {
  if (typeof value === "string") {
    return truncateUtf8ToBytes(value, JOURNAL_STRING_LEAF_BUDGET_BYTES);
  }
  if (Array.isArray(value)) {
    return value.map(shrinkRuntimeEventStrings);
  }
  if (value !== null && typeof value === "object") {
    const shrunk: Record<string, unknown> = {};
    for (const [key, leaf] of Object.entries(value as Record<string, unknown>)) {
      shrunk[key] = shrinkRuntimeEventStrings(leaf);
    }
    return shrunk;
  }
  return value;
};

const encodePersistableEvent = (event: ProviderRuntimeEvent) =>
  Effect.gen(function* () {
    const eventJson = yield* encodeEvent(event).pipe(
      Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.encode")),
    );
    const originalBytes = Buffer.byteLength(eventJson, "utf8");
    if (originalBytes <= PROVIDER_RUNTIME_EVENT_MAX_BYTES) {
      return { event, eventJson };
    }

    // Shrink oversized string leaves so one huge tool output no longer strands
    // the live item in quarantine. The raw payload is replaced by a forensics
    // marker (its own copy of the tool output would otherwise re-blow the
    // budget), while source/method/messageType survive for diagnostics.
    const compactedEvent = {
      ...event,
      payload: shrinkRuntimeEventStrings(event.payload),
      ...(event.raw !== undefined
        ? {
            raw: {
              source: event.raw.source,
              ...(event.raw.method !== undefined ? { method: event.raw.method } : {}),
              ...(event.raw.messageType !== undefined
                ? { messageType: event.raw.messageType }
                : {}),
              payload: {
                synaraTruncated: true,
                reason: "provider runtime event exceeded the durable journal size limit",
                originalBytes,
              },
            },
          }
        : {}),
    } as ProviderRuntimeEvent;
    const compactedJson = yield* encodeEvent(compactedEvent).pipe(
      Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.compact")),
    );
    if (Buffer.byteLength(compactedJson, "utf8") <= PROVIDER_RUNTIME_EVENT_MAX_BYTES) {
      return { event: compactedEvent, eventJson: compactedJson };
    }

    return yield* new PersistenceDecodeError({
      operation: "ProviderRuntimeEvent.append",
      issue: `Provider runtime event exceeds ${PROVIDER_RUNTIME_EVENT_MAX_BYTES} bytes after payload truncation and raw compaction.`,
    });
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const append: ProviderRuntimeEventRepositoryShape["append"] = (event) =>
    Effect.gen(function* () {
      const persistable = yield* encodePersistableEvent(event);
      const persistedEvent = persistable.event;
      const eventJson = persistable.eventJson;
      const appendResult = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // SQLite reserves the AUTOINCREMENT rowid before conflict handling, so duplicate event
            // IDs consume sequence values. Sequence is a cursor, not a dense counter; gaps are valid.
            const inserted = yield* sql<Record<string, unknown>>`
            INSERT INTO provider_runtime_events (
              event_id, thread_id, turn_id, lifecycle_generation, event_type,
              event_json, persisted_at
            ) VALUES (
              ${event.eventId}, ${event.threadId}, ${event.turnId ?? null},
              ${event.lifecycleGeneration ?? null},
              ${event.type}, ${eventJson}, ${new Date().toISOString()}
            )
            ON CONFLICT(event_id) DO NOTHING
            RETURNING sequence
            `;
            if (inserted[0] !== undefined) {
              return { inserted: true as const, row: inserted[0] };
            }

            const existing = yield* sql<Record<string, unknown>>`
              SELECT sequence, event_json AS "eventJson"
              FROM provider_runtime_events
              WHERE event_id = ${event.eventId}
          `;
            return { inserted: false as const, row: existing[0] };
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.append")));
      const persisted = appendResult.inserted
        ? yield* decodeSequenceRow(appendResult.row).pipe(
            Effect.map((row) => ({ sequence: row.sequence, eventJson })),
            Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.row")),
          )
        : yield* decodeStoredRow(appendResult.row).pipe(
            Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.conflictRow")),
          );
      if (persisted.eventJson !== eventJson) {
        return yield* new PersistenceDecodeError({
          operation: "ProviderRuntimeEvent.append",
          issue: `Provider event '${event.eventId}' was reused with different content.`,
        });
      }
      return {
        sequence: persisted.sequence,
        event: persistedEvent,
      } satisfies PersistedProviderRuntimeEvent;
    });

  const getHighWaterSequence = sql<{ readonly highWaterSequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS "highWaterSequence"
    FROM provider_runtime_events
  `.pipe(
    Effect.map((rows) => rows[0]?.highWaterSequence ?? 0),
    Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.getHighWaterSequence")),
  );

  const readAfter: ProviderRuntimeEventRepositoryShape["readAfter"] = (input) => {
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
    return Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT sequence, event_json AS "eventJson"
        FROM provider_runtime_events
        WHERE sequence > ${input.sequenceExclusive}
          AND sequence <= ${input.throughSequenceInclusive}
        ORDER BY sequence ASC
        LIMIT ${limit}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readAfter")));
      return yield* Effect.forEach(
        rows,
        (unknownRow) =>
          Effect.gen(function* () {
            const row = yield* decodeStoredRow(unknownRow).pipe(
              Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.readAfter.row")),
            );
            const event = yield* decodeEvent(row.eventJson).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  `ProviderRuntimeEvent.readAfter(sequence=${row.sequence})`,
                ),
              ),
            );
            return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
          }),
        { concurrency: 1 },
      );
    });
  };

  const getThreadCoverage: ProviderRuntimeEventRepositoryShape["getThreadCoverage"] = (threadId) =>
    sql<{
      readonly retainedCount: number;
      readonly oldestSequence: number | null;
      readonly highWaterSequence: number;
    }>`
      SELECT
        COUNT(*) AS "retainedCount",
        MIN(sequence) AS "oldestSequence",
        COALESCE(MAX(sequence), 0) AS "highWaterSequence"
      FROM provider_runtime_events
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map(
        (rows) => rows[0] ?? { retainedCount: 0, oldestSequence: null, highWaterSequence: 0 },
      ),
      Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.getThreadCoverage")),
    );

  const readThreadEvents: ProviderRuntimeEventRepositoryShape["readThreadEvents"] = (input) => {
    const beforeSequence = input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER;
    const turnFilter = input.turnId === undefined ? sql`` : sql`AND turn_id = ${input.turnId}`;
    const typeFilter =
      input.eventTypes === undefined || input.eventTypes.length === 0
        ? sql``
        : sql`AND event_type IN ${sql.in(input.eventTypes)}`;
    return Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT sequence, event_json AS "eventJson"
        FROM provider_runtime_events
        WHERE thread_id = ${input.threadId}
          AND sequence <= ${input.throughSequenceInclusive}
          AND sequence < ${beforeSequence}
          ${turnFilter}
          ${typeFilter}
        ORDER BY sequence DESC
        LIMIT ${Math.max(1, Math.min(201, Math.floor(input.limit)))}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readThreadEvents")));
      return yield* Effect.forEach(
        rows,
        (unknownRow) =>
          Effect.gen(function* () {
            const row = yield* decodeStoredRow(unknownRow).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderRuntimeEvent.readThreadEvents.row"),
              ),
            );
            const event = yield* decodeEvent(row.eventJson).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  `ProviderRuntimeEvent.readThreadEvents(sequence=${row.sequence})`,
                ),
              ),
            );
            return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
          }),
        { concurrency: 1 },
      );
    });
  };

  const readAcceptedOpenTurnEvents: ProviderRuntimeEventRepositoryShape["readAcceptedOpenTurnEvents"] =
    (input) => {
      const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
      return Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT event.sequence, event.event_json AS "eventJson"
          FROM provider_runtime_events AS event
          INNER JOIN provider_runtime_open_turns AS open_turn
            ON open_turn.thread_id = event.thread_id
           AND open_turn.turn_id = event.turn_id
           AND event.sequence >= open_turn.first_sequence
          INNER JOIN provider_runtime_event_consumers AS consumer
            ON consumer.consumer_name = ${input.consumerName}
           AND event.sequence <= consumer.last_acked_sequence
          WHERE event.sequence > ${input.sequenceExclusive}
          ORDER BY event.sequence ASC
          LIMIT ${limit}
        `.pipe(
          Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readAcceptedOpenTurnEvents")),
        );
        return yield* Effect.forEach(
          rows,
          (unknownRow) =>
            Effect.gen(function* () {
              const row = yield* decodeStoredRow(unknownRow).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProviderRuntimeEvent.readAcceptedOpenTurnEvents.row"),
                ),
              );
              const event = yield* decodeEvent(row.eventJson).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    `ProviderRuntimeEvent.readAcceptedOpenTurnEvents(sequence=${row.sequence})`,
                  ),
                ),
              );
              return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
            }),
          { concurrency: 1 },
        );
      });
    };

  // Open-turn rows keep their whole event range on the startup replay path
  // (`rebuildAcceptedOpenTurnState`, which runs before the server listens), so
  // rows that can never produce output again must not survive: settled turns,
  // turns of purged or deleted threads, and turns of archived threads that the
  // projection does not consider running (archiving neither interrupts a turn
  // nor is permanent, so a still-running turn on an archived thread stays).
  // Pruning is one-way: once a turn's row is gone, its journal rows become
  // eligible for the retention sweep below, so every criterion here must
  // describe a turn that can no longer emit output.
  const pruneSettledOpenTurns: ProviderRuntimeEventRepositoryShape["pruneSettledOpenTurns"] = sql`
      DELETE FROM provider_runtime_open_turns
      WHERE EXISTS (
        SELECT 1
        FROM projection_turns AS turn
        WHERE turn.thread_id = provider_runtime_open_turns.thread_id
          AND turn.turn_id = provider_runtime_open_turns.turn_id
          AND turn.state IN ('interrupted', 'completed', 'error')
      )
      OR NOT EXISTS (
        SELECT 1
        FROM projection_threads AS thread
        WHERE thread.thread_id = provider_runtime_open_turns.thread_id
          AND thread.deleted_at IS NULL
      )
      OR (
        EXISTS (
          SELECT 1
          FROM projection_threads AS thread
          WHERE thread.thread_id = provider_runtime_open_turns.thread_id
            AND thread.archived_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM projection_turns AS turn
          WHERE turn.thread_id = provider_runtime_open_turns.thread_id
            AND turn.turn_id = provider_runtime_open_turns.turn_id
            AND turn.state NOT IN ('interrupted', 'completed', 'error')
        )
      )
    `.pipe(
    Effect.asVoid,
    Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.pruneSettledOpenTurns")),
  );

  const getConsumerCursor: ProviderRuntimeEventRepositoryShape["getConsumerCursor"] = (
    consumerName,
  ) =>
    sql<{ readonly lastAckedSequence: number }>`
        SELECT last_acked_sequence AS "lastAckedSequence"
        FROM provider_runtime_event_consumers
        WHERE consumer_name = ${consumerName}
      `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(
              new PersistenceDecodeError({
                operation: "ProviderRuntimeEvent.getConsumerCursor",
                issue: `Consumer '${consumerName}' is not registered.`,
              }),
            )
          : Effect.succeed(rows[0].lastAckedSequence),
      ),
      Effect.mapError((error) =>
        error instanceof PersistenceDecodeError
          ? error
          : toPersistenceSqlError("ProviderRuntimeEvent.getConsumerCursor")(error),
      ),
    );

  const hasPendingEventsForThreads: ProviderRuntimeEventRepositoryShape["hasPendingEventsForThreads"] =
    (input) => {
      if (input.threadIds.length === 0) return Effect.succeed(false);
      return Effect.gen(function* () {
        const cursor = yield* getConsumerCursor(input.consumerName);
        const rows = yield* sql<{ readonly present: number }>`
          SELECT 1 AS present
          FROM provider_runtime_events
          WHERE sequence > ${cursor}
            AND thread_id IN ${sql.in(input.threadIds)}
          LIMIT 1
        `.pipe(
          Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.hasPendingEventsForThreads")),
        );
        return rows.length > 0;
      });
    };

  // Highest cursor position whose retention scan has already run. Process-local
  // on purpose: it is a "do not rescan yet" hint, never a durability record. A
  // restart resets it to 0, which makes the next cursor advance scan — the safe
  // direction, since the only effect of losing it is pruning sooner.
  let lastRetentionScanSequence = 0;

  const advanceConsumerCursor: ProviderRuntimeEventRepositoryShape["advanceConsumerCursor"] = (
    input,
  ) => {
    let retentionScanSequence: number | null = null;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const consumerRows = yield* sql<{ readonly lastAckedSequence: number }>`
            SELECT last_acked_sequence AS "lastAckedSequence"
            FROM provider_runtime_event_consumers
            WHERE consumer_name = ${input.consumerName}
          `;
          const cursor = consumerRows[0]?.lastAckedSequence;
          if (cursor === undefined) return false;
          if (cursor >= input.eventSequence) return true;

          // Event ids are idempotent and SQLite may leave sequence gaps after a
          // conflicting insert. Contiguity therefore means the exact next
          // stored row, not arithmetic sequence + 1.
          const nextRows = yield* sql<{ readonly sequence: number | null }>`
            SELECT MIN(sequence) AS sequence
            FROM provider_runtime_events
            WHERE sequence > ${cursor}
          `;
          if (nextRows[0]?.sequence !== input.eventSequence) return false;

          const eventRows = yield* sql<{
            readonly eventType: string;
            readonly threadId: string;
            readonly turnId: string | null;
          }>`
            SELECT event_type AS "eventType", thread_id AS "threadId", turn_id AS "turnId"
            FROM provider_runtime_events
            WHERE sequence = ${input.eventSequence}
          `;
          const event = eventRows[0];
          if (!event) return false;

          const advanced = yield* sql<{ readonly sequence: number }>`
            UPDATE provider_runtime_event_consumers
            SET last_acked_sequence = ${input.eventSequence}, updated_at = ${input.updatedAt}
            WHERE consumer_name = ${input.consumerName}
              AND last_acked_sequence = ${cursor}
            RETURNING last_acked_sequence AS sequence
          `;
          if (advanced.length !== 1) return false;

          const isTerminalTurnEvent =
            event.eventType === "turn.completed" || event.eventType === "turn.aborted";
          const isThreadTerminalEvent =
            event.eventType === "session.exited" || event.eventType === "runtime.error";
          if (event.turnId !== null && !isTerminalTurnEvent && !isThreadTerminalEvent) {
            yield* sql`
              INSERT INTO provider_runtime_open_turns (
                thread_id, turn_id, first_sequence, updated_at
              ) VALUES (
                ${event.threadId}, ${event.turnId}, ${input.eventSequence}, ${input.updatedAt}
              )
              ON CONFLICT (thread_id, turn_id) DO UPDATE SET
                first_sequence = MIN(
                  provider_runtime_open_turns.first_sequence,
                  excluded.first_sequence
                ),
                updated_at = excluded.updated_at
            `;
          } else if (event.turnId !== null) {
            yield* sql`
              DELETE FROM provider_runtime_open_turns
              WHERE thread_id = ${event.threadId} AND turn_id = ${event.turnId}
            `;
          } else if (isThreadTerminalEvent) {
            yield* sql`
              DELETE FROM provider_runtime_open_turns
              WHERE thread_id = ${event.threadId}
            `;
          } else if (isTerminalTurnEvent) {
            yield* sql`
              DELETE FROM provider_runtime_open_turns
              WHERE thread_id = ${event.threadId}
                AND 1 = (
                  SELECT COUNT(*) FROM provider_runtime_open_turns
                  WHERE thread_id = ${event.threadId}
                )
            `;
          }

          // Nothing below the cursor can become deletable while a turn only
          // grows, so the scan is worth running when a turn just settled (its
          // whole backlog is releasable now) or when enough events have piled up
          // since the last scan. See the interval constant for why this is safe.
          const settlesOpenTurns = isTerminalTurnEvent || isThreadTerminalEvent;
          if (
            !settlesOpenTurns &&
            input.eventSequence - lastRetentionScanSequence <
              PROVIDER_RUNTIME_EVENT_RETENTION_SCAN_INTERVAL
          ) {
            return true;
          }
          retentionScanSequence = input.eventSequence;

          // Pending rows are above the cursor. Accepted rows for an open turn
          // remain replayable until its terminal output is accepted; all other
          // accepted history is bounded to a diagnostic tail.
          yield* sql`
            DELETE FROM provider_runtime_events AS event
            WHERE event.sequence <= ${input.eventSequence}
              AND NOT EXISTS (
                SELECT 1
                FROM provider_runtime_open_turns AS open_turn
                WHERE open_turn.thread_id = event.thread_id
                  AND open_turn.turn_id = event.turn_id
                  AND event.sequence >= open_turn.first_sequence
              )
              AND event.sequence NOT IN (
                SELECT sequence
                FROM provider_runtime_events
                WHERE sequence <= ${input.eventSequence}
                ORDER BY sequence DESC
                LIMIT ${PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED}
              )
          `;
          return true;
        }),
      )
      .pipe(
        // Only a committed scan may move the hint forward; a rolled back
        // transaction leaves it where it was so the next advance rescans.
        Effect.tap(() =>
          Effect.sync(() => {
            if (retentionScanSequence !== null) {
              lastRetentionScanSequence = Math.max(
                lastRetentionScanSequence,
                retentionScanSequence,
              );
            }
          }),
        ),
        Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.advanceConsumerCursor")),
      );
  };

  return {
    append,
    getHighWaterSequence,
    readAfter,
    getThreadCoverage,
    readThreadEvents,
    readAcceptedOpenTurnEvents,
    pruneSettledOpenTurns,
    getConsumerCursor,
    hasPendingEventsForThreads,
    advanceConsumerCursor,
  } satisfies ProviderRuntimeEventRepositoryShape;
});

export const ProviderRuntimeEventRepositoryLive = Layer.effect(
  ProviderRuntimeEventRepository,
  make,
);
