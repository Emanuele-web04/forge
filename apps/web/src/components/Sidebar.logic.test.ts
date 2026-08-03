import { describe, expect, it } from "vitest";

import {
  buildProjectThreadTree,
  createSidebarThreadHoverAnchorId,
  derivePinnedProjectIdsForSidebar,
  derivePinnedThreadIdsForSidebar,
  deriveSidebarProjectData,
  describeAddProjectError,
  extractDuplicateProjectCreateProjectId,
  findDeepestWorkspaceRootMatch,
  findWorkspaceRootMatch,
  getFallbackThreadIdAfterDelete,
  getVisibleSidebarEntriesForPreview,
  orderPinnedProjectsForSidebar,
  pullRequestRepositoryConfigFingerprint,
  getPinnedThreadsForSidebar,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdForJumpCommand,
  getSidebarThreadIdsToPrewarm,
  getRenderedThreadsForSidebarProject,
  groupSidebarThreadsByProjectId,
  isLatestPinnedProjectMutation,
  isProjectsSidebarSurface,
  getUnpinnedThreadsForSidebar,
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  partitionSidebarThreadsByProjectIds,
  isLatestPinnedThreadMutation,
  isLoopbackHostname,
  isDuplicateProjectCreateError,
  pruneProjectThreadListPagingForCollapsedProjects,
  recoverExistingAddProjectTarget,
  resolvePullRequestReviewBadge,
  resolveSidebarThreadListPaging,
  resolveProjectEmptyState,
  resolveSettingsBackTarget,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadEnvMode,
  resolveThreadHoverCardMetadata,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  resolveThreadStatusTrailingIndicator,
  isUrgentThreadStatusPill,
  type ThreadStatusPill,
  shouldShowDebugFeatureFlagsMenu,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { ProjectId, ThreadId } from "@synara/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type SidebarThreadSummary,
  type Thread,
} from "../types";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): Parameters<typeof hasUnseenCompletion>[0]["latestTurn"] {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("isProjectsSidebarSurface", () => {
  it("enables Space shortcuts only where the Space switcher is visible", () => {
    expect(isProjectsSidebarSurface({ isOnSettings: false, isOnStudio: false })).toBe(true);
    expect(isProjectsSidebarSurface({ isOnSettings: false, isOnStudio: true })).toBe(false);
    expect(isProjectsSidebarSurface({ isOnSettings: true, isOnStudio: false })).toBe(false);
  });
});

describe("resolvePullRequestReviewBadge", () => {
  it("distinguishes complete, partial, and unavailable review counts", () => {
    expect(resolvePullRequestReviewBadge({ count: 3, incomplete: false })).toEqual({
      text: "3",
      accessibleLabel: "3 pull requests are waiting for your review",
    });
    expect(resolvePullRequestReviewBadge({ count: 3, incomplete: true })).toEqual({
      text: "3+",
      accessibleLabel: "At least 3 pull requests are waiting for your review",
    });
    expect(resolvePullRequestReviewBadge({ count: 0, incomplete: true })).toBeNull();
    expect(resolvePullRequestReviewBadge({ count: 0, incomplete: false })).toBeNull();
    expect(resolvePullRequestReviewBadge(undefined)).toBeNull();
    expect(resolvePullRequestReviewBadge({ count: 1, incomplete: false })?.accessibleLabel).toBe(
      "1 pull request is waiting for your review",
    );
  });
});

describe("pullRequestRepositoryConfigFingerprint", () => {
  it("changes for repository-affecting project edits but not sidebar ordering or expansion", () => {
    const first = makeProject({ id: ProjectId.makeUnsafe("project-1"), cwd: "/repo/one" });
    const second = makeProject({ id: ProjectId.makeUnsafe("project-2"), cwd: "/repo/two" });
    const baseline = pullRequestRepositoryConfigFingerprint([first, second]);

    expect(pullRequestRepositoryConfigFingerprint([second, first])).toBe(baseline);
    expect(
      pullRequestRepositoryConfigFingerprint([{ ...first, expanded: !first.expanded }, second]),
    ).toBe(baseline);
    expect(
      pullRequestRepositoryConfigFingerprint([{ ...first, cwd: "/repo/moved" }, second]),
    ).not.toBe(baseline);
    expect(
      pullRequestRepositoryConfigFingerprint([{ ...first, name: "Renamed" }, second]),
    ).not.toBe(baseline);
  });
});

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("debug feature flags menu visibility", () => {
  it("allows loopback hostnames", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("requires dev mode, localhost, and explicit storage opt-in", () => {
    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: true,
        hostname: "localhost",
        storageValue: "true",
      }),
    ).toBe(true);

    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: false,
        hostname: "localhost",
        storageValue: "true",
      }),
    ).toBe(false);
    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: true,
        hostname: "app.example.com",
        storageValue: "true",
      }),
    ).toBe(false);
    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: true,
        hostname: "localhost",
        storageValue: null,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadHoverCardMetadata", () => {
  it("includes source project and worktree names for worktree-backed chats", () => {
    const metadata = resolveThreadHoverCardMetadata({
      thread: makeSidebarThreadSummary({
        envMode: "worktree",
        branch: "codex/synara-mobile",
        worktreePath: "/Users/me/.codex/worktrees/1234/Remodex",
        associatedWorktreePath: "/Users/me/.codex/worktrees/1234/Remodex",
        associatedWorktreeBranch: "codex/synara-mobile",
      }),
      project: {
        kind: "project",
        name: "synara-mobile",
        folderName: "Remodex",
        cwd: "/Users/me/Developer/Remodex",
      },
    });

    expect(metadata).toEqual({
      projectName: "synara-mobile",
      projectCwd: "/Users/me/Developer/Remodex",
      sourceProjectName: "Remodex",
      branch: "codex/synara-mobile",
      worktreeName: "Remodex",
    });
  });

  it("keeps local chats compact", () => {
    const metadata = resolveThreadHoverCardMetadata({
      thread: makeSidebarThreadSummary({
        branch: "main",
      }),
      project: {
        kind: "project",
        name: "synara",
        folderName: "synara",
        cwd: "/Users/me/Developer/synara",
      },
    });

    expect(metadata).toEqual({
      projectName: "synara",
      projectCwd: "/Users/me/Developer/synara",
      sourceProjectName: null,
      branch: "main",
      worktreeName: null,
    });
  });

  it("labels project-less chat containers as Synara instead of the slug folder", () => {
    const metadata = resolveThreadHoverCardMetadata({
      thread: makeSidebarThreadSummary({ branch: null }),
      project: {
        kind: "chat",
        name: "open-the-browser-search-house-music",
        folderName: "open-the-browser-search-house-music",
        cwd: "/Users/me/Documents/Synara/2026-08-01/open-the-browser-search-house-music",
      },
    });

    expect(metadata.projectName).toBe("Synara");
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveSettingsBackTarget", () => {
  it("keeps fresh draft chats available as settings back targets", () => {
    // Mirrors the sidebar's settings-back wiring: persisted thread summaries plus the
    // segment's draft thread ids form the restorable set.
    const availableThreadIds = new Set(["thread-latest", "thread-draft"]);

    expect(
      resolveSettingsBackTarget({
        lastThreadRoute: {
          threadId: "thread-draft",
        },
        availableThreadIds,
        latestThreadId: "thread-latest",
      }),
    ).toEqual({
      kind: "thread",
      threadId: "thread-draft",
    });
  });

  it("returns the remembered live thread route", () => {
    expect(
      resolveSettingsBackTarget({
        lastThreadRoute: {
          threadId: "thread-remembered",
          splitViewId: "split-live",
        },
        availableThreadIds: new Set(["thread-remembered", "thread-latest"]),
        availableSplitViewIds: new Set(["split-live"]),
        latestThreadId: "thread-latest",
      }),
    ).toEqual({
      kind: "thread",
      threadId: "thread-remembered",
      splitViewId: "split-live",
    });
  });

  it("falls back to the latest sidebar thread when the remembered route is stale", () => {
    expect(
      resolveSettingsBackTarget({
        lastThreadRoute: {
          threadId: "thread-missing",
        },
        availableThreadIds: new Set(["thread-latest"]),
        latestThreadId: "thread-latest",
      }),
    ).toEqual({
      kind: "thread",
      threadId: "thread-latest",
    });
  });

  it("falls back to home when no thread target is available", () => {
    expect(
      resolveSettingsBackTarget({
        lastThreadRoute: null,
        availableThreadIds: new Set(),
        latestThreadId: null,
      }),
    ).toEqual({ kind: "home" });
  });
});

