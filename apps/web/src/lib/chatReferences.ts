// FILE: chatReferences.ts
// Purpose: Build file/line references and canned prompts, and append them to a
//          thread's composer draft so panels outside ChatView can talk to the chatbox.
// Layer: Web UI utility

import { CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS, type ThreadId } from "@synara/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { formatComposerMentionToken } from "./composerMentions";
import { createFileCommentDraft, type FileCommentSelection } from "./fileComments";

export interface ChatFileReference {
  path: string;
  startLine?: number;
  endLine?: number;
  // 1-based column of the first/last selected character. When present the
  // reference narrows to the exact span (e.g. `line 21:5-12`) so highlighting a
  // single word references just those characters, not the whole line.
  startColumn?: number;
  endColumn?: number;
  // Verbatim selected text, used by surfaces that cannot map a selection back
  // to source lines (diff rows, whose split/unified views renumber): the quoted
  // snippet itself becomes the precise reference. Ignored when line info is
  // present.
  snippet?: string;
}

// DataTransfer type used when dragging a file row toward the composer. The
// payload is the already-formatted reference text (mention token).
export const CHAT_FILE_REFERENCE_DRAG_TYPE = "application/x-synara-file-reference";

export function formatLineRangeLabel(startLine: number, endLine: number): string {
  return endLine !== startLine ? `lines ${startLine}-${endLine}` : `line ${startLine}`;
}

