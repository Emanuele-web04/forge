// FILE: splitViewStore.test.ts
// Purpose: Verify tree-aware split view state operations: drop creation, perpendicular subdivision,
// pane focus/ratio mutations, deleted-thread collapse semantics, and v1 -> v2 persisted-state migration.

import { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectLeaves, findParentSplitNode } from "./splitView.logic";
import {
  resolvePreferredSplitViewIdForThread,
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneIdForThread,
  resolveSplitViewThreadIds,
  useSplitViewStore,
  type LeafPane,
  type SplitNode,
  type SplitView,
} from "./splitViewStore";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");
const THREAD_D = ThreadId.makeUnsafe("thread-d");
const TURN_ID = TurnId.makeUnsafe("turn-1");
const ORIGINAL_LOCAL_STORAGE = globalThis.localStorage;

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();
  return {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  } as Storage;
}

function snapshot(splitViewId: string): SplitView {
  const splitView = useSplitViewStore.getState().splitViewsById[splitViewId];
  if (!splitView) throw new Error(`split view ${splitViewId} not found`);
  return splitView;
}

function findRootSplitNode(splitView: SplitView): SplitNode {
  if (splitView.root.kind !== "split") {
    throw new Error("expected split root to be a SplitNode");
  }
  return splitView.root;
}

function findEmptyLeafId(splitView: SplitView): string {
  const empty = collectLeaves(splitView.root).find((leaf) => leaf.threadId === null);
  if (!empty) throw new Error("expected an empty leaf");
  return empty.id;
}

function findLeafIdForThread(splitView: SplitView, threadId: ThreadId): string {
  const paneId = resolveSplitViewPaneIdForThread(splitView, threadId);
  if (!paneId) throw new Error(`expected leaf for thread ${threadId}`);
  return paneId;
}

