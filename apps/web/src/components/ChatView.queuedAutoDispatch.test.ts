import { describe, expect, it } from "vitest";

import type { ChatMessage, Thread } from "../types";
import {
  hasLiveTurnTakenOver,
  hasServerAcknowledgedLocalDispatch,
  LOCAL_DISPATCH_TURN_TAKEOVER_TIMEOUT_MS,
  type LocalDispatchSnapshot,
  type QueuedSteerGate,
  shouldHoldQueuedComposerAutoDispatch,
} from "./ChatView.logic";

const localDispatch: LocalDispatchSnapshot = {
  startedAt: "2026-04-13T00:00:00.000Z",
  worktreeSetup: null,
  expectedUserMessageId: "message-for-dispatch" as never,
  latestTurnTurnId: null,
  latestTurnRequestedAt: null,
  latestTurnStartedAt: null,
  latestTurnCompletedAt: null,
  sessionOrchestrationStatus: "ready",
  sessionUpdatedAt: "2026-04-13T00:00:00.000Z",
};

const echoedUserMessage: ChatMessage = {
  id: "message-for-dispatch" as never,
  role: "user",
  text: "queued follow-up A",
  createdAt: "2026-04-13T00:00:01.000Z",
  streaming: false,
};

/** Idle-looking gap after `thread.message-sent` + `thread.turn-start-requested`. */
const gapLatestTurn: Thread["latestTurn"] = {
  turnId: "turn-1" as never,
  state: "running",
  requestedAt: "2026-04-13T00:00:01.000Z",
  startedAt: null,
  completedAt: null,
  assistantMessageId: null,
  sourceProposedPlan: undefined,
};

const gapSession: Thread["session"] = {
  provider: "codex",
  status: "ready",
  orchestrationStatus: "ready",
  createdAt: "2026-04-13T00:00:00.000Z",
  updatedAt: "2026-04-13T00:00:01.000Z",
};

/**
 * Mirrors ChatView's auto-dispatch early-return derivation so this file locks
 * the #774 composition: message echo acks the send, takeover has not happened,
 * remaining queued turns must stay parked.
 */
