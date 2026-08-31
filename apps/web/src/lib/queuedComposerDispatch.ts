// FILE: queuedComposerDispatch.ts
// Purpose: Dispatch a snapshotted QueuedComposerTurn against a thread without ChatView.
// Layer: Web orchestration helper
// Exports: dispatchQueuedComposerTurnHeadless

import type { AssistantDeliveryMode, ThreadId } from "@synara/contracts";

import { persistModelSelectionBeforeRuntimeMode } from "../components/ChatView.logic";
import { useComposerDraftStore, type QueuedComposerTurn } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { clearPendingTurnDispatch, markPendingTurnDispatch } from "../pendingTurnDispatch";
import {
  buildSourceProposedPlanReference,
  findLatestProposedPlan,
  hasActionableProposedPlan,
} from "../session-logic";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { appendAssistantSelectionsToPrompt } from "./assistantSelections";
import { appendBrowserAnnotationsToPrompt } from "./browserAnnotations";
import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
} from "./composerMentions";
import { appendPastedTextsToPrompt, filterPastedTextsWithText } from "./composerPastedText";
import { formatOutgoingComposerPrompt, stageUploadComposerAttachments } from "./composerSend";
import { appendFileCommentsToPrompt } from "./fileComments";
import {
  appendTerminalContextsToPrompt,
  filterTerminalContextsWithText,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
} from "./terminalContext";
import { newCommandId, newMessageId } from "./utils";

