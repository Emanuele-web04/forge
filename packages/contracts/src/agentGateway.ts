/**
 * Public contracts for the Synara agent-control gateway.
 *
 * New gateway tools decode these schemas before doing any work. Keeping the
 * limits here ensures the MCP surface, server implementation, and tests share
 * the same definition of an exact creation/wait plan.
 */
import { Schema } from "effect";

import { CheckpointRef, IsoDateTime, MessageId, ProjectId, ThreadId, TurnId } from "./baseSchemas";
import {
  ModelSelection,
  OrchestrationCheckpointStatus,
  OrchestrationMessageRole,
  OrchestrationThreadPullRequest,
  PinnedMessageLabel,
  ProviderKind,
  ThreadCreationSource,
  ThreadGoal,
  ThreadHandoff,
  ThreadNotes,
} from "./orchestration";
import { ProviderModelDescriptor } from "./providerDiscovery";
import { ServerProviderAuthStatus } from "./server";

export const SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION = 20;
export const SYNARA_GATEWAY_MAX_REQUEST_ID_LENGTH = 256;
export const SYNARA_GATEWAY_MAX_WAIT_MS = 60_000;

export const SynaraGatewayErrorCode = Schema.Literals([
  "caller_session_inactive",
  "caller_turn_inactive",
  "capability_denied",
  "provider_unavailable",
  "model_unavailable",
  "model_option_unavailable",
  "idempotency_conflict",
  "creation_plan_locked",
  "creation_limit_exceeded",
  "thread_not_found",
  "wait_timed_out",
  "operation_failed",
]);
export type SynaraGatewayErrorCode = typeof SynaraGatewayErrorCode.Type;

export const SynaraGatewayError = Schema.Struct({
  code: SynaraGatewayErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type SynaraGatewayError = typeof SynaraGatewayError.Type;

export const SynaraGatewayErrorResult = Schema.Struct({
  error: SynaraGatewayError,
});
export type SynaraGatewayErrorResult = typeof SynaraGatewayErrorResult.Type;

export const SynaraGatewayPinnedMessageSummary = Schema.Struct({
  messageId: MessageId,
  label: Schema.NullOr(PinnedMessageLabel),
  done: Schema.Boolean,
  pinnedAt: IsoDateTime,
  message: Schema.NullOr(
    Schema.Struct({
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      role: OrchestrationMessageRole,
      text: Schema.String,
      truncated: Schema.Boolean,
    }),
  ),
});
export type SynaraGatewayPinnedMessageSummary = typeof SynaraGatewayPinnedMessageSummary.Type;

export const SynaraGatewayCheckpointSummary = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  latest: Schema.NullOr(
    Schema.Struct({
      turnId: TurnId,
      checkpointTurnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      checkpointRef: CheckpointRef,
      status: OrchestrationCheckpointStatus,
      completedAt: IsoDateTime,
      fileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      files: Schema.Array(Schema.String),
      filesTruncated: Schema.Boolean,
    }),
  ),
});
export type SynaraGatewayCheckpointSummary = typeof SynaraGatewayCheckpointSummary.Type;

export const SynaraGatewayThreadLineage = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  sourceThreadId: Schema.NullOr(ThreadId),
  sourceTurnId: Schema.NullOr(TurnId),
  creationSource: Schema.NullOr(ThreadCreationSource),
  gatewayOperationId: Schema.NullOr(Schema.String),
  gatewayOperationIndex: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  handoff: Schema.NullOr(ThreadHandoff),
});
export type SynaraGatewayThreadLineage = typeof SynaraGatewayThreadLineage.Type;

/** Compact, provider-independent state that survives provider session replacement. */
export const SynaraDurableTaskState = Schema.Struct({
  goal: Schema.NullOr(ThreadGoal),
  goalStartedAt: Schema.NullOr(IsoDateTime),
  goalPausedAt: Schema.NullOr(IsoDateTime),
  notes: Schema.NullOr(ThreadNotes),
  notesTruncated: Schema.Boolean,
  pins: Schema.Array(SynaraGatewayPinnedMessageSummary),
  settledAt: Schema.NullOr(IsoDateTime),
  lastKnownPr: Schema.NullOr(OrchestrationThreadPullRequest),
  lineage: SynaraGatewayThreadLineage,
  checkpoints: SynaraGatewayCheckpointSummary,
});
export type SynaraDurableTaskState = typeof SynaraDurableTaskState.Type;

export const SynaraContextResult = Schema.Struct({
  harness: Schema.Struct({
    name: Schema.Literal("Synara"),
    policyVersion: Schema.String,
  }),
  caller: Schema.Struct({
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    provider: ProviderKind,
    projectId: ProjectId,
  }),
  taskState: SynaraDurableTaskState,
  capabilities: Schema.Struct({
    threadRead: Schema.Boolean,
    threadCreate: Schema.Boolean,
    threadWait: Schema.Boolean,
    diagnostics: Schema.Boolean,
    automations: Schema.Boolean,
  }),
});
export type SynaraContextResult = typeof SynaraContextResult.Type;

