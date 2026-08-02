// FILE: useSidebarProjectRunController.test.ts
// Purpose: Characterizes Sidebar project-run lifecycle, attribution, and dialog behavior.
// Layer: Web hook tests

import { ProjectId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  let slots: HookSlot[] = [];
  let cursor = 0;
  const nextSlot = () => {
    const slot = (slots[cursor] ??= {});
    cursor += 1;
    return slot;
  };
  // Vitest requires helpers referenced by a hoisted factory to stay inside that factory.
  // oxlint-disable-next-line consistent-function-scoping
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    useCallback<T>(callback: T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = callback;
      }
      return slot.value as T;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = factory();
      }
      return slot.value as T;
    },
    useRef<T>(value: T) {
      const slot = nextSlot();
      if (!("value" in slot)) slot.value = { current: value };
      return slot.value as { current: T };
    },
    useState<T>(initialValue: T | (() => T)) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        slot.value =
          typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
      };
      return [slot.value as T, setValue] as const;
    },
  };
});

const harness = vi.hoisted(() => ({
  runsByProjectId: {} as Record<string, unknown>,
  upsertRun: vi.fn(),
  removeRun: vi.fn(),
  replaceAll: vi.fn(),
  invalidateQueries: vi.fn(),
  runDevServer: vi.fn(),
  stopDevServer: vi.fn(),
  listDevServers: vi.fn(),
  openExternal: vi.fn(),
  dispatchCommand: vi.fn(),
  toast: vi.fn(),
  localServers: [] as unknown[],
  discoveredTargetsByQuery: [[]] as unknown[][],
}));

vi.mock("react", () => ({
  useCallback: reactHarness.useCallback,
  useEffect: reactHarness.useEffect,
  useMemo: reactHarness.useMemo,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueries: (input: { queries: readonly unknown[] }) =>
    input.queries.map((_, index) => ({
      data: { targets: harness.discoveredTargetsByQuery[index] ?? [] },
    })),
  useQuery: () => ({ data: { servers: harness.localServers } }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));

vi.mock("../projectRunStore", () => {
  const useProjectRunStore = (selector: (state: unknown) => unknown) =>
    selector({
      runsByProjectId: harness.runsByProjectId,
      upsertRun: harness.upsertRun,
      removeRun: harness.removeRun,
    });
  useProjectRunStore.getState = () => ({ replaceAll: harness.replaceAll });
  return { useProjectRunStore };
});

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    projects: {
      runDevServer: harness.runDevServer,
      stopDevServer: harness.stopDevServer,
      listDevServers: harness.listDevServers,
    },
    shell: { openExternal: harness.openExternal },
    orchestration: { dispatchCommand: harness.dispatchCommand },
  }),
}));

vi.mock("../components/ui/toast", () => ({ toastManager: { add: harness.toast } }));
vi.mock("../lib/chatProjects", () => ({ isHomeChatContainerProject: () => false }));
vi.mock("../lib/projectReactQuery", () => ({
  projectDiscoverScriptsQueryOptions: (input: unknown) => input,
}));
vi.mock("../lib/serverReactQuery", () => ({
  serverQueryKeys: { localServers: () => ["server", "local"] },
  sidebarLocalServersQueryOptions: (input: unknown) => input,
}));
vi.mock("../projectScripts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../projectScripts")>()),
  projectScriptRuntimeEnv: () => ({ SYNARA_PROJECT_ROOT: "/repo" }),
}));

import type { Project } from "../types";
import { useSidebarProjectRunController } from "./useSidebarProjectRunController";

const PROJECT_ID = ProjectId.makeUnsafe("project-run");
const PROJECT: Project = {
  id: PROJECT_ID,
  kind: "project",
  name: "Project Run",
  remoteName: "Project Run",
  folderName: "repo",
  localName: null,
  cwd: "/repo",
  defaultModelSelection: null,
  expanded: true,
  scripts: [
    {
      id: "dev",
      name: "Dev",
      command: "bun dev",
      icon: "play",
      runOnWorktreeCreate: false,
    },
  ],
};
const projectById = new Map([[PROJECT_ID, PROJECT]]);

function render() {
  reactHarness.beginRender();
  return useSidebarProjectRunController({
    projects: [PROJECT],
    projectById,
    homeDir: "/Users/test",
    chatWorkspaceRoot: "/Users/test/.synara/chats",
  });
}

function confirmRun(command: string) {
  let controller = render();
  controller.openProjectRunDialog(PROJECT_ID);
  render();
  controller = render();
  controller.setProjectRunDialogCommandDraft(command);
  controller = render();
  controller.handleConfirmProjectRun();
}

