import { ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { isThreadDetailEventFor, THREAD_DETAIL_EVENT_TYPES } from "./threadDetailEvents";

describe("thread detail events", () => {
  it("keeps replay filtering and routing on one event-type definition", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const detailEvent = {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.unarchived",
    } as OrchestrationEvent;
    const shellOnlyEvent = {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.deleted",
    } as OrchestrationEvent;

    expect(THREAD_DETAIL_EVENT_TYPES).toContain(detailEvent.type);
    expect(isThreadDetailEventFor(detailEvent, threadId)).toBe(true);
    expect(isThreadDetailEventFor(shellOnlyEvent, threadId)).toBe(false);
    expect(isThreadDetailEventFor(detailEvent, ThreadId.makeUnsafe("thread-2"))).toBe(false);
  });
});
