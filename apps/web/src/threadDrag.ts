// FILE: threadDrag.ts
// Purpose: Shares the sidebar thread drag payload contract across drop targets.
// Layer: Web UI utility
// Exports: drag MIME, payload parser, and drag-type guard.

import type { ThreadId } from "@synara/contracts";

// Custom MIME so file drops and other native drags cannot trigger thread actions.
export const THREAD_DRAG_MIME = "application/x-synara-thread";

export interface ThreadDragPayload {
  threadId: ThreadId;
}

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
