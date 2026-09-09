// FILE: EnvironmentPullRequestSection.tsx
// Purpose: "Pull request" section of the Environment panel — one row (state glyph, title,
//          live check status) that opens the PR action menu: view / code changes, the
//          checks and review-comment lists, Repair (hands comments, failing checks, or
//          conflicts to the composer as context cards), Merge, Add to chat, Status, and
//          Open in GitHub.
// Layer: Environment panel section
// Depends on: git status/PR-snapshot React Query helpers, the pull request action mutation,
//             and the shared Environment row skin.

import type {
  GitPullRequestCheck,
  GitPullRequestComment,
  ProjectId,
  PullRequestAction,
  PullRequestDetailInput,
  PullRequestMergeMethod,
  ThreadId,
} from "@synara/contracts";
import { githubAvatarUrlForLogin } from "@synara/shared/githubAvatar";
import { parseGitHubRepositoryNameWithOwnerFromPullRequestUrl } from "@synara/shared/githubRepository";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "../ComposerPickerMenuPopup";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import { PullRequestAvatar } from "../../pullRequest/PullRequestAvatar";
import { PullRequestCheckStatusIcon } from "../../pullRequest/PullRequestCheckStatusIcon";
import { PullRequestDiffStat } from "../../pullRequest/PullRequestDiffStat";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "../../pullRequest/pullRequestStatePresentation";
import { PR_QUIET_INK_CLASS_NAME } from "../../pullRequest/pullRequestText";
import {
  assessPullRequestStack,
  pullRequestMergeBlocker,
} from "../../pullRequest/pullRequestStack.logic";
import { addChatPullRequestContext } from "~/lib/chatReferences";
import { gitPullRequestSnapshotQueryOptions, gitStatusQueryOptions } from "~/lib/gitReactQuery";
import {
  ChatBubbleIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  DiffIcon,
  ExternalLinkIcon,
  FileIcon,
  GitMergeConflictIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HammerIcon,
  Loader2Icon,
  MessageCircleIcon,
  RefreshCwIcon,
} from "~/lib/icons";
import {
  pullRequestActionMutationOptions,
  pullRequestDetailQueryOptions,
} from "~/lib/pullRequestReactQuery";
import { type PullRequestContextScope } from "~/lib/pullRequestContext";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
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
  buildPullRequestContextCard,
  describePullRequestComment,
  PULL_REQUEST_CHECK_STATUS_LABELS,
  PULL_REQUEST_CHECKS_TONE_TEXT_CLASS,
  summarizePullRequestChecks,
  summarizePullRequestComments,
  summarizePullRequestDiffStat,
  summarizePullRequestRepairs,
  withStableCheckKeys,
  type PullRequestChecksTone,
} from "./environmentPullRequest.logic";

const MENU_ICON_CLASS_NAME = "size-3.5 shrink-0";
/** Right-aligned secondary value on a menu row (diff stat, count, current status).
 *  The label grows instead of this span using `ml-auto`: sub-trigger chevrons already carry
 *  `margin-inline-start: auto`, and two auto margins would split the free space and float
 *  the value mid-row instead of flush against the chevron. */
const MENU_TRAILING_CLASS_NAME = "shrink-0 pl-3 text-muted-foreground tabular-nums";
/** The root menu opens to the left of the docked panel, so submenus keep cascading that way
 *  instead of folding back over the panel. Base UI flips them when there is no room. */
const SUBMENU_SIDE = "inline-start";

const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

const ACTION_SUCCESS_TITLES: Record<PullRequestAction, string> = {
  merge: "Pull request merged",
  ready: "Marked ready for review",
  draft: "Converted to draft",
  close: "Pull request closed",
  reopen: "Pull request reopened",
};

