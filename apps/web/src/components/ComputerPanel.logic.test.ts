import {
  COMPUTER_INPUT_SCROLL_LIMIT,
  type ComputerFrameHeader,
  type ComputerHealth,
  type ThreadComputerState,
  type ThreadId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  computerActionLabel,
  computerBackendIsVisibleDesktop,
  computerCanvasLabel,
  computerContainRect,
  computerControlReadiness,
  computerDeliveryWarning,
  computerPaneInputMode,
  computerStatusNeedsSetup,
  computerStopControlLabel,
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
      focus: true,
      raise: true,
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

  it("names the withheld grants in the blocked title", () => {
    // The settings panel and the pane both title themselves from this, and
    // "Computer control is unavailable" is the one thing a user with a missing
    // grant cannot act on — the switch has a name, so the title uses it.
    const view = resolveComputerAvailabilityView({
      kind: "permission-required",
      missing: ["accessibility", "screenRecording"],
      message: "Synara needs Accessibility and Screen Recording to control this Mac.",
      buildSignature: "signed",
    });
    expect(view.kind).toBe("blocked");
    expect(view.title).toBe("Computer control needs Accessibility and Screen Recording");
    expect(view.description).toContain("Screen Recording");
  });

  it("does not call an installed but unprobed helper ready", () => {
    expect(
      resolveComputerAvailabilityView(
        { kind: "available", backend: "mac" },
        { ...connectedHealth(), status: "unavailable", captureAvailable: false },
      ),
    ).toMatchObject({ kind: "checking", title: "Computer access has not been checked" });
  });

  it("does not claim full desktop readiness when capture is denied", () => {
    expect(
      resolveComputerAvailabilityView(
        { kind: "available", backend: "mac" },
        { ...connectedHealth(), captureAvailable: false },
      ),
    ).toMatchObject({ kind: "blocked", title: "Screen capture is unavailable" });
  });

  it("keeps the pre-availability and unsupported copy platform-neutral", () => {
    // macOS reaches both of these, so neither may name Linux alone.
    const checking = resolveComputerAvailabilityView(undefined);
    expect(checking.description).not.toContain("Linux");
    const unsupported = resolveComputerAvailabilityView({
      kind: "unsupported-platform",
      platform: "win32",
    });
    expect(unsupported.kind).toBe("blocked");
    expect(unsupported.description).toContain("win32");
    expect(unsupported.description).toContain("macOS");
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
    expect(reconnecting?.title).toContain("Reconnected once since startup.");

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
      deltaX: COMPUTER_INPUT_SCROLL_LIMIT,
      deltaY: -COMPUTER_INPUT_SCROLL_LIMIT,
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

describe("computerStatusNeedsSetup", () => {
  it("says no when there is no state yet, so no surface offers Set up on a guess", () => {
    expect(computerStatusNeedsSetup(undefined)).toBe(false);
  });

  it("says no on a host that could never have a desktop backend", () => {
    // "Set up" on Windows would install nothing and explain nothing; the
    // unsupported-platform message is the whole answer.
    expect(
      computerStatusNeedsSetup(
        state({ availability: { kind: "unsupported-platform", platform: "win32" } }),
      ),
    ).toBe(false);
  });

  it("says no on a ready desktop", () => {
    expect(computerStatusNeedsSetup(state())).toBe(false);
  });

  it("says yes on a withheld grant and on a backend that is not there", () => {
    expect(
      computerStatusNeedsSetup(
        state({
          availability: {
            kind: "permission-required",
            missing: ["screenRecording"],
            message: "needs Screen Recording",
            buildSignature: "adhoc",
          },
        }),
      ),
    ).toBe(true);
    expect(
      computerStatusNeedsSetup(
        state({ availability: { kind: "backend-unavailable", message: "no helper" } }),
      ),
    ).toBe(true);
  });

  it("says yes when the desktop is driveable but blind", () => {
    // captureAvailable is live health, not a capability: a Mac with
    // Accessibility but no Screen Recording answers "available" and still
    // cannot take a frame, and Set up is exactly what fixes it.
    expect(
      computerStatusNeedsSetup(
        state({ health: { ...connectedHealth(), captureAvailable: false } }),
      ),
    ).toBe(true);
  });

  it("says yes when the backend has not been provisioned into existence yet", () => {
    // The nested backend reports the empty capability set until its compositor
    // and plugin exist, which is what routes a first-time user to Set up.
    expect(
      computerStatusNeedsSetup(
        state({
          capabilities: { ...state().capabilities, input: false, capture: false },
        }),
      ),
    ).toBe(true);
  });
});

describe("computerControlReadiness", () => {
  it("is unknown until live state arrives, so the card offers Set up rather than claiming ready", () => {
    // The bug this replaces: a boolean latched inside the provision callback and
    // never cleared, so every later card in the conversation said "ready".
    expect(computerControlReadiness(undefined)).toBe("unknown");
  });

  it("reads ready and needs-setup off the same live state the desktop reports", () => {
    expect(computerControlReadiness(state())).toBe("ready");
    expect(
      computerControlReadiness(
        state({
          availability: {
            kind: "permission-required",
            missing: ["accessibility"],
            message: "needs Accessibility",
            buildSignature: "adhoc",
          },
        }),
      ),
    ).toBe("needs-setup");
  });

  it("flips to ready with nothing pressed once the grant lands", () => {
    // The expected path: the user allows the macOS dialog and touches nothing in
    // Synara. Only a derived answer can notice that.
    const blocked = state({
      availability: {
        kind: "permission-required",
        missing: ["accessibility"],
        message: "needs Accessibility",
        buildSignature: "adhoc",
      },
    });
    expect(computerControlReadiness(blocked)).toBe("needs-setup");
    expect(computerControlReadiness({ ...blocked, availability: { kind: "available" } })).toBe(
      "ready",
    );
  });

  it("stays needs-setup when the desktop can be driven but not seen", () => {
    // Screen Recording alone blocks nothing, so availability stays `available` —
    // and the card must still offer the fix.
    expect(
      computerControlReadiness(
        state({ health: { ...connectedHealth(), captureAvailable: false } }),
      ),
    ).toBe("needs-setup");
  });

  it("asks the same question of a thread state and a server status", () => {
    // One rule, two shapes: the chat reads pushed thread state, the settings
    // panel reads polled status, and a second copy of this test is how they
    // would start disagreeing.
    const threadState = state();
    expect(computerStatusNeedsSetup(threadState)).toBe(false);
    expect(
      computerStatusNeedsSetup({
        availability: threadState.availability,
        health: threadState.health,
        capabilities: threadState.capabilities,
      }),
    ).toBe(false);
  });
});

describe("computerPaneInputMode", () => {
  it("hides interactive mode entirely on a desktop the user is already sitting at", () => {
    // The pane mirrors the real screen there — including a picture of Synara —
    // so clicking it is a slower way to reach what the user's own mouse can.
    expect(
      computerPaneInputMode({ streamEnabled: true, visibleDesktop: true, agentActive: false }),
    ).toBe("hidden");
  });

  it("blocks input while the agent is acting, rather than interleaving on one seat", () => {
    expect(
      computerPaneInputMode({ streamEnabled: true, visibleDesktop: false, agentActive: true }),
    ).toBe("blocked-by-agent");
  });

  it("allows input on an idle agent desktop that is actually streaming", () => {
    expect(
      computerPaneInputMode({ streamEnabled: true, visibleDesktop: false, agentActive: false }),
    ).toBe("available");
    expect(
      computerPaneInputMode({ streamEnabled: false, visibleDesktop: false, agentActive: false }),
    ).toBe("hidden");
  });
});

describe("computerStopControlLabel", () => {
  it("offers a stop only while an agent is acting", () => {
    expect(computerStopControlLabel({ agentActive: false, visibleDesktop: true })).toBeNull();
  });

  it("says which machine is being stopped", () => {
    // On a visible desktop this is the only stop there is: macOS registers no
    // compositor release hotkey, so `computerReleaseControlHint` is null there.
    expect(computerStopControlLabel({ agentActive: true, visibleDesktop: true })).toContain(
      "this computer",
    );
    expect(computerStopControlLabel({ agentActive: true, visibleDesktop: false })).toContain(
      "the desktop",
    );
  });
});

describe("computerCanvasLabel", () => {
  it("names the backend it is actually a picture of", () => {
    // It said "Linux desktop" on every backend, macOS included — and whether the
    // agent is driving a sandbox or the user's own machine is the single most
    // important fact about this surface.
    expect(
      computerCanvasLabel({
        availability: { kind: "available", backend: "mac" },
        visibleDesktop: true,
      }),
    ).toBe("This Mac's desktop");
    expect(
      computerCanvasLabel({
        availability: { kind: "available", backend: "nested-kwin" },
        visibleDesktop: false,
      }),
    ).toBe("The agent's own desktop");
    expect(
      computerCanvasLabel({
        availability: { kind: "available", backend: "kwin" },
        visibleDesktop: true,
      }),
    ).toBe("This computer's desktop");
    expect(computerCanvasLabel({ availability: undefined, visibleDesktop: false })).toBe(
      "The agent's desktop",
    );
  });
});

describe("computerDeliveryWarning", () => {
  it("speaks up only for the verdict a person must act on", () => {
    // `unverifiable` is the ordinary answer for most native controls; reporting
    // it would train the user to ignore the row.
    expect(
      computerDeliveryWarning({ delivery: { path: "pid", verified: "unconfirmed" } }),
    ).toContain("could not confirm");
    expect(
      computerDeliveryWarning({ delivery: { path: "pid", verified: "unverifiable" } }),
    ).toBeNull();
    expect(
      computerDeliveryWarning({ delivery: { path: "pid", verified: "confirmed" } }),
    ).toBeNull();
    expect(computerDeliveryWarning(undefined)).toBeNull();
  });
});

describe("computerActionLabel", () => {
  it("speaks the tool-shaped action name", () => {
    expect(computerActionLabel({ action: "computer_double_click", ok: true })).toBe("Double click");
    expect(computerActionLabel(undefined)).toBeNull();
  });

  it("keeps a failure's own message, which is the part worth the space", () => {
    expect(
      computerActionLabel({ action: "computer_click", ok: false, message: "window moved" }),
    ).toBe("Click failed: window moved");
    expect(computerActionLabel({ action: "computer_click", ok: false })).toBe("Click failed");
  });
});

describe("computerBackendIsVisibleDesktop", () => {
  it("decides whether the pane-auto-open preference controls anything at all", () => {
    expect(computerBackendIsVisibleDesktop(state())).toBe(true);
    expect(
      computerBackendIsVisibleDesktop(
        state({ capabilities: { ...state().capabilities, visibleDesktop: false } }),
      ),
    ).toBe(false);
    expect(computerBackendIsVisibleDesktop(undefined)).toBe(false);
  });
});
