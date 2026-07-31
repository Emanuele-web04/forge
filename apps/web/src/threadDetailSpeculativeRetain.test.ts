// FILE: threadDetailSpeculativeRetain.test.ts
// Purpose: Verifies speculative retains fall with the resume cursors that justified them.
// Layer: Web subscription utility test

import { EnvironmentId, ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createThreadDetailPrewarmController } from "./threadDetailPrewarm";
import {
  localThreadDetailResumeCursors,
  resetThreadDetailResumeCursorsForTests,
  threadDetailResumeCursors,
} from "./threadDetailResumeCursors";
import { retainSpeculativeThreadDetail } from "./threadDetailSpeculativeRetain";
import {
  getRetainedThreadDetailIdsSnapshot,
  resetRetainedThreadDetailSubscriptionsForTests,
  resolveThreadDetailSubscriptionLeaseIds,
  retainThreadDetailSubscription,
} from "./threadDetailSubscriptionRetention";

function threadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

function makeRetainSpy() {
  const retainedThreadIds: ThreadId[] = [];
  const releasedThreadIds: ThreadId[] = [];
  const retainThreadDetailSubscription = vi.fn((id: ThreadId) => {
    retainedThreadIds.push(id);
    return () => {
      releasedThreadIds.push(id);
    };
  });
  return { retainThreadDetailSubscription, retainedThreadIds, releasedThreadIds };
}

