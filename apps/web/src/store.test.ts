// FILE: store.test.ts
// Purpose: Exercises the public store facade, persistence, and simple UI actions.

import {
  ProjectId,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
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
  syncServerShellSnapshot,
  useStore,
} from "./store";
import type { AppState } from "./storeState";
import { PERSISTED_STATE_KEY } from "./storePersistence";
import {
  makeThread,
  makeState,
  makeProject,
  makeReadModelThread,
  makeReadModel,
  makeReadModelProject,
  makeFakeWindow,
  threadsOf,
} from "./storeTestFixtures";

const makeProjectsReadModel = (
  projects: OrchestrationReadModel["projects"],
): OrchestrationReadModel => ({
  snapshotSequence: 1,
  updatedAt: "2026-02-27T00:00:00.000Z",
  spaces: [],
  projects,
  threads: [],
});

describe("store facade", () => {
  it("frees a batch of thread details in a single store write", () => {
    // Dropping several leases at once must not cost one update per thread: every
    // update re-runs the retention reconcile that decides what to evict next.
    const first = ThreadId.makeUnsafe("thread-batch-1");
    const second = ThreadId.makeUnsafe("thread-batch-2");
    const kept = ThreadId.makeUnsafe("thread-batch-kept");
    const initialState = useStore.getState();
    useStore.setState({
      messageIdsByThreadId: { [first]: [], [second]: [], [kept]: [] },
      messageByThreadId: { [first]: {}, [second]: {}, [kept]: {} },
    });

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
    const state = makeState(makeThread());
    state.spaces = [
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
    const state: AppState = {
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
    };

    const next = reorderProjects(state, project1, project3);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project3, project1]);
  });

  it("expands every project when toggled on", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
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
    };

    const next = setAllProjectsExpanded(state, true);

    expect(next.projects.map(({ id, expanded }) => ({ id, expanded }))).toEqual([
      { id: project1, expanded: true },
      { id: project2, expanded: true },
    ]);
  });

  it("collapses all projects when toggled off", () => {
    const state: AppState = {
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
    };

    const next = setAllProjectsExpanded(state, false);

    expect(next.projects.every((project) => project.expanded === false)).toBe(true);
  });

  it("collapses every project except the active one", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
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
    };

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
    const initialState: AppState = {
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
    };
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
    const initialState: AppState = {
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
    };

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

  it("keeps the latest local expansion through read-model and shell reconnects", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const project = makeReadModelProject({
      id: projectId,
      workspaceRoot: "/tmp/project-1",
    });
    const readModel = makeProjectsReadModel([project]);
    const hydrated = syncServerReadModel(
      { ...useStore.getState(), projects: [], shellSnapshotSequence: 0 },
      readModel,
    );
    const locallyCollapsed = setAllProjectsExpanded(hydrated, false);

    const afterReadModel = syncServerReadModel(locallyCollapsed, {
      ...readModel,
      snapshotSequence: 2,
    });
    const shellSnapshot: OrchestrationShellSnapshot = {
      snapshotSequence: 3,
      updatedAt: readModel.updatedAt,
      spaces: [],
      projects: [project],
      threads: [],
    };
    const afterShell = syncServerShellSnapshot(afterReadModel, shellSnapshot);

    expect(afterReadModel.projects[0]?.expanded).toBe(false);
    expect(afterShell.projects[0]?.expanded).toBe(false);
  });

  it("treats a changed project cwd as a new expanded identity", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const collapsed = {
      ...useStore.getState(),
      projects: [
        makeProject({
          id: projectId,
          cwd: "/tmp/project-old",
          expanded: false,
        }),
      ],
      shellSnapshotSequence: 1,
      threadsHydrated: true,
    };
    const renamed = syncServerReadModel(
      collapsed,
      makeProjectsReadModel([
        makeReadModelProject({
          id: projectId,
          workspaceRoot: "/tmp/project-new",
        }),
      ]),
    );

    expect(renamed.projects[0]).toMatchObject({
      cwd: "/tmp/project-new",
      expanded: true,
    });
  });

  it("persists the latest expansion and reordered project list", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();
      const fresh = await import("./store");
      const project1 = ProjectId.makeUnsafe("project-1");
      const project2 = ProjectId.makeUnsafe("project-2");
      fresh.useStore
        .getState()
        .syncServerReadModel(
          makeProjectsReadModel([
            makeReadModelProject({ id: project1, workspaceRoot: "/tmp/project-1" }),
            makeReadModelProject({ id: project2, workspaceRoot: "/tmp/project-2" }),
          ]),
        );

      fresh.useStore.getState().setAllProjectsExpanded(false);
      fresh.useStore.getState().toggleProject(project1);
      fresh.useStore.getState().toggleProject(project1);
      fresh.useStore.getState().toggleProject(project2);
      fresh.useStore.getState().reorderProjects(project2, project1);
      fresh.persistAppStateNow();

      expect(JSON.parse(storage.get(PERSISTED_STATE_KEY) ?? "{}")).toMatchObject({
        expandedProjectCwds: ["/tmp/project-2"],
        projectOrderCwds: ["/tmp/project-2", "/tmp/project-1"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops stale remembered project state when a snapshot returns a different set", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();
      const fresh = await import("./store");
      const persistence = await import("./storePersistence");
      const project1 = ProjectId.makeUnsafe("project-1");
      const project2 = ProjectId.makeUnsafe("project-2");
      fresh.useStore
        .getState()
        .syncServerReadModel(
          makeProjectsReadModel([
            makeReadModelProject({ id: project1, workspaceRoot: "/tmp/project-1" }),
          ]),
        );
      fresh.useStore.getState().setProjectExpanded(project1, false);

      fresh.useStore.getState().syncServerReadModel({
        ...makeProjectsReadModel([
          makeReadModelProject({ id: project2, workspaceRoot: "/tmp/project-2" }),
        ]),
        snapshotSequence: 2,
      });

      const remembered = persistence.getRememberedProjectUiState();
      expect(remembered.projectOrderCount).toBe(1);
      expect(remembered.projectOrderIndexForCwd("/tmp/project-2")).toBe(0);
      expect(remembered.projectOrderIndexForCwd("/tmp/project-1")).toBeUndefined();
      expect(remembered.isProjectExpanded("/tmp/project-1")).toBe(false);
      const projects = fresh.useStore.getState().projects;
      expect(projects.map((project) => project.cwd)).toEqual(["/tmp/project-2"]);
      expect(projects[0]?.expanded).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
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
    const fakeWindow = makeFakeWindow(storage);
    storage.set(
      PERSISTED_STATE_KEY,
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
      freshStore.useStore.setState((state) => ({
        ...state,
        projects: [
          makeProject({
            id: projectId,
            name: "synara",
            localName: "synara",
          }),
        ],
        sidebarThreadSummaryById: {},
        threadsHydrated: true,
      }));

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
    const fakeWindow = makeFakeWindow(storage);
    const setItem = fakeWindow.localStorage.setItem;
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const freshStore = await import("./store");
      const projectId = ProjectId.makeUnsafe("project-1");
      freshStore.useStore.setState((state) => ({
        ...state,
        projects: [
          makeProject({
            id: projectId,
            cwd: "/tmp/project",
          }),
        ],
        sidebarThreadSummaryById: {},
        threadsHydrated: true,
      }));

      freshStore.useStore.getState().renameProjectLocally(projectId, "synara");

      expect(setItem).toHaveBeenCalled();
      expect(JSON.parse(storage.get(PERSISTED_STATE_KEY) ?? "{}")).toMatchObject({
        projectNamesByCwd: {
          "/tmp/project": "synara",
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves all-collapsed state across a full reload and defaults unknown projects to expanded", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    const setItem = fakeWindow.localStorage.setItem;
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const fresh = await import("./store");
      const project1 = ProjectId.makeUnsafe("project-1");
      const project2 = ProjectId.makeUnsafe("project-2");
      const readModel = makeProjectsReadModel([
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
      ]);

      fresh.useStore.getState().syncServerReadModel(readModel);
      fresh.useStore.getState().setAllProjectsExpanded(false);
      fresh.persistAppStateNow();

      const saved = JSON.parse(storage.get(PERSISTED_STATE_KEY) ?? "{}");
      expect(saved.expandedProjectCwds).toEqual([]);
      expect(saved.projectOrderCwds).toEqual(["/tmp/project-1", "/tmp/project-2"]);
      expect(setItem).toHaveBeenCalled();

      vi.resetModules();

      const reloaded = await import("./store");
      const project3 = ProjectId.makeUnsafe("project-3");
      reloaded.useStore.getState().syncServerReadModel(
        makeProjectsReadModel([
          ...readModel.projects,
          makeReadModelProject({
            id: project3,
            title: "Project 3",
            workspaceRoot: "/tmp/project-3",
          }),
        ]),
      );
      expect(
        reloaded.useStore.getState().projects.map(({ id, expanded }) => ({ id, expanded })),
      ).toEqual([
        { id: project1, expanded: false },
        { id: project2, expanded: false },
        { id: project3, expanded: true },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15000);

  it("preserves a legacy all-collapsed payload through the first sync after reload", async () => {
    const storage = new Map<string, string>();
    storage.set(PERSISTED_STATE_KEY, JSON.stringify({ expandedProjectCwds: [] }));
    vi.stubGlobal("window", makeFakeWindow(storage));
    try {
      vi.resetModules();

      const reloaded = await import("./store");
      const project1 = ProjectId.makeUnsafe("project-1");
      const project2 = ProjectId.makeUnsafe("project-2");
      reloaded.useStore.getState().syncServerReadModel(
        makeProjectsReadModel([
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
        ]),
      );
      expect(
        reloaded.useStore.getState().projects.map(({ id, expanded }) => ({ id, expanded })),
      ).toEqual([
        { id: project1, expanded: false },
        { id: project2, expanded: false },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15000);

  it("preserves mixed expansion state across a full reload", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const fresh = await import("./store");
      const project1 = ProjectId.makeUnsafe("project-1");
      const project2 = ProjectId.makeUnsafe("project-2");
      const readModel = makeProjectsReadModel([
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
      ]);

      fresh.useStore.getState().syncServerReadModel(readModel);
      fresh.useStore.getState().setAllProjectsExpanded(false);
      fresh.useStore.getState().toggleProject(project1);
      fresh.persistAppStateNow();

      const saved = JSON.parse(storage.get(PERSISTED_STATE_KEY) ?? "{}");
      expect(saved.expandedProjectCwds).toEqual(["/tmp/project-1"]);
      expect(saved.projectOrderCwds).toEqual(["/tmp/project-1", "/tmp/project-2"]);

      vi.resetModules();

      const reloaded = await import("./store");
      reloaded.useStore.getState().syncServerReadModel(readModel);
      expect(
        reloaded.useStore.getState().projects.map(({ id, expanded }) => ({ id, expanded })),
      ).toEqual([
        { id: project1, expanded: true },
        { id: project2, expanded: false },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15000);

  it("keeps a project's local alias and resets expansion when its workspace root changes", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const fresh = await import("./store");
      const project1 = ProjectId.makeUnsafe("project-1");
      fresh.useStore.getState().syncServerReadModel(
        makeProjectsReadModel([
          makeReadModelProject({
            id: project1,
            title: "Project 1",
            workspaceRoot: "/tmp/project-1",
          }),
        ]),
      );
      fresh.useStore.getState().renameProjectLocally(project1, "alpha");
      fresh.useStore.getState().setAllProjectsExpanded(false);
      fresh.persistAppStateNow();

      fresh.useStore.getState().syncServerReadModel(
        makeProjectsReadModel([
          makeReadModelProject({
            id: project1,
            title: "Project 1",
            workspaceRoot: "/tmp/project-1-moved",
          }),
        ]),
      );

      const moved = fresh.useStore.getState().projects[0];
      expect(moved).toBeDefined();
      expect(moved?.cwd).toBe("/tmp/project-1-moved");
      expect(moved?.localName).toBe("alpha");
      expect(moved?.expanded).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15000);

  it("removes a deleted project's local alias from persisted projectNamesByCwd", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const fresh = await import("./store");
      const { getRememberedProjectUiState } = await import("./storePersistence");
      const project1 = ProjectId.makeUnsafe("project-1");
      const project2 = ProjectId.makeUnsafe("project-2");
      const readModel = makeProjectsReadModel([
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
      ]);

      fresh.useStore.getState().syncServerReadModel(readModel);
      fresh.useStore.getState().renameProjectLocally(project1, "alpha");
      fresh.useStore.getState().renameProjectLocally(project2, "beta");

      fresh.useStore.getState().removeDeletedProjectFromClientState(project2);
      expect(getRememberedProjectUiState().projectNameForCwd("/tmp/project-2")).toBeUndefined();
      fresh.persistAppStateNow();

      const saved = JSON.parse(storage.get(PERSISTED_STATE_KEY) ?? "{}");
      expect(saved.projectNamesByCwd).toEqual({ "/tmp/project-1": "alpha" });
      expect(saved.projectNamesByCwd).not.toHaveProperty("/tmp/project-2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not persist project UI before thread hydration", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = makeFakeWindow(storage);
    const setItem = fakeWindow.localStorage.setItem;
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const fresh = await import("./store");
      const projectId = ProjectId.makeUnsafe("project-1");
      fresh.useStore.setState((state) => ({
        ...state,
        projects: [makeProject({ id: projectId, cwd: "/tmp/project" })],
      }));

      fresh.persistAppStateNow();

      expect(setItem).not.toHaveBeenCalled();
      expect(storage.has(PERSISTED_STATE_KEY)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["read-model", "shell"] as const)(
    "%s snapshots forget removed project preferences before the cwd returns",
    async (kind) => {
      vi.stubGlobal("window", makeFakeWindow(new Map()));
      try {
        vi.resetModules();
        const fresh = await import("./store");
        const { getRememberedProjectUiState } = await import("./storePersistence");
        const first = makeReadModelProject({ workspaceRoot: "/tmp/removed" });
        const kept = makeReadModelProject({
          id: ProjectId.makeUnsafe("kept"),
          workspaceRoot: "/tmp/kept",
        });
        const sync = (projects: OrchestrationReadModel["projects"], sequence: number) => {
          const snapshot = { ...makeProjectsReadModel(projects), snapshotSequence: sequence };
          if (kind === "shell") fresh.useStore.getState().syncServerShellSnapshot(snapshot);
          else fresh.useStore.getState().syncServerReadModel(snapshot);
        };
        sync([first, kept], 1);
        fresh.useStore.getState().renameProjectLocally(first.id, "Old alias");
        fresh.useStore.getState().setProjectExpanded(first.id, false);
        sync([kept], 2);
        const remembered = getRememberedProjectUiState();
        expect(remembered.projectOrderIndexForCwd("/tmp/removed")).toBeUndefined();
        expect(remembered.projectNameForCwd("/tmp/removed")).toBeUndefined();
        sync([first, kept], 3);
        expect(fresh.useStore.getState().projects.map((project) => project.id)).toEqual([
          kept.id,
          first.id,
        ]);
        expect(fresh.useStore.getState().projects[1]).toMatchObject({
          expanded: true,
          localName: null,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["read-model", "shell"] as const)(
    "%s expires legacy expansion for an empty or known-disjoint project set",
    async (kind) => {
      for (const emptyFirst of [false, true]) {
        const storage = new Map<string, string>([
          [
            PERSISTED_STATE_KEY,
            JSON.stringify({
              expandedProjectCwds: emptyFirst ? [] : ["/tmp/old"],
            }),
          ],
        ]);
        vi.stubGlobal("window", makeFakeWindow(storage));
        try {
          vi.resetModules();
          const fresh = await import("./store");
          const sync = (projects: OrchestrationReadModel["projects"], sequence: number) => {
            const snapshot = { ...makeProjectsReadModel(projects), snapshotSequence: sequence };
            if (kind === "shell") fresh.useStore.getState().syncServerShellSnapshot(snapshot);
            else fresh.useStore.getState().syncServerReadModel(snapshot);
          };
          if (emptyFirst) sync([], 1);
          sync([makeReadModelProject({ workspaceRoot: "/tmp/unrelated" })], 2);
          expect(fresh.useStore.getState().projects[0]?.expanded).toBe(true);
        } finally {
          vi.unstubAllGlobals();
        }
      }
    },
  );

  it("normalizes trailing slashes across reload and remembers toggles before writing storage", async () => {
    const storage = new Map<string, string>([
      [
        PERSISTED_STATE_KEY,
        JSON.stringify({
          projectOrderCwds: ["/tmp/second/", "/tmp/first/"],
          expandedProjectCwds: ["/tmp/second/"],
          projectNamesByCwd: { "/tmp/first/": "Alias" },
        }),
      ],
    ]);
    const fakeWindow = makeFakeWindow(storage);
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();
      const fresh = await import("./store");
      const { getRememberedProjectUiState } = await import("./storePersistence");
      const first = makeReadModelProject({ workspaceRoot: "/tmp/first" });
      const second = makeReadModelProject({
        id: ProjectId.makeUnsafe("second"),
        workspaceRoot: "/tmp/second",
      });
      fresh.useStore.getState().syncServerReadModel(makeProjectsReadModel([first, second]));
      expect(fresh.useStore.getState().projects.map(({ id }) => id)).toEqual([second.id, first.id]);
      expect(fresh.useStore.getState().projects[1]).toMatchObject({
        expanded: false,
        localName: "Alias",
      });
      fakeWindow.localStorage.setItem.mockImplementation((key, value) => {
        expect(getRememberedProjectUiState().isProjectExpanded("/tmp/first")).toBe(true);
        storage.set(key, value);
      });
      fresh.useStore.getState().toggleProject(first.id);
      expect(getRememberedProjectUiState().isProjectExpanded("/tmp/first")).toBe(true);
      fresh.persistAppStateNow();
      expect(JSON.parse(storage.get(PERSISTED_STATE_KEY)!)).toMatchObject({
        projectOrderCwds: ["/tmp/second", "/tmp/first"],
        expandedProjectCwds: ["/tmp/second", "/tmp/first"],
        projectNamesByCwd: { "/tmp/first": "Alias" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps surviving persisted order ahead of unknown projects after reload pruning", async () => {
    const storage = new Map<string, string>([
      [
        PERSISTED_STATE_KEY,
        JSON.stringify({
          projectOrderCwds: ["/tmp/removed", "/tmp/kept"],
          expandedProjectCwds: [],
        }),
      ],
    ]);
    vi.stubGlobal("window", makeFakeWindow(storage));
    try {
      vi.resetModules();
      const fresh = await import("./store");
      fresh.useStore
        .getState()
        .syncServerReadModel(
          makeProjectsReadModel([
            makeReadModelProject({ workspaceRoot: "/tmp/new" }),
            makeReadModelProject({ id: ProjectId.makeUnsafe("kept"), workspaceRoot: "/tmp/kept" }),
          ]),
        );
      expect(
        fresh.useStore.getState().projects.map(({ cwd, expanded }) => ({ cwd, expanded })),
      ).toEqual([
        { cwd: "/tmp/kept", expanded: false },
        { cwd: "/tmp/new", expanded: true },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["read-model", "shell"] as const)(
    "%s pure projection consumes legacy state on the first sync without a subscriber",
    async (kind) => {
      const storage = new Map<string, string>([
        [PERSISTED_STATE_KEY, JSON.stringify({ expandedProjectCwds: [] })],
      ]);
      vi.stubGlobal("window", makeFakeWindow(storage));
      try {
        vi.resetModules();
        const fresh = await import("./store");
        const { initialState } = await import("./storeState");
        const { getRememberedProjectUiState } = await import("./storePersistence");
        const snapshot = makeProjectsReadModel([makeReadModelProject({})]);
        const sync = kind === "shell" ? fresh.syncServerShellSnapshot : fresh.syncServerReadModel;
        const next = sync(initialState, snapshot);
        expect(next.projects[0]?.expanded).toBe(false);
        expect(getRememberedProjectUiState().isLegacyExpansionPayload).toBe(false);
        expect(getRememberedProjectUiState().projectOrderCount).toBe(1);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
