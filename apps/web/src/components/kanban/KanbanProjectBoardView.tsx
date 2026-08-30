// FILE: KanbanProjectBoardView.tsx
// Purpose: Full 3-column board for one project — drag a Draft card onto In Progress to
//          dispatch its prompt, or reorder drafts; other moves are derived-only.
// Layer: UI component (owns the board DndContext)
// Exports: KanbanProjectBoardView

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useRef, useState } from "react";

import {
  getProviderStartOptions,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "~/appSettings";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { dispatchKanbanDraftCard } from "../../lib/kanbanDispatch";
import { KanbanCardView, type KanbanCardPrLookup } from "./KanbanCardView";
import { KanbanColumn, parseKanbanColumnDropId } from "./KanbanColumn";
import { NeedsReviewFilter } from "./NeedsReviewFilter";
import {
  reorderDraftCardIds,
  resolveReviewFoldToggleLabel,
  shouldShowReviewFoldToggle,
  type KanbanCard,
  type KanbanColumnKey,
  type KanbanProjectBoard,
} from "./kanban.logic";
import { useKanbanUiStore } from "../../kanbanUiStore";

function resolveDropColumn(board: KanbanProjectBoard, overId: string): KanbanColumnKey | null {
  const columnDrop = parseKanbanColumnDropId(overId);
  if (columnDrop) {
    // Awaiting you is derived-only (D1/S1-P6) — the drop is reported so the
    // board can explain instead of silently no-op (L1), like the Done column.
    if (columnDrop.column === "awaitingYou") {
      return "awaitingYou";
    }
    return columnDrop.projectId === board.projectId ? columnDrop.column : null;
  }
  // Sortable draft cards are the only non-column droppables on this board.
  return board.draft.some((card) => card.cardId === overId) ? "draft" : null;
}

const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }
  return closestCorners(args);
};

