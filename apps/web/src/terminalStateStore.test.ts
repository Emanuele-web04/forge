import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { collectTerminalIdsFromLayout } from "./terminalPaneLayout";
import {
  sanitizePersistedTerminalStateByThreadId,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "./terminalStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function summarizeTerminalGroups(
  terminalGroups: ReturnType<typeof selectThreadTerminalState>["terminalGroups"],
) {
  return terminalGroups.map((group) => ({
    id: group.id,
    activeTerminalId: group.activeTerminalId,
    terminalIds: collectTerminalIdsFromLayout(group.layout),
  }));
}

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState).toMatchObject({
      entryPoint: "chat",
      terminalOpen: false,
      presentationMode: "drawer",
      workspaceLayout: "both",
      workspaceActiveTab: "terminal",
      terminalHeight: 280,
      terminalIds: ["default"],
      terminalLabelsById: { default: "Terminal 1" },
      terminalTitleOverridesById: {},
      terminalCliKindsById: {},
      terminalAttentionStatesById: {},
      runningTerminalIds: [],
      activeTerminalId: "default",
      activeTerminalGroupId: "group-default",
    });
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "default",
        terminalIds: ["default"],
      },
    ]);
  });

  it("marks chat-first threads without forcing open terminal UI", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });
    store.openChatThreadPage(THREAD_ID);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.entryPoint).toBe("chat");
    expect(terminalState.workspaceLayout).toBe("both");
    expect(terminalState.workspaceActiveTab).toBe("chat");
  });

  it("opens terminal-first threads in the workspace terminal tab", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.splitTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "terminal-2",
        terminalIds: ["default", "terminal-2"],
      },
    ]);
  });

  it("restores the last-used presentation mode when reopened", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(THREAD_ID, "workspace");
    store.setTerminalOpen(THREAD_ID, false);
    store.setTerminalOpen(THREAD_ID, true);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
  });

  it("enters workspace mode on the terminal tab by default", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(THREAD_ID, "workspace");
    store.setTerminalWorkspaceTab(THREAD_ID, "chat");
    store.setTerminalPresentationMode(THREAD_ID, "drawer");
    store.setTerminalPresentationMode(THREAD_ID, "workspace");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("opens a new full-width terminal in terminal-only workspace mode", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
  });

  it("restores chat when selecting the chat workspace tab from terminal-only mode", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(THREAD_ID, "terminal-2");
    store.setTerminalWorkspaceTab(THREAD_ID, "chat");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.workspaceLayout).toBe("both");
    expect(terminalState.workspaceActiveTab).toBe("chat");
  });

  it("closes workspace chat into terminal-only mode without closing terminals", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(THREAD_ID, "workspace");
    store.setTerminalWorkspaceTab(THREAD_ID, "chat");
    store.closeWorkspaceChat(THREAD_ID);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
    expect(terminalState.terminalIds).toEqual(["default"]);
  });

  it("preserves terminal-only workspace layout when collapsing to drawer and reopening", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(THREAD_ID, "terminal-2");
    store.setTerminalPresentationMode(THREAD_ID, "drawer");
    store.setTerminalPresentationMode(THREAD_ID, "workspace");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("keeps split terminals in the same group up to the current group limit", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.splitTerminal(THREAD_ID, "terminal-5");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "terminal-5",
        terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalStateStore.getState().newTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      { id: "group-default", activeTerminalId: "default", terminalIds: ["default"] },
      { id: "group-terminal-2", activeTerminalId: "terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("stores terminal labels and removes them when a terminal closes", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: "codex",
      label: "Codex CLI",
    });

    let terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById).toEqual({
      default: "Terminal 1",
      "terminal-2": "Codex 1",
    });
    expect(terminalState.terminalCliKindsById).toEqual({ "terminal-2": "codex" });

    store.closeTerminal(THREAD_ID, "terminal-2");

    terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById).toEqual({ default: "Terminal 1" });
    expect(terminalState.terminalCliKindsById).toEqual({});
  });

  it("persists Antigravity CLI terminal identity", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: "antigravity",
      label: "Antigravity CLI",
    });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById["terminal-2"]).toBe("Antigravity 1");
    expect(terminalState.terminalCliKindsById).toEqual({
      "terminal-2": "antigravity",
    });
  });

  it("clears terminal provider identity when metadata cliKind is null", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: "codex",
      label: "Codex CLI",
    });
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: null,
      label: "bun dev",
    });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById["terminal-2"]).toBe("bun dev");
    expect(terminalState.terminalCliKindsById).toEqual({});
  });

  it("allows unlimited groups while keeping each group capped at four terminals", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.newTerminal(THREAD_ID, "terminal-5");
    store.newTerminal(THREAD_ID, "terminal-6");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
      "terminal-6",
    ]);
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "terminal-4",
        terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4"],
      },
      { id: "group-terminal-5", activeTerminalId: "terminal-5", terminalIds: ["terminal-5"] },
      { id: "group-terminal-6", activeTerminalId: "terminal-6", terminalIds: ["terminal-6"] },
    ]);
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.setTerminalActivity(THREAD_ID, "terminal-2", {
      hasRunningSubprocess: true,
      agentState: null,
    });
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(THREAD_ID, "terminal-2", {
      hasRunningSubprocess: false,
      agentState: null,
    });
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual([]);
  });

  it("strips volatile runtime flags from persisted terminal state", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.setTerminalTitleOverride(THREAD_ID, "terminal-2", "New keybinds set");
    store.setTerminalActivity(THREAD_ID, "terminal-2", {
      hasRunningSubprocess: false,
      agentState: "attention",
    });

    const sanitized = sanitizePersistedTerminalStateByThreadId(
      useTerminalStateStore.getState().terminalStateByThreadId,
    );

    expect(sanitized[THREAD_ID]?.terminalTitleOverridesById).toEqual({
      "terminal-2": "New keybinds set",
    });
    expect(sanitized[THREAD_ID]?.terminalAttentionStatesById).toEqual({});
    expect(sanitized[THREAD_ID]?.runningTerminalIds).toEqual([]);
  });

  it("drops retired standalone workspace terminal scopes", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );

    expect(
      sanitizePersistedTerminalStateByThreadId({
        ["workspace:legacy" as ThreadId]: {
          ...terminalState,
          terminalOpen: true,
        },
      }),
    ).toEqual({});
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_ID, "default");

    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeUndefined();
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .terminalIds,
    ).toEqual(["default"]);
  });

  it("keeps terminal-first threads terminal-first after closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });
    store.closeTerminal(THREAD_ID, "default");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeDefined();
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(false);
    expect(terminalState.terminalIds).toEqual(["default"]);
  });

  it("replaces the final dock terminal with a fresh terminal id", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });
    store.closeTerminalAndEnsureReplacement(THREAD_ID, "default", "terminal-replacement");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["terminal-replacement"]);
    expect(terminalState.activeTerminalId).toBe("terminal-replacement");
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-terminal-replacement",
        activeTerminalId: "terminal-replacement",
        terminalIds: ["terminal-replacement"],
      },
    ]);
  });

  it("does not add a replacement while another dock terminal remains", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });
    store.newTerminal(THREAD_ID, "terminal-2");
    store.closeTerminalAndEnsureReplacement(THREAD_ID, "terminal-2", "unused-replacement");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default"]);
    expect(terminalState.terminalIds).not.toContain("unused-replacement");
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.closeTerminal(THREAD_ID, "terminal-3");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "terminal-2",
        terminalIds: ["default", "terminal-2"],
      },
    ]);
  });
});
