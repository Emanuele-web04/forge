import { randomUUID } from "node:crypto";

import { PullRequestReviewDraft } from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import {
  PullRequestReviewDraftStore,
  type PullRequestReviewDraftIdentity,
  type PullRequestReviewDraftStoreShape,
} from "../Services/PullRequestReviewDraftStore.ts";

interface DraftRow {
  readonly id: string;
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly patchSignature: string;
  readonly path: string;
  readonly line: number;
  readonly side: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const decodeDraft = Schema.decodeUnknownEffect(PullRequestReviewDraft);

const decodeRows = (label: string, rows: ReadonlyArray<DraftRow>) =>
  Effect.forEach(rows, (row) => decodeDraft(row)).pipe(
    Effect.mapError(toPersistenceDecodeCauseError(`${label}:decodeRows`)),
  );

const makePullRequestReviewDraftStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectDrafts = (
    input: PullRequestReviewDraftIdentity & {
      readonly id?: string;
      readonly ids?: ReadonlyArray<string>;
    },
  ) => sql<DraftRow>`
    SELECT
      id,
      repository,
      pull_request_number AS "number",
      head_sha AS "headSha",
      patch_signature AS "patchSignature",
      path,
      line,
      side,
      body,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM pull_request_review_drafts
    WHERE repository = ${input.repository}
      AND pull_request_number = ${input.number}
      ${input.id === undefined ? sql`` : sql`AND id = ${input.id}`}
      ${input.ids === undefined ? sql`` : sql`AND id IN ${sql.in(input.ids)}`}
    ORDER BY created_at ASC, id ASC
  `;

  const list: PullRequestReviewDraftStoreShape["list"] = (input) =>
    selectDrafts(input).pipe(
      Effect.mapError(toPersistenceSqlError("PullRequestReviewDraftStore.list:query")),
      Effect.flatMap((rows) => decodeRows("PullRequestReviewDraftStore.list", rows)),
    );

  const listByIds: PullRequestReviewDraftStoreShape["listByIds"] = (input) =>
    input.ids.length === 0
      ? Effect.succeed([])
      : selectDrafts(input).pipe(
          Effect.mapError(toPersistenceSqlError("PullRequestReviewDraftStore.listByIds:query")),
          Effect.flatMap((rows) => decodeRows("PullRequestReviewDraftStore.listByIds", rows)),
        );

  const create: PullRequestReviewDraftStoreShape["create"] = (input) =>
    Effect.gen(function* () {
      const timestamp = new Date().toISOString();
      const draft = {
        id: randomUUID(),
        repository: input.repository,
        number: input.number,
        headSha: input.headSha,
        patchSignature: input.patchSignature,
        path: input.path,
        line: input.line,
        side: input.side,
        body: input.body,
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies PullRequestReviewDraft;
      yield* sql`
        INSERT INTO pull_request_review_drafts (
          id,
          repository,
          pull_request_number,
          head_sha,
          patch_signature,
          path,
          line,
          side,
          body,
          created_at,
          updated_at
        )
        VALUES (
          ${draft.id},
          ${draft.repository},
          ${draft.number},
          ${draft.headSha},
          ${draft.patchSignature},
          ${draft.path},
          ${draft.line},
          ${draft.side},
          ${draft.body},
          ${draft.createdAt},
          ${draft.updatedAt}
        )
      `.pipe(Effect.mapError(toPersistenceSqlError("PullRequestReviewDraftStore.create:query")));
      return draft;
    });

  const update: PullRequestReviewDraftStoreShape["update"] = (input) =>
    Effect.gen(function* () {
      const updatedAt = new Date().toISOString();
      const rows = yield* sql<DraftRow>`
        UPDATE pull_request_review_drafts
        SET body = ${input.body}, updated_at = ${updatedAt}
        WHERE id = ${input.id}
          AND repository = ${input.repository}
          AND pull_request_number = ${input.number}
        RETURNING
          id,
          repository,
          pull_request_number AS "number",
          head_sha AS "headSha",
          patch_signature AS "patchSignature",
          path,
          line,
          side,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `.pipe(Effect.mapError(toPersistenceSqlError("PullRequestReviewDraftStore.update:query")));
      const drafts = yield* decodeRows("PullRequestReviewDraftStore.update", rows);
      return Option.fromNullishOr(drafts[0]);
    });

  const deleteDraft: PullRequestReviewDraftStoreShape["delete"] = (input) =>
    sql`
      DELETE FROM pull_request_review_drafts
      WHERE id = ${input.id}
        AND repository = ${input.repository}
        AND pull_request_number = ${input.number}
      RETURNING id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("PullRequestReviewDraftStore.delete:query")),
    );

  const deleteMany: PullRequestReviewDraftStoreShape["deleteMany"] = (input) =>
    input.ids.length === 0
      ? Effect.void
      : sql`
          DELETE FROM pull_request_review_drafts
          WHERE repository = ${input.repository}
            AND pull_request_number = ${input.number}
            AND id IN ${sql.in(input.ids)}
        `.pipe(
          Effect.asVoid,
          Effect.mapError(toPersistenceSqlError("PullRequestReviewDraftStore.deleteMany:query")),
        );

  return {
    list,
    listByIds,
    create,
    update,
    delete: deleteDraft,
    deleteMany,
  } satisfies PullRequestReviewDraftStoreShape;
});

export const PullRequestReviewDraftStoreLive = Layer.effect(
  PullRequestReviewDraftStore,
  makePullRequestReviewDraftStore,
);
