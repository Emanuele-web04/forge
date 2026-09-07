// FILE: SidebarActivityView.browser.tsx
// Purpose: Browser regressions for Activity paging, stateful actions, scope fallback, and live PR data.
// Layer: Sidebar Activity UI test

import "../index.css";

import { ProjectId, ThreadId, type OrchestrationThreadPullRequest } from "@synara/contracts";
import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { Project, SidebarThreadSummary } from "../types";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { SidebarActivityView } from "./SidebarActivityView";
import { buildThreadHierarchyIndex } from "./sidebarThreadHierarchy";
import { buildHierarchyRevealPlan } from "./sidebarThreadHierarchyPresentation";

const PROJECT_A = ProjectId.makeUnsafe("activity-project-a");
const PROJECT_B = ProjectId.makeUnsafe("activity-project-b");

function makeProject(id: ProjectId, name: string): Project {
  return {
    id,
    kind: "project",
    name,
    remoteName: name,
    folderName: name,
    localName: null,
    cwd: `/tmp/${id}`,
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
    sources: [],
    primarySourceId: null,
  };
}

function makeThread(
  index: number,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  const completedAt = `2026-08-02T10:${String(index % 60).padStart(2, "0")}:00.000Z`;
  return {
    id: ThreadId.makeUnsafe(`activity-thread-${index}`),
    projectId: PROJECT_A,
    title: `Activity thread ${index}`,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-08-02T09:00:00.000Z",
    updatedAt: completedAt,
    latestTurn: {
      turnId: `activity-turn-${index}`,
      state: "completed",
      requestedAt: completedAt,
      startedAt: completedAt,
      completedAt,
      assistantMessageId: null,
    } as SidebarThreadSummary["latestTurn"],
    lastVisitedAt: "2026-08-02T12:00:00.000Z",
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

function renderActivity(input: {
  threads: readonly SidebarThreadSummary[];
  projects?: readonly Project[] | undefined;
  activeThreadId?: ThreadId | null | undefined;
  pinnedThreadIdSet?: ReadonlySet<ThreadId> | undefined;
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>;
  prByThreadId?: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest | null>;
  threadJumpLabelByThreadId?: ReadonlyMap<ThreadId, string>;
  onVisibleThreadIdsChange?: ((threadIds: readonly ThreadId[]) => void) | undefined;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  onSetThreadSettled?: (threadId: ThreadId, settled: boolean) => void;
  onMarkThreadRead?: (threadId: ThreadId, completedAt?: string) => void;
  onRenameThread?: ((threadId: ThreadId) => void) | undefined;
  onThreadRenamePointerUp?: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onThreadContextMenu?: (threadId: ThreadId, position: { x: number; y: number }) => void;
  onProjectContextMenu?: (projectId: ProjectId, position: { x: number; y: number }) => void;
  resolveThreadStatus?: ((thread: SidebarThreadSummary) => ThreadStatusPill | null) | undefined;
  expandedThreadIds?: ReadonlySet<ThreadId>;
  collapsedThreadIds?: ReadonlySet<ThreadId>;
  childVisibleCountByParentId?: ReadonlyMap<ThreadId, number>;
  onToggleBranch?: (threadId: ThreadId, isCurrentlyOpen: boolean) => void;
  onShowMoreChildren?: (parentId: ThreadId, totalChildCount: number) => void;
  onShowLessChildren?: (parentId: ThreadId) => void;
}) {
  const projects = input.projects ?? [makeProject(PROJECT_A, "Project A")];
  return (
    <SidebarActivityView
      threads={input.threads}
      projectById={new Map(projects.map((project) => [project.id, project]))}
      activeThreadId={input.activeThreadId ?? null}
      pinnedThreadIdSet={input.pinnedThreadIdSet ?? new Set()}
      settledOverrideByThreadId={input.settledOverrideByThreadId ?? new Map()}
      threadsHydrated
      prByThreadId={input.prByThreadId ?? new Map()}
      threadJumpLabelByThreadId={input.threadJumpLabelByThreadId ?? new Map()}
      onVisibleThreadIdsChange={input.onVisibleThreadIdsChange ?? (() => {})}
      resolveThreadStatus={input.resolveThreadStatus ?? (() => null)}
      onOpenThread={input.onOpenThread ?? (() => {})}
      onSetThreadSettled={input.onSetThreadSettled ?? (() => {})}
      onToggleThreadPinned={() => {}}
      onArchiveThread={() => {}}
      onMarkThreadRead={input.onMarkThreadRead ?? (() => {})}
      onRenameThread={input.onRenameThread ?? (() => {})}
      onThreadRenamePointerUp={input.onThreadRenamePointerUp ?? (() => {})}
      onThreadContextMenu={input.onThreadContextMenu ?? (() => {})}
      onProjectContextMenu={input.onProjectContextMenu ?? (() => {})}
      renderThreadHoverCard={() => null}
      onCreateChat={() => {}}
      onAddProject={() => {}}
      expandedThreadIds={input.expandedThreadIds ?? new Set()}
      collapsedThreadIds={input.collapsedThreadIds ?? new Set()}
      childVisibleCountByParentId={input.childVisibleCountByParentId ?? new Map()}
      onToggleBranch={input.onToggleBranch ?? (() => {})}
      onShowMoreChildren={input.onShowMoreChildren ?? (() => {})}
      onShowLessChildren={input.onShowLessChildren ?? (() => {})}
    />
  );
}

describe("SidebarActivityView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows an assigned thread jump shortcut in its activity row", async () => {
    const thread = makeThread(0);
    const mounted = await render(
      renderActivity({
        threads: [thread],
        threadJumpLabelByThreadId: new Map([[thread.id, "⌘1"]]),
      }),
    );

    expect(page.getByText("⌘")).toBeVisible();
    expect(page.getByText("1", { exact: true })).toBeVisible();
    await mounted.unmount();
  });

  it("pages project groups, reports only mounted rows, and prefers live PR state", async () => {
    const threads = Array.from({ length: 45 }, (_, index) => makeThread(index));
    threads[44] = makeThread(44, {
      lastKnownPr: {
        number: 42,
        title: "Persisted open PR",
        url: "https://github.com/acme/synara/pull/42",
        baseBranch: "main",
        headBranch: "feature/activity",
        state: "open",
      },
    });
    const livePr: OrchestrationThreadPullRequest = {
      number: 42,
      title: "Live merged PR",
      url: "https://github.com/acme/synara/pull/42",
      baseBranch: "main",
      headBranch: "feature/activity",
      state: "merged",
    };
    const onVisibleThreadIdsChange = vi.fn();
    const mounted = await render(
      renderActivity({
        threads,
        prByThreadId: new Map([[threads[44].id, livePr]]),
        onVisibleThreadIdsChange,
      }),
    );

    await page.getByRole("button", { name: "Activity options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Project" }).click();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-testid^='activity-thread-']")).toHaveLength(20);
      expect(onVisibleThreadIdsChange.mock.lastCall?.[0]).toHaveLength(20);
    });
    expect(document.querySelector('[title="#42 PR merged: Live merged PR"]')).not.toBeNull();

    await page.getByRole("button", { name: /Show \d+ more \(\d+\)/ }).click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-testid^='activity-thread-']")).toHaveLength(40);
      expect(onVisibleThreadIdsChange.mock.lastCall?.[0]).toHaveLength(40);
    });
    await mounted.unmount();
  });

  it("renames on row double-click and opens the row/project menus on right-click", async () => {
    const thread = makeThread(0);
    const onRenameThread = vi.fn();
    const onThreadContextMenu = vi.fn();
    const onProjectContextMenu = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [thread],
        onRenameThread,
        onThreadContextMenu,
        onProjectContextMenu,
      }),
    );

    await page.getByRole("button", { name: "Activity options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Project" }).click();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    const row = page.getByTestId(`activity-thread-${thread.id}`).element();
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(onRenameThread).toHaveBeenCalledWith(thread.id);

    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 }),
    );
    expect(onThreadContextMenu).toHaveBeenCalledWith(thread.id, { x: 12, y: 34 });
    // The row menu must not also bubble into the project block it sits under.
    expect(onProjectContextMenu).not.toHaveBeenCalled();

    const projectBlockLabel = document.querySelector('[data-slot="activity-section-label"]');
    expect(projectBlockLabel).not.toBeNull();
    projectBlockLabel?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }),
    );
    expect(onProjectContextMenu).toHaveBeenCalledWith(PROJECT_A, { x: 5, y: 6 });
    await mounted.unmount();
  });

  it("does not forward touch action taps to the row rename gesture", async () => {
    const thread = makeThread(0);
    const onThreadRenamePointerUp = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [thread],
        onThreadRenamePointerUp,
      }),
    );

    await page.getByRole("button", { name: "Activity options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Project" }).click();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    const pinButton = page.getByRole("button", { name: "Pin thread" }).element();
    pinButton.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch" }),
    );
    pinButton.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch" }),
    );
    expect(onThreadRenamePointerUp).not.toHaveBeenCalled();

    page
      .getByTestId(`activity-thread-${thread.id}`)
      .element()
      .dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
        }),
      );
    expect(onThreadRenamePointerUp).toHaveBeenCalledWith(expect.anything(), thread.id);
    await mounted.unmount();
  });

  it("keeps settled pins undoable and marks unseen work read before settling it", async () => {
    const pinned = makeThread(100, { settledAt: "2026-08-02T12:30:00.000Z" });
    const unseen = makeThread(101, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const resumedSettled = makeThread(102, {
      settledAt: "2026-08-02T09:30:00.000Z",
      lastVisitedAt: "2026-08-02T09:00:00.000Z",
    });
    const onSetThreadSettled = vi.fn();
    const onMarkThreadRead = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [pinned, unseen, resumedSettled],
        pinnedThreadIdSet: new Set([pinned.id]),
        onSetThreadSettled,
        onMarkThreadRead,
        resolveThreadStatus: (thread) =>
          thread.id === unseen.id
            ? {
                label: "Completed",
                colorClass: "text-emerald-600",
                dotClass: "bg-emerald-500",
                pulse: false,
              }
            : null,
      }),
    );

    const unseenRowButton = page.getByTestId(`activity-thread-${unseen.id}`).element();
    const unseenWrapper = unseenRowButton.parentElement!;
    const completedDot = unseenWrapper.querySelector('[aria-label="Unread completion"]');
    expect(completedDot).not.toBeNull();
    // The status glyph lives inline in the row's second line (next to PR/branch),
    // as a sibling of the title button inside the same row wrapper — never nested
    // in the title button and never under the hover-action overlay.
    expect(unseenWrapper.contains(completedDot ?? null)).toBe(true);
    expect(unseenRowButton.contains(completedDot ?? null)).toBe(false);
    const completedStatusLeft = completedDot?.getBoundingClientRect().left;

    const pinnedRow = page.getByTestId(`activity-thread-${pinned.id}`).element();
    pinnedRow.focus();
    pinnedRow.parentElement?.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.click();
    expect(onSetThreadSettled).toHaveBeenCalledWith(pinned.id, false);

    const resumedRow = page.getByTestId(`activity-thread-${resumedSettled.id}`).element();
    expect(resumedRow.parentElement?.querySelector('button[aria-label="Undo"]')).not.toBeNull();

    page.getByTestId(`activity-thread-${unseen.id}`).element().focus();
    await vi.waitFor(() => {
      // The inline status stays visible while hover actions appear (it no longer
      // fades out) and the row must not shift around it.
      expect(getComputedStyle(completedDot!).opacity).not.toBe("0");
    });
    expect(completedDot?.getBoundingClientRect().left).toBe(completedStatusLeft);
    await page.getByRole("button", { name: "Done" }).click();
    expect(onMarkThreadRead).toHaveBeenCalledWith(
      unseen.id,
      unseen.latestTurn?.completedAt ?? undefined,
    );
    expect(onSetThreadSettled).toHaveBeenCalledWith(unseen.id, true);
    expect(onMarkThreadRead.mock.invocationCallOrder[0]).toBeLessThan(
      onSetThreadSettled.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    await mounted.unmount();
  });

  it("opens settled rows through the shared thread activation path", async () => {
    const settled = makeThread(103, {
      branch: "feature/finished",
      settledAt: "2026-08-02T12:30:00.000Z",
    });
    const onOpenThread = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [settled],
        pinnedThreadIdSet: new Set([settled.id]),
        onOpenThread,
      }),
    );

    await page.getByTestId(`activity-thread-${settled.id}`).click();
    expect(onOpenThread).toHaveBeenCalledOnce();
    expect(onOpenThread).toHaveBeenCalledWith(settled.id);
    await mounted.unmount();
  });

  it("clears a project scope after that project disappears instead of reviving it later", async () => {
    const projectA = makeProject(PROJECT_A, "Project A");
    const projectB = makeProject(PROJECT_B, "Project B");
    const threadA = makeThread(200);
    const threadB = makeThread(201, { projectId: PROJECT_B });
    const mounted = await render(
      renderActivity({ threads: [threadA, threadB], projects: [projectA, projectB] }),
    );

    await page.getByRole("button", { name: "Filter activity by project" }).click();
    await page.getByRole("menuitemradio", { name: /Project A/u }).click();
    await expect
      .element(page.getByRole("button", { name: "Filter activity by project" }))
      .toHaveTextContent("Project A");

    await mounted.rerender(renderActivity({ threads: [threadB], projects: [projectB] }));
    await expect
      .element(page.getByRole("button", { name: "Filter activity by project" }))
      .toHaveTextContent("All activity");

    await mounted.rerender(
      renderActivity({ threads: [threadA, threadB], projects: [projectA, projectB] }),
    );
    await expect
      .element(page.getByRole("button", { name: "Filter activity by project" }))
      .toHaveTextContent("All activity");
    await mounted.unmount();
  });

  it("shows unread pins once in open Pinned and suppresses a stale dot on the open thread", async () => {
    const pinnedUnread = makeThread(300, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const openThread = makeThread(301, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const completedStatus: ThreadStatusPill = {
      label: "Completed",
      colorClass: "text-emerald-600",
      dotClass: "bg-emerald-500",
      pulse: false,
    };
    const mounted = await render(
      renderActivity({
        threads: [pinnedUnread, openThread],
        activeThreadId: openThread.id,
        pinnedThreadIdSet: new Set([pinnedUnread.id]),
        resolveThreadStatus: () => completedStatus,
      }),
    );

    await expect
      .element(page.getByRole("button", { name: "Pinned", exact: true }))
      .toHaveAttribute("aria-expanded", "true");
    expect(
      document.querySelectorAll(`[data-testid="activity-thread-${pinnedUnread.id}"]`),
    ).toHaveLength(1);
    expect(
      page
        .getByTestId(`activity-thread-${pinnedUnread.id}`)
        .element()
        .parentElement?.querySelector('[aria-label="Unread completion"]'),
    ).not.toBeNull();
    expect(
      page
        .getByTestId(`activity-thread-${openThread.id}`)
        .element()
        .parentElement?.querySelector('[aria-label="Unread completion"]'),
    ).toBeNull();
    await mounted.unmount();
  });

  it("gives pulsing status glyphs an accessible name", async () => {
    const running = makeThread(400, { hasLiveTailWork: true });
    const mounted = await render(
      renderActivity({
        threads: [running],
        resolveThreadStatus: () => ({
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        }),
      }),
    );

    expect(
      page
        .getByTestId(`activity-thread-${running.id}`)
        .element()
        .parentElement?.querySelector('[role="img"][aria-label="Working"]'),
    ).not.toBeNull();
    await mounted.unmount();
  });
});

