// FILE: importedThreadMessages.ts
// Purpose: Normalizes provider-native transcript snapshots into Synara import messages.
// Layer: Orchestration import mapping
// Exports: Codex, Claude, OpenCode, and Factory Droid transcript mappers.

import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  EventId,
  isToolLifecycleItemType,
  MessageId,
  type OrchestrationThreadActivity,
  type ThreadHandoffImportedMessage,
  type ThreadId,
} from "@synara/contracts";

import {
  classifyToolItemType,
  summarizeToolRequest,
  titleForTool,
} from "../provider/claudeToolClassification.ts";
import {
  codexItemStatus,
  itemDetail,
  itemTitle,
  reasoningSummaryDetail,
  toCanonicalItemType,
} from "../provider/codexItemClassification.ts";
import {
  boundActivityData,
  toActivityPayload,
  truncateDetail,
} from "./providerRuntimeActivityProjection.ts";

const IMPORTED_REASONING_DETAIL_MAX_CHARS = 2_000;

export interface ImportedThreadTranscript {
  readonly messages: ReadonlyArray<ThreadHandoffImportedMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

function parseRecordTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readTranscriptTextParts(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as {
      readonly type?: unknown;
      readonly text?: unknown;
    };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  });
}

function readCodexSnapshotMessageText(value: unknown): string {
  if (!value || typeof value !== "object") return "";

  const candidate = value as {
    readonly text?: unknown;
    readonly content?: unknown;
  };
  if (typeof candidate.text === "string") return candidate.text;

  return readTranscriptTextParts(candidate.content).join("");
}

export function mapCodexSnapshotTranscript(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{
    readonly items: ReadonlyArray<unknown>;
  }>;
}): ImportedThreadTranscript {
  const importedAtMs = Date.parse(input.importedAt);
  const messages: ThreadHandoffImportedMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  let runningIndex = 0;
  let activitySequence = 0;

  input.turns.forEach((turn, turnIndex) => {
    turn.items.forEach((item, itemIndex) => {
      if (!item || typeof item !== "object") return;
      const candidate = item as Record<string, unknown>;
      const recordTimestampMs =
        parseRecordTimestampMs(candidate.timestamp) ??
        parseRecordTimestampMs(candidate.completedAt) ??
        parseRecordTimestampMs(candidate.createdAt);
      const createdAt = new Date(recordTimestampMs ?? importedAtMs + runningIndex).toISOString();
      runningIndex += 1;

      const role =
        candidate.type === "userMessage"
          ? "user"
          : candidate.type === "agentMessage"
            ? "assistant"
            : null;
      if (role !== null) {
        const text = readCodexSnapshotMessageText(candidate);
        if (text.length === 0) return;
        messages.push({
          messageId: MessageId.makeUnsafe(
            `import:${String(input.threadId)}:${turnIndex}:${itemIndex}`,
          ),
          role,
          text,
          createdAt,
          updatedAt: createdAt,
        });
        return;
      }

      const canonicalItemType = toCanonicalItemType(candidate.type ?? candidate.kind);
      const activityId = EventId.makeUnsafe(
        `import:${String(input.threadId)}:codex:activity:${turnIndex}:${itemIndex}`,
      );
      if (canonicalItemType === "reasoning") {
        const reasoningDetail = reasoningSummaryDetail(candidate);
        if (reasoningDetail === undefined) return;
        activities.push({
          id: activityId,
          tone: "tool",
          kind: "task.progress",
          summary: "Reasoning trace",
          payload: toActivityPayload({
            detail: truncateDetail(reasoningDetail, IMPORTED_REASONING_DETAIL_MAX_CHARS),
            data: { toolCallId: `import:${turnIndex}:${itemIndex}` },
          }),
          turnId: null,
          sequence: activitySequence,
          createdAt,
        });
        activitySequence += 1;
        return;
      }
      if (!isToolLifecycleItemType(canonicalItemType)) return;
      const title = itemTitle(canonicalItemType);
      const detail = itemDetail(candidate, {});
      const status = codexItemStatus("item.completed", candidate.status) ?? "completed";
      activities.push({
        id: activityId,
        tone: "tool",
        kind: "tool.completed",
        summary: title ?? "Tool",
        payload: toActivityPayload({
          itemType: canonicalItemType,
          status,
          ...(title ? { title } : {}),
          ...(detail ? { detail: truncateDetail(detail) } : {}),
          data: boundActivityData(candidate),
        }),
        turnId: null,
        sequence: activitySequence,
        createdAt,
      });
      activitySequence += 1;
    });
  });

  return { messages, activities };
}

