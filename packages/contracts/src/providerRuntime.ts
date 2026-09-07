import { Option, Schema } from "effect";
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProviderItemId,
  PositiveInt,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ProviderKind } from "./orchestration";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const RuntimeEventRawSource = Schema.Literals([
  "codex.app-server.notification",
  "codex.app-server.request",
  "codex.eventmsg",
  "claude.sdk.message",
  "claude.sdk.permission",
  "claude.sdk.hook",
  "codex.sdk.thread-event",
  "antigravity.cli.event",
  "acp.jsonrpc",
  "acp.cursor.extension",
  "opencode.sdk.event",
  "pi.sdk.event",
]);
export type RuntimeEventRawSource = typeof RuntimeEventRawSource.Type;

export const RuntimeEventRaw = Schema.Struct({
  source: RuntimeEventRawSource,
  method: Schema.optional(TrimmedNonEmptyStringSchema),
  messageType: Schema.optional(TrimmedNonEmptyStringSchema),
  payload: Schema.Unknown,
});
export type RuntimeEventRaw = typeof RuntimeEventRaw.Type;

const ProviderRequestId = TrimmedNonEmptyStringSchema;
export type ProviderRequestId = typeof ProviderRequestId.Type;

const ProviderRefs = Schema.Struct({
  providerThreadId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerParentThreadId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerTurnId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentProviderTurnId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(ProviderRequestId),
});
export type ProviderRefs = typeof ProviderRefs.Type;

const RuntimeSessionState = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type RuntimeSessionState = typeof RuntimeSessionState.Type;

const RuntimeThreadState = Schema.Literals([
  "active",
  "idle",
  "archived",
  "closed",
  "compacted",
  "error",
]);
export type RuntimeThreadState = typeof RuntimeThreadState.Type;

const RuntimeTurnState = Schema.Literals(["completed", "failed", "interrupted", "cancelled"]);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

const RuntimeTaskStatus = Schema.Literals(["pending", "inProgress", "completed"]);
export type RuntimeTaskStatus = typeof RuntimeTaskStatus.Type;

const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

const RuntimeContentStreamKind = Schema.Literals([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
  "unknown",
]);
export type RuntimeContentStreamKind = typeof RuntimeContentStreamKind.Type;

const RuntimeSessionExitKind = Schema.Literals(["graceful", "error"]);
export type RuntimeSessionExitKind = typeof RuntimeSessionExitKind.Type;