function resolveQueuedComposerAutoDispatchHold(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: "disconnected" | "connecting" | "ready" | "running";
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  messages: readonly ChatMessage[];
  queuedTurnCount: number;
  isConnecting?: boolean;
  queuedSteerGate?: QueuedSteerGate | null;
  hasPendingApproval?: boolean;
  hasPendingProgress?: boolean;
  hasPendingUserInput?: boolean;
  threadError?: string | null;
  now?: number;
}): boolean {
  const hasPendingApproval = input.hasPendingApproval ?? false;
  const hasPendingUserInput = input.hasPendingUserInput ?? false;
  const isSendBusy =
    input.localDispatch !== null &&
    !hasServerAcknowledgedLocalDispatch({
      localDispatch: input.localDispatch,
      phase: input.phase,
      latestTurn: input.latestTurn,
      session: input.session,
      messages: input.messages,
      hasPendingApproval,
      hasPendingUserInput,
      threadError: input.threadError,
    });
  const turnTakenOver = hasLiveTurnTakenOver({
    localDispatch: input.localDispatch,
    phase: input.phase,
    latestTurn: input.latestTurn,
    session: input.session,
    hasPendingApproval,
    hasPendingUserInput,
    threadError: input.threadError,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const isAwaitingTurnStart = input.localDispatch !== null && !turnTakenOver;
  const hasQueueableLiveTurn = input.phase === "running" && input.session?.activeTurnId != null;
  return shouldHoldQueuedComposerAutoDispatch({
    hasQueueableLiveTurn,
    phase: input.phase,
    isSendBusy,
    isConnecting: input.isConnecting ?? false,
    isAwaitingTurnStart,
    queuedSteerGate: input.queuedSteerGate ?? null,
    hasPendingApproval,
    hasPendingProgress: input.hasPendingProgress ?? false,
    hasPendingUserInput,
    queuedTurnCount: input.queuedTurnCount,
  });
}

describe("shouldHoldQueuedComposerAutoDispatch", () => {
  const idleRelease = {
    hasQueueableLiveTurn: false,
    phase: "ready" as const,
    isSendBusy: false,
    isConnecting: false,
    isAwaitingTurnStart: false,
    queuedSteerGate: null,
    hasPendingApproval: false,
    hasPendingProgress: false,
    hasPendingUserInput: false,
    queuedTurnCount: 1,
  };

  it("releases the queue head when the thread is idle and not awaiting a turn start", () => {
    expect(shouldHoldQueuedComposerAutoDispatch(idleRelease)).toBe(false);
  });

  it("holds through the post-dispatch awaiting-turn gap even when send is no longer busy", () => {
    expect(
      shouldHoldQueuedComposerAutoDispatch({
        ...idleRelease,
        isSendBusy: false,
        isAwaitingTurnStart: true,
      }),
    ).toBe(true);
  });

  it("holds while a live turn is queueable, the steer gate is armed, or the queue is empty", () => {
    expect(
      shouldHoldQueuedComposerAutoDispatch({ ...idleRelease, hasQueueableLiveTurn: true }),
    ).toBe(true);
    expect(
      shouldHoldQueuedComposerAutoDispatch({
        ...idleRelease,
        queuedSteerGate: {
          sawInterruptGap: true,
          gapStartedAt: 1_000,
          armedActiveTurnId: "turn-original",
        },
      }),
    ).toBe(true);
    expect(shouldHoldQueuedComposerAutoDispatch({ ...idleRelease, queuedTurnCount: 0 })).toBe(true);
  });
});

describe("queued composer auto-dispatch gap (#774)", () => {
  it("does not drain remaining queued turns after message-sent / turn-start-requested", () => {
    const now = Date.parse("2026-04-13T00:00:02.000Z");
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: gapLatestTurn,
        session: gapSession,
        messages: [echoedUserMessage],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: gapLatestTurn,
        session: gapSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        now,
      }),
    ).toBe(false);

    expect(
      resolveQueuedComposerAutoDispatchHold({
        localDispatch,
        phase: "ready",
        latestTurn: gapLatestTurn,
        session: gapSession,
        messages: [echoedUserMessage],
        queuedTurnCount: 1,
        now,
      }),
    ).toBe(true);
  });

  it("keeps holding once the dispatched turn is observably live", () => {
    expect(
      resolveQueuedComposerAutoDispatchHold({
        localDispatch,
        phase: "running",
        latestTurn: {
          ...gapLatestTurn,
          startedAt: "2026-04-13T00:00:02.000Z",
        },
        session: {
          ...gapSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: "turn-1" as never,
        },
        messages: [echoedUserMessage],
        queuedTurnCount: 1,
      }),
    ).toBe(true);
  });

  it("releases the next queued turn after the previous one finished and dispatch cleared", () => {
    expect(
      resolveQueuedComposerAutoDispatchHold({
        localDispatch: null,
        phase: "ready",
        latestTurn: {
          ...gapLatestTurn,
          state: "completed",
          startedAt: "2026-04-13T00:00:02.000Z",
          completedAt: "2026-04-13T00:00:10.000Z",
        },
        session: {
          ...gapSession,
          status: "ready",
          orchestrationStatus: "ready",
        },
        messages: [echoedUserMessage],
        queuedTurnCount: 1,
      }),
    ).toBe(false);
  });

  it("fails open after the awaiting-turn timeout so a stuck start cannot wedge the queue", () => {
    const now = Date.parse(localDispatch.startedAt) + LOCAL_DISPATCH_TURN_TAKEOVER_TIMEOUT_MS;
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: gapLatestTurn,
        session: gapSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        now,
      }),
    ).toBe(true);
    expect(
      resolveQueuedComposerAutoDispatchHold({
        localDispatch,
        phase: "ready",
        latestTurn: gapLatestTurn,
        session: gapSession,
        messages: [echoedUserMessage],
        queuedTurnCount: 1,
        now,
      }),
    ).toBe(false);
  });
});
