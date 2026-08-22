import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { SplitView } from "../../splitViewStore";
import { routeSplitBrowserPanelOpenRequest } from "./browserPanelOpenRequest";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");

function createSplitView(): SplitView {
  return {
    id: "split-1",
    sourceThreadId: THREAD_A,
    ownerProjectId: ProjectId.makeUnsafe("project-1"),
    focusedPaneId: "pane-a",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    root: {
      kind: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "leaf",
        id: "pane-a",
        threadId: THREAD_A,
        panel: {
          panel: null,
          diffTurnId: null,
          diffFilePath: null,
          hasOpenedPanel: false,
          lastOpenPanel: "browser",
        },
      },
      second: {
        kind: "leaf",
        id: "pane-b",
        threadId: THREAD_B,
        panel: {
          panel: "diff",
          diffTurnId: null,
          diffFilePath: "src/example.ts",
          hasOpenedPanel: true,
          lastOpenPanel: "diff",
        },
      },
    },
  };
}

describe("routeSplitBrowserPanelOpenRequest", () => {
  it("does not disturb an unfocused pane that owns a background browser request", () => {
    const calls: string[] = [];

    routeSplitBrowserPanelOpenRequest({
      splitView: createSplitView(),
      requestedThreadId: THREAD_B,
      rememberFloatingBrowser: (threadId) => calls.push(`remember:${threadId}`),
      showFloatingBrowser: (paneId) => calls.push(`float:${paneId}`),
    });

    expect(calls).toEqual([`remember:${THREAD_B}`]);
  });

  it("shows the floating browser only when the requesting thread is already focused", () => {
    const calls: string[] = [];

    routeSplitBrowserPanelOpenRequest({
      splitView: createSplitView(),
      requestedThreadId: THREAD_A,
      rememberFloatingBrowser: (threadId) => calls.push(`remember:${threadId}`),
      showFloatingBrowser: (paneId) => calls.push(`float:${paneId}`),
    });

    expect(calls).toEqual([`remember:${THREAD_A}`, "float:pane-a"]);
  });

  it("does not replace a pane for a thread outside the split", () => {
    const calls: string[] = [];

    routeSplitBrowserPanelOpenRequest({
      splitView: createSplitView(),
      requestedThreadId: THREAD_C,
      rememberFloatingBrowser: (threadId) => calls.push(`remember:${threadId}`),
      showFloatingBrowser: (paneId) => calls.push(`float:${paneId}`),
    });

    expect(calls).toEqual([`remember:${THREAD_C}`]);
  });
});
