// FILE: GitActionsControl.tsx
// Purpose: Render the chat-header git action control, commit dialog, and action toasts.
// Layer: Header action control
// Depends on: git React Query hooks, native shell bridges, and shared picker/menu primitives.

import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "@synara/contracts";
import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  GitStackedAction,
  GitStatusResult,
  ModelSelection,
  ThreadId,
} from "@synara/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, InfoIcon } from "~/lib/icons";
import { Input } from "~/components/ui/input";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitDialogContext,
  type GitActionMenuItem,
  type GitGlyphName,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresFeatureBranchForDefaultBranchAction,
  requiresDefaultBranchConfirmation,
  resolveGitMenuActionDisabledReason,
  resolveLiveThreadBranchUpdate,
  resolveDefaultCreateBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveCreatePrActionAvailability,
  resolveCreatePrBaseBranch,
  resolveCreatePrDialogRuntimeStatus,
  resolveCreatePrExecution,
  resolveQuickAction,
  resolvePullActionAvailability,
  resolvePromotedPullPresentation,
  shouldOfferCreateBranchPrompt,
  summarizeGitResult,
} from "./GitActionsControl.logic";
import { GIT_ACTION_ICON_CLASS, GitActionGlyph } from "./gitActionGlyphs";
import { GitCommitDialog, type GitCommitDialogSubmission } from "./GitCommitDialog";
import {
  GitCreatePrDialog,
  type GitCreatePrDialogBrowserRequest,
  type GitCreatePrDialogSubmission,
} from "./GitCreatePrDialog";
import { getProviderStartOptions, useAppSettings } from "~/appSettings";
import { formatClockDuration } from "~/session-logic";
import { Button } from "~/components/ui/button";
import {
  ChatHeaderButton,
  ChatHeaderSplitDivider,
  ChatHeaderSplitGroup,
  CHAT_HEADER_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
} from "./chat/chatHeaderControls";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./chat/environment/EnvironmentRow";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { openInPreferredEditor } from "~/editorPreferences";
import {
  gitBranchesQueryOptions,
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
  isGitExpensiveReadCapacityError,
  refreshGitActionAvailability,
} from "~/lib/gitReactQuery";
import { cn, newCommandId, randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { readNativeApi } from "~/nativeApi";
import { createThreadSelector } from "~/storeSelectors";
import { useStore } from "~/store";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadId: ThreadId | null;
  hideQuickActionLabel?: boolean;
  // `header` renders the split quick-action button; `panel` collapses git actions into
  // an Environment row + dropdown, promoting Pull as the primary row when behind upstream.
  variant?: "header" | "panel";
  // `always` (default) keeps the control mounted. `pull-available` hides the header
  // control unless Pull is the current action or a pull is already running — used
  // next to Hand off / Add action while Environment owns the rest of git actions.
  visibleWhen?: "always" | "pull-available";
  // Lets a parent capture "run commit & push for this instance's repo" so a global
  // keyboard shortcut can trigger it without duplicating the action logic. Called with
  // `null` on unmount/dependency change so a stale trigger never lingers.
  onRegisterCommitAndPushTrigger?: ((trigger: (() => void) | null) => void) | undefined;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  forcePushOnlyProgress: boolean;
  onConfirmed?: () => void;
  filePaths?: string[];
}

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  forcePushOnlyProgress?: boolean;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: GitStatusResult | null;
  featureBranch?: boolean;
  isDefaultBranchOverride?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
  prTitle?: string;
  prBody?: string;
  prDraft?: boolean;
  allowDirtyWorkingTree?: boolean;
  afterSuccess?: (result: GitRunStackedActionResult) => void;
}

// Overrides captured when the Create PR dialog opens from a surface with a
// pre-resolved git status (e.g. the post-push toast CTA); null means "open
// against the live status".
interface CreatePrDialogState {
  statusOverride: GitStatusResult | null;
  statusOverrideSource: GitStatusResult | null;
  isDefaultBranchOverride: boolean | null;
}

interface GitPickerMenuItem {
  id: "push" | "pr" | "sync" | "commit" | "commit_push" | "create_branch";
  label: string;
  disabled: boolean;
  disabledReason: string | null;
  icon: GitGlyphName;
  onSelect: () => void;
}

// Keep "/" literal in branch names; GitHub compare URLs expect it unescaped.
function encodeBranchForCompareUrl(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  return `Running for ${formatClockDuration(Date.now() - startedAtMs)}`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

// Map a header quick action onto its shared glyph name; null falls back to a hint icon.
// Every push-family action collapses to "push" so the button matches the picker rows.
function resolveGitQuickActionGlyph(quickAction: GitQuickAction): GitGlyphName | null {
  if (quickAction.kind === "open_pr") return "pr";
  if (quickAction.kind === "run_pull") return "sync";
  if (quickAction.kind === "create_branch") return "branch";
  if (quickAction.kind === "run_action") {
    return quickAction.action === "commit" ? "commit" : "push";
  }
  if (quickAction.label === "Commit") return "commit";
  return null;
}

function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  const name = resolveGitQuickActionGlyph(quickAction);
  if (name) return <GitActionGlyph name={name} />;
  return <InfoIcon className={GIT_ACTION_ICON_CLASS} />;
}

// The commit-and-push behavior moves between menu items with git state: on a feature
// branch with pending changes it is the `commit_push` item, while on the default branch
// (or with ahead-only commits) it lives under the `push` item. Both the panel row's
// enabled state and the global shortcut resolve their target through this one rule.
function findRunnableCommitPushMenuItem(items: GitActionMenuItem[]): GitActionMenuItem | null {
  return (
    items.find((item) => (item.id === "commit_push" || item.id === "push") && !item.disabled) ??
    null
  );
}

function GitPickerMenuRow({ item }: { item: GitPickerMenuItem }) {
  return (
    <MenuItem disabled={item.disabled} onClick={item.onSelect}>
      <span className="inline-flex shrink-0 items-center [&>svg]:size-3.5">
        <GitActionGlyph name={item.icon} />
      </span>
      <span>{item.label}</span>
    </MenuItem>
  );
}

