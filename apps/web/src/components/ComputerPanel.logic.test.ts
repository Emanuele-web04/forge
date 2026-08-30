import type {
  ComputerFrameHeader,
  ComputerHealth,
  ThreadComputerState,
  ThreadId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  COMPUTER_SCROLL_DELTA_LIMIT,
  computerContainRect,
  computerCursorPosition,
  computerKeyCommand,
  computerStreamRegion,
  computerViewportPointToDesktop,
  computerWheelScrollDelta,
  createComputerFrameGateState,
  resolveComputerAvailabilityView,
  resolveComputerHealthBadge,
  shouldSubscribeToComputerStream,
  stepComputerFrameGate,
} from "./ComputerPanel.logic";

const COMPUTER_ID = "desktop";

function header(sequence: number, computerId = COMPUTER_ID): ComputerFrameHeader {
  return {
    computerId,
    sequence,
    timestampMs: 1,
    keyframe: true,
    codecConfig: false,
  };
}

function state(overrides: Partial<ThreadComputerState> = {}): ThreadComputerState {
  return {
    threadId: "thread-1" as ThreadId,
    version: 1,
    computerId: COMPUTER_ID,
    capabilities: {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      activation: true,
      ghostCursor: true,
      visibleDesktop: true,
    },
    windows: [],
    screenSize: { width: 5120, height: 2520 },
    agentActive: false,
    controlledByOtherThread: false,
    availability: { kind: "available" },
    health: connectedHealth(),
    lastError: null,
    ...overrides,
  };
}

function connectedHealth(): ComputerHealth {
  return { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true };
}

describe("computer frame gate", () => {
  it("accepts the first frame and rejects frames for another computer", () => {
    const initial = createComputerFrameGateState();
    const wrong = stepComputerFrameGate(initial, header(1, "other"), COMPUTER_ID);
    expect(wrong.action).toBe("ignore");
    expect(wrong.state).toEqual(initial);

    const first = stepComputerFrameGate(initial, header(7), COMPUTER_ID);
    expect(first.action).toBe("decode");
    expect(first.requestResync).toBe(false);
    expect(first.state.lastSequence).toBe(7);
  });

  it("drops duplicates and stale sequence numbers", () => {
    const current = stepComputerFrameGate(createComputerFrameGateState(), header(10), COMPUTER_ID);
    const duplicate = stepComputerFrameGate(current.state, header(10), COMPUTER_ID);
    const stale = stepComputerFrameGate(current.state, header(9), COMPUTER_ID);

    expect(duplicate.action).toBe("drop-stale");
    expect(stale.action).toBe("drop-stale");
    expect(duplicate.requestResync).toBe(false);
    expect(stale.requestResync).toBe(false);
  });

  it("accepts standalone frames after a gap and asks the source to resync", () => {
    const current = stepComputerFrameGate(createComputerFrameGateState(), header(10), COMPUTER_ID);
    const next = stepComputerFrameGate(current.state, header(13), COMPUTER_ID);

    expect(next.action).toBe("decode");
    expect(next.requestResync).toBe(true);
    expect(next.state.lastSequence).toBe(13);
  });

  it("handles uint32 sequence wraparound", () => {
    const current = stepComputerFrameGate(
      createComputerFrameGateState(),
      header(0xffff_fffe),
      COMPUTER_ID,
    );
    const wrapped = stepComputerFrameGate(current.state, header(1), COMPUTER_ID);

    expect(wrapped.action).toBe("decode");
    expect(wrapped.requestResync).toBe(true);
  });
});

