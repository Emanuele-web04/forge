// FILE: useKanbanCardContextMenu.tsx
// Purpose: Right-click context menu for kanban cards, mirroring the sidebar thread
//          menu (rename / pin / copy path / copy link / copy id / archive / delete). Reuses the
//          same shared primitives the sidebar uses (native contextMenu, clipboard,
//          worktree cleanup, rename flow) instead of duplicating its action logic.
// Layer: Kanban UI hook
// Exports: useKanbanCardContextMenu

import type { ThreadId } from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { RenameThreadDialog } from "~/components/RenameThreadDialog";
import {
  useCopyPathToClipboard,
  useCopyThreadIdToClipboard,
  useCopyThreadLinkToClipboard,
} from "~/hooks/useCopyToClipboard";
import { deleteActiveThreadFromClient } from "~/lib/activeThreadDelete";
import { gitRemoveWorktreeMutationOptions } from "~/lib/gitReactQuery";
import { pinActionLabel } from "~/lib/pin";
import { archiveThreadFromClient } from "~/lib/threadArchive";
import { dispatchThreadRename } from "~/lib/threadRename";
import { newCommandId } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useKanbanUiStore } from "../../kanbanUiStore";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import { getThreadFromState } from "../../threadDerivation";
import { toastManager } from "../ui/toast";
import { isKanbanDraftOnlyCard, type KanbanCard } from "./kanban.logic";

interface RenameTarget {
  threadId: ThreadId;
  title: string;
}

export interface KanbanCardContextMenuController {
  /** Attach to each card's `onContextMenu`. */
  onCardContextMenu: (card: KanbanCard, event: MouseEvent) => void;
  /** Render once near the board root. */
  renameDialog: React.ReactNode;
}

function resolveCardWorkspacePath(card: KanbanCard): string | null {
  const appState = useStore.getState();
  const project = appState.projects.find((candidate) => candidate.id === card.projectId) ?? null;
  return resolveThreadWorkspaceCwd({
    projectCwd: project?.cwd ?? null,
    envMode: card.envMode ?? undefined,
    worktreePath: card.worktreePath,
  });
}

async function archiveCardThread(threadId: ThreadId) {
  const api = readNativeApi();
  if (!api) return;
  const thread = getThreadFromState(useStore.getState(), threadId);
  if (!thread) return;
  // Archived threads leave the board's thread feed, so a live optimistic
  // dispatch entry could never reconcile — drop it with the card.
  useKanbanUiStore.getState().clearOptimisticDispatch(threadId);
  await archiveThreadFromClient(api.orchestration, threadId);
}

async function setThreadPinned(threadId: ThreadId, isPinned: boolean) {
  const api = readNativeApi();
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    isPinned,
  });
}

