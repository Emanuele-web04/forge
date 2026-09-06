// FILE: SidebarThreadHierarchy.browser.tsx
// Purpose: Browser harness for the shared orchestrator → subagent/batch branch wrapper.
// Layer: Browser UI test (Vitest + Playwright, no Synara instance needed).

import "../index.css";

import { ThreadId } from "@synara/contracts";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import {
  formatSubagentCounter,
  hierarchyIndentPx,
  nestSidebarEntriesByDepth,
  SidebarThreadHierarchyBranch,
} from "./SidebarThreadBranch";

type HarnessEntry = {
  thread: { id: ThreadId; title: string };
  depth: number;
  directChildCount?: number | undefined;
  edgeKind?: "subagent" | "batch" | undefined;
};

function makeEntry(
  id: string,
  title: string,
  depth: number,
  extra?: Partial<HarnessEntry>,
): HarnessEntry {
  return {
    thread: { id: ThreadId.makeUnsafe(id), title },
    depth,
    ...extra,
  };
}

/**
 * Shared harness mounting the same branch state in two presentations (standard
 * row vs pinned-style row) to prove view switching preserves expansion: both
 * lists read the same expanded set, so toggling in one is visible in the other.
 */
function DualPresentationHarness() {
  const [expanded, setExpanded] = useState<ReadonlySet<ThreadId>>(
    () => new Set([ThreadId.makeUnsafe("html-gastos")]),
  );
  const toggle = (threadId: ThreadId) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  };
  const entries: HarnessEntry[] = [
    makeEntry("html-gastos", "HTML gastos", 0, { directChildCount: 1 }),
    makeEntry("implement", "Implement: gastos-app v1", 1, {
      directChildCount: 2,
      edgeKind: "batch",
    }),
    makeEntry("build-1", "build 1", 2, { edgeKind: "subagent" }),
    makeEntry("build-2", "build 2", 2, { edgeKind: "subagent" }),
  ];
  const renderList = (variant: string) => (
    <ul aria-label={variant}>
      {nestSidebarEntriesByDepth(entries).map((node) => (
        <SidebarThreadHierarchyBranch
          key={`${variant}-${node.entry.thread.id}`}
          threadId={node.entry.thread.id}
          title={node.entry.thread.title}
          depth={node.entry.depth}
          directChildCount={node.entry.directChildCount ?? 0}
          edgeKind={node.entry.edgeKind}
          expanded={expanded.has(node.entry.thread.id)}
          onToggle={toggle}
          surface={variant}
          row={<span data-testid={`${variant}-row-${node.entry.thread.id}`}>{node.entry.thread.title}</span>}
        >
          {node.children.map((child) => (
            <SidebarThreadHierarchyBranch
              key={`${variant}-${child.entry.thread.id}`}
              threadId={child.entry.thread.id}
              title={child.entry.thread.title}
              depth={child.entry.depth}
              directChildCount={child.entry.directChildCount ?? 0}
              edgeKind={child.entry.edgeKind}
              expanded={expanded.has(child.entry.thread.id)}
              onToggle={toggle}
              surface={variant}
              row={
                <span data-testid={`${variant}-row-${child.entry.thread.id}`}>
                  {child.entry.thread.title}
                </span>
              }
            >
              {child.children.map((grandchild) => (
                <li key={`${variant}-${grandchild.entry.thread.id}`}>
                  <span data-testid={`${variant}-row-${grandchild.entry.thread.id}`}>
                    {grandchild.entry.thread.title}
                  </span>
                </li>
              ))}
            </SidebarThreadHierarchyBranch>
          ))}
        </SidebarThreadHierarchyBranch>
      ))}
    </ul>
  );

  return (
    <div>
      {renderList("standard")}
      {renderList("pinned")}
    </div>
  );
}

