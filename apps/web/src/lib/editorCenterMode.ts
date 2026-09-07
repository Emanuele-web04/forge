export type EditorCenterMode = "file" | "diff" | "fileEdit" | "diffEdit";

export type EditorCenterModeFamily = "file" | "diff";

export type EditorActivityBarItem = "file" | "diff" | "search";

export function editorCenterModeFamily(mode: EditorCenterMode): EditorCenterModeFamily {
  return mode === "diff" || mode === "diffEdit" ? "diff" : "file";
}

export interface EditorActivityBarSelection {
  item: EditorActivityBarItem;
  sidebarVisible: boolean;
  searchPaneActive: boolean;
  centerFamily: EditorCenterModeFamily;
}

/** True when the item already owns the visible sidebar, so selecting it hides the sidebar. */
export function isEditorActivityBarItemActive(selection: EditorActivityBarSelection): boolean {
  return (
    selection.sidebarVisible &&
    (selection.item === "search"
      ? selection.searchPaneActive
      : !selection.searchPaneActive && selection.centerFamily === selection.item)
  );
}

/**
 * Only a center-pane switch leaves an open editor. Hiding the sidebar or
 * opening search keeps the editor mounted, so those must not run the
 * discard flow that clears its dirty tracking.
 */
export function editorActivityBarSelectionLeavesEditor(
  selection: EditorActivityBarSelection,
): boolean {
  return !isEditorActivityBarItemActive(selection) && selection.item !== "search";
}
