import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadId, TurnId, WS_STREAM_LIMITS } from "@synara/contracts";
import { useStore } from "./store";
import {
  MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS,
  getRetainedThreadDetailIdsSnapshot,
  isThreadDetailRetained,
  resetRetainedThreadDetailSubscriptionsForTests,
  resolveThreadDetailSubscriptionLeaseIds,
  retainThreadDetailSubscription,
  setVisibleThreadDetailIds,
  subscribeThreadDetailEvictions,
} from "./threadDetailSubscriptionRetention";

describe("threadDetailSubscriptionRetention", () => {
  const initialStoreState = useStore.getState();

  const registerIdleSidebarThread = (threadId: ThreadId) => {
    useStore.setState({
      sidebarThreadSummaryById: {
        ...useStore.getState().sidebarThreadSummaryById,
        [threadId]: {
          id: threadId,
          projectId: "project-1" as never,
          title: "Idle thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          interactionMode: "default",
          envMode: "local",
          branch: null,
          worktreePath: null,
          session: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          latestTurn: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          hasLiveTailWork: false,
        },
      },
    });
  };

  afterEach(() => {
    vi.useRealTimers();
    resetRetainedThreadDetailSubscriptionsForTests();
    useStore.setState(initialStoreState);
  });

  it("retains a thread while any caller still holds a retain handle", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    const releaseOne = retainThreadDetailSubscription(threadId);
    const releaseTwo = retainThreadDetailSubscription(threadId);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    releaseOne();
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    releaseTwo();
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);
  });

  it("makes each retain handle idempotent so one caller cannot release another lease", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-idempotent");
    const releaseOne = retainThreadDetailSubscription(threadId);
    const releaseTwo = retainThreadDetailSubscription(threadId);

    releaseOne();
    releaseOne();
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    releaseTwo();
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("evicts a released thread after the retention timeout", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-2");

    const release = retainThreadDetailSubscription(threadId);
    release();

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("cancels eviction when a thread is retained again before timeout", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-3");

    const firstRelease = retainThreadDetailSubscription(threadId);
    firstRelease();
    vi.advanceTimersByTime(15 * 60 * 1000 - 1);

    const secondRelease = retainThreadDetailSubscription(threadId);
    vi.advanceTimersByTime(1);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    secondRelease();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("does not postpone idle eviction when unrelated store state changes", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-stable-deadline");
    const release = retainThreadDetailSubscription(threadId);
    release();

    vi.advanceTimersByTime(14 * 60 * 1000);
    useStore.setState({ threadsHydrated: !useStore.getState().threadsHydrated });
    vi.advanceTimersByTime(60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("keeps non-idle threads retained past the idle timeout until they settle", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-busy");

    useStore.setState({
      ...useStore.getState(),
      sidebarThreadSummaryById: {
        ...useStore.getState().sidebarThreadSummaryById,
        [threadId]: {
          id: threadId,
          projectId: "project-1" as never,
          title: "Busy thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          interactionMode: "default",
          envMode: "local",
          branch: null,
          worktreePath: null,
          session: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          latestTurn: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          hasLiveTailWork: true,
        },
      },
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);

    useStore.setState({
      ...useStore.getState(),
      sidebarThreadSummaryById: {
        ...useStore.getState().sidebarThreadSummaryById,
        [threadId]: {
          ...useStore.getState().sidebarThreadSummaryById[threadId]!,
          hasLiveTailWork: false,
        },
      },
    });

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
  });

  it("bounds the idle cache size", () => {
    vi.useFakeTimers();

    const releases = Array.from({ length: 40 }, (_, index) =>
      retainThreadDetailSubscription(ThreadId.makeUnsafe(`thread-${index}`)),
    );

    for (const release of releases) {
      release();
    }

    expect(getRetainedThreadDetailIdsSnapshot().length).toBeLessThanOrEqual(
      MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS,
    );
  });

  it("never evicts a visible thread, even when the cache is over capacity", () => {
    const visibleThreadId = ThreadId.makeUnsafe("thread-visible");
    setVisibleThreadDetailIds([visibleThreadId]);

    retainThreadDetailSubscription(visibleThreadId)();
    const releases = Array.from(
      { length: MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS + 10 },
      (_, index) => retainThreadDetailSubscription(ThreadId.makeUnsafe(`thread-idle-${index}`)),
    );
    for (const release of releases) {
      release();
    }

    expect(getRetainedThreadDetailIdsSnapshot()).toContain(visibleThreadId);
  });

  it("evicts released terminal detail without a shell row or sidebar summary", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-subagent-child");
    useStore.setState({
      messageIdsByThreadId: { [threadId]: [] },
      messageByThreadId: { [threadId]: {} },
      threadSessionById: {
        [threadId]: {
          provider: "claudeAgent",
          status: "ready",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          orchestrationStatus: "ready",
        },
      },
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);
    expect(useStore.getState().messageByThreadId?.[threadId]).toBeUndefined();
  });

  it("keeps a released hidden subagent while its normalized turn is still running", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-running-subagent-child");
    useStore.setState({
      messageIdsByThreadId: { [threadId]: [] },
      messageByThreadId: { [threadId]: {} },
      threadSessionById: {
        [threadId]: {
          provider: "claudeAgent",
          status: "running",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          orchestrationStatus: "running",
        },
      },
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([threadId]);
    expect(useStore.getState().messageByThreadId?.[threadId]).toBeDefined();
  });

  it("bounds released hidden terminal subagent detail", () => {
    const releases = Array.from(
      { length: MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS + 10 },
      (_, index) => {
        const threadId = ThreadId.makeUnsafe(`thread-terminal-subagent-${index}`);
        useStore.setState({
          messageIdsByThreadId: {
            ...useStore.getState().messageIdsByThreadId,
            [threadId]: [],
          },
          messageByThreadId: {
            ...useStore.getState().messageByThreadId,
            [threadId]: {},
          },
          threadSessionById: {
            ...useStore.getState().threadSessionById,
            [threadId]: {
              provider: "claudeAgent",
              status: "ready",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:01:00.000Z",
              orchestrationStatus: "ready",
            },
          },
        });
        return retainThreadDetailSubscription(threadId);
      },
    );

    for (const release of releases) {
      release();
    }

    expect(getRetainedThreadDetailIdsSnapshot().length).toBeLessThanOrEqual(
      MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS,
    );
  });

  it("prioritizes visible leases and stays within connection admission", () => {
    const visible = [ThreadId.makeUnsafe("visible-1"), ThreadId.makeUnsafe("visible-2")];
    const retained = Array.from({ length: WS_STREAM_LIMITS.threadPerClient }, (_, index) =>
      ThreadId.makeUnsafe(`retained-${index}`),
    );

    expect(
      resolveThreadDetailSubscriptionLeaseIds({
        visibleThreadIds: visible,
        retainedThreadIds: retained,
        serverThreadIds: new Set(retained),
      }),
    ).toEqual([
      ...visible,
      ...retained.slice(0, WS_STREAM_LIMITS.threadPerClient - visible.length),
    ]);
  });

  it("notifies eviction subscribers so lease owners can refresh wiped detail", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-eviction-listener");
    const listener = vi.fn();
    const unsubscribe = subscribeThreadDetailEvictions(listener);

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(listener).toHaveBeenCalledWith(threadId);

    unsubscribe();
    const secondThreadId = ThreadId.makeUnsafe("thread-eviction-listener-2");
    const releaseSecond = retainThreadDetailSubscription(secondThreadId);
    releaseSecond();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("releases normalized detail when an idle lease is evicted", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-detail-eviction");
    registerIdleSidebarThread(threadId);
    useStore.setState({
      messageIdsByThreadId: { [threadId]: [] },
      messageByThreadId: { [threadId]: {} },
      activityIdsByThreadId: { [threadId]: [] },
      activityByThreadId: { [threadId]: {} },
    });

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);

    const state = useStore.getState();
    expect(state.messageIdsByThreadId?.[threadId]).toBeUndefined();
    expect(state.messageByThreadId?.[threadId]).toBeUndefined();
    expect(state.activityIdsByThreadId?.[threadId]).toBeUndefined();
    expect(state.activityByThreadId?.[threadId]).toBeUndefined();
  });

  it("reports retention ownership so lease owners can free detail nothing owns", () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-ownership");

    const release = retainThreadDetailSubscription(threadId);
    expect(isThreadDetailRetained(threadId)).toBe(true);

    release();
    expect(isThreadDetailRetained(threadId)).toBe(true);

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(isThreadDetailRetained(threadId)).toBe(false);
  });

  it("stops owning an evicted thread whose detail a raced snapshot restored", () => {
    // Regression: eviction wipes detail and notifies lease owners, which refresh the
    // thread. When that snapshot lands before the lease drops, the restored slices
    // belong to no retention entry — and eviction only ever runs from a retention
    // entry, so the lease owner must be able to see that nothing owns them.
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-raced-snapshot");

    const release = retainThreadDetailSubscription(threadId);
    release();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(getRetainedThreadDetailIdsSnapshot()).toEqual([]);

    // The refreshed snapshot lands and repopulates the store.
    useStore.setState({
      messageIdsByThreadId: { [threadId]: [] },
      messageByThreadId: { [threadId]: {} },
    });

    expect(isThreadDetailRetained(threadId)).toBe(false);
    expect(useStore.getState().messageByThreadId?.[threadId]).toBeDefined();

    // The lease owner evicts on lease drop precisely because retention disclaims it.
    useStore.getState().evictThreadDetail(threadId);
    expect(useStore.getState().messageByThreadId?.[threadId]).toBeUndefined();
  });
});