function readClaudeSessionMessageText(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : "";

  const candidate = value as {
    readonly content?: unknown;
    readonly text?: unknown;
  };
  if (typeof candidate.text === "string") return candidate.text;
  if (typeof candidate.content === "string") return candidate.content;

  return readTranscriptTextParts(candidate.content).join("\n\n");
}

interface PendingClaudeTool {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly itemType: ReturnType<typeof classifyToolItemType>;
  readonly title: string;
  readonly detail: string;
  readonly startedAt: string;
}

function readClaudeContentBlocks(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const content = (value as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block && typeof block === "object" ? [block as Record<string, unknown>] : [],
  );
}

function claudeToolResultText(block: Record<string, unknown>): unknown {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const joined = readTranscriptTextParts(content).join("\n\n").trim();
    return joined.length > 0 ? joined : content;
  }
  return content;
}

export function mapClaudeSessionTranscript(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ClaudeSessionMessage>;
}): ImportedThreadTranscript {
  const importedAtMs = Date.parse(input.importedAt);
  const messages: ThreadHandoffImportedMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const pendingTools = new Map<string, PendingClaudeTool>();
  let activitySequence = 0;

  input.messages.forEach((message, messageIndex) => {
    if (message.type !== "user" && message.type !== "assistant") return;
    if (message.parent_tool_use_id !== null || message.parent_agent_id !== null) return;

    const recordTimestampMs = parseRecordTimestampMs(
      (message as { readonly timestamp?: unknown }).timestamp,
    );
    const createdAt = new Date(recordTimestampMs ?? importedAtMs + messageIndex).toISOString();
    const blocks = readClaudeContentBlocks(message.message);

    if (message.type === "assistant") {
      blocks.forEach((block, blockIndex) => {
        if (block.type === "thinking" && typeof block.thinking === "string") {
          const thinking = block.thinking.trim();
          if (thinking.length === 0) return;
          const reasoningId = `import:${String(input.threadId)}:claude:reasoning:${message.uuid}:${blockIndex}`;
          activities.push({
            id: EventId.makeUnsafe(reasoningId),
            tone: "tool",
            kind: "task.progress",
            summary: "Reasoning trace",
            payload: toActivityPayload({
              detail: truncateDetail(thinking, IMPORTED_REASONING_DETAIL_MAX_CHARS),
              data: { toolCallId: reasoningId },
            }),
            turnId: null,
            sequence: activitySequence,
            createdAt,
          });
          activitySequence += 1;
          return;
        }
        if (block.type === "tool_use" && typeof block.id === "string") {
          const toolName = typeof block.name === "string" ? block.name : "Tool";
          const toolInput =
            block.input && typeof block.input === "object" && !Array.isArray(block.input)
              ? (block.input as Record<string, unknown>)
              : {};
          const itemType = classifyToolItemType(toolName);
          pendingTools.set(block.id, {
            toolUseId: block.id,
            toolName,
            input: toolInput,
            itemType,
            title: titleForTool(itemType),
            detail: summarizeToolRequest(toolName, toolInput),
            startedAt: createdAt,
          });
        }
      });
    }

    if (message.type === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const pending = pendingTools.get(block.tool_use_id);
        if (!pending) continue;
        pendingTools.delete(block.tool_use_id);
        if (!isToolLifecycleItemType(pending.itemType)) continue;
        activities.push({
          id: EventId.makeUnsafe(
            `import:${String(input.threadId)}:claude:tool:${pending.toolUseId}`,
          ),
          tone: "tool",
          kind: "tool.completed",
          summary: pending.title,
          payload: toActivityPayload({
            itemType: pending.itemType,
            status: block.is_error === true ? "failed" : "completed",
            title: pending.title,
            detail: truncateDetail(pending.detail),
            data: boundActivityData({
              toolCallId: pending.toolUseId,
              callId: pending.toolUseId,
              toolName: pending.toolName,
              input: pending.input,
              result: claudeToolResultText(block),
            }),
          }),
          turnId: null,
          sequence: activitySequence,
          createdAt,
        });
        activitySequence += 1;
      }
    }

    const text = readClaudeSessionMessageText(message.message).trim();
    if (text.length === 0) return;
    messages.push({
      messageId: MessageId.makeUnsafe(`import:${String(input.threadId)}:claude:${message.uuid}`),
      role: message.type,
      text,
      createdAt,
      updatedAt: createdAt,
    });
  });

  for (const pending of pendingTools.values()) {
    if (!isToolLifecycleItemType(pending.itemType)) continue;
    activities.push({
      id: EventId.makeUnsafe(`import:${String(input.threadId)}:claude:tool:${pending.toolUseId}`),
      tone: "tool",
      kind: "tool.started",
      summary: `${pending.title} started`,
      payload: toActivityPayload({
        itemType: pending.itemType,
        status: "inProgress",
        title: pending.title,
        detail: truncateDetail(pending.detail),
        data: boundActivityData({
          toolCallId: pending.toolUseId,
          callId: pending.toolUseId,
          toolName: pending.toolName,
          input: pending.input,
        }),
      }),
      turnId: null,
      sequence: activitySequence,
      createdAt: pending.startedAt,
    });
    activitySequence += 1;
  }

  return { messages, activities };
}

