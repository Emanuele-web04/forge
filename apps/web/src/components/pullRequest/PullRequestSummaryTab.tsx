// FILE: PullRequestSummaryTab.tsx
// Purpose: The Summary tab of the pull request detail surface — title + author line, plain
//          meta rows (branch, reviewers, comments, checks), and the Description / Checks /
//          Comments disclosure sections. Pure presentation over an already-loaded detail;
//          all queries, actions, and tab switching stay in PullRequestDetailPanel.
// Layer: Pull request presentation
// Exports: PullRequestSummaryTab

import type { PullRequestDetail } from "@synara/contracts";
import { useState, type ReactNode } from "react";

import {
  PULL_REQUEST_CHECK_STATUS_LABELS,
  summarizePullRequestChecks,
  summarizePullRequestComments,
  withStableCheckKeys,
} from "~/components/chat/environment/environmentPullRequest.logic";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { ChatBubbleIcon, GitBranchIcon, UsersIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { ensureNativeApi } from "~/nativeApi";
import { describePullRequestState, buildPullRequestDetailModel } from "./pullRequestDetail.logic";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestCheckStatusIcon } from "./PullRequestCheckStatusIcon";
import { PullRequestConflictIcon } from "./pullRequestStatePresentation";
import { PullRequestMetaLine } from "./PullRequestMetaLine";
import { PullRequestChecksRing } from "./PullRequestChecksRing";
import { PullRequestCommentCard } from "./PullRequestCommentCard";
import { PullRequestCommentComposer } from "./PullRequestCommentComposer";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestDiffStat } from "./PullRequestDiffStat";
import { PullRequestWarningNote } from "./PullRequestWarningNote";
import {
  PR_BODY_TEXT_CLASS_NAME,
  PR_FINE_TEXT_CLASS_NAME,
  PR_META_TEXT_CLASS_NAME,
  PR_SECTION_TITLE_TEXT_CLASS_NAME,
} from "./pullRequestText";
import { cn } from "~/lib/utils";

/** A branch name in the Branch meta row (head and base render identically). Plain text at the
 *  row's own size — no chip, no width cap: it gives up characters only once the row genuinely
 *  runs out of room, and then shrinks proportionally, so the long head branch yields before a
 *  short base like `main`. The title carries the full name for the truncated case. */
function BranchName({ name }: { name: string }) {
  return (
    <span className="min-w-0 truncate" title={name}>
      {name}
    </span>
  );
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(PR_META_TEXT_CLASS_NAME, "flex items-center gap-2 py-1.5")}>
      <span className="flex w-24 shrink-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
    </div>
  );
}

function pullRequestProviderLabel(provider: PullRequestDetail["provider"]): string {
  return provider === "bitbucket" ? "Bitbucket" : "GitHub";
}

function commentsAvailabilityWarning(detail: PullRequestDetail): string | null {
  const providerLabel = pullRequestProviderLabel(detail.provider);
  if (detail.commentsIncomplete) {
    return `Some unresolved review comments could not be loaded. Check ${providerLabel} for the complete review.`;
  }
  if (detail.commentsTruncated) {
    return `More unresolved review comments may be available on ${providerLabel}.`;
  }
  return null;
}

