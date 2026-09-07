// FILE: threadRuntimeStop.test.ts
// Purpose: Characterizes when the Stop agent process action is offered or blocked.
// Layer: Web helper tests

import { ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  canOfferStopAgentProcess,
  isStopAgentProcessBlockedByActiveTurn,
  stopIdleRuntimeSessionFromClient,
} from "./threadRuntimeStop";

describe("canOfferStopAgentProcess", () => {
  it("offers the action for live ready/running/connecting sessions", () => {
    expect(canOfferStopAgentProcess({ status: "ready" })).toBe(true);
    expect(canOfferStopAgentProcess({ status: "running" })).toBe(true);
    expect(canOfferStopAgentProcess({ status: "connecting" })).toBe(true);
  });

  it("hides the action when there is no live process to stop", () => {
    expect(canOfferStopAgentProcess(null)).toBe(false);
    expect(canOfferStopAgentProcess({ status: "disconnected" })).toBe(false);
    expect(canOfferStopAgentProcess({ status: "closed" })).toBe(false);
    expect(canOfferStopAgentProcess({ status: "error" })).toBe(false);
  });
});

describe("isStopAgentProcessBlockedByActiveTurn", () => {
  it("blocks only while a turn is actively running", () => {
    expect(
      isStopAgentProcessBlockedByActiveTurn({
        status: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(true);
    expect(isStopAgentProcessBlockedByActiveTurn({ status: "ready" })).toBe(false);
    expect(
      isStopAgentProcessBlockedByActiveTurn({
        status: "running",
        activeTurnId: null,
      }),
    ).toBe(false);
  });
});

describe("stopIdleRuntimeSessionFromClient", () => {
  it("forwards the thread id to the provider API", async () => {
    const stopIdleRuntimeSession = vi.fn(async () => undefined);
    const threadId = ThreadId.makeUnsafe("thread-stop-1");

    await stopIdleRuntimeSessionFromClient({ stopIdleRuntimeSession }, threadId);

    expect(stopIdleRuntimeSession).toHaveBeenCalledWith({ threadId });
  });
});
