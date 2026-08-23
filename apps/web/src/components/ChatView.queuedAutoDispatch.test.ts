import { describe, expect, it } from "vitest";

import type { ChatMessage, Thread } from "../types";
import {
  hasLiveTurnTakenOver,
  hasServerAcknowledgedLocalDispatch,
  LOCAL_DISPATCH_TURN_TAKEOVER_TIMEOUT_MS,
  type LocalDispatchSnapshot,
  resolveQueuedComposerAutoDispatchHold,
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

function resolveHold(overrides: {
  localDispatch?: LocalDispatchSnapshot | null;
  phase?: "disconnected" | "connecting" | "ready" | "running";
  latestTurn?: Thread["latestTurn"] | null;
  session?: Thread["session"] | null;
  messages?: readonly ChatMessage[];
  queuedTurnCount?: number;
  now?: number;
}): boolean {
  return resolveQueuedComposerAutoDispatchHold({
    localDispatch: overrides.localDispatch === undefined ? localDispatch : overrides.localDispatch,
    phase: overrides.phase ?? "ready",
    latestTurn: overrides.latestTurn === undefined ? gapLatestTurn : overrides.latestTurn,
    session: overrides.session === undefined ? gapSession : overrides.session,
    messages: overrides.messages ?? [echoedUserMessage],
    isConnecting: false,
    queuedSteerGate: null,
    hasPendingApproval: false,
    hasPendingProgress: false,
    hasPendingUserInput: false,
    queuedTurnCount: overrides.queuedTurnCount ?? 1,
    threadError: null,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
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

describe("resolveQueuedComposerAutoDispatchHold", () => {
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
    expect(resolveHold({ now })).toBe(true);
  });

  it("keeps holding once the dispatched turn is observably live", () => {
    expect(
      resolveHold({
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
      }),
    ).toBe(true);
  });

  it("releases the next queued turn after the previous one finished and dispatch cleared", () => {
    expect(
      resolveHold({
        localDispatch: null,
        latestTurn: {
          ...gapLatestTurn,
          state: "completed",
          startedAt: "2026-04-13T00:00:02.000Z",
          completedAt: "2026-04-13T00:00:10.000Z",
        },
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
    expect(resolveHold({ now })).toBe(false);
  });
});
