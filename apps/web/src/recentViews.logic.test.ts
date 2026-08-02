// FILE: recentViews.logic.test.ts
// Purpose: Verifies Ctrl+Tab recent-view MRU behavior without rendering React.
// Layer: UI state logic test

import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
import type { ResolvedTerminalVisualIdentity } from "@synara/shared/terminalThreads";
import {
  buildRecentViewDisplayEntries,
  deriveCurrentRecentView,
  pruneRecentViews,
  recentViewKey,
  resolveRecentViewNavigationIndex,
  shouldPruneRecentViewsOnHydration,
  upsertRecentView,
  type RecentView,
} from "./recentViews.logic";
import type { Project, SidebarThreadSummary } from "./types";

function threadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

function projectId(value: string): ProjectId {
  return ProjectId.makeUnsafe(value);
}

describe("recent view MRU logic", () => {
  it("moves reopened views to the front and caps the list at five", () => {
    const recentViews = ["thread-1", "thread-2", "thread-3", "thread-4", "thread-5"].map((id) => ({
      kind: "thread" as const,
      threadId: threadId(id),
    }));

    const reopened = upsertRecentView(recentViews, {
      kind: "thread",
      threadId: threadId("thread-3"),
    });
    expect(reopened.map(recentViewKey)).toEqual([
      "thread:thread-3",
      "thread:thread-1",
      "thread:thread-2",
      "thread:thread-4",
      "thread:thread-5",
    ]);

    const withSixth = upsertRecentView(reopened, { kind: "settings" });
    expect(withSixth.map(recentViewKey)).toEqual([
      "settings",
      "thread:thread-3",
      "thread:thread-1",
      "thread:thread-2",
      "thread:thread-4",
    ]);
  });

  it("prunes deleted views and downgrades missing split views to plain threads", () => {
    const recentViews: RecentView[] = [
      { kind: "thread", threadId: threadId("thread-1"), splitViewId: "split-missing" },
      { kind: "thread", threadId: threadId("thread-deleted") },
      { kind: "plugins" },
    ];

    const pruned = pruneRecentViews(recentViews, {
      availableThreadIds: new Set([threadId("thread-1")]),
      availableSplitViewIds: new Set(["split-1"]),
    });

    expect(pruned).toEqual([
      { kind: "thread", threadId: threadId("thread-1") },
      { kind: "plugins" },
    ]);
  });

  it("downgrades split views that no longer contain the saved thread", () => {
    const pruned = pruneRecentViews(
      [{ kind: "thread", threadId: threadId("thread-1"), splitViewId: "split-1" }],
      {
        availableThreadIds: new Set([threadId("thread-1"), threadId("thread-2")]),
        availableSplitViewIds: new Set(["split-1"]),
        threadIdsBySplitViewId: new Map([["split-1", new Set([threadId("thread-2")])]]),
      },
    );

    expect(pruned).toEqual([{ kind: "thread", threadId: threadId("thread-1") }]);
  });

  it("selects the previous MRU entry on the first forward cycle", () => {
    const recentViews: RecentView[] = [
      { kind: "thread", threadId: threadId("thread-current") },
      { kind: "settings" },
      { kind: "plugins" },
    ];

    expect(
      resolveRecentViewNavigationIndex({
        recentViews,
        currentView: recentViews[0] ?? null,
        direction: "next",
      }),
    ).toBe(1);
    expect(
      resolveRecentViewNavigationIndex({
        recentViews,
        currentView: recentViews[0] ?? null,
        selectedKey: recentViewKey(recentViews[1] as RecentView),
        direction: "previous",
      }),
    ).toBe(0);
  });

  it("derives only primary route views", () => {
    expect(
      deriveCurrentRecentView({
        pathname: "/thread-1",
        routeThreadId: threadId("thread-1"),
        activeThreadId: threadId("thread-focused"),
        splitViewId: "split-1",
      }),
    ).toEqual({
      kind: "thread",
      threadId: threadId("thread-focused"),
      splitViewId: "split-1",
    });

    expect(
      deriveCurrentRecentView({
        pathname: "/",
        routeThreadId: null,
        activeThreadId: null,
      }),
    ).toBeNull();
  });

  it("prefers terminal visual identity over thread provider for display icons", () => {
    const terminalThreadId = threadId("thread-terminal");
    const project = { id: projectId("project-1"), name: "Synara" } as Project;
    const threadSummary = {
      id: terminalThreadId,
      projectId: project.id,
      title: "Dev server",
      modelSelection: { provider: "codex", model: "gpt-5" },
    } as SidebarThreadSummary;

    const entries = buildRecentViewDisplayEntries({
      recentViews: [{ kind: "thread", threadId: terminalThreadId }],
      currentView: null,
      threadsById: { [terminalThreadId]: threadSummary },
      projects: [project],
      pinnedThreadIds: [],
      terminalVisualIdentityByThreadId: new Map<ThreadId, ResolvedTerminalVisualIdentity>([
        [
          terminalThreadId,
          {
            cliKind: null,
            iconKey: "terminal",
            state: "running",
            title: "bun dev",
          },
        ],
      ]),
    });

    expect(entries[0]).toMatchObject({
      icon: { kind: "terminal", iconKey: "terminal" },
      isTerminal: true,
      provider: "codex",
      subtitle: "Synara · Terminal",
      terminalVisualIdentity: {
        cliKind: null,
        iconKey: "terminal",
        state: "running",
        title: "bun dev",
      },
    });
  });
});

