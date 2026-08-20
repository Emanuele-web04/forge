import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  doesSnapshotSatisfyTerminalFence,
  isTerminalThreadSessionStatus,
  TERMINAL_FENCE_EMPTY_TURN_HOLD_MS,
} from "./-threadTerminalFence";

describe("isTerminalThreadSessionStatus", () => {
  it.each(["ready", "interrupted", "stopped", "error"] as const)(
    "treats %s as terminal",
    (status) => {
      expect(isTerminalThreadSessionStatus(status)).toBe(true);
    },
  );

  it.each(["running", "starting", "connecting"] as const)("treats %s as non-terminal", (status) => {
    expect(isTerminalThreadSessionStatus(status)).toBe(false);
  });
});

describe("doesSnapshotSatisfyTerminalFence", () => {
  const assistantId = MessageId.makeUnsafe("assistant-1");
  const armedAtMs = 1_000;

  it("rejects a still-running session even when the snapshot advanced past the fence", () => {
    expect(
      doesSnapshotSatisfyTerminalFence({
        snapshotSequence: 10,
        fenceSequence: 5,
        sessionStatus: "running",
        latestTurn: {
          state: "running",
          assistantMessageId: null,
        },
        messages: [],
        armedAtMs,
        nowMs: armedAtMs + 10_000,
      }),
    ).toBe(false);
  });

  it("accepts a terminal snapshot projected after the session-set fence sequence", () => {
    expect(
      doesSnapshotSatisfyTerminalFence({
        snapshotSequence: 6,
        fenceSequence: 5,
        sessionStatus: "ready",
        latestTurn: {
          state: "completed",
          assistantMessageId: assistantId,
        },
        messages: [{ id: assistantId }],
        armedAtMs,
        nowMs: armedAtMs,
      }),
    ).toBe(true);
  });

  it("keeps the fence when the snapshot is still at the session-set sequence without the assistant row", () => {
    expect(
      doesSnapshotSatisfyTerminalFence({
        snapshotSequence: 5,
        fenceSequence: 5,
        sessionStatus: "ready",
        latestTurn: {
          state: "completed",
          assistantMessageId: assistantId,
        },
        messages: [],
        armedAtMs,
        nowMs: armedAtMs + 100,
      }),
    ).toBe(false);
  });

  it("keeps the fence when an unrelated projection advanced but the assistant row is absent", () => {
    expect(
      doesSnapshotSatisfyTerminalFence({
        snapshotSequence: 6,
        fenceSequence: 5,
        sessionStatus: "ready",
        latestTurn: {
          state: "completed",
          assistantMessageId: assistantId,
        },
        messages: [],
        armedAtMs,
        nowMs: armedAtMs + 10_000,
      }),
    ).toBe(false);
  });

  it("keeps a buffered-style completed+null snapshot at the fence sequence before the empty-turn hold", () => {
    expect(
      doesSnapshotSatisfyTerminalFence({
        snapshotSequence: 5,
        fenceSequence: 5,
        sessionStatus: "ready",
        latestTurn: {
          state: "completed",
          assistantMessageId: null,
        },
        messages: [],
        armedAtMs,
        nowMs: armedAtMs + TERMINAL_FENCE_EMPTY_TURN_HOLD_MS - 1,
      }),
    ).toBe(false);
  });

  it("accepts a same-sequence terminal snapshot once the assistant row is present", () => {
    expect(
      doesSnapshotSatisfyTerminalFence({
        snapshotSequence: 5,
        fenceSequence: 5,
        sessionStatus: "ready",
        latestTurn: {
          state: "completed",
          assistantMessageId: assistantId,
        },
        messages: [{ id: assistantId }],
        armedAtMs,
        nowMs: armedAtMs,
      }),
    ).toBe(true);
  });

  it("accepts a same-sequence empty completed turn only after the hold window", () => {
    expect(
      doesSnapshotSatisfyTerminalFence({
        snapshotSequence: 5,
        fenceSequence: 5,
        sessionStatus: "ready",
        latestTurn: {
          state: "completed",
          assistantMessageId: null,
        },
        messages: [],
        armedAtMs,
        nowMs: armedAtMs + TERMINAL_FENCE_EMPTY_TURN_HOLD_MS,
      }),
    ).toBe(true);
  });

  it("accepts interrupted and error turns at the fence sequence immediately", () => {
    expect(
      doesSnapshotSatisfyTerminalFence({
        snapshotSequence: 5,
        fenceSequence: 5,
        sessionStatus: "interrupted",
        latestTurn: {
          state: "interrupted",
          assistantMessageId: assistantId,
        },
        messages: [],
        armedAtMs,
        nowMs: armedAtMs,
      }),
    ).toBe(true);

    expect(
      doesSnapshotSatisfyTerminalFence({
        snapshotSequence: 5,
        fenceSequence: 5,
        sessionStatus: "error",
        latestTurn: {
          state: "error",
          assistantMessageId: null,
        },
        messages: [],
        armedAtMs,
        nowMs: armedAtMs,
      }),
    ).toBe(true);
  });
});
