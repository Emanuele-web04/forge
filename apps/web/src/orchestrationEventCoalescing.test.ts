import {
  CheckpointRef,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { coalesceOrchestrationUiEvents } from "./orchestrationEventCoalescing";
import { makeActivity, makeDomainEvent, makeState, makeThread } from "./storeTestFixtures";

import { applyOrchestrationEvents } from "./storeEventReducer";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const MESSAGE_A = MessageId.makeUnsafe("message-a");
const MESSAGE_B = MessageId.makeUnsafe("message-b");

function delta(
  threadId: ThreadId,
  messageId: MessageId,
  text: string,
  sequence: number,
  options: { streaming?: boolean; createdAt?: string } = {},
): OrchestrationEvent {
  const createdAt =
    options.createdAt ?? `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`;
  return makeDomainEvent(
    "thread.message-sent",
    {
      threadId,
      messageId,
      role: "assistant",
      text,
      turnId: TurnId.makeUnsafe("turn-1"),
      streaming: options.streaming ?? true,
      source: "native",
      createdAt,
      updatedAt: createdAt,
    },
    { sequence },
  );
}

function activity(threadId: ThreadId, sequence: number): OrchestrationEvent {
  return makeDomainEvent(
    "thread.activity-appended",
    { threadId, activity: makeActivity({ id: `activity-${sequence}` }) },
    { sequence },
  );
}

function messageText(event: OrchestrationEvent): string | null {
  return event.type === "thread.message-sent" ? event.payload.text : null;
}

describe("coalesceOrchestrationUiEvents", () => {
  it("returns a copy for zero or one event", () => {
    expect(coalesceOrchestrationUiEvents([])).toEqual([]);
    const single = [delta(THREAD_A, MESSAGE_A, "hi", 1)];
    const result = coalesceOrchestrationUiEvents(single);
    expect(result).toEqual(single);
    expect(result).not.toBe(single);
  });

  it("merges adjacent deltas for one message into one event", () => {
    const result = coalesceOrchestrationUiEvents([
      delta(THREAD_A, MESSAGE_A, "Hel", 1),
      delta(THREAD_A, MESSAGE_A, "lo", 2),
      delta(THREAD_A, MESSAGE_A, "!", 3),
    ]);
    expect(result).toHaveLength(1);
    expect(messageText(result[0]!)).toBe("Hello!");
    expect(result[0]!.sequence).toBe(3);
  });

  it("merges deltas for the same message even when other threads interleave", () => {
    const result = coalesceOrchestrationUiEvents([
      delta(THREAD_A, MESSAGE_A, "a1", 1),
      delta(THREAD_B, MESSAGE_B, "b1", 2),
      activity(THREAD_A, 3),
      delta(THREAD_A, MESSAGE_A, "a2", 4),
      delta(THREAD_B, MESSAGE_B, "b2", 5),
      delta(THREAD_A, MESSAGE_A, "a3", 6),
    ]);
    expect(result.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.message-sent",
      "thread.activity-appended",
      "thread.message-sent",
    ]);
    expect(messageText(result[0]!)).toBe("a1");
    expect(messageText(result[3]!)).toBe("a2a3");
    expect(messageText(result[1]!)).toBe("b1b2");
    expect(result[2]!.sequence).toBe(3);
  });

  it("keeps the first delta's createdAt and the latest event's sequence", () => {
    const result = coalesceOrchestrationUiEvents([
      delta(THREAD_A, MESSAGE_A, "x", 1, { createdAt: "2026-01-01T00:00:01.000Z" }),
      activity(THREAD_B, 2),
      delta(THREAD_A, MESSAGE_A, "y", 3, { createdAt: "2026-01-01T00:00:03.000Z" }),
    ]);
    const merged = result[0]!;
    expect(merged.type).toBe("thread.message-sent");
    if (merged.type !== "thread.message-sent") throw new Error("unreachable");
    expect(merged.payload.createdAt).toBe("2026-01-01T00:00:01.000Z");
    expect(merged.payload.updatedAt).toBe("2026-01-01T00:00:03.000Z");
    expect(merged.sequence).toBe(3);
  });

  it("preserves completion events as turn-state boundaries", () => {
    const result = coalesceOrchestrationUiEvents([
      activity(THREAD_A, 1),
      delta(THREAD_A, MESSAGE_A, "partial", 2),
      delta(THREAD_A, MESSAGE_A, "final full text", 3, { streaming: false }),
    ]);
    expect(result).toHaveLength(3);
    expect(messageText(result[2]!)).toBe("final full text");
    if (result[2]!.type !== "thread.message-sent") throw new Error("unreachable");
    expect(result[2]!.payload.streaming).toBe(false);
  });

  it("keeps a non-adjacent completion in place so intervening events see the transition in order", () => {
    const result = coalesceOrchestrationUiEvents([
      delta(THREAD_A, MESSAGE_A, "part", 1),
      activity(THREAD_A, 2),
      delta(THREAD_A, MESSAGE_A, "ial", 3),
      makeDomainEvent(
        "thread.turn-diff-completed",
        {
          threadId: THREAD_A,
          turnId: TurnId.makeUnsafe("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:04.000Z",
        },
        { sequence: 4 },
      ),
      delta(THREAD_A, MESSAGE_A, "partial", 5, { streaming: false }),
      delta(THREAD_A, MESSAGE_A, "", 6, { streaming: false }),
    ]);
    expect(result).toHaveLength(6);
    expect(messageText(result[0]!)).toBe("part");
    expect(messageText(result[2]!)).toBe("ial");
    expect(messageText(result[4]!)).toBe("partial");
    expect(result[5]!.sequence).toBe(6);
  });

  it("does not merge different messages of the same thread", () => {
    const result = coalesceOrchestrationUiEvents([
      delta(THREAD_A, MESSAGE_A, "a", 1),
      delta(THREAD_A, MESSAGE_B, "b", 2),
      delta(THREAD_A, MESSAGE_A, "a", 3),
    ]);
    expect(result.map(messageText)).toEqual(["a", "b", "a"]);
  });

  it("preserves final reducer state for same-turn message switches and activity barriers", () => {
    const cases = [
      [delta(THREAD_A, MESSAGE_A, "a", 1), delta(THREAD_A, MESSAGE_B, "b", 2), delta(THREAD_A, MESSAGE_A, "a", 3)],
      [delta(THREAD_A, MESSAGE_A, "a", 1), activity(THREAD_A, 2), delta(THREAD_A, MESSAGE_A, "b", 3)],
      [delta(THREAD_A, MESSAGE_A, "a", 1), delta(THREAD_A, MESSAGE_A, "ab", 2, { streaming: false }), delta(THREAD_A, MESSAGE_A, "c", 3)],
      [delta(THREAD_A, MESSAGE_A, "a", 1), activity(THREAD_B, 2), delta(THREAD_A, MESSAGE_A, "b", 3)],
    ];
    for (const events of cases) {
      // Hydration creates the sidebar summary before stream deltas arrive.
      const state = applyOrchestrationEvents(makeState(makeThread({ id: THREAD_A })), [
        delta(THREAD_A, MESSAGE_A, "seed", 0),
      ]);
      expect(applyOrchestrationEvents(state, coalesceOrchestrationUiEvents(events)))
        .toEqual(applyOrchestrationEvents(state, events));
    }
  });

  it("does not move deltas across a project deletion", () => {
    const thread = makeThread({ id: THREAD_A });
    const events = [
      delta(THREAD_A, MESSAGE_A, "a", 1),
      makeDomainEvent("project.deleted", { projectId: thread.projectId, deletedAt: "2026-01-01T00:00:02Z" }, { sequence: 2 }),
      delta(THREAD_A, MESSAGE_A, "b", 3),
    ];
    expect(coalesceOrchestrationUiEvents(events)).toEqual(events);
    const state = makeState(thread);
    expect(applyOrchestrationEvents(state, coalesceOrchestrationUiEvents(events)))
      .toEqual(applyOrchestrationEvents(state, events));
  });

  it("does not mutate the input events", () => {
    const first = delta(THREAD_A, MESSAGE_A, "a", 1);
    const second = delta(THREAD_A, MESSAGE_A, "b", 2);
    coalesceOrchestrationUiEvents([first, second]);
    expect(messageText(first)).toBe("a");
    expect(messageText(second)).toBe("b");
  });
});
