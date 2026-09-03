// FILE: threadFind.logic.ts
// Purpose: In-thread find matching and next/prev selection against projected
//   transcript messages — not the virtualized DOM list.
// Layer: Chat transcript presentation-adjacent logic (unit-tested)
// Depends on: timeline entry shape and message ids only.

import { type MessageId } from "@synara/contracts";
import { repairMarkdownTableDelimiters } from "../../lib/markdownTableRepair";
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";
import { type TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { resolveUserMessageMarkdownText } from "./userMessageTerminalContexts";

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

export const CHAT_FIND_MATCH_START_ATTRIBUTE = "data-chat-find-start";
export const CHAT_FIND_MATCH_ATTRIBUTE = "data-chat-find-match";
const CHAT_FIND_MATCH_CLASS = "chat-find-match";
const CHAT_FIND_MATCH_ACTIVE_CLASS = "chat-find-match-active";

export interface FindTextPart {
  text: string;
  match: boolean;
  active: boolean;
  startOffset?: number;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
}

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

function messageHasVisibleMedia(message: ChatMessage): boolean {
  return (message.attachments ?? []).some(
    (attachment) =>
      attachment.type === "image" ||
      attachment.type === "file" ||
      attachment.type === "assistant-selection",
  );
}

export function resolveThreadFindDocumentText(message: ChatMessage, text = message.text): string {
  if (message.role === "user") {
    const displayed = deriveDisplayedUserMessageState(text, {
      hideImageOnlyBootstrapPrompt: messageHasVisibleMedia(message),
      messageId: message.id,
    });
    return resolveUserMessageMarkdownText(displayed.visibleText, displayed.contexts);
  }
  return repairMarkdownTableDelimiters(text);
}

type ThreadFindDocumentTextResolver = (message: ChatMessage, text: string) => string;

interface CachedThreadFindDocumentText {
  sourceText: string;
  documentText: string;
}

interface CachedThreadFindMessageText {
  message?: CachedThreadFindDocumentText;
  segments: Map<number, CachedThreadFindDocumentText>;
}

export interface ThreadFindDocumentTextCache {
  resolve: (message: ChatMessage, text: string, segmentIndex?: number) => string;
}

export function createThreadFindDocumentTextCache(
  resolveText: ThreadFindDocumentTextResolver = resolveThreadFindDocumentText,
): ThreadFindDocumentTextCache {
  const messages = new WeakMap<ChatMessage, CachedThreadFindMessageText>();
  return {
    resolve: (message, text, segmentIndex) => {
      let cachedMessage = messages.get(message);
      if (!cachedMessage) {
        cachedMessage = { segments: new Map() };
        messages.set(message, cachedMessage);
      }
      const cached =
        segmentIndex === undefined
          ? cachedMessage.message
          : cachedMessage.segments.get(segmentIndex);
      if (cached?.sourceText === text) {
        return cached.documentText;
      }
      const documentText = resolveText(message, text);
      const next = { sourceText: text, documentText };
      if (segmentIndex === undefined) {
        cachedMessage.message = next;
      } else {
        cachedMessage.segments.set(segmentIndex, next);
      }
      return documentText;
    },
  };
}

const defaultThreadFindDocumentTextCache = createThreadFindDocumentTextCache();

export function collectThreadFindDocuments(
  timelineEntries: readonly TimelineEntry[],
  textCache: ThreadFindDocumentTextCache = defaultThreadFindDocumentTextCache,
): ThreadFindDocument[] {
  const documents: ThreadFindDocument[] = [];
  for (const entry of timelineEntries) {
    if (entry.kind === "message") {
      const text = textCache.resolve(entry.message, entry.message.text);
      if (text.length === 0) {
        continue;
      }
      documents.push({
        messageId: entry.message.id,
        text,
      });
      continue;
    }
    if (entry.kind !== "message-segment") {
      continue;
    }
    const segmentText = entry.message.textSegments?.[entry.segmentIndex]?.text ?? "";
    const text = textCache.resolve(entry.message, segmentText, entry.segmentIndex);
    if (text.length === 0) {
      continue;
    }
    documents.push({
      messageId: entry.message.id,
      text,
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

export function splitTextWithFindMatches(
  text: string,
  query: string,
  activeRange: ThreadFindRange | null,
  sourceOffset = 0,
): FindTextPart[] {
  const ranges = collectCaseInsensitiveSubstringRanges(text, query).map((range) => ({
    startOffset: sourceOffset + range.startOffset,
    endOffset: sourceOffset + range.endOffset,
  }));
  return splitTextWithFindRanges(text, ranges, activeRange, sourceOffset);
}

export function splitTextWithFindRanges(
  text: string,
  ranges: readonly ThreadFindRange[],
  activeRange: ThreadFindRange | null,
  sourceOffset = 0,
): FindTextPart[] {
  if (ranges.length === 0) {
    return [{ text, match: false, active: false }];
  }
  const parts: FindTextPart[] = [];
  let cursor = 0;
  const sourceEnd = sourceOffset + text.length;
  for (const range of ranges) {
    const overlapStart = Math.max(range.startOffset, sourceOffset);
    const overlapEnd = Math.min(range.endOffset, sourceEnd);
    if (overlapStart >= overlapEnd) {
      continue;
    }
    const localStart = overlapStart - sourceOffset;
    const localEnd = overlapEnd - sourceOffset;
    if (localStart > cursor) {
      parts.push({
        text: text.slice(cursor, localStart),
        match: false,
        active: false,
      });
    }
    parts.push({
      text: text.slice(localStart, localEnd),
      match: true,
      active:
        activeRange !== null &&
        activeRange.startOffset === range.startOffset &&
        activeRange.endOffset === range.endOffset,
      startOffset: range.startOffset,
      continuesBefore: overlapStart > range.startOffset,
      continuesAfter: overlapEnd < range.endOffset,
    });
    cursor = localEnd;
  }
  if (parts.length === 0) {
    return [{ text, match: false, active: false }];
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), match: false, active: false });
  }
  return parts;
}

function decodeHtmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    if (body === "nbsp") return " ";
    return entity;
  });
}