export default function GitActionsControl({
  gitCwd,
  activeThreadId,
  hideQuickActionLabel: hideQuickActionLabelProp,
  variant: variantProp,
  visibleWhen: visibleWhenProp,
  onRegisterCommitAndPushTrigger,
}: GitActionsControlProps) {
  const hideQuickActionLabel = hideQuickActionLabelProp ?? false;
  const variant = variantProp ?? "header";
  const visibleWhen = visibleWhenProp ?? "always";
  const isPanel = variant === "panel";
  const createBranchNameFieldId = useId();
  const { settings } = useAppSettings();
  // Manual memoization kept: this file does not compile under React Compiler (see compile-report).
  const providerOptions = useMemo(() => getProviderStartOptions(settings), [settings]);
  const gitTextGenerationModelSelection = useMemo(
    (): ModelSelection => ({
      provider: settings.textGenerationProvider ?? "codex",
      model: settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL,
    }),
    [settings.textGenerationModel, settings.textGenerationProvider],
  );
  const activeThread = useStore(
    useMemo(() => createThreadSelector(activeThreadId), [activeThreadId]),
  );
  const setThreadWorkspaceAction = useStore((store) => store.setThreadWorkspace);
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const queryClient = useQueryClient();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const [isCreateBranchDialogOpen, setIsCreateBranchDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [createPrDialog, setCreatePrDialog] = useState<CreatePrDialogState | null>(null);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: threadToastData,
    });
  }, [threadToastData]);

  const { data: branchListData, isSuccess: branchListReady } = useQuery(
    gitBranchesQueryOptions(gitCwd),
  );
  const branchList = branchListData ?? null;
  // Default to true while loading so we don't flash init controls.
  const isRepo = branchList?.isRepo ?? true;
  const hasOriginRemote = branchList?.hasOriginRemote ?? false;
  const currentBranch = branchList?.branches.find((branch) => branch.current)?.name ?? null;
  // Only poll status after branch discovery confirms a repo — avoids non-repo
  // cwds feeding a permanent "Refreshing git status..." invalidation loop.
  const {
    data: gitStatusData,
    error: gitStatusError,
    isFetching: isGitStatusFetching,
  } = useQuery(gitStatusQueryOptions(gitCwd, branchListReady && branchList?.isRepo === true));
  const gitStatus = gitStatusData ?? null;
  const isGitStatusRefreshDelayed = isGitExpensiveReadCapacityError(gitStatusError);
  const requestGitActionAvailabilityRefresh = useCallback(() => {
    if (!gitCwd) return;
    void refreshGitActionAvailability(queryClient, gitCwd).catch(() => undefined);
  }, [gitCwd, queryClient]);
  const liveThreadBranchUpdate = useMemo(
    () =>
      resolveLiveThreadBranchUpdate({
        threadBranch: currentBranch,
        gitStatus,
      }),
    [currentBranch, gitStatus],
  );
  const isGitStatusOutOfSync = liveThreadBranchUpdate !== null;

  useEffect(() => {
    if (!isGitStatusOutOfSync) return;
    requestGitActionAvailabilityRefresh();
  }, [isGitStatusOutOfSync, requestGitActionAvailabilityRefresh]);

  const gitStatusForActions = isGitStatusOutOfSync ? null : gitStatus;

  const initMutation = useMutation(gitInitMutationOptions({ cwd: gitCwd, queryClient }));

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      cwd: gitCwd,
      queryClient,
      codexHomePath: settings.codexHomePath || null,
      model: settings.textGenerationModel ?? null,
      modelSelection: gitTextGenerationModelSelection,
      ...(providerOptions ? { providerOptions } : {}),
    }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ cwd: gitCwd, queryClient }));
  const persistThreadPr = useCallback(
    async (pr: {
      number: number;
      title: string;
      url: string;
      baseBranch: string;
      headBranch: string;
      state: "open" | "closed" | "merged";
      isDraft?: boolean;
      mergeability?: "mergeable" | "conflicting" | "unknown";
      additions?: number | null;
      deletions?: number | null;
      changedFiles?: number | null;
    }) => {
      if (!activeThreadId) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: activeThreadId,
        lastKnownPr: pr,
      });
    },
    [activeThreadId],
  );

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(gitCwd) }) > 0;
  const isPullRunning = useIsMutating({ mutationKey: gitMutationKeys.pull(gitCwd) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;
  const isDefaultBranch = useMemo(() => {
    const branchName = gitStatusForActions?.branch;
    if (!branchName) return false;
    const current = branchList?.branches.find((branch) => branch.name === branchName);
    return current?.isDefault ?? (branchName === "main" || branchName === "master");
  }, [branchList?.branches, gitStatusForActions?.branch]);
  const defaultBranchName = useMemo(
    () => branchList?.branches.find((branch) => !branch.isRemote && branch.isDefault)?.name ?? null,
    [branchList?.branches],
  );
  const shouldOfferCreateBranch = useMemo(() => {
    return shouldOfferCreateBranchPrompt({
      activeWorktreePath: activeThread?.worktreePath ?? null,
      gitStatus: gitStatusForActions
        ? {
            branch: gitStatusForActions.branch,
            hasUpstream: gitStatusForActions.hasUpstream,
          }
        : null,
      createBranchFlowCompleted: activeThread?.createBranchFlowCompleted ?? false,
    });
  }, [activeThread?.createBranchFlowCompleted, activeThread?.worktreePath, gitStatusForActions]);
  const currentBranchName =
    gitStatusForActions?.branch ?? currentBranch ?? activeThread?.branch ?? null;
  const existingBranchNames = useMemo(
    () => (branchList?.branches ?? []).map((branch) => branch.name),
    [branchList?.branches],
  );
  const branchNames = useMemo(
    () => new Set(existingBranchNames.map((branchName) => branchName.toLowerCase())),
    [existingBranchNames],
  );
  const suggestedCreateBranchName = useMemo(
    () =>
      resolveDefaultCreateBranchName(
        existingBranchNames,
        activeThread?.associatedWorktreeBranch ?? activeThread?.title,
      ),
    [activeThread?.associatedWorktreeBranch, activeThread?.title, existingBranchNames],
  );

  const quickAction = useMemo(
    () =>
      resolveQuickAction(
        gitStatusForActions,
        isGitActionRunning,
        isDefaultBranch,
        hasOriginRemote,
        shouldOfferCreateBranch,
        defaultBranchName,
      ),
    [
      defaultBranchName,
      gitStatusForActions,
      hasOriginRemote,
      isDefaultBranch,
      isGitActionRunning,
      shouldOfferCreateBranch,
    ],
  );
  const gitActionMenuItems = useMemo(
    () =>
      buildMenuItems(
        gitStatusForActions,
        isGitActionRunning,
        hasOriginRemote,
        isDefaultBranch,
        defaultBranchName,
      ),
    [defaultBranchName, gitStatusForActions, hasOriginRemote, isDefaultBranch, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
      })
    : null;
  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }

    const applyProgressEvent = (event: GitActionProgressEvent) => {
      const progress = activeGitActionProgressRef.current;
      if (!progress) {
        return;
      }
      if (gitCwd && event.cwd !== gitCwd) {
        return;
      }
      if (progress.actionId !== event.actionId) {
        return;
      }

      const now = Date.now();
      switch (event.kind) {
        case "action_started":
          progress.phaseStartedAtMs = now;
          progress.hookStartedAtMs = null;
          progress.hookName = null;
          progress.lastOutputLine = null;
          break;
        case "phase_started":
          progress.title = event.label;
          progress.currentPhaseLabel = event.label;
          progress.phaseStartedAtMs = now;
          progress.hookStartedAtMs = null;
          progress.hookName = null;
          progress.lastOutputLine = null;
          break;
        case "hook_started":
          progress.title = `Running ${event.hookName}...`;
          progress.hookName = event.hookName;
          progress.hookStartedAtMs = now;
          progress.lastOutputLine = null;
          break;
        case "hook_output":
          progress.lastOutputLine = event.text;
          break;
        case "hook_finished":
          progress.title = progress.currentPhaseLabel ?? "Committing...";
          progress.hookName = null;
          progress.hookStartedAtMs = null;
          progress.lastOutputLine = null;
          break;
        case "action_finished":
          // The terminal stream response owns the final toast so success is rendered once.
          // Its server-side status refresh is detached, keeping this event-to-response gap short.
          return;
        case "action_failed":
          // Same reasoning as action_finished — let the HTTP error handler
          // manage the final toast state to avoid a flash of bare title.
          return;
      }

      updateActiveProgressToast();
    };

    return api.git.onActionProgress(applyProgressEvent);
  }, [gitCwd, updateActiveProgressToast]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open PR found.",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      });
    });
  }, [gitStatusForActions, threadToastData]);

  // Single entry point for every "Create PR" surface: opens the PR dialog when a
  // PR can be created, opens the existing PR when one is already open, and
  // explains unavailability otherwise.
  const openCreatePrDialog = useCallback(
    (input?: {
      statusOverride?: GitStatusResult | null;
      statusOverrideSource?: GitStatusResult | null;
      isDefaultBranchOverride?: boolean;
    }) => {
      const execution = resolveCreatePrExecution({
        gitStatus: input?.statusOverride ?? gitStatusForActions,
        isBusy: isGitActionRunning,
        isDefaultBranch: input?.isDefaultBranchOverride ?? isDefaultBranch,
        hasOriginRemote,
        defaultBranchName,
      });
      if (execution.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (execution.kind === "unavailable") {
        toastManager.add({
          type: "info",
          title: "Create PR unavailable",
          description: execution.hint,
          data: threadToastData,
        });
        return;
      }
      setCreatePrDialog({
        statusOverride: input?.statusOverride ?? null,
        statusOverrideSource: input?.statusOverrideSource ?? null,
        isDefaultBranchOverride: input?.isDefaultBranchOverride ?? null,
      });
    },
    [
      defaultBranchName,
      gitStatusForActions,
      hasOriginRemote,
      isDefaultBranch,
      isGitActionRunning,
      openExistingPr,
      threadToastData,
    ],
  );

  const openComparePage = useCallback(
    async (headBranch: string | null, baseBranch: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd || !headBranch) {
        toastManager.add({
          type: "error",
          title: "Unable to open compare page.",
          data: threadToastData,
        });
        return;
      }
      try {
        const repoResult = await api.git.githubRepository({ cwd: gitCwd });
        const repoUrl = repoResult.repository?.url ?? null;
        if (!repoUrl) {
          toastManager.add({
            type: "error",
            title: "Unable to open compare page",
            description: "No GitHub repository detected for this project.",
            data: threadToastData,
          });
          return;
        }
        await api.shell.openExternal(
          `${repoUrl}/compare/${encodeBranchForCompareUrl(baseBranch)}...${encodeBranchForCompareUrl(headBranch)}?expand=1`,
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to open compare page",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [gitCwd, threadToastData],
  );

  const runSyncWithRemote = useCallback(() => {
    const promise = pullMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: "Syncing with remote...", data: threadToastData },
      success: (result) => ({
        title: result.status === "pulled" ? "Remote synced" : "Already up to date",
        description:
          result.status === "pulled"
            ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}`
            : `${result.branch} is already synchronized.`,
        data: threadToastData,
      }),
      error: (err) => ({
        title: "Sync failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [pullMutation, threadToastData]);

  const runGitActionWithToast = useCallback(
    async function runGitActionWithToast({
      action,
      commitMessage,
      forcePushOnlyProgress: forcePushOnlyProgressProp,
      onConfirmed,
      skipDefaultBranchPrompt: skipDefaultBranchPromptProp,
      statusOverride,
      featureBranch: featureBranchProp,
      isDefaultBranchOverride,
      progressToastId,
      filePaths,
      prTitle,
      prBody,
      prDraft,
      allowDirtyWorkingTree,
      afterSuccess,
    }: RunGitActionWithToastInput) {
      const forcePushOnlyProgress = forcePushOnlyProgressProp ?? false;
      const skipDefaultBranchPrompt = skipDefaultBranchPromptProp ?? false;
      const featureBranch = featureBranchProp ?? false;
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.branch ?? null;
      const actionIsDefaultBranch =
        isDefaultBranchOverride ?? (featureBranch ? false : isDefaultBranch);
      const includesCommit =
        !forcePushOnlyProgress &&
        action !== "push" &&
        action !== "create_pr" &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges);
      const shouldPushBeforePr =
        action === "create_pr" &&
        (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          forcePushOnlyProgress,
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      if (action === "create_pr" && !featureBranch && !allowDirtyWorkingTree) {
        const createPrAvailability = resolveCreatePrActionAvailability({
          gitStatus: actionStatus,
          isDefaultBranch: actionIsDefaultBranch,
          hasOriginRemote,
          defaultBranchName,
        });
        if (!createPrAvailability.canRun) {
          toastManager.add({
            type: "info",
            title: "Create PR unavailable",
            description: createPrAvailability.hint ?? "No branch changes to include in a PR.",
            data: threadToastData,
          });
          return;
        }
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        forcePushOnly: forcePushOnlyProgress,
        featureBranch,
        shouldPushBeforePr,
      });
      const actionId = randomUUID();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: threadToastData,
        });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        actionId,
        title: progressStages[0] ?? "Running git action...",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Running git action...",
      };

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: threadToastData,
        });
      }

      const promise = runImmediateGitActionMutation.mutateAsync({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(prTitle ? { prTitle } : {}),
        ...(prBody ? { prBody } : {}),
        ...(prDraft ? { prDraft } : {}),
        ...(allowDirtyWorkingTree ? { allowDirtyWorkingTree } : {}),
      });

      try {
        const result = await promise;
        activeGitActionProgressRef.current = null;
        const resultToast = summarizeGitResult(result);
        const persistedPr =
          result.pr.status === "created" || result.pr.status === "opened_existing"
            ? result.pr.number &&
              result.pr.title &&
              result.pr.url &&
              result.pr.baseBranch &&
              result.pr.headBranch
              ? {
                  number: result.pr.number,
                  title: result.pr.title,
                  url: result.pr.url,
                  baseBranch: result.pr.baseBranch,
                  headBranch: result.pr.headBranch,
                  state: "open" as const,
                }
              : null
            : actionStatus?.pr?.state === "open"
              ? actionStatus.pr
              : null;
        if (persistedPr) {
          void persistThreadPr(persistedPr).catch(() => undefined);
        }

        const existingOpenPrUrl =
          actionStatus?.pr?.state === "open" ? actionStatus.pr.url : undefined;
        const prUrl = result.pr.url ?? existingOpenPrUrl;
        const shouldOfferPushCta = action === "commit" && result.commit.status === "created";
        const shouldOfferOpenPrCta =
          (action === "push" ||
            action === "create_pr" ||
            action === "commit_push" ||
            action === "commit_push_pr") &&
          !!prUrl &&
          (!actionIsDefaultBranch ||
            result.pr.status === "created" ||
            result.pr.status === "opened_existing");
        const postPushStatus = actionStatus
          ? {
              ...actionStatus,
              hasUpstream: true,
              upstreamBranch:
                actionStatus.upstreamBranch ??
                (!actionStatus.hasUpstream ? (result.push.branch ?? actionStatus.branch) : null),
              aheadCount: 0,
            }
          : null;
        const shouldOfferCreatePrCta =
          (action === "push" || action === "commit_push") &&
          !prUrl &&
          result.push.status === "pushed" &&
          !actionIsDefaultBranch &&
          resolveCreatePrExecution({
            gitStatus: postPushStatus,
            isBusy: false,
            isDefaultBranch: actionIsDefaultBranch,
            hasOriginRemote,
            defaultBranchName,
          }).kind === "run_action";
        const closeResultToast = () => {
          toastManager.close(resolvedProgressToastId);
        };

        toastManager.update(resolvedProgressToastId, {
          type: "success",
          title: resultToast.title,
          description: resultToast.description,
          timeout: 0,
          data: {
            ...threadToastData,
            dismissAfterVisibleMs: 10_000,
          },
          ...(shouldOfferPushCta
            ? {
                actionProps: {
                  children: "Push",
                  onClick: () => {
                    void runGitActionWithToast({
                      action: "push",
                      onConfirmed: closeResultToast,
                      statusOverride: actionStatus,
                      isDefaultBranchOverride: actionIsDefaultBranch,
                    });
                  },
                },
              }
            : shouldOfferOpenPrCta
              ? {
                  actionProps: {
                    children: "View PR",
                    onClick: () => {
                      const api = readNativeApi();
                      if (!api) return;
                      closeResultToast();
                      void api.shell.openExternal(prUrl);
                    },
                  },
                }
              : shouldOfferCreatePrCta
                ? {
                    actionProps: {
                      children: "Create PR",
                      onClick: () => {
                        closeResultToast();
                        openCreatePrDialog({
                          statusOverride: postPushStatus,
                          statusOverrideSource: actionStatus,
                          isDefaultBranchOverride: actionIsDefaultBranch,
                        });
                      },
                    },
                  }
                : {}),
        });
        afterSuccess?.(result);
      } catch (err) {
        activeGitActionProgressRef.current = null;
        toastManager.update(resolvedProgressToastId, {
          type: "error",
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [
      defaultBranchName,
      gitStatusForActions,
      hasOriginRemote,
      isDefaultBranch,
      openCreatePrDialog,
      persistThreadPr,
      runImmediateGitActionMutation,
      threadToastData,
    ],
  );

  const createPrDialogRuntimeStatus = useMemo(
    () =>
      resolveCreatePrDialogRuntimeStatus({
        liveGitStatus: gitStatusForActions,
        statusOverride: createPrDialog?.statusOverride ?? null,
        statusOverrideSource: createPrDialog?.statusOverrideSource ?? null,
        isDefaultBranch,
        isDefaultBranchOverride: createPrDialog?.isDefaultBranchOverride ?? null,
      }),
    [createPrDialog, gitStatusForActions, isDefaultBranch],
  );

  const handleCreatePrDialogSubmit = useCallback(
    (submission: GitCreatePrDialogSubmission) => {
      setCreatePrDialog(null);
      const actionStatus = createPrDialogRuntimeStatus.gitStatus;
      const actionIsDefaultBranch = createPrDialogRuntimeStatus.isDefaultBranch;
      const excludesDirtyChanges =
        !submission.includeLocalChanges && actionStatus?.hasWorkingTreeChanges === true;
      void runGitActionWithToast({
        action: submission.action,
        ...(createPrDialogRuntimeStatus.statusOverride
          ? { statusOverride: createPrDialogRuntimeStatus.statusOverride }
          : {}),
        isDefaultBranchOverride: actionIsDefaultBranch,
        ...(actionIsDefaultBranch ? { featureBranch: true } : {}),
        skipDefaultBranchPrompt: true,
        ...(submission.title ? { prTitle: submission.title } : {}),
        ...(submission.body ? { prBody: submission.body } : {}),
        ...(submission.draft ? { prDraft: true } : {}),
        ...(excludesDirtyChanges ? { allowDirtyWorkingTree: true } : {}),
      });
    },
    [createPrDialogRuntimeStatus, runGitActionWithToast],
  );

  const handleCreatePrDialogBrowser = useCallback(
    (request: GitCreatePrDialogBrowserRequest) => {
      setCreatePrDialog(null);
      const actionStatus = createPrDialogRuntimeStatus.gitStatus;
      const actionIsDefaultBranch = createPrDialogRuntimeStatus.isDefaultBranch;
      const preparation = request.preparation;
      if (preparation.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (preparation.kind === "unavailable") {
        toastManager.add({
          type: "info",
          title: "Create PR unavailable",
          description: preparation.hint,
          data: threadToastData,
        });
        return;
      }
      if (preparation.kind === "open_compare") {
        void openComparePage(
          actionStatus?.branch ?? null,
          resolveCreatePrBaseBranch(actionStatus, defaultBranchName),
        );
        return;
      }
      const excludesDirtyChanges =
        !request.includeLocalChanges && actionStatus?.hasWorkingTreeChanges === true;
      void runGitActionWithToast({
        action: preparation.action,
        ...(createPrDialogRuntimeStatus.statusOverride
          ? { statusOverride: createPrDialogRuntimeStatus.statusOverride }
          : {}),
        isDefaultBranchOverride: actionIsDefaultBranch,
        ...(actionIsDefaultBranch ? { featureBranch: true } : {}),
        skipDefaultBranchPrompt: true,
        ...(excludesDirtyChanges ? { allowDirtyWorkingTree: true } : {}),
        afterSuccess: (result) => {
          void openComparePage(
            result.push.branch ?? result.branch.name ?? actionStatus?.branch ?? null,
            resolveCreatePrBaseBranch(actionStatus, defaultBranchName),
          );
        },
      });
    },
    [
      createPrDialogRuntimeStatus,
      defaultBranchName,
      openComparePage,
      openExistingPr,
      runGitActionWithToast,
      threadToastData,
    ],
  );

  const createPrDialogContext = useMemo<GitDialogContext>(
    () => ({
      gitStatus: createPrDialogRuntimeStatus.gitStatus,
      isBusy: isGitActionRunning,
      isDefaultBranch: createPrDialogRuntimeStatus.isDefaultBranch,
      hasOriginRemote,
      defaultBranchName,
    }),
    [createPrDialogRuntimeStatus, defaultBranchName, hasOriginRemote, isGitActionRunning],
  );

  // The Commit dialog always resolves against live status — unlike Create PR it is never
  // opened from a surface carrying a post-push snapshot.
  const commitDialogContext = useMemo<GitDialogContext>(
    () => ({
      gitStatus: gitStatusForActions,
      isBusy: isGitActionRunning,
      isDefaultBranch,
      hasOriginRemote,
      defaultBranchName,
    }),
    [defaultBranchName, gitStatusForActions, hasOriginRemote, isDefaultBranch, isGitActionRunning],
  );

  const continuePendingDefaultBranchAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, forcePushOnlyProgress, onConfirmed, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      forcePushOnlyProgress,
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      ...(requiresFeatureBranchForDefaultBranchAction(action) ? { featureBranch: true } : {}),
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction, runGitActionWithToast]);

  const checkoutFeatureBranchAndContinuePendingAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, forcePushOnlyProgress, onConfirmed, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      forcePushOnlyProgress,
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction, runGitActionWithToast]);

  const handleCommitDialogSubmit = useCallback(
    (submission: GitCommitDialogSubmission) => {
      setIsCommitDialogOpen(false);
      // Create PR owns its own authoring dialog (title/description/draft), so the
      // commit dialog hands off instead of dispatching a PR chain itself.
      if (submission.action === "create_pr") {
        openCreatePrDialog();
        return;
      }
      void runGitActionWithToast({
        action: submission.action,
        ...(submission.message ? { commitMessage: submission.message } : {}),
        ...(submission.filePaths ? { filePaths: submission.filePaths } : {}),
        ...(submission.featureBranch ? { featureBranch: true, skipDefaultBranchPrompt: true } : {}),
      });
    },
    [openCreatePrDialog, runGitActionWithToast],
  );

  const openCreateBranchDialog = useCallback(() => {
    setCreateBranchName(suggestedCreateBranchName);
    setIsCreateBranchDialogOpen(true);
  }, [suggestedCreateBranchName]);

  const runQuickAction = useCallback(() => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      runSyncWithRemote();
      return;
    }
    if (quickAction.kind === "create_branch") {
      openCreateBranchDialog();
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      // PR-creating quick actions go through the Create PR dialog so the user
      // can review title/description/draft before the chain runs.
      if (quickAction.action === "create_pr" || quickAction.action === "commit_push_pr") {
        openCreatePrDialog();
        return;
      }
      void runGitActionWithToast({ action: quickAction.action });
    }
  }, [
    openCreateBranchDialog,
    openCreatePrDialog,
    openExistingPr,
    quickAction,
    runGitActionWithToast,
    runSyncWithRemote,
    threadToastData,
  ]);

  const openCommitDialog = useCallback(() => {
    setIsCommitDialogOpen(true);
  }, []);

  const normalizedCurrentBranchName = currentBranchName?.trim().toLowerCase() ?? "";
  const normalizedCreateBranchName = createBranchName.trim().toLowerCase();
  const createBranchNameConflicts =
    normalizedCreateBranchName.length > 0 &&
    normalizedCreateBranchName !== normalizedCurrentBranchName &&
    branchNames.has(normalizedCreateBranchName);

  const createAndCheckoutBranch = useCallback(
    async (branchName: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) return;

      const trimmedName = branchName.trim();
      if (!trimmedName) return;

      setIsCreateBranchDialogOpen(false);
      setCreateBranchName("");

      if (trimmedName.toLowerCase() === normalizedCurrentBranchName) {
        if (activeThreadId) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: activeThreadId,
              createBranchFlowCompleted: true,
            })
            .catch(() => {
              setThreadWorkspaceAction(activeThreadId, {
                createBranchFlowCompleted: false,
              });
            });
          setThreadWorkspaceAction(activeThreadId, {
            createBranchFlowCompleted: true,
          });
        }
        toastManager.add({
          type: "success",
          title: `Keeping ${trimmedName}`,
          description: "Branch name confirmed.",
          data: threadToastData,
        });
        return;
      }

      const toastId = toastManager.add({
        type: "loading",
        title: "Creating branch...",
        timeout: 0,
        data: threadToastData,
      });

      try {
        await api.git.createBranch({ cwd: gitCwd, branch: trimmedName, publish: hasOriginRemote });
        await api.git.checkout({ cwd: gitCwd, branch: trimmedName });
        if (activeThreadId) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: activeThreadId,
              branch: trimmedName,
              worktreePath: activeThread?.worktreePath ?? null,
              associatedWorktreeBranch: trimmedName,
              associatedWorktreeRef: trimmedName,
              createBranchFlowCompleted: true,
            })
            .catch(() => {
              setThreadWorkspaceAction(activeThreadId, {
                createBranchFlowCompleted: false,
              });
            });
          setThreadWorkspaceAction(activeThreadId, {
            branch: trimmedName,
            associatedWorktreeBranch: trimmedName,
            associatedWorktreeRef: trimmedName,
            createBranchFlowCompleted: true,
          });
        }
        await invalidateGitQueries(queryClient);

        toastManager.update(toastId, {
          type: "success",
          title: `Switched to ${trimmedName}`,
          description: "Branch created and checked out.",
          data: threadToastData,
        });
      } catch (error) {
        toastManager.update(toastId, {
          type: "error",
          title: "Failed to create branch",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [
      activeThread?.worktreePath,
      activeThreadId,
      gitCwd,
      hasOriginRemote,
      normalizedCurrentBranchName,
      queryClient,
      setThreadWorkspaceAction,
      threadToastData,
    ],
  );

  const openDialogForMenuItem = useCallback(
    (item: GitActionMenuItem) => {
      if (item.disabled) return;
      if (item.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (item.dialogAction === "push") {
        void runGitActionWithToast({ action: "push" });
        return;
      }
      if (item.dialogAction === "commit_push") {
        void runGitActionWithToast({ action: "commit_push" });
        return;
      }
      if (item.dialogAction === "create_pr") {
        openCreatePrDialog();
        return;
      }
      openCommitDialog();
    },
    [openCommitDialog, openCreatePrDialog, openExistingPr, runGitActionWithToast],
  );

  useEffect(() => {
    if (!onRegisterCommitAndPushTrigger) return;
    // Pull-only header instances must not steal the Environment panel's commit &
    // push shortcut registration, including while they are hidden.
    if (visibleWhen === "pull-available") return;
    const target = findRunnableCommitPushMenuItem(gitActionMenuItems);
    if (!target) {
      onRegisterCommitAndPushTrigger(null);
      return;
    }
    onRegisterCommitAndPushTrigger(() => openDialogForMenuItem(target));
    return () => onRegisterCommitAndPushTrigger(null);
  }, [gitActionMenuItems, onRegisterCommitAndPushTrigger, openDialogForMenuItem, visibleWhen]);

  const gitPickerMenuItems = useMemo<GitPickerMenuItem[]>(() => {
    const items: GitPickerMenuItem[] = [];
    const commitMenuItem = gitActionMenuItems.find((item) => item.id === "commit");
    const commitPushMenuItem = gitActionMenuItems.find((item) => item.id === "commit_push");
    const pushMenuItem = gitActionMenuItems.find((item) => item.id === "push");
    const prMenuItem = gitActionMenuItems.find((item) => item.id === "pr");
    const createBranchDisabled = isGitActionRunning || !gitStatusForActions;
    const pullAvailability = resolvePullActionAvailability({
      gitStatus: gitStatusForActions,
      isBusy: isGitActionRunning,
    });

    if (commitMenuItem) {
      items.push({
        id: "commit",
        label: commitMenuItem.label,
        disabled: commitMenuItem.disabled,
        disabledReason: resolveGitMenuActionDisabledReason({
          item: commitMenuItem,
          gitStatus: gitStatusForActions,
          isBusy: isGitActionRunning,
          hasOriginRemote,
          isDefaultBranch,
          defaultBranchName,
        }),
        icon: "commit",
        onSelect: () => openDialogForMenuItem(commitMenuItem),
      });
    }

    if (commitPushMenuItem) {
      items.push({
        id: "commit_push",
        label: commitPushMenuItem.label,
        disabled: commitPushMenuItem.disabled,
        disabledReason: resolveGitMenuActionDisabledReason({
          item: commitPushMenuItem,
          gitStatus: gitStatusForActions,
          isBusy: isGitActionRunning,
          hasOriginRemote,
          isDefaultBranch,
          defaultBranchName,
        }),
        icon: "push",
        onSelect: () => openDialogForMenuItem(commitPushMenuItem),
      });
    }

    items.push({
      id: "sync",
      label: "Pull",
      disabled: !pullAvailability.canRun,
      disabledReason: pullAvailability.hint,
      icon: "sync",
      onSelect: runSyncWithRemote,
    });

    if (pushMenuItem) {
      items.push({
        id: "push",
        label: pushMenuItem.label,
        disabled: pushMenuItem.disabled,
        disabledReason: resolveGitMenuActionDisabledReason({
          item: pushMenuItem,
          gitStatus: gitStatusForActions,
          isBusy: isGitActionRunning,
          hasOriginRemote,
          isDefaultBranch,
          defaultBranchName,
        }),
        icon: "push",
        onSelect: () => openDialogForMenuItem(pushMenuItem),
      });
    }

    if (prMenuItem) {
      items.push({
        id: "pr",
        label: prMenuItem.label,
        disabled: prMenuItem.disabled,
        disabledReason: resolveGitMenuActionDisabledReason({
          item: prMenuItem,
          gitStatus: gitStatusForActions,
          isBusy: isGitActionRunning,
          hasOriginRemote,
          isDefaultBranch,
          defaultBranchName,
        }),
        icon: "pr",
        onSelect: () => openDialogForMenuItem(prMenuItem),
      });
    }

    items.push({
      id: "create_branch",
      label: "Create Branch",
      disabled: createBranchDisabled,
      disabledReason: createBranchDisabled
        ? isGitActionRunning
          ? "Git action in progress."
          : "Git status is unavailable."
        : null,
      icon: "branch",
      onSelect: openCreateBranchDialog,
    });

    return items;
  }, [
    defaultBranchName,
    gitActionMenuItems,
    gitStatusForActions,
    hasOriginRemote,
    isDefaultBranch,
    isGitActionRunning,
    openCreateBranchDialog,
    openDialogForMenuItem,
    runSyncWithRemote,
  ]);

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void openInPreferredEditor(api, target).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [gitCwd, threadToastData],
  );

  if (!gitCwd) return null;

  const promotedPull = resolvePromotedPullPresentation({
    quickAction,
    isPullRunning,
  });
  const showPromotedPullAction = promotedPull !== null;
  if (visibleWhen === "pull-available") {
    if (!promotedPull) return null;
    // Pull-only chrome: Environment already owns commit/push/PR dialogs, so this
    // instance must not mount a second copy of them beside the panel control.
    return (
      <ChatHeaderButton
        type="button"
        tone="outline"
        className={hideQuickActionLabel ? "gap-1" : "gap-1.5"}
        aria-label={promotedPull.label}
        title={promotedPull.label}
        disabled={isGitActionRunning}
        onClick={runSyncWithRemote}
      >
        <GitActionGlyph name="sync" />
        {!hideQuickActionLabel ? (
          <span className="truncate font-normal">{promotedPull.label}</span>
        ) : null}
      </ChatHeaderButton>
    );
  }

  const runnableCommitPushMenuItem = findRunnableCommitPushMenuItem(gitActionMenuItems);

  // Shared dropdown body — the picker rows plus the contextual git-status warnings.
  // Rendered identically by the header split button and the panel "Commit and Push" row.
  const gitMenuContent = (
    <>
      <MenuGroup>
        <MenuGroupLabel>Git actions</MenuGroupLabel>
        {gitPickerMenuItems.map((item) => {
          const menuRow = <GitPickerMenuRow item={item} />;
          if (item.disabled && item.disabledReason) {
            return (
              <Popover key={item.id}>
                <PopoverTrigger
                  openOnHover
                  nativeButton={false}
                  render={<span className="block cursor-not-allowed" />}
                >
                  {menuRow}
                </PopoverTrigger>
                <PopoverPopup tooltipStyle side="left" align="center">
                  {item.disabledReason}
                </PopoverPopup>
              </Popover>
            );
          }
          return <GitPickerMenuRow key={item.id} item={item} />;
        })}
      </MenuGroup>
      {(gitStatusForActions?.branch === null ||
        (gitStatusForActions &&
          gitStatusForActions.branch !== null &&
          !gitStatusForActions.hasWorkingTreeChanges &&
          gitStatusForActions.behindCount > 0 &&
          gitStatusForActions.aheadCount === 0) ||
        isGitStatusOutOfSync ||
        gitStatusError) && <MenuSeparator className="mx-3 mt-2" />}
      {gitStatusForActions?.branch === null && (
        <p className="px-3 py-1.5 text-xs text-warning">
          Detached HEAD: create and checkout a branch to enable push and PR actions.
        </p>
      )}
      {gitStatusForActions &&
        gitStatusForActions.branch !== null &&
        !gitStatusForActions.hasWorkingTreeChanges &&
        gitStatusForActions.behindCount > 0 &&
        gitStatusForActions.aheadCount === 0 && (
          <p className="px-3 py-1.5 text-xs text-warning">Behind upstream. Pull/rebase first.</p>
        )}
      {isGitStatusOutOfSync && (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">Refreshing git status...</p>
      )}
      {isGitStatusRefreshDelayed && !isGitStatusOutOfSync && (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">
          {isGitStatusFetching ? "Refreshing git status..." : "Git status refresh delayed."}
        </p>
      )}
      {gitStatusError && !isGitStatusRefreshDelayed && (
        <p className="px-3 py-1.5 text-xs text-destructive">
          {gitStatusError instanceof Error ? gitStatusError.message : "Git status refresh failed."}
        </p>
      )}
    </>
  );

  // The git action dialogs are identical across surfaces; only the trigger differs.
  const gitActionDialogs = (
    <>
      <GitCreatePrDialog
        open={createPrDialog !== null}
        onOpenChange={(open) => {
          if (!open) setCreatePrDialog(null);
        }}
        context={createPrDialogContext}
        onSubmit={handleCreatePrDialogSubmit}
        onOpenInBrowser={handleCreatePrDialogBrowser}
      />

      <GitCommitDialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) setIsCommitDialogOpen(false);
        }}
        context={commitDialogContext}
        onSubmit={handleCommitDialogSubmit}
        onOpenFile={openChangedFileInEditor}
      />

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefaultBranchAction(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              shape="capsule"
              onClick={() => setPendingDefaultBranchAction(null)}
            >
              Abort
            </Button>
            <Button
              variant="outline"
              size="sm"
              shape="capsule"
              onClick={continuePendingDefaultBranchAction}
            >
              {pendingDefaultBranchAction &&
              requiresFeatureBranchForDefaultBranchAction(pendingDefaultBranchAction.action)
                ? "Create feature branch & continue"
                : (pendingDefaultBranchActionCopy?.continueLabel ?? "Continue")}
            </Button>
            {pendingDefaultBranchAction &&
            !requiresFeatureBranchForDefaultBranchAction(pendingDefaultBranchAction.action) ? (
              <Button
                size="sm"
                shape="capsule"
                onClick={checkoutFeatureBranchAndContinuePendingAction}
              >
                Checkout feature branch & continue
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={isCreateBranchDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCreateBranchDialogOpen(false);
            setCreateBranchName("");
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Branch</DialogTitle>
            <DialogDescription>
              Create and switch to a branch from the current HEAD. Future commits, pushes, and PRs
              will use it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const trimmedName = createBranchName.trim();
                if (!trimmedName || createBranchNameConflicts) {
                  return;
                }
                void createAndCheckoutBranch(trimmedName);
              }}
            >
              <div className="space-y-1.5">
                <label className="block font-medium text-sm" htmlFor={createBranchNameFieldId}>
                  Branch name
                </label>
                <Input
                  autoFocus
                  id={createBranchNameFieldId}
                  placeholder="feature/my-change"
                  value={createBranchName}
                  onChange={(event) => setCreateBranchName(event.target.value)}
                />
              </div>
              {createBranchNameConflicts ? (
                <p className="text-destructive text-sm">A branch with this name already exists.</p>
              ) : null}
              <DialogFooter variant="bare">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setIsCreateBranchDialogOpen(false);
                    setCreateBranchName("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={createBranchName.trim().length === 0 || createBranchNameConflicts}
                >
                  Create Branch
                </Button>
              </DialogFooter>
            </form>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );

  if (isPanel) {
    const showPanelPullRow = showPromotedPullAction;
    // The panel row runs its action on click — exactly like Pull — and the chevron
    // beside it is the only way into the git actions menu (and its dialogs).
    const panelPrimaryLabel = showPanelPullRow
      ? (promotedPull?.label ?? "Pull")
      : (runnableCommitPushMenuItem?.label ?? "Commit and Push");
    const panelPrimaryGlyph: GitGlyphName = showPanelPullRow ? "sync" : "push";
    const runPanelPrimaryAction = () => {
      if (showPanelPullRow) {
        runSyncWithRemote();
        return;
      }
      if (runnableCommitPushMenuItem) {
        openDialogForMenuItem(runnableCommitPushMenuItem);
      }
    };
    const panelGitActionsMenu = (
      <Menu
        onOpenChange={(open) => {
          if (open) requestGitActionAvailabilityRefresh();
        }}
      >
        <MenuTrigger
          render={
            <button
              type="button"
              className={cn(ENVIRONMENT_ROW_CLASS_NAME, "w-auto shrink-0 px-1.5")}
              aria-label="Git action options"
              title="More Git actions"
            />
          }
        >
          <EnvironmentRowChevron />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="start" side="bottom" className="w-60 min-w-60">
          {gitMenuContent}
        </ComposerPickerMenuPopup>
      </Menu>
    );

    return (
      <>
        {!isRepo ? (
          <EnvironmentRow
            icon={<GitActionGlyph name="branch" className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
            label={initMutation.isPending ? "Initializing..." : "Initialize Git"}
            disabled={initMutation.isPending}
            onClick={() => initMutation.mutate()}
          />
        ) : (
          <div className="flex w-full items-center">
            <button
              type="button"
              className={cn(ENVIRONMENT_ROW_CLASS_NAME, "min-w-0 flex-1")}
              aria-label={panelPrimaryLabel}
              title={panelPrimaryLabel}
              disabled={isGitActionRunning || (!showPanelPullRow && !runnableCommitPushMenuItem)}
              onClick={runPanelPrimaryAction}
            >
              <EnvironmentRowBody
                icon={
                  <GitActionGlyph
                    name={panelPrimaryGlyph}
                    className={ENVIRONMENT_ROW_ICON_CLASS_NAME}
                  />
                }
                label={panelPrimaryLabel}
              />
            </button>
            {panelGitActionsMenu}
          </div>
        )}
        {gitActionDialogs}
      </>
    );
  }

  return (
    <>
      {!isRepo ? (
        <Button
          variant="chrome-outline"
          size="xs"
          className={cn(CHAT_HEADER_CONTROL_CLASS_NAME, CHAT_HEADER_ICON_STRENGTH_CLASS_NAME)}
          disabled={initMutation.isPending}
          onClick={() => initMutation.mutate()}
        >
          {initMutation.isPending ? "Initializing..." : "Initialize Git"}
        </Button>
      ) : (
        <ChatHeaderSplitGroup label="Git actions">
          {promotedPull ? (
            <Button
              variant="chrome-outline"
              size={hideQuickActionLabel ? "icon-xs" : "xs"}
              className={cn(
                hideQuickActionLabel
                  ? CHAT_HEADER_ICON_CONTROL_CLASS_NAME
                  : CHAT_HEADER_CONTROL_CLASS_NAME,
                CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
              )}
              disabled={isGitActionRunning}
              aria-label={promotedPull.label}
              title={promotedPull.label}
              onClick={runSyncWithRemote}
            >
              <GitActionGlyph name="sync" />
              {!hideQuickActionLabel ? (
                <span className="font-normal">{promotedPull.label}</span>
              ) : null}
            </Button>
          ) : quickActionDisabledReason ? (
            <Popover>
              <PopoverTrigger
                openOnHover
                render={
                  <Button
                    aria-label={quickAction.label}
                    aria-disabled="true"
                    className={cn(
                      hideQuickActionLabel
                        ? CHAT_HEADER_ICON_CONTROL_CLASS_NAME
                        : CHAT_HEADER_CONTROL_CLASS_NAME,
                      CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                      CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
                      "cursor-not-allowed opacity-64",
                    )}
                    size={hideQuickActionLabel ? "icon-xs" : "xs"}
                    variant="chrome-outline"
                    title={quickAction.label}
                  />
                }
              >
                <GitQuickActionIcon quickAction={quickAction} />
                {!hideQuickActionLabel ? (
                  <span className="font-normal">{quickAction.label}</span>
                ) : null}
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="bottom" align="start">
                {quickActionDisabledReason}
              </PopoverPopup>
            </Popover>
          ) : (
            <Button
              variant="chrome-outline"
              size={hideQuickActionLabel ? "icon-xs" : "xs"}
              className={cn(
                hideQuickActionLabel
                  ? CHAT_HEADER_ICON_CONTROL_CLASS_NAME
                  : CHAT_HEADER_CONTROL_CLASS_NAME,
                CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
              )}
              disabled={isGitActionRunning || quickAction.disabled}
              aria-label={quickAction.label}
              title={quickAction.label}
              onClick={runQuickAction}
            >
              <GitQuickActionIcon quickAction={quickAction} />
              {!hideQuickActionLabel ? (
                <span className="font-normal">{quickAction.label}</span>
              ) : null}
            </Button>
          )}
          <ChatHeaderSplitDivider />
          <Menu
            onOpenChange={(open) => {
              if (open) requestGitActionAvailabilityRefresh();
            }}
          >
            <MenuTrigger
              render={
                <Button
                  aria-label="Git action options"
                  size="icon-xs"
                  variant="chrome-outline"
                  className={cn(
                    CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
                    CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                    CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
                  )}
                />
              }
              disabled={isGitActionRunning}
            >
              <ChevronDownIcon aria-hidden="true" className="size-3.5" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-50 min-w-50">
              {gitMenuContent}
            </ComposerPickerMenuPopup>
          </Menu>
        </ChatHeaderSplitGroup>
      )}

      {gitActionDialogs}
    </>
  );
}
