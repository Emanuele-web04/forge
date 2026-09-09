// Purpose: Detects absolute / ~/ filesystem-path queries in the Cmd+P palette
//          and resolves them to an openable dock file path.
// Layer: Web UI logic (pure helpers; no React)

import {
  inferHomeFromCwd,
  isLocalAbsolutePath,
  joinWorkspaceRelativePath,
  workspaceRelativePathOf,
} from "@synara/shared/path";

// Trailing `:line` / `:line:col` from pasted editor references; the dock viewer
// opens whole files, so the position is dropped before opening.
const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

function stripFilePositionSuffix(path: string): string {
  return path.replace(FILE_POSITION_SUFFIX_PATTERN, "");
}

/** True when the query is an absolute path or a `~/` / `~\` home-relative path. */
export function isWorkspaceSearchFilesystemPathQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return true;
  }
  return isLocalAbsolutePath(stripFilePositionSuffix(trimmed));
}

/**
 * Resolves a filesystem-path palette query to a dock-openable path.
 * Prefers a workspace-relative form when the target sits inside `cwd`; otherwise
 * returns the absolute path (preview grants handle out-of-workspace locals).
 * Returns null when the query is not path-like, or when `~/…` cannot be expanded.
 */
export function resolveWorkspaceSearchFilesystemPath(
  query: string,
  cwd: string | null,
): string | null {
  const trimmed = query.trim();
  if (!isWorkspaceSearchFilesystemPathQuery(trimmed)) {
    return null;
  }

  const withoutPosition = stripFilePositionSuffix(trimmed);
  let absolutePath: string;

  if (withoutPosition.startsWith("~/") || withoutPosition.startsWith("~\\")) {
    if (!cwd) {
      return null;
    }
    const home = inferHomeFromCwd(cwd);
    if (!home) {
      return null;
    }
    absolutePath = joinWorkspaceRelativePath(home, withoutPosition.slice(2).replace(/\\/g, "/"));
  } else if (isLocalAbsolutePath(withoutPosition)) {
    absolutePath = withoutPosition;
  } else {
    return null;
  }

  if (cwd) {
    const relativePath = workspaceRelativePathOf(absolutePath, cwd);
    if (relativePath) {
      return relativePath;
    }
  }

  return absolutePath;
}
