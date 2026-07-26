// FILE: taskCompletion.logic.ts
// Purpose: Detects new thread lifecycle notifications and builds alert copy.
// Layer: Notification logic
// Exports: lifecycle detection helpers and notification copy helpers

import {
  defaultTerminalTitleForCliKind,
  type TerminalCliKind,
  type TerminalVisualState,
} from "@synara/shared/terminalThreads";
import type { Thread, ThreadSession } from "../types";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  hasLiveLatestTurn,
} from "../session-logic";

export interface CompletedThreadCandidate {
  threadId: Thread["id"];
  projectId: Thread["projectId"];
  title: string;
  completedAt: string;
  assistantSummary: string | null;
}

export interface ThreadAttentionCandidate {
  kind: "approval" | "user-input";
  threadId: Thread["id"];
  projectId: Thread["projectId"];
  title: string;
  requestId: string;
  createdAt: string;
  requestKind?: "command" | "file-read" | "file-change";
  summary?: string;
}

interface TerminalNotificationThreadState {
  runningTerminalIds: string[];
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}

export interface CompletedTerminalCandidate {
  cliKind: TerminalCliKind | null;
  terminalId: string;
  threadId: Thread["id"];
  title: string;
}

export interface TerminalAttentionCandidate {
  cliKind: TerminalCliKind | null;
  terminalId: string;
  threadId: Thread["id"];
  title: string;
}

type ThreadSessionStatus = ThreadSession["status"];

// Thread completion toasts are for off-screen work; visible threads already show the result inline.
export function shouldShowThreadNotificationToast(input: {
  threadId: Thread["id"];
  visibleThreadIds: ReadonlySet<Thread["id"]>;
}): boolean {
  return !input.visibleThreadIds.has(input.threadId);
}

// Treat sidebar "working" states as the only notification-worthy starting point.
function isRunningStatus(status: ThreadSessionStatus | null | undefined): boolean {
  return status === "running" || status === "connecting";
}

const NOTIFICATION_SUMMARY_MAX_LENGTH = 120;

const PROTECTED_CODE_START = "\uE000";
const PROTECTED_CODE_END = "\uE001";

function markdownColumnWidth(value: string): number {
  let columns = 0;
  for (const character of value) {
    columns = character === "\t" ? columns + (4 - (columns % 4)) : columns + 1;
  }
  return columns;
}

function findMarkdownContainerBoundary(
  text: string,
  contentStart: number,
  quotePrefix: string,
  quoteDepth: number,
  listContinuationIndent: number,
): number | null {
  if (quoteDepth === 0 && listContinuationIndent === 0) {
    return null;
  }

  const quotePattern = new RegExp(`^${quotePrefix}`);
  let lineStart = contentStart;

  while (lineStart < text.length) {
    const nextNewline = text.indexOf("\n", lineStart);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const quoteMatch = quotePattern.exec(line);

    if (quoteDepth > 0 && !quoteMatch) {
      return lineStart;
    }

    const content = line.slice(quoteMatch?.[0].length ?? 0);
    if (listContinuationIndent > 0 && content.trim().length > 0) {
      const indentation = content.match(/^[ \t]*/)?.[0] ?? "";
      if (markdownColumnWidth(indentation) < listContinuationIndent) {
        return lineStart;
      }
    }

    if (nextNewline === -1) {
      break;
    }
    lineStart = nextNewline + 1;
  }

  return null;
}

