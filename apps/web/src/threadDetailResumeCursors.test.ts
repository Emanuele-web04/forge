// FILE: threadDetailResumeCursors.test.ts
// Purpose: Verifies per-environment resume-cursor bookkeeping behind delta-capable resubscribes.
// Layer: Web subscription utility test

import { EnvironmentId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import {
  localThreadDetailResumeCursors,
  resetThreadDetailResumeCursorsForTests,
  threadDetailResumeCursors,
} from "./threadDetailResumeCursors";

function threadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("remote-environment");

describe("threadDetailResumeCursors", () => {
  afterEach(() => {
    resetThreadDetailResumeCursorsForTests();
  });

  // The single-local-server case is the regression bar, and it was previously
  // only pinned indirectly: a mutation collapsing every environment into one
  // global map failed only multi-environment tests, so a regression affecting
  // just the default path would have gone unnoticed. These pin it directly.
  it("resolves the env-unaware default to the same scope as the local environment", () => {
    expect(localThreadDetailResumeCursors()).toBe(threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID));
  });

  it("shares cursor state between env-unaware and explicitly-local callers", () => {
    const thread = threadId("thread-default-path");

    // An env-unaware caller writes...
    localThreadDetailResumeCursors().set(thread, 21);
    // ...and a caller naming the local environment explicitly must observe it.
    expect(threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID).get(thread)).toBe(21);
    expect(threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID).buildSubscribeInput(thread)).toEqual({
      threadId: thread,
      afterSequence: 21,
    });

    // And the reverse direction, so neither is a one-way alias.
    threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID).set(thread, 34);
    expect(localThreadDetailResumeCursors().get(thread)).toBe(34);
  });

  it("subscribes without a cursor until cached detail exists, then resumes from it", () => {
    const cursors = localThreadDetailResumeCursors();
    const thread = threadId("thread-1");

    expect(cursors.buildSubscribeInput(thread)).toEqual({ threadId: thread });

    cursors.set(thread, 12);
    expect(cursors.buildSubscribeInput(thread)).toEqual({ threadId: thread, afterSequence: 12 });
  });

  it("advances monotonically for events but lets snapshots overwrite backwards", () => {
    const cursors = localThreadDetailResumeCursors();
    const thread = threadId("thread-2");

    cursors.advance(thread, 5);
    cursors.advance(thread, 3);
    expect(cursors.get(thread)).toBe(5);

    // A fresh snapshot replaces cached detail wholesale, so a lower fence
    // (server restored from backup) must win over the stale live cursor.
    cursors.set(thread, 2);
    expect(cursors.get(thread)).toBe(2);
  });

  it("clears cursors individually and in batch when cached detail is wiped", () => {
    const cursors = localThreadDetailResumeCursors();
    const threadOne = threadId("thread-3");
    const threadTwo = threadId("thread-4");
    cursors.set(threadOne, 7);
    cursors.set(threadTwo, 8);

    cursors.clear(threadOne);
    expect(cursors.has(threadOne)).toBe(false);
    expect(cursors.has(threadTwo)).toBe(true);

    cursors.clearMany([threadTwo]);
    expect(cursors.buildSubscribeInput(threadTwo)).toEqual({ threadId: threadTwo });
  });

  it("retains only the surviving threads within its own environment", () => {
    const local = localThreadDetailResumeCursors();
    const remote = threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID);
    const kept = threadId("thread-kept");
    const pruned = threadId("thread-pruned");
    local.set(kept, 4);
    local.set(pruned, 5);
    remote.set(pruned, 9);

    local.retain(new Set([kept]));

    expect(local.has(pruned)).toBe(false);
    // The remote server's journal was not pruned; its cursor must survive.
    expect(remote.get(pruned)).toBe(9);
  });

  it("keeps sequence spaces separate for the same thread id across environments", () => {
    // Sequences are per-server SQLite autoincrement values with no cross-server
    // ordering. A thread id colliding across environments must never let one
    // server's fence be sent to the other.
    const shared = threadId("thread-shared");
    const local = localThreadDetailResumeCursors();
    const remote = threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID);

    local.set(shared, 100);
    remote.set(shared, 3);

    expect(local.buildSubscribeInput(shared)).toEqual({ threadId: shared, afterSequence: 100 });
    expect(remote.buildSubscribeInput(shared)).toEqual({ threadId: shared, afterSequence: 3 });

    // An advance in one environment cannot drag the other forward, even though
    // the remote sequence is numerically lower.
    remote.advance(shared, 4);
    expect(local.get(shared)).toBe(100);
    expect(remote.get(shared)).toBe(4);
  });

  it("resets only the environment whose server instance changed", () => {
    const shared = threadId("thread-shared");
    const local = localThreadDetailResumeCursors();
    const remote = threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID);
    local.set(shared, 11);
    remote.set(shared, 22);

    remote.resetAll();

    expect(local.get(shared)).toBe(11);
    expect(remote.get(shared)).toBeUndefined();
  });

  it("memoizes one scope per environment id", () => {
    expect(threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID)).toBe(localThreadDetailResumeCursors());
    expect(threadDetailResumeCursors(REMOTE_ENVIRONMENT_ID)).not.toBe(
      localThreadDetailResumeCursors(),
    );
  });
});
