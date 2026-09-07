// FILE: filePreviewFind.logic.ts
// Purpose: In-preview find matching, focus detection, highlight/scroll helpers,
//   and a small opener registry so Cmd+F can target the focused file preview.
// Layer: File preview presentation-adjacent logic (unit-tested)

import {
  collectCaseInsensitiveSubstringRanges,
  normalizeFindQuery,
  stepThreadFindIndex,
  type ThreadFindRange,
} from "./chat/threadFind.logic";

export const FILE_PREVIEW_FIND_MAX_MATCHES = 1000;
export const FILE_PREVIEW_FIND_QUERY_MAX_LENGTH = 200;

export const FILE_PREVIEW_FIND_MATCH_HIGHLIGHT = "file-find-match";
export const FILE_PREVIEW_FIND_ACTIVE_HIGHLIGHT = "file-find-match-active";
export const FILE_PREVIEW_FIND_LINE_MATCH_CLASS = "file-find-line-match";
export const FILE_PREVIEW_FIND_LINE_ACTIVE_CLASS = "file-find-line-match-active";

export type FilePreviewFindRange = ThreadFindRange;

export interface FilePreviewFindMatch extends FilePreviewFindRange {
  index: number;
}

export type FilePreviewFindStepDirection = "next" | "previous";

export function collectFilePreviewMatches(
  contents: string,
  query: string,
  maxMatches = FILE_PREVIEW_FIND_MAX_MATCHES,
): FilePreviewFindMatch[] {
  const ranges = collectCaseInsensitiveSubstringRanges(contents, query);
  const limited = ranges.length > maxMatches ? ranges.slice(0, maxMatches) : ranges;
  return limited.map((range, index) => ({
    index,
    startOffset: range.startOffset,
    endOffset: range.endOffset,
  }));
}

export function filePreviewMatchCountLabel(input: {
  query: string;
  matchCount: number;
  activeIndex: number;
  capped: boolean;
}): string {
  if (normalizeFindQuery(input.query).length === 0) {
    return "";
  }
  if (input.matchCount === 0) {
    return "No results";
  }
  const total = input.capped
    ? `${FILE_PREVIEW_FIND_MAX_MATCHES}+`
    : String(input.matchCount);
  const current =
    input.activeIndex < 0 ? 0 : Math.min(input.activeIndex + 1, input.matchCount);
  return `${current} / ${total}`;
}

export function stepFilePreviewFindIndex(
  matchCount: number,
  currentIndex: number,
  direction: FilePreviewFindStepDirection,
): number {
  return stepThreadFindIndex(matchCount, currentIndex, direction);
}

/**
 * Keep the current hit stable across live reloads by preferring the same
 * absolute offset, then the nearest later offset, then the nearest earlier one.
 */
