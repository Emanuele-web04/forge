// FILE: SidebarActivityView.browser.tsx
// Purpose: Browser regressions for Activity paging, stateful actions, scope fallback, and live PR data.
// Layer: Sidebar Activity UI test

import "../index.css";

import { ProjectId, ThreadId, type OrchestrationThreadPullRequest } from "@synara/contracts";
import type { PointerEvent as ReactPointerEvent } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { Project, SidebarThreadSummary } from "../types";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { SidebarActivityView } from "./SidebarActivityView";

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
  projects?: readonly Project[];
  activeThreadId?: ThreadId | null;
  pinnedThreadIdSet?: ReadonlySet<ThreadId>;
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>;
  prByThreadId?: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest | null>;
  onVisibleThreadIdsChange?: (threadIds: readonly ThreadId[]) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  onSetThreadSettled?: (threadId: ThreadId, settled: boolean) => void;
  onMarkThreadRead?: (threadId: ThreadId, completedAt?: string) => void;
  onRenameThread?: (threadId: ThreadId) => void;
  onThreadRenamePointerUp?: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onThreadContextMenu?: (threadId: ThreadId, position: { x: number; y: number }) => void;
  onProjectContextMenu?: (projectId: ProjectId, position: { x: number; y: number }) => void;
  resolveThreadStatus?: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
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
    />
  );
}

describe("SidebarActivityView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
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

    await page.getByRole("button", { name: "Show more" }).click();
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

    const completedDot = page
      .getByTestId(`activity-thread-${unseen.id}`)
      .element()
      .parentElement?.querySelector('[aria-label="Unread completion"]');
    expect(completedDot).not.toBeNull();
    expect(completedDot?.parentElement?.dataset.slot).toBe("activity-completion-status");
    const completedStatusSlot = completedDot?.parentElement;
    const completedStatusLeft = completedStatusSlot?.getBoundingClientRect().left;

    const pinnedRow = page.getByTestId(`activity-thread-${pinned.id}`).element();
    pinnedRow.focus();
    pinnedRow.parentElement?.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.click();
    expect(onSetThreadSettled).toHaveBeenCalledWith(pinned.id, false);

    const resumedRow = page.getByTestId(`activity-thread-${resumedSettled.id}`).element();
    expect(resumedRow.parentElement?.querySelector('button[aria-label="Undo"]')).not.toBeNull();

    page.getByTestId(`activity-thread-${unseen.id}`).element().focus();
    await vi.waitFor(() => {
      expect(getComputedStyle(completedStatusSlot!).opacity).toBe("0");
    });
    expect(completedStatusSlot?.getBoundingClientRect().left).toBe(completedStatusLeft);
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
