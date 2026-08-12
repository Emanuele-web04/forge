// FILE: accountCredentialLock.test.ts
// Purpose: Coverage for the cross-process credential-file lock — stale
// threshold sizing (a slow legitimate holder must not be stolen from),
// owner-checked release (a holder that lost a stale takeover must not delete
// the new owner's lock), and stale takeover of a crashed process's lock.
// Layer: Server account tests

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  internalsForTesting,
  STALE_LOCK_MS,
  withCredentialFileLock,
} from "./accountCredentialLock";

const temporaryDirectories: string[] = [];

function makeCredentialsPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-credential-lock-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "account-credentials.json");
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function backdateLock(lockPath: string, ageMs: number): Promise<void> {
  const then = new Date(Date.now() - ageMs);
  return fsp.utimes(lockPath, then, then);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withCredentialFileLock", () => {
  it("sizes the stale threshold past the worst-case token refresh", () => {
    // Two 60s grant attempts plus the retry pause is ~121s of legitimate
    // hold; a threshold at or below that steals the lock from a live holder
    // mid-refresh and double-spends the single-use refresh token.
    expect(STALE_LOCK_MS).toBeGreaterThan(2 * 60_000 + 1_000);
  });

  it("does not steal a live holder's lock aged past the old 30s threshold", async () => {
    const credentialsPath = makeCredentialsPath();
    const lockPath = `${credentialsPath}.lock`;
    // Another process acquired 40s ago and is still inside a slow refresh.
    await fsp.writeFile(lockPath, "9999:live-holder-token");
    await backdateLock(lockPath, 40_000);

    let ran = false;
    const pending = withCredentialFileLock(credentialsPath, async () => {
      ran = true;
    });

    // The waiter must be retrying, not breaking the lock: the holder's file
    // survives untouched.
    await sleep(300);
    expect(ran).toBe(false);
    expect(await fsp.readFile(lockPath, "utf8")).toBe("9999:live-holder-token");

    // The holder finishes and releases; the waiter proceeds.
    await fsp.rm(lockPath);
    await pending;
    expect(ran).toBe(true);
  });

  it("release is owner-checked: a takeover victim must not delete the new owner's lock", async () => {
    const credentialsPath = makeCredentialsPath();
    const lockPath = `${credentialsPath}.lock`;

    let releaseHolder: () => void = () => {};
    const holderDone = withCredentialFileLock(credentialsPath, async () => {
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
    });
    // Wait until the holder owns the lock file.
    for (let attempt = 0; attempt < 100 && !fs.existsSync(lockPath); attempt += 1) {
      await sleep(10);
    }
    expect(fs.existsSync(lockPath)).toBe(true);

    // Simulate another process breaking the (apparently stale) lock and
    // writing its own owner token while the original holder is still running.
    await fsp.writeFile(lockPath, "4242:new-owner-token");

    // The original holder finishes; its release reads the lock, sees a token
    // that is not its own, and must leave the new owner's lock in place.
    releaseHolder();
    await holderDone;
    expect(await fsp.readFile(lockPath, "utf8")).toBe("4242:new-owner-token");

    await fsp.rm(lockPath, { force: true });
  });

  it("takes over a genuinely stale lock and releases it after the critical section", async () => {
    const credentialsPath = makeCredentialsPath();
    const lockPath = `${credentialsPath}.lock`;
    // A crashed process's leftover: old enough to be past the threshold.
    await fsp.writeFile(lockPath, "1234:crashed-owner-token");
    await backdateLock(lockPath, STALE_LOCK_MS + 5_000);

    let observedOwner: string | undefined;
    await withCredentialFileLock(credentialsPath, async () => {
      observedOwner = await fsp.readFile(lockPath, "utf8");
    });

    // Inside the section the lock carried OUR token (pid-prefixed), not the
    // crashed owner's; afterwards the owner-checked release removed it.
    expect(observedOwner).toMatch(new RegExp(`^${process.pid}:`, "u"));
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // The reclamation CAS, driven deterministically: two contenders see the
  // same stale lock; both break, both race the exclusive create — exactly one
  // create succeeds, so exactly one enters the critical section.
  it("stale takeover is mutually exclusive: two contenders, one acquisition", async () => {
    const credentialsPath = makeCredentialsPath();
    const lockPath = `${credentialsPath}.lock`;
    const { breakStaleLock, tryCreateLock } = internalsForTesting;

    await fsp.writeFile(lockPath, "1234:crashed-owner-token");
    await backdateLock(lockPath, STALE_LOCK_MS + 5_000);

    // Interleave the worst ordering explicitly: A breaks, B breaks (no-op —
    // the rename already carried the stale file aside), THEN both attempt
    // the exclusive create. The old rename-over-and-read-back design let
    // both read their own token in this ordering.
    await breakStaleLock(lockPath);
    await breakStaleLock(lockPath);
    const [aAcquired, bAcquired] = await Promise.all([
      tryCreateLock(lockPath, "1:contender-a"),
      tryCreateLock(lockPath, "2:contender-b"),
    ]);

    expect([aAcquired, bAcquired].filter(Boolean)).toHaveLength(1);
    const winner = aAcquired ? "1:contender-a" : "2:contender-b";
    expect(await fsp.readFile(lockPath, "utf8")).toBe(winner);

    await fsp.rm(lockPath, { force: true });
  });

  // A slower contender whose staleness judgment predates a faster takeover
  // must not destroy the new owner's fresh lock: breakStaleLock restores a
  // renamed-aside lock that turns out to be fresh.
  it("does not break a fresh lock re-acquired between staleness check and rename", async () => {
    const credentialsPath = makeCredentialsPath();
    const lockPath = `${credentialsPath}.lock`;
    const { breakStaleLock } = internalsForTesting;

    // The faster contender already took over: the lock on disk is FRESH.
    await fsp.writeFile(lockPath, "1:new-owner-token");

    // The slower contender acts on its stale pre-takeover judgment.
    await breakStaleLock(lockPath);

    // The fresh lock survives, still owned by the new owner.
    expect(await fsp.readFile(lockPath, "utf8")).toBe("1:new-owner-token");

    await fsp.rm(lockPath, { force: true });
  });

  // End-to-end: many concurrent waiters on one stale lock still serialize —
  // no two critical sections overlap.
  it("serializes concurrent critical sections across a stale takeover", async () => {
    const credentialsPath = makeCredentialsPath();
    const lockPath = `${credentialsPath}.lock`;
    await fsp.writeFile(lockPath, "1234:crashed-owner-token");
    await backdateLock(lockPath, STALE_LOCK_MS + 5_000);

    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withCredentialFileLock(credentialsPath, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(10);
          inside -= 1;
        }),
      ),
    );

    expect(maxInside).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
