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

import type { OrchestrationThreadStreamItem } from "@synara/contracts";

import { createEnvironmentAttachmentRegistry } from "./environmentAttachment";

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
  // Attachment is keyed on the CLIENT by the shared registry rather than the
  // environment id. A logout disposes a transport without deregistering, so the
  // registry hands back a NEW client object under the same id; an id-keyed check
  // would treat the replacement as already-attached and leave the detach
  // pointing at a dead client whose registries `dispose()` cleared — that
  // environment's threads would silently stop updating. Three subscribers got
  // this wrong independently before it was extracted.
  const registry = createEnvironmentAttachmentRegistry({
    attach: (client) => client.api.orchestration.onThreadEvent(onItem),
  });
  return {
    sync: registry.sync,
    detachAll: registry.dispose,
  };
}
