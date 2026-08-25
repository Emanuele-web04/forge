import { isLocalAbsolutePath, isWorkspaceRelativePathSafe } from "@synara/shared/path";

import { resolvePathLinkTarget } from "./terminal-links";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
] as const;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const rawPath = parsed.pathname;
    if (rawPath.length === 0) return null;

    // Browser URL parser encodes "C:/foo" as "/C:/foo" for file URLs.
    const normalizedPath = /^\/[A-Za-z]:[\\/]/.test(rawPath) ? rawPath.slice(1) : rawPath;

    return {
      path: options?.decodePath === false ? normalizedPath : safeDecode(normalizedPath),
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(href.trim(), { decodePath: false });
  if (!target) return null;
  return `${target.path}${target.hash}`;
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

function pathWithoutPositionSuffix(value: string): string {
  return value.trim().replace(POSITION_SUFFIX_PATTERN, "");
}

const LEADING_COLLAPSED_SEGMENT_PATTERN = /^(?:\.{3}|…)\/+/;

function stripCollapsedRelativePrefix(path: string): string {
  let next = path;
  while (LEADING_COLLAPSED_SEGMENT_PATTERN.test(next)) {
    next = next.replace(LEADING_COLLAPSED_SEGMENT_PATTERN, "");
  }
  return next;
}

function pathBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function uniqueAbsolutePathEndingWith(
  suffix: string,
  knownAbsolutePaths: ReadonlyArray<string>,
): string | null {
  let match: string | null = null;
  for (const rawPath of knownAbsolutePaths) {
    const candidate = pathWithoutPositionSuffix(rawPath).replaceAll("\\", "/");
    if (!isLocalAbsolutePath(candidate)) continue;
    if (candidate !== suffix && !candidate.endsWith(`/${suffix}`)) continue;
    if (match !== null && match !== candidate) return null;
    match = candidate;
  }
  return match;
}

function looksLikeAbsoluteFilePath(path: string): boolean {
  const basename = pathBasename(path);
  return basename.includes(".") && RELATIVE_FILE_NAME_PATTERN.test(basename);
}

function joinAbsoluteDirectory(directory: string, relative: string): string {
  const dir = directory.replaceAll("\\", "/").replace(/\/+$/, "");
  const suffix = relative.replaceAll("\\", "/").replace(/^\/+/, "");
  return `${dir}/${suffix}`;
}

const BACKTICK_SPAN_PATTERN = /`([^`]+)`/g;
const BARE_POSIX_ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s(])(\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root)\/[^\s`'")]*)/g;

/**
 * Absolute local files and directories already written in the markdown.
 * Used to join later relative chips (`scripts/foo.py`) onto `Dir: /abs`.
 */
export function extractAbsoluteFilesystemPaths(text: string): string[] {
  const found = new Set<string>();
  const consider = (raw: string) => {
    const trimmed = raw.trim().replace(/[,.;]+$/, "");
    if (trimmed.length === 0) return;
    const candidate = pathWithoutPositionSuffix(trimmed).replace(/\/+$/, "");
    if (candidate.length === 0 || hasExternalScheme(candidate)) return;
    if (!isLocalAbsolutePath(candidate) && !looksLikePosixFilesystemPath(candidate)) return;
    found.add(candidate);
  };

  for (const match of text.matchAll(BACKTICK_SPAN_PATTERN)) {
    consider(match[1] ?? "");
  }
  for (const match of text.matchAll(BARE_POSIX_ABSOLUTE_PATH_PATTERN)) {
    consider(match[1] ?? "");
  }
  return [...found];
}

function uniqueJoinAgainstKnownDirectories(
  suffix: string,
  knownAbsolutePaths: ReadonlyArray<string>,
): string | null {
  const matches = new Set<string>();
  for (const rawPath of knownAbsolutePaths) {
    const candidate = pathWithoutPositionSuffix(rawPath).replaceAll("\\", "/");
    if (!isLocalAbsolutePath(candidate) || looksLikeAbsoluteFilePath(candidate)) continue;
    matches.add(joinAbsoluteDirectory(candidate, suffix));
  }
  return matches.size === 1 ? ([...matches][0] ?? null) : null;
}

/**
 * If exactly one known absolute path already ends with this relative
 * reference, return that path. Zero or several matches return null so the
 * caller can keep the workspace cwd join.
 */
export function resolveUniqueAbsoluteSuffixTarget(
  reference: string,
  knownAbsolutePaths: ReadonlyArray<string>,
): string | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;

  const suffix = stripCollapsedRelativePrefix(
    pathWithoutPositionSuffix(trimmed).replaceAll("\\", "/"),
  );
  if (
    suffix.length === 0 ||
    suffix.includes("\0") ||
    !isRelativePath(suffix) ||
    !isWorkspaceRelativePathSafe(suffix)
  ) {
    return null;
  }

  const match =
    uniqueAbsolutePathEndingWith(suffix, knownAbsolutePaths) ??
    uniqueJoinAgainstKnownDirectories(suffix, knownAbsolutePaths) ??
    (pathBasename(suffix) === suffix
      ? null
      : uniqueAbsolutePathEndingWith(pathBasename(suffix), knownAbsolutePaths));
  if (match === null) return null;

  const position = POSITION_SUFFIX_PATTERN.exec(trimmed)?.[0] ?? "";
  return `${match}${position}`;
}

export function resolveChatFileChipTarget(
  reference: string | undefined,
  cwd: string | undefined,
  knownAbsolutePaths?: ReadonlyArray<string>,
): string | null {
  if (!reference) return null;
  const knownTarget =
    knownAbsolutePaths && knownAbsolutePaths.length > 0
      ? resolveUniqueAbsoluteSuffixTarget(reference, knownAbsolutePaths)
      : null;
  return knownTarget ?? resolveMarkdownFileLinkTarget(reference, cwd);
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!href) return null;
  const rawHref = href.trim();
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim());
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!cwd) return null;
  return resolvePathLinkTarget(pathWithPosition, cwd);
}
