// FILE: threadStreamAggregation.ts
// Purpose: Deliver every environment's thread-detail stream to one handler, so a
//          remote thread's transcript is actually consumed.
// Layer: Web transport aggregation
// Exports: createThreadStreamAggregator
//
// WHY THIS EXISTS
//
// `subscribeThread` is routed to the thread's OWNING host, so a remote thread's
// events arrive on that host's connection. The root route previously listened
// only on the local client, so those events were delivered to a socket nobody
// was reading: the chat rendered empty or frozen with no error, because nothing
// failed — the stream simply had no listener. Subscribing remotely while
// consuming locally is the whole bug.
//
// Unlike the shell aggregator this attaches the LOCAL environment too, and is
// the only thread-stream listener. Thread detail is keyed by thread id and each
// thread has exactly one owner, so there is no double-apply to avoid: two
// environments cannot both deliver the same thread's events.

import type { EnvironmentId, OrchestrationThreadStreamItem } from "@synara/contracts";

import type { WsEnvironmentClient } from "./wsNativeApi";

/**
 * Fans every registered environment's thread stream into `onItem`.
 *
 * The handler must be environment-agnostic: it is called with items from all
 * connected hosts, and anything it records has to be keyed by thread id (or
 * resolve the owning environment itself) rather than assuming one server.
 */
export function createThreadStreamAggregator(
  onItem: (item: OrchestrationThreadStreamItem) => void,
) {
  // Keyed by environment id, but the CLIENT is held alongside the detach: the
  // registry replaces a disposed entry with a NEW client object under the same
  // id (a logout disposes the transport without deregistering, so this is
  // normal). Keying attachment on the id alone would make a replacement look
  // already-attached, leaving the stored detach pointing at a dead client whose
  // registries `dispose()` cleared — so the replacement would never be
  // subscribed and that environment's threads would silently stop updating.
  // The shell aggregator learned this the hard way; the same shape is required
  // here rather than rediscovered.
  const attachedByEnvironmentId = new Map<
    EnvironmentId,
    { readonly client: WsEnvironmentClient; readonly detach: () => void }
  >();

  return {
    sync(clients: readonly WsEnvironmentClient[]): void {
      const present = new Set<EnvironmentId>();
      for (const client of clients) {
        present.add(client.environmentId);
        const attached = attachedByEnvironmentId.get(client.environmentId);
        if (attached?.client === client) continue;
        // A different instance under the same id is a replacement: release the
        // old subscription before taking one on the new client.
        attached?.detach();
        attachedByEnvironmentId.set(client.environmentId, {
          client,
          detach: client.api.orchestration.onThreadEvent(onItem),
        });
      }
      // Snapshotted before the loop because the body DELETES from the map, and
      // mutating a Map while iterating it is how entries get skipped. Lint
      // flags the spread as unnecessary; it is not, and the shell aggregator
      // carries the same warning for the same reason.
      for (const [environmentId, attached] of [...attachedByEnvironmentId]) {
        if (present.has(environmentId)) continue;
        // Delete BEFORE detaching, matching the shell aggregator: if `detach`
        // throws, the entry is already gone rather than left pointing at a
        // half-released subscription a later sync would treat as live.
        attachedByEnvironmentId.delete(environmentId);
        attached.detach();
      }
    },
    detachAll(): void {
      for (const attached of attachedByEnvironmentId.values()) attached.detach();
      attachedByEnvironmentId.clear();
    },
  };
}