const RuntimeErrorClass = Schema.Literals([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type RuntimeErrorClass = typeof RuntimeErrorClass.Type;

export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
  "image_generation",
] as const;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

export const CanonicalItemType = Schema.Literals([
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  ...TOOL_LIFECYCLE_ITEM_TYPES,
  "review_entered",
  "review_exited",
  "context_compaction",
  "error",
  "unknown",
]);
export type CanonicalItemType = typeof CanonicalItemType.Type;

export const CanonicalRequestType = Schema.Literals([
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "permissions_approval",
  "apply_patch_approval",
  "exec_command_approval",
  "tool_user_input",
  "dynamic_tool_call",
  "auth_tokens_refresh",
  "unknown",
]);
export type CanonicalRequestType = typeof CanonicalRequestType.Type;

const ProviderRuntimeEventType = Schema.Literals([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.token-usage.updated",
  "thread.realtime.started",
  "thread.realtime.item-added",
  "thread.realtime.audio.delta",
  "thread.realtime.error",
  "thread.realtime.closed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "turn.tasks.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "turn.steered",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "hook.started",
  "hook.progress",
  "hook.completed",
  "tool.progress",
  "tool.summary",
  "auth.status",
  "account.updated",
  "account.rate-limits.updated",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "model.rerouted",
  "config.warning",
  "deprecation.notice",
  "files.persisted",
  "vcs.state.changed",
  "runtime.warning",
  "runtime.error",
  "event.unmapped",
]);
export type ProviderRuntimeEventType = typeof ProviderRuntimeEventType.Type;

const SessionStartedType = Schema.Literal("session.started");
const SessionConfiguredType = Schema.Literal("session.configured");
const SessionStateChangedType = Schema.Literal("session.state.changed");
const SessionExitedType = Schema.Literal("session.exited");
const ThreadStartedType = Schema.Literal("thread.started");
const ThreadStateChangedType = Schema.Literal("thread.state.changed");
const ThreadMetadataUpdatedType = Schema.Literal("thread.metadata.updated");
const ThreadTokenUsageUpdatedType = Schema.Literal("thread.token-usage.updated");
const ThreadRealtimeStartedType = Schema.Literal("thread.realtime.started");
const ThreadRealtimeItemAddedType = Schema.Literal("thread.realtime.item-added");
const ThreadRealtimeAudioDeltaType = Schema.Literal("thread.realtime.audio.delta");
const ThreadRealtimeErrorType = Schema.Literal("thread.realtime.error");
const ThreadRealtimeClosedType = Schema.Literal("thread.realtime.closed");
const TurnStartedType = Schema.Literal("turn.started");
const TurnCompletedType = Schema.Literal("turn.completed");
const TurnAbortedType = Schema.Literal("turn.aborted");
const TurnTasksUpdatedType = Schema.Literal("turn.tasks.updated");
const TurnProposedDeltaType = Schema.Literal("turn.proposed.delta");
const TurnProposedCompletedType = Schema.Literal("turn.proposed.completed");
const TurnDiffUpdatedType = Schema.Literal("turn.diff.updated");
const TurnSteeredType = Schema.Literal("turn.steered");
const ItemStartedType = Schema.Literal("item.started");
const ItemUpdatedType = Schema.Literal("item.updated");
const ItemCompletedType = Schema.Literal("item.completed");
const ContentDeltaType = Schema.Literal("content.delta");
const RequestOpenedType = Schema.Literal("request.opened");
const RequestResolvedType = Schema.Literal("request.resolved");
const UserInputRequestedType = Schema.Literal("user-input.requested");
const UserInputResolvedType = Schema.Literal("user-input.resolved");
const TaskStartedType = Schema.Literal("task.started");
const TaskProgressType = Schema.Literal("task.progress");
const TaskUpdatedType = Schema.Literal("task.updated");
const TaskCompletedType = Schema.Literal("task.completed");
const HookStartedType = Schema.Literal("hook.started");
const HookProgressType = Schema.Literal("hook.progress");
const HookCompletedType = Schema.Literal("hook.completed");
const ToolProgressType = Schema.Literal("tool.progress");
const ToolSummaryType = Schema.Literal("tool.summary");
const AuthStatusType = Schema.Literal("auth.status");
const AccountUpdatedType = Schema.Literal("account.updated");
const AccountRateLimitsUpdatedType = Schema.Literal("account.rate-limits.updated");
const McpStatusUpdatedType = Schema.Literal("mcp.status.updated");
const McpOauthCompletedType = Schema.Literal("mcp.oauth.completed");
const ModelReroutedType = Schema.Literal("model.rerouted");
const ConfigWarningType = Schema.Literal("config.warning");
const DeprecationNoticeType = Schema.Literal("deprecation.notice");
const FilesPersistedType = Schema.Literal("files.persisted");
const VcsStateChangedType = Schema.Literal("vcs.state.changed");
const RuntimeWarningType = Schema.Literal("runtime.warning");
const RuntimeErrorType = Schema.Literal("runtime.error");
const EventUnmappedType = Schema.Literal("event.unmapped");

const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  parentTurnId: Schema.optional(TurnId),
  itemId: Schema.optional(RuntimeItemId),
  requestId: Schema.optional(RuntimeRequestId),
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyStringSchema),
  providerRefs: Schema.optional(ProviderRefs),
  raw: Schema.optional(RuntimeEventRaw),
});
export type ProviderRuntimeEventBase = typeof ProviderRuntimeEventBase.Type;

const SessionStartedPayload = Schema.Struct({
  message: Schema.optional(TrimmedNonEmptyStringSchema),
  resume: Schema.optional(Schema.Unknown),
});
export type SessionStartedPayload = typeof SessionStartedPayload.Type;

const SessionConfiguredPayload = Schema.Struct({
  config: UnknownRecordSchema,
});
export type SessionConfiguredPayload = typeof SessionConfiguredPayload.Type;

const SessionStateChangedPayload = Schema.Struct({
  state: RuntimeSessionState,
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(Schema.Unknown),
});
export type SessionStateChangedPayload = typeof SessionStateChangedPayload.Type;

const SessionExitedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  recoverable: Schema.optional(Schema.Boolean),
  exitKind: Schema.optional(RuntimeSessionExitKind),
});
export type SessionExitedPayload = typeof SessionExitedPayload.Type;

const ThreadStartedPayload = Schema.Struct({
  providerThreadId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadStartedPayload = typeof ThreadStartedPayload.Type;

const ThreadStateChangedPayload = Schema.Struct({
  state: RuntimeThreadState,
  detail: Schema.optional(Schema.Unknown),
});
export type ThreadStateChangedPayload = typeof ThreadStateChangedPayload.Type;

const ThreadMetadataUpdatedPayload = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyStringSchema),
  metadata: Schema.optional(UnknownRecordSchema),
});
export type ThreadMetadataUpdatedPayload = typeof ThreadMetadataUpdatedPayload.Type;

export const ThreadTokenUsageSnapshot = Schema.Struct({
  usedTokens: NonNegativeInt,
  usedPercent: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  totalProcessedTokens: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(PositiveInt),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  lastUsedTokens: Schema.optional(NonNegativeInt),
  lastInputTokens: Schema.optional(NonNegativeInt),
  lastCachedInputTokens: Schema.optional(NonNegativeInt),
  lastOutputTokens: Schema.optional(NonNegativeInt),
  lastReasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  compactsAutomatically: Schema.optional(Schema.Boolean),
});
export type ThreadTokenUsageSnapshot = typeof ThreadTokenUsageSnapshot.Type;

