// FILE: SidebarSplitGroupRail.tsx
// Purpose: Draws the leading rail that ties sidebar rows belonging to the same split view together.
// Layer: Sidebar UI primitive
// Exports: SidebarSplitGroupRail

import { pluralize } from "@synara/shared/text";

import type { SidebarSplitGroupInfo } from "./sidebarSplitGroups";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const PANE_CELL_COUNT = 4;

// Approximates the split layout as a 2x2 grid with one cell filled per member. The real pane tree
// can be a 1x2, 1x3, or 2x2 arrangement, so this reads as "how many chats share this view" rather
// than as an exact map of the geometry.
function SplitLayoutGlyph({ memberCount, active }: { memberCount: number; active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-[9px] grid-cols-2 gap-px overflow-hidden rounded-[2px] p-px ring-1",
        active ? "ring-primary/55" : "ring-border/60",
      )}
    >
      {Array.from({ length: PANE_CELL_COUNT }, (_, cellIndex) => (
        <span
          key={cellIndex}
          className={cn(
            "rounded-[0.5px]",
            cellIndex < memberCount
              ? active
                ? "bg-primary/75"
                : "bg-muted-foreground/55"
              : active
                ? "bg-primary/18"
                : "bg-muted-foreground/16",
          )}
        />
      ))}
    </span>
  );
}

export function SidebarSplitGroupRail({
  splitGroup,
  active,
}: {
  splitGroup: SidebarSplitGroupInfo;
  active: boolean;
}) {
  const lineClass = cn("absolute left-[5px] w-px", active ? "bg-primary/45" : "bg-border/45");
  const verticalSpanClass =
    splitGroup.position === "first"
      ? "top-1/2 bottom-0 rounded-t-full"
      : splitGroup.position === "last"
        ? "top-0 bottom-1/2 rounded-b-full"
        : "top-0 bottom-0";

  const rail = (
    <span
      data-testid="sidebar-split-group-rail"
      data-split-view-id={splitGroup.splitViewId}
      data-split-position={splitGroup.position}
      data-split-member={`${splitGroup.memberIndex}/${splitGroup.memberCount}`}
      className="relative inline-flex h-3.5 w-3 shrink-0 items-center"
    >
      <span aria-hidden="true" className={cn(lineClass, verticalSpanClass)} />
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-[5px] top-1/2 h-px w-1.5 -translate-y-1/2",
          active ? "bg-primary/45" : "bg-border/45",
        )}
      />
      {splitGroup.isLeader ? (
        <span className="absolute left-[1px] top-1/2 -translate-y-1/2">
          <SplitLayoutGlyph memberCount={splitGroup.memberCount} active={active} />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-[5px] top-1/2 size-[4px] -translate-x-1/2 -translate-y-1/2 rounded-full",
            active ? "bg-primary/60" : "bg-border/70",
          )}
        />
      )}
    </span>
  );

  if (!splitGroup.isLeader) {
    return rail;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={rail} />
      <TooltipPopup side="top">
        {`Split view · ${splitGroup.memberCount} ${pluralize(splitGroup.memberCount, "chat")}`}
      </TooltipPopup>
    </Tooltip>
  );
}
