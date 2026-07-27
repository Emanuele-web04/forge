/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import { spawn as spawnChildProcess } from "node:child_process";
import type {
  AgentInfo,
  CanUseTool,
  AgentDefinition,
  HookInput,
  HookJSONOutput,
  Options as ClaudeQueryOptions,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKResultMessage,
  SDKControlGetContextUsageResponse,
  Settings,
  SettingSource,
  SDKUserMessage,
  SlashCommand,
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type ClaudeApiEffort,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  type RuntimeSessionState,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
  type ProviderComposerCapabilities,
  type ProviderListCommandsInput,
  type ProviderListCommandsResult,
  type ProviderListSkillsInput,
  type ProviderListSkillsResult,
  type ProviderListAgentsResult,
  type ProviderListModelsResult,
  getAgentMentionAliases,
} from "@synara/contracts";
import {
  applyClaudePromptEffortPrefix,
  getDefaultModel,
  getEffectiveClaudeCodeEffort,
  getModelCapabilities,
  hasEffortLevel,
  resolveApiModelId,
  trimOrNull,
} from "@synara/shared/model";
import { buildClaudeSubagentPrompt } from "@synara/shared/agentMentions";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Queue,
  Random,
  Ref,
  Semaphore,
  Stream,
} from "effect";

import { buildClaudeMcpServers } from "../../agentGateway/mcpInjection.ts";
import { renderSynaraHarnessPolicy } from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  acquireAgentGatewaySessionLease,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { resolveProviderAttachmentPath } from "../providerAttachmentPaths.ts";
import { ServerConfig } from "../../config.ts";
import { buildFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadClaudeAgentSdk } from "../claudeAgentSdk.ts";
import { buildClaudeProcessEnv } from "../claudeProcessEnv.ts";
import {
  CLAUDE_CONTEXT_WINDOW_MAX_TOKENS,
  decideClaudeContextUsageWarnings,
  maxClaudeContextWindowFromModelUsage,
  mergeClaudeTokenUsageSnapshot,
  normalizeClaudeTokenUsage,
  resolveClaudeApiModelIdContextWindowMaxTokens,
  resolveClaudeEffectiveContextBudget,
  resolveEffectiveClaudeContextWindow,
  resolveSelectedClaudeAutoCompactWindow,
  snapshotFromClaudeContextUsage,
  stripClaudeContextWindowSuffix,
} from "../claudeTokenUsage.ts";
import {
  applyClaudeTaskToolResult,
  claudeTrackedTasksPayload,
  hasOnlyCompletedClaudeTasks,
  hasUnfinishedClaudeTasks,
  normalizeClaudeTodoTasks,
  parseClaudeTrackedTasks,
  type ClaudeTrackedTask,
} from "../claudeTaskTracker.ts";
import {
  extractClaudeWorkflowAgentPhases,
  extractClaudeWorkflowAgentPlans,
  parseClaudeWorkflowLaunch,
  parseClaudeWorkflowLaunchFromText,
  parseClaudeWorkflowProgressAgents,
  parseClaudeWorkflowScriptMeta,
} from "../claudeWorkflowScript.ts";
import {
  claudeWorkflowRuntimeSnapshots,
  collectClaudeWorkflowRuntime,
  makeClaudeWorkflowRuntimeState,
  readClaudeWorkflowOutputText,
  type ClaudeWorkflowRuntimeState,
} from "../claudeWorkflowRuntime.ts";
import { positiveFiniteNumber } from "../tokenUsage.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { extractProposedPlanMarkdown, withProviderPlanModePrompt } from "../planMode.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  teardownChildProcessTree,
  teardownProviderProcessTree,
  type ProcessExitHandle,
} from "../supervisedProcessTeardown.ts";

const PROVIDER = "claudeAgent" as const;
const CLAUDE_COMMAND_DISCOVERY_THREAD_ID = ThreadId.makeUnsafe("claude:command-discovery");
type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
  readonly trackedTasks?: ReadonlyArray<ClaudeTrackedTask>;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly interactionMode: "default" | "plan";
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  readonly sawFileChange: boolean;
  nextSyntheticAssistantBlockIndex: number;
  // Offset into assistantTextBlockOrder where the current assistant API
  // message's blocks begin. A turn spans many API messages (tool-use round
  // trips; a subagent's whole conversation shares one synthetic turn), while
  // snapshot backfill aligns by position within a single message.
  assistantMessageBlockBase: number;
}

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

function coerceClaudeAnswerValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  return "";
}

// Claude's AskUserQuestion SDK expects answers keyed by question text; the web UI submits stable ids.
function remapAnswersToClaudeQuestionText(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, string> {
  const remapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    remapped[key] = coerceClaudeAnswerValue(value);
  }

  for (const question of questions) {
    if (Object.hasOwn(remapped, question.question)) {
      continue;
    }

    if (Object.hasOwn(remapped, question.id)) {
      remapped[question.question] = remapped[question.id]!;
      delete remapped[question.id];
    }
  }

  return remapped;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

// One live Task tool spawn. Subagent SDK traffic is keyed by the Task tool_use_id
// (parent_tool_use_id on forwarded messages); the task_id arrives later via
// task_started and is what query.stopTask needs.
interface ClaudeSubagentRun {
  readonly toolUseId: string;
  taskId: string | undefined;
  readonly context: ClaudeSessionContext;
}

interface ClaudeSessionContext {
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  session: ProviderSession;
  readonly lifecycleGeneration?: string;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  readonly processOwner: ClaudeProcessOwner;
  stopDeferred?: Deferred.Deferred<void, ProviderAdapterProcessError>;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  // The mode the CLI provably spawned in (from queryOptions, or the SDK's
  // "default" when omitted). This is the ONLY permission mode we can prove the
  // running CLI is in: `canUseTool` is shadowed under bypassPermissions, so once
  // any prompt has run the CLI's mode is opaque (a future SDK adding a
  // mode-changing tool like EnterPlanMode would silently diverge from anything
  // we tracked). We therefore only skip the redundant first-turn
  // `setPermissionMode` while this spawn state is still authoritative.
  readonly spawnPermissionMode: PermissionMode;
  // True until the first prompt of the session has been dispatched. While true,
  // the CLI is provably still in `spawnPermissionMode`; once cleared we can no
  // longer prove the CLI's mode, so every turn re-sends `setPermissionMode`
  // unconditionally.
  firstTurnSpawnModeAuthoritative: boolean;
  lastInteractionMode: "default" | "plan" | undefined;
  currentApiModelId: string | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  readonly trackedTasks: Map<string, ClaudeTrackedTask>;
  turnState: ClaudeTurnState | undefined;
  // Survives `turnState` being cleared so a terminal result that arrives with no
  // live turn still names the turn it settles. An id-less `turn.completed` is
  // dropped by runtime ingestion and leaves the projection running forever.
  lastTurnId: TurnId | undefined;
  interruptRequestedTurnId: TurnId | undefined;
  lastKnownContextWindow: number | undefined;
  currentAutoCompactWindow: number | undefined;
  currentAlwaysThinkingEnabled: boolean | undefined;
  currentEffort: ClaudeApiEffort | null;
  currentUltracode: boolean;
  currentFastMode: boolean;
  lastKnownAutoCompactThreshold: number | undefined;
  contextUsageControlEnabled: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  // Original API model id the runtime rerouted away from (safeguard refusal
  // fallback). Tracks the in-flight turn only; turn completion restores the
  // user-selected model via setModel so the fallback cannot pin later turns.
  rerouteOriginalApiModelId: string | undefined;
  // Context-size warnings already emitted for this session (once per threshold).
  readonly emittedContextUsageWarnings: Set<string>;
  stopped: boolean;
  // Unrecognized SDK message kinds already surfaced as a runtime warning. Newer
  // Claude SDKs stream high-frequency telemetry (e.g. `thinking_tokens`); de-duping
  // here keeps a single unknown kind from flooding the conversation timeline.
  readonly warnedUnhandledSdkKinds: Set<string>;
  // Live Task tool spawns keyed by tool_use_id. Each run owns a scoped context
  // whose events carry `subagentRefs`, so ingestion routes them to the child thread.
  readonly subagentRuns: Map<string, ClaudeSubagentRun>;
  // Mid-task user messages queued per subagent tool_use_id, drained by the
  // PreToolUse hook on the subagent's next tool call.
  readonly pendingSubagentSteers: Map<string, Array<string>>;
  // Stop requests that arrived before task_started mapped the tool_use_id to an
  // SDK task id; fired via query.stopTask the moment the mapping lands.
  readonly pendingSubagentStops: Set<string>;
  // Last background-task ids from background_tasks_changed (REPLACE
  // semantics); diffed so only newly backgrounded work gets announced.
  readonly knownBackgroundTaskIds: Set<string>;
  // Final status per tool-use id whose task already settled (terminal
  // task_updated or task_notification). Late messages still tagged with them
  // must not resurrect a scoped run: the synthetic turn that would start on
  // the settled child thread never completes and pins the strip row on
  // "Running". The status also corrects the Task tool_result's error shape
  // (a user stop returns an error result that would otherwise read "Failed").
  readonly settledSubagentToolUseIds: Map<string, "completed" | "failed" | "stopped">;
  // Live workflow runs (task_type "local_workflow") by task id. The SDK carries no
  // parent-task linkage, so agent tasks that start while exactly one workflow is
  // live get tagged with it (recorded in workflowTaskIdByMemberTaskId); with
  // concurrent workflows membership is ambiguous and stays untagged.
  readonly liveWorkflowTaskIds: Set<string>;
  // Workflow identity survives a terminal task_updated until task_notification
  // supplies the authoritative final output file.
  readonly knownWorkflowTaskIds: Set<string>;
  readonly workflowTaskIdByMemberTaskId: Map<string, string>;
  // Live transcript-directory pollers per workflow task id, plus the agent
  // labels seen so far (first-seen order from "<phase>: <label>" progress
  // descriptions) that the poller zips against journal start order.
  readonly workflowRuntimePollers: Map<string, Fiber.Fiber<void>>;
  readonly workflowAgentLabels: Map<string, Array<string>>;
  // Poller state per workflow task id, kept reachable so settle can backfill
  // runtime-only fields (effort) into the final output-file snapshots.
  readonly workflowRuntimeStates: Map<string, ClaudeWorkflowRuntimeState>;
  // Set on subagent-scoped contexts only: stamps providerThreadId (the Task
  // tool_use_id) + providerParentThreadId on every runtime event this context emits.
  readonly subagentRefs?: {
    readonly providerThreadId: string;
    readonly providerParentThreadId: string;
  };
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly stopTask: (taskId: string) => Promise<void>;
  readonly backgroundTasks: (toolUseId?: string) => Promise<boolean>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly applyFlagSettings: (settings: {
    [K in keyof Settings]?: Settings[K] | null;
  }) => Promise<void>;
  readonly getContextUsage: () => Promise<SDKControlGetContextUsageResponse>;
  readonly supportedCommands: () => Promise<SlashCommand[]>;
  readonly supportedModels: () => Promise<ModelInfo[]>;
  readonly supportedAgents: () => Promise<AgentInfo[]>;
  readonly close: () => void;
}

export type ClaudeOwnedProcess = ClaudeSpawnedProcess & ProcessExitHandle;

interface ClaudeProcessOwner {
  process?: ClaudeOwnedProcess;
}

function spawnOwnedClaudeCodeProcess(options: ClaudeSpawnOptions): ClaudeOwnedProcess {
  const prepared = prepareWindowsSafeProcess(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
  });
  return spawnChildProcess(prepared.command, prepared.args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    signal: options.signal,
    shell: prepared.shell,
    ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  }) as unknown as ClaudeOwnedProcess;
}

export interface ClaudeAdapterLiveOptions {
  // Async because the default implementation lazily imports the Claude Agent
  // SDK; test doubles may still return a runtime synchronously.
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime | Promise<ClaudeQueryRuntime>;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  // Interval for polling a live workflow's transcript directory. Tests shrink it.
  readonly workflowRuntimePollIntervalMs?: number;
  readonly spawnClaudeCodeProcess?: (options: ClaudeSpawnOptions) => ClaudeOwnedProcess;
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
}

function mapSupportedCommands(commands: SlashCommand[]): ProviderListCommandsResult {
  return {
    commands: commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description || undefined,
    })),
    source: "claudeAgent",
    cached: false,
  };
}

function neverResolvingUserMessageStream(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next: async () => new Promise<IteratorResult<SDKUserMessage>>(() => {}),
      };
    },
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

// Claude hook system messages can carry transient session ids; only durable
// conversation messages should advance the resumable provider cursor.
function hasDurableClaudeSessionId(message: SDKMessage): boolean {
  if (message.type !== "system") {
    return true;
  }

  return (
    message.subtype !== "hook_started" &&
    message.subtype !== "hook_progress" &&
    message.subtype !== "hook_response"
  );
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

// SIGINT (130) and SIGTERM (143) are graceful stop requests, not crashes. When the
// Claude subprocess receives one from outside our own stop path (an idle reaper, the
// OS, or a parent process tearing the process group down), the SDK stream throws
// "Claude Code process exited with code 143". Treat that as a suspend-and-resume,
// not a hard failure with an error toast. SIGKILL (137) is intentionally excluded:
// it usually signals an OOM/forced kill that is worth surfacing.
const CLAUDE_BENIGN_TERMINATION_EXIT_CODES = new Set([130, 143]);

const CLAUDE_BENIGN_TERMINATION_MESSAGE =
  "Claude runtime stopped and will resume on your next message.";

function isClaudeBenignTerminationMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  const exitCode = normalized.match(/exited with code (\d+)/)?.[1];
  if (exitCode !== undefined) {
    return CLAUDE_BENIGN_TERMINATION_EXIT_CODES.has(Number.parseInt(exitCode, 10));
  }
  return normalized.includes("signal sigterm") || normalized.includes("signal sigint");
}

function isClaudeBenignTerminationCause(cause: Cause.Cause<Error>): boolean {
  return normalizeClaudeStreamMessages(cause).some(isClaudeBenignTerminationMessage);
}

function isClaudeMissingResumeConversationCause(cause: Cause.Cause<Error>): boolean {
  return normalizeClaudeStreamMessages(cause).some((message) =>
    message.toLowerCase().includes("no conversation found with session id"),
  );
}

function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

function hasPendingUserInterrupt(context: ClaudeSessionContext): boolean {
  const activeTurnId = context.turnState?.turnId;
  return activeTurnId !== undefined && context.interruptRequestedTurnId === activeTurnId;
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function claudeEffectiveContextBudget(context: ClaudeSessionContext): number | undefined {
  return resolveClaudeEffectiveContextBudget(
    context.lastKnownAutoCompactThreshold,
    context.currentAutoCompactWindow,
    context.lastKnownContextWindow,
  );
}

// Safeguard reroutes (e.g. Fable 5 refusal -> Opus fallback) stream as an
// untyped system message; match it structurally so SDK type drift stays inert.
interface ClaudeModelRefusalFallback {
  readonly originalModel: string;
  readonly fallbackModel: string;
  readonly content?: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readClaudeModelRefusalFallback(message: unknown): ClaudeModelRefusalFallback | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as {
    type?: unknown;
    subtype?: unknown;
    original_model?: unknown;
    fallback_model?: unknown;
    originalModel?: unknown;
    fallbackModel?: unknown;
    content?: unknown;
  };
  if (record.type !== "system" || record.subtype !== "model_refusal_fallback") {
    return undefined;
  }
  // Claude Agent SDK 0.3.x emits snake_case fields. Accept camelCase too so a
  // future typed SDK projection cannot silently disable reroute protection.
  const originalModel =
    readNonEmptyString(record.original_model) ?? readNonEmptyString(record.originalModel);
  const fallbackModel =
    readNonEmptyString(record.fallback_model) ?? readNonEmptyString(record.fallbackModel);
  if (!originalModel || !fallbackModel) {
    return undefined;
  }
  return {
    originalModel,
    fallbackModel,
    ...(typeof record.content === "string" && record.content.trim().length > 0
      ? { content: record.content }
      : {}),
  };
}

const DEFAULT_WORKFLOW_RUNTIME_POLL_INTERVAL_MS = 2_000;
// Synthetic description for poller-emitted task.progress events; consumers key
// off payload.workflowAgents, not this text.
const WORKFLOW_AGENTS_PROGRESS_DESCRIPTION = "Workflow agents";

function resolveSelectedClaudeThinkingToggle(
  model: string | null | undefined,
  selectedThinking: boolean | null | undefined,
): boolean | undefined {
  if (typeof selectedThinking !== "boolean") {
    return undefined;
  }
  return getModelCapabilities("claudeAgent", model).supportsThinkingToggle
    ? selectedThinking
    : undefined;
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function toPermissionMode(value: unknown): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
      return value;
    default:
      return undefined;
  }
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
    trackedTasks?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;
  const trackedTasks = parseClaudeTrackedTasks(cursor.trackedTasks);

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
    ...(trackedTasks.length > 0 ? { trackedTasks } : {}),
  };
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized === "todowrite" ||
    normalized.includes("todo") ||
    normalized === "taskcreate" ||
    normalized === "taskupdate" ||
    normalized === "taskget" ||
    normalized === "tasklist"
  ) {
    return "plan";
  }
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

