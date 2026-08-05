import { describe, expect, it } from "vitest";
import { ThreadId } from "@synara/contracts";

import {
  RIGHT_DOCK_PANE_KINDS,
  SINGLETON_PANE_KINDS,
  closePaneInState,
  createDefaultRightDockState,
  findMissingSidechatPaneIds,
  isRightDockPaneKind,
  openPaneInState,
  resolveVisibleDockSidechatThreadIds,
  sanitizeRightDockStateByThreadId,
  sanitizeRightDockThreadState,
  setDockOpenInState,
  updatePaneInState,
} from "./rightDockStore.logic";

describe("RIGHT_DOCK_PANE_KINDS (single source of truth)", () => {
  it("lists every supported kind", () => {
    expect([...RIGHT_DOCK_PANE_KINDS]).toEqual([
      "browser",
      "diff",
      "explorer",
      "file",
      "terminal",
      "sidechat",
      "git",
      "pullRequest",
    ]);
  });

  it("derives singletons as every kind except the multi-instance ones", () => {
    for (const kind of RIGHT_DOCK_PANE_KINDS) {
      expect(SINGLETON_PANE_KINDS.has(kind)).toBe(kind !== "file");
    }
  });
});

describe("isRightDockPaneKind", () => {
  it("accepts the known pane kinds", () => {
    for (const kind of [
      "browser",
      "diff",
      "explorer",
      "file",
      "terminal",
      "sidechat",
      "git",
      "pullRequest",
    ]) {
      expect(isRightDockPaneKind(kind)).toBe(true);
    }
  });

  it("rejects unknown or malformed kinds", () => {
    expect(isRightDockPaneKind("plan")).toBe(false);
    expect(isRightDockPaneKind(undefined)).toBe(false);
    expect(isRightDockPaneKind(null)).toBe(false);
    expect(isRightDockPaneKind(42)).toBe(false);
  });
});

describe("pull request pane", () => {
  it("reuses the singleton pane and updates its PR identity", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "pr-1",
      kind: "pullRequest",
      pullRequestProjectId: "project-1" as never,
      pullRequestRepository: "acme/one",
      pullRequestNumber: 12,
      pullRequestInitialTab: "summary",
    });
    const reopened = openPaneInState(first, {
      paneId: "pr-2",
      kind: "pullRequest",
      pullRequestProjectId: "project-2" as never,
      pullRequestRepository: "acme/two",
      pullRequestNumber: 24,
      pullRequestInitialTab: "code",
    });
    expect(reopened.panes).toHaveLength(1);
    expect(reopened.activePaneId).toBe("pr-1");
    expect(reopened.panes[0]?.pullRequestProjectId).toBe("project-2");
    expect(reopened.panes[0]?.pullRequestRepository).toBe("acme/two");
    expect(reopened.panes[0]?.pullRequestNumber).toBe(24);
    expect(reopened.panes[0]?.pullRequestInitialTab).toBe("code");
  });

  it("drops a non-integer persisted pull request number", () => {
    const sanitized = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "pr-1",
      panes: [
        {
          paneId: "ignored",
          id: "pr-1",
          kind: "pullRequest",
          pullRequestNumber: 1.5,
        },
      ],
    });
    expect(sanitized.panes[0]?.pullRequestNumber).toBeNull();
  });
});

describe("sanitizeRightDockThreadState", () => {
  it("keeps recognized panes and a valid active tab", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "b",
      panes: [
        { id: "a", kind: "diff", threadId: null, diffTurnId: null, diffFilePath: null },
        { id: "b", kind: "terminal", threadId: null, diffTurnId: null, diffFilePath: null },
      ],
    });
    expect(state.panes.map((pane) => pane.id)).toEqual(["a", "b"]);
    expect(state.activePaneId).toBe("b");
    expect(state.open).toBe(true);
  });

  it("drops panes with an unknown kind and repoints the active tab", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "legacy",
      panes: [
        { id: "legacy", kind: "scrabble", threadId: null, diffTurnId: null, diffFilePath: null },
        { id: "keep", kind: "git", threadId: null, diffTurnId: null, diffFilePath: null },
      ],
    });
    expect(state.panes.map((pane) => pane.id)).toEqual(["keep"]);
    expect(state.activePaneId).toBe("keep");
    expect(state.open).toBe(true);
  });

  it("preserves an open empty dock when no valid panes survive", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "legacy",
      panes: [
        { id: "legacy", kind: "scrabble", threadId: null, diffTurnId: null, diffFilePath: null },
      ],
    });
    expect(state.panes).toEqual([]);
    expect(state.activePaneId).toBeNull();
    expect(state.open).toBe(true);
  });

  it("returns the default state for malformed input", () => {
    expect(sanitizeRightDockThreadState(null)).toEqual({
      open: false,
      panes: [],
      activePaneId: null,
    });
    expect(sanitizeRightDockThreadState({ panes: "nope" })).toEqual({
      open: false,
      panes: [],
      activePaneId: null,
    });
  });

  it("migrates multiple persisted sidechat tabs into one active destination", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "side-b",
      panes: [
        { id: "side-a", kind: "sidechat", threadId: "thread-a" },
        { id: "side-b", kind: "sidechat", threadId: "thread-b" },
      ],
    });

    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.id).toBe("side-b");
    expect(state.panes[0]?.threadId).toBe("thread-b");
    expect(state.activePaneId).toBe("side-b");
  });
});

