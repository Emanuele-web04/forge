// FILE: threadFind.logic.ts
// Purpose: In-thread find matching and next/prev selection against projected
//   transcript messages — not the virtualized DOM list.
// Layer: Chat transcript presentation-adjacent logic (unit-tested)
// Depends on: timeline entry shape and message ids only.

import { type MessageId } from "@synara/contracts";
import { type TimelineEntry } from "../../session-logic";

export interface ThreadFindRange {
  startOffset: number;
  endOffset: number;
}

export interface ThreadFindDocument {
  messageId: MessageId;
  text: string;
  /** Set when the document is one interleaved assistant text segment. */
  segmentIndex?: number;
}

export interface ThreadFindMatch extends ThreadFindRange {
  messageId: MessageId;
  segmentIndex?: number;
}

export interface ThreadFindHighlight {
  query: string;
  activeMatch: ThreadFindMatch | null;
}

export type ThreadFindStepDirection = "next" | "previous";

export function normalizeFindQuery(query: string): string {
  return query.trim();
}

/**
 * Non-overlapping case-insensitive substring ranges in transcript order.
 * Fast path uses a lowercased indexOf when case-folding preserves UTF-16 length.
 */
export function collectCaseInsensitiveSubstringRanges(
  text: string,
  query: string,
): ThreadFindRange[] {
  const needle = normalizeFindQuery(query);
  if (needle.length === 0 || text.length === 0) {
    return [];
  }

  const needleLower = needle.toLowerCase();
  const haystackLower = text.toLowerCase();
  if (haystackLower.length === text.length && needleLower.length === needle.length) {
    const ranges: ThreadFindRange[] = [];
    let from = 0;
    while (from <= haystackLower.length - needleLower.length) {
      const index = haystackLower.indexOf(needleLower, from);
      if (index < 0) {
        break;
      }
      ranges.push({ startOffset: index, endOffset: index + needle.length });
      from = index + needle.length;
    }
    return ranges;
  }

  const ranges: ThreadFindRange[] = [];
  let from = 0;
  const lastStart = text.length - needle.length;
  while (from <= lastStart) {
    const slice = text.slice(from, from + needle.length);
    if (slice.toLowerCase() === needleLower) {
      ranges.push({ startOffset: from, endOffset: from + needle.length });
      from += needle.length;
      continue;
    }
    from += 1;
  }
  return ranges;
}

export function collectThreadFindDocuments(
  timelineEntries: readonly TimelineEntry[],
): ThreadFindDocument[] {
  const documents: ThreadFindDocument[] = [];
  for (const entry of timelineEntries) {
    if (entry.kind === "message") {
      if (entry.message.text.length === 0) {
        continue;
      }
      documents.push({
        messageId: entry.message.id,
        text: entry.message.text,
      });
      continue;
    }
    if (entry.kind !== "message-segment") {
      continue;
    }
    const segmentText = entry.message.textSegments?.[entry.segmentIndex]?.text ?? "";
    if (segmentText.length === 0) {
      continue;
    }
    documents.push({
      messageId: entry.message.id,
      text: segmentText,
      segmentIndex: entry.segmentIndex,
    });
  }
  return documents;
}

export function findThreadMatches(
  documents: readonly ThreadFindDocument[],
  query: string,
): ThreadFindMatch[] {
  const needle = normalizeFindQuery(query);
  if (needle.length === 0) {
    return [];
  }

  const matches: ThreadFindMatch[] = [];
  for (const document of documents) {
    const ranges = collectCaseInsensitiveSubstringRanges(document.text, needle);
    for (const range of ranges) {
      matches.push({
        messageId: document.messageId,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        ...(document.segmentIndex === undefined ? {} : { segmentIndex: document.segmentIndex }),
      });
    }
  }
  return matches;
}

export function stepThreadFindIndex(
  matchCount: number,
  currentIndex: number,
  direction: ThreadFindStepDirection,
): number {
  if (matchCount <= 0) {
    return -1;
  }
  if (currentIndex < 0 || currentIndex >= matchCount) {
    return direction === "next" ? 0 : matchCount - 1;
  }
  if (direction === "next") {
    return (currentIndex + 1) % matchCount;
  }
  return (currentIndex - 1 + matchCount) % matchCount;
}

export function resolveThreadFindJump(
  matches: readonly ThreadFindMatch[],
  index: number,
): ThreadFindMatch | null {
  if (index < 0 || index >= matches.length) {
    return null;
  }
  return matches[index] ?? null;
}

export function threadFindMarkdownProps(
  highlight: ThreadFindHighlight | null,
  messageId: MessageId,
  segmentIndex?: number,
): {
  findQuery?: string;
  findActiveRange?: ThreadFindRange | null;
} {
  if (highlight === null || normalizeFindQuery(highlight.query).length === 0) {
    return {};
  }
  const active = highlight.activeMatch;
  const isActive =
    active !== null && active.messageId === messageId && active.segmentIndex === segmentIndex;
  return {
    findQuery: highlight.query,
    findActiveRange: isActive
      ? { startOffset: active.startOffset, endOffset: active.endOffset }
      : null,
  };
}
