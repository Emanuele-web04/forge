// FILE: SidebarThreadHierarchy.browser.tsx
// Purpose: Browser harness for the shared orchestrator → subagent/batch branch wrapper.
// Layer: Browser UI test (Vitest + Playwright, no Synara instance needed).

import "../index.css";

import { ThreadId } from "@synara/contracts";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState, type ReactNode } from "react";

import {
  hierarchyThreadLineOffsetPx,
  nestSidebarEntriesByDepth,
  SidebarThreadHierarchyBranch,
} from "./SidebarThreadBranch";
import {
  formatBranchCount,
  formatSubagentCounter,
  SidebarThreadBranchControl,
} from "./SidebarThreadBranchControl";
import { SidebarThreadBranchPaging } from "./SidebarThreadBranchPaging";

type HarnessEntry = {
  thread: { id: ThreadId; title: string };
  depth: number;
  directChildCount?: number | undefined;
};

/** Project-nested classic row: `pl-8` (32px) + half of the 12px provider icon. */
const CLASSIC_ROOT_LINE_OFFSET_PX = hierarchyThreadLineOffsetPx(32);
/** Every child row uses `px-2` (8px), so nested lines sit 14px in. */
const CLASSIC_CHILD_LINE_OFFSET_PX = hierarchyThreadLineOffsetPx(8);

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
 * Minimal classic-style row: 12px icon, flex-1 title, then the fixed slot.
 * `nested` mirrors a project-nested root (`pl-8`); children use `px-2`.
 */
function HarnessRow({
  testId,
  title,
  branchControl,
  nested = false,
}: {
  testId: string;
  title: string;
  branchControl: ReactNode;
  nested?: boolean;
}) {
  return (
    <span className={`flex h-7 min-w-0 items-center gap-1 pr-2 ${nested ? "pl-8" : "pl-2"}`}>
      <span aria-hidden="true" className="size-3 shrink-0 rounded-full bg-current" />
      <span data-testid={testId} className="min-w-0 flex-1 truncate">
        {title}
      </span>
      {branchControl}
    </span>
  );
}

