import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventType,
  ProjectId,
  SpaceId,
  ThreadId,
} from "@synara/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Stream } from "effect";

import {
  PersistenceDecodeError,
  toPersistenceDecodeError,
  toPersistenceSqlOrDecodeError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../Services/OrchestrationEventStore.ts";
import {
  normalizeLegacyModelSelection,
  normalizePersistedModelSelection,
} from "../modelSelectionCompatibility.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

const AppendEventRequestSchema = Schema.Struct({
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.Union([SpaceId, ProjectId, ThreadId]),
  type: OrchestrationEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: UnknownFromJsonString,
});

// Decode only the SQL envelope here. JSON and domain-schema decoding happen one row at a
// time below so a corrupt or unsupported event always reports its exact sequence and type.
const RawPersistedEventRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: Schema.String,
  type: Schema.String,
  aggregateKind: Schema.String,
  aggregateId: Schema.String,
  occurredAt: Schema.String,
  commandId: Schema.NullOr(Schema.String),
  causationEventId: Schema.NullOr(Schema.String),
  correlationId: Schema.NullOr(Schema.String),
  payloadJson: Schema.String,
  metadataJson: Schema.String,
});

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  throughSequenceInclusive: NonNegativeInt,
  limit: Schema.Number,
});
const ReadThreadFromSequenceRequestSchema = Schema.Struct({
  threadId: Schema.String,
  sequenceExclusive: NonNegativeInt,
  throughSequenceInclusive: NonNegativeInt,
  limit: Schema.Number,
  eventTypes: Schema.Array(Schema.String),
});
const ReadThreadEventsRequestSchema = Schema.Struct({
  threadId: Schema.String,
  throughSequenceInclusive: NonNegativeInt,
  beforeSequenceExclusive: NonNegativeInt,
  limit: Schema.Number,
  eventTypes: Schema.Array(Schema.String),
});
const ThreadHighWaterRequestSchema = Schema.Struct({ threadId: Schema.String });
const HighWaterSequenceRowSchema = Schema.Struct({
  highWaterSequence: NonNegativeInt,
});
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000;
const READ_PAGE_SIZE = 500;
const CURRENT_PERSISTED_EVENT_SCHEMA_VERSION = 1;
const LEGACY_PERSISTED_EVENT_SCHEMA_VERSION = 0;
const PERSISTED_EVENT_SCHEMA_VERSION_KEY = "persistedEventSchemaVersion";
const LEGACY_MODEL_SELECTION_EVENT_TYPES = new Set([
  "thread.created",
  "thread.meta-updated",
  "thread.turn-start-requested",
]);

