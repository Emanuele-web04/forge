// FILE: chatThreads.ts
// Purpose: Shared chat-thread title helpers used by web and server flows.
// Layer: Shared util
// Exports: generic title checks plus fallback/generated title sanitizers

export const GENERIC_CHAT_THREAD_TITLE = "New thread";
const MAX_CHAT_THREAD_TITLE_LENGTH = 60;
export const THREAD_TITLE_CONTEXT_MAX_CHARS = 8_000;
export const THREAD_TITLE_CONTEXT_MAX_MESSAGES = 12;
const THREAD_TITLE_CONTEXT_MESSAGE_MAX_CHARS = 1_200;
const GENERIC_GENERATED_THREAD_TITLES = new Set([
  "chat",
  "conversation",
  "new chat",
  "new conversation",
  "new session",
  GENERIC_CHAT_THREAD_TITLE.toLowerCase(),
  "session",
  "thread",
  "untitled",
]);
// Single source for the title word cap. Exported so the server-side title prompt
// (textGenerationShared.buildThreadTitlePrompt) derives its wording and fallback
// limits from the same number the sanitizers enforce here.
export const MAX_CHAT_THREAD_TITLE_WORDS = 6;

function normalizeTitleWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimTitleToken(token: string): string {
  return token.replace(/^[\s"'`([{]+|[\s"'`)\]}:;,.!?]+$/g, "");
}

function titleWords(value: string): string[] {
  return normalizeTitleWhitespace(value)
    .split(" ")
    .map(trimTitleToken)
    .filter((token) => token.length > 0);
}

function removeReasoningWrappers(value: string): string {
  const withoutClosedWrappers = value.replace(
    /<(?:analysis|reasoning|think)>[\s\S]*?<\/(?:analysis|reasoning|think)>/gi,
    "",
  );
  return withoutClosedWrappers.replace(/<(?:analysis|reasoning|think)>[\s\S]*$/gi, "");
}

function firstGeneratedTitleLine(value: string): string {
  const lines = removeReasoningWrappers(value)
    .split(/\r?\n/)
    .map((line) => line.trim());
  return lines.find((line) => line.length > 0 && !/^```/.test(line)) ?? "";
}

function truncateConversationMessage(value: string): string {
  const normalized = normalizeTitleWhitespace(value);
  if (normalized.length <= THREAD_TITLE_CONTEXT_MESSAGE_MAX_CHARS) {
    return normalized;
  }
  const headLength = Math.floor((THREAD_TITLE_CONTEXT_MESSAGE_MAX_CHARS - 3) * 0.6);
  const tailLength = THREAD_TITLE_CONTEXT_MESSAGE_MAX_CHARS - headLength - 3;
  return `${normalized.slice(0, headLength)}...${normalized.slice(-tailLength)}`;
}

type ThreadTitleConversationAttachment =
  | {
      readonly type: "image" | "file";
      readonly name: string;
    }
  | {
      readonly type: "assistant-selection";
      readonly text: string;
    };

function formatConversationAttachment(attachment: ThreadTitleConversationAttachment): string {
  if (attachment.type === "assistant-selection") {
    const selection = normalizeTitleWhitespace(attachment.text);
    return selection.length > 0 ? `[assistant selection: ${selection}]` : "[assistant selection]";
  }
  const name = normalizeTitleWhitespace(attachment.name);
  return name.length > 0 ? `[${attachment.type}: ${name}]` : `[${attachment.type}]`;
}

function threadTitleConversationMessageText(message: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<ThreadTitleConversationAttachment> | undefined;
}): string {
  return [
    normalizeTitleWhitespace(message.text),
    ...(message.attachments ?? []).map(formatConversationAttachment),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

export function buildThreadTitleConversationContext(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments?: ReadonlyArray<ThreadTitleConversationAttachment> | undefined;
    readonly streaming?: boolean | undefined;
  }>,
): string | null {
  const eligible = messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.streaming !== true &&
      threadTitleConversationMessageText(message).length > 0,
  );
  const latestUserIndex = eligible.findLastIndex((message) => message.role === "user");
  if (latestUserIndex < 0) {
    return null;
  }
  const tail = eligible.slice(-(THREAD_TITLE_CONTEXT_MAX_MESSAGES - 1));
  const candidates = tail.some((message) => message.role === "user")
    ? eligible.slice(-THREAD_TITLE_CONTEXT_MAX_MESSAGES)
    : [eligible[latestUserIndex]!, ...tail];

  const candidateLines = candidates.map(
    (message) =>
      `${message.role === "user" ? "User" : "Assistant"}: ${truncateConversationMessage(threadTitleConversationMessageText(message))}`,
  );
  const requiredUserIndex = candidates.findLastIndex((message) => message.role === "user");
  const selectedIndexes = new Set([requiredUserIndex]);
  let contextLength = candidateLines[requiredUserIndex]!.length;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (index === requiredUserIndex) continue;
    const line = candidateLines[index]!;
    const nextLength = contextLength + line.length + 1;
    if (nextLength > THREAD_TITLE_CONTEXT_MAX_CHARS) {
      continue;
    }
    selectedIndexes.add(index);
    contextLength = nextLength;
  }
  return candidateLines.filter((_, index) => selectedIndexes.has(index)).join("\n");
}

export function truncateChatThreadTitle(
  text: string,
  maxLength = MAX_CHAT_THREAD_TITLE_LENGTH,
): string {
  const trimmed = normalizeTitleWhitespace(text);
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

// Build a short deterministic title while the model-generated rename is pending.
export function buildPromptThreadTitleFallback(message: string): string {
  const words = titleWords(message).slice(0, MAX_CHAT_THREAD_TITLE_WORDS);
  if (words.length === 0) {
    return GENERIC_CHAT_THREAD_TITLE;
  }
  return truncateChatThreadTitle(words.join(" "));
}

// Keep generated titles compact so the sidebar never renders sentence-length prompts.
export function sanitizeGeneratedThreadTitle(raw: string): string {
  const unquoted = firstGeneratedTitleLine(raw).replace(/^['"`]+|['"`]+$/g, "");
  const words = titleWords(unquoted).slice(0, MAX_CHAT_THREAD_TITLE_WORDS);
  if (words.length === 0) {
    return GENERIC_CHAT_THREAD_TITLE;
  }
  return truncateChatThreadTitle(words.join(" "));
}

export function isUsableGeneratedThreadTitle(title: string | null | undefined): boolean {
  const normalized = normalizeTitleWhitespace(title ?? "").toLowerCase();
  return normalized.length > 0 && !GENERIC_GENERATED_THREAD_TITLES.has(normalized);
}

export function isGenericChatThreadTitle(title: string | null | undefined): boolean {
  return normalizeTitleWhitespace(title ?? "") === GENERIC_CHAT_THREAD_TITLE;
}