function protectMarkdownFencedBlocks(text: string, protect: (content: string) => string): string {
  const openingPattern =
    /(^|\n)((?:[ \t]{0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+))*[ \t]{0,3})(`{3,}|~{3,})([^\r\n]*)\r?\n/g;
  let result = "";
  let cursor = 0;
  let openingMatch: RegExpExecArray | null;

  while ((openingMatch = openingPattern.exec(text)) !== null) {
    const linePrefix = openingMatch[1] ?? "";
    const containerPrefix = openingMatch[2] ?? "";
    const fence = openingMatch[3] ?? "";
    const info = openingMatch[4] ?? "";
    const fenceCharacter = fence[0];

    // Backticks are not valid inside a backtick fence's info string. Treat
    // such a line as prose so same-line multi-backtick code remains inline.
    if (fenceCharacter === "`" && info.includes("`")) {
      continue;
    }

    const quoteDepth = containerPrefix.match(/>/g)?.length ?? 0;
    const quotePrefix = `(?:[ \\t]{0,3}>[ \\t]?){${quoteDepth}}`;
    const prefixWithoutBlockquotes = containerPrefix.replace(/[ \t]{0,3}>[ \t]?/g, "");
    const listContinuationIndent = /(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(prefixWithoutBlockquotes)
      ? markdownColumnWidth(prefixWithoutBlockquotes)
      : 0;
    const closingPattern = new RegExp(
      `(^|\\n)${quotePrefix}([ \\t]*)${fenceCharacter}{${fence.length},}[ \\t]*\\r?(?=\\n|$)`,
      "g",
    );
    closingPattern.lastIndex = openingPattern.lastIndex;
    let closingMatch: RegExpExecArray | null = null;
    let closingCandidate: RegExpExecArray | null;
    const minimumClosingIndent = listContinuationIndent;
    const maximumClosingIndent = listContinuationIndent + 3;

    while ((closingCandidate = closingPattern.exec(text)) !== null) {
      const closingColumns = markdownColumnWidth(closingCandidate[2] ?? "");
      if (closingColumns >= minimumClosingIndent && closingColumns <= maximumClosingIndent) {
        closingMatch = closingCandidate;
        break;
      }
    }
    const containerBoundary = findMarkdownContainerBoundary(
      text,
      openingPattern.lastIndex,
      quotePrefix,
      quoteDepth,
      listContinuationIndent,
    );
    const boundaryPrecedesClosing =
      containerBoundary !== null &&
      (closingMatch === null || containerBoundary < closingMatch.index);
    const effectiveClosingMatch = boundaryPrecedesClosing ? null : closingMatch;
    const contentEnd = boundaryPrecedesClosing
      ? containerBoundary
      : (effectiveClosingMatch?.index ?? text.length);
    const content = text
      .slice(openingPattern.lastIndex, contentEnd)
      .replace(new RegExp(`(^|\\n)${quotePrefix}`, "g"), "$1");

    result += text.slice(cursor, openingMatch.index);
    result += linePrefix;
    result += protect(content);

    if (!effectiveClosingMatch) {
      cursor = contentEnd;
      if (containerBoundary === null) {
        break;
      }
      openingPattern.lastIndex = cursor;
      continue;
    }

    cursor = closingPattern.lastIndex;
    openingPattern.lastIndex = cursor;
  }

  return result + text.slice(cursor);
}

function protectMarkdownEscapes(text: string, protect: (content: string) => string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_match, punctuation: string) =>
    protect(punctuation),
  );
}

function protectMarkdownInlineCode(text: string, protect: (content: string) => string): string {
  const runs: Array<{ start: number; end: number; length: number }> = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }

    const start = index;
    while (text[index] === "`") {
      index += 1;
    }
    runs.push({ start, end: index, length: index - start });
  }

  const nextMatchingRun = Array.from<number | undefined>({ length: runs.length });
  const nextRunByLength = new Map<number, number>();

  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const run = runs[runIndex];
    if (!run) {
      continue;
    }
    nextMatchingRun[runIndex] = nextRunByLength.get(run.length);
    nextRunByLength.set(run.length, runIndex);
  }

  let result = "";
  let cursor = 0;
  let runIndex = 0;

  while (runIndex < runs.length) {
    const openingRun = runs[runIndex];
    const closingRunIndex = nextMatchingRun[runIndex];
    const closingRun = closingRunIndex === undefined ? undefined : runs[closingRunIndex];
    if (!openingRun || !closingRun) {
      runIndex += 1;
      continue;
    }

    result += text.slice(cursor, openingRun.start);
    result += protect(text.slice(openingRun.end, closingRun.start));
    cursor = closingRun.end;
    runIndex = closingRunIndex + 1;
  }

  return result + text.slice(cursor);
}

