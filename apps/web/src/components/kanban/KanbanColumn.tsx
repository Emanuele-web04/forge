// FILE: KanbanColumn.tsx
// Purpose: One kanban column — droppable body, sortable draft cards, done render cap.
// Layer: UI component (project-board building block)
// Exports: KanbanColumn, kanbanColumnDropId, parseKanbanColumnDropId

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProjectId } from "@synara/contracts";
import { memo, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { KanbanCardView, type KanbanCardPrLookup } from "./KanbanCardView";
import { KanbanStatusIcon } from "./KanbanStatusIcon";
import {
  KANBAN_COLUMN_LABELS,
  resolveDraftDropAction,
  type KanbanCard,
  type KanbanColumnKey,
} from "./kanban.logic";

const COLUMN_DROP_ID_PREFIX = "kanban-column";
const DONE_RENDER_CAP = 30;

export function kanbanColumnDropId(projectId: ProjectId, column: KanbanColumnKey): string {
  return `${COLUMN_DROP_ID_PREFIX}|${column}|${projectId}`;
}

export function parseKanbanColumnDropId(
  dropId: string,
): { projectId: string; column: KanbanColumnKey } | null {
  const [prefix, column, ...projectIdParts] = dropId.split("|");
  if (prefix !== COLUMN_DROP_ID_PREFIX || projectIdParts.length === 0) {
    return null;
  }
  if (column !== "draft" && column !== "inProgress" && column !== "done") {
    return null;
  }
  return { projectId: projectIdParts.join("|"), column };
}

function SortableKanbanCard({
  card,
  onOpen,
  onContextMenu,
  prByThreadId,
  nowMs,
}: {
  card: KanbanCard;
  onOpen: (card: KanbanCard) => void;
  onContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  prByThreadId: KanbanCardPrLookup;
  nowMs?: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.cardId,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("list-none", isDragging && "z-20")}
      {...attributes}
      {...listeners}
    >
      <KanbanCardView
        card={card}
        onOpen={onOpen}
        {...(onContextMenu ? { onContextMenu } : {})}
        prByThreadId={prByThreadId}
        isDragSource={isDragging}
        {...(nowMs !== undefined ? { nowMs } : {})}
      />
    </li>
  );
}

function KanbanColumnComponent({
  projectId,
  columnKey,
  cards,
  onOpenCard,
  onCardContextMenu,
  sortable: sortableProp,
  droppable: droppableProp,
  activeCard: activeCardProp,
  onNewCard,
  prByThreadId,
  nowMs,
}: {
  projectId: ProjectId;
  columnKey: KanbanColumnKey;
  cards: readonly KanbanCard[];
  onOpenCard: (card: KanbanCard) => void;
  /** Right-click handler forwarded to each card's context menu. */
  onCardContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  /** Draft column in the project board: cards reorder via dnd-kit sortable. */
  sortable?: boolean;
  /** Project board only — the column body registers as a drop target. */
  droppable?: boolean;
  /** Card currently being dragged, for drop-target affordances. */
  activeCard?: KanbanCard | null;
  /** Renders a + button in the column header (Draft column's new-task entry point). */
  onNewCard?: (() => void) | undefined;
  prByThreadId: KanbanCardPrLookup;
  /** Shared board clock for live elapsed labels. */
  nowMs?: number;
}) {
  const sortable = sortableProp ?? false;
  const droppable = droppableProp ?? false;
  const activeCard = activeCardProp ?? null;
  const dropId = kanbanColumnDropId(projectId, columnKey);
  const { isOver, setNodeRef } = useDroppable({ id: dropId, disabled: !droppable });
  const [showAll, setShowAll] = useState(false);

  // Done columns can grow unbounded; cap the initial render so opening the board
  // stays cheap for long-lived projects.
  const cappedCards =
    columnKey === "done" && !showAll && cards.length > DONE_RENDER_CAP
      ? cards.slice(0, DONE_RENDER_CAP)
      : cards;
  const hiddenCount = cards.length - cappedCards.length;

  const sortableItems = useMemo(() => cards.map((card) => card.cardId), [cards]);

  const dispatchTarget =
    columnKey === "inProgress" &&
    activeCard !== null &&
    resolveDraftDropAction(activeCard) === "dispatch";

  const cardElements = cappedCards.map((card) =>
    sortable ? (
      <SortableKanbanCard
        key={card.cardId}
        card={card}
        onOpen={onOpenCard}
        onContextMenu={onCardContextMenu}
        prByThreadId={prByThreadId}
        {...(nowMs !== undefined ? { nowMs } : {})}
      />
    ) : (
      <li key={card.cardId} className="list-none">
        <KanbanCardView
          card={card}
          onOpen={onOpenCard}
          {...(onCardContextMenu ? { onContextMenu: onCardContextMenu } : {})}
          prByThreadId={prByThreadId}
          {...(nowMs !== undefined ? { nowMs } : {})}
        />
      </li>
    ),
  );

  return (
    <section className="flex min-h-0 min-w-64 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-1.5 pb-2">
        <h3 className="text-[13px] font-medium text-foreground/90">
          {KANBAN_COLUMN_LABELS[columnKey]}
        </h3>
        <span className="text-xs text-muted-foreground/70">{cards.length}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {dispatchTarget ? (
            <span className="text-[11px] text-sky-600 dark:text-sky-300/90">Drop to send</span>
          ) : null}
          {onNewCard ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0 text-muted-foreground/70 hover:text-foreground"
              aria-label="New task"
              title="New task"
              onClick={onNewCard}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          ) : null}
          <KanbanStatusIcon column={columnKey} />
        </span>
      </header>
      <ul
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-xl p-1 transition-colors",
          dispatchTarget && "bg-sky-500/5 ring-1 ring-sky-400/30",
          dispatchTarget && isOver && "bg-sky-500/10 ring-sky-400/60",
        )}
      >
        {sortable ? (
          <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
            {cardElements}
          </SortableContext>
        ) : (
          cardElements
        )}
        {cards.length === 0 ? (
          <li className="list-none rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground/60">
            No cards
          </li>
        ) : null}
        {hiddenCount > 0 ? (
          <li className="list-none">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full rounded-lg px-3 py-1.5 text-center text-xs text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              Show {hiddenCount} more
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

export const KanbanColumn = memo(KanbanColumnComponent);