function decodedOffsetToHtmlOffset(raw: string, decodedOffset: number): number {
  let decoded = 0;
  let index = 0;
  while (index < raw.length && decoded < decodedOffset) {
    if (raw[index] === "&") {
      const end = raw.indexOf(";", index + 1);
      if (end === -1 || end - index > 12) {
        index += 1;
        decoded += 1;
        continue;
      }
      index = end + 1;
      decoded += 1;
      continue;
    }
    index += 1;
    decoded += 1;
  }
  return index;
}

type HtmlTextRun = {
  htmlStart: number;
  htmlEnd: number;
  decoded: string;
};

function collectHtmlTextRuns(html: string): HtmlTextRun[] {
  const runs: HtmlTextRun[] = [];
  let index = 0;
  while (index < html.length) {
    if (html[index] === "<") {
      const end = html.indexOf(">", index);
      if (end === -1) {
        break;
      }
      index = end + 1;
      continue;
    }
    const nextTag = html.indexOf("<", index);
    const htmlEnd = nextTag === -1 ? html.length : nextTag;
    const raw = html.slice(index, htmlEnd);
    if (raw.length > 0) {
      runs.push({ htmlStart: index, htmlEnd, decoded: decodeHtmlText(raw) });
    }
    index = htmlEnd;
  }
  return runs;
}