describe("pruneProjectThreadListPagingForCollapsedProjects", () => {
  it("clears remembered show-more paging when a project is collapsed", () => {
    const current = new Map([
      ["/Users/tester/Code/one", 2],
      ["/Users/tester/Code/two", 1],
    ]);

    const next = pruneProjectThreadListPagingForCollapsedProjects({
      threadListExtraPagesByProjectCwd: current,
      projects: [
        { cwd: "/Users/tester/Code/one", expanded: false },
        { cwd: "/Users/tester/Code/two", expanded: true },
      ],
      normalizeProjectCwd: (cwd) => cwd.replace(/\/+$/, ""),
    });

    expect([...next]).toEqual([["/Users/tester/Code/two", 1]]);
  });

  it("preserves the existing map when no collapsed project needs pruning", () => {
    const current = new Map([["/Users/tester/Code/one", 1]]);

    const next = pruneProjectThreadListPagingForCollapsedProjects({
      threadListExtraPagesByProjectCwd: current,
      projects: [{ cwd: "/Users/tester/Code/one", expanded: true }],
      normalizeProjectCwd: (cwd) => cwd.replace(/\/+$/, ""),
    });

    expect(next).toBe(current);
  });
});

describe("resolveSidebarThreadListPaging", () => {
  it("keeps the base preview with no paging affordances when everything fits", () => {
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 4,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: 0,
      }),
    ).toEqual({
      effectiveExtraPages: 0,
      previewLimit: 5,
      canShowMore: false,
      canShowLess: false,
    });
  });

  it("adds one page per show-more click and offers show-less only after the first", () => {
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: 0,
      }),
    ).toEqual({
      effectiveExtraPages: 0,
      previewLimit: 5,
      canShowMore: true,
      canShowLess: false,
    });

    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: 1,
      }),
    ).toEqual({
      effectiveExtraPages: 1,
      previewLimit: 10,
      canShowMore: true,
      canShowLess: true,
    });
  });

  it("clamps oversized requested paging to what the list can actually use", () => {
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: 9,
      }),
    ).toEqual({
      effectiveExtraPages: 2,
      previewLimit: 15,
      canShowMore: false,
      canShowLess: true,
    });
  });

  it("ignores negative and non-finite requested paging", () => {
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: -3,
      }).effectiveExtraPages,
    ).toBe(0);
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: Number.NaN,
      }).effectiveExtraPages,
    ).toBe(0);
  });
});

