import fs from "node:fs";
import path from "node:path";

import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";
export {
  sameFileIdentity,
  supportsPosixPermissions,
  syncDirectoryEntry,
  syncRegularFile,
} from "@synara/shared/filesystemPlatform";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_EXECUTABLE_FILE_MODE = 0o700;

export class PrivatePathPermissionError extends Error {
  readonly path: string;
  readonly operation: string;

  constructor(operation: string, targetPath: string, cause: unknown) {
    super(`Failed to ${operation} private path ${targetPath}`, { cause });
    this.name = "PrivatePathPermissionError";
    this.path = targetPath;
    this.operation = operation;
  }
}

function withPathContext<T>(operation: string, targetPath: string, action: () => T): T {
  try {
    return action();
  } catch (cause) {
    if (cause instanceof PrivatePathPermissionError) throw cause;
    throw new PrivatePathPermissionError(operation, targetPath, cause);
  }
}

export function ensurePrivateDirectorySync(
  directoryPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  withPathContext("create", directoryPath, () => {
    fs.mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  });
  if (!supportsPosixPermissions(platform)) return;

  // O_NOFOLLOW prevents an existing state/log directory symlink from turning
  // startup permission repair into chmod of an unrelated external tree.
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const descriptor = withPathContext("open without following symlinks", directoryPath, () =>
    fs.openSync(directoryPath, directoryFlags),
  );
  try {
    withPathContext("set mode on", directoryPath, () => {
      if (!fs.fstatSync(descriptor).isDirectory()) {
        throw new Error("Path is not a directory");
      }
      fs.fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function repairPrivateFileSync(
  filePath: string,
  options: {
    readonly executable?: boolean;
    readonly platform?: NodeJS.Platform;
  } = {},
): void {
  if (!supportsPosixPermissions(options.platform)) return;
  const targetMode = options.executable ? PRIVATE_EXECUTABLE_FILE_MODE : PRIVATE_FILE_MODE;
  const descriptor = withPathContext("open without following symlinks", filePath, () =>
    fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
  );
  try {
    withPathContext("set mode on", filePath, () => {
      if (!fs.fstatSync(descriptor).isFile()) {
        throw new Error("Path is not a regular file");
      }
      fs.fchmodSync(descriptor, targetMode);
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function ensurePrivateFileSync(
  filePath: string,
  options: {
    readonly executable?: boolean;
    readonly platform?: NodeJS.Platform;
  } = {},
): void {
  if (!supportsPosixPermissions(options.platform)) {
    withPathContext("create", filePath, () => {
      const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
      fs.closeSync(descriptor);
    });
    return;
  }

  const targetMode = options.executable ? PRIVATE_EXECUTABLE_FILE_MODE : PRIVATE_FILE_MODE;
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
  const descriptor = withPathContext("open without following symlinks", filePath, () =>
    fs.openSync(filePath, flags, targetMode),
  );
  try {
    withPathContext("set mode on", filePath, () => {
      if (!fs.fstatSync(descriptor).isFile()) {
        throw new Error("Path is not a regular file");
      }
      fs.fchmodSync(descriptor, targetMode);
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function repairPrivateFile(
  filePath: string,
  options: {
    readonly executable?: boolean;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<void> {
  if (!supportsPosixPermissions(options.platform)) return;
  const targetMode = options.executable ? PRIVATE_EXECUTABLE_FILE_MODE : PRIVATE_FILE_MODE;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (cause) {
    throw new PrivatePathPermissionError("open without following symlinks", filePath, cause);
  }
  try {
    try {
      if (!(await handle.stat()).isFile()) {
        throw new Error("Path is not a regular file");
      }
      await handle.chmod(targetMode);
    } catch (cause) {
      throw new PrivatePathPermissionError("set mode on", filePath, cause);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Repairs a private tree without following symlinks. Owner-executable files
 * keep that capability, while all group/other access is removed.
 */
export function repairPrivateTreeSync(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!supportsPosixPermissions(platform)) return;

  const visit = (entryPath: string, isRoot = false): void => {
    const stat = withPathContext("inspect", entryPath, () => fs.lstatSync(entryPath));
    if (stat.isSymbolicLink()) {
      if (isRoot) {
        throw new PrivatePathPermissionError(
          "repair",
          entryPath,
          new Error("Refusing to follow a symlinked private-tree root"),
        );
      }
      return;
    }
    if (stat.isDirectory()) {
      withPathContext("set mode on", entryPath, () =>
        fs.chmodSync(entryPath, PRIVATE_DIRECTORY_MODE),
      );
      const entries = withPathContext("read", entryPath, () => fs.readdirSync(entryPath));
      for (const entry of entries) {
        visit(path.join(entryPath, entry));
      }
      return;
    }
    if (stat.isFile()) {
      repairPrivateFileSync(entryPath, {
        executable: (stat.mode & 0o100) !== 0,
        platform,
      });
    }
  };

  visit(rootPath, true);
}
