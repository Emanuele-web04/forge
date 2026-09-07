import { describe, expect, it } from "vitest";

import {
  SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT,
  buildThreadHierarchyIndex,
  collectRevealThreadIds,
  getAncestorThreadIds,
  getDirectChildThreadCount,
  getRootThreadId,
  getThreadDepth,
  getThreadEdgeKind,
  isBatchThreadEdge,
  resolveThreadChildPage,
  resolveVisibleChildThreadIds,
  type ThreadHierarchyNode,
} from "./sidebarThreadHierarchy";

interface TestThread extends ThreadHierarchyNode {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
  readonly projectId?: string | null | undefined;
  readonly sourceThreadId?: string | null | undefined;
  readonly forkSourceThreadId?: string | null | undefined;
  readonly sidechatSourceThreadId?: string | null | undefined;
  readonly gatewayOperationId?: string | null | undefined;
  readonly createdAt?: string | undefined;
}

function makeThread(id: string, overrides: Partial<TestThread> = {}): TestThread {
  return { id, ...overrides };
}

describe("buildThreadHierarchyIndex", () => {
  it("returns an empty forest for empty input", () => {
    const index = buildThreadHierarchyIndex<TestThread>([]);
    expect(index.rootIds).toEqual([]);
    expect(index.nodesById.size).toBe(0);
    expect(index.hiddenThreadIds.size).toBe(0);
    expect(getAncestorThreadIds(index, "missing")).toEqual([]);
    expect(getDirectChildThreadCount(index, "missing")).toBe(0);
    expect(getRootThreadId(index, "missing")).toBeUndefined();
    expect(getThreadDepth(index, "missing")).toBe(0);
  });

  it("builds a multilevel tree with roots, depths and creation-ordered children", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("root-b"),
      makeThread("root-a"),
      makeThread("child-a2", { parentThreadId: "root-a" }),
      makeThread("child-a1", { parentThreadId: "root-a" }),
      makeThread("grandchild", { parentThreadId: "child-a1" }),
    ]);

    expect(index.rootIds).toEqual(["root-b", "root-a"]);
    expect(index.childIdsByParentId.get("root-a")).toEqual(["child-a1", "child-a2"]);
    expect(index.childIdsByParentId.get("child-a1")).toEqual(["grandchild"]);
    expect(getRootThreadId(index, "grandchild")).toBe("root-a");
    expect(getThreadDepth(index, "root-a")).toBe(0);
    expect(getThreadDepth(index, "child-a1")).toBe(1);
    expect(getThreadDepth(index, "grandchild")).toBe(2);
    expect(getAncestorThreadIds(index, "grandchild")).toEqual(["child-a1", "root-a"]);
    expect(getAncestorThreadIds(index, "root-a")).toEqual([]);
    expect(index.hiddenThreadIds.size).toBe(0);
  });

  it("counts direct children only, excluding collapsed or paged descendants", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("root"),
      makeThread("child-1", { parentThreadId: "root" }),
      makeThread("child-2", { parentThreadId: "root" }),
      makeThread("grandchild", { parentThreadId: "child-1" }),
    ]);

    expect(getDirectChildThreadCount(index, "root")).toBe(2);
    expect(getDirectChildThreadCount(index, "child-1")).toBe(1);
    expect(getDirectChildThreadCount(index, "grandchild")).toBe(0);
  });

  it("drops the counter once every child leaves the snapshot (archived), keeping the root", () => {
    const before = buildThreadHierarchyIndex([
      makeThread("root"),
      makeThread("child-1", { parentThreadId: "root" }),
      makeThread("child-2", { parentThreadId: "root" }),
    ]);
    expect(getDirectChildThreadCount(before, "root")).toBe(2);

    // Archived threads are excluded upstream; the parent is then a plain root
    // with no control and no stale aggregate, never promoted or hidden.
    const after = buildThreadHierarchyIndex([makeThread("root")]);
    expect(getDirectChildThreadCount(after, "root")).toBe(0);
    expect(after.rootIds).toEqual(["root"]);
    expect(after.hiddenThreadIds.size).toBe(0);
  });

  it("nests batches via sourceThreadId with a batch edge; fork/sidechat/gateway alone stay roots", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("orchestrator"),
      makeThread("batch-a", {
        sourceThreadId: "orchestrator",
        gatewayOperationId: "op-1",
      }),
      makeThread("batch-b", {
        forkSourceThreadId: "orchestrator",
        sidechatSourceThreadId: "orchestrator",
        gatewayOperationId: "op-1",
      }),
      makeThread("lone-gateway", {
        gatewayOperationId: "op-1",
      }),
    ]);

    expect(index.rootIds).toEqual(["orchestrator", "batch-b", "lone-gateway"]);
    expect(index.childIdsByParentId.get("orchestrator")).toEqual(["batch-a"]);
    expect(getThreadEdgeKind(index, "batch-a")).toBe("batch");
    expect(isBatchThreadEdge(index, "batch-a")).toBe(true);
    expect(getThreadEdgeKind(index, "batch-b")).toBeUndefined();
    expect(index.hiddenThreadIds.size).toBe(0);
  });

  it("prefers parentThreadId over sourceThreadId and marks subagent edges", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("orchestrator"),
      makeThread("other-source"),
      makeThread("child", {
        parentThreadId: "orchestrator",
        sourceThreadId: "other-source",
        gatewayOperationId: "op-9",
      }),
    ]);

    expect(index.rootIds).toEqual(["orchestrator", "other-source"]);
    expect(index.childIdsByParentId.get("orchestrator")).toEqual(["child"]);
    expect(index.childIdsByParentId.get("other-source")).toBeUndefined();
    expect(getThreadEdgeKind(index, "child")).toBe("subagent");
    expect(isBatchThreadEdge(index, "child")).toBe(false);
  });

  it("nests the real example: HTML gastos ▸ Implement ▸ 4 build children", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("html-gastos"),
      makeThread("implement", { sourceThreadId: "html-gastos", gatewayOperationId: "op-impl" }),
      makeThread("build-1", { parentThreadId: "implement" }),
      makeThread("build-2", { parentThreadId: "implement" }),
      makeThread("build-3", { sourceThreadId: "implement", gatewayOperationId: "op-build" }),
      makeThread("build-4", { sourceThreadId: "implement", gatewayOperationId: "op-build" }),
    ]);

    expect(index.rootIds).toEqual(["html-gastos"]);
    expect(index.childIdsByParentId.get("html-gastos")).toEqual(["implement"]);
    expect(getThreadEdgeKind(index, "implement")).toBe("batch");
    expect(index.childIdsByParentId.get("implement")).toEqual([
      "build-1",
      "build-2",
      "build-3",
      "build-4",
    ]);
    expect(getThreadEdgeKind(index, "build-1")).toBe("subagent");
    expect(getThreadEdgeKind(index, "build-3")).toBe("batch");
    expect(getDirectChildThreadCount(index, "html-gastos")).toBe(1);
    expect(getDirectChildThreadCount(index, "implement")).toBe(4);
  });

  it("hides orphans and their whole subtree instead of promoting them", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("root"),
      makeThread("orphan", { parentThreadId: "archived-parent" }),
      makeThread("orphan-child", { parentThreadId: "orphan" }),
    ]);

    expect(index.rootIds).toEqual(["root"]);
    expect(index.hiddenThreadIds.has("orphan")).toBe(true);
    expect(index.hiddenThreadIds.has("orphan-child")).toBe(true);
    expect(getAncestorThreadIds(index, "orphan-child")).toEqual([]);
  });

  it("shows the family again once the snapshot provides the valid parent", () => {
    const withoutParent = buildThreadHierarchyIndex([makeThread("child", { parentThreadId: "p" })]);
    expect(withoutParent.rootIds).toEqual([]);

    const withParent = buildThreadHierarchyIndex([
      makeThread("child", { parentThreadId: "p" }),
      makeThread("p"),
    ]);
    expect(withParent.rootIds).toEqual(["p"]);
    expect(withParent.childIdsByParentId.get("p")).toEqual(["child"]);
  });

  it("hides children whose parent was filtered out of the snapshot", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("visible-root"),
      makeThread("child", { parentThreadId: "filtered-parent" }),
    ]);

    expect(index.rootIds).toEqual(["visible-root"]);
    expect(index.hiddenThreadIds.has("child")).toBe(true);
  });

  it("keeps kinship within the same project only", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("root-a", { projectId: "project-a" }),
      makeThread("child-a", { parentThreadId: "root-a", projectId: "project-a" }),
      makeThread("stray", { parentThreadId: "root-a", projectId: "project-b" }),
      makeThread("stray-child", { parentThreadId: "stray", projectId: "project-b" }),
      makeThread("root-b", { projectId: "project-b" }),
    ]);

    expect(index.rootIds).toEqual(["root-a", "root-b"]);
    expect(index.childIdsByParentId.get("root-a")).toEqual(["child-a"]);
    expect(index.hiddenThreadIds.has("stray")).toBe(true);
    expect(index.hiddenThreadIds.has("stray-child")).toBe(true);
  });

  it("keeps the first occurrence of duplicated ids deterministically", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("root"),
      makeThread("dup", { parentThreadId: "root" }),
      makeThread("dup", { parentThreadId: "other" }),
      makeThread("other"),
    ]);

    expect(index.nodesById.size).toBe(3);
    expect(index.rootIds).toEqual(["root", "other"]);
    expect(index.childIdsByParentId.get("root")).toEqual(["dup"]);
    expect(index.childIdsByParentId.get("other")).toBeUndefined();
  });

  it("hides self-references without looping", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("root"),
      makeThread("self", { parentThreadId: "self" }),
      makeThread("self-child", { parentThreadId: "self" }),
    ]);

    expect(index.rootIds).toEqual(["root"]);
    expect(index.hiddenThreadIds.has("self")).toBe(true);
    expect(index.hiddenThreadIds.has("self-child")).toBe(true);
  });

  it("hides two-node and longer cycles with their descendants", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("root"),
      makeThread("a", { parentThreadId: "c" }),
      makeThread("b", { parentThreadId: "a" }),
      makeThread("c", { parentThreadId: "b" }),
      makeThread("below", { parentThreadId: "c" }),
      makeThread("x", { parentThreadId: "y" }),
      makeThread("y", { parentThreadId: "x" }),
    ]);

    expect(index.rootIds).toEqual(["root"]);
    for (const id of ["a", "b", "c", "below", "x", "y"]) {
      expect(index.hiddenThreadIds.has(id)).toBe(true);
    }
    expect(getAncestorThreadIds(index, "b")).toEqual([]);
  });

  it("tolerates abnormal depth with iterative walks", () => {
    const depth = 5000;
    const threads: TestThread[] = [makeThread("node-0")];
    for (let level = 1; level <= depth; level += 1) {
      threads.push(makeThread(`node-${level}`, { parentThreadId: `node-${level - 1}` }));
    }
    const index = buildThreadHierarchyIndex(threads);

    expect(index.rootIds).toEqual(["node-0"]);
    expect(getThreadDepth(index, `node-${depth}`)).toBe(depth);
    expect(getRootThreadId(index, `node-${depth}`)).toBe("node-0");
    const ancestors = getAncestorThreadIds(index, `node-${depth}`);
    expect(ancestors).toHaveLength(depth);
    expect(ancestors[0]).toBe(`node-${depth - 1}`);
    expect(ancestors[depth - 1]).toBe("node-0");
  });
});