describe("computer panel state helpers", () => {
  it("maps availability into ready, checking, and blocked views", () => {
    expect(resolveComputerAvailabilityView(undefined).kind).toBe("checking");
    expect(resolveComputerAvailabilityView({ kind: "available" }).kind).toBe("ready");
    expect(
      resolveComputerAvailabilityView({ kind: "backend-unavailable", message: "Backend is off" }),
    ).toMatchObject({ kind: "blocked", description: "Backend is off" });
  });

  it("shows a reconnecting backend as checking rather than blocked", () => {
    expect(
      resolveComputerAvailabilityView(
        { kind: "backend-unavailable", message: "Reconnecting to the desktop. Last failure: boom" },
        {
          ...connectedHealth(),
          status: "reconnecting",
          consecutiveFailures: 2,
          lastFailure: { message: "boom", at: "2026-08-16T10:00:00.000Z" },
        },
      ),
    ).toMatchObject({ kind: "checking", description: "boom" });
  });

  it("badges a degraded backend and stays silent while it is connected", () => {
    expect(resolveComputerHealthBadge(connectedHealth())).toBeNull();
    expect(resolveComputerHealthBadge(undefined)).toBeNull();

    const reconnecting = resolveComputerHealthBadge({
      ...connectedHealth(),
      status: "reconnecting",
      consecutiveFailures: 3,
      reconnects: 1,
      captureAvailable: false,
      lastFailure: { message: "The backend vanished", at: "2026-08-16T10:00:00.000Z" },
    });
    expect(reconnecting).toMatchObject({
      label: "Reconnecting to desktop",
      tone: "warning",
      pulse: true,
    });
    expect(reconnecting?.title).toContain("The backend vanished");
    expect(reconnecting?.title).toContain("3");
    expect(reconnecting?.title).toContain("Reconnects since startup: 1.");

    // Non-connected with a clean record is the lazy backend that has simply
    // never been engaged — the server no longer connects at boot — and must
    // not flash "unavailable" at every pane open on a healthy desktop.
    expect(resolveComputerHealthBadge({ ...connectedHealth(), status: "unavailable" })).toBeNull();
    expect(
      resolveComputerHealthBadge({
        ...connectedHealth(),
        status: "unavailable",
        consecutiveFailures: 1,
        lastFailure: { message: "plugin load refused", at: "2026-08-20T10:00:00.000Z" },
      }),
    ).toMatchObject({ label: "Desktop unavailable", tone: "danger", pulse: false });
  });

  it("subscribes only for a visible live available thread", () => {
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "live",
        isVisible: true,
        threadState: state(),
      }),
    ).toBe(true);
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "preview",
        isVisible: true,
        threadState: state(),
      }),
    ).toBe(false);
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "live",
        isVisible: true,
        threadState: state({ availability: { kind: "backend-unavailable", message: "off" } }),
      }),
    ).toBe(false);
  });

  it("contains a multi-monitor desktop and maps the agent cursor", () => {
    const rect = computerContainRect({
      source: { width: 5120, height: 2520 },
      containerWidth: 800,
      containerHeight: 500,
    });
    expect(rect).toEqual({ left: 0, top: 53.125, width: 800, height: 393.75 });
    expect(
      computerCursorPosition({
        cursor: { x: 2560, y: 1260 },
        screenSize: { width: 5120, height: 2520 },
        containRect: rect,
      }),
    ).toEqual({ left: 400, top: 250 });
  });
});

describe("computer pane pointer mapping", () => {
  const screenSize = { width: 1_920, height: 1_080 };
  const paneRect = computerContainRect({
    source: screenSize,
    containerWidth: 800,
    containerHeight: 600,
  });

  function toDesktop(x: number, y: number) {
    return computerViewportPointToDesktop({
      pointer: { x, y },
      containRect: paneRect,
      region: computerStreamRegion(screenSize),
    });
  }

  it("derives the streamed region from the screen size and passes an explicit one through", () => {
    expect(computerStreamRegion(screenSize)).toEqual({ x: 0, y: 0, width: 1_920, height: 1_080 });
    expect(computerStreamRegion(undefined)).toBeNull();
    const region = { x: 1_920, y: 0, width: 1_920, height: 1_080 };
    expect(computerStreamRegion(screenSize, region)).toBe(region);
  });

  it("maps pane pixels to desktop pixels across the letterboxed image", () => {
    // 800x600 pane, 16:9 desktop: the image is 800x450 with 75px bars.
    expect(paneRect).toEqual({ left: 0, top: 75, width: 800, height: 450 });
    expect(toDesktop(0, 75)).toEqual({ x: 0, y: 0 });
    expect(toDesktop(400, 300)).toEqual({ x: 960, y: 540 });
    // The far edge lands on the last pixel, never one past the screen.
    expect(toDesktop(800, 525)).toEqual({ x: 1_919, y: 1_079 });
  });

  it("ignores the letterbox padding on either side of the image", () => {
    expect(toDesktop(400, 74)).toBeNull();
    expect(toDesktop(400, 526)).toBeNull();
    expect(toDesktop(-1, 300)).toBeNull();
    expect(toDesktop(801, 300)).toBeNull();
  });

  it("applies a region offset and rounds to whole desktop pixels", () => {
    const region = { x: 1_920, y: 0, width: 1_920, height: 1_080 };
    const containRect = { left: 10, top: 20, width: 480, height: 270 };

    expect(
      computerViewportPointToDesktop({ pointer: { x: 250, y: 155 }, containRect, region }),
    ).toEqual({ x: 2_880, y: 540 });
    // Four desktop pixels per pane pixel: sub-pixel offsets round, not truncate.
    expect(
      computerViewportPointToDesktop({ pointer: { x: 10.6, y: 20.2 }, containRect, region }),
    ).toEqual({ x: 1_922, y: 1 });
  });

  it("maps nothing without geometry", () => {
    const region = computerStreamRegion(screenSize);
    expect(
      computerViewportPointToDesktop({ pointer: { x: 1, y: 1 }, containRect: null, region }),
    ).toBeNull();
    expect(
      computerViewportPointToDesktop({
        pointer: { x: 1, y: 1 },
        containRect: paneRect,
        region: null,
      }),
    ).toBeNull();
    expect(
      computerViewportPointToDesktop({
        pointer: { x: Number.NaN, y: 1 },
        containRect: paneRect,
        region,
      }),
    ).toBeNull();
  });
});