describe("speculative thread detail retain", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetThreadDetailResumeCursorsForTests();
    resetRetainedThreadDetailSubscriptionsForTests();
  });

  it("opens no full-snapshot lease per prewarmed thread after a server-generation change", () => {
    const prewarmed = [threadId("a"), threadId("b"), threadId("c")];
    for (const thread of prewarmed) {
      localThreadDetailResumeCursors().set(thread, 5);
      retainSpeculativeThreadDetail(thread);
    }

    expect(
      resolveThreadDetailSubscriptionLeaseIds({
        visibleThreadIds: [],
        retainedThreadIds: getRetainedThreadDetailIdsSnapshot(),
        serverThreadIds: new Set(prewarmed),
      }),
    ).toEqual(prewarmed);

    // The transport observes a new server instance and drops every cursor.
    localThreadDetailResumeCursors().resetAll();

    // A reconnect rebuilds every lease's input from the cursor state, so any
    // lease surviving here would be resubscribed as a full-history snapshot
    // stream — one per prewarmed thread, the exact burst the gate prevents.
    const leased = resolveThreadDetailSubscriptionLeaseIds({
      visibleThreadIds: [],
      retainedThreadIds: getRetainedThreadDetailIdsSnapshot(),
      serverThreadIds: new Set(prewarmed),
    });
    expect(leased).toHaveLength(0);
    expect(
      leased.filter(
        (id) =>
          localThreadDetailResumeCursors().buildSubscribeInput(id).afterSequence === undefined,
      ),
    ).toHaveLength(0);
  });

  it("keeps leasing a thread something is actually rendering after the cursors reset", () => {
    const thread = threadId("open");
    localThreadDetailResumeCursors().set(thread, 5);
    retainSpeculativeThreadDetail(thread);
    // A real (non-speculative) holder: the open chat view.
    retainThreadDetailSubscription(thread);

    localThreadDetailResumeCursors().resetAll();

    // This one must still be leased — it will take a full snapshot, which is
    // correct: the user is looking at it.
    expect(
      resolveThreadDetailSubscriptionLeaseIds({
        visibleThreadIds: [],
        retainedThreadIds: getRetainedThreadDetailIdsSnapshot(),
        serverThreadIds: new Set([thread]),
      }),
    ).toEqual([thread]);
  });

  it("refuses a thread with no resume cursor", () => {
    const retain = makeRetainSpy();

    expect(
      retainSpeculativeThreadDetail(threadId("cold"), {
        retainThreadDetailSubscription: retain.retainThreadDetailSubscription,
      }),
    ).toBeNull();
    expect(retain.retainedThreadIds).toEqual([]);
  });

  it("keeps a retain when a different environment's server restarts", () => {
    const retain = makeRetainSpy();
    const thread = threadId("warm");
    localThreadDetailResumeCursors().set(thread, 12);

    retainSpeculativeThreadDetail(thread, {
      retainThreadDetailSubscription: retain.retainThreadDetailSubscription,
    });
    expect(retain.retainedThreadIds).toEqual([thread]);

    // Sequences are per-server, so a remote environment's journal changing says
    // nothing about this one's. Releasing here would throw away resume state
    // that is still valid — hence per-environment reset listeners, not global.
    threadDetailResumeCursors(EnvironmentId.makeUnsafe("remote")).resetAll();

    expect(retain.releasedThreadIds).toEqual([]);
  });

  it("gives the retain back when a server-generation change resets the cursors", () => {
    const retain = makeRetainSpy();
    const thread = threadId("warm");
    localThreadDetailResumeCursors().set(thread, 12);

    const release = retainSpeculativeThreadDetail(thread, {
      retainThreadDetailSubscription: retain.retainThreadDetailSubscription,
    });

    expect(release).not.toBeNull();
    expect(retain.retainedThreadIds).toEqual([thread]);
    expect(retain.releasedThreadIds).toEqual([]);

    localThreadDetailResumeCursors().resetAll();

    expect(retain.releasedThreadIds).toEqual([thread]);
    // The caller's own release must stay safe to call and must not double-release.
    release?.();
    expect(retain.releasedThreadIds).toEqual([thread]);
  });

  it("opens no full-snapshot stream for prewarmed threads after a server-generation change", () => {
    vi.useFakeTimers();
    const retain = makeRetainSpy();
    const prewarmed = [threadId("a"), threadId("b"), threadId("c")];
    for (const thread of prewarmed) {
      localThreadDetailResumeCursors().set(thread, 20);
    }

    const controller = createThreadDetailPrewarmController({
      retainThreadDetailSubscription: retain.retainThreadDetailSubscription,
    });
    controller.prewarmThreadDetails(prewarmed);
    expect(retain.retainedThreadIds).toEqual(prewarmed);

    // The transport observes a new server instance and drops every cursor.
    localThreadDetailResumeCursors().resetAll();

    // Whatever the transport re-subscribes now must not include a speculative
    // thread: each of those would be a cursorless (full-snapshot) stream, and
    // one per prewarmed thread is precisely the reconnect burst the eligibility
    // gate exists to prevent.
    const stillRetained = retain.retainedThreadIds.filter(
      (id) => !retain.releasedThreadIds.includes(id),
    );
    const fullSnapshotSubscribes = stillRetained.filter(
      (id) => localThreadDetailResumeCursors().buildSubscribeInput(id).afterSequence === undefined,
    );
    expect(fullSnapshotSubscribes).toHaveLength(0);
    expect(stillRetained).toHaveLength(0);

    controller.dispose();
  });

  it("re-checks eligibility instead of trusting the retain a reset already took back", () => {
    vi.useFakeTimers();
    const retain = makeRetainSpy();
    const thread = threadId("a");
    localThreadDetailResumeCursors().set(thread, 20);

    const controller = createThreadDetailPrewarmController({
      retainThreadDetailSubscription: retain.retainThreadDetailSubscription,
    });
    controller.prewarmThreadDetails([thread]);
    localThreadDetailResumeCursors().resetAll();

    // Same list, next render: the thread is cold now, so eligibility must be
    // re-checked rather than inferred from the lease the reset already dropped,
    // and the controller must end up holding nothing.
    controller.prewarmThreadDetails([thread]);
    const stillLive = retain.retainedThreadIds.filter(
      (id) => !retain.releasedThreadIds.includes(id),
    );
    expect(stillLive).toHaveLength(0);

    controller.dispose();
  });
});
