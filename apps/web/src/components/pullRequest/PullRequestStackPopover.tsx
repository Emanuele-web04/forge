// FILE: PullRequestStackPopover.tsx
// Purpose: Compact stack position control plus a full bottom-to-top stack navigator for the
//          pull request detail header. GitHub stack state stays visible without duplicating a
//          second pull request surface.
// Layer: Pull request presentation
// Exports: PullRequestStackPopover

import type { PullRequestStack } from "@synara/contracts";
import { useState } from "react";

import { CHAT_HEADER_CONTROL_CLASS_NAME } from "~/components/chat/chatHeaderControls";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ArrowUpRightIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { PullRequestStateGlyph } from "./PullRequestStateGlyph";
import { PullRequestStackPosition } from "./PullRequestStackPosition";
import { assessPullRequestStack } from "./pullRequestStack.logic";

const ASSESSMENT_COLOR_CLASS = {
  ready: "text-status-open",
  blocked: "text-status-failure",
  pending: "text-muted-foreground",
  warning: "text-status-failure",
  complete: "text-status-merged",
} as const;

export function PullRequestStackPopover({
  stack,
  currentNumber,
  onSelectPullRequest,
}: {
  stack: PullRequestStack;
  currentNumber: number;
  onSelectPullRequest?: ((number: number) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const assessment = assessPullRequestStack(stack);
  const entriesTopDown = stack.entries.toReversed();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="chrome-outline"
            size="xs"
            className={cn(CHAT_HEADER_CONTROL_CLASS_NAME, "gap-1.5 px-2 font-normal")}
            aria-label={`View stack ${stack.number}, pull request ${stack.position} of ${stack.size}`}
            title={`Stack #${stack.number}`}
          >
            <PullRequestStackPosition stack={stack} appearance="plain" />
          </Button>
        }
      />
      <PopoverPopup
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-[min(26rem,calc(100vw-1rem))] p-0 [&_[data-slot=popover-viewport]]:p-0"
      >
        <div className="border-b border-border px-4 py-3">
          <div className={cn("text-sm font-medium", ASSESSMENT_COLOR_CLASS[assessment.tone])}>
            {assessment.label}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Stack #{stack.number} · targets {stack.baseBranch}
          </div>
        </div>

        <div className="max-h-[min(28rem,70vh)] overflow-y-auto py-1.5">
          {entriesTopDown.map((entry, index) => {
            const current = entry.number === currentNumber;
            return (
              <div key={entry.number} className="relative px-2">
                {index < entriesTopDown.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute left-[1.6875rem] top-8 h-[calc(100%-1rem)] w-px bg-border"
                  />
                ) : null}
                <button
                  type="button"
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "group relative flex w-full items-start gap-3 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
                    current
                      ? "bg-[var(--color-background-elevated-secondary)]"
                      : "hover:bg-[var(--color-background-elevated-secondary)]",
                  )}
                  onClick={() => {
                    setOpen(false);
                    if (!current) onSelectPullRequest?.(entry.number);
                  }}
                >
                  <PullRequestStateGlyph
                    state={entry.state}
                    isDraft={entry.isDraft}
                    mergeability={entry.mergeability}
                    className="mt-0.5 bg-[var(--color-background-elevated-primary-opaque)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{entry.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      #{entry.number} · {entry.headBranch}
                    </span>
                  </span>
                  {!current ? (
                    <ArrowUpRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                  ) : null}
                </button>
              </div>
            );
          })}

          <div className="relative mx-2 flex items-center gap-3 px-2 py-2 text-xs text-muted-foreground">
            <span aria-hidden="true" className="absolute -top-2 left-4 h-6 w-px bg-border" />
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-[var(--color-background-elevated-primary-opaque)]"
            />
            <span className="truncate">{stack.baseBranch}</span>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