export function KanbanProjectBoardView({
  board,
  onOpenCard,
  onCardContextMenu,
  onNewTask,
  prByThreadId,
  nowMs,
  viewMode,
}: {
  board: KanbanProjectBoard;
  onOpenCard: (card: KanbanCard) => void;
  onCardContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  onNewTask: () => void;
  prByThreadId: KanbanCardPrLookup;
  nowMs?: number;
  /** v2 four-column layout vs classic 3-column escape hatch. */
  viewMode: "classic" | "v2";
}) {
  const { settings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const providerOptionsForDispatch = getProviderStartOptions(settings);
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const setDraftOrder = useKanbanUiStore((state) => state.setDraftOrder);
  const hasRevealedReviewFold = useKanbanUiStore((state) => state.hasRevealedReviewFold);
  const setHasRevealedReviewFold = useKanbanUiStore((state) => state.setHasRevealedReviewFold);
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null);
  // A completed drag still emits a click on the source card; swallow exactly that one
  // so dropping a card never also opens its chat.
  const suppressClickRef = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const handleOpenCard = (card: KanbanCard) => {
    if (suppressClickRef.current) {
      return;
    }
    onOpenCard(card);
  };

  const handleDispatchDrop = async (card: KanbanCard) => {
    const targetProvider = card.provider ?? settings.defaultProvider;
    const sendAvailability = await resolveProviderSendAvailabilityWithRefresh({
      provider: targetProvider,
      statuses: providerStatuses,
      refreshStatuses: () => refreshProviderStatuses({ silent: true }),
    });
    if (!sendAvailability.usable) {
      toastManager.add({
        type: "error",
        title: sendAvailability.unavailableReason,
      });
      return;
    }
    // The dispatch marks the optimistic overlay synchronously, so the card jumps
    // to In Progress before any round-trip; failure results revert it.
    const result = await dispatchKanbanDraftCard({
      card,
      defaultProvider: settings.defaultProvider,
      assistantDeliveryMode,
      providerOptions: providerOptionsForDispatch,
    });
    if (result.kind === "dispatched") {
      toastManager.add({
        type: "success",
        title: "Draft sent",
        description: card.title,
      });
      return;
    }
    if (result.kind === "open-thread") {
      const description =
        result.reason === "empty"
          ? "Nothing to send yet — write the prompt in the composer."
          : result.reason === "worktree-pending"
            ? "Open the chat to create the worktree with the normal send flow."
            : "Open the chat to continue this task.";
      toastManager.add({
        type: "info",
        title: "Finish this draft in the chat",
        description,
      });
      onOpenCard(card);
      return;
    }
    if (result.kind === "unavailable") {
      toastManager.add({
        type: "error",
        title: "Not connected",
        description: "Reconnect to the server before sending drafts.",
      });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not send draft",
      description: result.message,
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    const card = board.draft.find((candidate) => candidate.cardId === event.active.id) ?? null;
    setActiveCard(card);
    suppressClickRef.current = true;
  };

  const releaseClickSuppression = () => {
    // The trailing click (if any) fires synchronously after dragend; release on the
    // next tick so regular clicks keep working when the drop happens off-card.
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleDragCancel = () => {
    setActiveCard(null);
    releaseClickSuppression();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveCard(null);
    releaseClickSuppression();
    const { active, over } = event;
    if (!over) {
      return;
    }
    const activeId = String(active.id);
    const card = board.draft.find((candidate) => candidate.cardId === activeId);
    if (!card) {
      return;
    }
    const overId = String(over.id);
    const targetColumn = resolveDropColumn(board, overId);
    if (targetColumn === "draft") {
      const visibleCardIds = board.draft.map((draftCard) => draftCard.cardId);
      const nextOrder =
        overId === activeId
          ? null
          : board.draft.some((draftCard) => draftCard.cardId === overId)
            ? reorderDraftCardIds(visibleCardIds, activeId, overId)
            : // Dropped on the column body itself: move to the end.
              reorderDraftCardIds(visibleCardIds, activeId, visibleCardIds.at(-1) ?? activeId);
      if (nextOrder) {
        setDraftOrder(board.projectId, nextOrder);
      }
      return;
    }
    if (targetColumn === "inProgress") {
      // A drag that started before the board re-derived could re-drop a card whose
      // dispatch is still settling; a second drop must not queue another turn.
      if (useKanbanUiStore.getState().optimisticDispatchByThreadId[card.threadId]) {
        return;
      }
      void handleDispatchDrop(card);
      return;
    }
    if (targetColumn === "done") {
      toastManager.add({
        type: "info",
        title: "Done is derived automatically",
        description: "Cards move here when their runs complete.",
      });
      return;
    }
    if (targetColumn === "awaitingYou") {
      toastManager.add({
        type: "info",
        title: "Awaiting you is derived automatically",
        description: "Cards move here when they need your approval, input, or a retry.",
      });
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex h-full min-h-0 flex-col">
        {viewMode === "v2" ? (
          <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
            <NeedsReviewFilter />
            {shouldShowReviewFoldToggle(hasRevealedReviewFold, board.hiddenCount) ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-xs text-muted-foreground/80 hover:text-foreground"
                onClick={() => setHasRevealedReviewFold(!hasRevealedReviewFold)}
              >
                {resolveReviewFoldToggleLabel(hasRevealedReviewFold, board.hiddenCount)}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4">
          <KanbanColumn
            projectId={board.projectId}
            columnKey="draft"
            cards={board.draft}
            onOpenCard={handleOpenCard}
            onCardContextMenu={onCardContextMenu}
            sortable
            droppable
            activeCard={activeCard}
            onNewCard={onNewTask}
            prByThreadId={prByThreadId}
            {...(nowMs !== undefined ? { nowMs } : {})}
          />
          <KanbanColumn
            projectId={board.projectId}
            columnKey="inProgress"
            cards={board.inProgress}
            onOpenCard={handleOpenCard}
            onCardContextMenu={onCardContextMenu}
            droppable
            activeCard={activeCard}
            prByThreadId={prByThreadId}
            {...(nowMs !== undefined ? { nowMs } : {})}
          />
          {viewMode === "v2" ? (
            <KanbanColumn
              projectId={board.projectId}
              columnKey="awaitingYou"
              cards={board.awaitingYou}
              onOpenCard={handleOpenCard}
              onCardContextMenu={onCardContextMenu}
              // Droppable so a drop onto it produces the explaining toast rather
              // than silently falling through to empty space (L1).
              droppable
              activeCard={activeCard}
              prByThreadId={prByThreadId}
              {...(nowMs !== undefined ? { nowMs } : {})}
            />
          ) : null}
          <KanbanColumn
            projectId={board.projectId}
            columnKey="done"
            cards={board.done}
            onOpenCard={handleOpenCard}
            onCardContextMenu={onCardContextMenu}
            droppable
            activeCard={activeCard}
            prByThreadId={prByThreadId}
            {...(nowMs !== undefined ? { nowMs } : {})}
            // Fold the inner done-column cap under the board-level reveal so a
            // >30 done column's tail is reachable in one unfold (C2).
            {...(viewMode === "v2" && hasRevealedReviewFold ? { uncapped: true } : {})}
          />
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <KanbanCardView
            card={activeCard}
            isOverlay
            prByThreadId={prByThreadId}
            {...(nowMs !== undefined ? { nowMs } : {})}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
