// FILE: fileComments.ts
// Purpose: Normalize, serialize, and parse inline "Local comment" requests that
//          the file viewer attaches to a thread's composer draft and prompt.
// Layer: Chat composer and transcript helpers

import { randomUUID } from "./utils";

// Inline comments authored against a file/line range in the editor gutter. They
// live on the composer draft like terminal contexts (not wire attachments) and
// are serialized into a trailing <file_comments> prompt block on send.
export const FILE_COMMENT_TEXT_MAX_CHARS = 4_000;

const TRAILING_FILE_COMMENTS_PATTERN = /\n*<file_comments>\n([\s\S]*?)\n<\/file_comments>\s*$/;
const FILE_COMMENT_HEADER_PATTERN = /^- (.+?) (?:line (\d+)|lines (\d+)-(\d+)):$/;

export interface FileCommentSelection {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileCommentDraft extends FileCommentSelection {
  id: string;
}

export interface ParsedFileCommentEntry {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ExtractedFileComments {
  promptText: string;
  comments: ParsedFileCommentEntry[];
}

export type FileCommentValidationError = "empty" | "too-long";

export function normalizeFileCommentText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

function normalizeLineRange(
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } {
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.max(start, Math.floor(endLine));
  return { startLine: start, endLine: end };
}

export function getFileCommentValidationError(
  comment: Pick<FileCommentSelection, "path" | "text">,
): FileCommentValidationError | null {
  const path = comment.path.trim();
  const text = normalizeFileCommentText(comment.text);
  if (path.length === 0 || text.length === 0) {
    return "empty";
  }
  if (text.length > FILE_COMMENT_TEXT_MAX_CHARS) {
    return "too-long";
  }
  return null;
}

export function normalizeFileCommentSelection(
  selection: FileCommentSelection,
): FileCommentSelection | null {
  if (getFileCommentValidationError(selection)) {
    return null;
  }
  const { startLine, endLine } = normalizeLineRange(selection.startLine, selection.endLine);
  return {
    path: selection.path.trim(),
    startLine,
    endLine,
    text: normalizeFileCommentText(selection.text),
  };
}

export function createFileCommentDraft(selection: FileCommentSelection): FileCommentDraft | null {
  const normalized = normalizeFileCommentSelection(selection);
  if (!normalized) {
    return null;
  }
  return {
    id: randomUUID(),
    ...normalized,
  };
}

export function formatFileCommentRange(selection: { startLine: number; endLine: number }): string {
  return selection.startLine === selection.endLine
    ? `line ${selection.startLine}`
    : `lines ${selection.startLine}-${selection.endLine}`;
}

export function formatFileCommentLabel(selection: {
  path: string;
  startLine: number;
  endLine: number;
}): string {
  return `${selection.path} ${formatFileCommentRange(selection)}`;
}

export function formatFileCommentTitleSeed(commentCount: number): string {
  return commentCount === 1 ? "File comment" : "File comments";
}

export function buildFileCommentsPromptBlock(
  comments: ReadonlyArray<FileCommentSelection>,
): string {
  const normalizedComments = comments
    .map((comment) => normalizeFileCommentSelection(comment))
    .filter((comment): comment is FileCommentSelection => comment !== null);
  if (normalizedComments.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (let index = 0; index < normalizedComments.length; index += 1) {
    const comment = normalizedComments[index]!;
    lines.push(`- ${formatFileCommentLabel(comment)}:`);
    for (const line of comment.text.split("\n")) {
      lines.push(`  ${line}`);
    }
    if (index < normalizedComments.length - 1) {
      lines.push("");
    }
  }
  return ["<file_comments>", ...lines, "</file_comments>"].join("\n");
}

export function appendFileCommentsToPrompt(
  prompt: string,
  comments: ReadonlyArray<FileCommentSelection>,
): string {
  const trimmedPrompt = prompt.trim();
  const block = buildFileCommentsPromptBlock(comments);
  if (block.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${block}` : block;
}

export function extractTrailingFileComments(prompt: string): ExtractedFileComments {
  const match = TRAILING_FILE_COMMENTS_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      comments: [],
    };
  }
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    comments: parseFileCommentEntries(match[1] ?? ""),
  };
}

function parseFileCommentEntries(block: string): ParsedFileCommentEntry[] {
  const entries: ParsedFileCommentEntry[] = [];
  let current: {
    path: string;
    startLine: number;
    endLine: number;
    lines: string[];
  } | null = null;

  const commitCurrent = () => {
    if (!current) return;
    const text = current.lines.join("\n").trimEnd();
    if (text.length > 0) {
      entries.push({
        path: current.path,
        startLine: current.startLine,
        endLine: current.endLine,
        text,
      });
    }
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const headerMatch = FILE_COMMENT_HEADER_PATTERN.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      const single = headerMatch[2];
      const startLine = single ? Number(single) : Number(headerMatch[3]);
      const endLine = single ? Number(single) : Number(headerMatch[4]);
      current = {
        path: headerMatch[1]!.trim(),
        startLine,
        endLine,
        lines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (rawLine.startsWith("  ")) {
      current.lines.push(rawLine.slice(2));
      continue;
    }
    if (rawLine.length === 0) {
      current.lines.push("");
    }
  }

  commitCurrent();
  return entries;
}
