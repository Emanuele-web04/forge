import type { OrchestrationMessage, OrchestrationThread } from "@synara/contracts";

const RECENT_MESSAGE_COUNT = 6;
const EARLIER_MESSAGE_CHAR_LIMIT = 320;
const RECENT_MESSAGE_CHAR_LIMIT = 2_400;
// Hard ceiling for any bootstrap transcript: it replays as one uncached user
// message, so long threads must drop their oldest summaries rather than grow.
const BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET = 32_000;

function normalizeMessageText(value: string): string {
  return value
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function roleLabel(message: Pick<OrchestrationMessage, "role">): "User" | "Assistant" {
  return message.role === "assistant" ? "Assistant" : "User";
}

function earlierSummaryHeader(omittedCount: number): string {
  return omittedCount > 0
    ? `Earlier conversation summary (${omittedCount} older ${
        omittedCount === 1 ? "message" : "messages"
      } omitted to fit the context budget):`
    : "Earlier conversation summary:";
}

export function listImportedHandoffMessages(
  thread: Pick<OrchestrationThread, "messages">,
): ReadonlyArray<OrchestrationMessage> {
  return thread.messages.filter(
    (message) =>
      message.source === "handoff-import" &&
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false,
  );
}

export function listImportedForkMessages(
  thread: Pick<OrchestrationThread, "messages">,
): ReadonlyArray<OrchestrationMessage> {
  return thread.messages.filter(
    (message) =>
      message.source === "fork-import" &&
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false,
  );
}

export function hasNativeHandoffMessages(thread: Pick<OrchestrationThread, "messages">): boolean {
  return thread.messages.some(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.source === "native" &&
      message.streaming === false,
  );
}

export function hasNativeAssistantMessagesBefore(
  thread: Pick<OrchestrationThread, "messages">,
  currentMessageId?: string,
): boolean {
  const currentIndex =
    currentMessageId === undefined
      ? thread.messages.length
      : thread.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex <= 0) {
    return false;
  }
  return thread.messages.slice(0, currentIndex).some((message) => {
    return (
      message.role === "assistant" && message.source === "native" && message.streaming === false
    );
  });
}

export function listPriorTranscriptMessages(
  thread: Pick<OrchestrationThread, "messages">,
  currentMessageId?: string,
): ReadonlyArray<OrchestrationMessage> {
  const currentIndex =
    currentMessageId === undefined
      ? thread.messages.length
      : thread.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex <= 0) {
    return [];
  }

  return thread.messages.slice(0, currentIndex).filter((message) => {
    return (
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false &&
      normalizeMessageText(message.text).length > 0
    );
  });
}

function buildImportedMessagesBootstrapText(input: {
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath">;
  importedMessages: ReadonlyArray<OrchestrationMessage>;
  intro: string;
  maxChars: number;
}): string | null {
  if (input.importedMessages.length === 0) {
    return null;
  }

  const maxChars = Math.min(Math.max(0, input.maxChars), BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET);
  const earlierMessages = input.importedMessages.slice(0, -RECENT_MESSAGE_COUNT);
  const recentMessages = input.importedMessages.slice(-RECENT_MESSAGE_COUNT);
  const sections: string[] = [input.intro, `Original conversation title: ${input.thread.title}`];

  if (input.thread.branch) {
    sections.push(`Git branch: ${input.thread.branch}`);
  }
  if (input.thread.worktreePath) {
    sections.push(`Worktree path: ${input.thread.worktreePath}`);
  }

  const recentSection =
    "Most recent imported messages:\n" +
    recentMessages
      .map((message) => {
        const normalized = truncateText(
          normalizeMessageText(message.text),
          RECENT_MESSAGE_CHAR_LIMIT,
        );
        return `${roleLabel(message)}:\n${normalized}`;
      })
      .join("\n\n");

  if (earlierMessages.length > 0) {
    // Keep the newest earlier-message summaries that fit the remaining budget;
    // older ones are dropped so long threads cannot inflate the bootstrap.
    let remaining =
      maxChars -
      sections.reduce((total, section) => total + section.length + 2, 0) -
      (recentSection.length + 2);
    // Reserve space for the omission header up front so accepted summary
    // lines can never push the assembled section past `remaining`. The
    // header only shrinks as more lines are accepted (omittedCount falls
    // monotonically from earlierMessages.length toward 0, and shorter/no
    // counts never produce a longer header), so sizing the reservation off
    // the largest possible omitted count is a true worst-case bound, not
    // just a conservative guess. The extra `+ 1` covers the "\n" that joins
    // the header to the summary lines when at least one line is kept.
    remaining -= earlierSummaryHeader(earlierMessages.length).length + 1;
    const summaryLines: string[] = [];
    for (let index = earlierMessages.length - 1; index >= 0; index -= 1) {
      const message = earlierMessages[index]!;
      const normalized = truncateText(
        normalizeMessageText(message.text),
        EARLIER_MESSAGE_CHAR_LIMIT,
      );
      const line = `- ${roleLabel(message)}: ${normalized}`;
      if (remaining < line.length + 1) {
        break;
      }
      remaining -= line.length + 1;
      summaryLines.push(line);
    }
    summaryLines.reverse();
    const omittedCount = earlierMessages.length - summaryLines.length;
    const header = earlierSummaryHeader(omittedCount);
    sections.push(summaryLines.length > 0 ? `${header}\n${summaryLines.join("\n")}` : header);
  }

  sections.push(recentSection);

  const joined = sections.join("\n\n").trim();
  return truncateText(joined, maxChars);
}

export function buildHandoffBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "handoff" | "messages">,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): string | null {
  const importedMessages = listImportedHandoffMessages(thread);
  if (importedMessages.length === 0 || thread.handoff === null) {
    return null;
  }

  return buildImportedMessagesBootstrapText({
    thread,
    importedMessages,
    intro: `This conversation was handed off from ${thread.handoff.sourceProvider}.`,
    maxChars,
  });
}

export function buildPriorTranscriptBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  currentMessageId: string | undefined,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): string | null {
  const priorMessages = listPriorTranscriptMessages(thread, currentMessageId);
  if (priorMessages.length === 0) {
    return null;
  }

  return buildImportedMessagesBootstrapText({
    thread,
    importedMessages: priorMessages,
    intro:
      "This provider session may have been restarted without native conversation state. Use this prior Synara transcript as context for the latest user message.",
    maxChars,
  });
}

export function buildForkBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): string | null {
  const importedMessages = listImportedForkMessages(thread);
  if (importedMessages.length === 0) {
    return null;
  }

  return buildImportedMessagesBootstrapText({
    thread,
    importedMessages,
    intro: "This sidechat was cloned from an earlier conversation.",
    maxChars,
  });
}