describe("collectRevealThreadIds", () => {
  it("returns the thread plus its ancestors for transient reveals", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("root"),
      makeThread("child", { parentThreadId: "root" }),
      makeThread("grandchild", { parentThreadId: "child" }),
    ]);

    expect([...collectRevealThreadIds(index, "grandchild")].sort()).toEqual([
      "child",
      "grandchild",
      "root",
    ]);
    expect(collectRevealThreadIds(index, "root")).toEqual(new Set(["root"]));
    expect(collectRevealThreadIds(index, undefined).size).toBe(0);
    expect(collectRevealThreadIds(index, "missing").size).toBe(0);
  });

  it("reveals nothing for hidden threads", () => {
    const index = buildThreadHierarchyIndex([makeThread("orphan", { parentThreadId: "absent" })]);
    expect(collectRevealThreadIds(index, "orphan").size).toBe(0);
  });
});

describe("resolveThreadChildPage", () => {
  it("shows the initial five-child prefix with no paging affordances when everything fits", () => {
    expect(SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT).toBe(5);
    expect(resolveThreadChildPage({ totalChildCount: 0 })).toMatchObject({
      visibleCount: 0,
      hasMoreChildren: false,
      hasLessChildren: false,
    });
    expect(resolveThreadChildPage({ totalChildCount: 1 })).toMatchObject({
      visibleCount: 1,
      hasMoreChildren: false,
      hasLessChildren: false,
    });
    expect(resolveThreadChildPage({ totalChildCount: 5 })).toMatchObject({
      visibleCount: 5,
      hasMoreChildren: false,
      hasLessChildren: false,
    });
  });

  it("pages five first with show more/less support for twenty children", () => {
    expect(resolveThreadChildPage({ totalChildCount: 20 })).toMatchObject({
      visibleCount: 5,
      hasMoreChildren: true,
      hasLessChildren: false,
    });
    expect(
      resolveThreadChildPage({ totalChildCount: 20, requestedVisibleCount: 20 }),
    ).toMatchObject({
      visibleCount: 20,
      hasMoreChildren: false,
      hasLessChildren: true,
    });
  });

  it("enlarges the prefix through a revealed child without reordering it", () => {
    expect(resolveThreadChildPage({ totalChildCount: 20, minimumVisibleCount: 17 })).toMatchObject({
      visibleCount: 17,
      hasMoreChildren: true,
      hasLessChildren: false,
    });
  });

  it("clamps oversized requests to the real child count", () => {
    expect(
      resolveThreadChildPage({ totalChildCount: 3, requestedVisibleCount: 500 }),
    ).toMatchObject({
      visibleCount: 3,
      hasMoreChildren: false,
      hasLessChildren: false,
    });
  });

  it("normalizes malformed requests to the initial five when the total permits", () => {
    expect(
      resolveThreadChildPage({ totalChildCount: 20, requestedVisibleCount: Number.NaN })
        .visibleCount,
    ).toBe(5);
    expect(
      resolveThreadChildPage({ totalChildCount: 20, requestedVisibleCount: -3 }).visibleCount,
    ).toBe(5);
    expect(
      resolveThreadChildPage({ totalChildCount: 20, requestedVisibleCount: 7.9 }).visibleCount,
    ).toBe(7);
    expect(
      resolveThreadChildPage({ totalChildCount: 2, requestedVisibleCount: Number.NaN })
        .visibleCount,
    ).toBe(2);
  });

  it("normalizes malformed totals and minimums to zero", () => {
    expect(resolveThreadChildPage({ totalChildCount: Number.NaN }).visibleCount).toBe(0);
    expect(
      resolveThreadChildPage({ totalChildCount: 20, minimumVisibleCount: Number.NaN }).visibleCount,
    ).toBe(5);
  });
});

