// FILE: SidebarSplitLinkIndicator.tsx
// Purpose: Marks split-view members that remain in separate sidebar containers.

import { Columns2Icon } from "../lib/icons";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SidebarSplitLinkIndicator({
  label,
  active,
  className,
}: {
  label: string;
  active: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            data-testid="sidebar-split-link-indicator"
            className={cn(
              "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/42",
              active ? "bg-primary/[0.06] text-primary/72" : null,
              className,
            )}
          >
            <Columns2Icon className="size-3" aria-hidden />
          </span>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