describe("computer pane wheel and key mapping", () => {
  it("converts wheel deltas to pixels and clamps a runaway burst", () => {
    expect(computerWheelScrollDelta({ deltaX: -12, deltaY: 48, deltaMode: 0 })).toEqual({
      deltaX: -12,
      deltaY: 48,
    });
    expect(computerWheelScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({
      deltaX: 0,
      deltaY: 48,
    });
    expect(computerWheelScrollDelta({ deltaX: 0, deltaY: -2, deltaMode: 2 })).toEqual({
      deltaX: 0,
      deltaY: -800,
    });
    expect(computerWheelScrollDelta({ deltaX: 1e9, deltaY: -1e9, deltaMode: 0 })).toEqual({
      deltaX: COMPUTER_SCROLL_DELTA_LIMIT,
      deltaY: -COMPUTER_SCROLL_DELTA_LIMIT,
    });
    expect(computerWheelScrollDelta({ deltaX: Number.NaN, deltaY: 0, deltaMode: 0 })).toEqual({
      deltaX: 0,
      deltaY: 0,
    });
  });

  it("translates keydowns into backend key presses", () => {
    expect(keyEvent("a")).toEqual({ key: "a", modifiers: [] });
    expect(keyEvent(" ")).toEqual({ key: "space", modifiers: [] });
    expect(keyEvent("ArrowLeft")).toEqual({ key: "arrowleft", modifiers: [] });
    expect(keyEvent("F5")).toEqual({ key: "f5", modifiers: [] });
    // A printable character carries its own shift state.
    expect(keyEvent("A", { shiftKey: true })).toEqual({ key: "A", modifiers: [] });
    expect(keyEvent("c", { ctrlKey: true })).toEqual({ key: "c", modifiers: ["ctrl"] });
    expect(keyEvent("Tab", { shiftKey: true })).toEqual({ key: "tab", modifiers: ["shift"] });
    expect(keyEvent("Tab", { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })).toEqual(
      { key: "tab", modifiers: ["ctrl", "alt", "shift", "meta"] },
    );
  });

  it("leaves keys the seat cannot express to the browser", () => {
    expect(keyEvent("Shift", { shiftKey: true })).toBeNull();
    expect(keyEvent("Control", { ctrlKey: true })).toBeNull();
    expect(keyEvent("Dead")).toBeNull();
    expect(keyEvent("Unidentified")).toBeNull();
    expect(keyEvent("é")).toBeNull();
    expect(keyEvent("F13")).toBeNull();
  });
});

function keyEvent(
  key: string,
  modifiers: {
    readonly ctrlKey?: boolean;
    readonly altKey?: boolean;
    readonly shiftKey?: boolean;
    readonly metaKey?: boolean;
  } = {},
) {
  return computerKeyCommand({
    key,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    metaKey: modifiers.metaKey ?? false,
  });
}
