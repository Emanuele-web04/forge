// FILE: shellAggregation.ts
// Purpose: Merge remote environments' shell streams into the single client-side store.
// Layer: Web transport aggregation
// Exports: attachEnvironmentShellStream and the multi-environment aggregator.

import type { EnvironmentId, OrchestrationShellStreamItem } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import type { WsEnvironmentClient } from "./wsNativeApi";

/**
 * The subset of the store this module writes. Narrowed to keep the aggregator
 * testable without standing up the full zustand store.
 */
export interface ShellAggregationTarget {
  syncServerShellSnapshot(
    snapshot: Extract<OrchestrationShellStreamItem, { kind: "snapshot" }>["snapshot"],
    environmentId: EnvironmentId,
  ): void;
}

/**
 * Streams one environment's shell into the store.
 *
 * Each environment keeps its own snapshot fence. Sequences are per-server
 * autoincrement values, so a shared fence would let the first environment's
 * snapshot sequence suppress a second environment's — two servers both starting
 * at sequence 1 is the normal case, not an anomaly.
 */
export function attachEnvironmentShellStream(
  client: WsEnvironmentClient,
  store: ShellAggregationTarget,
): () => void {
  const { environmentId } = client;

  // Only snapshots are merged for remote environments. Incremental shell events
  // are deliberately dropped: the store's event path resolves threads by id
  // alone, so applying one would write into whichever environment happens to
  // hold that id. Staleness between snapshots is the accepted cost until that
  // path is environment-keyed; a wrong-environment write would not be.
  return client.api.orchestration.onShellEvent((item) => {
    if (item.kind !== "snapshot") return;
    // The store fences per environment, so no fence is tracked here — a second
    // server's sequence 1 must not be compared against the first server's.
    store.syncServerShellSnapshot(item.snapshot, environmentId);
  });
}

/**
 * Attaches every registered non-local environment and detaches the ones that
 * have gone away. The local environment is excluded: it is already streamed by
 * the root route's subscription, and attaching it twice would double-apply.
 */
export function createShellAggregator(store: ShellAggregationTarget) {
  const detachByEnvironmentId = new Map<EnvironmentId, () => void>();

  return {
    sync(clients: readonly WsEnvironmentClient[]): void {
      const present = new Set<EnvironmentId>();
      for (const client of clients) {
        if (client.environmentId === LOCAL_ENVIRONMENT_ID) continue;
        present.add(client.environmentId);
        if (detachByEnvironmentId.has(client.environmentId)) continue;
        detachByEnvironmentId.set(
          client.environmentId,
          attachEnvironmentShellStream(client, store),
        );
      }
      for (const [environmentId, detach] of [...detachByEnvironmentId]) {
        if (present.has(environmentId)) continue;
        detachByEnvironmentId.delete(environmentId);
        detach();
      }
    },
    detachAll(): void {
      for (const detach of detachByEnvironmentId.values()) detach();
      detachByEnvironmentId.clear();
    },
    get attachedCount(): number {
      return detachByEnvironmentId.size;
    },
  };
}
