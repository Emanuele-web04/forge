import { PROJECT_EXTERNAL_FILE_CANDIDATE_MAX_COUNT } from "@synara/contracts";
import {
  isLocalAbsolutePath,
  isWorkspaceRelativePathSafe,
  joinWorkspaceRelativePath,
} from "@synara/shared/path";

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
const INLINE_CODE_SPAN_PATTERN = /`([^`\n]+)`/g;

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

function pathWithoutPositionSuffix(value: string): string {
  return value.trim().replace(POSITION_SUFFIX_PATTERN, "");
}

function nearestPrecedingAbsoluteInlineCodePath(text: string, beforeOffset: number): string | null {
  let nearest: string | null = null;
  for (const match of text.matchAll(INLINE_CODE_SPAN_PATTERN)) {
    if ((match.index ?? text.length) >= beforeOffset) {
      break;
    }
    const candidate = pathWithoutPositionSuffix(match[1] ?? "");
    if (isLocalAbsolutePath(candidate)) {
      nearest = candidate;
    }
  }
  return nearest;
}

/**
 * Builds exact absolute fallback candidates for one relative reference from
 * bounded same-turn provenance. Structured tool paths only count when they
 * already end in the full relative suffix. The nearest preceding absolute
 * inline-code path in the same assistant message may also act as its base,
 * which covers lists introduced by `Dir: /absolute/path` without combining
 * the reference with every unrelated directory mentioned later in the turn.
 */
export function deriveMarkdownExternalFileCandidates(input: {
  readonly text: string;
  readonly reference: string;
  readonly referenceOffset: number;
  readonly provenancePaths?: ReadonlyArray<string>;
}): string[] {
  const relativePath = pathWithoutPositionSuffix(input.reference);
  if (!isWorkspaceRelativePathSafe(relativePath)) {
    return [];
  }

  const normalizedSuffix = relativePath.replace(/\\/g, "/");
  const candidates = new Set<string>();
  const addExactSuffixMatch = (rawPath: string) => {
    const candidate = pathWithoutPositionSuffix(rawPath);
    if (
      isLocalAbsolutePath(candidate) &&
      candidate.replace(/\\/g, "/").endsWith(`/${normalizedSuffix}`)
    ) {
      candidates.add(candidate);
    }
  };

  for (const provenancePath of input.provenancePaths ?? []) {
    addExactSuffixMatch(provenancePath);
    if (candidates.size >= PROJECT_EXTERNAL_FILE_CANDIDATE_MAX_COUNT) {
      return [...candidates];
    }
  }

  const messageBase = nearestPrecedingAbsoluteInlineCodePath(input.text, input.referenceOffset);
  if (messageBase) {
    addExactSuffixMatch(messageBase);
    if (candidates.size < PROJECT_EXTERNAL_FILE_CANDIDATE_MAX_COUNT) {
      candidates.add(joinWorkspaceRelativePath(messageBase, normalizedSuffix));
    }
  }

  return [...candidates].slice(0, PROJECT_EXTERNAL_FILE_CANDIDATE_MAX_COUNT);
}
