import {
  GitHandoffThreadInput,
  GitHandoffThreadResult,
  type OrchestrationCommand,
} from "@synara/contracts";
import { resolveWorktreeHandoffWorkspaceMetadata } from "@synara/shared/worktreeHandoff";
import { Data, Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type HandoffPhase = "pending" | "git_applied" | "completed" | "uncertain";

interface HandoffRow {
  readonly commandId: string;
  readonly threadId: string;
  readonly inputJson: string;
  readonly phase: HandoffPhase;
  readonly resultJson: string | null;
}

export type GitHandoffOperation =
  | { readonly phase: "new" }
  | { readonly phase: "pending" | "uncertain" }
  | {
      readonly phase: "git_applied" | "completed";
      readonly result: GitHandoffThreadResult;
    };

export class GitHandoffOperationError extends Data.TaggedError("GitHandoffOperationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const operationError = (message: string) => (cause: unknown) =>
  new GitHandoffOperationError({ message, cause });

const parseResult = (row: HandoffRow) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(GitHandoffThreadResult)(JSON.parse(row.resultJson ?? "")),
    catch: operationError(`Invalid persisted Git handoff result for ${row.commandId}.`),
  });

const readOperation = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<HandoffRow>`
      SELECT
        command_id AS "commandId",
        thread_id AS "threadId",
        input_json AS "inputJson",
        phase,
        result_json AS "resultJson"
      FROM git_handoff_operations
      WHERE command_id = ${commandId}
    `.pipe(Effect.mapError(operationError("Failed to read Git handoff operation.")));
    return rows[0] ?? null;
  });

const decodeOperation = (
  row: HandoffRow,
): Effect.Effect<GitHandoffOperation, GitHandoffOperationError> =>
  row.phase === "git_applied" || row.phase === "completed"
    ? parseResult(row).pipe(Effect.map((result) => ({ phase: row.phase, result })))
    : Effect.succeed({ phase: row.phase });

export const beginGitHandoff = (input: GitHandoffThreadInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inputJson = JSON.stringify(input);
    const now = new Date().toISOString();
    const inserted = yield* sql<{ readonly commandId: string }>`
      INSERT INTO git_handoff_operations (
        command_id, thread_id, input_json, phase, result_json, created_at, updated_at
      ) VALUES (
        ${input.commandId}, ${input.threadId}, ${inputJson}, 'pending', NULL, ${now}, ${now}
      )
      ON CONFLICT (command_id) DO NOTHING
      RETURNING command_id AS "commandId"
    `.pipe(Effect.mapError(operationError("Failed to begin Git handoff operation.")));
    if (inserted.length > 0) return { phase: "new" } as const;

    const existing = yield* readOperation(input.commandId);
    if (!existing || existing.threadId !== input.threadId || existing.inputJson !== inputJson) {
      return yield* new GitHandoffOperationError({
        message: `Git handoff command identity ${input.commandId} was reused with different input.`,
      });
    }
    return yield* decodeOperation(existing);
  });

export const recordGitHandoffResult = (commandId: string, result: GitHandoffThreadResult) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const resultJson = JSON.stringify(result);
    const now = new Date().toISOString();
    yield* sql`
      UPDATE git_handoff_operations
      SET phase = 'git_applied', result_json = ${resultJson}, updated_at = ${now}
      WHERE command_id = ${commandId} AND phase = 'pending'
    `.pipe(Effect.mapError(operationError("Failed to persist applied Git handoff result.")));
  });

export const completeGitHandoff = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE git_handoff_operations
      SET phase = 'completed', updated_at = ${new Date().toISOString()}
      WHERE command_id = ${commandId} AND phase = 'git_applied'
    `.pipe(Effect.mapError(operationError("Failed to complete Git handoff operation.")));
  });

export const discardPendingGitHandoff = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM git_handoff_operations
      WHERE command_id = ${commandId} AND phase = 'pending'
    `.pipe(Effect.mapError(operationError("Failed to discard failed Git handoff operation.")));
  });

export const gitHandoffMetadataCommand = (
  input: Pick<GitHandoffThreadInput, "commandId" | "threadId">,
  result: GitHandoffThreadResult,
): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: input.commandId,
  threadId: input.threadId,
  ...resolveWorktreeHandoffWorkspaceMetadata(result),
});

export const recoverGitHandoffOperations = (
  dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, unknown>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const interrupted = yield* sql<{ readonly commandId: string }>`
      UPDATE git_handoff_operations
      SET phase = 'uncertain', updated_at = ${new Date().toISOString()}
      WHERE phase = 'pending'
      RETURNING command_id AS "commandId"
    `.pipe(Effect.mapError(operationError("Failed to fence interrupted Git handoffs.")));
    if (interrupted.length > 0) {
      yield* Effect.logWarning("Git handoffs were interrupted before their result was durable", {
        commandIds: interrupted.map(({ commandId }) => commandId),
      });
    }

    const rows = yield* sql<HandoffRow>`
      SELECT
        command_id AS "commandId",
        thread_id AS "threadId",
        input_json AS "inputJson",
        phase,
        result_json AS "resultJson"
      FROM git_handoff_operations
      WHERE phase = 'git_applied'
      ORDER BY updated_at ASC, command_id ASC
    `.pipe(Effect.mapError(operationError("Failed to list recoverable Git handoffs.")));

    for (const row of rows) {
      const input = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(GitHandoffThreadInput)(JSON.parse(row.inputJson)),
        catch: operationError(`Invalid persisted Git handoff input for ${row.commandId}.`),
      });
      const result = yield* parseResult(row);
      yield* dispatch(gitHandoffMetadataCommand(input, result)).pipe(
        Effect.mapError(operationError(`Failed to recover Git handoff ${row.commandId}.`)),
      );
      yield* completeGitHandoff(row.commandId);
    }
  });