/**
 * Shared harness mounting the same branch state in two presentations (standard
 * row vs pinned-style row) to prove view switching preserves expansion: both
 * lists read the same expanded set, so toggling in one is visible in the other.
 * The control renders inside the row layout through the render slot; the shell
 * itself adds no leading gutter, chips, or extra labels.
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
    makeEntry("implement", "Implement: gastos-app v1", 1, { directChildCount: 2 }),
    makeEntry("build-1", "build 1", 2),
    makeEntry("build-2", "build 2", 2),
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
          expanded={expanded.has(node.entry.thread.id)}
          onToggle={toggle}
          surface={variant}
          layout="classic"
          threadLineOffsetPx={CLASSIC_ROOT_LINE_OFFSET_PX}
          renderRow={({ branchControl }) => (
            <HarnessRow
              testId={`${variant}-row-${node.entry.thread.id}`}
              title={node.entry.thread.title}
              branchControl={branchControl}
              nested
            />
          )}
        >
          {node.children.map((child) => (
            <SidebarThreadHierarchyBranch
              key={`${variant}-${child.entry.thread.id}`}
              threadId={child.entry.thread.id}
              title={child.entry.thread.title}
              depth={child.entry.depth}
              directChildCount={child.entry.directChildCount ?? 0}
              expanded={expanded.has(child.entry.thread.id)}
              onToggle={toggle}
              surface={variant}
              layout="classic"
              threadLineOffsetPx={CLASSIC_CHILD_LINE_OFFSET_PX}
              renderRow={({ branchControl }) => (
                <HarnessRow
                  testId={`${variant}-row-${child.entry.thread.id}`}
                  title={child.entry.thread.title}
                  branchControl={branchControl}
                />
              )}
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
    vi.restoreAllMocks();
  });

  it("shares helpers: thread-line offset from row padding and numeric counters", () => {
    expect(hierarchyThreadLineOffsetPx(32)).toBe(38);
    expect(hierarchyThreadLineOffsetPx(8)).toBe(14);
    expect(hierarchyThreadLineOffsetPx(10)).toBe(16);
    expect(hierarchyThreadLineOffsetPx(Number.NaN)).toBe(6);
    expect(formatSubagentCounter(1)).toBe("1 subagent");
    expect(formatSubagentCounter(4)).toBe("4 subagents");
    expect(formatBranchCount(1)).toBe("1");
    expect(formatBranchCount(20)).toBe("20");
    expect(formatBranchCount(150)).toBe("99+");
  });

  it("reserves the same 44px slot on rows with and without children", async () => {
    const screen = await render(
      <div style={{ width: "280px" }}>
        <ul>
          <SidebarThreadHierarchyBranch
            threadId={ThreadId.makeUnsafe("plain")}
            title="Plain root with a long title that will need to truncate"
            depth={0}
            directChildCount={0}
            expanded={false}
            onToggle={() => {}}
            layout="classic"
            threadLineOffsetPx={CLASSIC_ROOT_LINE_OFFSET_PX}
            renderRow={({ branchControl }) => (
              <HarnessRow
                testId="plain-title"
                title="Plain root with a long title that will need to truncate"
                branchControl={branchControl}
              />
            )}
          />
          <SidebarThreadHierarchyBranch
            threadId={ThreadId.makeUnsafe("parent")}
            title="Parent root with a long title that will need to truncate"
            depth={0}
            directChildCount={2}
            expanded={false}
            onToggle={() => {}}
            layout="classic"
            threadLineOffsetPx={CLASSIC_ROOT_LINE_OFFSET_PX}
            renderRow={({ branchControl }) => (
              <HarnessRow
                testId="parent-title"
                title="Parent root with a long title that will need to truncate"
                branchControl={branchControl}
              />
            )}
          >
            <li>child</li>
          </SidebarThreadHierarchyBranch>
        </ul>
      </div>,
    );
    const slots = document.querySelectorAll<HTMLElement>("[data-thread-branch-slot]");
    expect(slots).toHaveLength(2);
    const [emptySlot, controlSlot] = Array.from(slots).map((slot) => slot.getBoundingClientRect());
    expect(emptySlot!.width).toBeCloseTo(44, 0);
    expect(controlSlot!.width).toBeCloseTo(44, 0);
    expect(Math.abs(emptySlot!.left - controlSlot!.left)).toBeLessThanOrEqual(1);
    // Titles truncate at the same boundary whether or not the row has children.
    const plain = screen.getByTestId("plain-title").element().getBoundingClientRect();
    const parent = screen.getByTestId("parent-title").element().getBoundingClientRect();
    expect(Math.abs(plain.left - parent.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(plain.right - parent.right)).toBeLessThanOrEqual(1);
    // The whole slot is the toggle's hit area, not just the chevron.
    const toggle = screen.getByRole("button", { name: /Expand 2 subagents/ }).element();
    expect(toggle.getBoundingClientRect().width).toBeCloseTo(44, 0);
    expect(toggle.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
  });

  it("draws one vertical thread line per open branch under the parent icon", async () => {
    await render(<DualPresentationHarness />);
    const list = document.querySelector<HTMLUListElement>(
      '[aria-label="standard"] [data-thread-branch-children]',
    );
    expect(list).not.toBeNull();
    const style = window.getComputedStyle(list!);
    expect(style.marginLeft).toBe(`${CLASSIC_ROOT_LINE_OFFSET_PX}px`);
    expect(style.borderLeftWidth).toBe("1px");
    expect(style.borderLeftStyle).toBe("solid");
    expect(style.paddingLeft).toBe("12px");
    // The line runs under the centre of the parent row's 12px icon.
    const parentRow = document.querySelector<HTMLElement>(
      '[data-testid="standard-row-html-gastos"]',
    )!;
    const icon = parentRow.previousElementSibling as HTMLElement;
    const iconRect = icon.getBoundingClientRect();
    const iconCenter = iconRect.left + iconRect.width / 2;
    const lineX = list!.getBoundingClientRect().left + 0.5;
    expect(Math.abs(lineX - iconCenter)).toBeLessThanOrEqual(1);
    // No per-row connectors remain anywhere in the tree.
    expect(document.querySelectorAll('[class*="bg-border"]')).toHaveLength(0);
  });

  it("toggles with mouse without navigating and keeps both presentations in sync", async () => {
    const screen = await render(<DualPresentationHarness />);

    // Both presentations render the open root with the same numeric counter.
    await expect.element(screen.getByText("HTML gastos").first()).toBeVisible();
    const counters = screen.getByText("1");
    await expect.element(counters.first()).toBeVisible();

    // No full-label gutter and no batch chip anywhere.
    expect(document.body.textContent).not.toContain("1 subagent");
    expect(document.body.textContent).not.toContain("batch");

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

  it("renders the same compact control for one and twenty children", async () => {
    const screen = await render(
      <ul>
        <SidebarThreadHierarchyBranch
          threadId={ThreadId.makeUnsafe("one")}
          title="One child"
          depth={0}
          directChildCount={1}
          expanded={false}
          onToggle={() => {}}
          layout="classic"
          threadLineOffsetPx={CLASSIC_ROOT_LINE_OFFSET_PX}
          renderRow={({ branchControl }) => (
            <HarnessRow testId="one" title="One child" branchControl={branchControl} />
          )}
        />
        <SidebarThreadHierarchyBranch
          threadId={ThreadId.makeUnsafe("twenty")}
          title="Twenty children"
          depth={0}
          directChildCount={20}
          expanded={false}
          onToggle={() => {}}
          layout="classic"
          threadLineOffsetPx={CLASSIC_ROOT_LINE_OFFSET_PX}
          renderRow={({ branchControl }) => (
            <HarnessRow testId="twenty" title="Twenty children" branchControl={branchControl} />
          )}
        />
      </ul>,
    );
    const one = screen.getByRole("button", { name: "Expand 1 subagent for One child" });
    const twenty = screen.getByRole("button", { name: "Expand 20 subagents for Twenty children" });
    await expect.element(one).toBeVisible();
    await expect.element(twenty).toBeVisible();
    expect(one.element().tagName).toBe("BUTTON");
    expect(twenty.element().tagName).toBe("BUTTON");
    // Native button semantics with identical fixed sizing.
    expect(one.element().getAttribute("type")).toBe("button");
    await expect.element(screen.getByText("1")).toBeVisible();
    await expect.element(screen.getByText("20")).toBeVisible();
    const oneRect = one.element().getBoundingClientRect();
    const twentyRect = twenty.element().getBoundingClientRect();
    expect(Math.abs(oneRect.height - twentyRect.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(oneRect.width - twentyRect.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(oneRect.right - twentyRect.right)).toBeLessThanOrEqual(1);
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
          layout="classic"
          threadLineOffsetPx={CLASSIC_ROOT_LINE_OFFSET_PX}
          renderRow={({ branchControl }) => <span>HTML gastos {branchControl}</span>}
        >
          <li>child</li>
        </SidebarThreadHierarchyBranch>
      </ul>,
    );

    const toggle = screen.getByRole("button", { name: /Expand 1 subagent for HTML gastos/ });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(toggle)
      .toHaveAttribute("aria-controls", "sidebar-branch-sidebar-html-gastos");

    await toggle.click();
    expect(onToggle).toHaveBeenCalledTimes(1);

    // Keyboard: focus + Enter activates the toggle without side effects.
    screen
      .getByRole("button", { name: /Expand 1 subagent for HTML gastos/ })
      .element()
      .focus();
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
            layout="classic"
            threadLineOffsetPx={CLASSIC_ROOT_LINE_OFFSET_PX}
            renderRow={({ branchControl }) => <span>HTML gastos {branchControl}</span>}
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

  it("survives rapid close/reopen without stale rows or focus loss", async () => {
    function RapidHarness() {
      const [open, setOpen] = useState(true);
      return (
        <ul>
          <SidebarThreadHierarchyBranch
            threadId={ThreadId.makeUnsafe("html-gastos")}
            title="HTML gastos"
            depth={0}
            directChildCount={1}
            expanded={open}
            onToggle={() => setOpen((current) => !current)}
            layout="classic"
            threadLineOffsetPx={CLASSIC_ROOT_LINE_OFFSET_PX}
            renderRow={({ branchControl }) => <span>HTML gastos {branchControl}</span>}
          >
            <li>
              <button type="button" data-testid="rapid-child">
                build 1
              </button>
            </li>
          </SidebarThreadHierarchyBranch>
        </ul>
      );
    }
    const screen = await render(<RapidHarness />);
    const toggle = screen.getByRole("button", { name: /subagent for HTML gastos/ });
    // Close, reopen, close, reopen faster than the 220ms exit animation.
    await toggle.click();
    await toggle.click();
    await toggle.click();
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(toggle).toHaveFocus();
    // Past the retention window the live subtree is still the only one mounted.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(document.querySelectorAll('[data-testid="rapid-child"]')).toHaveLength(1);
    await expect.element(screen.getByTestId("rapid-child")).toBeVisible();
    // A final close retains the subtree for the animation, then releases it.
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(document.querySelectorAll('[data-testid="rapid-child"]')).toHaveLength(0);
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
          layout="classic"
          threadLineOffsetPx={CLASSIC_CHILD_LINE_OFFSET_PX}
          renderRow={({ branchControl }) => <span>Implement: gastos-app v1 {branchControl}</span>}
          childPaging={
            <SidebarThreadBranchPaging
              hiddenCount={20}
              canShowLess
              onShowMore={onMore}
              onShowLess={onLess}
            />
          }
        >
          <li>
            <span>build 1</span>
          </li>
        </SidebarThreadHierarchyBranch>
      </ul>,
    );

    await expect.element(screen.getByText("25")).toBeVisible();
    // Paging renders inside a list item of the branch list, never as a bare
    // button child of the list.
    const pagingItem = screen
      .getByRole("button", { name: "Show 20 more" })
      .element()
      .closest("ul > li");
    expect(pagingItem).not.toBeNull();
    await screen.getByRole("button", { name: "Show 20 more" }).click();
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
            layout="classic"
            threadLineOffsetPx={CLASSIC_CHILD_LINE_OFFSET_PX}
            renderRow={({ branchControl }) => (
              <HarnessRow
                testId="long"
                title="HTML gastos with a very long title that must truncate instead of overflowing the sidebar"
                branchControl={branchControl}
              />
            )}
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

  it("exposes the shared control with hidden-status summaries", async () => {
    const screen = await render(
      <ul>
        <SidebarThreadBranchControl
          threadId={ThreadId.makeUnsafe("html-gastos")}
          title="HTML gastos"
          directChildCount={150}
          expanded={false}
          controlsId="sidebar-branch-sidebar-html-gastos"
          hiddenSummary={{
            hiddenCount: 145,
            attentionCount: 2,
            runningCount: 1,
            unreadCount: 0,
            containsActiveThread: true,
          }}
          onToggle={() => {}}
        />
      </ul>,
    );
    // Visible count caps at 99+ while the accessible label keeps the exact total.
    await expect.element(screen.getByText("99+").first()).toBeVisible();
    const toggle = screen.getByRole("button", {
      name: "Expand 150 subagents for HTML gastos, 2 hidden need attention, 1 hidden running, contains the current conversation",
    });
    await expect.element(toggle).toBeVisible();
    // The attention aggregate is the one case allowed to widen the slot; it
    // extends leftwards so the chevron + count stay put.
    expect(toggle.element().getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  });
});
