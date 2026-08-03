// FILE: KanbanCardView.tsx
// Purpose: Presentational kanban card — title, draft preview, provider/branch/env/PR
//          meta row with status pill and relative timestamp.
// Layer: UI component (pure; drag wiring lives in KanbanColumn)
// Exports: KanbanCardView

import { GoRepoForked } from "react-icons/go";

import { PrStateChip } from "../pullRequest/PrStateChip";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusPillChip } from "../ThreadStatusPillChip";
import { ProviderIcon } from "../ProviderIcon";
import {
  GitBranchIcon,
  LoaderIcon,
  PaperclipIcon,
  PinFilledIcon,
  TerminalIcon,
  WorktreeIcon,
} from "~/lib/icons";
import { resolveThreadEnvironmentPresentation } from "~/lib/threadEnvironment";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { formatElapsed } from "../../session-logic";
import { RAISED_SURFACE_CHROME_CLASS_NAME } from "../chat/composerPickerStyles";
import { KanbanStatusIcon } from "./KanbanStatusIcon";
import { KANBAN_COLUMN_LABELS, kanbanThreadCardId, type KanbanCard } from "./kanban.logic";

export interface KanbanCardViewProps {
  card: KanbanCard;
  onOpen?: (card: KanbanCard) => void;
  /** Right-click handler — opens the sidebar-style thread/draft context menu. */
  onContextMenu?: (card: KanbanCard, event: React.MouseEvent) => void;
  /** Rendered inside the DragOverlay — lifted styling, no interactions. */
  isOverlay?: boolean;
  /** The in-column original while its overlay clone is being dragged. */
  isDragSource?: boolean;
  /** Shared wall-clock tick from the board root for live elapsed labels. */
  nowMs?: number;
}

/**
 * At-a-glance status tag. Terminal-first threads get a dedicated "Terminal" tag —
 * an idle terminal is not a draft, so column status would be misleading.
 */
function KanbanCardColumnLabel({ card }: { card: KanbanCard }) {
  if (card.isTerminal) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/80">
        <TerminalIcon className="size-3 shrink-0" aria-hidden />
        Terminal
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/80">
      <KanbanStatusIcon column={card.column} className="size-3" />
      {KANBAN_COLUMN_LABELS[card.column]}
    </span>
  );
}

// Pills that merely restate the card's column add nothing, so we drop them and
// let the column label speak: "Working"/"Connecting" duplicate the "In Progress"
// column, and "Completed" duplicates "Done". Distinct, actionable states
// (Pending Approval, Awaiting Input, Plan Ready) still surface as pills.
const REDUNDANT_COLUMN_PILL_LABELS = new Set(["Working", "Connecting", "Completed"]);

function KanbanCardStatusPill({ card }: { card: KanbanCard }) {
  const pill = card.thread
    ? resolveThreadStatusPill({
        thread: card.thread,
        hasPendingApprovals: card.thread.hasPendingApprovals,
        hasPendingUserInput: card.thread.hasPendingUserInput,
      })
    : null;
  if (!pill || REDUNDANT_COLUMN_PILL_LABELS.has(pill.label)) {
    return null;
  }
  return <ThreadStatusPillChip pill={pill} />;
}

