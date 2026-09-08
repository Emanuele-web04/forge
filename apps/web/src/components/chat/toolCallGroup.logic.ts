// FILE: toolCallGroup.logic.ts
// Purpose: Summarizes a settled run of tool-call work entries into one compact
//          label ("Ran 2 commands, Edited 2 files, Searched 3 files") for the
//          collapsed tool-group disclosure in the transcript.
// Layer: Web chat presentation helpers
// Exports: MIN_COLLAPSIBLE_TOOL_GROUP_SIZE, ToolCallSummaryCategory,
//          ToolCallGroupSummary, isSummarizableToolCallEntry,
//          classifyToolCallSummaryCategory, summarizeToolCallGroup

import { pluralize } from "@synara/shared/text";
import { isFileChangeWorkLogEntry, type WorkLogEntry } from "../../session-logic";
import { deriveReadableCommandDisplay } from "../../lib/toolCallLabel";

// A single tool row collapses into nothing useful; only runs of 2+ fold.
export const MIN_COLLAPSIBLE_TOOL_GROUP_SIZE = 2;

export type ToolCallSummaryCategory =
  | "command"
  | "edit"
  | "read"
  | "search"
  | "agent"
  | "tool"
  | "other";

export interface ToolCallGroupSummaryPart {
  category: ToolCallSummaryCategory;
  count: number;
  label: string;
}

export interface ToolCallGroupSummary {
  label: string;
  parts: ReadonlyArray<ToolCallGroupSummaryPart>;
  entryCount: number;
  // A group with in-flight work must never present itself as settled.
  hasRunningEntry: boolean;
  // First summarized entry: the collapsed row borrows its icon so the summary
  // keeps the same leading glyph as the first tool row it folds away.
  iconEntry: WorkLogEntry;
}

// Rich rows (subagent strips, automation cards, thread-creation recaps) and
// non-tool tones (errors, approvals, info) must stay individually visible, so
// they never fold into a summary group.
export function isSummarizableToolCallEntry(entry: WorkLogEntry): boolean {
  return (
    entry.tone === "tool" &&
    !entry.synaraThreadCreation &&
    !entry.automation &&
    !entry.subagentAction &&
    (entry.subagents?.length ?? 0) === 0
  );
}

const READ_VERBS = new Set(["Read", "Reading"]);
const SEARCH_VERBS = new Set(["Searched", "Searching", "Found", "Finding"]);

function classifyCommandVerb(verb: string): ToolCallSummaryCategory {
  if (READ_VERBS.has(verb)) return "read";
  if (SEARCH_VERBS.has(verb)) return "search";
  return "command";
}

export function classifyToolCallSummaryCategory(entry: WorkLogEntry): ToolCallSummaryCategory {
  if (isFileChangeWorkLogEntry(entry)) {
    return "edit";
  }
  if (entry.requestKind === "file-read") {
    return "read";
  }
  if (entry.requestKind === "tool") {
    return "tool";
  }
  if (entry.itemType === "web_search") {
    return "search";
  }
  const command = entry.command ?? entry.rawCommand;
  if (entry.itemType === "command_execution" || entry.requestKind === "command" || command) {
    if (command) {
      return classifyCommandVerb(deriveReadableCommandDisplay(command).verb);
    }
    // Structured command actions (e.g. Codex read/search) carry the verb as the
    // derived tool title without any shell command string.
    const titleVerb = entry.toolTitle?.trim().split(/\s+/, 1)[0] ?? "";
    return classifyCommandVerb(titleVerb);
  }
  if (entry.itemType === "collab_agent_tool_call") {
    return "agent";
  }
  if (entry.itemType === "mcp_tool_call" || entry.itemType === "dynamic_tool_call") {
    return "tool";
  }
  if (entry.toolName) {
    return "tool";
  }
  return "other";
}

// Distinct-file identity for an edit/read entry. Entries with no file info
// count as one unit each so the total never under-reports work.
function entryFileKeys(entry: WorkLogEntry): ReadonlyArray<string> {
  if (entry.changedFiles && entry.changedFiles.length > 0) {
    return entry.changedFiles;
  }
  const detailFiles = entry.toolDetails?.files;
  if (detailFiles && detailFiles.length > 0) {
    return detailFiles;
  }
  const command = entry.command ?? entry.rawCommand;
  if (command) {
    const target = deriveReadableCommandDisplay(command).target.trim();
    if (target.length > 0) {
      return [target];
    }
  }
  if (entry.preview?.trim()) {
    return [entry.preview.trim()];
  }
  return [];
}

const CATEGORY_ORDER: ReadonlyArray<ToolCallSummaryCategory> = [
  "command",
  "edit",
  "read",
  "search",
  "agent",
  "tool",
  "other",
];

function summaryPartLabel(
  category: ToolCallSummaryCategory,
  count: number,
  isSolePart: boolean,
): string {
  switch (category) {
    case "command":
      return `Ran ${count} ${pluralize(count, "command")}`;
    case "edit":
      return `Edited ${count} ${pluralize(count, "file")}`;
    case "read":
      return `Read ${count} ${pluralize(count, "file")}`;
    case "search":
      return `Searched ${count} ${pluralize(count, "file")}`;
    case "agent":
      return `Ran ${count} agent ${pluralize(count, "task")}`;
    case "tool":
      return `Used ${count} ${pluralize(count, "tool")}`;
    case "other":
      return isSolePart
        ? `Ran ${count} tool ${pluralize(count, "call")}`
        : `${count} other tool ${pluralize(count, "call")}`;
  }
}

export function summarizeToolCallGroup(
  entries: ReadonlyArray<WorkLogEntry>,
): ToolCallGroupSummary | null {
  const summarizable = entries.filter(isSummarizableToolCallEntry);
  if (summarizable.length < MIN_COLLAPSIBLE_TOOL_GROUP_SIZE) {
    return null;
  }

  const countByCategory = new Map<ToolCallSummaryCategory, number>();
  const distinctFilesByCategory = new Map<ToolCallSummaryCategory, Set<string>>();
  let hasRunningEntry = false;

  for (const entry of summarizable) {
    if (entry.toolStatus === "running") {
      hasRunningEntry = true;
    }
    const category = classifyToolCallSummaryCategory(entry);
    if (category === "edit" || category === "read") {
      const fileKeys = entryFileKeys(entry);
      if (fileKeys.length === 0) {
        countByCategory.set(category, (countByCategory.get(category) ?? 0) + 1);
        continue;
      }
      const distinctFiles =
        distinctFilesByCategory.get(category) ??
        distinctFilesByCategory.set(category, new Set()).get(category)!;
      for (const fileKey of fileKeys) {
        distinctFiles.add(fileKey);
      }
      continue;
    }
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + 1);
  }

  for (const [category, distinctFiles] of distinctFilesByCategory) {
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + distinctFiles.size);
  }

  const populated = CATEGORY_ORDER.filter((category) => (countByCategory.get(category) ?? 0) > 0);
  const parts = populated.map((category) => {
    const count = countByCategory.get(category)!;
    return {
      category,
      count,
      label: summaryPartLabel(category, count, populated.length === 1),
    };
  });

  return {
    label: parts.map((part) => part.label).join(", "),
    parts,
    entryCount: summarizable.length,
    hasRunningEntry,
    iconEntry: summarizable[0]!,
  };
}
