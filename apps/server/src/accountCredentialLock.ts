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
 * Breaks a stale lock by atomically renaming it aside to a unique
 * per-contender path and deleting it. Breaking confers NO ownership: the
 * breaker (and everyone else) must still win the exclusive-create race in
 * {@link tryCreateLock} to enter the critical section.
 *
 * The rename is what makes the break atomic. Of all contenders racing the
 * same stale lock, exactly one rename succeeds — the rest get ENOENT and
 * fall through to the normal acquire-wait. The renamed lock is always
 * deleted; if it was accidentally fresh (broken between another contender's
 * break and re-acquire), that displaced holder's owner-checked release will
 * harmlessly no-op, and they will need to re-acquire.
 */
async function breakStaleLock(lockPath: string): Promise<void> {
  const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await fs.rename(lockPath, stalePath);
  } catch {
    // Another contender renamed it aside first (or the holder released):
    // the stale lock is already gone, nothing left to break.
    return;
  }
  await fs.rm(stalePath, { force: true }).catch(() => {});
}

/**
 * One exclusive-create acquisition attempt. `true` means this call created
 * the lock file and owns the lock: O_EXCL create is atomic on every
 * filesystem this runs on, so a lock file existing = the lock is held. The
 * read-back is defence in depth, not protocol — with exclusive creation the
 * token on disk must be ours.
 */
async function tryCreateLock(lockPath: string, ownerToken: string): Promise<boolean> {
  try {
    await fs.writeFile(lockPath, ownerToken, { flag: "wx" });
  } catch {
    return false;
  }
  const content = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  return content === ownerToken;
}

/**
 * Test-only handles on the acquisition primitives, so the stale-takeover
 * interleaving can be driven deterministically (two contenders on one stale
 * lock) without racing real timers.
 */
export const internalsForTesting = { breakStaleLock, tryCreateLock };

/** Acquires the lock, resolving to the owner token release must present. */
async function acquireCrossProcessLock(lockPath: string): Promise<string> {
  const ownerToken = makeOwnerToken();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    if (await tryCreateLock(lockPath, ownerToken)) return ownerToken;

    // The directory may not exist yet (fresh install, nothing stored). The
    // caller's own read/write will surface any real problem; do not let the
    // lock be the thing that fails first.
    const stat = await fs.stat(lockPath).catch(() => undefined);
    if (!stat) {
      await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {});
      if (await tryCreateLock(lockPath, ownerToken)) return ownerToken;
    }

    // Held by someone. If it is stale (crashed holder), break it aside —
    // then loop and race the exclusive create like everyone else; the
    // break itself grants nothing. Otherwise wait and retry.
    if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      await breakStaleLock(lockPath);
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
