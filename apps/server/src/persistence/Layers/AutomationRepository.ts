import { randomBytes } from "node:crypto";

import {
  AutomationCompletionPolicy,
  AutomationDefinition,
  AutomationMemory,
  AutomationPermissionSnapshot,
  AutomationRun,
  AutomationSchedule,
  DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES,
  DEFAULT_AUTOMATION_RUNTIME_MODE,
  ModelSelection,
  NonNegativeInt,
  ProviderStartOptions,
  ProjectId,
  TurnId,
} from "@synara/contracts";
import { automationRequiresTargetThread } from "@synara/shared/automationMode";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { resolveAutomationStopPolicy } from "../../automation/stopPolicy.ts";

import {
  toPersistenceDecodeCauseError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  AcquireAutomationSchedulerLeaseInput,
  ArchiveAutomationDefinitionInput,
  AttachAutomationDefinitionThreadInput,
  AutomationRepository,
  type AutomationRepositoryShape,
  CountActiveAutomationRunsByThreadInput,
  CountActiveAutomationRunsInput,
  CountPendingCompletionEvaluationsByThreadInput,
  DisableAutomationDefinitionInput,
  DisableAutomationDefinitionIfUnchangedInput,
  GetEarliestAutomationNextRunAtInput,
  GetAutomationMemoryInput,
  GetAutomationDefinitionInput,
  GetDeferredAutomationRunInput,
  GetLatestFinishedAutomationRunInput,
  GetAutomationRunByThreadInput,
  GetAutomationRunInput,
  IncrementAutomationIterationInput,
  ListActiveAutomationRunsForDefinitionInput,
  ListAutomationRunsForDefinitionInput,
  ListDueAutomationDefinitionsInput,
  ListAutomationRunsNeedingCompletionEvaluationInput,
  ListDueDeferredAutomationRunsInput,
  ListRecoverableAutomationRunsInput,
  MarkAutomationRunFailedInput,
  MarkAutomationRunInterruptedInput,
  MarkAutomationRunResultInput,
  MarkAutomationRunSkippedInput,
  MarkAutomationRunStartedInput,
  MarkAutomationRunSucceededInput,
  MarkAutomationRunWaitingForApprovalInput,
  ReserveDeferredAutomationRunInput,
  RecordAutomationDefinitionRunFailureInput,
  RecordAutomationDefinitionRunFailureResult,
  ResetAutomationDefinitionFailureCountInput,
  ResolvePendingAutomationProposalInput,
  RestartAutomationDefinitionLoopInput,
  SetAutomationRunDeferredInput,
  SetAutomationDefinitionNextRunAtInput,
  UpsertAutomationMemoryInput,
} from "../Services/AutomationRepository.ts";

const AutomationDefinitionDbRow = Schema.Struct({
  id: AutomationDefinition.fields.id,
  projectId: AutomationDefinition.fields.projectId,
  sourceThreadId: AutomationDefinition.fields.sourceThreadId,
  name: AutomationDefinition.fields.name,
  prompt: AutomationDefinition.fields.prompt,
  schedule: Schema.fromJsonString(AutomationSchedule),
  enabled: Schema.Number,
  nextRunAt: AutomationDefinition.fields.nextRunAt,
  modelSelection: Schema.fromJsonString(ModelSelection),
  providerOptions: Schema.NullOr(Schema.fromJsonString(ProviderStartOptions)),
  runtimeMode: AutomationDefinition.fields.runtimeMode,
  interactionMode: AutomationDefinition.fields.interactionMode,
  worktreeMode: AutomationDefinition.fields.worktreeMode,
  mode: AutomationDefinition.fields.mode,
  targetThreadId: AutomationDefinition.fields.targetThreadId,
  proposalState: AutomationDefinition.fields.proposalState,
  notificationPolicy: AutomationDefinition.fields.notificationPolicy,
  heartbeatCooldownSeconds: AutomationDefinition.fields.heartbeatCooldownSeconds,
  maxIterations: AutomationDefinition.fields.maxIterations,
  stopOnError: Schema.Number,
  stopAfterConsecutiveFailures: AutomationDefinition.fields.stopAfterConsecutiveFailures,
  consecutiveFailureCount: AutomationDefinition.fields.consecutiveFailureCount,
  disabledReason: AutomationDefinition.fields.disabledReason,
  disabledAt: AutomationDefinition.fields.disabledAt,
  completionPolicy: Schema.fromJsonString(AutomationCompletionPolicy),
  completionPolicyVersion: AutomationDefinition.fields.completionPolicyVersion,
  completionPolicyUpdatedAt: AutomationDefinition.fields.completionPolicyUpdatedAt,
  minimumIntervalSeconds: AutomationDefinition.fields.minimumIntervalSeconds,
  maxRuntimeSeconds: AutomationDefinition.fields.maxRuntimeSeconds,
  retryPolicy: Schema.fromJsonString(AutomationDefinition.fields.retryPolicy),
  misfirePolicy: AutomationDefinition.fields.misfirePolicy,
  acknowledgedRisks: Schema.fromJsonString(AutomationDefinition.fields.acknowledgedRisks),
  iterationCount: AutomationDefinition.fields.iterationCount,
  createdAt: AutomationDefinition.fields.createdAt,
  updatedAt: AutomationDefinition.fields.updatedAt,
  archivedAt: AutomationDefinition.fields.archivedAt,
});
type AutomationDefinitionDbRow = typeof AutomationDefinitionDbRow.Type;

const SaveAutomationDefinitionDbRow = Schema.Struct({
  definition: AutomationDefinitionDbRow,
  expectedUpdatedAt: Schema.String,
});

const AutomationRunDbRow = Schema.Struct({
  id: AutomationRun.fields.id,
  automationId: AutomationRun.fields.automationId,
  projectId: AutomationRun.fields.projectId,
  threadId: AutomationRun.fields.threadId,
  turnId: Schema.NullOr(TurnId),
  triggerType: Schema.Literals(["manual", "scheduled"]),
  status: AutomationRun.fields.status,
  scheduledFor: AutomationRun.fields.scheduledFor,
  deferredUntil: AutomationRun.fields.deferredUntil,
  claimedBy: AutomationRun.fields.claimedBy,
  claimedAt: AutomationRun.fields.claimedAt,
  leaseExpiresAt: AutomationRun.fields.leaseExpiresAt,
  startedAt: AutomationRun.fields.startedAt,
  finishedAt: AutomationRun.fields.finishedAt,
  threadCreateCommandId: AutomationRun.fields.threadCreateCommandId,
  turnStartCommandId: AutomationRun.fields.turnStartCommandId,
  messageId: AutomationRun.fields.messageId,
  error: AutomationRun.fields.error,
  result: Schema.NullOr(Schema.fromJsonString(AutomationRun.fields.result)),
  permissionSnapshot: Schema.fromJsonString(AutomationPermissionSnapshot),
  createdAt: AutomationRun.fields.createdAt,
  updatedAt: AutomationRun.fields.updatedAt,
});
type AutomationRunDbRow = typeof AutomationRunDbRow.Type;

const AutomationMemoryDbRow = AutomationMemory;

function withResultDefaults(run: AutomationRun): NonNullable<AutomationRun["result"]> {
  return (
    run.result ?? {
      outcome: "unknown",
      summary: null,
      unread: true,
      archivedAt: null,
    }
  );
}

const decodeDefinition = Schema.decodeUnknownEffect(AutomationDefinition);
const decodeRun = Schema.decodeUnknownEffect(AutomationRun);

/** Upper bound on how many run rows the list query returns to a client snapshot. */
const MAX_RUN_LIST_ROWS = 500;

class AutomationRunClaimRejected extends Error {}

const ClaimAutomationIterationInput = Schema.Struct({
  id: AutomationDefinition.fields.id,
  now: Schema.String,
  expectedDefinitionUpdatedAt: Schema.NullOr(Schema.String),
  consumeIteration: Schema.Number,
});

function toDefinition(row: AutomationDefinitionDbRow) {
  return decodeDefinition({
    ...row,
    enabled: row.enabled === 1,
    providerOptions: row.providerOptions ?? undefined,
  }).pipe(Effect.mapError(toPersistenceDecodeError("AutomationRepository.definitionRowToDomain")));
}

function toRun(row: AutomationRunDbRow) {
  return decodeRun({
    ...row,
    trigger: { type: row.triggerType },
    turnId: row.turnId,
  }).pipe(Effect.mapError(toPersistenceDecodeError("AutomationRepository.runRowToDomain")));
}

const makeAutomationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertDefinition = SqlSchema.void({
    Request: AutomationDefinitionDbRow,
    execute: (definition) =>
      sql`
        INSERT INTO automation_definitions (
          automation_id,
          project_id,
          source_thread_id,
          name,
          prompt,
          schedule_json,
          enabled,
          next_run_at,
          model_selection_json,
          provider_options_json,
          runtime_mode,
          interaction_mode,
          worktree_mode,
          mode,
          target_thread_id,
          proposal_state,
          notification_policy,
          heartbeat_cooldown_seconds,
          max_iterations,
          stop_on_error,
          stop_after_consecutive_failures,
          consecutive_failure_count,
          disabled_reason,
          disabled_at,
          completion_policy_json,
          completion_policy_version,
          completion_policy_updated_at,
          minimum_interval_seconds,
          max_runtime_seconds,
          retry_policy_json,
          misfire_policy,
          acknowledged_risks_json,
          iteration_count,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (
          ${definition.id},
          ${definition.projectId},
          ${definition.sourceThreadId},
          ${definition.name},
          ${definition.prompt},
          ${definition.schedule},
          ${definition.enabled},
          ${definition.nextRunAt},
          ${definition.modelSelection},
          ${definition.providerOptions},
          ${definition.runtimeMode},
          ${definition.interactionMode},
          ${definition.worktreeMode},
          ${definition.mode},
          ${definition.targetThreadId},
          ${definition.proposalState ?? null},
          ${definition.notificationPolicy === "all" ? null : definition.notificationPolicy},
          ${definition.heartbeatCooldownSeconds ?? 60},
          ${definition.maxIterations},
          ${definition.stopOnError},
          ${definition.stopAfterConsecutiveFailures},
          ${definition.consecutiveFailureCount},
          ${definition.disabledReason},
          ${definition.disabledAt},
          ${definition.completionPolicy},
          ${definition.completionPolicyVersion},
          ${definition.completionPolicyUpdatedAt},
          ${definition.minimumIntervalSeconds},
          ${definition.maxRuntimeSeconds},
          ${definition.retryPolicy},
          ${definition.misfirePolicy},
          ${definition.acknowledgedRisks},
          ${definition.iterationCount},
          ${definition.createdAt},
          ${definition.updatedAt},
          ${definition.archivedAt}
        )
      `,
  });

  const getDefinitionRow = SqlSchema.findOneOption({
    Request: GetAutomationDefinitionInput,
    Result: AutomationDefinitionDbRow,
    execute: ({ id }) =>
      sql`
        SELECT
          automation_id AS "id",
          project_id AS "projectId",
          source_thread_id AS "sourceThreadId",
          name,
          prompt,
          schedule_json AS "schedule",
          enabled,
          next_run_at AS "nextRunAt",
          model_selection_json AS "modelSelection",
          provider_options_json AS "providerOptions",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          worktree_mode AS "worktreeMode",
          mode,
          target_thread_id AS "targetThreadId",
          proposal_state AS "proposalState",
          COALESCE(notification_policy, 'all') AS "notificationPolicy",
          COALESCE(heartbeat_cooldown_seconds, 60) AS "heartbeatCooldownSeconds",
          max_iterations AS "maxIterations",
          stop_on_error AS "stopOnError",
          stop_after_consecutive_failures AS "stopAfterConsecutiveFailures",
          consecutive_failure_count AS "consecutiveFailureCount",
          disabled_reason AS "disabledReason",
          disabled_at AS "disabledAt",
          completion_policy_json AS "completionPolicy",
          completion_policy_version AS "completionPolicyVersion",
          COALESCE(
            completion_policy_updated_at,
            updated_at,
            created_at,
            '1970-01-01T00:00:00.000Z'
          ) AS "completionPolicyUpdatedAt",
          minimum_interval_seconds AS "minimumIntervalSeconds",
          max_runtime_seconds AS "maxRuntimeSeconds",
          retry_policy_json AS "retryPolicy",
          misfire_policy AS "misfirePolicy",
          acknowledged_risks_json AS "acknowledgedRisks",
          iteration_count AS "iterationCount",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM automation_definitions
        WHERE automation_id = ${id}
      `,
  });

  const updateDefinitionRow = SqlSchema.findOneOption({
    Request: SaveAutomationDefinitionDbRow,
    Result: Schema.Struct({ id: AutomationDefinition.fields.id }),
    execute: ({ definition, expectedUpdatedAt }) =>
      sql`
        UPDATE automation_definitions
        SET project_id = ${definition.projectId},
            source_thread_id = ${definition.sourceThreadId},
            name = ${definition.name},
            prompt = ${definition.prompt},
            schedule_json = ${definition.schedule},
            enabled = ${definition.enabled},
            next_run_at = ${definition.nextRunAt},
            model_selection_json = ${definition.modelSelection},
            provider_options_json = ${definition.providerOptions},
            runtime_mode = ${definition.runtimeMode},
            interaction_mode = ${definition.interactionMode},
            worktree_mode = ${definition.worktreeMode},
            mode = ${definition.mode},
            target_thread_id = ${definition.targetThreadId},
            proposal_state = ${definition.proposalState ?? null},
            notification_policy = ${
              definition.notificationPolicy === "all" ? null : definition.notificationPolicy
            },
            heartbeat_cooldown_seconds = ${definition.heartbeatCooldownSeconds ?? 60},
            max_iterations = ${definition.maxIterations},
            stop_on_error = ${definition.stopOnError},
            stop_after_consecutive_failures = ${definition.stopAfterConsecutiveFailures},
            consecutive_failure_count = ${definition.consecutiveFailureCount},
            disabled_reason = ${definition.disabledReason},
            disabled_at = ${definition.disabledAt},
            completion_policy_json = ${definition.completionPolicy},
            completion_policy_version = ${definition.completionPolicyVersion},
            completion_policy_updated_at = ${definition.completionPolicyUpdatedAt},
            minimum_interval_seconds = ${definition.minimumIntervalSeconds},
            max_runtime_seconds = ${definition.maxRuntimeSeconds},
            retry_policy_json = ${definition.retryPolicy},
            misfire_policy = ${definition.misfirePolicy},
            acknowledged_risks_json = ${definition.acknowledgedRisks},
            iteration_count = ${definition.iterationCount},
            updated_at = ${definition.updatedAt},
            archived_at = ${definition.archivedAt}
        WHERE automation_id = ${definition.id}
          AND updated_at = ${expectedUpdatedAt}
        RETURNING automation_id AS "id"
      `,
  });

  const resolvePendingProposalRow = SqlSchema.findOneOption({
    Request: ResolvePendingAutomationProposalInput,
    Result: Schema.Struct({ id: AutomationDefinition.fields.id }),
    execute: ({ id, resolution, nextRunAt, updatedAt, archivedAt }) =>
      sql`
        UPDATE automation_definitions
        SET enabled = ${resolution === "accepted" ? 1 : 0},
            next_run_at = ${nextRunAt},
            proposal_state = ${resolution},
            updated_at = ${updatedAt},
            archived_at = ${archivedAt}
        WHERE automation_id = ${id}
          AND proposal_state = 'pending'
        RETURNING automation_id AS "id"
      `,
  });

  const listDefinitionRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.optional(ProjectId),
      includeArchived: Schema.Boolean,
    }),
    Result: AutomationDefinitionDbRow,
    execute: ({ projectId, includeArchived }) =>
      sql`
        SELECT
          automation_id AS "id",
          project_id AS "projectId",
          source_thread_id AS "sourceThreadId",
          name,
          prompt,
          schedule_json AS "schedule",
          enabled,
          next_run_at AS "nextRunAt",
          model_selection_json AS "modelSelection",
          provider_options_json AS "providerOptions",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          worktree_mode AS "worktreeMode",
          mode,
          target_thread_id AS "targetThreadId",
          proposal_state AS "proposalState",
          COALESCE(notification_policy, 'all') AS "notificationPolicy",
          COALESCE(heartbeat_cooldown_seconds, 60) AS "heartbeatCooldownSeconds",
          max_iterations AS "maxIterations",
          stop_on_error AS "stopOnError",
          stop_after_consecutive_failures AS "stopAfterConsecutiveFailures",
          consecutive_failure_count AS "consecutiveFailureCount",
          disabled_reason AS "disabledReason",
          disabled_at AS "disabledAt",
          completion_policy_json AS "completionPolicy",
          completion_policy_version AS "completionPolicyVersion",
          COALESCE(
            completion_policy_updated_at,
            updated_at,
            created_at,
            '1970-01-01T00:00:00.000Z'
          ) AS "completionPolicyUpdatedAt",
          minimum_interval_seconds AS "minimumIntervalSeconds",
          max_runtime_seconds AS "maxRuntimeSeconds",
          retry_policy_json AS "retryPolicy",
          misfire_policy AS "misfirePolicy",
          acknowledged_risks_json AS "acknowledgedRisks",
          iteration_count AS "iterationCount",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM automation_definitions
        WHERE (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null})
          AND (${includeArchived ? 1 : 0} = 1 OR archived_at IS NULL)
        ORDER BY updated_at DESC, automation_id ASC
      `,
  });

  const listDueDefinitionRows = SqlSchema.findAll({
    Request: ListDueAutomationDefinitionsInput,
    Result: AutomationDefinitionDbRow,
    execute: ({ now, limit }) =>
      sql`
        SELECT
          definitions.automation_id AS "id",
          definitions.project_id AS "projectId",
          definitions.source_thread_id AS "sourceThreadId",
          definitions.name,
          definitions.prompt,
          definitions.schedule_json AS "schedule",
          definitions.enabled,
          definitions.next_run_at AS "nextRunAt",
          definitions.model_selection_json AS "modelSelection",
          definitions.provider_options_json AS "providerOptions",
          definitions.runtime_mode AS "runtimeMode",
          definitions.interaction_mode AS "interactionMode",
          definitions.worktree_mode AS "worktreeMode",
          definitions.mode,
          definitions.target_thread_id AS "targetThreadId",
          definitions.proposal_state AS "proposalState",
          COALESCE(definitions.notification_policy, 'all') AS "notificationPolicy",
          COALESCE(definitions.heartbeat_cooldown_seconds, 60) AS "heartbeatCooldownSeconds",
          definitions.max_iterations AS "maxIterations",
          definitions.stop_on_error AS "stopOnError",
          definitions.stop_after_consecutive_failures AS "stopAfterConsecutiveFailures",
          definitions.consecutive_failure_count AS "consecutiveFailureCount",
          definitions.disabled_reason AS "disabledReason",
          definitions.disabled_at AS "disabledAt",
          definitions.completion_policy_json AS "completionPolicy",
          definitions.completion_policy_version AS "completionPolicyVersion",
          COALESCE(
            definitions.completion_policy_updated_at,
            definitions.updated_at,
            definitions.created_at,
            '1970-01-01T00:00:00.000Z'
          ) AS "completionPolicyUpdatedAt",
          definitions.minimum_interval_seconds AS "minimumIntervalSeconds",
          definitions.max_runtime_seconds AS "maxRuntimeSeconds",
          definitions.retry_policy_json AS "retryPolicy",
          definitions.misfire_policy AS "misfirePolicy",
          definitions.acknowledged_risks_json AS "acknowledgedRisks",
          definitions.iteration_count AS "iterationCount",
          definitions.created_at AS "createdAt",
          definitions.updated_at AS "updatedAt",
          definitions.archived_at AS "archivedAt"
        FROM automation_definitions definitions
        WHERE definitions.enabled = 1
          AND definitions.archived_at IS NULL
          AND definitions.proposal_state IS NOT 'pending'
          AND definitions.next_run_at IS NOT NULL
          AND definitions.next_run_at <= ${now}
          AND NOT (
            definitions.mode = 'heartbeat'
            AND EXISTS (
              SELECT 1
              FROM automation_runs deferred_runs
              WHERE deferred_runs.automation_id = definitions.automation_id
                AND deferred_runs.status = 'pending'
                AND deferred_runs.deferred_until IS NOT NULL
            )
          )
        ORDER BY definitions.next_run_at ASC, definitions.automation_id ASC
        LIMIT ${limit}
      `,
  });

  const setDefinitionNextRunAtRow = SqlSchema.void({
    Request: SetAutomationDefinitionNextRunAtInput,
    execute: ({ id, nextRunAt, updatedAt }) =>
      sql`
        UPDATE automation_definitions
        SET next_run_at = ${nextRunAt},
            updated_at = ${updatedAt}
        WHERE automation_id = ${id}
      `,
  });

  const attachDefinitionThreadRow = SqlSchema.findAll({
    Request: AttachAutomationDefinitionThreadInput,
    Result: Schema.Struct({ id: AutomationDefinition.fields.id }),
    execute: ({ id, threadId, updatedAt }) =>
      sql`
        UPDATE automation_definitions
        SET target_thread_id = ${threadId},
            updated_at = ${updatedAt}
        WHERE automation_id = ${id}
          AND target_thread_id IS NULL
        RETURNING automation_id AS "id"
      `,
  });

  const archiveDefinitionRow = SqlSchema.void({
    Request: ArchiveAutomationDefinitionInput,
    execute: ({ id, archivedAt }) =>
      sql`
        UPDATE automation_definitions
        SET archived_at = ${archivedAt}, updated_at = ${archivedAt}, enabled = 0
        WHERE automation_id = ${id}
      `,
  });

  const insertRun = SqlSchema.void({
    Request: AutomationRunDbRow,
    execute: (run) =>
      sql`
        INSERT OR IGNORE INTO automation_runs (
          run_id,
          automation_id,
          project_id,
          thread_id,
          turn_id,
          trigger_type,
          status,
          scheduled_for,
          deferred_until,
          claimed_by,
          claimed_at,
          lease_expires_at,
          started_at,
          finished_at,
          thread_create_command_id,
          turn_start_command_id,
          message_id,
          error,
          result_json,
          permission_snapshot_json,
          created_at,
          updated_at
        )
        SELECT
          ${run.id},
          ${run.automationId},
          ${run.projectId},
          ${run.threadId},
          ${run.turnId},
          ${run.triggerType},
          ${run.status},
          ${run.scheduledFor},
          ${run.deferredUntil ?? null},
          ${run.claimedBy},
          ${run.claimedAt},
          ${run.leaseExpiresAt},
          ${run.startedAt},
          ${run.finishedAt},
          ${run.threadCreateCommandId},
          ${run.turnStartCommandId},
          ${run.messageId},
          ${run.error},
          ${run.result},
          ${run.permissionSnapshot},
          ${run.createdAt},
          ${run.updatedAt}
        WHERE ${run.threadId} IS NULL
           OR NOT EXISTS (
             SELECT 1
             FROM automation_runs
             WHERE thread_id = ${run.threadId}
               AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
           )
      `,
  });

  const getRunRowById = SqlSchema.findOneOption({
    Request: GetAutomationRunInput,
    Result: AutomationRunDbRow,
    execute: ({ id }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          deferred_until AS "deferredUntil",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE run_id = ${id}
      `,
  });

  const getDeferredRunRowByDefinition = SqlSchema.findOneOption({
    Request: GetDeferredAutomationRunInput,
    Result: AutomationRunDbRow,
    execute: ({ automationId }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          deferred_until AS "deferredUntil",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE automation_id = ${automationId}
          AND status = 'pending'
          AND deferred_until IS NOT NULL
        ORDER BY created_at ASC, run_id ASC
        LIMIT 1
      `,
  });

  const getLatestFinishedRunRowByDefinition = SqlSchema.findOneOption({
    Request: GetLatestFinishedAutomationRunInput,
    Result: AutomationRunDbRow,
    execute: ({ automationId }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          deferred_until AS "deferredUntil",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE automation_id = ${automationId}
          AND finished_at IS NOT NULL
        ORDER BY finished_at DESC, run_id DESC
        LIMIT 1
      `,
  });

  const listDueDeferredRunRows = SqlSchema.findAll({
    Request: ListDueDeferredAutomationRunsInput,
    Result: AutomationRunDbRow,
    execute: ({ now, limit }) =>
      sql`
        SELECT
          runs.run_id AS "id",
          runs.automation_id AS "automationId",
          runs.project_id AS "projectId",
          runs.thread_id AS "threadId",
          runs.turn_id AS "turnId",
          runs.trigger_type AS "triggerType",
          runs.status,
          runs.scheduled_for AS "scheduledFor",
          runs.deferred_until AS "deferredUntil",
          runs.claimed_by AS "claimedBy",
          runs.claimed_at AS "claimedAt",
          runs.lease_expires_at AS "leaseExpiresAt",
          runs.started_at AS "startedAt",
          runs.finished_at AS "finishedAt",
          runs.thread_create_command_id AS "threadCreateCommandId",
          runs.turn_start_command_id AS "turnStartCommandId",
          runs.message_id AS "messageId",
          runs.error,
          runs.result_json AS "result",
          runs.permission_snapshot_json AS "permissionSnapshot",
          runs.created_at AS "createdAt",
          runs.updated_at AS "updatedAt"
        FROM automation_runs runs
        INNER JOIN automation_definitions definitions
          ON definitions.automation_id = runs.automation_id
        WHERE runs.status = 'pending'
          AND runs.deferred_until IS NOT NULL
          AND runs.deferred_until <= ${now}
          AND definitions.enabled = 1
          AND definitions.archived_at IS NULL
        ORDER BY runs.deferred_until ASC, runs.created_at ASC, runs.run_id ASC
        LIMIT ${limit}
      `,
  });

  const listRunRowsForDefinition = SqlSchema.findAll({
    Request: ListAutomationRunsForDefinitionInput,
    Result: AutomationRunDbRow,
    execute: ({ automationId, limit }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          deferred_until AS "deferredUntil",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE automation_id = ${automationId}
        ORDER BY scheduled_for DESC, run_id DESC
        LIMIT ${limit}
      `,
  });

  const getRunRowByOccurrence = SqlSchema.findOneOption({
    Request: Schema.Struct({
      automationId: AutomationRun.fields.automationId,
      scheduledFor: AutomationRun.fields.scheduledFor,
    }),
    Result: AutomationRunDbRow,
    execute: ({ automationId, scheduledFor }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          deferred_until AS "deferredUntil",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE automation_id = ${automationId}
          AND scheduled_for = ${scheduledFor}
          AND trigger_type = 'scheduled'
      `,
  });

  const listRunRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.optional(ProjectId),
      includeArchived: Schema.Boolean,
    }),
    Result: AutomationRunDbRow,
    execute: ({ projectId, includeArchived }) =>
      sql`
        SELECT
          runs.run_id AS "id",
          runs.automation_id AS "automationId",
          runs.project_id AS "projectId",
          runs.thread_id AS "threadId",
          runs.turn_id AS "turnId",
          runs.trigger_type AS "triggerType",
          runs.status,
          runs.scheduled_for AS "scheduledFor",
          runs.deferred_until AS "deferredUntil",
          runs.claimed_by AS "claimedBy",
          runs.claimed_at AS "claimedAt",
          runs.lease_expires_at AS "leaseExpiresAt",
          runs.started_at AS "startedAt",
          runs.finished_at AS "finishedAt",
          runs.thread_create_command_id AS "threadCreateCommandId",
          runs.turn_start_command_id AS "turnStartCommandId",
          runs.message_id AS "messageId",
          runs.error,
          runs.result_json AS "result",
          runs.permission_snapshot_json AS "permissionSnapshot",
          runs.created_at AS "createdAt",
          runs.updated_at AS "updatedAt"
        FROM automation_runs runs
        INNER JOIN automation_definitions definitions
          ON definitions.automation_id = runs.automation_id
        WHERE (${projectId ?? null} IS NULL OR runs.project_id = ${projectId ?? null})
          AND (${includeArchived ? 1 : 0} = 1 OR definitions.archived_at IS NULL)
        ORDER BY runs.scheduled_for DESC, runs.run_id DESC
        LIMIT ${MAX_RUN_LIST_ROWS}
      `,
  });

  const getMemoryRow = SqlSchema.findOneOption({
    Request: GetAutomationMemoryInput,
    Result: AutomationMemoryDbRow,
    execute: ({ automationId }) =>
      sql`
        SELECT
          automation_id AS "automationId",
          content,
          updated_at AS "updatedAt"
        FROM automation_memory
        WHERE automation_id = ${automationId}
      `,
  });

  const upsertMemoryRow = SqlSchema.void({
    Request: UpsertAutomationMemoryInput,
    execute: ({ automationId, content, updatedAt }) =>
      sql`
        INSERT INTO automation_memory (automation_id, content, updated_at)
        VALUES (${automationId}, ${content}, ${updatedAt})
        ON CONFLICT (automation_id)
        DO UPDATE SET
          content = excluded.content,
          updated_at = excluded.updated_at
      `,
  });

  const getAutomationSettingRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ key: Schema.String }),
    Result: Schema.Struct({ value: Schema.String }),
    execute: ({ key }) =>
      sql`
        SELECT setting_value AS "value"
        FROM automation_settings
        WHERE setting_key = ${key}
      `,
  });

  const insertAutomationSettingRow = SqlSchema.void({
    Request: Schema.Struct({
      key: Schema.String,
      value: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: ({ key, value, updatedAt }) =>
      sql`
        INSERT OR IGNORE INTO automation_settings (setting_key, setting_value, updated_at)
        VALUES (${key}, ${value}, ${updatedAt})
      `,
  });

  const cancelRunRow = SqlSchema.void({
    Request: Schema.Struct({
      id: GetAutomationRunInput.fields.id,
      now: Schema.String,
    }),
    execute: ({ id, now }) =>
      sql`
        UPDATE automation_runs
        SET status = 'cancelled',
            finished_at = ${now},
            updated_at = ${now},
            deferred_until = NULL,
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
      `,
  });

  const markRunStartedRow = SqlSchema.void({
    Request: MarkAutomationRunStartedInput,
    execute: ({ id, threadId, messageId, threadCreateCommandId, turnStartCommandId, startedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'running',
            thread_id = ${threadId},
            message_id = ${messageId},
            thread_create_command_id = ${threadCreateCommandId},
            turn_start_command_id = ${turnStartCommandId},
            deferred_until = NULL,
            started_at = ${startedAt},
            updated_at = ${startedAt}
        WHERE run_id = ${id}
          AND status IN ('pending', 'claimed', 'waiting-for-approval')
      `,
  });

  const reserveDeferredRunRow = SqlSchema.findAll({
    Request: ReserveDeferredAutomationRunInput,
    Result: Schema.Struct({ id: AutomationRun.fields.id }),
    execute: ({ id, threadId, reservedAt }) =>
      sql`
        UPDATE automation_runs
        SET thread_id = ${threadId},
            deferred_until = NULL,
            updated_at = ${reservedAt}
        WHERE run_id = ${id}
          AND status = 'pending'
          AND deferred_until IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM automation_definitions definitions
            WHERE definitions.automation_id = automation_runs.automation_id
              AND definitions.enabled = 1
              AND definitions.archived_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM automation_runs active_runs
            WHERE active_runs.thread_id = ${threadId}
              AND active_runs.run_id <> ${id}
              AND active_runs.status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
          )
        RETURNING run_id AS "id"
      `,
  });

  const markRunFailedRow = SqlSchema.findAll({
    Request: MarkAutomationRunFailedInput,
    Result: Schema.Struct({ id: AutomationRun.fields.id }),
    execute: ({ id, error, finishedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'failed',
            error = ${error},
            finished_at = ${finishedAt},
            updated_at = ${finishedAt},
            deferred_until = NULL,
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
        RETURNING run_id AS "id"
      `,
  });

  const markRunSkippedRow = SqlSchema.void({
    Request: MarkAutomationRunSkippedInput,
    execute: ({ id, reason, finishedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'skipped',
            error = ${reason},
            finished_at = ${finishedAt},
            updated_at = ${finishedAt},
            deferred_until = NULL,
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status IN ('pending', 'claimed')
      `,
  });

  const markRunSucceededRow = SqlSchema.findAll({
    Request: MarkAutomationRunSucceededInput,
    Result: Schema.Struct({ id: AutomationRun.fields.id }),
    execute: ({ id, turnId, result, finishedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'succeeded',
            turn_id = COALESCE(${turnId}, turn_id),
            result_json = ${result === null ? null : JSON.stringify(result)},
            finished_at = ${finishedAt},
            updated_at = ${finishedAt},
            deferred_until = NULL,
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
        RETURNING run_id AS "id"
      `,
  });

  const markRunResultRow = SqlSchema.void({
    Request: MarkAutomationRunResultInput,
    execute: ({ id, result, updatedAt }) =>
      sql`
        UPDATE automation_runs
        SET result_json = ${result === null ? null : JSON.stringify(result)},
            updated_at = ${updatedAt}
        WHERE run_id = ${id}
      `,
  });

  // Writes a new result but carries the triage fields (archivedAt/unread) over from the
  // existing row atomically, so a background update can never clobber a concurrent user
  // archive/mark-read landing between the run reload and this write.
  // unread is round-tripped through json() so it stays a JSON boolean rather than the
  // 0/1 that json_extract yields.
  const markRunResultPreservingTriageRow = SqlSchema.void({
    Request: MarkAutomationRunResultInput,
    execute: ({ id, result, updatedAt }) =>
      result === null
        ? sql`
            UPDATE automation_runs
            SET result_json = NULL, updated_at = ${updatedAt}
            WHERE run_id = ${id}
          `
        : sql`
            UPDATE automation_runs
            SET result_json = CASE
                  WHEN result_json IS NULL THEN ${JSON.stringify(result)}
                  ELSE json_set(
                    json_set(
                      ${JSON.stringify(result)},
                      '$.archivedAt',
                      json_extract(result_json, '$.archivedAt')
                    ),
                    '$.unread',
                    json(
                      CASE
                        -- Existing row has no boolean unread (legacy/null): fall back to the
                        -- incoming result's value rather than implicitly defaulting to unread.
                        WHEN json_extract(result_json, '$.unread') IS NULL THEN
                          CASE WHEN json_extract(${JSON.stringify(result)}, '$.unread') = 0
                            THEN 'false' ELSE 'true' END
                        WHEN json_extract(result_json, '$.unread') = 0 THEN 'false'
                        ELSE 'true'
                      END
                    )
                  )
                END,
                updated_at = ${updatedAt}
            WHERE run_id = ${id}
          `,
  });

  const markRunInterruptedRow = SqlSchema.void({
    Request: MarkAutomationRunInterruptedInput,
    execute: ({ id, turnId, finishedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'interrupted',
            turn_id = COALESCE(${turnId}, turn_id),
            finished_at = ${finishedAt},
            updated_at = ${finishedAt},
            deferred_until = NULL,
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
      `,
  });

  const markRunWaitingForApprovalRow = SqlSchema.void({
    Request: MarkAutomationRunWaitingForApprovalInput,
    execute: ({ id, turnId, updatedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'waiting-for-approval',
            turn_id = COALESCE(${turnId}, turn_id),
            updated_at = ${updatedAt}
        WHERE run_id = ${id}
          AND status IN ('pending', 'claimed', 'running')
      `,
  });

  const setRunDeferredRow = SqlSchema.void({
    Request: SetAutomationRunDeferredInput,
    execute: ({ id, deferredUntil, updatedAt }) =>
      sql`
        UPDATE automation_runs
        SET deferred_until = ${deferredUntil},
            updated_at = ${updatedAt}
        WHERE run_id = ${id}
          AND status = 'pending'
      `,
  });

  const getRunRowByThread = SqlSchema.findOneOption({
    Request: GetAutomationRunByThreadInput,
    Result: AutomationRunDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          deferred_until AS "deferredUntil",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE thread_id = ${threadId}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
        ORDER BY created_at DESC, run_id DESC
        LIMIT 1
      `,
  });

  const listRecoverableRunRows = SqlSchema.findAll({
    Request: ListRecoverableAutomationRunsInput,
    Result: AutomationRunDbRow,
    execute: ({ limit, afterCreatedAt, afterRunId }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          deferred_until AS "deferredUntil",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
          AND NOT (status = 'pending' AND deferred_until IS NOT NULL)
          AND (
            ${afterCreatedAt ?? null} IS NULL
            OR created_at > ${afterCreatedAt ?? null}
            OR (created_at = ${afterCreatedAt ?? null} AND run_id > ${afterRunId ?? ""})
          )
        ORDER BY created_at ASC, run_id ASC
        LIMIT ${limit}
      `,
  });

  const listRunsNeedingCompletionEvaluationRows = SqlSchema.findAll({
    Request: ListAutomationRunsNeedingCompletionEvaluationInput,
    Result: AutomationRunDbRow,
    execute: ({ limit }) =>
      sql`
        SELECT
          runs.run_id AS "id",
          runs.automation_id AS "automationId",
          runs.project_id AS "projectId",
          runs.thread_id AS "threadId",
          runs.turn_id AS "turnId",
          runs.trigger_type AS "triggerType",
          runs.status,
          runs.scheduled_for AS "scheduledFor",
          runs.deferred_until AS "deferredUntil",
          runs.claimed_by AS "claimedBy",
          runs.claimed_at AS "claimedAt",
          runs.lease_expires_at AS "leaseExpiresAt",
          runs.started_at AS "startedAt",
          runs.finished_at AS "finishedAt",
          runs.thread_create_command_id AS "threadCreateCommandId",
          runs.turn_start_command_id AS "turnStartCommandId",
          runs.message_id AS "messageId",
          runs.error,
          runs.result_json AS "result",
          runs.permission_snapshot_json AS "permissionSnapshot",
          runs.created_at AS "createdAt",
          runs.updated_at AS "updatedAt"
        FROM automation_runs runs
        INNER JOIN automation_pending_completion_evaluations pending
          ON pending.run_id = runs.run_id
        ORDER BY pending.finished_at ASC, pending.run_id ASC
        LIMIT ${limit}
      `,
  });

  const countActiveRunsRow = SqlSchema.findAll({
    Request: CountActiveAutomationRunsInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ automationId }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM automation_runs
        WHERE automation_id = ${automationId}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
      `,
  });

  const countActiveRunsByThreadRow = SqlSchema.findAll({
    Request: CountActiveAutomationRunsByThreadInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ threadId }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM automation_runs
        WHERE thread_id = ${threadId}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
      `,
  });

  const countPendingCompletionEvaluationsByThreadRow = SqlSchema.findAll({
    Request: CountPendingCompletionEvaluationsByThreadInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ threadId }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM automation_pending_completion_evaluations pending
        WHERE pending.thread_id = ${threadId}
      `,
  });

  const listActiveRunsForDefinitionRows = SqlSchema.findAll({
    Request: ListActiveAutomationRunsForDefinitionInput,
    Result: AutomationRunDbRow,
    execute: ({ automationId }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          deferred_until AS "deferredUntil",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE automation_id = ${automationId}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
        ORDER BY created_at ASC, run_id ASC
      `,
  });

  const getEarliestNextRunAtRow = SqlSchema.findOneOption({
    Request: GetEarliestAutomationNextRunAtInput,
    Result: Schema.Struct({ nextRunAt: AutomationDefinition.fields.nextRunAt }),
    execute: () =>
      sql`
        SELECT candidates.next_run_at AS "nextRunAt"
        FROM (
          SELECT definitions.next_run_at AS next_run_at
          FROM automation_definitions definitions
          WHERE definitions.enabled = 1
            AND definitions.archived_at IS NULL
            AND definitions.next_run_at IS NOT NULL
            AND NOT (
              definitions.mode = 'heartbeat'
              AND EXISTS (
                SELECT 1
                FROM automation_runs deferred_runs
                WHERE deferred_runs.automation_id = definitions.automation_id
                  AND deferred_runs.status = 'pending'
                  AND deferred_runs.deferred_until IS NOT NULL
              )
            )
          UNION ALL
          SELECT runs.deferred_until AS next_run_at
          FROM automation_runs runs
          INNER JOIN automation_definitions definitions
            ON definitions.automation_id = runs.automation_id
          WHERE runs.status = 'pending'
            AND runs.deferred_until IS NOT NULL
            AND definitions.enabled = 1
            AND definitions.archived_at IS NULL
        ) candidates
        ORDER BY candidates.next_run_at ASC
        LIMIT 1
      `,
  });

  const disableDefinitionRow = SqlSchema.void({
    Request: DisableAutomationDefinitionInput,
    execute: ({ id, now, reason }) =>
      sql`
        UPDATE automation_definitions
        SET enabled = 0,
            next_run_at = NULL,
            disabled_reason = ${reason},
            disabled_at = ${now},
            updated_at = ${now}
        WHERE automation_id = ${id}
      `,
  });

  const disableDefinitionIfUnchangedRow = SqlSchema.findAll({
    Request: DisableAutomationDefinitionIfUnchangedInput,
    Result: Schema.Struct({ id: AutomationDefinition.fields.id }),
    execute: ({ id, expectedUpdatedAt, now, reason }) =>
      sql`
        UPDATE automation_definitions
        SET enabled = 0,
            next_run_at = NULL,
            disabled_reason = ${reason},
            disabled_at = ${now},
            updated_at = ${now}
        WHERE automation_id = ${id}
          AND enabled = 1
          AND archived_at IS NULL
          AND updated_at = ${expectedUpdatedAt}
        RETURNING automation_id AS "id"
      `,
  });

  const recordDefinitionRunFailureRow = SqlSchema.findOneOption({
    Request: RecordAutomationDefinitionRunFailureInput,
    Result: Schema.Struct({
      consecutiveFailureCount: NonNegativeInt,
      autoDisabled: Schema.Number,
    }),
    execute: ({ id, now }) =>
      sql`
        UPDATE automation_definitions
        SET consecutive_failure_count = consecutive_failure_count + 1,
            enabled = CASE
              WHEN stop_after_consecutive_failures IS NOT NULL
                AND consecutive_failure_count + 1 >= stop_after_consecutive_failures
              THEN 0
              ELSE enabled
            END,
            next_run_at = CASE
              WHEN stop_after_consecutive_failures IS NOT NULL
                AND consecutive_failure_count + 1 >= stop_after_consecutive_failures
              THEN NULL
              ELSE next_run_at
            END,
            disabled_reason = CASE
              WHEN stop_after_consecutive_failures IS NOT NULL
                AND consecutive_failure_count + 1 >= stop_after_consecutive_failures
              THEN 'failures'
              ELSE disabled_reason
            END,
            disabled_at = CASE
              WHEN stop_after_consecutive_failures IS NOT NULL
                AND consecutive_failure_count + 1 >= stop_after_consecutive_failures
              THEN ${now}
              ELSE disabled_at
            END,
            updated_at = ${now}
        WHERE automation_id = ${id}
          AND enabled = 1
          AND archived_at IS NULL
        RETURNING
          consecutive_failure_count AS "consecutiveFailureCount",
          CASE WHEN enabled = 0 THEN 1 ELSE 0 END AS "autoDisabled"
      `,
  });

  const resetDefinitionFailureCountRow = SqlSchema.findAll({
    Request: ResetAutomationDefinitionFailureCountInput,
    Result: Schema.Struct({ id: AutomationDefinition.fields.id }),
    execute: ({ id, now }) =>
      sql`
        UPDATE automation_definitions
        SET consecutive_failure_count = 0,
            updated_at = ${now}
        WHERE automation_id = ${id}
          AND enabled = 1
          AND archived_at IS NULL
          AND consecutive_failure_count <> 0
        RETURNING automation_id AS "id"
      `,
  });

  const incrementIterationRow = SqlSchema.void({
    Request: IncrementAutomationIterationInput,
    execute: ({ id, now }) =>
      sql`
        UPDATE automation_definitions
        SET iteration_count = iteration_count + 1, updated_at = ${now}
        WHERE automation_id = ${id}
      `,
  });

  const incrementIterationIfRunnableRow = SqlSchema.findAll({
    Request: ClaimAutomationIterationInput,
    Result: Schema.Struct({ id: AutomationDefinition.fields.id }),
    execute: ({ id, now, expectedDefinitionUpdatedAt, consumeIteration }) =>
      sql`
        UPDATE automation_definitions
        SET iteration_count = iteration_count + CASE WHEN ${consumeIteration} = 1 THEN 1 ELSE 0 END,
            updated_at = ${now}
        WHERE automation_id = ${id}
          AND archived_at IS NULL
          AND (max_iterations IS NULL OR iteration_count < max_iterations)
          AND (
            ${expectedDefinitionUpdatedAt} IS NULL
            OR (enabled = 1 AND updated_at = ${expectedDefinitionUpdatedAt})
          )
        RETURNING automation_id AS "id"
      `,
  });

  const restartDefinitionLoopRow = SqlSchema.void({
    Request: RestartAutomationDefinitionLoopInput,
    execute: ({ id, enabled, nextRunAt, updatedAt }) => {
      const enabledValue = enabled ? 1 : 0;
      return sql`
        UPDATE automation_definitions
        SET enabled = ${enabledValue},
            iteration_count = 0,
            consecutive_failure_count = CASE
              WHEN ${enabledValue} = 1 THEN 0
              ELSE consecutive_failure_count
            END,
            disabled_reason = CASE
              WHEN ${enabledValue} = 1 THEN NULL
              ELSE disabled_reason
            END,
            disabled_at = CASE WHEN ${enabledValue} = 1 THEN NULL ELSE disabled_at END,
            next_run_at = ${nextRunAt},
            updated_at = ${updatedAt}
        WHERE automation_id = ${id}
      `;
    },
  });

  const acquireLease = SqlSchema.findAll({
    Request: AcquireAutomationSchedulerLeaseInput,
    Result: Schema.Struct({ changed: Schema.Number }),
    execute: ({ leaseKey, ownerId, now, leaseExpiresAt }) =>
      sql`
        INSERT INTO automation_scheduler_leases (
          lease_key,
          owner_id,
          acquired_at,
          heartbeat_at,
          lease_expires_at
        )
        VALUES (${leaseKey}, ${ownerId}, ${now}, ${now}, ${leaseExpiresAt})
        ON CONFLICT (lease_key)
        DO UPDATE SET
          owner_id = excluded.owner_id,
          acquired_at = excluded.acquired_at,
          heartbeat_at = excluded.heartbeat_at,
          lease_expires_at = excluded.lease_expires_at
        WHERE automation_scheduler_leases.owner_id = ${ownerId}
           OR automation_scheduler_leases.lease_expires_at <= ${now}
        RETURNING changes() AS changed
      `,
  });

  const createDefinition: AutomationRepositoryShape["createDefinition"] = (request) => {
    const { id, input, now } = request;
    const initialNextRunAt = Object.hasOwn(request, "nextRunAt")
      ? (request.nextRunAt ?? null)
      : input.schedule.type === "manual"
        ? null
        : now;
    const mode = input.mode ?? "standalone";
    const completionPolicy = input.completionPolicy ?? { type: "none" as const };
    const definition: AutomationDefinition = {
      id,
      projectId: input.projectId,
      sourceThreadId: input.sourceThreadId ?? null,
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: input.enabled ?? true,
      nextRunAt: initialNextRunAt,
      modelSelection: input.modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      runtimeMode: input.runtimeMode ?? DEFAULT_AUTOMATION_RUNTIME_MODE,
      interactionMode: input.interactionMode ?? "default",
      worktreeMode: input.worktreeMode ?? "auto",
      mode,
      // Only heartbeat takes a caller-supplied thread. A dedicated automation starts
      // without one and claims the thread its first run creates.
      targetThreadId: automationRequiresTargetThread(mode) ? (input.targetThreadId ?? null) : null,
      proposalState: input.proposalState ?? null,
      notificationPolicy: input.notificationPolicy ?? "all",
      heartbeatCooldownSeconds: input.heartbeatCooldownSeconds ?? 60,
      maxIterations: input.maxIterations ?? null,
      stopAfterConsecutiveFailures: resolveAutomationStopPolicy(
        input,
        DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES,
      ),
      consecutiveFailureCount: 0,
      disabledReason: null,
      disabledAt: null,
      completionPolicy,
      completionPolicyVersion: 1,
      completionPolicyUpdatedAt: now,
      minimumIntervalSeconds: input.minimumIntervalSeconds ?? 60,
      maxRuntimeSeconds: input.maxRuntimeSeconds === undefined ? 60 * 60 : input.maxRuntimeSeconds,
      retryPolicy: input.retryPolicy ?? { type: "none" },
      misfirePolicy: input.misfirePolicy ?? "coalesce",
      acknowledgedRisks: input.acknowledgedRisks ?? [],
      iterationCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    return insertDefinition({
      ...definition,
      enabled: definition.enabled ? 1 : 0,
      stopOnError: definition.stopAfterConsecutiveFailures === null ? 0 : 1,
      providerOptions: definition.providerOptions ?? null,
      completionPolicy: definition.completionPolicy ?? { type: "none" },
      completionPolicyVersion: definition.completionPolicyVersion ?? 1,
      completionPolicyUpdatedAt: definition.completionPolicyUpdatedAt ?? definition.createdAt,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.createDefinition:query")),
      Effect.as(definition),
    );
  };

  const saveDefinition: AutomationRepositoryShape["saveDefinition"] = (input) => {
    const { definition, expectedUpdatedAt } = input;
    return updateDefinitionRow({
      definition: {
        ...definition,
        enabled: definition.enabled ? 1 : 0,
        stopOnError: definition.stopAfterConsecutiveFailures === null ? 0 : 1,
        providerOptions: definition.providerOptions ?? null,
        completionPolicy: definition.completionPolicy ?? { type: "none" },
        completionPolicyVersion: definition.completionPolicyVersion ?? 1,
        completionPolicyUpdatedAt: definition.completionPolicyUpdatedAt ?? definition.createdAt,
      },
      expectedUpdatedAt,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.saveDefinition:update")),
      Effect.map(Option.map(() => definition)),
    );
  };

  const resolvePendingProposal: AutomationRepositoryShape["resolvePendingProposal"] = (input) =>
    resolvePendingProposalRow(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(toPersistenceSqlError("AutomationRepository.resolvePendingProposal:update")),
    );

  const getDefinitionById: AutomationRepositoryShape["getDefinitionById"] = (input) =>
    getDefinitionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getDefinitionById:query")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toDefinition(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const listDueDefinitions: AutomationRepositoryShape["listDueDefinitions"] = (input) =>
    listDueDefinitionRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.listDueDefinitions:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toDefinition, { concurrency: "unbounded" })),
    );

  const setDefinitionNextRunAt: AutomationRepositoryShape["setDefinitionNextRunAt"] = (input) =>
    setDefinitionNextRunAtRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.setDefinitionNextRunAt:update")),
    );

  const attachDefinitionThread: AutomationRepositoryShape["attachDefinitionThread"] = (input) =>
    attachDefinitionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.attachDefinitionThread:update")),
      Effect.map((rows) => rows.length > 0),
    );

  const archiveDefinition: AutomationRepositoryShape["archiveDefinition"] = (input) =>
    archiveDefinitionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.archiveDefinition:query")),
    );

  const list: AutomationRepositoryShape["list"] = (input = {}) => {
    const normalized = {
      projectId: input.projectId,
      includeArchived: input.includeArchived ?? false,
    };
    return Effect.all({
      definitions: listDefinitionRows(normalized).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, toDefinition, { concurrency: "unbounded" })),
      ),
      runs: listRunRows(normalized).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
      ),
      memories: Effect.succeed([]),
    }).pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.list:query")));
  };

  const createRun: AutomationRepositoryShape["createRun"] = (input) => {
    const run: AutomationRun = {
      id: input.id,
      automationId: input.automationId,
      projectId: input.projectId,
      threadId: input.threadId,
      trigger: input.trigger,
      status: "pending",
      scheduledFor: input.scheduledFor,
      deferredUntil: input.deferredUntil ?? null,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      threadCreateCommandId: input.threadCreateCommandId ?? null,
      turnStartCommandId: input.turnStartCommandId ?? null,
      messageId: input.messageId ?? null,
      error: null,
      result: null,
      permissionSnapshot: input.permissionSnapshot,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const decodeInserted = (rowOption: Option.Option<AutomationRunDbRow>) =>
      Option.match(rowOption, {
        onNone: () =>
          Effect.fail(
            toPersistenceDecodeCauseError("AutomationRepository.createRun:missingRow")(
              new Error("Automation run was not inserted or found."),
            ),
          ),
        onSome: toRun,
      });
    const decodeInsertedOrActiveThread = (rowOption: Option.Option<AutomationRunDbRow>) =>
      Option.match(rowOption, {
        onSome: toRun,
        onNone: () =>
          input.threadId
            ? getRunRowByThread({ threadId: input.threadId }).pipe(
                Effect.mapError(
                  toPersistenceSqlError("AutomationRepository.createRun:selectActiveThread"),
                ),
                Effect.flatMap(decodeInserted),
              )
            : decodeInserted(rowOption),
      });
    const inserted = insertRun({
      ...run,
      turnId: null,
      triggerType: run.trigger.type,
    }).pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.createRun:insert")));
    // Scheduled runs dedupe on (automationId, scheduledFor) via INSERT OR IGNORE +
    // the partial unique index, so a re-run of the same occurrence returns the existing
    // row. Manual runs are never deduped and are read back by their own run id.
    if (run.trigger.type === "scheduled") {
      return inserted.pipe(
        Effect.flatMap(() =>
          getRunRowByOccurrence({
            automationId: input.automationId,
            scheduledFor: input.scheduledFor,
          }).pipe(
            Effect.mapError(toPersistenceSqlError("AutomationRepository.createRun:select")),
            Effect.flatMap(decodeInsertedOrActiveThread),
          ),
        ),
      );
    }
    return inserted.pipe(
      Effect.flatMap(() =>
        getRunRowById({ id: input.id }).pipe(
          Effect.mapError(toPersistenceSqlError("AutomationRepository.createRun:select")),
          Effect.flatMap(decodeInsertedOrActiveThread),
        ),
      ),
    );
  };

  const createRunAndIncrementDefinition: AutomationRepositoryShape["createRunAndIncrementDefinition"] =
    (input, scheduleAdvance) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const run = yield* createRun(input);
            const inserted = run.id === input.id;
            if (inserted || scheduleAdvance !== undefined) {
              const updated = yield* incrementIterationIfRunnableRow({
                id: input.automationId,
                now: input.now,
                expectedDefinitionUpdatedAt: scheduleAdvance?.expectedDefinitionUpdatedAt ?? null,
                consumeIteration: inserted && scheduleAdvance?.consumeIteration !== false ? 1 : 0,
              });
              if (updated.length === 0) {
                return yield* Effect.fail(new AutomationRunClaimRejected());
              }
            }
            if (scheduleAdvance) {
              yield* scheduleAdvance.disable
                ? disableDefinitionRow({
                    id: input.automationId,
                    now: input.now,
                    reason: "schedule",
                  })
                : setDefinitionNextRunAtRow({
                    id: input.automationId,
                    nextRunAt: scheduleAdvance.nextRunAt,
                    updatedAt: input.now,
                  });
            }
            return inserted ? Option.some(run) : Option.none<AutomationRun>();
          }),
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof AutomationRunClaimRejected
              ? Effect.succeed(Option.none<AutomationRun>())
              : Effect.fail(error),
          ),
          Effect.mapError(
            toPersistenceSqlError("AutomationRepository.createRunAndIncrementDefinition"),
          ),
        );

  const getRunById: AutomationRepositoryShape["getRunById"] = (input) =>
    getRunRowById(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getRunById:query")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toRun(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const getDeferredRunForDefinition: AutomationRepositoryShape["getDeferredRunForDefinition"] = (
    input,
  ) =>
    getDeferredRunRowByDefinition(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.getDeferredRunForDefinition:query"),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toRun(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const getLatestFinishedRunForDefinition: AutomationRepositoryShape["getLatestFinishedRunForDefinition"] =
    (input) =>
      getLatestFinishedRunRowByDefinition(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("AutomationRepository.getLatestFinishedRunForDefinition:query"),
        ),
        Effect.flatMap((rowOption) =>
          Option.match(rowOption, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) => toRun(row).pipe(Effect.map(Option.some)),
          }),
        ),
      );

  const listDueDeferredRuns: AutomationRepositoryShape["listDueDeferredRuns"] = (input) =>
    listDueDeferredRunRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.listDueDeferredRuns:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
    );

  const listRunsForDefinition: AutomationRepositoryShape["listRunsForDefinition"] = (input) =>
    listRunRowsForDefinition(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.listRunsForDefinition:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
    );

  const requireRunById = (id: AutomationRunDbRow["id"], operation: string) =>
    getRunById({ id }).pipe(
      Effect.flatMap((runOption) =>
        Option.match(runOption, {
          onNone: () =>
            Effect.fail(
              toPersistenceSqlError(`${operation}:missingRow`)(
                new Error("Automation run was not found after update."),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const markRunStarted: AutomationRepositoryShape["markRunStarted"] = (input) =>
    markRunStartedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunStarted:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunStarted")),
    );

  const reserveDeferredRun: AutomationRepositoryShape["reserveDeferredRun"] = (input) =>
    reserveDeferredRunRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.reserveDeferredRun:update")),
      Effect.map((rows) => rows.length > 0),
    );

  const setRunDeferred: AutomationRepositoryShape["setRunDeferred"] = (input) =>
    setRunDeferredRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.setRunDeferred:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.setRunDeferred")),
    );

  const markRunFailed: AutomationRepositoryShape["markRunFailed"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* markRunFailedRow(input);
          const run = yield* requireRunById(input.id, "AutomationRepository.markRunFailed");
          if (rows.length === 0) {
            return {
              run,
              transitioned: false,
              failureAccounting: Option.none(),
            };
          }
          const accountingRow = yield* recordDefinitionRunFailureRow({
            id: run.automationId,
            now: input.finishedAt,
          });
          return {
            run,
            transitioned: true,
            failureAccounting: Option.map(
              accountingRow,
              (row): RecordAutomationDefinitionRunFailureResult => ({
                consecutiveFailureCount: row.consecutiveFailureCount,
                autoDisabled: row.autoDisabled === 1,
              }),
            ),
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunFailed:update")));

  const markRunSkipped: AutomationRepositoryShape["markRunSkipped"] = (input) =>
    markRunSkippedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunSkipped:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunSkipped")),
    );

  const markRunSucceeded: AutomationRepositoryShape["markRunSucceeded"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* markRunSucceededRow(input);
          const run = yield* requireRunById(input.id, "AutomationRepository.markRunSucceeded");
          let failureCountReset = false;
          if (rows.length > 0) {
            const resetRows = yield* resetDefinitionFailureCountRow({
              id: run.automationId,
              now: input.accountedAt,
            });
            failureCountReset = resetRows.length > 0;
          }
          return { run, transitioned: rows.length > 0, failureCountReset };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunSucceeded:update")));

  const markRunResult: AutomationRepositoryShape["markRunResult"] = (input) =>
    markRunResultRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunResult:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunResult")),
    );

  const markRunResultPreservingTriage: AutomationRepositoryShape["markRunResultPreservingTriage"] =
    (input) =>
      markRunResultPreservingTriageRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("AutomationRepository.markRunResultPreservingTriage:update"),
        ),
        Effect.flatMap(() =>
          requireRunById(input.id, "AutomationRepository.markRunResultPreservingTriage"),
        ),
      );

  const markRunInterrupted: AutomationRepositoryShape["markRunInterrupted"] = (input) =>
    markRunInterruptedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunInterrupted:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunInterrupted")),
    );

  const markRunWaitingForApproval: AutomationRepositoryShape["markRunWaitingForApproval"] = (
    input,
  ) =>
    markRunWaitingForApprovalRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.markRunWaitingForApproval:update"),
      ),
      Effect.flatMap(() =>
        requireRunById(input.id, "AutomationRepository.markRunWaitingForApproval"),
      ),
    );

  const cancelRun: AutomationRepositoryShape["cancelRun"] = ({ runId, now }) =>
    cancelRunRow({ id: runId, now }).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.cancelRun:update")),
      Effect.flatMap(() => requireRunById(runId, "AutomationRepository.cancelRun")),
    );

  const getRunByThreadId: AutomationRepositoryShape["getRunByThreadId"] = (input) =>
    getRunRowByThread(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getRunByThreadId:query")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toRun(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const listRecoverableRuns: AutomationRepositoryShape["listRecoverableRuns"] = (input) =>
    listRecoverableRunRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.listRecoverableRuns:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
    );

  const listRunsNeedingCompletionEvaluation: AutomationRepositoryShape["listRunsNeedingCompletionEvaluation"] =
    (input) =>
      listRunsNeedingCompletionEvaluationRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("AutomationRepository.listRunsNeedingCompletionEvaluation:query"),
        ),
        Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
      );

  const countActiveRunsForDefinition: AutomationRepositoryShape["countActiveRunsForDefinition"] = (
    input,
  ) =>
    countActiveRunsRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.countActiveRunsForDefinition:query"),
      ),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  const countActiveRunsForThread: AutomationRepositoryShape["countActiveRunsForThread"] = (input) =>
    countActiveRunsByThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.countActiveRunsForThread:query")),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  const countPendingCompletionEvaluationsForThread: AutomationRepositoryShape["countPendingCompletionEvaluationsForThread"] =
    (input) =>
      countPendingCompletionEvaluationsByThreadRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "AutomationRepository.countPendingCompletionEvaluationsForThread:query",
          ),
        ),
        Effect.map((rows) => rows[0]?.count ?? 0),
      );

  const listActiveRunsForDefinition: AutomationRepositoryShape["listActiveRunsForDefinition"] = (
    input,
  ) =>
    listActiveRunsForDefinitionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.listActiveRunsForDefinition:query"),
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
    );

  const getEarliestNextRunAt: AutomationRepositoryShape["getEarliestNextRunAt"] = (input = {}) =>
    getEarliestNextRunAtRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getEarliestNextRunAt:query")),
      Effect.map((rowOption) =>
        Option.match(rowOption, {
          onNone: () => null,
          onSome: (row) => row.nextRunAt,
        }),
      ),
    );

  const markRunRead: AutomationRepositoryShape["markRunRead"] = ({ runId, unread, now }) =>
    requireRunById(runId, "AutomationRepository.markRunRead:load").pipe(
      Effect.flatMap((run) =>
        markRunResult({
          id: run.id,
          result: { ...withResultDefaults(run), unread },
          updatedAt: now,
        }),
      ),
    );

  const archiveRun: AutomationRepositoryShape["archiveRun"] = ({ runId, archived, now }) =>
    requireRunById(runId, "AutomationRepository.archiveRun:load").pipe(
      Effect.flatMap((run) =>
        markRunResult({
          id: run.id,
          result: {
            ...withResultDefaults(run),
            unread: archived ? false : withResultDefaults(run).unread,
            archivedAt: archived ? now : null,
          },
          updatedAt: now,
        }),
      ),
    );

  const getMemory: AutomationRepositoryShape["getMemory"] = (input) =>
    getMemoryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getMemory:query")),
    );

  const upsertMemory: AutomationRepositoryShape["upsertMemory"] = (input) =>
    upsertMemoryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.upsertMemory:update")),
      Effect.flatMap(() => getMemory({ automationId: input.automationId })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              toPersistenceDecodeCauseError("AutomationRepository.upsertMemory:missingRow")(
                new Error("Automation memory was not found after update."),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const getOrCreateInstallSalt: AutomationRepositoryShape["getOrCreateInstallSalt"] = () => {
    const key = "schedule-jitter-salt";
    const generated = randomBytes(32).toString("base64url");
    const updatedAt = new Date().toISOString();
    return insertAutomationSettingRow({ key, value: generated, updatedAt }).pipe(
      Effect.flatMap(() => getAutomationSettingRow({ key })),
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getOrCreateInstallSalt:query")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              toPersistenceDecodeCauseError(
                "AutomationRepository.getOrCreateInstallSalt:missingRow",
              )(new Error("Automation jitter salt was not found after initialization.")),
            ),
          onSome: (row) => Effect.succeed(row.value),
        }),
      ),
    );
  };

  const disableDefinition: AutomationRepositoryShape["disableDefinition"] = (input) =>
    disableDefinitionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.disableDefinition:update")),
    );

  const disableDefinitionIfUnchanged: AutomationRepositoryShape["disableDefinitionIfUnchanged"] = (
    input,
  ) =>
    disableDefinitionIfUnchangedRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.disableDefinitionIfUnchanged:update"),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const recordDefinitionRunFailure: AutomationRepositoryShape["recordDefinitionRunFailure"] = (
    input,
  ) =>
    recordDefinitionRunFailureRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.recordDefinitionRunFailure:update"),
      ),
      Effect.map(
        Option.map(
          (row): RecordAutomationDefinitionRunFailureResult => ({
            consecutiveFailureCount: row.consecutiveFailureCount,
            autoDisabled: row.autoDisabled === 1,
          }),
        ),
      ),
    );

  const resetDefinitionFailureCount: AutomationRepositoryShape["resetDefinitionFailureCount"] = (
    input,
  ) =>
    resetDefinitionFailureCountRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.resetDefinitionFailureCount:update"),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const incrementDefinitionIterationCount: AutomationRepositoryShape["incrementDefinitionIterationCount"] =
    (input) =>
      incrementIterationRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("AutomationRepository.incrementDefinitionIterationCount:update"),
        ),
      );

  const restartDefinitionLoop: AutomationRepositoryShape["restartDefinitionLoop"] = (input) =>
    restartDefinitionLoopRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.restartDefinitionLoop:update")),
    );

  const tryAcquireSchedulerLease: AutomationRepositoryShape["tryAcquireSchedulerLease"] = (input) =>
    acquireLease(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.tryAcquireLease:query")),
      Effect.map((rows) => rows.length > 0),
    );

  return {
    createDefinition,
    saveDefinition,
    resolvePendingProposal,
    getDefinitionById,
    listDueDefinitions,
    setDefinitionNextRunAt,
    attachDefinitionThread,
    archiveDefinition,
    list,
    createRun,
    createRunAndIncrementDefinition,
    getRunById,
    getDeferredRunForDefinition,
    listDueDeferredRuns,
    listRunsForDefinition,
    getLatestFinishedRunForDefinition,
    setRunDeferred,
    markRunStarted,
    reserveDeferredRun,
    markRunFailed,
    markRunSkipped,
    markRunSucceeded,
    markRunResult,
    markRunResultPreservingTriage,
    markRunInterrupted,
    markRunWaitingForApproval,
    cancelRun,
    getRunByThreadId,
    listRecoverableRuns,
    listRunsNeedingCompletionEvaluation,
    countActiveRunsForDefinition,
    countActiveRunsForThread,
    countPendingCompletionEvaluationsForThread,
    listActiveRunsForDefinition,
    getEarliestNextRunAt,
    markRunRead,
    archiveRun,
    getMemory,
    upsertMemory,
    getOrCreateInstallSalt,
    disableDefinition,
    disableDefinitionIfUnchanged,
    recordDefinitionRunFailure,
    resetDefinitionFailureCount,
    incrementDefinitionIterationCount,
    restartDefinitionLoop,
    tryAcquireSchedulerLease,
  } satisfies AutomationRepositoryShape;
});

export const AutomationRepositoryLive = Layer.effect(
  AutomationRepository,
  makeAutomationRepository,
);
