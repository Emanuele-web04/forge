import type { OrchestrationEvent, ThreadId } from "@synara/contracts";

export const THREAD_DETAIL_EVENT_TYPES = [
  "thread.message-sent",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.conversation-rolled-back",
  "thread.session-set",
  "thread.meta-updated",
  "thread.pinned-message-added",
  "thread.pinned-message-removed",
  "thread.pinned-message-done-set",
  "thread.pinned-message-label-set",
  "thread.marker-added",
  "thread.marker-removed",
  "thread.marker-done-set",
  "thread.marker-label-set",
  "thread.archived",
  "thread.unarchived",
  "thread.sidechat-activity-recorded",
  "thread.sidechat-expired",
] as const satisfies ReadonlyArray<OrchestrationEvent["type"]>;

const THREAD_DETAIL_EVENT_TYPE_SET = new Set<OrchestrationEvent["type"]>(THREAD_DETAIL_EVENT_TYPES);

export function isThreadDetailEventFor(event: OrchestrationEvent, threadId: ThreadId): boolean {
  return (
    event.aggregateKind === "thread" &&
    event.aggregateId === threadId &&
    THREAD_DETAIL_EVENT_TYPE_SET.has(event.type)
  );
}
