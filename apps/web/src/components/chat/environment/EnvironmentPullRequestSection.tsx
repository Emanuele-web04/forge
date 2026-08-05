// FILE: EnvironmentPullRequestSection.tsx
// Purpose: "Pull request" section of the Environment panel — PR title link, live CI check
//          rollup, and open review comments with a one-click "Fix" handoff to the composer.
// Layer: Environment panel section
// Depends on: git status/PR-snapshot React Query helpers and the shared Environment row skin.

import type {
  GitPullRequestCheck,
  GitPullRequestComment,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { parseGitHubRepositoryNameWithOwnerFromPullRequestUrl } from "@synara/shared/githubRepository";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ComposerPickerMenuPopup } from "../ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuTrigger } from "../../ui/menu";
import { PullRequestCheckStatusIcon } from "../../pullRequest/PullRequestCheckStatusIcon";
import { PullRequestDiffStat } from "../../pullRequest/PullRequestDiffStat";
import { PullRequestConflictIcon } from "../../pullRequest/pullRequestStatePresentation";
import { PR_QUIET_INK_CLASS_NAME } from "../../pullRequest/pullRequestText";
import { appendComposerPromptText } from "~/lib/chatReferences";
import { gitPullRequestSnapshotQueryOptions, gitStatusQueryOptions } from "~/lib/gitReactQuery";
import {
  ArrowUpRightIcon,
  ChatBubbleIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  DiffIcon,
  GitPullRequestIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { useRightDockStore } from "~/rightDockStore";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentLabeledSection,
  EnvironmentRow,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";
import {
  buildFixReviewCommentsPrompt,
  buildResolveConflictsPrompt,
  describePullRequestComment,
  PULL_REQUEST_CHECK_STATUS_LABELS,
  PULL_REQUEST_CHECKS_TONE_TEXT_CLASS,
  summarizePullRequestChecks,
  summarizePullRequestComments,
  summarizePullRequestDiffStat,
  withStableCheckKeys,
  type PullRequestChecksTone,
} from "./environmentPullRequest.logic";

/** Inline "Fix" action that drafts a composer prompt from the PR's conflicts or comments. */
const PR_FIX_ACTION_CLASS_NAME = cn(
  "shrink-0 cursor-pointer rounded-md px-2 py-1 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)]",
  ELEVATED_HOVER_SURFACE_CLASS_NAME,
);

function checksToneIcon(tone: PullRequestChecksTone) {
  const colorClass = PULL_REQUEST_CHECKS_TONE_TEXT_CLASS[tone];
  switch (tone) {
    case "failure":
      return (
        <CircleAlertIcon className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, colorClass)} aria-hidden />
      );
    case "pending":
      return (
        <Loader2Icon
          className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "animate-spin", colorClass)}
          aria-hidden
        />
      );
    case "success":
      return (
        <CircleCheckIcon className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, colorClass)} aria-hidden />
      );
    default:
      return (
        <CircleCheckIcon
          className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "opacity-50")}
          aria-hidden
        />
      );
  }
}

// Popup row that is clickable only when it has a URL: plain div without one, MenuItem with one.
function MenuRow({
  url,
  onOpenUrl,
  className,
  children,
}: {
  url: string | null;
  onOpenUrl: (url: string) => void;
  className: string;
  children: ReactNode;
}) {
  if (!url) {
    return (
      <div className={cn("w-full cursor-default rounded-[0.5rem] text-left", className)}>
        {children}
      </div>
    );
  }

  return (
    <MenuItem
      onClick={() => onOpenUrl(url)}
      className={cn(
        "w-full cursor-pointer rounded-[0.5rem] text-left data-highlighted:bg-[var(--color-background-elevated-secondary)]",
        className,
      )}
    >
      {children}
    </MenuItem>
  );
}

function ChecksMenuRow({
  check,
  onOpenUrl,
}: {
  check: GitPullRequestCheck;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <MenuRow
      url={check.url}
      onOpenUrl={onOpenUrl}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 py-1 text-[length:var(--app-font-size-ui,12px)]"
    >
      <PullRequestCheckStatusIcon status={check.status} />
      <span className="min-w-0 truncate text-[var(--color-text-foreground)]">{check.name}</span>
      <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
        {PULL_REQUEST_CHECK_STATUS_LABELS[check.status]}
      </span>
    </MenuRow>
  );
}

function CommentsMenuRow({
  comment,
  onOpenUrl,
}: {
  comment: GitPullRequestComment;
  onOpenUrl: (url: string) => void;
}) {
  const display = describePullRequestComment(comment);
  return (
    // items-stretch overrides the menu-option default items-center for this column layout.
    <MenuRow
      url={comment.url}
      onOpenUrl={onOpenUrl}
      className="flex flex-col items-stretch gap-0.5 px-2 py-1.5"
    >
      <span className="line-clamp-2 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)]">
        {display.title}
      </span>
      {display.snippet ? (
        <span className="line-clamp-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
          {display.snippet}
        </span>
      ) : null}
      <span
        className={cn(
          PR_QUIET_INK_CLASS_NAME,
          "flex items-center justify-between gap-2 text-[length:var(--app-font-size-ui-xs,10px)]",
        )}
      >
        <span className="min-w-0 truncate">{comment.path ?? comment.author ?? ""}</span>
        {comment.createdAt ? (
          <span className="shrink-0 tabular-nums">{formatRelativeTime(comment.createdAt)}</span>
        ) : null}
      </span>
    </MenuRow>
  );
}

