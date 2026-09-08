// FILE: SidebarThreadRowContent.browser.tsx
// Purpose: Characterizes the shared Sidebar thread-row identity and status presentation.
// Layer: Browser UI test

import "../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../types";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";
import { isSiblingControlTarget } from "./sidebarThreadRowGestures";

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
  it("isolates gestures on action icons while preserving navigation icon gestures", async () => {
    const screen = await render(
      <div>
        <button type="button" aria-label="Toggle branch">
          <svg>
            <path d="M0 0" />
          </svg>
        </button>
        <button type="button" data-thread-nav aria-label="Open thread">
          <svg>
            <path d="M0 0" />
          </svg>
        </button>
      </div>,
    );
    const actionIcon = screen.container.querySelector('[aria-label="Toggle branch"] path');
    const navigationIcon = screen.container.querySelector('[aria-label="Open thread"] path');
    expect(actionIcon).not.toBeNull();
    expect(navigationIcon).not.toBeNull();
    expect(isSiblingControlTarget(actionIcon)).toBe(true);
    expect(isSiblingControlTarget(navigationIcon)).toBe(false);
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps space between the provider icon and thread title inside the navigation button", async () => {
    const screen = await render(
      <button type="button" className="flex min-w-0 items-center">
        <SidebarThreadRowContent
          thread={makeThread()}
          terminalEntryPoint={false}
          terminalStatus={null}
          terminalCount={0}
          isActive={false}
          variant="standard"
        />
      </button>,
    );

    const providerIcon = screen.container.querySelector("svg");
    expect(providerIcon).not.toBeNull();
    const iconRight = providerIcon!.getBoundingClientRect().right;
    const titleLeft = screen.getByText("Shared thread row").element().getBoundingClientRect().left;

    expect(titleLeft - iconRight).toBeCloseTo(8, 0);
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
      />,
    );

    await expect.element(screen.getByText("Scout")).toBeVisible();
    await expect.element(screen.getByText("(reviewer)")).toBeVisible();
    // Subagent rows lead with their own provider icon like any other row; no
    // connector or accent dot stands in for it.
    expect(screen.container.querySelector("svg")).not.toBeNull();
    expect(screen.container.querySelectorAll('[class*="bg-border"]')).toHaveLength(0);
  });

  it("renders a batch child with its provider icon and full title, without a batch role", async () => {
    const screen = await render(
      <SidebarThreadRowContent
        thread={makeThread({
          id: ThreadId.makeUnsafe("thread-batch-row"),
          parentThreadId: null,
          title: "Batch child full title",
        })}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={0}
        isActive={false}
        variant="standard"
      />,
    );

    await expect.element(screen.getByText("Batch child full title")).toBeVisible();
    expect(document.body.textContent).not.toContain("batch");
    expect(screen.container.querySelector("svg")).not.toBeNull();
  });
});
