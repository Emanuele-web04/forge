import { describe, expect, it } from "vitest";

import {
  editorActivityBarSelectionLeavesEditor,
  isEditorActivityBarItemActive,
} from "./editorCenterMode";

describe("editorActivityBarSelectionLeavesEditor", () => {
  it("keeps the editor when re-selecting the active item only hides the sidebar", () => {
    const selection = {
      item: "file",
      sidebarVisible: true,
      searchPaneActive: false,
      centerFamily: "file",
    } as const;
    expect(isEditorActivityBarItemActive(selection)).toBe(true);
    expect(editorActivityBarSelectionLeavesEditor(selection)).toBe(false);
  });

  it("keeps the editor when opening the search sidebar", () => {
    expect(
      editorActivityBarSelectionLeavesEditor({
        item: "search",
        sidebarVisible: false,
        searchPaneActive: false,
        centerFamily: "file",
      }),
    ).toBe(false);
    expect(
      editorActivityBarSelectionLeavesEditor({
        item: "search",
        sidebarVisible: true,
        searchPaneActive: true,
        centerFamily: "diff",
      }),
    ).toBe(false);
  });

  it("leaves the editor when the selection switches the center pane", () => {
    expect(
      editorActivityBarSelectionLeavesEditor({
        item: "diff",
        sidebarVisible: true,
        searchPaneActive: false,
        centerFamily: "file",
      }),
    ).toBe(true);
    // Same family with the sidebar hidden re-shows the sidebar and switches
    // the edit pane back to the plain center mode.
    expect(
      editorActivityBarSelectionLeavesEditor({
        item: "file",
        sidebarVisible: false,
        searchPaneActive: false,
        centerFamily: "file",
      }),
    ).toBe(true);
    expect(
      editorActivityBarSelectionLeavesEditor({
        item: "file",
        sidebarVisible: true,
        searchPaneActive: true,
        centerFamily: "file",
      }),
    ).toBe(true);
  });
});
