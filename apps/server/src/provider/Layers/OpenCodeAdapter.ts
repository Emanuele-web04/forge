import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type ProviderKind,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Layer, Option, Queue, Ref, Scope, Stream } from "effect";
import type {
  AssistantMessage,
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
  Todo,
} from "@opencode-ai/sdk/v2";

import { resolveProviderAttachmentPath } from "../providerAttachmentPaths.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { takeSynaraHarnessPolicyForProviderSession } from "../../agentGateway/harnessPolicy.ts";
import { buildOpenCodeMcpServer, SYNARA_MCP_SERVER_NAME } from "../../agentGateway/mcpInjection.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { KiloAdapter, type KiloAdapterShape } from "../Services/KiloAdapter.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  buildOpenCodePermissionRules,
  KILO_CLI_SPEC,
  type OpenCodeCliModelDescriptor,
  type OpenCodeCompatibleCliSpec,
  type OpenCodeInventory,
  OPENCODE_CLI_SPEC,
  type OpenCodeRuntimeShape,
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { extractProposedPlanMarkdown, withProviderPlanModePrompt } from "../planMode.ts";
import { makeRuntimeTaskListItem, nonEmptyRuntimeTaskListPayload } from "../runtimeTaskList.ts";
import {
  buildOpenCodeModelContextLimitMap,
  emptyOpenCodeModelInventory,
  flattenOpenCodeAgents,
  flattenOpenCodeCommands,
  flattenOpenCodeCliModels,
  flattenOpenCodeModels,
  isUnsupportedOpenCodeCommandListError,
  mergeOpenCodeCliModelDescriptors,
  resolvePreferredOpenCodeModelProviders,
} from "../OpenCodeDiscovery.ts";
import { nonNegativeFiniteNumber, nonNegativeInteger, positiveInteger } from "../tokenUsage.ts";

export { flattenOpenCodeCliModels, flattenOpenCodeModels, resolvePreferredOpenCodeModelProviders };

type OpenCodeCompatibleProvider = Extract<ProviderKind, "opencode" | "kilo">;

interface OpenCodeCompatibleAdapterConfig {
  readonly provider: OpenCodeCompatibleProvider;
  readonly displayName: string;
  readonly defaultBinaryPath: string;
  readonly providerOptionsKey: OpenCodeCompatibleProvider;
  readonly runtimeEventSource: "opencode.sdk.event" | "kilo.sdk.event";
  readonly turnIdPrefix: string;
  readonly cliModelSource: string;
  readonly fallbackModelSource: string;
  readonly defaultAgent: string;
  readonly planAgent: string;
  readonly cliSpec: OpenCodeCompatibleCliSpec;
}

const OPENCODE_ADAPTER_CONFIG: OpenCodeCompatibleAdapterConfig = {
  provider: "opencode",
  displayName: "OpenCode",
  defaultBinaryPath: "opencode",
  providerOptionsKey: "opencode",
  runtimeEventSource: "opencode.sdk.event",
  turnIdPrefix: "opencode-turn",
  cliModelSource: "opencode-cli",
  fallbackModelSource: "opencode",
  defaultAgent: "build",
  planAgent: "plan",
  cliSpec: OPENCODE_CLI_SPEC,
};

const KILO_ADAPTER_CONFIG: OpenCodeCompatibleAdapterConfig = {
  provider: "kilo",
  displayName: "Kilo",
  defaultBinaryPath: "kilo",
  providerOptionsKey: "kilo",
  runtimeEventSource: "kilo.sdk.event",
  turnIdPrefix: "kilo-turn",
  cliModelSource: "kilo-cli",
  fallbackModelSource: "kilo",
  defaultAgent: "code",
  planAgent: "plan",
  cliSpec: KILO_CLI_SPEC,
};

const OPENCODE_PROMPT_ACCEPTED_ACTIVITY_TIMEOUT_MS = 60_000;
const OPENCODE_PROMPT_ACCEPTED_RECOVERY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000] as const;
const OPENCODE_PROMPT_SUBMISSION_INLINE_WAIT_MS = 500;
const OPENCODE_EVENT_RECONNECT_DELAYS_MS = [250, 1_000, 2_500, 5_000] as const;
const OPENCODE_MAX_RELATED_SESSIONS = 256;

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface OpenCodeSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly gatewayControlAvailable: boolean;
  gatewaySessionLease?: AgentGatewaySessionLease;
  session: ProviderSession;
  readonly lifecycleGeneration?: string;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  /** Permission request ids resolved by Synara policy and never surfaced to the UI. */
  readonly policyResolvedPermissionIds: Set<string>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly pendingTextDeltasByPartId: Map<string, string>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly messageSnapshotKeyById: Map<string, string>;
  readonly partById: Map<string, Part>;
  readonly partSnapshotKeyById: Map<string, string>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly relatedSessionIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  readonly modelContextLimitBySlug: Map<string, number>;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastEmittedTokenUsageKey: string | undefined;
  latestTurnCostUsd: number | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnEventSerial: number;
  activeTurnProviderActivitySerial: number;
  activeTurnCompletionActivitySerial: number;
  activeTurnSawToolCallFinish: boolean;
  activeTurnSawFinalAssistant: boolean;
  activeTurnFinalAssistantMessageId: string | undefined;
  activeTurnToolCallIdleWatchdogStarted: boolean;
  activeInteractionMode: "default" | "plan" | undefined;
  appliedPermissionInteractionMode: "default" | "plan";
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

function releaseOpenCodeGatewayLease(context: OpenCodeSessionContext): void {
  context.gatewaySessionLease?.release();
  delete context.gatewaySessionLease;
}

interface OpenCodeMessageSnapshot {
  readonly info: {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly time?: {
      readonly completed?: number;
    };
    readonly finish?: string;
  };
  readonly parts: ReadonlyArray<Part>;
}

export interface OpenCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly runtime?: OpenCodeRuntimeShape;
  readonly adapterConfig?: OpenCodeCompatibleAdapterConfig;
  readonly promptAcceptedActivityTimeoutMs?: number;
  readonly promptAcceptedRecoveryDelaysMs?: ReadonlyArray<number>;
  readonly promptSubmissionInlineWaitMs?: number;
  readonly prematureIdleCompletionGraceMs?: number;
  readonly beforeSessionInstall?: Effect.Effect<void>;
  readonly resolveServerPassword?: (
    provider: OpenCodeCompatibleProvider,
  ) => Effect.Effect<string | undefined, ProviderAdapterValidationError>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRequestError(
  provider: OpenCodeCompatibleProvider,
  cause: OpenCodeRuntimeError,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });
}

function toProcessError(
  provider: OpenCodeCompatibleProvider,
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });
}

function asRuntimeItemId(value: string) {
  return RuntimeItemId.makeUnsafe(value);
}

