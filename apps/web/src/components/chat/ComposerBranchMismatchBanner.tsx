// FILE: ComposerBranchMismatchBanner.tsx
// Purpose: Floating Codex-style notice explaining that sending from a settled
//          local thread will resume on the directory's current branch.
// Layer: Chat composer UI
// Exports: ComposerBranchMismatchBanner

import { ArrowRightIcon, TriangleAlertIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";

export function ComposerBranchMismatchBanner({
  threadBranch,
  currentBranch,
}: {
  threadBranch: string;
  currentBranch: string;
}) {
  return (
    <div
      className={cn(
        COMPOSER_INPUT_SURFACE_CLASS_NAME,
        "flex w-full min-w-0 items-center gap-3 px-4 py-3.5",
      )}
      data-testid="composer-branch-mismatch-warning"
      role="status"
    >
      <TriangleAlertIcon
        aria-hidden="true"
        className="size-4.5 shrink-0 text-[var(--color-text-foreground-secondary)]"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--app-font-size-ui,12px)] leading-5 font-medium text-foreground/95">
          Sending a message will move this thread to the current branch
        </p>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-5">
          <code
            className="max-w-[40%] truncate text-muted-foreground/80"
            title={`Thread branch: ${threadBranch}`}
          >
            {threadBranch}
          </code>
          <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/50" />
          <code
            className="min-w-0 truncate font-medium text-foreground/85"
            title={`Current branch: ${currentBranch}`}
          >
            {currentBranch}
          </code>
        </div>
      </div>
    </div>
  );
}