describe("resolveVisibleChildThreadIds", () => {
  function buildWideFamily(childCount: number) {
    const threads: TestThread[] = [makeThread("root", { projectId: "p" })];
    for (let position = 1; position <= childCount; position += 1) {
      threads.push(
        makeThread(`child-${String(position).padStart(2, "0")}`, {
          projectId: "p",
          parentThreadId: "root",
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, position)).toISOString(),
        }),
      );
    }
    return buildThreadHierarchyIndex(threads);
  }

  it("renders 0/1/5 children fully with no paging", () => {
    for (const count of [0, 1, 5]) {
      const index = buildWideFamily(count);
      const page = resolveVisibleChildThreadIds({ index, parentId: "root" });
      expect(page.visibleChildIds).toHaveLength(count);
      expect(page.hiddenChildIds).toHaveLength(0);
      expect(page.hasMoreChildren).toBe(false);
      expect(page.hasLessChildren).toBe(false);
    }
  });

  it("shows the first five of twenty by default and all twenty on request", () => {
    const index = buildWideFamily(20);
    const page = resolveVisibleChildThreadIds({ index, parentId: "root" });

    expect(page.totalChildCount).toBe(20);
    expect(page.visibleChildIds).toHaveLength(5);
    expect(page.visibleChildIds[0]).toBe("child-01");
    expect(page.visibleChildIds[4]).toBe("child-05");
    expect(page.hiddenChildIds).toHaveLength(15);
    expect(page.hasMoreChildren).toBe(true);
    expect(page.hasLessChildren).toBe(false);

    const next = resolveVisibleChildThreadIds({
      index,
      parentId: "root",
      requestedVisibleCount: 20,
    });
    expect(next.visibleChildIds).toHaveLength(20);
    expect(next.hasMoreChildren).toBe(false);
    expect(next.hasLessChildren).toBe(true);
  });

  it("reveals the prefix through child 17, not 1-5 plus 17", () => {
    const threads = [
      { id: "root", projectId: "p", createdAt: "2026-09-01T00:00:00Z" },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `child-${String(index + 1).padStart(2, "0")}`,
        projectId: "p",
        sourceThreadId: "root",
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, index + 1)).toISOString(),
      })),
    ];
    const index = buildThreadHierarchyIndex(threads);
    const page = resolveVisibleChildThreadIds({
      index,
      parentId: "root",
      revealedThreadIds: new Set(["child-17"]),
    });
    expect(page.visibleChildIds).toEqual(threads.slice(1, 18).map((thread) => thread.id));
    expect(page.hiddenChildIds).toEqual(["child-18", "child-19", "child-20"]);
  });

  it("clamps a request of 500 to exactly the available children", () => {
    const index = buildWideFamily(3);
    const page = resolveVisibleChildThreadIds({
      index,
      parentId: "root",
      requestedVisibleCount: 500,
    });
    expect(page.visibleChildIds).toHaveLength(3);
    expect(page.hiddenChildIds).toHaveLength(0);
  });

  it("returns empty pages for unknown parents", () => {
    const index = buildWideFamily(3);
    expect(resolveVisibleChildThreadIds({ index, parentId: "missing" }).visibleChildIds).toEqual(
      [],
    );
  });
});

