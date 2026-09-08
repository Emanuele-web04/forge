import { describe, expect, it } from "vitest";

import type { ThreadId } from "@synara/contracts";

import type { SidebarThreadSummary } from "../types";
import { buildThreadHierarchyIndex } from "./sidebarThreadHierarchy";
import {
  buildHiddenBranchSummaries,
  buildHierarchyRevealPlan,
  type HiddenBranchSummary,
} from "./sidebarThreadHierarchyPresentation";
import type { ThreadStatusPill } from "./Sidebar.logic";

function makeNode(
  id: string,
  overrides: {
    parentThreadId?: string | null;
    sourceThreadId?: string | null;
    projectId?: string | null;
    createdAt?: string;
  } = {},
): SidebarThreadSummary {
  return {
    id: id as ThreadId,
    projectId: (overrides.projectId ?? "p") as SidebarThreadSummary["projectId"],
    parentThreadId: (overrides.parentThreadId ?? null) as SidebarThreadSummary["parentThreadId"],
    sourceThreadId: (overrides.sourceThreadId ?? null) as SidebarThreadSummary["sourceThreadId"],
    createdAt: overrides.createdAt ?? "2026-09-01T00:00:00.000Z",
  } as SidebarThreadSummary;
}

function makeStatus(label: ThreadStatusPill["label"]): ThreadStatusPill {
  return { label, colorClass: "", dotClass: "", pulse: false };
}

function summaryAt(
  summaries: ReadonlyMap<ThreadId, HiddenBranchSummary>,
  id: string,
): HiddenBranchSummary | undefined {
  return summaries.get(id as ThreadId);
}

describe("buildHiddenBranchSummaries", () => {
  it("assigns a hidden grandchild to its nearest visible ancestor without duplication", () => {
    const index = buildThreadHierarchyIndex([
      makeNode("r"),
      makeNode("a", { parentThreadId: "r", createdAt: "2026-09-01T00:01:00.000Z" }),
      makeNode("b", { parentThreadId: "r", createdAt: "2026-09-01T00:02:00.000Z" }),
      makeNode("a1", { parentThreadId: "a", createdAt: "2026-09-01T00:03:00.000Z" }),
    ]);
    const summaries = buildHiddenBranchSummaries({
      index,
      visibleThreadIds: new Set(["r", "a"] as ThreadId[]),
      statusByThreadId: new Map([
        ["b" as ThreadId, makeStatus("Working")],
        ["a1" as ThreadId, makeStatus("Awaiting Input")],
      ]),
      activeThreadId: null,
    });

    expect(summaryAt(summaries, "r")).toMatchObject({ runningCount: 1, attentionCount: 0 });
    expect(summaryAt(summaries, "a")).toMatchObject({ attentionCount: 1, runningCount: 0 });
  });

  it("counts every hidden descendant on the root once the branch closes", () => {
    const index = buildThreadHierarchyIndex([
      makeNode("r"),
      makeNode("a", { parentThreadId: "r", createdAt: "2026-09-01T00:01:00.000Z" }),
      makeNode("b", { parentThreadId: "r", createdAt: "2026-09-01T00:02:00.000Z" }),
      makeNode("a1", { parentThreadId: "a", createdAt: "2026-09-01T00:03:00.000Z" }),
    ]);
    const summaries = buildHiddenBranchSummaries({
      index,
      visibleThreadIds: new Set(["r"] as ThreadId[]),
      statusByThreadId: new Map([
        ["b" as ThreadId, makeStatus("Working")],
        ["a1" as ThreadId, makeStatus("Awaiting Input")],
      ]),
      activeThreadId: null,
    });

    expect(summaryAt(summaries, "r")).toMatchObject({
      hiddenCount: 3,
      runningCount: 1,
      attentionCount: 1,
    });
    expect(summaryAt(summaries, "a")).toBeUndefined();
  });

  it("classifies attention, running and unread completion separately", () => {
    const index = buildThreadHierarchyIndex([
      makeNode("r"),
      makeNode("c1", { parentThreadId: "r", createdAt: "2026-09-01T00:01:00.000Z" }),
      makeNode("c2", { parentThreadId: "r", createdAt: "2026-09-01T00:02:00.000Z" }),
      makeNode("c3", { parentThreadId: "r", createdAt: "2026-09-01T00:03:00.000Z" }),
    ]);
    const summaries = buildHiddenBranchSummaries({
      index,
      visibleThreadIds: new Set(["r"] as ThreadId[]),
      statusByThreadId: new Map([
        ["c1" as ThreadId, makeStatus("Pending Approval")],
        ["c2" as ThreadId, makeStatus("Working")],
        ["c3" as ThreadId, makeStatus("Completed")],
      ]),
      activeThreadId: null,
    });

    expect(summaryAt(summaries, "r")).toMatchObject({
      hiddenCount: 3,
      attentionCount: 1,
      runningCount: 1,
      unreadCount: 1,
    });
  });

  it("omits the aggregate when every descendant is visible", () => {
    const index = buildThreadHierarchyIndex([
      makeNode("r"),
      makeNode("a", { parentThreadId: "r", createdAt: "2026-09-01T00:01:00.000Z" }),
    ]);
    const summaries = buildHiddenBranchSummaries({
      index,
      visibleThreadIds: new Set(["r", "a"] as ThreadId[]),
      statusByThreadId: new Map([["a" as ThreadId, makeStatus("Working")]]),
      activeThreadId: null,
    });

    expect(summaryAt(summaries, "r")).toBeUndefined();
  });

  it("marks the toggle when a hidden child is the current conversation", () => {
    const index = buildThreadHierarchyIndex([
      makeNode("r"),
      makeNode("a", { parentThreadId: "r", createdAt: "2026-09-01T00:01:00.000Z" }),
    ]);
    const summaries = buildHiddenBranchSummaries({
      index,
      visibleThreadIds: new Set(["r"] as ThreadId[]),
      statusByThreadId: new Map(),
      activeThreadId: "a" as ThreadId,
    });

    expect(summaryAt(summaries, "r")).toMatchObject({
      hiddenCount: 1,
      containsActiveThread: true,
    });
  });

  it("excludes the ancestor own status and null statuses", () => {
    const index = buildThreadHierarchyIndex([
      makeNode("r"),
      makeNode("a", { parentThreadId: "r", createdAt: "2026-09-01T00:01:00.000Z" }),
    ]);
    const summaries = buildHiddenBranchSummaries({
      index,
      visibleThreadIds: new Set(["r"] as ThreadId[]),
      statusByThreadId: new Map([
        ["r" as ThreadId, makeStatus("Working")],
        ["a" as ThreadId, null],
      ]),
      activeThreadId: null,
    });

    expect(summaryAt(summaries, "r")).toMatchObject({
      hiddenCount: 1,
      runningCount: 0,
      attentionCount: 0,
      unreadCount: 0,
    });
  });
});

