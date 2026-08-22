import type * as Acp from "@agentclientprotocol/sdk";
import type {
  RuntimeContentStreamKind,
  ThreadTokenUsageSnapshot,
  ToolLifecycleItemType,
} from "@synara/contracts";
import { summarizeToolRawOutput } from "@synara/shared/toolOutputSummary";

import { computeUsagePercent, nonNegativeInteger, positiveInteger } from "../tokenUsage.ts";
import { canonicalItemTypeFromAcpToolKind } from "./AcpAdapterSupport.ts";

type AcpTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<AcpSessionMode>;
}

export interface AcpToolCallState {
  readonly toolCallId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly status?: "pending" | "inProgress" | "completed" | "failed";
  readonly command?: string;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
}

export interface AcpPlanUpdate {
  readonly explanation?: string | null;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

export interface AcpPermissionRequest {
  readonly kind: string | "unknown";
  readonly detail?: string;
  readonly toolCall?: AcpToolCallState;
}

export type AcpParsedSessionEvent =
  | {
      readonly _tag: "ModeChanged";
      readonly modeId: string;
    }
  | {
      readonly _tag: "AssistantItemStarted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "AssistantItemCompleted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "PlanUpdated";
      readonly payload: AcpPlanUpdate;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ToolCallUpdated";
      readonly toolCall: AcpToolCallState;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ContentDelta";
      readonly itemId?: string;
      readonly text: string;
      readonly streamKind?: AcpTextStreamKind;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "UsageUpdated";
      readonly usage: ThreadTokenUsageSnapshot;
      readonly cost?: Acp.Cost | null | undefined;
      readonly rawPayload: unknown;
    };

type AcpSessionSetupResponse =
  | Acp.LoadSessionResponse
  | Acp.NewSessionResponse
  | Acp.ResumeSessionResponse;

type AcpToolCallUpdate = Extract<
  Acp.SessionNotification["update"],
  { readonly sessionUpdate: "tool_call" | "tool_call_update" }
>;

export function extractModelConfigId(sessionResponse: AcpSessionSetupResponse): string | undefined {
  const configOptions = sessionResponse.configOptions;
  if (!configOptions) return undefined;
  for (const opt of configOptions) {
    if (opt.category === "model" && opt.id.trim().length > 0) {
      return opt.id.trim();
    }
  }
  return undefined;
}

export function findSessionConfigOption(
  configOptions: ReadonlyArray<Acp.SessionConfigOption> | null | undefined,
  configId: string,
): Acp.SessionConfigOption | undefined {
  if (!configOptions) {
    return undefined;
  }
  const normalizedConfigId = configId.trim();
  if (!normalizedConfigId) {
    return undefined;
  }
  return configOptions.find((option) => option.id.trim() === normalizedConfigId);
}

export function collectSessionConfigOptionValues(
  configOption: Acp.SessionConfigOption,
): ReadonlyArray<string> {
  if (configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
}

export function parseSessionModeState(
  sessionResponse: AcpSessionSetupResponse,
): AcpSessionModeState | undefined {
  const modes = sessionResponse.modes;
  if (!modes) return undefined;
  const currentModeId = modes.currentModeId.trim();
  if (!currentModeId) {
    return undefined;
  }
  const availableModes = modes.availableModes
    .map((mode) => {
      const id = mode.id.trim();
      const name = mode.name.trim();
      if (!id || !name) {
        return undefined;
      }
      const description = mode.description?.trim() || undefined;
      return description !== undefined
        ? ({ id, name, description } satisfies AcpSessionMode)
        : ({ id, name } satisfies AcpSessionMode);
    })
    .filter((mode): mode is AcpSessionMode => mode !== undefined);
  if (availableModes.length === 0) {
    return undefined;
  }
  return {
    currentModeId,
    availableModes,
  };
}

function normalizePlanStepStatus(raw: unknown): "pending" | "inProgress" | "completed" {
  switch (raw) {
    case "completed":
      return "completed";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    default:
      return "pending";
  }
}

function normalizeToolCallStatus(
  raw: unknown,
  fallback?: "pending" | "inProgress" | "completed" | "failed",
): "pending" | "inProgress" | "completed" | "failed" | undefined {
  switch (raw) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return fallback;
  }
}

// Converts ACP's unstable usage updates into Synara's context-window snapshot shape.
function tokenUsageSnapshotFromAcpUsageUpdate(input: {
  readonly size: unknown;
  readonly used: unknown;
}): ThreadTokenUsageSnapshot | undefined {
  const usedTokens = nonNegativeInteger(input.used);
  if (usedTokens === undefined) {
    return undefined;
  }
  const maxTokens = positiveInteger(input.size);
  const usedPercent = computeUsagePercent(usedTokens, maxTokens);
  return {
    usedTokens,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    compactsAutomatically: true,
  };
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const match = /`([^`]+)`/.exec(title);
  return match?.[1]?.trim() || undefined;
}

function extractToolCallCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (isRecord(rawInput)) {
    const directCommand = normalizeCommandValue(rawInput.command);
    if (directCommand) {
      return directCommand;
    }
    const executable = typeof rawInput.executable === "string" ? rawInput.executable.trim() : "";
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return `${executable} ${args}`;
    }
    if (executable) {
      return executable;
    }
  }
  return extractCommandFromTitle(title);
}

function extractTextContentFromToolCallContent(
  content: ReadonlyArray<Acp.ToolCallContent> | null | undefined,
): string | undefined {
  if (!content) return undefined;
  const chunks = content
    .map((entry) => {
      if (entry.type !== "content") {
        return undefined;
      }
      const nestedContent = entry.content;
      if (nestedContent.type !== "text") {
        return undefined;
      }
      return nestedContent.text.trim().length > 0 ? nestedContent.text.trim() : undefined;
    })
    .filter((entry): entry is string => entry !== undefined);
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function summarizeToolCallLocations(
  locations: ReadonlyArray<Acp.ToolCallLocation> | null | undefined,
): string | undefined {
  const paths = (locations ?? [])
    .map((location) =>
      location.line === undefined || location.line === null
        ? location.path.trim()
        : `${location.path.trim()}:${location.line}`,
    )
    .filter((entry) => entry.length > 0);
  if (paths.length === 0) {
    return undefined;
  }
  return paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1} more`;
}

