// FILE: SidebarRowHoverActions.tsx
// Purpose: Absolutely positioned hover action strip on thread/chat rows.
// Layer: Sidebar UI primitive
// Exports: SidebarRowHoverActions

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function SidebarRowHoverActions({
  threadId,
  testId,
  className,
  children,
}: {
  threadId: string;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId ?? `thread-hover-actions-${threadId}`}
      className={cn(
        "pointer-events-none absolute inset-y-0 right-0 my-auto inline-flex items-center",
        "opacity-0 transition-opacity group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}