describe("hierarchy child ordering", () => {
  it("orders direct siblings by creation time while roots follow input order", () => {
    const index = buildThreadHierarchyIndex<TestThread>([
      makeThread("root-b", { projectId: "p" }),
      makeThread("root-a", { projectId: "p" }),
      makeThread("child-a2", {
        projectId: "p",
        parentThreadId: "root-a",
        createdAt: "2026-09-01T00:02:00.000Z",
      }),
      makeThread("child-a1", {
        projectId: "p",
        parentThreadId: "root-a",
        createdAt: "2026-09-01T00:01:00.000Z",
      }),
    ]);

    expect(index.rootIds).toEqual(["root-b", "root-a"]);
    expect(index.childIdsByParentId.get("root-a")).toEqual(["child-a1", "child-a2"]);
  });

  it("breaks creation-time ties and invalid timestamps by id", () => {
    const index = buildThreadHierarchyIndex<TestThread>([
      makeThread("root", { projectId: "p" }),
      makeThread("child-b", { projectId: "p", parentThreadId: "root", createdAt: "invalid" }),
      makeThread("child-a", { projectId: "p", parentThreadId: "root" }),
      makeThread("child-c", {
        projectId: "p",
        parentThreadId: "root",
        createdAt: "2026-09-01T00:01:00.000Z",
      }),
    ]);

    expect(index.childIdsByParentId.get("root")).toEqual(["child-a", "child-b", "child-c"]);
  });

  it("keeps sibling order stable across status-only changes", () => {
    const base = [
      makeThread("root", { projectId: "p" }),
      makeThread("child-1", {
        projectId: "p",
        parentThreadId: "root",
        createdAt: "2026-09-01T00:01:00.000Z",
      }),
      makeThread("child-2", {
        projectId: "p",
        parentThreadId: "root",
        createdAt: "2026-09-01T00:02:00.000Z",
      }),
    ];
    const first = buildThreadHierarchyIndex(base);
    expect(first.childIdsByParentId.get("root")).toEqual(["child-1", "child-2"]);
    const second = buildThreadHierarchyIndex([
      { ...base[0]!, updatedAt: "2026-09-02T00:00:00Z", title: "renamed", status: "Working" },
      { ...base[1]!, updatedAt: "2026-09-03T00:00:00Z", title: "other", status: "Completed" },
      { ...base[2]!, updatedAt: "2026-09-01T00:00:00Z", title: "zzz", status: "Working" },
    ]);
    expect(second.childIdsByParentId.get("root")).toEqual(["child-1", "child-2"]);
  });

  it("reveals an active grandchild through its direct-child ancestor prefix", () => {
    const threads = [
      makeThread("root", { projectId: "p" }),
      ...[1, 2, 3, 4, 5, 6].map((position) =>
        makeThread(`child-${position}`, {
          projectId: "p",
          parentThreadId: "root",
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, position)).toISOString(),
        }),
      ),
      makeThread("grandchild", {
        projectId: "p",
        parentThreadId: "child-3",
        createdAt: "2026-09-01T01:00:00.000Z",
      }),
    ];
    const index = buildThreadHierarchyIndex(threads);
    const revealed = collectRevealThreadIds(index, "grandchild");
    const rootPage = resolveVisibleChildThreadIds({
      index,
      parentId: "root",
      revealedThreadIds: revealed,
    });
    expect(rootPage.visibleChildIds).toContain("child-3");
    const nestedPage = resolveVisibleChildThreadIds({
      index,
      parentId: "child-3",
      revealedThreadIds: revealed,
    });
    expect(nestedPage.visibleChildIds).toContain("grandchild");
  });
});