function protectMarkdownCode(text: string): {
  protectedText: string;
  restore: (value: string) => string;
} {
  const segments: string[] = [];
  const protect = (content: string): string => {
    const token = `${PROTECTED_CODE_START}${segments.length}${PROTECTED_CODE_END}`;
    segments.push(content);
    return token;
  };

  const protectedBlocks = protectMarkdownFencedBlocks(text, protect);
  const protectedEscapes = protectMarkdownEscapes(protectedBlocks, protect);
  const protectedText = protectMarkdownInlineCode(protectedEscapes, protect);

  return {
    protectedText,
    restore: (value) =>
      value.replace(
        new RegExp(`${PROTECTED_CODE_START}(\\d+)${PROTECTED_CODE_END}`, "g"),
        (_match, index: string) => segments[Number(index)] ?? "",
      ),
  };
}

function buildMatchingMarkdownDelimiters(
  text: string,
  openDelimiter: "[" | "(",
  closeDelimiter: "]" | ")",
): ReadonlyMap<number, number> {
  const openingIndexes: number[] = [];
  const matches = new Map<number, number>();

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === openDelimiter) {
      openingIndexes.push(index);
      continue;
    }
    if (character === closeDelimiter) {
      const openingIndex = openingIndexes.pop();
      if (openingIndex !== undefined) {
        matches.set(openingIndex, index);
      }
    }
  }

  return matches;
}

function normalizeMarkdownReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

const MARKDOWN_REFERENCE_DEFINITION_PATTERN =
  /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<[^<>\r\n]*>|[^\s<>]+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?[ \t]*$/gm;

function collectMarkdownReferenceLabels(text: string): ReadonlySet<string> {
  const labels = new Set<string>();

  for (const match of text.matchAll(MARKDOWN_REFERENCE_DEFINITION_PATTERN)) {
    const label = match[1];
    if (label) {
      labels.add(normalizeMarkdownReferenceLabel(label));
    }
  }
  return labels;
}

function removeMarkdownReferenceDefinitions(text: string): string {
  return text.replace(MARKDOWN_REFERENCE_DEFINITION_PATTERN, "");
}

function stripMarkdownLinks(text: string, referenceLabels: ReadonlySet<string>): string {
  const labelMatches = buildMatchingMarkdownDelimiters(text, "[", "]");
  const destinationMatches = buildMatchingMarkdownDelimiters(text, "(", ")");
  let result = "";
  let index = 0;

  while (index < text.length) {
    const isImage = text[index] === "!" && text[index + 1] === "[";
    const labelOpenIndex = isImage ? index + 1 : index;
    if (text[labelOpenIndex] !== "[") {
      result += text[index];
      index += 1;
      continue;
    }

    const labelCloseIndex = labelMatches.get(labelOpenIndex);
    if (labelCloseIndex === undefined) {
      result += text[index];
      index += 1;
      continue;
    }

    const destinationOpenIndex = labelCloseIndex + 1;
    if (text[destinationOpenIndex] === "(") {
      const destinationCloseIndex = destinationMatches.get(destinationOpenIndex);
      if (destinationCloseIndex === undefined) {
        result += text[index];
        index += 1;
        continue;
      }

      if (isImage) {
        result += " ";
      } else {
        result += text.slice(labelOpenIndex + 1, labelCloseIndex);
      }
      index = destinationCloseIndex + 1;
      continue;
    }

    const label = text.slice(labelOpenIndex + 1, labelCloseIndex);
    if (text[destinationOpenIndex] === "[") {
      const referenceCloseIndex = labelMatches.get(destinationOpenIndex);
      if (referenceCloseIndex === undefined) {
        result += text[index];
        index += 1;
        continue;
      }
      const explicitReference = text.slice(destinationOpenIndex + 1, referenceCloseIndex);
      const reference = explicitReference.length > 0 ? explicitReference : label;
      if (!referenceLabels.has(normalizeMarkdownReferenceLabel(reference))) {
        result += text[index];
        index += 1;
        continue;
      }

      result += isImage ? " " : label;
      index = referenceCloseIndex + 1;
      continue;
    }

    if (!referenceLabels.has(normalizeMarkdownReferenceLabel(label))) {
      result += text[index];
      index += 1;
      continue;
    }

    result += isImage ? " " : label;
    index = labelCloseIndex + 1;
  }

  return result;
}

