import { type MessageId, type ThreadId, type WorkItemAttachment } from "@synara/contracts";
import {
  extractTrailingAssistantSelections,
  type ParsedAssistantSelectionEntry,
} from "./assistantSelections";
import {
  buildBrowserAnnotationsPromptBlock,
  extractTrailingBrowserAnnotations,
  type BrowserAnnotationDraft,
} from "./browserAnnotations";
import { extractTrailingFileComments, type ParsedFileCommentEntry } from "./fileComments";
import { extractTrailingPastedTexts, type ParsedPastedTextEntry } from "./composerPastedText";
import { buildAttachedWorkItemsBlock, extractTrailingWorkItems } from "./composerWorkItems";

export interface TerminalContextSelection {
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface TerminalContextDraft extends TerminalContextSelection {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

export interface ExtractedTerminalContexts {
  promptText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
}

export interface DisplayedUserMessageState {
  visibleText: string;
  copyText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
  assistantSelections: ParsedAssistantSelectionEntry[];
  fileComments: ParsedFileCommentEntry[];
  pastedTexts: ParsedPastedTextEntry[];
  workItems: WorkItemAttachment[];
  browserAnnotations: BrowserAnnotationDraft[];
}

export interface ParsedTerminalContextEntry {
  header: string;
  body: string;
}

export const INLINE_TERMINAL_CONTEXT_PLACEHOLDER = "\uFFFC";
export const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
export const IMAGE_ONLY_VISIBLE_PLACEHOLDER = "(No Content)";

const TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN =
  /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/;
const TRAILING_SERIALIZED_COMPOSER_BLOCK_PATTERNS = [
  /\n*(<pasted_text>\n[\s\S]*?\n<\/pasted_text>)\s*$/u,
  /\n*(<attached_work_items>\n[\s\S]*?\n<\/attached_work_items>)\s*$/u,
  /\n*(<file_comments>\n[\s\S]*?\n<\/file_comments>)\s*$/u,
  /\n*(<terminal_context>\n[\s\S]*?\n<\/terminal_context>)\s*$/u,
  /\n*(<assistant_selection>\n[\s\S]*?\n<\/assistant_selection>)\s*$/u,
] as const;

interface DisplayedUserMessageOptions {
  hideImageOnlyBootstrapPrompt?: boolean;
  messageId: MessageId | undefined;
}

export function normalizeTerminalContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function hasTerminalContextText(context: { text: string }): boolean {
  return normalizeTerminalContextText(context.text).length > 0;
}

export function isTerminalContextExpired(context: { text: string }): boolean {
  return !hasTerminalContextText(context);
}

export function filterTerminalContextsWithText<T extends { text: string }>(
  contexts: ReadonlyArray<T>,
): T[] {
  return contexts.filter((context) => hasTerminalContextText(context));
}

export function syncTerminalContextsByIds<T extends { id: string }>(
  contexts: ReadonlyArray<T>,
  ids: ReadonlyArray<string>,
): T[] {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
}

export function terminalContextIdListsEqual<T extends { id: string }>(
  contexts: ReadonlyArray<T>,
  ids: ReadonlyArray<string>,
): boolean {
  return (
    contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index])
  );
}

function previewTerminalContextText(text: string): string {
  const normalized = normalizeTerminalContextText(text);
  if (normalized.length === 0) {
    return "";
  }
  const lines = normalized.split("\n");
  const visibleLines = lines.slice(0, 3);
  if (lines.length > 3) {
    visibleLines.push("...");
  }
  const preview = visibleLines.join("\n");
  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

export function normalizeTerminalContextSelection(
  selection: TerminalContextSelection,
): TerminalContextSelection | null {
  const text = normalizeTerminalContextText(selection.text);
  const terminalId = selection.terminalId.trim();
  const terminalLabel = selection.terminalLabel.trim();
  if (text.length === 0 || terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(selection.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(selection.lineEnd));
  return {
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text,
  };
}

export function formatTerminalContextRange(selection: {
  lineStart: number;
  lineEnd: number;
}): string {
  return selection.lineStart === selection.lineEnd
    ? `line ${selection.lineStart}`
    : `lines ${selection.lineStart}-${selection.lineEnd}`;
}

export function formatTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return `${selection.terminalLabel} ${formatTerminalContextRange(selection)}`;
}

export function formatInlineTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  const terminalLabel = selection.terminalLabel.trim().toLowerCase().replace(/\s+/g, "-");
  const range =
    selection.lineStart === selection.lineEnd
      ? `${selection.lineStart}`
      : `${selection.lineStart}-${selection.lineEnd}`;
  return `@${terminalLabel}:${range}`;
}

