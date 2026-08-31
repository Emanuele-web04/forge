// FILE: SidebarRowHoverActions.tsx
// Purpose: Absolutely positioned hover action strip on thread/chat/folder rows.
// Layer: Sidebar UI primitive
// Exports: SidebarRowHoverActions, SidebarRowHoverActionsRow

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Row groups that host a hover action strip. Each entry is the counterpart of the
 * same key in `sidebarHoverRevealHideClassName`: the resting glyph fades out exactly
 * when the strip fades in, so the actions replace it instead of stacking on it.
 * Tailwind only emits utilities it reads as complete literals, hence the spelled-out
 * `group/<row>` tokens. Requires an ancestor carrying the matching `group/<row>` marker.
 */
export type SidebarRowHoverActionsRow = "thread-folder-row" | "thread-row";

const REVEAL_CLASS_NAME: Record<SidebarRowHoverActionsRow, string> = {
  "thread-folder-row":
    "group-hover/thread-folder-row:pointer-events-auto group-hover/thread-folder-row:opacity-100 group-focus-within/thread-folder-row:pointer-events-auto group-focus-within/thread-folder-row:opacity-100",
  "thread-row":
    "group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100",
};

export function SidebarRowHoverActions({
  row: rowProp,
  testId,
  className,
  children,
}: {
  row?: SidebarRowHoverActionsRow;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  const row = rowProp ?? "thread-row";
  return (
    <div
      {...(testId ? { "data-testid": testId } : {})}
      className={cn(
        "pointer-events-none absolute inset-y-0 right-0 my-auto inline-flex items-center",
        "opacity-0 transition-opacity",
        REVEAL_CLASS_NAME[row],
        className,
      )}
    >
      {children}
    </div>
  );
}
