// FILE: localFolderMentions.ts
// Purpose: Centralize the composer rules for entering local-folder mention browsing.
// Layer: Web composer helper
// Exports: local mention constants plus query/root helpers used by ChatView and command menus.

export const LOCAL_FOLDER_MENTION_NAME = "local";

const UNC_SHARE_ROOT_PATTERN = /^(\\\\[^\\/]+[\\/][^\\/]+)(?:[\\/]|$)/;

export function matchesLocalFolderMentionShortcut(query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }
  return LOCAL_FOLDER_MENTION_NAME.startsWith(normalizedQuery);
}

export function isLocalFolderMentionQuery(query: string): boolean {
  const normalizedQuery = query.trim();
  if (normalizedQuery.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(normalizedQuery)) return true;
  if (UNC_SHARE_ROOT_PATTERN.test(normalizedQuery)) return true;
  if (normalizedQuery.startsWith("~/") || normalizedQuery.startsWith("~\\")) return true;
  return false;
}

export function getLocalFolderBrowseRootPath(
  homeDir: string | null | undefined,
  preferFilesystemRoot: boolean,
): string | null {
  const normalizedHomeDir = homeDir?.trim() ?? "";
  if (normalizedHomeDir.length === 0) {
    return null;
  }

  if (!preferFilesystemRoot) {
    return normalizedHomeDir;
  }

  const windowsRootMatch = /^[A-Za-z]:[\\/]/.exec(normalizedHomeDir);
  if (windowsRootMatch) {
    return windowsRootMatch[0].replace(/\//g, "\\");
  }

  const uncShareRootMatch = UNC_SHARE_ROOT_PATTERN.exec(normalizedHomeDir);
  if (uncShareRootMatch?.[1]) {
    return `${uncShareRootMatch[1].replace(/\//g, "\\")}\\`;
  }

  if (normalizedHomeDir.startsWith("/")) {
    return "/";
  }

  return normalizedHomeDir;
}

/**
 * Expand a leading `~` / `~/` / `~\` into the configured home directory.
 * Returns the input unchanged when the path does not start with `~` or when
 * homeDir is missing (so the caller can surface "unavailable" states).
 */
export function expandLocalFolderPath(value: string, homeDir: string | null | undefined): string {
  if (!value) return value;
  const normalizedHomeDir = homeDir?.trim() ?? "";
  if (!normalizedHomeDir) return value;
  if (value === "~") return normalizedHomeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    const separator = value[1] as "/" | "\\";
    const suffix = value.slice(2);
    if (!suffix) return normalizedHomeDir;
    const homeEndsWithSeparator =
      normalizedHomeDir.endsWith("/") || normalizedHomeDir.endsWith("\\");
    return homeEndsWithSeparator
      ? `${normalizedHomeDir}${suffix}`
      : `${normalizedHomeDir}${separator}${suffix}`;
  }
  return value;
}
