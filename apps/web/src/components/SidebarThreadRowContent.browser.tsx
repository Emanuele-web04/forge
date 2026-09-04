// FILE: SidebarThreadRowContent.browser.tsx
// Purpose: Characterizes the shared Sidebar thread-row identity and status presentation.
// Layer: Browser UI test

import "../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../types";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";

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
  });
});