// Tools whose result is surfaced through a dedicated runtime channel — AskUserQuestion
// via the user-input request flow, ExitPlanMode via the proposed-plan flow — must NOT
// also emit a generic tool-call lifecycle item, or the timeline shows a redundant
// "ToolName: {json}" row alongside the real interaction surface.
function isClientSurfacedClaudeTool(toolName: string): boolean {
  return toolName === "AskUserQuestion" || toolName === "ExitPlanMode";
}

// Stable per-call identity stamped on every tool lifecycle event's data so the client
// can collapse started/updated/completed (and dedupe parallel calls) by tool-call id
// instead of relying on row adjacency. Mirrors the shape other adapters emit (Pi/Grok).
function toolLifecycleEventData(
  tool: Pick<ToolInFlight, "itemId" | "toolName" | "input">,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    toolCallId: tool.itemId,
    callId: tool.itemId,
    toolName: tool.toolName,
    input: tool.input,
    ...(tool.toolName === "Task" || tool.toolName === "Agent" ? subagentReceiverData(tool) : {}),
    ...extra,
  };
}

// Receiver identity for the shared subagent-thread machinery: ingestion spawns a
// child thread per receiverThreadId on collab_agent_tool_call items and titles it
// from these hints (see extractSubagentIdentityHints in @synara/shared/subagents).
function subagentReceiverData(
  tool: Pick<ToolInFlight, "itemId" | "input">,
): Record<string, unknown> {
  const {
    subagent_type: subagentType,
    description,
    prompt,
    model,
    run_in_background: runInBackground,
  } = tool.input;
  const effort =
    typeof subagentType === "string" ? claudeWorkerEffortFromSubagentType(subagentType) : undefined;
  return {
    receiverThreadId: tool.itemId,
    ...(typeof subagentType === "string" ? { agentType: subagentType } : {}),
    ...(typeof description === "string" ? { nickname: description } : {}),
    ...(typeof prompt === "string" ? { prompt } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(runInBackground === true ? { background: true } : {}),
  };
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "plan":
      return "Plan";
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;
const CLAUDE_CONTEXT_USAGE_TIMEOUT_MS = 1_000;
// The SDK's interrupt resolves only once the CLI acknowledges it; a wedged CLI
// would otherwise stall the caller (and the provider command reactor) forever.
const CLAUDE_INTERRUPT_TIMEOUT = Duration.seconds(10);
export const buildEmbeddedClaudeSystemPromptAppend = (gatewayControlAvailable: boolean) =>
  [
    "You are running inside Synara, a coding app that embeds the Claude Agent SDK.",
    "Do not present the host app as Claude Code unless the user is explicitly asking about Claude Code.",
    "Treat the current working directory as the active workspace for the task.",
    "When the user asks about the current project, codebase, or repository, proactively inspect files in the current working directory before asking the user where to look.",
    "When spawning subagents, set the Agent tool's `model` parameter and pick reasoning effort by choosing a worker-<tier> subagent type (worker-low, worker-medium, worker-high, worker-xhigh).",
    "Honor explicit user instructions about a subagent's model or effort verbatim; otherwise match task complexity: mechanical work → haiku or worker-low, standard work → sonnet or worker-medium, hard reasoning → opus or fable with worker-high and above.",
    renderSynaraHarnessPolicy({ gatewayControlAvailable }),
  ].join("\n");

const CLAUDE_WORKER_EFFORT_TIERS = ["low", "medium", "high", "xhigh"] as const;
const CLAUDE_WORKER_PROMPT =
  "You are a general-purpose worker agent. Complete the assigned task end to end with the available tools, then return a concise report covering what you did, key findings, and any remaining risks.";

function claudeWorkerEffortFromSubagentType(subagentType: string): string | undefined {
  return (CLAUDE_WORKER_EFFORT_TIERS as readonly string[]).find(
    (tier) => subagentType === `worker-${tier}`,
  );
}

function claudeSubagentSteerContext(message: string): string {
  return `The user sent you a message mid-task: ${message}. Address it and adjust your work accordingly.`;
}

function buildClaudeSdkSubagents(): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};

  for (const alias of getAgentMentionAliases("claudeAgent")) {
    if (alias.kind !== "claude-subagent" || agents[alias.agentName]) {
      continue;
    }

    agents[alias.agentName] = {
      description: alias.description,
      prompt: alias.prompt,
      ...(alias.tools ? { tools: [...alias.tools] } : {}),
      ...(alias.disallowedTools ? { disallowedTools: [...alias.disallowedTools] } : {}),
      ...(alias.model ? { model: alias.model } : {}),
    };
  }

  // Effort-tier worker variants: the Agent tool input has a `model` param but no
  // effort param, so effort is selected by picking the matching worker type.
  // Model stays unset (inherit) so the tool's `model` input composes with it.
  for (const tier of CLAUDE_WORKER_EFFORT_TIERS) {
    const agentName = `worker-${tier}`;
    if (agents[agentName]) {
      continue;
    }
    agents[agentName] = {
      description: `General-purpose worker at ${tier} reasoning effort; choose per task complexity`,
      prompt: CLAUDE_WORKER_PROMPT,
      effort: tier,
    };
  }

  return agents;
}

function buildPromptText(input: ProviderSendTurnInput): string {
  const basePrompt = buildClaudeSubagentPrompt(input.input?.trim() ?? "").prompt;
  const rawEffort =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.options?.effort : null;
  const requestedEffort = trimOrNull(rawEffort);
  const claudeModel =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.model : undefined;
  const caps = getModelCapabilities("claudeAgent", claudeModel);
  const promptEffort =
    requestedEffort === "ultrathink" && caps.promptInjectedEffortLevels.includes("ultrathink")
      ? "ultrathink"
      : requestedEffort && hasEffortLevel(caps, requestedEffort)
        ? requestedEffort
        : null;
  return withProviderPlanModePrompt({
    text: applyClaudePromptEffortPrefix(basePrompt, promptEffort),
    interactionMode: input.interactionMode,
  });
}

function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent,
    },
  } as unknown as SDKUserMessage;
}

function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

function buildUserMessageEffect(
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
): Effect.Effect<SDKUserMessage, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const text = buildPromptText(input);
    const sdkContent: Array<Record<string, unknown>> = [];

    if (text.length > 0) {
      sdkContent.push({ type: "text", text });
    }

    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }

      if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType.toLowerCase())) {
        continue;
      }

      const attachmentPath = resolveProviderAttachmentPath({
        attachmentsDir: dependencies.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }

      const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: toMessage(cause, "Failed to read attachment file."),
              cause,
            }),
        ),
      );

      sdkContent.push(
        buildClaudeImageContentBlock({
          mimeType: attachment.mimeType.toLowerCase(),
          bytes,
        }),
      );
    }

    const fileBlock = buildFileAttachmentsPromptBlock({
      attachments: input.attachments,
      attachmentsDir: dependencies.attachmentsDir,
      include: "all-files",
      includeImage: (attachment) =>
        !SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType.toLowerCase()),
    });
    if (fileBlock) {
      sdkContent.push({ type: "text", text: fileBlock });
    }

    return buildUserMessage({ sdkContent });
  });
}

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function nativeProviderRefs(
  context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  return {
    ...context.subagentRefs,
    ...(options?.providerItemId
      ? { providerItemId: ProviderItemId.makeUnsafe(options.providerItemId) }
      : {}),
  };
}

function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    const sanitizedText =
      candidate.type === "text" && typeof candidate.text === "string"
        ? sanitizeClaudeDisplayText(candidate.text)
        : "";
    if (candidate.type === "text" && sanitizedText.length > 0) {
      fragments.push(sanitizedText);
    }
  }

  return fragments;
}

function sanitizeClaudeDisplayText(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const lines = text.split(/\r?\n/);
  const filteredLines = lines.filter((line) => {
    const normalized = line.trim().toLowerCase();
    return !(
      normalized.startsWith("[ede_diagnostic]") &&
      normalized.includes("result_type=") &&
      normalized.includes("stop_reason=")
    );
  });

  if (
    filteredLines.length === 0 &&
    lines.some((line) => line.trim().toLowerCase().startsWith("[ede_diagnostic]"))
  ) {
    return "";
  }

  return filteredLines.join("\n");
}

function normalizeClaudeUserVisibleErrorMessage(
  text: string | undefined,
  status: ProviderRuntimeTurnStatus,
): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }

  const sanitized = sanitizeClaudeDisplayText(text).trim();
  if (sanitized.length === 0) {
    return undefined;
  }

  if (sanitized === "User interrupted response.") {
    return status === "interrupted" ? "Claude runtime interrupted." : undefined;
  }

  if (/^[\]})"'`.,;:!?_-]+$/.test(sanitized)) {
    return status === "interrupted" ? "Claude runtime interrupted." : "Claude turn failed.";
  }

  return sanitized;
}

function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string"
    ? sanitizeClaudeDisplayText(candidate.text)
    : "";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return sanitizeClaudeDisplayText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return sanitizeClaudeDisplayText(record.text);
  }

  return extractTextContent(record.content);
}

function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

function toolResultStreamKind(itemType: CanonicalItemType): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
  readonly structuredResult: unknown;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
    readonly structuredResult: unknown;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
      structuredResult: message.tool_use_result,
    });
  }

  return blocks;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

function parentToolUseId(message: SDKMessage): string | undefined {
  if (
    message.type !== "assistant" &&
    message.type !== "user" &&
    message.type !== "stream_event" &&
    message.type !== "tool_progress"
  ) {
    return undefined;
  }
  return typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.length > 0
    ? message.parent_tool_use_id
    : undefined;
}

function isRecognizedSubagentToolUseId(context: ClaudeSessionContext, toolUseId: string): boolean {
  if (context.subagentRuns.has(toolUseId) || context.settledSubagentToolUseIds.has(toolUseId)) {
    return true;
  }
  for (const tool of context.inFlightTools.values()) {
    if (tool.itemId === toolUseId && tool.itemType === "collab_agent_tool_call") {
      return true;
    }
  }
  return false;
}

function recognizedSubagentParentToolUseId(
  context: ClaudeSessionContext,
  message: SDKMessage,
): string | undefined {
  const toolUseId = parentToolUseId(message);
  return toolUseId && isRecognizedSubagentToolUseId(context, toolUseId) ? toolUseId : undefined;
}

function claudeTaskTurnStatus(
  status: "completed" | "failed" | "stopped",
): ProviderRuntimeTurnStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "interrupted";
  }
}

function runtimeSessionStateFromClaudeTaskStatus(
  status: string | undefined,
): RuntimeSessionState | undefined {
  switch (status) {
    case "pending":
      return "starting";
    case "running":
      return "running";
    case "paused":
      return "waiting";
    case "completed":
      return "ready";
    case "failed":
      return "error";
    case "killed":
      return "stopped";
    default:
      return undefined;
  }
}

function subagentRunForTask(
  context: ClaudeSessionContext,
  toolUseId: string | undefined,
  taskId: string,
): ClaudeSubagentRun | undefined {
  const run = toolUseId ? context.subagentRuns.get(toolUseId) : undefined;
  if (run) {
    run.taskId ??= taskId;
    return run;
  }
  for (const candidate of context.subagentRuns.values()) {
    if (candidate.taskId === taskId) {
      return candidate;
    }
  }
  return undefined;
}