export function anchorFilePreviewMatchIndex(
  matches: readonly FilePreviewFindMatch[],
  previous: FilePreviewFindRange | null,
): number {
  if (matches.length === 0) {
    return -1;
  }
  if (previous === null) {
    return 0;
  }
  const exact = matches.findIndex(
    (match) =>
      match.startOffset === previous.startOffset && match.endOffset === previous.endOffset,
  );
  if (exact >= 0) {
    return exact;
  }
  const atOffset = matches.findIndex((match) => match.startOffset === previous.startOffset);
  if (atOffset >= 0) {
    return atOffset;
  }
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const distance = Math.abs(match.startOffset - previous.startOffset);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function lineIndexForOffset(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  for (let index = 0; index < clamped; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

export function supportsCssCustomHighlight(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

interface DomTextNodeSpan {
  node: Text;
  start: number;
  end: number;
}

function collectDomTextNodeSpans(root: Node): DomTextNodeSpan[] {
  const spans: DomTextNodeSpan[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let current = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      const textNode = current as Text;
      const length = textNode.data.length;
      if (length > 0) {
        spans.push({ node: textNode, start: offset, end: offset + length });
        offset += length;
      }
    }
    current = walker.nextNode();
  }
  return spans;
}

function createRangeFromDomOffsets(
  spans: readonly DomTextNodeSpan[],
  startOffset: number,
  endOffset: number,
): Range | null {
  if (endOffset <= startOffset || spans.length === 0) {
    return null;
  }
  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;
  for (const span of spans) {
    if (startNode === null && startOffset >= span.start && startOffset <= span.end) {
      startNode = span.node;
      startNodeOffset = startOffset - span.start;
    }
    if (endOffset >= span.start && endOffset <= span.end) {
      endNode = span.node;
      endNodeOffset = endOffset - span.start;
      break;
    }
  }
  if (startNode === null || endNode === null) {
    return null;
  }
  try {
    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    return range;
  } catch {
    return null;
  }
}

export function collectDomHighlightRanges(
  root: HTMLElement,
  query: string,
  maxMatches = FILE_PREVIEW_FIND_MAX_MATCHES,
): Range[] {
  const needle = normalizeFindQuery(query);
  if (needle.length === 0) {
    return [];
  }
  const spans = collectDomTextNodeSpans(root);
  if (spans.length === 0) {
    return [];
  }
  const haystack = spans.map((span) => span.node.data).join("");
  const matches = collectCaseInsensitiveSubstringRanges(haystack, needle);
  const limited = matches.length > maxMatches ? matches.slice(0, maxMatches) : matches;
  const ranges: Range[] = [];
  for (const match of limited) {
    const range = createRangeFromDomOffsets(spans, match.startOffset, match.endOffset);
    if (range) {
      ranges.push(range);
    }
  }
  return ranges;
}

export function clearFilePreviewFindHighlights(root: HTMLElement | null): void {
  if (typeof CSS !== "undefined" && "highlights" in CSS) {
    CSS.highlights.delete(FILE_PREVIEW_FIND_MATCH_HIGHLIGHT);
    CSS.highlights.delete(FILE_PREVIEW_FIND_ACTIVE_HIGHLIGHT);
  }
  if (!root) {
    return;
  }
  for (const element of root.querySelectorAll(
    `.${FILE_PREVIEW_FIND_LINE_MATCH_CLASS}, .${FILE_PREVIEW_FIND_LINE_ACTIVE_CLASS}`,
  )) {
    element.classList.remove(
      FILE_PREVIEW_FIND_LINE_MATCH_CLASS,
      FILE_PREVIEW_FIND_LINE_ACTIVE_CLASS,
    );
  }
}

export function applyFilePreviewFindHighlights(input: {
  root: HTMLElement;
  contents: string;
  query: string;
  activeIndex: number;
  matches: readonly FilePreviewFindMatch[];
}): void {
  clearFilePreviewFindHighlights(input.root);
  const needle = normalizeFindQuery(input.query);
  if (needle.length === 0 || input.matches.length === 0) {
    return;
  }

  const safeIndex =
    input.activeIndex < 0
      ? -1
      : Math.min(input.activeIndex, input.matches.length - 1);

  if (supportsCssCustomHighlight()) {
    const domRanges = collectDomHighlightRanges(input.root, needle);
    if (domRanges.length > 0) {
      const activeDomIndex =
        safeIndex < 0 ? -1 : Math.min(safeIndex, domRanges.length - 1);
      const inactive = new Highlight();
      const active = new Highlight();
      for (let index = 0; index < domRanges.length; index += 1) {
        const range = domRanges[index];
        if (!range) continue;
        if (index === activeDomIndex) {
          active.add(range);
        } else {
          inactive.add(range);
        }
      }
      CSS.highlights.set(FILE_PREVIEW_FIND_MATCH_HIGHLIGHT, inactive);
      if (activeDomIndex >= 0) {
        CSS.highlights.set(FILE_PREVIEW_FIND_ACTIVE_HIGHLIGHT, active);
      }
      return;
    }
  }

  // Line-level fallback for engines without CSS Custom Highlight (or when the
  // rendered markdown DOM cannot host source-aligned ranges).
  const lineElements = input.root.querySelectorAll(".line");
  if (lineElements.length === 0) {
    return;
  }
  const activeMatch = safeIndex >= 0 ? input.matches[safeIndex] : null;
  const highlightedLines = new Set<number>();
  for (const match of input.matches) {
    highlightedLines.add(lineIndexForOffset(input.contents, match.startOffset));
  }
  for (const lineIndex of highlightedLines) {
    const element = lineElements[lineIndex];
    if (!(element instanceof HTMLElement)) continue;
    element.classList.add(FILE_PREVIEW_FIND_LINE_MATCH_CLASS);
  }
  if (activeMatch) {
    const activeLine = lineIndexForOffset(input.contents, activeMatch.startOffset);
    const element = lineElements[activeLine];
    if (element instanceof HTMLElement) {
      element.classList.add(FILE_PREVIEW_FIND_LINE_ACTIVE_CLASS);
    }
  }
}

export function scrollFilePreviewMatchIntoView(input: {
  root: HTMLElement;
  contents: string;
  query: string;
  activeIndex: number;
  matches: readonly FilePreviewFindMatch[];
}): void {
  if (input.matches.length === 0 || input.activeIndex < 0) {
    return;
  }
  const safeIndex = Math.min(input.activeIndex, input.matches.length - 1);
  const match = input.matches[safeIndex];
  if (!match) {
    return;
  }

  const needle = normalizeFindQuery(input.query);
  if (needle.length > 0 && supportsCssCustomHighlight()) {
    const domRanges = collectDomHighlightRanges(input.root, needle);
    const range = domRanges[Math.min(safeIndex, Math.max(domRanges.length - 1, 0))];
    if (range) {
      const anchor = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      anchor?.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
  }

  const lineElements = input.root.querySelectorAll(".line");
  const lineIndex = lineIndexForOffset(input.contents, match.startOffset);
  const lineElement = lineElements[lineIndex];
  if (lineElement instanceof HTMLElement) {
    lineElement.scrollIntoView({ block: "center", inline: "nearest" });
    return;
  }

  // Markdown / non-line DOM: scroll the first element that contains the hit text.
  const snippet = input.contents.slice(match.startOffset, match.endOffset);
  if (snippet.length === 0) {
    return;
  }
  const walker = document.createTreeWalker(input.root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (
      current.nodeType === Node.TEXT_NODE &&
      current.nodeValue &&
      current.nodeValue.toLowerCase().includes(snippet.toLowerCase())
    ) {
      const parent = current.parentElement;
      parent?.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
    current = walker.nextNode();
  }
}

export function isFilePreviewFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || !activeElement.isConnected) {
    return false;
  }
  return activeElement.closest("[data-file-preview='true']") !== null;
}

export function eventTargetsFilePreview(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  return target.closest("[data-file-preview='true']") !== null;
}

interface FilePreviewFindController {
  root: HTMLElement;
  open: () => void;
}

const filePreviewFindControllers = new Set<FilePreviewFindController>();

export function registerFilePreviewFindController(controller: FilePreviewFindController): () => void {
  filePreviewFindControllers.add(controller);
  return () => {
    filePreviewFindControllers.delete(controller);
  };
}

export function openFocusedFilePreviewFind(): boolean {
  const activeElement = document.activeElement;
  for (const controller of filePreviewFindControllers) {
    if (
      controller.root === activeElement ||
      (activeElement instanceof Node && controller.root.contains(activeElement))
    ) {
      controller.open();
      return true;
    }
  }
  return false;
}
