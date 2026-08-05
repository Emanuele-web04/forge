// FILE: sidechatCreation.ts
// Purpose: Own the sidechat fork/start/snapshot lifecycle independently of composer state.
// Layer: Chat orchestration

import type {
  ModelSelection,
  NativeApi,
  OrchestrationShellSnapshot,
  ThreadId,
} from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";

import { newCommandId, newMessageId, newThreadId } from "./utils";
import { buildThreadHandoffImportedMessages } from "./threadHandoff";
import type { Project, Thread } from "../types";

const SIDECHAT_MISSING_GRACE_MS = 15_000;
type SidechatPaneRetention = { kind: "syncing" } | { kind: "grace"; untilMs: number };
const sidechatPaneRetentionByThreadId = new Map<ThreadId, SidechatPaneRetention>();
const sidechatPaneRetentionListeners = new Set<() => void>();
let sidechatPaneRetentionVersion = 0;

function emitSidechatPaneRetentionChange(): void {
  sidechatPaneRetentionVersion += 1;
  for (const listener of sidechatPaneRetentionListeners) {
    listener();
  }
}

function setSidechatPaneRetention(threadId: ThreadId, retention: SidechatPaneRetention): void {
  sidechatPaneRetentionByThreadId.set(threadId, retention);
  emitSidechatPaneRetentionChange();
}

export function subscribeSidechatPaneRetention(listener: () => void): () => void {
  sidechatPaneRetentionListeners.add(listener);
  return () => sidechatPaneRetentionListeners.delete(listener);
}

export function getSidechatPaneRetentionVersion(): number {
  return sidechatPaneRetentionVersion;
}

export interface SidechatCreationResult {
  threadId: ThreadId;
  promptError: unknown | null;
  snapshotError: unknown | null;
}

export interface SidechatCreationFlight {
  readonly creation: Promise<SidechatCreationResult>;
  readonly completion: Promise<true>;
  readonly submittedPrompts: Set<string>;
  promptTail: Promise<void>;
  creationSettled: boolean;
}

function scheduleSidechatFlightCleanup(
  inFlightBySourceThreadId: Map<ThreadId, SidechatCreationFlight>,
  sourceThreadId: ThreadId,
  flight: SidechatCreationFlight,
): void {
  const observedTail = flight.promptTail;
  void observedTail.then(
    () => {
      if (
        flight.creationSettled &&
        flight.promptTail === observedTail &&
        inFlightBySourceThreadId.get(sourceThreadId) === flight
      ) {
        inFlightBySourceThreadId.delete(sourceThreadId);
      }
    },
    () => {
      if (
        flight.creationSettled &&
        flight.promptTail === observedTail &&
        inFlightBySourceThreadId.get(sourceThreadId) === flight
      ) {
        inFlightBySourceThreadId.delete(sourceThreadId);
      }
    },
  );
}

export function createOrJoinSidechat(input: {
  inFlightBySourceThreadId: Map<ThreadId, SidechatCreationFlight>;
  sourceThreadId: ThreadId;
  initialPrompt?: string | undefined;
  startCreation: (initialPrompt?: string) => Promise<SidechatCreationResult>;
  sendQueuedPrompt: (threadId: ThreadId, prompt: string) => Promise<void>;
  onCreationResult: (result: SidechatCreationResult) => void;
  onQueuedPromptError: (error: unknown) => void;
}): Promise<true> {
  const prompt = input.initialPrompt?.trim() ?? "";
  const existing = input.inFlightBySourceThreadId.get(input.sourceThreadId);
  if (existing) {
    if (prompt.length === 0) {
      return existing.completion;
    }
    if (existing.submittedPrompts.has(prompt)) {
      return Promise.all([existing.completion, existing.promptTail]).then(() => true as const);
    }
    existing.submittedPrompts.add(prompt);
    existing.promptTail = existing.promptTail.then(async () => {
      const result = await existing.creation;
      try {
        await input.sendQueuedPrompt(result.threadId, prompt);
      } catch (error) {
        input.onQueuedPromptError(error);
      }
    });
    if (existing.creationSettled) {
      scheduleSidechatFlightCleanup(input.inFlightBySourceThreadId, input.sourceThreadId, existing);
    }
    return existing.promptTail.then(() => true as const);
  }

  const creation = input.startCreation(prompt.length > 0 ? prompt : undefined);
  const completion = creation.then((result) => {
    input.onCreationResult(result);
    return true as const;
  });
  const flight: SidechatCreationFlight = {
    creation,
    completion,
    submittedPrompts: new Set(prompt.length > 0 ? [prompt] : []),
    promptTail: Promise.resolve(),
    creationSettled: false,
  };
  input.inFlightBySourceThreadId.set(input.sourceThreadId, flight);
  void flight.completion.then(
    () => {
      flight.creationSettled = true;
      scheduleSidechatFlightCleanup(input.inFlightBySourceThreadId, input.sourceThreadId, flight);
    },
    () => {
      flight.creationSettled = true;
      scheduleSidechatFlightCleanup(input.inFlightBySourceThreadId, input.sourceThreadId, flight);
    },
  );
  return flight.completion;
}