export function useKanbanCardContextMenu(): KanbanCardContextMenuController {
  const { settings } = useAppSettings();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);

  const copyPathToClipboard = useCopyPathToClipboard();
  const copyThreadIdToClipboard = useCopyThreadIdToClipboard();
  const copyThreadLinkToClipboard = useCopyThreadLinkToClipboard();

  const deleteCardThread = async (card: KanbanCard) => {
    // A deleted thread can never reconcile its optimistic dispatch — drop the
    // entry first so no phantom In Progress card survives the deletion.
    useKanbanUiStore.getState().clearOptimisticDispatch(card.threadId);
    // Local-only draft (never promoted): just drop it from the draft store.
    if (card.thread === null) {
      clearDraftThread(card.threadId);
      return;
    }
    // A settled thread can have a separate draft card for its unsent composer prompt.
    if (isKanbanDraftOnlyCard(card)) {
      clearComposerContent(card.threadId);
      return;
    }
    await deleteActiveThreadFromClient({
      threadId: card.threadId,
      onDeleted: ({ thread }) => {
        clearDraftThread(card.threadId);
        clearProjectDraftThreadById(thread.projectId, thread.id);
        clearTerminalState(card.threadId);
      },
      removeWorktree: (worktree) => removeWorktreeMutation.mutateAsync(worktree),
      unknownWorktreeErrorMessage: "Unknown error.",
    });
  };

  const onCardContextMenu = (card: KanbanCard, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readNativeApi();
    if (!api) return;
    const position = { x: event.clientX, y: event.clientY };
    const isDraftOnlyCard = isKanbanDraftOnlyCard(card);
    const isThreadBacked = card.thread !== null;
    const deletesOnlyDraft = !isThreadBacked || isDraftOnlyCard;
    const isThreadActionCard = isThreadBacked && !isDraftOnlyCard;
    const workspacePath = resolveCardWorkspacePath(card);

    void (async () => {
      const clicked = await api.contextMenu.show(
        [
          ...(isThreadActionCard
            ? [
                { id: "rename", label: "Rename thread" },
                {
                  id: "toggle-pin",
                  label: pinActionLabel("thread", card.thread?.isPinned ?? false),
                },
              ]
            : []),
          ...(workspacePath
            ? [{ id: "copy-path", label: "Copy Path", separatorBefore: true }]
            : []),
          ...(isThreadBacked
            ? [
                {
                  id: "copy-link",
                  label: "Copy link",
                  ...(workspacePath ? {} : { separatorBefore: true }),
                },
                { id: "copy-thread-id", label: "Copy Thread ID" },
              ]
            : []),
          ...(isThreadActionCard
            ? [{ id: "archive", label: "Archive", separatorBefore: true }]
            : []),
          {
            id: "delete",
            label: deletesOnlyDraft ? "Delete draft" : "Delete",
            destructive: true,
            separatorBefore: !isThreadActionCard,
          },
        ],
        position,
      );

      if (clicked === "rename" && isThreadActionCard && card.thread) {
        setRenameTarget({ threadId: card.threadId, title: card.thread.title });
        return;
      }
      if (clicked === "toggle-pin" && isThreadActionCard && card.thread) {
        const next = !card.thread.isPinned;
        void setThreadPinned(card.threadId, next).catch(() => {
          toastManager.add({
            type: "error",
            title: next ? "Unable to pin thread" : "Unable to unpin thread",
          });
        });
        return;
      }
      if (clicked === "copy-path") {
        if (!workspacePath) return;
        copyPathToClipboard(workspacePath);
        return;
      }
      if (clicked === "copy-link") {
        copyThreadLinkToClipboard(card.threadId);
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(card.threadId);
        return;
      }
      if (clicked === "archive") {
        if (!isThreadActionCard) return;
        if (settings.confirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(
            [
              `Archive thread "${card.title}"?`,
              "Archived threads are hidden from the sidebar but can be restored later.",
            ].join("\n"),
          );
          if (!confirmed) return;
        }
        await archiveCardThread(card.threadId);
        return;
      }
      if (clicked !== "delete") return;
      if (settings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          deletesOnlyDraft
            ? `Delete this draft? This removes its unsent prompt.`
            : [
                `Delete thread "${card.title}"?`,
                "This permanently clears conversation history for this thread.",
              ].join("\n"),
        );
        if (!confirmed) return;
      }
      await deleteCardThread(card);
    })();
  };

  const renameDialog = (
    <RenameThreadDialog
      open={renameTarget !== null}
      currentTitle={renameTarget?.title ?? ""}
      onOpenChange={(open) => {
        if (!open) setRenameTarget(null);
      }}
      onSave={async (newTitle) => {
        if (!renameTarget) return;
        const outcome = await dispatchThreadRename({
          threadId: renameTarget.threadId,
          newTitle,
          unchangedTitles: [renameTarget.title],
        });
        if (outcome === "unavailable") {
          toastManager.add({
            type: "error",
            title: "Not connected",
            description: "Reconnect to the server before renaming.",
          });
          return;
        }
        setRenameTarget(null);
      }}
    />
  );

  return { onCardContextMenu, renameDialog };
}