type RawPersistedEventRow = typeof RawPersistedEventRowSchema.Type;
type ParsedPersistedEventRow = Omit<RawPersistedEventRow, "payloadJson" | "metadataJson"> & {
  readonly payload: unknown;
  readonly metadata: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLegacyEventRow(row: ParsedPersistedEventRow): ParsedPersistedEventRow {
  if (!isRecord(row.payload)) {
    return row;
  }

  const originalPayload = row.payload;
  let normalizedPayload: Record<string, unknown> | undefined;
  const payloadWithNormalizedModelSelection = () => {
    normalizedPayload ??= { ...originalPayload };
    return normalizedPayload;
  };

  if (
    (row.type === "project.created" || row.type === "project.meta-updated") &&
    originalPayload.defaultModelSelection !== undefined &&
    originalPayload.defaultModelSelection !== null
  ) {
    payloadWithNormalizedModelSelection().defaultModelSelection = normalizePersistedModelSelection(
      originalPayload.defaultModelSelection,
    );
  }

  if (
    LEGACY_MODEL_SELECTION_EVENT_TYPES.has(row.type) &&
    originalPayload.modelSelection !== undefined
  ) {
    payloadWithNormalizedModelSelection().modelSelection = normalizePersistedModelSelection(
      originalPayload.modelSelection,
    );
  }

  if (
    (row.type === "project.created" || row.type === "project.meta-updated") &&
    originalPayload.defaultModelSelection === undefined
  ) {
    const nextPayload = payloadWithNormalizedModelSelection();
    const legacyModel = readTrimmedString(originalPayload, "defaultModel");
    nextPayload.defaultModelSelection = legacyModel
      ? normalizeLegacyModelSelection({
          provider: originalPayload.defaultProvider,
          model: legacyModel,
          options: originalPayload.defaultModelOptions,
        })
      : null;
    delete nextPayload.defaultProvider;
    delete nextPayload.defaultModel;
    delete nextPayload.defaultModelOptions;
    return { ...row, payload: nextPayload };
  }

  if (
    LEGACY_MODEL_SELECTION_EVENT_TYPES.has(row.type) &&
    originalPayload.modelSelection === undefined
  ) {
    const nextPayload = payloadWithNormalizedModelSelection();
    const legacyModel =
      readTrimmedString(originalPayload, "model") ??
      (row.type === "thread.created" ? "gpt-5.5" : undefined);
    if (legacyModel !== undefined) {
      nextPayload.modelSelection = normalizeLegacyModelSelection({
        provider: originalPayload.provider,
        model: legacyModel,
        options: originalPayload.modelOptions,
      });
    }
    delete nextPayload.provider;
    delete nextPayload.model;
    delete nextPayload.modelOptions;
    return { ...row, payload: nextPayload };
  }

  return normalizedPayload === undefined ? row : { ...row, payload: normalizedPayload };
}

type PersistedEventUpcaster = (row: ParsedPersistedEventRow) => ParsedPersistedEventRow;

// Every unversioned event passes through the same v0 -> v1 boundary. Most event types are a
// no-op; the model-selection families need the historical shape normalization above.
const PERSISTED_EVENT_UPCASTERS: Readonly<Record<number, PersistedEventUpcaster>> = {
  [LEGACY_PERSISTED_EVENT_SCHEMA_VERSION]: normalizeLegacyEventRow,
};

function persistedEventDecodeOperation(
  operation: string,
  row: RawPersistedEventRow,
  schemaVersion?: number,
): string {
  const versionDetail = schemaVersion === undefined ? "" : `, schemaVersion=${schemaVersion}`;
  return `${operation}(sequence=${row.sequence}, type=${row.type}${versionDetail})`;
}

function makePersistedEventDecodeError(
  operation: string,
  row: RawPersistedEventRow,
  issue: string,
  cause?: unknown,
): PersistenceDecodeError {
  return new PersistenceDecodeError({
    operation: persistedEventDecodeOperation(operation, row),
    issue,
    ...(cause === undefined ? {} : { cause }),
  });
}

function parsePersistedJson(
  operation: string,
  row: RawPersistedEventRow,
  field: "payloadJson" | "metadataJson",
): Effect.Effect<unknown, PersistenceDecodeError> {
  return Effect.try({
    try: () => JSON.parse(row[field]) as unknown,
    catch: (cause) =>
      makePersistedEventDecodeError(
        operation,
        row,
        `Stored ${field === "payloadJson" ? "payload_json" : "metadata_json"} is not valid JSON.`,
        cause,
      ),
  });
}

function decodePersistedEventRow(
  operation: string,
  row: RawPersistedEventRow,
): Effect.Effect<OrchestrationEvent, PersistenceDecodeError> {
  return Effect.gen(function* () {
    const payload = yield* parsePersistedJson(operation, row, "payloadJson");
    const rawMetadata = yield* parsePersistedJson(operation, row, "metadataJson");
    const metadata = isRecord(rawMetadata) ? { ...rawMetadata } : rawMetadata;
    const rawSchemaVersion = isRecord(metadata)
      ? metadata[PERSISTED_EVENT_SCHEMA_VERSION_KEY]
      : undefined;
    const schemaVersion =
      rawSchemaVersion === undefined ? LEGACY_PERSISTED_EVENT_SCHEMA_VERSION : rawSchemaVersion;

    if (
      typeof schemaVersion !== "number" ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < LEGACY_PERSISTED_EVENT_SCHEMA_VERSION
    ) {
      return yield* makePersistedEventDecodeError(
        operation,
        row,
        `Invalid persisted event schema version; expected a non-negative safe integer, received ${typeof schemaVersion}.`,
      );
    }
    if (schemaVersion > CURRENT_PERSISTED_EVENT_SCHEMA_VERSION) {
      return yield* makePersistedEventDecodeError(
        operation,
        row,
        `Unsupported persisted event schema version ${schemaVersion}; this build supports through ${CURRENT_PERSISTED_EVENT_SCHEMA_VERSION}.`,
      );
    }

    if (isRecord(metadata)) {
      delete metadata[PERSISTED_EVENT_SCHEMA_VERSION_KEY];
    }
    let candidate: ParsedPersistedEventRow = {
      sequence: row.sequence,
      eventId: row.eventId,
      type: row.type,
      aggregateKind: row.aggregateKind,
      aggregateId: row.aggregateId,
      occurredAt: row.occurredAt,
      commandId: row.commandId,
      causationEventId: row.causationEventId,
      correlationId: row.correlationId,
      payload,
      metadata,
    };
    for (
      let version = schemaVersion;
      version < CURRENT_PERSISTED_EVENT_SCHEMA_VERSION;
      version += 1
    ) {
      const upcaster = PERSISTED_EVENT_UPCASTERS[version];
      if (!upcaster) {
        return yield* makePersistedEventDecodeError(
          operation,
          row,
          `No persisted event upcaster is registered for schema version ${version}.`,
        );
      }
      candidate = upcaster(candidate);
    }

    return yield* decodeEvent(candidate).pipe(
      Effect.mapError(
        toPersistenceDecodeError(persistedEventDecodeOperation(operation, row, schemaVersion)),
      ),
    );
  });
}

function inferActorKind(
  event: Omit<OrchestrationEvent, "sequence">,
): Schema.Schema.Type<typeof OrchestrationActorKind> {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) {
    return "provider";
  }
  if (event.commandId !== null && event.commandId.startsWith("server:")) {
    return "server";
  }
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  if (event.commandId === null) {
    return "server";
  }
  return "client";
}

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEventRow = SqlSchema.findOne({
    Request: AppendEventRequestSchema,
    Result: RawPersistedEventRowSchema,
    execute: (request) =>
      sql`
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
          ${request.eventId},
          ${request.aggregateKind},
          ${request.streamId},
          COALESCE(
            (
              SELECT stream_version + 1
              FROM orchestration_events
              WHERE aggregate_kind = ${request.aggregateKind}
                AND stream_id = ${request.streamId}
              ORDER BY stream_version DESC
              LIMIT 1
            ),
            0
          ),
          ${request.type},
          ${request.occurredAt},
          ${request.commandId},
          ${request.causationEventId},
          ${request.correlationId},
          ${request.actorKind},
          ${request.payloadJson},
          ${request.metadataJson}
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
      `,
  });

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
    Result: RawPersistedEventRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
          AND sequence <= ${request.throughSequenceInclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });

  const readThreadEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadThreadFromSequenceRequestSchema,
    Result: RawPersistedEventRowSchema,
    execute: (request) => {
      const typeFilter =
        request.eventTypes.length === 0
          ? sql``
          : sql`AND event_type IN ${sql.in(request.eventTypes)}`;
      return sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${request.threadId}
          AND sequence > ${request.sequenceExclusive}
          AND sequence <= ${request.throughSequenceInclusive}
          ${typeFilter}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `;
    },
  });

  const readHighWaterSequenceRow = SqlSchema.findOne({
    Request: Schema.Void,
    Result: HighWaterSequenceRowSchema,
    execute: () =>
      sql`
        SELECT COALESCE(MAX(sequence), 0) AS "highWaterSequence"
        FROM orchestration_events
      `,
  });

  const readThreadHighWaterSequenceRow = SqlSchema.findOne({
    Request: ThreadHighWaterRequestSchema,
    Result: HighWaterSequenceRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT COALESCE(MAX(sequence), 0) AS "highWaterSequence"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      `,
  });

  const readThreadEventRows = SqlSchema.findAll({
    Request: ReadThreadEventsRequestSchema,
    Result: RawPersistedEventRowSchema,
    execute: (request) => {
      const typeFilter =
        request.eventTypes.length === 0
          ? sql``
          : sql`AND event_type IN ${sql.in(request.eventTypes)}`;
      return sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${request.threadId}
          AND sequence <= ${request.throughSequenceInclusive}
          AND sequence < ${request.beforeSequenceExclusive}
          ${typeFilter}
        ORDER BY sequence DESC
        LIMIT ${request.limit}
      `;
    },
  });

  const append: OrchestrationEventStoreShape["append"] = (event) =>
    appendEventRow({
      eventId: event.eventId,
      aggregateKind: event.aggregateKind,
      streamId: event.aggregateId,
      type: event.type,
      causationEventId: event.causationEventId,
      correlationId: event.correlationId,
      actorKind: inferActorKind(event),
      occurredAt: event.occurredAt,
      commandId: event.commandId,
      payloadJson: event.payload,
      metadataJson: {
        ...event.metadata,
        [PERSISTED_EVENT_SCHEMA_VERSION_KEY]: CURRENT_PERSISTED_EVENT_SCHEMA_VERSION,
      },
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.append:insert",
          "OrchestrationEventStore.append:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        decodePersistedEventRow("OrchestrationEventStore.append:rowToEvent", row),
      ),
    );

  const readFromSequence: OrchestrationEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
    throughSequenceInclusive = Number.MAX_SAFE_INTEGER,
  ) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    const normalizedThroughSequence = Math.max(0, Math.floor(throughSequenceInclusive));
    if (normalizedLimit === 0 || normalizedThroughSequence <= sequenceExclusive) {
      return Stream.empty;
    }
    const readPage = (
      cursor: number,
      remaining: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          throughSequenceInclusive: normalizedThroughSequence,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "OrchestrationEventStore.readFromSequence:query",
              "OrchestrationEventStore.readFromSequence:decodeRows",
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodePersistedEventRow("OrchestrationEventStore.readFromSequence:rowToEvent", row),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap((events) => {
          if (events.length === 0) {
            return Stream.empty;
          }
          const nextRemaining = remaining - events.length;
          if (nextRemaining <= 0) {
            return Stream.fromIterable(events);
          }
          return Stream.concat(
            Stream.fromIterable(events),
            readPage(events[events.length - 1]!.sequence, nextRemaining),
          );
        }),
      );

    return readPage(sequenceExclusive, normalizedLimit);
  };

  const readThreadEventsFromSequence: OrchestrationEventStoreShape["readThreadEventsFromSequence"] =
    (
      threadId,
      sequenceExclusive,
      limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
      throughSequenceInclusive = Number.MAX_SAFE_INTEGER,
      eventTypes = [],
    ) => {
      const normalizedLimit = Math.max(0, Math.floor(limit));
      const normalizedThroughSequence = Math.max(0, Math.floor(throughSequenceInclusive));
      if (normalizedLimit === 0 || normalizedThroughSequence <= sequenceExclusive) {
        return Stream.empty;
      }
      const readPage = (
        cursor: number,
        remaining: number,
      ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
        Stream.fromEffect(
          readThreadEventRowsFromSequence({
            threadId,
            sequenceExclusive: cursor,
            throughSequenceInclusive: normalizedThroughSequence,
            limit: Math.min(remaining, READ_PAGE_SIZE),
            eventTypes: [...eventTypes],
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "OrchestrationEventStore.readThreadEventsFromSequence:query",
                "OrchestrationEventStore.readThreadEventsFromSequence:decodeRows",
              ),
            ),
            Effect.flatMap((rows) =>
              Effect.forEach(rows, (row) =>
                decodePersistedEventRow(
                  "OrchestrationEventStore.readThreadEventsFromSequence:rowToEvent",
                  row,
                ),
              ),
            ),
          ),
        ).pipe(
          Stream.flatMap((events) => {
            if (events.length === 0) return Stream.empty;
            const nextRemaining = remaining - events.length;
            if (nextRemaining <= 0) return Stream.fromIterable(events);
            return Stream.concat(
              Stream.fromIterable(events),
              readPage(events[events.length - 1]!.sequence, nextRemaining),
            );
          }),
        );

      return readPage(sequenceExclusive, normalizedLimit);
    };

  const getHighWaterSequence: OrchestrationEventStoreShape["getHighWaterSequence"] = () =>
    readHighWaterSequenceRow(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.getHighWaterSequence:query",
          "OrchestrationEventStore.getHighWaterSequence:decodeRow",
        ),
      ),
      Effect.map((row) => row.highWaterSequence),
    );

  const getThreadHighWaterSequence: OrchestrationEventStoreShape["getThreadHighWaterSequence"] = (
    threadId,
  ) =>
    readThreadHighWaterSequenceRow({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.getThreadHighWaterSequence:query",
          "OrchestrationEventStore.getThreadHighWaterSequence:decodeRow",
        ),
      ),
      Effect.map((row) => row.highWaterSequence),
    );

  const readThreadEvents: OrchestrationEventStoreShape["readThreadEvents"] = (input) => {
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit === 0) return Effect.succeed([]);
    return readThreadEventRows({
      threadId: input.threadId,
      throughSequenceInclusive: Math.max(0, Math.floor(input.throughSequenceInclusive)),
      beforeSequenceExclusive: Math.max(
        0,
        Math.floor(input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER),
      ),
      limit,
      eventTypes: [...(input.eventTypes ?? [])],
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.readThreadEvents:query",
          "OrchestrationEventStore.readThreadEvents:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodePersistedEventRow("OrchestrationEventStore.readThreadEvents:rowToEvent", row),
        ),
      ),
    );
  };

  return {
    append,
    getHighWaterSequence,
    getThreadHighWaterSequence,
    readThreadEvents,
    readThreadEventsFromSequence,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);
