import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import {
  ModelSelection,
  OrchestrationThreadPullRequest,
  ThreadPinnedMessages,
  ThreadMarkers,
  ThreadHandoff,
} from "@synara/contracts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    createBranchFlowCompleted: SqliteBoolean,
    isPinned: SqliteBoolean,
    handoff: Schema.NullOr(Schema.fromJsonString(ThreadHandoff)),
    lastKnownPr: Schema.NullOr(Schema.fromJsonString(OrchestrationThreadPullRequest)),
    pinnedMessages: Schema.NullOr(Schema.fromJsonString(ThreadPinnedMessages)),
    threadMarkers: Schema.NullOr(Schema.fromJsonString(ThreadMarkers)),
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          env_mode,
          branch,
          worktree_path,
          working_directory,
          associated_worktree_path,
          associated_worktree_branch,
          associated_worktree_ref,
          create_branch_flow_completed,
          is_pinned,
          parent_thread_id,
          creation_source,
          source_thread_id,
          source_turn_id,
          gateway_operation_id,
          gateway_operation_index,
          subagent_agent_id,
          subagent_nickname,
          subagent_role,
          fork_source_thread_id,
          sidechat_source_thread_id,
          last_known_pr_json,
          latest_turn_id,
          handoff_json,
          pinned_messages_json,
          thread_markers_json,
          notes,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          settled_at,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.envMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.workingDirectory ?? null},
          ${row.associatedWorktreePath ?? null},
          ${row.associatedWorktreeBranch ?? null},
          ${row.associatedWorktreeRef ?? null},
          ${row.createBranchFlowCompleted ? 1 : 0},
          ${row.isPinned ? 1 : 0},
          ${row.parentThreadId ?? null},
          ${row.creationSource ?? null},
          ${row.sourceThreadId ?? null},
          ${row.sourceTurnId ?? null},
          ${row.gatewayOperationId ?? null},
          ${row.gatewayOperationIndex ?? null},
          ${row.subagentAgentId ?? null},
          ${row.subagentNickname ?? null},
          ${row.subagentRole ?? null},
          ${row.forkSourceThreadId ?? null},
          ${row.sidechatSourceThreadId ?? null},
          ${row.lastKnownPr === null ? null : JSON.stringify(row.lastKnownPr)},
          ${row.latestTurnId},
          ${row.handoff === null ? null : JSON.stringify(row.handoff)},
          ${row.pinnedMessages === null ? null : JSON.stringify(row.pinnedMessages)},
          ${row.threadMarkers === null ? null : JSON.stringify(row.threadMarkers)},
          ${row.notes},
          ${row.latestUserMessageAt},
          ${row.pendingApprovalCount},
          ${row.pendingUserInputCount},
          ${row.hasActionableProposedPlan},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt ?? null},
          ${row.settledAt ?? null},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          env_mode = excluded.env_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          working_directory = excluded.working_directory,
          associated_worktree_path = excluded.associated_worktree_path,
          associated_worktree_branch = excluded.associated_worktree_branch,
          associated_worktree_ref = excluded.associated_worktree_ref,
          create_branch_flow_completed = excluded.create_branch_flow_completed,
          is_pinned = excluded.is_pinned,
          parent_thread_id = excluded.parent_thread_id,
          creation_source = excluded.creation_source,
          source_thread_id = excluded.source_thread_id,
          source_turn_id = excluded.source_turn_id,
          gateway_operation_id = excluded.gateway_operation_id,
          gateway_operation_index = excluded.gateway_operation_index,
          subagent_agent_id = excluded.subagent_agent_id,
          subagent_nickname = excluded.subagent_nickname,
          subagent_role = excluded.subagent_role,
          fork_source_thread_id = excluded.fork_source_thread_id,
          sidechat_source_thread_id = excluded.sidechat_source_thread_id,
          last_known_pr_json = excluded.last_known_pr_json,
          latest_turn_id = excluded.latest_turn_id,
          handoff_json = excluded.handoff_json,
          pinned_messages_json = excluded.pinned_messages_json,
          thread_markers_json = excluded.thread_markers_json,
          notes = excluded.notes,
          latest_user_message_at = excluded.latest_user_message_at,
          pending_approval_count = excluded.pending_approval_count,
          pending_user_input_count = excluded.pending_user_input_count,
          has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          settled_at = excluded.settled_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          working_directory AS "workingDirectory",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          create_branch_flow_completed AS "createBranchFlowCompleted",
          is_pinned AS "isPinned",
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          last_known_pr_json AS "lastKnownPr",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_at AS "settledAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          working_directory AS "workingDirectory",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          create_branch_flow_completed AS "createBranchFlowCompleted",
          is_pinned AS "isPinned",
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          last_known_pr_json AS "lastKnownPr",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_at AS "settledAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