// Wrap a snippet in a fenced block whose fence is longer than any backtick run
// inside it (so selected code that itself contains ``` survives Markdown), after
// normalizing newlines, trimming blank edges, and capping the length.
export function fenceCodeSnippet(snippet: string): string {
  const normalized = snippet.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  const truncated =
    normalized.length > CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS
      ? normalized.slice(0, CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)
      : normalized;
  const longestBacktickRun = truncated
    .match(/`+/g)
    ?.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, (longestBacktickRun ?? 0) + 1));
  return `${fence}\n${truncated}\n${fence}`;
}

// Editor-style location label for a reference: `line 21`, `line 21:5-12`,
// `lines 3-9`, or `lines 21:5-23:8`. Columns are appended only when both ends
// are known, so a single highlighted word reads as `line 21:5-12` instead of
// referencing the whole line. Returns null when there is no line info.
export function formatSelectionLabel(reference: ChatFileReference): string | null {
  if (typeof reference.startLine !== "number") {
    return null;
  }
  const endLine = reference.endLine ?? reference.startLine;
  const { startColumn, endColumn } = reference;
  if (typeof startColumn !== "number" || typeof endColumn !== "number") {
    return formatLineRangeLabel(reference.startLine, endLine);
  }
  if (reference.startLine === endLine) {
    const columns = startColumn === endColumn ? `${startColumn}` : `${startColumn}-${endColumn}`;
    return `line ${reference.startLine}:${columns}`;
  }
  return `lines ${reference.startLine}:${startColumn}-${endLine}:${endColumn}`;
}

// `@path` mention token plus a parenthetical location suffix (e.g.
// `@file (line 21:5-12)`). The range/columns live outside the mention token
// itself so provider-side file resolution keeps working. References without
// line info but with a snippet quote the selected text as a fenced block
// instead — the snippet is the precise reference there.
export function formatChatFileReference(reference: ChatFileReference): string {
  const token = formatComposerMentionToken(reference.path);
  const label = formatSelectionLabel(reference);
  if (label) {
    return `${token} (${label})`;
  }
  if (reference.snippet !== undefined && reference.snippet.trim().length > 0) {
    return `${token}\n${fenceCodeSnippet(reference.snippet)}`;
  }
  return token;
}

export function buildWhyChangedPrompt(path: string): string {
  return `Why did we implement the changes in ${formatComposerMentionToken(path)}?`;
}

// "Why" prompt for an arbitrary file or line range. Providers run in the
// workspace, so the prompt steers them toward git blame/history for evidence.
export function buildWhyLinesPrompt(reference: ChatFileReference): string {
  const token = formatComposerMentionToken(reference.path);
  if (typeof reference.startLine !== "number") {
    return `Why did we implement ${token} this way? Check the git history if needed and explain the reasoning.`;
  }
  const endLine = reference.endLine ?? reference.startLine;
  return `Why were ${formatLineRangeLabel(reference.startLine, endLine)} in ${token} implemented this way? Check git blame/history for the relevant commits and explain the reasoning.`;
}

// Mention token plus the highlighted diff snippet as a fenced block. Diff rows
// have no stable file line numbers (split/unified views renumber), so the
// quoted code itself is the precise reference.
export function buildDiffSelectionReference(path: string, snippet: string): string {
  return formatChatFileReference({ path, snippet });
}

export function appendComposerPromptText(threadId: ThreadId, text: string): void {
  const store = useComposerDraftStore.getState();
  const existingPrompt = store.draftsByThreadId[threadId]?.prompt ?? "";
  const needsSeparator = existingPrompt.length > 0 && !/\s$/.test(existingPrompt);
  store.setPrompt(threadId, `${existingPrompt}${needsSeparator ? " " : ""}${text} `);
  // Pull the user's attention to the composer so the insert is visible.
  requestComposerFocus(threadId);
}

export function appendChatFileReference(threadId: ThreadId, reference: ChatFileReference): void {
  appendComposerPromptText(threadId, formatChatFileReference(reference));
}

// Attach an inline "Local comment" (file + line range + request text) to the
// thread's composer draft so it surfaces as a chip and is serialized into the
// prompt on send. Returns false when the comment is empty/invalid. Focus is
// pulled to the composer whenever a valid comment is submitted (even if it
// dedupes against an existing one) so the resulting chip is visible.
export function addChatFileComment(threadId: ThreadId, comment: FileCommentSelection): boolean {
  const draft = createFileCommentDraft(comment);
  if (!draft) {
    return false;
  }
  useComposerDraftStore.getState().addFileComment(threadId, draft);
  requestComposerFocus(threadId);
  return true;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count;
}

// Number of characters on the current line of `text` (everything after the last
// newline), i.e. the 0-based column count at the end of `text`.
function columnsOnLastLine(text: string): number {
  return text.length - (text.lastIndexOf("\n") + 1);
}

// Pure line-range math, separated from the DOM selection plumbing for testability.
export function computeSelectionLineRange(
  prefixText: string,
  selectedText: string,
): { startLine: number; endLine: number } {
  const startLine = countNewlines(prefixText) + 1;
  const endLine = startLine + countNewlines(selectedText.replace(/\n+$/, ""));
  return { startLine, endLine };
}

// Pure 1-based column math. `startColumn` is the column of the first selected
// character; `endColumn` is the column of the last selected character (trailing
// newlines are ignored so a line-spanning selection ends on real content).
export function computeSelectionColumns(
  prefixText: string,
  selectedText: string,
): { startColumn: number; endColumn: number } {
  const startColumn = columnsOnLastLine(prefixText) + 1;
  const trimmedSelection = selectedText.replace(/\n+$/, "");
  const endColumn = columnsOnLastLine(prefixText + trimmedSelection);
  return { startColumn, endColumn };
}

export interface SelectionWithin {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

// Verbatim selection text ready to be quoted as a snippet reference: CRLF
// collapsed to LF, blank edge lines and surrounding whitespace removed. Returns
// null when nothing remains, so callers treat whitespace-only selections as
// "no selection". Shared by every surface that references a selection by its
// text rather than by source lines (diff rows, rendered markdown).
export function normalizeSelectionSnippet(text: string): string | null {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
  return normalized.length === 0 ? null : normalized;
}

// The current window selection scoped to `container`: null when collapsed,
// reaching outside the container, or whitespace-only.
function getSelectionRangeWithin(
  container: HTMLElement,
): { selection: Selection; range: Range; selectedText: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const selectedText = range.toString();
  if (selectedText.trim().length === 0) {
    return null;
  }
  return { selection, range, selectedText };
}

// Resolve the 1-based line+column span of the current selection inside
// `container`. Works for both plain <pre> contents and Shiki-highlighted markup
// because both keep one "\n" of text content per rendered line. Returns null
// when there is no actionable selection.
export function getSelectionWithin(container: HTMLElement): SelectionWithin | null {
  const scoped = getSelectionRangeWithin(container);
  if (!scoped) {
    return null;
  }
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(container);
  prefixRange.setEnd(scoped.range.startContainer, scoped.range.startOffset);
  const prefixText = prefixRange.toString();
  return {
    ...computeSelectionLineRange(prefixText, scoped.selectedText),
    ...computeSelectionColumns(prefixText, scoped.selectedText),
  };
}

// Snippet-only reference for the current selection inside `container`, for
// surfaces whose DOM does not mirror the source lines 1:1 (rendered markdown):
// the quoted text itself is the reference. Returns null when there is no
// actionable selection.
export function getSelectionSnippetWithin(container: HTMLElement): { snippet: string } | null {
  const scoped = getSelectionRangeWithin(container);
  if (!scoped) {
    return null;
  }
  // `Selection.toString()` yields the text as laid out (a line break between
  // block elements such as list items); `Range.toString()` would concatenate
  // their text content with no separator.
  const snippet = normalizeSelectionSnippet(scoped.selection.toString());
  return snippet === null ? null : { snippet };
}