// Reduce rich assistant output to readable notification context. Toasts and OS
// notifications should never expose Markdown syntax or turn into mini transcripts.
function summarizeAssistantText(text: string): string | null {
  const { protectedText, restore } = protectMarkdownCode(text);
  const referenceLabels = collectMarkdownReferenceLabels(protectedText);
  const withoutReferenceDefinitions = removeMarkdownReferenceDefinitions(protectedText);
  const cleaned = stripMarkdownLinks(withoutReferenceDefinitions, referenceLabels)
    .replace(/`+/g, "")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, "")
    .replace(/^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, " · ")
    .replace(/\*\*([^\s*\n](?:[^*\n]*[^\s*\n])?)\*\*/g, "$1")
    .replace(
      /(^|[^\p{L}\p{N}\p{M}_])__([^\s_\n](?:[^_\n]*[^\s_\n])?)__(?=$|[^\p{L}\p{N}\p{M}_])/gu,
      "$1$2",
    )
    .replace(/~~([^\s~\n](?:[^~\n]*[^\s~\n])?)~~/g, "$1")
    .replace(
      /(^|[^\p{L}\p{N}\p{M}_])\*([^\s*\n](?:[^*\n]*[^\s*\n])?)\*(?=$|[^\p{L}\p{N}\p{M}_])/gu,
      "$1$2",
    )
    .replace(
      /(^|[^\p{L}\p{N}\p{M}_])_([^\s_\n](?:[^_\n]*[^\s_\n])?)_(?=$|[^\p{L}\p{N}\p{M}_])/gu,
      "$1$2",
    );
  const trimmed = restore(cleaned).trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length <= NOTIFICATION_SUMMARY_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, NOTIFICATION_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

// Build a short body from the turn's *final* assistant message — the end-of-turn reply
// that lands after the work/compaction, not the opening preamble. Prefer the canonical
// `latestTurn.assistantMessageId`; if it's missing/empty, fall back to the last non-empty
// assistant message of that turn so we still surface the latest reply.
function summarizeLatestAssistantMessage(thread: Thread): string | null {
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  const finalAssistantMessageId = thread.latestTurn?.assistantMessageId ?? null;

  if (finalAssistantMessageId) {
    const finalMessage = thread.messages.find((message) => message.id === finalAssistantMessageId);
    if (finalMessage) {
      const summary = summarizeAssistantText(finalMessage.text);
      if (summary) {
        return summary;
      }
    }
  }

  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    // Stay within the just-completed turn so an earlier/other-turn preamble can't win.
    if (latestTurnId && message.turnId !== latestTurnId) {
      continue;
    }
    const summary = summarizeAssistantText(message.text);
    if (summary) {
      return summary;
    }
  }
  return null;
}

function hadUnsettledTurn(thread: Thread | undefined): boolean {
  if (!thread) {
    return false;
  }
  if (hasLiveLatestTurn(thread.latestTurn, thread.session)) {
    return true;
  }
  return !thread.latestTurn?.completedAt && isRunningStatus(thread.session?.status);
}

function isCompletionNotificationSettled(thread: Thread | undefined): boolean {
  if (!thread?.latestTurn?.startedAt || !thread.latestTurn.completedAt) {
    return false;
  }
  if (!thread.session) {
    return true;
  }
  return thread.session.orchestrationStatus !== "running";
}

// Compare consecutive snapshots and emit fresh settled completions, even if the
// session snapshot skips directly to ready before the toast logic observes it.
export function collectCompletedThreadCandidates(
  previousThreads: readonly Thread[],
  nextThreads: readonly Thread[],
): CompletedThreadCandidate[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread] as const));
  const candidates: CompletedThreadCandidate[] = [];

  for (const thread of nextThreads) {
    const previousThread = previousById.get(thread.id);
    if (!previousThread) {
      continue;
    }

    const completedAt = thread.latestTurn?.completedAt;
    if (!completedAt) {
      continue;
    }
    if (!isCompletionNotificationSettled(thread)) {
      continue;
    }
    if (!previousThread.session && !previousThread.latestTurn?.completedAt) {
      continue;
    }
    if (!hadUnsettledTurn(previousThread) && !previousThread.latestTurn?.completedAt) {
      continue;
    }
    if (
      previousThread.latestTurn?.turnId === thread.latestTurn?.turnId &&
      isCompletionNotificationSettled(previousThread)
    ) {
      continue;
    }

    candidates.push({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      completedAt,
      assistantSummary: summarizeLatestAssistantMessage(thread),
    });
  }

  return candidates;
}
function resolveTerminalNotificationState(
  threadState: TerminalNotificationThreadState | undefined,
  terminalId: string,
): TerminalVisualState {
  if (!threadState) {
    return "idle";
  }
  if (threadState.terminalAttentionStatesById?.[terminalId] === "attention") {
    return "attention";
  }
  if ((threadState.runningTerminalIds ?? []).includes(terminalId)) {
    return "running";
  }
  if (threadState.terminalAttentionStatesById?.[terminalId] === "review") {
    return "review";
  }
  return "idle";
}

function resolveTerminalNotificationTitle(
  threadState: TerminalNotificationThreadState | undefined,
  terminalId: string,
): { cliKind: TerminalCliKind | null; title: string } {
  const cliKind = threadState?.terminalCliKindsById?.[terminalId] ?? null;
  const title =
    threadState?.terminalTitleOverridesById?.[terminalId]?.trim() ||
    threadState?.terminalLabelsById?.[terminalId]?.trim() ||
    (cliKind ? defaultTerminalTitleForCliKind(cliKind) : "Terminal");
  return { cliKind, title };
}

export function collectCompletedTerminalCandidates(
  previousByThreadId: Record<string, TerminalNotificationThreadState>,
  nextByThreadId: Record<string, TerminalNotificationThreadState>,
): CompletedTerminalCandidate[] {
  const threadIds = new Set([...Object.keys(previousByThreadId), ...Object.keys(nextByThreadId)]);
  const candidates: CompletedTerminalCandidate[] = [];

  for (const threadId of threadIds) {
    const previousThreadState = previousByThreadId[threadId];
    const nextThreadState = nextByThreadId[threadId];
    const terminalIds = new Set([
      ...(previousThreadState?.terminalIds ?? []),
      ...(nextThreadState?.terminalIds ?? []),
    ]);

    for (const terminalId of terminalIds) {
      const previousState = resolveTerminalNotificationState(previousThreadState, terminalId);
      const nextState = resolveTerminalNotificationState(nextThreadState, terminalId);
      if (nextState !== "review" || previousState === "review") {
        continue;
      }
      const { cliKind, title } = resolveTerminalNotificationTitle(nextThreadState, terminalId);
      candidates.push({
        threadId: threadId as Thread["id"],
        terminalId,
        cliKind,
        title,
      });
    }
  }

  return candidates;
}

function approvalSummary(requestKind: "command" | "file-read" | "file-change"): string {
  switch (requestKind) {
    case "command":
      return "Command approval requested.";
    case "file-read":
      return "File-read approval requested.";
    case "file-change":
      return "File-change approval requested.";
  }
}

// Compare consecutive activity snapshots and emit only fresh input-needed transitions.
export function collectThreadAttentionCandidates(
  previousThreads: readonly Thread[],
  nextThreads: readonly Thread[],
): ThreadAttentionCandidate[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread] as const));
  const candidates: ThreadAttentionCandidate[] = [];

  for (const thread of nextThreads) {
    const previousThread = previousById.get(thread.id);
    if (!previousThread) {
      continue;
    }

    const previousApprovalIds = new Set(
      derivePendingApprovals(previousThread.activities, previousThread.pendingInteractions).map(
        (approval) => approval.requestId,
      ),
    );
    const previousUserInputIds = new Set(
      derivePendingUserInputs(previousThread.activities, previousThread.pendingInteractions).map(
        (request) => request.requestId,
      ),
    );

    for (const approval of derivePendingApprovals(thread.activities, thread.pendingInteractions)) {
      if (previousApprovalIds.has(approval.requestId)) {
        continue;
      }
      candidates.push({
        kind: "approval",
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        requestId: approval.requestId,
        createdAt: approval.createdAt,
        requestKind: approval.requestKind,
      });
    }

    for (const request of derivePendingUserInputs(thread.activities, thread.pendingInteractions)) {
      if (previousUserInputIds.has(request.requestId)) {
        continue;
      }
      candidates.push({
        kind: "user-input",
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        requestId: request.requestId,
        createdAt: request.createdAt,
      });
    }
  }

  return candidates.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function collectTerminalAttentionCandidates(
  previousByThreadId: Record<string, TerminalNotificationThreadState>,
  nextByThreadId: Record<string, TerminalNotificationThreadState>,
): TerminalAttentionCandidate[] {
  const threadIds = new Set([...Object.keys(previousByThreadId), ...Object.keys(nextByThreadId)]);
  const candidates: TerminalAttentionCandidate[] = [];

  for (const threadId of threadIds) {
    const previousThreadState = previousByThreadId[threadId];
    const nextThreadState = nextByThreadId[threadId];
    const terminalIds = new Set([
      ...(previousThreadState?.terminalIds ?? []),
      ...(nextThreadState?.terminalIds ?? []),
    ]);

    for (const terminalId of terminalIds) {
      const previousState = resolveTerminalNotificationState(previousThreadState, terminalId);
      const nextState = resolveTerminalNotificationState(nextThreadState, terminalId);
      if (nextState !== "attention" || previousState === "attention") {
        continue;
      }
      const { cliKind, title } = resolveTerminalNotificationTitle(nextThreadState, terminalId);
      candidates.push({
        threadId: threadId as Thread["id"],
        terminalId,
        cliKind,
        title,
      });
    }
  }

  return candidates;
}

// Keep toast and OS notification copy aligned across browser and desktop surfaces.
export function buildTaskCompletionCopy(candidate: CompletedThreadCandidate): {
  title: string;
  body: string;
} {
  const normalizedTitle = candidate.title.trim();
  const threadLabel = normalizedTitle.length > 0 ? normalizedTitle : "Untitled thread";

  return {
    title: threadLabel,
    body: candidate.assistantSummary || "Finished working.",
  };
}

export function buildThreadAttentionCopy(candidate: ThreadAttentionCandidate): {
  title: string;
  body: string;
} {
  const normalizedTitle = candidate.title.trim();
  const threadLabel = normalizedTitle.length > 0 ? normalizedTitle : "Untitled thread";
  const summary =
    candidate.summary ??
    (candidate.kind === "approval"
      ? approvalSummary(candidate.requestKind ?? "command")
      : "User input requested.");

  return {
    title: "Input needed",
    body: `${threadLabel}: ${summary}`,
  };
}

export function buildTerminalCompletionCopy(candidate: CompletedTerminalCandidate): {
  title: string;
  body: string;
} {
  const terminalLabel = candidate.title.trim() || "Terminal";
  return {
    title: "Terminal task completed",
    body: `${terminalLabel} finished working.`,
  };
}

export function buildTerminalAttentionCopy(candidate: TerminalAttentionCandidate): {
  title: string;
  body: string;
} {
  const terminalLabel = candidate.title.trim() || "Terminal";
  return {
    title: "Terminal input needed",
    body: `${terminalLabel} needs your attention.`,
  };
}

export const collectInputNeededThreadCandidates = collectThreadAttentionCandidates;

export const buildInputNeededCopy = buildThreadAttentionCopy;

// Hydration can replay old thread details after refresh; only timestamps after
// this notification runtime mounted should be treated as live events.
export function isNotificationRuntimeFreshTimestamp(
  candidateTimestamp: string,
  runtimeStartedAtMs: number,
): boolean {
  const candidateMs = Date.parse(candidateTimestamp);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(runtimeStartedAtMs)) {
    return true;
  }
  return candidateMs > runtimeStartedAtMs;
}
