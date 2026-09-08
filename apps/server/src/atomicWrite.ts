import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  syncDirectoryEntry,
  supportsPosixPermissions,
} from "./privatePathPermissions";

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  const missingDirectories: Array<string> = [];
  let existingDirectory = path.resolve(directoryPath);
  while (true) {
    try {
      const stat = await fs.lstat(existingDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Atomic write parent is not a real directory: ${existingDirectory}`);
      }
      if (supportsPosixPermissions() && (stat.mode & 0o022) !== 0) {
        throw new Error(
          `Atomic write parent directory is group/other writable: ${existingDirectory}`,
        );
      }
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      missingDirectories.unshift(existingDirectory);
      const parent = path.dirname(existingDirectory);
      if (parent === existingDirectory) throw cause;
      existingDirectory = parent;
    }
  }
  for (const missingDirectory of missingDirectories) {
    let created = false;
    try {
      await fs.mkdir(missingDirectory, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    const stat = await fs.lstat(missingDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Atomic write parent is not a real directory: ${missingDirectory}`);
    }
    if (created && supportsPosixPermissions()) {
      // This exact entry was atomically created by this call, so repairing the
      // umask-filtered mode cannot follow a pre-existing final symlink.
      await fs.chmod(missingDirectory, PRIVATE_DIRECTORY_MODE);
    } else if (supportsPosixPermissions() && (stat.mode & 0o022) !== 0) {
      throw new Error(`Atomic write parent directory is group/other writable: ${missingDirectory}`);
    }
    await syncDirectoryEntry(path.dirname(missingDirectory));
  }
  const privateFlags = supportsPosixPermissions()
    ? fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(directoryPath, fsConstants.O_RDONLY | privateFlags);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new Error(`Atomic write parent path is not a directory: ${directoryPath}`);
    }
    if (supportsPosixPermissions() && (stat.mode & 0o022) !== 0) {
      throw new Error(`Atomic write parent directory is group/other writable: ${directoryPath}`);
    }
  } finally {
    await handle.close();
  }
}

function assertSameRegularFile(descriptorStat: Stats, pathStat: Stats, tempPath: string): void {
  if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`Atomic write temporary path is not a regular file: ${tempPath}`);
  }
  if (
    supportsPosixPermissions() &&
    (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino)
  ) {
    throw new Error(`Atomic write temporary path identity changed: ${tempPath}`);
  }
}

/** Writes and fsyncs a fully verified temp file next to the final path. */
async function writeDurableTempFile(
  directoryPath: string,
  tempPath: string,
  contents: string | Uint8Array,
  mode: number,
): Promise<void> {
  await ensurePrivateDirectory(directoryPath);

  const noFollowFlag = supportsPosixPermissions() ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(
    tempPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag,
    mode,
  );
  let descriptorStat: Stats | undefined;
  try {
    if (supportsPosixPermissions()) await handle.chmod(mode);
    await handle.writeFile(contents);
    await handle.sync();
    descriptorStat = await handle.stat();
  } finally {
    await handle.close();
  }

  if (!descriptorStat) {
    throw new Error(`Failed to inspect atomic write temporary file: ${tempPath}`);
  }
  const pathStat = await fs.lstat(tempPath);
  assertSameRegularFile(descriptorStat, pathStat, tempPath);
}

const withTempFile = <A>(
  filePath: string,
  run: (tempPath: string) => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.sync(() => `${filePath}.${process.pid}.${randomUUID()}.tmp`).pipe(
    Effect.flatMap((tempPath) =>
      Effect.uninterruptible(
        Effect.tryPromise({
          try: () => run(tempPath),
          catch: (cause) => cause,
        }).pipe(
          Effect.ensuring(
            Effect.tryPromise(() => fs.rm(tempPath, { force: true })).pipe(
              Effect.ignore({ log: true }),
            ),
          ),
        ),
      ),
    ),
  );

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string | Uint8Array;
  readonly mode?: number;
}) => {
  const directoryPath = path.dirname(input.filePath);
  const mode = input.mode ?? PRIVATE_FILE_MODE;

  return withTempFile(input.filePath, async (tempPath) => {
    await writeDurableTempFile(directoryPath, tempPath, input.contents, mode);
    await fs.rename(tempPath, input.filePath);
    await syncDirectoryEntry(directoryPath);
  });
};

/**
 * Like {@link writeFileStringAtomically}, but only ever CREATES the file: the
 * fully written temp file is hard-linked into place, which fails when the
 * path already exists instead of replacing it. Resolves `true` when this call
 * created the file and `false` when another writer got there first — the
 * caller must then read the winner's contents. Because the link happens after
 * the temp file is complete, a concurrent reader never observes a partial
 * file either way.
 */
export const createFileStringExclusively = (input: {
  readonly filePath: string;
  readonly contents: string | Uint8Array;
  readonly mode?: number;
}) => {
  const directoryPath = path.dirname(input.filePath);
  const mode = input.mode ?? PRIVATE_FILE_MODE;

  return withTempFile(input.filePath, async (tempPath) => {
    await writeDurableTempFile(directoryPath, tempPath, input.contents, mode);
    try {
      await fs.link(tempPath, input.filePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw cause;
    }
    await syncDirectoryEntry(directoryPath);
    return true;
  });
};
