// FILE: kanbanDispatch.ts
// Purpose: Sends a kanban Draft card to In Progress — promotes local draft threads when
//          needed and dispatches the drafted prompt as a queued turn.
// Layer: Web orchestration helper
// Exports: dispatchKanbanDraftCard, dispatchKanbanDraftThread, KanbanDraftDispatchResult

import type {
  AssistantDeliveryMode,
  ProjectId,
  ProviderKind,
  ProviderStartOptions,
  ThreadEnvironmentMode,
  ThreadId,
} from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { isPendingThreadWorktree } from "@synara/shared/threadEnvironment";
import {
  buildKanbanComposerDraftSnapshot,
  resolveKanbanDraftOpenThreadReason,
  resolveDraftDropAction,
  type KanbanCard,
  type KanbanDraftOpenThreadReason,
} from "../components/kanban/kanban.logic";
import {
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useKanbanUiStore } from "../kanbanUiStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import type { SidebarThreadSummary } from "../types";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { appendAssistantSelectionsToPrompt } from "./assistantSelections";
import {
  appendBrowserAnnotationsToPrompt,
  formatBrowserAnnotationLabel,
} from "./browserAnnotations";
import {
  stageUploadComposerAttachments,
  formatOutgoingComposerPrompt,
  resolvePromptEffortFromModelSelection,
} from "./composerSend";
import { appendFileCommentsToPrompt, formatFileCommentTitleSeed } from "./fileComments";
import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
} from "./composerMentions";
import {
  appendTerminalContextsToPrompt,
  filterTerminalContextsWithText,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
} from "./terminalContext";
import { resolveTerminalThreadCreationState } from "./threadBootstrap";
import { promoteThreadCreate } from "./threadCreatePromotion";
import { newCommandId, newMessageId } from "./utils";

export type KanbanDraftDispatchResult =
  /** The drafted prompt is on its way; runtime events move the card to In Progress. */
  | { kind: "dispatched"; warning?: string | undefined }
  /** The board cannot dispatch this card faithfully — open the chat instead. */
  | { kind: "open-thread"; reason: KanbanDraftOpenThreadReason }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export function kanbanDispatchFailureToast(
  result: Exclude<KanbanDraftDispatchResult, { kind: "dispatched" }>,
  errorTitle: string,
): { type: "info" | "error"; title: string; description: string } {
  if (result.kind === "open-thread") {
    return {
      type: "info",
      title: "Finish this draft in the chat",
      description:
        result.reason === "empty"
          ? "Nothing to send yet. Write the prompt in the composer."
          : result.reason === "worktree-pending"
            ? "Open the chat to create the worktree with the normal send flow."
            : "Open the chat to continue this task.",
    };
  }
  if (result.kind === "unavailable") {
    return {
      type: "error",
      title: "Not connected",
      description: "Reconnect to the server before sending drafts.",
    };
  }
  return { type: "error", title: errorTitle, description: result.message };
}

export async function dispatchKanbanDraftCard(input: {
  card: KanbanCard;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
}): Promise<KanbanDraftDispatchResult> {
  const { card } = input;
  if (resolveDraftDropAction(card) !== "dispatch") {
    return {
      kind: "open-thread",
      reason: resolveKanbanDraftOpenThreadReason(card) ?? "not-draft",
    };
  }
  return dispatchKanbanDraftThread({
    threadId: card.threadId,
    projectId: card.projectId,
    thread: card.thread,
    defaultProvider: input.defaultProvider,
    assistantDeliveryMode: input.assistantDeliveryMode,
    providerOptions: input.providerOptions,
  });
}