function findMatchSpanOpenTag(
  startOffset: number,
  active: boolean,
  continuesBefore: boolean,
  continuesAfter: boolean,
): string {
  const classes = [
    CHAT_FIND_MATCH_CLASS,
    active ? CHAT_FIND_MATCH_ACTIVE_CLASS : "",
    continuesBefore ? "chat-find-match-continues-before" : "",
    continuesAfter ? "chat-find-match-continues-after" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<span class="${classes}" ${CHAT_FIND_MATCH_ATTRIBUTE}="${active ? "active" : "true"}" ${CHAT_FIND_MATCH_START_ATTRIBUTE}="${String(startOffset)}">`;
}

/**
 * Wrap case-insensitive query hits inside HTML text nodes (Shiki output, fallback
 * code). Offsets on data-chat-find-start are in the surrounding message source.
 */
export function wrapFindQueryInHtml(
  html: string,
  query: string,
  sourceOffset = 0,
  activeRange: ThreadFindRange | null = null,
): string {
  const needle = normalizeFindQuery(query);
  if (needle.length === 0 || html.length === 0) {
    return html;
  }
  const runs = collectHtmlTextRuns(html);
  if (runs.length === 0) {
    return html;
  }
  const decoded = runs.map((run) => run.decoded).join("");
  const ranges = collectCaseInsensitiveSubstringRanges(decoded, needle);
  if (ranges.length === 0) {
    return html;
  }

  const insertions: Array<{ htmlStart: number; htmlEnd: number; open: string }> = [];
  for (const range of ranges) {
    const matchStartOffset = sourceOffset + range.startOffset;
    const active =
      activeRange !== null &&
      activeRange.startOffset === matchStartOffset &&
      activeRange.endOffset === sourceOffset + range.endOffset;
    let decodedCursor = 0;
    for (const run of runs) {
      const runDecodedEnd = decodedCursor + run.decoded.length;
      const overlapStart = Math.max(range.startOffset, decodedCursor);
      const overlapEnd = Math.min(range.endOffset, runDecodedEnd);
      if (overlapStart < overlapEnd) {
        const raw = html.slice(run.htmlStart, run.htmlEnd);
        const localStart = overlapStart - decodedCursor;
        const localEnd = overlapEnd - decodedCursor;
        insertions.push({
          htmlStart: run.htmlStart + decodedOffsetToHtmlOffset(raw, localStart),
          htmlEnd: run.htmlStart + decodedOffsetToHtmlOffset(raw, localEnd),
          open: findMatchSpanOpenTag(
            matchStartOffset,
            active,
            overlapStart > range.startOffset,
            overlapEnd < range.endOffset,
          ),
        });
      }
      decodedCursor = runDecodedEnd;
    }
  }

  const segments: string[] = [];
  let cursor = 0;
  for (const insertion of insertions.toSorted((left, right) => left.htmlStart - right.htmlStart)) {
    segments.push(
      html.slice(cursor, insertion.htmlStart),
      insertion.open,
      html.slice(insertion.htmlStart, insertion.htmlEnd),
      "</span>",
    );
    cursor = insertion.htmlEnd;
  }
  segments.push(html.slice(cursor));
  return segments.join("");
}

export function eventTargetsInAppBrowser(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(
      "[data-floating-browser-host='true'], [data-floating-browser-panel='true'], [data-browser-panel='true']",
    ) !== null
  );
}

export function shouldCaptureChatFindShortcut(input: {
  shouldRenderChatPaneContent: boolean;
  terminalWorkspaceTerminalTabActive: boolean;
  inAppBrowserFocused: boolean;
}): boolean {
  return (
    input.shouldRenderChatPaneContent &&
    !input.terminalWorkspaceTerminalTabActive &&
    !input.inAppBrowserFocused
  );
}

/**
 * Highlight snapshots flow from the find bar to the timeline without ChatView
 * state, so typing in find does not re-render the whole chat shell.
 */
export interface ThreadFindHighlightStore {
  get: () => ThreadFindHighlight | null;
  set: (value: ThreadFindHighlight | null) => void;
  setActiveMatch: (value: ThreadFindMatch | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createThreadFindHighlightStore(): ThreadFindHighlightStore {
  let current: ThreadFindHighlight | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (value) => {
      if (Object.is(current, value)) {
        return;
      }
      current = value;
      for (const listener of listeners) {
        listener();
      }
    },
    setActiveMatch: (value) => {
      if (current === null || Object.is(current.activeMatch, value)) {
        return;
      }
      current = { ...current, activeMatch: value };
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function applyActiveChatFindMatch(
  root: ParentNode | null,
  activeRange: ThreadFindRange | null,
): void {
  if (!root) {
    return;
  }
  const activeStart = activeRange?.startOffset;
  const elements = root.querySelectorAll(`[${CHAT_FIND_MATCH_ATTRIBUTE}]`);
  for (const element of elements) {
    const start = Number(element.getAttribute(CHAT_FIND_MATCH_START_ATTRIBUTE));
    const isActive = activeStart !== undefined && start === activeStart;
    element.setAttribute(CHAT_FIND_MATCH_ATTRIBUTE, isActive ? "active" : "true");
    element.classList.toggle(CHAT_FIND_MATCH_ACTIVE_CLASS, isActive);
  }
}
