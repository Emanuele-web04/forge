// FILE: remoteEnvironmentClientSync.ts
// Purpose: THE ONE PLACE that turns a ready remote host into a registered
//          WebSocket client — and deregisters it when the host goes away.
// Layer: Web transport aggregation
// Exports: createRemoteEnvironmentClientSync, remoteEnvironmentIdsToRegister
//
// Why exactly one owner
// ---------------------
// Registering an environment is not idempotent in its effects: it opens a
// socket, starts subscriptions, and fans out to shell aggregation, descriptor
// sync and provider-status sync via the registry-change listener in __root.tsx.
// Scattering `ensureWsEnvironmentClient` across the settings panel, the picker
// and the router would mean several components racing to own one socket's
// lifetime, and the first component to unmount would take the others' data with
// it. So the rule is: STATUS decides, and only this module acts on it.
//
// Everything downstream is already automatic — anything registered is picked up
// by the existing fan-in — so this module deliberately does nothing else.

import type { EnvironmentId, RemoteEnvironmentStatus } from "@synara/contracts";

import {
  ensureWsEnvironmentClient,
  onRemoteEnvironmentStatusesUpdated,
  removeWsEnvironmentClient,
} from "./wsEnvironmentRegistry";

/**
 * The environments a status set says should be connected.
 *
 * Two conditions, both required: the host reached `ready`, AND the server told
 * us which environment it provisioned. A ready host with no id is a server bug
 * rather than a connectable environment — and inventing an id here would
 * register a socket for a path the proxy has no entry for, which fails as a
 * confusing 404 rather than as the missing field it actually is.
 */
export function remoteEnvironmentIdsToRegister(
  statuses: readonly RemoteEnvironmentStatus[],
): readonly EnvironmentId[] {
  const ids: EnvironmentId[] = [];
  for (const status of statuses) {
    if (status.phase !== "ready") continue;
    if (status.environmentId === undefined) continue;
    if (ids.includes(status.environmentId)) continue;
    ids.push(status.environmentId);
  }
  return ids;
}

/** The proxy route an environment is reachable on. Matches `/env/:envId/*`. */
function environmentSocketUrl(environmentId: EnvironmentId): string {
  return `/env/${encodeURIComponent(environmentId)}/ws`;
}

/**
 * Keeps the registered remote clients equal to the ready hosts.
 *
 * A host that leaves `ready` — failed, removed, or torn down — is deregistered,
 * because its tunnel is gone and the proxy already retracted the entry: leaving
 * the client registered would keep a socket retrying against a path that now
 * 404s, and would keep its rows in the sidebar claiming a server that is not
 * there.
 */
export function createRemoteEnvironmentClientSync() {
  const registered = new Set<EnvironmentId>();
  let disposed = false;

  const apply = (statuses: readonly RemoteEnvironmentStatus[]): void => {
    if (disposed) return;
    const wanted = remoteEnvironmentIdsToRegister(statuses);

    for (const environmentId of wanted) {
      if (registered.has(environmentId)) continue;
      registered.add(environmentId);
      ensureWsEnvironmentClient({
        environmentId,
        url: environmentSocketUrl(environmentId),
      });
    }

    // Snapshotted: `removeWsEnvironmentClient` emits a registry change, and a
    // listener that re-enters would otherwise mutate the set being iterated.
    for (const environmentId of [...registered]) {
      if (wanted.includes(environmentId)) continue;
      registered.delete(environmentId);
      void removeWsEnvironmentClient(environmentId);
    }
  };

  // Replays the latest push on subscribe, so a host that reached `ready` before
  // this ran is registered immediately rather than waiting for a status change
  // that a settled host may never produce.
  const unsubscribe = onRemoteEnvironmentStatusesUpdated((payload) => {
    apply(payload.statuses);
  });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      // Deliberately does NOT deregister: dispose runs on effect teardown (a
      // hot reload or a remount), and dropping every remote socket there would
      // disconnect working hosts and blank their rows for no reason. A host
      // that genuinely went away is removed by `apply`.
      registered.clear();
    },
    /** Test seam. */
    get registeredCount(): number {
      return registered.size;
    },
  };
}
