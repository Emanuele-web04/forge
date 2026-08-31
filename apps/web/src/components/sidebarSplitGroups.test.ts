// FILE: sidebarSplitGroups.test.ts
// Purpose: Verify sidebar split-group membership resolution, row grouping/anchoring, and paging clamps.

import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { LeafPane, Pane, SplitView } from "../splitViewStore";
import {
  applySidebarSplitGroups,
  buildSidebarSplitGroupIndex,
  clampPreviewLimitToSplitGroupBoundary,
  reorderThreadIdsByRowOrder,
} from "./sidebarSplitGroups";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");
const THREAD_D = ThreadId.makeUnsafe("thread-d");

function leaf(threadId: ThreadId | null, id: string): LeafPane {
  return {
    kind: "leaf",
    id,
    threadId,
    panel: {
      panel: null,
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: false,
      lastOpenPanel: "diff",
    },
  };
}

function splitView(input: {
  id: string;
  sourceThreadId: ThreadId;
  threadIds: readonly (ThreadId | null)[];
}): SplitView {
  const leaves = input.threadIds.map((threadId, index) =>
    leaf(threadId, `${input.id}-pane-${index}`),
  );
  const root: Pane =
    leaves.length === 1 && leaves[0]
      ? leaves[0]
      : leaves.slice(1).reduce<Pane>(
          (accumulated, next, index) => ({
            kind: "split",
            id: `${input.id}-node-${index}`,
            direction: index % 2 === 0 ? "horizontal" : "vertical",
            first: accumulated,
            second: next,
            ratio: 0.5,
          }),
          leaves[0] as Pane,
        );

  return {
    id: input.id,
    sourceThreadId: input.sourceThreadId,
    ownerProjectId: PROJECT_ID,
    root,
    focusedPaneId: `${input.id}-pane-0`,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

interface TestRow {
  thread: { id: ThreadId };
  depth: number;
}

function row(threadId: ThreadId, depth = 0): TestRow {
  return { thread: { id: threadId }, depth };
}

function describeRows(rows: readonly (TestRow & { splitGroup: unknown })[]): string[] {
  return rows.map((entry) => entry.thread.id);
}

describe("buildSidebarSplitGroupIndex", () => {
  it("indexes every split member in pane order", () => {
    const split = splitView({
      id: "split-1",
      sourceThreadId: THREAD_A,
      threadIds: [THREAD_A, THREAD_B],
    });

    const index = buildSidebarSplitGroupIndex({
      splitViewsById: { [split.id]: split },
      splitViewIdBySourceThreadId: { [THREAD_A]: split.id },
    });

    expect(index.get(THREAD_A)).toEqual({ splitViewId: "split-1", paneOrder: 0 });
    expect(index.get(THREAD_B)).toEqual({ splitViewId: "split-1", paneOrder: 1 });
  });

  it("skips empty panes without shifting the pane order of later members", () => {
    const split = splitView({
      id: "split-1",
      sourceThreadId: THREAD_A,
      threadIds: [THREAD_A, null, THREAD_B],
    });

    const index = buildSidebarSplitGroupIndex({
      splitViewsById: { [split.id]: split },
      splitViewIdBySourceThreadId: { [THREAD_A]: split.id },
    });

    expect(index.get(THREAD_B)?.paneOrder).toBe(1);
  });

  it("gives an ambiguous non-source member no group at all", () => {
    const first = splitView({
      id: "split-1",
      sourceThreadId: THREAD_A,
      threadIds: [THREAD_A, THREAD_C],
    });
    const second = splitView({
      id: "split-2",
      sourceThreadId: THREAD_B,
      threadIds: [THREAD_B, THREAD_C],
    });

    const index = buildSidebarSplitGroupIndex({
      splitViewsById: { [first.id]: first, [second.id]: second },
      splitViewIdBySourceThreadId: { [THREAD_A]: first.id, [THREAD_B]: second.id },
    });

    expect(index.get(THREAD_A)?.splitViewId).toBe("split-1");
    expect(index.get(THREAD_B)?.splitViewId).toBe("split-2");
    expect(index.has(THREAD_C)).toBe(false);
  });

  it("keeps a thread in the split it is the source of, even when it leaks into another", () => {
    const first = splitView({
      id: "split-1",
      sourceThreadId: THREAD_A,
      threadIds: [THREAD_A, THREAD_C],
    });
    const second = splitView({
      id: "split-2",
      sourceThreadId: THREAD_B,
      threadIds: [THREAD_B, THREAD_A],
    });

    const index = buildSidebarSplitGroupIndex({
      splitViewsById: { [first.id]: first, [second.id]: second },
      splitViewIdBySourceThreadId: { [THREAD_A]: first.id, [THREAD_B]: second.id },
    });

    expect(index.get(THREAD_A)?.splitViewId).toBe("split-1");
  });
});

describe("applySidebarSplitGroups", () => {
  const membership = new Map([
    [THREAD_B, { splitViewId: "split-1", paneOrder: 0 }],
    [THREAD_D, { splitViewId: "split-1", paneOrder: 1 }],
  ]);

  it("anchors the group at its topmost member and pulls the siblings under it", () => {
    const grouped = applySidebarSplitGroups({
      rows: [row(THREAD_A), row(THREAD_B), row(THREAD_C), row(THREAD_D)],
      membershipByThreadId: membership,
    });

    expect(describeRows(grouped)).toEqual([THREAD_A, THREAD_B, THREAD_D, THREAD_C]);
  });

  it("orders members by pane order rather than by list order", () => {
    const grouped = applySidebarSplitGroups({
      rows: [row(THREAD_D), row(THREAD_A), row(THREAD_B)],
      membershipByThreadId: membership,
    });

    expect(describeRows(grouped)).toEqual([THREAD_B, THREAD_D, THREAD_A]);
  });

  it("annotates rail position, member index, and the leader row", () => {
    const grouped = applySidebarSplitGroups({
      rows: [row(THREAD_B), row(THREAD_D)],
      membershipByThreadId: membership,
    });

    expect(grouped[0]?.splitGroup).toEqual({
      splitViewId: "split-1",
      memberIndex: 1,
      memberCount: 2,
      isLeader: true,
      position: "first",
    });
    expect(grouped[1]?.splitGroup).toMatchObject({
      memberIndex: 2,
      isLeader: false,
      position: "last",
    });
  });

  it("leaves a group with a single visible member ungrouped", () => {
    const grouped = applySidebarSplitGroups({
      rows: [row(THREAD_A), row(THREAD_B)],
      membershipByThreadId: membership,
    });

    expect(describeRows(grouped)).toEqual([THREAD_A, THREAD_B]);
    expect(grouped.every((entry) => entry.splitGroup === null)).toBe(true);
  });

  it("moves subagent rows with their parent and spans the rail across them", () => {
    const grouped = applySidebarSplitGroups({
      rows: [row(THREAD_A), row(THREAD_B), row(THREAD_C, 1), row(THREAD_D)],
      membershipByThreadId: membership,
    });

    expect(describeRows(grouped)).toEqual([THREAD_A, THREAD_B, THREAD_C, THREAD_D]);
    expect(grouped.map((entry) => entry.splitGroup?.position ?? null)).toEqual([
      null,
      "first",
      "middle",
      "last",
    ]);
  });

  it("returns the rows untouched when nothing is split", () => {
    const rows = [row(THREAD_A), row(THREAD_B)];

    const grouped = applySidebarSplitGroups({ rows, membershipByThreadId: new Map() });

    expect(describeRows(grouped)).toEqual([THREAD_A, THREAD_B]);
    expect(grouped.every((entry) => entry.splitGroup === null)).toBe(true);
  });
});

describe("clampPreviewLimitToSplitGroupBoundary", () => {
  it("pulls the cut back so a group is never rendered half-way", () => {
    const limit = clampPreviewLimitToSplitGroupBoundary({
      splitGroupIds: [null, "split-1", "split-1", null],
      previewLimit: 2,
    });

    expect(limit).toBe(1);
  });

  it("keeps the limit when it already lands on a group boundary", () => {
    const limit = clampPreviewLimitToSplitGroupBoundary({
      splitGroupIds: [null, "split-1", "split-1", null],
      previewLimit: 3,
    });

    expect(limit).toBe(3);
  });

  it("falls back to the requested limit when the whole preview is one group", () => {
    const limit = clampPreviewLimitToSplitGroupBoundary({
      splitGroupIds: ["split-1", "split-1", "split-1"],
      previewLimit: 2,
    });

    expect(limit).toBe(2);
  });
});

describe("reorderThreadIdsByRowOrder", () => {
  it("follows the rendered row order and keeps rowless ids at the end", () => {
    const ordered = reorderThreadIdsByRowOrder({
      threadIds: [THREAD_A, THREAD_B, THREAD_C, THREAD_D],
      rowThreadIds: [THREAD_B, THREAD_D, THREAD_A],
    });

    expect(ordered).toEqual([THREAD_B, THREAD_D, THREAD_A, THREAD_C]);
  });

  it("ignores row ids that are not part of the list", () => {
    const ordered = reorderThreadIdsByRowOrder({
      threadIds: [THREAD_A, THREAD_B],
      rowThreadIds: [THREAD_C, THREAD_B],
    });

    expect(ordered).toEqual([THREAD_B, THREAD_A]);
  });
});
