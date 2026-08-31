// FILE: sidebarSplitGroups.ts
// Purpose: Groups sidebar thread rows that share a split view so the list shows split membership.
// Layer: Sidebar UI logic (pure)
// Exports: split-group index builder, row grouping pass, and the paging clamp that keeps groups whole

import type { ThreadId } from "@synara/contracts";

import { collectLeaves } from "../splitView.logic";
import {
  resolvePreferredSplitViewIdForThread,
  type SplitView,
  type SplitViewId,
} from "../splitViewStore";

export type SidebarSplitGroupPosition = "first" | "middle" | "last";

export interface SidebarSplitGroupInfo {
  splitViewId: SplitViewId;
  /** 1-based pane order among the members actually rendered in this list. */
  memberIndex: number;
  memberCount: number;
  /** True on the first row of the first member; useful for group-level affordances. */
  isLeader: boolean;
  /** Where this row sits inside the group's row span, so the card can cap its ends. */
  position: SidebarSplitGroupPosition;
}

export interface SidebarSplitGroupMembership {
  splitViewId: SplitViewId;
  /** DFS index of the thread's pane in the split tree (first before second). */
  paneOrder: number;
}

// A thread can be a leaf of several split views. resolvePreferredSplitViewIdForThread is the same
// tie-breaker the chat route uses to restore a split, so the sidebar never claims a membership the
// route would not honor: ambiguous non-source threads get no group at all.
export function buildSidebarSplitGroupIndex(input: {
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  splitViewIdBySourceThreadId: Record<string, SplitViewId | undefined>;
}): ReadonlyMap<ThreadId, SidebarSplitGroupMembership> {
  const membershipByThreadId = new Map<ThreadId, SidebarSplitGroupMembership>();

  for (const splitView of Object.values(input.splitViewsById)) {
    if (!splitView) continue;
    let paneOrder = 0;
    for (const leaf of collectLeaves(splitView.root)) {
      const threadId = leaf.threadId;
      if (!threadId) continue;
      const currentPaneOrder = paneOrder;
      paneOrder += 1;
      if (membershipByThreadId.has(threadId)) continue;
      const preferredSplitViewId = resolvePreferredSplitViewIdForThread({
        splitViewsById: input.splitViewsById,
        splitViewIdBySourceThreadId: input.splitViewIdBySourceThreadId,
        threadId,
      });
      if (preferredSplitViewId !== splitView.id) continue;
      membershipByThreadId.set(threadId, {
        splitViewId: splitView.id,
        paneOrder: currentPaneOrder,
      });
    }
  }

  return membershipByThreadId;
}

interface RowBlock<T> {
  rows: T[];
  membership: SidebarSplitGroupMembership | null;
}

type GroupableRow = { thread: { id: ThreadId }; depth: number };