/** Right-click "Send as goal" for a dispatchable draft card. */
export async function dispatchKanbanDraftCardAsGoal(input: {
  card: KanbanCard;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
}): Promise<KanbanDraftDispatchResult> {
  const { card } = input;
  if (resolveDraftDropAction(card) !== "dispatch") {
    return {
      kind: "open-thread",
      reason: resolveKanbanDraftOpenThreadReason(card) ?? "not-draft",
    };
  }
  return dispatchKanbanDraftThreadAsGoal({
    threadId: card.threadId,
    projectId: card.projectId,
    thread: card.thread,
    defaultProvider: input.defaultProvider,
    assistantDeliveryMode: input.assistantDeliveryMode,
    providerOptions: input.providerOptions,
  });
}

interface KanbanDraftDispatchInput {
  threadId: ThreadId;
  projectId: ProjectId;
  /** Backing summary; null for local-only draft threads not yet promoted. */
  thread: SidebarThreadSummary | null;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
}

const MAX_KANBAN_GOAL_LENGTH = 4096;

// Racing callers (a re-drop before the board re-derives, drag + send-now, or a
// drag racing a right-click "Send as goal") must not queue two turns for the
// same thread — the server accepts duplicate thread.turn.start commands while
// the session is still starting. Same pattern as threadCreatePromotion's
// inFlightThreadCreateById. The guard is keyed by threadId alone so a
// concurrent dispatch and "Send as goal" coalesce onto the first turn instead
// of racing past each other on mode-specific keys.
const inFlightDispatchByThreadId = new Map<string, Promise<KanbanDraftDispatchResult>>();

function dispatchKanbanDraftThreadInternal(
  input: KanbanDraftDispatchInput,
  mode: "dispatch" | "goal",
): Promise<KanbanDraftDispatchResult> {
  const existing = inFlightDispatchByThreadId.get(input.threadId);
  if (existing) {
    return existing;
  }
  const dispatchPromise = dispatchKanbanDraftThreadOnce(input, mode).finally(() => {
    inFlightDispatchByThreadId.delete(input.threadId);
  });
  inFlightDispatchByThreadId.set(input.threadId, dispatchPromise);
  return dispatchPromise;
}

/**
 * Promote (when needed) and dispatch a draft thread's composer prompt as a queued
 * turn. Shared by the board's drag-to-In-Progress drop and the new-task dialog's
 * "send now" path, so both routes stay byte-for-byte consistent. Reads the live
 * composer draft by id, so callers only pass identity + dispatch preferences.
 * Concurrent calls for the same thread coalesce onto the first dispatch.
 */
export function dispatchKanbanDraftThread(
  input: KanbanDraftDispatchInput,
): Promise<KanbanDraftDispatchResult> {
  return dispatchKanbanDraftThreadInternal(input, "dispatch");
}

/**
 * Promote a local-only draft (when needed), set the thread's goal from the live
 * composer prompt, then queue the turn. Dispatches `thread.meta.update` with
 * `goalStartBehavior: "defer"` before `thread.turn.start`; if the goal update
 * fails the turn still starts and a warning is surfaced.
 */
export function dispatchKanbanDraftThreadAsGoal(
  input: KanbanDraftDispatchInput,
): Promise<KanbanDraftDispatchResult> {
  return dispatchKanbanDraftThreadInternal(input, "goal");
}

