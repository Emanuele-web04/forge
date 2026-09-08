// FILE: KanbanStatusIcon.tsx
// Purpose: Linear-style column status glyph — dashed circle (Draft), half-filled
//          yellow pie (In Progress), filled indigo check (Done), raised hand
//          (Awaiting you, attention-colored). Shared by board column headers
//          and card status labels.
// Layer: Kanban UI component
// Exports: KanbanStatusIcon

import { cn } from "~/lib/utils";
import type { KanbanColumnKey } from "./kanban.logic";

export function KanbanStatusIcon({
  column,
  className,
}: {
  column: KanbanColumnKey;
  className?: string;
}) {
  if (column === "done") {
    return (
      <svg
        viewBox="0 0 14 14"
        className={cn("size-3.5 shrink-0 text-[#5e6ad2]", className)}
        aria-hidden
      >
        <circle cx="7" cy="7" r="7" fill="currentColor" />
        <path
          d="M4.1 7.4 6.15 9.4 9.9 4.9"
          fill="none"
          stroke="var(--color-background-surface, white)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (column === "inProgress") {
    return (
      <svg
        viewBox="0 0 14 14"
        className={cn("size-3.5 shrink-0 text-[#f2c94c]", className)}
        aria-hidden
      >
        <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" />
      </svg>
    );
  }
  if (column === "awaitingYou") {
    // Raised-hand glyph — the human's ball is in play, distinct from the draft
    // dashed circle and the in-progress pie. Attention-colored (amber) like the
    // awaiting-you pills so the column reads coherently at a glance.
    return (
      <svg
        viewBox="0 0 14 14"
        className={cn("size-3.5 shrink-0 text-amber-600 dark:text-amber-300/90", className)}
        aria-hidden
      >
        <path
          d="M4.3 8.4V5.2M6 8.4V4.9M7.7 8.4V5M9.4 8.4V5.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M3.9 9.7a3.1 3.1 0 0 0 6.2 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 14 14"
      className={cn("size-3.5 shrink-0 text-muted-foreground/60", className)}
      aria-hidden
    >
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeDasharray="2 2.2"
      />
    </svg>
  );
}
