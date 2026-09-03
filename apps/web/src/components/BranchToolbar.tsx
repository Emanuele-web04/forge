// FILE: BranchToolbar.tsx
// Purpose: Renders the chat thread's compact workspace controls, including the
// local usage popover, inline workspace handoff actions, and runtime access toggle.
import type {
  ProviderKind,
  ProviderModelDescriptor,
  ServerProviderStatus,
  ThreadId,
  RuntimeMode,
} from "@synara/contracts";
import { CheckIcon, ChevronDownIcon, HandoffIcon, WorktreeIcon } from "~/lib/icons";
import { HiOutlineHandRaised } from "react-icons/hi2";
import { CentralIcon } from "~/lib/central-icons";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useAppSettings } from "~/appSettings";

import { newCommandId, cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProviderUsageSummary } from "../hooks/useProviderUsageSummary";
import { resolveThreadEnvironmentPresentation } from "../lib/threadEnvironment";
import {
  RUNTIME_MODE_PRESENTATION,
  providerModelSupportsAutoRuntimeMode,
} from "../lib/runtimeMode";
import { useStore } from "../store";
import {
  createAllThreadsSelector,
  createProjectSelector,
  createThreadSelector,
} from "../storeSelectors";
import {
  EnvMode,
  resolveAssociatedWorktreeMetadataAfterWorkspacePatch,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveFixedLocalWorkspacePatch,
} from "./BranchToolbar.logic";
import {
  BranchToolbarBranchSelector,
  type BranchSelectorVariant,
} from "./BranchToolbarBranchSelector";
import {
  RUNTIME_AUTO_ACCENT_CLASS_NAME,
  RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
  COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
} from "./chat/composerPickerStyles";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./chat/environment/EnvironmentRow";
import type { ContextWindowSnapshot } from "../lib/contextWindow";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel } from "./ui/collapsible";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import type { ThreadWorkspacePatch } from "../types";

function WorktreeGlyph({ className }: { className?: string }) {
  return <WorktreeIcon className={className} />;
}

/** Leading glyph treatment shared by every "Continue in" menu row (16px, muted). */
const ENV_MENU_ICON_CLASS_NAME = "size-3.5 text-muted-foreground";

/**
 * One row of the "Continue in" menu: `[glyph] [label …grows] [✓ when selected]`.
 * Centralizes the icon/label/check treatment so the local, worktree, and handoff
 * entries stay on one grid instead of repeating the same class strings per row.
 */
function ContinueInMenuItem({
  icon,
  label,
  selected: selectedProp,
  disabled: disabledProp,
  onSelect,
}: {
  icon: ReactNode;
  label: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  const selected = selectedProp ?? false;
  const disabled = disabledProp ?? false;
  return (
    <MenuItem disabled={disabled} {...(onSelect ? { onClick: onSelect } : {})}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? (
        <CheckIcon className="size-3.5 shrink-0 text-[var(--color-text-foreground)]" />
      ) : null}
    </MenuItem>
  );
}

function RuntimeModeMenuItem({
  mode,
  icon,
  accent = false,
}: {
  mode: RuntimeMode;
  icon: ReactNode;
  accent?: boolean;
}) {
  const presentation = RUNTIME_MODE_PRESENTATION[mode];
  return (
    <MenuRadioItem
      value={mode}
      className={cn(
        "runtime-mode-menu-item",
        mode === "auto" && "runtime-mode-menu-item--auto",
        accent &&
          "text-[var(--runtime-full-access-accent)] data-highlighted:text-[var(--runtime-full-access-accent)]",
      )}
    >
      <span className="grid w-full min-w-0 flex-1 grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3">
        <span className="flex h-5 items-center justify-center">{icon}</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>{presentation.label}</span>
          <span
            className={cn(
              "runtime-mode-menu-description text-xs font-normal",
              accent ? "text-current" : "text-muted-foreground",
            )}
          >
            {presentation.description}
          </span>
        </span>
      </span>
    </MenuRadioItem>
  );
}