async function dispatchKanbanDraftThreadOnce(
  input: KanbanDraftDispatchInput,
  mode: "dispatch" | "goal",
): Promise<KanbanDraftDispatchResult> {
  const { threadId, projectId, thread } = input;
  const api = readNativeApi();
  if (!api) {
    return { kind: "unavailable" };
  }

  // Re-read the composer at drop time: the card snapshot may lag behind edits made
  // in an open chat, and a stale prompt must never be dispatched.
  const composerStore = useComposerDraftStore.getState();
  const draftComposerState = composerStore.draftsByThreadId[threadId] ?? null;
  const liveSnapshot = buildKanbanComposerDraftSnapshot(draftComposerState);
  const prompt = liveSnapshot?.prompt.trim() ?? "";
  if (prompt.length === 0 && liveSnapshot?.hasAttachments !== true) {
    return { kind: "open-thread", reason: "empty" };
  }

  const appState = useStore.getState();
  const project = appState.projects.find((candidate) => candidate.id === projectId) ?? null;
  const existingThread = thread ? getThreadFromState(appState, threadId) : null;
  const modelSelection = resolvePreferredComposerModelSelection({
    draft: draftComposerState,
    threadModelSelection: thread?.modelSelection ?? null,
    projectModelSelection: project?.defaultModelSelection ?? null,
    defaultProvider: input.defaultProvider,
  });
  const draftThread = composerStore.getDraftThread(threadId);
  // Worktree creation is owned by the full chat composer path. Kanban stays a
  // control surface and opens chat when a draft still needs that preflight.
  const dispatchEnvironment = {
    envMode: (thread?.envMode ??
      existingThread?.envMode ??
      draftThread?.envMode ??
      null) as ThreadEnvironmentMode | null,
    worktreePath: thread?.worktreePath ?? existingThread?.worktreePath ?? draftThread?.worktreePath,
  };
  if (isPendingThreadWorktree(dispatchEnvironment)) {
    return { kind: "open-thread", reason: "worktree-pending" };
  }
  const runtimeMode =
    draftComposerState?.runtimeMode ??
    existingThread?.runtimeMode ??
    draftThread?.runtimeMode ??
    DEFAULT_RUNTIME_MODE;
  const interactionMode =
    draftComposerState?.interactionMode ??
    existingThread?.interactionMode ??
    thread?.interactionMode ??
    draftThread?.interactionMode ??
    DEFAULT_INTERACTION_MODE;
  const skills = draftComposerState?.skills ?? [];
  const mentions = draftComposerState?.mentions ?? [];
  const composerImages = draftComposerState?.images ?? [];
  const composerFiles = draftComposerState?.files ?? [];
  const composerAssistantSelections = draftComposerState?.assistantSelections ?? [];
  const composerBrowserAnnotations = draftComposerState?.browserAnnotations ?? [];
  const composerFileComments = draftComposerState?.fileComments ?? [];
  const sendableTerminalContexts = filterTerminalContextsWithText(
    draftComposerState?.terminalContexts ?? [],
  );
  const titleSeed =
    prompt ||
    (composerImages[0] ? `Image: ${composerImages[0].name}` : "") ||
    (composerFiles[0] ? `File: ${composerFiles[0].name}` : "") ||
    (composerAssistantSelections.length > 0 ? "Referenced assistant selection" : "") ||
    (composerBrowserAnnotations[0]
      ? formatBrowserAnnotationLabel(composerBrowserAnnotations[0])
      : "") ||
    (sendableTerminalContexts.length > 0 ? "Attached terminal context" : "") ||
    (composerFileComments.length > 0
      ? formatFileCommentTitleSeed(composerFileComments.length)
      : "") ||
    "New task";
  const fallbackTitle = buildPromptThreadTitleFallback(titleSeed);
  const messageId = newMessageId();
  // Browser annotations serialize outermost so display extraction can validate
  // their message-bound transport before unwrapping the remaining context blocks.
  const messageText = appendBrowserAnnotationsToPrompt(
    appendFileCommentsToPrompt(
      appendTerminalContextsToPrompt(
        appendAssistantSelectionsToPrompt(liveSnapshot?.prompt ?? "", composerAssistantSelections),
        sendableTerminalContexts,
      ),
      composerFileComments,
    ),
    composerBrowserAnnotations,
    messageId,
  );
  const outgoingMessageText = formatOutgoingComposerPrompt({
    provider: modelSelection.provider,
    model: modelSelection.model,
    effort: resolvePromptEffortFromModelSelection(modelSelection),
    text: messageText || (composerImages.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : ""),
  });
  const mentionedSkills = filterPromptSkillReferences(
    outgoingMessageText,
    skills,
    modelSelection.provider,
  );
  const mentionedMentions = filterPromptProviderMentionReferences(outgoingMessageText, mentions);
  const turnAttachmentsPromise = stageUploadComposerAttachments({
    threadId,
    images: composerImages,
    files: composerFiles,
    assistantSelections: composerAssistantSelections,
  });
  // The same instant feeds both the command timestamps and the optimistic entry:
  // a server-side failure stamps the session with this createdAt, and the
  // failure check compares it against droppedAtMs with >=.
  const droppedAtMs = Date.now();
  const createdAt = new Date(droppedAtMs).toISOString();

  // Optimistic move: show the card In Progress before any round-trip. Provider
  // session init can take seconds; runtime events confirm the move (reconciliation
  // clears the entry) or the failure paths below revert it.
  const kanbanUi = useKanbanUiStore.getState();
  kanbanUi.markOptimisticDispatch(threadId, {
    projectId,
    title: thread?.title ?? fallbackTitle,
    provider: modelSelection.provider,
    baselineTurnId: thread?.latestTurn?.turnId ?? null,
    droppedAtMs,
  });

  let goalWarning: string | undefined;

  try {
    if (thread === null) {
      // Local-only draft thread: create the durable thread first, reusing the same
      // workspace resolution the terminal-first promotion path uses.
      const creationState = resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: null,
        defaultProvider: input.defaultProvider,
        draftComposerState,
        draftThread,
        options: undefined,
        projectDefaultModelSelection: project?.defaultModelSelection ?? null,
        projectId,
      });
      const promotion = await promoteThreadCreate(
        {
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId,
          title: fallbackTitle,
          modelSelection,
          runtimeMode,
          interactionMode,
          envMode: creationState.envMode,
          branch: creationState.branch,
          worktreePath: creationState.worktreePath,
          workingDirectory: creationState.workingDirectory,
          lastKnownPr: creationState.lastKnownPr,
          createdAt: draftThread?.createdAt ?? createdAt,
        },
        api,
      );
      if (promotion === "unavailable") {
        await turnAttachmentsPromise.then(
          (staged) => staged.cleanup(),
          () => undefined,
        );
        kanbanUi.clearOptimisticDispatch(threadId);
        return { kind: "unavailable" };
      }
      if (project?.kind === "chat") {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          title: fallbackTitle,
        });
      }
    }

    if (mode === "goal" && prompt.length > 0) {
      // Attachment-only drafts intentionally dispatch no goal command; a prompt
      // over the cap is clamped so the metadata update never fails validation.
      const truncated = prompt.length > MAX_KANBAN_GOAL_LENGTH;
      const goal = truncated ? prompt.slice(0, MAX_KANBAN_GOAL_LENGTH) : prompt;
      if (truncated) {
        goalWarning = `Goal saved truncated to ${MAX_KANBAN_GOAL_LENGTH} characters.`;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          goal,
          goalStartBehavior: "defer",
        });
      } catch (error) {
        goalWarning = `Could not save the goal; the task was started anyway. ${
          error instanceof Error ? error.message : "Unknown error."
        }`;
      }
    }

    const stagedTurnAttachments = await turnAttachmentsPromise;
    await stagedTurnAttachments.runWithDispatch((turnAttachments) =>
      api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        message: {
          messageId,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
          ...(mentionedSkills.length > 0 ? { skills: mentionedSkills } : {}),
          ...(mentionedMentions.length > 0 ? { mentions: mentionedMentions } : {}),
        },
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        assistantDeliveryMode: input.assistantDeliveryMode,
        dispatchMode: "queue",
        runtimeMode,
        interactionMode,
        createdAt,
      }),
    );
  } catch (error) {
    await turnAttachmentsPromise.then(
      (staged) => staged.cleanup(),
      () => undefined,
    );
    kanbanUi.clearOptimisticDispatch(threadId);
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Could not send the drafted prompt.",
    };
  }

  // The prompt was consumed by the dispatched turn; an open composer for this
  // thread should not keep offering it.
  useComposerDraftStore.getState().clearComposerContent(threadId);
  return { kind: "dispatched", warning: goalWarning };
}
