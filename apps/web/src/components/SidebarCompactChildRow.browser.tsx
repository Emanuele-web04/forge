// FILE: SidebarCompactChildRow.browser.tsx
// Purpose: Browser harness for the single compact descendant-row layout.
// Layer: Browser UI test (Vitest + Playwright, no Synara instance needed).

import "../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../types";
import { SidebarCompactChildRow } from "./SidebarCompactChildRow";
import { SidebarThreadBranchControl } from "./SidebarThreadBranchControl";

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("compact-child"),
    projectId: ProjectId.makeUnsafe("project-compact"),
    title: "Compact child",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-09-01T00:01:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

const COMPLETED_STATUS = {
  label: "Completed" as const,
  colorClass: "text-emerald-600",
  dotClass: "bg-emerald-500",
  pulse: false,
};

function renderRow(overrides: Partial<Parameters<typeof SidebarCompactChildRow>[0]> = {}) {
  const callbacks = {
    onActivate: vi.fn(),
    onPrime: vi.fn(),
    onRename: vi.fn(),
    onRenamePointerUp: vi.fn(),
    onContextMenu: vi.fn(),
    renderHoverCard: vi.fn(() => null),
    ...overrides,
  };
  return callbacks;
}

describe("SidebarCompactChildRow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a native child with nickname and role on one compact line", async () => {
    const callbacks = renderRow();
    const screen = await render(
      <ul>
        <li>
          <SidebarCompactChildRow
            thread={makeThread({
              parentThreadId: ThreadId.makeUnsafe("compact-parent"),
              subagentNickname: "Scout",
              subagentRole: "reviewer",
            })}
            surface="project"
            isActive={false}
            isSelected={false}
            status={null}
            branchControl={null}
            threadJumpLabel={null}
            actions={null}
            {...callbacks}
          />
        </li>
      </ul>,
    );

    await expect.element(screen.getByText("Scout")).toBeVisible();
    await expect.element(screen.getByText("(reviewer)")).toBeVisible();
    // Single visual line at desktop density: 28px, never a two-line card.
    const row = screen.getByText("Scout").element().closest("[data-thread-item]")!;
    expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(32);
    // One connector owned by the compact row (two segments), none duplicated
    // from the embedded row content.
    expect(row.querySelectorAll('[class*="bg-border"]').length).toBe(2);
    // No provider avatar, project name, timestamp, or badges in the row.
    expect(row.querySelector("svg")).toBeNull();
    expect(callbacks.renderHoverCard).toHaveBeenCalledWith("project:compact-child");
  });

  it("renders a batch child with a null parent using its full title", async () => {
    const callbacks = renderRow();
    const screen = await render(
      <ul>
        <li>
          <SidebarCompactChildRow
            thread={makeThread({
              id: ThreadId.makeUnsafe("batch-child"),
              parentThreadId: null,
              sourceThreadId: ThreadId.makeUnsafe("compact-parent"),
              title: "Batch child full title",
            })}
            surface="activity"
            isActive={false}
            isSelected={false}
            status={null}
            branchControl={null}
            threadJumpLabel={null}
            actions={null}
            {...callbacks}
          />
        </li>
      </ul>,
    );

    await expect.element(screen.getByText("Batch child full title")).toBeVisible();
    expect(document.body.textContent).not.toContain("batch");
    expect(callbacks.renderHoverCard).toHaveBeenCalledWith("activity:batch-child");
  });

  it("keeps branch-control activation separate from navigation", async () => {
    const onToggle = vi.fn();
    const callbacks = renderRow();
    const screen = await render(
      <ul>
        <li>
          <SidebarCompactChildRow
            thread={makeThread()}
            surface="project"
            isActive={false}
            isSelected={false}
            status={null}
            branchControl={
              <SidebarThreadBranchControl
                threadId={ThreadId.makeUnsafe("compact-child")}
                title="Compact child"
                directChildCount={2}
                expanded={false}
                controlsId="compact-branch-compact-child"
                onToggle={onToggle}
              />
            }
            threadJumpLabel={null}
            actions={null}
            {...callbacks}
          />
        </li>
      </ul>,
    );

    await screen.getByRole("button", { name: "Expand 2 subagents for Compact child" }).click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(callbacks.onActivate).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "Compact child", exact: true }).click();
    expect(callbacks.onActivate).toHaveBeenCalledTimes(1);
  });

  it("renames from the row but never from sibling controls", async () => {
    const callbacks = renderRow();
    const screen = await render(
      <ul>
        <li>
          <SidebarCompactChildRow
            thread={makeThread()}
            surface="project"
            isActive={false}
            isSelected={false}
            status={null}
            branchControl={
              <button type="button" aria-label="Expand control">
                1
              </button>
            }
            threadJumpLabel={null}
            actions={
              <button type="button" aria-label="Row action">
                act
              </button>
            }
            {...callbacks}
          />
        </li>
      </ul>,
    );

    const nav = screen.getByRole("button", { name: "Compact child" }).element();
    nav.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(callbacks.onRename).toHaveBeenCalledTimes(1);

    screen
      .getByRole("button", { name: "Expand control" })
      .element()
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    screen
      .getByRole("button", { name: "Row action" })
      .element()
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(callbacks.onRename).toHaveBeenCalledTimes(1);
  });

  it("marks only the actual active thread with navigation semantics", async () => {
    const activeCallbacks = renderRow();
    const idleCallbacks = renderRow();
    const screen = await render(
      <ul>
        <li>
          <SidebarCompactChildRow
            thread={makeThread({ id: ThreadId.makeUnsafe("active-child") })}
            surface="project"
            isActive
            isSelected
            status={COMPLETED_STATUS}
            branchControl={null}
            threadJumpLabel={null}
            actions={null}
            {...activeCallbacks}
          />
        </li>
        <li>
          <SidebarCompactChildRow
            thread={makeThread({ id: ThreadId.makeUnsafe("idle-child"), title: "Idle child" })}
            surface="project"
            isActive={false}
            isSelected={false}
            status={COMPLETED_STATUS}
            branchControl={null}
            threadJumpLabel={null}
            actions={null}
            {...idleCallbacks}
          />
        </li>
      </ul>,
    );

    // Active: navigation semantics, unread completion suppressed (already seen).
    const activeNav = screen.getByRole("button", { name: "Compact child" });
    await expect.element(activeNav).toHaveAttribute("aria-current", "page");
    // Idle: no active semantics, unread completion glyph visible.
    const idleNav = screen.getByRole("button", { name: "Idle child" });
    await expect.element(idleNav).not.toHaveAttribute("aria-current");
    await expect.element(screen.getByLabelText("Unread completion")).toBeVisible();
  });

  it("meets desktop hit targets with ellipsis and visible focus", async () => {
    const callbacks = renderRow();
    const screen = await render(
      <div style={{ width: "240px" }}>
        <ul>
          <li>
            <SidebarCompactChildRow
              thread={makeThread({
                title:
                  "A very long compact child title that must truncate instead of overflowing the sidebar",
              })}
              surface="project"
              isActive={false}
              isSelected={false}
              status={null}
              branchControl={
                <SidebarThreadBranchControl
                  threadId={ThreadId.makeUnsafe("compact-child")}
                  title="A very long compact child title that must truncate instead of overflowing the sidebar"
                  directChildCount={3}
                  expanded={false}
                  controlsId="compact-branch-compact-child"
                  onToggle={() => {}}
                />
              }
              threadJumpLabel={null}
              actions={null}
              {...callbacks}
            />
          </li>
        </ul>
      </div>,
    );

    const nav = screen
      .getByRole("button", {
        name: "A very long compact child title that must truncate instead of overflowing the sidebar",
        exact: true,
      })
      .element();
    nav.focus();
    expect(document.activeElement).toBe(nav);
    const control = screen
      .getByRole("button", { name: /Expand 3 subagents for A very long compact/ })
      .element();
    expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    const container = screen.container;
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
  });
});
