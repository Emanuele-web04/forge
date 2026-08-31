import type { ProjectFileEncoding, ProjectFileLineEnding } from "@synara/contracts";

export interface WorkspaceFileEditorEncoding {
  /** Server-side version of the loaded bytes (`sha256:<hex>` of the raw file). */
  expectedVersion: string | null;
  encoding: ProjectFileEncoding | null;
  lineEnding: Exclude<ProjectFileLineEnding, "mixed"> | null;
}

export const EMPTY_WORKSPACE_FILE_EDITOR_ENCODING: WorkspaceFileEditorEncoding = {
  expectedVersion: null,
  encoding: null,
  lineEnding: null,
};

export interface WorkspaceFileEditorState extends WorkspaceFileEditorEncoding {
  key: string | null;
  baseline: string;
  baselineSha256: string;
  value: string;
  version: number;
  conflict: boolean;
  saving: boolean;
  saveError: string | null;
}

export type WorkspaceFileEditorAction =
  | ({
      type: "loaded";
      key: string;
      contents: string;
      sha256: string;
    } & Partial<WorkspaceFileEditorEncoding>)
  | ({
      type: "reloaded";
      key: string;
      contents: string;
      sha256: string;
    } & Partial<WorkspaceFileEditorEncoding>)
  | { type: "changed"; value: string }
  | { type: "saveStarted" }
  | ({
      type: "saveSucceeded";
      contents: string;
      sha256: string;
    } & Partial<WorkspaceFileEditorEncoding>)
  | { type: "saveFailed"; message: string; conflict: boolean }
  | { type: "conflictDismissed" }
  | { type: "closed" };

export const INITIAL_WORKSPACE_FILE_EDITOR_STATE: WorkspaceFileEditorState = {
  key: null,
  baseline: "",
  baselineSha256: "",
  value: "",
  version: 0,
  conflict: false,
  saving: false,
  saveError: null,
  ...EMPTY_WORKSPACE_FILE_EDITOR_ENCODING,
};

export function isWorkspaceFileEditorDirty(state: WorkspaceFileEditorState): boolean {
  return state.key !== null && state.value !== state.baseline;
}

function replaceBuffer(
  state: WorkspaceFileEditorState,
  key: string,
  contents: string,
  sha256: string,
  encoding?: Partial<WorkspaceFileEditorEncoding>,
): WorkspaceFileEditorState {
  return {
    key,
    baseline: contents,
    baselineSha256: sha256,
    value: contents,
    version: state.version + 1,
    conflict: false,
    saving: false,
    saveError: null,
    expectedVersion: encoding?.expectedVersion ?? null,
    encoding: encoding?.encoding ?? null,
    lineEnding: encoding?.lineEnding ?? null,
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
        state.baselineSha256 === action.sha256
      ) {
        return state;
      }
      return replaceBuffer(state, action.key, action.contents, action.sha256, action);
    }
    case "reloaded":
      return replaceBuffer(state, action.key, action.contents, action.sha256, action);
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
        baselineSha256: action.sha256,
        saving: false,
        conflict: false,
        saveError: null,
        expectedVersion: action.expectedVersion ?? state.expectedVersion,
        encoding: action.encoding ?? state.encoding,
        lineEnding: action.lineEnding ?? state.lineEnding,
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