describe("sidechat pane", () => {
  it("reuses the singleton destination and switches its embedded thread", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "side-pane",
      kind: "sidechat",
      threadId: ThreadId.makeUnsafe("thread-a"),
    });
    const switched = openPaneInState(first, {
      paneId: "ignored",
      kind: "sidechat",
      threadId: ThreadId.makeUnsafe("thread-b"),
    });

    expect(switched.panes).toHaveLength(1);
    expect(switched.activePaneId).toBe("side-pane");
    expect(switched.panes[0]?.threadId).toBe("thread-b");
  });

  it("finds sidechat panes whose backing thread no longer exists", () => {
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: "side-pane",
      kind: "sidechat",
      threadId: ThreadId.makeUnsafe("missing-thread"),
    });

    expect(findMissingSidechatPaneIds(state, new Set())).toEqual(["side-pane"]);
    expect(
      findMissingSidechatPaneIds(state, new Set([ThreadId.makeUnsafe("missing-thread")])),
    ).toEqual([]);
  });
});

describe("resolveVisibleDockSidechatThreadIds", () => {
  const hostThreadId = ThreadId.makeUnsafe("host-thread");
  const sidechatThreadId = ThreadId.makeUnsafe("sidechat-thread");

  function dockWithSidechat(open: boolean) {
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: "side-pane",
      kind: "sidechat",
      threadId: sidechatThreadId,
    });
    return setDockOpenInState(state, open);
  }

  it("exposes the embedded sidechat thread of an open host dock", () => {
    expect(
      resolveVisibleDockSidechatThreadIds({
        dockRendered: true,
        dockStateByThreadId: { [hostThreadId]: dockWithSidechat(true) },
        hostThreadIds: [hostThreadId],
      }),
    ).toEqual([sidechatThreadId]);
  });

  it("ignores hidden docks, inactive sidechat panes, other hosts, and non-sidechat panes", () => {
    expect(
      resolveVisibleDockSidechatThreadIds({
        dockRendered: false,
        dockStateByThreadId: { [hostThreadId]: dockWithSidechat(true) },
        hostThreadIds: [hostThreadId],
      }),
    ).toEqual([]);
    expect(
      resolveVisibleDockSidechatThreadIds({
        dockRendered: true,
        dockStateByThreadId: { [hostThreadId]: dockWithSidechat(false) },
        hostThreadIds: [hostThreadId],
      }),
    ).toEqual([]);
    expect(
      resolveVisibleDockSidechatThreadIds({
        dockRendered: true,
        dockStateByThreadId: { [hostThreadId]: dockWithSidechat(true) },
        hostThreadIds: [ThreadId.makeUnsafe("other-host")],
      }),
    ).toEqual([]);
    const explorerOnly = openPaneInState(createDefaultRightDockState(), {
      paneId: "explorer-pane",
      kind: "explorer",
    });
    expect(
      resolveVisibleDockSidechatThreadIds({
        dockRendered: true,
        dockStateByThreadId: { [hostThreadId]: explorerOnly },
        hostThreadIds: [hostThreadId],
      }),
    ).toEqual([]);
    const inactiveSidechat = openPaneInState(dockWithSidechat(true), {
      paneId: "explorer-pane",
      kind: "explorer",
    });
    expect(
      resolveVisibleDockSidechatThreadIds({
        dockRendered: true,
        dockStateByThreadId: { [hostThreadId]: inactiveSidechat },
        hostThreadIds: [hostThreadId],
      }),
    ).toEqual([]);
  });

  it("deduplicates against host threads and across hosts", () => {
    const selfEmbedding = openPaneInState(createDefaultRightDockState(), {
      paneId: "side-pane",
      kind: "sidechat",
      threadId: hostThreadId,
    });
    expect(
      resolveVisibleDockSidechatThreadIds({
        dockRendered: true,
        dockStateByThreadId: { [hostThreadId]: selfEmbedding },
        hostThreadIds: [hostThreadId],
      }),
    ).toEqual([]);

    const otherHostThreadId = ThreadId.makeUnsafe("other-host");
    expect(
      resolveVisibleDockSidechatThreadIds({
        dockRendered: true,
        dockStateByThreadId: {
          [hostThreadId]: dockWithSidechat(true),
          [otherHostThreadId]: dockWithSidechat(true),
        },
        hostThreadIds: [hostThreadId, otherHostThreadId],
      }),
    ).toEqual([sidechatThreadId]);
  });
});

