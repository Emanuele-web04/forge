// FILE: PullRequestRow.tsx
// Purpose: One row of the pull requests list — state glyph, truncating title (full title +
//          number in a tooltip), author avatar + repository + head branch on the second line,
//          relative time + muted diff stat, and a sibling pin control that never opens detail.
// Layer: Pull request presentation
// Exports: PullRequestRow

import type { PullRequestListEntry } from "@synara/contracts";
import { pullRequestListProjectContexts } from "@synara/shared/githubRepository";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PinStatusIcon, pinActionLabel } from "~/lib/pin";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import {
  PR_BODY_TEXT_CLASS_NAME,
  PR_FINE_TEXT_CLASS_NAME,
  PR_META_TEXT_CLASS_NAME,
  PR_QUIET_INK_CLASS_NAME,
} from "./pullRequestText";
import { PullRequestAvatar } from "./PullRequestAvatar";
import { PullRequestDiffStat } from "./PullRequestDiffStat";
import { PullRequestMetaLine } from "./PullRequestMetaLine";
import { PullRequestStateGlyph } from "./PullRequestStateGlyph";
import { PullRequestStackPosition } from "./PullRequestStackPosition";

function TruncatedTitle({ title, number }: { title: string; number: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              PR_BODY_TEXT_CLASS_NAME,
              "min-w-0 flex-1 truncate font-medium text-foreground",
            )}
          >
            {title}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        <p className={cn(PR_META_TEXT_CLASS_NAME)}>
          {title} <span className="text-muted-foreground">#{number}</span>
        </p>
      </TooltipPopup>
    </Tooltip>
  );
}

export const PullRequestRow = function PullRequestRow({
  entry,
  selected,
  showProjectTitle: showProjectTitleProp,
  showDiffColors: showDiffColorsProp,
  onClick,
  onTogglePinned,
}: {
  entry: PullRequestListEntry;
  selected: boolean;
  /** All-projects view: identifies the preferred local context used when opening the remote PR. */
  showProjectTitle?: boolean;
  showDiffColors?: boolean;
  onClick: (entry: PullRequestListEntry) => void;
  onTogglePinned: (entry: PullRequestListEntry) => void;
}) {
  const showProjectTitle = showProjectTitleProp ?? false;
  const showDiffColors = showDiffColorsProp ?? true;
  const isPinned = entry.isPinned === true;
  const projectContexts = pullRequestListProjectContexts(entry);
  const projectLabel =
    projectContexts.length > 1 ? `${projectContexts.length} projects` : entry.projectTitle;
  const projectTitle = projectContexts.map((context) => context.projectTitle).join(", ");
  const pinLabel = pinActionLabel(
    showProjectTitle
      ? `pull request #${entry.number} in ${projectLabel}`
      : `pull request #${entry.number}`,
    isPinned,
  );
  return (
    <div
      className={cn(
        // The row bleeds past the page padding and pays the same amount back as its own
        // padding, so the hover surface keeps a halo while the glyph and the title still sit
        // on the page heading's verticals. The width is explicit because the negative margin
        // shifts the row without widening it.
        "group -mx-3 flex w-[calc(100%+1.5rem)] items-stretch rounded-lg text-left transition-colors",
        selected
          ? "bg-[var(--color-background-elevated-secondary)]"
          : "hover:bg-[var(--color-background-elevated-secondary)]/70 focus-within:bg-[var(--color-background-elevated-secondary)]/70",
      )}
    >
      <button
        type="button"
        data-pull-request-row
        data-project-id={entry.projectId}
        data-repository={entry.repository}
        data-pull-request-number={entry.number}
        aria-current={selected ? "true" : undefined}
        onClick={() => onClick(entry)}
        className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg py-1.5 pl-3 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <PullRequestStateGlyph
          state={entry.state}
          isDraft={entry.isDraft}
          mergeability={entry.mergeability}
          size="md"
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <TruncatedTitle title={entry.title} number={entry.number} />
            {entry.stack ? <PullRequestStackPosition stack={entry.stack} /> : null}
          </span>
          {/* Fine print, set once on the line: author, repository and branch are one thought at
              one size — the branch used to be the only part stepped down, which made the line
              read as two. It also matches the time/diff column on the right. */}
          <span
            className={cn(
              PR_FINE_TEXT_CLASS_NAME,
              PR_QUIET_INK_CLASS_NAME,
              "mt-0.5 flex min-w-0 items-center gap-1.5",
            )}
          >
            {/* The avatar leads the line without a separator — it labels the row's author, it
                isn't one of the dot-separated facts about the PR. */}
            <PullRequestAvatar actor={entry.author} size="sm" className="shrink-0" />
            <PullRequestMetaLine className="flex-1">
              {showProjectTitle ? (
                <span className="max-w-[12rem] truncate" title={projectTitle}>
                  {projectLabel}
                </span>
              ) : null}
              <span className="truncate">{entry.repository}</span>
              <span
                className="max-w-[14rem] truncate"
                title={`${entry.headBranch} → ${entry.baseBranch}`}
              >
                {entry.headBranch}
              </span>
            </PullRequestMetaLine>
          </span>
        </span>
        <span
          className={cn(
            PR_FINE_TEXT_CLASS_NAME,
            PR_QUIET_INK_CLASS_NAME,
            "flex shrink-0 flex-col items-end gap-0.5 tabular-nums",
          )}
        >
          <span>{formatRelativeTime(entry.updatedAt)}</span>
          <PullRequestDiffStat
            additions={entry.additions}
            deletions={entry.deletions}
            tone={showDiffColors ? "diff" : "muted"}
          />
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={pinLabel}
              aria-pressed={entry.isPinned}
              onClick={() => onTogglePinned(entry)}
              className={cn(
                "my-auto mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,opacity] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isPinned
                  ? "text-foreground opacity-100"
                  : "opacity-70 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
              )}
            >
              <PinStatusIcon pinned={isPinned} className="size-3.5" aria-hidden />
            </button>
          }
        />
        <TooltipPopup side="top">{pinLabel}</TooltipPopup>
      </Tooltip>
    </div>
  );
};