function MenuPlaceholder({ text }: { text: string }) {
  return (
    <div className="px-3 py-3 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
      {text}
    </div>
  );
}

export function EnvironmentPullRequestSection({
  gitCwd,
  enabled,
  activeThreadId,
  projectId,
  configuredRepositories,
  onOpenUrl,
  onClose,
}: {
  gitCwd: string | null;
  /** Gate polling on the panel being open (mirrors the Local Servers section). */
  enabled: boolean;
  activeThreadId: ThreadId | null;
  projectId: ProjectId | null;
  configuredRepositories: ReadonlyArray<{ readonly nameWithOwner: string }>;
  /** Open non-PR URLs in the in-app browser panel. */
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}) {
  const openPane = useRightDockStore((store) => store.openPane);
  // Shares the cached git status the git block already fetches — no extra RPC.
  const { data: gitStatus } = useQuery(gitStatusQueryOptions(gitCwd));
  const pr = gitStatus?.pr ?? null;

  const snapshotQuery = useQuery(
    gitPullRequestSnapshotQueryOptions({
      cwd: gitCwd,
      reference: pr?.url ?? null,
      enabled: enabled && pr !== null && pr.state === "open",
    }),
  );

  // The snapshot's own PR summary is fresher than the cached git status: prefer its
  // title/number/url for display, and when it reports the PR merged/closed between
  // git-status polls, swap the checks/comments rows for a state note instead of
  // rendering stale "open" data.
  const livePr = snapshotQuery.data?.pullRequest ?? null;
  const displayPr = livePr ?? pr;

  if (!pr || pr.state !== "open" || !displayPr) {
    return null;
  }

  const settledState = displayPr.state !== "open" ? displayPr.state : null;
  const diffStat = summarizePullRequestDiffStat(displayPr);
  const hasConflicts = settledState === null && displayPr.mergeability === "conflicting";
  const pullRequestRepository = parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(displayPr.url);
  const repositoryBelongsToProject = configuredRepositories.some(
    (repository) => repository.nameWithOwner.toLowerCase() === pullRequestRepository?.toLowerCase(),
  );
  const openPullRequest = (initialTab: "summary" | "code" = "summary") => {
    if (activeThreadId && projectId && pullRequestRepository && repositoryBelongsToProject) {
      openPane(activeThreadId, {
        kind: "pullRequest",
        pullRequestProjectId: projectId,
        pullRequestRepository,
        pullRequestNumber: displayPr.number,
        pullRequestInitialTab: initialTab,
      });
    } else {
      onOpenUrl(initialTab === "code" ? `${displayPr.url}/files` : displayPr.url);
    }
    onClose();
  };

  const checks = snapshotQuery.data?.checks ?? [];
  const comments = snapshotQuery.data?.comments ?? [];
  const commentsTruncated = snapshotQuery.data?.commentsTruncated ?? false;
  const commentsError = snapshotQuery.data?.commentsError ?? null;
  const checksSummary = summarizePullRequestChecks(checks);
  const loading = snapshotQuery.isLoading;
  // Any failed refetch should be visible; otherwise stale rows look current.
  const failed = snapshotQuery.isError;

  // Fix actions keep the PR context visible while the user reviews the generated draft.
  const handleFixComments = () => {
    if (!activeThreadId || comments.length === 0) {
      return;
    }
    appendComposerPromptText(
      activeThreadId,
      buildFixReviewCommentsPrompt({
        prNumber: displayPr.number,
        prUrl: displayPr.url,
        comments,
        commentsTruncated,
      }),
    );
  };

  const handleResolveConflicts = () => {
    if (!activeThreadId) {
      return;
    }
    appendComposerPromptText(
      activeThreadId,
      buildResolveConflictsPrompt({
        prNumber: displayPr.number,
        prUrl: displayPr.url,
        baseBranch: displayPr.baseBranch,
        headBranch: displayPr.headBranch,
      }),
    );
  };

  return (
    <EnvironmentLabeledSection label="Pull request">
      <EnvironmentRow
        icon={<GitPullRequestIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{`#${displayPr.number} ${displayPr.title}`}</span>
            {displayPr.isDraft ? (
              <span className="shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 py-px text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
                Draft
              </span>
            ) : null}
          </span>
        }
        trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
        onClick={() => {
          openPullRequest();
        }}
      />

      {diffStat ? (
        <EnvironmentRow
          icon={<DiffIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label={
            <span className="flex min-w-0 items-center gap-1.5">
              <PullRequestDiffStat
                additions={diffStat.additions}
                deletions={diffStat.deletions}
                tone="diff"
              />
              {diffStat.filesLabel ? (
                <span className="truncate text-muted-foreground">{diffStat.filesLabel}</span>
              ) : null}
            </span>
          }
          trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          title="Open pull request file changes"
          onClick={() => {
            openPullRequest("code");
          }}
        />
      ) : null}

      {hasConflicts ? (
        <div className="flex w-full items-center gap-1">
          <EnvironmentRow
            className="min-w-0 flex-1"
            // Same glyph and same red as the PR badge one dock away: this row used to say
            // conflicts with a generic amber alert, which read as a softer problem than the
            // state it mirrors.
            icon={<PullRequestConflictIcon className="size-4" />}
            label={<span className="truncate">{`Conflicts with ${displayPr.baseBranch}`}</span>}
            trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
            onClick={() => {
              openPullRequest();
            }}
          />
          {activeThreadId ? (
            <button
              type="button"
              onClick={handleResolveConflicts}
              title="Drafts a prompt in the composer asking the agent to resolve the merge conflicts — review it, then send"
              className={PR_FIX_ACTION_CLASS_NAME}
            >
              Fix
            </button>
          ) : null}
        </div>
      ) : null}

      {settledState ? (
        <EnvironmentRow
          icon={
            settledState === "merged" ? (
              <CircleCheckIcon
                className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "text-success")}
                aria-hidden
              />
            ) : (
              <CircleAlertIcon
                className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "opacity-60")}
                aria-hidden
              />
            )
          }
          label={settledState === "merged" ? "Merged on GitHub" : "Closed on GitHub"}
          trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          onClick={() => {
            openPullRequest();
          }}
        />
      ) : failed ? (
        <EnvironmentRow
          icon={
            <CircleAlertIcon
              className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "text-destructive")}
              aria-hidden
            />
          }
          label="Couldn't load PR data"
          trailing={
            <RefreshCwIcon
              className={cn("size-3 shrink-0", snapshotQuery.isFetching && "animate-spin")}
              aria-hidden
            />
          }
          title="Retry loading checks and review comments"
          onClick={() => void snapshotQuery.refetch()}
        />
      ) : (
        <>
          <Menu>
            <MenuTrigger
              render={
                <button type="button" className={ENVIRONMENT_ROW_CLASS_NAME} disabled={loading} />
              }
            >
              <EnvironmentRowBody
                icon={
                  loading ? (
                    <RefreshCwIcon
                      className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "animate-spin")}
                      aria-hidden
                    />
                  ) : (
                    checksToneIcon(checksSummary.tone)
                  )
                }
                label={loading ? "Loading checks…" : checksSummary.label}
                trailing={<EnvironmentRowChevron />}
              />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="start" side="bottom" className="w-72 min-w-72">
              {checks.length === 0 ? (
                <MenuPlaceholder text="No checks reported for this PR." />
              ) : (
                <div className="flex flex-col gap-0.5">
                  {withStableCheckKeys(checks).map(({ key, check }) => (
                    <ChecksMenuRow
                      key={key}
                      check={check}
                      onOpenUrl={(url) => {
                        onOpenUrl(url);
                        onClose();
                      }}
                    />
                  ))}
                </div>
              )}
            </ComposerPickerMenuPopup>
          </Menu>

          {/* The summary opens details; its sibling Fix drafts the entire visible batch. */}
          <div className="flex w-full items-center gap-1">
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className={cn(ENVIRONMENT_ROW_CLASS_NAME, "min-w-0 flex-1")}
                    disabled={loading}
                  />
                }
              >
                <EnvironmentRowBody
                  icon={<ChatBubbleIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
                  label={
                    loading
                      ? "Loading comments…"
                      : commentsError
                        ? "Comments unavailable"
                        : summarizePullRequestComments(comments.length, commentsTruncated)
                  }
                  trailing={<EnvironmentRowChevron />}
                />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" side="bottom" className="w-80 min-w-80">
                {commentsError ? (
                  <MenuPlaceholder text={`Couldn't load review comments: ${commentsError}`} />
                ) : comments.length === 0 ? (
                  <MenuPlaceholder
                    text={
                      commentsTruncated
                        ? "Review comments may be hidden by the bounded preview. Open the PR on GitHub."
                        : "No unresolved review comments."
                    }
                  />
                ) : (
                  <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                    {comments.map((comment) => (
                      <CommentsMenuRow
                        key={comment.id}
                        comment={comment}
                        onOpenUrl={(url) => {
                          onOpenUrl(url);
                          onClose();
                        }}
                      />
                    ))}
                    {commentsTruncated ? (
                      <MenuPlaceholder text="More review comments may be available on GitHub." />
                    ) : null}
                  </div>
                )}
              </ComposerPickerMenuPopup>
            </Menu>
            {!commentsError && comments.length > 0 && activeThreadId ? (
              <button
                type="button"
                onClick={handleFixComments}
                title="Draft one prompt containing all visible review comments"
                className={PR_FIX_ACTION_CLASS_NAME}
              >
                Fix
              </button>
            ) : null}
          </div>
        </>
      )}
    </EnvironmentLabeledSection>
  );
}
