/**
 * Pure summarization helpers for agent gateway thread tools.
 *
 * Converts full orchestration read-model shapes into compact, token-friendly
 * summaries: a derived one-word thread status, shell summaries for
 * `synara_list_threads`, and truncated/paginated message views for
 * `synara_read_thread`. Kept pure so the shaping rules are unit-testable.
 *
 * @module agentGateway/threadSummary
 */
import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@synara/contracts";

export type AgentThreadStatus =
  | "working"
  | "idle"
  | "waiting-for-approval"
  | "waiting-for-user-input"
  | "interrupted"
  | "error";

/**
 * Collapse session/turn/pending projections into one status an agent can act
 * on. Pending gates win over turn state: a thread blocked on approval is not
 * "working" even though its turn is still running.
 */
export function deriveAgentThreadStatus(thread: {
  readonly session: OrchestrationThreadShell["session"];
  readonly latestTurn: OrchestrationThreadShell["latestTurn"];
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
}): AgentThreadStatus {
  if (thread.hasPendingApprovals) return "waiting-for-approval";
  if (thread.hasPendingUserInput) return "waiting-for-user-input";
  const sessionStatus = thread.session?.status;
  const turnState = thread.latestTurn?.state;
  if (turnState === "running" || sessionStatus === "running" || sessionStatus === "starting") {
    return "working";
  }
  if (turnState === "error" || sessionStatus === "error") return "error";
  if (turnState === "interrupted") return "interrupted";
  return "idle";
}

export interface AgentThreadListItem {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly status: AgentThreadStatus;
  readonly parentThreadId: string | null;
  readonly creationSource: string | null;
  readonly envMode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly archived: boolean;
  readonly isSelf: boolean;
  readonly updatedAt: string;
}

export function summarizeThreadShell(
  thread: OrchestrationThreadShell,
  callerThreadId: string,
): AgentThreadListItem {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    provider: thread.modelSelection.provider,
    model: thread.modelSelection.model,
    status: deriveAgentThreadStatus(thread),
    parentThreadId: thread.parentThreadId ?? null,
    creationSource: thread.creationSource ?? null,
    envMode: thread.envMode ?? "local",
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    archived: (thread.archivedAt ?? null) !== null,
    isSelf: thread.id === callerThreadId,
    updatedAt: thread.updatedAt,
  };
}

export const READ_THREAD_DEFAULT_MESSAGE_LIMIT = 20;
export const READ_THREAD_MAX_MESSAGE_LIMIT = 100;
export const READ_THREAD_DEFAULT_MESSAGE_CHARS = 1500;
export const READ_THREAD_MAX_MESSAGE_CHARS = 20_000;
export const WAIT_THREAD_SUMMARY_MAX_CHARS = 2_000;

export interface AgentThreadMessageSummary {
  readonly index: number;
  readonly role: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly dispatchOrigin?: string;
  readonly createdAt: string;
}

export interface AgentThreadSingleMessagePage {
  readonly index: number;
  readonly offsetChars: number;
  readonly endOffsetChars: number;
  readonly totalChars: number;
  readonly nextOffsetChars?: number;
}

export interface AgentThreadMessagePage {
  readonly messages: ReadonlyArray<AgentThreadMessageSummary>;
  readonly totalMessages: number;
  readonly effectiveMessageLimit: number;
  readonly effectiveMaxMessageChars: number;
  /** Pass back as `cursor` to fetch the next (older) page; absent when done. */
  readonly nextCursor?: string;
  readonly messagePage?: AgentThreadSingleMessagePage;
}

