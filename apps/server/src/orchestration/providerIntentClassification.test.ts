import { EventId, ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  isClaimedProviderIntent,
  isProviderIntentEvent,
  isProviderSideEffectIntent,
  isReplaySafeClaimedProviderIntent,
} from "./providerIntentClassification.ts";

describe("providerIntentClassification", () => {
  it("orders replay-safe unarchive restoration without treating it as provider execution", () => {
    const event = {
      type: "thread.unarchived",
      payload: { threadId: ThreadId.makeUnsafe("thread-provider-intent-unarchive") },
    } as OrchestrationEvent;
    expect(isProviderIntentEvent(event)).toBe(true);
    if (!isProviderIntentEvent(event)) return;
    expect(isClaimedProviderIntent(event)).toBe(true);
    expect(isReplaySafeClaimedProviderIntent(event)).toBe(true);
    expect(isProviderSideEffectIntent(event)).toBe(false);
  });

  it("orders archive cleanup with later provider side effects", () => {
    const threadId = ThreadId.makeUnsafe("thread-provider-intent-archive");
    const event = {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-provider-intent-archive"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.archived",
      occurredAt: "2026-07-23T20:00:00.000Z",
      payload: {
        threadId,
        archivedAt: "2026-07-23T20:00:00.000Z",
        updatedAt: "2026-07-23T20:00:00.000Z",
      },
    } as OrchestrationEvent;

    expect(isProviderIntentEvent(event)).toBe(true);
    if (!isProviderIntentEvent(event)) return;
    expect(isProviderSideEffectIntent(event)).toBe(true);
    expect(isClaimedProviderIntent(event)).toBe(true);
    expect(isReplaySafeClaimedProviderIntent(event)).toBe(true);
  });
});
