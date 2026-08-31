import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { groupThreadFolderEntries } from "./sidebarThreadFolderStore";

describe("sidebar thread folder visible entries", () => {
  it("derives shortcut rows in rendered folder order before project-root rows", () => {
    const folderAThread = ThreadId.makeUnsafe("thread-folder-a");
    const folderBThread = ThreadId.makeUnsafe("thread-folder-b");
    const projectRootThread = ThreadId.makeUnsafe("thread-project-root");
    const grouped = groupThreadFolderEntries({
      entries: [
        { rowId: projectRootThread, rootRowId: projectRootThread },
        { rowId: folderBThread, rootRowId: folderBThread },
        { rowId: folderAThread, rootRowId: folderAThread },
      ],
      activeFolderIds: new Set(["folder-a", "folder-b"]),
      folderIdByThreadId: {
        [folderAThread]: "folder-a",
        [folderBThread]: "folder-b",
      },
    });

    expect(grouped.visibleEntries.map((entry) => entry.rowId)).toEqual([
      folderAThread,
      folderBThread,
      projectRootThread,
    ]);
  });

  it("excludes rows inside collapsed visual folders from shortcut order", () => {
    const collapsedThread = ThreadId.makeUnsafe("thread-collapsed");
    const expandedThread = ThreadId.makeUnsafe("thread-expanded");
    const grouped = groupThreadFolderEntries({
      entries: [
        { rowId: collapsedThread, rootRowId: collapsedThread },
        { rowId: expandedThread, rootRowId: expandedThread },
      ],
      activeFolderIds: new Set(["folder-collapsed", "folder-expanded"]),
      folderIdByThreadId: {
        [collapsedThread]: "folder-collapsed",
        [expandedThread]: "folder-expanded",
      },
      collapsedFolderIds: { "folder-collapsed": true },
    });

    expect(grouped.visibleEntries.map((entry) => entry.rowId)).toEqual([expandedThread]);
  });
});
