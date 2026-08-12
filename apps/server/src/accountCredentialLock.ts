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
 *   construction. The lock file carries a per-acquisition owner token, so a
 *   holder only ever releases its own lock — a lock broken as stale (older
 *   than {@link STALE_LOCK_MS}, presumed abandoned by a crashed process)
 *   cannot later be deleted out from under its new owner by the original
 *   holder's release.
 *
 * @module accountCredentialLock
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { GRANT_REQUEST_TIMEOUT_MS } from "@synara/shared/account";

/**
 * Worst case for a healthy holder's critical section: renewSession makes up
 * to two refresh attempts of one grant-request timeout each with a one-second
 * pause between them (see accountAuth.ts), plus a few file reads/writes.
 */
const WORST_CASE_HOLD_MS = 2 * GRANT_REQUEST_TIMEOUT_MS + 1_000;

/**
 * How long before a lock file left by a crashed process is broken. Derived
 * from the worst-case legitimate hold plus generous margin: a live holder in
 * the middle of a slow token refresh must never look stale, or a second
 * process would break its lock and double-spend the single-use refresh token.
 * Exported for tests.
 */
export const STALE_LOCK_MS = WORST_CASE_HOLD_MS + 30_000;

/**
 * How long acquisition retries before giving up. Long enough to outwait a
 * live worst-case holder and, failing that, the stale break of a crashed one.
 */
const ACQUIRE_TIMEOUT_MS = STALE_LOCK_MS + 30_000;

const RETRY_DELAY_MS = 50;

/** In-process serialization: one promise chain per lock file path. */
const inProcessChains = new Map<string, Promise<unknown>>();

function lockFilePath(credentialsPath: string): string {
  return `${credentialsPath}.lock`;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** The pid is informational for a human inspecting a stuck lock. */
function makeOwnerToken(): string {
  return `${process.pid}:${randomUUID()}`;
}

/**
 * Takes over a stale lock by atomically replacing it with our owner token,
 * then re-reading to verify we actually own it: two processes racing the same
 * stale lock both rename, the last write wins, and only the process that
 * reads its own token back may proceed. The rename also resets the lock's
 * mtime, so the loser sees a fresh lock and waits instead of re-breaking it.
 */
async function takeOverStaleLock(lockPath: string, ownerToken: string): Promise<boolean> {
  const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, ownerToken);
    await fs.rename(tempPath, lockPath);
  } catch {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    return false;
  }
  const content = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  return content === ownerToken;
}

/** Acquires the lock, resolving to the owner token release must present. */
async function acquireCrossProcessLock(lockPath: string): Promise<string> {
  const ownerToken = makeOwnerToken();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      // O_EXCL create is atomic on every filesystem this runs on.
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(ownerToken);
      } finally {
        await handle.close();
      }
      return ownerToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // The directory may not exist yet (fresh install, nothing stored).
        // The caller's own read/write will surface the real problem; do not
        // let the lock be the thing that fails first.
        await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {});
        const retry = await fs.open(lockPath, "wx").catch(() => undefined);
        if (retry) {
          await retry.writeFile(ownerToken).catch(() => {});
          await retry.close();
          return ownerToken;
        }
      }
      // Held by someone. Take it over if stale, otherwise wait and retry.
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        if (await takeOverStaleLock(lockPath, ownerToken)) return ownerToken;
        continue;
      }
      if (Date.now() > deadline) {
        // Never fall through to unlocked execution — running the critical
        // section without the lock is the exact double-spend race this
        // module exists to prevent. A wedged lock fails the operation
        // instead; the stale break above bounds how long that can last.
        throw new Error(
          `Timed out after ${ACQUIRE_TIMEOUT_MS}ms waiting for the credential lock at ${lockPath}`,
        );
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Owner-checked release: deletes the lock only while it still contains our
 * token, so a holder that overran the stale threshold and lost the lock to a
 * takeover cannot delete the new owner's lock. A read→delete TOCTOU window
 * remains, but it shrinks the race from "always, on any slow refresh" to
 * microseconds between two syscalls.
 */
async function releaseCrossProcessLock(lockPath: string, ownerToken: string): Promise<void> {
  const content = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  if (content !== ownerToken) return;
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
      const ownerToken = await acquireCrossProcessLock(lockPath);
      try {
        return await fn();
      } finally {
        await releaseCrossProcessLock(lockPath, ownerToken);
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
