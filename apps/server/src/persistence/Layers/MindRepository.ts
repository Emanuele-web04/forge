import { createHash } from "node:crypto";

import { MindMemory, MindMemoryId, MindJournalOp } from "@synara/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";

import {
  toPersistenceDecodeCauseError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  toPersistenceSqlOrDecodeError,
} from "../Errors.ts";
import { MIND_DECAY_LAMBDA } from "../../mind/scoring.ts";
import {
  ConfirmMindMemoryInput,
  CountMindMemoriesInput,
  FindMindMemoryByTextInput,
  ForgetMindMemoryInput,
  GetMindMemoryInput,
  ListMindMemoriesInput,
  MindRepository,
  PinMindMemoryInput,
  PruneMindMemoriesInput,
  RecallMindMemoriesInput,
  RecordMindJournalInput,
  RememberMindMemoryInput,
  type MindRepositoryShape,
} from "../Services/MindRepository.ts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const MindMemoryDbRow = MindMemory.mapFields(
  Struct.assign({
    pinned: SqliteBoolean,
  }),
);
type MindMemoryDbRow = typeof MindMemoryDbRow.Type;

const toMemory = (row: MindMemoryDbRow) =>
  Schema.decodeUnknownEffect(MindMemory)(row).pipe(
    Effect.mapError(toPersistenceDecodeError("MindRepository.rowToDomain")),
  );

const normalizeText = (text: string): string => text.trim().replace(/\s+/g, " ");

/**
 * Build a safe FTS5 MATCH query from raw user input. Each whitespace token
 * becomes a quoted phrase (embedded quotes doubled) joined with AND, so
 * punctuation and operators (quotes, *, OR/AND/NOT, parens) stay literal
 * instead of throwing MATCH syntax errors. Returns null when no usable
 * token remains so callers fall back to the unfiltered scan branch.
 */
const toFtsMatchQuery = (query: string): string | null => {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/"/g, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(" AND ");
};

const memoryIdFor = (projectId: string, text: string): MindMemoryId => {
  const normalized = normalizeText(text);
  const hash = createHash("sha256").update(`memory:${projectId}:${normalized}`).digest("base64url");
  return MindMemoryId.makeUnsafe(hash);
};

const RememberMindMemoryRequest = Schema.Struct({
  memoryId: MindMemoryId,
  projectId: MindMemory.fields.projectId,
  text: MindMemory.fields.text,
  weight: MindMemory.fields.weight,
  accessCount: MindMemory.fields.accessCount,
  pinned: MindMemory.fields.pinned,
  createdAt: MindMemory.fields.createdAt,
  updatedAt: MindMemory.fields.updatedAt,
  now: MindMemory.fields.updatedAt,
});

const makeMindRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRememberRow = SqlSchema.findOneOption({
    Request: RememberMindMemoryRequest,
    Result: MindMemoryDbRow,
    execute: ({
      memoryId,
      projectId,
      text,
      weight,
      accessCount,
      pinned,
      createdAt,
      updatedAt,
      now,
    }) =>
      sql`
        INSERT INTO mind_memories (
          memory_id,
          project_id,
          text,
          weight,
          access_count,
          pinned,
          created_at,
          updated_at
        )
        VALUES (
          ${memoryId},
          ${projectId},
          ${text},
          ${weight},
          ${accessCount},
          ${pinned ? 1 : 0},
          ${createdAt},
          ${updatedAt}
        )
        ON CONFLICT (memory_id) DO UPDATE SET
          weight = min(1.0, weight + 0.02),
          access_count = access_count + 1,
          updated_at = ${now}
        RETURNING
          memory_id AS "memoryId",
          project_id AS "projectId",
          text,
          weight,
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const findByTextRow = SqlSchema.findOneOption({
    Request: FindMindMemoryByTextInput,
    Result: MindMemoryDbRow,
    execute: ({ projectId, text }) =>
      sql`
        SELECT
          memory_id AS "memoryId",
          project_id AS "projectId",
          text,
          weight,
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM mind_memories
        WHERE project_id = ${projectId} AND text = ${text}
      `,
  });

  const getByIdRow = SqlSchema.findOneOption({
    Request: GetMindMemoryInput,
    Result: MindMemoryDbRow,
    execute: ({ memoryId, projectId }) =>
      sql`
        SELECT
          memory_id AS "memoryId",
          project_id AS "projectId",
          text,
          weight,
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM mind_memories
        WHERE memory_id = ${memoryId} AND project_id = ${projectId}
      `,
  });

  const recallRows = SqlSchema.findAll({
    Request: RecallMindMemoriesInput,
    Result: MindMemoryDbRow,
    execute: ({ projectId, query }) => {
      const q = query === undefined ? null : toFtsMatchQuery(query);
      if (q !== null) {
        return sql`
          WITH matches AS (
            SELECT rowid, rank
            FROM mind_memories_fts
            WHERE mind_memories_fts MATCH ${q}
          )
          SELECT
            m.memory_id AS "memoryId",
            m.project_id AS "projectId",
            m.text,
            m.weight,
            m.access_count AS "accessCount",
            m.pinned,
            m.created_at AS "createdAt",
            m.updated_at AS "updatedAt"
          FROM mind_memories m
          JOIN matches ON m.rowid = matches.rowid
          WHERE m.project_id = ${projectId}
          ORDER BY matches.rank
        `;
      }
      return sql`
        SELECT
          memory_id AS "memoryId",
          project_id AS "projectId",
          text,
          weight,
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM mind_memories
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC, memory_id ASC
      `;
    },
  });

  const confirmRow = SqlSchema.findOneOption({
    Request: ConfirmMindMemoryInput,
    Result: MindMemoryDbRow,
    execute: ({ projectId, memoryId, now }) =>
      sql`
        UPDATE mind_memories
        SET weight = weight + min(0.15, 1.0 - weight),
            updated_at = ${now}
        WHERE memory_id = ${memoryId} AND project_id = ${projectId}
        RETURNING
          memory_id AS "memoryId",
          project_id AS "projectId",
          text,
          weight,
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const deleteMemoryRow = SqlSchema.void({
    Request: ForgetMindMemoryInput,
    execute: ({ projectId, memoryId }) =>
      sql`
        DELETE FROM mind_memories
        WHERE memory_id = ${memoryId} AND project_id = ${projectId}
      `,
  });

  const pinRow = SqlSchema.findOneOption({
    Request: PinMindMemoryInput,
    Result: MindMemoryDbRow,
    execute: ({ projectId, memoryId, pinned, now }) =>
      sql`
        UPDATE mind_memories
        SET pinned = ${pinned ? 1 : 0},
            updated_at = ${now}
        WHERE memory_id = ${memoryId} AND project_id = ${projectId}
        RETURNING
          memory_id AS "memoryId",
          project_id AS "projectId",
          text,
          weight,
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: ListMindMemoriesInput,
    Result: MindMemoryDbRow,
    execute: ({ projectId, query }) => {
      const q = query === undefined ? null : toFtsMatchQuery(query);
      if (q !== null) {
        return sql`
          WITH matches AS (
            SELECT rowid
            FROM mind_memories_fts
            WHERE mind_memories_fts MATCH ${q}
          )
          SELECT
            m.memory_id AS "memoryId",
            m.project_id AS "projectId",
            m.text,
            m.weight,
            m.access_count AS "accessCount",
            m.pinned,
            m.created_at AS "createdAt",
            m.updated_at AS "updatedAt"
          FROM mind_memories m
          JOIN matches ON m.rowid = matches.rowid
          WHERE m.project_id = ${projectId}
          ORDER BY m.updated_at DESC, m.memory_id ASC
        `;
      }
      return sql`
        SELECT
          memory_id AS "memoryId",
          project_id AS "projectId",
          text,
          weight,
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM mind_memories
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC, memory_id ASC
      `;
    },
  });

  const countProjectRows = SqlSchema.findOneOption({
    Request: CountMindMemoriesInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ projectId }) =>
      sql`
        SELECT COUNT(*) AS count
        FROM mind_memories
        WHERE project_id = ${projectId}
      `,
  });

  const pruneRows = SqlSchema.findAll({
    Request: PruneMindMemoriesInput,
    Result: Schema.Struct({ memoryId: MindMemoryId }),
    execute: ({ projectId, now }) => {
      const cutoff = new Date(new Date(now).getTime() - 45 * 86400_000).toISOString();
      return sql`
        DELETE FROM mind_memories
        WHERE project_id = ${projectId}
          AND weight * exp(-${MIND_DECAY_LAMBDA} * (julianday(${now}) - julianday(updated_at))) < 0.1
          AND access_count < 2
          AND updated_at < ${cutoff}
          AND pinned = 0
        RETURNING memory_id AS "memoryId"
      `;
    },
  });

  const recordJournalRow = SqlSchema.void({
    Request: RecordMindJournalInput,
    execute: ({ memoryId, projectId, turnId, op, weightDelta, createdAt }) =>
      sql`
        INSERT INTO mind_memory_journal (
          memory_id,
          project_id,
          turn_id,
          op,
          weight_delta,
          created_at
        )
        VALUES (
          ${memoryId},
          ${projectId},
          ${turnId ?? null},
          ${op},
          ${weightDelta ?? null},
          ${createdAt}
        )
      `,
  });

  const withDecodedMemory = (rowOption: Option.Option<MindMemoryDbRow>, operation: string) =>
    Option.match(rowOption, {
      onNone: () =>
        Effect.fail(
          toPersistenceDecodeCauseError(operation)(
            new Error("Memory row was not found after operation."),
          ),
        ),
      onSome: toMemory,
    });

  const withOptionalMemory = (rowOption: Option.Option<MindMemoryDbRow>) =>
    Option.match(rowOption, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (row) => toMemory(row).pipe(Effect.map(Option.some)),
    });

  const remember: MindRepositoryShape["remember"] = (input) =>
    Effect.gen(function* () {
      const now = input.now;
      const normalized = normalizeText(input.text);
      const memoryId = memoryIdFor(input.projectId, input.text);
      const row = yield* upsertRememberRow({
        memoryId,
        projectId: input.projectId,
        text: normalized,
        weight: 1.0,
        accessCount: 0,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        now,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "MindRepository.remember:query",
            "MindRepository.remember:decodeRow",
          ),
        ),
      );
      return yield* withDecodedMemory(row, "MindRepository.remember:missingRow");
    });

  const findByText: MindRepositoryShape["findByText"] = (input) =>
    findByTextRow({
      projectId: input.projectId,
      text: normalizeText(input.text),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "MindRepository.findByText:query",
          "MindRepository.findByText:decodeRow",
        ),
      ),
      Effect.flatMap(withOptionalMemory),
    );

  const getById: MindRepositoryShape["getById"] = (input) =>
    getByIdRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "MindRepository.getById:query",
          "MindRepository.getById:decodeRow",
        ),
      ),
      Effect.flatMap(withOptionalMemory),
    );

  const recall: MindRepositoryShape["recall"] = (input) =>
    recallRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "MindRepository.recall:query",
          "MindRepository.recall:decodeRows",
        ),
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, toMemory, { concurrency: "unbounded" })),
    );

  const confirm: MindRepositoryShape["confirm"] = (input) =>
    confirmRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "MindRepository.confirm:update",
          "MindRepository.confirm:decodeRow",
        ),
      ),
      Effect.flatMap((row) => withDecodedMemory(row, "MindRepository.confirm:missingRow")),
    );

  const forget: MindRepositoryShape["forget"] = (input) =>
    deleteMemoryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.forget:delete")),
    );

  const pin: MindRepositoryShape["pin"] = (input) =>
    pinRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError("MindRepository.pin:update", "MindRepository.pin:decodeRow"),
      ),
      Effect.flatMap((row) => withDecodedMemory(row, "MindRepository.pin:missingRow")),
    );

  const list: MindRepositoryShape["list"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "MindRepository.list:query",
          "MindRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, toMemory, { concurrency: "unbounded" })),
    );

  const countByProject: MindRepositoryShape["countByProject"] = (input) =>
    countProjectRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.countByProject:query")),
      Effect.map((rowOption) =>
        Option.match(rowOption, {
          onNone: () => 0,
          onSome: (row) => row.count,
        }),
      ),
    );

  const prune: MindRepositoryShape["prune"] = (input) =>
    pruneRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "MindRepository.prune:delete",
          "MindRepository.prune:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.memoryId)),
    );

  const recordJournal: MindRepositoryShape["recordJournal"] = (input) =>
    recordJournalRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.recordJournal:insert")),
    );

  return {
    remember,
    findByText,
    getById,
    recall,
    confirm,
    forget,
    pin,
    list,
    countByProject,
    prune,
    recordJournal,
  } satisfies MindRepositoryShape;
});

export const MindRepositoryLive = Layer.effect(MindRepository, makeMindRepository);
