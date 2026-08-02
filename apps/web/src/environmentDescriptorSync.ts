// FILE: environmentDescriptorSync.ts
// Purpose: Keeps the environment directory's labels and reachability current by
//          asking each connected server to describe itself.
// Layer: Web environment UX
// Exports: createEnvironmentDescriptorSync

import {
  createEnvironmentAttachmentRegistry,
  type EnvironmentAttachment,
} from "./environmentAttachment";
import {
  forgetEnvironmentMetadata,
  recordEnvironmentDescriptor,
  recordEnvironmentReachability,
} from "./environmentDirectory";

/**
 * Describes every connected environment, and forgets the ones that left.
 *
 * A failed descriptor marks the environment UNREACHABLE rather than leaving it
 * pending: the "Start in" picker refuses to start a chat on a host it cannot
 * describe, and a permanently-"checking" host is indistinguishable from a
 * working one that is merely slow — the user would keep clicking a row that
 * never responds.
 *
 * Attachment is keyed on the CLIENT via the shared registry, not the
 * environment id: the registry replaces a disposed client with a new object
 * under the same id, and an id-keyed check would treat the replacement as
 * already-described — leaving that host stuck on a stale label, or stuck at
 * "checking" forever if the first attempt failed.
 */
export function createEnvironmentDescriptorSync() {
  return createEnvironmentAttachmentRegistry({
    attach(client): EnvironmentAttachment["detach"] {
      // Resolved after the request settles, so a client replaced or removed
      // mid-flight does not record a descriptor for a connection that is gone.
      let active = true;
      void client.api.server
        .getEnvironment()
        .then((descriptor) => {
          if (!active) return;
          recordEnvironmentDescriptor(client.environmentId, descriptor);
        })
        .catch(() => {
          if (!active) return;
          recordEnvironmentReachability(client.environmentId, "unreachable");
        });
      return () => {
        active = false;
      };
    },
    // A re-registered host may be a different machine reusing the same id slot,
    // so a surviving label would name the old one.
    release: forgetEnvironmentMetadata,
  });
}