function summarizeToolCallContent(
  content: ReadonlyArray<Acp.ToolCallContent> | null | undefined,
): string | undefined {
  for (const entry of content ?? []) {
    if (entry.type === "diff") {
      return entry.path.trim() || undefined;
    }
    if (entry.type !== "content") {
      continue;
    }
    const nested = entry.content;
    if (nested.type === "resource_link") {
      return (nested.title ?? nested.name ?? nested.uri).trim() || undefined;
    }
    if (nested.type === "resource") {
      const resource = nested.resource;
      const uri = "uri" in resource && typeof resource.uri === "string" ? resource.uri.trim() : "";
      return uri || undefined;
    }
  }
  return extractTextContentFromToolCallContent(content);
}

function isProviderGenericToolTitle(title: string | undefined, kind: string | undefined): boolean {
  const normalized = title?.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (normalized === "tool" || normalized === "terminal" || normalized === "tool call") {
    return true;
  }
  if (kind === "search" && normalized === "find") {
    return true;
  }
  if (kind === "read" && (normalized === "read" || normalized === "read file")) {
    return true;
  }
  return false;
}

function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : undefined;
}

function inferToolKindFromProviderTitle(title: string | undefined): string | undefined {
  const normalized = title?.toLowerCase().replace(/\s+/g, " ").trim();
  switch (normalized) {
    case "find":
      return "search";
    case "read":
    case "read file":
      return "read";
    case "terminal":
      return "execute";
    default:
      return undefined;
  }
}

function deriveGenericToolActionTitle(
  kind: string | undefined,
  status: "pending" | "inProgress" | "completed" | "failed" | undefined,
): string | undefined {
  const running = status === "pending" || status === "inProgress" || status === undefined;
  switch (kind) {
    case "execute":
      return "Ran command";
    case "edit":
      return running ? "Editing" : "Edited";
    case "delete":
      return running ? "Deleting" : "Deleted";
    case "move":
      return running ? "Moving" : "Moved";
    case "search":
      return running ? "Searching" : "Searched";
    case "fetch":
      return running ? "Fetching" : "Fetched";
    case "read":
      return running ? "Reading" : "Read";
    default:
      return undefined;
  }
}

