import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getProjectThreadFolders,
  getThreadIdsInFolder,
  groupThreadFolderEntries,
  useSidebarThreadFolderStore,
} from "./sidebarThreadFolderStore";

const PROJECT_A = ProjectId.makeUnsafe("project-a");
const PROJECT_B = ProjectId.makeUnsafe("project-b");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("sidebarThreadFolderStore", () => {
  beforeEach(() => {
    useSidebarThreadFolderStore.setState({
      folders: [],
      folderIdByThreadId: {},
      collapsedFolderIds: {},
    });
  });

  it("creates a visual folder and files the selected threads into it", () => {
    useSidebarThreadFolderStore.getState().createFolder({
      id: "folder-sidebar",
      projectId: PROJECT_A,
      name: "  Sidebar changes  ",
      threadIds: [THREAD_A, THREAD_B],
      createdAt: "2026-08-30T10:00:00.000Z",
    });

    const state = useSidebarThreadFolderStore.getState();
    expect(state.folders).toEqual([
      {
        id: "folder-sidebar",
        projectId: PROJECT_A,
        name: "Sidebar changes",
        createdAt: "2026-08-30T10:00:00.000Z",
        archivedAt: null,
      },
    ]);
    expect(getThreadIdsInFolder(state.folderIdByThreadId, "folder-sidebar")).toEqual([
      THREAD_A,
      THREAD_B,
    ]);
  });

  it("moves threads between a folder and the project root without changing the threads", () => {
    const store = useSidebarThreadFolderStore.getState();
    store.createFolder({ id: "folder-ui", projectId: PROJECT_A, name: "UI" });
    store.assignThreads("folder-ui", [THREAD_A, THREAD_B]);
    store.assignThreads(null, [THREAD_A]);

    expect(useSidebarThreadFolderStore.getState().folderIdByThreadId).toEqual({
      [THREAD_B]: "folder-ui",
    });
  });

  it("archives folders reversibly while preserving their thread membership", () => {
    const store = useSidebarThreadFolderStore.getState();
    store.createFolder({
      id: "folder-ui",
      projectId: PROJECT_A,
      name: "UI",
      threadIds: [THREAD_A],
    });
    store.archiveFolder("folder-ui", "2026-08-30T11:00:00.000Z");

    expect(
      getProjectThreadFolders(useSidebarThreadFolderStore.getState().folders, PROJECT_A),
    ).toEqual([]);
    expect(
      getProjectThreadFolders(useSidebarThreadFolderStore.getState().folders, PROJECT_A, {
        includeArchived: true,
      })[0]?.archivedAt,
    ).toBe("2026-08-30T11:00:00.000Z");
    expect(useSidebarThreadFolderStore.getState().folderIdByThreadId[THREAD_A]).toBe("folder-ui");

    useSidebarThreadFolderStore.getState().restoreFolder("folder-ui");
    expect(
      getProjectThreadFolders(useSidebarThreadFolderStore.getState().folders, PROJECT_A),
    ).toHaveLength(1);
  });

  it("deleting a folder removes its assignments and collapsed state", () => {
    const store = useSidebarThreadFolderStore.getState();
    store.createFolder({
      id: "folder-ui",
      projectId: PROJECT_A,
      name: "UI",
      threadIds: [THREAD_A],
    });
    store.setFolderCollapsed("folder-ui", true);
    store.deleteFolder("folder-ui");

    const state = useSidebarThreadFolderStore.getState();
    expect(state.folders).toEqual([]);
    expect(state.folderIdByThreadId).toEqual({});
    expect(state.collapsedFolderIds).toEqual({});
  });

  it("prunes folders only when their project disappears", () => {
    const store = useSidebarThreadFolderStore.getState();
    store.createFolder({ id: "folder-a", projectId: PROJECT_A, name: "A" });
    store.createFolder({ id: "folder-b", projectId: PROJECT_B, name: "B" });
    store.pruneProjects([PROJECT_B]);

    expect(useSidebarThreadFolderStore.getState().folders.map((folder) => folder.id)).toEqual([
      "folder-b",
    ]);
  });

  it("groups a parent and its descendants by the parent assignment without hiding stale folders", () => {
    const child = ThreadId.makeUnsafe("thread-child");
    const stale = ThreadId.makeUnsafe("thread-stale");
    const entries = [
      { rowId: THREAD_A, rootRowId: THREAD_A },
      { rowId: child, rootRowId: THREAD_A },
      { rowId: THREAD_B, rootRowId: THREAD_B },
      { rowId: stale, rootRowId: stale },
    ];

    const grouped = groupThreadFolderEntries({
      entries,
      activeFolderIds: new Set(["folder-ui"]),
      folderIdByThreadId: {
        [THREAD_A]: "folder-ui",
        [stale]: "folder-archived-or-missing",
      },
    });

    expect(grouped.entriesByFolderId.get("folder-ui")?.map((entry) => entry.rowId)).toEqual([
      THREAD_A,
      child,
    ]);
    expect(grouped.rootEntries.map((entry) => entry.rowId)).toEqual([THREAD_B, stale]);
  });
});
