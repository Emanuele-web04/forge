// FILE: orchestrationEventCoalescing.ts
// Purpose: Collapse a flush window of orchestration domain events before they reach the
//          store reducer, so N streamed text deltas for one message cost one reducer pass.
// Layer: Web client event pipeline (pure)
// Exports: coalesceOrchestrationUiEvents
// Why: Coalesce text across interleaved threads without moving a thread's state
//      transitions ahead of its other events.

import type { OrchestrationEvent } from "@synara/contracts";

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

/** Concatenate incremental text while retaining the message's original timeline position. */
function mergeThreadMessageSentEvents(
  previous: ThreadMessageSentEvent,
  event: ThreadMessageSentEvent,
): ThreadMessageSentEvent {
  return {
    ...event,
    payload: {
      ...event.payload,
      attachments: event.payload.attachments ?? previous.payload.attachments,
      skills: event.payload.skills ?? previous.payload.skills,
      mentions: event.payload.mentions ?? previous.payload.mentions,
      createdAt: previous.payload.createdAt,
      text: previous.payload.text + event.payload.text,
    },
  };
}

/**
 * Only unrelated threads may intervene between merged deltas. Even a streaming
 * message updates turn state and diff bindings, so every other event in its own
 * thread is an ordering barrier. Project/space events can affect multiple threads.
 */
export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  const coalesced: OrchestrationEvent[] = [];
  const lastSlotByThread = new Map<string, number>();
  for (const event of events) {
    if (!("threadId" in event.payload)) {
      lastSlotByThread.clear();
    } else {
      const threadId = event.payload.threadId;
      const slot = lastSlotByThread.get(threadId);
      const previous = slot === undefined ? undefined : coalesced[slot];
      if (
        event.type === "thread.message-sent" &&
        previous?.type === "thread.message-sent" &&
        previous.payload.messageId === event.payload.messageId &&
        previous.payload.turnId === event.payload.turnId &&
        previous.payload.role === event.payload.role &&
        previous.payload.streaming &&
        event.payload.streaming
      ) {
        coalesced[slot!] = mergeThreadMessageSentEvents(previous, event);
        continue;
      }
      lastSlotByThread.set(threadId, coalesced.length);
    }
    coalesced.push(event);
  }
  return coalesced;
}
