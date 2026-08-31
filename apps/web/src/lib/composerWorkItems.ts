// FILE: composerWorkItems.ts
// Purpose: Work item (GitHub issue / PR) attachment state, serialization, and parsing.
// Layer: Web composer utility

import type { WorkItemAttachment } from "@synara/contracts";

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
    const parsed = JSON.parse(match[1]!) as unknown;
    if (!Array.isArray(parsed)) return { promptText: before, workItems: [] };
    const items = parsed
      .map((entry: unknown) => parseWorkItemEntry(entry))
      .filter((item): item is WorkItemAttachment => item !== null);
    return { promptText: before, workItems: items };
  } catch {
    return { promptText: before, workItems: [] };
  }
}

function parseWorkItemEntry(raw: unknown): WorkItemAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const kind = entry.kind === "issue" || entry.kind === "pull-request" ? entry.kind : null;
  const number = typeof entry.number === "number" ? entry.number : Number(entry.number);
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  const state =
    entry.state === "open" || entry.state === "closed" || entry.state === "merged"
      ? entry.state
      : null;
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  const bodyExcerpt = typeof entry.bodyExcerpt === "string" ? entry.bodyExcerpt : "";
  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
  const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
  if (
    !kind ||
    !Number.isFinite(number) ||
    number <= 0 ||
    title.length === 0 ||
    !state ||
    url.length === 0
  ) {
    return null;
  }
  return { kind, number, title, state, url, bodyExcerpt, createdAt, updatedAt };
}
