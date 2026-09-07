// FILE: SidebarThreadBranchPaging.tsx
// Purpose: Shared `Show N more` / `Show less` actions for hierarchy branches.
// Layer: Sidebar UI primitive
// Exports: SidebarThreadBranchPaging
// Depends on: the same event-guard and focus conventions as the branch control.

import type { MouseEvent as ReactMouseEvent, SyntheticEvent } from "react";

import { cn } from "../lib/utils";

function stopPagingPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

export function SidebarThreadBranchPaging(props: {
  hiddenCount: number;
  canShowLess: boolean;
  onShowMore: () => void;
  onShowLess: () => void;
}) {
  const { canShowLess, hiddenCount, onShowLess, onShowMore } = props;
  const total = Number.isFinite(hiddenCount) ? Math.max(0, Math.floor(hiddenCount)) : 0;
  if (total <= 0 && !canShowLess) {
    return null;
  }
  const handleShowMore = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onShowMore();
  };
  const handleShowLess = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onShowLess();
  };
  return (
    <div className="flex w-full min-w-0 items-center gap-1 py-0.5 pr-2">
      {total > 0 ? (
        <button
          type="button"
          data-thread-selection-safe
          aria-label={`Show ${total} more`}
          onPointerDown={stopPagingPropagation}
          onClick={handleShowMore}
          onKeyDown={stopPagingPropagation}
          onDoubleClick={stopPagingPropagation}
          onContextMenu={stopPagingPropagation}
          className="h-6 min-h-6 flex-1 cursor-pointer truncate rounded-md pl-8 text-left text-[length:var(--app-font-size-ui,11px)] text-muted-foreground/79 tabular-nums hover:bg-transparent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 active:bg-transparent active:text-foreground pointer-coarse:min-h-11"
        >
          Show {total} more
        </button>
      ) : null}
      {canShowLess ? (
        <button
          type="button"
          data-thread-selection-safe
          onPointerDown={stopPagingPropagation}
          onClick={handleShowLess}
          onKeyDown={stopPagingPropagation}
          onDoubleClick={stopPagingPropagation}
          onContextMenu={stopPagingPropagation}
          className={cn(
            "h-6 min-h-6 cursor-pointer rounded-md text-left text-[length:var(--app-font-size-ui,11px)] text-muted-foreground/79 hover:bg-transparent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 active:bg-transparent active:text-foreground pointer-coarse:min-h-11",
            total > 0 ? "flex-none px-2" : "flex-1 truncate pl-8",
          )}
        >
          Show less
        </button>
      ) : null}
    </div>
  );
}