// Reorders the already-sorted rows so split members render contiguously, and annotates each row
// with its position inside the group. The group is anchored where its topmost member already sat,
// so grouping never overrides the list's own sort; members follow pane order below that anchor.
// Subagent rows travel with their parent, and a thread that only shows up as a nested subagent row
// is left alone (it is not addressable as a top-level block).
export function applySidebarSplitGroups<T extends GroupableRow>(input: {
  rows: readonly T[];
  membershipByThreadId: ReadonlyMap<ThreadId, SidebarSplitGroupMembership>;
}): (T & { splitGroup: SidebarSplitGroupInfo | null })[] {
  const { membershipByThreadId, rows } = input;
  if (rows.length === 0 || membershipByThreadId.size === 0) {
    return rows.map((row) => ({ ...row, splitGroup: null }));
  }

  const blocks: RowBlock<T>[] = [];
  for (const row of rows) {
    const currentBlock = blocks.at(-1);
    if (row.depth > 0 && currentBlock) {
      currentBlock.rows.push(row);
      continue;
    }
    blocks.push({
      rows: [row],
      membership: membershipByThreadId.get(row.thread.id) ?? null,
    });
  }

  const blockIndexesByGroupId = new Map<SplitViewId, number[]>();
  blocks.forEach((block, index) => {
    if (!block.membership) return;
    const groupBlockIndexes = blockIndexesByGroupId.get(block.membership.splitViewId) ?? [];
    groupBlockIndexes.push(index);
    blockIndexesByGroupId.set(block.membership.splitViewId, groupBlockIndexes);
  });

  const groupedBlockIndexesByGroupId = new Map<SplitViewId, number[]>();
  for (const [groupId, groupBlockIndexes] of blockIndexesByGroupId) {
    // A single visible member is not a group: the siblings are archived, filtered out, or live in
    // another project's list, and a card around one row would only add noise.
    if (groupBlockIndexes.length < 2) continue;
    groupedBlockIndexesByGroupId.set(
      groupId,
      groupBlockIndexes.toSorted((first, second) => {
        const firstOrder = blocks[first]?.membership?.paneOrder ?? 0;
        const secondOrder = blocks[second]?.membership?.paneOrder ?? 0;
        return firstOrder - secondOrder;
      }),
    );
  }

  const groupedRows: (T & { splitGroup: SidebarSplitGroupInfo | null })[] = [];
  const emittedGroupIds = new Set<SplitViewId>();

  const pushUngroupedBlock = (block: RowBlock<T>) => {
    for (const row of block.rows) {
      groupedRows.push({ ...row, splitGroup: null });
    }
  };

  blocks.forEach((block, index) => {
    const groupId = block.membership?.splitViewId ?? null;
    const groupBlockIndexes = groupId ? groupedBlockIndexesByGroupId.get(groupId) : undefined;
    if (!groupId || !groupBlockIndexes) {
      pushUngroupedBlock(block);
      return;
    }
    if (emittedGroupIds.has(groupId)) {
      return;
    }
    if (!groupBlockIndexes.includes(index)) {
      pushUngroupedBlock(block);
      return;
    }
    emittedGroupIds.add(groupId);

    const memberBlocks = groupBlockIndexes
      .map((blockIndex) => blocks[blockIndex])
      .filter((memberBlock): memberBlock is RowBlock<T> => memberBlock !== undefined);
    const groupRowCount = memberBlocks.reduce((total, member) => total + member.rows.length, 0);
    let groupRowIndex = 0;

    memberBlocks.forEach((memberBlock, memberIndex) => {
      for (const row of memberBlock.rows) {
        const position: SidebarSplitGroupPosition =
          groupRowIndex === 0 ? "first" : groupRowIndex === groupRowCount - 1 ? "last" : "middle";
        groupedRows.push({
          ...row,
          splitGroup: {
            splitViewId: groupId,
            memberIndex: memberIndex + 1,
            memberCount: memberBlocks.length,
            isLeader: groupRowIndex === 0,
            position,
          },
        });
        groupRowIndex += 1;
      }
    });
  });

  return groupedRows;
}

// Pulls the preview cut back to the nearest group boundary so "Show more" never renders half a
// split. Falls back to the requested limit when the whole preview is one group, since showing
// nothing would be worse than showing a partial group.
export function clampPreviewLimitToSplitGroupBoundary(input: {
  splitGroupIds: readonly (string | null | undefined)[];
  previewLimit: number;
}): number {
  const { previewLimit, splitGroupIds } = input;
  let limit = Math.min(previewLimit, splitGroupIds.length);

  while (limit > 0) {
    const previousGroupId = splitGroupIds[limit - 1] ?? null;
    const nextGroupId = splitGroupIds[limit] ?? null;
    if (previousGroupId === null || previousGroupId !== nextGroupId) break;
    limit -= 1;
  }

  return limit === 0 ? previewLimit : limit;
}

// Keeps range-selection order (shift-click) aligned with the grouped order the user sees. Ids that
// have no row — filtered subagents or rows past the preview cut — keep their original relative order
// after the visible ones.
export function reorderThreadIdsByRowOrder(input: {
  threadIds: readonly ThreadId[];
  rowThreadIds: readonly ThreadId[];
}): ThreadId[] {
  const { rowThreadIds, threadIds } = input;
  const threadIdSet = new Set(threadIds);
  const orderedVisibleIds = rowThreadIds.filter((threadId) => threadIdSet.has(threadId));
  const orderedVisibleIdSet = new Set(orderedVisibleIds);
  return [
    ...orderedVisibleIds,
    ...threadIds.filter((threadId) => !orderedVisibleIdSet.has(threadId)),
  ];
}
