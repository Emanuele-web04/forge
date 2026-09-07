// FILE: SidebarThreadBranchControl.tsx
// Purpose: Numeric inline branch toggle shared by every sidebar surface.
// Layer: Sidebar UI primitive
// Exports: SidebarThreadBranchControl, formatSubagentCounter, formatBranchCount
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

export function formatSubagentCounter(count: number): string {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `${total} ${pluralize(total, "subagent", "subagents")}`;
}

/** Visible toggle text: the direct child count only; above 99 it reads `99+`. */
export function formatBranchCount(count: number): string {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return total > 99 ? "99+" : String(total);
}

function formatCount99(count: number): string {
  return count > 99 ? "99+" : String(Math.max(0, Math.floor(count)));
}

function stopBranchControlPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

export function SidebarThreadBranchControl(props: {
  threadId: ThreadId;
  title: string;
  directChildCount: number;
  expanded: boolean;
  controlsId: string;
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
    onToggle,
    threadId,
    title,
  } = props;
  const total = Number.isFinite(directChildCount) ? Math.max(0, Math.floor(directChildCount)) : 0;

  // The label lists every hidden status count; the visible aggregate keeps a
  // single glyph by priority (attention > running > unread).
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
        <span className="inline-flex shrink-0 items-center gap-0.5 text-amber-600 tabular-nums dark:text-amber-300/90">
          <TriangleAlertIcon aria-hidden="true" className="size-3" />
          <span className="text-[length:var(--app-font-size-ui,11px)] leading-none">
            {formatCount99(hiddenSummary.attentionCount)}
          </span>
        </span>
      );
    } else if (hiddenSummary.runningCount > 0) {
      aggregate = (
        <span className="inline-flex shrink-0 items-center" aria-hidden="true">
          <ThreadRunningSpinner className="size-3" />
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
        "inline-flex max-w-full min-h-6 min-w-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 text-[length:var(--app-font-size-ui,11px)] tabular-nums hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-1 active:bg-transparent",
        "pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        hiddenSummary?.containsActiveThread === true
          ? "text-[var(--color-text-accent)] hover:text-[var(--color-text-accent)] active:text-[var(--color-text-accent)]"
          : "text-muted-foreground/79 hover:text-foreground active:text-foreground",
      )}
    >
      <DisclosureChevron open={expanded} className="size-3" />
      <span className="truncate">{formatBranchCount(total)}</span>
      {aggregate}
    </button>
  );
}