describe("SidebarActivityView compact hierarchy", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function HierarchyHarness({
    threads,
    projects,
    activeThreadId = null,
    pinnedThreadIdSet,
    resolveThreadStatus,
    onOpenThread,
    onRenameThread,
    onToggleBranch,
    onVisibleThreadIdsChange,
  }: {
    threads: readonly SidebarThreadSummary[];
    projects?: readonly Project[];
    activeThreadId?: ThreadId | null;
    pinnedThreadIdSet?: ReadonlySet<ThreadId>;
    resolveThreadStatus?: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
    onOpenThread?: (threadId: ThreadId) => void;
    onRenameThread?: (threadId: ThreadId) => void;
    onToggleBranch?: (threadId: ThreadId, isCurrentlyOpen: boolean) => void;
    onVisibleThreadIdsChange?: (threadIds: readonly ThreadId[]) => void;
  }) {
    const [expanded, setExpanded] = useState<ReadonlySet<ThreadId>>(new Set());
    const [collapsed, setCollapsed] = useState<ReadonlySet<ThreadId>>(new Set());
    const [counts, setCounts] = useState<ReadonlyMap<ThreadId, number>>(new Map());
    // Mirrors the Sidebar owner's navigation reveal: opening ancestors is
    // persisted into the expanded set so navigating away keeps the family open.
    const index = useMemo(() => buildThreadHierarchyIndex(threads), [threads]);
    useEffect(() => {
      if (activeThreadId === null) return;
      const plan = buildHierarchyRevealPlan({ index, threadId: activeThreadId });
      if (plan.ancestorIds.length === 0) return;
      setExpanded((current) => {
        const next = new Set(current);
        for (const ancestorId of plan.ancestorIds) next.add(ancestorId);
        return next.size === current.size ? current : next;
      });
      setCollapsed((current) => {
        if (!plan.ancestorIds.some((id) => current.has(id))) return current;
        const next = new Set(current);
        for (const ancestorId of plan.ancestorIds) next.delete(ancestorId);
        return next;
      });
      setCounts((current) => {
        let next: Map<ThreadId, number> | undefined;
        for (const [parentId, required] of plan.minimumVisibleCountByParentId) {
          if (required <= (current.get(parentId) ?? 5)) continue;
          next ??= new Map(current);
          next.set(parentId, required);
        }
        return next ?? current;
      });
    }, [activeThreadId, index]);
    return renderActivity({
      threads,
      projects,
      activeThreadId,
      pinnedThreadIdSet,
      resolveThreadStatus,
      onOpenThread,
      onRenameThread,
      onVisibleThreadIdsChange,
      expandedThreadIds: expanded,
      collapsedThreadIds: collapsed,
      childVisibleCountByParentId: counts,
      onToggleBranch: (id, isOpen) => {
        onToggleBranch?.(id, isOpen);
        if (isOpen) {
          setExpanded((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
          setCollapsed((current) => new Set(current).add(id));
          setCounts((current) => {
            if (!current.has(id)) return current;
            const next = new Map(current);
            next.delete(id);
            return next;
          });
        } else {
          setExpanded((current) => new Set(current).add(id));
          setCollapsed((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      },
      onShowMoreChildren: (id, total) => setCounts((current) => new Map(current).set(id, total)),
      onShowLessChildren: (id) =>
        setCounts((current) => {
          if (!current.has(id)) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
    });
  }

  function makeFamily(rootIndex: number, childCount: number, options?: { title?: string }) {
    // Current timestamps land the family in the open Recent section instead of
    // the closed Earlier bucket, so role queries resolve without extra clicks.
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const nowThread = (
      index: number,
      skewMs: number,
      overrides: Partial<SidebarThreadSummary> = {},
    ) =>
      makeThread(index, {
        createdAt: at(-3_600_000 + skewMs),
        updatedAt: at(-1_800_000 + skewMs),
        latestTurn: {
          turnId: `now-turn-${index}`,
          state: "completed",
          requestedAt: at(-1_900_000 + skewMs),
          startedAt: at(-1_900_000 + skewMs),
          completedAt: at(-1_800_000 + skewMs),
          assistantMessageId: null,
        } as SidebarThreadSummary["latestTurn"],
        lastVisitedAt: at(-600_000),
        ...overrides,
      });
    const root = nowThread(rootIndex, 0, { title: options?.title ?? `Family root ${rootIndex}` });
    const children = Array.from({ length: childCount }, (_, position) =>
      nowThread(rootIndex * 100 + position + 1, (position + 1) * 1000, {
        parentThreadId: root.id,
      }),
    );
    return { root, children, nowThread };
  }

  it("renders descendants as full activity rows with a numeric toggle and five-child paging", async () => {
    const { root, children, nowThread } = makeFamily(900, 20);
    children[0] = nowThread(90001, 1000, {
      parentThreadId: root.id,
      subagentNickname: "Scout",
      subagentRole: "reviewer",
    });
    children[1] = nowThread(90002, 2000, {
      parentThreadId: null,
      sourceThreadId: root.id,
      title: "Batch child full title",
    });
    const onOpenThread = vi.fn();
    const onVisibleThreadIdsChange = vi.fn();
    const mounted = await render(
      <HierarchyHarness
        threads={[root, ...children]}
        onOpenThread={onOpenThread}
        onVisibleThreadIdsChange={onVisibleThreadIdsChange}
      />,
    );

    // A02: one numeric toggle, initially closed.
    await expect
      .element(page.getByRole("button", { name: "Expand 20 subagents for Family root 900" }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Scout");
    expect(onVisibleThreadIdsChange.mock.lastCall?.[0]).toEqual([root.id]);

    // Open: five compact rows plus the exact paging label.
    await page.getByRole("button", { name: "Expand 20 subagents for Family root 900" }).click();
    expect(onOpenThread).not.toHaveBeenCalled();
    await expect.element(page.getByText("Scout")).toBeVisible();
    await expect.element(page.getByText("(reviewer)")).toBeVisible();
    await expect.element(page.getByText("Batch child full title")).toBeVisible();
    expect(document.body.textContent).not.toContain("batch");
    await page.getByRole("button", { name: "Show 15 more" }).click();

    // Children are full two-line activity rows: provider icon + title on the
    // first line, project · slot · branch · time on the second — identical to
    // the root row, only indented under the thread line.
    const rootRow = page
      .getByTestId(`activity-thread-${root.id}`)
      .element()
      .closest("[data-thread-item]")!;
    for (const title of ["Activity thread 90003", "Activity thread 90004"]) {
      const nav = page.getByRole("button", { name: title, exact: true }).element();
      const row = nav.closest("[data-thread-item]")!;
      expect(
        Math.abs(row.getBoundingClientRect().height - rootRow.getBoundingClientRect().height),
      ).toBeLessThanOrEqual(1);
      expect(nav.querySelector("svg, [data-slot=central-icon]")).not.toBeNull();
      expect(row.querySelectorAll('[class*="bg-border"]')).toHaveLength(0);
      expect(row.querySelector(`[aria-label="${title} in Project A"]`)).not.toBeNull();
      expect(row.querySelector("[data-thread-branch-slot]")).not.toBeNull();
    }
    // Children sit inside the parent's thread line, to the right of the root.
    const childList = rootRow.parentElement!.querySelector<HTMLElement>(
      "[data-thread-branch-children]",
    )!;
    expect(window.getComputedStyle(childList).borderLeftWidth).toBe("1px");
    expect(window.getComputedStyle(childList).marginLeft).toBe("16px");
    expect(childList.getBoundingClientRect().left).toBeGreaterThan(
      rootRow.getBoundingClientRect().left,
    );

    // A06/A19: full reveal reports exactly the mounted rows in order.
    await expect.element(page.getByText("Activity thread 90020")).toBeVisible();
    expect(document.querySelector('button[aria-label="Show 15 more"]')).toBeNull();
    await expect.element(page.getByRole("button", { name: "Show less" })).toBeVisible();
    expect(onVisibleThreadIdsChange.mock.lastCall?.[0]).toEqual([
      root.id,
      ...children.map((child) => child.id),
    ]);

    // Show less resets to the initial five with no active descendant.
    await page.getByRole("button", { name: "Show less" }).click();
    expect(document.querySelector('button[aria-label="Activity thread 90006"]')).toBeNull();
    expect(onVisibleThreadIdsChange.mock.lastCall?.[0]).toEqual([
      root.id,
      ...children.slice(0, 5).map((child) => child.id),
    ]);
    await mounted.unmount();
  });

  it("reveals an active descendant through the visible prefix without reordering", async () => {
    const { root, children } = makeFamily(910, 20);
    const target = children[16]!;
    const onVisibleThreadIdsChange = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [root, ...children],
        activeThreadId: target.id,
        expandedThreadIds: new Set([root.id]),
        onVisibleThreadIdsChange,
      }),
    );

    // A07: prefix 1–17 with three remaining, selection on the target.
    await expect
      .element(page.getByRole("button", { name: target.title, exact: true }))
      .toHaveAttribute("aria-current", "page");
    await expect.element(page.getByRole("button", { name: "Show 3 more" })).toBeVisible();
    expect(document.querySelector(`button[aria-label="${children[17]!.title}"]`)).toBeNull();
    expect(onVisibleThreadIdsChange.mock.lastCall?.[0]).toEqual([
      root.id,
      ...children.slice(0, 17).map((child) => child.id),
    ]);
    await mounted.unmount();
  });

  it("keeps the previous family open state and prefix when navigating away", async () => {
    const familyA = makeFamily(920, 7, { title: "Family A" });
    const familyB = makeFamily(930, 0, { title: "Family B" });
    const onVisibleThreadIdsChange = vi.fn();
    const mounted = await render(
      <HierarchyHarness
        threads={[familyA.root, ...familyA.children, familyB.root]}
        activeThreadId={familyA.children[0]!.id}
        onVisibleThreadIdsChange={onVisibleThreadIdsChange}
      />,
    );

    // The active child reveals its ancestor path on first visit: the branch
    // starts open with the initial five-child prefix.
    await expect
      .element(page.getByRole("button", { name: "Collapse 7 subagents for Family A" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Show 2 more" }).click();
    await expect.element(page.getByText(familyA.children[6]!.title)).toBeVisible();

    // Navigate to the other family by rerendering with a new active thread.
    await mounted.rerender(
      <HierarchyHarness
        threads={[familyA.root, ...familyA.children, familyB.root]}
        activeThreadId={familyB.root.id}
        onVisibleThreadIdsChange={onVisibleThreadIdsChange}
      />,
    );
    // A08: the previous family's open state and enlarged prefix are unchanged.
    await expect.element(page.getByText(familyA.children[6]!.title)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Collapse 7 subagents for Family A" }))
      .toBeVisible();
    await mounted.unmount();
  });

  it("keeps branch geometry stable across hidden status updates", async () => {
    const familyA = {
      root: makeThread(50, { title: "Stable A root" }),
      child: makeThread(51, {
        title: "Stable A child",
        parentThreadId: ThreadId.makeUnsafe("activity-thread-50"),
      }),
    };
    const familyB = {
      root: makeThread(40, { title: "Stable B root" }),
      child: makeThread(41, {
        title: "Stable B child",
        parentThreadId: ThreadId.makeUnsafe("activity-thread-40"),
      }),
    };
    const attention: ThreadStatusPill = {
      label: "Awaiting Input",
      colorClass: "text-indigo-600",
      dotClass: "bg-indigo-500",
      pulse: false,
    };
    const renderWithAttention = (withAttention: boolean, expanded: boolean) =>
      renderActivity({
        threads: [familyA.root, familyA.child, familyB.root, familyB.child],
        pinnedThreadIdSet: new Set([familyA.child.id, familyB.child.id]),
        expandedThreadIds: expanded ? new Set([familyA.root.id]) : new Set(),
        resolveThreadStatus: (thread) =>
          withAttention && thread.id === familyA.child.id ? attention : null,
      });
    const mounted = await render(renderWithAttention(false, false));
    const secondTop = () =>
      page.getByTestId(`activity-thread-${familyB.root.id}`).element().getBoundingClientRect().top;

    // Closed branch: the hidden attention aggregate must not resize the root.
    const beforeClosed = secondTop();
    await mounted.rerender(renderWithAttention(true, false));
    expect(Math.abs(secondTop() - beforeClosed)).toBeLessThanOrEqual(1);
    await expect
      .element(page.getByRole("button", { name: /Expand 1 subagent for Stable A root/ }))
      .toBeVisible();

    // Open branch: the in-flow child status glyph must not resize the child row.
    await mounted.rerender(renderWithAttention(true, true));
    expect(Math.abs(secondTop() - beforeClosed)).toBeLessThanOrEqual(1);
    await expect
      .element(page.getByRole("button", { name: /Collapse 1 subagent for Stable A root/ }))
      .toBeVisible();
    await mounted.unmount();
  });

  it("toggles and pages without navigating and activates a child exactly once", async () => {
    const { root, children } = makeFamily(940, 3);
    const onOpenThread = vi.fn();
    const onRenameThread = vi.fn();
    const onToggleBranch = vi.fn();
    const mounted = await render(
      <HierarchyHarness
        threads={[root, ...children]}
        onOpenThread={onOpenThread}
        onRenameThread={onRenameThread}
        onToggleBranch={onToggleBranch}
      />,
    );

    const toggle = () =>
      page.getByRole("button", { name: /subagents for Family root 940/ }).element();
    toggle().focus();
    await userEvent.keyboard("{Enter}");
    expect(onToggleBranch).toHaveBeenCalledTimes(1);
    expect(onOpenThread).not.toHaveBeenCalled();
    await expect.element(page.getByText(children[0]!.title)).toBeVisible();

    await userEvent.keyboard(" ");
    expect(onToggleBranch).toHaveBeenCalledTimes(2);
    expect(onOpenThread).not.toHaveBeenCalled();

    toggle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(onRenameThread).not.toHaveBeenCalled();

    await page.getByRole("button", { name: /Expand 3 subagents for Family root 940/ }).click();
    await page.getByRole("button", { name: children[1]!.title, exact: true }).click();
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith(children[1]!.id);
    await mounted.unmount();
  });

  it("keeps root titles full-width with the toggle on the metadata line", async () => {
    const {
      root: parent,
      children,
      nowThread,
    } = makeFamily(951, 1, {
      title: "Same width root title here",
    });
    const plain = nowThread(950, 0, { title: parent.title });
    const mounted = await render(
      <div style={{ width: "280px" }}>
        {renderActivity({ threads: [plain, parent, ...children] })}
      </div>,
    );

    // A01: no control, gutter, or new line on the childless root.
    const titleOf = (id: ThreadId) =>
      page.getByTestId(`activity-thread-${id}`).element().querySelector("span.truncate")!;
    const plainRect = titleOf(plain.id).getBoundingClientRect();
    const parentRect = titleOf(parent.id).getBoundingClientRect();
    await expect.element(page.getByTestId(`activity-thread-${plain.id}`)).toBeVisible();
    expect(plainRect.width).toBeGreaterThan(0);
    expect(Math.abs(plainRect.left - parentRect.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(plainRect.width - parentRect.width)).toBeLessThanOrEqual(1);
    const plainTitleLine = titleOf(plain.id).parentElement!;
    // Action space is already reserved before pointer or keyboard interaction.
    expect(parseFloat(getComputedStyle(plainTitleLine).paddingRight)).toBeGreaterThanOrEqual(68);
    await page.getByTestId(`activity-thread-${plain.id}`).hover();
    expect(titleOf(plain.id).getBoundingClientRect().width).toBeCloseTo(plainRect.width, 0);
    page.getByTestId(`activity-thread-${plain.id}`).element().focus();
    expect(titleOf(plain.id).getBoundingClientRect().width).toBeCloseTo(plainRect.width, 0);
    // The meta line reserves the same 40px slot on both rows, so the branch and
    // time columns align whether or not the row has children.
    const slotOf = (id: ThreadId) =>
      page
        .getByTestId(`activity-thread-${id}`)
        .element()
        .closest("[data-thread-item]")!
        .querySelector<HTMLElement>("[data-thread-branch-slot]")!
        .getBoundingClientRect();
    const plainSlot = slotOf(plain.id);
    const parentSlot = slotOf(parent.id);
    expect(plainSlot.width).toBeCloseTo(40, 0);
    expect(parentSlot.width).toBeCloseTo(40, 0);
    expect(Math.abs(plainSlot.left - parentSlot.left)).toBeLessThanOrEqual(1);
    const timeOf = (id: ThreadId) =>
      page
        .getByTestId(`activity-thread-${id}`)
        .element()
        .closest("[data-thread-item]")!
        .querySelector<HTMLElement>("[data-activity-branch-column]")!
        .getBoundingClientRect();
    expect(Math.abs(timeOf(plain.id).left - timeOf(parent.id).left)).toBeLessThanOrEqual(1);
    await mounted.unmount();
  });

  it("truncates deep nesting without horizontal overflow at 240px", async () => {
    const root = makeThread(960, {
      title: "A very long root title that must truncate instead of overflowing the sidebar",
    });
    const child = makeThread(961, {
      title: "A very long child title that must truncate instead of overflowing the sidebar",
      parentThreadId: root.id,
    });
    const grandchild = makeThread(962, {
      title: "A very long grandchild title that must truncate instead of overflowing the sidebar",
      parentThreadId: child.id,
    });
    const mounted = await render(
      <div style={{ width: "240px" }}>
        {renderActivity({
          threads: [root, child, grandchild],
          expandedThreadIds: new Set([root.id, child.id]),
        })}
      </div>,
    );

    await expect
      .element(page.getByText("A very long grandchild title that must truncate"))
      .toBeVisible();
    const container = document.body;
    for (const element of Array.from(document.querySelectorAll("[data-thread-branch]"))) {
      const item = element as HTMLElement;
      expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1);
    }
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
    await mounted.unmount();
  });
});