const ThreadTokenUsageUpdatedPayload = Schema.Struct({
  usage: ThreadTokenUsageSnapshot,
});
export type ThreadTokenUsageUpdatedPayload = typeof ThreadTokenUsageUpdatedPayload.Type;

const ThreadRealtimeStartedPayload = Schema.Struct({
  realtimeSessionId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadRealtimeStartedPayload = typeof ThreadRealtimeStartedPayload.Type;

const ThreadRealtimeItemAddedPayload = Schema.Struct({
  item: Schema.Unknown,
});
export type ThreadRealtimeItemAddedPayload = typeof ThreadRealtimeItemAddedPayload.Type;

const ThreadRealtimeAudioDeltaPayload = Schema.Struct({
  audio: Schema.Unknown,
});
export type ThreadRealtimeAudioDeltaPayload = typeof ThreadRealtimeAudioDeltaPayload.Type;

const ThreadRealtimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
});
export type ThreadRealtimeErrorPayload = typeof ThreadRealtimeErrorPayload.Type;

const ThreadRealtimeClosedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadRealtimeClosedPayload = typeof ThreadRealtimeClosedPayload.Type;

const TurnStartedPayload = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnStartedPayload = typeof TurnStartedPayload.Type;

const TurnCompletedPayload = Schema.Struct({
  state: RuntimeTurnState,
  stopReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  usage: Schema.optional(Schema.Unknown),
  modelUsage: Schema.optional(UnknownRecordSchema),
  totalCostUsd: Schema.optional(Schema.Number),
  cumulativeCostUsd: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnCompletedPayload = typeof TurnCompletedPayload.Type;

const TurnAbortedPayload = Schema.Struct({
  reason: TrimmedNonEmptyStringSchema,
});
export type TurnAbortedPayload = typeof TurnAbortedPayload.Type;

const RuntimeTaskListItem = Schema.Struct({
  task: TrimmedNonEmptyStringSchema,
  status: RuntimeTaskStatus,
});
export type RuntimeTaskListItem = typeof RuntimeTaskListItem.Type;

const TurnTasksUpdatedPayload = Schema.Struct({
  explanation: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  tasks: Schema.Array(RuntimeTaskListItem),
});
export type TurnTasksUpdatedPayload = typeof TurnTasksUpdatedPayload.Type;

const TurnProposedDeltaPayload = Schema.Struct({
  delta: Schema.String,
});
export type TurnProposedDeltaPayload = typeof TurnProposedDeltaPayload.Type;

const TurnProposedCompletedPayload = Schema.Struct({
  planMarkdown: TrimmedNonEmptyStringSchema,
});
export type TurnProposedCompletedPayload = typeof TurnProposedCompletedPayload.Type;

const TurnDiffUpdatedPayload = Schema.Struct({
  unifiedDiff: Schema.String,
});
export type TurnDiffUpdatedPayload = typeof TurnDiffUpdatedPayload.Type;

export const ItemLifecyclePayload = Schema.Struct({
  itemType: CanonicalItemType,
  status: Schema.optional(RuntimeItemStatus),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  // Free-form body (e.g. raw tool output), which legitimately carries leading
  // and/or trailing whitespace. Keep it unconstrained so item events from
  // provider adapters (pi, opencode, codex, ...) always pass the durable
  // journal's encode step; a TrimmedNonEmptyString here rejects ordinary
  // tool output and forces the event into quarantine.
  detail: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});
export type ItemLifecyclePayload = typeof ItemLifecyclePayload.Type;

// Codex-generated images are persisted as local file references, never inline bytes.
export const CODEX_GENERATED_IMAGE_ARTIFACT_KIND = "codex.generated_image" as const;
export const CodexGeneratedImageArtifact = Schema.Struct({
  kind: Schema.Literal(CODEX_GENERATED_IMAGE_ARTIFACT_KIND),
  path: TrimmedNonEmptyStringSchema,
  callId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type CodexGeneratedImageArtifact = typeof CodexGeneratedImageArtifact.Type;

const ContentDeltaPayload = Schema.Struct({
  streamKind: RuntimeContentStreamKind,
  delta: Schema.String,
  contentIndex: Schema.optional(Schema.Int),
  summaryIndex: Schema.optional(Schema.Int),
});
export type ContentDeltaPayload = typeof ContentDeltaPayload.Type;

const RequestOpenedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  args: Schema.optional(Schema.Unknown),
});
export type RequestOpenedPayload = typeof RequestOpenedPayload.Type;

const RequestResolvedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  decision: Schema.optional(TrimmedNonEmptyStringSchema),
  resolution: Schema.optional(Schema.Unknown),
});
export type RequestResolvedPayload = typeof RequestResolvedPayload.Type;

const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  description: TrimmedNonEmptyStringSchema,
});
export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

const UserInputRequestedPayload = Schema.Struct({
  questions: Schema.Array(UserInputQuestion),
});
export type UserInputRequestedPayload = typeof UserInputRequestedPayload.Type;

const UserInputResolvedPayload = Schema.Struct({
  answers: UnknownRecordSchema,
});
export type UserInputResolvedPayload = typeof UserInputResolvedPayload.Type;