export function buildTerminalContextPreviewTitle(
  contexts: ReadonlyArray<TerminalContextSelection>,
): string | null {
  if (contexts.length === 0) {
    return null;
  }
  const previews = contexts
    .map((context) => {
      const normalized = normalizeTerminalContextSelection(context);
      if (!normalized) {
        return null;
      }
      const preview = previewTerminalContextText(normalized.text);
      return preview.length > 0
        ? `${formatTerminalContextLabel(normalized)}\n${preview}`
        : formatTerminalContextLabel(normalized);
    })
    .filter((value): value is string => value !== null)
    .join("\n\n");
  return previews.length > 0 ? previews : null;
}

function buildTerminalContextBodyLines(selection: TerminalContextSelection): string[] {
  return normalizeTerminalContextText(selection.text)
    .split("\n")
    .map((line, index) => `  ${selection.lineStart + index} | ${line}`);
}

export function buildTerminalContextBlock(
  contexts: ReadonlyArray<TerminalContextSelection>,
): string {
  const normalizedContexts = contexts
    .map((context) => normalizeTerminalContextSelection(context))
    .filter((context): context is TerminalContextSelection => context !== null);
  if (normalizedContexts.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (let index = 0; index < normalizedContexts.length; index += 1) {
    const context = normalizedContexts[index]!;
    lines.push(`- ${formatTerminalContextLabel(context)}:`);
    lines.push(...buildTerminalContextBodyLines(context));
    if (index < normalizedContexts.length - 1) {
      lines.push("");
    }
  }
  return ["<terminal_context>", ...lines, "</terminal_context>"].join("\n");
}

export function materializeInlineTerminalContextPrompt(
  prompt: string,
  contexts: ReadonlyArray<{
    terminalLabel: string;
    lineStart: number;
    lineEnd: number;
  }>,
): string {
  let nextContextIndex = 0;
  let result = "";

  for (const char of prompt) {
    if (char !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      result += char;
      continue;
    }
    const context = contexts[nextContextIndex] ?? null;
    nextContextIndex += 1;
    if (!context) {
      continue;
    }
    result += formatInlineTerminalContextLabel(context);
  }

  return result;
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

export function appendTerminalContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<TerminalContextSelection>,
): string {
  const trimmedPrompt = materializeInlineTerminalContextPrompt(prompt, contexts).trim();
  const contextBlock = buildTerminalContextBlock(contexts);
  if (contextBlock.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${contextBlock}` : contextBlock;
}

export function appendOriginalTerminalContextBlock(input: {
  editedPrompt: string;
  originalPrompt: string;
}): string {
  return appendOriginalComposerPromptBlocks(input);
}

// Edits operate on visible bubble text. Reattach the hidden composer metadata
// blocks from the original message so resend keeps the same references.
export function appendOriginalComposerPromptBlocks(input: {
  editedPrompt: string;
  originalPrompt: string;
  messageId?: MessageId;
}): string {
  let remainingPrompt = input.originalPrompt;
  const originalBlocks: string[] = [];
  if (input.messageId) {
    const extractedBrowserAnnotations = extractTrailingBrowserAnnotations(
      input.originalPrompt,
      input.messageId,
    );
    if (extractedBrowserAnnotations.annotations.length > 0) {
      remainingPrompt = extractedBrowserAnnotations.promptText;
      originalBlocks.push(
        buildBrowserAnnotationsPromptBlock(
          extractedBrowserAnnotations.annotations,
          input.messageId,
        ),
      );
    }
  }
  let strippedBlock = true;
  while (strippedBlock) {
    strippedBlock = false;
    for (const pattern of TRAILING_SERIALIZED_COMPOSER_BLOCK_PATTERNS) {
      const match = pattern.exec(remainingPrompt);
      const rawBlock = match?.[1];
      if (!match || !rawBlock) {
        continue;
      }
      originalBlocks.unshift(rawBlock.trim());
      remainingPrompt = remainingPrompt.slice(0, match.index).replace(/\n+$/u, "");
      strippedBlock = true;
      break;
    }
  }

  const editedPrompt = input.editedPrompt.trim();
  if (originalBlocks.length === 0) {
    return editedPrompt;
  }
  const serializedBlocks = originalBlocks.join("\n\n");
  return editedPrompt.length > 0 ? `${editedPrompt}\n\n${serializedBlocks}` : serializedBlocks;
}

export function extractTrailingTerminalContexts(prompt: string): ExtractedTerminalContexts {
  const match = TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const parsedContexts = parseTerminalContextEntries(match[1] ?? "");
  return {
    promptText,
    contextCount: parsedContexts.length,
    previewTitle:
      parsedContexts.length > 0
        ? parsedContexts
            .map(({ header, body }) => (body.length > 0 ? `${header}\n${body}` : header))
            .join("\n\n")
        : null,
    contexts: parsedContexts,
  };
}

export function deriveDisplayedUserMessageState(
  prompt: string,
  options: DisplayedUserMessageOptions,
): DisplayedUserMessageState {
  // Trailing blocks are serialized in order: assistant selections, terminal
  // contexts, file comments, pasted text, then browser annotations (outermost).
  // Strip them in reverse so each extractor sees its block at the end.
  const extractedBrowserAnnotations =
    options.messageId === undefined
      ? { promptText: prompt, annotations: [] }
      : extractTrailingBrowserAnnotations(prompt, options.messageId);
  const extractedWorkItems = extractTrailingWorkItems(extractedBrowserAnnotations.promptText);
  const extractedPastedTexts = extractTrailingPastedTexts(extractedWorkItems.promptText);
  const extractedFileComments = extractTrailingFileComments(extractedPastedTexts.promptText);
  const extractedContexts = extractTrailingTerminalContexts(extractedFileComments.promptText);
  const extractedAssistantSelections = extractTrailingAssistantSelections(
    extractedContexts.promptText,
  );
  const hidePrompt =
    options.hideImageOnlyBootstrapPrompt === true &&
    extractedAssistantSelections.promptText.trim() === IMAGE_ONLY_BOOTSTRAP_PROMPT;
  return {
    // Keep the internal bootstrap prompt hidden while still giving image-only
    // user messages a visible bubble in the transcript.
    visibleText: hidePrompt
      ? IMAGE_ONLY_VISIBLE_PLACEHOLDER
      : extractedAssistantSelections.promptText,
    copyText: hidePrompt ? "" : extractedAssistantSelections.promptText,
    contextCount: extractedContexts.contextCount,
    previewTitle: extractedContexts.previewTitle,
    contexts: extractedContexts.contexts,
    assistantSelections: extractedAssistantSelections.selections,
    fileComments: extractedFileComments.comments,
    pastedTexts: extractedPastedTexts.pastedTexts,
    workItems: extractedWorkItems.workItems,
    browserAnnotations: extractedBrowserAnnotations.annotations,
  };
}

function parseTerminalContextEntries(block: string): ParsedTerminalContextEntry[] {
  const entries: ParsedTerminalContextEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;

  const commitCurrent = () => {
    if (!current) {
      return;
    }
    entries.push({
      header: current.header,
      body: current.bodyLines.join("\n").trimEnd(),
    });
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      current = {
        header: headerMatch[1]!,
        bodyLines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (rawLine.startsWith("  ")) {
      current.bodyLines.push(rawLine.slice(2));
      continue;
    }
    if (rawLine.length === 0) {
      current.bodyLines.push("");
    }
  }

  commitCurrent();
  return entries;
}

export function countInlineTerminalContextPlaceholders(prompt: string): number {
  let count = 0;
  for (const char of prompt) {
    if (char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      count += 1;
    }
  }
  return count;
}

export function ensureInlineTerminalContextPlaceholders(
  prompt: string,
  terminalContextCount: number,
): string {
  const missingCount = terminalContextCount - countInlineTerminalContextPlaceholders(prompt);
  if (missingCount <= 0) {
    return prompt;
  }
  return `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER.repeat(missingCount)}${prompt}`;
}

function isInlineTerminalContextBoundaryWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\n" || char === "\t" || char === "\r";
}

export function insertInlineTerminalContextPlaceholder(
  prompt: string,
  cursorInput: number,
): { prompt: string; cursor: number; contextIndex: number } {
  const cursor = Math.max(0, Math.min(prompt.length, Math.floor(cursorInput)));
  const needsLeadingSpace = !isInlineTerminalContextBoundaryWhitespace(prompt[cursor - 1]);
  const replacement = `${needsLeadingSpace ? " " : ""}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} `;
  const rangeEnd = prompt[cursor] === " " ? cursor + 1 : cursor;
  return {
    prompt: `${prompt.slice(0, cursor)}${replacement}${prompt.slice(rangeEnd)}`,
    cursor: cursor + replacement.length,
    contextIndex: countInlineTerminalContextPlaceholders(prompt.slice(0, cursor)),
  };
}

export function stripInlineTerminalContextPlaceholders(prompt: string): string {
  return prompt.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, "");
}

export function removeInlineTerminalContextPlaceholder(
  prompt: string,
  contextIndex: number,
): { prompt: string; cursor: number } {
  if (contextIndex < 0) {
    return { prompt, cursor: prompt.length };
  }

  let placeholderIndex = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }
    if (placeholderIndex === contextIndex) {
      return {
        prompt: prompt.slice(0, index) + prompt.slice(index + 1),
        cursor: index,
      };
    }
    placeholderIndex += 1;
  }

  return { prompt, cursor: prompt.length };
}
