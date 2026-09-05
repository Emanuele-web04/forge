// FILE: composerWorkItems.ts
// Purpose: Work item (GitHub issue / PR) attachment state, serialization, and parsing.
// Layer: Web composer utility

import { WorkItemAttachment } from "@synara/contracts";
import { Schema } from "effect";

export interface WorkItemDraft extends WorkItemAttachment {
  id: string;
}

export const WORK_ITEM_ATTACHMENT_LIMIT = 5;

export function workItemKey(item: { kind: string; number: number }): string {
  return `${item.kind}:${item.number}`;
}

export function normalizeWorkItemDraft(item: WorkItemDraft): WorkItemDraft {
  return { ...item, title: item.title.trim(), url: item.url.trim() };
}

export function buildAttachedWorkItemsBlock(items: ReadonlyArray<WorkItemAttachment>): string {
  if (items.length === 0) return "";
  // Field whitelist must stay in sync with WorkItemAttachment: a dropped field
  // fails schema re-parse on extraction and the attachment disappears.
  const fields = [
    "kind",
    "number",
    "title",
    "state",
    "url",
    "bodyExcerpt",
    "createdAt",
    "updatedAt",
  ];
  return `\n<attached_work_items>\n${JSON.stringify(items, fields, 2)}\n</attached_work_items>`;
}

export function appendWorkItemsToPrompt(
  prompt: string,
  workItems: ReadonlyArray<WorkItemAttachment>,
): string {
  const trimmedPrompt = prompt.trim();
  const workItemsBlock = buildAttachedWorkItemsBlock(workItems);
  if (workItemsBlock.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n${workItemsBlock}` : workItemsBlock;
}

const TRAILING_ATTACHED_WORK_ITEMS_PATTERN =
  /\n*<attached_work_items>\n([\s\S]*?)\n<\/attached_work_items>\s*$/;

export function extractTrailingWorkItems(text: string): {
  promptText: string;
  workItems: WorkItemAttachment[];
} {
  const match = TRAILING_ATTACHED_WORK_ITEMS_PATTERN.exec(text);
  if (!match) return { promptText: text, workItems: [] };
  const before = text.slice(0, match.index);
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(parsed)) return { promptText: before, workItems: [] };
    const items = parsed
      .map((entry) => parseWorkItemEntry(entry))
      .filter((item): item is WorkItemAttachment => item !== null);
    return { promptText: before, workItems: items };
  } catch {
    return { promptText: before, workItems: [] };
  }
}

function parseWorkItemEntry(raw: unknown): WorkItemAttachment | null {
  try {
    return Schema.decodeUnknownSync(WorkItemAttachment)(raw);
  } catch {
    return null;
  }
}
