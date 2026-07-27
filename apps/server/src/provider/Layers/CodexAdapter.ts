/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type ChatAttachment,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ModelSelection,
  type ProviderComposerCapabilities,
  type ProviderEvent,
  type ProviderListModelsResult,
  type ProviderListPluginsResult,
  type ProviderReadPluginResult,
  type ProviderSendTurnInput,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ServerVoiceTranscriptionResult,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderApprovalDecision,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  Cause,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Schema,
  ServiceMap,
  Stream,
} from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  CodexAppServerManager,
  parseCodexUserInputQuestions,
  type CodexAppServerSendTurnInput,
  type CodexAppServerStartSessionInput,
} from "../../codexAppServerManager.ts";
import {
  evaluateAcpTurnIdleTick,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { acquireAgentGatewaySessionLease } from "../../agentGateway/sessionLease.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import {
  codexGeneratedImageArtifact,
  extractCodexGeneratedImageReference,
  firstStringValue,
  isCodexGeneratedImageItemType,
  sanitizeNestedCodexGeneratedImagePayloads,
} from "../../codexGeneratedImages.ts";
import { isNonFatalCodexErrorMessage } from "../../codexErrorClassification.ts";
import { ServerConfig } from "../../config.ts";
import { makeRuntimeTaskListItem } from "../runtimeTaskList.ts";
import { extractProposedPlanMarkdown } from "../planMode.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { synaraSkillsDir } from "../skillsCatalog.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import { assignDerivedProviderRuntimeEventIds } from "../providerRuntimeEventIdentity.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES,
  providerRuntimeEventBytes,
} from "../providerRuntimeEventIngress.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "codex" as const;

// Backstop for an alive-but-silent codex app-server: if a turn produces no
// activity at all for this long, abort it instead of showing "Working" forever.
// Every turn-scoped event (reasoning, tool output, deltas) resets the clock and
// a pending question/approval pauses it, so only a wedged child trips this.
// Generous by design; override with SYNARA_CODEX_TURN_IDLE_TIMEOUT_MS.
const CODEX_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_CODEX_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 900_000,
});
const CODEX_TURN_WATCHDOG_INTERVAL_MS = 15_000;

interface CodexTurnWatchdogEntry {
  readonly turnId: TurnId;
  lastActivityAt: number;
}

type CodexRuntimeIngressItem = {
  readonly nativeEvent: ProviderEvent;
  readonly runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>;
};

function compactCodexNativeEventForIngress(event: ProviderEvent): ProviderEvent {
  let originalBytes: number;
  try {
    originalBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    originalBytes = PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES + 1;
  }
  if (originalBytes <= PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES) {
    return event;
  }
  return {
    ...event,
    payload: {
      synaraTruncated: true,
      reason: "Codex native event exceeded the callback ingress size limit",
      originalBytes,
    },
  };
}

function codexRuntimeIngressItemBytes(item: CodexRuntimeIngressItem): number {
  let nativeBytes: number;
  try {
    nativeBytes = Buffer.byteLength(JSON.stringify(item.nativeEvent), "utf8");
  } catch {
    nativeBytes = PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES;
  }
  return (
    nativeBytes +
    item.runtimeEvents.reduce((total, event) => total + providerRuntimeEventBytes(event), 0)
  );
}

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return sanitizeUserFacingErrorMessage(cause.message, fallback);
  }
  return fallback;
}

function sanitizeUserFacingErrorMessage(message: string, fallback: string): string {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return fallback;
  }

  const firstLine = normalized.split("\n")[0]?.trim() ?? "";
  const withoutInlineStack = firstLine.replace(/\s+at file:\/\/.*$/s, "").trim();
  return withoutInlineStack.length > 0 ? withoutInlineStack : fallback;
}

function composeCodexInputWithFileAttachments(input: {
  readonly input: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
}): string | undefined {
  return appendFileAttachmentsPromptBlock({
    text: input.input,
    attachments: input.attachments,
    attachmentsDir: input.attachmentsDir,
    include: "all-files",
  });
}

