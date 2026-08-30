// FILE: EnvironmentPanel.tsx
// Purpose: Codex-style "Environment" panel. Consolidates the chat-header diff toggle,
//          the composer-footer env/branch pickers, the header git actions, and the
//          "Open in editor" controls into one vertical list of full-width rows. Always
//          rendered as the same rounded floating card; the only difference is whether it
//          overlays pinned top-right of the chat column (p-3 gutters). Full-width single
//          chat also reserves transcript/composer inset; split panes and an open right dock
//          use floating overlay only. The card surface and content are identical either way.
// Layer: Environment panel container

import type {
  AutomationDefinition,
  EditorId,
  MessageId,
  PinnedMessage,
  ProjectId,
  ResolvedKeybindingsConfig,
  ThreadId,
  ThreadMarker,
  ThreadMarkerId,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useAppSettings } from "~/appSettings";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
import {
  ENVIRONMENT_PANEL_MOTION_CLASS,
  ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import BranchToolbar, { type BranchToolbarProps } from "~/components/BranchToolbar";
import ChatMarkdown from "~/components/ChatMarkdown";
import { FolderClosed } from "~/components/FolderClosed";
import GitActionsControl from "~/components/GitActionsControl";
import { DiffStat } from "~/components/ui/diff-stat";
import { IconButton } from "~/components/ui/icon-button";
import { toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { basenameOfPath } from "~/file-icons";
import type { RepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { ArrowUpRightIcon, ChangesIcon, GitHubIcon, SettingsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { waitForSidechatCreator } from "~/lib/sidechatCreatorRegistry";
import { useRightDockStore } from "~/rightDockStore";

import { EnvironmentEditorSection } from "./EnvironmentEditorSection";
import {
  EnvironmentAutomationsSection,
  type EnvironmentAutomationPanelItem,
} from "./EnvironmentAutomationsSection";
import { EnvironmentUsageSection } from "./EnvironmentUsageSection";
import { EnvironmentLocalServersSection } from "./EnvironmentLocalServersSection";
import { EnvironmentPullRequestSection } from "./EnvironmentPullRequestSection";
import { EnvironmentMarkersSection } from "./EnvironmentMarkersSection";
import { EnvironmentStudioOutputsSection } from "./EnvironmentStudioOutputsSection";
import {
  EnvironmentSidechatsSection,
  type EnvironmentSidechatPanelItem,
} from "./EnvironmentSidechatsSection";
import { EnvironmentNotesSection } from "./EnvironmentNotesSection";
import { EnvironmentPinnedSection } from "./EnvironmentPinnedSection";
import { EnvironmentProjectInstructionsSection } from "./EnvironmentProjectInstructionsSection";
import { ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME } from "./environmentPanelStyles";
import { shouldShowStudioFolderRow } from "./EnvironmentPanel.logic";
import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentCollapsibleSection,
  EnvironmentLabeledSection,
  EnvironmentPanelTitle,
  EnvironmentRow,
  EnvironmentSectionDivider,
} from "./EnvironmentRow";

// Horizontal space (px) the docked card reserves on the right edge of the chat area.
// Mirrors the card footprint — w-72 (288px) plus the p-3 wrapper gutters — so insetting
// the chat content by this amount clears the overlay while leaving the transcript's
// scrollbar pinned to the viewport's far right.
export const ENVIRONMENT_DOCKED_CONTENT_INSET_PX = 312;

const ENVIRONMENT_PANEL_OVERLAY_WRAPPER_CLASS_NAME =
  "pointer-events-none absolute inset-y-0 right-0 z-20 flex flex-col p-3";

export interface EnvironmentPanelProps {
  /** Drives the slide-in/out transition; the panel stays mounted so CSS can interpolate. */
  open: boolean;
  /**
   * Both variants render the same top-right overlay card inside the chat column.
   * `docked` also reserves layout space via {@link ENVIRONMENT_DOCKED_CONTENT_INSET_PX};
   * `floating` is used when the column is narrow (split chat or right dock open) — overlay
   * only, no content inset.
   */
  variant: "docked" | "floating";
  gitCwd: string | null;
  openInTarget: string | null;
  githubRepository?: {
    readonly nameWithOwner: string;
    readonly url: string;
  } | null;
  githubRepositories?: ReadonlyArray<{ readonly nameWithOwner: string }>;
  isGitRepo: boolean;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  activeThreadId: ThreadId | null;
  /**
   * Whether the active thread is a Studio chat. Studio chats show the Output section:
   * the Outbox files THIS chat produced, so its output stays attached to the chat.
   */
  isStudioChat: boolean;
  /** Ordinary cwd selected for this Studio chat; this is not a Git worktree. */
  studioFolderPath?: string | null;
  /** Whether the active runtime exposes git actions (hides "Commit and Push" otherwise). */
  showGitActions: boolean;
  /** Current diff-panel open state, so the "Changes" row reflects/toggles it. */
  diffOpen: boolean;
  /** Heartbeat automations whose target is the active thread. */
  threadAutomations: readonly EnvironmentAutomationPanelItem[];
  /** Child side chats for a host thread. Null suppresses the section in embedded side chats. */
  sidechats: readonly EnvironmentSidechatPanelItem[] | null;
  /** Non-null when the diff panel cannot be opened (e.g. no repo / no changes yet). */
  diffDisabledReason?: string | null;
  /** Shared diff totals from ChatView so the mounted panel does not duplicate patch parsing. */
  diffTotals: RepoDiffTotals;
  /** Env/branch picker config — `variant` is supplied by the panel. */
  branchToolbar: Omit<BranchToolbarProps, "variant">;
  /** Compact idle-generated chat memory for the top of the panel. */
  recap?: {
    readonly text: string | null;
    readonly status: "idle" | "pending" | "error";
    readonly updatedAt: string | null;
  } | null;
  /** Per-thread pinned-message checklist (server-synced). */
  pinnedMessages: readonly PinnedMessage[];
  /** Per-thread text markers (server-synced). */
  threadMarkers: readonly ThreadMarker[];
  /** Live text of pinned messages still present in the transcript (for labels/availability). */
  pinnedMessageTextById: ReadonlyMap<MessageId, string>;
  /** Live text of marked messages still present in the transcript (for labels/availability). */
  markerMessageTextById: ReadonlyMap<MessageId, string>;
  /** Per-thread freeform scratchpad notes (server-synced). */
  notes: string;
  /** Active project whose local instructions should be edited. */
  activeProjectId: ProjectId | null;
  /** Per-project freeform instructions, persisted locally and optionally copied into notes. */
  projectInstructions: string;
  /** Whether the current thread is server-backed enough to accept notepad updates. */
  canCopyProjectInstructionsToNotes: boolean;
  /** Persist local project instruction edits. */
  onProjectInstructionsChange: (projectId: ProjectId, instructions: string) => void;
  /** Copy/append current project instructions into the active thread's notepad. */
  onCopyProjectInstructionsToNotes: () => void;
  /** Toggle the Diff panel/route (same handler the header diff toggle used). */
  onToggleDiff: () => void;
  /** Open the shared automation editor for a thread-bound automation row. */
  onOpenAutomation: (definition: AutomationDefinition) => void;
  /** Open the repository URL in the in-app browser panel. */
  onOpenGithubRepository?: (url: string) => void;
  /** Scroll the transcript to a pinned message. */
  onJumpToPinnedMessage: (messageId: MessageId) => void;
  /** Toggle a pinned message's done state (strikethrough; stays pinned). */
  onTogglePinnedMessageDone: (messageId: MessageId) => void;
  /** Remove a message from the pinned checklist. */
  onUnpinMessage: (messageId: MessageId) => void;
  /** Set (`null` clears to auto) a pinned message's label. */
  onRenamePinnedMessage: (messageId: MessageId, label: string | null) => void;
  /** Scroll the transcript to a text marker. */
  onJumpToThreadMarker: (marker: ThreadMarker) => void;
  /** Toggle a marker's done state. */
  onToggleThreadMarkerDone: (markerId: ThreadMarkerId) => void;
  /** Remove a text marker. */
  onRemoveThreadMarker: (markerId: ThreadMarkerId) => void;
  /** Set (`null` clears to auto) a marker label. */
  onRenameThreadMarker: (markerId: ThreadMarkerId, label: string | null) => void;
  /** Persist updated notes for the given thread (bound per section instance, not the active thread). */
  onNotesChange: (threadId: ThreadId, notes: string) => Promise<void>;
  /** Open the in-app editor workspace view (the Editor section's default first row). */
  onOpenEditorView?: (() => void) | null;
  /** Dismiss the panel overlay — invoked after actions that open the dock. */
  onClose: () => void;
  /** Registers the panel's "Commit and Push" row as the target for the global shortcut. */
  onRegisterCommitAndPushTrigger?: (trigger: (() => void) | null) => void;
}

function EnvironmentRecapSection({
  recap,
  markdownCwd,
}: {
  recap: NonNullable<EnvironmentPanelProps["recap"]>;
  markdownCwd: string | undefined;
}) {
  return (
    <EnvironmentCollapsibleSection label="Recap">
      <div className="flex flex-col gap-1.5 pb-1.5">
        {recap.text ? (
          <div className="px-2">
            <ChatMarkdown
              text={recap.text}
              cwd={markdownCwd}
              isStreaming={false}
              className={ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 px-2" aria-hidden>
            <div className="h-2.5 w-full rounded bg-[var(--color-background-button-secondary-hover)]/45 motion-safe:animate-pulse" />
            <div className="h-2.5 w-4/5 rounded bg-[var(--color-background-button-secondary-hover)]/35 motion-safe:animate-pulse" />
          </div>
        )}
      </div>
    </EnvironmentCollapsibleSection>
  );
}

export function EnvironmentPanel({
  open,
  variant,
  gitCwd,
  openInTarget,
  githubRepository: githubRepositoryProp,
  githubRepositories: githubRepositoriesProp,
  isGitRepo,
  keybindings,
  availableEditors,
  activeThreadId,
  isStudioChat,
  studioFolderPath: studioFolderPathProp,
  showGitActions,
  diffOpen,
  threadAutomations,
  sidechats,
  diffDisabledReason: diffDisabledReasonProp,
  diffTotals,
  branchToolbar,
  recap: recapProp,
  pinnedMessages,
  threadMarkers,
  pinnedMessageTextById,
  markerMessageTextById,
  notes,
  activeProjectId,
  projectInstructions,
  canCopyProjectInstructionsToNotes,
  onProjectInstructionsChange,
  onCopyProjectInstructionsToNotes,
  onToggleDiff,
  onOpenAutomation,
  onOpenGithubRepository,
  onJumpToPinnedMessage,
  onTogglePinnedMessageDone,
  onUnpinMessage,
  onRenamePinnedMessage,
  onJumpToThreadMarker,
  onToggleThreadMarkerDone,
  onRemoveThreadMarker,
  onRenameThreadMarker,
  onNotesChange,
  onOpenEditorView: onOpenEditorViewProp,
  onClose,
  onRegisterCommitAndPushTrigger,
}: EnvironmentPanelProps) {
  const githubRepository = githubRepositoryProp ?? null;
  const githubRepositories = githubRepositoriesProp ?? [];
  const studioFolderPath = studioFolderPathProp ?? null;
  const diffDisabledReason = diffDisabledReasonProp ?? null;
  const recap = recapProp ?? null;
  const onOpenEditorView = onOpenEditorViewProp ?? null;
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const openRightDockPane = useRightDockStore((store) => store.openPane);
  const { additions, deletions, hasChanges } = diffTotals;

  // Disable the Changes row only when the diff cannot be opened *and* is not already open
  // (so an open diff stays toggleable closed even when there are no pending changes).
  const changesDisabled = diffDisabledReason !== null && !diffOpen;
  const showRecap = Boolean(recap?.text) || recap?.status === "pending";
  const markdownCwd = openInTarget ?? gitCwd ?? undefined;
  const showStudioFolderRow = shouldShowStudioFolderRow({
    isStudioChat,
    studioFolderPath,
    nativeShellAvailable: isElectron,
  });

  const content = (
    <div className="flex flex-col gap-0.5 p-1.5">
      {threadAutomations.length > 0 ? (
        <>
          <EnvironmentAutomationsSection
            automations={threadAutomations}
            onOpenAutomation={(definition) => {
              onOpenAutomation(definition);
              onClose();
            }}
          />
          <EnvironmentSectionDivider />
        </>
      ) : null}

      <div className="flex items-center justify-between gap-2 px-2 pb-0.5 pt-0.5">
        <EnvironmentPanelTitle>Environment</EnvironmentPanelTitle>
        {/*
          icon-xs centers the 14px gear inside a 28/24px box, insetting it ~7/5px from the
          content edge; pull it back so the glyph's right edge lines up with the rows' chevrons
          (which sit flush against the same px-2 gutter).
        */}
        <IconButton
          label="Panel sections"
          tooltip="Panel sections"
          className="-mr-[7px] sm:-mr-[5px]"
          onClick={() =>
            void navigate({
              to: "/settings",
              search: { target: SETTINGS_TARGETS.environmentPanel },
            })
          }
        >
          <SettingsIcon className="size-3.5" />
        </IconButton>
      </div>

      {showStudioFolderRow && studioFolderPath ? (
        <EnvironmentRow
          icon={<FolderClosed className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label={
            <span className="truncate" title={studioFolderPath}>
              {basenameOfPath(studioFolderPath) || studioFolderPath}
            </span>
          }
          trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          onClick={() => {
            const api = readNativeApi();
            if (!api) {
              toastManager.add({
                type: "error",
                title: "Unable to open folder",
                description: "The desktop connection is not available yet.",
              });
              return;
            }
            void api.shell
              .showInFolder(studioFolderPath)
              .then(onClose)
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open folder",
                  description:
                    error instanceof Error ? error.message : "An unknown error occurred.",
                });
              });
          }}
        />
      ) : null}

      {isGitRepo ? (
        <EnvironmentRow
          icon={<ChangesIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label="Changes"
          trailing={hasChanges ? <DiffStat insertions={additions} deletions={deletions} /> : null}
          disabled={changesDisabled}
          onClick={() => {
            onToggleDiff();
            onClose();
          }}
        />
      ) : null}

      {isGitRepo ? <BranchToolbar {...branchToolbar} variant="panel" /> : null}

      {showGitActions ? (
        <GitActionsControl
          gitCwd={gitCwd}
          activeThreadId={activeThreadId}
          variant="panel"
          onRegisterCommitAndPushTrigger={onRegisterCommitAndPushTrigger}
        />
      ) : null}

      <EnvironmentLocalServersSection enabled={open} />

      {sidechats && activeThreadId ? (
        <EnvironmentSidechatsSection
          sidechats={sidechats}
          onCreate={() => {
            void waitForSidechatCreator(activeThreadId)
              .then((createSidechat) => {
                if (!createSidechat) {
                  toastManager.add({
                    type: "warning",
                    title: "Side chat is unavailable",
                    description: "Open a server-backed main thread before starting a side chat.",
                  });
                  return;
                }
                return createSidechat();
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Could not start side chat",
                  description:
                    error instanceof Error
                      ? error.message
                      : "An error occurred while creating the side chat.",
                });
              });
          }}
          onOpen={(sidechatThreadId) => {
            openRightDockPane(activeThreadId, {
              kind: "sidechat",
              threadId: sidechatThreadId,
            });
            onClose();
          }}
        />
      ) : null}

      {/*
        Optional sections below the git block. Each renders its own leading divider only when it
        actually shows, so toggling any section via the header gear menu never leaves a doubled or
        dangling rule. Visibility is gated on the per-section AppSettings flags.
      */}
      {settings.showEnvironmentUsage ? <EnvironmentUsageSection /> : null}

      {settings.showEnvironmentRepository && githubRepository && onOpenGithubRepository ? (
        <EnvironmentLabeledSection label="Repository">
          <EnvironmentRow
            icon={<GitHubIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
            label={<span className="truncate">{githubRepository.nameWithOwner}</span>}
            trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
            onClick={() => {
              onOpenGithubRepository(githubRepository.url);
              onClose();
            }}
          />
        </EnvironmentLabeledSection>
      ) : null}

      {settings.showEnvironmentPullRequest && isGitRepo && onOpenGithubRepository ? (
        <EnvironmentPullRequestSection
          gitCwd={gitCwd}
          enabled={open}
          activeThreadId={activeThreadId}
          projectId={activeProjectId}
          configuredRepositories={githubRepositories}
          showDiffColors={settings.showPullRequestDiffColors}
          onOpenUrl={onOpenGithubRepository}
          onClose={onClose}
        />
      ) : null}

      {isStudioChat && activeThreadId ? (
        <EnvironmentStudioOutputsSection threadId={activeThreadId} enabled={open} />
      ) : null}

      {settings.showEnvironmentEditor ? (
        <EnvironmentEditorSection
          keybindings={keybindings}
          availableEditors={availableEditors}
          openInTarget={openInTarget}
          {...(onOpenEditorView
            ? {
                onOpenEditorView: () => {
                  onOpenEditorView();
                  onClose();
                },
              }
            : {})}
        />
      ) : null}

      {settings.showEnvironmentRecap && showRecap && recap ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentRecapSection recap={recap} markdownCwd={markdownCwd} />
        </>
      ) : null}

      {settings.showEnvironmentPinned && pinnedMessages.length > 0 ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentPinnedSection
            pins={pinnedMessages}
            messageTextById={pinnedMessageTextById}
            onJump={onJumpToPinnedMessage}
            onToggleDone={onTogglePinnedMessageDone}
            onUnpin={onUnpinMessage}
            onRename={onRenamePinnedMessage}
          />
        </>
      ) : null}

      {settings.showEnvironmentMarkers && threadMarkers.length > 0 ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentMarkersSection
            markers={threadMarkers}
            messageTextById={markerMessageTextById}
            onJump={onJumpToThreadMarker}
            onToggleDone={onToggleThreadMarkerDone}
            onRemove={onRemoveThreadMarker}
            onRename={onRenameThreadMarker}
          />
        </>
      ) : null}

      {settings.showEnvironmentInstructions && activeProjectId ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentProjectInstructionsSection
            key={activeProjectId}
            projectId={activeProjectId}
            instructions={projectInstructions}
            threadNotes={notes}
            canCopyToThreadNotes={canCopyProjectInstructionsToNotes}
            onInstructionsChange={onProjectInstructionsChange}
            onCopyToThreadNotes={onCopyProjectInstructionsToNotes}
          />
        </>
      ) : null}

      {settings.showEnvironmentNotepad && activeThreadId ? (
        <>
          <EnvironmentSectionDivider />
          <EnvironmentNotesSection
            key={activeThreadId}
            threadId={activeThreadId}
            notes={notes}
            onChange={onNotesChange}
          />
        </>
      ) : null}
    </div>
  );

  // Top-right overlay pinned to the chat column with p-3 edge gutters (same footprint in
  // split panes and when the right dock is open). Docked mode additionally insets transcript
  // content; floating overlays only without stealing flex width from the narrow chat pane.
  return (
    <div
      className={ENVIRONMENT_PANEL_OVERLAY_WRAPPER_CLASS_NAME}
      data-environment-panel-variant={variant}
      aria-hidden={!open}
    >
      <div
        className={cn(
          ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
          ENVIRONMENT_PANEL_MOTION_CLASS,
          "flex max-h-full w-72 flex-col",
          open
            ? "pointer-events-auto translate-x-0 opacity-100"
            : "pointer-events-none translate-x-full opacity-0",
        )}
      >
        <div className="min-h-0 overflow-y-auto">{content}</div>
      </div>
    </div>
  );
}
