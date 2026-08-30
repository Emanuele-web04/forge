// FILE: KanbanOverview.tsx
// Purpose: Top kanban layer — one column per project (In Progress → Draft → Done cards);
//          clicking a project drills into its full 3-column board. v2 mode threads the
//          attention-first flatten order and the needs-review filter.
// Layer: UI component (read-only; drag & drop lives in the project board)
// Exports: KanbanOverview

import type { ProjectId } from "@synara/contracts";
import { Button } from "~/components/ui/button";
import { ChevronRightIcon, PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { KanbanViewMode } from "../../kanbanUiStore";
import { KanbanCardView, type KanbanCardPrLookup } from "./KanbanCardView";
import { NeedsReviewFilter } from "./NeedsReviewFilter";
import {
  overviewVisibleKanbanCards,
  type KanbanBoard,
  type KanbanCard,
  type KanbanProjectBoard,
} from "./kanban.logic";

const OverviewProjectColumn = function OverviewProjectColumn({
  projectBoard,
  onOpenProject,
  onOpenCard,
  onCardContextMenu,
  onNewTask,
  prByThreadId,
  nowMs,
  viewMode,
}: {
  projectBoard: KanbanProjectBoard;
  onOpenProject: (projectId: ProjectId) => void;
  onOpenCard: (card: KanbanCard) => void;
  onCardContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  onNewTask: (projectId: ProjectId) => void;
  prByThreadId: KanbanCardPrLookup;
  nowMs?: number;
  viewMode: KanbanViewMode;
}) {
  const { visibleCards, hiddenCount } = overviewVisibleKanbanCards(projectBoard, viewMode === "v2");

  return (
    <section className="flex w-72 shrink-0 flex-col">
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onOpenProject(projectBoard.projectId)}
          className={cn(
            "group/kanban-project flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
            "hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          <h2 className="min-w-0 truncate text-[13px] font-semibold text-foreground/90">
            {projectBoard.projectName}
          </h2>
          <span className="text-xs text-muted-foreground/70">{projectBoard.totalCount}</span>
          <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover/kanban-project:opacity-100 group-focus-visible/kanban-project:opacity-100" />
        </button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0 text-muted-foreground/70 hover:text-foreground"
          aria-label={`New task in ${projectBoard.projectName}`}
          title={`New task in ${projectBoard.projectName}`}
          onClick={() => onNewTask(projectBoard.projectId)}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1">
        {visibleCards.map((card) => (
          <li key={card.cardId} className="list-none">
            <KanbanCardView
              card={card}
              onOpen={onOpenCard}
              prByThreadId={prByThreadId}
              {...(onCardContextMenu ? { onContextMenu: onCardContextMenu } : {})}
              {...(nowMs !== undefined ? { nowMs } : {})}
            />
          </li>
        ))}
        {hiddenCount > 0 ? (
          <li className="list-none">
            <button
              type="button"
              onClick={() => onOpenProject(projectBoard.projectId)}
              className="w-full rounded-lg px-3 py-1.5 text-center text-xs text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              Show {hiddenCount} more
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
};

export function KanbanOverview({
  board,
  onOpenProject,
  onOpenCard,
  onCardContextMenu,
  onNewTask,
  prByThreadId,
  nowMs,
  viewMode,
}: {
  board: KanbanBoard;
  onOpenProject: (projectId: ProjectId) => void;
  onOpenCard: (card: KanbanCard) => void;
  onCardContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  onNewTask: (projectId: ProjectId) => void;
  prByThreadId: KanbanCardPrLookup;
  nowMs?: number;
  viewMode: KanbanViewMode;
}) {
  // Projects without any cards are pure noise on the overview; their boards stay
  // reachable through /kanban/$projectId if linked directly.
  const visibleProjects = board.projects.filter((projectBoard) => projectBoard.totalCount > 0);

  if (visibleProjects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <div className="text-sm font-medium text-foreground/85">Nothing on the board yet</div>
          <div className="mt-1 text-sm text-muted-foreground">
            Drafted prompts, running turns, and completed chats will show up here automatically.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {viewMode === "v2" ? (
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
          <NeedsReviewFilter />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto px-4 pb-4">
        {visibleProjects.map((projectBoard) => (
          <OverviewProjectColumn
            key={projectBoard.projectId}
            projectBoard={projectBoard}
            onOpenProject={onOpenProject}
            onOpenCard={onOpenCard}
            onCardContextMenu={onCardContextMenu}
            onNewTask={onNewTask}
            prByThreadId={prByThreadId}
            {...(nowMs !== undefined ? { nowMs } : {})}
            viewMode={viewMode}
          />
        ))}
      </div>
    </div>
  );
}