describe("empty launcher state", () => {
  it("opens the dock without creating a pane", () => {
    expect(setDockOpenInState(createDefaultRightDockState(), true)).toEqual({
      open: true,
      panes: [],
      activePaneId: null,
    });
  });

  it("returns to the launcher after the final pane closes", () => {
    const open = openPaneInState(createDefaultRightDockState(), {
      paneId: "browser-1",
      kind: "browser",
    });

    expect(closePaneInState(open, "browser-1")).toEqual({
      open: true,
      panes: [],
      activePaneId: null,
    });
  });
});

describe("file panes", () => {
  it("opens a file pane carrying the file path", () => {
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    expect(state.open).toBe(true);
    expect(state.activePaneId).toBe("f1");
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.filePath).toBe("src/page.tsx");
  });

  it("opens another file in a new tab instead of swapping the existing pane", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const second = openPaneInState(first, {
      paneId: "f2",
      kind: "file",
      filePath: "README.md",
    });
    expect(second.panes).toHaveLength(2);
    expect(second.panes[0]?.filePath).toBe("src/page.tsx");
    expect(second.panes[1]?.filePath).toBe("README.md");
    expect(second.activePaneId).toBe("f2");
  });

  it("focuses the existing tab when the same file is opened again", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const second = openPaneInState(first, {
      paneId: "f2",
      kind: "file",
      filePath: "README.md",
    });
    const reopened = openPaneInState(second, {
      paneId: "f3",
      kind: "file",
      filePath: "src/page.tsx",
    });
    expect(reopened.panes).toHaveLength(2);
    expect(reopened.activePaneId).toBe("f1");
  });

  it("reuses an existing empty file pane on a bare open", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
    });
    const reopened = openPaneInState({ ...first, open: false }, { paneId: "f2", kind: "file" });
    expect(reopened.open).toBe(true);
    expect(reopened.panes).toHaveLength(1);
    expect(reopened.activePaneId).toBe("f1");
  });

  it("adds a new empty tab on a bare open when every file pane is occupied", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const second = openPaneInState(first, { paneId: "f2", kind: "file" });
    expect(second.panes).toHaveLength(2);
    expect(second.panes[1]?.filePath).toBeNull();
    expect(second.activePaneId).toBe("f2");
  });

  it("updates the file path through updatePaneInState", () => {
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const updated = updatePaneInState(state, "f1", { filePath: "src/other.tsx" });
    expect(updated.panes[0]?.filePath).toBe("src/other.tsx");
    expect(updatePaneInState(updated, "f1", { filePath: "src/other.tsx" })).toBe(updated);
  });

  it("sanitizes persisted file panes, preserving the file path", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "f1",
      panes: [
        {
          id: "f1",
          kind: "file",
          threadId: null,
          diffTurnId: null,
          diffFilePath: null,
          filePath: "src/page.tsx",
        },
      ],
    });
    expect(state.panes[0]?.kind).toBe("file");
    expect(state.panes[0]?.filePath).toBe("src/page.tsx");
  });
});

describe("sanitizeRightDockStateByThreadId", () => {
  it("sanitizes every thread entry and skips undefined values", () => {
    const result = sanitizeRightDockStateByThreadId({
      t1: {
        open: true,
        activePaneId: "x",
        panes: [{ id: "x", kind: "browser", threadId: null, diffTurnId: null, diffFilePath: null }],
      },
      t2: undefined,
    });
    expect(Object.keys(result)).toEqual(["t1"]);
    expect(result.t1?.panes).toHaveLength(1);
  });

  it("returns an empty map for non-object input", () => {
    expect(sanitizeRightDockStateByThreadId(null)).toEqual({});
    expect(sanitizeRightDockStateByThreadId("oops")).toEqual({});
  });
});