describe("SidebarThreadHierarchy", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shares helpers: indent 12px/level capped at 48px and direct-only counters", () => {
    expect(hierarchyIndentPx(0)).toBe(0);
    expect(hierarchyIndentPx(1)).toBe(12);
    expect(hierarchyIndentPx(4)).toBe(48);
    expect(hierarchyIndentPx(9)).toBe(48);
    expect(formatSubagentCounter(1)).toBe("1 subagent");
    expect(formatSubagentCounter(4)).toBe("4 subagents");
  });

  it("toggles with mouse without navigating and keeps both presentations in sync", async () => {
    const screen = await render(<DualPresentationHarness />);

    // Both presentations render the open root with the same counter.
    await expect.element(screen.getByText("HTML gastos").first()).toBeVisible();
    const counters = screen.getByText("1 subagent");
    await expect.element(counters.first()).toBeVisible();

    // Batch edge shows the subtle batch chip, subagent rows do not duplicate it.
    await expect.element(screen.getByText("batch").first()).toBeVisible();

    // Collapse from the standard presentation: the toggle flips in both
    // presentations (shared expansion state) and the child region hides.
    // (Closed branches keep DOM mounted for the 220ms disclosure animation
    // with aria-hidden + inert, so assert semantics instead of visibility.)
    await counters.first().click();
    const collapsedToggles = screen.getByRole("button", {
      name: /Expand 1 subagent for HTML gastos/,
    });
    await expect.element(collapsedToggles.first()).toHaveAttribute("aria-expanded", "false");
    await expect.element(collapsedToggles.nth(1)).toHaveAttribute("aria-expanded", "false");
    // Scope to the branch DOM: the disclosure shell hides its subtree.
    const branchItem = collapsedToggles.first().element().closest("li");
    const hiddenShell = branchItem?.querySelector('[aria-hidden="true"]') ?? null;
    expect(hiddenShell?.getAttribute("aria-hidden")).toBe("true");
  });

  it("toggles with Enter/Space and exposes aria-expanded/controls", async () => {
    const onToggle = vi.fn();
    const screen = await render(
      <ul>
        <SidebarThreadHierarchyBranch
          threadId={ThreadId.makeUnsafe("html-gastos")}
          title="HTML gastos"
          depth={0}
          directChildCount={1}
          expanded={false}
          onToggle={onToggle}
          row={<span>HTML gastos</span>}
        >
          <li>child</li>
        </SidebarThreadHierarchyBranch>
      </ul>,
    );

    const toggle = screen.getByRole("button", { name: /Expand 1 subagent for HTML gastos/ });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.element(toggle).toHaveAttribute("aria-controls", "sidebar-branch-sidebar-html-gastos");

    await toggle.click();
    expect(onToggle).toHaveBeenCalledTimes(1);

    // Keyboard: focus + Enter activates the toggle without side effects.
    screen.getByRole("button", { name: /Expand 1 subagent for HTML gastos/ }).element().focus();
    await userEvent.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the toggle when collapsing a branch that contains focus", async () => {
    function FocusHarness() {
      const [open, setOpen] = useState(true);
      return (
        <ul>
          <SidebarThreadHierarchyBranch
            threadId={ThreadId.makeUnsafe("html-gastos")}
            title="HTML gastos"
            depth={0}
            directChildCount={1}
            expanded={open}
            onToggle={() => setOpen(false)}
            row={<span>HTML gastos</span>}
          >
            <li>
              <button type="button" data-testid="inner-child">
                build 1
              </button>
            </li>
          </SidebarThreadHierarchyBranch>
        </ul>
      );
    }
    const screen = await render(<FocusHarness />);
    screen.getByTestId("inner-child").element().focus();
    await screen.getByRole("button", { name: /Collapse 1 subagent for HTML gastos/ }).click();
    await expect
      .element(screen.getByRole("button", { name: /Expand 1 subagent for HTML gastos/ }))
      .toHaveFocus();
  });

  it("renders grandchildren under their own parent and pages siblings on demand", async () => {
    const onMore = vi.fn();
    const onLess = vi.fn();
    const screen = await render(
      <ul>
        <SidebarThreadHierarchyBranch
          threadId={ThreadId.makeUnsafe("implement")}
          title="Implement: gastos-app v1"
          depth={1}
          directChildCount={25}
          expanded
          onToggle={() => {}}
          row={<span>Implement: gastos-app v1</span>}
          childPaging={
            <div>
              <button type="button" onClick={onMore}>
                Show 5 more
              </button>
              <button type="button" onClick={onLess}>
                Show less
              </button>
            </div>
          }
        >
          <li>
            <span>build 1</span>
          </li>
        </SidebarThreadHierarchyBranch>
      </ul>,
    );

    await expect.element(screen.getByText("25 subagents")).toBeVisible();
    await screen.getByRole("button", { name: "Show 5 more" }).click();
    expect(onMore).toHaveBeenCalledTimes(1);
    await screen.getByRole("button", { name: "Show less" }).click();
    expect(onLess).toHaveBeenCalledTimes(1);
  });

  it("keeps rows truncated without horizontal overflow at narrow widths", async () => {
    const screen = await render(
      <div style={{ width: "240px" }}>
        <ul>
          <SidebarThreadHierarchyBranch
            threadId={ThreadId.makeUnsafe("html-gastos")}
            title="HTML gastos with a very long title that must truncate instead of overflowing the sidebar"
            depth={2}
            directChildCount={1}
            expanded
            onToggle={() => {}}
            row={
              <span className="block truncate">
                HTML gastos with a very long title that must truncate instead of overflowing the
                sidebar
              </span>
            }
          >
            <li>
              <span>child</span>
            </li>
          </SidebarThreadHierarchyBranch>
        </ul>
      </div>,
    );
    const container = screen.container;
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
  });
});