function truncateMessageText(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n[... truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return Math.max(minimum, Math.min(Math.trunc(value ?? fallback), maximum));
}

function summarizeMessage(
  message: OrchestrationMessage,
  index: number,
  text: string,
  truncated: boolean,
): AgentThreadMessageSummary {
  return {
    index,
    role: message.role,
    text,
    truncated,
    ...(message.dispatchOrigin !== undefined ? { dispatchOrigin: message.dispatchOrigin } : {}),
    createdAt: message.createdAt,
  };
}

function assertMessageCoordinates(input: {
  readonly cursor?: string | undefined;
  readonly messageIndex?: number | undefined;
  readonly messageOffsetChars?: number | undefined;
  readonly totalMessages: number;
}): void {
  if (input.messageIndex === undefined) {
    if (input.messageOffsetChars !== undefined) {
      throw new Error('"messageOffsetChars" requires "messageIndex".');
    }
    return;
  }
  if (input.cursor !== undefined) {
    throw new Error('"cursor" cannot be combined with "messageIndex".');
  }
  if (!Number.isInteger(input.messageIndex) || input.messageIndex < 0) {
    throw new Error('"messageIndex" must be a non-negative integer.');
  }
  if (input.messageIndex >= input.totalMessages) {
    throw new Error(
      `Message index ${input.messageIndex} is no longer available (thread currently has ${input.totalMessages} messages). Re-read the thread before continuing.`,
    );
  }
  if (
    input.messageOffsetChars !== undefined &&
    (!Number.isInteger(input.messageOffsetChars) || input.messageOffsetChars < 0)
  ) {
    throw new Error('"messageOffsetChars" must be a non-negative integer.');
  }
}

function paginateSingleMessage(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly messageIndex: number;
  readonly messageOffsetChars: number;
  readonly maxChars: number;
}): AgentThreadMessagePage {
  const message = input.messages[input.messageIndex]!;
  const totalChars = message.text.length;
  if (input.messageOffsetChars > 0 && input.messageOffsetChars >= totalChars) {
    throw new Error(
      `Message offset ${input.messageOffsetChars} is no longer valid for message ${input.messageIndex} (current length ${totalChars}). Re-read the message from offset 0.`,
    );
  }
  const endOffsetChars = Math.min(input.messageOffsetChars + input.maxChars, totalChars);
  const nextOffsetChars = endOffsetChars < totalChars ? endOffsetChars : undefined;
  return {
    messages: [
      summarizeMessage(
        message,
        input.messageIndex,
        message.text.slice(input.messageOffsetChars, endOffsetChars),
        nextOffsetChars !== undefined,
      ),
    ],
    totalMessages: input.messages.length,
    effectiveMessageLimit: 1,
    effectiveMaxMessageChars: input.maxChars,
    messagePage: {
      index: input.messageIndex,
      offsetChars: input.messageOffsetChars,
      endOffsetChars,
      totalChars,
      ...(nextOffsetChars !== undefined ? { nextOffsetChars } : {}),
    },
  };
}

export function summarizeWaitThreadText(text: string | null | undefined): {
  readonly summary: string | null;
  readonly truncated: boolean;
} {
  if (text === null || text === undefined) return { summary: null, truncated: false };
  if (text.length <= WAIT_THREAD_SUMMARY_MAX_CHARS) {
    return { summary: text, truncated: false };
  }
  let retainedChars = WAIT_THREAD_SUMMARY_MAX_CHARS;
  let marker = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    marker = `\n[... truncated ${text.length - retainedChars} chars]`;
    retainedChars = Math.max(0, WAIT_THREAD_SUMMARY_MAX_CHARS - marker.length);
  }
  marker = `\n[... truncated ${text.length - retainedChars} chars]`;
  return {
    summary: `${text.slice(0, retainedChars)}${marker}`,
    truncated: true,
  };
}

/**
 * Page a thread's messages newest-first. `cursor` is the opaque value returned
 * by the previous page; the first call omits it and gets the tail of the
 * transcript. Message indexes are stable positions in the full transcript so
 * agents can reason about ordering across pages.
 */
