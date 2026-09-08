// FILE: studioOutputs.ts
// Purpose: Resolve the files a single Studio chat produced anywhere under the Studio
//          workspace root, from checkpoint summaries (Git roots), persisted file-change
//          activities, and captured per-turn output activities (non-Git roots). Also owns
//          the bounded workspace tree scan the StudioOutputReactor diffs per turn.
// Layer: Server workspace helper
// Exports: Pure attribution/scan-diff helpers + listStudioThreadOutputs (Effect I/O).

import type { StudioOutputEntry } from "@synara/contracts";
import { Effect, FileSystem, Path } from "effect";

// Managed Studio subtrees that hold inputs or infrastructure, never produced content.
// Compared case-insensitively so an agent-created "logs"/"TMP" variant is excluded too.
const EXCLUDED_TOP_LEVEL_DIRECTORY_NAMES = new Set(["tmp", "logs", "inbox", "context", "skills"]);

// Managed provider instruction files live at the workspace root. They are
// infrastructure even when the self-healing scaffold creates them mid-turn.
const EXCLUDED_ROOT_FILE_NAMES = new Set(["agents.md", "claude.md"]);

// Never treated as outputs (or descended into) at any depth.
const EXCLUDED_NESTED_DIRECTORY_NAMES = new Set(["node_modules"]);

// Upper bound on how many distinct files a single request will stat. Checkpoint file
// lists are deduplicated, so a realistic chat stays far below this; the cap only guards
// a pathological thread whose turns touched thousands of files. Newest turns are
// collected first, so when the cap bites it drops the OLDEST outputs.
export const MAX_THREAD_OUTPUT_FILES = 500;

// How many `stat` calls run concurrently. Bounded so a large output list doesn't open
// hundreds of file descriptors at once.
export const STAT_CONCURRENCY = 16;

// Bounds for the per-turn workspace scan: the Studio root is a content folder, not a
// codebase, so realistic trees stay far below these limits. They only guard pathological
// content (an agent cloning a repository into the root).
export const MAX_SCAN_DEPTH = 8;
export const MAX_SCAN_FILES = 4_000;
export const MAX_SCAN_ENTRIES = 20_000;
const SCAN_STAT_BATCH_SIZE = STAT_CONCURRENCY * 4;

interface CheckpointFileLike {
  readonly path: string;
}

interface CheckpointLike {
  readonly files: ReadonlyArray<CheckpointFileLike>;
}

const ACTIVITY_PATH_KEYS = new Set(["path", "filePath", "file_path"]);
const FAILED_FILE_CHANGE_STATUSES = new Set(["failed", "declined"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExcludedTopLevelSegment(segment: string): boolean {
  return EXCLUDED_TOP_LEVEL_DIRECTORY_NAMES.has(segment.toLowerCase());
}

function isExcludedRootFileName(fileName: string): boolean {
  return EXCLUDED_ROOT_FILE_NAMES.has(fileName.toLowerCase());
}

// Rejects empty/dot segments so a crafted or malformed path can never escape the
// workspace root, and skips hidden files (e.g. .DS_Store, .git) plus nested
// infrastructure folders like node_modules.
function isSafeVisibleSegments(segments: readonly string[]): boolean {
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith(".") &&
      !EXCLUDED_NESTED_DIRECTORY_NAMES.has(segment.toLowerCase()),
  );
}

/** Whether a workspace-root-relative POSIX path counts as produced Studio output. */
export function isStudioOutputRelativePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const first = segments[0];
  if (first === undefined || segments.length === 0) {
    return false;
  }
  if (segments.length === 1 && isExcludedRootFileName(first)) {
    return false;
  }
  if (segments.length > 1 && isExcludedTopLevelSegment(first)) {
    return false;
  }
  return isSafeVisibleSegments(segments);
}

/** Pulls path-shaped fields from one bounded file-change activity payload. */
function collectActivityPathValues(value: unknown, paths: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectActivityPathValues(item, paths, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (ACTIVITY_PATH_KEYS.has(key) && typeof child === "string" && child.trim().length > 0) {
      paths.push(child.trim());
      continue;
    }
    collectActivityPathValues(child, paths, depth + 1);
  }
}

/**
 * Extracts newest-first file paths from completed file-change activities. Providers use
 * different nested payload shapes, so only explicit path keys are accepted.
 */