beforeEach(() => {
  reactHarness.reset();
  harness.runsByProjectId = {};
  harness.localServers = [];
  harness.discoveredTargetsByQuery = [[]];
  for (const mock of [
    harness.upsertRun,
    harness.removeRun,
    harness.replaceAll,
    harness.invalidateQueries,
    harness.runDevServer,
    harness.stopDevServer,
    harness.listDevServers,
    harness.openExternal,
    harness.dispatchCommand,
    harness.toast,
  ]) {
    mock.mockReset();
  }
  harness.runDevServer.mockResolvedValue({
    server: {
      projectId: PROJECT_ID,
      command: "bun custom",
      cwd: "/repo",
      pid: 42,
      startedAt: "2026-07-20T00:00:00.000Z",
      status: "running",
    },
  });
  harness.stopDevServer.mockResolvedValue(undefined);
  harness.listDevServers.mockResolvedValue({ servers: [] });
  harness.dispatchCommand.mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
});

describe("useSidebarProjectRunController", () => {
  it("optimistically starts, accepts the authoritative server, and invalidates discovery", async () => {
    confirmRun("  bun custom  ");
    await vi.waitFor(() => expect(harness.runDevServer).toHaveBeenCalled());

    expect(harness.upsertRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: PROJECT_ID,
        command: "bun custom",
        cwd: "/repo",
        status: "starting",
      }),
    );
    expect(harness.runDevServer).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      command: "bun custom",
      cwd: "/repo",
      env: { SYNARA_PROJECT_ROOT: "/repo" },
    });
    expect(harness.upsertRun).toHaveBeenCalledTimes(2);
    expect(harness.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["server", "local"],
    });
  });

  it("rolls back and reports a failed start", async () => {
    harness.runDevServer.mockRejectedValue(new Error("port busy"));

    confirmRun("bun dev");
    await vi.waitFor(() => expect(harness.removeRun).toHaveBeenCalled());

    expect(harness.removeRun).toHaveBeenCalledWith(PROJECT_ID);
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: 'Failed to run "Project Run"',
        description: "port busy",
      }),
    );
  });

  it("restores authoritative state after a failed stop and always invalidates", async () => {
    harness.stopDevServer.mockRejectedValue(new Error("still running"));
    const authoritative = [{ projectId: PROJECT_ID, status: "running" }];
    harness.listDevServers.mockResolvedValue({ servers: authoritative });

    await render().handleStopProjectRun(PROJECT_ID);

    expect(harness.removeRun).toHaveBeenCalledWith(PROJECT_ID);
    // Scoped to the environment that answered: the routed API sent
    // `listDevServers` to the project's OWNING host, so its snapshot replaces
    // that host's rows and must leave other environments' runs alone.
    expect(harness.replaceAll).toHaveBeenCalledWith(
      authoritative,
      expect.any(String),
      expect.any(Function),
    );
    expect(harness.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["server", "local"],
    });
  });

  it("attributes unmatched servers to the deepest project cwd", () => {
    const nestedId = ProjectId.makeUnsafe("project-nested");
    const nested = { ...PROJECT, id: nestedId, cwd: "/repo/apps/web", name: "Web" };
    harness.localServers = [
      {
        id: "server-web",
        cwd: "/repo/apps/web/src",
        addresses: [{ url: "http://localhost:4173" }],
      },
    ];
    reactHarness.beginRender();
    const controller = useSidebarProjectRunController({
      projects: [PROJECT, nested],
      projectById: new Map([
        [PROJECT_ID, PROJECT],
        [nestedId, nested],
      ]),
      homeDir: "/Users/test",
      chatWorkspaceRoot: "/Users/test/.synara/chats",
    });

    expect(controller.projectRunServerByProjectId.get(nestedId)).toMatchObject({
      id: "server-web",
    });
    expect(controller.projectRunServerByProjectId.has(PROJECT_ID)).toBe(false);
  });

  it("keeps tracked pid attribution authoritative before cwd fallback", () => {
    const nestedId = ProjectId.makeUnsafe("project-tracked-nested");
    const nested = { ...PROJECT, id: nestedId, cwd: "/repo/apps/web", name: "Web" };
    harness.runsByProjectId = {
      [PROJECT_ID]: {
        projectId: PROJECT_ID,
        command: "bun dev",
        cwd: "/repo",
        pid: 700,
        startedAt: "2026-07-20T00:00:00.000Z",
        status: "running",
      },
    };
    harness.localServers = [
      {
        id: "tracked-root",
        pid: 701,
        ppid: 700,
        cwd: "/outside",
        addresses: [{ host: "127.0.0.1", port: 4173, url: "http://localhost:4173" }],
      },
      {
        id: "fallback-nested",
        pid: 800,
        ppid: 1,
        cwd: "/repo/apps/web/src",
        addresses: [{ host: "127.0.0.1", port: 4174, url: "http://localhost:4174" }],
      },
    ];
    reactHarness.beginRender();
    const controller = useSidebarProjectRunController({
      projects: [PROJECT, nested],
      projectById: new Map([
        [PROJECT_ID, PROJECT],
        [nestedId, nested],
      ]),
      homeDir: "/Users/test",
      chatWorkspaceRoot: "/Users/test/.synara/chats",
    });

    expect(controller.projectRunServerByProjectId.get(PROJECT_ID)).toMatchObject({
      id: "tracked-root",
    });
    expect(controller.projectRunServerByProjectId.get(nestedId)).toMatchObject({
      id: "fallback-nested",
    });
  });

  it("opens the first server URL and reports shell failures", async () => {
    harness.localServers = [
      {
        id: "server-root",
        pid: 900,
        ppid: 1,
        cwd: "/repo",
        ports: [4173, 4174],
        addresses: [
          { host: "127.0.0.1", port: 4173, url: "http://localhost:4173" },
          { host: "127.0.0.1", port: 4174, url: "http://localhost:4174" },
        ],
      },
    ];
    let controller = render();

    await controller.handleOpenProjectRunServer(PROJECT_ID);
    expect(harness.openExternal).toHaveBeenCalledWith("http://localhost:4173");

    harness.openExternal.mockRejectedValueOnce(new Error("shell unavailable"));
    controller = render();
    await controller.handleOpenProjectRunServer(PROJECT_ID);
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "shell unavailable" }),
    );
  });

  it("seeds and trims dialog commands while persistence failure does not block launch", async () => {
    harness.dispatchCommand.mockRejectedValue(new Error("metadata unavailable"));
    let controller = render();
    controller.openProjectRunDialog(PROJECT_ID);
    render();
    controller = render();
    expect(controller.projectRunDialogCommandDraft).toBe("bun dev");

    controller.setProjectRunDialogCommandDraft("  bun custom  ");
    controller = render();
    controller.handleConfirmProjectRun();
    await vi.waitFor(() => expect(harness.runDevServer).toHaveBeenCalled());

    expect(harness.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project.meta.update", projectId: PROJECT_ID }),
    );
    expect(harness.runDevServer).toHaveBeenCalledWith(
      expect.objectContaining({ command: "bun custom" }),
    );
  });

  it("keeps discovered commands aligned with their project query", () => {
    const secondId = ProjectId.makeUnsafe("project-run-second");
    const secondProject: Project = {
      ...PROJECT,
      id: secondId,
      name: "Second Project",
      cwd: "/repo-second",
      scripts: [],
    };
    const firstProject = { ...PROJECT, scripts: [] };
    harness.discoveredTargetsByQuery = [
      [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [{ name: "dev", command: "bun first" }],
        },
      ],
      [
        {
          cwd: "/repo-second",
          relativePath: "",
          packageJsonPath: "/repo-second/package.json",
          scripts: [{ name: "dev", command: "bun second" }],
        },
      ],
    ];

    reactHarness.beginRender();
    let controller = useSidebarProjectRunController({
      projects: [firstProject, secondProject],
      projectById: new Map([
        [PROJECT_ID, firstProject],
        [secondId, secondProject],
      ]),
      homeDir: "/Users/test",
      chatWorkspaceRoot: "/Users/test/.synara/chats",
    });
    controller.openProjectRunDialog(secondId);
    reactHarness.beginRender();
    useSidebarProjectRunController({
      projects: [firstProject, secondProject],
      projectById: new Map([
        [PROJECT_ID, firstProject],
        [secondId, secondProject],
      ]),
      homeDir: "/Users/test",
      chatWorkspaceRoot: "/Users/test/.synara/chats",
    });
    reactHarness.beginRender();
    controller = useSidebarProjectRunController({
      projects: [firstProject, secondProject],
      projectById: new Map([
        [PROJECT_ID, firstProject],
        [secondId, secondProject],
      ]),
      homeDir: "/Users/test",
      chatWorkspaceRoot: "/Users/test/.synara/chats",
    });

    expect(controller.projectRunDialogCommandDraft).toBe("bun second");
  });
});