describe("add-project error helpers", () => {
  it("finds an existing project by workspace root", () => {
    expect(
      findWorkspaceRootMatch(
        [
          { id: "project-1", cwd: "/Users/tester/Code/one" },
          { id: "project-2", cwd: "/Users/tester/Code/two" },
        ],
        "/Users/tester/Code/two/",
        (project) => project.cwd,
      )?.id,
    ).toBe("project-2");
  });

  it("attributes a nested server cwd to the deepest matching project", () => {
    const projects = [
      { id: "repo", cwd: "/Users/tester/Code/repo" },
      { id: "web", cwd: "/Users/tester/Code/repo/apps/web" },
      { id: "other", cwd: "/Users/tester/Code/other" },
    ];

    expect(
      findDeepestWorkspaceRootMatch(
        projects,
        "/Users/tester/Code/repo/apps/web/src",
        (project) => project.cwd,
      )?.id,
    ).toBe("web");
    expect(
      findDeepestWorkspaceRootMatch(
        projects,
        "/Users/tester/Code/repo/apps/server",
        (project) => project.cwd,
      )?.id,
    ).toBe("repo");
    expect(
      findDeepestWorkspaceRootMatch(
        projects,
        "/Users/tester/Code/unrelated",
        (project) => project.cwd,
      ),
    ).toBeUndefined();
  });

  it("falls through to project.create when a local project shell is stale on the server", async () => {
    const recoverByProjectIdCalls: ProjectId[] = [];
    const recoverByWorkspaceRootCalls: string[] = [];

    const decision = await recoverExistingAddProjectTarget({
      existingProjectId: ProjectId.makeUnsafe("project-stale-local"),
      workspaceRoot: "/Users/tester/Code/one",
      recoverByProjectId: async (projectId) => {
        recoverByProjectIdCalls.push(projectId);
        return false;
      },
      recoverByWorkspaceRoot: async (workspaceRoot) => {
        recoverByWorkspaceRootCalls.push(workspaceRoot);
        return false;
      },
    });

    expect(decision).toBe("create");
    expect(recoverByProjectIdCalls).toEqual([ProjectId.makeUnsafe("project-stale-local")]);
    expect(recoverByWorkspaceRootCalls).toEqual(["/Users/tester/Code/one"]);
  });

  it("reuses an active server project matched by workspace root even if the local id is stale", async () => {
    const decision = await recoverExistingAddProjectTarget({
      existingProjectId: ProjectId.makeUnsafe("project-stale-local"),
      workspaceRoot: "/Users/tester/Code/one",
      recoverByProjectId: async () => false,
      recoverByWorkspaceRoot: async () => true,
    });

    expect(decision).toBe("recovered");
  });

  it("detects duplicate project.create errors", () => {
    expect(
      isDuplicateProjectCreateError(
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root 'C:\\Labs\\influenzo'.",
      ),
    ).toBe(true);
  });

  it("extracts the existing project id from duplicate project.create errors", () => {
    expect(
      extractDuplicateProjectCreateProjectId(
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      ),
    ).toBe("project-123");
  });

  it("does not classify unrelated errors as duplicate project.create failures", () => {
    expect(
      isDuplicateProjectCreateError("Project directory does not exist: C:\\Labs\\influenzo"),
    ).toBe(false);
  });

  it("returns null when extracting from unrelated add-project errors", () => {
    expect(
      extractDuplicateProjectCreateProjectId(
        "Project directory does not exist: C:\\Labs\\influenzo",
      ),
    ).toBeNull();
  });

  it("adds a readable explanation for duplicate workspace-root errors", () => {
    expect(
      describeAddProjectError(
        "Orchestration command invariant failed (project.create): Project 'project-duplicate' already uses workspace root 'C:\\Labs\\influenzo'.",
      ),
    ).toContain("already linked to an existing project");
  });

  it("explains root-absolute add-project paths that probably missed the home directory", () => {
    expect(
      describeAddProjectError("Failed to create project directory: /Developer/Testing/synara"),
    ).toContain("/Users/<name>/Developer");
  });

  it("returns no explanation for unrelated add-project errors", () => {
    expect(describeAddProjectError("Project path is not a directory: C:\\Labs\\influenzo")).toBe(
      null,
    );
  });
});

