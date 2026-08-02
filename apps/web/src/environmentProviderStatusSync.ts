// FILE: environmentProviderStatusSync.ts
// Purpose: Keeps each connected environment's provider statuses current, so the
//          picker can say whether a host can actually run a chat.
// Layer: Web environment UX
// Exports: createEnvironmentProviderStatusSync

import type { EnvironmentId } from "@synara/contracts";

import {
  forgetEnvironmentProviderStatuses,
  recordEnvironmentProviderStatuses,
} from "./environmentProviderStatus";
import { onServerProviderStatusesUpdated } from "./wsEnvironmentRegistry";
import type { WsEnvironmentClient } from "./wsNativeApi";

/**
 * Subscribes to every connected environment's provider statuses, and forgets
 * the ones that left.
 *
 * Per-environment rather than through the shared `["server","config"]` query
 * cache on purpose: that key has no environment in it, so feeding a second
 * server's statuses into it would make a remote host overwrite the local
 * provider list every screen reads. See environmentProviderStatus.ts.
 *
 * `onServerProviderStatusesUpdated` replays the last cached push on subscribe,
 * so a host that reported before this ran is not missed — without that, a
 * picker opened after connect would sit at "Checking…" until the next push,
 * which for a settled host may never come.
 */
export function createEnvironmentProviderStatusSync() {
  const unsubscribeByEnvironmentId = new Map<EnvironmentId, () => void>();
  let disposed = false;

  const drop = (environmentId: EnvironmentId): void => {
    unsubscribeByEnvironmentId.get(environmentId)?.();
    unsubscribeByEnvironmentId.delete(environmentId);
    // A disconnected host must not keep reporting "ready" from a cached
    // answer — that is precisely the stale claim the readiness line exists to
    // avoid making.
    forgetEnvironmentProviderStatuses(environmentId);
  };

  return {
    sync(clients: readonly WsEnvironmentClient[]): void {
      if (disposed) return;
      const present = new Set(clients.map((client) => client.environmentId));

      // Snapshotted before the loop because `drop` deletes from the map;
      // mutating it while iterating is how entries get skipped.
      const departed = Array.from(unsubscribeByEnvironmentId.keys()).filter(
        (environmentId) => !present.has(environmentId),
      );
      for (const environmentId of departed) drop(environmentId);

      for (const client of clients) {
        if (unsubscribeByEnvironmentId.has(client.environmentId)) continue;
        unsubscribeByEnvironmentId.set(
          client.environmentId,
          onServerProviderStatusesUpdated(
            (payload) => {
              if (disposed) return;
              recordEnvironmentProviderStatuses(client.environmentId, payload.providers);
            },
            { environmentId: client.environmentId },
          ),
        );
      }
    },
    dispose(): void {
      disposed = true;
      for (const environmentId of Array.from(unsubscribeByEnvironmentId.keys())) {
        drop(environmentId);
      }
    },
  };
}
