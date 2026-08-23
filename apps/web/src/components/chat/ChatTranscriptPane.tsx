// FILE: ChatTranscriptPane.tsx
// Purpose: Isolate the transcript shell so composer state changes do not re-render it unnecessarily.
// Layer: Chat transcript shell
// Depends on: MessagesTimeline and ChatView's list-owned scroll contract.

import { type MessageId, type ThreadId, type ThreadMarker, type TurnId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
} from "react";
import { type TimestampFormat } from "../../appSettings";
import { type TurnDiffSummary, type WorktreeSetupSnapshot } from "../../types";
import { ArrowDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { DISCLOSURE_CONTENT_MOTION_CLASS } from "~/lib/disclosureMotion";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { ChatEmptyStateHero } from "./ChatEmptyStateHero";
import { MessagesTimeline, type MessagesTimelineController } from "./MessagesTimeline";
import { composerOverlayAffordanceBottomPx } from "./composerOverlay";
import { MessageTrail } from "./MessageTrail";
import { createActiveTrailStore, deriveMessageTrailItems } from "./messageTrail.logic";
import { createThreadFindHighlightStore, type ThreadFindHighlightStore } from "./threadFind.logic";
import { AgentActivityDetailView } from "./AgentActivityDetailView";
import type { AgentActivityDetail } from "./agentActivity.logic";

interface ChatTranscriptPaneProps {
  activeThreadId: string;
  activeTurnId?: TurnId | null;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  agentActivityDetail?: AgentActivityDetail | null;
  contentInsetRightPx?: ComponentProps<typeof MessagesTimeline>["contentInsetRightPx"];
  contentInsetBottomPx?: ComponentProps<typeof MessagesTimeline>["contentInsetBottomPx"];
  contentInsetBottomClearancePx?: ComponentProps<
    typeof MessagesTimeline
  >["contentInsetBottomClearancePx"];
  chatFontSizePx: number;
  emptyStateContent?: ReactNode;
  emptyStateProjectName: string | undefined;
  expandedWorkGroups?: Record<string, boolean>;
  hasMessages: boolean;
  isRevertingCheckpoint: boolean;
  isTemporaryThread?: boolean;
  isWorking: boolean;
  workingLabel?: ComponentProps<typeof MessagesTimeline>["workingLabel"];
  followLiveOutput: boolean;
  listRef: RefObject<LegendListRef | null>;
  timelineControllerRef?: RefObject<MessagesTimelineController | null>;
  pinnedMessageIds?: ReadonlySet<MessageId>;
  canPinMessage?: (messageId: MessageId) => boolean;
  onTogglePinMessage?: (messageId: MessageId) => void;
  onForkFromMessage?: (messageId: MessageId) => void;
  threadMarkers?: readonly ThreadMarker[];
  goalAchievements?: ComponentProps<typeof MessagesTimeline>["goalAchievements"];
  enteringUserMessageIds?: ComponentProps<typeof MessagesTimeline>["enteringUserMessageIds"];
  tailAnchorMessageId?: ComponentProps<typeof MessagesTimeline>["tailAnchorMessageId"];
  tailAnchorScrollInFlightRef?: ComponentProps<
    typeof MessagesTimeline
  >["tailAnchorScrollInFlightRef"];
  crossTaskOrigin?: ComponentProps<typeof MessagesTimeline>["crossTaskOrigin"];
  forkSource?: ComponentProps<typeof MessagesTimeline>["forkSource"];
  markdownCwd: string | undefined;
  onExpandTimelineImage: (preview: ExpandedImagePreview) => void;
  onMessagesClickCapture: MouseEventHandler<HTMLDivElement>;
  onMessagesMouseUp: MouseEventHandler<HTMLDivElement>;
  onMessagesPointerCancel: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerDown: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerUp: PointerEventHandler<HTMLDivElement>;
  onMessagesScroll: ComponentProps<typeof MessagesTimeline>["onMessagesScroll"];
  onMessagesTouchEnd: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchMove: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchStart: TouchEventHandler<HTMLDivElement>;
  onMessagesWheel: WheelEventHandler<HTMLDivElement>;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onCloseAgentActivityDetail?: () => void;
  onOpenAgentActivity?: ComponentProps<typeof MessagesTimeline>["onOpenAgentActivity"];
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenAutomation?: ComponentProps<typeof MessagesTimeline>["onOpenAutomation"];
  onRevertUserMessage: (messageId: MessageId) => void;
  onUndoTurnFiles?: ComponentProps<typeof MessagesTimeline>["onUndoTurnFiles"];
  onEditUserMessage?: (messageId: MessageId, text: string) => boolean | Promise<boolean>;
  editableUserMessageId?: MessageId | null;
  onScrollToBottom: () => void;
  onToggleWorkGroup?: (groupId: string) => void;
  resolvedTheme: "light" | "dark";
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  scrollButtonVisible: boolean;
  terminalWorkspaceTerminalTabActive: boolean;
  timelineEntries: ComponentProps<typeof MessagesTimeline>["timelineEntries"];
  timestampFormat: TimestampFormat;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  workspaceRoot: string | undefined;
  worktreeSetup: WorktreeSetupSnapshot | null;
  worktreeSetupPendingAction?: ComponentProps<
    typeof MessagesTimeline
  >["worktreeSetupPendingAction"];
  onResolveWorktreeSetup?: ComponentProps<typeof MessagesTimeline>["onResolveWorktreeSetup"];
  findHighlightStore?: ThreadFindHighlightStore | null;
}

export function ChatTranscriptPane({
  activeThreadId,
  activeTurnId,
  activeTurnInProgress,
  activeTurnStartedAt,
  agentActivityDetail,
  contentInsetRightPx,
  contentInsetBottomPx,
  contentInsetBottomClearancePx,
  chatFontSizePx,
  emptyStateContent,
  emptyStateProjectName,
  expandedWorkGroups,
  hasMessages,
  isRevertingCheckpoint,
  isTemporaryThread,
  isWorking,
  workingLabel,
  followLiveOutput,
  listRef,
  timelineControllerRef,
  pinnedMessageIds,
  canPinMessage,
  onTogglePinMessage,
  onForkFromMessage,
  threadMarkers,
  goalAchievements,
  enteringUserMessageIds,
  tailAnchorMessageId,
  tailAnchorScrollInFlightRef,
  crossTaskOrigin,
  forkSource,
  markdownCwd,
  onExpandTimelineImage,
  onMessagesClickCapture,
  onMessagesMouseUp,
  onMessagesPointerCancel,
  onMessagesPointerDown,
  onMessagesPointerUp,
  onMessagesScroll,
  onMessagesTouchEnd,
  onMessagesTouchMove,
  onMessagesTouchStart,
  onMessagesWheel,
  onIsAtEndChange,
  onCloseAgentActivityDetail,
  onOpenAgentActivity,
  onOpenTurnDiff,
  onOpenThread,
  onOpenAutomation,
  onRevertUserMessage,
  onUndoTurnFiles,
  onEditUserMessage,
  editableUserMessageId,
  onScrollToBottom,
  onToggleWorkGroup,
  resolvedTheme,
  revertTurnCountByUserMessageId,
  scrollButtonVisible,
  terminalWorkspaceTerminalTabActive,
  timelineEntries,
  timestampFormat,
  turnDiffSummaryByAssistantMessageId,
  workspaceRoot,
  worktreeSetup,
  worktreeSetupPendingAction,
  onResolveWorktreeSetup,
  findHighlightStore: findHighlightStoreProp,
}: ChatTranscriptPaneProps) {
  // The composer floats over the transcript's bottom edge, so the scroll-to-bottom
  // affordance rides above it on the same inset the transcript content uses.
  const scrollButtonFrameStyle: CSSProperties | undefined =
    contentInsetRightPx || contentInsetBottomPx
      ? {
          ...(contentInsetRightPx ? { paddingRight: contentInsetRightPx } : {}),
          ...(contentInsetBottomPx
            ? { bottom: composerOverlayAffordanceBottomPx(contentInsetBottomPx) }
            : {}),
        }
      : undefined;

  // Left-edge navigation trail: one tick per sent message. Current + visible
  // highlights are pushed up from MessagesTimeline as the viewport scrolls. They
  // flow through a stable store (not pane state) so scroll updates re-render only
  // the trail, not the memoized timeline; reset on thread switch so stale
  // highlights can't linger.
  const trailItems = deriveMessageTrailItems(timelineEntries);
  const [activeTrailStore] = useState(() => createActiveTrailStore());
  const [fallbackFindHighlightStore] = useState(() => createThreadFindHighlightStore());
  const findHighlightStore = findHighlightStoreProp ?? fallbackFindHighlightStore;
  const findHighlight = useSyncExternalStore(
    findHighlightStore.subscribe,
    findHighlightStore.get,
    findHighlightStore.get,
  );
  useEffect(() => {
    activeTrailStore.set(null);
  }, [activeThreadId, activeTrailStore]);
  const handleTrailSelect = (messageId: MessageId) => {
    timelineControllerRef?.current?.scrollToMessage(messageId);
  };

  return (
    <div
      data-chat-transcript-pane="true"
      aria-hidden={terminalWorkspaceTerminalTabActive}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        terminalWorkspaceTerminalTabActive ? "pointer-events-none invisible" : "",
      )}
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {agentActivityDetail && onCloseAgentActivityDetail ? (
          <AgentActivityDetailView
            detail={agentActivityDetail}
            chatFontSizePx={chatFontSizePx}
            contentInsetRightPx={contentInsetRightPx}
            markdownCwd={markdownCwd}
            onBack={onCloseAgentActivityDetail}
            onImageExpand={onExpandTimelineImage}
            timestampFormat={timestampFormat}
          />
        ) : (
          <MessagesTimeline
            key={activeThreadId}
            hasMessages={hasMessages}
            isWorking={isWorking}
            {...(workingLabel ? { workingLabel } : {})}
            worktreeSetup={worktreeSetup}
            worktreeSetupPendingAction={worktreeSetupPendingAction ?? null}
            {...(onResolveWorktreeSetup ? { onResolveWorktreeSetup } : {})}
            activeTurnId={activeTurnId ?? null}
            activeTurnInProgress={activeTurnInProgress}
            activeTurnStartedAt={activeTurnStartedAt}
            listRef={listRef}
            {...(timelineControllerRef ? { controllerRef: timelineControllerRef } : {})}
            {...(pinnedMessageIds ? { pinnedMessageIds } : {})}
            {...(canPinMessage ? { canPinMessage } : {})}
            {...(onTogglePinMessage ? { onTogglePinMessage } : {})}
            {...(onForkFromMessage ? { onForkFromMessage } : {})}
            {...(threadMarkers ? { threadMarkers } : {})}
            {...(goalAchievements ? { goalAchievements } : {})}
            {...(enteringUserMessageIds ? { enteringUserMessageIds } : {})}
            tailAnchorMessageId={tailAnchorMessageId ?? null}
            {...(tailAnchorScrollInFlightRef ? { tailAnchorScrollInFlightRef } : {})}
            {...(crossTaskOrigin ? { crossTaskOrigin } : {})}
            {...(forkSource ? { forkSource } : {})}
            isTemporaryThread={isTemporaryThread ?? false}
            timelineEntries={timelineEntries}
            turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
            onOpenTurnDiff={onOpenTurnDiff}
            onOpenThread={onOpenThread}
            {...(onOpenAutomation ? { onOpenAutomation } : {})}
            revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
            onRevertUserMessage={onRevertUserMessage}
            {...(onUndoTurnFiles ? { onUndoTurnFiles } : {})}
            {...(onEditUserMessage ? { onEditUserMessage } : {})}
            editableUserMessageId={editableUserMessageId ?? null}
            isRevertingCheckpoint={isRevertingCheckpoint}
            onImageExpand={onExpandTimelineImage}
            followLiveOutput={followLiveOutput}
            onIsAtEndChange={onIsAtEndChange}
            onTrailHighlightsChange={activeTrailStore.set}
            onMessagesScroll={onMessagesScroll}
            onMessagesClickCapture={onMessagesClickCapture}
            onMessagesMouseUp={onMessagesMouseUp}
            onMessagesWheel={onMessagesWheel}
            onMessagesPointerDown={onMessagesPointerDown}
            onMessagesPointerUp={onMessagesPointerUp}
            onMessagesPointerCancel={onMessagesPointerCancel}
            onMessagesTouchStart={onMessagesTouchStart}
            onMessagesTouchMove={onMessagesTouchMove}
            onMessagesTouchEnd={onMessagesTouchEnd}
            markdownCwd={markdownCwd}
            resolvedTheme={resolvedTheme}
            chatFontSizePx={chatFontSizePx}
            timestampFormat={timestampFormat}
            workspaceRoot={workspaceRoot}
            contentInsetRightPx={contentInsetRightPx}
            contentInsetBottomPx={contentInsetBottomPx}
            contentInsetBottomClearancePx={contentInsetBottomClearancePx}
            {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
            findHighlight={findHighlight}
            emptyStateContent={
              emptyStateContent === undefined ? (
                <ChatEmptyStateHero projectName={emptyStateProjectName} />
              ) : (
                emptyStateContent
              )
            }
            {...(expandedWorkGroups ? { expandedWorkGroups } : {})}
            {...(onToggleWorkGroup ? { onToggleWorkGroup } : {})}
          />
        )}

        {!agentActivityDetail ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center py-1",
              // Reuse the shared disclosure motion so the arrow fades + drifts in/out with
              // the same 220ms ease-out curve (and motion-reduce fallback) as every other
              // show/hide in the app. The wrapper stays pointer-events-none; only the
              // button re-enables pointer events while visible.
              DISCLOSURE_CONTENT_MOTION_CLASS,
              scrollButtonVisible ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
            )}
            // Follow the same right inset as transcript rows so the button centers in the
            // visible chat column while the side panel overlays the viewport edge.
            style={scrollButtonFrameStyle}
          >
            <button
              type="button"
              onClick={onScrollToBottom}
              data-scroll-anchor-ignore
              aria-label="Scroll to bottom"
              aria-hidden={!scrollButtonVisible}
              tabIndex={scrollButtonVisible ? 0 : -1}
              className={cn(
                "flex size-8 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground)] backdrop-blur-md hover:cursor-pointer",
                ELEVATED_HOVER_SURFACE_CLASS_NAME,
                scrollButtonVisible ? "pointer-events-auto" : "pointer-events-none",
              )}
            >
              <ArrowDownIcon className="size-3.5" />
            </button>
          </div>
        ) : null}

        {!agentActivityDetail ? (
          <MessageTrail
            items={trailItems}
            activeStore={activeTrailStore}
            onSelect={handleTrailSelect}
          />
        ) : null}
      </div>
    </div>
  );
}
