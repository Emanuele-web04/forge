import { ApprovalRequestId, MessageId, ThreadId, TurnId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueuedComposerTurn } from "../composerDraftStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeActivity, makeState, makeThread } from "../storeTestFixtures";
import type { Thread, ThreadSession } from "../types";
import {
  armQueuedComposerSteerGate,
  claimQueuedComposerAutoDispatch,
  endQueuedComposerAutoDispatch,
  getQueuedComposerSteerGate,
  isQueuedComposerAwaitingTurnStart,
  releaseQueuedComposerAutoDispatch,
  resetQueuedComposerDrainForTests,
  shouldAutoDispatchQueuedComposerTurn,
  startQueuedComposerDrainWatcher,
  tryBeginQueuedComposerAutoDispatch,
  type QueuedComposerAutoDispatchGates,
} from "./queuedComposerDrain";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const LIVE_TURN_ID = TurnId.makeUnsafe("turn-live");

const OPEN_GATES: QueuedComposerAutoDispatchGates = {
  hasQueueableLiveTurn: false,
  phase: "ready",
  isSendBusy: false,
  isConnecting: false,
  isAwaitingTurnStart: false,
  steerGate: null,
  hasPendingApproval: false,
  hasPendingProgress: false,
  pendingUserInputCount: 0,
  queuedTurnCount: 1,
};

function makeQueuedChatTurn(id: string): QueuedComposerTurn {
  return {
    id,
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: `queued ${id}`,
    prompt: `queued ${id}`,
    images: [],
    files: [],
    assistantSelections: [],
    browserAnnotations: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    skills: [],
    mentions: [],
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
  };
}

function makeSession(status: ThreadSession["status"], activeTurnId?: TurnId): ThreadSession {
  return {
    provider: "codex",
    status,
    orchestrationStatus: status === "running" ? "running" : "ready",
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    ...(activeTurnId ? { activeTurnId } : {}),
  };
}

function seedThread(thread: Thread): void {
  useStore.setState(makeState(thread));
}

async function flushDrain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("shouldAutoDispatchQueuedComposerTurn", () => {
  it("allows drain when the thread is idle with a queued turn", () => {
    expect(shouldAutoDispatchQueuedComposerTurn(OPEN_GATES)).toBe(true);
  });

  it("blocks drain while a live turn still has an active turn id", () => {
    expect(
      shouldAutoDispatchQueuedComposerTurn({
        ...OPEN_GATES,
        hasQueueableLiveTurn: true,
        phase: "running",
      }),
    ).toBe(false);
  });

  it("blocks drain while disconnected, connecting, or send-busy", () => {
    expect(shouldAutoDispatchQueuedComposerTurn({ ...OPEN_GATES, phase: "disconnected" })).toBe(
      false,
    );
    expect(
      shouldAutoDispatchQueuedComposerTurn({
        ...OPEN_GATES,
        phase: "connecting",
        isConnecting: true,
      }),
    ).toBe(false);
    expect(shouldAutoDispatchQueuedComposerTurn({ ...OPEN_GATES, isSendBusy: true })).toBe(false);
  });

  it("blocks drain while a steer gate, approval, or user input is outstanding", () => {
    expect(
      shouldAutoDispatchQueuedComposerTurn({
        ...OPEN_GATES,
        steerGate: {
          sawInterruptGap: false,
          gapStartedAt: null,
          armedActiveTurnId: "turn-original",
        },
      }),
    ).toBe(false);
    expect(shouldAutoDispatchQueuedComposerTurn({ ...OPEN_GATES, hasPendingApproval: true })).toBe(
      false,
    );
    expect(shouldAutoDispatchQueuedComposerTurn({ ...OPEN_GATES, hasPendingProgress: true })).toBe(
      false,
    );
    expect(shouldAutoDispatchQueuedComposerTurn({ ...OPEN_GATES, pendingUserInputCount: 1 })).toBe(
      false,
    );
  });

  it("blocks drain when the queue is empty", () => {
    expect(shouldAutoDispatchQueuedComposerTurn({ ...OPEN_GATES, queuedTurnCount: 0 })).toBe(false);
  });
});

