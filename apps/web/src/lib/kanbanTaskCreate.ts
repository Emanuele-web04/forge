// FILE: kanbanTaskCreate.ts
// Purpose: Creates a standalone draft thread from the kanban new-task dialog — the
//          draft lands in the board's Draft column and dispatches like any other card.
// Layer: Web orchestration helper
// Exports: createKanbanDraftTask, createAndSendKanbanTask, KanbanDraftTaskInput

import type {
  AssistantDeliveryMode,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";

import { useComposerDraftStore, type DraftThreadEnvMode } from "../composerDraftStore";
import { dispatchKanbanDraftThread, type KanbanDraftDispatchResult } from "./kanbanDispatch";
import { newThreadId } from "./utils";

export interface KanbanDraftTaskInput {
  projectId: ProjectId;
  prompt: string;
  /** Optional scratch composer whose full transferable content seeds the new task. */
  sourceComposerThreadId?: ThreadId;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
}

/**
 * Registers a new mapping-less draft thread and seeds its composer content. The
 * project's regular composer draft is untouched, so any number of tasks can be
 * created back to back.
 */
export function createKanbanDraftTask(input: KanbanDraftTaskInput): ThreadId {
  const store = useComposerDraftStore.getState();
  const threadId = newThreadId();
  store.registerDraftThread(threadId, {
    projectId: input.projectId,
    envMode: input.envMode,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    isKanbanDraft: true,
  });
  if (input.sourceComposerThreadId) {
    store.copyTransferableComposerState(input.sourceComposerThreadId, threadId);
  } else {
    store.setPrompt(threadId, input.prompt);
  }
  store.setModelSelection(threadId, input.modelSelection);
  store.setRuntimeMode(threadId, input.runtimeMode);
  store.setInteractionMode(threadId, input.interactionMode);
  return threadId;
}

/**
 * Creates the draft, then immediately promotes + dispatches it so the task skips
 * the Draft column and lands in In Progress — the "send now" path for the new-task
 * dialog. Reuses {@link dispatchKanbanDraftThread} so a sent task behaves exactly
 * like dragging a Draft card onto In Progress.
 */
export async function createAndSendKanbanTask(
  input: KanbanDraftTaskInput & {
    defaultProvider: ProviderKind;
    assistantDeliveryMode: AssistantDeliveryMode;
    providerOptions?: ProviderStartOptions | undefined;
  },
): Promise<{ threadId: ThreadId; result: KanbanDraftDispatchResult }> {
  const threadId = createKanbanDraftTask(input);
  const result = await dispatchKanbanDraftThread({
    threadId,
    projectId: input.projectId,
    thread: null,
    defaultProvider: input.defaultProvider,
    assistantDeliveryMode: input.assistantDeliveryMode,
    providerOptions: input.providerOptions,
  });
  return { threadId, result };
}