describe("shouldPruneRecentViewsOnHydration", () => {
  // This prune fires ONCE and deletes persisted views permanently, so the gate
  // is the only thing standing between a slow-connecting remote host and the
  // silent loss of its recent views. It was previously an inline predicate in a
  // useEffect: correct, and completely undefended — mutating it broke nothing.

  it("does not run while any environment is still unhydrated", () => {
    // The bug. A remote host connects after local; in that window its views are
    // absent from the aggregate because its server has not answered, not
    // because they are gone. Pruning here deletes them with no second pass.
    expect(
      shouldPruneRecentViewsOnHydration({
        threadsHydrated: true,
        allEnvironmentsHydrated: false,
        alreadyPruned: false,
      }),
    ).toBe(false);
  });

  it("runs once every environment has reported", () => {
    expect(
      shouldPruneRecentViewsOnHydration({
        threadsHydrated: true,
        allEnvironmentsHydrated: true,
        alreadyPruned: false,
      }),
    ).toBe(true);
  });

  it("does not run before the LOCAL server has reported", () => {
    // The original condition, still required: absence before local hydration is
    // "nothing has loaded yet" rather than "these are gone".
    expect(
      shouldPruneRecentViewsOnHydration({
        threadsHydrated: false,
        allEnvironmentsHydrated: true,
        alreadyPruned: false,
      }),
    ).toBe(false);
  });

  it("never runs twice", () => {
    // The latch is what makes an early prune unrecoverable, so it must hold
    // even once everything is hydrated.
    expect(
      shouldPruneRecentViewsOnHydration({
        threadsHydrated: true,
        allEnvironmentsHydrated: true,
        alreadyPruned: true,
      }),
    ).toBe(false);
  });

  it("is unchanged for a single-server install", () => {
    // With only the local environment registered, "all hydrated" IS "local
    // hydrated", so the single-server case behaves exactly as before. The flag
    // is REQUIRED rather than defaulting: the caller is a hook that no unit
    // test reaches, so omitting it would silently restore the bug — a compile
    // error is the one check a caller cannot skip.
    expect(
      shouldPruneRecentViewsOnHydration({
        threadsHydrated: true,
        allEnvironmentsHydrated: true,
        alreadyPruned: false,
      }),
    ).toBe(true);
    expect(
      shouldPruneRecentViewsOnHydration({
        threadsHydrated: false,
        allEnvironmentsHydrated: true,
        alreadyPruned: false,
      }),
    ).toBe(false);
  });
});
