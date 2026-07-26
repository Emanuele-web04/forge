// FILE: wsTransportEvents.test.ts
// Purpose: Locks down transport-state replay used for projection reconciliation.
// Layer: Web transport utility unit tests

import { describe, expect, it, vi } from "vitest";

import { addWsTransportStateListener, emitWsTransportState } from "./wsTransportEvents";

describe("WebSocket transport state events", () => {
  it("replays an already-open transport to a late reconciliation listener", () => {
    emitWsTransportState("open");
    const listener = vi.fn();

    const unsubscribe = addWsTransportStateListener(listener, { replayCurrent: true });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("open");
    unsubscribe();
  });
});