function makeClaudeAdapter(options?: ClaudeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    // Optional so adapter tests can run without the gateway layer; when
    // present, every session gets the synara_* MCP tools.
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    // The Claude Agent SDK is imported on first query construction rather than at
    // module scope, so boots that never open a Claude session never pay for it.
    const createQuery = async (input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }): Promise<ClaudeQueryRuntime> => {
      const override = options?.createQuery;
      if (override) {
        return override(input);
      }
      const { query } = await loadClaudeAgentSdk();
      return query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime;
    };
    const spawnClaudeProcess = options?.spawnClaudeCodeProcess ?? spawnOwnedClaudeCodeProcess;
    const teardownProcessTree = options?.teardownProcessTree ?? teardownProviderProcessTree;

    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    const failedStartupProcessOwners = new Map<ThreadId, ClaudeProcessOwner>();
    const failedCommandDiscoveryProcessOwners = new Set<ClaudeProcessOwner>();
    const sessionLifecycleLocks = new Map<ThreadId, Semaphore.Semaphore>();
    let cachedModels: ProviderListModelsResult | null = null;
    let cachedAgents: ProviderListAgentsResult | null = null;
    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const withSessionLifecycleLock = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      let lock = sessionLifecycleLocks.get(threadId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        sessionLifecycleLocks.set(threadId, lock);
      }
      return lock.withPermits(1)(effect);
    };
    const resolveClaudeSdkEnv = Effect.sync(() =>
      buildClaudeProcessEnv({ homeDir: serverConfig.homeDir }),
    );

    const bindClaudeProcessOwner =
      (owner: ClaudeProcessOwner) =>
      (spawnOptions: ClaudeSpawnOptions): ClaudeSpawnedProcess => {
        const process = spawnClaudeProcess(spawnOptions);
        owner.process = process;
        return process;
      };

    const teardownClaudeProcess = (
      threadId: ThreadId,
      owner: ClaudeProcessOwner,
    ): Effect.Effect<void, ProviderAdapterProcessError> => {
      const process = owner.process;
      if (!process) {
        return Effect.void;
      }
      return Effect.tryPromise({
        try: () => teardownChildProcessTree(process, teardownProcessTree),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to prove Claude process-tree exit."),
            cause,
          }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (owner.process === process) {
              delete owner.process;
            }
          }),
        ),
        Effect.asVoid,
      );
    };
    const teardownFailedStartupProcess = Effect.fnUntraced(function* (
      threadId: ThreadId,
      owner: ClaudeProcessOwner,
    ) {
      yield* teardownClaudeProcess(threadId, owner);
      if (failedStartupProcessOwners.get(threadId) === owner) {
        failedStartupProcessOwners.delete(threadId);
      }
    });
    const teardownFailedCommandDiscoveryProcesses = () =>
      Effect.forEach(
        failedCommandDiscoveryProcessOwners,
        (owner) =>
          teardownClaudeProcess(CLAUDE_COMMAND_DISCOVERY_THREAD_ID, owner).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                failedCommandDiscoveryProcessOwners.delete(owner);
              }),
            ),
          ),
        { discard: true },
      );
    const teardownCommandDiscoveryProcess = (owner: ClaudeProcessOwner) =>
      teardownClaudeProcess(CLAUDE_COMMAND_DISCOVERY_THREAD_ID, owner).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (owner.process) {
              failedCommandDiscoveryProcessOwners.add(owner);
            }
          }),
        ),
      );

    const offerRuntimeEvent = (
      context: ClaudeSessionContext,
      event: ProviderRuntimeEvent,
    ): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, {
        ...event,
        ...(context.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: context.lifecycleGeneration }
          : {}),
      }).pipe(Effect.asVoid);

    const logNativeSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!nativeEventLogger) {
          return;
        }

        const observedAt = new Date().toISOString();
        const itemId = sdkNativeItemId(message);

        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id:
                "uuid" in message && typeof message.uuid === "string"
                  ? message.uuid
                  : crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method: sdkNativeMethod(message),
              ...(typeof message.session_id === "string"
                ? { providerThreadId: message.session_id }
                : {}),
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
              payload: message,
            },
          },
          context.session.threadId,
        );
      });

    const snapshotThread = (
      context: ClaudeSessionContext,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{
          id: TurnId;
          items: ReadonlyArray<unknown>;
        }>;
      },
      ProviderAdapterValidationError
    > =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "readThread",
            issue: "Session thread id is not initialized yet.",
          });
        }
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const updateResumeCursor = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) return;

        const resumeCursor = {
          threadId,
          ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
          ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
          turnCount: context.turns.length,
          ...(context.trackedTasks.size > 0
            ? { trackedTasks: Array.from(context.trackedTasks.values()) }
            : {}),
        };

        context.session = {
          ...context.session,
          resumeCursor,
          updatedAt: yield* nowIso,
        };
      });

    const ensureAssistantTextBlock = (
      context: ClaudeSessionContext,
      blockIndex: number,
      options?: {
        readonly fallbackText?: string;
        readonly streamClosed?: boolean;
      },
    ): Effect.Effect<
      | {
          readonly blockIndex: number;
          readonly block: AssistantTextBlockState;
        }
      | undefined
    > =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return undefined;
        }

        const existing = turnState.assistantTextBlocks.get(blockIndex);
        if (existing && !existing.completionEmitted) {
          if (existing.fallbackText.length === 0 && options?.fallbackText) {
            existing.fallbackText = options.fallbackText;
          }
          if (options?.streamClosed) {
            existing.streamClosed = true;
          }
          return { blockIndex, block: existing };
        }

        const block: AssistantTextBlockState = {
          itemId: yield* Random.nextUUIDv4,
          blockIndex,
          emittedTextDelta: false,
          fallbackText: options?.fallbackText ?? "",
          streamClosed: options?.streamClosed ?? false,
          completionEmitted: false,
        };
        turnState.assistantTextBlocks.set(blockIndex, block);
        turnState.assistantTextBlockOrder.push(block);
        return { blockIndex, block };
      });

    const createSyntheticAssistantTextBlock = (
      context: ClaudeSessionContext,
      fallbackText: string,
    ): Effect.Effect<
      | {
          readonly blockIndex: number;
          readonly block: AssistantTextBlockState;
        }
      | undefined
    > =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return undefined;
        }

        const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
        turnState.nextSyntheticAssistantBlockIndex -= 1;
        return yield* ensureAssistantTextBlock(context, blockIndex, {
          fallbackText,
          streamClosed: true,
        });
      });

    const completeAssistantTextBlock = (
      context: ClaudeSessionContext,
      block: AssistantTextBlockState,
      options?: {
        readonly force?: boolean;
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState || block.completionEmitted) {
          return;
        }

        if (!options?.force && !block.streamClosed) {
          return;
        }

        if (!block.emittedTextDelta && block.fallbackText.length > 0) {
          const deltaStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "content.delta",
            eventId: deltaStamp.eventId,
            provider: PROVIDER,
            createdAt: deltaStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            itemId: asRuntimeItemId(block.itemId),
            payload: {
              streamKind: "assistant_text",
              delta: block.fallbackText,
            },
            providerRefs: nativeProviderRefs(context),
            ...(options?.rawMethod || options?.rawPayload
              ? {
                  raw: {
                    source: "claude.sdk.message" as const,
                    ...(options.rawMethod ? { method: options.rawMethod } : {}),
                    payload: options?.rawPayload,
                  },
                }
              : {}),
          });
        }

        block.completionEmitted = true;
        if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
          turnState.assistantTextBlocks.delete(block.blockIndex);
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "item.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          itemId: asRuntimeItemId(block.itemId),
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
          },
          providerRefs: nativeProviderRefs(context),
          ...(options?.rawMethod || options?.rawPayload
            ? {
                raw: {
                  source: "claude.sdk.message" as const,
                  ...(options.rawMethod ? { method: options.rawMethod } : {}),
                  payload: options?.rawPayload,
                },
              }
            : {}),
        });
      });

    const backfillAssistantTextBlocksFromSnapshot = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const snapshotTextBlocks = extractAssistantTextBlocks(message);
        if (snapshotTextBlocks.length === 0) {
          return;
        }

        // Align against only the current API message's blocks: aligning from
        // position 0 would collide with completed blocks from earlier messages
        // in the same turn and silently drop this snapshot's text (subagent
        // conversations arrive as complete messages under one synthetic turn).
        const orderedBlocks = turnState.assistantTextBlockOrder
          .slice(turnState.assistantMessageBlockBase)
          .map((block) => ({
            blockIndex: block.blockIndex,
            block,
          }));

        for (const [position, text] of snapshotTextBlocks.entries()) {
          const existingEntry = orderedBlocks[position];
          const entry =
            existingEntry ??
            (yield* createSyntheticAssistantTextBlock(context, text).pipe(
              Effect.map((created) => {
                if (!created) {
                  return undefined;
                }
                orderedBlocks.push(created);
                return created;
              }),
            ));
          if (!entry) {
            continue;
          }

          if (entry.block.fallbackText.length === 0) {
            entry.block.fallbackText = text;
          }

          if (entry.block.streamClosed && !entry.block.completionEmitted) {
            yield* completeAssistantTextBlock(context, entry.block, {
              rawMethod: "claude/assistant",
              rawPayload: message,
            });
          }
        }

        // Without stream events there is no message_start to advance the base,
        // so move it past this snapshot's blocks once they are settled.
        turnState.assistantMessageBlockBase = turnState.assistantTextBlockOrder.length;
      });

    const ensureThreadId = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (typeof message.session_id !== "string" || message.session_id.length === 0) {
          return;
        }
        if (!hasDurableClaudeSessionId(message)) {
          return;
        }
        const nextThreadId = message.session_id;
        context.resumeSessionId = message.session_id;
        yield* updateResumeCursor(context);

        if (context.lastThreadStartedId !== nextThreadId) {
          context.lastThreadStartedId = nextThreadId;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "thread.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              providerThreadId: nextThreadId,
            },
            providerRefs: {},
            raw: {
              source: "claude.sdk.message",
              method: "claude/thread/started",
              payload: {
                session_id: message.session_id,
              },
            },
          });
        }
      });

    const emitRuntimeError = (
      context: ClaudeSessionContext,
      message: string,
      cause?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (cause !== undefined) {
          void cause;
        }
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "runtime.error",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            class: "provider_error",
            ...(cause !== undefined ? { detail: cause } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    const emitRuntimeWarning = (
      context: ClaudeSessionContext,
      message: string,
      detail?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "runtime.warning",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    // Warn once per session per threshold when the logical prompt is large. Cache
    // reads still count toward context size, but are materially cheaper than fresh
    // input, so the warning names both instead of equating all tokens with cost.
    const maybeEmitContextUsageWarning = (
      context: ClaudeSessionContext,
      rawUsage: Record<string, unknown>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const warnings = decideClaudeContextUsageWarnings(
          rawUsage,
          claudeEffectiveContextBudget(context),
          context.emittedContextUsageWarnings,
        );
        if (!warnings) {
          return;
        }

        context.emittedContextUsageWarnings.add(warnings.first.key);
        yield* emitRuntimeWarning(context, warnings.first.message);
        if (warnings.second) {
          context.emittedContextUsageWarnings.add(warnings.second.key);
          yield* emitRuntimeWarning(context, warnings.second.message);
        }
      });

    const readClaudeContextUsage = (
      context: ClaudeSessionContext,
    ): Effect.Effect<SDKControlGetContextUsageResponse | undefined> => {
      if (!context.contextUsageControlEnabled) {
        return Effect.succeed(undefined);
      }
      return Effect.tryPromise({
        try: () => context.query.getContextUsage(),
        catch: (cause) => toError(cause, "Failed to read Claude context usage."),
      }).pipe(
        Effect.timeoutOption(CLAUDE_CONTEXT_USAGE_TIMEOUT_MS),
        Effect.map(
          Option.match({
            onNone: () => {
              // A missing control response otherwise blocks every future turn.
              context.contextUsageControlEnabled = false;
              return undefined;
            },
            onSome: (usage) => usage,
          }),
        ),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    };

    // Surfaces each distinct unrecognized SDK message kind at most once per session.
    // Without this, high-frequency telemetry the adapter doesn't model (notably the
    // `thinking_tokens` system subtype streamed on every reasoning tick) turns into a
    // "Runtime warning" timeline entry per message and floods the conversation.
    const warnUnhandledSdkKind = (
      context: ClaudeSessionContext,
      kind: string,
      message: string,
      detail: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.warnedUnhandledSdkKinds.has(kind)) {
          return;
        }
        context.warnedUnhandledSdkKinds.add(kind);
        yield* emitRuntimeWarning(context, message, detail);
      });

    const emitProposedPlanCompleted = (
      context: ClaudeSessionContext,
      input: {
        readonly planMarkdown: string;
        readonly toolUseId?: string | undefined;
        readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
        readonly rawMethod: string;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const planMarkdown = input.planMarkdown.trim();
        if (!turnState || planMarkdown.length === 0) {
          return;
        }

        const captureKey = exitPlanCaptureKey({
          toolUseId: input.toolUseId,
          planMarkdown,
        });
        if (turnState.capturedProposedPlanKeys.has(captureKey)) {
          return;
        }
        turnState.capturedProposedPlanKeys.add(captureKey);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "turn.proposed.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            planMarkdown,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: input.toolUseId,
          }),
          raw: {
            source: input.rawSource,
            method: input.rawMethod,
            payload: input.rawPayload,
          },
        });
      });

    // Normalizes Claude TodoWrite tool calls into the shared runtime task-list event.
    const emitTodoTasksUpdated = (
      context: ClaudeSessionContext,
      input: {
        readonly toolInput: Record<string, unknown>;
        readonly toolUseId?: string | undefined;
        readonly rawMethod: string;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const tasksPayload = normalizeClaudeTodoTasks(input.toolInput);
        if (!tasksPayload) {
          return;
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "turn.tasks.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: tasksPayload,
          providerRefs: nativeProviderRefs(context, {
            providerItemId: input.toolUseId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: input.rawMethod,
            payload: input.rawPayload,
          },
        });
      });

    const emitTrackedTasksUpdated = (
      context: ClaudeSessionContext,
      input: {
        readonly toolUseId?: string | undefined;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "turn.tasks.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: claudeTrackedTasksPayload(context.trackedTasks),
          providerRefs: nativeProviderRefs(context, {
            providerItemId: input.toolUseId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user/task-result",
            payload: input.rawPayload,
          },
        });
      });

    const completeTurn = (
      context: ClaudeSessionContext,
      status: ProviderRuntimeTurnStatus,
      errorMessage?: string,
      result?: SDKResultMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const liveContextUsage = yield* readClaudeContextUsage(context);
        const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
        const liveRawContextWindow = positiveFiniteNumber(liveContextUsage?.rawMaxTokens);
        const effectiveContextWindow = resolveEffectiveClaudeContextWindow({
          reportedContextWindow: liveRawContextWindow ?? resultContextWindow,
          lastKnownContextWindow: context.lastKnownContextWindow,
        });
        if (effectiveContextWindow !== undefined) {
          context.lastKnownContextWindow = effectiveContextWindow;
        }
        const liveAutoCompactThreshold = positiveFiniteNumber(
          liveContextUsage?.autoCompactThreshold,
        );
        if (liveAutoCompactThreshold !== undefined) {
          context.lastKnownAutoCompactThreshold = liveAutoCompactThreshold;
        }

        // The SDK result.usage contains *accumulated* totals across all API calls
        // (input_tokens, cache_read_input_tokens, etc. summed over every request).
        // This does NOT represent the current context window size.
        // Instead, use the last known context-window-accurate usage from task_progress
        // events and treat the accumulated total as totalProcessedTokens.
        const accumulatedSnapshot = normalizeClaudeTokenUsage(
          result?.usage,
          claudeEffectiveContextBudget(context),
        );
        const totalProcessedTokens =
          accumulatedSnapshot?.totalProcessedTokens ?? accumulatedSnapshot?.usedTokens;
        const liveSnapshot = liveContextUsage
          ? snapshotFromClaudeContextUsage(liveContextUsage, totalProcessedTokens)
          : undefined;
        const lastGoodUsage = liveSnapshot ?? context.lastKnownTokenUsage;
        const maxTokens = claudeEffectiveContextBudget(context);
        const usageSnapshot: ThreadTokenUsageSnapshot | undefined = lastGoodUsage
          ? mergeClaudeTokenUsageSnapshot(lastGoodUsage, accumulatedSnapshot, maxTokens)
          : accumulatedSnapshot;

        // A safeguard reroute only applies to the turn that just finished.
        // Restore the user-selected model so subsequent turns do not silently
        // stay on the (heavier) fallback; the safeguard may reroute again.
        const reroutedFrom = context.rerouteOriginalApiModelId;
        if (reroutedFrom !== undefined) {
          const restoreExit = yield* Effect.exit(
            Effect.tryPromise({
              try: () => context.query.setModel(reroutedFrom),
              catch: (cause) => toError(cause, "Failed to restore Claude model after reroute."),
            }),
          );
          if (Exit.isSuccess(restoreExit)) {
            context.rerouteOriginalApiModelId = undefined;
            context.currentApiModelId = reroutedFrom;
            context.lastKnownContextWindow =
              resolveClaudeApiModelIdContextWindowMaxTokens(reroutedFrom);
          }
        }

        const turnState = context.turnState;
        if (!turnState) {
          if (usageSnapshot) {
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "thread.token-usage.updated",
              eventId: usageStamp.eventId,
              provider: PROVIDER,
              createdAt: usageStamp.createdAt,
              threadId: context.session.threadId,
              payload: {
                usage: usageSnapshot,
              },
              providerRefs: {},
            });
          }

          // Runtime ingestion drops a terminal event it cannot attribute to a
          // turn, which strands the projection in "running". The last turn this
          // session owned is the only turn this result can belong to, because a
          // newer one would still have live turn state.
          const settledTurnId = context.lastTurnId;
          if (settledTurnId === undefined) {
            yield* Effect.logWarning("claude turn result arrived with no attributable turn", {
              threadId: context.session.threadId,
              status,
            });
          }
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "turn.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(settledTurnId !== undefined ? { turnId: settledTurnId } : {}),
            payload: {
              state: status,
              ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
              ...(result?.usage ? { usage: result.usage } : {}),
              ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
              ...(typeof result?.total_cost_usd === "number"
                ? { totalCostUsd: result.total_cost_usd }
                : {}),
              ...(errorMessage ? { errorMessage } : {}),
            },
            providerRefs: {},
          });
          return;
        }

        for (const [index, tool] of context.inFlightTools.entries()) {
          const toolStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "item.completed",
            eventId: toolStamp.eventId,
            provider: PROVIDER,
            createdAt: toolStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: status === "completed" ? "completed" : "failed",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolLifecycleEventData(tool),
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/result",
              payload: result ?? { status },
            },
          });
          if (tool.itemType === "file_change") {
            context.turnState = {
              ...turnState,
              sawFileChange: true,
            };
          }
          context.inFlightTools.delete(index);
        }
        // Clear any remaining stale entries (e.g. from interrupted content blocks)
        context.inFlightTools.clear();

        for (const block of turnState.assistantTextBlockOrder) {
          yield* completeAssistantTextBlock(context, block, {
            force: true,
            rawMethod: "claude/result",
            rawPayload: result ?? { status },
          });
        }

        context.turns.push({
          id: turnState.turnId,
          items: [...turnState.items],
        });

        if (usageSnapshot) {
          const usageStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "thread.token-usage.updated",
            eventId: usageStamp.eventId,
            provider: PROVIDER,
            createdAt: usageStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            payload: {
              usage: usageSnapshot,
            },
            providerRefs: nativeProviderRefs(context),
          });
        }

        // Feed Claude edits into the same placeholder checkpoint flow used by Codex.
        if (status === "completed" && turnState.sawFileChange) {
          const diffStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "turn.diff.updated",
            eventId: diffStamp.eventId,
            provider: PROVIDER,
            createdAt: diffStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            payload: {
              unifiedDiff: "",
            },
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.message",
              method: "claude/result",
              payload: result ?? { status },
            },
          });
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            state: status,
            ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(typeof result?.total_cost_usd === "number"
              ? { totalCostUsd: result.total_cost_usd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });

        const updatedAt = yield* nowIso;
        if (context.interruptRequestedTurnId === turnState.turnId) {
          context.interruptRequestedTurnId = undefined;
        }
        context.lastInteractionMode = turnState.interactionMode;
        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt,
          ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
        };
        yield* updateResumeCursor(context);
      });

    // A subagent run gets its own scoped context sharing the parent session/query:
    // the same handlers project its messages, but every event carries subagentRefs
    // (providerThreadId = Task tool_use_id, providerParentThreadId = parent thread),
    // so ingestion's provider-ref path routes it to the `subagent:<parent>:<toolUseId>`
    // child thread and the reactor's interrupt decoding hands the toolUseId back here.
    const ensureSubagentRun = (
      context: ClaudeSessionContext,
      toolUseId: string,
    ): ClaudeSubagentRun => {
      const existing = context.subagentRuns.get(toolUseId);
      if (existing) {
        return existing;
      }
      const run: ClaudeSubagentRun = {
        toolUseId,
        taskId: undefined,
        context: {
          session: context.session,
          ...(context.lifecycleGeneration === undefined
            ? {}
            : { lifecycleGeneration: context.lifecycleGeneration }),
          promptQueue: context.promptQueue,
          query: context.query,
          processOwner: context.processOwner,
          streamFiber: undefined,
          startedAt: context.startedAt,
          basePermissionMode: context.basePermissionMode,
          spawnPermissionMode: context.spawnPermissionMode,
          // Subagent contexts only project events for an already-running CLI;
          // they never dispatch the first prompt, so spawn state is not theirs
          // to prove.
          firstTurnSpawnModeAuthoritative: false,
          lastInteractionMode: undefined,
          currentApiModelId: undefined,
          resumeSessionId: undefined,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          turns: [],
          inFlightTools: new Map(),
          trackedTasks: new Map(),
          turnState: undefined,
          lastTurnId: undefined,
          interruptRequestedTurnId: undefined,
          lastKnownContextWindow: context.lastKnownContextWindow,
          currentAutoCompactWindow: context.currentAutoCompactWindow,
          currentAlwaysThinkingEnabled: undefined,
          currentEffort: context.currentEffort,
          currentUltracode: context.currentUltracode,
          currentFastMode: context.currentFastMode,
          lastKnownAutoCompactThreshold: context.lastKnownAutoCompactThreshold,
          // Session-level context usage controls answer for the main conversation
          // only; subagent completion must not poll them.
          contextUsageControlEnabled: false,
          lastKnownTokenUsage: undefined,
          lastAssistantUuid: undefined,
          lastThreadStartedId: undefined,
          rerouteOriginalApiModelId: undefined,
          emittedContextUsageWarnings: new Set(),
          stopped: false,
          warnedUnhandledSdkKinds: context.warnedUnhandledSdkKinds,
          subagentRuns: new Map(),
          pendingSubagentSteers: new Map(),
          pendingSubagentStops: new Set(),
          knownBackgroundTaskIds: new Set(),
          settledSubagentToolUseIds: new Map(),
          liveWorkflowTaskIds: new Set(),
          knownWorkflowTaskIds: new Set(),
          workflowTaskIdByMemberTaskId: new Map(),
          workflowRuntimePollers: new Map(),
          workflowAgentLabels: new Map(),
          workflowRuntimeStates: new Map(),
          subagentRefs: {
            providerThreadId: toolUseId,
            providerParentThreadId: context.session.threadId,
          },
        },
      };
      context.subagentRuns.set(toolUseId, run);
      return run;
    };

    // Opens a tool item and emits item.started. Streaming turns key the entry
    // by stream block index; complete-message turns (subagent conversations
    // arrive without stream events) use synthetic negative keys that stream
    // deltas can never reference.
    const openInFlightTool = (
      context: ClaudeSessionContext,
      input: {
        readonly blockIndex: number;
        readonly toolName: string;
        readonly itemId: string;
        readonly toolInput: Record<string, unknown>;
        readonly rawMethod: string;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const itemType = classifyToolItemType(input.toolName);
        const detail = summarizeToolRequest(input.toolName, input.toolInput);
        const inputFingerprint =
          Object.keys(input.toolInput).length > 0
            ? toolInputFingerprint(input.toolInput)
            : undefined;

        const tool: ToolInFlight = {
          itemId: input.itemId,
          itemType,
          toolName: input.toolName,
          title: titleForTool(itemType),
          detail,
          input: input.toolInput,
          partialInputJson: "",
          ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
        };
        context.inFlightTools.set(input.blockIndex, tool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "item.started",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            itemType: tool.itemType,
            status: "inProgress",
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
            data: toolLifecycleEventData(tool),
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: input.rawMethod,
            payload: input.rawPayload,
          },
        });
        if (tool.toolName === "TodoWrite") {
          yield* emitTodoTasksUpdated(context, {
            toolInput: input.toolInput,
            toolUseId: tool.itemId,
            rawMethod: input.rawMethod,
            rawPayload: input.rawPayload,
          });
        }
      });

    const handleStreamEvent = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "stream_event") {
          return;
        }

        const { event } = message;

        if (event.type === "content_block_delta") {
          if (
            (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
            context.turnState
          ) {
            const deltaText =
              event.delta.type === "text_delta"
                ? event.delta.text
                : typeof event.delta.thinking === "string"
                  ? event.delta.thinking
                  : "";
            if (deltaText.length === 0) {
              return;
            }
            const streamKind = streamKindFromDeltaType(event.delta.type);
            const assistantBlockEntry =
              event.delta.type === "text_delta"
                ? yield* ensureAssistantTextBlock(context, event.index)
                : context.turnState.assistantTextBlocks.get(event.index)
                  ? {
                      blockIndex: event.index,
                      block: context.turnState.assistantTextBlocks.get(
                        event.index,
                      ) as AssistantTextBlockState,
                    }
                  : undefined;
            if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
              assistantBlockEntry.block.emittedTextDelta = true;
            }
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "content.delta",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              ...(assistantBlockEntry?.block
                ? { itemId: asRuntimeItemId(assistantBlockEntry.block.itemId) }
                : {}),
              payload: {
                streamKind,
                delta: deltaText,
              },
              providerRefs: nativeProviderRefs(context),
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta",
                payload: message,
              },
            });
            return;
          }

          if (event.delta.type === "input_json_delta") {
            const tool = context.inFlightTools.get(event.index);
            if (!tool || typeof event.delta.partial_json !== "string") {
              return;
            }

            const partialInputJson = tool.partialInputJson + event.delta.partial_json;
            const parsedInput = tryParseJsonRecord(partialInputJson);
            const detail = parsedInput
              ? summarizeToolRequest(tool.toolName, parsedInput)
              : tool.detail;
            let nextTool: ToolInFlight = {
              ...tool,
              partialInputJson,
              ...(parsedInput ? { input: parsedInput } : {}),
              ...(detail ? { detail } : {}),
            };

            const nextFingerprint =
              parsedInput && Object.keys(parsedInput).length > 0
                ? toolInputFingerprint(parsedInput)
                : undefined;
            context.inFlightTools.set(event.index, nextTool);

            if (
              !parsedInput ||
              !nextFingerprint ||
              tool.lastEmittedInputFingerprint === nextFingerprint
            ) {
              return;
            }

            nextTool = {
              ...nextTool,
              lastEmittedInputFingerprint: nextFingerprint,
            };
            context.inFlightTools.set(event.index, nextTool);

            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "item.updated",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              itemId: asRuntimeItemId(nextTool.itemId),
              payload: {
                itemType: nextTool.itemType,
                status: "inProgress",
                title: nextTool.title,
                ...(nextTool.detail ? { detail: nextTool.detail } : {}),
                data: toolLifecycleEventData(nextTool),
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta/input_json_delta",
                payload: message,
              },
            });
            if (nextTool.toolName === "TodoWrite") {
              yield* emitTodoTasksUpdated(context, {
                toolInput: nextTool.input,
                toolUseId: nextTool.itemId,
                rawMethod: "claude/stream_event/content_block_delta/input_json_delta",
                rawPayload: message,
              });
            }
          }
          return;
        }

        if (event.type === "content_block_start") {
          const { index, content_block: block } = event;
          if (block.type === "text") {
            yield* ensureAssistantTextBlock(context, index, {
              fallbackText: extractContentBlockText(block),
            });
            return;
          }
          if (
            block.type !== "tool_use" &&
            block.type !== "server_tool_use" &&
            block.type !== "mcp_tool_use"
          ) {
            return;
          }
          const toolName = block.name;
          // AskUserQuestion / ExitPlanMode are rendered by their own runtime channels;
          // emitting a generic tool item here would duplicate them as a raw row.
          if (isClientSurfacedClaudeTool(toolName)) {
            return;
          }
          yield* openInFlightTool(context, {
            blockIndex: index,
            toolName,
            itemId: block.id,
            toolInput:
              typeof block.input === "object" && block.input !== null
                ? (block.input as Record<string, unknown>)
                : {},
            rawMethod: "claude/stream_event/content_block_start",
            rawPayload: message,
          });
          return;
        }

        if (event.type === "content_block_stop") {
          const { index } = event;
          const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
          if (assistantBlock) {
            assistantBlock.streamClosed = true;
            yield* completeAssistantTextBlock(context, assistantBlock, {
              rawMethod: "claude/stream_event/content_block_stop",
              rawPayload: message,
            });
            return;
          }
          const tool = context.inFlightTools.get(index);
          if (!tool) {
            return;
          }
        }
      });

    const handleUserMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "user") {
          return;
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
        }

        for (const toolResult of toolResultBlocksFromUserMessage(message)) {
          const toolEntry = Array.from(context.inFlightTools.entries()).find(
            ([, tool]) => tool.itemId === toolResult.toolUseId,
          );
          if (!toolEntry) {
            continue;
          }

          const [index, tool] = toolEntry;
          const itemStatus = toolResult.isError ? "failed" : "completed";
          // A user-stopped task returns an error-shaped tool_result; the settled
          // status stamps a per-agent state so the row reads "Stopped", not
          // "Failed".
          const settledStatus =
            tool.toolName === "Task" || tool.toolName === "Agent"
              ? context.settledSubagentToolUseIds.get(tool.itemId)
              : undefined;
          const toolData = toolLifecycleEventData(tool, {
            result: toolResult.block,
            ...(settledStatus === "stopped"
              ? { agentStates: { [tool.itemId]: { status: "stopped" } } }
              : {}),
          });

          const updatedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "item.updated",
            eventId: updatedStamp.eventId,
            provider: PROVIDER,
            createdAt: updatedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: toolResult.isError ? "failed" : "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolData,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });

          const streamKind = toolResultStreamKind(tool.itemType);
          if (streamKind && toolResult.text.length > 0 && context.turnState) {
            const deltaStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "content.delta",
              eventId: deltaStamp.eventId,
              provider: PROVIDER,
              createdAt: deltaStamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              itemId: asRuntimeItemId(tool.itemId),
              payload: {
                streamKind,
                delta: toolResult.text,
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/user",
                payload: message,
              },
            });
          }

          if (
            applyClaudeTaskToolResult(
              context.trackedTasks,
              tool,
              toolResult.block,
              toolResult.structuredResult,
              toolResult.isError,
            )
          ) {
            yield* updateResumeCursor(context);
            yield* emitTrackedTasksUpdated(context, {
              toolUseId: tool.itemId,
              rawPayload: message,
            });
          }

          // The Workflow tool returns async_launched with the persisted script
          // path and runId; surfacing them on task.updated is what lets the
          // panel offer stop-then-resume.
          const workflowLaunch =
            tool.toolName === "Workflow"
              ? (parseClaudeWorkflowLaunch(toolResult.structuredResult) ??
                (toolResult.text.length > 0
                  ? parseClaudeWorkflowLaunchFromText(toolResult.text)
                  : undefined))
              : undefined;
          const workflowLaunchTaskId =
            workflowLaunch?.taskId ??
            (context.liveWorkflowTaskIds.size === 1
              ? Array.from(context.liveWorkflowTaskIds)[0]
              : undefined);
          if (workflowLaunch && workflowLaunchTaskId) {
            const launchStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "task.updated",
              eventId: launchStamp.eventId,
              provider: PROVIDER,
              createdAt: launchStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(workflowLaunchTaskId),
                ...(workflowLaunch.runId ? { workflowRunId: workflowLaunch.runId } : {}),
                ...(workflowLaunch.scriptPath
                  ? { workflowScriptPath: workflowLaunch.scriptPath }
                  : {}),
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/user",
                payload: message,
              },
            });
            if (workflowLaunch.transcriptDir) {
              startWorkflowRuntimePoller(
                context,
                workflowLaunchTaskId,
                workflowLaunch.transcriptDir,
              );
            }
          }

          const completedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "item.completed",
            eventId: completedStamp.eventId,
            provider: PROVIDER,
            createdAt: completedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: itemStatus,
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolData,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });

          if (tool.itemType === "file_change" && context.turnState) {
            context.turnState = {
              ...context.turnState,
              sawFileChange: true,
            };
          }
          context.inFlightTools.delete(index);
        }
      });

    // Auto-start a synthetic turn for messages that arrive without an active turn
    // (e.g., background agent/subagent responses between user prompts).
    const ensureSyntheticTurn = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.turnState) {
          return;
        }
        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const startedAt = yield* nowIso;
        context.turnState = {
          turnId,
          startedAt,
          interactionMode: "default",
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          sawFileChange: false,
          nextSyntheticAssistantBlockIndex: -1,
          assistantMessageBlockBase: 0,
        };
        context.lastTurnId = turnId;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: startedAt,
        };
        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: {},
          providerRefs: {
            ...nativeProviderRefs(context),
            providerTurnId: turnId,
          },
          raw: {
            source: "claude.sdk.message",
            method: "claude/synthetic-turn-start",
            payload: {},
          },
        });
      });

    // Transcript marker on the child thread, emitted only at actual delivery
    // (the PreToolUse hook fired inside the subagent), never on enqueue.
    const emitSubagentSteerDelivered = (
      run: ClaudeSubagentRun,
      message: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* ensureSyntheticTurn(run.context);
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(run.context, {
          type: "turn.steered",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: run.context.session.threadId,
          ...(run.context.turnState
            ? { turnId: asCanonicalTurnId(run.context.turnState.turnId) }
            : {}),
          payload: {
            message,
          },
          providerRefs: nativeProviderRefs(run.context),
          raw: {
            source: "claude.sdk.hook",
            method: "hooks/PreToolUse",
            payload: {
              taskId: run.taskId,
              toolUseId: run.toolUseId,
            },
          },
        });
      });

    const handleAssistantMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }

        yield* ensureSyntheticTurn(context);
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") {
              continue;
            }
            const toolUse = block as {
              type?: unknown;
              id?: unknown;
              name?: unknown;
              input?: unknown;
            };
            const isToolUseBlock =
              toolUse.type === "tool_use" ||
              toolUse.type === "server_tool_use" ||
              toolUse.type === "mcp_tool_use";
            if (
              isToolUseBlock &&
              context.subagentRefs !== undefined &&
              typeof toolUse.id === "string" &&
              typeof toolUse.name === "string" &&
              !isClientSurfacedClaudeTool(toolUse.name)
            ) {
              // Subagent conversations are forwarded as complete messages only
              // (no stream events), so this snapshot is the sole chance to open
              // their tool items. The parent thread always streams and opens
              // tools from content_block_start — which can arrive after this
              // snapshot, so registering here for the parent would duplicate
              // the item. Dedupe by tool-use id in case a subagent ever streams.
              const toolUseId = toolUse.id;
              const alreadyOpen = Array.from(context.inFlightTools.values()).some(
                (tool) => tool.itemId === toolUseId,
              );
              if (!alreadyOpen) {
                let syntheticIndex = -1;
                for (const key of context.inFlightTools.keys()) {
                  if (key <= syntheticIndex) {
                    syntheticIndex = key - 1;
                  }
                }
                yield* openInFlightTool(context, {
                  blockIndex: syntheticIndex,
                  toolName: toolUse.name,
                  itemId: toolUseId,
                  toolInput:
                    typeof toolUse.input === "object" && toolUse.input !== null
                      ? (toolUse.input as Record<string, unknown>)
                      : {},
                  rawMethod: "claude/assistant",
                  rawPayload: message,
                });
              }
            }
            if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
              continue;
            }
            const planMarkdown = extractExitPlanModePlan(toolUse.input);
            if (!planMarkdown) {
              continue;
            }
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
              rawSource: "claude.sdk.message",
              rawMethod: "claude/assistant",
              rawPayload: message,
            });
          }

          const taggedPlanMarkdown =
            context.turnState?.interactionMode === "plan"
              ? extractProposedPlanMarkdown(extractTextContent(content))
              : undefined;
          if (taggedPlanMarkdown) {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown: taggedPlanMarkdown,
              rawSource: "claude.sdk.message",
              rawMethod: "claude/assistant/proposed-plan-block",
              rawPayload: message,
            });
          }
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
          yield* backfillAssistantTextBlocksFromSnapshot(context, message);
        }

        // Capture per-API-call usage from the assistant response for accurate
        // context window tracking. Unlike task_progress (accumulated per-task),
        // this reflects the actual prompt + output size for this single API call.
        const perCallUsage = (message.message as { usage?: unknown } | undefined)?.usage;
        if (perCallUsage) {
          yield* maybeEmitContextUsageWarning(context, perCallUsage as Record<string, unknown>);
          const normalizedPerCallUsage = normalizeClaudeTokenUsage(
            perCallUsage as Record<string, unknown>,
            claudeEffectiveContextBudget(context),
          );
          if (normalizedPerCallUsage) {
            context.lastKnownTokenUsage = normalizedPerCallUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "thread.token-usage.updated",
              eventId: usageStamp.eventId,
              provider: PROVIDER,
              createdAt: usageStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              payload: { usage: normalizedPerCallUsage },
              providerRefs: nativeProviderRefs(context),
              raw: {
                source: "claude.sdk.message",
                method: "claude/assistant-usage",
                payload: perCallUsage,
              },
            });
          }
        }

        context.lastAssistantUuid = message.uuid;
        yield* updateResumeCursor(context);
      });

    const handleResultMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "result") {
          return;
        }

        const status =
          hasPendingUserInterrupt(context) && message.subtype === "error_during_execution"
            ? "interrupted"
            : turnStatusFromResult(message);
        const errorMessage =
          message.subtype === "success"
            ? undefined
            : normalizeClaudeUserVisibleErrorMessage(message.errors[0], status);

        if (status === "failed") {
          yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
        }

        yield* completeTurn(context, status, errorMessage, message);
      });

    // Task usage totals belong to the agent that spent them: subagent tasks feed the
    // child thread's token meter, everything else feeds the parent as before. This
    // also keeps per-task totals off the parent's context-window snapshot.
    const emitTaskUsageSnapshot = (
      context: ClaudeSessionContext,
      message: Extract<SDKMessage, { subtype: "task_progress" | "task_notification" }>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!message.usage) {
          return;
        }
        const run = subagentRunForTask(context, message.tool_use_id, message.task_id);
        const target = run?.context ?? context;
        const normalizedUsage = normalizeClaudeTokenUsage(
          message.usage,
          claudeEffectiveContextBudget(target),
        );
        if (!normalizedUsage) {
          return;
        }
        target.lastKnownTokenUsage = normalizedUsage;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(target, {
          type: "thread.token-usage.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: target.session.threadId,
          ...(target.turnState ? { turnId: asCanonicalTurnId(target.turnState.turnId) } : {}),
          payload: {
            usage: normalizedUsage,
          },
          providerRefs: nativeProviderRefs(target),
          raw: {
            source: "claude.sdk.message",
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          },
        });
      });

    // Workflow scripts arrive inline: task_started.prompt carries the full text,
    // with the Workflow tool input (`script`, or a resume-style `scriptPath` read
    // best-effort) as fallback. Absence just means no parsed meta on the event.
    const resolveWorkflowScriptText = (
      context: ClaudeSessionContext,
      message: Extract<SDKMessage, { subtype: "task_started" }>,
    ): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        if (typeof message.prompt === "string" && message.prompt.trim().length > 0) {
          return message.prompt;
        }
        const tool = message.tool_use_id
          ? Array.from(context.inFlightTools.values()).find(
              (candidate) => candidate.itemId === message.tool_use_id,
            )
          : undefined;
        if (typeof tool?.input.script === "string" && tool.input.script.trim().length > 0) {
          return tool.input.script;
        }
        if (typeof tool?.input.scriptPath === "string" && tool.input.scriptPath.length > 0) {
          return yield* fileSystem
            .readFileString(tool.input.scriptPath)
            .pipe(Effect.orElseSucceed(() => undefined));
        }
        return undefined;
      });

    const workflowRuntimePollInterval = Duration.millis(
      options?.workflowRuntimePollIntervalMs ?? DEFAULT_WORKFLOW_RUNTIME_POLL_INTERVAL_MS,
    );

    // Polls a live workflow's transcript directory (journal.jsonl + per-agent
    // transcripts) and emits task.progress events carrying per-agent runtime
    // snapshots. Runs detached like streamFiber; exits when the workflow
    // settles or the session stops, and is interrupted eagerly on both.
    const startWorkflowRuntimePoller = (
      context: ClaudeSessionContext,
      taskId: string,
      transcriptDir: string,
    ): void => {
      if (context.workflowRuntimePollers.has(taskId)) {
        return;
      }
      const state = makeClaudeWorkflowRuntimeState();
      context.workflowRuntimeStates.set(taskId, state);
      let lastEmitted = "";
      const loop = Effect.gen(function* () {
        while (!context.stopped && context.liveWorkflowTaskIds.has(taskId)) {
          yield* Effect.sleep(workflowRuntimePollInterval);
          const changed = yield* collectClaudeWorkflowRuntime(fileSystem, transcriptDir, state);
          if (!changed) {
            continue;
          }
          const snapshots = claudeWorkflowRuntimeSnapshots(
            state,
            context.workflowAgentLabels.get(taskId) ?? [],
          );
          if (snapshots.length === 0) {
            continue;
          }
          const fingerprint = JSON.stringify(snapshots);
          if (fingerprint === lastEmitted) {
            continue;
          }
          lastEmitted = fingerprint;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "task.progress",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(taskId),
              description: WORKFLOW_AGENTS_PROGRESS_DESCRIPTION,
              workflowAgents: snapshots,
            },
            providerRefs: nativeProviderRefs(context),
          });
        }
      });
      const fiber = Effect.runFork(loop);
      context.workflowRuntimePollers.set(taskId, fiber);
      fiber.addObserver(() => {
        if (context.workflowRuntimePollers.get(taskId) === fiber) {
          context.workflowRuntimePollers.delete(taskId);
        }
      });
    };

    const stopWorkflowRuntimePoller = (
      context: ClaudeSessionContext,
      taskId: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        context.workflowAgentLabels.delete(taskId);
        // workflowRuntimeStates survives poller teardown: a terminal
        // task_updated stops the poller before task_notification backfills
        // effort into the final snapshots; the state is dropped there instead.
        const fiber = context.workflowRuntimePollers.get(taskId);
        if (!fiber) {
          return;
        }
        context.workflowRuntimePollers.delete(taskId);
        yield* Fiber.interrupt(fiber);
      });

    const handleSystemMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "system") {
          return;
        }

        // Benign high-frequency telemetry we intentionally don't project. `thinking_tokens`
        // streams on every reasoning tick while extended thinking is active. Short-circuit
        // before allocating an event stamp so it can't flood the timeline (or churn
        // allocations) with "Runtime warning" entries.
        if (message.subtype === "thinking_tokens") {
          return;
        }

        // `task_updated` is an incremental task patch. Status transitions surface as
        // `task.updated` on the parent thread (workflow panels track pause/kill through
        // them); tracked subagent runs additionally keep the child thread truthful via
        // `session.state.changed`. Non-status patches stay dropped.
        if (message.subtype === "task_updated") {
          const patch = message.patch;
          const status = patch?.status;
          const isBackgrounded = patch?.is_backgrounded;
          if (status === undefined && isBackgrounded === undefined) {
            return;
          }
          const isTerminalStatus =
            status === "completed" || status === "failed" || status === "killed";
          const isSettledRuntimeStatus = isTerminalStatus || status === "paused";
          if (isSettledRuntimeStatus && context.liveWorkflowTaskIds.has(message.task_id)) {
            context.liveWorkflowTaskIds.delete(message.task_id);
            yield* stopWorkflowRuntimePoller(context, message.task_id);
          }
          const workflowTaskId = context.workflowTaskIdByMemberTaskId.get(message.task_id);
          const run = subagentRunForTask(context, undefined, message.task_id);
          const raw = {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          };
          const taskStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "task.updated",
            eventId: taskStamp.eventId,
            provider: PROVIDER,
            createdAt: taskStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(message.task_id),
              ...(status !== undefined ? { status } : {}),
              ...(patch?.error ? { error: patch.error } : {}),
              ...(isBackgrounded !== undefined ? { isBackgrounded } : {}),
              ...(run ? { toolUseId: run.toolUseId } : {}),
              ...(workflowTaskId
                ? { workflowTaskId: RuntimeTaskId.makeUnsafe(workflowTaskId) }
                : {}),
            },
            providerRefs: nativeProviderRefs(context),
            raw,
          });
          const state =
            status !== undefined ? runtimeSessionStateFromClaudeTaskStatus(status) : undefined;
          if (!run || state === undefined) {
            return;
          }
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(run.context, {
            type: "session.state.changed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: run.context.session.threadId,
            ...(run.context.turnState
              ? { turnId: asCanonicalTurnId(run.context.turnState.turnId) }
              : {}),
            payload: {
              state,
              reason: `task:${status}`,
              detail: message,
            },
            providerRefs: nativeProviderRefs(run.context),
            raw,
          });
          if (isTerminalStatus) {
            context.subagentRuns.delete(run.toolUseId);
            context.pendingSubagentSteers.delete(run.toolUseId);
            context.pendingSubagentStops.delete(run.toolUseId);
            context.settledSubagentToolUseIds.set(
              run.toolUseId,
              status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
            );
            if (run.context.turnState) {
              yield* completeTurn(
                run.context,
                status === "completed"
                  ? "completed"
                  : status === "failed"
                    ? "failed"
                    : "interrupted",
              );
            }
          }
          return;
        }

        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          },
        };

        // Safeguard reroute (e.g. Fable 5 refusal -> Opus fallback). Track the
        // fallback for the in-flight turn only; turn completion restores the
        // user-selected model so one refusal cannot pin later turns to Opus.
        const refusalFallback = readClaudeModelRefusalFallback(message);
        if (refusalFallback) {
          context.rerouteOriginalApiModelId ??= refusalFallback.originalModel;
          context.currentApiModelId = refusalFallback.fallbackModel;
          context.lastKnownContextWindow = resolveClaudeApiModelIdContextWindowMaxTokens(
            refusalFallback.fallbackModel,
          );
          yield* updateResumeCursor(context);
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "model.rerouted",
            payload: {
              fromModel: refusalFallback.originalModel,
              toModel: refusalFallback.fallbackModel,
              reason: refusalFallback.content ?? "Model safeguards rerouted this request.",
            },
          });
          return;
        }

        switch (message.subtype) {
          case "init":
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "session.configured",
              payload: {
                config: message as Record<string, unknown>,
              },
            });
            return;
          case "status":
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "session.state.changed",
              payload: {
                state: message.status === "compacting" ? "waiting" : "running",
                reason: `status:${message.status ?? "active"}`,
                detail: message,
              },
            });
            return;
          case "compact_boundary":
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: message,
              },
            });
            return;
          case "hook_started":
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "hook.started",
              payload: {
                hookId: message.hook_id,
                hookName: message.hook_name,
                hookEvent: message.hook_event,
              },
            });
            return;
          case "hook_progress":
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "hook.progress",
              payload: {
                hookId: message.hook_id,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
              },
            });
            return;
          case "hook_response":
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "hook.completed",
              payload: {
                hookId: message.hook_id,
                outcome: message.outcome,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
                ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
              },
            });
            return;
          case "task_started": {
            // Subagent tasks get a run entry so later task_progress/notification and
            // stopTask can be keyed by the Task tool_use_id ingestion routes on.
            if (
              message.tool_use_id &&
              (message.subagent_type !== undefined || context.subagentRuns.has(message.tool_use_id))
            ) {
              const run = ensureSubagentRun(context, message.tool_use_id);
              run.taskId = message.task_id;
              // A stop that raced the spawn window fires now that the task id exists.
              if (context.pendingSubagentStops.delete(message.tool_use_id)) {
                yield* Effect.tryPromise(() => context.query.stopTask(message.task_id)).pipe(
                  Effect.catch((cause) =>
                    emitRuntimeError(
                      context,
                      `Failed to stop subagent task '${message.task_id}'.`,
                      cause,
                    ),
                  ),
                );
              }
            }
            if (message.task_type === "local_workflow") {
              context.liveWorkflowTaskIds.add(message.task_id);
              context.knownWorkflowTaskIds.add(message.task_id);
            } else if (
              context.liveWorkflowTaskIds.size === 1 &&
              // Ambient housekeeping tasks (each Bash call an agent makes
              // surfaces as its own local_bash task) are not workflow members;
              // tagging them floods the run panel with pseudo-agent rows.
              message.task_type !== "local_bash" &&
              message.skip_transcript !== true &&
              // Task-tool subagent spawns already surface in the subagent
              // strip via their collab item; tagging them too would list the
              // same agent twice (strip row + workflow member row).
              !(message.tool_use_id !== undefined && message.subagent_type !== undefined)
            ) {
              const [workflowTaskId] = context.liveWorkflowTaskIds;
              context.workflowTaskIdByMemberTaskId.set(message.task_id, workflowTaskId!);
            }
            const workflowTaskId = context.workflowTaskIdByMemberTaskId.get(message.task_id);
            const workflowScript =
              message.task_type === "local_workflow"
                ? yield* resolveWorkflowScriptText(context, message)
                : undefined;
            const workflowMeta = workflowScript
              ? parseClaudeWorkflowScriptMeta(workflowScript)
              : undefined;
            const workflowAgentPhases = workflowScript
              ? extractClaudeWorkflowAgentPhases(workflowScript)
              : undefined;
            const workflowAgentPlans = workflowScript
              ? extractClaudeWorkflowAgentPlans(workflowScript)
              : undefined;
            const workflowName = message.workflow_name ?? workflowMeta?.name;
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "task.started",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.task_type ? { taskType: message.task_type } : {}),
                ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
                ...(workflowName ? { workflowName } : {}),
                ...(workflowTaskId
                  ? { workflowTaskId: RuntimeTaskId.makeUnsafe(workflowTaskId) }
                  : {}),
                ...(workflowMeta?.phases ? { workflowPhases: workflowMeta.phases } : {}),
                ...(workflowAgentPhases ? { workflowAgentPhases } : {}),
                ...(workflowAgentPlans ? { workflowAgentPlans } : {}),
                ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
              },
            });
            return;
          }
          case "task_progress": {
            yield* emitTaskUsageSnapshot(context, message);
            // Workflow progress descriptions arrive as "<phase>: <label>" in agent
            // start order; the label list is what the transcript poller zips
            // against journal starts to attach labels to live snapshots.
            if (context.liveWorkflowTaskIds.has(message.task_id)) {
              const separator = message.description.indexOf(": ");
              const label = (
                separator > 0 ? message.description.slice(separator + 2) : message.description
              ).trim();
              if (label.length > 0) {
                const labels = context.workflowAgentLabels.get(message.task_id) ?? [];
                if (!labels.includes(label)) {
                  labels.push(label);
                  context.workflowAgentLabels.set(message.task_id, labels);
                }
              }
            }
            const workflowTaskId = context.workflowTaskIdByMemberTaskId.get(message.task_id);
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "task.progress",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
                ...(workflowTaskId
                  ? { workflowTaskId: RuntimeTaskId.makeUnsafe(workflowTaskId) }
                  : {}),
              },
            });
            return;
          }
          case "task_notification": {
            yield* emitTaskUsageSnapshot(context, message);
            const workflowTaskId = context.workflowTaskIdByMemberTaskId.get(message.task_id);
            // Settled workflows: the output file's workflowProgress carries the
            // final per-agent states/models the live stream never surfaced.
            const workflowOutputText =
              context.knownWorkflowTaskIds.has(message.task_id) &&
              typeof message.output_file === "string" &&
              message.output_file.length > 0
                ? yield* readClaudeWorkflowOutputText(fileSystem, message.output_file)
                : undefined;
            const parsedWorkflowAgents = workflowOutputText
              ? parseClaudeWorkflowProgressAgents(workflowOutputText)
              : undefined;
            // The output file carries no reasoning effort; the live poller saw
            // it on the transcripts, so carry it over by agent id at settle.
            const runtimeEffortByAgentId = new Map(
              Array.from(
                context.workflowRuntimeStates.get(message.task_id)?.agents.values() ?? [],
                (agent) => [agent.agentId, agent.effort] as const,
              ).filter((entry): entry is [string, string] => entry[1] !== undefined),
            );
            const workflowAgents = parsedWorkflowAgents?.map((agent) => {
              const effort = agent.agentId ? runtimeEffortByAgentId.get(agent.agentId) : undefined;
              return agent.effort === undefined && effort !== undefined
                ? Object.assign({}, agent, { effort })
                : agent;
            });
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "task.completed",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                status: message.status,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
                ...(workflowTaskId
                  ? { workflowTaskId: RuntimeTaskId.makeUnsafe(workflowTaskId) }
                  : {}),
                ...(workflowAgents ? { workflowAgents } : {}),
              },
            });
            context.liveWorkflowTaskIds.delete(message.task_id);
            context.knownWorkflowTaskIds.delete(message.task_id);
            context.workflowTaskIdByMemberTaskId.delete(message.task_id);
            context.workflowRuntimeStates.delete(message.task_id);
            yield* stopWorkflowRuntimePoller(context, message.task_id);
            const run = subagentRunForTask(context, message.tool_use_id, message.task_id);
            if (run) {
              context.subagentRuns.delete(run.toolUseId);
              context.pendingSubagentSteers.delete(run.toolUseId);
              context.pendingSubagentStops.delete(run.toolUseId);
              context.settledSubagentToolUseIds.set(run.toolUseId, message.status);
              if (run.context.turnState) {
                yield* completeTurn(run.context, claudeTaskTurnStatus(message.status));
              }
            }
            return;
          }
          case "files_persisted":
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "files.persisted",
              payload: {
                files: Array.isArray(message.files)
                  ? message.files.map((file: { filename: string; file_id: string }) => ({
                      filename: file.filename,
                      fileId: file.file_id,
                    }))
                  : [],
                ...(Array.isArray(message.failed)
                  ? {
                      failed: message.failed.map((entry: { filename: string; error: string }) => ({
                        filename: entry.filename,
                        error: entry.error,
                      })),
                    }
                  : {}),
              },
            });
            return;
          case "background_tasks_changed": {
            // REPLACE semantics: the payload is the full live background set.
            // Announce only newly backgrounded work with a one-line notice;
            // removals settle through their own task lifecycle events.
            const tasks = Array.isArray(message.tasks) ? message.tasks : [];
            const added = tasks.filter((task) => !context.knownBackgroundTaskIds.has(task.task_id));
            context.knownBackgroundTaskIds.clear();
            for (const task of tasks) {
              context.knownBackgroundTaskIds.add(task.task_id);
            }
            if (added.length === 0) {
              return;
            }
            const labels = added.map((task) =>
              task.description.trim().length > 0 ? task.description.trim() : task.task_type,
            );
            const notice =
              added.length === 1
                ? labels[0]!
                : `${added.length} tasks: ${labels.join(", ")}`.slice(0, 200);
            yield* emitRuntimeWarning(context, notice, message);
            return;
          }
          default:
            yield* warnUnhandledSdkKind(
              context,
              `system:${message.subtype}`,
              `Unhandled Claude system message subtype '${message.subtype}'.`,
              message,
            );
            return;
        }
      });

    const handleSdkTelemetryMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: message.type,
            payload: message,
          },
        };

        if (message.type === "tool_progress") {
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "tool.progress",
            payload: {
              toolUseId: message.tool_use_id,
              toolName: message.tool_name,
              elapsedSeconds: message.elapsed_time_seconds,
              ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
            },
          });
          return;
        }

        if (message.type === "tool_use_summary") {
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "tool.summary",
            payload: {
              summary: message.summary,
              ...(message.preceding_tool_use_ids.length > 0
                ? { precedingToolUseIds: message.preceding_tool_use_ids }
                : {}),
            },
          });
          return;
        }

        if (message.type === "auth_status") {
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "auth.status",
            payload: {
              isAuthenticating: message.isAuthenticating,
              output: message.output,
              ...(message.error ? { error: message.error } : {}),
            },
          });
          return;
        }

        if (message.type === "rate_limit_event") {
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "account.rate-limits.updated",
            payload: {
              rateLimits: message,
            },
          });
          return;
        }
      });

    const handleSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* logNativeSdkMessage(context, message);

        // Claude also sets parent_tool_use_id on async Bash progress, so route only
        // ids already recognized as Task/Agent tools onto child threads.
        const subagentToolUseId = recognizedSubagentParentToolUseId(context, message);
        if (subagentToolUseId !== undefined) {
          // A settled task's zombie tail (messages already in flight when the
          // stop landed) is dropped, not projected onto the settled child.
          if (context.settledSubagentToolUseIds.has(subagentToolUseId)) {
            return;
          }
          const run = ensureSubagentRun(context, subagentToolUseId);
          yield* ensureSyntheticTurn(run.context);
          switch (message.type) {
            case "stream_event":
              yield* handleStreamEvent(run.context, message);
              return;
            case "user":
              yield* handleUserMessage(run.context, message);
              return;
            case "assistant":
              yield* handleAssistantMessage(run.context, message);
              return;
            default:
              yield* handleSdkTelemetryMessage(run.context, message);
              return;
          }
        }

        yield* ensureThreadId(context, message);

        switch (message.type) {
          case "stream_event":
            yield* handleStreamEvent(context, message);
            return;
          case "user":
            yield* handleUserMessage(context, message);
            return;
          case "assistant":
            yield* handleAssistantMessage(context, message);
            return;
          case "result":
            yield* handleResultMessage(context, message);
            return;
          case "system":
            yield* handleSystemMessage(context, message);
            return;
          case "tool_progress":
          case "tool_use_summary":
          case "auth_status":
          case "rate_limit_event":
            yield* handleSdkTelemetryMessage(context, message);
            return;
          default:
            yield* warnUnhandledSdkKind(
              context,
              `type:${message.type}`,
              `Unhandled Claude SDK message type '${message.type}'.`,
              message,
            );
            return;
        }
      });

    const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
      Stream.fromAsyncIterable(context.query, (cause) =>
        toError(cause, "Claude runtime stream failed."),
      ).pipe(
        Stream.takeWhile(() => !context.stopped),
        Stream.runForEach((message) => handleSdkMessage(context, message)),
      );

    const handleStreamExit = (
      context: ClaudeSessionContext,
      exit: Exit.Exit<void, Error>,
    ): Effect.Effect<void, ProviderAdapterProcessError> =>
      Effect.gen(function* () {
        if (context.stopped) {
          return;
        }

        if (Exit.isFailure(exit)) {
          if (hasPendingUserInterrupt(context) || isClaudeInterruptedCause(exit.cause)) {
            if (context.turnState) {
              yield* completeTurn(
                context,
                "interrupted",
                interruptionMessageFromClaudeCause(exit.cause),
              );
            }
          } else if (isClaudeBenignTerminationCause(exit.cause)) {
            // External SIGTERM/SIGINT: a graceful stop, not a crash. Suspend the turn
            // without an error toast so the session resumes on the next message.
            // Marker for how often the expensive path fires: the next message on
            // this thread pays a full resume replay of the conversation.
            yield* Effect.logInfo("claude.session.benign_termination", {
              threadId: context.session.threadId,
              hadActiveTurn: context.turnState !== undefined,
              detail: messageFromClaudeStreamCause(exit.cause, "Claude runtime terminated."),
            });
            if (context.turnState) {
              yield* completeTurn(context, "interrupted", CLAUDE_BENIGN_TERMINATION_MESSAGE);
            }
          } else {
            const message = messageFromClaudeStreamCause(
              exit.cause,
              "Claude runtime stream failed.",
            );
            if (isClaudeMissingResumeConversationCause(exit.cause)) {
              // The SDK can accept a resumed query and report the missing
              // native conversation only after the prompt is queued. Drop the
              // dead native ids before completing the turn so ProviderService
              // persists a cursor without `resume`; the next dispatch then
              // starts a fresh Claude session and bootstraps Synara's retained
              // transcript instead of replaying the same broken id forever.
              context.resumeSessionId = undefined;
              context.lastAssistantUuid = undefined;
              // The map is the source for `turn.tasks.updated`, so clearing it
              // silently would strand the turn's task chips: the next dispatch
              // sees an empty map and emits no correction.
              if (context.trackedTasks.size > 0) {
                context.trackedTasks.clear();
                yield* emitTrackedTasksUpdated(context, {
                  rawPayload: { source: "claude.stale-resume-invalidated" },
                });
              }
              yield* Effect.logWarning("claude.session.stale_resume_invalidated", {
                threadId: context.session.threadId,
                detail: message,
              });
            }
            yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
            yield* completeTurn(context, "failed", message);
          }
        } else if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
        }

        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const performStopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void, ProviderAdapterProcessError> =>
      Effect.gen(function* () {
        context.stopped = true;
        context.gatewaySessionLease?.release();

        for (const [requestId, pending] of context.pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel");
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "request.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
            providerRefs: nativeProviderRefs(context),
          });
        }
        context.pendingApprovals.clear();

        for (const run of context.subagentRuns.values()) {
          if (run.context.turnState) {
            yield* completeTurn(run.context, "interrupted", "Session stopped.");
          }
        }
        context.subagentRuns.clear();
        context.pendingSubagentSteers.clear();
        context.pendingSubagentStops.clear();

        for (const taskId of Array.from(context.workflowRuntimePollers.keys())) {
          yield* stopWorkflowRuntimePoller(context, taskId);
        }
        context.liveWorkflowTaskIds.clear();
        context.knownWorkflowTaskIds.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        yield* Queue.shutdown(context.promptQueue);

        const streamFiber = context.streamFiber;
        context.streamFiber = undefined;
        if (streamFiber && streamFiber.pollUnsafe() === undefined) {
          yield* Fiber.interrupt(streamFiber);
        }

        // @effect-diagnostics-next-line tryCatchInEffectGen:off
        try {
          context.query.close();
        } catch (cause) {
          yield* emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
        }
        // Do not release session ownership until teardown proves the old
        // process tree exited. The stopped context remains non-routable and
        // prevents a replacement process from being spawned concurrently.
        yield* teardownClaudeProcess(context.session.threadId, context.processOwner);

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              reason: "Session stopped",
              exitKind: "graceful",
            },
            providerRefs: {},
          });
        }

        if (sessions.get(context.session.threadId) === context) {
          sessions.delete(context.session.threadId);
        }
      });

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void, ProviderAdapterProcessError> =>
      Effect.suspend(() => {
        if (context.stopDeferred) {
          return Deferred.await(context.stopDeferred);
        }
        const stopDeferred = Deferred.makeUnsafe<void, ProviderAdapterProcessError>();
        context.stopDeferred = stopDeferred;
        return performStopSessionInternal(context, options).pipe(
          Effect.onExit((exit) =>
            Deferred.done(stopDeferred, exit).pipe(
              Effect.andThen(
                Exit.isFailure(exit)
                  ? Effect.sync(() => {
                      if (context.stopDeferred === stopDeferred) {
                        delete context.stopDeferred;
                      }
                    })
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
          ),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const startSessionUnlocked: ClaudeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const threadId = input.threadId;
        const existingResumeSessionId = resumeState?.resume;
        const newSessionId =
          existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
        const sessionId = existingResumeSessionId ?? newSessionId;

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.filter((item) => item.type === "message"),
          Stream.map((item) => item.message),
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
          ),
          Stream.toAsyncIterable,
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const pendingSubagentSteers = new Map<string, Array<string>>();
        const pendingSubagentStops = new Set<string>();
        const inFlightTools = new Map<number, ToolInFlight>();
        const trackedTasks = new Map<string, ClaudeTrackedTask>(
          (resumeState?.trackedTasks ?? []).map((task) => [task.id, task]),
        );

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

        /**
         * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
         * runtime event and waiting for the user to respond via `respondToUserInput`.
         */
        const handleAskUserQuestion = (
          context: ClaudeSessionContext,
          toolInput: Record<string, unknown>,
          callbackOptions: { readonly signal: AbortSignal; readonly toolUseID?: string },
        ) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

            // Parse questions from the SDK's AskUserQuestion input.
            const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
            const questions: Array<UserInputQuestion> = rawQuestions.map(
              (q: Record<string, unknown>, idx: number) => ({
                id: typeof q.header === "string" ? q.header : `q-${idx}`,
                header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
                question: typeof q.question === "string" ? q.question : "",
                options: Array.isArray(q.options)
                  ? q.options.map((opt: Record<string, unknown>) => ({
                      label: typeof opt.label === "string" ? opt.label : "",
                      description: typeof opt.description === "string" ? opt.description : "",
                    }))
                  : [],
                multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
              }),
            );

            const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
            let aborted = false;
            const pendingInput: PendingUserInput = {
              questions,
              answers: answersDeferred,
            };

            // Emit user-input.requested so the UI can present the questions.
            const requestedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "user-input.requested",
              eventId: requestedStamp.eventId,
              provider: PROVIDER,
              createdAt: requestedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: { questions },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callbackOptions.toolUseID,
              }),
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/AskUserQuestion",
                payload: { toolName: "AskUserQuestion", input: toolInput },
              },
            });

            pendingUserInputs.set(requestId, pendingInput);

            // Handle abort (e.g. turn interrupted while waiting for user input).
            const onAbort = () => {
              if (!pendingUserInputs.has(requestId)) {
                return;
              }
              aborted = true;
              pendingUserInputs.delete(requestId);
              Effect.runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
            };
            callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

            // Block until the user provides answers.
            const answers = remapAnswersToClaudeQuestionText(
              questions,
              yield* Deferred.await(answersDeferred).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    callbackOptions.signal.removeEventListener("abort", onAbort);
                  }),
                ),
              ),
            );
            pendingUserInputs.delete(requestId);

            // Emit user-input.resolved so the UI knows the interaction completed.
            const resolvedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "user-input.resolved",
              eventId: resolvedStamp.eventId,
              provider: PROVIDER,
              createdAt: resolvedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: { answers },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callbackOptions.toolUseID,
              }),
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/AskUserQuestion/resolved",
                payload: { answers },
              },
            });

            if (aborted) {
              return {
                behavior: "deny",
                message: "User cancelled tool execution.",
              } satisfies PermissionResult;
            }

            // Return the answers to the SDK in the expected format:
            // { questions: [...], answers: { questionText: selectedLabel } }
            return {
              behavior: "allow",
              updatedInput: {
                questions: toolInput.questions,
                answers,
              },
            } satisfies PermissionResult;
          });

        // Host-side PreToolUse hook: the only SDK channel that reaches a RUNNING
        // subagent (inbound messages with parent_tool_use_id become main-thread
        // turns). Hook input `agent_id` equals the run's task_id. It fires on
        // every tool call, so the no-steer path must stay trivial; queued
        // messages are drained on the subagent's next tool call.
        const subagentSteerHook = async (hookInput: HookInput): Promise<HookJSONOutput> => {
          const agentId = "agent_id" in hookInput ? hookInput.agent_id : undefined;
          if (pendingSubagentSteers.size === 0 || typeof agentId !== "string") {
            return {};
          }
          return Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                return {};
              }
              let run: ClaudeSubagentRun | undefined;
              for (const candidate of context.subagentRuns.values()) {
                if (candidate.taskId === agentId) {
                  run = candidate;
                  break;
                }
              }
              const pending = run ? pendingSubagentSteers.get(run.toolUseId) : undefined;
              if (!run || !pending || pending.length === 0) {
                return {};
              }
              pendingSubagentSteers.delete(run.toolUseId);
              const message = pending.join("\n\n");
              yield* emitSubagentSteerDelivered(run, message);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  additionalContext: claudeSubagentSteerContext(message),
                },
              } satisfies HookJSONOutput;
            }),
          ).catch(() => ({}));
        };

        const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                return {
                  behavior: "deny",
                  message: "Claude session context is unavailable.",
                } satisfies PermissionResult;
              }

              // Handle AskUserQuestion: surface clarifying questions to the
              // user via the user-input runtime event channel, regardless of
              // runtime mode (plan mode relies on this heavily).
              if (toolName === "AskUserQuestion") {
                return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
              }

              if (toolName === "ExitPlanMode") {
                const planMarkdown = extractExitPlanModePlan(toolInput);
                if (planMarkdown) {
                  yield* emitProposedPlanCompleted(context, {
                    planMarkdown,
                    toolUseId: callbackOptions.toolUseID,
                    rawSource: "claude.sdk.permission",
                    rawMethod: "canUseTool/ExitPlanMode",
                    rawPayload: {
                      toolName,
                      input: toolInput,
                    },
                  });
                }

                return {
                  behavior: "deny",
                  message:
                    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                } satisfies PermissionResult;
              }

              const runtimeMode = input.runtimeMode ?? "full-access";
              if (runtimeMode === "full-access") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                } satisfies PermissionResult;
              }

              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const requestType = classifyRequestType(toolName);
              const detail = summarizeToolRequest(toolName, toolInput);
              const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
              const pendingApproval: PendingApproval = {
                requestType,
                detail,
                decision: decisionDeferred,
                ...(callbackOptions.suggestions
                  ? { suggestions: callbackOptions.suggestions }
                  : {}),
              };

              const requestedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent(context, {
                type: "request.opened",
                eventId: requestedStamp.eventId,
                provider: PROVIDER,
                createdAt: requestedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  detail,
                  args: {
                    toolName,
                    input: toolInput,
                    ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
                  },
                },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/request",
                  payload: {
                    toolName,
                    input: toolInput,
                  },
                },
              });

              pendingApprovals.set(requestId, pendingApproval);

              const onAbort = () => {
                if (!pendingApprovals.has(requestId)) {
                  return;
                }
                pendingApprovals.delete(requestId);
                Effect.runFork(Deferred.succeed(decisionDeferred, "cancel"));
              };

              callbackOptions.signal.addEventListener("abort", onAbort, {
                once: true,
              });

              const decision = yield* Deferred.await(decisionDeferred).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    callbackOptions.signal.removeEventListener("abort", onAbort);
                  }),
                ),
              );
              pendingApprovals.delete(requestId);

              const resolvedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent(context, {
                type: "request.resolved",
                eventId: resolvedStamp.eventId,
                provider: PROVIDER,
                createdAt: resolvedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  decision,
                },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/decision",
                  payload: {
                    decision,
                  },
                },
              });

              if (decision === "accept" || decision === "acceptForSession") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                  ...(decision === "acceptForSession" && pendingApproval.suggestions
                    ? { updatedPermissions: [...pendingApproval.suggestions] }
                    : {}),
                } satisfies PermissionResult;
              }

              return {
                behavior: "deny",
                message:
                  decision === "cancel"
                    ? "User cancelled tool execution."
                    : "User declined tool execution.",
              } satisfies PermissionResult;
            }),
          );

        const providerOptions = input.providerOptions?.claudeAgent;
        const modelSelection =
          input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
        const requestedEffort = trimOrNull(modelSelection?.options?.effort ?? null);
        const requestedAutoCompactWindow = trimOrNull(
          modelSelection?.options?.autoCompactWindow ??
            modelSelection?.options?.contextWindow ??
            null,
        );
        const effectiveClaudeModel = modelSelection?.model ?? getDefaultModel("claudeAgent");
        const caps = getModelCapabilities("claudeAgent", effectiveClaudeModel);
        const requestedAutoCompactWindowTokens = resolveSelectedClaudeAutoCompactWindow(
          effectiveClaudeModel,
          requestedAutoCompactWindow,
        );
        const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
        const effort =
          requestedEffort && hasEffortLevel(caps, requestedEffort) ? requestedEffort : null;
        const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
        const thinking = resolveSelectedClaudeThinkingToggle(
          effectiveClaudeModel,
          modelSelection?.options?.thinking,
        );
        const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
        const ultracode = effort === "ultracode" && hasEffortLevel(caps, "xhigh");
        const permissionMode =
          toPermissionMode(providerOptions?.permissionMode) ??
          (input.runtimeMode === "full-access" ? "bypassPermissions" : undefined);
        const settings = {
          // Native 1M models otherwise compact near their full model limit. Keep
          // Synara's safer 200k budget explicit unless the thread opts into 1M.
          autoCompactEnabled: true,
          ...(requestedAutoCompactWindowTokens !== undefined
            ? { autoCompactWindow: requestedAutoCompactWindowTokens }
            : {}),
          ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
          // Non-max effort lives in the flag-settings layer so later selection
          // changes apply live via applyFlagSettings instead of a restart-and-
          // resume replay. `max` has no Settings equivalent (effortLevel caps
          // at xhigh) and stays a spawn-time query option below.
          ...(effectiveEffort && effectiveEffort !== "max" ? { effortLevel: effectiveEffort } : {}),
          ...(fastMode ? { fastMode: true } : {}),
          ...(ultracode ? { ultracode: true } : {}),
        };
        const claudeSubagents = buildClaudeSdkSubagents();
        const claudeSdkEnv = yield* resolveClaudeSdkEnv;
        const failedStartupProcessOwner = failedStartupProcessOwners.get(threadId);
        if (failedStartupProcessOwner) {
          // A prior createQuery failure may have happened after spawning. Do
          // not create another runtime until that orphan's exit is proven.
          yield* teardownFailedStartupProcess(threadId, failedStartupProcessOwner);
        }
        const existing = sessions.get(threadId);
        if (existing) {
          // Retire and prove the old process tree before spawning its replacement.
          // A replacement spawn failure is truthfully a stopped session, never two runtimes.
          yield* stopSessionInternal(existing, { emitExitEvent: false });
        }
        const processOwner: ClaudeProcessOwner = {};

        const gatewaySessionLease = acquireAgentGatewaySessionLease(
          agentGatewayCredentials,
          threadId,
          PROVIDER,
        );
        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          // Keep Claude context-window selection model-driven so session start
          // and in-session switches both use the same API model contract.
          ...(apiModelId ? { model: apiModelId } : {}),
          pathToClaudeCodeExecutable: providerOptions?.binaryPath ?? "claude",
          settingSources: [...CLAUDE_SETTING_SOURCES],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: buildEmbeddedClaudeSystemPromptAppend(agentGatewayCredentials !== undefined),
            // Strip per-user dynamic sections (working directory, auto-memory
            // path) into the first user message so the cached system-prompt
            // prefix stays static across sessions and users. Tradeoff: that
            // context steers marginally less authoritatively from a user turn.
            excludeDynamicSections: true,
          },
          ...(Object.keys(claudeSubagents).length > 0 ? { agents: claudeSubagents } : {}),
          // Only `max` effort is spawn-fixed; every other level rides in
          // `settings.effortLevel` so it can change live mid-session.
          ...(effectiveEffort === "max" ? { effort: "max" as const } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          settings,
          ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
          ...(newSessionId ? { sessionId: newSessionId } : {}),
          includePartialMessages: true,
          // Forward full subagent conversations (text + thinking) tagged with
          // parent_tool_use_id so child threads can stream live.
          forwardSubagentText: true,
          hooks: {
            PreToolUse: [{ hooks: [subagentSteerHook] }],
          },
          canUseTool,
          env: claudeSdkEnv,
          spawnClaudeCodeProcess: bindClaudeProcessOwner(processOwner),
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
          ...(agentGatewayCredentials
            ? {
                mcpServers: buildClaudeMcpServers(gatewaySessionLease!.connection),
              }
            : {}),
        };

        const queryRuntime = yield* Effect.tryPromise({
          try: () =>
            createQuery({
              prompt,
              options: queryOptions,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        }).pipe(
          Effect.tapError(() =>
            Effect.all([
              teardownClaudeProcess(threadId, processOwner).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    if (processOwner.process) {
                      failedStartupProcessOwners.set(threadId, processOwner);
                    }
                  }).pipe(
                    Effect.andThen(
                      Effect.logWarning("claude.session.failed_start_teardown_unproven", {
                        threadId,
                        detail: error.message,
                      }),
                    ),
                  ),
                ),
              ),
              gatewaySessionLease ? Effect.sync(gatewaySessionLease.release) : Effect.void,
            ]).pipe(Effect.asVoid),
          ),
        );

        let installationContext: ClaudeSessionContext | undefined;
        let installationComplete = false;

        return yield* Effect.gen(function* () {
          // Populate model cache in background from first session
          if (!cachedModels) {
            queryRuntime
              .supportedModels()
              .then((models) => {
                cachedModels = {
                  models: models.map((m) => ({ slug: m.value, name: m.displayName })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {
                /* ignore discovery failures */
              });
          }

          // Populate agent cache in background from first session
          if (!cachedAgents) {
            queryRuntime
              .supportedAgents()
              .then((agents) => {
                cachedAgents = {
                  agents: agents.map((a) => ({
                    name: a.name,
                    displayName: a.name,
                    ...(a.description ? { description: a.description } : {}),
                    ...(a.model ? { model: a.model } : {}),
                  })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {
                /* ignore discovery failures */
              });
          }

          const session: ProviderSession = {
            threadId,
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(threadId ? { threadId } : {}),
            resumeCursor: {
              ...(threadId ? { threadId } : {}),
              ...(sessionId ? { resume: sessionId } : {}),
              ...(resumeState?.resumeSessionAt
                ? { resumeSessionAt: resumeState.resumeSessionAt }
                : {}),
              turnCount: resumeState?.turnCount ?? 0,
              ...(trackedTasks.size > 0 ? { trackedTasks: Array.from(trackedTasks.values()) } : {}),
            },
            createdAt: startedAt,
            updatedAt: startedAt,
          };

          const context: ClaudeSessionContext = {
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            session,
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            promptQueue,
            query: queryRuntime,
            processOwner,
            streamFiber: undefined,
            startedAt,
            basePermissionMode: permissionMode,
            // A fresh CLI starts in `permissionMode` when queryOptions provides
            // one, otherwise the SDK's "default" mode (queryOptions omits it).
            spawnPermissionMode: permissionMode ?? "default",
            firstTurnSpawnModeAuthoritative: true,
            lastInteractionMode: undefined,
            currentApiModelId: apiModelId,
            resumeSessionId: sessionId,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            inFlightTools,
            trackedTasks,
            turnState: undefined,
            lastTurnId: undefined,
            interruptRequestedTurnId: undefined,
            lastKnownContextWindow: resolveClaudeApiModelIdContextWindowMaxTokens(
              apiModelId ?? effectiveClaudeModel,
            ),
            currentAutoCompactWindow: requestedAutoCompactWindowTokens,
            currentAlwaysThinkingEnabled: thinking,
            currentEffort: effectiveEffort,
            currentUltracode: ultracode,
            currentFastMode: fastMode,
            lastKnownAutoCompactThreshold: requestedAutoCompactWindowTokens,
            contextUsageControlEnabled: true,
            lastKnownTokenUsage: undefined,
            lastAssistantUuid: resumeState?.resumeSessionAt,
            lastThreadStartedId: undefined,
            rerouteOriginalApiModelId: undefined,
            emittedContextUsageWarnings: new Set(),
            stopped: false,
            warnedUnhandledSdkKinds: new Set(),
            subagentRuns: new Map(),
            pendingSubagentSteers,
            pendingSubagentStops,
            knownBackgroundTaskIds: new Set(),
            settledSubagentToolUseIds: new Map(),
            liveWorkflowTaskIds: new Set(),
            knownWorkflowTaskIds: new Set(),
            workflowTaskIdByMemberTaskId: new Map(),
            workflowRuntimePollers: new Map(),
            workflowAgentLabels: new Map(),
            workflowRuntimeStates: new Map(),
          };
          installationContext = context;
          yield* Effect.gen(function* () {
            yield* Ref.set(contextRef, context);
            sessions.set(threadId, context);

            const sessionStartedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "session.started",
              eventId: sessionStartedStamp.eventId,
              provider: PROVIDER,
              createdAt: sessionStartedStamp.createdAt,
              threadId,
              payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
              providerRefs: {},
            });

            const configuredStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "session.configured",
              eventId: configuredStamp.eventId,
              provider: PROVIDER,
              createdAt: configuredStamp.createdAt,
              threadId,
              payload: {
                config: {
                  ...(modelSelection?.model ? { model: modelSelection.model } : {}),
                  ...(apiModelId ? { apiModelId } : {}),
                  autoCompactWindow: requestedAutoCompactWindowTokens ?? null,
                  ...(input.cwd ? { cwd: input.cwd } : {}),
                  ...(effectiveEffort ? { effort: effectiveEffort } : {}),
                  ...(permissionMode ? { permissionMode } : {}),
                  ...(providerOptions?.maxThinkingTokens !== undefined
                    ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
                    : {}),
                  ...(fastMode ? { fastMode: true } : {}),
                  ...(ultracode ? { ultracode: true } : {}),
                },
              },
              providerRefs: {},
            });

            const readyStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "session.state.changed",
              eventId: readyStamp.eventId,
              provider: PROVIDER,
              createdAt: readyStamp.createdAt,
              threadId,
              payload: {
                state: "ready",
              },
              providerRefs: {},
            });

            if (context.currentAutoCompactWindow === CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["1m"]) {
              context.emittedContextUsageWarnings.add("one-million-window");
              yield* emitRuntimeWarning(
                context,
                "Claude's auto-compact budget is set to the model's 1M limit for this thread. Long conversations can consume usage limits much faster; switch Auto-compact to 200k unless the larger working context is intentional.",
              );
            }

            const streamFiber = Effect.runFork(runSdkStream(context));
            context.streamFiber = streamFiber;
            streamFiber.addObserver((exit) => {
              if (context.stopped) {
                return;
              }
              if (context.streamFiber === streamFiber) {
                context.streamFiber = undefined;
              }
              Effect.runFork(handleStreamExit(context, exit));
            });
          });

          installationComplete = true;
          return {
            ...session,
          };
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (installationComplete) {
                return Effect.void;
              }
              if (installationContext !== undefined) {
                return stopSessionInternal(installationContext, {
                  emitExitEvent: false,
                }).pipe(Effect.ignore);
              }
              return Effect.gen(function* () {
                gatewaySessionLease?.release();
                yield* Queue.shutdown(promptQueue);
                const closeExit = yield* Effect.exit(Effect.sync(() => queryRuntime.close()));
                if (Exit.isFailure(closeExit)) {
                  yield* Effect.logWarning("claude.session.failed_install_cleanup", {
                    threadId,
                    cause: Cause.pretty(closeExit.cause),
                  });
                }
                yield* teardownClaudeProcess(threadId, processOwner);
              });
            }).pipe(Effect.ignore),
          ),
        );
      });

    const startSession: ClaudeAdapterShape["startSession"] = (input) =>
      withSessionLifecycleLock(input.threadId, startSessionUnlocked(input));

    const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const modelSelection =
          input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
        const requestedAutoCompactWindow = resolveSelectedClaudeAutoCompactWindow(
          modelSelection?.model,
          modelSelection?.options?.autoCompactWindow ?? modelSelection?.options?.contextWindow,
        );

        if (context.turnState) {
          // Auto-close a stale synthetic turn (from background agent responses
          // between user prompts) to prevent blocking the user's next turn.
          yield* completeTurn(context, "completed");
        }

        if (hasOnlyCompletedClaudeTasks(context.trackedTasks)) {
          context.trackedTasks.clear();
          yield* updateResumeCursor(context);
        }

        if (modelSelection?.model) {
          const apiModelId = resolveApiModelId(modelSelection);
          if (apiModelId !== context.currentApiModelId) {
            yield* Effect.tryPromise({
              try: () => context.query.setModel(apiModelId),
              catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
            });
          }
          context.currentApiModelId = apiModelId;
          context.rerouteOriginalApiModelId = undefined;
          context.lastKnownContextWindow =
            resolveClaudeApiModelIdContextWindowMaxTokens(apiModelId);
          yield* updateResumeCursor(context);
        }

        if (modelSelection && requestedAutoCompactWindow !== context.currentAutoCompactWindow) {
          yield* Effect.tryPromise({
            try: () =>
              context.query.applyFlagSettings({
                autoCompactWindow: requestedAutoCompactWindow ?? null,
              }),
            catch: (cause) => toRequestError(input.threadId, "turn/applyFlagSettings", cause),
          });
          context.currentAutoCompactWindow = requestedAutoCompactWindow;
          context.lastKnownAutoCompactThreshold = requestedAutoCompactWindow;
          context.emittedContextUsageWarnings.delete("near-window");
          context.emittedContextUsageWarnings.delete("large-prompt");

          const configuredWindow =
            requestedAutoCompactWindow !== undefined
              ? { autoCompactWindow: requestedAutoCompactWindow }
              : context.lastKnownContextWindow !== undefined
                ? { contextWindow: context.lastKnownContextWindow }
                : { autoCompactWindow: null };
          const configuredStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "session.configured",
            eventId: configuredStamp.eventId,
            provider: PROVIDER,
            createdAt: configuredStamp.createdAt,
            threadId: input.threadId,
            payload: { config: configuredWindow },
            providerRefs: nativeProviderRefs(context),
          });
        }

        // The thinking toggle mirrors the spawn-time `alwaysThinkingEnabled`
        // setting; flipping it live avoids a restart-and-resume replay.
        const requestedThinking = resolveSelectedClaudeThinkingToggle(
          modelSelection?.model,
          modelSelection?.options?.thinking,
        );
        if (modelSelection && requestedThinking !== context.currentAlwaysThinkingEnabled) {
          yield* Effect.tryPromise({
            try: () =>
              context.query.applyFlagSettings({
                alwaysThinkingEnabled: requestedThinking ?? null,
              }),
            catch: (cause) => toRequestError(input.threadId, "turn/applyFlagSettings", cause),
          });
          context.currentAlwaysThinkingEnabled = requestedThinking;
        }

        // Effort, fast mode, and ultracode are Settings keys too, so selection
        // changes apply live instead of forcing a restart-and-resume replay.
        // `max` effort has no Settings equivalent; transitions involving it
        // restart upstream (claudeSelectionRequiresRestart) before this runs.
        if (modelSelection) {
          const turnCaps = getModelCapabilities("claudeAgent", modelSelection.model);
          const requestedEffortOption = trimOrNull(modelSelection.options?.effort ?? null);
          const validEffort =
            requestedEffortOption && hasEffortLevel(turnCaps, requestedEffortOption)
              ? requestedEffortOption
              : null;
          const requestedEffort = getEffectiveClaudeCodeEffort(validEffort);
          const requestedUltracode =
            validEffort === "ultracode" && hasEffortLevel(turnCaps, "xhigh");
          const requestedFastMode =
            modelSelection.options?.fastMode === true && turnCaps.supportsFastMode;
          const effortChanged =
            requestedEffort !== context.currentEffort &&
            requestedEffort !== "max" &&
            context.currentEffort !== "max";
          const ultracodeChanged = requestedUltracode !== context.currentUltracode;
          const fastModeChanged = requestedFastMode !== context.currentFastMode;
          if (effortChanged || ultracodeChanged || fastModeChanged) {
            yield* Effect.tryPromise({
              try: () =>
                context.query.applyFlagSettings({
                  ...(effortChanged
                    ? { effortLevel: requestedEffort as Exclude<ClaudeApiEffort, "max"> | null }
                    : {}),
                  ...(ultracodeChanged ? { ultracode: requestedUltracode ? true : null } : {}),
                  ...(fastModeChanged ? { fastMode: requestedFastMode ? true : null } : {}),
                }),
              catch: (cause) => toRequestError(input.threadId, "turn/applyFlagSettings", cause),
            });
            if (effortChanged) {
              context.currentEffort = requestedEffort;
            }
            context.currentUltracode = requestedUltracode;
            context.currentFastMode = requestedFastMode;
          }
        }

        // Apply interaction mode on every turn so sticky SDK permission state
        // cannot leak plan mode across service/recovery paths that omit it.
        // The desired mode is computed exactly as before. We skip the control
        // request in exactly one provable case: the first turn of a session
        // whose desired mode equals the mode the CLI spawned in — sending it
        // there would be redundant AND would block that first turn on the CLI's
        // init handshake. In every other case we send unconditionally, because
        // once any prompt has run the CLI's mode is opaque (`canUseTool` is
        // shadowed under bypassPermissions, so a future mode-changing tool could
        // diverge from anything we tracked); only the pre-first-prompt state is
        // provable.
        const effectiveInteractionMode = input.interactionMode ?? "default";
        const desiredPermissionMode: PermissionMode | undefined =
          effectiveInteractionMode === "plan"
            ? "plan"
            : context.basePermissionMode !== undefined || context.lastInteractionMode === "plan"
              ? (context.basePermissionMode ?? "default")
              : undefined;
        const canSkipRedundantSpawnModeRequest =
          context.firstTurnSpawnModeAuthoritative &&
          desiredPermissionMode === context.spawnPermissionMode;
        if (desiredPermissionMode !== undefined && !canSkipRedundantSpawnModeRequest) {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode(desiredPermissionMode),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        }

        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const turnState: ClaudeTurnState = {
          turnId,
          startedAt: yield* nowIso,
          interactionMode: effectiveInteractionMode,
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          sawFileChange: false,
          nextSyntheticAssistantBlockIndex: -1,
          assistantMessageBlockBase: 0,
        };

        const updatedAt = yield* nowIso;
        context.turnState = turnState;
        context.lastTurnId = turnId;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: context.currentApiModelId
            ? { model: stripClaudeContextWindowSuffix(context.currentApiModelId) }
            : modelSelection?.model
              ? { model: modelSelection.model }
              : {},
          providerRefs: {},
        });

        if (hasUnfinishedClaudeTasks(context.trackedTasks)) {
          yield* emitTrackedTasksUpdated(context, {
            rawPayload: {
              source: "claude.resume-cursor",
              trackedTaskCount: context.trackedTasks.size,
            },
          });
        }

        const message = yield* buildUserMessageEffect(input, {
          fileSystem,
          attachmentsDir: serverConfig.attachmentsDir,
        });

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

        // The first prompt has been dispatched; the CLI's spawn mode is no longer
        // provably its current mode, so subsequent turns re-send unconditionally.
        context.firstTurnSpawnModeAuthoritative = false;

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (
      threadId,
      _turnId,
      providerThreadId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);

        // A subagent provider thread id targets one Task tool spawn: stop that task
        // instead of interrupting the whole turn. Before task_started maps the tool
        // use to a task id there is nothing to stop yet, so queue the request and
        // fire it the moment the mapping lands (backgrounding is not stopping).
        if (providerThreadId !== undefined) {
          // Already settled: nothing to stop, and queueing would leak a stop
          // that could fire on an unrelated future task.
          if (context.settledSubagentToolUseIds.has(providerThreadId)) {
            return;
          }
          const taskId = context.subagentRuns.get(providerThreadId)?.taskId;
          if (taskId === undefined) {
            context.pendingSubagentStops.add(providerThreadId);
            return;
          }
          yield* Effect.tryPromise({
            try: () => context.query.stopTask(taskId),
            catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
          });
          return;
        }

        if (context.turnState) {
          context.interruptRequestedTurnId = context.turnState.turnId;
        }
        const acknowledged = yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        }).pipe(Effect.timeoutOption(CLAUDE_INTERRUPT_TIMEOUT));
        if (Option.isNone(acknowledged)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/interrupt",
            detail: `The Claude CLI did not acknowledge the interrupt within ${Duration.toMillis(
              CLAUDE_INTERRUPT_TIMEOUT,
            )}ms.`,
          });
        }
      });

    // Stops one background task by its SDK task id (workflow runs and their member
    // agents included); the SDK answers with a task_notification status "stopped".
    const stopTask: ClaudeAdapterShape["stopTask"] = (threadId, taskId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.stopTask(taskId),
          catch: (cause) => toRequestError(threadId, "task/stop", cause),
        });
      });

    // Moves one in-flight foreground Task call to the background (the CLI's
    // Ctrl+B): the blocking Task tool_result returns immediately, the parent
    // turn continues, and the task settles later via task_notification.
    const backgroundTask: ClaudeAdapterShape["backgroundTask"] = (threadId, toolUseId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.backgroundTasks(toolUseId).then(() => undefined),
          catch: (cause) => toRequestError(threadId, "task/background", cause),
        });
      });

    // Queues a mid-task user message for one running subagent; the PreToolUse
    // hook injects it as additionalContext on the subagent's next tool call.
    const steerSubagent: ClaudeAdapterShape["steerSubagent"] = (
      threadId,
      providerThreadId,
      input,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!context.subagentRuns.has(providerThreadId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/steerSubagent",
            detail: `Subagent '${providerThreadId}' already finished; the message was not delivered.`,
          });
        }
        // The PreToolUse hook channel is text-only: project every attachment
        // (images included) as a disk-path reference the subagent can read
        // with its own tools.
        const attachmentsBlock = buildFileAttachmentsPromptBlock({
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
          includeImage: () => true,
        });
        const message = [input.input, attachmentsBlock]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const pending = context.pendingSubagentSteers.get(providerThreadId) ?? [];
        pending.push(message);
        context.pendingSubagentSteers.set(providerThreadId, pending);
      });

    const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue:
            `Claude rollback requires a session restart for thread '${threadId}'. ` +
            "ProviderService owns that restart and retained-transcript bootstrap.",
        }),
      );

    const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }

        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/respondToUserInput",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        context.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.answers, answers);
      });

    const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
      withSessionLifecycleLock(
        threadId,
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (!context) {
            return;
          }
          yield* stopSessionInternal(context, {
            emitExitEvent: true,
          });
        }),
      );

    const listSessions: ClaudeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    // Native command discovery cache — avoids spawning a process per query.
    let commandsCache: { result: ProviderListCommandsResult; cwd: string } | null = null;
    let pendingCommandDiscovery: Promise<ProviderListCommandsResult> | null = null;

    async function discoverCommandsViaTemporaryProcess(
      cwd: string,
      env: NodeJS.ProcessEnv,
    ): Promise<ProviderListCommandsResult> {
      // Never spawn another discovery process until every previously unproven
      // process tree has been reaped successfully.
      await Effect.runPromise(teardownFailedCommandDiscoveryProcesses());

      // Spawn a lightweight Claude Code process for native command discovery.
      // The SDK's supportedCommands() awaits an internal initialization promise
      // that only resolves when the async generator is iterated (driving the
      // subprocess handshake). We iterate in the background to unblock it.
      const processOwner: ClaudeProcessOwner = {};
      let tempQuery: ClaudeQueryRuntime | undefined;

      try {
        // Query construction itself may invoke the spawn callback before
        // throwing, so it belongs inside the same ownership boundary.
        tempQuery = await createQuery({
          prompt: neverResolvingUserMessageStream(),
          options: {
            cwd,
            pathToClaudeCodeExecutable: "claude",
            settingSources: [...CLAUDE_SETTING_SOURCES],
            permissionMode: "plan" as PermissionMode,
            persistSession: false,
            env,
            spawnClaudeCodeProcess: bindClaudeProcessOwner(processOwner),
          },
        });
        const queryRuntime = tempQuery;

        // Drive the iterator so the subprocess completes its init handshake.
        // This runs in the background; close() in the finally block stops it.
        void (async () => {
          for await (const message of queryRuntime) {
            void message;
            /* consume until closed */
          }
        })().catch(() => undefined);

        const commands = await queryRuntime.supportedCommands();
        return mapSupportedCommands(commands);
      } finally {
        try {
          tempQuery?.close();
        } finally {
          await Effect.runPromise(teardownCommandDiscoveryProcess(processOwner));
        }
      }
    }

    const listCommands: NonNullable<ClaudeAdapterShape["listCommands"]> = (
      input: ProviderListCommandsInput,
    ) =>
      Effect.gen(function* () {
        // 1. Try an active session first (cheapest path).
        const context = input.threadId
          ? sessions.get(ThreadId.makeUnsafe(input.threadId))
          : [...sessions.values()].find((s) => !s.stopped);

        if (context && !context.stopped) {
          const commands = yield* Effect.tryPromise({
            try: () => context.query.supportedCommands(),
            catch: (cause) => toRequestError(context.session.threadId, "listCommands", cause),
          });
          const result = mapSupportedCommands(commands);
          commandsCache = { result, cwd: input.cwd };
          return result;
        }

        // 2. Return from cache if valid and not force-reloading.
        if (commandsCache && commandsCache.cwd === input.cwd && !input.forceReload) {
          return { ...commandsCache.result, cached: true } satisfies ProviderListCommandsResult;
        }

        // 3. Spawn a temporary process for discovery (deduplicating concurrent requests).
        const claudeSdkEnv = yield* resolveClaudeSdkEnv;
        const discoveryPromise =
          pendingCommandDiscovery ?? discoverCommandsViaTemporaryProcess(input.cwd, claudeSdkEnv);
        pendingCommandDiscovery = discoveryPromise;

        const result = yield* Effect.tryPromise({
          try: () => discoveryPromise,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("discovery"),
              detail: toMessage(cause, "Failed to discover Claude commands."),
              cause,
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pendingCommandDiscovery = null;
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              pendingCommandDiscovery = null;
            }),
          ),
        );

        commandsCache = { result, cwd: input.cwd };
        return result;
      });

    const listSkills: NonNullable<ClaudeAdapterShape["listSkills"]> = (
      _input: ProviderListSkillsInput,
    ) =>
      Effect.succeed({
        skills: [],
        source: "unsupported",
        cached: false,
      } satisfies ProviderListSkillsResult);

    const stopAll: ClaudeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          sessions,
          ([, context]) =>
            stopSessionInternal(context, {
              emitExitEvent: true,
            }),
          { discard: true },
        );
        yield* Effect.forEach(
          failedStartupProcessOwners,
          ([threadId, owner]) => teardownFailedStartupProcess(threadId, owner),
          { discard: true },
        );
        yield* teardownFailedCommandDiscoveryProcesses();
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          sessions,
          ([, context]) =>
            stopSessionInternal(context, {
              emitExitEvent: false,
            }),
          { discard: true },
        );
        yield* Effect.forEach(
          failedStartupProcessOwners,
          ([threadId, owner]) => teardownFailedStartupProcess(threadId, owner),
          { discard: true },
        );
        yield* teardownFailedCommandDiscoveryProcesses();
      }).pipe(Effect.ignore, Effect.andThen(Queue.shutdown(runtimeEventQueue))),
    );

    const composerCapabilities: ProviderComposerCapabilities = {
      provider: PROVIDER,
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: false,
      supportsThreadImport: true,
    };

    const getComposerCapabilities: NonNullable<
      ClaudeAdapterShape["getComposerCapabilities"]
    > = () => Effect.succeed(composerCapabilities);

    const listModels: NonNullable<ClaudeAdapterShape["listModels"]> = (_input) =>
      Effect.sync(() => {
        if (cachedModels) {
          return { ...cachedModels, cached: true };
        }
        // Fallback: try to get models from any active session
        for (const [, context] of sessions) {
          if (!context.stopped && context.query) {
            // Trigger async cache population
            context.query
              .supportedModels()
              .then((models) => {
                cachedModels = {
                  models: models.map((m) => ({ slug: m.value, name: m.displayName })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {});
            break;
          }
        }
        // Return empty while waiting for cache
        return { models: [], source: "pending", cached: false };
      });

    const listAgents: NonNullable<ClaudeAdapterShape["listAgents"]> = (_input) =>
      Effect.sync(() => {
        if (cachedAgents) {
          return { ...cachedAgents, cached: true };
        }
        for (const [, context] of sessions) {
          if (!context.stopped && context.query) {
            context.query
              .supportedAgents()
              .then((agents) => {
                cachedAgents = {
                  agents: agents.map((a) => ({
                    name: a.name,
                    displayName: a.name,
                    ...(a.description ? { description: a.description } : {}),
                    ...(a.model ? { model: a.model } : {}),
                  })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {});
            break;
          }
        }
        return { agents: [], source: "pending", cached: false };
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: "restart-session",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      stopTask,
      backgroundTask,
      steerSubagent,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      getComposerCapabilities,
      listCommands,
      listSkills,
      listModels,
      listAgents,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeAdapterShape;
  });
}

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
