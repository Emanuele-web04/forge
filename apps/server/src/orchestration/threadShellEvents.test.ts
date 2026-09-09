import { EventId, MessageId, ThreadId } from "@synara/contracts";
import type { OrchestrationEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  shouldApplyDeferredThreadShellSummary,
  shouldPublishThreadShellForEvent,
} from "./threadShellEvents.ts";

const threadId = ThreadId.makeUnsafe("thread-shell-events");
const createdAt = "2026-07-09T00:00:00.000Z";

function event<TType extends OrchestrationEvent["type"]>(
  type: TType,
  payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
): Extract<OrchestrationEvent, { type: TType }> {
  return {
    type,
    payload,
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${type}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as Extract<OrchestrationEvent, { type: TType }>;
}

function activityEvent(
  kind: string,
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
  return event("thread.activity-appended", {
    threadId,
    activity: {
      id: EventId.makeUnsafe(`activity-${kind}`),
      tone: "info",
      kind,
      summary: kind,
      payload: {},
      turnId: null,
      createdAt,
    },
  });
}

function messageEvent(input: {
  role: "user" | "assistant";
  streaming: boolean;
}): Extract<OrchestrationEvent, { type: "thread.message-sent" }> {
  return event("thread.message-sent", {
    threadId,
    messageId: MessageId.makeUnsafe(`message-${input.role}-${input.streaming}`),
    role: input.role,
    text: "text",
    turnId: null,
    streaming: input.streaming,
    source: "native",
    createdAt,
    updatedAt: createdAt,
  });
}

describe("thread shell event relevance", () => {
  it("drops telemetry and tool progress that cannot change the shell", () => {
    expect(shouldPublishThreadShellForEvent(activityEvent("context-window.updated"))).toBe(false);
    expect(shouldPublishThreadShellForEvent(activityEvent("account.rate-limits.updated"))).toBe(
      false,
    );
    expect(shouldPublishThreadShellForEvent(activityEvent("tool.updated"))).toBe(false);
    expect(
      shouldPublishThreadShellForEvent(messageEvent({ role: "assistant", streaming: true })),
    ).toBe(false);
  });

  it("keeps events that update shell fields or summary state", () => {
    expect(shouldPublishThreadShellForEvent(activityEvent("approval.requested"))).toBe(true);
    expect(shouldApplyDeferredThreadShellSummary(activityEvent("approval.requested"))).toBe(false);
    expect(shouldPublishThreadShellForEvent(messageEvent({ role: "user", streaming: false }))).toBe(
      true,
    );
    expect(
      shouldApplyDeferredThreadShellSummary(messageEvent({ role: "user", streaming: false })),
    ).toBe(true);
    expect(
      shouldPublishThreadShellForEvent(messageEvent({ role: "assistant", streaming: false })),
    ).toBe(true);
  });
});
