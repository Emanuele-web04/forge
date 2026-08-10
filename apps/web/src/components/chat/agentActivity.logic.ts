// FILE: agentActivity.logic.ts
// Purpose: Derive compact transcript rows and full-detail models for agent activity.
// Layer: Chat presentation helpers
// Exports: agent activity detection, formatting, and timeline compaction

import { normalizeCompactToolLabel } from "../../lib/toolCallLabel";
import type { WorkLogEntry } from "../../session-logic";

export interface AgentActivityDetail {
  id: string;
  title: string;
  summary: string | null;
  primaryEntry: WorkLogEntry;
  entries: WorkLogEntry[];
}

export interface AgentActivityTimelineState {
  timelineWorkEntries: WorkLogEntry[];
  detailById: Map<string, AgentActivityDetail>;
}

const REASONING_GROUP_PREFIX = "agent-reasoning";

export function isReasoningUpdateWorkEntry(
  entry: Pick<WorkLogEntry, "label" | "toolTitle">,
): boolean {
  const heading = normalizeWorkText(entry.toolTitle ?? entry.label);
  return (
    heading === "reasoning" ||
    heading === "reasoning update" ||
    heading === "reasoning trace" ||
    heading === "reasoning summary"
  );
}

export function isCodexActivityStatusWorkEntry(entry: WorkLogEntry): boolean {
  if (isReasoningUpdateWorkEntry(entry)) {
    return true;
  }
  const isStatusOnlyCommand =
    entry.itemType === "command_execution" && !entry.command && !entry.rawCommand;
  return (
    isStatusOnlyCommand || normalizeWorkText(entry.toolTitle ?? entry.label) === "command execution"
  );
}

export function isAgentActivityWorkEntry(entry: WorkLogEntry): boolean {
  return entry.itemType === "collab_agent_tool_call" || isReasoningUpdateWorkEntry(entry);
}

export function formatAgentActivityEntryTitle(entry: WorkLogEntry): string {
  if (isReasoningUpdateWorkEntry(entry)) {
    return "Reasoning";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle ?? entry.label).trim();
  if (!heading) {
    return entry.itemType === "collab_agent_tool_call" ? "Agent task" : "Activity";
  }
  return capitalizePhrase(heading);
}

export function formatAgentActivityEntryPreview(entry: WorkLogEntry): string | null {
  if (isReasoningUpdateWorkEntry(entry)) {
    return cleanReasoningProgressText(entry.preview ?? entry.detail ?? entry.label);
  }

  if (entry.itemType === "collab_agent_tool_call") {
    return (
      normalizeOptionalText(entry.detail) ??
      normalizeOptionalText(entry.preview) ??
      normalizeOptionalText(entry.subagentAction?.prompt) ??
      normalizeOptionalText(entry.subagentAction?.summaryText)
    );
  }

  return normalizeOptionalText(entry.preview) ?? normalizeOptionalText(entry.detail);
}

export function formatAgentActivityEntrySummary(entry: WorkLogEntry): string | null {
  if (isReasoningUpdateWorkEntry(entry)) {
    return formatAgentActivityEntryPreview(entry);
  }

  if (entry.itemType === "collab_agent_tool_call") {
    return (
      normalizeOptionalText(entry.subagentAction?.prompt) ??
      normalizeOptionalText(entry.subagentAction?.summaryText) ??
      normalizeOptionalText(entry.preview)
    );
  }

  return normalizeOptionalText(entry.preview);
}

