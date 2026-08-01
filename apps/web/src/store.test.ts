// FILE: store.test.ts
// Purpose: Exercises the public store facade, persistence, and simple UI actions.

import {
  ProjectId,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  applySpaceOrder,
  collapseProjectsExcept,
  markThreadUnread,
  renameProjectLocally,
  reorderProjects,
  setThreadWorkspace,
  setAllProjectsExpanded,
  syncServerReadModel,
  useStore,
} from "./store";
import type { AppState } from "./storeState";
import type { Space } from "./types";
import {
  makeThread,
  makeState,
  makeStoreState,
  makeProject,
  makeReadModelThread,
  makeReadModel,
  makeReadModelProject,
  threadsOf,
} from "./storeTestFixtures";

describe("store facade", () => {
  it("frees a batch of thread details in a single store write", () => {
    // Dropping several leases at once must not cost one update per thread: every
    // update re-runs the retention reconcile that decides what to evict next.
    const first = ThreadId.makeUnsafe("thread-batch-1");
    const second = ThreadId.makeUnsafe("thread-batch-2");
    const kept = ThreadId.makeUnsafe("thread-batch-kept");
    const initialState = useStore.getState();
    useStore.setState(
      makeStoreState({
        messageIdsByThreadId: { [first]: [], [second]: [], [kept]: [] },
        messageByThreadId: { [first]: {}, [second]: {}, [kept]: {} },
      }),
    );

    const updates = vi.fn();
    const unsubscribe = useStore.subscribe(updates);
    try {
      useStore.getState().evictThreadDetails([first, second]);
    } finally {
      unsubscribe();
    }

    const state = useStore.getState();
    expect(updates).toHaveBeenCalledTimes(1);
    expect(state.messageByThreadId?.[first]).toBeUndefined();
    expect(state.messageByThreadId?.[second]).toBeUndefined();
    expect(state.messageByThreadId?.[kept]).toBeDefined();

    useStore.setState(initialState);
  });

  it("applies a Space order immediately for optimistic drag feedback", () => {
    const workSpaceId = SpaceId.makeUnsafe("space-work");
    const sideSpaceId = SpaceId.makeUnsafe("space-side");
    const spaces: Space[] = [
      {
        id: workSpaceId,
        name: "Work",
        icon: "bag",
        sortOrder: 0,
        createdAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:00:00.000Z",
      },
      {
        id: sideSpaceId,
        name: "Side",
        icon: "rocket",
        sortOrder: 1,
        createdAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:00:00.000Z",
      },
    ];
    const state = makeStoreState({ spaces });

    const reordered = applySpaceOrder(state, [sideSpaceId, workSpaceId]);

    expect(reordered.spaces.map((space) => space.id)).toEqual([sideSpaceId, workSpaceId]);
    expect(reordered.spaces.map((space) => space.sortOrder)).toEqual([0, 1]);
  });

  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = threadsOf(next)[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });

  it("does not regress a semantic branch when local workspace patches only report a temp branch", () => {
    const state = makeState(
      makeThread({
        branch: "feature/semantic-branch",
      }),
    );

    const next = setThreadWorkspace(state, ThreadId.makeUnsafe("thread-1"), {
      branch: "synara/abc123ef",
    });

    expect(threadsOf(next)[0]?.branch).toBe("feature/semantic-branch");
  });

  it("preserves optimistic createBranchFlowCompleted during stale read-model syncs", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const optimisticState = setThreadWorkspace(
      makeState(
        makeThread({
          envMode: "worktree",
          branch: "synara/tmp-working",
          worktreePath: "/tmp/project/.worktrees/tmp-working",
          associatedWorktreePath: "/tmp/project/.worktrees/tmp-working",
          associatedWorktreeBranch: "synara/tmp-working",
          associatedWorktreeRef: "synara/tmp-working",
        }),
      ),
      threadId,
      {
        createBranchFlowCompleted: true,
      },
    );

    const next = syncServerReadModel(
      optimisticState,
      makeReadModel(
        makeReadModelThread({
          envMode: "worktree",
          branch: "synara/tmp-working",
          worktreePath: "/tmp/project/.worktrees/tmp-working",
          associatedWorktreePath: "/tmp/project/.worktrees/tmp-working",
          associatedWorktreeBranch: "synara/tmp-working",
          associatedWorktreeRef: "synara/tmp-working",
          createBranchFlowCompleted: false,
          updatedAt: "2026-02-27T00:05:00.000Z",
        }),
      ),
    );

    expect(threadsOf(next)[0]?.createBranchFlowCompleted).toBe(true);
    expect(next.threadShellById?.[threadId]?.createBranchFlowCompleted).toBe(true);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const state: AppState = makeStoreState({
      spaces: [],
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
        makeProject({
          id: project3,
          name: "Project 3",
          remoteName: "Project 3",
          folderName: "project-3",
          cwd: "/tmp/project-3",
        }),
      ],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    });

    const next = reorderProjects(state, project1, project3);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project3, project1]);
  });

  it("expands every project when toggled on", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = makeStoreState({
      spaces: [],
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
          expanded: false,
        }),
      ],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    });

    const next = setAllProjectsExpanded(state, true);

    expect(next.projects.map(({ id, expanded }) => ({ id, expanded }))).toEqual([
      { id: project1, expanded: true },
      { id: project2, expanded: true },
    ]);
  });

  it("collapses all projects when toggled off", () => {
    const state: AppState = makeStoreState({
      spaces: [],
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
      ],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    });

    const next = setAllProjectsExpanded(state, false);

    expect(next.projects.every((project) => project.expanded === false)).toBe(true);
  });

  it("collapses every project except the active one", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = makeStoreState({
      spaces: [],
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
      ],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    });

    const next = collapseProjectsExcept(state, project2);

    expect(next.projects.map(({ id, expanded }) => ({ id, expanded }))).toEqual([
      { id: project1, expanded: false },
      { id: project2, expanded: true },
    ]);
  });

  it("renames a project locally without changing its remote or folder names", () => {
    const state = makeState(makeThread());

    const next = renameProjectLocally(state, ProjectId.makeUnsafe("project-1"), "synara");

    expect(next.projects[0]).toMatchObject({
      name: "synara",
      localName: "synara",
      remoteName: "Project",
      folderName: "project",
    });
  });

  it("preserves the current project order when syncing incoming read model updates", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = makeStoreState({
      spaces: [],
      projects: [
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
      ],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    });
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      spaces: [],
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project1, project3]);
  });

  it("preserves expanded project state when a project briefly disappears from the snapshot", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const initialState: AppState = makeStoreState({
      spaces: [],
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
      ],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    });

    const snapshotWithoutProject2: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      spaces: [],
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
      ],
      threads: [],
    };
    const snapshotWithProject2Restored: OrchestrationReadModel = {
      snapshotSequence: 3,
      updatedAt: "2026-02-27T00:01:00.000Z",
      spaces: [],
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
      ],
      threads: [],
    };

    const withoutProject2 = syncServerReadModel(initialState, snapshotWithoutProject2);
    const restored = syncServerReadModel(withoutProject2, snapshotWithProject2Restored);

    expect(restored.projects.find((project) => project.id === project2)?.expanded).toBe(true);
  });

  it("preserves a local project alias across read model syncs", () => {
    const aliasedState = renameProjectLocally(
      makeState(makeThread()),
      ProjectId.makeUnsafe("project-1"),
      "synara",
    );

    const next = syncServerReadModel(
      aliasedState,
      makeReadModel(
        makeReadModelThread({
          updatedAt: "2026-02-28T00:00:00.000Z",
        }),
      ),
    );

    expect(next.projects[0]).toMatchObject({
      name: "synara",
      localName: "synara",
      remoteName: "Project",
      folderName: "project",
    });
  });

  it("keeps a cleared local project alias from reappearing during syncs", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
      addEventListener: vi.fn(),
    };
    storage.set(
      "synara:renderer-state:v8",
      JSON.stringify({
        projectNamesByCwd: {
          "/tmp/project": "synara",
        },
      }),
    );
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const freshStore = await import("./store");
      const projectId = ProjectId.makeUnsafe("project-1");
      freshStore.useStore.setState(
        makeStoreState({
          projects: [
            makeProject({
              id: projectId,
              name: "synara",
              localName: "synara",
            }),
          ],
          threadsHydrated: true,
        }),
      );

      freshStore.useStore.getState().renameProjectLocally(projectId, null);

      const next = freshStore.syncServerReadModel(
        freshStore.useStore.getState(),
        makeReadModel(
          makeReadModelThread({
            updatedAt: "2026-02-28T00:00:00.000Z",
          }),
        ),
      );

      expect(next.projects[0]).toMatchObject({
        name: "Project",
        localName: null,
        remoteName: "Project",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("persists project aliases immediately when the local alias changes", async () => {
    const storage = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => {
      storage.set(key, value);
    });
    const fakeWindow = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
      addEventListener: vi.fn(),
    };
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const freshStore = await import("./store");
      const projectId = ProjectId.makeUnsafe("project-1");
      freshStore.useStore.setState(
        makeStoreState({
          projects: [
            makeProject({
              id: projectId,
              cwd: "/tmp/project",
            }),
          ],
          threadsHydrated: true,
        }),
      );

      freshStore.useStore.getState().renameProjectLocally(projectId, "synara");

      expect(setItem).toHaveBeenCalled();
      expect(JSON.parse(storage.get("synara:renderer-state:v8") ?? "{}")).toMatchObject({
        projectNamesByCwd: {
          "/tmp/project": "synara",
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
