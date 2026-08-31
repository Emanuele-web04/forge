// FILE: sidebarThreadHierarchy.ts
// Purpose: Resolves the presentation-only parent relation used by the sidebar thread tree.

import type { ThreadId } from "@synara/contracts";

import type { SidebarThreadSummary } from "../types";

type SidebarHierarchyThread = Partial<
  Pick<SidebarThreadSummary, "parentThreadId" | "creationSource" | "sourceThreadId">
>;

export function resolveSidebarParentThreadId(
  thread: SidebarHierarchyThread,
): ThreadId | null {
  const nativeParentThreadId = thread.parentThreadId ?? null;
  if (nativeParentThreadId) {
    return nativeParentThreadId;
  }

  return thread.creationSource === "synara_mcp" ? (thread.sourceThreadId ?? null) : null;
}
