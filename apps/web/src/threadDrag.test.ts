import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  hasThreadDragType,
  parseThreadDragPayload,
  resolveSidebarFolderDropTarget,
  resolveThreadFolderMenuTarget,
  THREAD_DRAG_MIME,
} from "./threadDrag";

function dataTransfer(input: { types?: string[]; payload?: string }) {
  return {
    types: input.types ?? [],
    getData: (type: string) => (type === THREAD_DRAG_MIME ? (input.payload ?? "") : ""),
  } as Pick<DataTransfer, "getData" | "types">;
}

describe("threadDrag", () => {
  it("recognizes only the Synara thread MIME type", () => {
    expect(hasThreadDragType(dataTransfer({ types: [THREAD_DRAG_MIME] }))).toBe(true);
    expect(hasThreadDragType(dataTransfer({ types: ["Files"] }))).toBe(false);
  });

  it("parses a valid thread payload", () => {
    expect(
      parseThreadDragPayload(dataTransfer({ payload: JSON.stringify({ threadId: "thread-a" }) })),
    ).toEqual({ threadId: ThreadId.makeUnsafe("thread-a") });
  });

  it("rejects malformed and empty payloads", () => {
    expect(parseThreadDragPayload(dataTransfer({ payload: "{" }))).toBeNull();
    expect(
      parseThreadDragPayload(dataTransfer({ payload: JSON.stringify({ threadId: "" }) })),
    ).toBeNull();
  });

  it("gives the folder's project-root gutter a usable drag target", () => {
    expect(
      resolveSidebarFolderDropTarget({ clientX: 142, containerLeft: 100, folderId: "folder-a" }),
    ).toBeNull();
    expect(
      resolveSidebarFolderDropTarget({ clientX: 145, containerLeft: 100, folderId: "folder-a" }),
    ).toBe("folder-a");
  });

  it("maps the project-root menu action to an unassigned thread", () => {
    expect(resolveThreadFolderMenuTarget("folder:root")).toBeNull();
    expect(resolveThreadFolderMenuTarget("folder:folder-a")).toBe("folder-a");
  });
});
