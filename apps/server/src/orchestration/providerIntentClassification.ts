import type { OrchestrationEvent } from "@synara/contracts";

export type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.created"
      | "thread.deleted"
      | "thread.archived"
      | "thread.meta-updated"
      | "thread.session-set"
      | "thread.runtime-mode-set"
      | "thread.turn-queued"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.task-stop-requested"
      | "thread.task-background-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.conversation-rollback-requested"
      | "thread.message-edit-resend-requested"
      | "thread.session-stop-requested";
  }
>;

const PROVIDER_INTENT_EVENT_TYPES = new Set<ProviderIntentEvent["type"]>([
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.meta-updated",
  "thread.session-set",
  "thread.runtime-mode-set",
  "thread.turn-queued",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.task-stop-requested",
  "thread.task-background-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.conversation-rollback-requested",
  "thread.message-edit-resend-requested",
  "thread.session-stop-requested",
]);

export const isProviderIntentEventType = (
  eventType: string,
): eventType is ProviderIntentEvent["type"] =>
  PROVIDER_INTENT_EVENT_TYPES.has(eventType as ProviderIntentEvent["type"]);

export const isProviderIntentEvent = (event: OrchestrationEvent): event is ProviderIntentEvent =>
  isProviderIntentEventType(event.type);

export const isReplaySafeClaimedProviderIntent = (event: ProviderIntentEvent): boolean =>
  event.type === "thread.created" || event.type === "thread.archived";

export const isProviderSideEffectIntent = (event: ProviderIntentEvent): boolean =>
  event.type !== "thread.created" &&
  event.type !== "thread.deleted" &&
  event.type !== "thread.session-set" &&
  event.type !== "thread.turn-queued";

export const isClaimedProviderIntent = (event: ProviderIntentEvent): boolean =>
  isReplaySafeClaimedProviderIntent(event) || isProviderSideEffectIntent(event);

/**
 * Intents that must still execute while a thread is quarantined by a blocking
 * delivery. Skipping an interrupt is never safe: the turn it would settle keeps
 * running (or keeps showing as running) with no other way out for the user.
 */
export const isQuarantineExemptProviderIntent = (event: ProviderIntentEvent): boolean =>
  event.type === "thread.turn-interrupt-requested";