export function deriveAgentActivityTimelineState(
  entries: ReadonlyArray<WorkLogEntry>,
): AgentActivityTimelineState {
  const timelineWorkEntries: WorkLogEntry[] = [];
  const detailById = new Map<string, AgentActivityDetail>();
  let pendingReasoningEntries: WorkLogEntry[] = [];

  const flushReasoningEntries = () => {
    if (pendingReasoningEntries.length === 0) {
      return;
    }

    const groupEntries = pendingReasoningEntries;
    pendingReasoningEntries = [];
    const first = groupEntries[0]!;
    const latest = groupEntries[groupEntries.length - 1]!;
    const groupId = `${REASONING_GROUP_PREFIX}:${first.id}`;
    const latestPreview = findLatestPreview(groupEntries);
    const updateCount = groupEntries.length;
    const displayPreview =
      updateCount > 1
        ? latestPreview
          ? `${updateCount} updates - ${latestPreview}`
          : `${updateCount} updates`
        : latestPreview;
    const displayEntry: WorkLogEntry = {
      ...latest,
      id: groupId,
      label: "Reasoning trace",
      toolTitle: "Reasoning trace",
      tone: "tool",
      ...(displayPreview ? { preview: displayPreview, detail: displayPreview } : {}),
    };

    timelineWorkEntries.push(displayEntry);
    detailById.set(groupId, buildAgentActivityDetail(groupId, displayEntry, groupEntries));
  };

  for (const entry of entries) {
    // Legacy providers emit free-standing reasoning updates with no item id;
    // keep compacting those. Canonical Codex reasoning carries toolCallId, so
    // each completed provider item remains its own visible row.
    if (isReasoningUpdateWorkEntry(entry) && !entry.toolCallId) {
      pendingReasoningEntries.push(entry);
      continue;
    }

    flushReasoningEntries();
    const reasoningPreview = isReasoningUpdateWorkEntry(entry)
      ? formatAgentActivityEntryPreview(entry)
      : null;
    // Old Forkara builds persisted a literal placeholder for every empty Codex
    // reasoning lifecycle. Match Codex history semantics and hide those rows.
    if (isReasoningUpdateWorkEntry(entry) && !reasoningPreview) {
      continue;
    }
    const displayEntry = reasoningPreview
      ? {
          ...entry,
          label: "Reasoning trace",
          toolTitle: "Reasoning trace",
          preview: reasoningPreview,
          tone: "tool" as const,
        }
      : entry;
    timelineWorkEntries.push(displayEntry);
    if (isAgentActivityWorkEntry(entry)) {
      detailById.set(entry.id, buildAgentActivityDetail(entry.id, displayEntry, [entry]));
    }
  }

  flushReasoningEntries();
  return { timelineWorkEntries, detailById };
}

function buildAgentActivityDetail(
  id: string,
  primaryEntry: WorkLogEntry,
  entries: ReadonlyArray<WorkLogEntry>,
): AgentActivityDetail {
  const title = formatAgentActivityEntryTitle(primaryEntry);
  return {
    id,
    title,
    summary: findLatestSummary(entries),
    primaryEntry,
    entries: [...entries],
  };
}

function findLatestPreview(entries: ReadonlyArray<WorkLogEntry>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const preview = formatAgentActivityEntryPreview(entries[index]!);
    if (preview) {
      return preview;
    }
  }
  return null;
}

function findLatestSummary(entries: ReadonlyArray<WorkLogEntry>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const summary = formatAgentActivityEntrySummary(entries[index]!);
    if (summary) {
      return summary;
    }
  }
  return null;
}

function cleanReasoningProgressText(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  // Codex summaries are Markdown blocks such as
  // `**Planning the implementation**\n\n<!-- -->`. Its compact UI label is the
  // last readable line, with comments and lightweight Markdown removed.
  const readableLines = value
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("<!--"));
  const latestLine = readableLines.at(-1);
  if (!latestLine) {
    return null;
  }
  const trimmed = latestLine
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^\*\*(.+)\*\*$/u, "$1")
    .replace(/^__(.+)__$/u, "$1")
    .replace(/^`(.+)`$/u, "$1")
    .trim();

  const withoutReasoningPrefix = trimmed
    .replace(/^reasoning(?:\s+(?:update|trace|summary))?\b[\s:.-]*/i, "")
    .trim();
  const withoutRunningPrefix = withoutReasoningPrefix.replace(/^running\b[\s:.-]*/i, "").trim();
  return withoutRunningPrefix || withoutReasoningPrefix || null;
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkText(value: string): string {
  return normalizeCompactToolLabel(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}
