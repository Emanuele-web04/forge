import { describe, expect, it } from "vitest";

import {
  SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE,
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

  it("builds a multilevel tree with roots, depths and stable input order", () => {
    const index = buildThreadHierarchyIndex([
      makeThread("root-b"),
      makeThread("root-a"),
      makeThread("child-a2", { parentThreadId: "root-a" }),
      makeThread("child-a1", { parentThreadId: "root-a" }),
      makeThread("grandchild", { parentThreadId: "child-a1" }),
    ]);

    expect(index.rootIds).toEqual(["root-b", "root-a"]);
    expect(index.childIdsByParentId.get("root-a")).toEqual(["child-a2", "child-a1"]);
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
    const index = buildThreadHierarchyIndex([
      makeThread("orphan", { parentThreadId: "absent" }),
    ]);
    expect(collectRevealThreadIds(index, "orphan").size).toBe(0);
  });
});

describe("resolveThreadChildPage", () => {
  it("shows the initial page and pages 20 by 20 with show less support", () => {
    expect(SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE).toBe(20);
    expect(resolveThreadChildPage({ totalChildCount: 0, requestedExtraPages: 0 })).toMatchObject({
      visibleCount: 20,
      hasMoreChildren: false,
      hasLessChildren: false,
      effectiveExtraPages: 0,
    });
    expect(resolveThreadChildPage({ totalChildCount: 25, requestedExtraPages: 0 })).toMatchObject({
      visibleCount: 20,
      hasMoreChildren: true,
      hasLessChildren: false,
    });
    expect(resolveThreadChildPage({ totalChildCount: 25, requestedExtraPages: 1 })).toMatchObject({
      visibleCount: 40,
      hasMoreChildren: false,
      hasLessChildren: true,
    });
    // Stale paging beyond the real child count clamps to the last useful page.
    expect(resolveThreadChildPage({ totalChildCount: 25, requestedExtraPages: 7 })).toMatchObject({
      visibleCount: 40,
      hasMoreChildren: false,
      hasLessChildren: true,
      effectiveExtraPages: 1,
    });
  });
});

describe("resolveVisibleChildThreadIds", () => {
  function buildWideFamily(childCount: number) {
    const threads: TestThread[] = [makeThread("root")];
    for (let position = 1; position <= childCount; position += 1) {
      threads.push(makeThread(`child-${position}`, { parentThreadId: "root" }));
    }
    return buildThreadHierarchyIndex(threads);
  }

  it("paginates siblings without consuming root slots and keeps input order", () => {
    const index = buildWideFamily(25);
    const page = resolveVisibleChildThreadIds({ index, parentId: "root" });

    expect(page.totalChildCount).toBe(25);
    expect(page.visibleChildIds).toHaveLength(20);
    expect(page.visibleChildIds[0]).toBe("child-1");
    expect(page.visibleChildIds[19]).toBe("child-20");
    expect(page.hiddenChildIds).toEqual([
      "child-21",
      "child-22",
      "child-23",
      "child-24",
      "child-25",
    ]);
    expect(page.hasMoreChildren).toBe(true);

    const next = resolveVisibleChildThreadIds({ index, parentId: "root", requestedExtraPages: 1 });
    expect(next.visibleChildIds).toHaveLength(25);
    expect(next.hasMoreChildren).toBe(false);
    expect(next.hasLessChildren).toBe(true);
  });

  it("reveals the active path even outside the current page", () => {
    const index = buildWideFamily(25);
    const page = resolveVisibleChildThreadIds({
      index,
      parentId: "root",
      revealedThreadIds: new Set(["child-25"]),
    });

    expect(page.visibleChildIds).toHaveLength(21);
    expect(page.visibleChildIds).toContain("child-25");
    expect(page.hiddenChildIds).not.toContain("child-25");
    // Remaining ids come from actually hidden children, so "Show more" repeats nothing.
    expect(page.hiddenChildIds).toHaveLength(4);
  });

  it("returns empty pages for unknown parents", () => {
    const index = buildWideFamily(3);
    expect(
      resolveVisibleChildThreadIds({ index, parentId: "missing" }).visibleChildIds,
    ).toEqual([]);
  });
});
