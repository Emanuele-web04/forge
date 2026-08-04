// FILE: toastRouteVisibility.ts
// Purpose: Keeps thread-scoped toasts visible for every thread currently rendered in the route.
// Layer: UI helpers
// Exports: visible-thread resolver shared by toast containers and split-aware tests

import type { ThreadId } from "@synara/contracts";
import { resolveSplitViewThreadIds, type SplitView } from "../../splitViewStore";
import type { RightDockThreadState } from "../../rightDockStore.logic";

export function resolveVisibleToastThreadIds(input: {
  activeThreadId: ThreadId | null;
  splitView: SplitView | null;
  rightDockState?: RightDockThreadState | null;
}): ReadonlySet<ThreadId> {
  const visibleThreadIds = input.splitView
    ? new Set(resolveSplitViewThreadIds(input.splitView))
    : input.activeThreadId
      ? new Set([input.activeThreadId])
      : new Set<ThreadId>();

  if (!input.splitView && input.rightDockState?.open) {
    const activePane = input.rightDockState.panes.find(
      (pane) => pane.id === input.rightDockState?.activePaneId,
    );
    if (activePane?.kind === "sidechat" && activePane.threadId) {
      visibleThreadIds.add(activePane.threadId);
    }
  }

  return visibleThreadIds;
}

export function shouldRenderToastForVisibleThreads(input: {
  allowCrossThreadVisibility?: boolean | undefined;
  toastThreadId?: ThreadId | null | undefined;
  visibleThreadIds: ReadonlySet<ThreadId>;
}): boolean {
  if (input.allowCrossThreadVisibility) {
    return true;
  }
  const toastThreadId = input.toastThreadId;
  if (!toastThreadId) {
    return true;
  }
  return input.visibleThreadIds.has(toastThreadId);
}