function codexModelSelectionOverrides(
  modelSelection: ModelSelection | undefined,
): Pick<CodexAppServerSendTurnInput, "model" | "effort"> &
  Pick<CodexAppServerStartSessionInput, "serviceTier"> {
  if (modelSelection?.provider !== PROVIDER) {
    return {};
  }

  return {
    model: modelSelection.model,
    ...(modelSelection.options?.reasoningEffort !== undefined
      ? { effort: modelSelection.options.reasoningEffort }
      : {}),
    ...(modelSelection.options?.fastMode ? { serviceTier: "fast" } : {}),
  };
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  // A closed stdin is the transport-level signature of a dead app-server
  // process; treat it as a closed session so callers recover via resume
  // instead of surfacing a raw request failure.
  if (normalized.includes("session is closed") || normalized.includes("stdin closed")) {
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Keep manager-emitted stderr lines visible without escalating them into a fatal thread error.
function providerErrorMapsToWarning(event: ProviderEvent): boolean {
  return (
    event.kind === "error" &&
    (event.method === "process/stderr" ||
      (event.method === "error" &&
        typeof event.message === "string" &&
        isNonFatalCodexErrorMessage(event.message)))
  );
}

function normalizeCodexTokenUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asObject(value);
  const totalUsage = asObject(usage?.total_token_usage ?? usage?.total);
  const lastUsage = asObject(usage?.last_token_usage ?? usage?.last);

  const totalProcessedTokens =
    asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens);
  const usedTokens =
    asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = asNumber(usage?.model_context_window) ?? asNumber(usage?.modelContextWindow);
  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens);
  const cachedInputTokens =
    asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens);
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens);
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens);

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return value?.trim() ? TurnId.makeUnsafe(value) : undefined;
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value?.trim() ? ProviderItemId.makeUnsafe(value) : undefined;
}

function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (isCodexGeneratedImageItemType(raw)) return "image_generation";
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered") || type.includes("entered review")) return "review_entered";
  if (type.includes("review exited") || type.includes("exited review")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_generation":
      return "Generated image";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function joinedTextParts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const object = asObject(entry);
      return asString(object?.text) ?? asString(object?.summary);
    })
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function reasoningSummaryDetail(item: Record<string, unknown>): string | undefined {
  return asString(item.summary)?.trim() || joinedTextParts(item.summary);
}

function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    joinedTextParts(item.summary),
    joinedTextParts(item.content),
    asString(item.review),
    asString(item.text),
    asString(item.saved_path),
    asString(item.savedPath),
    asString(item.path),
    asString(item.file_path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function itemStatus(
  lifecycle: "item.started" | "item.updated" | "item.completed",
  rawStatus: unknown,
): "inProgress" | "completed" | "failed" | "declined" | undefined {
  if (lifecycle === "item.started") {
    return "inProgress";
  }
  if (lifecycle === "item.updated") {
    return undefined;
  }
  return rawStatus === "failed" || rawStatus === "declined" ? rawStatus : "completed";
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  const result: Record<string, string | ReadonlyArray<string> | null> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (typeof value === "string") {
      result[questionId] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const normalized = value.filter((entry): entry is string => typeof entry === "string");
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }

    const nestedAnswers = asArray(asObject(value)?.answers);
    if (nestedAnswers) {
      const normalized = nestedAnswers.filter(
        (entry): entry is string => typeof entry === "string",
      );
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }
  }
  return result;
}