export function collectFileChangeActivityPathCandidates(
  payloadsNewestFirst: ReadonlyArray<unknown>,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const payload of payloadsNewestFirst) {
    if (!isRecord(payload)) {
      continue;
    }
    if (
      typeof payload.status === "string" &&
      FAILED_FILE_CHANGE_STATUSES.has(payload.status.toLowerCase())
    ) {
      continue;
    }
    const candidates: string[] = [];
    collectActivityPathValues(payload.data, candidates);
    for (const candidate of candidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        paths.push(candidate);
      }
    }
  }

  return paths;
}

/**
 * Checkpoint diff paths are git-style POSIX paths relative to the thread cwd (the Studio
 * root). Keep only safe output paths (excluded/hidden subtrees dropped) and return them
 * relative to the workspace root, newest checkpoint first, deduplicated.
 */
export function collectThreadOutputRelativePaths(
  checkpoints: ReadonlyArray<CheckpointLike>,
): string[] {
  const relativePaths: string[] = [];
  const seen = new Set<string>();

  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    if (!checkpoint) {
      continue;
    }
    for (const file of checkpoint.files) {
      if (relativePaths.length >= MAX_THREAD_OUTPUT_FILES) {
        return relativePaths;
      }
      if (!isStudioOutputRelativePath(file.path) || seen.has(file.path)) {
        continue;
      }
      seen.add(file.path);
      relativePaths.push(file.path);
    }
  }

  return relativePaths;
}

/** One scanned file's identity for turn-boundary diffing. */
export interface StudioWorkspaceFileStat {
  readonly mtimeMs: number;
  readonly size: number;
}

/** Workspace-root-relative POSIX path -> file identity, for one scan pass. */
export type StudioWorkspaceScan = ReadonlyMap<string, StudioWorkspaceFileStat>;

/**
 * Bounded walk of the Studio workspace root collecting candidate output files.
 * Managed input/infra subtrees, hidden entries, and symlinked directories are skipped;
 * depth, entry-count, and file-count caps keep a pathological tree from stalling the reactor.
 * Unreadable entries are skipped instead of failing the scan.
 */