function buildProviderEventBase(input: {
  readonly provider: OpenCodeCompatibleProvider;
  readonly runtimeEventSource: "opencode.sdk.event" | "kilo.sdk.event";
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
> {
  return {
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: input.provider,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: asRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: input.runtimeEventSource,
            payload: input.raw,
          },
        }
      : {}),
  };
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) return "command_execution";
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("image")) return "image_view";
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function openCodeSnapshotKey(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function rememberOpenCodeMessageSnapshot(
  context: OpenCodeSessionContext,
  snapshot: OpenCodeMessageSnapshot,
): void {
  context.messageRoleById.set(snapshot.info.id, snapshot.info.role);
  context.messageSnapshotKeyById.set(snapshot.info.id, openCodeSnapshotKey(snapshot.info));

  for (const part of snapshot.parts) {
    context.partById.set(part.id, part);
    context.partSnapshotKeyById.set(part.id, openCodeSnapshotKey(part));

    const text = textFromPart(part);
    if (text !== undefined) {
      context.emittedTextByPartId.set(part.id, text);
    }
    if (
      part.type === "text" &&
      shouldProjectOpenCodeTextPart(part) &&
      part.time?.end !== undefined
    ) {
      context.completedAssistantPartIds.add(part.id);
    }
  }
}

function openCodeMessageSnapshotFromEntry(entry: {
  readonly info: {
    readonly id: string;
    readonly role: string;
    readonly time?: {
      readonly created?: number;
      readonly completed?: number;
    };
    readonly finish?: string;
  };
  readonly parts: ReadonlyArray<Part>;
}): OpenCodeMessageSnapshot | undefined {
  if (entry.info.role !== "user" && entry.info.role !== "assistant") {
    return undefined;
  }
  return {
    info: {
      ...entry.info,
      role: entry.info.role,
    },
    parts: entry.parts,
  };
}

function openCodeMessageSnapshotsFromResponse(
  entries: ReadonlyArray<{
    readonly info: {
      readonly id: string;
      readonly role: string;
      readonly time?: {
        readonly created?: number;
        readonly completed?: number;
      };
      readonly finish?: string;
    };
    readonly parts: ReadonlyArray<Part>;
  }>,
): ReadonlyArray<OpenCodeMessageSnapshot> {
  return entries.flatMap((entry) => {
    const snapshot = openCodeMessageSnapshotFromEntry(entry);
    return snapshot ? [snapshot] : [];
  });
}

function isFinalAssistantMessageSnapshot(snapshot: OpenCodeMessageSnapshot): boolean {
  return (
    snapshot.info.role === "assistant" &&
    typeof snapshot.info.time?.completed === "number" &&
    snapshot.info.finish !== "tool-calls"
  );
}

function ensureSessionContext(
  provider: OpenCodeCompatibleProvider,
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider,
      threadId,
    });
  }
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider,
      threadId,
    });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function normalizeOpenCodeTodoTasks(todos: ReadonlyArray<Todo>): {
  readonly tasks: ReadonlyArray<{
    readonly task: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} | null {
  const tasks = todos.flatMap((todo) => {
    const task = makeRuntimeTaskListItem(todo.content, todo.status);
    return task ? [task] : [];
  });

  return nonEmptyRuntimeTaskListPayload(tasks);
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function shouldProjectOpenCodeTextPart(part: Part): boolean {
  // Kilo uses synthetic/ignored text parts for local UI progress such as snapshot setup.
  return part.type !== "text" || (!part.synthetic && !part.ignored);
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
      return shouldProjectOpenCodeTextPart(part) ? part.text : undefined;
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function suffixPrefixOverlap(text: string, delta: string): number {
  const maxLength = Math.min(text.length, delta.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(delta.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): { readonly latestText: string; readonly deltaToEmit: string } {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): { readonly nextText: string; readonly deltaToEmit: string } {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta));
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit,
  };
}

function bufferPendingTextDelta(
  context: OpenCodeSessionContext,
  partId: string,
  delta: string,
): void {
  if (delta.length === 0) {
    return;
  }
  const previousText = context.pendingTextDeltasByPartId.get(partId) ?? "";
  const { nextText } = appendOpenCodeAssistantTextDelta(previousText, delta);
  context.pendingTextDeltasByPartId.set(partId, nextText);
}

function applyPendingTextDeltaToPart(context: OpenCodeSessionContext, part: Part): Part {
  if (part.type !== "text" && part.type !== "reasoning") {
    context.pendingTextDeltasByPartId.delete(part.id);
    return part;
  }

  const pendingDelta = context.pendingTextDeltasByPartId.get(part.id);
  if (!pendingDelta || pendingDelta.length === 0) {
    return part;
  }

  const { nextText } = appendOpenCodeAssistantTextDelta(part.text, pendingDelta);
  context.pendingTextDeltasByPartId.delete(part.id);
  return nextText === part.text ? part : { ...part, text: nextText };
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message =
    data && "message" in data
      ? data.message
      : "message" in error
        ? error.message
        : "error" in error
          ? error.error
          : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function isOpenCodeContextOverflowError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ("name" in error && error.name === "ContextOverflowError") {
    return true;
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : undefined;
  return (
    typeof message === "string" &&
    /context|token/i.test(message) &&
    /overflow|too large|maximum context|context length|size limit/i.test(message)
  );
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

function clearActiveTurnState(context: OpenCodeSessionContext): void {
  context.activeTurnId = undefined;
  context.activeTurnEventSerial = 0;
  context.activeTurnProviderActivitySerial = 0;
  context.activeTurnCompletionActivitySerial = 0;
  context.activeTurnSawToolCallFinish = false;
  context.activeTurnSawFinalAssistant = false;
  context.activeTurnFinalAssistantMessageId = undefined;
  context.activeTurnToolCallIdleWatchdogStarted = false;
  context.activeInteractionMode = undefined;
  context.activeAgent = undefined;
  context.activeVariant = undefined;
  context.latestTurnCostUsd = undefined;
  context.relatedSessionIds.clear();
  // Deliberately NOT cleared here: a permission policy-resolved at the tail of a turn can
  // have its permission.replied echo arrive after turn teardown, and dropping the id first
  // would misclassify that echo as a real resolution (orphaned "Approval resolved" in the
  // UI). Ids are unique per request so stale entries are inert; the set is freed with the
  // session context when the session is removed.
}

function markOpenCodeTurnProviderActivity(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
): void {
  if (!turnId || context.activeTurnId !== turnId) {
    return;
  }
  context.activeTurnProviderActivitySerial += 1;
}

function markOpenCodeTurnCompletionActivity(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
): void {
  if (!turnId || context.activeTurnId !== turnId) {
    return;
  }
  context.activeTurnCompletionActivitySerial += 1;
}

function openCodeNextTextItemId(turnId: TurnId): string {
  return `${turnId}-next-text`;
}

function isoFromOpenCodeTimestamp(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

function openCodeToolContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((item) =>
      item && typeof item === "object" && "type" in item && item.type === "text"
        ? [String((item as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isOpenCodeTerminalStepFinish(value: unknown): boolean {
  const finish = trimNonEmptyString(value)?.toLowerCase().replace(/_/gu, "-");
  if (!finish) {
    return false;
  }
  return !["tool-call", "tool-calls", "function-call", "continue", "unknown"].includes(finish);
}

function isOpenCodeToolCallFinish(value: unknown): boolean {
  const finish = trimNonEmptyString(value)?.toLowerCase().replace(/_/gu, "-");
  return finish === "tool-call" || finish === "tool-calls" || finish === "function-call";
}

function isOpenCodeCompletedAssistantMessage(entry: OpenCodeMessageSnapshot): boolean {
  if (entry.info.role !== "assistant") {
    return false;
  }
  const finish = trimNonEmptyString(entry.info.finish);
  if (finish !== undefined && !isOpenCodeTerminalStepFinish(finish)) {
    return false;
  }
  const time = entry.info.time;
  if (
    time &&
    typeof time === "object" &&
    !Array.isArray(time) &&
    typeof (time as { completed?: unknown }).completed === "number"
  ) {
    return true;
  }
  return finish !== undefined;
}

function trackActiveTurnAssistantFinish(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  entry: OpenCodeMessageSnapshot,
): void {
  if (!turnId || context.activeTurnId !== turnId || entry.info.role !== "assistant") {
    return;
  }
  if (isOpenCodeToolCallFinish(entry.info.finish)) {
    context.activeTurnSawToolCallFinish = true;
  }
  if (isOpenCodeCompletedAssistantMessage(entry)) {
    context.activeTurnSawFinalAssistant = true;
    context.activeTurnFinalAssistantMessageId = entry.info.id;
    markOpenCodeTurnCompletionActivity(context, turnId);
  }
}

function areOpenCodeAssistantTextPartsSettled(parts: ReadonlyArray<Part>): boolean {
  let sawTextPart = false;
  for (const part of parts) {
    if (part.type !== "text") {
      continue;
    }
    sawTextPart = true;
    if (!isCompletedOpenCodeAssistantTextPart(part)) {
      return false;
    }
  }
  return sawTextPart;
}

function isOpenCodeAssistantMessageTextSettled(
  context: OpenCodeSessionContext,
  messageId: string,
): boolean {
  const messageParts: Array<Part> = [];
  for (const part of context.partById.values()) {
    if (part.messageID === messageId) {
      messageParts.push(part);
    }
  }
  return (
    areOpenCodeAssistantTextPartsSettled(messageParts) &&
    messageParts.every(
      (part) => part.type !== "text" || context.completedAssistantPartIds.has(part.id),
    )
  );
}

function isCompletedOpenCodeAssistantTextPart(part: Part): boolean {
  return part.type === "text" && part.time?.end !== undefined;
}

function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor.trim();
  }
  if (
    resumeCursor &&
    typeof resumeCursor === "object" &&
    "openCodeSessionId" in resumeCursor &&
    typeof resumeCursor.openCodeSessionId === "string" &&
    resumeCursor.openCodeSessionId.trim().length > 0
  ) {
    return resumeCursor.openCodeSessionId.trim();
  }
  return undefined;
}

function extractResumeCwd(resumeCursor: unknown): string | undefined {
  if (
    resumeCursor &&
    typeof resumeCursor === "object" &&
    "cwd" in resumeCursor &&
    typeof resumeCursor.cwd === "string" &&
    resumeCursor.cwd.trim().length > 0
  ) {
    return resumeCursor.cwd.trim();
  }
  return undefined;
}

function openCodeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rememberRelatedOpenCodeSession(
  context: OpenCodeSessionContext,
  part: Extract<Part, { type: "tool" }>,
): void {
  const state = openCodeRecord(part.state);
  const metadata = openCodeRecord(state?.metadata) ?? openCodeRecord(part.metadata);
  const childSessionId =
    trimNonEmptyString(metadata?.sessionId) ?? trimNonEmptyString(metadata?.sessionID);
  if (!childSessionId || childSessionId === context.openCodeSessionId) {
    return;
  }
  context.relatedSessionIds.add(childSessionId);
}

function subscribedEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  if (!("properties" in event)) {
    return undefined;
  }

  const properties = event.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return undefined;
  }

  const sessionId = (properties as { readonly sessionID?: unknown }).sessionID;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function shouldHandleRelatedOpenCodeSessionEvent(event: OpenCodeSubscribedEvent): boolean {
  if (event.type.startsWith("session.next.tool.") || event.type.startsWith("session.next.shell.")) {
    return true;
  }
  if (event.type === "message.part.updated") {
    return event.properties.part.type === "tool";
  }
  return (
    event.type === "permission.asked" ||
    event.type === "permission.replied" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "session.error"
  );
}

function shouldHandleSubscribedEvent(
  context: OpenCodeSessionContext,
  event: OpenCodeSubscribedEvent,
): boolean {
  const sessionId = subscribedEventSessionId(event);
  if (sessionId !== undefined) {
    return (
      sessionId === context.openCodeSessionId ||
      (context.relatedSessionIds.has(sessionId) && shouldHandleRelatedOpenCodeSessionEvent(event))
    );
  }

  return (
    context.activeTurnId !== undefined &&
    (event.type === "session.error" || event.type === "session.idle")
  );
}

function isOpenCodeTurnProviderActivityEvent(
  context: OpenCodeSessionContext,
  event: OpenCodeSubscribedEvent,
): boolean {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.role === "assistant";
    case "message.part.delta": {
      const part = context.partById.get(event.properties.partID);
      return part ? messageRoleForPart(context, part) === "assistant" : false;
    }
    case "message.part.updated":
      return messageRoleForPart(context, event.properties.part) === "assistant";
    case "session.status":
      return event.properties.status.type === "busy" || event.properties.status.type === "retry";
    case "permission.asked":
    case "question.asked":
    case "todo.updated":
    case "session.compacted":
    case "session.error":
    case "session.idle":
      return true;
    default:
      return event.type.startsWith("session.next.");
  }
}

type OpenCodeAssistantTokens = AssistantMessage["tokens"];

interface NormalizedOpenCodeTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

function readOpenCodeTokens(tokens: unknown): NormalizedOpenCodeTokens | undefined {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return undefined;
  }
  const tokenRecord = tokens as Partial<OpenCodeAssistantTokens>;
  const inputTokens = nonNegativeInteger(tokenRecord.input);
  const outputTokens = nonNegativeInteger(tokenRecord.output);
  const reasoningOutputTokens = nonNegativeInteger(tokenRecord.reasoning);
  const cacheReadTokens = nonNegativeInteger(tokenRecord.cache?.read);
  const cacheWriteTokens = nonNegativeInteger(tokenRecord.cache?.write);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function normalizeOpenCodeTokenUsage(
  tokens: unknown,
  maxTokens?: number | undefined,
): ThreadTokenUsageSnapshot | undefined {
  const normalizedTokens = readOpenCodeTokens(tokens);
  if (!normalizedTokens) {
    return undefined;
  }

  const { inputTokens, outputTokens, reasoningOutputTokens, cacheReadTokens, cacheWriteTokens } =
    normalizedTokens;
  const cachedInputTokens = cacheReadTokens + cacheWriteTokens;
  const totalProcessedTokens =
    inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;
  if (totalProcessedTokens <= 0) {
    return undefined;
  }

  const normalizedMaxTokens = positiveInteger(maxTokens);
  const usedTokens =
    normalizedMaxTokens !== undefined
      ? Math.min(totalProcessedTokens, normalizedMaxTokens)
      : totalProcessedTokens;

  return {
    usedTokens,
    totalProcessedTokens,
    ...(normalizedMaxTokens !== undefined ? { maxTokens: normalizedMaxTokens } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
    lastReasoningOutputTokens: reasoningOutputTokens,
  };
}

function buildOpenCodeTokenUsageKey(input: {
  readonly messageId: string;
  readonly tokens: OpenCodeAssistantTokens;
  readonly maxTokens?: number | undefined;
}): string | undefined {
  const normalizedTokens = readOpenCodeTokens(input.tokens);
  if (!normalizedTokens) {
    return undefined;
  }

  const { inputTokens, outputTokens, reasoningOutputTokens, cacheReadTokens, cacheWriteTokens } =
    normalizedTokens;
  return [
    input.messageId,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens,
    positiveInteger(input.maxTokens) ?? "",
  ].join(":");
}

function replaceModelContextLimits(
  context: OpenCodeSessionContext,
  limits: ReadonlyMap<string, number>,
): void {
  context.modelContextLimitBySlug.clear();
  for (const [slug, limit] of limits) {
    context.modelContextLimitBySlug.set(slug, limit);
  }
}

function buildOpenCodeThreadSnapshot(input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<OpenCodeMessageSnapshot>;
  readonly cwd?: string | null;
}) {
  return {
    threadId: input.threadId,
    turns: input.messages.map((entry) => ({
      id: TurnId.makeUnsafe(entry.info.id),
      items: [entry],
    })),
    cwd: input.cwd ?? null,
  };
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return;
  }

  yield* runOpenCodeSdk("session.abort", () =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }),
  ).pipe(Effect.ignore({ log: true }));

  yield* Scope.close(context.sessionScope, Exit.void).pipe(
    Effect.ensuring(Effect.sync(() => releaseOpenCodeGatewayLease(context))),
  );
});

export function makeOpenCodeAdapterLive(options?: OpenCodeAdapterLiveOptions) {
  const adapterConfig = options?.adapterConfig ?? OPENCODE_ADAPTER_CONFIG;
  return Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const openCodeRuntime = yield* OpenCodeRuntime;
      const agentGatewayCredentials = Option.getOrUndefined(
        yield* Effect.serviceOption(AgentGatewayCredentials),
      );
      const provider = adapterConfig.provider;
      const buildEventBase = (
        input: Omit<
          Parameters<typeof buildProviderEventBase>[0],
          "provider" | "runtimeEventSource"
        >,
      ) =>
        buildProviderEventBase({
          provider,
          runtimeEventSource: adapterConfig.runtimeEventSource,
          ...input,
        });
      const toAdapterRequestError = (cause: OpenCodeRuntimeError) =>
        toRequestError(provider, cause);
      const toAdapterProcessError = (threadId: ThreadId, cause: unknown) =>
        toProcessError(provider, threadId, cause);
      const ensureAdapterSessionContext = (threadId: ThreadId) =>
        ensureSessionContext(provider, sessions, threadId);
      const promptAcceptedActivityTimeoutMs =
        options?.promptAcceptedActivityTimeoutMs ?? OPENCODE_PROMPT_ACCEPTED_ACTIVITY_TIMEOUT_MS;
      const promptAcceptedRecoveryDelaysMs =
        options?.promptAcceptedRecoveryDelaysMs?.filter(
          (delayMs) => Number.isFinite(delayMs) && delayMs > 0,
        ) ?? OPENCODE_PROMPT_ACCEPTED_RECOVERY_DELAYS_MS;
      const promptSubmissionInlineWaitMs =
        options?.promptSubmissionInlineWaitMs ?? OPENCODE_PROMPT_SUBMISSION_INLINE_WAIT_MS;
      const prematureIdleCompletionGraceMs = options?.prematureIdleCompletionGraceMs ?? 10_000;
      const nativeEventLogger =
        options?.nativeEventLogger ??
        (options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
              stream: "native",
            })
          : undefined);
      const managedNativeEventLogger =
        options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
      const runtimeEvents = yield* Queue.bounded<ProviderRuntimeEvent>(
        PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
      );
      const sessions = new Map<ThreadId, OpenCodeSessionContext>();

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
          if (managedNativeEventLogger !== undefined) {
            yield* managedNativeEventLogger.close();
          }
        }),
      );

      const emit = (context: OpenCodeSessionContext, event: ProviderRuntimeEvent) =>
        Queue.offer(runtimeEvents, {
          ...event,
          ...(context.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: context.lifecycleGeneration }
            : {}),
        }).pipe(Effect.asVoid);
      const writeNativeEvent = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
      const writeNativeEventBestEffort = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

      const emitContextCompactionProgress = Effect.fn("emitContextCompactionProgress")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId?: TurnId | undefined;
          readonly detail?: string | undefined;
          readonly raw?: unknown;
          readonly data?: unknown;
        },
      ) {
        yield* emit(context, {
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: input.turnId,
            raw: input.raw,
          }),
          type: "item.updated",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            detail: input.detail ?? "Compacting context",
            ...(input.data !== undefined ? { data: input.data } : {}),
          },
        });
      });

      const emitContextCompacted = Effect.fn("emitContextCompacted")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId?: TurnId | undefined;
          readonly raw?: unknown;
        },
      ) {
        updateProviderSession(
          context,
          {
            status: context.activeTurnId ? "running" : "ready",
          },
          { clearLastError: true },
        );
        yield* emit(context, {
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: input.turnId,
            raw: input.raw,
          }),
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: { source: provider },
          },
        });
      });

      const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
        context: OpenCodeSessionContext,
        message: string,
      ) {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        const turnId = context.activeTurnId;
        sessions.delete(context.session.threadId);
        yield* emit(context, {
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "runtime.error",
          payload: {
            message,
            class: "transport_error",
          },
        }).pipe(Effect.ignore);
        yield* emit(context, {
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "session.exited",
          payload: {
            reason: message,
            recoverable: false,
            exitKind: "error",
          },
        }).pipe(Effect.ignore);
        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.ignore({ log: true }));
        yield* Scope.close(context.sessionScope, Exit.void).pipe(
          Effect.ensuring(Effect.sync(() => releaseOpenCodeGatewayLease(context))),
        );
      });

      const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
        context: OpenCodeSessionContext,
        part: Part,
        turnId: TurnId | undefined,
        raw: unknown,
      ) {
        const text = textFromPart(part);
        if (text === undefined) {
          return;
        }
        const nextTextItemId =
          turnId && part.type === "text" ? openCodeNextTextItemId(turnId) : undefined;
        const itemId =
          nextTextItemId && context.emittedTextByPartId.has(nextTextItemId)
            ? nextTextItemId
            : part.id;
        const previousText = context.emittedTextByPartId.get(itemId);
        const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
        context.emittedTextByPartId.set(itemId, latestText);
        if (itemId !== part.id) {
          context.emittedTextByPartId.set(part.id, latestText);
        }
        if (latestText !== text) {
          context.partById.set(
            part.id,
            (part.type === "text" || part.type === "reasoning"
              ? { ...part, text: latestText }
              : part) satisfies Part,
          );
        }
        if (deltaToEmit.length > 0) {
          markOpenCodeTurnCompletionActivity(context, turnId);
          yield* emit(context, {
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              createdAt:
                part.type === "text" || part.type === "reasoning"
                  ? isoFromEpochMs(part.time?.start)
                  : undefined,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: resolveTextStreamKind(part),
              delta: deltaToEmit,
            },
          });
        }

        if (
          part.type === "text" &&
          part.time?.end !== undefined &&
          !context.completedAssistantPartIds.has(itemId)
        ) {
          context.completedAssistantPartIds.add(itemId);
          if (itemId !== part.id) {
            context.completedAssistantPartIds.add(part.id);
          }
          const proposedPlanMarkdown =
            context.activeInteractionMode === "plan"
              ? extractProposedPlanMarkdown(latestText)
              : undefined;
          if (proposedPlanMarkdown && turnId) {
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                createdAt: isoFromEpochMs(part.time.end),
                raw,
              }),
              type: "turn.proposed.completed",
              payload: {
                planMarkdown: proposedPlanMarkdown,
              },
            });
          }
          yield* emit(context, {
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId,
              createdAt: isoFromEpochMs(part.time.end),
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(latestText.length > 0 ? { detail: latestText } : {}),
            },
          });
        }
      });

      const emitRecoveredAssistantTextDelta = Effect.fn("emitRecoveredAssistantTextDelta")(
        function* (context: OpenCodeSessionContext, part: Part, turnId: TurnId, raw: unknown) {
          const text = textFromPart(part);
          const nextTextItemId = openCodeNextTextItemId(turnId);
          if (
            text === undefined ||
            part.type !== "text" ||
            !context.emittedTextByPartId.has(nextTextItemId)
          ) {
            yield* emitAssistantTextDelta(context, part, turnId, raw);
            return;
          }

          const previousText = context.emittedTextByPartId.get(nextTextItemId);
          const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
          context.emittedTextByPartId.set(nextTextItemId, latestText);
          context.emittedTextByPartId.set(part.id, latestText);
          context.partById.set(part.id, { ...part, text: latestText });
          if (deltaToEmit.length > 0) {
            markOpenCodeTurnCompletionActivity(context, turnId);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: nextTextItemId,
                createdAt: isoFromEpochMs(part.time?.start),
                raw,
              }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: deltaToEmit,
              },
            });
          }

          if (part.time?.end !== undefined) {
            if (context.completedAssistantPartIds.has(nextTextItemId)) {
              context.completedAssistantPartIds.add(part.id);
              return;
            }
            context.completedAssistantPartIds.add(nextTextItemId);
            context.completedAssistantPartIds.add(part.id);
            const proposedPlanMarkdown =
              context.activeInteractionMode === "plan"
                ? extractProposedPlanMarkdown(latestText)
                : undefined;
            if (proposedPlanMarkdown) {
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: nextTextItemId,
                  createdAt: isoFromEpochMs(part.time.end),
                  raw,
                }),
                type: "turn.proposed.completed",
                payload: {
                  planMarkdown: proposedPlanMarkdown,
                },
              });
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: nextTextItemId,
                createdAt: isoFromEpochMs(part.time.end),
                raw,
              }),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(latestText.length > 0 ? { detail: latestText } : {}),
              },
            });
          }
        },
      );

      const completeOpenCodeTurn = Effect.fn("completeOpenCodeTurn")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly raw: unknown;
          readonly totalCostUsd?: number | undefined;
          readonly errorMessage?: string | undefined;
        },
      ) {
        if (context.activeTurnId !== input.turnId) {
          return false;
        }
        clearActiveTurnState(context);
        updateProviderSession(
          context,
          input.errorMessage
            ? { status: "error", lastError: input.errorMessage }
            : { status: "ready" },
          { clearActiveTurnId: true },
        );
        yield* emit(context, {
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: input.turnId,
            raw: input.raw,
          }),
          type: "turn.completed",
          payload: input.errorMessage
            ? {
                state: "failed",
                errorMessage: input.errorMessage,
              }
            : {
                state: "completed",
                ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
              },
        });
        return true;
      });

      const waitForOpenCodeTurnCompletionQuiet = Effect.fn("waitForOpenCodeTurnCompletionQuiet")(
        function* (context: OpenCodeSessionContext, turnId: TurnId, quietMs: number) {
          let observedActivitySerial = context.activeTurnCompletionActivitySerial;
          while (true) {
            yield* Effect.sleep(quietMs);
            if ((yield* Ref.get(context.stopped)) || context.activeTurnId !== turnId) {
              return false;
            }
            const currentActivitySerial = context.activeTurnCompletionActivitySerial;
            if (currentActivitySerial === observedActivitySerial) {
              return true;
            }
            observedActivitySerial = currentActivitySerial;
          }
        },
      );

      const deferPrematureIdleCompletion = Effect.fn("deferPrematureIdleCompletion")(function* (
        context: OpenCodeSessionContext,
        turnId: TurnId,
        raw: unknown,
      ) {
        const idleBeforeAssistantActivity = context.activeTurnCompletionActivitySerial === 0;
        const idleAfterToolCalls =
          context.activeTurnSawToolCallFinish && !context.activeTurnSawFinalAssistant;
        const finalAssistantMessageId = context.activeTurnFinalAssistantMessageId;
        const idleBeforeFinalAssistantParts =
          context.activeTurnSawFinalAssistant &&
          finalAssistantMessageId !== undefined &&
          !isOpenCodeAssistantMessageTextSettled(context, finalAssistantMessageId);
        const idleAfterFinalAssistant =
          context.activeTurnSawFinalAssistant && finalAssistantMessageId !== undefined;
        if (!idleBeforeAssistantActivity && !idleAfterToolCalls && !idleAfterFinalAssistant) {
          return false;
        }
        if (!context.activeTurnToolCallIdleWatchdogStarted) {
          context.activeTurnToolCallIdleWatchdogStarted = true;
          yield* Effect.gen(function* () {
            // A normal final response only needs a short event-stream quiet
            // window. Early idle with no completed part keeps the longer grace
            // period used for delayed provider recovery.
            const needsRecoveryGrace =
              idleBeforeAssistantActivity || idleAfterToolCalls || idleBeforeFinalAssistantParts;
            const initialQuietMs = needsRecoveryGrace
              ? prematureIdleCompletionGraceMs
              : Math.min(prematureIdleCompletionGraceMs, 250);
            if (!(yield* waitForOpenCodeTurnCompletionQuiet(context, turnId, initialQuietMs))) {
              return;
            }

            // Some OpenCode versions emit idle before the final assistant event
            // and never emit idle again. A completed assistant message is enough
            // to settle that deferred idle instead of leaving the turn running.
            if (context.activeTurnSawFinalAssistant) {
              // Re-read the id after the grace period: the final metadata may have
              // arrived after the idle event that scheduled this watchdog.
              const deferredFinalAssistantMessageId = context.activeTurnFinalAssistantMessageId;
              if (
                deferredFinalAssistantMessageId !== undefined &&
                (yield* recoverOpenCodeTurnFromMessageId(context, {
                  turnId,
                  messageId: deferredFinalAssistantMessageId,
                  raw: {
                    source: "synara.opencode.deferred-idle-completion",
                    event: raw,
                  },
                }))
              ) {
                return;
              }
              if (
                deferredFinalAssistantMessageId !== undefined &&
                isOpenCodeAssistantMessageTextSettled(context, deferredFinalAssistantMessageId)
              ) {
                // The event stream can be ahead of session.messages. Completion
                // activity has now stayed quiet for a full grace window, so all
                // locally delivered parts belong to this final response.
                yield* completeOpenCodeTurn(context, {
                  turnId,
                  raw: {
                    source: "synara.opencode.deferred-idle-local-part",
                    event: raw,
                  },
                  totalCostUsd: context.latestTurnCostUsd,
                });
                return;
              }

              // A final message snapshot may be visible before its parts. Keep
              // one additional bounded window for the SSE part or a fresher
              // snapshot instead of failing a response that is still arriving.
              if (
                !(yield* waitForOpenCodeTurnCompletionQuiet(
                  context,
                  turnId,
                  prematureIdleCompletionGraceMs,
                ))
              ) {
                return;
              }
              const retriedFinalAssistantMessageId = context.activeTurnFinalAssistantMessageId;
              if (
                retriedFinalAssistantMessageId !== undefined &&
                (yield* recoverOpenCodeTurnFromMessageId(context, {
                  turnId,
                  messageId: retriedFinalAssistantMessageId,
                  raw: {
                    source: "synara.opencode.deferred-idle-completion-retry",
                    event: raw,
                  },
                }))
              ) {
                return;
              }
              if (
                retriedFinalAssistantMessageId !== undefined &&
                isOpenCodeAssistantMessageTextSettled(context, retriedFinalAssistantMessageId)
              ) {
                yield* completeOpenCodeTurn(context, {
                  turnId,
                  raw: {
                    source: "synara.opencode.deferred-idle-local-part-retry",
                    event: raw,
                  },
                  totalCostUsd: context.latestTurnCostUsd,
                });
                return;
              }
            }

            const message = idleAfterToolCalls
              ? `${adapterConfig.displayName} became idle after tool calls without producing a final assistant response.`
              : `${adapterConfig.displayName} became idle before producing an assistant response.`;
            const completed = yield* completeOpenCodeTurn(context, {
              turnId,
              raw: {
                source: "synara.opencode.idle-after-tool-calls",
                event: raw,
              },
              errorMessage: message,
            });
            if (!completed) return;
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: {
                  source: "synara.opencode.idle-after-tool-calls",
                  event: raw,
                },
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
              },
            });
          }).pipe(Effect.forkIn(context.sessionScope), Effect.asVoid);
        }
        return true;
      });

      const recoverOpenCodeTurnFromAssistantMessage = Effect.fn(
        "recoverOpenCodeTurnFromAssistantMessage",
      )(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly assistantEntry: OpenCodeMessageSnapshot;
          readonly raw: unknown;
        },
      ) {
        if (context.activeTurnId !== input.turnId) {
          return false;
        }
        if (!areOpenCodeAssistantTextPartsSettled(input.assistantEntry.parts)) {
          return false;
        }
        context.messageRoleById.set(input.assistantEntry.info.id, "assistant");
        trackActiveTurnAssistantFinish(context, input.turnId, input.assistantEntry);
        for (const part of input.assistantEntry.parts) {
          if (context.activeTurnId !== input.turnId) {
            return false;
          }
          context.partById.set(part.id, part);
          yield* emitRecoveredAssistantTextDelta(context, part, input.turnId, input.raw);
        }

        if (context.activeTurnId !== input.turnId) {
          return false;
        }

        const selectedModel = context.session.model;
        const maxTokens =
          selectedModel !== undefined
            ? context.modelContextLimitBySlug.get(selectedModel)
            : undefined;
        const normalizedUsage = normalizeOpenCodeTokenUsage(
          (input.assistantEntry.info as Partial<AssistantMessage>).tokens,
          maxTokens,
        );
        if (normalizedUsage !== undefined) {
          context.lastKnownTokenUsage = normalizedUsage;
          yield* emit(context, {
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: input.turnId,
              raw: input.raw,
            }),
            type: "thread.token-usage.updated",
            payload: {
              usage: normalizedUsage,
            },
          });
        }
        if (context.activeTurnId !== input.turnId) {
          return false;
        }
        const cost = nonNegativeFiniteNumber(
          (input.assistantEntry.info as Partial<AssistantMessage>).cost,
        );
        context.latestTurnCostUsd = cost;
        yield* completeOpenCodeTurn(context, {
          turnId: input.turnId,
          raw: input.raw,
          totalCostUsd: cost,
        });
        return true;
      });

      const recoverOpenCodeTurnFromMessageId = Effect.fn("recoverOpenCodeTurnFromMessageId")(
        function* (
          context: OpenCodeSessionContext,
          input: {
            readonly turnId: TurnId;
            readonly messageId: string;
            readonly raw: unknown;
          },
        ) {
          const messagesResponse = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(
            Effect.catchCause(() =>
              Effect.succeed(
                null as Awaited<ReturnType<OpencodeClient["session"]["messages"]>> | null,
              ),
            ),
          );
          if (context.activeTurnId !== input.turnId) {
            return false;
          }
          const assistantEntry = (messagesResponse?.data ?? []).find((entry) => {
            if (entry.info.id !== input.messageId || entry.info.role !== "assistant") {
              return false;
            }
            // The generated SDK response keeps `info` typed as the broad Message union
            // even after its role discriminator is checked.
            return isOpenCodeCompletedAssistantMessage(entry as unknown as OpenCodeMessageSnapshot);
          });
          if (!assistantEntry || assistantEntry.info.role !== "assistant") {
            return false;
          }
          return yield* recoverOpenCodeTurnFromAssistantMessage(context, {
            turnId: input.turnId,
            assistantEntry: assistantEntry as unknown as OpenCodeMessageSnapshot,
            raw: input.raw,
          });
        },
      );

      const recoverOpenCodeTurnFromMessages = Effect.fn("recoverOpenCodeTurnFromMessages")(
        function* (
          context: OpenCodeSessionContext,
          input: {
            readonly turnId: TurnId;
            readonly excludedMessageIds: ReadonlySet<string>;
          },
        ) {
          const messagesResponse = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(
            Effect.catchCause(() =>
              Effect.succeed(
                null as Awaited<ReturnType<OpencodeClient["session"]["messages"]>> | null,
              ),
            ),
          );
          if (context.activeTurnId !== input.turnId) {
            return false;
          }
          if (!messagesResponse) {
            return false;
          }

          const assistantEntry = (messagesResponse.data ?? [])
            .flatMap((entry) =>
              entry.info.role === "assistant" && !input.excludedMessageIds.has(entry.info.id)
                ? [
                    {
                      info: entry.info,
                      parts: entry.parts,
                    } satisfies OpenCodeMessageSnapshot,
                  ]
                : [],
            )
            .findLast(isOpenCodeCompletedAssistantMessage);
          if (!assistantEntry) {
            return false;
          }

          return yield* recoverOpenCodeTurnFromAssistantMessage(context, {
            turnId: input.turnId,
            assistantEntry,
            raw: {
              source: "synara.opencode.prompt.recovery",
              message: assistantEntry,
            },
          });
        },
      );

      const captureOpenCodeRecoveryBaseline = Effect.fn("captureOpenCodeRecoveryBaseline")(
        function* (context: OpenCodeSessionContext) {
          const messagesResponse = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(
            Effect.catchCause(() =>
              Effect.succeed(
                null as Awaited<ReturnType<OpencodeClient["session"]["messages"]>> | null,
              ),
            ),
          );
          const baselineIds = new Set<string>();
          for (const id of context.messageRoleById.keys()) {
            baselineIds.add(id);
          }
          for (const entry of messagesResponse?.data ?? []) {
            if (typeof entry.info.id === "string") {
              baselineIds.add(entry.info.id);
            }
          }
          return baselineIds;
        },
      );

      const schedulePromptAcceptedWatchdog = Effect.fn("schedulePromptAcceptedWatchdog")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly providerActivitySerial: number;
          readonly excludedMessageIds: ReadonlySet<string>;
        },
      ) {
        yield* Effect.gen(function* () {
          for (const delayMs of promptAcceptedRecoveryDelaysMs) {
            yield* Effect.sleep(delayMs);
            if ((yield* Ref.get(context.stopped)) || context.activeTurnId !== input.turnId) {
              break;
            }
            const recovered = yield* recoverOpenCodeTurnFromMessages(context, {
              turnId: input.turnId,
              excludedMessageIds: input.excludedMessageIds,
            });
            if (recovered) {
              break;
            }
          }
        }).pipe(
          Effect.flatMap(() => Effect.sleep(promptAcceptedActivityTimeoutMs)),
          Effect.flatMap(() =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              if (
                context.activeTurnId !== input.turnId ||
                context.activeTurnProviderActivitySerial !== input.providerActivitySerial
              ) {
                return;
              }

              const message =
                "OpenCode did not produce any activity for this prompt. The session may be stuck; try sending again or restart OpenCode.";
              const completed = yield* completeOpenCodeTurn(context, {
                turnId: input.turnId,
                raw: { source: "synara.opencode.prompt.watchdog" },
                errorMessage: message,
              });
              if (!completed) return;
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: input.turnId,
                  raw: { source: "synara.opencode.prompt.watchdog" },
                }),
                type: "runtime.error",
                payload: {
                  message,
                  class: "transport_error",
                },
              });
            }),
          ),
          Effect.forkIn(context.sessionScope),
          Effect.asVoid,
        );
      });

      const submitOpenCodePrompt = Effect.fn("submitOpenCodePrompt")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly promptInput: Parameters<OpencodeClient["session"]["prompt"]>[0];
        },
      ) {
        const settled = yield* Deferred.make<ProviderAdapterRequestError | null, never>();

        // Keep the documented prompt request off the command path; SSE streams live
        // updates, and the final HTTP response lets us recover if events are missed.
        yield* runOpenCodeSdk("session.prompt", () =>
          context.client.session.prompt(input.promptInput),
        ).pipe(
          Effect.mapError(toAdapterRequestError),
          Effect.flatMap((response) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return null;
              }
              if (context.activeTurnId !== input.turnId) {
                return null;
              }
              const assistantEntry =
                response.data && response.data.info.role === "assistant"
                  ? ({
                      info: response.data.info,
                      parts: response.data.parts,
                    } satisfies OpenCodeMessageSnapshot)
                  : null;
              if (assistantEntry && isOpenCodeCompletedAssistantMessage(assistantEntry)) {
                yield* recoverOpenCodeTurnFromAssistantMessage(context, {
                  turnId: input.turnId,
                  assistantEntry,
                  raw: {
                    source: "synara.opencode.prompt.response",
                    message: assistantEntry,
                  },
                });
              }
              return null;
            }),
          ),
          Effect.catch((requestError) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return requestError;
              }
              if (
                context.activeTurnId !== input.turnId ||
                context.activeTurnProviderActivitySerial > 0
              ) {
                return requestError;
              }
              clearActiveTurnState(context);
              updateProviderSession(
                context,
                {
                  status: "ready",
                  model: context.session.model,
                  lastError: requestError.detail,
                },
                { clearActiveTurnId: true },
              );
              yield* emit(context, {
                ...buildEventBase({ threadId: context.session.threadId, turnId: input.turnId }),
                type: "turn.aborted",
                payload: {
                  reason: requestError.detail,
                },
              });
              return requestError;
            }),
          ),
          Effect.flatMap((result) => Deferred.succeed(settled, result)),
          Effect.forkIn(context.sessionScope),
        );

        const quickResult = yield* Deferred.await(settled).pipe(
          Effect.timeoutOption(promptSubmissionInlineWaitMs),
        );
        if (quickResult._tag === "Some" && quickResult.value) {
          return yield* quickResult.value;
        }
      });

      const submitOpenCodePromptAsync = Effect.fn("submitOpenCodePromptAsync")(function* (
        context: OpenCodeSessionContext,
        input: {
          readonly turnId: TurnId;
          readonly promptInput: Parameters<OpencodeClient["session"]["promptAsync"]>[0];
        },
      ) {
        const settled = yield* Deferred.make<ProviderAdapterRequestError | null, never>();
        yield* runOpenCodeSdk("session.promptAsync", () =>
          context.client.session.promptAsync(input.promptInput),
        ).pipe(
          Effect.mapError(toAdapterRequestError),
          Effect.as(null),
          Effect.catch((requestError) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return requestError;
              }
              if (context.activeTurnId !== input.turnId) {
                return requestError;
              }
              clearActiveTurnState(context);
              updateProviderSession(
                context,
                {
                  status: "ready",
                  model: context.session.model,
                  lastError: requestError.detail,
                },
                { clearActiveTurnId: true },
              );
              yield* emit(context, {
                ...buildEventBase({ threadId: context.session.threadId, turnId: input.turnId }),
                type: "turn.aborted",
                payload: {
                  reason: requestError.detail,
                },
              });
              return requestError;
            }),
          ),
          Effect.flatMap((result) => Deferred.succeed(settled, result)),
          Effect.forkIn(context.sessionScope),
        );

        const quickResult = yield* Deferred.await(settled).pipe(
          Effect.timeoutOption(promptSubmissionInlineWaitMs),
        );
        if (quickResult._tag === "Some" && quickResult.value) {
          return yield* quickResult.value;
        }
      });

      const refreshRelatedOpenCodeSessions = Effect.fn("refreshRelatedOpenCodeSessions")(function* (
        context: OpenCodeSessionContext,
      ) {
        const discovered = new Set<string>();
        const pending = [context.openCodeSessionId];
        while (pending.length > 0 && discovered.size < OPENCODE_MAX_RELATED_SESSIONS) {
          const parentSessionId = pending.shift();
          if (!parentSessionId) {
            break;
          }
          const response = yield* runOpenCodeSdk("session.children", () =>
            context.client.session.children({ sessionID: parentSessionId }),
          );
          for (const child of response.data ?? []) {
            if (
              child.id === context.openCodeSessionId ||
              discovered.has(child.id) ||
              discovered.size >= OPENCODE_MAX_RELATED_SESSIONS
            ) {
              continue;
            }
            discovered.add(child.id);
            pending.push(child.id);
          }
        }
        for (const sessionId of discovered) {
          context.relatedSessionIds.add(sessionId);
        }
      });

      const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
        context: OpenCodeSessionContext,
        event: OpenCodeSubscribedEvent,
      ) {
        if (!shouldHandleSubscribedEvent(context, event)) {
          const sessionId = subscribedEventSessionId(event);
          const canBelongToUndiscoveredChild =
            sessionId !== undefined &&
            (event.type === "permission.asked" || event.type === "question.asked");
          if (!canBelongToUndiscoveredChild) {
            return;
          }
          const refreshExit = yield* Effect.exit(refreshRelatedOpenCodeSessions(context));
          if (Exit.isFailure(refreshExit)) {
            yield* Effect.logWarning(
              `${adapterConfig.displayName} failed to reconcile child sessions`,
              Cause.squash(refreshExit.cause),
            );
          }
          if (!shouldHandleSubscribedEvent(context, event)) {
            return;
          }
        }

        const turnId = context.activeTurnId;
        if (turnId) {
          context.activeTurnEventSerial += 1;
          // User-message echoes should not disable prompt recovery; track provider-side
          // activity separately for the "accepted but nothing started" watchdog.
          if (isOpenCodeTurnProviderActivityEvent(context, event)) {
            markOpenCodeTurnProviderActivity(context, turnId);
          }
        }
        yield* writeNativeEventBestEffort(context.session.threadId, {
          observedAt: nowIso(),
          event: {
            provider,
            threadId: context.session.threadId,
            providerThreadId: context.openCodeSessionId,
            type: event.type,
            ...(turnId ? { turnId } : {}),
            payload: event,
          },
        });

        switch (event.type) {
          case "message.updated": {
            context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
            context.messageSnapshotKeyById.set(
              event.properties.info.id,
              openCodeSnapshotKey(event.properties.info),
            );
            if (event.properties.info.role === "assistant") {
              const assistantMessage = event.properties.info;
              trackActiveTurnAssistantFinish(context, turnId, {
                info: {
                  ...assistantMessage,
                  role: "assistant",
                },
                parts: [],
              });
              const selectedModel = context.session.model;
              const maxTokens =
                selectedModel !== undefined
                  ? context.modelContextLimitBySlug.get(selectedModel)
                  : undefined;
              const normalizedUsage = normalizeOpenCodeTokenUsage(
                assistantMessage.tokens,
                maxTokens,
              );
              const usageKey =
                normalizedUsage !== undefined
                  ? buildOpenCodeTokenUsageKey({
                      messageId: assistantMessage.id,
                      tokens: assistantMessage.tokens,
                      maxTokens,
                    })
                  : undefined;
              const cost = nonNegativeFiniteNumber(assistantMessage.cost);
              if (cost !== undefined) {
                context.latestTurnCostUsd = cost;
              }
              if (
                normalizedUsage !== undefined &&
                usageKey !== undefined &&
                usageKey !== context.lastEmittedTokenUsageKey
              ) {
                context.lastKnownTokenUsage = normalizedUsage;
                context.lastEmittedTokenUsageKey = usageKey;
                yield* emit(context, {
                  ...buildEventBase({
                    threadId: context.session.threadId,
                    turnId,
                    raw: event,
                  }),
                  type: "thread.token-usage.updated",
                  payload: {
                    usage: normalizedUsage,
                  },
                });
              }

              for (const part of context.partById.values()) {
                if (part.messageID !== event.properties.info.id) {
                  continue;
                }
                const resolvedPart = applyPendingTextDeltaToPart(context, part);
                if (resolvedPart !== part) {
                  context.partById.set(resolvedPart.id, resolvedPart);
                }
                yield* emitAssistantTextDelta(context, resolvedPart, turnId, event);
              }
            }
            break;
          }

          case "message.removed": {
            context.messageRoleById.delete(event.properties.messageID);
            context.messageSnapshotKeyById.delete(event.properties.messageID);
            break;
          }

          case "message.part.delta": {
            const delta = event.properties.delta;
            if (delta.length === 0) {
              break;
            }
            const existingPart = context.partById.get(event.properties.partID);
            if (!existingPart) {
              bufferPendingTextDelta(context, event.properties.partID, delta);
              break;
            }
            const resolvedPart = applyPendingTextDeltaToPart(context, existingPart);
            if (resolvedPart !== existingPart) {
              context.partById.set(event.properties.partID, resolvedPart);
            }
            const role = messageRoleForPart(context, resolvedPart);
            if (role !== "assistant") {
              bufferPendingTextDelta(context, event.properties.partID, delta);
              break;
            }
            if (!shouldProjectOpenCodeTextPart(resolvedPart)) {
              break;
            }
            const streamKind = resolveTextStreamKind(resolvedPart);
            const previousText =
              context.emittedTextByPartId.get(event.properties.partID) ??
              textFromPart(resolvedPart) ??
              "";
            const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
            if (deltaToEmit.length === 0) {
              break;
            }
            markOpenCodeTurnCompletionActivity(context, turnId);
            context.emittedTextByPartId.set(event.properties.partID, nextText);
            if (resolvedPart.type === "text" || resolvedPart.type === "reasoning") {
              const nextPart = {
                ...resolvedPart,
                text: nextText,
              } satisfies Part;
              context.partById.set(event.properties.partID, nextPart);
              context.partSnapshotKeyById.set(
                event.properties.partID,
                openCodeSnapshotKey(nextPart),
              );
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.partID,
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind,
                delta: deltaToEmit,
              },
            });
            break;
          }

          case "message.part.updated": {
            const part = applyPendingTextDeltaToPart(context, event.properties.part);
            context.partById.set(part.id, part);
            context.partSnapshotKeyById.set(part.id, openCodeSnapshotKey(part));
            const messageRole = messageRoleForPart(context, part);

            if (messageRole === "assistant") {
              if (
                turnId !== undefined &&
                context.activeTurnId === turnId &&
                context.activeTurnFinalAssistantMessageId === part.messageID
              ) {
                // Any final-message part restarts the deferred-idle quiet window.
                // OpenCode may publish several completed text parts for one
                // assistant message, especially around tool calls.
                markOpenCodeTurnCompletionActivity(context, turnId);
              }
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }

            if (part.type === "tool") {
              rememberRelatedOpenCodeSession(context, part);
              const itemType = toToolLifecycleItemType(part.tool);
              const title =
                part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
              const detail = detailFromToolPart(part);
              const payload = {
                itemType,
                ...(part.state.status === "error"
                  ? { status: "failed" as const }
                  : part.state.status === "completed"
                    ? { status: "completed" as const }
                    : { status: "inProgress" as const }),
                ...(title ? { title } : {}),
                ...(detail ? { detail } : {}),
                data: {
                  tool: part.tool,
                  toolName: part.tool,
                  toolCallId: part.callID,
                  callID: part.callID,
                  ...("input" in part.state ? { input: part.state.input } : {}),
                  state: part.state,
                },
              };
              const runtimeEvent: ProviderRuntimeEvent = {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: part.callID,
                  createdAt: toolStateCreatedAt(part),
                  raw: event,
                }),
                type:
                  part.state.status === "pending"
                    ? "item.started"
                    : part.state.status === "completed" || part.state.status === "error"
                      ? "item.completed"
                      : "item.updated",
                payload,
              };
              appendTurnItem(context, turnId, part);
              yield* emit(context, runtimeEvent);
            }

            if (part.type === "compaction") {
              yield* emitContextCompactionProgress(context, {
                turnId,
                raw: event,
                detail: part.overflow
                  ? "Compacting context after provider context overflow"
                  : "Compacting context",
                data: {
                  auto: part.auto,
                  ...(part.overflow !== undefined ? { overflow: part.overflow } : {}),
                  ...(part.tail_start_id ? { tailStartId: part.tail_start_id } : {}),
                },
              });
            }
            break;
          }

          case "permission.asked": {
            if (
              context.pendingPermissions.has(event.properties.id) ||
              context.policyResolvedPermissionIds.has(event.properties.id)
            ) {
              break;
            }
            // A permission recovered without an active turn has no trustworthy interaction
            // mode. Fail closed so a request left by an interrupted Plan turn can never be
            // reinterpreted as Full Access after a process restart or reconnect.
            const policyReply =
              context.activeInteractionMode === undefined ||
              context.activeInteractionMode === "plan"
                ? "reject"
                : context.session.runtimeMode === "full-access"
                  ? "once"
                  : undefined;
            if (policyReply !== undefined) {
              context.policyResolvedPermissionIds.add(event.properties.id);
              const replyExit = yield* Effect.exit(
                runOpenCodeSdk("permission.reply", () =>
                  context.client.permission.reply({
                    requestID: event.properties.id,
                    reply: policyReply,
                  }),
                ),
              );
              if (Exit.isSuccess(replyExit)) {
                break;
              }
              context.policyResolvedPermissionIds.delete(event.properties.id);
              const detail = openCodeRuntimeErrorDetail(Cause.squash(replyExit.cause));
              yield* Effect.logWarning(
                `${adapterConfig.displayName} permission policy reply failed`,
                Cause.squash(replyExit.cause),
              );
              // A Full-access or Plan turn must never degrade into a human approval. Abort the
              // provider turn and surface an actionable failure instead.
              yield* runOpenCodeSdk("session.abort", () =>
                context.client.session.abort({ sessionID: context.openCodeSessionId }),
              ).pipe(Effect.ignore({ log: true }));
              if (turnId !== undefined && context.activeTurnId === turnId) {
                yield* completeOpenCodeTurn(context, {
                  turnId,
                  raw: event,
                  errorMessage: `${adapterConfig.displayName} could not apply ${policyReply === "reject" ? "Plan-mode" : "Full-access"} permission policy: ${detail}`,
                });
              } else {
                yield* emit(context, {
                  ...buildEventBase({ threadId: context.session.threadId, raw: event }),
                  type: "runtime.warning",
                  payload: {
                    message: `${adapterConfig.displayName} could not apply its permission policy.`,
                    detail,
                  },
                });
              }
              break;
            }
            context.pendingPermissions.set(event.properties.id, event.properties);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.id,
                raw: event,
              }),
              type: "request.opened",
              payload: {
                requestType: mapPermissionToRequestType(event.properties.permission),
                detail:
                  event.properties.patterns.length > 0
                    ? event.properties.patterns.join("\n")
                    : event.properties.permission,
                args: event.properties.metadata,
              },
            });
            break;
          }

          case "permission.replied": {
            if (context.policyResolvedPermissionIds.delete(event.properties.requestID)) {
              // Synara policy resolved this request; nothing was surfaced to the UI.
              break;
            }
            const request = context.pendingPermissions.get(event.properties.requestID);
            context.pendingPermissions.delete(event.properties.requestID);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "request.resolved",
              payload: {
                requestType: request ? mapPermissionToRequestType(request.permission) : "unknown",
                decision: mapPermissionDecision(event.properties.reply),
              },
            });
            break;
          }

          case "question.asked": {
            if (context.pendingQuestions.has(event.properties.id)) {
              break;
            }
            context.pendingQuestions.set(event.properties.id, event.properties);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.id,
                raw: event,
              }),
              type: "user-input.requested",
              payload: {
                questions: normalizeQuestionRequest(event.properties),
              },
            });
            break;
          }

          case "question.replied": {
            const request = context.pendingQuestions.get(event.properties.requestID);
            context.pendingQuestions.delete(event.properties.requestID);
            const answers = Object.fromEntries(
              (request?.questions ?? []).map((question, index) => [
                openCodeQuestionId(index, question),
                event.properties.answers[index]?.join(", ") ?? "",
              ]),
            );
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "user-input.resolved",
              payload: { answers },
            });
            break;
          }

          case "question.rejected": {
            context.pendingQuestions.delete(event.properties.requestID);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "user-input.resolved",
              payload: { answers: {} },
            });
            break;
          }

          case "todo.updated": {
            const tasksPayload = normalizeOpenCodeTodoTasks(event.properties.todos);
            if (!tasksPayload) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              }),
              type: "turn.tasks.updated",
              payload: tasksPayload,
            });
            break;
          }

          case "session.status": {
            if (event.properties.status.type === "busy") {
              updateProviderSession(context, {
                status: "running",
                activeTurnId: turnId,
              });
            }

            if (event.properties.status.type === "retry") {
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                }),
                type: "runtime.warning",
                payload: {
                  message: event.properties.status.message,
                  detail: event.properties.status,
                },
              });
              break;
            }

            if (event.properties.status.type === "idle" && turnId) {
              if (yield* deferPrematureIdleCompletion(context, turnId, event)) {
                break;
              }
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                totalCostUsd: context.latestTurnCostUsd,
              });
            }
            break;
          }

          case "session.idle": {
            if (turnId) {
              if (yield* deferPrematureIdleCompletion(context, turnId, event)) {
                break;
              }
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                totalCostUsd: context.latestTurnCostUsd,
              });
            }
            break;
          }

          // Newer OpenCode servers can emit session.next.* events for the active
          // agent loop. Mirror them into Synara's canonical transcript stream.
          case "session.next.text.delta": {
            if (!turnId || event.properties.delta.length === 0) {
              break;
            }
            const itemId = openCodeNextTextItemId(turnId);
            const previousText = context.emittedTextByPartId.get(itemId) ?? "";
            const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(
              previousText,
              event.properties.delta,
            );
            if (deltaToEmit.length === 0) {
              break;
            }
            context.emittedTextByPartId.set(itemId, nextText);
            markOpenCodeTurnCompletionActivity(context, turnId);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: deltaToEmit,
              },
            });
            break;
          }

          case "session.next.text.ended": {
            if (!turnId) {
              break;
            }
            const itemId = openCodeNextTextItemId(turnId);
            const text = event.properties.text;
            const previousText = context.emittedTextByPartId.get(itemId) ?? "";
            const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
            context.emittedTextByPartId.set(itemId, latestText);
            if (deltaToEmit.length > 0) {
              markOpenCodeTurnCompletionActivity(context, turnId);
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId,
                  createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                  raw: event,
                }),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: deltaToEmit,
                },
              });
            }
            if (!context.completedAssistantPartIds.has(itemId)) {
              context.completedAssistantPartIds.add(itemId);
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId,
                  createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                  raw: event,
                }),
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  title: "Assistant message",
                  ...(latestText.length > 0 ? { detail: latestText } : {}),
                },
              });
            }
            break;
          }

          case "session.next.reasoning.delta": {
            if (!turnId || event.properties.delta.length === 0) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.reasoningID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind: "reasoning_text",
                delta: event.properties.delta,
              },
            });
            break;
          }

          case "session.next.reasoning.ended": {
            if (!turnId) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.reasoningID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: "completed",
                title: "Reasoning",
                ...(event.properties.text ? { detail: event.properties.text } : {}),
              },
            });
            break;
          }

          case "session.next.shell.started": {
            if (!turnId) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.started",
              payload: {
                itemType: "command_execution",
                status: "inProgress",
                title: "Ran command",
                detail: event.properties.command,
                data: {
                  tool: "shell",
                  toolName: "shell",
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  command: event.properties.command,
                  sessionID: event.properties.sessionID,
                },
              },
            });
            break;
          }

          case "session.next.shell.ended": {
            if (!turnId) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: "command_execution",
                status: "completed",
                title: "Ran command",
                ...(event.properties.output ? { detail: event.properties.output } : {}),
                data: {
                  tool: "shell",
                  toolName: "shell",
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  output: event.properties.output,
                  sessionID: event.properties.sessionID,
                },
              },
            });
            break;
          }

          case "session.next.tool.called": {
            if (!turnId) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.started",
              payload: {
                itemType: toToolLifecycleItemType(event.properties.tool),
                status: "inProgress",
                title: event.properties.tool,
                data: {
                  tool: event.properties.tool,
                  toolName: event.properties.tool,
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  input: event.properties.input,
                  provider: event.properties.provider,
                },
              },
            });
            break;
          }

          case "session.next.tool.progress":
          case "session.next.tool.success": {
            if (!turnId) {
              break;
            }
            const detail = openCodeToolContentText(event.properties.content);
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: event.type === "session.next.tool.success" ? "item.completed" : "item.updated",
              payload: {
                itemType: "dynamic_tool_call",
                status: event.type === "session.next.tool.success" ? "completed" : "inProgress",
                ...(detail ? { detail } : {}),
                data: {
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  structured: event.properties.structured,
                  content: event.properties.content,
                  ...("provider" in event.properties
                    ? { provider: event.properties.provider }
                    : {}),
                },
              },
            });
            break;
          }

          case "session.next.tool.failed": {
            if (!turnId) {
              break;
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.callID,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: "dynamic_tool_call",
                status: "failed",
                detail: event.properties.error.message,
                data: {
                  toolCallId: event.properties.callID,
                  callID: event.properties.callID,
                  error: event.properties.error,
                  provider: event.properties.provider,
                },
              },
            });
            break;
          }

          case "session.next.step.ended": {
            if (!turnId) {
              break;
            }
            const selectedModel = context.session.model;
            const maxTokens =
              selectedModel !== undefined
                ? context.modelContextLimitBySlug.get(selectedModel)
                : undefined;
            const normalizedUsage = normalizeOpenCodeTokenUsage(event.properties.tokens, maxTokens);
            if (normalizedUsage !== undefined) {
              context.lastKnownTokenUsage = normalizedUsage;
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                  raw: event,
                }),
                type: "thread.token-usage.updated",
                payload: {
                  usage: normalizedUsage,
                },
              });
            }
            context.latestTurnCostUsd = nonNegativeFiniteNumber(event.properties.cost);
            if (isOpenCodeToolCallFinish(event.properties.finish)) {
              context.activeTurnSawToolCallFinish = true;
            }
            if (isOpenCodeTerminalStepFinish(event.properties.finish)) {
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                totalCostUsd: context.latestTurnCostUsd,
              });
            }
            break;
          }

          case "session.next.step.failed": {
            const message = event.properties.error.message || "OpenCode session failed.";
            if (turnId) {
              yield* completeOpenCodeTurn(context, {
                turnId,
                raw: event,
                errorMessage: message,
              });
            } else {
              updateProviderSession(
                context,
                {
                  status: "error",
                  lastError: message,
                },
                { clearActiveTurnId: true },
              );
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: event.properties.error,
              },
            });
            break;
          }

          case "session.next.retried": {
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                createdAt: isoFromOpenCodeTimestamp(event.properties.timestamp),
                raw: event,
              }),
              type: "runtime.warning",
              payload: {
                message: event.properties.error.message,
                detail: event.properties,
              },
            });
            break;
          }

          case "session.compacted": {
            yield* emitContextCompacted(context, { turnId, raw: event });
            break;
          }

          case "session.error": {
            const message = sessionErrorMessage(event.properties.error);
            if (isOpenCodeContextOverflowError(event.properties.error)) {
              updateProviderSession(
                context,
                {
                  status: "running",
                },
                { clearLastError: true },
              );
              yield* emitContextCompactionProgress(context, {
                turnId,
                raw: event,
                detail: message,
                data: {
                  state: "context_overflow",
                },
              });
              break;
            }
            const activeTurnId = context.activeTurnId;
            clearActiveTurnState(context);
            updateProviderSession(
              context,
              {
                status: "error",
                lastError: message,
              },
              { clearActiveTurnId: true },
            );
            if (activeTurnId) {
              yield* emit(context, {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurnId,
                  raw: event,
                }),
                type: "turn.completed",
                payload: {
                  state: "failed",
                  errorMessage: message,
                },
              });
            }
            yield* emit(context, {
              ...buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: event.properties.error,
              },
            });
            break;
          }

          default:
            break;
        }
      });

      const reconcilePendingOpenCodeInteractions = Effect.fn(
        "reconcilePendingOpenCodeInteractions",
      )(function* (context: OpenCodeSessionContext) {
        yield* refreshRelatedOpenCodeSessions(context).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `${adapterConfig.displayName} pending child-session reconciliation failed`,
              Cause.squash(cause),
            ),
          ),
        );
        const [permissions, questions] = yield* Effect.all([
          runOpenCodeSdk("permission.list", () => context.client.permission.list()).pipe(
            Effect.map((response) => response.data ?? []),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `${adapterConfig.displayName} pending permission reconciliation failed`,
                Cause.squash(cause),
              ).pipe(Effect.as([] as ReadonlyArray<PermissionRequest>)),
            ),
          ),
          runOpenCodeSdk("question.list", () => context.client.question.list()).pipe(
            Effect.map((response) => response.data ?? []),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `${adapterConfig.displayName} pending question reconciliation failed`,
                Cause.squash(cause),
              ).pipe(Effect.as([] as ReadonlyArray<QuestionRequest>)),
            ),
          ),
        ]);
        const belongsToSessionTree = (sessionId: string) =>
          sessionId === context.openCodeSessionId || context.relatedSessionIds.has(sessionId);

        for (const request of permissions) {
          if (!belongsToSessionTree(request.sessionID)) {
            continue;
          }
          yield* handleSubscribedEvent(context, {
            type: "permission.asked",
            properties: request,
          } as OpenCodeSubscribedEvent);
        }
        for (const request of questions) {
          if (!belongsToSessionTree(request.sessionID)) {
            continue;
          }
          yield* handleSubscribedEvent(context, {
            type: "question.asked",
            properties: request,
          } as OpenCodeSubscribedEvent);
        }
      });

      const loadCurrentMessageSnapshots = Effect.fn("loadCurrentMessageSnapshots")(function* (
        context: OpenCodeSessionContext,
      ) {
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        );
        return openCodeMessageSnapshotsFromResponse(messages.data ?? []);
      });

      const rememberCurrentMessageSnapshots = Effect.fn("rememberCurrentMessageSnapshots")(
        function* (context: OpenCodeSessionContext) {
          const snapshots = yield* loadCurrentMessageSnapshots(context);
          for (const snapshot of snapshots) {
            rememberOpenCodeMessageSnapshot(context, snapshot);
          }
          return new Set(snapshots.map((snapshot) => snapshot.info.id));
        },
      );

      const collectKnownMessageIds = (context: OpenCodeSessionContext): Set<string> =>
        new Set(context.messageRoleById.keys());

      const captureTurnSnapshotWatchdogBaseline = Effect.fn("captureTurnSnapshotWatchdogBaseline")(
        function* (context: OpenCodeSessionContext) {
          const knownMessageIds = collectKnownMessageIds(context);
          const snapshotsExit = yield* Effect.exit(rememberCurrentMessageSnapshots(context));
          if (Exit.isSuccess(snapshotsExit)) {
            // Preserve already observed ids even if OpenCode returns a partial message list.
            for (const messageId of snapshotsExit.value) {
              knownMessageIds.add(messageId);
            }
            return {
              canStartWatchdog: true,
              messageIds: knownMessageIds,
            } as const;
          }

          if (knownMessageIds.size > 0) {
            return {
              canStartWatchdog: true,
              messageIds: knownMessageIds,
            } as const;
          }

          // Without a pre-turn or remembered baseline, old completed assistant messages
          // are indistinguishable from this turn's final response.
          yield* writeNativeEventBestEffort(context.session.threadId, {
            observedAt: nowIso(),
            event: {
              provider,
              threadId: context.session.threadId,
              providerThreadId: context.openCodeSessionId,
              type: "turn.snapshot-watchdog.disabled",
              detail: openCodeRuntimeErrorDetail(Cause.squash(snapshotsExit.cause)),
            },
          });
          return {
            canStartWatchdog: false,
            messageIds: knownMessageIds,
          } as const;
        },
      );

      const replayOpenCodeMessageSnapshots = Effect.fn("replayOpenCodeMessageSnapshots")(function* (
        context: OpenCodeSessionContext,
        snapshots: ReadonlyArray<OpenCodeMessageSnapshot>,
        turnId: TurnId,
      ) {
        for (const snapshot of snapshots) {
          const messageKey = openCodeSnapshotKey(snapshot.info);
          if (context.messageSnapshotKeyById.get(snapshot.info.id) !== messageKey) {
            yield* handleSubscribedEvent(context, {
              type: "message.updated",
              properties: {
                sessionID: context.openCodeSessionId,
                info: snapshot.info,
              },
            } as OpenCodeSubscribedEvent);
          }

          for (const part of snapshot.parts) {
            const partKey = openCodeSnapshotKey(part);
            if (context.partSnapshotKeyById.get(part.id) === partKey) {
              continue;
            }
            yield* handleSubscribedEvent(context, {
              type: "message.part.updated",
              properties: {
                sessionID: context.openCodeSessionId,
                part,
              },
            } as OpenCodeSubscribedEvent);
          }
        }

        if (context.activeTurnId !== turnId) {
          return;
        }
      });

      // Completion backstop for OpenCode-family providers: the SSE stream can drop or
      // delay the terminal `session.idle` event (child-session gating, reconnects,
      // provider-specific final-message shapes), which leaves a turn stuck in
      // "working" even though the provider already finished. This independent fiber
      // polls session status and, once the session looks idle with a fresh final
      // assistant message, synthesizes the idle event so the turn completes.
      //
      // `pollMessagesWhileBusy` trades load for liveness: Kilo pulls the full message
      // list every tick to also act as a live transcript catch-up; plain OpenCode
      // keeps it cheap by only pulling messages once the session is no longer busy
      // (fetching a large transcript every 500ms would be wasteful on big turns).
      const startTurnSnapshotWatchdog = Effect.fn("startTurnSnapshotWatchdog")(function* (
        context: OpenCodeSessionContext,
        turnId: TurnId,
        baselineMessageIds: ReadonlySet<string>,
        options: { readonly pollMessagesWhileBusy: boolean },
      ) {
        yield* Effect.gen(function* () {
          let idlePollsWithFinalMessage = 0;

          while (!(yield* Ref.get(context.stopped)) && context.activeTurnId === turnId) {
            yield* Effect.sleep(500);

            const statusExit = yield* Effect.exit(
              runOpenCodeSdk("session.status", () =>
                context.client.session.status({
                  directory: context.directory,
                }),
              ),
            );
            const statusKnown = Exit.isSuccess(statusExit);
            const status = statusKnown
              ? statusExit.value.data?.[context.openCodeSessionId]
              : undefined;
            const sessionBusy = status?.type === "busy" || status?.type === "retry";

            let hasFinalAssistantMessage = false;
            if (options.pollMessagesWhileBusy || (statusKnown && !sessionBusy)) {
              const snapshotsExit = yield* Effect.exit(loadCurrentMessageSnapshots(context));
              if (Exit.isSuccess(snapshotsExit)) {
                yield* replayOpenCodeMessageSnapshots(context, snapshotsExit.value, turnId);
                hasFinalAssistantMessage = snapshotsExit.value.some(
                  (snapshot) =>
                    !baselineMessageIds.has(snapshot.info.id) &&
                    isFinalAssistantMessageSnapshot(snapshot),
                );
              }
            }

            if (!statusKnown || sessionBusy) {
              idlePollsWithFinalMessage = 0;
              continue;
            }

            idlePollsWithFinalMessage = hasFinalAssistantMessage
              ? idlePollsWithFinalMessage + 1
              : 0;
            if (idlePollsWithFinalMessage < 1 || context.activeTurnId !== turnId) {
              continue;
            }

            yield* handleSubscribedEvent(context, {
              type: "session.status",
              properties: {
                sessionID: context.openCodeSessionId,
                status: {
                  type: "idle",
                },
              },
            } as OpenCodeSubscribedEvent);
            return;
          }
        }).pipe(
          Effect.catchCause((cause) =>
            writeNativeEventBestEffort(context.session.threadId, {
              observedAt: nowIso(),
              event: {
                provider,
                threadId: context.session.threadId,
                providerThreadId: context.openCodeSessionId,
                type: "turn.snapshot-watchdog.error",
                turnId,
                detail: openCodeRuntimeErrorDetail(Cause.squash(cause)),
              },
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      });

      const startEventPump = Effect.fn("startEventPump")(function* (
        context: OpenCodeSessionContext,
      ) {
        const eventsAbortController = new AbortController();
        yield* Scope.addFinalizer(
          context.sessionScope,
          Effect.sync(() => eventsAbortController.abort()),
        );

        yield* Effect.gen(function* () {
          let reconnectAttempt = 0;
          while (!eventsAbortController.signal.aborted && !(yield* Ref.get(context.stopped))) {
            const subscriptionExit = yield* Effect.exit(
              Effect.gen(function* () {
                const subscription = yield* runOpenCodeSdk("event.subscribe", () =>
                  context.client.event.subscribe(undefined, {
                    signal: eventsAbortController.signal,
                  }),
                );
                yield* reconcilePendingOpenCodeInteractions(context).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `${adapterConfig.displayName} pending interaction reconciliation failed`,
                      Cause.squash(cause),
                    ),
                  ),
                );
                yield* Stream.fromAsyncIterable(
                  subscription.stream,
                  (cause) =>
                    new OpenCodeRuntimeError({
                      operation: "event.subscribe",
                      detail: openCodeRuntimeErrorDetail(cause),
                      cause,
                    }),
                ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event)));
              }),
            );
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }

            const delayMs =
              OPENCODE_EVENT_RECONNECT_DELAYS_MS[
                Math.min(reconnectAttempt, OPENCODE_EVENT_RECONNECT_DELAYS_MS.length - 1)
              ] ?? OPENCODE_EVENT_RECONNECT_DELAYS_MS[0];
            reconnectAttempt += 1;
            yield* Effect.sleep(delayMs);
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            const detail = Exit.isFailure(subscriptionExit)
              ? openCodeRuntimeErrorDetail(Cause.squash(subscriptionExit.cause))
              : `${adapterConfig.displayName} event stream ended.`;
            yield* emit(context, {
              ...buildEventBase({ threadId: context.session.threadId }),
              type: "runtime.warning",
              payload: {
                message: `${adapterConfig.displayName} event stream disconnected; reconnecting.`,
                detail,
              },
            });
          }
        }).pipe(Effect.forkIn(context.sessionScope));

        if (!context.server.external && context.server.exitCode !== null) {
          yield* context.server.exitCode.pipe(
            Effect.flatMap((code) =>
              Effect.gen(function* () {
                if (yield* Ref.get(context.stopped)) {
                  return;
                }
                yield* emitUnexpectedExit(
                  context,
                  `${adapterConfig.displayName} server exited unexpectedly (${code}).`,
                );
              }),
            ),
            Effect.forkIn(context.sessionScope),
          );
        }
      });

      const applyPermissionInteractionMode = Effect.fn("applyPermissionInteractionMode")(function* (
        context: OpenCodeSessionContext,
        interactionMode: "default" | "plan",
      ) {
        if (context.appliedPermissionInteractionMode === interactionMode) {
          return;
        }
        yield* runOpenCodeSdk("session.update", () =>
          context.client.session.update({
            sessionID: context.openCodeSessionId,
            permission: buildOpenCodePermissionRules(context.session.runtimeMode, interactionMode),
          }),
        ).pipe(Effect.mapError(toAdapterRequestError));
        context.appliedPermissionInteractionMode = interactionMode;
      });

      const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          const providerOptions = input.providerOptions?.[adapterConfig.providerOptionsKey];
          const binaryPath = providerOptions?.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
          const serverUrl = providerOptions?.serverUrl?.trim();
          const serverPassword = options?.resolveServerPassword
            ? yield* options.resolveServerPassword(provider)
            : undefined;
          const experimentalWebSockets =
            adapterConfig.providerOptionsKey === "opencode"
              ? input.providerOptions?.opencode?.experimentalWebSockets
              : undefined;
          const resumeDirectory = extractResumeCwd(input.resumeCursor);
          const directory = input.cwd ?? resumeDirectory ?? serverConfig.cwd;
          const initialParsedModel =
            input.modelSelection?.provider === adapterConfig.provider
              ? parseOpenCodeModelSlug(input.modelSelection.model)
              : null;
          const initialAgent =
            input.modelSelection?.provider === adapterConfig.provider
              ? input.modelSelection.options?.agent
              : undefined;
          const initialVariant =
            input.modelSelection?.provider === adapterConfig.provider
              ? input.modelSelection.options?.variant
              : undefined;
          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* stopOpenCodeContext(existing);
            sessions.delete(input.threadId);
          }

          const resumedSessionId = extractResumeSessionId(input.resumeCursor);
          // OpenCode's MCP registry is process/directory scoped, not session
          // scoped. A gateway token is therefore issued only for a managed
          // server that this runtime isolates to the exact Synara thread.
          const agentGatewaySessionLease = serverUrl
            ? undefined
            : acquireAgentGatewaySessionLease(agentGatewayCredentials, input.threadId, provider);
          const agentGatewayConnection = agentGatewaySessionLease?.connection;
          const poolIsolationKey = agentGatewayConnection ? randomUUID() : undefined;

          let sessionScopeTransferred = false;
          const installed = yield* Effect.acquireUseRelease(
            Scope.make(),
            (sessionScope) =>
              Effect.gen(function* () {
                const startedExit = yield* Effect.exit(
                  Effect.gen(function* () {
                    const server = yield* openCodeRuntime.connectToOpenCodeServer({
                      binaryPath,
                      cliSpec: adapterConfig.cliSpec,
                      cwd: directory,
                      ...(serverUrl ? { serverUrl } : {}),
                      ...(provider === "opencode" && experimentalWebSockets
                        ? { experimentalWebSockets: true }
                        : {}),
                      ...(poolIsolationKey ? { poolIsolationKey } : {}),
                    });
                    const client = openCodeRuntime.createOpenCodeSdkClient({
                      baseUrl: server.url,
                      directory,
                      cliSpec: adapterConfig.cliSpec,
                      ...(server.external && serverPassword ? { serverPassword } : {}),
                    });
                    const gatewayControlAvailable = agentGatewayConnection
                      ? yield* runOpenCodeSdk("mcp.add", () =>
                          client.mcp.add({
                            directory,
                            name: SYNARA_MCP_SERVER_NAME,
                            config: buildOpenCodeMcpServer(agentGatewayConnection),
                          }),
                        ).pipe(
                          Effect.flatMap((result) => {
                            const status = result.data?.[SYNARA_MCP_SERVER_NAME];
                            return status?.status === "connected"
                              ? Effect.void
                              : Effect.fail(
                                  new OpenCodeRuntimeError({
                                    operation: "mcp.add",
                                    detail:
                                      status?.status === "failed"
                                        ? `${adapterConfig.displayName} Synara MCP connection failed: ${status.error}`
                                        : `${adapterConfig.displayName} Synara MCP connection did not become ready.`,
                                  }),
                                );
                          }),
                          Effect.as(true),
                          Effect.catchCause((cause) =>
                            Effect.sync(() => agentGatewaySessionLease?.release()).pipe(
                              Effect.andThen(
                                Effect.logWarning(
                                  `${adapterConfig.displayName} could not install thread-scoped Synara MCP control`,
                                  Cause.squash(cause),
                                ),
                              ),
                              Effect.as(false),
                            ),
                          ),
                        )
                      : false;
                    const createSessionId = resumedSessionId
                      ? // A resumed provider may still be executing an interrupted Plan turn.
                        // Install the read-only ruleset until Synara dispatches a new turn with a
                        // known interaction mode. This must succeed before the event pump starts:
                        // otherwise an already-running Full Access session could mutate state
                        // without ever emitting a permission request for Synara to reject.
                        runOpenCodeSdk("session.update", () =>
                          client.session.update({
                            sessionID: resumedSessionId,
                            permission: buildOpenCodePermissionRules(input.runtimeMode, "plan"),
                          }),
                        ).pipe(
                          Effect.tapError(() =>
                            runOpenCodeSdk("session.abort", () =>
                              client.session.abort({ sessionID: resumedSessionId }),
                            ).pipe(Effect.ignore({ log: true })),
                          ),
                          Effect.as(resumedSessionId),
                        )
                      : runOpenCodeSdk("session.create", () => {
                          const sessionCreateInput = {
                            ...(initialParsedModel
                              ? {
                                  model: {
                                    providerID: initialParsedModel.providerID,
                                    id: initialParsedModel.modelID,
                                    ...(initialVariant ? { variant: initialVariant } : {}),
                                  },
                                }
                              : {}),
                            ...(initialAgent ? { agent: initialAgent } : {}),
                            permission: buildOpenCodePermissionRules(input.runtimeMode),
                            title: `Synara ${input.threadId}`,
                          };
                          return client.session.create(
                            sessionCreateInput as unknown as Parameters<
                              typeof client.session.create
                            >[0],
                          );
                        }).pipe(
                          Effect.flatMap((sessionResult) =>
                            sessionResult.data?.id
                              ? Effect.succeed(sessionResult.data.id)
                              : Effect.fail(
                                  new OpenCodeRuntimeError({
                                    operation: "session.create",
                                    detail: `${adapterConfig.displayName} session.create returned no session payload.`,
                                  }),
                                ),
                          ),
                        );
                    const loadModelContextLimits = openCodeRuntime
                      .loadOpenCodeInventory(client)
                      .pipe(
                        Effect.map(buildOpenCodeModelContextLimitMap),
                        Effect.catchCause(() => Effect.succeed(new Map<string, number>())),
                      );
                    // Session creation and metadata discovery are independent once the server is up.
                    const [openCodeSessionId, modelContextLimitBySlug] = yield* Effect.all(
                      [createSessionId, loadModelContextLimits],
                      { concurrency: "unbounded" },
                    );

                    return {
                      sessionScope,
                      server,
                      client,
                      openCodeSessionId,
                      modelContextLimitBySlug,
                      gatewayControlAvailable,
                    };
                  }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
                );
                if (Exit.isFailure(startedExit)) {
                  return yield* toAdapterProcessError(
                    input.threadId,
                    Cause.squash(startedExit.cause),
                  );
                }

                const started = startedExit.value;
                if (options?.beforeSessionInstall) {
                  yield* options.beforeSessionInstall;
                }

                const raceWinner = sessions.get(input.threadId);
                if (raceWinner) {
                  yield* runOpenCodeSdk("session.abort", () =>
                    started.client.session.abort({
                      sessionID: started.openCodeSessionId,
                    }),
                  ).pipe(Effect.ignore);
                  return {
                    kind: "race-winner" as const,
                    session: raceWinner.session,
                  };
                }

                const createdAt = nowIso();
                const session: ProviderSession = {
                  provider,
                  status: "ready",
                  runtimeMode: input.runtimeMode,
                  cwd: directory,
                  ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
                  threadId: input.threadId,
                  resumeCursor: { openCodeSessionId: started.openCodeSessionId, cwd: directory },
                  createdAt,
                  updatedAt: createdAt,
                };

                const context: OpenCodeSessionContext = {
                  session,
                  gatewayControlAvailable: started.gatewayControlAvailable,
                  ...(started.gatewayControlAvailable && agentGatewaySessionLease
                    ? {
                        gatewaySessionLease: agentGatewaySessionLease,
                      }
                    : {}),
                  ...(input.lifecycleGeneration !== undefined
                    ? { lifecycleGeneration: input.lifecycleGeneration }
                    : {}),
                  client: started.client,
                  server: started.server,
                  directory,
                  openCodeSessionId: started.openCodeSessionId,
                  pendingPermissions: new Map(),
                  policyResolvedPermissionIds: new Set(),
                  pendingQuestions: new Map(),
                  pendingTextDeltasByPartId: new Map(),
                  partById: new Map(),
                  partSnapshotKeyById: new Map(),
                  emittedTextByPartId: new Map(),
                  messageRoleById: new Map(),
                  messageSnapshotKeyById: new Map(),
                  completedAssistantPartIds: new Set(),
                  relatedSessionIds: new Set(),
                  turns: [],
                  modelContextLimitBySlug: started.modelContextLimitBySlug,
                  lastKnownTokenUsage: undefined,
                  lastEmittedTokenUsageKey: undefined,
                  latestTurnCostUsd: undefined,
                  activeTurnId: undefined,
                  activeTurnEventSerial: 0,
                  activeTurnProviderActivitySerial: 0,
                  activeTurnCompletionActivitySerial: 0,
                  activeTurnSawToolCallFinish: false,
                  activeTurnSawFinalAssistant: false,
                  activeTurnFinalAssistantMessageId: undefined,
                  activeTurnToolCallIdleWatchdogStarted: false,
                  activeInteractionMode: undefined,
                  appliedPermissionInteractionMode: resumedSessionId ? "plan" : "default",
                  activeAgent: undefined,
                  activeVariant: undefined,
                  stopped: yield* Ref.make(false),
                  sessionScope: started.sessionScope,
                };
                sessions.set(input.threadId, context);
                sessionScopeTransferred = true;
                return {
                  kind: "installed" as const,
                  session,
                  context,
                };
              }),
            (sessionScope) =>
              sessionScopeTransferred
                ? Effect.void
                : Scope.close(sessionScope, Exit.void).pipe(
                    Effect.ignore,
                    Effect.ensuring(Effect.sync(() => agentGatewaySessionLease?.release())),
                  ),
          );

          if (installed.kind === "race-winner") {
            return installed.session;
          }

          const { context, session } = installed;
          yield* startEventPump(context);

          yield* emit(context, {
            ...buildEventBase({ threadId: input.threadId }),
            type: "session.started",
            payload: {
              message: resumedSessionId
                ? `${adapterConfig.displayName} session resumed`
                : `${adapterConfig.displayName} session started`,
              resume: { openCodeSessionId: context.openCodeSessionId },
            },
          });
          yield* emit(context, {
            ...buildEventBase({ threadId: input.threadId }),
            type: "thread.started",
            payload: {
              providerThreadId: context.openCodeSessionId,
            },
          });

          return session;
        },
      );

      const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureAdapterSessionContext(input.threadId);
        const turnId = TurnId.makeUnsafe(`${adapterConfig.turnIdPrefix}-${randomUUID()}`);
        const modelSelection =
          input.modelSelection ??
          (context.session.model ? { provider, model: context.session.model } : undefined);
        const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `${adapterConfig.displayName} model selection must use the 'provider/model' format.`,
          });
        }

        const baseText = withProviderPlanModePrompt({
          text: input.input?.trim() ?? "",
          interactionMode: input.interactionMode,
        }).trim();
        const text =
          appendFileAttachmentsPromptBlock({
            text: baseText,
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          })?.trim() ?? "";
        const fileParts = toOpenCodeFileParts({
          attachments: input.attachments,
          resolveAttachmentPath: (attachment) =>
            resolveProviderAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            }),
        });
        if ((!text || text.length === 0) && fileParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `${adapterConfig.displayName} turns require text input or at least one attachment.`,
          });
        }
        const harnessPolicy = takeSynaraHarnessPolicyForProviderSession(context, {
          provider,
          scopedGatewayConnectionAvailable: context.gatewayControlAvailable,
        });
        const providerText = [harnessPolicy, text].filter(Boolean).join("\n\n");

        const requestedAgent =
          input.modelSelection?.provider === provider
            ? input.modelSelection.options?.agent
            : undefined;
        const variant =
          input.modelSelection?.provider === provider
            ? input.modelSelection.options?.variant
            : undefined;

        const interactionMode = input.interactionMode === "plan" ? "plan" : "default";
        yield* applyPermissionInteractionMode(context, interactionMode);

        context.activeTurnId = turnId;
        context.activeTurnEventSerial = 0;
        context.activeTurnProviderActivitySerial = 0;
        context.activeTurnCompletionActivitySerial = 0;
        context.activeTurnSawToolCallFinish = false;
        context.activeTurnSawFinalAssistant = false;
        context.activeTurnFinalAssistantMessageId = undefined;
        context.activeTurnToolCallIdleWatchdogStarted = false;
        context.activeInteractionMode = interactionMode;
        // Always pin Synara's interaction mode to OpenCode's primary agent.
        // Otherwise a user config with default agent=plan (or a stale options.agent=plan
        // after leaving Synara plan mode) can trap default turns in plan mode.
        const modePinnedAgent =
          interactionMode === "plan" ? adapterConfig.planAgent : adapterConfig.defaultAgent;
        context.activeAgent =
          interactionMode !== "plan" && requestedAgent === adapterConfig.planAgent
            ? adapterConfig.defaultAgent
            : (requestedAgent ?? modePinnedAgent);
        context.activeVariant = variant;
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            model: modelSelection?.model ?? context.session.model,
          },
          { clearLastError: true },
        );

        yield* emit(context, {
          ...buildEventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });

        if (provider === "kilo") {
          const snapshotWatchdogBaseline = yield* captureTurnSnapshotWatchdogBaseline(context);
          const recoveryBaselineMessageIds = yield* captureOpenCodeRecoveryBaseline(context);
          const providerActivitySerial = context.activeTurnProviderActivitySerial;
          yield* schedulePromptAcceptedWatchdog(context, {
            turnId,
            providerActivitySerial,
            excludedMessageIds: recoveryBaselineMessageIds,
          });
          yield* submitOpenCodePrompt(context, {
            turnId,
            promptInput: {
              sessionID: context.openCodeSessionId,
              messageID: `msg_${randomUUID()}`,
              model: parsedModel,
              ...(context.activeAgent ? { agent: context.activeAgent } : {}),
              ...(context.activeVariant ? { variant: context.activeVariant } : {}),
              noReply: false,
              parts: [
                ...(providerText ? [{ type: "text" as const, text: providerText }] : []),
                ...fileParts,
              ],
            },
          });
          if (snapshotWatchdogBaseline.canStartWatchdog) {
            yield* startTurnSnapshotWatchdog(context, turnId, snapshotWatchdogBaseline.messageIds, {
              pollMessagesWhileBusy: true,
            });
          }
        } else {
          // Capture the pre-turn message ids before submitting so the watchdog can
          // distinguish this turn's final assistant message from prior ones.
          const snapshotWatchdogBaseline = yield* captureTurnSnapshotWatchdogBaseline(context);
          yield* submitOpenCodePromptAsync(context, {
            turnId,
            promptInput: {
              sessionID: context.openCodeSessionId,
              model: parsedModel,
              ...(context.activeAgent ? { agent: context.activeAgent } : {}),
              ...(context.activeVariant ? { variant: context.activeVariant } : {}),
              parts: [
                ...(providerText ? [{ type: "text" as const, text: providerText }] : []),
                ...fileParts,
              ],
            },
          });
          // OpenCode lacks Kilo's prompt-accepted hard-fail watchdog, but it still
          // needs a completion backstop for dropped/delayed idle events. Keep the
          // poll cheap (status-first) so large turns are not penalized.
          if (snapshotWatchdogBaseline.canStartWatchdog) {
            yield* startTurnSnapshotWatchdog(context, turnId, snapshotWatchdogBaseline.messageIds, {
              pollMessagesWhileBusy: false,
            });
          }
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: { openCodeSessionId: context.openCodeSessionId, cwd: context.directory },
        };
      });

      const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, turnId) {
          const context = ensureAdapterSessionContext(threadId);
          const activeTurnId = turnId ?? context.activeTurnId;
          yield* runOpenCodeSdk("session.abort", () =>
            context.client.session.abort({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));
          clearActiveTurnState(context);
          updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          if (activeTurnId) {
            yield* emit(context, {
              ...buildEventBase({ threadId, turnId: activeTurnId }),
              type: "turn.aborted",
              payload: {
                reason: "Interrupted by user.",
              },
            });
          }
        },
      );

      const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
        "respondToRequest",
      )(function* (threadId, requestId, decision) {
        const context = ensureAdapterSessionContext(threadId);
        if (!context.pendingPermissions.has(requestId)) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "permission.reply",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }

        yield* runOpenCodeSdk("permission.reply", () =>
          context.client.permission.reply({
            requestID: requestId,
            reply: toOpenCodePermissionReply(decision),
          }),
        ).pipe(Effect.mapError(toAdapterRequestError));
      });

      const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, requestId, answers) {
        const context = ensureAdapterSessionContext(threadId);
        const request = context.pendingQuestions.get(requestId);
        if (!request) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "question.reply",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        yield* runOpenCodeSdk("question.reply", () =>
          context.client.question.reply({
            requestID: requestId,
            answers: toOpenCodeQuestionAnswers(request, answers),
          }),
        ).pipe(Effect.mapError(toAdapterRequestError));
      });

      const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = ensureAdapterSessionContext(threadId);
          yield* stopOpenCodeContext(context);
          sessions.delete(threadId);
          yield* emit(context, {
            ...buildEventBase({ threadId }),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: false,
              exitKind: "graceful",
            },
          });
        },
      );

      const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = ensureAdapterSessionContext(threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          return buildOpenCodeThreadSnapshot({
            threadId,
            messages: (messages.data ?? []).flatMap((entry) =>
              entry.info.role === "user" || entry.info.role === "assistant"
                ? [
                    {
                      info: {
                        id: entry.info.id,
                        role: entry.info.role,
                      },
                      parts: entry.parts,
                    } satisfies OpenCodeMessageSnapshot,
                  ]
                : [],
            ),
            cwd: context.directory,
          });
        },
      );

      const readExternalThread: NonNullable<OpenCodeAdapterShape["readExternalThread"]> = (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const directory = input.cwd ?? serverConfig.cwd;
            const server = yield* openCodeRuntime
              .connectToOpenCodeServer({
                binaryPath: adapterConfig.defaultBinaryPath,
                cliSpec: adapterConfig.cliSpec,
                cwd: directory,
              })
              .pipe(Effect.mapError(toAdapterRequestError));
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory,
              cliSpec: adapterConfig.cliSpec,
            });
            const session = yield* runOpenCodeSdk("session.get", () =>
              client.session.get({
                sessionID: input.externalThreadId,
              }),
            ).pipe(Effect.mapError(toAdapterRequestError));
            const messages = yield* runOpenCodeSdk("session.messages", () =>
              client.session.messages({
                sessionID: input.externalThreadId,
              }),
            ).pipe(Effect.mapError(toAdapterRequestError));

            return buildOpenCodeThreadSnapshot({
              threadId: ThreadId.makeUnsafe(input.externalThreadId),
              messages: (messages.data ?? []).flatMap((entry) =>
                entry.info.role === "user" || entry.info.role === "assistant"
                  ? [
                      {
                        info: {
                          id: entry.info.id,
                          role: entry.info.role,
                        },
                        parts: entry.parts,
                      } satisfies OpenCodeMessageSnapshot,
                    ]
                  : [],
              ),
              cwd: session.data?.directory ?? directory,
            });
          }),
        );

      const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = ensureAdapterSessionContext(threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({
              sessionID: context.openCodeSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          const assistantMessages = (messages.data ?? []).filter(
            (entry) => entry.info.role === "assistant",
          );
          const targetIndex = assistantMessages.length - numTurns - 1;
          const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
          yield* runOpenCodeSdk("session.revert", () =>
            context.client.session.revert({
              sessionID: context.openCodeSessionId,
              ...(target ? { messageID: target.info.id } : {}),
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          return yield* readThread(threadId);
        },
      );

      const compactThread: NonNullable<OpenCodeAdapterShape["compactThread"]> = (threadId) =>
        Effect.gen(function* () {
          const context = ensureAdapterSessionContext(threadId);
          const parsedModel = parseOpenCodeModelSlug(context.session.model);
          if (!parsedModel) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "compactThread",
              issue: `${adapterConfig.displayName} compaction requires a current 'provider/model' selection.`,
            });
          }

          yield* runOpenCodeSdk("session.summarize", () =>
            context.client.session.summarize({
              sessionID: context.openCodeSessionId,
              providerID: parsedModel.providerID,
              modelID: parsedModel.modelID,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));
        });

      const forkThread: NonNullable<OpenCodeAdapterShape["forkThread"]> = (input) =>
        Effect.gen(function* () {
          const sourceContext = sessions.get(input.sourceThreadId);
          const sourceSessionId =
            sourceContext?.openCodeSessionId ?? extractResumeSessionId(input.sourceResumeCursor);
          if (!sourceSessionId) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "forkThread",
              issue: `${adapterConfig.displayName} native fork requires a resumable source session id.`,
            });
          }

          const providerOptions = input.providerOptions?.[adapterConfig.providerOptionsKey];
          const binaryPath = providerOptions?.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
          const serverUrl = providerOptions?.serverUrl?.trim();
          const serverPassword = options?.resolveServerPassword
            ? yield* options.resolveServerPassword(provider)
            : undefined;
          const persistedSourceDirectory =
            sourceContext?.directory ??
            input.sourceCwd ??
            extractResumeCwd(input.sourceResumeCursor);
          const targetDirectory = input.cwd ?? persistedSourceDirectory ?? serverConfig.cwd;
          const sourceDirectory = persistedSourceDirectory ?? targetDirectory;
          if (sourceDirectory !== targetDirectory) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "forkThread",
              issue: `${adapterConfig.displayName} native fork cannot cross cwd boundaries.`,
            });
          }

          let client: OpencodeClient;
          if (sourceContext) {
            client = sourceContext.client;
          } else {
            client = yield* Effect.scoped(
              Effect.gen(function* () {
                const server = yield* openCodeRuntime
                  .connectToOpenCodeServer({
                    binaryPath,
                    cliSpec: adapterConfig.cliSpec,
                    cwd: sourceDirectory,
                    ...(serverUrl ? { serverUrl } : {}),
                  })
                  .pipe(Effect.mapError(toAdapterRequestError));
                return openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: sourceDirectory,
                  cliSpec: adapterConfig.cliSpec,
                  ...(server.external && serverPassword ? { serverPassword } : {}),
                });
              }),
            );
          }

          const forked = yield* runOpenCodeSdk("session.fork", () =>
            client.session.fork({
              sessionID: sourceSessionId,
            }),
          ).pipe(Effect.mapError(toAdapterRequestError));

          const forkedSessionId = forked.data?.id?.trim();
          if (!forkedSessionId) {
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "session.fork",
              detail: `${adapterConfig.displayName} session.fork returned no session payload.`,
            });
          }

          const session = yield* startSession({
            threadId: input.threadId,
            provider,
            cwd: targetDirectory,
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
            resumeCursor: { openCodeSessionId: forkedSessionId, cwd: targetDirectory },
            runtimeMode: input.runtimeMode,
          });

          return {
            threadId: input.threadId,
            ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
          };
        });

      const withDiscoveryClient = <A>(
        input: {
          readonly threadId?: string | null;
          readonly binaryPath?: string | null;
          readonly cwd?: string | null;
          readonly serverUrl?: string | null;
          readonly experimentalWebSockets?: boolean;
          readonly reuseAnyActiveContext?: boolean;
        },
        fn: (input: {
          readonly client: OpencodeClient;
          readonly activeContext?: OpenCodeSessionContext;
        }) => Effect.Effect<A, ProviderAdapterRequestError>,
      ): Effect.Effect<A, ProviderAdapterRequestError> =>
        Effect.gen(function* () {
          const requestedCwd = input.cwd?.trim();
          const requestedServerUrl = input.serverUrl?.trim();
          const activeContext = input.threadId
            ? sessions.get(ThreadId.makeUnsafe(input.threadId))
            : input.reuseAnyActiveContext
              ? [...sessions.values()][0]
              : undefined;
          if (
            activeContext &&
            (!requestedCwd || requestedCwd === activeContext.directory) &&
            (!requestedServerUrl || requestedServerUrl === activeContext.server.url)
          ) {
            return yield* fn({
              client: activeContext.client,
              activeContext,
            });
          }

          return yield* Effect.scoped(
            Effect.gen(function* () {
              const serverUrl = input.serverUrl?.trim();
              const serverPassword = options?.resolveServerPassword
                ? yield* options.resolveServerPassword(provider).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapterRequestError({
                          provider,
                          method: cause.operation,
                          detail: cause.issue,
                          cause,
                        }),
                    ),
                  )
                : undefined;
              const server = yield* openCodeRuntime
                .connectToOpenCodeServer({
                  binaryPath: input.binaryPath?.trim() || adapterConfig.defaultBinaryPath,
                  cliSpec: adapterConfig.cliSpec,
                  cwd: input.cwd?.trim() || serverConfig.cwd,
                  ...(serverUrl ? { serverUrl } : {}),
                  ...(provider === "opencode" && input.experimentalWebSockets
                    ? { experimentalWebSockets: true }
                    : {}),
                })
                .pipe(Effect.mapError(toAdapterRequestError));
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory: input.cwd?.trim() || serverConfig.cwd,
                cliSpec: adapterConfig.cliSpec,
                ...(server.external && serverPassword ? { serverPassword } : {}),
              });
              return yield* fn({ client });
            }),
          );
        });

      const withDiscoveryInventory = <A>(
        input: {
          readonly binaryPath?: string | null;
          readonly cwd?: string | null;
        },
        fn: (input: {
          readonly client: OpencodeClient;
          readonly inventory: OpenCodeInventory;
          readonly credentialProviderIDs: ReadonlyArray<string>;
        }) => Effect.Effect<A, ProviderAdapterRequestError>,
      ): Effect.Effect<A, ProviderAdapterRequestError> =>
        withDiscoveryClient(
          {
            ...input,
            reuseAnyActiveContext: true,
          },
          ({ activeContext, client }) =>
            Effect.gen(function* () {
              const inventory = yield* openCodeRuntime
                .loadOpenCodeInventory(client)
                .pipe(Effect.mapError(toAdapterRequestError));
              if (activeContext) {
                replaceModelContextLimits(
                  activeContext,
                  buildOpenCodeModelContextLimitMap(inventory),
                );
              }
              const credentialProviderIDs =
                yield* openCodeRuntime.loadOpenCodeCredentialProviderIDs(
                  client,
                  adapterConfig.cliSpec,
                );
              return yield* fn({
                client,
                inventory,
                credentialProviderIDs,
              });
            }),
        );

      const listModels: NonNullable<OpenCodeAdapterShape["listModels"]> = (input) => {
        const binaryPath = input.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
        const freeOnlyProviderID = adapterConfig.provider === "kilo" ? "kilo" : undefined;
        return Effect.gen(function* () {
          const cliModelsEffect = openCodeRuntime
            .listOpenCodeCliModels({
              binaryPath,
              cliSpec: adapterConfig.cliSpec,
              ...(input.cwd ? { cwd: input.cwd } : {}),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logDebug(`${adapterConfig.displayName} CLI model discovery failed`, {
                  binaryPath,
                  detail: openCodeRuntimeErrorDetail(error),
                }).pipe(Effect.as([] as ReadonlyArray<OpenCodeCliModelDescriptor>)),
              ),
            );
          const inventoryEffect = withDiscoveryInventory(
            { binaryPath, ...(input.cwd ? { cwd: input.cwd } : {}) },
            ({ inventory, credentialProviderIDs }) =>
              Effect.succeed({
                inventory,
                credentialProviderIDs,
              }),
          ).pipe(Effect.exit);
          const [cliModels, inventoryExit] = yield* Effect.all([cliModelsEffect, inventoryEffect], {
            concurrency: "unbounded",
          });

          if (Exit.isSuccess(inventoryExit)) {
            const { inventory, credentialProviderIDs } = inventoryExit.value;
            const preferredProviderIDs = new Set(
              resolvePreferredOpenCodeModelProviders({
                inventory,
                credentialProviderIDs,
              }).map((provider) => provider.id),
            );
            const inventoryModels = flattenOpenCodeModels({
              inventory,
              credentialProviderIDs,
              ...(freeOnlyProviderID ? { freeOnlyProviderID } : {}),
            });
            const preferredCliModels = cliModels.filter((model) =>
              preferredProviderIDs.has(model.providerID),
            );
            const models = mergeOpenCodeCliModelDescriptors({
              inventory,
              models: inventoryModels,
              cliModels: preferredCliModels.length > 0 ? preferredCliModels : cliModels,
              ...(freeOnlyProviderID ? { freeOnlyProviderID } : {}),
            });
            yield* Effect.logDebug(`${adapterConfig.displayName} model discovery resolved`, {
              binaryPath,
              connectedProviders: inventory.providerList.connected,
              inventoryModelCount: inventoryModels.length,
              cliModelCount: cliModels.length,
              modelCount: models.length,
              sampleModels: models.slice(0, 12).map((model) => model.slug),
            });
            return {
              models,
              source:
                cliModels.length > 0
                  ? adapterConfig.cliModelSource
                  : adapterConfig.fallbackModelSource,
              cached: false,
            };
          }

          // Keep OpenCode's authoritative CLI list usable even if the local server
          // cannot start; otherwise the web picker falls back to one static model.
          if (cliModels.length > 0) {
            const models = mergeOpenCodeCliModelDescriptors({
              inventory: emptyOpenCodeModelInventory(),
              models: [],
              cliModels,
              ...(freeOnlyProviderID ? { freeOnlyProviderID } : {}),
            });
            yield* Effect.logDebug(
              `${adapterConfig.displayName} model discovery resolved from CLI only`,
              {
                binaryPath,
                cliModelCount: cliModels.length,
                modelCount: models.length,
                sampleModels: models.slice(0, 12).map((model) => model.slug),
              },
            );
            return {
              models,
              source: adapterConfig.cliModelSource,
              cached: false,
            };
          }

          const inventoryFailure = Cause.squash(inventoryExit.cause);
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "listModels",
            detail: openCodeRuntimeErrorDetail(inventoryFailure),
            cause: inventoryFailure,
          });
        });
      };

      const listAgents: NonNullable<OpenCodeAdapterShape["listAgents"]> = (input) => {
        const binaryPath = input.binaryPath?.trim() || adapterConfig.defaultBinaryPath;
        return withDiscoveryInventory(
          { binaryPath, ...(input.cwd ? { cwd: input.cwd } : {}) },
          ({ inventory }) =>
            Effect.succeed({
              agents: flattenOpenCodeAgents(inventory.agents),
              source: adapterConfig.fallbackModelSource,
              cached: false,
            }),
        );
      };

      const listCommands: NonNullable<OpenCodeAdapterShape["listCommands"]> = (input) => {
        const discoveryInput = {
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.binaryPath !== undefined ? { binaryPath: input.binaryPath } : {}),
          cwd: input.cwd,
          ...(input.serverUrl !== undefined ? { serverUrl: input.serverUrl } : {}),
          ...(input.experimentalWebSockets !== undefined
            ? { experimentalWebSockets: input.experimentalWebSockets }
            : {}),
        };

        return withDiscoveryClient(discoveryInput, ({ client }) =>
          runOpenCodeSdk("command.list", () => client.command.list()).pipe(
            Effect.map(
              (commands) =>
                ({
                  commands: flattenOpenCodeCommands(commands.data ?? []),
                  source: adapterConfig.fallbackModelSource,
                  cached: false,
                }) satisfies ProviderListCommandsResult,
            ),
            Effect.catch((cause) =>
              isUnsupportedOpenCodeCommandListError(cause)
                ? Effect.succeed({
                    commands: [],
                    source: "unsupported",
                    cached: false,
                  } satisfies ProviderListCommandsResult)
                : Effect.fail(cause),
            ),
            Effect.mapError(toAdapterRequestError),
          ),
        );
      };

      const getComposerCapabilities: NonNullable<
        OpenCodeAdapterShape["getComposerCapabilities"]
      > = () =>
        Effect.succeed({
          provider,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: provider === "opencode",
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: true,
          supportsThreadImport: true,
        } satisfies ProviderComposerCapabilities);

      const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
        });

      return {
        provider,
        capabilities: {
          sessionModelSwitch: "in-session",
          supportsRuntimeModelList: true,
          supportsNativeSlashCommandDiscovery: provider === "opencode",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        readExternalThread,
        rollbackThread,
        compactThread,
        forkThread,
        stopAll,
        listModels,
        listAgents,
        ...(provider === "opencode" ? { listCommands } : {}),
        getComposerCapabilities,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } as OpenCodeAdapterShape;
    }),
  ).pipe(
    Layer.provide(
      options?.runtime ? Layer.succeed(OpenCodeRuntime, options.runtime) : OpenCodeRuntimeLive,
    ),
    Layer.provide(NodeServices.layer),
  );
}

export const OpenCodeAdapterLive = makeOpenCodeAdapterLive();

export function makeKiloAdapterLive(options?: Omit<OpenCodeAdapterLiveOptions, "adapterConfig">) {
  const kiloOpenCodeCompatibleLayer = makeOpenCodeAdapterLive({
    ...options,
    adapterConfig: KILO_ADAPTER_CONFIG,
  });
  return Layer.effect(
    KiloAdapter,
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      return adapter as unknown as KiloAdapterShape;
    }),
  ).pipe(Layer.provide(kiloOpenCodeCompatibleLayer));
}

export const KiloAdapterLive = makeKiloAdapterLive();
