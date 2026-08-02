// FILE: environmentProviderStatusSync.ts
// Purpose: Keeps each connected environment's provider statuses current, so the
//          picker can say whether a host can actually run a chat.
// Layer: Web environment UX
// Exports: createEnvironmentProviderStatusSync

import { createEnvironmentAttachmentRegistry } from "./environmentAttachment";
import {
  forgetEnvironmentProviderStatuses,
  recordEnvironmentProviderStatuses,
} from "./environmentProviderStatus";
import { onServerProviderStatusesUpdated } from "./wsEnvironmentRegistry";

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
  return createEnvironmentAttachmentRegistry({
    // Keyed on the CLIENT by the shared registry, not the environment id: the
    // registry replaces a disposed client with a new object under the same id,
    // and an id-keyed check would treat the replacement as already-subscribed —
    // so that host's provider statuses would freeze at whatever the dead
    // connection last reported, and the picker would keep claiming it.
    attach: (client) =>
      onServerProviderStatusesUpdated(
        (payload) => {
          recordEnvironmentProviderStatuses(client.environmentId, payload.providers);
        },
        { environmentId: client.environmentId },
      ),
    // A disconnected host must not keep reporting "ready" from a cached answer —
    // precisely the stale claim the readiness line exists to avoid making.
    release: forgetEnvironmentProviderStatuses,
  });
}