describe("pin helpers", () => {
  const makeProject = (id: string): Project =>
    ({
      id: id as ProjectId,
      kind: "project",
      name: id,
      remoteName: id,
      folderName: id,
      localName: null,
      cwd: `/tmp/${id}`,
      defaultModelSelection: null,
      expanded: true,
      spaceId: null,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      scripts: [],
    }) satisfies Project;

  const makeThread = (id: string): Thread =>
    ({
      id: id as ThreadId,
      codexThreadId: null,
      projectId: "project-1" as ProjectId,
      title: id,
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
      session: null,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-09T10:00:00.000Z",
      latestTurn: null,
      turnDiffSummaries: [],
      activities: [],
      branch: null,
      worktreePath: null,
    }) satisfies Thread;

  it("returns pinned threads in persisted pin order", () => {
    const threads = [makeThread("thread-1"), makeThread("thread-2"), makeThread("thread-3")];

    expect(
      getPinnedThreadsForSidebar(threads, ["thread-3" as ThreadId, "thread-1" as ThreadId]),
    ).toEqual([threads[2], threads[0]]);
  });

  it("filters pinned threads out of project lists", () => {
    const threads = [makeThread("thread-1"), makeThread("thread-2"), makeThread("thread-3")];

    expect(
      getUnpinnedThreadsForSidebar(threads, ["thread-2" as ThreadId, "thread-3" as ThreadId]),
    ).toEqual([threads[0]]);
  });

  it("keeps a pinned parent in project lists so its children stay reachable and nested", () => {
    const threads = [
      makeThread("thread-1"),
      {
        ...makeThread("child-1"),
        parentThreadId: "thread-1" as ThreadId,
      },
      makeThread("thread-2"),
    ];

    // Pinning the parent must not hide child-1 entirely (buildProjectThreadTree
    // hides children with missing parents); the parent stays in the tree,
    // children render under it.
    expect(getUnpinnedThreadsForSidebar(threads, ["thread-1" as ThreadId])).toEqual(threads);
    // Childless pinned threads are still hidden from project lists.
    expect(getUnpinnedThreadsForSidebar(threads, ["thread-2" as ThreadId])).toEqual([
      threads[0],
      threads[1],
    ]);
  });

  it("lets an optimistic unpin override server and persisted pinned state", () => {
    const threads = [
      {
        ...makeThread("thread-1"),
        isPinned: true,
      },
    ];

    expect(
      derivePinnedThreadIdsForSidebar({
        threads,
        persistedPinnedThreadIds: ["thread-1" as ThreadId],
        optimisticPinnedStateByThreadId: new Map([["thread-1" as ThreadId, false]]),
      }),
    ).toEqual([]);
  });

  it("shows an optimistic pin before the server snapshot confirms it", () => {
    const threads = [makeThread("thread-1")];

    expect(
      derivePinnedThreadIdsForSidebar({
        threads,
        persistedPinnedThreadIds: [],
        optimisticPinnedStateByThreadId: new Map([["thread-1" as ThreadId, true]]),
      }),
    ).toEqual(["thread-1"]);
  });

  it("derives at most three pinned projects and keeps persisted order first", () => {
    const projects = [
      { ...makeProject("project-1"), isPinned: true },
      { ...makeProject("project-2"), isPinned: true },
      { ...makeProject("project-3"), isPinned: true },
      { ...makeProject("project-4"), isPinned: true },
    ];

    expect(
      derivePinnedProjectIdsForSidebar({
        projects,
        persistedPinnedProjectIds: ["project-3" as ProjectId, "project-1" as ProjectId],
        optimisticPinnedStateByProjectId: new Map([["project-1" as ProjectId, false]]),
      }),
    ).toEqual(["project-3", "project-2", "project-4"]);
  });

  it("moves pinned projects to the top while preserving unpinned order", () => {
    const projects = [makeProject("project-1"), makeProject("project-2"), makeProject("project-3")];

    expect(
      orderPinnedProjectsForSidebar(projects, ["project-3" as ProjectId, "project-1" as ProjectId]),
    ).toEqual([projects[2], projects[0], projects[1]]);
  });

  it("rejects stale pin mutation versions so old failures cannot roll back newer clicks", () => {
    const threadId = "thread-1" as ThreadId;
    const latestMutationVersionByThreadId = new Map<ThreadId, number>([[threadId, 2]]);
    const projectId = "project-1" as ProjectId;
    const latestMutationVersionByProjectId = new Map<ProjectId, number>([[projectId, 2]]);

    expect(
      isLatestPinnedThreadMutation({
        threadId,
        requestVersion: 1,
        latestMutationVersionByThreadId,
      }),
    ).toBe(false);
    expect(
      isLatestPinnedThreadMutation({
        threadId,
        requestVersion: 2,
        latestMutationVersionByThreadId,
      }),
    ).toBe(true);
    expect(
      isLatestPinnedProjectMutation({
        projectId,
        requestVersion: 1,
        latestMutationVersionByProjectId,
      }),
    ).toBe(false);
    expect(
      isLatestPinnedProjectMutation({
        projectId,
        requestVersion: 2,
        latestMutationVersionByProjectId,
      }),
    ).toBe(true);
  });

  it("waits for thread hydration before pruning persisted pins", () => {
    expect(shouldPrunePinnedThreads({ threadsHydrated: false })).toBe(false);
    expect(shouldPrunePinnedThreads({ threadsHydrated: true })).toBe(true);
  });

  it("shows loading before the first project snapshot can prove the list is empty", () => {
    expect(
      resolveProjectEmptyState({
        projectCount: 0,
        shouldShowProjectPathEntry: false,
        threadsHydrated: false,
      }),
    ).toBe("loading");
    expect(
      resolveProjectEmptyState({
        projectCount: 0,
        shouldShowProjectPathEntry: false,
        threadsHydrated: true,
      }),
    ).toBe("empty");
    expect(
      resolveProjectEmptyState({
        projectCount: 1,
        shouldShowProjectPathEntry: false,
        threadsHydrated: false,
      }),
    ).toBeNull();
  });
});

function statusPill(label: ThreadStatusPill["label"]): ThreadStatusPill {
  return { label, colorClass: "", dotClass: "", pulse: false };
}