// Null means the successful fork is still synchronizing and must not be pruned.
// Missing restored panes receive one bounded recheck window before removal.
export function sidechatPaneRetentionRemainingMs(
  threadId: ThreadId,
  nowMs = Date.now(),
): number | null {
  let retention = sidechatPaneRetentionByThreadId.get(threadId);
  if (!retention) {
    retention = { kind: "grace", untilMs: nowMs + SIDECHAT_MISSING_GRACE_MS };
    setSidechatPaneRetention(threadId, retention);
  }
  if (retention.kind === "syncing") {
    return null;
  }
  const remainingMs = retention.untilMs - nowMs;
  if (remainingMs <= 0) {
    clearSidechatPaneRetention(threadId);
    return 0;
  }
  return remainingMs;
}

function markSidechatSyncing(threadId: ThreadId): void {
  setSidechatPaneRetention(threadId, { kind: "syncing" });
}

function markSidechatSyncFailed(threadId: ThreadId): void {
  setSidechatPaneRetention(threadId, {
    kind: "grace",
    untilMs: Date.now() + SIDECHAT_MISSING_GRACE_MS,
  });
}

export function clearSidechatPaneRetention(threadId: ThreadId): void {
  if (sidechatPaneRetentionByThreadId.delete(threadId)) {
    emitSidechatPaneRetentionChange();
  }
}

export async function sendSidechatPrompt(input: {
  api: NativeApi;
  threadId: ThreadId;
  selectedModelSelection: ModelSelection;
  prompt: string;
}): Promise<void> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    return;
  }
  await input.api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: input.threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: prompt,
      attachments: [],
    },
    modelSelection: input.selectedModelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
}

export async function createSidechatThread(input: {
  api: NativeApi;
  project: Project;
  sourceThread: Thread;
  selectedModelSelection: ModelSelection;
  initialPrompt?: string | undefined;
  openSidechat: (threadId: ThreadId) => void;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
}): Promise<SidechatCreationResult> {
  const nextThreadId = newThreadId();
  const createdAt = new Date().toISOString();
  const initialPrompt = input.initialPrompt?.trim() ?? "";
  const titleSeed =
    initialPrompt.length > 0
      ? buildPromptThreadTitleFallback(initialPrompt)
      : input.sourceThread.title;

  await input.api.orchestration.dispatchCommand({
    type: "thread.fork.create",
    commandId: newCommandId(),
    threadId: nextThreadId,
    sourceThreadId: input.sourceThread.id,
    sidechatSourceThreadId: input.sourceThread.id,
    projectId: input.project.id,
    title: `Sidechat: ${titleSeed}`,
    modelSelection: input.selectedModelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: input.sourceThread.envMode ?? (input.sourceThread.worktreePath ? "worktree" : "local"),
    branch: input.sourceThread.branch,
    worktreePath: input.sourceThread.worktreePath,
    workingDirectory: input.sourceThread.workingDirectory ?? null,
    associatedWorktreePath: input.sourceThread.associatedWorktreePath ?? null,
    associatedWorktreeBranch: input.sourceThread.associatedWorktreeBranch ?? null,
    associatedWorktreeRef: input.sourceThread.associatedWorktreeRef ?? null,
    importedMessages: [...buildThreadHandoffImportedMessages(input.sourceThread)],
    createdAt,
  });

  // The fork now exists. Expose it immediately so a slow snapshot refresh cannot
  // leave a successful creation invisible and tempt the user into creating duplicates.
  markSidechatSyncing(nextThreadId);
  input.openSidechat(nextThreadId);

  // Start snapshot synchronization before an optional prompt. A slow/queued turn
  // must never prevent the successful fork from reaching the shell projection.
  const snapshotPromise = (async (): Promise<unknown | null> => {
    try {
      const snapshot = await input.api.orchestration.getShellSnapshot();
      input.syncServerShellSnapshot(snapshot);
      return null;
    } catch (error) {
      return error;
    }
  })();

  const promptPromise = (async (): Promise<unknown | null> => {
    try {
      await sendSidechatPrompt({
        api: input.api,
        threadId: nextThreadId,
        selectedModelSelection: input.selectedModelSelection,
        prompt: initialPrompt,
      });
      return null;
    } catch (error) {
      return error;
    }
  })();

  const [snapshotError, promptError] = await Promise.all([snapshotPromise, promptPromise]);
  if (snapshotError) {
    markSidechatSyncFailed(nextThreadId);
  } else {
    clearSidechatPaneRetention(nextThreadId);
  }

  return { threadId: nextThreadId, promptError, snapshotError };
}
