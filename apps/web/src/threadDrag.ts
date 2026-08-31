// FILE: threadDrag.ts
// Purpose: Shares the sidebar thread drag payload contract across drop targets.
// Layer: Web UI utility
// Exports: drag payload helpers and virtual-folder drop/menu target resolvers.

import type { ThreadId } from "@synara/contracts";

// Custom MIME so file drops and other native drags cannot trigger thread actions.
export const THREAD_DRAG_MIME = "application/x-synara-thread";
const THREAD_FOLDER_ACTION_PREFIX = "folder:";

export interface ThreadDragPayload {
  threadId: ThreadId;
}

// Match the minimum comfortable pointer target used by the rest of the UI. The
// previous 20px rail made dragging a thread out of a folder needlessly precise.
export const SIDEBAR_FOLDER_ROOT_GUTTER_PX = 44;

type ThreadDragDataTransfer = Pick<DataTransfer, "getData" | "types">;

export function hasThreadDragType(dataTransfer: ThreadDragDataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(THREAD_DRAG_MIME);
}

export function parseThreadDragPayload(
  dataTransfer: Pick<DataTransfer, "getData">,
): ThreadDragPayload | null {
  try {
    const raw = dataTransfer.getData(THREAD_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ThreadDragPayload>;
    if (typeof parsed.threadId !== "string" || parsed.threadId.length === 0) return null;
    return { threadId: parsed.threadId as ThreadId };
  } catch {
    return null;
  }
}

export function resolveSidebarFolderDropTarget(input: {
  clientX: number;
  containerLeft: number;
  folderId: string;
}): string | null {
  return input.clientX <= input.containerLeft + SIDEBAR_FOLDER_ROOT_GUTTER_PX
    ? null
    : input.folderId;
}

export function resolveThreadFolderMenuTarget(actionId: string): string | null {
  const target = actionId.slice(THREAD_FOLDER_ACTION_PREFIX.length);
  return target === "root" ? null : target;
}
