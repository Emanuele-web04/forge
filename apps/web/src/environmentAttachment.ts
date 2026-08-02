// FILE: environmentAttachment.ts
// Purpose: The one correct way to hold per-environment state that must follow a
//          CLIENT, not just an environment id.
// Layer: Web transport aggregation
// Exports: createEnvironmentAttachmentRegistry
//
// WHY THIS EXISTS AS SHARED CODE
//
// Four subscribers attach something per environment: shell aggregation, thread
// streams, descriptor sync, provider-status sync. Three of them independently
// got the same detail wrong, and the fourth only avoided it because the bug had
// already been paid for once.
//
// The detail: the registry REPLACES a disposed entry with a new client object
// under the SAME environment id. A logout disposes a transport without
// deregistering, so this is routine rather than exceptional. Code that keys
// attachment on the environment id alone then sees the replacement as
// "already attached" and skips it — leaving whatever it stored pointing at a
// dead client whose listener registries `dispose()` already cleared. Nothing
// throws. That environment simply stops updating, which reads as a hang rather
// than a failure.
//
// Keying on the CLIENT makes the replacement visible, because a new object is
// not the old one. That is the whole fix, and it belongs in one place so the
// fifth subscriber inherits it instead of rediscovering it.

import type { EnvironmentId } from "@synara/contracts";

import type { WsEnvironmentClient } from "./wsNativeApi";

export interface EnvironmentAttachment {
  /** Releases whatever was attached. Must tolerate being called once. */
  readonly detach: () => void;
}

/**
 * Tracks one attachment per environment, re-attaching when the client changes.
 *
 * `attach` runs for a new environment AND for a replacement client. `release`
 * is called for an environment that has gone away, after its detach — use it
 * for state that must not outlive the connection (cached descriptors, provider
 * statuses), since a re-registered id may be an entirely different machine.
 */
export function createEnvironmentAttachmentRegistry(options: {
  readonly attach: (client: WsEnvironmentClient) => EnvironmentAttachment["detach"];
  readonly release?: (environmentId: EnvironmentId) => void;
  /** Excludes an environment entirely — the shell aggregator skips local. */
  readonly skip?: (client: WsEnvironmentClient) => boolean;
}) {
  const attached = new Map<
    EnvironmentId,
    { readonly client: WsEnvironmentClient; readonly detach: () => void }
  >();
  let disposed = false;

  const drop = (environmentId: EnvironmentId): void => {
    const entry = attached.get(environmentId);
    if (!entry) return;
    // Delete BEFORE detaching so a throwing detach cannot leave a half-released
    // entry that a later sync would treat as live.
    attached.delete(environmentId);
    entry.detach();
    options.release?.(environmentId);
  };

  return {
    sync(clients: readonly WsEnvironmentClient[]): void {
      if (disposed) return;
      const present = new Set<EnvironmentId>();

      for (const client of clients) {
        if (options.skip?.(client)) continue;
        present.add(client.environmentId);
        const existing = attached.get(client.environmentId);
        // Identity, not id: a different object under the same id is a
        // REPLACEMENT and must be re-attached.
        if (existing?.client === client) continue;
        if (existing) {
          attached.delete(client.environmentId);
          existing.detach();
        }
        attached.set(client.environmentId, { client, detach: options.attach(client) });
      }

      // Snapshotted before the loop because `drop` deletes from the map;
      // mutating it while iterating is how entries get skipped.
      for (const environmentId of [...attached.keys()]) {
        if (present.has(environmentId)) continue;
        drop(environmentId);
      }
    },
    dispose(): void {
      disposed = true;
      // Snapshotted for the same reason as above: `drop` deletes as it goes.
      // Lint calls the spread unnecessary; it is not, and removing it would
      // silently leave half the environments attached.
      for (const environmentId of [...attached.keys()]) drop(environmentId);
    },
    /** Test seam: how many environments are currently attached. */
    get attachedCount(): number {
      return attached.size;
    },
  };
}
