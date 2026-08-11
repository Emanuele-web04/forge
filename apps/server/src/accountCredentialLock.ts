/**
 * accountCredentialLock - serializes credential-file read-modify-write.
 *
 * The account credential file is shared by the server and any number of
 * `synara` CLI processes, and WorkOS refresh tokens are single-use: two
 * concurrent expired-token operations that both read the stored token will
 * double-spend it, and the loser's write can clobber the winner's rotated
 * pair. Every read→decide→write sequence on the file must therefore run
 * under this lock.
 *
 * Two layers, both needed:
 * - An in-process mutex (promise chain per file path) serializes the
 *   server's own concurrent operations without touching the filesystem.
 * - A cross-process advisory lock (an O_EXCL lock file next to the
 *   credentials) serializes against other processes. Advisory: everything
 *   that mutates the file goes through this module, so cooperation is by
 *   construction. A lock older than {@link STALE_LOCK_MS} is presumed
 *   abandoned by a crashed process and broken — the critical sections here
 *   are a couple of file reads/writes plus one HTTP round trip, so a healthy
 *   holder is long gone before that.
 *
 * @module accountCredentialLock
 */
import fs from "node:fs/promises";
import path from "node:path";

/** How long before a lock file left by a crashed process is broken. */
const STALE_LOCK_MS = 30_000;

/** How long acquisition retries before giving up and proceeding unlocked. */
const ACQUIRE_TIMEOUT_MS = 45_000;

const RETRY_DELAY_MS = 50;

/** In-process serialization: one promise chain per lock file path. */
const inProcessChains = new Map<string, Promise<unknown>>();

function lockFilePath(credentialsPath: string): string {
  return `${credentialsPath}.lock`;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireCrossProcessLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      // O_EXCL create is atomic on every filesystem this runs on; the pid is
      // informational for a human inspecting a stuck lock.
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // The directory may not exist yet (fresh install, nothing stored).
        // The caller's own read/write will surface the real problem; do not
        // let the lock be the thing that fails first.
        await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {});
        const retry = await fs.open(lockPath, "wx").catch(() => undefined);
        if (retry) {
          await retry.writeFile(String(process.pid)).catch(() => {});
          await retry.close();
          return;
        }
      }
      // Held by someone. Break it if stale, otherwise wait and retry.
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        // Proceeding unlocked risks the race this module exists to prevent,
        // but deadlocking every account operation behind a wedged lock is
        // strictly worse; the atomic-rename write keeps the file untorn.
        return;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function releaseCrossProcessLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true }).catch(() => {});
}

/**
 * Runs `fn` while holding both the in-process and cross-process locks for
 * the credential file at `credentialsPath`. Reentrant calls deadlock —
 * never nest.
 */
export async function withCredentialFileLock<A>(
  credentialsPath: string,
  fn: () => Promise<A>,
): Promise<A> {
  const lockPath = lockFilePath(credentialsPath);
  const previous = inProcessChains.get(lockPath) ?? Promise.resolve();
  const run = previous
    .catch(() => {
      // The previous holder's failure is its own; the chain must keep serving.
    })
    .then(async () => {
      await acquireCrossProcessLock(lockPath);
      try {
        return await fn();
      } finally {
        await releaseCrossProcessLock(lockPath);
      }
    });
  inProcessChains.set(lockPath, run);
  // Trim the map once this settles and nothing newer is queued behind it.
  void run
    .catch(() => {})
    .then(() => {
      if (inProcessChains.get(lockPath) === run) inProcessChains.delete(lockPath);
    });
  return run;
}