describe("isUrgentThreadStatusPill", () => {
  it("treats every status but a finished turn as urgent", () => {
    expect(isUrgentThreadStatusPill(statusPill("Pending Approval"))).toBe(true);
    expect(isUrgentThreadStatusPill(statusPill("Awaiting Input"))).toBe(true);
    expect(isUrgentThreadStatusPill(statusPill("Plan Ready"))).toBe(true);
    expect(isUrgentThreadStatusPill(statusPill("Working"))).toBe(true);
    expect(isUrgentThreadStatusPill(statusPill("Connecting"))).toBe(true);
    expect(isUrgentThreadStatusPill(statusPill("Completed"))).toBe(false);
  });
});

describe("resolveThreadStatusTrailingIndicator", () => {
  it("shows nothing when there is no status", () => {
    expect(resolveThreadStatusTrailingIndicator({ status: null })).toBeNull();
  });

  it("yields the slot when another affordance owns it", () => {
    expect(
      resolveThreadStatusTrailingIndicator({
        status: statusPill("Working"),
        slotOccupied: true,
      }),
    ).toBeNull();
  });

  it("hides an unread completion on the open thread but keeps it elsewhere", () => {
    const completed = statusPill("Completed");
    expect(resolveThreadStatusTrailingIndicator({ status: completed, isActive: true })).toBeNull();
    expect(resolveThreadStatusTrailingIndicator({ status: completed, isActive: false })).toBe(
      completed,
    );
  });

  it("keeps live and actionable statuses on the open row", () => {
    for (const label of ["Working", "Connecting", "Pending Approval", "Awaiting Input"] as const) {
      const pill = statusPill(label);
      expect(resolveThreadStatusTrailingIndicator({ status: pill, isActive: true })).toBe(pill);
    }
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    dismissedStatusKey: undefined,
    proposedPlans: [],
    hasLiveTailWork: false,
    updatedAt: "2026-03-09T10:05:00.000Z",
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("keeps showing working when late turn activity arrives after the session looks ready", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasLiveTailWork: true,
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
              implementedAt: null,
              implementationThreadId: null,
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not show plan ready after the proposed plan was implemented elsewhere", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
              implementedAt: "2026-03-09T10:06:00.000Z",
              implementationThreadId: "thread-implement" as never,
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("hides a dismissible status when its dismissal key matches", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          dismissedStatusKey:
            "Plan Ready:2026-03-09T10:05:00.000Z:turn-1:2026-03-09T10:05:00.000Z:2026-03-09T10:00:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadRowClassName", () => {
  it("keeps selected active rows on the selected sidebar background", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("hover:bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("text-[var(--sidebar-accent-foreground)]");
    expect(className).not.toContain("bg-[var(--color-background-button-secondary-hover)]");
  });

  it("keeps selected rows visually aligned with hover", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("hover:bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("text-[var(--sidebar-accent-foreground)]");
    expect(className).not.toContain("bg-[var(--color-background-button-secondary-hover)]");
  });

  it("uses the hover sidebar background for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("hover:bg-[var(--sidebar-accent-active)]");
  });

  it("uses the sidebar accent token for hover-only rows", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: false });
    expect(className).toContain("hover:bg-[var(--sidebar-accent)]");
    expect(className).not.toContain("hover:bg-[var(--color-background-button-secondary-hover)]");
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
      ThreadId.makeUnsafe("thread-5"),
      ThreadId.makeUnsafe("thread-6"),
      ThreadId.makeUnsafe("thread-8"),
    ]);
  });

  it("returns all threads when the preview limit covers the whole list", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      previewLimit: 8,
    });

    expect(result.hasHiddenThreads).toBe(false);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
  });
});

describe("getRenderedThreadsForSidebarProject", () => {
  it("pins only the active thread when the parent project is collapsed", () => {
    const threads = Array.from({ length: 4 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getRenderedThreadsForSidebarProject({
      project: makeProject({ expanded: false }),
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-4"),
      previewLimit: 2,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.renderedThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });
});

describe("buildProjectThreadTree", () => {
  it("keeps inactive child threads out of the sidebar", () => {
    const rows = buildProjectThreadTree({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        thread: expect.objectContaining({ id: ThreadId.makeUnsafe("thread-parent") }),
        depth: 0,
      }),
    ]);
  });

  it("hides subagent subtrees whose parent is not in the list", () => {
    // Regression: archiving (or deleting) a parent removes it from the sidebar
    // list; its subagent children must stay hidden instead of surfacing as
    // top-level rows (#488).
    const rows = buildProjectThreadTree({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-other"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          parentThreadId: ThreadId.makeUnsafe("thread-archived-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-grandchild"),
          parentThreadId: ThreadId.makeUnsafe("thread-child"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        thread: expect.objectContaining({ id: ThreadId.makeUnsafe("thread-other") }),
        depth: 0,
      }),
    ]);
  });

  it("reveals the active child thread and its ancestors", () => {
    const rows = buildProjectThreadTree({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-grandchild"),
          parentThreadId: ThreadId.makeUnsafe("thread-child"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
      forceVisibleThreadId: ThreadId.makeUnsafe("thread-grandchild"),
    });

    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      [ThreadId.makeUnsafe("thread-parent"), 0],
      [ThreadId.makeUnsafe("thread-child"), 1],
      [ThreadId.makeUnsafe("thread-grandchild"), 2],
    ]);
  });
});