export interface BranchToolbarProps {
  threadId: ThreadId;
  className?: string;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  threadDetailReady: boolean;
  onHandoffToWorktree?: () => void;
  onHandoffToLocal?: () => void;
  handoffBusy?: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  // `toolbar` renders the compact composer-footer row; `panel` stacks the env and branch
  // pickers as full-width Environment panel rows that open downward.
  variant?: BranchSelectorVariant;
  // Keeps the Local/Worktree control visible while hiding Git-only branch UI for non-repo cwd.
  showBranchSelector?: boolean;
  // Studio-like containers bind the toolbar to one concrete local folder and
  // must not persist project/worktree metadata from branch selector actions.
  fixedLocalWorkspaceCwd?: string | null;
}

export interface RuntimeUsageControlsProps {
  provider?: ProviderKind | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
  providerStatus?: ServerProviderStatus | null | undefined;
  runtimeMode?: RuntimeMode | undefined;
  onRuntimeModeChange?: ((mode: RuntimeMode) => void) | undefined;
  contextWindow?: ContextWindowSnapshot | null | undefined;
  cumulativeCostUsd?: number | null | undefined;
  activeContextWindowLabel?: string | null | undefined;
  pendingContextWindowLabel?: string | null | undefined;
  className?: string | undefined;
  // Force icon-only rendering regardless of container width. Used when the
  // control is relocated outside the composer footer (which provides the
  // @container the responsive sr-only fallback depends on).
  hideLabel?: boolean | undefined;
}

export function RuntimeUsageControls({
  provider,
  runtimeModel,
  providerStatus,
  runtimeMode,
  onRuntimeModeChange,
  className,
  hideLabel: hideLabelProp,
}: RuntimeUsageControlsProps) {
  const autoModeAvailable =
    provider !== undefined &&
    providerModelSupportsAutoRuntimeMode(provider, runtimeModel, providerStatus);
  const runtimePresentation = RUNTIME_MODE_PRESENTATION[runtimeMode ?? "approval-required"];
  const hideLabel = hideLabelProp ?? false;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[var(--color-text-foreground-secondary)]",
        className,
      )}
    >
      {runtimeMode && onRuntimeModeChange ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="chrome"
                className={cn(
                  "min-w-0 shrink-0 justify-start gap-1.5 whitespace-nowrap px-2 [&_svg]:mx-0 sm:px-2.5",
                  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
                  runtimeMode === "auto" && RUNTIME_AUTO_ACCENT_CLASS_NAME,
                  runtimeMode === "full-access" && RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
                )}
                title={`${runtimePresentation.label}: ${runtimePresentation.description}. Click to change permissions.`}
              />
            }
          >
            <span className="inline-flex items-center gap-1.5">
              {runtimeMode === "full-access" ? (
                <CentralIcon name="shield-access" className="size-3.5 shrink-0" />
              ) : runtimeMode === "auto" ? (
                <CentralIcon name="shield-code" className="size-3.5 shrink-0" />
              ) : (
                <HiOutlineHandRaised className="size-3.5 shrink-0" />
              )}
              <span className={cn("truncate", hideLabel ? "sr-only" : "@max-[480px]:sr-only")}>
                {runtimePresentation.label}
              </span>
              <ChevronDownIcon
                className={cn(
                  "size-3 shrink-0 opacity-70",
                  hideLabel ? "hidden" : "@max-[480px]:hidden",
                )}
              />
            </span>
          </MenuTrigger>
          <ComposerPickerMenuPopup
            align="start"
            side="top"
            className="runtime-mode-menu w-[26rem] min-w-[26rem]"
          >
            <MenuRadioGroup
              className="flex flex-col gap-1"
              value={runtimeMode}
              onValueChange={(value) => {
                if (
                  !value ||
                  (value !== "full-access" && value !== "auto" && value !== "approval-required") ||
                  (value === "auto" && !autoModeAvailable) ||
                  value === runtimeMode
                ) {
                  return;
                }
                onRuntimeModeChange(value);
              }}
            >
              <RuntimeModeMenuItem
                mode="approval-required"
                icon={<HiOutlineHandRaised className="size-4 shrink-0" />}
              />
              {autoModeAvailable ? (
                <RuntimeModeMenuItem
                  mode="auto"
                  icon={<CentralIcon name="shield-code" className="size-4 shrink-0" />}
                />
              ) : null}
              <RuntimeModeMenuItem
                mode="full-access"
                accent
                icon={<CentralIcon name="shield-access" className="size-4 shrink-0" />}
              />
            </MenuRadioGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

