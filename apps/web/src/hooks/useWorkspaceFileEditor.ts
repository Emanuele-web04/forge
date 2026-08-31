import { isWorkspaceFileWriteConflictError } from "@synara/shared/workspaceFileWrite";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";

import { invalidateGitQueriesForCwds } from "~/lib/gitReactQuery";
import {
  invalidateProjectFileQueriesForCwds,
  projectReadFileQueryOptions,
} from "~/lib/projectReactQuery";
import { sha256Hex } from "~/lib/sha256";
import {
  INITIAL_WORKSPACE_FILE_EDITOR_STATE,
  isWorkspaceFileEditorDirty,
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
  truncated: boolean;
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
  const contents = fileQuery.data?.contents ?? null;
  const truncated = fileQuery.data?.truncated ?? false;
  const resolvedRelativePath = fileQuery.data?.relativePath ?? filePath;
  const stateRef = useRef(state);
  stateRef.current = state;
  const resolvedRelativePathRef = useRef(resolvedRelativePath);
  resolvedRelativePathRef.current = resolvedRelativePath;
  const truncatedRef = useRef(truncated);
  truncatedRef.current = truncated;

  useEffect(() => {
    if (editorKey === null || contents === null || truncated) {
      return;
    }
    let cancelled = false;
    void sha256Hex(contents).then((sha256) => {
      if (!cancelled) {
        const lineEnding = fileQuery.data?.lineEnding;
        dispatch({
          type: "loaded",
          key: editorKey,
          contents,
          sha256,
          expectedVersion: fileQuery.data?.version ?? null,
          encoding: fileQuery.data?.encoding ?? null,
          // Mixed endings cannot round-trip through a guarded write; treat
          // them like unversioned reads and fall back to the hash guard.
          lineEnding: lineEnding === "mixed" || lineEnding == null ? null : lineEnding,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [contents, editorKey, truncated, fileQuery.data]);

  useEffect(() => {
    if (editorKey === null) {
      dispatch({ type: "closed" });
    }
  }, [editorKey]);

  const handleChange = useCallback((value: string) => {
    dispatch({ type: "changed", value });
  }, []);

  const writeContents = useCallback(
    async (options: { useExpectedHash: boolean }) => {
      const current = stateRef.current;
      const relativePath = resolvedRelativePathRef.current;
      if (
        cwd === null ||
        relativePath === null ||
        current.key === null ||
        current.saving ||
        truncatedRef.current
      ) {
        return;
      }
      const nextContents = current.value;
      dispatch({ type: "saveStarted" });
      try {
        const api = ensureNativeApi();
        // Prefer the server's guarded-write path: it verifies the version it
        // issued and re-encodes the save with the file's original encoding and
        // line endings, so CRLF/BOM files neither false-conflict nor silently
        // change format. The contents hash remains the fallback for reads that
        // carried no version. Overwrite deliberately skips version guards so it
        // stays an escape hatch when the file changed on disk.
        const writeResult = await api.projects.writeFile({
          cwd,
          relativePath,
          contents: nextContents,
          ...(options.useExpectedHash &&
          current.expectedVersion !== null &&
          current.encoding !== null &&
          current.lineEnding !== null
            ? {
                expectedVersion: current.expectedVersion,
                encoding: current.encoding,
                lineEnding: current.lineEnding,
              }
            : options.useExpectedHash && current.baselineSha256.length > 0
              ? { expectedContentsSha256: current.baselineSha256 }
              : {}),
        });
        const sha256 = await sha256Hex(nextContents);
        dispatch({
          type: "saveSucceeded",
          contents: nextContents,
          sha256,
          expectedVersion: writeResult.version,
        });
        queryClient.setQueryData(queryOptions.queryKey, (previous) =>
          previous ? { ...previous, contents: nextContents } : previous,
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
    void writeContents({ useExpectedHash: true });
  }, [writeContents]);

  const overwrite = useCallback(() => {
    void writeContents({ useExpectedHash: false });
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
      .then(async (result) => {
        if (stateRef.current.value !== valueAtReloadStart) {
          return;
        }
        dispatch({
          type: "reloaded",
          key: editorKey,
          contents: result.contents,
          sha256: await sha256Hex(result.contents),
          expectedVersion: result.version,
          encoding: result.encoding,
          lineEnding:
            result.lineEnding === "mixed" || result.lineEnding == null ? null : result.lineEnding,
        });
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
    truncated,
    canEdit: state.key !== null && state.key === editorKey && !truncated,
    handleChange,
    save,
    overwrite,
    reloadFromDisk,
    dismissConflict,
  };
}
