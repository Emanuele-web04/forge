// FILE: PrStateChip.tsx
// Purpose: Compact PR chip (state icon + #number, hover title) shared by the
//          kanban card meta row and the sidebar Activity rows.
// Layer: UI component (pure)
// Exports: PrStateChip

import type { OrchestrationThreadPullRequest } from "@synara/contracts";

import { cn } from "~/lib/utils";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";
import { PR_FINE_TEXT_CLASS_NAME } from "./pullRequestText";

export function PrStateChip({
  pr,
  className,
}: {
  pr: OrchestrationThreadPullRequest;
  className?: string;
}) {
  const presentation = resolvePrStatePresentation(pr);
  const PrIcon = PR_STATE_PRESENTATION_ICONS[presentation.iconKind];
  return (
    <span
      title={`#${pr.number} ${presentation.label}: ${pr.title}`}
      className={cn(
        // The PR type scale, not a pixel: this chip is the same fine print as every other PR
        // surface, so it tracks the user's font-size setting with them.
        PR_FINE_TEXT_CLASS_NAME,
        "flex shrink-0 items-center gap-0.5",
        presentation.colorClass,
        className,
      )}
    >
      <PrIcon className="size-3 shrink-0" aria-hidden />#{pr.number}
    </span>
  );
}