describe("queued composer drain watcher", () => {
  const dispatch = vi.fn(async () => true);

  beforeEach(() => {
    resetQueuedComposerDrainForTests();
    resetComposerDraftStore();
    useStore.setState(initialState);
    dispatch.mockReset();
    dispatch.mockResolvedValue(true);
    startQueuedComposerDrainWatcher({ dispatch });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetQueuedComposerDrainForTests();
    resetComposerDraftStore();
    useStore.setState(initialState);
  });

  it("drains a backgrounded thread when its live turn settles and ChatView is unmounted", async () => {
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("running", LIVE_TURN_ID),
      }),
    );
    useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-1"));

    await flushDrain();
    expect(dispatch).not.toHaveBeenCalled();

    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
      }),
    );

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        dispatchMode: "queue",
        queuedTurn: expect.objectContaining({ id: "queued-1" }),
      }),
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns ?? []).toEqual(
      [],
    );
  });

  it("waits for the dispatched background turn to start before sending the next item", async () => {
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
      }),
    );
    useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-1"));
    useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-2"));

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    await flushDrain();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(isQueuedComposerAwaitingTurnStart(THREAD_ID)).toBe(true);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns.map(({ id }) => id),
    ).toEqual(["queued-2"]);

    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("running", LIVE_TURN_ID),
      }),
    );
    await flushDrain();
    expect(dispatch).toHaveBeenCalledTimes(1);

    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
      }),
    );
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(2);
    });
    expect(dispatch.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        queuedTurn: expect.objectContaining({ id: "queued-2" }),
      }),
    );
  });

  it("bounds retries when background dispatch keeps failing", async () => {
    vi.useFakeTimers();
    dispatch.mockResolvedValue(false);
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
      }),
    );
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-failing"));

    await flushDrain();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await flushDrain();
    expect(dispatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispatch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(dispatch).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushDrain();
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it("does not schedule drain work for unrelated streaming message updates", async () => {
    resetQueuedComposerDrainForTests();
    const now = vi.fn(() => Date.now());
    startQueuedComposerDrainWatcher({ dispatch, now });
    const streamingMessage = {
      id: MessageId.makeUnsafe("assistant-streaming"),
      role: "assistant" as const,
      text: "first chunk",
      createdAt: "2026-02-13T00:00:01.000Z",
      streaming: true,
    };
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("running", LIVE_TURN_ID),
        messages: [streamingMessage],
      }),
    );
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-streaming"));
    await flushDrain();
    expect(dispatch).not.toHaveBeenCalled();
    now.mockClear();

    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("running", LIVE_TURN_ID),
        messages: [{ ...streamingMessage, text: "first chunk, second chunk" }],
      }),
    );
    await flushDrain();

    expect(now).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not drain a claimed thread, then drains after ChatView unmounts", async () => {
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
      }),
    );
    claimQueuedComposerAutoDispatch(THREAD_ID);
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-open"));

    await flushDrain();
    expect(dispatch).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns).toHaveLength(
      1,
    );

    releaseQueuedComposerAutoDispatch(THREAD_ID);

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns ?? []).toEqual(
      [],
    );
  });

  it("does not drain while a live turn still has an active turn id", async () => {
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("running", LIVE_TURN_ID),
      }),
    );
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-live"));

    await flushDrain();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not drain while an approval is pending", async () => {
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
        hasPendingApprovals: true,
        activities: [
          makeActivity({
            id: "approval-requested",
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            payload: {
              requestId: "req-drain-approval",
              lifecycleGeneration: "generation-drain",
              requestKind: "command",
            },
          }),
        ],
        pendingInteractions: [
          {
            interactionKind: "approval",
            requestId: ApprovalRequestId.makeUnsafe("req-drain-approval"),
            threadId: THREAD_ID,
            turnId: null,
            lifecycleGeneration: "generation-drain",
            status: "pending",
            decision: null,
            responseCommandId: null,
            responseRequestedAt: null,
            createdAt: "2026-02-13T00:00:01.000Z",
            resolvedAt: null,
          },
        ],
      }),
    );
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-approval"));

    await flushDrain();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not drain while a steer gate is armed", async () => {
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
      }),
    );
    armQueuedComposerSteerGate(THREAD_ID, {
      sawInterruptGap: false,
      gapStartedAt: null,
      armedActiveTurnId: "turn-original",
    });
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-steer"));

    await flushDrain();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("gives ChatView and the watcher one exclusive per-thread drain lock", () => {
    expect(tryBeginQueuedComposerAutoDispatch(THREAD_ID)).toBe(true);
    expect(tryBeginQueuedComposerAutoDispatch(THREAD_ID)).toBe(false);
    endQueuedComposerAutoDispatch(THREAD_ID);
    expect(tryBeginQueuedComposerAutoDispatch(THREAD_ID)).toBe(true);
    endQueuedComposerAutoDispatch(THREAD_ID);
  });

  it("does not let ChatView send the same queue head the watcher already started", async () => {
    let resolveDispatch: ((value: boolean) => void) | undefined;
    dispatch.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
      }),
    );
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-overlap-focus"));

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    claimQueuedComposerAutoDispatch(THREAD_ID);
    expect(tryBeginQueuedComposerAutoDispatch(THREAD_ID)).toBe(false);

    resolveDispatch?.(true);
    await vi.waitFor(() => {
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns ?? [],
      ).toEqual([]);
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not let the watcher send a queue head ChatView already started after unmount", async () => {
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
      }),
    );
    claimQueuedComposerAutoDispatch(THREAD_ID);
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-overlap-unmount"));
    expect(tryBeginQueuedComposerAutoDispatch(THREAD_ID)).toBe(true);

    releaseQueuedComposerAutoDispatch(THREAD_ID);
    await flushDrain();
    expect(dispatch).not.toHaveBeenCalled();

    endQueuedComposerAutoDispatch(THREAD_ID);
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it("restores the shared steer gate after ChatView unmounts and remounts during the interrupt gap", async () => {
    seedThread(
      makeThread({
        id: THREAD_ID,
        session: makeSession("ready"),
      }),
    );
    const armedGate = {
      sawInterruptGap: false,
      gapStartedAt: null,
      armedActiveTurnId: "turn-original",
    };
    armQueuedComposerSteerGate(THREAD_ID, armedGate);
    useComposerDraftStore
      .getState()
      .enqueueQueuedTurn(THREAD_ID, makeQueuedChatTurn("queued-steer-remount"));

    claimQueuedComposerAutoDispatch(THREAD_ID);
    releaseQueuedComposerAutoDispatch(THREAD_ID);
    await flushDrain();
    expect(dispatch).not.toHaveBeenCalled();

    const restoredGate = getQueuedComposerSteerGate(THREAD_ID);
    expect(restoredGate).not.toBeNull();
    claimQueuedComposerAutoDispatch(THREAD_ID);
    expect(getQueuedComposerSteerGate(THREAD_ID)).toEqual(restoredGate);
    expect(
      shouldAutoDispatchQueuedComposerTurn({
        ...OPEN_GATES,
        steerGate: restoredGate,
      }),
    ).toBe(false);
  });
});
