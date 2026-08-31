// FILE: SidebarSplitGroupSurface.tsx
// Purpose: Presents sidebar rows that share a split view as one quiet, contained card.
// Layer: Sidebar UI primitive
// Exports: SidebarSplitGroupSurface

import type { SidebarSplitGroupPosition } from "./sidebarSplitGroups";
import { cn } from "../lib/utils";

// Each row owns one segment of the card. Middle segments bleed through the list gap so the
// result reads as a single container while normal row hover and focus states remain independent.
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
      data-split-active={active ? "true" : "false"}
      className={cn(
        "pointer-events-none absolute left-0.5 right-0.5 top-0 -z-10 border-x",
        active
          ? "border-primary/20 bg-primary/[0.04]"
          : "border-border/30 bg-muted-foreground/[0.03]",
        position === "first" ? "rounded-t-lg border-t" : null,
        position === "last" ? "bottom-0 rounded-b-lg border-b" : "-bottom-1",
      )}
    />
  );
}