function DisclosureSection({
  label,
  count,
  children,
  defaultOpen: defaultOpenProp,
}: {
  label: string;
  count?: number | undefined;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const defaultOpen = defaultOpenProp ?? true;
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {/* Reference layout: title first, chevron riding to its right, count after — the
          section reads as a heading with an affordance, not a tree node. */}
      <CollapsibleTrigger
        className={cn(
          PR_SECTION_TITLE_TEXT_CLASS_NAME,
          "flex w-full items-center gap-1.5 border-t border-border/60 px-5 py-3 text-left font-medium",
        )}
      >
        <span>{label}</span>
        <DisclosureChevron open={open} />
        {count === undefined ? null : (
          <span className={cn(PR_META_TEXT_CLASS_NAME, "tabular-nums text-muted-foreground")}>
            {count}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="px-5 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function PullRequestSummaryTab({ detail }: { detail: PullRequestDetail }) {
  const checks = detail.checks ?? [];
  const commentsWarning = commentsAvailabilityWarning(detail);
  const detailModel = buildPullRequestDetailModel(detail);
  return (
    <div className="h-full overflow-y-auto">
      <section className="space-y-4 px-5 py-5">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-snug">{detail.title}</h1>
          {/* Muted line, with the author the one thing lifted out of it. */}
          <PullRequestMetaLine
            className={cn(PR_META_TEXT_CLASS_NAME, "mt-1.5 flex-wrap text-muted-foreground")}
          >
            <PullRequestActorLabel actor={detail.author} className="font-medium text-foreground" />
            <span>{formatRelativeTime(detail.updatedAt)}</span>
            <span>{describePullRequestState(detail.state, detail.isDraft)}</span>
          </PullRequestMetaLine>
        </div>
        <div>
          <MetaRow icon={<GitBranchIcon className="size-3.5" />} label="Branch">
            {/* One line: the branch names absorb every pixel the row has spare, and only the
                separator and the counts are pinned. */}
            <span className="flex items-center gap-1.5">
              <BranchName name={detail.headBranch} />
              <span className="shrink-0 text-muted-foreground">›</span>
              <BranchName name={detail.baseBranch} />
              <PullRequestDiffStat
                additions={detail.additions}
                deletions={detail.deletions}
                tone="diff"
                className="ml-1 shrink-0"
              />
            </span>
          </MetaRow>
          {/* Conflicts are a merge signal, not a state: git keeps draft/open orthogonal to
              mergeability. Red stays on the glyph only — the row text reads like the other
              meta rows, and the call to action lives in the header (a disabled Merge pill
              that says why, plus "Resolve conflicts" in its "…" menu). */}
          {detail.state === "open" && detail.mergeability === "conflicting" ? (
            <MetaRow icon={<PullRequestConflictIcon className="size-3.5" />} label="Merge">
              Conflicts with {detail.baseBranch}
            </MetaRow>
          ) : null}
          <MetaRow icon={<UsersIcon className="size-3.5" />} label="Reviewers">
            {detail.reviewers.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <span className="flex flex-wrap items-center gap-1.5">
                {detail.reviewers.map((actor) => (
                  <PullRequestActorLabel
                    key={actor.login}
                    actor={actor}
                    className={cn(PR_FINE_TEXT_CLASS_NAME, "max-w-[8rem]")}
                  />
                ))}
              </span>
            )}
          </MetaRow>
          <MetaRow icon={<ChatBubbleIcon className="size-3.5" />} label="Comments">
            {summarizePullRequestComments(detail.comments.length)}
          </MetaRow>
          {/* Tone tinting intentionally omitted: the summary reads as plain metadata
              here, matching the muted meta rows around it. */}
          <MetaRow icon={<PullRequestChecksRing checks={checks} />} label="Checks">
            {detail.checks === null ? "Unavailable" : summarizePullRequestChecks(checks).label}
          </MetaRow>
        </div>
      </section>
      {/* No edit pencil here: there is no backend "edit PR description" action to back it. */}
      <DisclosureSection label="Description">
        <PullRequestMarkdown
          text={detail.body}
          fallback="_No description provided._"
          cwd={detail.workspaceRoot}
        />
      </DisclosureSection>
      <DisclosureSection label="Checks" count={detail.checks === null ? undefined : checks.length}>
        <div className="space-y-1">
          {detail.checks === null ? (
            <p className={cn(PR_META_TEXT_CLASS_NAME, "text-muted-foreground")}>
              Checks are unavailable from this provider.
            </p>
          ) : checks.length === 0 ? (
            <p className={cn(PR_META_TEXT_CLASS_NAME, "text-muted-foreground")}>
              No checks reported.
            </p>
          ) : (
            withStableCheckKeys(checks).map(({ key, check }) => (
              <button
                key={key}
                type="button"
                disabled={!check.url}
                onClick={() => check.url && void ensureNativeApi().shell.openExternal(check.url)}
                className={cn(
                  PR_META_TEXT_CLASS_NAME,
                  // The row bleeds past the panel padding and pays the same amount back as
                  // its own padding, so the hover surface keeps a halo while the glyph and
                  // the status label still sit on the section title's verticals. The width
                  // is explicit because a button sizes to fit-content, not to its parent.
                  "-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 disabled:hover:bg-transparent",
                )}
              >
                <PullRequestCheckStatusIcon status={check.status} />
                <span className="min-w-0 flex-1 truncate">{check.name}</span>
                <span className="text-muted-foreground">
                  {PULL_REQUEST_CHECK_STATUS_LABELS[check.status]}
                </span>
              </button>
            ))
          )}
        </div>
      </DisclosureSection>
      {/* Open by default so the comment composer is immediately reachable. */}
      <DisclosureSection label="Comments" count={detail.comments.length}>
        <div className="space-y-2">
          {commentsWarning ? (
            <PullRequestWarningNote>{commentsWarning}</PullRequestWarningNote>
          ) : null}
          {detail.comments.length === 0 ? (
            <p className={cn(PR_BODY_TEXT_CLASS_NAME, "py-4 text-center text-muted-foreground")}>
              No comments
            </p>
          ) : (
            <div>
              {detail.comments.map((comment, index) => (
                <PullRequestCommentCard
                  key={comment.id}
                  comment={comment}
                  prUrl={detail.url}
                  workspaceRoot={detail.workspaceRoot}
                  canReply={detailModel.showCommentComposer}
                  defaultOpen={index >= detail.comments.length - 2}
                />
              ))}
            </div>
          )}
          {detailModel.showCommentComposer ? <PullRequestCommentComposer detail={detail} /> : null}
        </div>
      </DisclosureSection>
    </div>
  );
}
