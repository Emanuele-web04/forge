// FILE: diff-stat.tsx
// Purpose: Single source of truth for the "+insertions −deletions" pair rendered
//          wherever the app surfaces diff size (git dialogs, environment panel,
//          branch selector, chat header).
// Layer: UI primitive

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function DiffStat({
  insertions,
  deletions,
  separator,
  className,
}: {
  insertions: number;
  deletions: number;
  /** Rendered between the two counts — e.g. a "/" in dense file rows. */
  separator?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 tabular-nums", className)}
      data-slot="diff-stat"
    >
      <span className="text-success">+{insertions.toLocaleString()}</span>
      {separator}
      <span className="text-destructive">−{deletions.toLocaleString()}</span>
    </span>
  );
}
