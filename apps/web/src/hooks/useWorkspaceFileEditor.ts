import { isWorkspaceFileWriteConflictError } from "@synara/shared/workspaceFileWrite";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";

import { invalidateGitQueriesForCwds } from "~/lib/gitReactQuery";
import {
  invalidateProjectFileQueriesForCwds,
  projectReadFileQueryOptions,
} from "~/lib/projectReactQuery";
import {
  INITIAL_WORKSPACE_FILE_EDITOR_STATE,
  isWorkspaceFileEditorDirty,
  resolveWorkspaceFileEditorFormat,
  resolveWorkspaceFileEditorReadOnlyReason,
  workspaceFileEditorKey,
  workspaceFileEditorReducer,
  type WorkspaceFileEditorState,
} from "~/lib/workspaceFileEditor";
import { ensureNativeApi } from "~/nativeApi";

export interface UseWorkspaceFileEditorInput {
  cwd: string | null;
  filePath: string | null;
  enabled: boolean;
}

export interface WorkspaceFileEditorController {
  state: WorkspaceFileEditorState;
  dirty: boolean;
  loading: boolean;
  loadError: string | null;
  /** Why the loaded file cannot be edited in place, or null when it can. */
  readOnlyReason: string | null;
  canEdit: boolean;
  handleChange: (value: string) => void;
  save: () => void;
  overwrite: () => void;
  reloadFromDisk: () => void;
  dismissConflict: () => void;
}

export function useWorkspaceFileEditor(
  input: UseWorkspaceFileEditorInput,
): WorkspaceFileEditorController {
  const { cwd, enabled, filePath } = input;
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(
    workspaceFileEditorReducer,
    INITIAL_WORKSPACE_FILE_EDITOR_STATE,
  );
  const editorKey = workspaceFileEditorKey(cwd, filePath);
  const queryOptions = projectReadFileQueryOptions({
    cwd,
    relativePath: filePath,
    enabled: enabled && cwd !== null && filePath !== null,
  });
  const fileQuery = useQuery(queryOptions);
  const file = fileQuery.data;
  const readOnlyReason = file === undefined ? null : resolveWorkspaceFileEditorReadOnlyReason(file);
  const resolvedRelativePath = file?.relativePath ?? filePath;
  const stateRef = useRef(state);
  stateRef.current = state;
  const resolvedRelativePathRef = useRef(resolvedRelativePath);
  resolvedRelativePathRef.current = resolvedRelativePath;

  useEffect(() => {
    if (editorKey === null || file === undefined) {
      return;
    }
    const format = resolveWorkspaceFileEditorFormat(file);
    if (format === null) {
      return;
    }
    dispatch({ type: "loaded", key: editorKey, contents: file.contents, format });
  }, [editorKey, file]);

  useEffect(() => {
    if (editorKey === null) {
      dispatch({ type: "closed" });
    }
  }, [editorKey]);

  const handleChange = useCallback((value: string) => {
    dispatch({ type: "changed", value });
  }, []);

  const writeContents = useCallback(
    async (options: { guarded: boolean }) => {
      const current = stateRef.current;
      const relativePath = resolvedRelativePathRef.current;
      if (
        cwd === null ||
        relativePath === null ||
        current.key === null ||
        current.format === null ||
        current.saving
      ) {
        return;
      }
      const nextContents = current.value;
      dispatch({ type: "saveStarted" });
      try {
        const api = ensureNativeApi();
        // The server re-encodes every save with the file's original encoding
        // and line endings, so CRLF/BOM files keep their format. A guarded save
        // also verifies the version it issued; Overwrite deliberately skips that
        // guard so it stays an escape hatch when the file changed on disk.
        const writeResult = await api.projects.writeFile({
          cwd,
          relativePath,
          contents: nextContents,
          encoding: current.format.encoding,
          lineEnding: current.format.lineEnding,
          ...(options.guarded ? { expectedVersion: current.format.expectedVersion } : {}),
        });
        dispatch({
          type: "saveSucceeded",
          contents: nextContents,
          expectedVersion: writeResult.version,
        });
        queryClient.setQueryData(queryOptions.queryKey, (previous) =>
          previous
            ? { ...previous, contents: nextContents, version: writeResult.version }
            : previous,
        );
        await Promise.all([
          invalidateGitQueriesForCwds(queryClient, [cwd]),
          invalidateProjectFileQueriesForCwds(queryClient, [cwd]),
        ]);
      } catch (error) {
        dispatch({
          type: "saveFailed",
          message: error instanceof Error ? error.message : "Could not save the file.",
          conflict: isWorkspaceFileWriteConflictError(error),
        });
      }
    },
    [cwd, queryClient, queryOptions.queryKey],
  );

  const save = useCallback(() => {
    void writeContents({ guarded: true });
  }, [writeContents]);

  const overwrite = useCallback(() => {
    void writeContents({ guarded: false });
  }, [writeContents]);

  const reloadFromDisk = useCallback(() => {
    if (editorKey === null) {
      return;
    }
    // The reload does not block input: if the user typed while the fetch was
    // in flight, applying it now would silently erase those edits.
    const valueAtReloadStart = stateRef.current.value;
    void queryClient
      .fetchQuery({ ...queryOptions, staleTime: 0 })
      .then((result) => {
        const format = resolveWorkspaceFileEditorFormat(result);
        if (stateRef.current.value !== valueAtReloadStart || format === null) {
          return;
        }
        dispatch({ type: "reloaded", key: editorKey, contents: result.contents, format });
      })
      .catch((error: unknown) => {
        dispatch({
          type: "saveFailed",
          message: error instanceof Error ? error.message : "Could not reload the file.",
          conflict: false,
        });
      });
  }, [editorKey, queryClient, queryOptions]);

  const dismissConflict = useCallback(() => {
    dispatch({ type: "conflictDismissed" });
  }, []);

  return {
    state,
    dirty: isWorkspaceFileEditorDirty(state),
    loading: fileQuery.isLoading,
    loadError:
      fileQuery.error instanceof Error
        ? fileQuery.error.message
        : fileQuery.error
          ? "Could not read file."
          : null,
    readOnlyReason,
    canEdit: state.key !== null && state.key === editorKey && readOnlyReason === null,
    handleChange,
    save,
    overwrite,
    reloadFromDisk,
    dismissConflict,
  };
}
