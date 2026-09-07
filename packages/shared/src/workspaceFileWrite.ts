/** RPC error code the server attaches when a guarded write no longer matches the file on disk. */
export const WORKSPACE_FILE_WRITE_CONFLICT_CODE = "WORKSPACE_FILE_CONFLICT";

export function isWorkspaceFileWriteConflictError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === WORKSPACE_FILE_WRITE_CONFLICT_CODE
  );
}
