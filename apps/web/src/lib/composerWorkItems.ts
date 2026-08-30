// FILE: composerWorkItems.ts
// Purpose: Work item (GitHub issue / PR) attachment state, serialization, and parsing.
// Layer: Web composer utility

import type { WorkItemAttachment } from "@synara/contracts";

export interface WorkItemDraft extends WorkItemAttachment {
  id: string;
}

export const WORK_ITEM_ATTACHMENT_LIMIT = 5;

export interface ParsedWorkItemEntry {
  index: number;
  item: WorkItemAttachment;
}

interface SerializedWorkItemEntry {
  readonly kind: WorkItemAttachment["kind"];
  readonly number: number;
  readonly title: string;
  readonly state: WorkItemAttachment["state"];
  readonly url: string;
  readonly bodyExcerpt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function workItemKey(item: { kind: string; number: number }): string {
  return `${item.kind}:${item.number}`;
}

export function normalizeWorkItemDraft(item: WorkItemDraft): WorkItemDraft {
  return {
    id: item.id,
    kind: item.kind,
    number: item.number,
    title: item.title.trim(),
    state: item.state,
    url: item.url.trim(),
    bodyExcerpt: item.bodyExcerpt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function uniqueWorkItems(items: ReadonlyArray<WorkItemDraft>): WorkItemDraft[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = workItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function canAddWorkItem(
  items: ReadonlyArray<WorkItemDraft>,
  item: { kind: string; number: number },
): boolean {
  if (items.length >= WORK_ITEM_ATTACHMENT_LIMIT) return false;
  return !items.some((existing) => workItemKey(existing) === workItemKey(item));
}

export function buildAttachedWorkItemsBlock(items: ReadonlyArray<WorkItemAttachment>): string {
  if (items.length === 0) return "";
  const payload: SerializedWorkItemEntry[] = items.map((item) => ({
    kind: item.kind,
    number: item.number,
    title: item.title,
    state: item.state,
    url: item.url,
    bodyExcerpt: item.bodyExcerpt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
  return `\n<attached_work_items>\n${JSON.stringify(payload, null, 2)}\n</attached_work_items>`;
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
      .map((entry: unknown, index: number) => parseWorkItemEntry(entry, index))
      .filter((item): item is WorkItemAttachment => item !== null);
    return { promptText: before, workItems: items };
  } catch {
    return { promptText: before, workItems: [] };
  }
}

function parseWorkItemEntry(raw: unknown, index: number): WorkItemAttachment | null {
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