export default function BranchToolbar({
  threadId,
  className,
  onEnvModeChange,
  envLocked,
  threadDetailReady,
  onHandoffToWorktree,
  onHandoffToLocal,
  handoffBusy: handoffBusyProp,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  variant: variantProp,
  showBranchSelector: showBranchSelectorProp,
  fixedLocalWorkspaceCwd,
}: BranchToolbarProps) {
  const handoffBusy = handoffBusyProp ?? false;
  const variant = variantProp ?? "toolbar";
  const showBranchSelector = showBranchSelectorProp ?? true;
  const isPanel = variant === "panel";
  const setThreadWorkspaceAction = useStore((store) => store.setThreadWorkspace);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [allThreadsSelector] = useState(() => createAllThreadsSelector());
  const threads = useStore(allThreadsSelector);
  const { settings } = useAppSettings();

  const serverThread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const hasServerThread = serverThread !== undefined;
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = hasServerThread
    ? (serverThread.branch ?? null)
    : (draftThread?.branch ?? null);
  const activeWorktreePath = hasServerThread
    ? (serverThread.worktreePath ?? null)
    : (draftThread?.worktreePath ?? null);
  const activeWorkingDirectory = hasServerThread
    ? (serverThread.workingDirectory ?? null)
    : (draftThread?.workingDirectory ?? null);
  const activeProvider =
    serverThread?.session?.provider ?? serverThread?.modelSelection.provider ?? null;
  const usesFixedLocalWorkspace = fixedLocalWorkspaceCwd !== undefined;
  const branchCwd = usesFixedLocalWorkspace
    ? fixedLocalWorkspaceCwd
    : (activeWorktreePath ?? activeWorkingDirectory ?? activeProject?.cwd ?? null);
  const branchProjectCwd = usesFixedLocalWorkspace ? branchCwd : (activeProject?.cwd ?? null);
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
    serverThreadEnvMode: serverThread?.envMode,
  });
  const environmentPresentation = resolveThreadEnvironmentPresentation({
    envMode: effectiveEnvMode,
    worktreePath: activeWorktreePath,
  });

  const setThreadWorkspace = useCallback(
    (patch: ThreadWorkspacePatch) => {
      if (!activeThreadId) return;
      if (usesFixedLocalWorkspace) {
        const nextWorkspace = resolveFixedLocalWorkspacePatch({
          currentWorkingDirectory: activeWorkingDirectory,
          patch,
        });
        const nextWorkingDirectory = nextWorkspace.workingDirectory ?? null;
        if (nextWorkingDirectory === activeWorkingDirectory) {
          return;
        }

        const api = readNativeApi();
        if (serverThread?.session && api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.session.stop",
              commandId: newCommandId(),
              threadId: activeThreadId,
              createdAt: new Date().toISOString(),
            })
            .catch(() => undefined);
        }
        if (api && hasServerThread) {
          void api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: activeThreadId,
            ...nextWorkspace,
          });
        }
        if (hasServerThread) {
          setThreadWorkspaceAction(activeThreadId, nextWorkspace);
          return;
        }
        setDraftThreadContext(threadId, nextWorkspace);
        return;
      }

      const branch = patch.branch !== undefined ? patch.branch : activeThreadBranch;
      const worktreePath =
        patch.worktreePath !== undefined ? patch.worktreePath : activeWorktreePath;
      const nextEnvMode =
        patch.envMode !== undefined ? patch.envMode : worktreePath ? "worktree" : effectiveEnvMode;
      const nextAssociatedWorktree = resolveAssociatedWorktreeMetadataAfterWorkspacePatch({
        branch,
        worktreePath,
        existingAssociatedWorktreePath: serverThread?.associatedWorktreePath ?? null,
        existingAssociatedWorktreeBranch: serverThread?.associatedWorktreeBranch ?? null,
        existingAssociatedWorktreeRef: serverThread?.associatedWorktreeRef ?? null,
        ...(patch.associatedWorktreePath !== undefined
          ? { patchAssociatedWorktreePath: patch.associatedWorktreePath }
          : {}),
        ...(patch.associatedWorktreeBranch !== undefined
          ? { patchAssociatedWorktreeBranch: patch.associatedWorktreeBranch }
          : {}),
        ...(patch.associatedWorktreeRef !== undefined
          ? { patchAssociatedWorktreeRef: patch.associatedWorktreeRef }
          : {}),
      });
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          envMode: nextEnvMode,
          branch,
          worktreePath,
          associatedWorktreePath: nextAssociatedWorktree.associatedWorktreePath,
          associatedWorktreeBranch: nextAssociatedWorktree.associatedWorktreeBranch,
          associatedWorktreeRef: nextAssociatedWorktree.associatedWorktreeRef,
        });
      }
      if (hasServerThread) {
        setThreadWorkspaceAction(activeThreadId, {
          envMode: nextEnvMode,
          branch,
          worktreePath,
          ...nextAssociatedWorktree,
        });
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      activeThreadBranch,
      activeWorkingDirectory,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadWorkspaceAction,
      serverThread?.associatedWorktreePath,
      serverThread?.associatedWorktreeBranch,
      serverThread?.associatedWorktreeRef,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
      usesFixedLocalWorkspace,
    ],
  );

  const canHandoffToWorktree = Boolean(
    !usesFixedLocalWorkspace &&
    hasServerThread &&
    envLocked &&
    !activeWorktreePath &&
    effectiveEnvMode === "local",
  );
  const canHandoffToLocal = Boolean(
    !usesFixedLocalWorkspace && hasServerThread && activeWorktreePath,
  );
  const canSwitchToWorktree = Boolean(
    !usesFixedLocalWorkspace && !envLocked && !activeWorktreePath && effectiveEnvMode === "local",
  );
  const canSwitchToLocal = Boolean(
    !usesFixedLocalWorkspace && !envLocked && effectiveEnvMode === "worktree",
  );
  const showEnvPicker = effectiveEnvMode === "local" || canSwitchToLocal;

  const usageSummary = useProviderUsageSummary({
    provider: activeProvider,
    threads,
    codexHomePath: settings.codexHomePath || null,
    fetchOpenUsageData: false,
  });
  const [rateLimitsOpen, setRateLimitsOpen] = useState(true);
  const [envPickerOpen, setEnvPickerOpen] = useState(false);

  if (!activeThreadId || !activeProject) return null;

  const envGlyph = (className: string) =>
    environmentPresentation.mode === "local" ? (
      <CentralIcon name="macbook-air" className={className} />
    ) : (
      <WorktreeGlyph className={className} />
    );

  return (
    <div
      className={cn(
        isPanel
          ? "flex w-full flex-col gap-0.5"
          : "mx-auto flex w-full items-center justify-between px-3 pb-1.5 pt-1",
        className,
      )}
    >
      <div className={isPanel ? "flex flex-col gap-0.5" : "flex items-center gap-2"}>
        {showEnvPicker ? (
          <Menu open={envPickerOpen} onOpenChange={setEnvPickerOpen}>
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={
                    isPanel
                      ? ENVIRONMENT_ROW_CLASS_NAME
                      : COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME
                  }
                />
              }
            >
              {isPanel ? (
                <EnvironmentRowBody
                  icon={envGlyph(ENVIRONMENT_ROW_ICON_CLASS_NAME)}
                  label={environmentPresentation.shortLabel}
                  trailing={<EnvironmentRowChevron />}
                />
              ) : (
                <>
                  {envGlyph("size-3.5")}
                  {environmentPresentation.shortLabel}
                  <ChevronDownIcon className="size-3 opacity-60" />
                </>
              )}
            </MenuTrigger>
            <ComposerPickerMenuPopup
              align="start"
              side={isPanel ? "bottom" : "top"}
              sideOffset={6}
              className="w-60 min-w-60"
            >
              <MenuGroup>
                <MenuGroupLabel>Continue in</MenuGroupLabel>
                {environmentPresentation.mode === "local" ? (
                  <ContinueInMenuItem
                    icon={<CentralIcon name="macbook-air" className={ENV_MENU_ICON_CLASS_NAME} />}
                    label={environmentPresentation.localOptionLabel}
                    selected
                  />
                ) : (
                  <ContinueInMenuItem
                    icon={<CentralIcon name="macbook-air" className={ENV_MENU_ICON_CLASS_NAME} />}
                    label={environmentPresentation.localOptionLabel}
                    onSelect={() => onEnvModeChange("local")}
                  />
                )}
                {canSwitchToWorktree ? (
                  <ContinueInMenuItem
                    icon={<WorktreeGlyph className={ENV_MENU_ICON_CLASS_NAME} />}
                    label="New worktree"
                    onSelect={() => onEnvModeChange("worktree")}
                  />
                ) : null}
                {effectiveEnvMode === "worktree" && !canHandoffToLocal ? (
                  <ContinueInMenuItem
                    icon={<WorktreeGlyph className={ENV_MENU_ICON_CLASS_NAME} />}
                    label={environmentPresentation.worktreeOptionLabel}
                    selected
                  />
                ) : null}
                {canHandoffToWorktree && onHandoffToWorktree ? (
                  <ContinueInMenuItem
                    icon={<WorktreeGlyph className={ENV_MENU_ICON_CLASS_NAME} />}
                    label="Hand off to new worktree"
                    disabled={handoffBusy}
                    onSelect={() => onHandoffToWorktree()}
                  />
                ) : null}
                {canHandoffToLocal && onHandoffToLocal ? (
                  <ContinueInMenuItem
                    icon={<HandoffIcon className={ENV_MENU_ICON_CLASS_NAME} />}
                    label="Hand off to local"
                    disabled={handoffBusy}
                    onSelect={() => onHandoffToLocal()}
                  />
                ) : null}
              </MenuGroup>

              {/* Rate limits are noise while drafting a new chat — no session has run yet. */}
              {hasServerThread ? (
                <>
                  <MenuSeparator />

                  <Collapsible open={rateLimitsOpen} onOpenChange={setRateLimitsOpen}>
                    <MenuItem
                      closeOnClick={false}
                      onClick={() => setRateLimitsOpen((open) => !open)}
                    >
                      <CentralIcon name="clock" className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">Rate limits remaining</span>
                      <DisclosureChevron
                        open={rateLimitsOpen}
                        className="text-[var(--color-text-foreground-secondary)]"
                      />
                    </MenuItem>
                    <CollapsiblePanel>
                      <ProviderUsagePanelContent
                        provider={activeProvider}
                        rateLimits={usageSummary.rateLimits}
                        usageLines={usageSummary.usageLines}
                        notice={usageSummary.usageNotice}
                        isLoading={usageSummary.isLoading}
                        learnMoreHref={usageSummary.learnMoreHref}
                        showTitle={false}
                        showLearnMore={true}
                        className="px-2 pb-1 pt-1"
                      />
                    </CollapsiblePanel>
                  </Collapsible>
                </>
              ) : null}
            </ComposerPickerMenuPopup>
          </Menu>
        ) : isPanel ? (
          <div className={cn(ENVIRONMENT_ROW_CLASS_NAME, "cursor-default hover:bg-transparent")}>
            <EnvironmentRowBody
              icon={<WorktreeGlyph className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
              label={environmentPresentation.shortLabel}
            />
          </div>
        ) : (
          <span className="inline-flex items-center gap-2 px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-[var(--color-text-foreground-secondary)]">
            <WorktreeGlyph className="size-3.5" />
            {environmentPresentation.shortLabel}
          </span>
        )}

        {showBranchSelector ? (
          /* ChatView stays mounted while the route switches threads. Reset the selector's
             optimistic checkout state at that boundary so a previous thread cannot paint its
             branch while the new thread's workspace query is resolving. */
          <BranchToolbarBranchSelector
            key={threadId}
            activeProjectCwd={branchProjectCwd ?? activeProject.cwd}
            activeThreadBranch={activeThreadBranch}
            activeWorktreePath={activeWorktreePath}
            branchCwd={branchCwd}
            effectiveEnvMode={effectiveEnvMode}
            envLocked={envLocked}
            hasServerThread={hasServerThread}
            isThreadSettled={serverThread?.settledAt != null || !threadDetailReady}
            onSetThreadWorkspace={setThreadWorkspace}
            variant={variant}
            {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
            {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
          />
        ) : null}
      </div>
    </div>
  );
}
