// FILE: sidebarThreadRowGestures.ts
// Purpose: Single source for the pointer gestures every sidebar thread row shares —
//          double-click (plus touch double-tap) rename and right-click context menu —
//          so the classic list, the pinned list, and the activity feed behave alike.
// Layer: Sidebar UI helper
// Exports: createSidebarThreadRowGestures, isSiblingControlTarget,
//          SidebarRowContextMenuPosition, SidebarThreadRowGestureProps

import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import type { ThreadId } from "@synara/contracts";

export type SidebarRowContextMenuPosition = { x: number; y: number };

/**
 * True when the gesture originated on a sibling control (branch toggle, hover
 * action) rather than the row's own navigation button, so wrapper gestures such
 * as rename-on-pointer-up do not fire for it.
 */
export function isSiblingControlTarget(
  target: EventTarget | null,
  navSelector = "[data-thread-nav]",
): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest("button") !== null && target.closest(navSelector) === null;
}

export type SidebarThreadRowGestureProps = {
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
};

/**
 * Builds the gesture props for one thread row. Both gestures stop propagation so a
 * row nested inside a project/group block never opens two menus (or renames while
 * its container also reacts).
 */
export function createSidebarThreadRowGestures({
  threadId,
  onRename,
  onRenamePointerUp,
  onContextMenu,
}: {
  threadId: ThreadId;
  onRename: (threadId: ThreadId) => void;
  /** Touch/pen double-tap fallback: pointer events, not dblclick, on touch devices. */
  onRenamePointerUp: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onContextMenu: (threadId: ThreadId, position: SidebarRowContextMenuPosition) => void;
}): SidebarThreadRowGestureProps {
  return {
    onDoubleClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRename(threadId);
    },
    onPointerUp: (event) => {
      onRenamePointerUp(event, threadId);
    },
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(threadId, { x: event.clientX, y: event.clientY });
    },
  };
}