export const scanStudioWorkspaceFiles = Effect.fnUntraced(function* (input: {
  readonly workspaceRoot: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const files = new Map<string, StudioWorkspaceFileStat>();
  const pendingDirectories: Array<{ readonly segments: readonly string[] }> = [{ segments: [] }];
  let scannedEntryCount = 0;

  while (
    pendingDirectories.length > 0 &&
    files.size < MAX_SCAN_FILES &&
    scannedEntryCount < MAX_SCAN_ENTRIES
  ) {
    const directory = pendingDirectories.pop();
    if (!directory) {
      break;
    }
    const directoryPath = path.join(input.workspaceRoot, ...directory.segments);
    const entryNames = yield* fileSystem
      .readDirectory(directoryPath)
      .pipe(Effect.catch(() => Effect.succeed<string[]>([])));

    let entryIndex = 0;
    while (
      entryIndex < entryNames.length &&
      files.size < MAX_SCAN_FILES &&
      scannedEntryCount < MAX_SCAN_ENTRIES
    ) {
      const batch: Array<{ readonly entryPath: string; readonly segments: readonly string[] }> = [];
      while (
        entryIndex < entryNames.length &&
        batch.length < SCAN_STAT_BATCH_SIZE &&
        scannedEntryCount < MAX_SCAN_ENTRIES
      ) {
        const entryName = entryNames[entryIndex];
        entryIndex += 1;
        if (entryName === undefined) {
          continue;
        }
        // Count every directory entry, including excluded and unreadable ones. A
        // file-only cap does not bound a tree containing thousands of directories.
        scannedEntryCount += 1;
        const segments = [...directory.segments, entryName];
        if (!isSafeVisibleSegments([entryName])) {
          continue;
        }
        if (
          segments.length === 1 &&
          (isExcludedTopLevelSegment(entryName) || isExcludedRootFileName(entryName))
        ) {
          continue;
        }
        batch.push({
          entryPath: path.join(directoryPath, entryName),
          segments,
        });
      }

      const statResults = yield* Effect.forEach(
        batch,
        (entry) =>
          fileSystem.stat(entry.entryPath).pipe(
            Effect.flatMap((info) => {
              if (info.type !== "Directory" || entry.segments.length >= MAX_SCAN_DEPTH) {
                return Effect.succeed({ ...entry, info, isLinkedDirectory: false });
              }
              // stat() follows symlinks, so a linked directory reports as
              // "Directory"; readLink distinguishes it without following it.
              return fileSystem.readLink(entry.entryPath).pipe(
                Effect.match({
                  onFailure: () => ({ ...entry, info, isLinkedDirectory: false }),
                  onSuccess: () => ({ ...entry, info, isLinkedDirectory: true }),
                }),
              );
            }),
            Effect.catch(() => Effect.succeed(null)),
          ),
        { concurrency: STAT_CONCURRENCY },
      );

      for (const result of statResults) {
        if (!result) {
          continue;
        }
        if (result.info.type === "File") {
          if (files.size >= MAX_SCAN_FILES) {
            break;
          }
          files.set(result.segments.join("/"), {
            mtimeMs: result.info.mtime?.getTime() ?? 0,
            size: Number(result.info.size),
          });
          continue;
        }
        if (result.info.type === "Directory" && !result.isLinkedDirectory) {
          pendingDirectories.push({ segments: result.segments });
        }
      }
    }
  }

  return files as StudioWorkspaceScan;
});

/**
 * Files present in `after` that are new or changed since `before`, i.e. the outputs a
 * turn produced. Deletions are ignored: a removed file is no longer a listable output.
 */
export function diffStudioWorkspaceScans(
  before: StudioWorkspaceScan,
  after: StudioWorkspaceScan,
): string[] {
  const changed: string[] = [];
  for (const [relativePath, stat] of after) {
    const previous = before.get(relativePath);
    if (!previous || previous.mtimeMs !== stat.mtimeMs || previous.size !== stat.size) {
      changed.push(relativePath);
    }
  }
  return changed;
}

/**
 * Canonical payload persisted whenever the server attributes workspace files to a
 * Studio turn. Both the turn-boundary scanner and out-of-workspace generated-image
 * capture use this shape so the listing query has one path extraction contract.
 */
export function studioOutputsCapturedActivityPayload(
  relativePaths: readonly string[],
  options?: {
    readonly generatedImage?: {
      readonly origin?: "codex.explicit_image_generation";
      readonly sourcePath: string;
      readonly fullPath: string;
    };
  },
) {
  return {
    itemType: "studio_outputs" as const,
    data: {
      files: relativePaths.map((path) => ({ path })),
      ...(options?.generatedImage ? { generatedImage: options.generatedImage } : {}),
    },
  };
}

/**
 * Stats the thread-attributed output files and returns the ones that still exist, most
 * recently modified first. Missing or unreadable files are omitted instead of failing.
 */
export const listStudioThreadOutputs = Effect.fnUntraced(function* (input: {
  readonly workspaceRoot: string;
  readonly checkpoints: ReadonlyArray<CheckpointLike>;
  readonly fileChangeActivityPayloads?: ReadonlyArray<unknown>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const relativePaths = collectThreadOutputRelativePaths(input.checkpoints);
  const seenRelativePaths = new Set(relativePaths);
  const activityPathCandidates = collectFileChangeActivityPathCandidates(
    input.fileChangeActivityPayloads ?? [],
  );
  for (const candidate of activityPathCandidates) {
    if (relativePaths.length >= MAX_THREAD_OUTPUT_FILES) {
      break;
    }
    if (candidate.includes("\0")) {
      continue;
    }
    const absolutePath = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(input.workspaceRoot, candidate);
    const relativePath = path.relative(input.workspaceRoot, absolutePath);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith(`..${path.sep}`) ||
      relativePath === ".." ||
      path.isAbsolute(relativePath)
    ) {
      continue;
    }
    const posixRelativePath = relativePath.split(path.sep).join("/");
    if (
      !isStudioOutputRelativePath(posixRelativePath) ||
      seenRelativePaths.has(posixRelativePath)
    ) {
      continue;
    }
    seenRelativePaths.add(posixRelativePath);
    relativePaths.push(posixRelativePath);
  }

  const statResults = yield* Effect.forEach(
    relativePaths,
    (relativePath) => {
      const fullPath = path.join(input.workspaceRoot, ...relativePath.split("/"));
      return fileSystem.stat(fullPath).pipe(
        Effect.map((info) =>
          info.type === "File"
            ? { relativePath, fullPath, modifiedAtMs: info.mtime?.getTime() ?? 0 }
            : null,
        ),
        Effect.catch(() => Effect.succeed(null)),
      );
    },
    { concurrency: STAT_CONCURRENCY },
  );

  const entries: StudioOutputEntry[] = statResults
    .filter((result) => result !== null)
    .toSorted((left, right) => right.modifiedAtMs - left.modifiedAtMs)
    .map((result) => ({
      name: result.relativePath.split("/").at(-1) ?? result.relativePath,
      relativePath: result.relativePath,
      fullPath: result.fullPath,
      modifiedAt: new Date(result.modifiedAtMs).toISOString(),
    }));

  return { entries };
});