describe("getVisibleSidebarEntriesForPreview", () => {
  it("caps preview by rendered rows, not root-thread count", () => {
    const result = getVisibleSidebarEntriesForPreview({
      entries: [
        {
          rowId: ThreadId.makeUnsafe("thread-parent"),
          rootRowId: ThreadId.makeUnsafe("thread-parent"),
        },
        {
          rowId: ThreadId.makeUnsafe("thread-child"),
          rootRowId: ThreadId.makeUnsafe("thread-parent"),
        },
        {
          rowId: ThreadId.makeUnsafe("thread-second-root"),
          rootRowId: ThreadId.makeUnsafe("thread-second-root"),
        },
        {
          rowId: ThreadId.makeUnsafe("thread-third-root"),
          rootRowId: ThreadId.makeUnsafe("thread-third-root"),
        },
      ],
      activeEntryId: undefined,
      previewLimit: 2,
    });

    expect(result.hasHiddenEntries).toBe(true);
    expect(result.visibleEntries.map((entry) => entry.rowId)).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-child"),
    ]);
  });

  it("reveals the active row and its ancestor chain when it falls below the preview", () => {
    const entries = [
      {
        rowId: ThreadId.makeUnsafe("thread-parent"),
        rootRowId: ThreadId.makeUnsafe("thread-parent"),
      },
      {
        rowId: ThreadId.makeUnsafe("thread-child"),
        rootRowId: ThreadId.makeUnsafe("thread-parent"),
      },
      {
        rowId: ThreadId.makeUnsafe("thread-second-root"),
        rootRowId: ThreadId.makeUnsafe("thread-second-root"),
      },
      {
        rowId: ThreadId.makeUnsafe("thread-third-root"),
        rootRowId: ThreadId.makeUnsafe("thread-third-root"),
      },
    ];

    const result = getVisibleSidebarEntriesForPreview({
      entries,
      activeEntryId: ThreadId.makeUnsafe("thread-third-root"),
      previewLimit: 2,
    });

    expect(result.hasHiddenEntries).toBe(true);
    expect(result.visibleEntries.map((entry) => entry.rowId)).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-child"),
      ThreadId.makeUnsafe("thread-third-root"),
    ]);
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("flattens only the sidebar-visible threads in render order", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-1"), expanded: true }),
      makeProject({ id: ProjectId.makeUnsafe("project-2"), expanded: false }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        projectId: ProjectId.makeUnsafe("project-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:03:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-4"),
        projectId: ProjectId.makeUnsafe("project-2"),
        createdAt: "2026-03-09T10:04:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-5"),
        projectId: ProjectId.makeUnsafe("project-2"),
        createdAt: "2026-03-09T10:05:00.000Z",
      }),
    ];

    const visibleThreadIds = getVisibleSidebarThreadIds({
      projects,
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-4"),
      threadListExtraPagesByProjectId: new Map<ProjectId, number>(),
      previewLimit: 2,
      previewPageSize: 2,
      threadSortOrder: "created_at",
    });

    expect(visibleThreadIds).toEqual([
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });

  it("groups interleaved thread input by project before flattening", () => {
    const visibleThreadIds = getVisibleSidebarThreadIds({
      projects: [
        makeProject({ id: ProjectId.makeUnsafe("project-1"), expanded: true }),
        makeProject({ id: ProjectId.makeUnsafe("project-2"), expanded: true }),
      ],
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-project-2"),
          projectId: ProjectId.makeUnsafe("project-2"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-project-1-newer"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-project-1-older"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
      activeThreadId: undefined,
      threadListExtraPagesByProjectId: new Map<ProjectId, number>(),
      previewLimit: 10,
      previewPageSize: 5,
      threadSortOrder: "created_at",
    });

    expect(visibleThreadIds).toEqual([
      ThreadId.makeUnsafe("thread-project-1-newer"),
      ThreadId.makeUnsafe("thread-project-1-older"),
      ThreadId.makeUnsafe("thread-project-2"),
    ]);
  });

  it("reveals an active subagent without persistent expansion state", () => {
    const visibleThreadIds = getVisibleSidebarThreadIds({
      projects: [makeProject({ id: ProjectId.makeUnsafe("project-1"), expanded: true })],
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          projectId: ProjectId.makeUnsafe("project-1"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
      activeThreadId: ThreadId.makeUnsafe("thread-child"),
      threadListExtraPagesByProjectId: new Map<ProjectId, number>(),
      previewLimit: 6,
      previewPageSize: 5,
      threadSortOrder: "created_at",
    });

    expect(visibleThreadIds).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-child"),
      ThreadId.makeUnsafe("thread-other"),
    ]);
  });
});

