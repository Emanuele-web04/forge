// FILE: SidebarThreadBranchControl.tsx
// Purpose: Shared subagent disclosure. Classic rows reserve a trailing slot;
//          Activity rows place a compact control before the parent title.
// Layer: Sidebar UI primitive
// Exports: SidebarThreadBranchControl, SidebarThreadBranchSlot, SidebarBranchSlotLayout,
//          formatSubagentCounter, formatBranchCount
// Depends on: DisclosureChevron + disclosureMotion only for the chevron.

import type {
  MouseEvent as ReactMouseEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  Ref,
  SyntheticEvent,
} from "react";

import type { ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";

import { TriangleAlertIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import type { HiddenBranchSummary } from "./sidebarThreadHierarchyPresentation";
import { SidebarUnreadCompletionGlyph } from "./SidebarStatusTrailingGlyph";
import { ThreadRunningSpinner } from "./ThreadRunningSpinner";
import { DisclosureChevron } from "./ui/DisclosureChevron";

/**
 * Classic one-line rows (Projects, Chats, Studio, Pinned) reserve 44px; the
 * Activity title uses a 40px control. Both are `min-w` so the
 * slot only grows when the hidden-attention aggregate (icon + count) is present;
 * the chevron and count stay right-aligned and never move.
 */
export type SidebarBranchSlotLayout = "classic" | "activity";

// Activity uses the title line height; both layouts expand for coarse pointers.
const SLOT_LAYOUT_CLASS: Record<SidebarBranchSlotLayout, string> = {
  classic: "min-w-11 pointer-coarse:min-h-11",
  activity: "min-w-10 min-h-7 justify-center self-center px-1 pointer-coarse:min-h-11",
};

const SLOT_CHEVRON_CLASS: Record<SidebarBranchSlotLayout, string> = {
  classic: "size-3",
  activity: "size-3",
};

const SLOT_BASE_CLASS =
  "inline-flex shrink-0 items-center justify-end gap-1 self-stretch tabular-nums";

export function formatSubagentCounter(count: number): string {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `${total} ${pluralize(total, "subagent", "subagents")}`;
}

/** Visible toggle text: the direct child count only; above 99 it reads `99+`. */
export function formatBranchCount(count: number): string {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return total > 99 ? "99+" : String(total);
}

function stopBranchControlPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

/** Classic rows keep their trailing columns aligned; Activity has no empty control. */
export function SidebarThreadBranchSlot(props: { layout: SidebarBranchSlotLayout }) {
  if (props.layout === "activity") return null;
  return (
    <span
      aria-hidden="true"
      data-thread-branch-slot="empty"
      className={cn(SLOT_BASE_CLASS, SLOT_LAYOUT_CLASS[props.layout])}
    />
  );
}

export function SidebarThreadBranchControl(props: {
  threadId: ThreadId;
  title: string;
  directChildCount: number;
  expanded: boolean;
  controlsId: string;
  layout?: SidebarBranchSlotLayout | undefined;
  hiddenSummary?: HiddenBranchSummary | undefined;
  onToggle: (threadId: ThreadId) => void;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}) {
  const {
    buttonRef,
    controlsId,
    directChildCount,
    expanded,
    hiddenSummary,
    layout = "classic",
    onToggle,
    threadId,
    title,
  } = props;
  const total = Number.isFinite(directChildCount) ? Math.max(0, Math.floor(directChildCount)) : 0;

  // The label lists every hidden status count; the visible aggregate keeps a
  // single glyph by priority (attention > running > unread), placed before the
  // chevron so the right-aligned chevron + count never shift.
  const hiddenParts: string[] = [];
  let aggregate: ReactNode = null;
  if (hiddenSummary && hiddenSummary.hiddenCount > 0) {
    if (hiddenSummary.attentionCount > 0) {
      hiddenParts.push(
        `${hiddenSummary.attentionCount} hidden need${hiddenSummary.attentionCount === 1 ? "s" : ""} attention`,
      );
    }
    if (hiddenSummary.runningCount > 0) {
      hiddenParts.push(`${hiddenSummary.runningCount} hidden running`);
    }
    if (hiddenSummary.unreadCount > 0) {
      hiddenParts.push(`${hiddenSummary.unreadCount} hidden unread`);
    }
    if (hiddenSummary.attentionCount > 0) {
      aggregate = (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-amber-600 dark:text-amber-300/90">
          <TriangleAlertIcon aria-hidden="true" className={SLOT_CHEVRON_CLASS[layout]} />
          <span className="text-[length:var(--app-font-size-ui,11px)] leading-none">
            {formatBranchCount(hiddenSummary.attentionCount)}
          </span>
        </span>
      );
    } else if (hiddenSummary.runningCount > 0) {
      aggregate = (
        <span className="inline-flex shrink-0 items-center" aria-hidden="true">
          <ThreadRunningSpinner className={SLOT_CHEVRON_CLASS[layout]} />
        </span>
      );
    } else if (hiddenSummary.unreadCount > 0) {
      aggregate = <SidebarUnreadCompletionGlyph />;
    }
  }
  const accessibleLabel = [
    `${expanded ? "Collapse" : "Expand"} ${formatSubagentCounter(total)} for ${title}`,
    ...hiddenParts,
    hiddenSummary?.containsActiveThread === true ? "contains the current conversation" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle(threadId);
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={expanded}
      aria-controls={controlsId}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      data-thread-selection-safe
      data-thread-branch-slot="control"
      onPointerDown={stopBranchControlPropagation}
      onClick={handleClick}
      onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
        // Native button keeps its Enter/Space activation; stop the row from
        // also treating the key as navigation.
        event.stopPropagation();
      }}
      onDoubleClick={stopBranchControlPropagation}
      onContextMenu={stopBranchControlPropagation}
      className={cn(
        SLOT_BASE_CLASS,
        SLOT_LAYOUT_CLASS[layout],
        "cursor-pointer rounded-md text-[length:var(--app-font-size-ui,11px)] focus-visible:outline-2 focus-visible:-outline-offset-2",
        layout === "activity"
          ? "bg-foreground/5 hover:bg-foreground/10 active:bg-foreground/15"
          : "hover:bg-transparent active:bg-transparent",
        hiddenSummary?.containsActiveThread === true
          ? "text-[var(--color-text-accent)] hover:text-[var(--color-text-accent)] active:text-[var(--color-text-accent)]"
          : "text-muted-foreground/79 hover:text-foreground active:text-foreground",
      )}
    >
      {aggregate}
      <DisclosureChevron open={expanded} className={SLOT_CHEVRON_CLASS[layout]} />
      <span className="min-w-3 shrink-0 text-right">{formatBranchCount(total)}</span>
    </button>
  );
}
