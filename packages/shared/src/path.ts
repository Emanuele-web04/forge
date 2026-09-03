// FILE: path.ts
// Purpose: Shared path classification and workspace-relative conversion helpers.
// Layer: Cross-package utility
// Exports: absolute-path predicates plus safe workspace relative path helpers

export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isLocalAbsolutePath(
  value: string,
  options: { readonly allowWindowsPaths?: boolean } = {},
): boolean {
  return (
    value.startsWith("/") || ((options.allowWindowsPaths ?? true) && isWindowsAbsolutePath(value))
  );
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function isNormalizedWindowsAbsolutePath(value: string): boolean {
  return isWindowsDrivePath(value) || value.startsWith("//");
}

function windowsRelativePathOf(targetPath: string, workspaceRoot: string): string | null {
  const targetSegments = targetPath.split("/");
  const rootSegments = workspaceRoot.split("/");
  if (targetSegments.length <= rootSegments.length) {
    return null;
  }
  const rootMatches = rootSegments.every(
    (segment, index) => segment.toLowerCase() === targetSegments[index]?.toLowerCase(),
  );
  return rootMatches ? targetSegments.slice(rootSegments.length).join("/") : null;
}

// Converts an absolute path inside `workspaceRoot` to its workspace-relative
// form (forward-slash separated). Returns null for the root itself, for paths
// outside the root, and for anything that still fails the relative-path safety
// check (so callers can hand the result straight to workspace file RPCs).
export function workspaceRelativePathOf(targetPath: string, workspaceRoot: string): string | null {
  const trimmedTarget = targetPath.trim();
  const trimmedRoot = workspaceRoot.trim();
  const normalizedTarget = normalizePathSeparators(trimmedTarget);
  const normalizedRoot = normalizePathSeparators(trimmedRoot).replace(/\/+$/, "");
  if (normalizedRoot.length === 0 || normalizedTarget.length === 0) {
    return null;
  }

  const compareCaseInsensitively =
    isNormalizedWindowsAbsolutePath(normalizedTarget) &&
    isNormalizedWindowsAbsolutePath(normalizedRoot);
  const relativePath = (
    compareCaseInsensitively
      ? windowsRelativePathOf(normalizedTarget, normalizedRoot)
      : normalizedTarget.startsWith(`${normalizedRoot}/`)
        ? normalizedTarget.slice(normalizedRoot.length + 1)
        : null
  )?.replace(/\/+$/, "");
  if (!relativePath) {
    return null;
  }
  return isWorkspaceRelativePathSafe(relativePath) ? relativePath : null;
}

// Inverse of `workspaceRelativePathOf`: joins a workspace root with a
// forward-slash relative path, matching the root's own separator style so the
// result stays a valid native path on Windows.
export function joinWorkspaceRelativePath(workspaceRoot: string, relativePath: string): string {
  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "");
  const normalizedRelativePath = relativePath.split("/").join(separator);
  return `${normalizedRoot}${separator}${normalizedRelativePath}`;
}

// True for workspace-relative paths that cannot escape the workspace root:
// rejects absolute paths (POSIX and Windows) and any "." / ".." segments.
export function isWorkspaceRelativePathSafe(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("/") || isWindowsAbsolutePath(trimmed)) {
    return false;
  }
  return trimmed.split(/[\\/]/).every((segment) => segment !== ".." && segment !== ".");
}
