import {
  ApprovalRequestId,
  EventId,
  isToolLifecycleItemType,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { nonEmptyTrimmed } from "@synara/shared/text";

const MAX_ACTIVITY_DATA_JSON_CHARS = 16_000;
const MAX_ACTIVITY_DATA_STRING_CHARS = 2_000;
const MAX_ACTIVITY_DATA_ARRAY_ITEMS = 24;
const MAX_ACTIVITY_DATA_OBJECT_KEYS = 64;
const ACTIVITY_DATA_TRUNCATION_MARKER = "__synaraTruncated";

type ActivityPayload = OrchestrationThreadActivity["payload"];

/**
 * Project a value onto exactly what `Schema.Json` admits: `null`, finite numbers,
 * booleans, strings, arrays and records of the same.
 *
 * Activity payloads splice in raw provider values - `Schema.Unknown` payload
 * fields, rate-limit blobs, usage records, workflow snapshots - that are built in
 * adapter code and never decoded. Those can carry explicitly-present `undefined`
 * members, bigints, functions, symbols, non-finite numbers or cycles, and any one
 * of them makes the enclosing `thread.activity.append` command fail its own schema.
 *
 * Primitive, array and object-member semantics match `JSON.stringify`
 * (undefined/function/symbol members dropped from objects and nulled inside
 * arrays, non-finite numbers nulled), Dates keep their JSON timestamp, and bigint
 * plus cycle handling matches {@link stringifyJsonLike}. Already-safe values are
 * returned by reference: a payload built from literals is walked but never copied.
 */
function jsonSafeValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    // undefined, function, symbol: no JSON representation at all.
    return undefined;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);
  try {
    if (value instanceof Date) {
      return value.toJSON();
    }
    if (Array.isArray(value)) {
      let changed = false;
      const retained: unknown[] = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        // Array positions are meaningful: an unrepresentable entry becomes null
        // rather than shifting everything after it.
        const safe = jsonSafeValue(entry, ancestors) ?? null;
        changed ||= !Object.is(safe, entry);
        retained[index] = safe;
      }
      return changed ? retained : value;
    }
    const prototype = Object.getPrototypeOf(value);
    const canReuseObject = prototype === Object.prototype || prototype === null;
    let changed = false;
    const retained: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const safe = jsonSafeValue(entry, ancestors);
      if (safe === undefined) {
        changed = true;
        continue;
      }
      changed ||= !Object.is(safe, entry);
      retained[key] = safe;
    }
    // Class instances, Dates, Maps, typed arrays, and other exotic objects are
    // not Schema.Json even when their enumerable entries happen to be safe.
    return changed || !canReuseObject ? retained : value;
  } finally {
    ancestors.delete(value);
  }
}

function toActivityPayload(payload: unknown): ActivityPayload {
  return (jsonSafeValue(payload, new Set<object>()) ?? null) as ActivityPayload;
}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  // A blank runtime turn id means "no turn", not a turn named "". Trimming here
  // is not cosmetic: `TurnId.makeUnsafe` throws on both blank and untrimmed input.
  const trimmed = value === undefined ? undefined : nonEmptyTrimmed(String(value));
  return trimmed === undefined ? undefined : TurnId.makeUnsafe(trimmed);
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function stringifyJsonLike(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "bigint") {
        return entry.toString();
      }
      if (typeof entry === "function" || typeof entry === "symbol") {
        return undefined;
      }
      if (entry && typeof entry === "object") {
        if (seen.has(entry)) {
          return "[Circular]";
        }
        seen.add(entry);
      }
      return entry;
    }) ?? "null"
  );
}

