// FILE: workspaceFileChanges.ts
// Purpose: Stream bounded change notifications for one workspace file without
//          recursively watching the workspace.
// Layer: Server filesystem utility

import { watch as watchNodeFileSystem } from "node:fs";
import * as NodeFileSystem from "node:fs/promises";
import * as NodePath from "node:path";

import type { ProjectFileChangeEvent, ProjectWatchFileInput } from "@synara/contracts";
import { Cause, Duration, Effect, Queue, Stream } from "effect";

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

function watchTargetDirectory(targetPath: string): Stream.Stream<void, WorkspaceFileWatchError> {
  const directoryPath = NodePath.dirname(targetPath);
  const targetName = NodePath.basename(targetPath);

  return Stream.callback<void, WorkspaceFileWatchError>((queue) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const watcher = watchNodeFileSystem(
            directoryPath,
            { recursive: false },
            (_eventType, filename) => {
              if (filename !== null && NodePath.basename(filename.toString()) !== targetName) {
                return;
              }
              Queue.offerUnsafe(queue, undefined);
            },
          );
          const onError = (cause: Error) => {
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new WorkspaceFileWatchError("watch", targetPath, cause)),
            );
          };
          const onClose = () => Queue.endUnsafe(queue);
          watcher.on("error", onError);
          watcher.on("close", onClose);

          // Establish the watcher before emitting the initial state. The client
          // revalidates once after this event, closing the read-before-watch race.
          Queue.offerUnsafe(queue, undefined);
          return { watcher, onError, onClose };
        },
        catch: (cause) => new WorkspaceFileWatchError("watch", targetPath, cause),
      }),
      ({ watcher, onError, onClose }) =>
        Effect.sync(() => {
          watcher.off("error", onError);
          watcher.off("close", onClose);
          watcher.close();
        }),
    ).pipe(Effect.asVoid),
  );
}

async function readFileChangeState(
  input: ProjectWatchFileInput,
  targetPath: string,
): Promise<ProjectFileChangeEvent> {
  try {
    const realPath = await resolveRealPathWithinRoot(input.cwd, targetPath);
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
    throw new WorkspaceFileWatchError("stat", targetPath, cause);
  }
}

export function watchWorkspaceFile(
  input: ProjectWatchFileInput,
): Stream.Stream<ProjectFileChangeEvent, WorkspaceFileWatchError | WorkspacePathOutsideRootError> {
  return Stream.unwrap(
    Effect.tryPromise({
      try: () =>
        resolveRealPathForCreateWithinRoot(
          input.cwd,
          NodePath.resolve(input.cwd, input.relativePath),
        ),
      catch: (cause) =>
        new WorkspaceFileWatchError(
          "prepare",
          NodePath.resolve(input.cwd, input.relativePath),
          cause,
        ),
    }).pipe(
      Effect.flatMap((targetPath) =>
        targetPath === null
          ? Effect.fail(
              new WorkspacePathOutsideRootError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
              }),
            )
          : Effect.succeed(targetPath),
      ),
      Effect.map((targetPath) =>
        watchTargetDirectory(targetPath).pipe(
          Stream.debounce(Duration.millis(FILE_CHANGE_DEBOUNCE_MS)),
          Stream.mapEffect(() =>
            Effect.tryPromise({
              try: () => readFileChangeState(input, targetPath),
              catch: (cause) =>
                cause instanceof WorkspaceFileWatchError
                  ? cause
                  : new WorkspaceFileWatchError("stat", targetPath, cause),
            }),
          ),
        ),
      ),
    ),
  );
}