export const SynaraCreateThreadSpec = Schema.Struct({
  prompt: Schema.String.check(Schema.isNonEmpty()),
  title: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  target: ModelSelection,
  projectId: Schema.optional(ProjectId),
  environment: Schema.optional(Schema.Literals(["local", "worktree"])),
  baseRef: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  // Legacy inputs remain decodable for replay/backward compatibility, but the
  // MCP catalog no longer advertises branch-backed worktree creation.
  baseBranch: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  branchName: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  runtimeMode: Schema.optional(Schema.Literals(["approval-required", "full-access"])),
});
export type SynaraCreateThreadSpec = typeof SynaraCreateThreadSpec.Type;

const SynaraGatewayRequestId = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(SYNARA_GATEWAY_MAX_REQUEST_ID_LENGTH),
);

export const SynaraCreateThreadsInput = Schema.Struct({
  requestId: SynaraGatewayRequestId,
  threads: Schema.Array(SynaraCreateThreadSpec)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SynaraCreateThreadsInput = typeof SynaraCreateThreadsInput.Type;

export const SynaraProviderCatalog = Schema.Struct({
  provider: ProviderKind,
  defaultModel: Schema.NullOr(Schema.String),
  models: Schema.Array(ProviderModelDescriptor),
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  authStatus: Schema.optional(ServerProviderAuthStatus),
  source: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type SynaraProviderCatalog = typeof SynaraProviderCatalog.Type;

export const SynaraGatewayTargetOptionValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
]);
export type SynaraGatewayTargetOptionValue = typeof SynaraGatewayTargetOptionValue.Type;

export const SynaraGatewayTargetOptionRule = Schema.Struct({
  key: Schema.String,
  valueType: Schema.Literals(["string", "number", "boolean"]),
  allowedValues: Schema.Array(SynaraGatewayTargetOptionValue),
  allowedValuesSource: Schema.Literals(["provider-contract", "model-discovery"]),
});
export type SynaraGatewayTargetOptionRule = typeof SynaraGatewayTargetOptionRule.Type;

export const SynaraGatewayTargetConstruction = Schema.Struct({
  modelValueSource: Schema.Literal("providers[].models[].slug"),
  primaryOptionKey: Schema.String,
  alternativeOptionKeys: Schema.Array(Schema.String),
  optionSelectionRule: Schema.String,
  providerOptions: Schema.Array(SynaraGatewayTargetOptionRule),
  optionsByModel: Schema.Record(Schema.String, Schema.Array(SynaraGatewayTargetOptionRule)),
  exampleTarget: Schema.NullOr(ModelSelection),
});
export type SynaraGatewayTargetConstruction = typeof SynaraGatewayTargetConstruction.Type;

export const SynaraCapabilitiesResult = Schema.Struct({
  targetConstruction: Schema.Record(Schema.String, SynaraGatewayTargetConstruction),
  providers: Schema.Array(SynaraProviderCatalog),
  limits: Schema.Struct({
    maxThreadsPerOperation: Schema.Int,
    maxWaitMs: Schema.Int,
    oneCreationPlanPerActiveTurn: Schema.Boolean,
  }),
});
export type SynaraCapabilitiesResult = typeof SynaraCapabilitiesResult.Type;

export const SynaraCreatedThreadResult = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  target: ModelSelection,
  provider: ProviderKind,
  model: Schema.String,
  runtimeMode: Schema.Literals(["approval-required", "full-access"]),
  environment: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  status: Schema.Literal("task_dispatched"),
});
export type SynaraCreatedThreadResult = typeof SynaraCreatedThreadResult.Type;

export const SynaraCreateThreadsResult = Schema.Struct({
  operationId: Schema.String,
  requestId: SynaraGatewayRequestId,
  requestedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  threadIds: Schema.Array(ThreadId),
  threads: Schema.Array(SynaraCreatedThreadResult),
});
export type SynaraCreateThreadsResult = typeof SynaraCreateThreadsResult.Type;

export const SynaraWaitForThreadsInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION)),
  runIds: Schema.optional(
    Schema.Array(Schema.NullOr(TurnId)).check(
      Schema.isMaxLength(SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION),
    ),
  ),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(SYNARA_GATEWAY_MAX_WAIT_MS),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SynaraWaitForThreadsInput = typeof SynaraWaitForThreadsInput.Type;

export const SynaraWaitedThreadResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(TurnId),
  state: Schema.Literals(["idle", "pending", "running", "completed", "error", "interrupted"]),
  terminal: Schema.Boolean,
  timedOut: Schema.Boolean,
  summary: Schema.NullOr(Schema.String),
  summaryTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  readThread: Schema.Struct({
    tool: Schema.Literal("synara_read_thread"),
    arguments: Schema.Struct({ threadId: ThreadId }),
  }),
});
export type SynaraWaitedThreadResult = typeof SynaraWaitedThreadResult.Type;

export const SynaraWaitForThreadsResult = Schema.Struct({
  callerThreadId: ThreadId,
  runIds: Schema.Array(Schema.NullOr(TurnId)),
  allTerminal: Schema.Boolean,
  timedOut: Schema.Boolean,
  threads: Schema.Array(SynaraWaitedThreadResult),
});
export type SynaraWaitForThreadsResult = typeof SynaraWaitForThreadsResult.Type;
