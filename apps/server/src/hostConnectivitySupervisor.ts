// FILE: hostConnectivitySupervisor.ts
// Purpose: Keep host connectivity (relay dial, mint gateway, ssh-forward
//          listener) in step with the account credentials file for the
//          lifetime of the server, instead of reading the file once at boot.
// Layer: server host connectivity
//
// Why: sign-in links this machine as a host and writes the host fields to the
// credentials file while the server is already running. Reading the file only
// at boot meant a freshly linked host did not dial the relay until the next
// restart, and an unlinked one kept its control socket open. The supervisor
// watches the file and (re)starts connectivity whenever the linked-host
// identity changes, so "signed in" and "reachable" happen in the same moment.

import fs from "node:fs";
import path from "node:path";

import { accountCredentialsPath, readAccountFile, type StoredAccountFile } from "./accountAuth";

/** The fields whose change means "a different host link": restart on any of them. */
export function hostLinkKey(file: StoredAccountFile | undefined): string | undefined {
  if (!file?.hostId || !file.hostOwnerUserId || file.hostKeyGeneration === undefined) {
    return undefined;
  }
  return JSON.stringify([
    file.accountUrl,
    file.hostId,
    file.hostOwnerUserId,
    file.hostKeyGeneration,
    file.organizationId ?? null,
  ]);
}

export interface HostConnectivitySupervisorOptions {
  readonly baseDir: string;
  /** Starts connectivity for the link currently on disk; resolves to its stop. */
  readonly start: () => Promise<() => void>;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Coalesces the burst of events an atomic rename produces. */
  readonly debounceMs?: number;
  /** Safety net for platforms where fs.watch drops events. */
  readonly pollIntervalMs?: number;
}

export interface HostConnectivitySupervisor {
  /** Re-reads the file now; useful after a write the caller made itself. */
  readonly reconcile: () => Promise<void>;
  readonly stop: () => void;
}

/**
 * Starts connectivity for the link on disk, then keeps it matched to the file.
 * A change to the link identity stops the running instance and starts a new
 * one; a file with no link stops it; a rewrite that leaves the link alone
 * (token refresh, discoverability acknowledgement) is ignored.
 */
export async function superviseHostConnectivity(
  options: HostConnectivitySupervisorOptions,
): Promise<HostConnectivitySupervisor> {
  const log = options.log ?? (() => {});
  const debounceMs = options.debounceMs ?? 250;
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const credentialsFile = path.basename(accountCredentialsPath(options.baseDir));

  let activeKey: string | undefined;
  let activeStop: (() => void) | undefined;
  let stopped = false;
  // Reconciliations are serialized: a change that lands while one is in
  // flight queues exactly one more pass, which reads the newest file state.
  let inFlight: Promise<void> | undefined;
  let pending = false;

  const stopActive = () => {
    const stop = activeStop;
    activeStop = undefined;
    activeKey = undefined;
    try {
      stop?.();
    } catch (error) {
      log("Host connectivity stop failed.", { error: String(error) });
    }
  };

  const reconcileOnce = async () => {
    const key = hostLinkKey(await readAccountFile(options.baseDir));
    if (stopped || key === activeKey) return;
    if (activeStop) {
      log(
        key
          ? "Host link changed; restarting host connectivity."
          : "Host unlinked; stopping host connectivity.",
      );
      stopActive();
    }
    if (!key) return;
    try {
      const stop = await options.start();
      if (stopped) {
        stop();
        return;
      }
      activeStop = stop;
      activeKey = key;
      log("Host connectivity started.");
    } catch (error) {
      // Leave activeKey unset so the next change (or poll) tries again.
      log("Host connectivity did not start.", { error: String(error) });
    }
  };

  const reconcile = (): Promise<void> => {
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    inFlight = (async () => {
      // `pending` and `stopped` flip from outside this loop, across awaits.
      while (true) {
        pending = false;
        await reconcileOnce();
        if (!pending || stopped) break;
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  let debounce: NodeJS.Timeout | undefined;
  const scheduleReconcile = () => {
    if (stopped) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void reconcile();
    }, debounceMs);
  };

  let watcher: fs.FSWatcher | undefined;
  try {
    // Watch the directory, not the file: the file is replaced by rename on
    // every write, and a watcher on the old inode would go quiet.
    watcher = fs.watch(options.baseDir, { persistent: false }, (_event, filename) => {
      if (!filename || filename.toString() === credentialsFile) scheduleReconcile();
    });
    watcher.on("error", (error) => {
      log("Credentials watcher failed; falling back to polling.", { error: String(error) });
      watcher?.close();
      watcher = undefined;
    });
  } catch (error) {
    log("Credentials watcher unavailable; falling back to polling.", { error: String(error) });
  }
  const poll = setInterval(() => void reconcile(), pollIntervalMs);
  poll.unref();

  await reconcile();

  return {
    reconcile,
    stop: () => {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
      stopActive();
    },
  };
}