function deriveToolActivityPresentation(input: {
  readonly itemType: ToolLifecycleItemType;
  readonly title?: string;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
  readonly fallbackSummary: string;
}): { readonly summary: string; readonly detail?: string } {
  const summary = input.title?.trim() || input.fallbackSummary;
  const detail = input.detail?.trim();
  return detail ? { summary, detail } : { summary };
}

function makeToolCallState(
  input: {
    readonly toolCallId: string;
    readonly title?: string | null | undefined;
    readonly kind?: Acp.ToolKind | null | undefined;
    readonly status?: Acp.ToolCallStatus | null | undefined;
    readonly rawInput?: unknown;
    readonly rawOutput?: unknown;
    readonly content?: ReadonlyArray<Acp.ToolCallContent> | null | undefined;
    readonly locations?: ReadonlyArray<Acp.ToolCallLocation> | null | undefined;
  },
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  const toolCallId = input.toolCallId.trim();
  if (!toolCallId) {
    return undefined;
  }
  const title = input.title?.trim() || undefined;
  const command = extractToolCallCommand(input.rawInput, title);
  const textContent = extractTextContentFromToolCallContent(input.content);
  const structuredContent = summarizeToolCallContent(input.content);
  const locationDetail = summarizeToolCallLocations(input.locations);
  const outputDetail = summarizeToolRawOutput(input.rawOutput);
  const status = normalizeToolCallStatus(input.status, options?.fallbackStatus);
  const kind = normalizeToolKind(input.kind) ?? inferToolKindFromProviderTitle(title);
  const normalizedTitle =
    title && title.toLowerCase() !== "terminal" && title.toLowerCase() !== "tool call"
      ? title
      : undefined;
  const data: Record<string, unknown> = { toolCallId };
  if (kind) {
    data.kind = kind;
  }
  if (command) {
    data.command = command;
  }
  if (input.rawInput !== undefined) {
    data.rawInput = input.rawInput;
  }
  if (input.rawOutput !== undefined) {
    data.rawOutput = input.rawOutput;
  }
  if (input.content !== undefined) {
    data.content = input.content;
  }
  if (input.locations !== undefined) {
    data.locations = input.locations;
  }
  const kindSpecificTitleIsGeneric = isProviderGenericToolTitle(title, kind);
  const fallbackDetail =
    status === "failed"
      ? (textContent ??
        outputDetail ??
        command ??
        locationDetail ??
        structuredContent ??
        (kindSpecificTitleIsGeneric ? undefined : normalizedTitle))
      : (command ??
        locationDetail ??
        structuredContent ??
        outputDetail ??
        (kindSpecificTitleIsGeneric ? undefined : normalizedTitle) ??
        textContent);
  const actionTitle = deriveGenericToolActionTitle(kind, status);
  const hasPresentationSeed =
    title !== undefined ||
    kind !== undefined ||
    command !== undefined ||
    locationDetail !== undefined ||
    structuredContent !== undefined ||
    outputDetail !== undefined ||
    normalizedTitle !== undefined ||
    textContent !== undefined;
  const itemType = canonicalItemTypeFromAcpToolKind(kind);
  const presentation = hasPresentationSeed
    ? deriveToolActivityPresentation({
        itemType,
        data,
        fallbackSummary: actionTitle ?? (itemType === "command_execution" ? "Ran command" : "Tool"),
        ...(normalizedTitle !== undefined && !kindSpecificTitleIsGeneric
          ? { title: normalizedTitle }
          : actionTitle !== undefined
            ? { title: actionTitle }
            : {}),
        ...(fallbackDetail !== undefined ? { detail: fallbackDetail } : {}),
      })
    : undefined;
  return {
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(presentation?.summary ? { title: presentation.summary } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(presentation?.detail ? { detail: presentation.detail } : {}),
    data,
  };
}

function parseTypedToolCallState(
  event: AcpToolCallUpdate,
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  return makeToolCallState(
    {
      toolCallId: event.toolCallId,
      title: event.title,
      kind: event.kind,
      status: event.status,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      content: event.content,
      locations: event.locations,
    },
    options,
  );
}

export function mergeToolCallState(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): AcpToolCallState {
  const nextKind = typeof next.data.kind === "string" ? next.data.kind : undefined;
  const kind = nextKind ?? previous?.kind;
  const status = next.status ?? previous?.status;
  const nextTitleIsGeneric = isProviderGenericToolTitle(next.title, kind);
  const actionTitle = nextTitleIsGeneric ? deriveGenericToolActionTitle(kind, status) : undefined;
  const title = nextTitleIsGeneric
    ? (actionTitle ?? previous?.title ?? next.title)
    : (next.title ?? previous?.title);
  const command = next.command ?? previous?.command;
  const detail = next.detail ?? previous?.detail;
  return {
    toolCallId: next.toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data: {
      ...previous?.data,
      ...next.data,
    },
  };
}

export function parsePermissionRequest(params: Acp.RequestPermissionRequest): AcpPermissionRequest {
  const toolCall = makeToolCallState(
    {
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title,
      kind: params.toolCall.kind,
      status: params.toolCall.status,
      rawInput: params.toolCall.rawInput,
      rawOutput: params.toolCall.rawOutput,
      content: params.toolCall.content,
      locations: params.toolCall.locations,
    },
    { fallbackStatus: "pending" },
  );
  const kind = normalizeToolKind(params.toolCall.kind) ?? "unknown";
  const detail =
    toolCall?.command ??
    toolCall?.title ??
    toolCall?.detail ??
    (typeof params.sessionId === "string" ? `Session ${params.sessionId}` : undefined);
  return {
    kind,
    ...(detail ? { detail } : {}),
    ...(toolCall ? { toolCall } : {}),
  };
}

export function parseSessionUpdateEvent(params: Acp.SessionNotification): {
  readonly modeId?: string;
  readonly events: ReadonlyArray<AcpParsedSessionEvent>;
} {
  const upd = params.update;
  const events: Array<AcpParsedSessionEvent> = [];
  let modeId: string | undefined;

  switch (upd.sessionUpdate) {
    case "current_mode_update": {
      modeId = upd.currentModeId.trim();
      if (modeId) {
        events.push({
          _tag: "ModeChanged",
          modeId,
        });
      }
      break;
    }
    case "plan": {
      const plan = upd.entries.map((entry, index) => ({
        step: entry.content.trim().length > 0 ? entry.content.trim() : `Step ${index + 1}`,
        status: normalizePlanStepStatus(entry.status),
      }));
      if (plan.length > 0) {
        events.push({
          _tag: "PlanUpdated",
          payload: {
            plan,
          },
          rawPayload: params,
        });
      }
      break;
    }
    case "tool_call": {
      const toolCall = parseTypedToolCallState(upd, {
        fallbackStatus: "pending",
      });
      if (toolCall) {
        events.push({
          _tag: "ToolCallUpdated",
          toolCall,
          rawPayload: params,
        });
      }
      break;
    }
    case "tool_call_update": {
      const toolCall = parseTypedToolCallState(upd);
      if (toolCall) {
        events.push({
          _tag: "ToolCallUpdated",
          toolCall,
          rawPayload: params,
        });
      }
      break;
    }
    case "agent_message_chunk": {
      if (upd.content.type === "text" && upd.content.text.length > 0) {
        const itemId = trimNonEmpty(upd.messageId);
        events.push({
          _tag: "ContentDelta",
          ...(itemId ? { itemId } : {}),
          text: upd.content.text,
          streamKind: "assistant_text",
          rawPayload: params,
        });
      }
      break;
    }
    case "agent_thought_chunk": {
      if (upd.content.type === "text" && upd.content.text.length > 0) {
        const itemId = trimNonEmpty(upd.messageId);
        events.push({
          _tag: "ContentDelta",
          ...(itemId ? { itemId } : {}),
          text: upd.content.text,
          streamKind: "reasoning_text",
          rawPayload: params,
        });
      }
      break;
    }
    case "usage_update": {
      const usage = tokenUsageSnapshotFromAcpUsageUpdate({
        size: upd.size,
        used: upd.used,
      });
      if (usage) {
        events.push({
          _tag: "UsageUpdated",
          usage,
          ...(upd.cost !== undefined ? { cost: upd.cost } : {}),
          rawPayload: params,
        });
      }
      break;
    }
    default:
      break;
  }

  return { ...(modeId !== undefined ? { modeId } : {}), events };
}