function truncateJsonString(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 15))}... [truncated]` : value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function activityPayloadKeyRank(key: string): number {
  const ranks: Record<string, number> = {
    itemType: 0,
    status: 1,
    title: 2,
    detail: 3,
    toolName: 4,
    tool: 5,
    toolCallId: 6,
    callID: 7,
    callId: 8,
    command: 9,
    cmd: 10,
    input: 11,
    rawInput: 12,
    arguments: 13,
    args: 14,
    params: 15,
    item: 16,
    result: 17,
    rawOutput: 18,
    output: 19,
    data: 20,
    commandActions: 21,
    files: 22,
    changes: 23,
    path: 24,
    file: 25,
    filePath: 26,
    stdout: 27,
    stderr: 28,
    content: 29,
    totalFiles: 30,
    truncated: 31,
  };
  return ranks[key] ?? 100;
}

function truncateJsonValue(
  value: unknown,
  options: {
    readonly stringLimit: number;
    readonly arrayItems: number;
    readonly objectKeys: number;
    readonly depth: number;
    readonly seen?: WeakSet<object>;
  },
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateJsonString(value, options.stringLimit);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
    return null;
  }
  const seen = options.seen ?? new WeakSet<object>();
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
  }
  if (options.depth <= 0) {
    return isJsonObject(value) || Array.isArray(value)
      ? {
          [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
        }
      : String(value);
  }
  if (Array.isArray(value)) {
    const retained = value
      .slice(0, options.arrayItems)
      .map((entry) => truncateJsonValue(entry, { ...options, depth: options.depth - 1 }));
    if (value.length > options.arrayItems) {
      retained.push({
        [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
        omittedItems: value.length - options.arrayItems,
      });
    }
    return retained;
  }
  if (!isJsonObject(value)) {
    return String(value);
  }

  const entries = Object.entries(value)
    .filter(
      ([, entry]) =>
        entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol",
    )
    .toSorted((left, right) => {
      const byRank = activityPayloadKeyRank(left[0]) - activityPayloadKeyRank(right[0]);
      return byRank !== 0 ? byRank : left[0].localeCompare(right[0]);
    });
  const retainedEntries = entries.slice(0, options.objectKeys);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of retainedEntries) {
    result[key] = truncateJsonValue(entry, { ...options, depth: options.depth - 1 });
  }
  if (entries.length > options.objectKeys) {
    result[ACTIVITY_DATA_TRUNCATION_MARKER] = true;
    result.omittedKeys = entries.length - options.objectKeys;
  }
  return result;
}

function boundActivityData(value: unknown): unknown {
  const serialized = stringifyJsonLike(value);
  if (serialized.length <= MAX_ACTIVITY_DATA_JSON_CHARS) {
    return JSON.parse(serialized);
  }

  const withTruncationMetadata = (bounded: unknown): Record<string, unknown> => {
    const metadata = {
      [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
      originalJsonChars: serialized.length,
    };
    return isJsonObject(bounded) ? { ...bounded, ...metadata } : { ...metadata, value: bounded };
  };
  const hardFallback = (): Record<string, unknown> => ({
    [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
    originalJsonChars: serialized.length,
    preview: truncateJsonString(serialized, MAX_ACTIVITY_DATA_STRING_CHARS),
  });

  const compact = truncateJsonValue(value, {
    stringLimit: MAX_ACTIVITY_DATA_STRING_CHARS,
    arrayItems: MAX_ACTIVITY_DATA_ARRAY_ITEMS,
    objectKeys: MAX_ACTIVITY_DATA_OBJECT_KEYS,
    depth: 6,
  });
  const compactWithMetadata = withTruncationMetadata(compact);
  if (stringifyJsonLike(compactWithMetadata).length <= MAX_ACTIVITY_DATA_JSON_CHARS) {
    return compactWithMetadata;
  }

  const bounded = withTruncationMetadata(
    truncateJsonValue(value, {
      stringLimit: 800,
      arrayItems: 12,
      objectKeys: 32,
      depth: 4,
    }),
  );
  return stringifyJsonLike(bounded).length <= MAX_ACTIVITY_DATA_JSON_CHARS
    ? bounded
    : hardFallback();
}

// Tool payloads power the timeline, but they must stay small enough for snapshots.
function activityDataField(data: unknown): { readonly data?: unknown } {
  return data === undefined ? {} : { data: boundActivityData(data) };
}

// Keep MCP progress payloads available to the web timeline so it can render the specific tool call.
function buildToolProgressActivityPayload(
  event: Extract<ProviderRuntimeEvent, { type: "tool.progress" }>,
): ActivityPayload {
  return toActivityPayload({
    itemType: "mcp_tool_call" as const,
    title: "MCP tool call",
    ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
    data: {
      ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
      ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
      ...(event.payload.summary ? { summary: event.payload.summary } : {}),
      ...(event.payload.elapsedSeconds !== undefined
        ? { elapsedSeconds: event.payload.elapsedSeconds }
        : {}),
    },
  });
}

export function readableReasoningDetail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.replace(/<!--[\s\S]*?-->/gu, "").trim() ? trimmed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ActivityPayload | undefined {
  if (event.type !== "thread.token-usage.updated") {
    return undefined;
  }
  const usage = event.payload.usage;
  const hasTokenUsage = usage.usedTokens > 0;
  const hasPercentUsage =
    typeof usage.usedPercent === "number" && Number.isFinite(usage.usedPercent);
  const hasKnownWindow = typeof usage.maxTokens === "number" && Number.isFinite(usage.maxTokens);
  if (!hasTokenUsage && !hasPercentUsage && !hasKnownWindow) {
    return undefined;
  }
  // Stamp the emitting provider so token stats can attribute usage to the
  // provider that actually processed the turn, not the thread's persisted
  // model selection (which can drift, e.g. across future per-turn providers).
  return toActivityPayload({ ...usage, provider: event.provider });
}

function asPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

interface CompactModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

// Claude's SDK reports a per-model token breakdown on the turn result (subagent
// models included). Persist a compact copy on the turn.completed activity so
// token stats can attribute multi-model turns exactly; cache reads/writes fold
// into inputTokens, matching how the adapters build context-window snapshots.
function compactTurnModelUsage(
  modelUsage: Record<string, unknown> | undefined,
): Record<string, CompactModelUsage> | undefined {
  if (!modelUsage) {
    return undefined;
  }
  const compact: Record<string, CompactModelUsage> = {};
  for (const [model, value] of Object.entries(modelUsage)) {
    const usage = asObject(value);
    if (!usage) {
      continue;
    }
    const inputTokens =
      (asPositiveFiniteNumber(usage.inputTokens) ?? 0) +
      (asPositiveFiniteNumber(usage.cacheReadInputTokens) ?? 0) +
      (asPositiveFiniteNumber(usage.cacheCreationInputTokens) ?? 0);
    const outputTokens = asPositiveFiniteNumber(usage.outputTokens) ?? 0;
    const totalTokens = inputTokens + outputTokens;
    if (totalTokens <= 0) {
      continue;
    }
    compact[model] = { inputTokens, outputTokens, totalTokens };
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

// Convert session-configured Claude window labels into the max-token shape the web meter uses.
function buildConfiguredContextWindowPayload(
  event: ProviderRuntimeEvent,
): ActivityPayload | undefined {
  if (event.type !== "session.configured") {
    return undefined;
  }
  const config = asObject(event.payload.config);
  const autoCompactWindow = config?.autoCompactWindow;
  const legacyContextWindow = config?.contextWindow;
  const configuredWindowValue = autoCompactWindow ?? legacyContextWindow;
  const configuredWindow = asString(configuredWindowValue)?.trim().toLowerCase();
  const maxTokens =
    asPositiveFiniteNumber(configuredWindowValue) ??
    (configuredWindow === "1m" ? 1_000_000 : configuredWindow === "200k" ? 200_000 : undefined);
  if (maxTokens === undefined) {
    const explicitlyCleared =
      (autoCompactWindow === null &&
        (legacyContextWindow === undefined || legacyContextWindow === null)) ||
      (autoCompactWindow === undefined && legacyContextWindow === null);
    return explicitlyCleared ? toActivityPayload({ cleared: true }) : undefined;
  }
  return toActivityPayload({
    maxTokens,
    ...(configuredWindow ? { contextWindow: configuredWindow } : {}),
  });
}

export function runtimePayloadRecord(
  event: ProviderRuntimeEvent,
): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown }).payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
}

export function runtimeTurnState(
  event: ProviderRuntimeEvent,
): "completed" | "failed" | "interrupted" | "cancelled" {
  const state = asString(runtimePayloadRecord(event)?.state);
  return state === "failed" || state === "interrupted" || state === "cancelled"
    ? state
    : "completed";
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  if (requestType === "command_execution_approval" || requestType === "exec_command_approval")
    return "command";
  if (requestType === "file_read_approval") return "file-read";
  return requestType === "file_change_approval" || requestType === "apply_patch_approval"
    ? "file-change"
    : undefined;
}

export function projectProviderRuntimeActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const sequence = (event as ProviderRuntimeEvent & { sessionSequence?: number }).sessionSequence;
    // Activity `sequence` is a NonNegativeInt. A fractional or negative runtime
    // counter has to be dropped: carrying it invalidates the whole command.
    return typeof sequence === "number" && Number.isInteger(sequence) && sequence >= 0
      ? { sequence }
      : {};
  })();
  // Codex and Antigravity only render completed reasoning items with a readable summary.
  // Empty starts/completions are private/encrypted reasoning boundaries, not
  // transcript rows. Waiting for the authoritative completion also avoids
  // per-token activity writes and transcript height churn.
  if (
    (event.provider === "codex" || event.provider === "antigravity") &&
    event.type === "item.completed" &&
    event.payload.itemType === "reasoning" &&
    event.itemId !== undefined &&
    readableReasoningDetail(event.payload.detail) !== undefined
  ) {
    const reasoningItemId = String(event.itemId);
    const reasoningDetail = readableReasoningDetail(event.payload.detail)!;
    return [
      {
        id: EventId.makeUnsafe(`provider-reasoning:${event.threadId}:${reasoningItemId}`),
        createdAt: event.createdAt,
        tone: "tool",
        kind: "task.progress",
        summary: "Reasoning trace",
        payload: toActivityPayload({
          ...(event.payload.status ? { status: event.payload.status } : {}),
          detail: truncateDetail(reasoningDetail, MAX_ACTIVITY_DATA_STRING_CHARS),
          data: { toolCallId: reasoningItemId },
        }),
        turnId: toTurnId(event.turnId) ?? null,
        ...maybeSequence,
      },
    ];
  }
  switch (event.type) {
    case "session.configured": {
      const payload = buildConfiguredContextWindowPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.configured",
          summary: "Context window configured",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.opened":
    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      const requestId = nonEmptyTrimmed(event.requestId);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: event.type === "request.opened" ? "approval.requested" : "approval.resolved",
          summary:
            event.type === "request.resolved"
              ? "Approval resolved"
              : requestKind === "command"
                ? "Command approval requested"
                : requestKind === "file-read"
                  ? "File-read approval requested"
                  : requestKind === "file-change"
                    ? "File-change approval requested"
                    : "Approval requested",
          payload: toActivityPayload({
            // Omitted, never `undefined`: `Schema.Json` rejects a member that is
            // explicitly present and undefined.
            ...(requestId ? { requestId: ApprovalRequestId.makeUnsafe(requestId) } : {}),
            ...(event.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: event.lifecycleGeneration }
              : {}),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.type === "request.opened" && event.payload.detail
              ? { detail: truncateDetail(event.payload.detail) }
              : {}),
            ...(event.type === "request.resolved" && event.payload.decision
              ? { decision: event.payload.decision }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      const payload = runtimePayloadRecord(event);
      const message = asString(payload?.message);
      if (!message) {
        return [];
      }
      const errorClass = asString(payload?.class);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Provider runtime error",
          payload: toActivityPayload({
            message: truncateDetail(message, 500),
            ...(errorClass ? { class: errorClass } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      const raw = asObject((event as { raw?: unknown }).raw);
      const nativeType = asString(asObject(raw?.payload)?.type);
      // Claude backgrounding notices arrive as warnings whose detail is the
      // SDK background_tasks_changed message; they present as a plain info
      // line ("Moved to background: <work>"), not as a runtime warning.
      const detailSubtype = asString(asObject(event.payload.detail)?.subtype);
      const isBackgroundMove = detailSubtype === "background_tasks_changed";
      const message = truncateDetail(event.payload.message);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: isBackgroundMove
            ? "Moved to background"
            : (event.provider === "opencode" || event.provider === "kilo") &&
                (nativeType === "session.next.retried" || nativeType === "session.status")
              ? event.provider === "opencode"
                ? "OpenCode retrying"
                : "Kilo retrying"
              : "Runtime warning",
          // Keep the user-visible message even when raw detail is structured.
          payload: toActivityPayload({
            message,
            detail: message,
            ...(isBackgroundMove
              ? { nativeEventType: detailSubtype }
              : nativeType
                ? { nativeEventType: nativeType }
                : {}),
            ...activityDataField(event.payload.detail),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "model.rerouted": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "model.rerouted",
          summary: `Model switched: ${event.payload.fromModel} -> ${event.payload.toModel}`,
          payload: toActivityPayload({
            fromModel: event.payload.fromModel,
            toModel: event.payload.toModel,
            detail: truncateDetail(event.payload.reason, 500),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.tasks.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.tasks.updated",
          summary: "Tasks updated",
          payload: toActivityPayload({
            tasks: event.payload.tasks,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested":
    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: event.type,
          summary:
            event.type === "user-input.requested" ? "User input requested" : "User input submitted",
          payload: toActivityPayload({
            ...(event.requestId ? { requestId: event.requestId } : {}),
            ...(event.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: event.lifecycleGeneration }
              : {}),
            ...(event.type === "user-input.requested"
              ? { questions: event.payload.questions }
              : { answers: event.payload.answers }),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
            ...(event.payload.workflowName ? { workflowName: event.payload.workflowName } : {}),
            ...(event.payload.workflowTaskId
              ? { workflowTaskId: event.payload.workflowTaskId }
              : {}),
            ...(event.payload.workflowPhases
              ? { workflowPhases: event.payload.workflowPhases }
              : {}),
            ...(event.payload.workflowAgentPhases
              ? { workflowAgentPhases: event.payload.workflowAgentPhases }
              : {}),
            ...(event.payload.workflowAgentPlans
              ? { workflowAgentPlans: event.payload.workflowAgentPlans }
              : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            // Kept verbatim next to detail: workflow progress encodes
            // "<phase>: <agent label>" here and the panel parses it back out.
            description: truncateDetail(event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.workflowTaskId
              ? { workflowTaskId: event.payload.workflowTaskId }
              : {}),
            ...(event.payload.workflowAgents
              ? { workflowAgents: event.payload.workflowAgents }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.workflowTaskId
              ? { workflowTaskId: event.payload.workflowTaskId }
              : {}),
            ...(event.payload.workflowAgents
              ? { workflowAgents: event.payload.workflowAgents }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "paused"
              ? "Task paused"
              : event.payload.status === "killed"
                ? "Task killed"
                : event.payload.isBackgrounded === true
                  ? "Task moved to background"
                  : "Task updated",
          payload: toActivityPayload({
            taskId: event.payload.taskId,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.error ? { detail: truncateDetail(event.payload.error) } : {}),
            ...(event.payload.workflowTaskId
              ? { workflowTaskId: event.payload.workflowTaskId }
              : {}),
            ...(event.payload.workflowRunId ? { workflowRunId: event.payload.workflowRunId } : {}),
            ...(event.payload.workflowScriptPath
              ? { workflowScriptPath: event.payload.workflowScriptPath }
              : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.steered": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.steered",
          summary: "User message delivered",
          payload: toActivityPayload({
            detail: truncateDetail(event.payload.message),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted manually",
          payload: toActivityPayload({
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated":
    case "item.completed":
    case "item.started": {
      if (event.type !== "item.started" && event.payload.itemType === "context_compaction") {
        const failed = event.type === "item.completed" && event.payload.status === "failed";
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: failed ? "error" : "info",
            kind: "context-compaction",
            summary:
              event.type === "item.updated"
                ? "Compacting conversation..."
                : failed
                  ? "Context compaction failed"
                  : "Context compacted",
            payload: toActivityPayload({
              itemType: event.payload.itemType,
              status: event.payload.status,
              ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
              ...activityDataField(event.payload.data),
            }),
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      // A provider that sends a blank title must not turn into a blank summary:
      // `??` falls back on undefined only, so normalize before choosing.
      const itemTitle = nonEmptyTrimmed(event.payload.title);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind:
            event.type === "item.started"
              ? "tool.started"
              : event.type === "item.completed"
                ? "tool.completed"
                : "tool.updated",
          summary:
            event.type === "item.started"
              ? `${itemTitle ?? "Tool"} started`
              : (itemTitle ?? (event.type === "item.completed" ? "Tool" : "Tool updated")),
          payload: toActivityPayload({
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(itemTitle ? { title: itemTitle } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...activityDataField(event.payload.data),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary:
            nonEmptyTrimmed(event.payload.toolName) ??
            nonEmptyTrimmed(event.payload.summary) ??
            "MCP tool call",
          payload: buildToolProgressActivityPayload(event),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.completed": {
      const state = runtimeTurnState(event);
      const modelUsage = compactTurnModelUsage(event.payload.modelUsage);
      const errorMessage = asString(runtimePayloadRecord(event)?.errorMessage);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: state === "failed" ? "error" : "info",
          kind: "turn.completed",
          summary: state === "failed" ? "Turn failed" : "Turn completed",
          payload: toActivityPayload({
            state,
            ...(modelUsage ? { modelUsage } : {}),
            ...(typeof event.payload.totalCostUsd === "number"
              ? { totalCostUsd: event.payload.totalCostUsd }
              : {}),
            ...(typeof event.payload.cumulativeCostUsd === "number"
              ? { cumulativeCostUsd: event.payload.cumulativeCostUsd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "account.rate-limits.updated": {
      const rawRateLimits = event.payload.rateLimits;
      if (!rawRateLimits || typeof rawRateLimits !== "object") {
        return [];
      }
      const rl = rawRateLimits as Record<string, unknown>;
      if (Object.keys(rl).length === 0) {
        return [];
      }
      const status = rl.status;
      // Normalize resetsAt: Claude SDK sends Unix seconds (number), Codex may send ISO string
      const resetsAtRaw = rl.resetsAt;
      const resetsAt =
        typeof resetsAtRaw === "number"
          ? new Date(resetsAtRaw * 1000).toISOString()
          : typeof resetsAtRaw === "string"
            ? resetsAtRaw
            : undefined;
      // Preserve per-window rate limit breakdown when the provider sends it.
      // Claude SDK may include a `limits` array with per-window entries
      // (e.g. { window: "5h", utilization: 0.06, resetsAt: ... }).
      const rawLimits = Array.isArray(rl.limits) ? rl.limits : undefined;
      const limits = rawLimits
        ?.filter(
          (l): l is Record<string, unknown> =>
            l !== null &&
            typeof l === "object" &&
            typeof (l as Record<string, unknown>).window === "string",
        )
        .map((l) => {
          const lResetsAtRaw = l.resetsAt;
          const lResetsAt =
            typeof lResetsAtRaw === "number"
              ? new Date(lResetsAtRaw * 1000).toISOString()
              : typeof lResetsAtRaw === "string"
                ? lResetsAtRaw
                : undefined;
          const limit = { window: l.window as string } as {
            window: string;
            utilization?: number;
            resetsAt?: string;
          };
          if (typeof l.utilization === "number") {
            limit.utilization = l.utilization;
          }
          if (lResetsAt) {
            limit.resetsAt = lResetsAt;
          }
          return limit;
        });
      const normalizedPayload = {
        provider: event.provider,
        ...rl,
        ...(resetsAt ? { resetsAt } : {}),
        ...(typeof rl.utilization === "number" ? { utilization: rl.utilization } : {}),
        ...(limits && limits.length > 0 ? { limits } : {}),
      };
      const activities: OrchestrationThreadActivity[] = [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "account.rate-limits.updated",
          summary: "Rate limits updated",
          payload: toActivityPayload(normalizedPayload),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
      if (status !== "rejected" && status !== "allowed_warning") {
        return activities;
      }
      return [
        ...activities,
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: (status === "rejected" ? "error" : "info") as "error" | "info",
          kind: "account.rate-limited",
          summary: status === "rejected" ? "Rate limited" : "Approaching rate limit",
          payload: toActivityPayload({
            ...normalizedPayload,
            status,
          }),
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

export function providerActivityUpdateDedupeKey(
  event: ProviderRuntimeEvent,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
): string | undefined {
  const prefix = `${threadId}:${event.provider}:${activity.kind}`;
  if (
    activity.kind === "context-window.updated" ||
    activity.kind === "account.rate-limits.updated"
  ) {
    return prefix;
  }

  const payload = asObject(activity.payload);
  if (activity.kind === "task.progress") {
    const taskId = asString(payload?.taskId);
    return taskId ? `${prefix}:${taskId}` : undefined;
  }
  if (activity.kind !== "tool.updated") {
    return undefined;
  }

  const data = asObject(payload?.data);
  const toolUpdateId =
    event.itemId ??
    asString(data?.toolUseId) ??
    asString(data?.toolCallId) ??
    asString(data?.callId) ??
    asString(data?.callID);
  return toolUpdateId ? `${prefix}:${toolUpdateId}` : undefined;
}

export function providerActivityUpdateFingerprint(activity: OrchestrationThreadActivity): string {
  return stringifyJsonLike({
    kind: activity.kind,
    summary: activity.summary,
    payload: activity.payload,
    turnId: activity.turnId,
  });
}