function checksToneIcon(tone: PullRequestChecksTone) {
  const colorClass = PULL_REQUEST_CHECKS_TONE_TEXT_CLASS[tone];
  switch (tone) {
    case "failure":
      return <CircleAlertIcon className={cn("size-3.5 shrink-0", colorClass)} aria-hidden />;
    case "pending":
      return (
        <Loader2Icon className={cn("size-3.5 shrink-0 animate-spin", colorClass)} aria-hidden />
      );
    case "success":
      return <CircleCheckIcon className={cn("size-3.5 shrink-0", colorClass)} aria-hidden />;
    default:
      return <CircleCheckIcon className="size-3.5 shrink-0 opacity-50" aria-hidden />;
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
        {comment.author ? (
          <span className="shrink-0" title={comment.author}>
            <PullRequestAvatar
              actor={{
                login: comment.author,
                name: null,
                // Review-thread authors are users or bots, never team slugs, so the
                // login-derived avatar is safe here (same as pullRequestOperations).
                avatarUrl: githubAvatarUrlForLogin(comment.author),
                url: null,
              }}
            />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{comment.path ?? comment.author ?? ""}</span>
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

/** Menu row label + optional trailing value, laid out like the reference PR menu. */
function MenuRowLabel({
  icon,
  label,
  trailing,
}: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? <span className={MENU_TRAILING_CLASS_NAME}>{trailing}</span> : null}
    </>
  );
}

export function EnvironmentPullRequestSection({
  gitCwd,
  enabled,
  activeThreadId,
  projectId,
  configuredRepositories,
  showDiffColors: showDiffColorsProp,
  onOpenUrl,
  onClose,
}: {
  gitCwd: string | null;
  /** Gate polling on the panel being open (mirrors the Local Servers section). */
  enabled: boolean;
  activeThreadId: ThreadId | null;
  projectId: ProjectId | null;
  configuredRepositories: ReadonlyArray<{ readonly nameWithOwner: string }>;
  showDiffColors?: boolean;
  /** Open non-PR URLs in the in-app browser panel. */
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}) {
  const showDiffColors = showDiffColorsProp ?? true;
  const openPane = useRightDockStore((store) => store.openPane);
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState<PullRequestMergeMethod | null>(null);
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
  // git-status polls, show a state row instead of rendering stale "open" data.
  const livePr = snapshotQuery.data?.pullRequest ?? null;
  const displayPr = livePr ?? pr;

  const pullRequestRepository = displayPr
    ? parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(displayPr.url)
    : null;
  const repositoryBelongsToProject = configuredRepositories.some(
    (repository) => repository.nameWithOwner.toLowerCase() === pullRequestRepository?.toLowerCase(),
  );
  // Merge / Status go through the GitHub-backed PR actions, which are keyed by project +
  // repository. A PR from a repository the project does not own only gets link actions.
  const actionInput: PullRequestDetailInput | null =
    displayPr && projectId && pullRequestRepository && repositoryBelongsToProject
      ? { projectId, repository: pullRequestRepository, number: displayPr.number }
      : null;
  // Merge capabilities (allowed methods, stack state) only live on the detail query. Fetch
  // it lazily while the menu is open so the row itself stays as cheap as before.
  const detailQuery = useQuery({
    ...pullRequestDetailQueryOptions(actionInput, { pollingEnabled: false }),
    enabled: actionInput !== null && menuOpen && displayPr?.state === "open",
  });
  const actionMutation = useMutation(pullRequestActionMutationOptions(queryClient));

  if (!pr || pr.state !== "open" || !displayPr) {
    return null;
  }

  const settledState = displayPr.state !== "open" ? displayPr.state : null;
  const diffStat = summarizePullRequestDiffStat(displayPr);
  const checks = snapshotQuery.data?.checks ?? [];
  const comments = snapshotQuery.data?.comments ?? [];
  const commentsTruncated = snapshotQuery.data?.commentsTruncated ?? false;
  const commentsError = snapshotQuery.data?.commentsError ?? null;
  const checksSummary = summarizePullRequestChecks(checks);
  const repairs = summarizePullRequestRepairs({
    checks,
    comments,
    mergeability: displayPr.mergeability,
  });
  const loading = snapshotQuery.isLoading;
  // Any failed refetch should be visible; otherwise stale rows look current.
  const failed = snapshotQuery.isError;
  const statePresentation = resolvePrStatePresentation(displayPr);
  const StateIcon = PR_STATE_PRESENTATION_ICONS[statePresentation.iconKind];

  const openPullRequest = (initialTab: "summary" | "code" = "summary") => {
    if (activeThreadId && actionInput) {
      openPane(activeThreadId, {
        kind: "pullRequest",
        pullRequestProjectId: actionInput.projectId,
        pullRequestRepository: actionInput.repository,
        pullRequestNumber: displayPr.number,
        pullRequestInitialTab: initialTab,
      });
    } else {
      onOpenUrl(initialTab === "code" ? `${displayPr.url}/files` : displayPr.url);
    }
    onClose();
  };

  const openInGitHub = () => {
    void ensureNativeApi()
      .shell.openExternal(displayPr.url)
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not open GitHub",
          description: error instanceof Error ? error.message : "The link could not be opened.",
        });
      });
    onClose();
  };

  // Repair / Add to chat attach a context card to the composer; the panel closes so the
  // new bubble is visible above the editor right away.
  const attachContextCard = (scope: PullRequestContextScope) => {
    if (!activeThreadId) {
      return;
    }
    const card = buildPullRequestContextCard({
      scope,
      pr: displayPr,
      checks,
      comments,
      commentsTruncated,
    });
    if (!card) {
      return;
    }
    if (addChatPullRequestContext(activeThreadId, card)) {
      onClose();
    }
  };

  const runAction = (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (!actionInput || actionMutation.isPending) {
      return;
    }
    void actionMutation
      .mutateAsync({ ...actionInput, action, ...(method ? { mergeMethod: method } : {}) })
      .then((result) => {
        toastManager.add({
          type: "success",
          title:
            action === "merge" && result.mergeOutcome === "enqueued"
              ? "Pull request added to merge queue"
              : ACTION_SUCCESS_TITLES[action],
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Pull request action failed",
          description: error instanceof Error ? error.message : "GitHub CLI action failed.",
        });
      });
  };

  const actionPending = actionMutation.isPending;
  const detail = detailQuery.data ?? null;
  const stackAssessment = detail?.stack ? assessPullRequestStack(detail.stack) : null;
  // Merge is gated on the detail query: the git snapshot knows nothing about allowed merge
  // methods, stack state, or review blockers, so offering Merge before detail resolves could
  // send an action GitHub rejects. Until then the entry stays disabled with a status hint.
  const allowedMergeMethods: PullRequestMergeMethod[] = detail
    ? (["merge", "squash", "rebase"] as const).filter((method) => detail.mergeCapabilities[method])
    : [];
  // Local snapshot facts first (draft, conflicts) so the reason shows before detail loads.
  const mergeBlocker = displayPr.isDraft
    ? "Mark the pull request ready for review before merging"
    : displayPr.mergeability === "conflicting"
      ? "Resolve merge conflicts before merging"
      : detail
        ? (pullRequestMergeBlocker(detail, stackAssessment) ??
          (allowedMergeMethods.length === 0
            ? "No merge method is allowed for this repository"
            : null))
        : null;
  const mergeDetailStatus: "ready" | "loading" | "error" =
    mergeBlocker !== null || detail ? "ready" : detailQuery.isError ? "error" : "loading";
  const mergeDisabled = actionPending || mergeBlocker !== null || mergeDetailStatus !== "ready";
  const mergeTrailing =
    mergeBlocker !== null
      ? "Blocked"
      : mergeDetailStatus === "loading"
        ? "Loading…"
        : mergeDetailStatus === "error"
          ? "Unavailable"
          : null;
  const canRunActions = actionInput !== null && settledState === null;
  const repairDisabled = loading || failed || !activeThreadId || repairs.total === 0;
  const stateLabel = settledState
    ? settledState === "merged"
      ? "Merged"
      : "Closed"
    : displayPr.isDraft
      ? "Draft"
      : "Ready for review";

  const rowTrailing = settledState ? (
    <span className={cn("text-muted-foreground", PR_QUIET_INK_CLASS_NAME)}>{stateLabel}</span>
  ) : loading ? (
    <RefreshCwIcon className="size-3.5 shrink-0 animate-spin opacity-60" aria-hidden />
  ) : failed ? (
    <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />
  ) : (
    checksToneIcon(checksSummary.tone)
  );
  const rowTitle = settledState
    ? `${stateLabel} on GitHub`
    : loading
      ? "Loading checks and comments…"
      : failed
        ? "Couldn't load PR data"
        : checksSummary.label;

  return (
    <EnvironmentLabeledSection label="Pull request">
      <Menu open={menuOpen} onOpenChange={setMenuOpen} keepOpenOnSubmenuInteraction>
        <MenuTrigger
          render={<button type="button" className={ENVIRONMENT_ROW_CLASS_NAME} title={rowTitle} />}
        >
          <EnvironmentRowBody
            icon={
              <StateIcon
                className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, statePresentation.colorClass)}
                aria-hidden
              />
            }
            label={
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{`#${displayPr.number} ${displayPr.title}`}</span>
              </span>
            }
            trailing={
              <>
                {rowTrailing}
                <EnvironmentRowChevron />
              </>
            }
          />
        </MenuTrigger>
        {/* Opens beside the row (the panel docks on the right, so screen-left) like a hover
            card, rather than dropping down over the rest of the panel. Base UI flips it to
            the other side when there is no room, and falls back below the row when neither
            side fits (narrow windows). */}
        <ComposerPickerMenuPopup
          align="start"
          side="left"
          sideOffset={8}
          collisionAvoidance={{ fallbackAxisSide: "end" }}
          className="w-72 min-w-72"
        >
          <MenuItem onClick={() => openPullRequest()}>
            <MenuRowLabel
              icon={<FileIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
              label="View PR"
            />
          </MenuItem>
          <MenuItem onClick={() => openPullRequest("code")}>
            <MenuRowLabel
              icon={<DiffIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
              label="Code changes"
              trailing={
                diffStat ? (
                  <PullRequestDiffStat
                    additions={diffStat.additions}
                    deletions={diffStat.deletions}
                    tone={showDiffColors ? "diff" : "muted"}
                  />
                ) : null
              }
            />
          </MenuItem>

          {settledState === null ? (
            <>
              <MenuSub keepOpenOnFocusOut>
                <MenuSubTrigger disabled={loading}>
                  <MenuRowLabel
                    icon={checksToneIcon(checksSummary.tone)}
                    label="Checks"
                    trailing={loading ? "Loading…" : failed ? "Unavailable" : checksSummary.label}
                  />
                </MenuSubTrigger>
                <ComposerPickerMenuSubPopup side={SUBMENU_SIDE} className="w-72 min-w-72">
                  {failed ? (
                    <MenuItem onClick={() => void snapshotQuery.refetch()}>
                      <MenuRowLabel
                        icon={<RefreshCwIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                        label="Retry loading checks"
                      />
                    </MenuItem>
                  ) : checks.length === 0 ? (
                    <MenuPlaceholder text="No checks reported for this PR." />
                  ) : (
                    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto [&>*]:shrink-0">
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
                </ComposerPickerMenuSubPopup>
              </MenuSub>
              <MenuSub keepOpenOnFocusOut>
                <MenuSubTrigger disabled={loading}>
                  <MenuRowLabel
                    icon={<ChatBubbleIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                    label="Comments"
                    trailing={
                      loading
                        ? "Loading…"
                        : failed || commentsError
                          ? "Unavailable"
                          : summarizePullRequestComments(comments.length, commentsTruncated)
                    }
                  />
                </MenuSubTrigger>
                <ComposerPickerMenuSubPopup side={SUBMENU_SIDE} className="w-80 min-w-80">
                  {failed ? (
                    <MenuItem onClick={() => void snapshotQuery.refetch()}>
                      <MenuRowLabel
                        icon={<RefreshCwIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                        label="Retry loading comments"
                      />
                    </MenuItem>
                  ) : commentsError ? (
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
                    // shrink-0 children: when the list overflows max-h-64, flex would otherwise
                    // shrink the rows (their line-clamp overflow-hidden spans have no automatic
                    // minimum size) and clip the text instead of scrolling.
                    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto [&>*]:shrink-0">
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
                </ComposerPickerMenuSubPopup>
              </MenuSub>

              {/* Repair hands work to the composer as a context card (never pasted text). */}
              <MenuSub keepOpenOnFocusOut>
                <MenuSubTrigger disabled={repairDisabled} data-testid="pr-repair-trigger">
                  <MenuRowLabel
                    icon={<HammerIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                    label="Repair"
                    trailing={
                      repairs.total > 0 ? (
                        <span className={cn(!repairDisabled && "text-destructive")}>
                          {repairs.total}
                        </span>
                      ) : null
                    }
                  />
                </MenuSubTrigger>
                <ComposerPickerMenuSubPopup side={SUBMENU_SIDE} className="w-60 min-w-60">
                  <MenuItem
                    disabled={repairs.comments === 0}
                    onClick={() => attachContextCard("comments")}
                  >
                    <MenuRowLabel
                      icon={<ChatBubbleIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                      label="Comments"
                      trailing={repairs.comments > 0 ? repairs.comments : null}
                    />
                  </MenuItem>
                  <MenuItem
                    disabled={repairs.failingChecks === 0}
                    onClick={() => attachContextCard("checks")}
                  >
                    <MenuRowLabel
                      icon={<CircleAlertIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                      label="Failing checks"
                      trailing={repairs.failingChecks > 0 ? repairs.failingChecks : null}
                    />
                  </MenuItem>
                  <MenuItem
                    disabled={!repairs.conflicts}
                    onClick={() => attachContextCard("conflicts")}
                  >
                    <MenuRowLabel
                      icon={<GitMergeConflictIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                      label="Merge conflicts"
                    />
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onClick={() => attachContextCard("everything")}>
                    <MenuRowLabel
                      icon={<HammerIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                      label="Everything"
                    />
                  </MenuItem>
                </ComposerPickerMenuSubPopup>
              </MenuSub>

              {canRunActions ? (
                <MenuSub keepOpenOnFocusOut>
                  <MenuSubTrigger
                    disabled={mergeDisabled}
                    title={
                      mergeBlocker ??
                      (detailQuery.error instanceof Error ? detailQuery.error.message : undefined)
                    }
                  >
                    <MenuRowLabel
                      icon={<GitMergeIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                      label={
                        actionPending && actionMutation.variables?.action === "merge"
                          ? "Merging…"
                          : "Merge"
                      }
                      trailing={mergeTrailing}
                    />
                  </MenuSubTrigger>
                  <ComposerPickerMenuSubPopup side={SUBMENU_SIDE} className="w-56 min-w-56">
                    {allowedMergeMethods.map((method) => (
                      <MenuItem key={method} onClick={() => setConfirmMerge(method)}>
                        <MenuRowLabel
                          icon={<GitMergeIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                          label={MERGE_METHOD_LABELS[method]}
                        />
                      </MenuItem>
                    ))}
                  </ComposerPickerMenuSubPopup>
                </MenuSub>
              ) : null}
            </>
          ) : null}

          {activeThreadId ? (
            <MenuItem onClick={() => attachContextCard("reference")}>
              <MenuRowLabel
                icon={<MessageCircleIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                label="Add to chat"
              />
            </MenuItem>
          ) : null}

          <MenuSeparator />

          {canRunActions ? (
            <MenuSub keepOpenOnFocusOut>
              <MenuSubTrigger disabled={actionPending}>
                <MenuRowLabel
                  icon={<GitPullRequestIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                  label="Status"
                  trailing={stateLabel}
                />
              </MenuSubTrigger>
              <ComposerPickerMenuSubPopup side={SUBMENU_SIDE} className="w-56 min-w-56">
                <MenuRadioGroup
                  value={displayPr.isDraft ? "draft" : "ready"}
                  onValueChange={(value) => {
                    if (value === "draft" && !displayPr.isDraft) runAction("draft");
                    if (value === "ready" && displayPr.isDraft) runAction("ready");
                  }}
                >
                  <MenuRadioItem value="draft" disabled={actionPending}>
                    <GitPullRequestDraftIcon className={MENU_ICON_CLASS_NAME} aria-hidden />
                    <span>Draft</span>
                  </MenuRadioItem>
                  <MenuRadioItem value="ready" disabled={actionPending}>
                    <GitPullRequestIcon className={MENU_ICON_CLASS_NAME} aria-hidden />
                    <span>Ready for review</span>
                  </MenuRadioItem>
                </MenuRadioGroup>
              </ComposerPickerMenuSubPopup>
            </MenuSub>
          ) : (
            <MenuItem disabled>
              <MenuRowLabel
                icon={<GitPullRequestIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
                label="Status"
                trailing={stateLabel}
              />
            </MenuItem>
          )}
          <MenuItem onClick={openInGitHub}>
            <MenuRowLabel
              icon={<ExternalLinkIcon className={MENU_ICON_CLASS_NAME} aria-hidden />}
              label="Open in GitHub"
            />
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>

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
          onClick={() => {
            openPullRequest();
          }}
        />
      ) : null}

      <AlertDialog
        open={confirmMerge !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmMerge(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {detail?.stack && stackAssessment
                ? `Merge ${stackAssessment.mergeTargetCount} ${stackAssessment.mergeTargetCount === 1 ? "pull request" : "pull requests"}?`
                : "Merge pull request?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {detail?.stack
                ? `This will atomically merge every open pull request through #${displayPr.number} into ${detail.stack.baseBranch} using ${confirmMerge ?? "merge"}.`
                : `This will merge #${displayPr.number} into ${displayPr.baseBranch} using ${confirmMerge ?? "merge"}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={actionPending}
              onClick={() => {
                const method = confirmMerge;
                setConfirmMerge(null);
                // Re-check against the loaded capabilities: the dialog may outlive a refetch.
                if (method && detail && allowedMergeMethods.includes(method)) {
                  runAction("merge", method);
                }
              }}
            >
              {detail?.stack ? "Merge stack" : "Merge"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </EnvironmentLabeledSection>
  );
}