function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (value) {
    case "idle":
      return "idle";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const turnId = event.turnId ?? toTurnId(asString(msg?.turn_id) ?? asString(msg?.turnId));
  const itemId = event.itemId ?? toProviderItemId(asString(msg?.item_id) ?? asString(msg?.itemId));
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

function codexGeneratedImageThreadId(
  event: ProviderEvent,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const msg = codexEventMessage(payload);
  const nestedEvent = asObject(payload?.event);
  return (
    firstStringValue(msg, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(nestedEvent, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(payload, ["thread_id", "threadId", "threadID", "thread"]) ??
    event.providerThreadId ??
    event.threadId
  );
}

function sanitizeGeneratedImagePayload(event: ProviderEvent, canonicalThreadId: ThreadId): unknown {
  const payload = asObject(event.payload);
  return sanitizeNestedCodexGeneratedImagePayloads({
    value: event.payload ?? {},
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
  });
}

function withSanitizedGeneratedImageRaw(
  base: Omit<ProviderRuntimeEvent, "type" | "payload">,
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    ...base,
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: sanitizeGeneratedImagePayload(event, canonicalThreadId),
    },
  };
}

function generatedImageEventCandidate(event: ProviderEvent): Record<string, unknown> | undefined {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const item = asObject(payload?.item);
  const nestedEvent = asObject(payload?.event);
  if (item) {
    return item;
  }
  if (msg) {
    return {
      ...msg,
      type: asString(msg.type) ?? "image_generation_end",
    };
  }
  if (nestedEvent) {
    return {
      ...nestedEvent,
      type: asString(nestedEvent.type) ?? "image_generation_end",
    };
  }
  if (payload) {
    return {
      ...payload,
      type: asString(payload.type) ?? "image_generation_end",
    };
  }
  return undefined;
}

function mapGeneratedImageEndEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ProviderRuntimeEvent | undefined {
  if (
    event.method !== "codex/event/image_generation_end" &&
    event.method !== "image_generation_end"
  ) {
    return undefined;
  }
  const payload = asObject(event.payload);
  const candidate = generatedImageEventCandidate(event);
  const reference = extractCodexGeneratedImageReference({
    value: candidate,
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
  });
  if (!reference) {
    return undefined;
  }

  const turnId =
    event.turnId ??
    toTurnId(
      firstStringValue(candidate, ["turn_id", "turnId"]) ??
        firstStringValue(payload, ["turn_id", "turnId"]),
    );
  const itemId =
    event.itemId ??
    toProviderItemId(
      firstStringValue(candidate, ["item_id", "itemId", "call_id", "callId", "id"]) ??
        firstStringValue(payload, ["item_id", "itemId", "call_id", "callId", "id"]),
    );
  const base = withSanitizedGeneratedImageRaw(
    {
      ...runtimeEventBase(
        {
          ...event,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
        },
        canonicalThreadId,
      ),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    },
    event,
    canonicalThreadId,
  );

  return {
    ...base,
    type: "item.completed",
    payload: {
      itemType: "image_generation",
      status: "completed",
      title: "Generated image",
      detail: reference.path,
      data: codexGeneratedImageArtifact(reference),
    },
  };
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.providerThreadId) refs.providerThreadId = event.providerThreadId;
  if (event.providerParentThreadId) refs.providerParentThreadId = event.providerParentThreadId;
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.parentTurnId) refs.parentProviderTurnId = event.parentTurnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: event.lifecycleGeneration }
      : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.parentTurnId ? { parentTurnId: event.parentTurnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const itemType = toCanonicalItemType(source.type ?? source.kind);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }
  const generatedImageReference =
    itemType === "image_generation"
      ? extractCodexGeneratedImageReference({
          value: source,
          threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
        })
      : undefined;
  if (
    lifecycle === "item.completed" &&
    itemType === "image_generation" &&
    !generatedImageReference
  ) {
    return undefined;
  }

  const canonicalItemType =
    lifecycle === "item.completed" && itemType === "review_exited" ? "assistant_message" : itemType;

  // Only the provider-authored summary is user-visible reasoning. Raw content
  // may contain model trace data and must not leak into transcript activities.
  const detail =
    itemType === "reasoning" ? reasoningSummaryDetail(source) : itemDetail(source, payload ?? {});
  const status = itemStatus(lifecycle, source.status);

  return {
    ...(generatedImageReference
      ? withSanitizedGeneratedImageRaw(
          runtimeEventBase(event, canonicalThreadId),
          event,
          canonicalThreadId,
        )
      : runtimeEventBase(event, canonicalThreadId)),
    type: lifecycle,
    payload: {
      itemType: canonicalItemType,
      ...(status ? { status } : {}),
      ...(itemTitle(canonicalItemType) ? { title: itemTitle(canonicalItemType) } : {}),
      ...(generatedImageReference
        ? { detail: generatedImageReference.path }
        : detail
          ? { detail }
          : {}),
      ...(generatedImageReference
        ? { data: codexGeneratedImageArtifact(generatedImageReference) }
        : event.payload !== undefined
          ? { data: event.payload }
          : {}),
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  const generatedImageEndEvent = mapGeneratedImageEndEvent(event, canonicalThreadId);
  if (generatedImageEndEvent) {
    return [generatedImageEndEvent];
  }

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    const treatAsWarning = providerErrorMapsToWarning(event);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: treatAsWarning ? "runtime.warning" : "runtime.error",
        payload: {
          message: event.message,
          ...(!treatAsWarning ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      // The manager refuses (and answers) unrenderable requests, so reaching
      // this branch with no questions means nothing is parked on the reply.
      const questions = parseCodexUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail =
      asString(payload?.command) ?? asString(payload?.reason) ?? asString(payload?.prompt);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
      },
    ];
  }

  if (event.method === "thread/compacting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType: "context_compaction",
          status: "inProgress",
          title: "Context compaction",
          detail: event.message ?? "Compacting context",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(asObject(payload?.thread)?.state ?? payload?.state),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const tokenUsage = asObject(payload?.tokenUsage);
    const normalizedUsage = normalizeCodexTokenUsage(tokenUsage ?? event.payload);
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const errorMessage = asString(asObject(turn?.error)?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.tasks.updated",
        payload: {
          ...(asString(payload?.explanation)
            ? { explanation: asString(payload?.explanation) }
            : {}),
          tasks: steps.flatMap((entry) => {
            const taskEntry = asObject(entry);
            if (!taskEntry) {
              return [];
            }
            const item = makeRuntimeTaskListItem(
              asString(taskEntry.step) ?? "task",
              taskEntry.status,
            );
            return item ? [item] : [];
          }),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff:
            asString(payload?.unifiedDiff) ??
            asString(payload?.diff) ??
            asString(payload?.patch) ??
            "",
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (!source) {
      return [];
    }
    const itemType = source ? toCanonicalItemType(source.type ?? source.kind) : "unknown";
    if (itemType === "plan") {
      const detail = itemDetail(source, payload ?? {});
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    const updated = mapItemLifecycle(event, canonicalThreadId, "item.updated");
    return updated ? [updated] : [];
  }

  if (event.method === "item/plan/delta") {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(typeof payload?.summaryIndex === "number"
            ? { summaryIndex: payload.summaryIndex }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const requestType =
      toRequestTypeFromResolvedPayload(payload) !== "unknown"
        ? toRequestTypeFromResolvedPayload(payload)
        : event.requestId && event.requestKind !== undefined
          ? toRequestTypeFromKind(event.requestKind)
          : "unknown";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(
            asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    const proposedPlanMarkdown = extractProposedPlanMarkdown(asString(msg?.last_agent_message));
    if (!taskId) {
      if (!proposedPlanMarkdown) {
        return [];
      }
      return [
        {
          ...codexEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        },
      ];
    }
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          status: "completed",
          ...(asString(msg?.last_agent_message)
            ? { summary: asString(msg?.last_agent_message) }
            : {}),
        },
      },
    ];
    if (proposedPlanMarkdown) {
      events.push({
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: proposedPlanMarkdown,
        },
      });
    }
    return events;
  }

  if (event.method === "codex/event/agent_reasoning") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id);
    const description = asString(msg?.text);
    if (!taskId || !description) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          description,
        },
      },
    ];
  }

  if (event.method === "codex/event/reasoning_content_delta") {
    const msg = codexEventMessage(payload);
    const delta = asString(msg?.delta);
    if (!delta) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            asNumber(msg?.summary_index) !== undefined
              ? "reasoning_summary_text"
              : "reasoning_text",
          delta,
          ...(asNumber(msg?.summary_index) !== undefined
            ? { summaryIndex: asNumber(msg?.summary_index) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Deprecation notice",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Configuration warning",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
          ...(asString(payload?.path) ? { path: asString(payload?.path) } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const realtimeSessionId = asString(payload?.realtimeSessionId);
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = asString(payload?.message) ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const message =
      asString(asObject(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    const treatAsWarning = willRetry || isNonFatalCodexErrorMessage(message);
    return [
      {
        type: treatAsWarning ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!treatAsWarning ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asObject(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

const makeCodexAdapter = (options?: CodexAdapterLiveOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
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

    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) {
          return options.manager;
        }
        const services = yield* Effect.services<never>();
        return (
          options?.makeManager?.(services) ??
          new CodexAppServerManager(services, {
            synaraSkillsDir: synaraSkillsDir(serverConfig.baseDir),
            ...(agentGatewayCredentials
              ? {
                  agentGatewayMcp: {
                    endpointUrl: () => agentGatewayCredentials.mcpEndpointUrl,
                    acquireSessionLease: (threadId) =>
                      acquireAgentGatewaySessionLease(agentGatewayCredentials, threadId, PROVIDER)!,
                  },
                }
              : {}),
          })
        );
      }),
      (manager) => Effect.promise(() => manager.stopAll()),
    );

    // Idle-progress backstop for codex turns. Same semantics as
    // AcpTurnIdleWatchdog (any inbound activity resets it, a pending human
    // decision pauses it), driven by one shared ticker because codex activity
    // arrives on a single manager event stream instead of per-session fibers.
    const turnWatchdogs = new Map<ThreadId, CodexTurnWatchdogEntry>();

    const armTurnWatchdog = (threadId: ThreadId, turnId: TurnId): void => {
      turnWatchdogs.set(threadId, { turnId, lastActivityAt: Date.now() });
    };

    const trackTurnWatchdogActivity = (
      threadId: ThreadId,
      runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>,
    ): void => {
      const entry = turnWatchdogs.get(threadId);
      if (entry) {
        entry.lastActivityAt = Date.now();
      }
      for (const runtimeEvent of runtimeEvents) {
        if (runtimeEvent.type === "turn.started" && runtimeEvent.turnId) {
          armTurnWatchdog(threadId, runtimeEvent.turnId);
        }
      }
    };

    const abandonStalledTurn = (threadId: ThreadId, turnId: TurnId, idleMs: number): void => {
      const idleSeconds = Math.round(idleMs / 1000);
      void manager
        .abandonTurn(
          threadId,
          turnId,
          `Codex stopped responding (no activity for ${idleSeconds}s); the turn was aborted.`,
        )
        .catch((cause: unknown) => {
          void Effect.runPromise(
            Effect.logError("Codex idle turn abandon failed", {
              threadId,
              turnId,
              idleMs,
              cause,
            }),
          );
        });
    };

    const evaluateTurnWatchdogs = (): void => {
      const now = Date.now();
      for (const [threadId, entry] of turnWatchdogs) {
        const idleMs = now - entry.lastActivityAt;
        const decision = evaluateAcpTurnIdleTick({
          isTurnActive: manager.isTurnActive(threadId, entry.turnId),
          isAwaitingHuman: manager.isAwaitingHumanResponse(threadId),
          idleMs,
          idleTimeoutMs: CODEX_TURN_IDLE_TIMEOUT_MS,
        });
        if (decision === "continue") {
          continue;
        }
        if (decision === "touch") {
          // Blocked on a human, not hung: keep the clock fresh so the turn
          // cannot trip the watchdog the instant it resumes.
          entry.lastActivityAt = now;
          continue;
        }
        // Both "stop" (the turn already settled) and "timeout" disarm; a timeout
        // disarms first so a slow interrupt cannot let the next tick re-fire.
        turnWatchdogs.delete(threadId);
        if (decision === "timeout") {
          abandonStalledTurn(threadId, entry.turnId, idleMs);
        }
      }
    };

    const prepareCodexManagerTurnInput = (
      input: ProviderSendTurnInput,
      method: "turn/start" | "turn/steer",
    ): Effect.Effect<CodexAppServerSendTurnInput, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const imageBlocks = yield* loadProviderPromptImageBlocks({
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          provider: PROVIDER,
          method,
          readFile: (attachmentPath) => fileSystem.readFile(attachmentPath),
          readErrorDetail: (cause) => toMessage(cause, "Failed to read attachment file."),
          invalidAttachmentError: (_attachment, cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: toMessage(cause, `${method} failed`),
              cause,
            }),
        });
        const nativeCodexAttachments = imageBlocks.map((attachment) => ({
          type: "image" as const,
          url: `data:${attachment.mimeType};base64,${attachment.data}`,
        }));
        const composedInput = composeCodexInputWithFileAttachments({
          input: input.input,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
        });

        return {
          threadId: input.threadId,
          ...(composedInput !== undefined ? { input: composedInput } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
          ...codexModelSelectionOverrides(input.modelSelection),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(nativeCodexAttachments.length > 0 ? { attachments: nativeCodexAttachments } : {}),
        } satisfies CodexAppServerSendTurnInput;
      });

    const startSession: CodexAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      const managerInput: CodexAppServerStartSessionInput = {
        threadId: input.threadId,
        provider: "codex",
        ...(input.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: input.lifecycleGeneration }
          : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        runtimeMode: input.runtimeMode,
        ...codexModelSelectionOverrides(input.modelSelection),
      };

      return Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            cause,
          }),
      }).pipe(Effect.map((session) => session));
    };

    const sendTurn: CodexAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const managerInput = yield* prepareCodexManagerTurnInput(input, "turn/start");

        return yield* Effect.tryPromise({
          try: () => manager.sendTurn(managerInput),
          catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
        }).pipe(
          // Armed here as well as on `turn.started`, so a child that goes silent
          // before its first notification is still covered.
          Effect.tap((result) => Effect.sync(() => armTurnWatchdog(input.threadId, result.turnId))),
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const steerTurn: CodexAdapterShape["steerTurn"] = (input) =>
      Effect.gen(function* () {
        const managerInput = yield* prepareCodexManagerTurnInput(input, "turn/steer");

        return yield* Effect.tryPromise({
          try: () => manager.steerTurn(managerInput),
          catch: (cause) => toRequestError(input.threadId, "turn/steer", cause),
        }).pipe(
          Effect.tap((result) => Effect.sync(() => armTurnWatchdog(input.threadId, result.turnId))),
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const startReview: CodexAdapterShape["startReview"] = (input) =>
      Effect.tryPromise({
        try: () => manager.startReview(input),
        catch: (cause) => toRequestError(input.threadId, "review/start", cause),
      }).pipe(
        Effect.tap((result) => Effect.sync(() => armTurnWatchdog(input.threadId, result.turnId))),
        Effect.map((result) => ({
          ...result,
          threadId: input.threadId,
        })),
      );

    const interruptTurn: CodexAdapterShape["interruptTurn"] = (
      threadId,
      turnId,
      providerThreadId,
    ) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(threadId, turnId, providerThreadId),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

    const readThread: CodexAdapterShape["readThread"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.readThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/read", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
          cwd: snapshot.cwd ?? null,
        })),
      );

    const readExternalThread: NonNullable<CodexAdapterShape["readExternalThread"]> = (input) =>
      Effect.tryPromise({
        try: () => manager.readExternalThread(input),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/read",
            detail: toMessage(cause, "Failed to read external Codex thread."),
            cause,
          }),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId: ThreadId.makeUnsafe(snapshot.threadId),
          turns: snapshot.turns,
          cwd: snapshot.cwd ?? null,
        })),
      );

    const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.rollbackThread(threadId, numTurns),
        catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
        })),
      );
    };

    const compactThread: NonNullable<CodexAdapterShape["compactThread"]> = (threadId) =>
      Effect.tryPromise({
        try: () => manager.compactThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/compact/start", cause),
      });

    const forkThread: CodexAdapterShape["forkThread"] = (input) =>
      Effect.tryPromise({
        try: () => manager.forkThread(input),
        catch: (cause) => toRequestError(input.sourceThreadId, "thread/fork", cause),
      });

    const respondToRequest: CodexAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(threadId, requestId, decision),
        catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
      });

    const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToUserInput(threadId, requestId, answers),
        catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
      });

    const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.stopSession(threadId),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to stop Codex adapter session."),
            cause,
          }),
      });

    const listSessions: CodexAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const stopAll: CodexAdapterShape["stopAll"] = () =>
      Effect.tryPromise({
        try: () => manager.stopAll(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ThreadId.makeUnsafe("codex:all"),
            detail: toMessage(cause, "Failed to stop all Codex app-server processes."),
            cause,
          }),
      });

    const getComposerCapabilities: NonNullable<CodexAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed(manager.getComposerCapabilities() satisfies ProviderComposerCapabilities);

    const listSkills: NonNullable<CodexAdapterShape["listSkills"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listSkills({
            cwd: input.cwd,
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            ...(input.forceReload !== undefined ? { forceReload: input.forceReload } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skills/list",
            detail: toMessage(cause, "skills/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListSkillsResult));

    const listPlugins: NonNullable<CodexAdapterShape["listPlugins"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listPlugins({
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            ...(input.forceRemoteSync !== undefined
              ? { forceRemoteSync: input.forceRemoteSync }
              : {}),
            ...(input.forceReload !== undefined ? { forceReload: input.forceReload } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/list",
            detail: toMessage(cause, "plugin/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListPluginsResult));

    const readPlugin: NonNullable<CodexAdapterShape["readPlugin"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.readPlugin({
            marketplacePath: input.marketplacePath,
            pluginName: input.pluginName,
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/read",
            detail: toMessage(cause, "plugin/read failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderReadPluginResult));

    const listModels: NonNullable<CodexAdapterShape["listModels"]> = (_input) =>
      Effect.tryPromise({
        try: () => manager.listModels(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "model/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListModelsResult));

    const transcribeVoice: NonNullable<CodexAdapterShape["transcribeVoice"]> = (input) =>
      Effect.tryPromise({
        try: () => manager.transcribeVoice(input),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "voice/transcribe",
            detail: toMessage(cause, "voice/transcribe failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ServerVoiceTranscriptionResult));

    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const writeNativeEvent = (event: ProviderEvent) =>
          Effect.gen(function* () {
            if (!nativeEventLogger) {
              return;
            }
            yield* nativeEventLogger.write(event, event.threadId);
          });

        const ingress = yield* makeBoundedCallbackIngress<CodexRuntimeIngressItem, never, never>(
          (item) =>
            Effect.gen(function* () {
              yield* writeNativeEvent(item.nativeEvent).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Codex native event logging failed", {
                    threadId: item.nativeEvent.threadId,
                    method: item.nativeEvent.method,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
              const runtimeEvents = item.runtimeEvents;
              if (runtimeEvents.length === 0) {
                yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                  method: item.nativeEvent.method,
                  threadId: item.nativeEvent.threadId,
                  turnId: item.nativeEvent.turnId,
                  itemId: item.nativeEvent.itemId,
                });
                return;
              }
              yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
            }),
          {
            capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
            maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
            terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
            isTerminal: (item) => item.runtimeEvents.some(isTerminalProviderRuntimeEvent),
            sizeOf: codexRuntimeIngressItemBytes,
          },
        );
        const listener = (event: ProviderEvent) => {
          const runtimeEvents = assignDerivedProviderRuntimeEventIds(
            mapToRuntimeEvents(event, event.threadId),
          ).map(compactProviderRuntimeEventForIngress);
          trackTurnWatchdogActivity(event.threadId, runtimeEvents);
          const result = ingress.offer({
            nativeEvent: compactCodexNativeEventForIngress(event),
            runtimeEvents,
          });
          if (result === "terminal-overflow") {
            // This means the reserved terminal budget itself was exhausted.
            // The runtime reconciler remains the final recovery fence.
            void Effect.runPromise(
              Effect.logError("Codex callback ingress exhausted terminal reserve", {
                threadId: event.threadId,
                method: event.method,
                status: ingress.status(),
              }),
            );
          }
        };
        manager.on("event", listener);
        const watchdogTicker = setInterval(evaluateTurnWatchdogs, CODEX_TURN_WATCHDOG_INTERVAL_MS);
        watchdogTicker.unref();
        return { ingress, listener, watchdogTicker };
      }),
      ({ ingress, listener, watchdogTicker }) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            clearInterval(watchdogTicker);
            turnWatchdogs.clear();
            manager.off("event", listener);
          });
          yield* ingress.stop;
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
        supportsLiveTurnDiffPatch: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      startReview,
      interruptTurn,
      readThread,
      readExternalThread,
      rollbackThread,
      compactThread,
      forkThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      getComposerCapabilities,
      listSkills,
      listPlugins,
      readPlugin,
      listModels,
      transcribeVoice,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CodexAdapterShape;
  });

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
