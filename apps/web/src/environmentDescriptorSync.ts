// FILE: environmentDescriptorSync.ts
// Purpose: Keeps the environment directory's labels and reachability current by
//          asking each connected server to describe itself.
// Layer: Web environment UX
// Exports: createEnvironmentDescriptorSync

import {
  forgetEnvironmentMetadata,
  recordEnvironmentDescriptor,
  recordEnvironmentReachability,
} from "./environmentDirectory";
import type { EnvironmentId } from "@synara/contracts";
import type { WsEnvironmentClient } from "./wsNativeApi";

/**
 * Describes every connected environment, and forgets the ones that left.
 *
 * A failed descriptor marks the environment UNREACHABLE rather than leaving it
 * pending: the "Start in" picker refuses to start a chat on a host it cannot
 * describe, and a permanently-"checking" host is indistinguishable from a
 * working one that is merely slow — the user would keep clicking a row that
 * never responds.
 */
export function createEnvironmentDescriptorSync() {
  const described = new Set<EnvironmentId>();
  let disposed = false;

  return {
    sync(clients: readonly WsEnvironmentClient[]): void {
      if (disposed) return;
      const present = new Set(clients.map((client) => client.environmentId));

      // Snapshotted before the loop because the loop deletes from `described`;
      // mutating a Set while iterating it is how entries get skipped.
      const departed = Array.from(described).filter((environmentId) => !present.has(environmentId));
      for (const environmentId of departed) {
        described.delete(environmentId);
        // A re-registered host may be a different machine reusing the same id
        // slot, so a surviving label would name the old one.
        forgetEnvironmentMetadata(environmentId);
      }

      for (const client of clients) {
        if (described.has(client.environmentId)) continue;
        described.add(client.environmentId);
        void client.api.server
          .getEnvironment()
          .then((descriptor) => {
            if (disposed || !described.has(client.environmentId)) return;
            recordEnvironmentDescriptor(client.environmentId, descriptor);
          })
          .catch(() => {
            if (disposed || !described.has(client.environmentId)) return;
            recordEnvironmentReachability(client.environmentId, "unreachable");
          });
      }
    },
    dispose(): void {
      disposed = true;
      for (const environmentId of described) forgetEnvironmentMetadata(environmentId);
      described.clear();
    },
  };
}