describe("splitViewStore", () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryStorage();
    useSplitViewStore.setState({
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
    });
  });

  afterEach(() => {
    vi.resetModules();
    globalThis.localStorage = ORIGINAL_LOCAL_STORAGE;
  });

  it("creates a horizontal drop split with the dropped leaf placed on the requested side", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "first",
    });

    const splitView = snapshot(splitViewId);
    const root = findRootSplitNode(splitView);
    expect(root.direction).toBe("horizontal");
    expect(root.first.kind).toBe("leaf");
    expect(root.second.kind).toBe("leaf");
    expect((root.first as LeafPane).threadId).toBe(THREAD_B);
    expect((root.second as LeafPane).threadId).toBe(THREAD_A);
    expect(splitView.focusedPaneId).toBe(root.first.id);
  });

  it("keeps writing split views to the Synara v1 storage key so persisted state can migrate", async () => {
    vi.resetModules();
    globalThis.localStorage = createMemoryStorage();
    const { useSplitViewStore: freshSplitViewStore } = await import("./splitViewStore");

    freshSplitViewStore.getState().createFromThread({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
    });

    const persisted = globalThis.localStorage.getItem("synara:split-view-state:v1");
    expect(persisted).not.toBeNull();
    expect(globalThis.localStorage.getItem("synara:split-view-state:v2")).toBeNull();
    expect(JSON.parse(persisted ?? "{}")).toMatchObject({ version: 2 });
  });

  it("replaces an existing source split when creating a drop split for the same source", () => {
    const store = useSplitViewStore.getState();
    const firstSplitId = store.createFromThread({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
    });

    const secondSplitId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "vertical",
      side: "first",
    });

    const nextState = useSplitViewStore.getState();
    expect(secondSplitId).toBe(firstSplitId);
    expect(Object.keys(nextState.splitViewsById)).toEqual([firstSplitId]);
    expect(nextState.splitViewIdBySourceThreadId[THREAD_A]).toBe(firstSplitId);
    expect(resolveSplitViewThreadIds(snapshot(firstSplitId)).toSorted()).toEqual(
      [THREAD_A, THREAD_B].toSorted(),
    );
    expect(findRootSplitNode(snapshot(firstSplitId)).direction).toBe("vertical");
  });

  it("migrates legacy v1 flat split views from the stable storage key", async () => {
    vi.resetModules();
    globalThis.localStorage = createMemoryStorage();
    globalThis.localStorage.setItem(
      "synara:split-view-state:v1",
      JSON.stringify({
        state: {
          splitViewsById: {
            "split-legacy": {
              id: "split-legacy",
              sourceThreadId: THREAD_A,
              ownerProjectId: PROJECT_ID,
              leftThreadId: THREAD_A,
              rightThreadId: THREAD_B,
              focusedPane: "right",
              ratio: 0.6,
              leftPanel: {
                panel: null,
                diffTurnId: null,
                diffFilePath: null,
                hasOpenedPanel: false,
                lastOpenPanel: "browser",
              },
              rightPanel: {
                panel: "diff",
                diffTurnId: TURN_ID,
                diffFilePath: "src/example.ts",
                hasOpenedPanel: true,
                lastOpenPanel: "diff",
              },
              createdAt: "2026-04-01T00:00:00.000Z",
              updatedAt: "2026-04-01T00:00:00.000Z",
            },
          },
        },
        version: 0,
      }),
    );
    const {
      resolveSplitViewFocusedThreadId: resolveFreshFocusedThreadId,
      resolveSplitViewThreadIds: resolveFreshThreadIds,
      useSplitViewStore: freshSplitViewStore,
    } = await import("./splitViewStore");

    const migrated = freshSplitViewStore.getState().splitViewsById["split-legacy"];
    expect(migrated).toBeDefined();
    if (!migrated) return;
    expect(migrated.root.kind).toBe("split");
    expect(resolveFreshThreadIds(migrated).toSorted()).toEqual([THREAD_A, THREAD_B].toSorted());
    expect(resolveFreshFocusedThreadId(migrated)).toBe(THREAD_B);
  });

  it("subdivides a target leaf perpendicular to its parent on dropThreadOnPane", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "second",
    });

    const targetLeafId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);
    const ok = useSplitViewStore.getState().dropThreadOnPane({
      splitViewId,
      targetPaneId: targetLeafId,
      direction: "vertical",
      side: "first",
      threadId: THREAD_C,
    });
    expect(ok).toBe(true);

    const splitView = snapshot(splitViewId);
    expect(resolveSplitViewThreadIds(splitView).toSorted()).toEqual(
      [THREAD_A, THREAD_B, THREAD_C].toSorted(),
    );
    const newLeaf = collectLeaves(splitView.root).find((leaf) => leaf.threadId === THREAD_C);
    expect(newLeaf).toBeDefined();
    expect(splitView.focusedPaneId).toBe(newLeaf?.id);
    if (newLeaf) {
      const parent = findParentSplitNode(splitView.root, newLeaf.id);
      expect(parent?.direction).toBe("vertical");
    }
  });

  it("rejects dropThreadOnPane when the dropped thread is already in the split view", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "second",
    });

    const targetLeafId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);
    const ok = useSplitViewStore.getState().dropThreadOnPane({
      splitViewId,
      targetPaneId: targetLeafId,
      direction: "vertical",
      side: "second",
      threadId: THREAD_A,
    });

    expect(ok).toBe(false);
    expect(resolveSplitViewThreadIds(snapshot(splitViewId)).toSorted()).toEqual(
      [THREAD_A, THREAD_B].toSorted(),
    );
  });

  it("rejects dropThreadOnPane when the requested direction matches the parent direction", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "first",
    });

    const targetLeafId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);
    const ok = useSplitViewStore.getState().dropThreadOnPane({
      splitViewId,
      targetPaneId: targetLeafId,
      direction: "horizontal",
      side: "second",
      threadId: THREAD_C,
    });
    expect(ok).toBe(false);
    expect(resolveSplitViewThreadIds(snapshot(splitViewId)).toSorted()).toEqual(
      [THREAD_A, THREAD_B].toSorted(),
    );
  });

  it("supports filling a 2x2 grid through perpendicular drops", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "first",
    });

    const leafAId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);
    expect(
      useSplitViewStore.getState().dropThreadOnPane({
        splitViewId,
        targetPaneId: leafAId,
        direction: "vertical",
        side: "second",
        threadId: THREAD_C,
      }),
    ).toBe(true);

    const leafBId = findLeafIdForThread(snapshot(splitViewId), THREAD_B);
    expect(
      useSplitViewStore.getState().dropThreadOnPane({
        splitViewId,
        targetPaneId: leafBId,
        direction: "vertical",
        side: "second",
        threadId: THREAD_D,
      }),
    ).toBe(true);

    expect(resolveSplitViewThreadIds(snapshot(splitViewId)).toSorted()).toEqual(
      [THREAD_A, THREAD_B, THREAD_C, THREAD_D].toSorted(),
    );
  });

  it("rejects drops on leaves that are already inside a second-level split", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "first",
    });

    const leafAId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);
    expect(
      useSplitViewStore.getState().dropThreadOnPane({
        splitViewId,
        targetPaneId: leafAId,
        direction: "vertical",
        side: "second",
        threadId: THREAD_C,
      }),
    ).toBe(true);

    const nestedLeafAId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);
    expect(
      useSplitViewStore.getState().dropThreadOnPane({
        splitViewId,
        targetPaneId: nestedLeafAId,
        direction: "horizontal",
        side: "second",
        threadId: THREAD_D,
      }),
    ).toBe(false);

    expect(resolveSplitViewThreadIds(snapshot(splitViewId)).toSorted()).toEqual(
      [THREAD_A, THREAD_B, THREAD_C].toSorted(),
    );
  });

  it("setRatioForNode clamps to the allowed range and only writes when changed", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "first",
    });
    const root = findRootSplitNode(snapshot(splitViewId));

    useSplitViewStore.getState().setRatioForNode(splitViewId, root.id, 0.99);
    expect(findRootSplitNode(snapshot(splitViewId)).ratio).toBeCloseTo(0.75);

    useSplitViewStore.getState().setRatioForNode(splitViewId, root.id, 0.01);
    expect(findRootSplitNode(snapshot(splitViewId)).ratio).toBeCloseTo(0.25);
  });

  it("setFocusedPane refuses ids that do not point to a leaf", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "first",
    });
    const root = findRootSplitNode(snapshot(splitViewId));
    const previousFocusedPaneId = snapshot(splitViewId).focusedPaneId;

    useSplitViewStore.getState().setFocusedPane(splitViewId, root.id);
    expect(snapshot(splitViewId).focusedPaneId).toBe(previousFocusedPaneId);

    useSplitViewStore.getState().setFocusedPane(splitViewId, "non-existent");
    expect(snapshot(splitViewId).focusedPaneId).toBe(previousFocusedPaneId);
  });

  it("replacePaneThread reanchors a split when clearing the source pane", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "second",
    });
    const sourcePaneId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);

    store.replacePaneThread(splitViewId, sourcePaneId, null);

    const nextState = useSplitViewStore.getState();
    const splitView = snapshot(splitViewId);
    expect(splitView.sourceThreadId).toBe(THREAD_B);
    expect(nextState.splitViewIdBySourceThreadId[THREAD_A]).toBeUndefined();
    expect(nextState.splitViewIdBySourceThreadId[THREAD_B]).toBe(splitViewId);
    expect(resolvePreferredSplitViewIdForThread({ ...nextState, threadId: THREAD_A })).toBeNull();
  });

  it("replacePaneThread reanchors a split when replacing the source pane", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "second",
    });
    const sourcePaneId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);

    store.replacePaneThread(splitViewId, sourcePaneId, THREAD_C);

    const nextState = useSplitViewStore.getState();
    const splitView = snapshot(splitViewId);
    expect(splitView.sourceThreadId).toBe(THREAD_C);
    expect(resolveSplitViewThreadIds(splitView).toSorted()).toEqual(
      [THREAD_B, THREAD_C].toSorted(),
    );
    expect(nextState.splitViewIdBySourceThreadId[THREAD_A]).toBeUndefined();
    expect(nextState.splitViewIdBySourceThreadId[THREAD_C]).toBe(splitViewId);
    expect(resolvePreferredSplitViewIdForThread({ ...nextState, threadId: THREAD_C })).toBe(
      splitViewId,
    );
  });

  it("replacePaneThread does not steal another split's source mapping", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "second",
    });
    const otherSplitId = store.createFromThread({
      sourceThreadId: THREAD_C,
      ownerProjectId: PROJECT_ID,
    });
    const sourcePaneId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);

    store.replacePaneThread(splitViewId, sourcePaneId, THREAD_C);

    const nextState = useSplitViewStore.getState();
    const splitView = snapshot(splitViewId);
    expect(splitView.sourceThreadId).toBe(THREAD_B);
    expect(resolveSplitViewThreadIds(splitView).toSorted()).toEqual(
      [THREAD_B, THREAD_C].toSorted(),
    );
    expect(nextState.splitViewIdBySourceThreadId[THREAD_A]).toBeUndefined();
    expect(nextState.splitViewIdBySourceThreadId[THREAD_B]).toBe(splitViewId);
    expect(nextState.splitViewIdBySourceThreadId[THREAD_C]).toBe(otherSplitId);
  });

  it("replacePaneThread removes a split when clearing its last populated pane", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromThread({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
    });
    const sourcePaneId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);

    store.replacePaneThread(splitViewId, sourcePaneId, null);

    const nextState = useSplitViewStore.getState();
    expect(nextState.splitViewsById[splitViewId]).toBeUndefined();
    expect(nextState.splitViewIdBySourceThreadId[THREAD_A]).toBeUndefined();
  });

  it("removeThreadFromSplitViews collapses the tree, drops orphaned splits, and reseats focus", () => {
    const store = useSplitViewStore.getState();
    const firstSplitId = store.createFromThread({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
    });
    const firstEmptyId = findEmptyLeafId(snapshot(firstSplitId));
    store.replacePaneThread(firstSplitId, firstEmptyId, THREAD_B);
    const firstThreadAPaneId = findLeafIdForThread(snapshot(firstSplitId), THREAD_A);
    store.setPanePanelState(firstSplitId, firstThreadAPaneId, {
      panel: "diff",
      diffTurnId: TURN_ID,
      diffFilePath: "src/left.ts",
      hasOpenedPanel: true,
      lastOpenPanel: "diff",
    });

    const secondSplitId = store.createFromThread({
      sourceThreadId: THREAD_C,
      ownerProjectId: PROJECT_ID,
    });
    const secondEmptyId = findEmptyLeafId(snapshot(secondSplitId));
    store.replacePaneThread(secondSplitId, secondEmptyId, THREAD_A);
    store.setFocusedPane(secondSplitId, secondEmptyId);

    useSplitViewStore.getState().removeThreadFromSplitViews(THREAD_A);

    const nextState = useSplitViewStore.getState();
    expect(nextState.splitViewIdBySourceThreadId[THREAD_A]).toBeUndefined();

    const firstSplit = nextState.splitViewsById[firstSplitId];
    expect(firstSplit).toBeDefined();
    if (firstSplit) {
      // First split kept THREAD_B and dropped the THREAD_A leaf, so the tree collapses to a single leaf.
      expect(resolveSplitViewThreadIds(firstSplit)).toEqual([THREAD_B]);
      expect(resolveSplitViewFocusedThreadId(firstSplit)).toBe(THREAD_B);
      expect(firstSplit.sourceThreadId).toBe(THREAD_B);
    }
    expect(nextState.splitViewIdBySourceThreadId[THREAD_B]).toBe(firstSplitId);

    const secondSplit = nextState.splitViewsById[secondSplitId];
    expect(secondSplit).toBeDefined();
    if (secondSplit) {
      expect(resolveSplitViewThreadIds(secondSplit)).toEqual([THREAD_C]);
      expect(resolveSplitViewFocusedThreadId(secondSplit)).toBe(THREAD_C);
    }
    expect(nextState.splitViewIdBySourceThreadId[THREAD_C]).toBe(secondSplitId);
  });

  it("removePaneFromSplitView removes one pane and lets the surviving subtree fill the split", () => {
    const store = useSplitViewStore.getState();
    const splitViewId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "second",
    });
    const threadBPaneId = findLeafIdForThread(snapshot(splitViewId), THREAD_B);
    store.dropThreadOnPane({
      splitViewId,
      targetPaneId: threadBPaneId,
      direction: "vertical",
      side: "second",
      threadId: THREAD_C,
    });

    const threadAPaneId = findLeafIdForThread(snapshot(splitViewId), THREAD_A);
    const ok = useSplitViewStore.getState().removePaneFromSplitView({
      splitViewId,
      paneId: threadAPaneId,
    });

    expect(ok).toBe(true);
    const splitView = snapshot(splitViewId);
    expect(splitView.root.kind).toBe("split");
    if (splitView.root.kind === "split") {
      expect(splitView.root.direction).toBe("vertical");
    }
    expect(resolveSplitViewThreadIds(splitView).toSorted()).toEqual(
      [THREAD_B, THREAD_C].toSorted(),
    );
    expect(splitView.sourceThreadId).toBe(THREAD_B);
    expect(useSplitViewStore.getState().splitViewIdBySourceThreadId[THREAD_A]).toBeUndefined();
    expect(useSplitViewStore.getState().splitViewIdBySourceThreadId[THREAD_B]).toBe(splitViewId);
  });

  it("removes an empty split entirely after deleting its source thread", () => {
    const store = useSplitViewStore.getState();
    const splitId = store.createFromDrop({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      droppedThreadId: THREAD_B,
      direction: "horizontal",
      side: "first",
    });

    useSplitViewStore.getState().removeThreadFromSplitViews(THREAD_A);
    useSplitViewStore.getState().removeThreadFromSplitViews(THREAD_B);

    const nextState = useSplitViewStore.getState();
    expect(nextState.splitViewsById[splitId]).toBeUndefined();
    expect(nextState.splitViewIdBySourceThreadId[THREAD_A]).toBeUndefined();
  });

  it("removes a source-plus-empty split after deleting its only thread", () => {
    const store = useSplitViewStore.getState();
    const splitId = store.createFromThread({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
    });

    useSplitViewStore.getState().removeThreadFromSplitViews(THREAD_A);

    const nextState = useSplitViewStore.getState();
    expect(nextState.splitViewsById[splitId]).toBeUndefined();
    expect(nextState.splitViewIdBySourceThreadId[THREAD_A]).toBeUndefined();
  });

  it("prefers the source split for a thread before other matching splits", () => {
    const store = useSplitViewStore.getState();
    const sourceSplitId = store.createFromThread({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
    });
    const otherSplitId = store.createFromThread({
      sourceThreadId: THREAD_C,
      ownerProjectId: PROJECT_ID,
    });
    const otherEmptyId = findEmptyLeafId(snapshot(otherSplitId));
    store.replacePaneThread(otherSplitId, otherEmptyId, THREAD_A);

    expect(
      resolvePreferredSplitViewIdForThread({
        splitViewsById: useSplitViewStore.getState().splitViewsById,
        splitViewIdBySourceThreadId: useSplitViewStore.getState().splitViewIdBySourceThreadId,
        threadId: THREAD_A,
      }),
    ).toBe(sourceSplitId);
  });

  it("resolves the only matching split for non-source threads", () => {
    const store = useSplitViewStore.getState();
    const splitId = store.createFromThread({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
    });
    const emptyId = findEmptyLeafId(snapshot(splitId));
    store.replacePaneThread(splitId, emptyId, THREAD_B);

    expect(
      resolvePreferredSplitViewIdForThread({
        splitViewsById: useSplitViewStore.getState().splitViewsById,
        splitViewIdBySourceThreadId: useSplitViewStore.getState().splitViewIdBySourceThreadId,
        threadId: THREAD_B,
      }),
    ).toBe(splitId);
  });

  it("returns null for ambiguous non-source split membership instead of guessing by recency", () => {
    const store = useSplitViewStore.getState();
    const olderSplitId = store.createFromThread({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
    });
    const olderEmptyId = findEmptyLeafId(snapshot(olderSplitId));
    store.replacePaneThread(olderSplitId, olderEmptyId, THREAD_B);

    const newerSplitId = store.createFromThread({
      sourceThreadId: THREAD_C,
      ownerProjectId: PROJECT_ID,
    });
    const newerEmptyId = findEmptyLeafId(snapshot(newerSplitId));
    store.replacePaneThread(newerSplitId, newerEmptyId, THREAD_B);

    expect(
      resolvePreferredSplitViewIdForThread({
        splitViewsById: useSplitViewStore.getState().splitViewsById,
        splitViewIdBySourceThreadId: useSplitViewStore.getState().splitViewIdBySourceThreadId,
        threadId: THREAD_B,
      }),
    ).toBeNull();
  });
});