export async function dispatchQueuedComposerTurnHeadless(input: {
  threadId: ThreadId;
  queuedTurn: QueuedComposerTurn;
  dispatchMode: "queue" | "steer";
  assistantDeliveryMode: AssistantDeliveryMode;
}): Promise<boolean> {
  const api = readNativeApi();
  if (!api) {
    return false;
  }

  const thread = getThreadFromState(useStore.getState(), input.threadId);
  if (!thread) {
    return false;
  }

  const createdAt = new Date().toISOString();
  const messageId = newMessageId();
  const queuedTurn = input.queuedTurn;

  if (queuedTurn.kind === "plan-follow-up") {
    const trimmed = queuedTurn.text.trim();
    if (!trimmed) {
      return false;
    }
    const outgoingMessageText = formatOutgoingComposerPrompt({
      provider: queuedTurn.selectedProvider,
      model: queuedTurn.selectedModel,
      effort: queuedTurn.selectedPromptEffort,
      text: trimmed,
    });
    const latestProposedPlan = findLatestProposedPlan(
      thread.proposedPlans,
      thread.latestTurn?.turnId,
    );
    const sourceProposedPlan =
      queuedTurn.interactionMode === "default"
        ? buildSourceProposedPlanReference({
            threadId: input.threadId,
            proposedPlan: hasActionableProposedPlan(latestProposedPlan) ? latestProposedPlan : null,
          })
        : undefined;

    markPendingTurnDispatch(input.threadId);
    try {
      await persistQueuedTurnThreadSettings({
        api,
        thread,
        queuedTurn,
        createdAt,
      });
      useComposerDraftStore
        .getState()
        .setInteractionMode(input.threadId, queuedTurn.interactionMode);
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: input.threadId,
        message: {
          messageId,
          role: "user",
          text: outgoingMessageText,
          attachments: [],
        },
        modelSelection: queuedTurn.modelSelection,
        ...(queuedTurn.providerOptionsForDispatch
          ? { providerOptions: queuedTurn.providerOptionsForDispatch }
          : {}),
        assistantDeliveryMode: input.assistantDeliveryMode,
        dispatchMode: input.dispatchMode,
        runtimeMode: queuedTurn.runtimeMode,
        interactionMode: queuedTurn.interactionMode,
        ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
        createdAt,
      });
      return true;
    } catch {
      clearPendingTurnDispatch(input.threadId);
      return false;
    }
  }

  const sendableTerminalContexts = filterTerminalContextsWithText(queuedTurn.terminalContexts);
  const sendablePastedTexts = filterPastedTextsWithText(queuedTurn.pastedTexts);
  const messageText = appendBrowserAnnotationsToPrompt(
    appendPastedTextsToPrompt(
      appendFileCommentsToPrompt(
        appendTerminalContextsToPrompt(
          appendAssistantSelectionsToPrompt(queuedTurn.prompt, queuedTurn.assistantSelections),
          sendableTerminalContexts,
        ),
        queuedTurn.fileComments,
      ),
      sendablePastedTexts,
    ),
    queuedTurn.browserAnnotations,
    messageId,
  );
  const outgoingTextSeed =
    messageText || (queuedTurn.images.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "");
  if (!outgoingTextSeed.trim() && queuedTurn.images.length === 0) {
    return false;
  }
  const outgoingMessageText = formatOutgoingComposerPrompt({
    provider: queuedTurn.selectedProvider,
    model: queuedTurn.selectedModel,
    effort: queuedTurn.selectedPromptEffort,
    text: outgoingTextSeed,
  });
  const mentionedSkills = filterPromptSkillReferences(
    outgoingMessageText,
    queuedTurn.skills,
    queuedTurn.selectedProvider,
  );
  const mentionedMentions = filterPromptProviderMentionReferences(
    outgoingMessageText,
    queuedTurn.mentions,
  );
  const turnAttachmentsPromise = stageUploadComposerAttachments({
    threadId: input.threadId,
    images: queuedTurn.images,
    files: queuedTurn.files,
    assistantSelections: queuedTurn.assistantSelections,
  });

  markPendingTurnDispatch(input.threadId);
  try {
    await persistQueuedTurnThreadSettings({
      api,
      thread,
      queuedTurn,
      createdAt,
    });
    const stagedTurnAttachments = await turnAttachmentsPromise;
    await stagedTurnAttachments.runWithDispatch((turnAttachments) =>
      api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: input.threadId,
        message: {
          messageId,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
          ...(mentionedSkills.length > 0 ? { skills: mentionedSkills } : {}),
          ...(mentionedMentions.length > 0 ? { mentions: mentionedMentions } : {}),
        },
        modelSelection: queuedTurn.modelSelection,
        ...(queuedTurn.providerOptionsForDispatch
          ? { providerOptions: queuedTurn.providerOptionsForDispatch }
          : {}),
        assistantDeliveryMode: input.assistantDeliveryMode,
        dispatchMode: input.dispatchMode,
        runtimeMode: queuedTurn.runtimeMode,
        interactionMode: queuedTurn.interactionMode,
        ...(queuedTurn.sourceProposedPlan
          ? { sourceProposedPlan: queuedTurn.sourceProposedPlan }
          : {}),
        createdAt,
      }),
    );
    return true;
  } catch {
    await turnAttachmentsPromise.then(
      (staged) => staged.cleanup(),
      () => undefined,
    );
    clearPendingTurnDispatch(input.threadId);
    return false;
  }
}

async function persistQueuedTurnThreadSettings(input: {
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  thread: NonNullable<ReturnType<typeof getThreadFromState>>;
  queuedTurn: QueuedComposerTurn;
  createdAt: string;
}): Promise<void> {
  await persistModelSelectionBeforeRuntimeMode({
    currentModelSelection: input.thread.modelSelection,
    nextModelSelection: input.queuedTurn.modelSelection,
    currentRuntimeMode: input.thread.runtimeMode,
    nextRuntimeMode: input.queuedTurn.runtimeMode,
    persistModelSelection: (modelSelection) =>
      input.api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: input.thread.id,
        modelSelection,
      }),
    persistRuntimeMode: (runtimeMode) =>
      input.api.orchestration.dispatchCommand({
        type: "thread.runtime-mode.set",
        commandId: newCommandId(),
        threadId: input.thread.id,
        runtimeMode,
        createdAt: input.createdAt,
      }),
  });

  if (input.queuedTurn.interactionMode !== input.thread.interactionMode) {
    await input.api.orchestration.dispatchCommand({
      type: "thread.interaction-mode.set",
      commandId: newCommandId(),
      threadId: input.thread.id,
      interactionMode: input.queuedTurn.interactionMode,
      createdAt: input.createdAt,
    });
  }
}
