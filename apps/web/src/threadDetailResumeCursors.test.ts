// FILE: threadDetailResumeCursors.test.ts
// Purpose: Verifies resume-cursor bookkeeping behind delta-capable thread resubscribes.
// Layer: Web subscription utility test

import { ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceThreadDetailResumeCursor,
  buildThreadSubscribeInput,
  clearThreadDetailResumeCursor,
  getThreadDetailResumeCursor,
  hasThreadDetailResumeCursor,
  resetThreadDetailResumeCursorsForTests,
  setThreadDetailResumeCursor,
} from "./threadDetailResumeCursors";

function threadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

describe("threadDetailResumeCursors", () => {
  afterEach(() => {
    resetThreadDetailResumeCursorsForTests();
  });

  it("subscribes without a cursor until cached detail exists, then resumes from it", () => {
    const thread = threadId("thread-1");

    expect(buildThreadSubscribeInput(thread)).toEqual({ threadId: thread });

    setThreadDetailResumeCursor(thread, 12);
    expect(buildThreadSubscribeInput(thread)).toEqual({ threadId: thread, afterSequence: 12 });
  });

  it("advances monotonically for events but lets snapshots overwrite backwards", () => {
    const thread = threadId("thread-2");

    advanceThreadDetailResumeCursor(thread, 5);
    advanceThreadDetailResumeCursor(thread, 3);
    expect(getThreadDetailResumeCursor(thread)).toBe(5);

    // A fresh snapshot replaces cached detail wholesale, so a lower fence
    // (server restored from backup) must win over the stale live cursor.
    setThreadDetailResumeCursor(thread, 2);
    expect(getThreadDetailResumeCursor(thread)).toBe(2);
  });

  it("clears cursors individually and in batch when cached detail is wiped", () => {
    const threadOne = threadId("thread-3");
    const threadTwo = threadId("thread-4");
    setThreadDetailResumeCursor(threadOne, 7);
    setThreadDetailResumeCursor(threadTwo, 8);

    clearThreadDetailResumeCursor(threadOne);
    expect(hasThreadDetailResumeCursor(threadOne)).toBe(false);
    expect(hasThreadDetailResumeCursor(threadTwo)).toBe(true);

    clearThreadDetailResumeCursor(threadTwo);
    expect(buildThreadSubscribeInput(threadTwo)).toEqual({ threadId: threadTwo });
  });
});