describe("buildHierarchyRevealPlan", () => {
  it("returns nearest-parent-first ancestors with per-parent minimum counts", () => {
    const index = buildThreadHierarchyIndex([
      makeNode("root"),
      makeNode("child", { parentThreadId: "root", createdAt: "2026-09-01T00:01:00.000Z" }),
      makeNode("grandchild", {
        parentThreadId: "child",
        createdAt: "2026-09-01T00:02:00.000Z",
      }),
    ]);
    const plan = buildHierarchyRevealPlan({ index, threadId: "grandchild" as ThreadId });

    expect(plan.ancestorIds).toEqual(["child", "root"]);
    expect(plan.minimumVisibleCountByParentId.get("child" as ThreadId)).toBe(1);
    expect(plan.minimumVisibleCountByParentId.get("root" as ThreadId)).toBe(1);
  });

  it("records the child position plus one for deep prefixes", () => {
    const nodes = [makeNode("root")];
    for (let position = 1; position <= 20; position += 1) {
      nodes.push(
        makeNode(`child-${String(position).padStart(2, "0")}`, {
          parentThreadId: "root",
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, position)).toISOString(),
        }),
      );
    }
    const index = buildThreadHierarchyIndex(nodes);
    const plan = buildHierarchyRevealPlan({ index, threadId: "child-17" as ThreadId });

    expect(plan.ancestorIds).toEqual(["root"]);
    expect(plan.minimumVisibleCountByParentId.get("root" as ThreadId)).toBe(17);
  });

  it("returns empty outputs for hidden or unknown nodes", () => {
    const index = buildThreadHierarchyIndex([
      makeNode("orphan", { parentThreadId: "absent" }),
      makeNode("root"),
    ]);
    expect(buildHierarchyRevealPlan({ index, threadId: "orphan" as ThreadId }).ancestorIds).toEqual(
      [],
    );
    expect(
      buildHierarchyRevealPlan({ index, threadId: "missing" as ThreadId })
        .minimumVisibleCountByParentId.size,
    ).toBe(0);
    expect(buildHierarchyRevealPlan({ index, threadId: "root" as ThreadId }).ancestorIds).toEqual(
      [],
    );
  });
});
