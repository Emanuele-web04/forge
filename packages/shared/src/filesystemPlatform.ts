// FILE: filesystemPlatform.ts
// Purpose: Centralizes filesystem operations whose durability or identity semantics differ by OS.
// Layer: Shared platform runtime

import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EBADF"]);

export function supportsPosixPermissions(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/** Flushes directory-entry changes where the platform exposes durable directory fsync. */
export async function syncDirectoryEntry(
  directoryPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!supportsPosixPermissions(platform)) return;

  const handle = await fs.open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync().catch((cause) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (!code || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) throw cause;
    });
  } finally {
    await handle.close();
  }
}

/**
 * Flushes a regular file created by Synara. Windows FlushFileBuffers requires
 * write access; POSIX additionally retains no-follow protection.
 */
export async function syncRegularFile(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const flags = supportsPosixPermissions(platform)
    ? fsConstants.O_RDWR | fsConstants.O_NOFOLLOW
    : fsConstants.O_RDWR;
  const handle = await fs.open(filePath, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** POSIX inode identity is stable; Windows callers rely on guarded path checks. */
export function sameFileIdentity(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !supportsPosixPermissions(platform) || (left.dev === right.dev && left.ino === right.ino);
}