// Phase declared in a workflow script's `meta.phases` literal.
const WorkflowPhase = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type WorkflowPhase = typeof WorkflowPhase.Type;

// Final per-agent snapshot from a settled workflow's progress file.
const WorkflowAgentSnapshot = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  phaseIndex: Schema.optional(Schema.Int),
  // Authoritative phase name from the progress file; phaseIndex is 1-based in
  // recent CLI output files, so prefer the title when both are present.
  phaseTitle: Schema.optional(TrimmedNonEmptyStringSchema),
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  // Backfilled from the live runtime snapshots at settle when the progress
  // file itself carries no effort.
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
  state: Schema.optional(TrimmedNonEmptyStringSchema),
  tokens: Schema.optional(Schema.Int),
  toolCalls: Schema.optional(Schema.Int),
  durationMs: Schema.optional(Schema.Int),
  lastToolName: Schema.optional(TrimmedNonEmptyStringSchema),
  promptPreview: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type WorkflowAgentSnapshot = typeof WorkflowAgentSnapshot.Type;

// Live per-agent snapshot polled from a running workflow's transcript directory
// (journal.jsonl + agent-<id>.jsonl). The label is a best-effort join against
// the workflow's progress descriptions and may be absent.
const WorkflowAgentRuntimeSnapshot = Schema.Struct({
  agentId: TrimmedNonEmptyStringSchema,
  label: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  // Top-level `effort` field on the transcript's assistant lines.
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
  state: Schema.optional(Schema.Literals(["running", "completed"])),
  tokens: Schema.optional(Schema.Int),
  toolCalls: Schema.optional(Schema.Int),
  recentToolNames: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  promptPreview: Schema.optional(TrimmedNonEmptyStringSchema),
  startedAt: Schema.optional(TrimmedNonEmptyStringSchema),
  lastActivityAt: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type WorkflowAgentRuntimeSnapshot = typeof WorkflowAgentRuntimeSnapshot.Type;

// Per-agent() opts scanned statically from a workflow script (string literals
// only): planned phase/model/effort for an agent label before it runs live.
const WorkflowAgentPlan = Schema.Struct({
  phase: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type WorkflowAgentPlan = typeof WorkflowAgentPlan.Type;

const TaskStartedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  taskType: Schema.optional(TrimmedNonEmptyStringSchema),
  subagentType: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowName: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowTaskId: Schema.optional(RuntimeTaskId),
  // Parsed statically from the workflow script (task_started.prompt or the
  // Workflow tool input); absent when the meta literal is not parseable.
  workflowPhases: Schema.optional(Schema.Array(WorkflowPhase)),
  // agent() label -> phase title pairs scanned from the script text.
  workflowAgentPhases: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // agent() label -> planned {phase, model, effort} opts scanned from the script
  // text. Superset of workflowAgentPhases (kept for already-persisted events).
  workflowAgentPlans: Schema.optional(Schema.Record(Schema.String, WorkflowAgentPlan)),
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskStartedPayload = typeof TaskStartedPayload.Type;

const TaskProgressPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: TrimmedNonEmptyStringSchema,
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  lastToolName: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowTaskId: Schema.optional(RuntimeTaskId),
  // Live per-agent snapshots for workflow tasks, polled from the run's
  // transcript directory while the workflow is running.
  workflowAgents: Schema.optional(Schema.Array(WorkflowAgentRuntimeSnapshot)),
});
export type TaskProgressPayload = typeof TaskProgressPayload.Type;

const TaskUpdatedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.optional(
    Schema.Literals(["pending", "running", "completed", "failed", "killed", "paused"]),
  ),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
  // Set when the SDK moves a blocking Task call between foreground and background.
  isBackgrounded: Schema.optional(Schema.Boolean),
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowTaskId: Schema.optional(RuntimeTaskId),
  // Persisted launch identifiers from the Workflow tool result; re-invoking the
  // tool with {scriptPath, resumeFromRunId} resumes the run.
  workflowRunId: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowScriptPath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskUpdatedPayload = typeof TaskUpdatedPayload.Type;

const TaskCompletedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  workflowTaskId: Schema.optional(RuntimeTaskId),
  workflowAgents: Schema.optional(Schema.Array(WorkflowAgentSnapshot)),
});
export type TaskCompletedPayload = typeof TaskCompletedPayload.Type;

// A user message was injected into running work without interrupting it.
// `target` says where it landed, which decides whether the message needs its own
// transcript marker: a `"subagent"` steer is delivered on the child thread where
// nothing else shows it, while a `"turn"` steer is already rendered as the sent
// user message on the thread it steers. Absent means `"subagent"` (the only
// producer before turn steering existed).
const TurnSteeredPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  target: Schema.optional(Schema.Literals(["turn", "subagent"])),
});
export type TurnSteeredPayload = typeof TurnSteeredPayload.Type;

const HookStartedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  hookName: TrimmedNonEmptyStringSchema,
  hookEvent: TrimmedNonEmptyStringSchema,
  statusMessage: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
});
export type HookStartedPayload = typeof HookStartedPayload.Type;

const HookProgressPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
});
export type HookProgressPayload = typeof HookProgressPayload.Type;

const HookCompletedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  hookName: Schema.optional(TrimmedNonEmptyStringSchema),
  hookEvent: Schema.optional(TrimmedNonEmptyStringSchema),
  outcome: Schema.Literals(["success", "error", "cancelled"]),
  status: Schema.optional(Schema.Literals(["completed", "failed", "blocked", "stopped"])),
  statusMessage: Schema.optional(TrimmedNonEmptyStringSchema),
  durationMs: Schema.optional(NonNegativeInt),
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Int),
  data: Schema.optional(Schema.Unknown),
});
export type HookCompletedPayload = typeof HookCompletedPayload.Type;

const ToolProgressPayload = Schema.Struct({
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  toolName: Schema.optional(TrimmedNonEmptyStringSchema),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  elapsedSeconds: Schema.optional(Schema.Number),
});
export type ToolProgressPayload = typeof ToolProgressPayload.Type;

const ToolSummaryPayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  precedingToolUseIds: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
});
export type ToolSummaryPayload = typeof ToolSummaryPayload.Type;

const AuthStatusPayload = Schema.Struct({
  isAuthenticating: Schema.optional(Schema.Boolean),
  output: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type AuthStatusPayload = typeof AuthStatusPayload.Type;

const AccountUpdatedPayload = Schema.Struct({
  account: Schema.Unknown,
});
export type AccountUpdatedPayload = typeof AccountUpdatedPayload.Type;

const AccountRateLimitsUpdatedPayload = Schema.Struct({
  rateLimits: Schema.Unknown,
});
export type AccountRateLimitsUpdatedPayload = typeof AccountRateLimitsUpdatedPayload.Type;

const McpStatusUpdatedPayload = Schema.Struct({
  status: Schema.Unknown,
});
export type McpStatusUpdatedPayload = typeof McpStatusUpdatedPayload.Type;

const McpOauthCompletedPayload = Schema.Struct({
  success: Schema.Boolean,
  name: Schema.optional(TrimmedNonEmptyStringSchema),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type McpOauthCompletedPayload = typeof McpOauthCompletedPayload.Type;

const ModelReroutedPayload = Schema.Struct({
  fromModel: TrimmedNonEmptyStringSchema,
  toModel: TrimmedNonEmptyStringSchema,
  reason: TrimmedNonEmptyStringSchema,
});
export type ModelReroutedPayload = typeof ModelReroutedPayload.Type;

const ConfigWarningPayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  details: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.optional(TrimmedNonEmptyStringSchema),
  range: Schema.optional(Schema.Unknown),
});
export type ConfigWarningPayload = typeof ConfigWarningPayload.Type;

const DeprecationNoticePayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  details: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type DeprecationNoticePayload = typeof DeprecationNoticePayload.Type;

const FilesPersistedPayload = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      filename: TrimmedNonEmptyStringSchema,
      fileId: TrimmedNonEmptyStringSchema,
    }),
  ),
  failed: Schema.optional(
    Schema.Array(
      Schema.Struct({
        filename: TrimmedNonEmptyStringSchema,
        error: TrimmedNonEmptyStringSchema,
      }),
    ),
  ),
});
export type FilesPersistedPayload = typeof FilesPersistedPayload.Type;

const VcsStateChangedPayload = Schema.Struct({
  kind: Schema.optional(TrimmedNonEmptyStringSchema),
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type VcsStateChangedPayload = typeof VcsStateChangedPayload.Type;

const RuntimeWarningPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeWarningPayload = typeof RuntimeWarningPayload.Type;

const RuntimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  class: Schema.optional(RuntimeErrorClass),
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeErrorPayload = typeof RuntimeErrorPayload.Type;

// Forward-compatible diagnostic for provider events without an explicit mapping.
// The adapter bounds and redacts `data`; `detail` is a safe readable one-liner.
const EventUnmappedPayload = Schema.Struct({
  nativeType: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
});
export type EventUnmappedPayload = typeof EventUnmappedPayload.Type;

const ProviderRuntimeSessionStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionStartedType,
  payload: SessionStartedPayload,
});
export type ProviderRuntimeSessionStartedEvent = typeof ProviderRuntimeSessionStartedEvent.Type;

const ProviderRuntimeSessionConfiguredEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionConfiguredType,
  payload: SessionConfiguredPayload,
});
export type ProviderRuntimeSessionConfiguredEvent =
  typeof ProviderRuntimeSessionConfiguredEvent.Type;

const ProviderRuntimeSessionStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionStateChangedType,
  payload: SessionStateChangedPayload,
});
export type ProviderRuntimeSessionStateChangedEvent =
  typeof ProviderRuntimeSessionStateChangedEvent.Type;

const ProviderRuntimeSessionExitedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionExitedType,
  payload: SessionExitedPayload,
});
export type ProviderRuntimeSessionExitedEvent = typeof ProviderRuntimeSessionExitedEvent.Type;

const ProviderRuntimeThreadStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadStartedType,
  payload: ThreadStartedPayload,
});
export type ProviderRuntimeThreadStartedEvent = typeof ProviderRuntimeThreadStartedEvent.Type;

const ProviderRuntimeThreadStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadStateChangedType,
  payload: ThreadStateChangedPayload,
});
export type ProviderRuntimeThreadStateChangedEvent =
  typeof ProviderRuntimeThreadStateChangedEvent.Type;

const ProviderRuntimeThreadMetadataUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadMetadataUpdatedType,
  payload: ThreadMetadataUpdatedPayload,
});
export type ProviderRuntimeThreadMetadataUpdatedEvent =
  typeof ProviderRuntimeThreadMetadataUpdatedEvent.Type;

const ProviderRuntimeThreadTokenUsageUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadTokenUsageUpdatedType,
  payload: ThreadTokenUsageUpdatedPayload,
});
export type ProviderRuntimeThreadTokenUsageUpdatedEvent =
  typeof ProviderRuntimeThreadTokenUsageUpdatedEvent.Type;

const ProviderRuntimeThreadRealtimeStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeStartedType,
  payload: ThreadRealtimeStartedPayload,
});
export type ProviderRuntimeThreadRealtimeStartedEvent =
  typeof ProviderRuntimeThreadRealtimeStartedEvent.Type;

const ProviderRuntimeThreadRealtimeItemAddedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeItemAddedType,
  payload: ThreadRealtimeItemAddedPayload,
});
export type ProviderRuntimeThreadRealtimeItemAddedEvent =
  typeof ProviderRuntimeThreadRealtimeItemAddedEvent.Type;

const ProviderRuntimeThreadRealtimeAudioDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeAudioDeltaType,
  payload: ThreadRealtimeAudioDeltaPayload,
});
export type ProviderRuntimeThreadRealtimeAudioDeltaEvent =
  typeof ProviderRuntimeThreadRealtimeAudioDeltaEvent.Type;

const ProviderRuntimeThreadRealtimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeErrorType,
  payload: ThreadRealtimeErrorPayload,
});
export type ProviderRuntimeThreadRealtimeErrorEvent =
  typeof ProviderRuntimeThreadRealtimeErrorEvent.Type;

const ProviderRuntimeThreadRealtimeClosedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeClosedType,
  payload: ThreadRealtimeClosedPayload,
});
export type ProviderRuntimeThreadRealtimeClosedEvent =
  typeof ProviderRuntimeThreadRealtimeClosedEvent.Type;

const ProviderRuntimeTurnStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnStartedType,
  payload: TurnStartedPayload,
});
export type ProviderRuntimeTurnStartedEvent = typeof ProviderRuntimeTurnStartedEvent.Type;

const ProviderRuntimeTurnCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnCompletedType,
  payload: TurnCompletedPayload,
});
export type ProviderRuntimeTurnCompletedEvent = typeof ProviderRuntimeTurnCompletedEvent.Type;

const ProviderRuntimeTurnAbortedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnAbortedType,
  payload: TurnAbortedPayload,
});
export type ProviderRuntimeTurnAbortedEvent = typeof ProviderRuntimeTurnAbortedEvent.Type;

const ProviderRuntimeTurnTasksUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnTasksUpdatedType,
  payload: TurnTasksUpdatedPayload,
});
export type ProviderRuntimeTurnTasksUpdatedEvent = typeof ProviderRuntimeTurnTasksUpdatedEvent.Type;

const ProviderRuntimeTurnProposedDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedDeltaType,
  payload: TurnProposedDeltaPayload,
});
export type ProviderRuntimeTurnProposedDeltaEvent =
  typeof ProviderRuntimeTurnProposedDeltaEvent.Type;

const ProviderRuntimeTurnProposedCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedCompletedType,
  payload: TurnProposedCompletedPayload,
});
export type ProviderRuntimeTurnProposedCompletedEvent =
  typeof ProviderRuntimeTurnProposedCompletedEvent.Type;

const ProviderRuntimeTurnDiffUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnDiffUpdatedType,
  payload: TurnDiffUpdatedPayload,
});
export type ProviderRuntimeTurnDiffUpdatedEvent = typeof ProviderRuntimeTurnDiffUpdatedEvent.Type;

const ProviderRuntimeTurnSteeredEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnSteeredType,
  payload: TurnSteeredPayload,
});
export type ProviderRuntimeTurnSteeredEvent = typeof ProviderRuntimeTurnSteeredEvent.Type;

const ProviderRuntimeItemStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemStartedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemStartedEvent = typeof ProviderRuntimeItemStartedEvent.Type;

const ProviderRuntimeItemUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemUpdatedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemUpdatedEvent = typeof ProviderRuntimeItemUpdatedEvent.Type;

const ProviderRuntimeItemCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemCompletedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemCompletedEvent = typeof ProviderRuntimeItemCompletedEvent.Type;

const ProviderRuntimeContentDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ContentDeltaType,
  payload: ContentDeltaPayload,
});
export type ProviderRuntimeContentDeltaEvent = typeof ProviderRuntimeContentDeltaEvent.Type;

const ProviderRuntimeRequestOpenedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestOpenedType,
  payload: RequestOpenedPayload,
});
export type ProviderRuntimeRequestOpenedEvent = typeof ProviderRuntimeRequestOpenedEvent.Type;

const ProviderRuntimeRequestResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestResolvedType,
  payload: RequestResolvedPayload,
});
export type ProviderRuntimeRequestResolvedEvent = typeof ProviderRuntimeRequestResolvedEvent.Type;

const ProviderRuntimeUserInputRequestedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputRequestedType,
  payload: UserInputRequestedPayload,
});
export type ProviderRuntimeUserInputRequestedEvent =
  typeof ProviderRuntimeUserInputRequestedEvent.Type;

const ProviderRuntimeUserInputResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputResolvedType,
  payload: UserInputResolvedPayload,
});
export type ProviderRuntimeUserInputResolvedEvent =
  typeof ProviderRuntimeUserInputResolvedEvent.Type;

const ProviderRuntimeTaskStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskStartedType,
  payload: TaskStartedPayload,
});
export type ProviderRuntimeTaskStartedEvent = typeof ProviderRuntimeTaskStartedEvent.Type;

const ProviderRuntimeTaskProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskProgressType,
  payload: TaskProgressPayload,
});
export type ProviderRuntimeTaskProgressEvent = typeof ProviderRuntimeTaskProgressEvent.Type;

const ProviderRuntimeTaskUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskUpdatedType,
  payload: TaskUpdatedPayload,
});
export type ProviderRuntimeTaskUpdatedEvent = typeof ProviderRuntimeTaskUpdatedEvent.Type;

const ProviderRuntimeTaskCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskCompletedType,
  payload: TaskCompletedPayload,
});
export type ProviderRuntimeTaskCompletedEvent = typeof ProviderRuntimeTaskCompletedEvent.Type;

const ProviderRuntimeHookStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookStartedType,
  payload: HookStartedPayload,
});
export type ProviderRuntimeHookStartedEvent = typeof ProviderRuntimeHookStartedEvent.Type;

const ProviderRuntimeHookProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookProgressType,
  payload: HookProgressPayload,
});
export type ProviderRuntimeHookProgressEvent = typeof ProviderRuntimeHookProgressEvent.Type;

const ProviderRuntimeHookCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookCompletedType,
  payload: HookCompletedPayload,
});
export type ProviderRuntimeHookCompletedEvent = typeof ProviderRuntimeHookCompletedEvent.Type;

const ProviderRuntimeToolProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolProgressType,
  payload: ToolProgressPayload,
});
export type ProviderRuntimeToolProgressEvent = typeof ProviderRuntimeToolProgressEvent.Type;

const ProviderRuntimeToolSummaryEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolSummaryType,
  payload: ToolSummaryPayload,
});
export type ProviderRuntimeToolSummaryEvent = typeof ProviderRuntimeToolSummaryEvent.Type;

const ProviderRuntimeAuthStatusEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AuthStatusType,
  payload: AuthStatusPayload,
});
export type ProviderRuntimeAuthStatusEvent = typeof ProviderRuntimeAuthStatusEvent.Type;

const ProviderRuntimeAccountUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AccountUpdatedType,
  payload: AccountUpdatedPayload,
});
export type ProviderRuntimeAccountUpdatedEvent = typeof ProviderRuntimeAccountUpdatedEvent.Type;

const ProviderRuntimeAccountRateLimitsUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AccountRateLimitsUpdatedType,
  payload: AccountRateLimitsUpdatedPayload,
});
export type ProviderRuntimeAccountRateLimitsUpdatedEvent =
  typeof ProviderRuntimeAccountRateLimitsUpdatedEvent.Type;

const ProviderRuntimeMcpStatusUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: McpStatusUpdatedType,
  payload: McpStatusUpdatedPayload,
});
export type ProviderRuntimeMcpStatusUpdatedEvent = typeof ProviderRuntimeMcpStatusUpdatedEvent.Type;

const ProviderRuntimeMcpOauthCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: McpOauthCompletedType,
  payload: McpOauthCompletedPayload,
});
export type ProviderRuntimeMcpOauthCompletedEvent =
  typeof ProviderRuntimeMcpOauthCompletedEvent.Type;

const ProviderRuntimeModelReroutedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ModelReroutedType,
  payload: ModelReroutedPayload,
});
export type ProviderRuntimeModelReroutedEvent = typeof ProviderRuntimeModelReroutedEvent.Type;

const ProviderRuntimeConfigWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ConfigWarningType,
  payload: ConfigWarningPayload,
});
export type ProviderRuntimeConfigWarningEvent = typeof ProviderRuntimeConfigWarningEvent.Type;

const ProviderRuntimeDeprecationNoticeEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: DeprecationNoticeType,
  payload: DeprecationNoticePayload,
});
export type ProviderRuntimeDeprecationNoticeEvent =
  typeof ProviderRuntimeDeprecationNoticeEvent.Type;

const ProviderRuntimeFilesPersistedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: FilesPersistedType,
  payload: FilesPersistedPayload,
});
export type ProviderRuntimeFilesPersistedEvent = typeof ProviderRuntimeFilesPersistedEvent.Type;

const ProviderRuntimeVcsStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: VcsStateChangedType,
  payload: VcsStateChangedPayload,
});
export type ProviderRuntimeVcsStateChangedEvent = typeof ProviderRuntimeVcsStateChangedEvent.Type;

const ProviderRuntimeWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeWarningType,
  payload: RuntimeWarningPayload,
});
export type ProviderRuntimeWarningEvent = typeof ProviderRuntimeWarningEvent.Type;

const ProviderRuntimeEventUnmappedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: EventUnmappedType,
  payload: EventUnmappedPayload,
});
export type ProviderRuntimeEventUnmappedEvent = typeof ProviderRuntimeEventUnmappedEvent.Type;

const ProviderRuntimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeErrorType,
  payload: RuntimeErrorPayload,
});
export type ProviderRuntimeErrorEvent = typeof ProviderRuntimeErrorEvent.Type;

export const ProviderRuntimeEventV2 = Schema.Union([
  ProviderRuntimeSessionStartedEvent,
  ProviderRuntimeSessionConfiguredEvent,
  ProviderRuntimeSessionStateChangedEvent,
  ProviderRuntimeSessionExitedEvent,
  ProviderRuntimeThreadStartedEvent,
  ProviderRuntimeThreadStateChangedEvent,
  ProviderRuntimeThreadMetadataUpdatedEvent,
  ProviderRuntimeThreadTokenUsageUpdatedEvent,
  ProviderRuntimeThreadRealtimeStartedEvent,
  ProviderRuntimeThreadRealtimeItemAddedEvent,
  ProviderRuntimeThreadRealtimeAudioDeltaEvent,
  ProviderRuntimeThreadRealtimeErrorEvent,
  ProviderRuntimeThreadRealtimeClosedEvent,
  ProviderRuntimeTurnStartedEvent,
  ProviderRuntimeTurnCompletedEvent,
  ProviderRuntimeTurnAbortedEvent,
  ProviderRuntimeTurnTasksUpdatedEvent,
  ProviderRuntimeTurnProposedDeltaEvent,
  ProviderRuntimeTurnProposedCompletedEvent,
  ProviderRuntimeTurnDiffUpdatedEvent,
  ProviderRuntimeTurnSteeredEvent,
  ProviderRuntimeItemStartedEvent,
  ProviderRuntimeItemUpdatedEvent,
  ProviderRuntimeItemCompletedEvent,
  ProviderRuntimeContentDeltaEvent,
  ProviderRuntimeRequestOpenedEvent,
  ProviderRuntimeRequestResolvedEvent,
  ProviderRuntimeUserInputRequestedEvent,
  ProviderRuntimeUserInputResolvedEvent,
  ProviderRuntimeTaskStartedEvent,
  ProviderRuntimeTaskProgressEvent,
  ProviderRuntimeTaskUpdatedEvent,
  ProviderRuntimeTaskCompletedEvent,
  ProviderRuntimeHookStartedEvent,
  ProviderRuntimeHookProgressEvent,
  ProviderRuntimeHookCompletedEvent,
  ProviderRuntimeToolProgressEvent,
  ProviderRuntimeToolSummaryEvent,
  ProviderRuntimeAuthStatusEvent,
  ProviderRuntimeAccountUpdatedEvent,
  ProviderRuntimeAccountRateLimitsUpdatedEvent,
  ProviderRuntimeMcpStatusUpdatedEvent,
  ProviderRuntimeMcpOauthCompletedEvent,
  ProviderRuntimeModelReroutedEvent,
  ProviderRuntimeConfigWarningEvent,
  ProviderRuntimeDeprecationNoticeEvent,
  ProviderRuntimeFilesPersistedEvent,
  ProviderRuntimeVcsStateChangedEvent,
  ProviderRuntimeWarningEvent,
  ProviderRuntimeErrorEvent,
  ProviderRuntimeEventUnmappedEvent,
]);
export type ProviderRuntimeEventV2 = typeof ProviderRuntimeEventV2.Type;

export const ProviderRuntimeEvent = ProviderRuntimeEventV2;
export type ProviderRuntimeEvent = ProviderRuntimeEventV2;

// Compatibility aliases for call sites still importing legacy names.
const ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
export type ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
const ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
export type ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
const ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
export type ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
const ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;
export type ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;

// Legacy helper aliases retained for adapters/tests.
const ProviderRuntimeToolKind = Schema.Literals(["command", "file-read", "file-change", "other"]);
export type ProviderRuntimeToolKind = typeof ProviderRuntimeToolKind.Type;

export const ProviderRuntimeTurnStatus = RuntimeTurnState;
export type ProviderRuntimeTurnStatus = RuntimeTurnState;