describe("getNextVisibleSidebarThreadId", () => {
  const visibleThreadIds = [
    ThreadId.makeUnsafe("thread-1"),
    ThreadId.makeUnsafe("thread-2"),
    ThreadId.makeUnsafe("thread-3"),
  ];

  it("advances to the next visible thread and wraps at the end", () => {
    expect(
      getNextVisibleSidebarThreadId({
        visibleThreadIds,
        activeThreadId: ThreadId.makeUnsafe("thread-3"),
        direction: "forward",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-1"));
  });

  it("moves backward through the visible list and wraps at the start", () => {
    expect(
      getNextVisibleSidebarThreadId({
        visibleThreadIds,
        activeThreadId: ThreadId.makeUnsafe("thread-1"),
        direction: "backward",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-3"));
  });
});

describe("getSidebarThreadIdForJumpCommand", () => {
  const visibleThreadIds = [
    ThreadId.makeUnsafe("thread-1"),
    ThreadId.makeUnsafe("thread-2"),
    ThreadId.makeUnsafe("thread-3"),
  ];

  it("resolves numbered jump commands against the visible sidebar order", () => {
    expect(
      getSidebarThreadIdForJumpCommand({
        visibleThreadIds,
        command: "thread.jump.2",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-2"));
  });

  it("returns null when a jump command points past the visible rows", () => {
    expect(
      getSidebarThreadIdForJumpCommand({
        visibleThreadIds,
        command: "thread.jump.9",
      }),
    ).toBeNull();
  });
});

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns the first visible sidebar rows up to the requested limit", () => {
    expect(
      getSidebarThreadIdsToPrewarm({
        visibleThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
        ],
        limit: 2,
      }),
    ).toEqual([ThreadId.makeUnsafe("thread-1"), ThreadId.makeUnsafe("thread-2")]);
  });

  it("prioritizes the active thread neighborhood before filling the limit", () => {
    expect(
      getSidebarThreadIdsToPrewarm({
        visibleThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
          ThreadId.makeUnsafe("thread-4"),
          ThreadId.makeUnsafe("thread-5"),
          ThreadId.makeUnsafe("thread-6"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-5"),
        limit: 5,
        neighborRadius: 1,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-4"),
      ThreadId.makeUnsafe("thread-5"),
      ThreadId.makeUnsafe("thread-6"),
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });
});

describe("createSidebarThreadHoverAnchorId", () => {
  it("keeps duplicated thread rows addressable by sidebar surface", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    expect(createSidebarThreadHoverAnchorId({ scope: "pinned", threadId })).toBe("pinned:thread-1");
    expect(createSidebarThreadHoverAnchorId({ scope: "chat", threadId })).toBe("chat:thread-1");
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.makeUnsafe("project-1"),
    kind: "project",
    name: "Project",
    remoteName: "Project",
    folderName: "project",
    localName: null,
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    expanded: true,
    spaceId: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeSidebarThreadSummary(
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

describe("partitionSidebarThreadsByProjectIds", () => {
  it("splits Studio threads from the regular Threads surface by project id", () => {
    const projectThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-project"),
      projectId: ProjectId.makeUnsafe("project-app"),
    });
    const studioThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-studio"),
      projectId: ProjectId.makeUnsafe("project-studio"),
    });

    const partitioned = partitionSidebarThreadsByProjectIds(
      [projectThread, studioThread],
      new Set([ProjectId.makeUnsafe("project-studio")]),
    );

    expect(partitioned.nonStudioThreads.map((thread) => thread.id)).toEqual(["thread-project"]);
    expect(partitioned.studioThreads.map((thread) => thread.id)).toEqual(["thread-studio"]);
  });
});

describe("deriveSidebarProjectData", () => {
  it("keeps pinned threads in the total project thread count", () => {
    const project = makeProject();
    const pinnedThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-pinned"),
      title: "Pinned",
    });
    const unpinnedThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-unpinned"),
      title: "Unpinned",
      createdAt: "2026-03-09T10:05:00.000Z",
      updatedAt: "2026-03-09T10:05:00.000Z",
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([
        pinnedThread,
        unpinnedThread,
      ]),
      pinnedThreadIds: [pinnedThread.id],
      threadListExtraPagesByProjectCwd: new Map(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: undefined,
      previewLimit: 5,
      previewPageSize: 5,
    });

    expect(data.get(project.id)).toMatchObject({
      allProjectThreadCount: 2,
      orderedProjectThreadIds: [unpinnedThread.id],
    });
  });

  it("shows split member threads as normal project rows", () => {
    const project = makeProject();
    const sourceThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-source"),
      title: "Source",
    });
    const droppedThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-dropped"),
      title: "Dropped",
      createdAt: "2026-03-09T10:05:00.000Z",
      updatedAt: "2026-03-09T10:05:00.000Z",
    });
    const standaloneThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-standalone"),
      title: "Standalone",
      createdAt: "2026-03-09T10:10:00.000Z",
      updatedAt: "2026-03-09T10:10:00.000Z",
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([
        sourceThread,
        droppedThread,
        standaloneThread,
      ]),
      pinnedThreadIds: [],
      threadListExtraPagesByProjectCwd: new Map(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: undefined,
      previewLimit: 5,
      previewPageSize: 5,
    });

    expect(data.get(project.id)?.visibleEntries).toEqual([
      expect.objectContaining({ kind: "thread", rowId: sourceThread.id }),
      expect.objectContaining({ kind: "thread", rowId: droppedThread.id }),
      expect.objectContaining({ kind: "thread", rowId: standaloneThread.id }),
    ]);
  });

  it("keeps the active thread visible when its project is collapsed", () => {
    const project = makeProject({ expanded: false });
    const threadOne = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-1"),
      title: "One",
    });
    const threadTwo = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-2"),
      title: "Two",
      createdAt: "2026-03-09T10:01:00.000Z",
      updatedAt: "2026-03-09T10:01:00.000Z",
    });
    const threadThree = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-3"),
      title: "Three",
      createdAt: "2026-03-09T10:02:00.000Z",
      updatedAt: "2026-03-09T10:02:00.000Z",
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([
        threadOne,
        threadTwo,
        threadThree,
      ]),
      pinnedThreadIds: [],
      threadListExtraPagesByProjectCwd: new Map(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: threadThree.id,
      previewLimit: 1,
      previewPageSize: 1,
    });

    expect(data.get(project.id)).toMatchObject({
      activeEntryId: threadThree.id,
      visibleEntries: [
        expect.objectContaining({
          kind: "thread",
          rowId: threadThree.id,
        }),
      ],
    });
  });

  it("uses the provided thread-status resolver for project status", () => {
    const project = makeProject();
    const threadOne = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-1"),
      title: "One",
      hasPendingApprovals: true,
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([threadOne]),
      pinnedThreadIds: [],
      threadListExtraPagesByProjectCwd: new Map(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: undefined,
      previewLimit: 5,
      previewPageSize: 5,
      resolveThreadStatus: () => null,
    });

    expect(data.get(project.id)?.projectStatus).toBeNull();
  });

  it("pages the thread preview five rows at a time and clamps stale paging", () => {
    const project = makeProject({ cwd: "/Users/tester/Code/demo" });
    const threads = Array.from({ length: 12 }, (_, index) =>
      makeSidebarThreadSummary({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
        createdAt: `2026-03-09T10:${String(index).padStart(2, "0")}:00.000Z`,
        updatedAt: `2026-03-09T10:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const derive = (requestedExtraPages: number) =>
      deriveSidebarProjectData({
        projects: [project],
        sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId(threads),
        pinnedThreadIds: [],
        threadListExtraPagesByProjectCwd: new Map([[project.cwd, requestedExtraPages]]),
        normalizeProjectCwd: (cwd) => cwd,
        activeSidebarThreadId: undefined,
        previewLimit: 5,
        previewPageSize: 5,
      }).get(project.id);

    expect(derive(0)).toMatchObject({
      threadListExtraPages: 0,
      canShowMoreThreads: true,
      canShowLessThreads: false,
    });
    expect(derive(0)?.visibleEntries).toHaveLength(5);

    expect(derive(1)).toMatchObject({
      threadListExtraPages: 1,
      canShowMoreThreads: true,
      canShowLessThreads: true,
    });
    expect(derive(1)?.visibleEntries).toHaveLength(10);

    // Stale persisted paging beyond the real thread count clamps to the last useful page.
    expect(derive(7)).toMatchObject({
      threadListExtraPages: 2,
      canShowMoreThreads: false,
      canShowLessThreads: true,
    });
    expect(derive(7)?.visibleEntries).toHaveLength(12);
  });
});

describe("sortThreadsForSidebar", () => {
  it("sorts threads by the latest user message in recency mode", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "older",
              createdAt: "2026-03-09T10:01:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:01:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [
            {
              id: "message-2" as never,
              role: "user",
              text: "newer",
              createdAt: "2026-03-09T10:06:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:06:00.000Z",
            },
          ],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("falls back to thread timestamps when there is no user message", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:01:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "assistant",
              text: "assistant only",
              createdAt: "2026-03-09T10:02:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:02:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("falls back to id ordering when threads have no sortable timestamps", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("can sort threads by createdAt when configured", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
        }),
      ],
      "created_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });

  it("floats a finished thread the user has not opened above newer threads", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-finished"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:05:00.000Z" }),
          lastVisitedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-finished"),
      ThreadId.makeUnsafe("thread-newer"),
    ]);
  });

  it("returns an opened finished thread to plain timestamp order", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-finished"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:05:00.000Z" }),
          lastVisitedAt: "2026-03-09T10:06:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-newer"),
      ThreadId.makeUnsafe("thread-finished"),
    ]);
  });

  it("floats live threads above unseen finished, and unseen finished above plain", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest-plain"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        {
          ...makeThread({
            id: ThreadId.makeUnsafe("thread-working"),
            createdAt: "2026-03-09T09:00:00.000Z",
            updatedAt: "2026-03-09T09:00:00.000Z",
          }),
          hasLiveTailWork: true,
        },
        makeThread({
          id: ThreadId.makeUnsafe("thread-finished"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:05:00.000Z" }),
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-working"),
      ThreadId.makeUnsafe("thread-finished"),
      ThreadId.makeUnsafe("thread-newest-plain"),
    ]);
  });

  it("treats a running session with no settled turn as live", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-running"),
          createdAt: "2026-03-09T09:00:00.000Z",
          updatedAt: "2026-03-09T09:00:00.000Z",
          session: {
            provider: "codex" as const,
            status: "running" as const,
            createdAt: "2026-03-09T09:00:00.000Z",
            updatedAt: "2026-03-09T09:00:00.000Z",
            orchestrationStatus: "running" as const,
          },
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-running"),
      ThreadId.makeUnsafe("thread-newer"),
    ]);
  });
});

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-oldest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other-project"),
          projectId: ProjectId.makeUnsafe("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-next"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      deletedThreadIds: new Set([
        ThreadId.makeUnsafe("thread-active"),
        ThreadId.makeUnsafe("thread-newest"),
      ]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-next"));
  });
});

describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-1"), name: "Older project" }),
      makeProject({ id: ProjectId.makeUnsafe("project-2"), name: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.makeUnsafe("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            createdAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:01:00.000Z",
          },
        ],
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        projectId: ProjectId.makeUnsafe("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            createdAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:05:00.000Z",
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Beta",
          createdAt: undefined,
          updatedAt: undefined,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Alpha",
          createdAt: undefined,
          updatedAt: undefined,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-1"),
      ProjectId.makeUnsafe("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-2"), name: "Second" }),
      makeProject({ id: ProjectId.makeUnsafe("project-1"), name: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});
