import type { ProjectFileEncoding, ProjectFileLineEnding } from "@synara/contracts";

/** On-disk format of a loaded buffer; every save re-encodes with it. */
export interface WorkspaceFileEditorFormat {
  /** Server-side version of the loaded bytes (`sha256:<hex>` of the raw file). */
  expectedVersion: string;
  encoding: ProjectFileEncoding;
  lineEnding: Exclude<ProjectFileLineEnding, "mixed">;
}

export interface WorkspaceFileEditorSource {
  truncated: boolean;
  version: string | null;
  encoding: ProjectFileEncoding | null;
  lineEnding: ProjectFileLineEnding | null;
}

export interface WorkspaceFileEditorState {
  key: string | null;
  baseline: string;
  value: string;
  version: number;
  format: WorkspaceFileEditorFormat | null;
  conflict: boolean;
  saving: boolean;
  saveError: string | null;
}

export type WorkspaceFileEditorAction =
  | { type: "loaded"; key: string; contents: string; format: WorkspaceFileEditorFormat }
  | { type: "reloaded"; key: string; contents: string; format: WorkspaceFileEditorFormat }
  | { type: "changed"; value: string }
  | { type: "saveStarted" }
  | { type: "saveSucceeded"; contents: string; expectedVersion: string }
  | { type: "saveFailed"; message: string; conflict: boolean }
  | { type: "conflictDismissed" }
  | { type: "closed" };

export const INITIAL_WORKSPACE_FILE_EDITOR_STATE: WorkspaceFileEditorState = {
  key: null,
  baseline: "",
  value: "",
  version: 0,
  format: null,
  conflict: false,
  saving: false,
  saveError: null,
};

/**
 * Why a read cannot be edited in place, or null when it can. Mixed line
 * endings cannot round-trip through a re-encoding save, so they stay
 * read-only rather than being silently normalized.
 */
export function resolveWorkspaceFileEditorReadOnlyReason(
  source: WorkspaceFileEditorSource,
): string | null {
  if (source.truncated) {
    return "Large files are read-only.";
  }
  if (source.lineEnding === "mixed") {
    return "Files with mixed line endings are read-only to preserve their exact format.";
  }
  if (source.version === null || source.encoding === null || source.lineEnding === null) {
    return "This file format is read-only.";
  }
  return null;
}

export function resolveWorkspaceFileEditorFormat(
  source: WorkspaceFileEditorSource,
): WorkspaceFileEditorFormat | null {
  if (
    source.truncated ||
    source.version === null ||
    source.encoding === null ||
    source.lineEnding === null ||
    source.lineEnding === "mixed"
  ) {
    return null;
  }
  return {
    expectedVersion: source.version,
    encoding: source.encoding,
    lineEnding: source.lineEnding,
  };
}

export function isWorkspaceFileEditorDirty(state: WorkspaceFileEditorState): boolean {
  return state.key !== null && state.value !== state.baseline;
}

function replaceBuffer(
  state: WorkspaceFileEditorState,
  key: string,
  contents: string,
  format: WorkspaceFileEditorFormat,
): WorkspaceFileEditorState {
  return {
    key,
    baseline: contents,
    value: contents,
    version: state.version + 1,
    format,
    conflict: false,
    saving: false,
    saveError: null,
  };
}

export function workspaceFileEditorReducer(
  state: WorkspaceFileEditorState,
  action: WorkspaceFileEditorAction,
): WorkspaceFileEditorState {
  switch (action.type) {
    case "loaded": {
      if (state.key === action.key && isWorkspaceFileEditorDirty(state)) {
        return state;
      }
      if (
        state.key === action.key &&
        state.baseline === action.contents &&
        state.format?.expectedVersion === action.format.expectedVersion
      ) {
        return state;
      }
      return replaceBuffer(state, action.key, action.contents, action.format);
    }
    case "reloaded":
      return replaceBuffer(state, action.key, action.contents, action.format);
    case "changed":
      return state.key === null || state.value === action.value
        ? state
        : { ...state, value: action.value };
    case "saveStarted":
      return state.saving ? state : { ...state, saving: true, saveError: null };
    case "saveSucceeded":
      return {
        ...state,
        baseline: action.contents,
        format: state.format ? { ...state.format, expectedVersion: action.expectedVersion } : null,
        saving: false,
        conflict: false,
        saveError: null,
      };
    case "saveFailed":
      return { ...state, saving: false, conflict: action.conflict, saveError: action.message };
    case "conflictDismissed":
      return state.conflict || state.saveError !== null
        ? { ...state, conflict: false, saveError: null }
        : state;
    case "closed":
      return state.key === null ? state : INITIAL_WORKSPACE_FILE_EDITOR_STATE;
  }
}

export function workspaceFileEditorKey(cwd: string | null, filePath: string | null): string | null {
  return cwd === null || filePath === null ? null : `${cwd}\u0000${filePath}`;
}