export function paginateThreadMessages(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly cursor?: string | undefined;
  readonly messageLimit?: number | undefined;
  readonly maxMessageChars?: number | undefined;
  readonly messageIndex?: number | undefined;
  readonly messageOffsetChars?: number | undefined;
}): AgentThreadMessagePage {
  const limit = boundedInteger(
    input.messageLimit,
    READ_THREAD_DEFAULT_MESSAGE_LIMIT,
    1,
    READ_THREAD_MAX_MESSAGE_LIMIT,
  );
  const maxChars = boundedInteger(
    input.maxMessageChars,
    READ_THREAD_DEFAULT_MESSAGE_CHARS,
    50,
    READ_THREAD_MAX_MESSAGE_CHARS,
  );
  const total = input.messages.length;
  assertMessageCoordinates({
    cursor: input.cursor,
    messageIndex: input.messageIndex,
    messageOffsetChars: input.messageOffsetChars,
    totalMessages: total,
  });
  if (input.messageIndex !== undefined) {
    return paginateSingleMessage({
      messages: input.messages,
      messageIndex: input.messageIndex,
      messageOffsetChars: input.messageOffsetChars ?? 0,
      maxChars,
    });
  }
  // endExclusive is the transcript index right after the newest message of
  // this page; the cursor carries the start of the previous (newer) page.
  let endExclusive = total;
  if (input.cursor !== undefined) {
    const parsed = Number.parseInt(input.cursor, 10);
    if (Number.isFinite(parsed)) {
      endExclusive = Math.max(0, Math.min(parsed, total));
    }
  }
  const startInclusive = Math.max(0, endExclusive - limit);
  const messages = input.messages.slice(startInclusive, endExclusive).map((message, offset) => {
    const { text, truncated } = truncateMessageText(message.text, maxChars);
    return summarizeMessage(message, startInclusive + offset, text, truncated);
  });
  return {
    messages,
    totalMessages: total,
    effectiveMessageLimit: limit,
    effectiveMaxMessageChars: maxChars,
    ...(startInclusive > 0 ? { nextCursor: String(startInclusive) } : {}),
  };
}

export interface AgentThreadDetail {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string | null;
  readonly provider: string;
  readonly model: string;
  readonly status: AgentThreadStatus;
  readonly sessionStatus: string | null;
  readonly latestTurnState: string | null;
  readonly parentThreadId: string | null;
  readonly creationSource: string | null;
  readonly envMode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly archived: boolean;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AgentThreadMessageSummary>;
  readonly totalMessages: number;
  readonly effectiveMessageLimit: number;
  readonly effectiveMaxMessageChars: number;
  readonly nextCursor?: string;
  readonly messagePage?: AgentThreadSingleMessagePage;
}

export function summarizeThreadDetail(input: {
  readonly thread: OrchestrationThread;
  readonly cursor?: string | undefined;
  readonly messageLimit?: number | undefined;
  readonly maxMessageChars?: number | undefined;
  readonly messageIndex?: number | undefined;
  readonly messageOffsetChars?: number | undefined;
}): AgentThreadDetail {
  const { thread } = input;
  const page = paginateThreadMessages({
    messages: thread.messages,
    cursor: input.cursor,
    messageLimit: input.messageLimit,
    maxMessageChars: input.maxMessageChars,
    messageIndex: input.messageIndex,
    messageOffsetChars: input.messageOffsetChars,
  });
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    goal: thread.goal?.trim() || null,
    provider: thread.modelSelection.provider,
    model: thread.modelSelection.model,
    status: deriveAgentThreadStatus(thread),
    sessionStatus: thread.session?.status ?? null,
    latestTurnState: thread.latestTurn?.state ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    creationSource: thread.creationSource ?? null,
    envMode: thread.envMode ?? "local",
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    archived: (thread.archivedAt ?? null) !== null,
    lastError: thread.session?.lastError ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: page.messages,
    totalMessages: page.totalMessages,
    effectiveMessageLimit: page.effectiveMessageLimit,
    effectiveMaxMessageChars: page.effectiveMaxMessageChars,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    ...(page.messagePage !== undefined ? { messagePage: page.messagePage } : {}),
  };
}