function KanbanCardViewComponent({
  card,
  onOpen,
  onContextMenu,
  isOverlay: isOverlayProp,
  isDragSource: isDragSourceProp,
  nowMs,
}: KanbanCardViewProps) {
  const isOverlay = isOverlayProp ?? false;
  const isDragSource = isDragSourceProp ?? false;
  // Thread-backed draft cards keep their own title, so the unsent prompt is shown
  // separately; local drafts and unsent-prompt cards already title themselves from it.
  const showDraftPreview =
    card.column === "draft" &&
    card.draftPrompt.length > 0 &&
    card.cardId === kanbanThreadCardId(card.threadId);

  const isForked = Boolean(card.thread?.forkSourceThreadId && !card.thread.sidechatSourceThreadId);
  const worktreeBadgeLabel = resolveThreadEnvironmentPresentation({
    envMode: card.envMode,
    worktreePath: card.worktreePath,
  }).worktreeBadgeLabel;
  const pr = card.thread?.lastKnownPr ?? null;
  const activeWorkElapsed =
    card.activeWorkStartedAt && nowMs
      ? formatElapsed(card.activeWorkStartedAt, new Date(nowMs).toISOString())
      : null;

  return (
    <button
      type="button"
      tabIndex={isOverlay ? -1 : 0}
      onClick={onOpen ? () => onOpen(card) : undefined}
      onContextMenu={onContextMenu ? (event) => onContextMenu(card, event) : undefined}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1.5 rounded-lg bg-card/70 px-3 py-2.5 text-left transition-colors",
        RAISED_SURFACE_CHROME_CLASS_NAME,
        // The shared raised chrome drops its border in dark mode (shadow-only),
        // which leaves kanban cards edgeless against the column. Re-add a faint
        // hairline so each card stays visually separated in dark mode.
        "dark:border dark:border-white/[0.05]",
        "hover:bg-card focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isOverlay && "bg-card shadow-lg dark:shadow-lg",
        isDragSource && "opacity-40",
      )}
    >
      <span className="flex min-w-0 items-start gap-1.5">
        <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-medium text-foreground/90">
          {card.title}
        </span>
        {card.thread?.isPinned ? (
          <span title="Pinned" className="flex shrink-0 items-center pt-0.5">
            <PinFilledIcon className="size-3 text-muted-foreground/60" aria-hidden />
          </span>
        ) : null}
      </span>
      {showDraftPreview ? (
        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
          {card.draftPrompt}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-2 pt-0.5">
        {card.isTerminal ? null : (
          <ProviderIcon
            provider={card.provider}
            className="size-3.5 shrink-0 opacity-80"
            fallback={
              <span className="size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
            }
          />
        )}
        {card.branch ? (
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/70">
            <GitBranchIcon className="size-3 shrink-0" aria-hidden />
            <span className="max-w-32 truncate">{card.branch}</span>
          </span>
        ) : null}
        {worktreeBadgeLabel ? (
          <span title={worktreeBadgeLabel} className="flex shrink-0 items-center">
            <WorktreeIcon className="size-3 text-muted-foreground/70" aria-hidden />
          </span>
        ) : null}
        {isForked ? (
          <span title="Forked thread" className="flex shrink-0 items-center">
            <GoRepoForked
              className="size-3 text-emerald-600 dark:text-emerald-300/90"
              aria-hidden
            />
          </span>
        ) : null}
        {pr ? <PrStateChip pr={pr} /> : null}
        {card.draftHasAttachments ? (
          <PaperclipIcon className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
        ) : null}
        <span className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
          {card.isOptimisticDispatch ? (
            // Optimistically In Progress — the thread's real status (Draft/Completed)
            // would contradict the column until the first runtime signal arrives.
            <>
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-sky-600 dark:text-sky-300/90">
                <LoaderIcon className="size-3 shrink-0 animate-spin" aria-hidden />
                Starting…
              </span>
              {activeWorkElapsed ? (
                <span className="shrink-0 text-[11px] text-muted-foreground/70">
                  Worked for {activeWorkElapsed}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <KanbanCardStatusPill card={card} />
              {activeWorkElapsed ? (
                <span className="shrink-0 text-[11px] text-muted-foreground/70">
                  Worked for {activeWorkElapsed}
                </span>
              ) : card.timestamp ? (
                <span className="shrink-0 text-[11px] text-muted-foreground/70">
                  {formatRelativeTime(card.timestamp)}
                </span>
              ) : null}
            </>
          )}
          <KanbanCardColumnLabel card={card} />
        </span>
      </span>
    </button>
  );
}

export const KanbanCardView = KanbanCardViewComponent;
