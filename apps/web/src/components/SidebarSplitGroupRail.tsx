// FILE: SidebarSplitGroupRail.tsx
// Purpose: Presents sidebar rows that share a split view as one contained group — a subtle shared
//          surface tying the rows together plus a compact side-by-side panes indicator per row.
// Layer: Sidebar UI primitive
// Exports: SidebarSplitGroupSurface (the shared card behind the rows), SidebarSplitGroupRail (the
//          leading split indicator)

import { pluralize } from "@synara/shared/text";

import type { SidebarSplitGroupInfo, SidebarSplitGroupPosition } from "./sidebarSplitGroups";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Visual cap on how many panes the indicator draws. Real split trees are 2–4 panes; anything larger
// is approximated so the glyph stays legible and the leading slot keeps a stable width.
const MAX_PANE_CELLS = 4;

// Draws the split as a row of side-by-side panes (never a 2x2 grid, which reads as a folder/app
// grid). The cell for this row's own pane is filled; the rest sit faint, so a member both signals
// "this is a split view" and shows which pane it is.
function SplitPanesGlyph({
  memberIndex,
  memberCount,
  active,
}: {
  memberIndex: number;
  memberCount: number;
  active: boolean;
}) {
  const cellCount = Math.min(Math.max(memberCount, 2), MAX_PANE_CELLS);
  const activeCell = Math.min(Math.max(memberIndex, 1), cellCount);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-[9px] items-stretch gap-px rounded-[2px] p-px ring-1",
        active ? "ring-primary/55" : "ring-border/60",
      )}
    >
      {Array.from({ length: cellCount }, (_, cellIndex) => (
        <span
          key={cellIndex}
          className={cn(
            "w-[2.5px] rounded-[1px]",
            cellIndex + 1 === activeCell
              ? active
                ? "bg-primary/80"
                : "bg-muted-foreground/65"
              : active
                ? "bg-primary/20"
                : "bg-muted-foreground/18",
          )}
        />
      ))}
    </span>
  );
}

// The shared card behind every row of a split group. Rendered as a decorative layer beneath the row
// content (negative z sits above the row's own hover/active fill but below its text and icons). Side
// borders run the full height of every member; the top/bottom caps and rounded corners land only on
// the group's ends, and non-last rows bleed past their box (the row button opts into overflow-visible
// for split rows) to bridge the inter-row gap so the whole span reads as one contained surface rather
// than stacked pills. The bleed clears the widest list gap (gap-1, 4px); overshoot on tighter lists
// just tucks under the next member's own surface, so it is safe.
export function SidebarSplitGroupSurface({
  position,
  active,
}: {
  position: SidebarSplitGroupPosition;
  active: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="sidebar-split-group-surface"
      data-split-position={position}
      className={cn(
        "pointer-events-none absolute left-0 right-0 top-0 -z-10 border-x",
        active
          ? "border-primary/30 bg-primary/[0.06]"
          : "border-border/55 bg-muted-foreground/[0.04]",
        position === "first" ? "rounded-t-md border-t" : null,
        position === "last" ? "bottom-0 rounded-b-md border-b" : "-bottom-1",
      )}
    />
  );
}

export function SidebarSplitGroupRail({
  splitGroup,
  active,
}: {
  splitGroup: SidebarSplitGroupInfo;
  active: boolean;
}) {
  const paneLabel = `Split view · pane ${splitGroup.memberIndex} of ${splitGroup.memberCount}`;

  const glyph = (
    <span
      role="img"
      aria-label={paneLabel}
      data-testid="sidebar-split-group-rail"
      data-split-view-id={splitGroup.splitViewId}
      data-split-position={splitGroup.position}
      data-split-member={`${splitGroup.memberIndex}/${splitGroup.memberCount}`}
      className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
    >
      <SplitPanesGlyph
        memberIndex={splitGroup.memberIndex}
        memberCount={splitGroup.memberCount}
        active={active}
      />
    </span>
  );

  if (!splitGroup.isLeader) {
    return glyph;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={glyph} />
      <TooltipPopup side="top">
        {`Split view · ${splitGroup.memberCount} ${pluralize(splitGroup.memberCount, "chat")}`}
      </TooltipPopup>
    </Tooltip>
  );
}
