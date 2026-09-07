// FILE: SidebarCompactChildRow.tsx
// Purpose: Single descendant-row layout shared by classic and Activity surfaces.
// Layer: Sidebar UI component
// Exports: SidebarCompactChildRow, SidebarCompactChildRowProps
// Depends on: SidebarThreadRowContent (compact options), branch control slot,
// status glyphs, row gestures, and the existing hover-card primitives.

import type {
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import type { ThreadId } from "@synara/contracts";

import { splitShortcutLabel } from "../keybindings";
import { cn } from "../lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../sidebarRowStyles";
import type { SidebarThreadSummary } from "../types";
import {
  createSidebarThreadHoverAnchorId,
  resolveThreadStatusTrailingIndicator,
} from "./Sidebar.logic";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";
import {
  createSidebarThreadRowGestures,
  type SidebarRowContextMenuPosition,
} from "./sidebarThreadRowGestures";
import { SIDEBAR_HOVER_CARD_TRIGGER_PROPS } from "./sidebarHoverCardStyles";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

export interface SidebarCompactChildRowProps {
  thread: SidebarThreadSummary;
  surface: string;
  isActive: boolean;
  isSelected: boolean;
  status: ThreadStatusPill | null;
  branchControl: ReactNode;
  threadJumpLabel: string | null;
  onActivate: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPrime: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onRename: (threadId: ThreadId) => void;
  onRenamePointerUp: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onContextMenu: (threadId: ThreadId, position: SidebarRowContextMenuPosition) => void;
  renderHoverCard: (anchorId: string) => ReactNode;
  actions: ReactNode;
  /**
   * Existing surface drag behavior (dataTransfer/selection) for natively
   * draggable children. Source/batch children are never independently
   * draggable project/folder roots; callers simply omit this prop for them.
   */
  dragProps?:
    | Pick<HTMLAttributes<HTMLDivElement>, "draggable" | "onDragStart" | "onDragEnd">
    | undefined;
}

function hoverScopeForSurface(surface: string): "activity" | "chat" | "pinned" | "project" {
  if (surface === "activity") return "activity";
  if (surface === "pinned") return "pinned";
  if (surface === "project") return "project";
  return "chat";
}

/**
 * True when the gesture originated on a sibling control (branch toggle, hover
 * action) rather than the row's own navigation button, so wrapper gestures such
 * as rename-on-pointer-up do not fire for it.
 */
export function isSiblingControlTarget(
  target: EventTarget | null,
  navSelector = "[data-compact-nav]",
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.closest("button") !== null && target.closest(navSelector) === null;
}

export function SidebarCompactChildRow(props: SidebarCompactChildRowProps) {
  const {
    actions,
    branchControl,
    dragProps,
    isActive,
    isSelected,
    onActivate,
    onContextMenu,
    onPrime,
    onRename,
    onRenamePointerUp,
    renderHoverCard,
    status,
    surface,
    thread,
    threadJumpLabel,
  } = props;
  const hoverAnchorId = createSidebarThreadHoverAnchorId({
    scope: hoverScopeForSurface(surface),
    threadId: thread.id,
  });
  // The existing visibility rule (including unread suppression for the actually
  // active child); the slot stays reserved so pending/working status never
  // disappears when hover actions appear.
  const visibleStatus = resolveThreadStatusTrailingIndicator({
    status,
    slotOccupied: threadJumpLabel !== null,
    isActive,
  });
  const threadJumpLabelParts = threadJumpLabel ? splitShortcutLabel(threadJumpLabel) : [];
  const gestures = createSidebarThreadRowGestures({
    threadId: thread.id,
    onRename,
    onRenamePointerUp,
    onContextMenu,
  });
  const handleDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (isSiblingControlTarget(event.target)) {
      return;
    }
    gestures.onDoubleClick(event);
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (isSiblingControlTarget(event.target)) {
      return;
    }
    gestures.onPointerUp(event);
  };
  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (isSiblingControlTarget(event.target)) {
      return;
    }
    gestures.onContextMenu(event);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
        render={
          <div
            data-thread-hover-anchor={hoverAnchorId}
            data-thread-item
            className={cn(
              "group/compact-child group/thread-row group/activity-row relative flex min-h-7 min-w-0 items-center gap-1 rounded-md pointer-coarse:min-h-11",
              isActive || isSelected
                ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
                : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
            )}
            onDoubleClick={handleDoubleClick}
            onPointerUp={handlePointerUp}
            onContextMenu={handleContextMenu}
            {...dragProps}
          />
        }
      >
        <button
          type="button"
          data-compact-nav
          onClick={onActivate}
          onPointerDown={onPrime}
          aria-current={isActive ? "page" : undefined}
          aria-label={thread.title}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center text-left select-none",
            SIDEBAR_ROW_FOCUS_CLASS_NAME,
          )}
        >
          <span
            aria-hidden="true"
            className="relative inline-flex h-3.5 w-[18px] shrink-0 items-center"
          >
            <span className="absolute left-1.5 top-0 bottom-0 w-px rounded-full bg-border/35" />
            <span className="absolute left-1.5 top-1/2 h-px w-2.5 -translate-y-1/2 bg-border/35" />
          </span>
          <SidebarThreadRowContent
            thread={thread}
            terminalEntryPoint={false}
            terminalStatus={null}
            terminalCount={0}
            isActive={isActive}
            variant="standard"
            isHierarchyChild
            showHierarchyConnector={false}
          />
        </button>
        {branchControl}
        {visibleStatus ? <SidebarStatusTrailingGlyph status={visibleStatus} /> : null}
        {threadJumpLabelParts.length > 0 ? (
          <KbdGroup className="shrink-0">
            {threadJumpLabelParts.map((part) => (
              <Kbd key={part}>{part}</Kbd>
            ))}
          </KbdGroup>
        ) : null}
        {actions ? <span className="inline-flex shrink-0 items-center">{actions}</span> : null}
      </TooltipTrigger>
      {renderHoverCard(hoverAnchorId)}
    </Tooltip>
  );
}
