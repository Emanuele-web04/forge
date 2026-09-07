import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import { supportsPosixPermissions, syncDirectoryEntry } from "@synara/shared/filesystemPlatform";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../privatePathPermissions.ts";

const OWNER_FILE_NAME = "owner.json";

type DatabaseLifecycleLockOwner = {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
};

export type DatabaseLifecycleLock = {
  readonly dbPath: string;
  readonly lockPath: string;
  readonly owner: DatabaseLifecycleLockOwner;
};

export class DatabaseLifecycleLockedError extends Error {
  readonly _tag = "DatabaseLifecycleLockedError";

  constructor(
    readonly dbPath: string,
    readonly lockPath: string,
    detail: string,
  ) {
    super(`Database lifecycle is locked for ${dbPath}: ${detail} (${lockPath})`);
    this.name = "DatabaseLifecycleLockedError";
  }
}

function errnoCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}

async function canonicalDatabasePath(dbPath: string): Promise<string> {
  const directoryPath = path.dirname(dbPath);
  await fs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const directoryStat = await fs.lstat(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Database parent path is not a real directory: ${directoryPath}`);
  }
  if (supportsPosixPermissions() && (directoryStat.mode & 0o022) !== 0) {
    throw new Error(`Database parent directory is group/other writable: ${directoryPath}`);
  }
  return path.join(await fs.realpath(directoryPath), path.basename(dbPath));
}

async function readOwner(lockPath: string): Promise<DatabaseLifecycleLockOwner> {
  const lockStat = await fs.lstat(lockPath);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    throw new Error("lock path is not a real directory");
  }
  const ownerPath = path.join(lockPath, OWNER_FILE_NAME);
  const ownerPathStat = await fs.lstat(ownerPath);
  if (!ownerPathStat.isFile() || ownerPathStat.isSymbolicLink()) {
    throw new Error("lock owner is not a real regular file");
  }
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(ownerPath, flags);
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("lock owner is not a regular file");
    if (
      process.platform !== "win32" &&
      (stat.dev !== ownerPathStat.dev || stat.ino !== ownerPathStat.ino)
    ) {
      throw new Error("lock owner identity changed while it was opened");
    }
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const owner = JSON.parse(text) as Partial<DatabaseLifecycleLockOwner>;
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid! <= 0 ||
    typeof owner.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner.token) ||
    typeof owner.createdAt !== "string"
  ) {
    throw new Error("lock owner metadata is invalid");
  }
  return owner as DatabaseLifecycleLockOwner;
}

function ownerProcessState(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

async function writeOwner(lockPath: string, owner: DatabaseLifecycleLockOwner): Promise<void> {
  if (process.platform !== "win32") await fs.chmod(lockPath, PRIVATE_DIRECTORY_MODE);
  const ownerPath = path.join(lockPath, OWNER_FILE_NAME);
  const handle = await fs.open(ownerPath, "wx", PRIVATE_FILE_MODE);
  try {
    if (process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryEntry(lockPath);
}

async function prepareOwnedDirectory(
  lockPath: string,
  owner: DatabaseLifecycleLockOwner,
): Promise<string> {
  const stagingPath = `${lockPath}.acquiring.${owner.pid}.${owner.token}`;
  await fs.mkdir(stagingPath, { mode: PRIVATE_DIRECTORY_MODE });
  try {
    await writeOwner(stagingPath, owner);
    await syncDirectoryEntry(path.dirname(lockPath));
    return stagingPath;
  } catch (cause) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") return false;
    throw cause;
  }
}

async function tryPublishOwnedDirectory(
  targetPath: string,
  owner: DatabaseLifecycleLockOwner,
): Promise<boolean> {
  const stagingPath = await prepareOwnedDirectory(targetPath, owner);
  let published = false;
  try {
    await fs.rename(stagingPath, targetPath);
    published = true;
  } catch (cause) {
    if (!(await pathExists(targetPath))) throw cause;
  } finally {
    if (!published) {
      await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (!published) return false;
  try {
    await syncDirectoryEntry(path.dirname(targetPath));
    return true;
  } catch (cause) {
    await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

type ReaperGuard = {
  readonly path: string;
  readonly owner: DatabaseLifecycleLockOwner;
  readonly retiredPaths: ReadonlyArray<string>;
};

async function acquireReaperGuard(dbPath: string, lockPath: string): Promise<ReaperGuard> {
  const reaperPath = `${lockPath}.reaper`;
  const retiredPaths: string[] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner: DatabaseLifecycleLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    if (await tryPublishOwnedDirectory(reaperPath, owner)) {
      return { path: reaperPath, owner, retiredPaths };
    }

    let existingOwner: DatabaseLifecycleLockOwner;
    try {
      existingOwner = await readOwner(reaperPath);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        `stale-lock recovery owner is unknown: ${detail}`,
      );
    }
    const state = ownerProcessState(existingOwner.pid);
    if (state !== "dead") {
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        `stale-lock recovery owner pid ${existingOwner.pid} is ${state}`,
      );
    }
    if (attempt > 0) {
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        "dead stale-lock recovery owner could not be replaced safely",
      );
    }

    const retiredPath = `${reaperPath}.retired.${existingOwner.token}`;
    try {
      const currentOwner = await readOwner(reaperPath);
      if (
        currentOwner.token !== existingOwner.token ||
        ownerProcessState(currentOwner.pid) !== "dead"
      ) {
        throw new DatabaseLifecycleLockedError(
          dbPath,
          lockPath,
          "stale-lock recovery ownership changed during takeover",
        );
      }
      await fs.rename(reaperPath, retiredPath);
      await syncDirectoryEntry(path.dirname(reaperPath));
      retiredPaths.push(retiredPath);
    } catch (cause) {
      if (cause instanceof DatabaseLifecycleLockedError) throw cause;
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        "dead stale-lock recovery owner could not be retired safely",
      );
    }
  }

  throw new DatabaseLifecycleLockedError(dbPath, lockPath, "stale-lock recovery failed");
}

async function releaseReaperGuard(dbPath: string, lockPath: string, guard: ReaperGuard) {
  const owner = await readOwner(guard.path);
  if (owner.token !== guard.owner.token || owner.pid !== guard.owner.pid) {
    throw new DatabaseLifecycleLockedError(
      dbPath,
      lockPath,
      "refusing to release stale-lock recovery owned by another process or token",
    );
  }
  const releasedPath = `${guard.path}.released.${guard.owner.token}.${randomUUID()}`;
  await fs.rename(guard.path, releasedPath);
  await syncDirectoryEntry(path.dirname(guard.path));
  await fs.rm(releasedPath, { recursive: true, force: true });
  for (const retiredPath of guard.retiredPaths) {
    await fs.rm(retiredPath, { recursive: true, force: true });
  }
  await syncDirectoryEntry(path.dirname(guard.path));
}

async function reapDeadOwner(
  dbPath: string,
  lockPath: string,
  observedOwner: DatabaseLifecycleLockOwner,
): Promise<void> {
  const guard = await acquireReaperGuard(dbPath, lockPath);

  try {
    const currentOwner = await readOwner(lockPath);
    if (
      currentOwner.token !== observedOwner.token ||
      ownerProcessState(currentOwner.pid) !== "dead"
    ) {
      throw new DatabaseLifecycleLockedError(
        dbPath,
        lockPath,
        "lock ownership changed while stale recovery was starting",
      );
    }
    const stalePath = `${lockPath}.stale.${observedOwner.token}.${randomUUID()}`;
    await fs.rename(lockPath, stalePath);
    await syncDirectoryEntry(path.dirname(lockPath));
    await fs.rm(stalePath, { recursive: true, force: true });
    await syncDirectoryEntry(path.dirname(lockPath));
  } finally {
    await releaseReaperGuard(dbPath, lockPath, guard);
  }
}

async function acquire(dbPath: string): Promise<DatabaseLifecycleLock> {
  const canonicalDbPath = await canonicalDatabasePath(dbPath);
  const lockPath = `${canonicalDbPath}.lifecycle-lock`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner: DatabaseLifecycleLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const published = await tryPublishOwnedDirectory(lockPath, owner);

    if (!published) {
      let existingOwner: DatabaseLifecycleLockOwner;
      try {
        existingOwner = await readOwner(lockPath);
      } catch (ownerCause) {
        const detail = ownerCause instanceof Error ? ownerCause.message : String(ownerCause);
        throw new DatabaseLifecycleLockedError(
          canonicalDbPath,
          lockPath,
          `owner is live or unknown: ${detail}`,
        );
      }
      const state = ownerProcessState(existingOwner.pid);
      if (state !== "dead") {
        throw new DatabaseLifecycleLockedError(
          canonicalDbPath,
          lockPath,
          `owner pid ${existingOwner.pid} is ${state}`,
        );
      }
      if (attempt > 0) {
        throw new DatabaseLifecycleLockedError(
          canonicalDbPath,
          lockPath,
          "dead owner could not be recovered safely",
        );
      }
      await reapDeadOwner(canonicalDbPath, lockPath, existingOwner);
      continue;
    }

    return { dbPath: canonicalDbPath, lockPath, owner };
  }
  throw new DatabaseLifecycleLockedError(canonicalDbPath, lockPath, "acquisition failed");
}

async function release(lock: DatabaseLifecycleLock): Promise<void> {
  let owner: DatabaseLifecycleLockOwner;
  try {
    owner = await readOwner(lock.lockPath);
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") return;
    throw cause;
  }
  if (owner.token !== lock.owner.token || owner.pid !== lock.owner.pid) {
    throw new DatabaseLifecycleLockedError(
      lock.dbPath,
      lock.lockPath,
      "refusing to release a lock owned by another process or token",
    );
  }
  const releasedPath = `${lock.lockPath}.released.${lock.owner.token}.${randomUUID()}`;
  await fs.rename(lock.lockPath, releasedPath);
  await syncDirectoryEntry(path.dirname(lock.lockPath));
  await fs.rm(releasedPath, { recursive: true, force: true });
  await syncDirectoryEntry(path.dirname(lock.lockPath));
}

const attemptPromise = <A>(action: () => Promise<A>) =>
  Effect.tryPromise({ try: action, catch: (cause) => cause });

export const acquireDatabaseLifecycleLock = (dbPath: string) =>
  attemptPromise(() => acquire(dbPath));

export const releaseDatabaseLifecycleLock = (lock: DatabaseLifecycleLock) =>
  attemptPromise(() => release(lock));

export const withDatabaseLifecycleLock = <A, E, R>(dbPath: string, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    acquireDatabaseLifecycleLock(dbPath),
    () => use,
    releaseDatabaseLifecycleLock,
  );
