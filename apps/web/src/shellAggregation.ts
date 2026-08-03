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
  const detachListener = client.api.orchestration.onShellEvent((item) => {
    if (item.kind !== "snapshot") return;
    // The store fences per environment, so no fence is tracked here — a second
    // server's sequence 1 must not be compared against the first server's.
    store.syncServerShellSnapshot(item.snapshot, environmentId);
  });

  // ASK FOR THE STREAM, do not merely listen for it. A listener is not a
  // subscription: the server only starts sending shell snapshots once
  // `subscribeShell` has been called on that connection. Attaching without it
  // left every environment — including the local one — waiting on a producer
  // nobody started, so the sidebar stayed empty and `threadIds` never
  // populated. Before this module existed the call lived in the route effect;
  // moving attachment per-environment moved the listener and dropped the
  // request.
  void client.api.orchestration.subscribeShell().catch(() => {
    // A failed subscribe must not tear down the listener: the transport
    // resubscribes on reconnect, and a snapshot pushed later still lands.
  });

  return () => {
    detachListener();
    void client.api.orchestration.unsubscribeShell().catch(() => undefined);
  };
}

/**
 * Attaches every registered non-local environment and detaches the ones that
 * have gone away. The local environment is excluded: it is already streamed by
 * the root route's subscription, and attaching it twice would double-apply.
 */
export function createShellAggregator(store: ShellAggregationTarget) {
  // Keyed by environment id, but the CLIENT is held alongside the detach: the
  // registry replaces a disposed entry with a new client object under the same
  // id (a logout disposes the transport without deregistering, so this is a
  // normal occurrence). Keying attachment on the id alone made a replacement
  // look already-attached, leaving the stored detach pointing at a dead client
  // whose listener registries `dispose()` had cleared — so the replacement was
  // never subscribed and that environment's sidebar silently stopped updating.
  const attachedByEnvironmentId = new Map<
    EnvironmentId,
    { readonly client: WsEnvironmentClient; readonly detach: () => void }
  >();

  return {
    sync(clients: readonly WsEnvironmentClient[]): void {
      const present = new Set<EnvironmentId>();
      for (const client of clients) {
        if (client.environmentId === LOCAL_ENVIRONMENT_ID) continue;
        present.add(client.environmentId);
        const attached = attachedByEnvironmentId.get(client.environmentId);
        if (attached?.client === client) continue;
        // A different instance under the same id is a replacement: release the
        // old subscription before taking one on the new client.
        attached?.detach();
        attachedByEnvironmentId.set(client.environmentId, {
          client,
          detach: attachEnvironmentShellStream(client, store),
        });
      }
      for (const [environmentId, attached] of [...attachedByEnvironmentId]) {
        if (present.has(environmentId)) continue;
        attachedByEnvironmentId.delete(environmentId);
        attached.detach();
      }
    },
    detachAll(): void {
      for (const attached of attachedByEnvironmentId.values()) attached.detach();
      attachedByEnvironmentId.clear();
    },
    get attachedCount(): number {
      return attachedByEnvironmentId.size;
    },
  };
}
