// FILE: sidebarThreadHierarchyPresentation.ts
// Purpose: Pure hidden-descendant aggregation and explicit-navigation reveal planning.
// Layer: Sidebar model (no React, no storage).
// Exports: HiddenBranchSummary, HierarchyRevealPlan, buildHiddenBranchSummaries,
// buildHierarchyRevealPlan.

import type { ThreadId } from "@synara/contracts";

import type { SidebarThreadSummary } from "../types";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { getChildThreadIds, type ThreadHierarchyIndex } from "./sidebarThreadHierarchy";

export interface HiddenBranchSummary {
  hiddenCount: number;
  attentionCount: number;
  runningCount: number;
  unreadCount: number;
  containsActiveThread: boolean;
}

export interface HierarchyRevealPlan {
  ancestorIds: readonly ThreadId[];
  minimumVisibleCountByParentId: ReadonlyMap<ThreadId, number>;
}

type MutableHiddenBranchSummary = {
  hiddenCount: number;
  attentionCount: number;
  runningCount: number;
  unreadCount: number;
  containsActiveThread: boolean;
};

function isAttentionStatus(status: ThreadStatusPill): boolean {
  return (
    status.label === "Pending Approval" ||
    status.label === "Awaiting Input" ||
    status.label === "Plan Ready"
  );
}

function isRunningStatus(status: ThreadStatusPill): boolean {
  return status.label === "Working" || status.label === "Connecting";
}

/**
 * One summary per visible branch from descendants that are not represented by
 * visible thread rows. Each hidden descendant is assigned to its nearest
 * visible ancestor so a hidden grandchild under an already visible child is
 * never double-counted on the root. The ancestor's own status never counts.
 * Single iterative forest traversal: O(n).
 */
export function buildHiddenBranchSummaries(input: {
  index: ThreadHierarchyIndex<SidebarThreadSummary>;
  visibleThreadIds: ReadonlySet<ThreadId>;
  statusByThreadId: ReadonlyMap<ThreadId, ThreadStatusPill | null>;
  activeThreadId: ThreadId | null;
}): ReadonlyMap<ThreadId, HiddenBranchSummary> {
  const { activeThreadId, index, statusByThreadId, visibleThreadIds } = input;
  const summaries = new Map<ThreadId, MutableHiddenBranchSummary>();

  type StackEntry = { nodeId: ThreadId; owner: ThreadId | null };
  const stack: StackEntry[] = [];
  for (let rootPosition = index.rootIds.length - 1; rootPosition >= 0; rootPosition -= 1) {
    const rootId = index.rootIds[rootPosition];
    if (rootId !== undefined) {
      stack.push({ nodeId: rootId, owner: null });
    }
  }

  while (stack.length > 0) {
    const { nodeId, owner } = stack.pop() as StackEntry;
    const isVisible = visibleThreadIds.has(nodeId);
    if (!isVisible && owner !== null) {
      let summary = summaries.get(owner);
      if (!summary) {
        summary = {
          hiddenCount: 0,
          attentionCount: 0,
          runningCount: 0,
          unreadCount: 0,
          containsActiveThread: false,
        };
        summaries.set(owner, summary);
      }
      summary.hiddenCount += 1;
      const status = statusByThreadId.get(nodeId) ?? null;
      if (status !== null) {
        if (isAttentionStatus(status)) {
          summary.attentionCount += 1;
        } else if (isRunningStatus(status)) {
          summary.runningCount += 1;
        } else if (status.label === "Completed") {
          summary.unreadCount += 1;
        }
      }
      if (activeThreadId !== null && nodeId === activeThreadId) {
        summary.containsActiveThread = true;
      }
    }
    const childOwner = isVisible ? nodeId : owner;
    const childIds = getChildThreadIds(index, nodeId);
    for (let position = childIds.length - 1; position >= 0; position -= 1) {
      const childId = childIds[position];
      if (childId !== undefined) {
        stack.push({ nodeId: childId as ThreadId, owner: childOwner });
      }
    }
  }

  return summaries;
}

/**
 * Explicit-navigation reveal plan for one thread: nearest-parent-first
 * ancestors plus, per (parent, child-on-path) pair, the child's zero-based
 * position plus one in the parent's already sorted child array. Empty for
 * hidden/unknown nodes. Pure: modifies neither expansion nor index data.
 */
export function buildHierarchyRevealPlan(input: {
  index: ThreadHierarchyIndex<SidebarThreadSummary>;
  threadId: ThreadId;
}): HierarchyRevealPlan {
  const { index, threadId } = input;
  const empty: HierarchyRevealPlan = {
    ancestorIds: [],
    minimumVisibleCountByParentId: new Map(),
  };
  if (!index.nodesById.has(threadId) || index.hiddenThreadIds.has(threadId)) {
    return empty;
  }
  const ancestorIds: ThreadId[] = [];
  const seen = new Set<string>([threadId as string]);
  let current = index.parentIdByThreadId.get(threadId);
  while (current !== undefined) {
    const key = current as string;
    if (seen.has(key)) {
      break;
    }
    seen.add(key);
    ancestorIds.push(current);
    if (ancestorIds.length > index.nodesById.size) {
      break;
    }
    current = index.parentIdByThreadId.get(current);
  }
  if (ancestorIds.length === 0) {
    return { ancestorIds, minimumVisibleCountByParentId: new Map() };
  }
  const minimumVisibleCountByParentId = new Map<ThreadId, number>();
  for (let level = 0; level < ancestorIds.length; level += 1) {
    const parentId = ancestorIds[level] as ThreadId;
    const childOnPath = (level === 0 ? threadId : ancestorIds[level - 1]) as ThreadId;
    const childIds = getChildThreadIds(index, parentId);
    const position = childIds.indexOf(childOnPath);
    if (position >= 0) {
      minimumVisibleCountByParentId.set(parentId, position + 1);
    }
  }
  return { ancestorIds, minimumVisibleCountByParentId };
}
