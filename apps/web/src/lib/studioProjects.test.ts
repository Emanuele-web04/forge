// FILE: studioProjects.test.ts
// Purpose: Verifies hidden Studio container detection and creation dispatches.
// Layer: Web orchestration tests

import { type ProjectId, type ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import type { Project } from "../types";
import {
  ensureStudioProject,
  findStudioDraftThreadId,
  findStudioContainerProject,
  isStudioContainerProject,
} from "./studioProjects";
import { PROJECT_SNAPSHOT_HYDRATION_TIMEOUT_MS } from "./projectSnapshotHydration";

const nativeApiMock = vi.hoisted(() => ({
  dispatchedCommands: [] as unknown[],
  dispatchError: null as Error | null,
  shellSnapshotProjects: [] as unknown[],
  shellSnapshotProjectBatches: [] as unknown[][],
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: async (command: unknown) => {
        if (nativeApiMock.dispatchError) {
          throw nativeApiMock.dispatchError;
        }
        nativeApiMock.dispatchedCommands.push(command);
        // Mirror the real server: an accepted project.create shows up in later shell snapshots,
        // which the post-create sync in ensureStudioProject waits on before resolving.
        const typed = command as {
          type?: string;
          projectId?: string;
          kind?: string;
          title?: string;
          workspaceRoot?: string;
        };
        if (typed.type === "project.create") {
          nativeApiMock.shellSnapshotProjects.push({
            id: typed.projectId,
            kind: typed.kind,
            title: typed.title,
            workspaceRoot: typed.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            isPinned: false,
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
          });
        }
      },
      getShellSnapshot: async () => {
        const projects =
          nativeApiMock.shellSnapshotProjectBatches.length > 0
            ? nativeApiMock.shellSnapshotProjectBatches.shift()!
            : nativeApiMock.shellSnapshotProjects;
        return {
          spaces: [],
          projects,
          threads: [],
          snapshotSequence: 1,
          updatedAt: "2026-06-21T00:00:00.000Z",
        };
      },
    },
  }),
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-studio" as ProjectId,
    kind: "studio",
    name: "Studio",
    remoteName: "Studio",
    folderName: "Studio",
    localName: null,
    cwd: "/Users/tester/Documents/Synara/Studio",
    defaultModelSelection: null,
    expanded: false,
    spaceId: null,
    scripts: [],
    ...overrides,
  };
}

