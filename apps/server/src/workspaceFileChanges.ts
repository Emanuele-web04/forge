// FILE: workspaceFileChanges.ts
// Purpose: Stream bounded change notifications for one workspace file without
//          recursively watching the workspace.
// Layer: Server filesystem utility

import { type FSWatcher, watch as watchNodeFileSystem } from "node:fs";
import * as NodeFileSystem from "node:fs/promises";
import * as NodePath from "node:path";

import type { ProjectFileChangeEvent, ProjectWatchFileInput } from "@synara/contracts";
import { Cause, Effect, Queue, Stream } from "effect";

import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";
import {
  resolveRealPathForCreateWithinRoot,
  resolveRealPathWithinRoot,
} from "./workspace/realPathContainment";

const FILE_CHANGE_DEBOUNCE_MS = 100;

export class WorkspaceFileWatchError extends Error {
  constructor(
    readonly operation: "prepare" | "watch" | "stat",
    readonly filePath: string,
    override readonly cause: unknown,
  ) {
    super(
      `Failed to ${operation} workspace file watch for ${filePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "WorkspaceFileWatchError";
  }
}

function isFileNotFoundError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function outsideRootError(input: ProjectWatchFileInput): WorkspacePathOutsideRootError {
  return new WorkspacePathOutsideRootError({
    workspaceRoot: input.cwd,
    relativePath: input.relativePath,
  });
}

async function resolveWatchTargets(input: ProjectWatchFileInput): Promise<string[] | null> {
  const lexicalTargetPath = NodePath.resolve(input.cwd, input.relativePath);
  const [entryParentPath, resolvedTargetPath] = await Promise.all([
    resolveRealPathWithinRoot(input.cwd, NodePath.dirname(lexicalTargetPath)),
    resolveRealPathForCreateWithinRoot(input.cwd, lexicalTargetPath),
  ]);
  if (entryParentPath === null || resolvedTargetPath === null) {
    return null;
  }

  // Keep the lexical directory entry watched even when the file is a symlink.
  // The resolved target catches content writes; the entry catches unlink and
  // retarget operations. Canonicalizing the parent avoids duplicate watchers
  // when the workspace root itself is reached through a symlink.
  const entryPath = NodePath.join(entryParentPath, NodePath.basename(lexicalTargetPath));
  return [...new Set([entryPath, resolvedTargetPath])];
}

async function readFileChangeState(input: ProjectWatchFileInput): Promise<ProjectFileChangeEvent> {
  const lexicalTargetPath = NodePath.resolve(input.cwd, input.relativePath);
  try {
    const realPath = await resolveRealPathWithinRoot(input.cwd, lexicalTargetPath);
    if (realPath === null) {
      return { type: "deleted", relativePath: input.relativePath };
    }
    const stat = await NodeFileSystem.stat(realPath);
    return stat.isFile()
      ? { type: "changed", relativePath: input.relativePath, mtimeMs: stat.mtimeMs }
      : { type: "deleted", relativePath: input.relativePath };
  } catch (cause) {
    if (isFileNotFoundError(cause)) {
      return { type: "deleted", relativePath: input.relativePath };
    }
    throw new WorkspaceFileWatchError("stat", lexicalTargetPath, cause);
  }
}

interface WatchedDirectory {
  readonly watcher: FSWatcher;
  names: ReadonlySet<string>;
  readonly onError: (cause: Error) => void;
  readonly onClose: () => void;
}

function groupWatchTargets(targetPaths: ReadonlyArray<string>): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const targetPath of targetPaths) {
    const directoryPath = NodePath.dirname(targetPath);
    const names = grouped.get(directoryPath) ?? new Set<string>();
    names.add(NodePath.basename(targetPath));
    grouped.set(directoryPath, names);
  }
  return grouped;
}

function watchTargetDirectories(
  input: ProjectWatchFileInput,
  initialTargetPaths: ReadonlyArray<string>,
): Stream.Stream<ProjectFileChangeEvent, WorkspaceFileWatchError | WorkspacePathOutsideRootError> {
  const lexicalTargetPath = NodePath.resolve(input.cwd, input.relativePath);

  return Stream.callback<
    ProjectFileChangeEvent,
    WorkspaceFileWatchError | WorkspacePathOutsideRootError
  >((queue) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const watchedDirectories = new Map<string, WatchedDirectory>();
          let closed = false;
          let debounceTimer: ReturnType<typeof setTimeout> | null = null;
          let refreshInFlight = false;
          let refreshAgain = false;

          const closeWatchedDirectory = (directory: WatchedDirectory) => {
            directory.watcher.off("error", directory.onError);
            directory.watcher.off("close", directory.onClose);
            directory.watcher.close();
          };
          const closeAllWatchedDirectories = () => {
            for (const directory of watchedDirectories.values()) {
              closeWatchedDirectory(directory);
            }
            watchedDirectories.clear();
          };
          const fail = (cause: WorkspaceFileWatchError | WorkspacePathOutsideRootError) => {
            if (closed) return;
            closed = true;
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            closeAllWatchedDirectories();
            Queue.failCauseUnsafe(queue, Cause.fail(cause));
          };

          const refreshTargets = (targetPaths: ReadonlyArray<string>) => {
            const nextDirectories = groupWatchTargets(targetPaths);

            // Add new directory watches before removing obsolete ones so a
            // symlink retarget never leaves its lexical entry unwatched.
            for (const [directoryPath, names] of nextDirectories) {
              const existing = watchedDirectories.get(directoryPath);
              if (existing) {
                existing.names = names;
                continue;
              }

              let directory!: WatchedDirectory;
              const watcher = watchNodeFileSystem(
                directoryPath,
                { recursive: false },
                (_eventType, filename) => {
                  if (
                    filename !== null &&
                    !directory.names.has(NodePath.basename(filename.toString()))
                  ) {
                    return;
                  }
                  scheduleRefresh();
                },
              );
              const onError = (cause: Error) =>
                fail(new WorkspaceFileWatchError("watch", directoryPath, cause));
              const onClose = () =>
                fail(
                  new WorkspaceFileWatchError(
                    "watch",
                    directoryPath,
                    new Error("File watcher closed unexpectedly."),
                  ),
                );
              directory = { watcher, names, onError, onClose };
              watcher.on("error", onError);
              watcher.on("close", onClose);
              watchedDirectories.set(directoryPath, directory);
            }

            for (const [directoryPath, directory] of watchedDirectories) {
              if (nextDirectories.has(directoryPath)) continue;
              watchedDirectories.delete(directoryPath);
              closeWatchedDirectory(directory);
            }
          };

          const refreshAndEmit = async () => {
            if (refreshInFlight || closed) {
              refreshAgain = true;
              return;
            }
            refreshInFlight = true;
            try {
              do {
                refreshAgain = false;
                let targetPaths: string[] | null;
                try {
                  targetPaths = await resolveWatchTargets(input);
                } catch (cause) {
                  if (isFileNotFoundError(cause)) {
                    // A previously valid symlink can become temporarily
                    // dangling. Keep its lexical-entry and last target
                    // directory watches alive so recreating the target is
                    // observable, while reporting the current file deleted.
                    if (!closed) {
                      Queue.offerUnsafe(queue, {
                        type: "deleted",
                        relativePath: input.relativePath,
                      });
                    }
                    continue;
                  }
                  throw cause;
                }
                if (targetPaths === null) {
                  fail(outsideRootError(input));
                  return;
                }
                refreshTargets(targetPaths);
                const event = await readFileChangeState(input);
                if (!closed) Queue.offerUnsafe(queue, event);
              } while (refreshAgain && !closed);
            } catch (cause) {
              fail(
                cause instanceof WorkspacePathOutsideRootError ||
                  cause instanceof WorkspaceFileWatchError
                  ? cause
                  : new WorkspaceFileWatchError("stat", lexicalTargetPath, cause),
              );
            } finally {
              refreshInFlight = false;
            }
          };

          function scheduleRefresh() {
            if (closed) return;
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              debounceTimer = null;
              void refreshAndEmit();
            }, FILE_CHANGE_DEBOUNCE_MS);
          }

          try {
            refreshTargets(initialTargetPaths);
            // Establish every watcher before reading and emitting the initial
            // state, closing the read-before-watch race.
            Queue.offerUnsafe(queue, await readFileChangeState(input));
          } catch (cause) {
            // acquireRelease cannot finalize a resource whose acquisition
            // rejected, so close any watchers opened before the failure here.
            closed = true;
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            closeAllWatchedDirectories();
            throw cause;
          }

          return {
            close: () => {
              closed = true;
              if (debounceTimer !== null) clearTimeout(debounceTimer);
              closeAllWatchedDirectories();
            },
          };
        },
        catch: (cause) =>
          cause instanceof WorkspacePathOutsideRootError || cause instanceof WorkspaceFileWatchError
            ? cause
            : new WorkspaceFileWatchError("watch", lexicalTargetPath, cause),
      }),
      (resource) => Effect.sync(resource.close),
    ).pipe(Effect.asVoid),
  );
}

export function watchWorkspaceFile(
  input: ProjectWatchFileInput,
): Stream.Stream<ProjectFileChangeEvent, WorkspaceFileWatchError | WorkspacePathOutsideRootError> {
  return Stream.unwrap(
    Effect.tryPromise({
      try: () => resolveWatchTargets(input),
      catch: (cause) =>
        new WorkspaceFileWatchError(
          "prepare",
          NodePath.resolve(input.cwd, input.relativePath),
          cause,
        ),
    }).pipe(
      Effect.flatMap((targetPaths) =>
        targetPaths === null ? Effect.fail(outsideRootError(input)) : Effect.succeed(targetPaths),
      ),
      Effect.map((targetPaths) => watchTargetDirectories(input, targetPaths)),
    ),
  );
}