function readOpenCodeSessionMessageText(parts: ReadonlyArray<unknown>): string {
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as {
        readonly type?: unknown;
        readonly text?: unknown;
      };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("\n\n")
    .trim();
}

export function mapOpenCodeSnapshotMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{
    readonly items: ReadonlyArray<unknown>;
  }>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  return input.turns.flatMap((turn, turnIndex) =>
    turn.items.flatMap((item, itemIndex) => {
      if (!item || typeof item !== "object") return [];

      const candidate = item as {
        readonly info?: {
          readonly id?: unknown;
          readonly role?: unknown;
        };
        readonly parts?: ReadonlyArray<unknown>;
      };
      const role =
        candidate.info?.role === "user"
          ? "user"
          : candidate.info?.role === "assistant"
            ? "assistant"
            : null;
      if (role === null) return [];

      const text = readOpenCodeSessionMessageText(candidate.parts ?? []);
      if (text.length === 0) return [];

      const sourceId =
        typeof candidate.info?.id === "string" && candidate.info.id.length > 0
          ? candidate.info.id
          : `${turnIndex}:${itemIndex}`;

      return [
        {
          messageId: MessageId.makeUnsafe(
            `import:${String(input.threadId)}:opencode:${turnIndex}:${itemIndex}:${sourceId}`,
          ),
          role,
          text,
          createdAt: input.importedAt,
          updatedAt: input.importedAt,
        },
      ];
    }),
  );
}

export function mapFactorySnapshotMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{ readonly items: ReadonlyArray<unknown> }>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  let messageIndex = 0;
  return input.turns.flatMap((turn, turnIndex) =>
    turn.items.flatMap((item, itemIndex) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as {
        readonly type?: unknown;
        readonly id?: unknown;
        readonly role?: unknown;
        readonly text?: unknown;
        readonly timestamp?: unknown;
      };
      if (candidate.type !== "factoryMessage") return [];
      const role =
        candidate.role === "user" ? "user" : candidate.role === "assistant" ? "assistant" : null;
      const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
      if (!role || !text) return [];
      const sourceId =
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : `${turnIndex}:${itemIndex}`;
      const parsedTimestamp =
        typeof candidate.timestamp === "string" ? Date.parse(candidate.timestamp) : Number.NaN;
      const fallbackTimestamp = Date.parse(input.importedAt) + messageIndex;
      const createdAt = new Date(
        Number.isFinite(parsedTimestamp) ? parsedTimestamp : fallbackTimestamp,
      ).toISOString();
      messageIndex += 1;
      return [
        {
          messageId: MessageId.makeUnsafe(
            `import:${String(input.threadId)}:droid:${turnIndex}:${itemIndex}:${sourceId}`,
          ),
          role,
          text,
          createdAt,
          updatedAt: createdAt,
        },
      ];
    }),
  );
}
