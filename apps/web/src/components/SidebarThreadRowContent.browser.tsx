// FILE: SidebarThreadRowContent.browser.tsx
// Purpose: Characterizes the shared Sidebar thread-row identity and status presentation.
// Layer: Browser UI test

import "../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../types";
import {
  resolveChildThreadRowDescription,
  resolveSubagentRowDescription,
  SidebarThreadRowContent,
} from "./SidebarThreadRowContent";

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-row-content"),
    projectId: ProjectId.makeUnsafe("project-row-content"),
    title: "Shared thread row",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-07-19T12:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

describe("SidebarThreadRowContent", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("preserves the pinned title, pending state, terminal count, and suffix", async () => {
    const thread = makeThread();
    const screen = await render(
      <SidebarThreadRowContent
        thread={thread}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={2}
        isActive
        variant="pinned"
        pendingStatusColorClass="text-amber-600"
        suffix={<span>Project Alpha</span>}
      />,
    );

    await expect
      .element(screen.getByTestId(`thread-title-${thread.id}`))
      .toHaveTextContent("Shared thread row");
    await expect.element(screen.getByLabelText("Pending approval")).toHaveTextContent("Pending");
    await expect.element(screen.getByLabelText("2 terminals open")).toBeVisible();
    await expect.element(screen.getByText("Project Alpha")).toBeVisible();
  });

  it("keeps standard subagent nickname and role presentation", async () => {
    const screen = await render(
      <SidebarThreadRowContent
        thread={makeThread({
          id: ThreadId.makeUnsafe("thread-subagent-row"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent-row"),
          subagentNickname: "Scout",
          subagentRole: "reviewer",
        })}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={0}
        isActive={false}
        variant="standard"
        subagentIndentPx={10}
      />,
    );

    await expect.element(screen.getByText("Scout")).toBeVisible();
    await expect.element(screen.getByText("(reviewer)")).toBeVisible();
    const connector = screen.getByTestId("sidebar-subagent-connector");
    await expect.element(connector).toBeVisible();
    await expect.element(connector).toHaveAttribute("data-indent", "10");
  });

  it("shows Synara-created threads as indented children", async () => {
    const screen = await render(
      <SidebarThreadRowContent
        thread={makeThread({
          id: ThreadId.makeUnsafe("thread-created-row"),
          title: "Saludo",
          creationSource: "synara_mcp",
          sourceThreadId: ThreadId.makeUnsafe("thread-parent-row"),
        })}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={0}
        isActive={false}
        variant="standard"
        subagentIndentPx={10}
      />,
    );

    await expect.element(screen.getByText("Saludo")).toBeVisible();
    const connector = screen.getByTestId("sidebar-subagent-connector");
    await expect.element(connector).toBeVisible();
    await expect.element(connector).toHaveAttribute("data-indent", "10");
    await expect.element(screen.getByTestId("sidebar-child-provider-icon")).toHaveAttribute(
      "data-provider",
      "codex",
    );
  });

  it("uses a quiet linked indicator without a card for colocated split members", async () => {
    const screen = await render(
      <SidebarThreadRowContent
        thread={makeThread({ id: ThreadId.makeUnsafe("thread-split-member") })}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={0}
        isActive={false}
        variant="standard"
        splitGroup={{
          splitViewId: "split-rail",
          presentation: "card",
          memberIndex: 2,
          memberCount: 3,
          isLeader: false,
          position: "middle",
        }}
        splitGroupActive
        splitGroupLabel="Split view with hola 1 and hoola 2"
      />,
    );

    await expect
      .element(screen.getByLabelText("Split view with hola 1 and hoola 2"))
      .toBeVisible();
    expect(document.querySelector("[data-testid=sidebar-split-group-surface]")).toBeNull();
  });

  it("uses a linked indicator instead of a card for remote split members", async () => {
    const screen = await render(
      <SidebarThreadRowContent
        thread={makeThread({ id: ThreadId.makeUnsafe("thread-linked-split-member") })}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={0}
        isActive={false}
        variant="standard"
        splitGroup={{
          splitViewId: "split-linked",
          presentation: "linked",
          memberIndex: 1,
          memberCount: 2,
          isLeader: true,
          position: "first",
        }}
        splitGroupActive
        splitGroupLabel="Split view with hoola 2"
      />,
    );

    await expect.element(screen.getByLabelText("Split view with hoola 2")).toBeVisible();
    expect(document.querySelector("[data-testid=sidebar-split-group-surface]")).toBeNull();
  });

  it("moves the subagent context onto its focusable row description", () => {
    expect(
      resolveSubagentRowDescription({
        thread: makeThread({
          parentThreadId: ThreadId.makeUnsafe("thread-parent-row"),
          modelSelection: {
            provider: "codex",
            model: "gpt-5.6",
            options: { reasoningEffort: "medium" },
          },
          session: {
            provider: "codex",
            status: "closed",
            orchestrationStatus: "stopped",
            createdAt: "2026-07-19T12:00:00.000Z",
            updatedAt: "2026-07-19T12:01:00.000Z",
          },
        }),
        parentTitle: "Implement webhook spec",
      }),
    ).toBe("Subagent of Implement webhook spec · gpt-5.6 · medium · closed");
  });

  it("describes a Synara-created child without calling it a native subagent", () => {
    expect(
      resolveChildThreadRowDescription({
        thread: makeThread({
          creationSource: "synara_mcp",
          sourceThreadId: ThreadId.makeUnsafe("thread-parent"),
        }),
        parentTitle: "hola 1",
      }),
    ).toBe("Created from hola 1");
  });

  it("omits the split-group surface when the row is not part of a split", async () => {
    const screen = await render(
      <SidebarThreadRowContent
        thread={makeThread({ id: ThreadId.makeUnsafe("thread-no-split") })}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={0}
        isActive={false}
        variant="standard"
        splitGroup={null}
      />,
    );

    await expect.element(screen.getByText("Shared thread row")).toBeVisible();
    expect(document.querySelectorAll("[data-testid=sidebar-split-group-rail]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-testid=sidebar-split-group-surface]")).toHaveLength(0);
  });

  it("keeps the temporary icon when an ordinary thread has no metadata chips", async () => {
    const screen = await render(
      <SidebarThreadRowContent
        thread={makeThread()}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={0}
        isActive={false}
        variant="standard"
        suffix={<span aria-label="Temporary chat">Temporary</span>}
      />,
    );

    await expect.element(screen.getByLabelText("Temporary chat")).toBeVisible();
  });
});