describe("studioProjects", () => {
  beforeEach(() => {
    nativeApiMock.dispatchedCommands = [];
    nativeApiMock.dispatchError = null;
    nativeApiMock.shellSnapshotProjects = [];
    nativeApiMock.shellSnapshotProjectBatches = [];
    useStore.setState({
      spaces: [],
      projects: [],
      sidebarThreadSummaryById: {},
      threadIds: [],
      threadShellById: {},
      threadsHydrated: true,
    });
  });

  it("matches the configured Studio root and nested Studio paths", () => {
    const paths = {
      homeDir: "/Users/tester",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    };

    expect(isStudioContainerProject(makeProject(), paths)).toBe(true);
    expect(
      isStudioContainerProject(
        makeProject({ cwd: "/Users/tester/Documents/Synara/Studio/Outbox" }),
        paths,
      ),
    ).toBe(true);
  });

  it("rejects non-Studio kinds and drifted roots, but trusts the kind before the root arrives", () => {
    expect(
      isStudioContainerProject(makeProject({ kind: "project" }), {
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).toBe(false);
    // A studio-kind container whose cwd drifted outside the configured root is orphaned.
    expect(
      isStudioContainerProject(makeProject({ cwd: "/Users/tester/Elsewhere" }), {
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).toBe(false);
    // Before the welcome delivers the Studio root, the kind alone identifies the container so
    // Studio threads aren't mis-partitioned during boot.
    expect(isStudioContainerProject(makeProject(), { homeDir: "/Users/tester" })).toBe(true);
  });

  it("finds an existing Studio container project", () => {
    const ordinaryProject = makeProject({
      id: "project-app" as ProjectId,
      kind: "project",
      name: "App",
      cwd: "/Users/tester/Developer/app",
    });
    const studioProject = makeProject();

    expect(
      findStudioContainerProject([ordinaryProject, studioProject], {
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).toBe(studioProject);
  });

  it("prefers the canonical Studio root container over nested studio-kind rows", () => {
    const nestedStudioProject = makeProject({
      id: "project-studio-nested" as ProjectId,
      cwd: "/Users/tester/Documents/Synara/Studio/Outbox",
    });
    const canonicalStudioProject = makeProject({ id: "project-studio-root" as ProjectId });

    // Store order must not decide which row backs new Studio chats.
    expect(
      findStudioContainerProject([nestedStudioProject, canonicalStudioProject], {
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).toBe(canonicalStudioProject);
  });

  it("prefers an unpromoted chat draft for the Studio container", () => {
    const studioProjectId = "project-studio" as ProjectId;
    const studioDraftThreadId = "thread-studio-draft" as ThreadId;

    expect(
      findStudioDraftThreadId({
        studioProjectIds: new Set([studioProjectId]),
        projectDraftThreadIdByProjectId: {
          [studioProjectId]: studioDraftThreadId,
        },
        draftThreadsByThreadId: {
          [studioDraftThreadId]: {
            projectId: studioProjectId,
            createdAt: "2026-06-21T00:00:00.000Z",
            runtimeMode: "approval-required",
            interactionMode: "default",
            entryPoint: "chat",
            branch: null,
            worktreePath: null,
            envMode: "local",
          },
        },
      }),
    ).toBe(studioDraftThreadId);
  });

  it("ignores promoted or non-chat Studio drafts", () => {
    const studioProjectId = "project-studio" as ProjectId;
    const promotedDraftThreadId = "thread-promoted-draft" as ThreadId;
    const terminalDraftThreadId = "thread-terminal-draft" as ThreadId;

    expect(
      findStudioDraftThreadId({
        studioProjectIds: new Set([studioProjectId]),
        projectDraftThreadIdByProjectId: {
          [studioProjectId]: promotedDraftThreadId,
        },
        draftThreadsByThreadId: {
          [promotedDraftThreadId]: {
            projectId: studioProjectId,
            createdAt: "2026-06-21T00:00:00.000Z",
            runtimeMode: "approval-required",
            interactionMode: "default",
            entryPoint: "chat",
            branch: null,
            worktreePath: null,
            envMode: "local",
            promotedTo: "thread-real" as ThreadId,
          },
          [terminalDraftThreadId]: {
            projectId: studioProjectId,
            createdAt: "2026-06-21T00:00:00.000Z",
            runtimeMode: "approval-required",
            interactionMode: "default",
            entryPoint: "terminal",
            branch: null,
            worktreePath: null,
            envMode: "local",
          },
        },
      }),
    ).toBeNull();
  });

  it("creates the hidden Studio project with the real Studio root", async () => {
    const projectId = await ensureStudioProject({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });

    expect(projectId).toBeTruthy();
    expect(nativeApiMock.dispatchedCommands).toHaveLength(1);
    expect(nativeApiMock.dispatchedCommands[0]).toMatchObject({
      type: "project.create",
      projectId,
      kind: "studio",
      title: "Studio",
      workspaceRoot: "/Users/tester/Documents/Synara/Studio",
      createWorkspaceRootIfMissing: true,
    });
  });

  it("reuses the existing Studio project without dispatching create", async () => {
    const existingProject = makeProject({ id: "project-existing-studio" as ProjectId });
    useStore.setState({ projects: [existingProject] });

    await expect(
      ensureStudioProject({
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).resolves.toBe(existingProject.id);
    expect(nativeApiMock.dispatchedCommands).toEqual([]);
  });

  it("waits for the shell snapshot before creating a Studio project", async () => {
    useStore.setState({ projects: [], threadsHydrated: false });

    const projectPromise = ensureStudioProject({
      homeDir: "/Users/tester",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });
    await Promise.resolve();

    expect(nativeApiMock.dispatchedCommands).toEqual([]);

    const existingProject = makeProject({ id: "project-hydrated-studio" as ProjectId });
    useStore.setState({ projects: [existingProject], threadsHydrated: true });

    await expect(projectPromise).resolves.toBe(existingProject.id);
    expect(nativeApiMock.dispatchedCommands).toEqual([]);
  });

  it("gives up and returns null without dispatching once the hydration wait times out", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ projects: [], threadsHydrated: false });

      const projectPromise = ensureStudioProject({
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      });

      await vi.advanceTimersByTimeAsync(PROJECT_SNAPSHOT_HYDRATION_TIMEOUT_MS);

      await expect(projectPromise).resolves.toBeNull();
      expect(nativeApiMock.dispatchedCommands).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates concurrent Studio creation requests while hydration is pending", async () => {
    useStore.setState({ projects: [], threadsHydrated: false });

    const firstProjectPromise = ensureStudioProject({
      homeDir: "/Users/tester",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });
    const secondProjectPromise = ensureStudioProject({
      homeDir: "/Users/tester",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });
    await Promise.resolve();

    expect(nativeApiMock.dispatchedCommands).toEqual([]);

    useStore.setState({ projects: [], threadsHydrated: true });
    const [firstProjectId, secondProjectId] = await Promise.all([
      firstProjectPromise,
      secondProjectPromise,
    ]);

    expect(firstProjectId).toBe(secondProjectId);
    expect(nativeApiMock.dispatchedCommands).toHaveLength(1);
    expect(nativeApiMock.dispatchedCommands[0]).toMatchObject({
      type: "project.create",
      projectId: firstProjectId,
      kind: "studio",
    });
  });

  it("hydrates a freshly created Studio container into the store before resolving", async () => {
    useStore.setState({ projects: [], threadsHydrated: true });

    const projectPromise = ensureStudioProject({
      homeDir: "/Users/tester",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });
    await vi.waitFor(() => {
      expect(nativeApiMock.dispatchedCommands).toHaveLength(1);
    });
    // The follow-up shell snapshot now includes the created container; ensureStudioProject must
    // sync it into the store before resolving so no consumer sees an unknown project id.
    const createCommand = nativeApiMock.dispatchedCommands[0] as { projectId: ProjectId };
    nativeApiMock.shellSnapshotProjects = [
      {
        id: createCommand.projectId,
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/Users/tester/Documents/Synara/Studio",
        defaultModelSelection: null,
        scripts: [],
        isPinned: false,
        createdAt: "2026-06-21T00:00:00.000Z",
        updatedAt: "2026-06-21T00:00:00.000Z",
      },
    ];

    await expect(projectPromise).resolves.toBe(createCommand.projectId);
    expect(
      useStore.getState().projects.some((project) => project.id === createCommand.projectId),
    ).toBe(true);
  });

  it("recovers and hydrates the existing Studio project when the server rejects a duplicate create", async () => {
    const existingProjectId = "project-server-studio" as ProjectId;
    nativeApiMock.dispatchError = new Error(
      "Orchestration command invariant failed (project.create): Project 'project-server-studio' already uses workspace root '/Users/tester/Documents/Synara/Studio'.",
    );
    nativeApiMock.shellSnapshotProjects = [
      {
        id: existingProjectId,
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/Users/tester/Documents/Synara/Studio",
        defaultModelSelection: null,
        scripts: [],
        isPinned: false,
        createdAt: "2026-06-21T00:00:00.000Z",
        updatedAt: "2026-06-21T00:00:00.000Z",
      },
    ];

    await expect(
      ensureStudioProject({
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).resolves.toBe(existingProjectId);
    expect(useStore.getState().projects).toMatchObject([
      {
        id: existingProjectId,
        kind: "studio",
        cwd: "/Users/tester/Documents/Synara/Studio",
      },
    ]);
  });

  it("retries duplicate Studio recovery while the shell snapshot catches up", async () => {
    const existingProjectId = "project-retried-studio" as ProjectId;
    nativeApiMock.dispatchError = new Error(
      "Orchestration command invariant failed (project.create): Project 'project-retried-studio' already uses workspace root '/Users/tester/Documents/Synara/Studio'.",
    );
    nativeApiMock.shellSnapshotProjectBatches = [
      [],
      [
        {
          id: existingProjectId,
          kind: "studio",
          title: "Studio",
          workspaceRoot: "/Users/tester/Documents/Synara/Studio",
          defaultModelSelection: null,
          scripts: [],
          isPinned: false,
          createdAt: "2026-06-21T00:00:00.000Z",
          updatedAt: "2026-06-21T00:00:00.000Z",
        },
      ],
    ];

    await expect(
      ensureStudioProject({
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).resolves.toBe(existingProjectId);
  });
});
