// FILE: useKanbanTaskSubmit.ts
// Purpose: Owns the kanban new-task dialog's draft/create/send lifecycle.
// Layer: Kanban UI hook
// Exports: useKanbanTaskSubmit

import type {
  AssistantDeliveryMode,
  ModelSlug,
  ProjectId,
  ProviderInteractionMode,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
  ServerProviderStatus,
  ThreadId,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import type { DraftThreadEnvMode } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { createAndSendKanbanTask, createKanbanDraftTask } from "~/lib/kanbanTaskCreate";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { buildModelSelection } from "~/providerModelOptions";
import { truncateKanbanTaskPreview } from "./KanbanNewTaskDialog.logic";

interface UseKanbanTaskSubmitInput {
  readonly selectedProjectId: ProjectId | null;
  readonly hasSendableContent: boolean;
  readonly selectedProvider: ProviderKind;
  readonly selectedModel: ModelSlug | null;
  readonly selectedModelSupportsAutoMode: boolean | undefined;
  readonly taskPreview: string;
  readonly trimmedPrompt: string;
  readonly scratchThreadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly envMode: DraftThreadEnvMode;
  readonly sendAsDraft: boolean;
  readonly defaultProvider: ProviderKind;
  readonly assistantDeliveryMode: AssistantDeliveryMode;
  readonly providerOptionsForDispatch: ProviderStartOptions | undefined;
  readonly providerStatuses: readonly ServerProviderStatus[];
  readonly isPreparingImages: boolean;
  readonly waitForPendingImages: () => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}

export function useKanbanTaskSubmit(input: UseKanbanTaskSubmitInput) {
  const {
    selectedProjectId,
    hasSendableContent,
    selectedProvider,
    selectedModel,
    selectedModelSupportsAutoMode,
    taskPreview,
    trimmedPrompt,
    scratchThreadId,
    runtimeMode,
    interactionMode,
    envMode,
    sendAsDraft,
    defaultProvider,
    assistantDeliveryMode,
    providerOptionsForDispatch,
    providerStatuses,
    isPreparingImages,
    waitForPendingImages,
    onOpenChange,
  } = input;
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  // Synchronous re-entry guard: repeated Cmd+Enter can fire before React flushes
  // the loading state, and two passes here would create two tasks.
  const isCreatingRef = useRef(false);

  const canCreate =
    selectedProjectId !== null &&
    hasSendableContent &&
    selectedModel !== null &&
    !isCreating &&
    !isPreparingImages;

  const handleCreate = async () => {
    if (
      !selectedProjectId ||
      !hasSendableContent ||
      selectedModel === null ||
      isCreating ||
      isCreatingRef.current
    ) {
      return;
    }

    isCreatingRef.current = true;
    await waitForPendingImages();
    const truncatedPrompt = truncateKanbanTaskPreview(taskPreview);
    // The scratch draft carries the full selection (model + reasoning effort +
    // speed) set through the picker; fall back to a bare selection otherwise.
    const scratchState = useComposerDraftStore.getState().draftsByThreadId[scratchThreadId];
    const storedModelSelection = scratchState?.modelSelectionByProvider[selectedProvider];
    const storedModelSupportsAutoMode =
      storedModelSelection?.provider === "claudeAgent"
        ? storedModelSelection.supportsAutoMode
        : undefined;
    const modelSelection = buildModelSelection(
      selectedProvider,
      selectedModel,
      storedModelSelection?.options,
      selectedProvider === "claudeAgent"
        ? (selectedModelSupportsAutoMode ?? storedModelSupportsAutoMode)
        : undefined,
    );
    const taskInput = {
      projectId: selectedProjectId,
      prompt: trimmedPrompt,
      sourceComposerThreadId: scratchThreadId,
      modelSelection,
      runtimeMode,
      interactionMode,
      envMode,
    };

    if (sendAsDraft) {
      createKanbanDraftTask(taskInput);
      toastManager.add({
        type: "success",
        title: "Task added to Drafts",
        description: truncatedPrompt,
      });
      onOpenChange(false);
      return;
    }

    // Send now: create + promote + dispatch straight to In Progress.
    const sendAvailability = await resolveProviderSendAvailabilityWithRefresh({
      provider: modelSelection.provider,
      statuses: providerStatuses,
      refreshStatuses: () => refreshProviderStatuses({ silent: true }),
    });
    if (!sendAvailability.usable) {
      toastManager.add({
        type: "error",
        title: sendAvailability.unavailableReason,
      });
      isCreatingRef.current = false;
      return;
    }

    setIsCreating(true);
    void createAndSendKanbanTask({
      ...taskInput,
      defaultProvider,
      assistantDeliveryMode,
      providerOptions: providerOptionsForDispatch,
    })
      .then(({ threadId, result }) => {
        if (result.kind === "dispatched") {
          toastManager.add({
            type: "success",
            title: "Task started",
            description: truncatedPrompt,
          });
          onOpenChange(false);
          return;
        }
        if (result.kind === "open-thread") {
          toastManager.add({
            type: "info",
            title: "Finish this task in the chat",
            description:
              result.reason === "worktree-pending"
                ? "Worktree setup stays on the normal composer send path."
                : "The task was saved as a draft.",
          });
          onOpenChange(false);
          void navigate({ to: "/$threadId", params: { threadId } });
          return;
        }
        // Promotion/dispatch could not complete faithfully; the draft still
        // exists on the board, so surface the failure and keep the dialog open.
        toastManager.add({
          type: "error",
          title: "Couldn't start the task",
          description:
            result.kind === "error"
              ? result.message
              : "The task was saved to Drafts instead. Open it to send manually.",
        });
        isCreatingRef.current = false;
        setIsCreating(false);
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Couldn't start the task",
          description: error instanceof Error ? error.message : "Unexpected error.",
        });
        isCreatingRef.current = false;
        setIsCreating(false);
      });
  };

  return {
    isCreating,
    canCreate,
    handleCreate,
  };
}
