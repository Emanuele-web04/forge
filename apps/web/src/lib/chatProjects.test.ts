// FILE: chatProjects.test.ts
// Purpose: Verifies home chat-container project recognition across new and legacy roots.

import { ProjectId, type OrchestrationShellSnapshot } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import { ensureHomeChatProject, isHomeChatContainerProject } from "./chatProjects";
import { PROJECT_SNAPSHOT_HYDRATION_TIMEOUT_MS } from "./projectSnapshotHydration";

const NOW = "2026-06-26T21:00:00.000Z";

function makeShellProject(
  overrides: Partial<OrchestrationShellSnapshot["projects"][number]> = {},
): OrchestrationShellSnapshot["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-home-existing"),
    kind: "chat",
    title: "Home",
    workspaceRoot: "/Users/tester",
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeShellSnapshot(
  projects: OrchestrationShellSnapshot["projects"],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    spaces: [],
    projects,
    threads: [],
    updatedAt: NOW,
  };
}

beforeEach(() => {
  // ensureHomeChatProject waits for the first shell snapshot before deciding to create.
  useStore.setState({ threadsHydrated: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useStore.setState({
    projects: [],
    threadIds: [],
    threadShellById: {},
  });
});

describe("isHomeChatContainerProject", () => {
  it("matches the managed Documents/Synara general-chat root used by older drafts", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara",
          kind: "chat",
          name: "Home",
          remoteName: "Home",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(true);
  });

  it("matches Codex-style date/slug chat workspaces under Documents/Synara", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara/2026-06-11/yes-it-takes-all-the-skills",
          kind: "chat",
          name: "Yes it takes",
          remoteName: "Yes it takes",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(true);
  });

  it("keeps recognizing the legacy home-directory chat container during migration", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester",
          kind: "chat",
          name: "Home",
          remoteName: "Home",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(true);
  });

  it("trusts the chat kind before any server workspace path resolves", () => {
    // Boot window: neither homeDir nor chatWorkspaceRoot known yet — the kind alone decides,
    // mirroring isStudioContainerProject, so chat rows aren't mis-partitioned during startup.
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara/2026-06-11/some-chat",
          kind: "chat",
          name: "Some chat",
          remoteName: "Some chat",
        },
        { homeDir: null },
      ),
    ).toBe(true);
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Developer/app",
          kind: "project",
          name: "App",
          remoteName: "App",
        },
        { homeDir: null },
      ),
    ).toBe(false);
  });

  it("does not classify ordinary projects under Documents/Synara as home chat containers", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara",
          kind: "project",
          name: "Synara",
          remoteName: "Synara",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(false);
  });

  it("does not classify ordinary projects under date/slug chat folders", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara/2026-06-11/yes-it-takes-all-the-skills",
          kind: "project",
          name: "yes-it-takes-all-the-skills",
          remoteName: "yes-it-takes-all-the-skills",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(false);
  });

  it("waits for the shell snapshot before creating a Home chat project", async () => {
    const dispatchCommand = vi.fn(async (_command: { type: string }) => {});
    vi.stubGlobal("window", {
      nativeApi: { orchestration: { dispatchCommand, getShellSnapshot: vi.fn() } },
    });
    useStore.setState({ projects: [], threadsHydrated: false });

    const projectPromise = ensureHomeChatProject({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
    });
    await Promise.resolve();

    expect(dispatchCommand).not.toHaveBeenCalled();

    // Hydration reveals an already-persisted container: no duplicate create is dispatched.
    const existingProject = {
      id: ProjectId.makeUnsafe("project-home-hydrated"),
      kind: "chat" as const,
      name: "Home",
      remoteName: "Home",
      folderName: "Home",
      localName: null,
      cwd: "/Users/tester",
      defaultModelSelection: null,
      expanded: false,
      scripts: [],
    };
    useStore.setState({ projects: [existingProject], threadsHydrated: true });

    await expect(projectPromise).resolves.toBe(existingProject.id);
    expect(dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "project.create" }),
    );
  });

  it("gives up and returns null without dispatching once the hydration wait times out", async () => {
    vi.useFakeTimers();
    try {
      const dispatchCommand = vi.fn(async (_command: { type: string }) => {});
      vi.stubGlobal("window", {
        nativeApi: { orchestration: { dispatchCommand, getShellSnapshot: vi.fn() } },
      });
      useStore.setState({ projects: [], threadsHydrated: false });

      const projectPromise = ensureHomeChatProject({
        homeDir: "/Users/tester",
        chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      });

      await vi.advanceTimersByTimeAsync(PROJECT_SNAPSHOT_HYDRATION_TIMEOUT_MS);

      await expect(projectPromise).resolves.toBeNull();
      expect(dispatchCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates concurrent Home chat creation requests while hydration is pending", async () => {
    const dispatchCommand = vi.fn(async (_command: { type: string }) => {});
    vi.stubGlobal("window", {
      nativeApi: { orchestration: { dispatchCommand, getShellSnapshot: vi.fn() } },
    });
    useStore.setState({ projects: [], threadsHydrated: false });

    const paths = {
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
    };
    const firstProjectPromise = ensureHomeChatProject(paths);
    const secondProjectPromise = ensureHomeChatProject(paths);
    await Promise.resolve();

    expect(dispatchCommand).not.toHaveBeenCalled();

    useStore.setState({ projects: [], threadsHydrated: true });
    const [firstProjectId, secondProjectId] = await Promise.all([
      firstProjectPromise,
      secondProjectPromise,
    ]);

    expect(firstProjectId).toBe(secondProjectId);
    const createCommands = dispatchCommand.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "project.create");
    expect(createCommands).toHaveLength(1);
    expect(createCommands[0]).toMatchObject({ type: "project.create", kind: "chat" });
  });

  it("recovers a stale duplicate when the snapshot shows an existing Home chat container", async () => {
    const existingProjectId = ProjectId.makeUnsafe("project-home-existing");
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.create") {
        throw new Error(
          `Orchestration command invariant failed (project.create): Project '${existingProjectId}' already uses workspace root '/Users/tester'.`,
        );
      }
    });
    const getShellSnapshot = vi.fn(async () =>
      makeShellSnapshot([makeShellProject({ id: existingProjectId })]),
    );
    vi.stubGlobal("window", {
      nativeApi: {
        orchestration: {
          dispatchCommand,
          getShellSnapshot,
        },
      },
    });

    const projectId = await ensureHomeChatProject({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
    });

    expect(projectId).toBe(existingProjectId);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.create",
        kind: "chat",
        workspaceRoot: "/Users/tester",
      }),
    );
    expect(dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.meta.update",
      }),
    );
  });

  it("normalizes a recognizable legacy Home duplicate before returning it", async () => {
    const existingProjectId = ProjectId.makeUnsafe("project-home-existing");
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.create") {
        throw new Error(
          `Orchestration command invariant failed (project.create): Project '${existingProjectId}' already uses workspace root '/Users/tester'.`,
        );
      }
    });
    const getShellSnapshot = vi.fn(async () =>
      makeShellSnapshot([
        makeShellProject({
          id: existingProjectId,
          kind: "project",
          title: "Home",
        }),
      ]),
    );
    vi.stubGlobal("window", {
      nativeApi: {
        orchestration: {
          dispatchCommand,
          getShellSnapshot,
        },
      },
    });

    const projectId = await ensureHomeChatProject({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
    });

    expect(projectId).toBe(existingProjectId);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.meta.update",
        projectId: existingProjectId,
        kind: "chat",
        title: "Home",
      }),
    );
  });

  it("does not convert an ordinary duplicate home-folder project into Home chat", async () => {
    const existingProjectId = ProjectId.makeUnsafe("project-home-existing");
    const duplicateError = new Error(
      `Orchestration command invariant failed (project.create): Project '${existingProjectId}' already uses workspace root '/Users/tester'.`,
    );
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.create") {
        throw duplicateError;
      }
    });
    const getShellSnapshot = vi.fn(async () =>
      makeShellSnapshot([
        makeShellProject({
          id: existingProjectId,
          kind: "project",
          title: "tester",
        }),
      ]),
    );
    vi.stubGlobal("window", {
      nativeApi: {
        orchestration: {
          dispatchCommand,
          getShellSnapshot,
        },
      },
    });

    await expect(
      ensureHomeChatProject({
        homeDir: "/Users/tester",
        chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      }),
    ).rejects.toThrow(duplicateError.message);
    expect(dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.meta.update",
      }),
    );
  });
});
