import type { DeviceDescriptor, DeviceUdid } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  attachedDeviceFromThreadState,
  deviceAttachStatusLabel,
  resolveDisplayedDevice,
  buildDevicePickerEntries,
  canvasPointToDevicePoint,
  createDeviceFrameGateState,
  createDeviceRecordingState,
  DEVICE_TAP_MOVEMENT_THRESHOLD_POINTS,
  deviceContainRect,
  deviceHidUsageForKey,
  deviceKeyModifiers,
  deviceRecordingClickIntent,
  deviceSetupProgress,
  describeDegradedCapabilities,
  inferDeviceScaleFactor,
  isDeviceRecordingActive,
  isNextDeviceFrameSequence,
  resolveDeviceAvailabilityView,
  resolveDeviceHardwareButtonShortcut,
  resolveDevicePointerGesture,
  resolveDevicePointSize,
  shouldSubscribeToDeviceStream,
  stepDeviceFrameGate,
  stepDeviceRecording,
  type DeviceFrameGateState,
} from "./DevicePanel.logic";

const UDID = "AAAA-BBBB" as DeviceUdid;
const OTHER_UDID = "CCCC-DDDD" as DeviceUdid;

function header(overrides: {
  sequence: number;
  keyframe?: boolean;
  codecConfig?: boolean;
  deviceId?: string;
}) {
  return {
    deviceId: overrides.deviceId ?? UDID,
    sequence: overrides.sequence,
    keyframe: overrides.keyframe ?? false,
    codecConfig: overrides.codecConfig ?? false,
  };
}

function device(overrides: Partial<DeviceDescriptor> = {}): DeviceDescriptor {
  return {
    platform: "ios-simulator",
    udid: UDID,
    name: "iPhone 16 Pro",
    runtime: "iOS 18.2",
    state: "booted",
    bootSource: "user",
    ...overrides,
  } as DeviceDescriptor;
}

describe("device frame gate", () => {
  it("ignores frames addressed to another device", () => {
    const state = createDeviceFrameGateState();
    const step = stepDeviceFrameGate(state, header({ sequence: 1, deviceId: OTHER_UDID }), UDID);

    expect(step.action).toEqual({ kind: "ignore" });
    expect(step.state).toBe(state);
  });

  it("ignores every frame while no device is attached", () => {
    const step = stepDeviceFrameGate(
      createDeviceFrameGateState(),
      header({ sequence: 1, keyframe: true, codecConfig: true }),
      null,
    );

    expect(step.action).toEqual({ kind: "ignore" });
  });

  it("drops media frames until a codec config arrives", () => {
    const step = stepDeviceFrameGate(
      createDeviceFrameGateState(),
      header({ sequence: 1, keyframe: true }),
      UDID,
    );

    expect(step.action).toEqual({ kind: "drop", reason: "no-codec-config" });
    expect(step.state.phase).toBe("awaiting-config");
    expect(step.state.droppedSinceResync).toBe(1);
  });

  it("configures on a codec-config frame and then requires a keyframe", () => {
    const configured = stepDeviceFrameGate(
      createDeviceFrameGateState(),
      header({ sequence: 1, codecConfig: true }),
      UDID,
    );
    expect(configured.action).toEqual({ kind: "configure" });
    expect(configured.state.phase).toBe("awaiting-keyframe");
    expect(configured.requestKeyframe).toBe(true);

    const delta = stepDeviceFrameGate(configured.state, header({ sequence: 2 }), UDID);
    expect(delta.action).toEqual({ kind: "drop", reason: "awaiting-keyframe" });

    const key = stepDeviceFrameGate(delta.state, header({ sequence: 3, keyframe: true }), UDID);
    expect(key.action).toEqual({ kind: "decode", keyframe: true });
    expect(key.state.phase).toBe("streaming");
    expect(key.state.droppedSinceResync).toBe(0);
  });

  it("decodes consecutive delta frames once streaming", () => {
    let state: DeviceFrameGateState = stepDeviceFrameGate(
      createDeviceFrameGateState(),
      header({ sequence: 1, codecConfig: true }),
      UDID,
    ).state;
    state = stepDeviceFrameGate(state, header({ sequence: 2, keyframe: true }), UDID).state;

    const first = stepDeviceFrameGate(state, header({ sequence: 3 }), UDID);
    expect(first.action).toEqual({ kind: "decode", keyframe: false });
    const second = stepDeviceFrameGate(first.state, header({ sequence: 4 }), UDID);
    expect(second.action).toEqual({ kind: "decode", keyframe: false });
    expect(second.state.lastSequence).toBe(4);
  });

  it("holds and requests a keyframe after a sequence gap", () => {
    let state: DeviceFrameGateState = stepDeviceFrameGate(
      createDeviceFrameGateState(),
      header({ sequence: 1, codecConfig: true }),
      UDID,
    ).state;
    state = stepDeviceFrameGate(state, header({ sequence: 2, keyframe: true }), UDID).state;

    const gap = stepDeviceFrameGate(state, header({ sequence: 9 }), UDID);
    expect(gap.action).toEqual({ kind: "drop", reason: "sequence-gap" });
    expect(gap.state.phase).toBe("awaiting-keyframe");
    expect(gap.requestKeyframe).toBe(true);

    const recovered = stepDeviceFrameGate(
      gap.state,
      header({ sequence: 10, keyframe: true }),
      UDID,
    );
    expect(recovered.action).toEqual({ kind: "decode", keyframe: true });
    expect(recovered.state.phase).toBe("streaming");
  });

  it("decodes straight through a gap when the gap frame is itself a keyframe", () => {
    let state: DeviceFrameGateState = stepDeviceFrameGate(
      createDeviceFrameGateState(),
      header({ sequence: 1, codecConfig: true }),
      UDID,
    ).state;
    state = stepDeviceFrameGate(state, header({ sequence: 2, keyframe: true }), UDID).state;

    const step = stepDeviceFrameGate(state, header({ sequence: 40, keyframe: true }), UDID);
    expect(step.action).toEqual({ kind: "decode", keyframe: true });
    expect(step.state.phase).toBe("streaming");
  });

  it("drops duplicate and far-out-of-order frames without disturbing the gate", () => {
    let state: DeviceFrameGateState = stepDeviceFrameGate(
      createDeviceFrameGateState(),
      header({ sequence: 100, codecConfig: true }),
      UDID,
    ).state;
    state = stepDeviceFrameGate(state, header({ sequence: 101, keyframe: true }), UDID).state;

    const duplicate = stepDeviceFrameGate(state, header({ sequence: 101 }), UDID);
    expect(duplicate.action).toEqual({ kind: "drop", reason: "stale-sequence" });
    expect(duplicate.state.phase).toBe("streaming");
    expect(duplicate.state.lastSequence).toBe(101);

    const stale = stepDeviceFrameGate(state, header({ sequence: 50 }), UDID);
    expect(stale.action).toEqual({ kind: "drop", reason: "stale-sequence" });
    expect(stale.state.lastSequence).toBe(101);
  });

  it("treats a wrapped u32 sequence as consecutive", () => {
    const last = 2 ** 32 - 1;
    expect(isNextDeviceFrameSequence(last, 0)).toBe(true);
    expect(isNextDeviceFrameSequence(5, 6)).toBe(true);
    expect(isNextDeviceFrameSequence(5, 7)).toBe(false);

    let state: DeviceFrameGateState = stepDeviceFrameGate(
      createDeviceFrameGateState(),
      header({ sequence: last - 1, codecConfig: true }),
      UDID,
    ).state;
    state = stepDeviceFrameGate(state, header({ sequence: last, keyframe: true }), UDID).state;

    const wrapped = stepDeviceFrameGate(state, header({ sequence: 0 }), UDID);
    expect(wrapped.action).toEqual({ kind: "decode", keyframe: false });
  });

  it("re-arms the keyframe requirement when a new codec config arrives mid-stream", () => {
    let state: DeviceFrameGateState = stepDeviceFrameGate(
      createDeviceFrameGateState(),
      header({ sequence: 1, codecConfig: true }),
      UDID,
    ).state;
    state = stepDeviceFrameGate(state, header({ sequence: 2, keyframe: true }), UDID).state;
    expect(state.phase).toBe("streaming");

    const reconfigured = stepDeviceFrameGate(
      state,
      header({ sequence: 3, codecConfig: true }),
      UDID,
    );
    expect(reconfigured.action).toEqual({ kind: "configure" });
    expect(reconfigured.state.phase).toBe("awaiting-keyframe");

    const delta = stepDeviceFrameGate(reconfigured.state, header({ sequence: 4 }), UDID);
    expect(delta.action).toEqual({ kind: "drop", reason: "awaiting-keyframe" });
  });
});

describe("coordinate mapping", () => {
  const geometry = {
    frameWidth: 400,
    frameHeight: 800,
    displayWidth: 400,
    displayHeight: 800,
  };

  it("maps a click one-to-one when the canvas matches the frame", () => {
    expect(canvasPointToDevicePoint(geometry, 100, 200)).toEqual({ x: 100, y: 200 });
  });

  it("scales coordinates when the canvas is smaller than the frame", () => {
    const scaled = { ...geometry, displayWidth: 200, displayHeight: 400 };
    expect(canvasPointToDevicePoint(scaled, 100, 200)).toEqual({ x: 200, y: 400 });
  });

  it("accounts for letterboxing when the aspect ratios differ", () => {
    // A tall 400x800 frame in a 800x800 box leaves 200px bars left and right.
    const letterboxed = { ...geometry, displayWidth: 800, displayHeight: 800 };
    const rect = deviceContainRect(letterboxed);
    expect(rect).toEqual({ offsetX: 200, offsetY: 0, width: 400, height: 800 });

    expect(canvasPointToDevicePoint(letterboxed, 400, 400)).toEqual({ x: 200, y: 400 });
    // Inside the left bar: no device coordinate at all.
    expect(canvasPointToDevicePoint(letterboxed, 100, 400)).toBeNull();
    expect(canvasPointToDevicePoint(letterboxed, 700, 400)).toBeNull();
  });

  it("maps to device points when they differ from frame pixels", () => {
    const retina = {
      ...geometry,
      frameWidth: 1179,
      frameHeight: 2556,
      displayWidth: 1179,
      displayHeight: 2556,
      devicePointWidth: 393,
      devicePointHeight: 852,
    };
    expect(canvasPointToDevicePoint(retina, 1179, 2556)).toEqual({ x: 393, y: 852 });
    expect(canvasPointToDevicePoint(retina, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("returns null for a degenerate geometry rather than dividing by zero", () => {
    expect(deviceContainRect({ ...geometry, frameWidth: 0 })).toBeNull();
    expect(canvasPointToDevicePoint({ ...geometry, displayHeight: 0 }, 10, 10)).toBeNull();
  });
});

describe("device point size", () => {
  // Regression: the pane shipped sending frame *pixels* as tap coordinates. On a
  // 3x phone that put every tap ~3x off the right edge of the screen, where the
  // backend clamps silently — clicks appeared to do nothing at all.
  it("prefers the contract geometry over everything else", () => {
    // The helper's own attachment geometry is what the backend validates input
    // against, so a coordinate derived from it can never be rejected.
    expect(
      resolveDevicePointSize({
        framePixelWidth: 1206,
        framePixelHeight: 2622,
        geometry: { pointWidth: 402, pointHeight: 874, scale: 3 },
        measured: { width: 390, height: 844 },
      }),
    ).toEqual({ width: 402, height: 874 });
  });

  it("falls back to the measured size when the descriptor has no geometry", () => {
    // A server that predates the geometry field, or a device nothing has
    // attached to yet, still has to produce landable taps.
    expect(
      resolveDevicePointSize({
        framePixelWidth: 1206,
        framePixelHeight: 2622,
        geometry: undefined,
        measured: { width: 402, height: 874 },
      }),
    ).toEqual({ width: 402, height: 874 });
  });

  it("falls back past a degenerate geometry rather than dividing by zero", () => {
    expect(
      resolveDevicePointSize({
        framePixelWidth: 1206,
        framePixelHeight: 2622,
        geometry: { pointWidth: 0, pointHeight: 874, scale: 3 },
        measured: { width: 402, height: 874 },
      }),
    ).toEqual({ width: 402, height: 874 });
  });

  it("falls back to the inferred scale when neither source is available", () => {
    expect(
      resolveDevicePointSize({
        framePixelWidth: 1206,
        framePixelHeight: 2622,
        geometry: null,
        measured: null,
      }),
    ).toEqual({ width: 402, height: 874 });
  });

  it("maps a canvas click through the contract geometry, not frame pixels", () => {
    const size = resolveDevicePointSize({
      framePixelWidth: 1206,
      framePixelHeight: 2622,
      geometry: { pointWidth: 402, pointHeight: 874, scale: 3 },
    });
    const point = canvasPointToDevicePoint(
      {
        frameWidth: 1206,
        frameHeight: 2622,
        displayWidth: 368,
        displayHeight: 816,
        devicePointWidth: size?.width ?? 0,
        devicePointHeight: size?.height ?? 0,
      },
      368 * 0.845,
      816 * 0.365,
    );
    expect(point?.x).toBeCloseTo(340, 0);
    // Short of 0.365 * 874: the 1206x2622 frame letterboxes 8px top and bottom
    // in the 368x816 box, and the mapping accounts for the bars.
    expect(point?.y).toBeCloseTo(317, 0);
  });

  it("prefers the measured accessibility size over anything inferred", () => {
    expect(
      resolveDevicePointSize({
        framePixelWidth: 1206,
        framePixelHeight: 2622,
        measured: { width: 402, height: 874 },
      }),
    ).toEqual({ width: 402, height: 874 });
  });

  it("infers the 3x scale of a Retina phone when accessibility is unavailable", () => {
    expect(resolveDevicePointSize({ framePixelWidth: 1206, framePixelHeight: 2622 })).toEqual({
      width: 402,
      height: 874,
    });
  });

  it("never returns the raw pixel size for a Retina frame", () => {
    const size = resolveDevicePointSize({ framePixelWidth: 1206, framePixelHeight: 2622 });
    expect(size?.width).not.toBe(1206);
    expect(size?.height).not.toBe(2622);
  });

  it("identifies each Apple scale factor from the frame width", () => {
    expect(inferDeviceScaleFactor(1206)).toBe(3); // iPhone 17 Pro
    expect(inferDeviceScaleFactor(1170)).toBe(3); // iPhone 13 Pro
    expect(inferDeviceScaleFactor(1640)).toBe(2); // iPad Air
  });

  it("ignores a degenerate or missing measurement", () => {
    expect(
      resolveDevicePointSize({
        framePixelWidth: 1206,
        framePixelHeight: 2622,
        measured: { width: 0, height: 0 },
      }),
    ).toEqual({ width: 402, height: 874 });
    expect(resolveDevicePointSize({ framePixelWidth: 0, framePixelHeight: 0 })).toBeNull();
  });

  it("maps a canvas click to points, not pixels, end to end", () => {
    // The exact failure from the live repro: a click 84.5% across a 3x screen
    // must send ~340, not the ~1019 the pane was sending.
    const size = resolveDevicePointSize({ framePixelWidth: 1206, framePixelHeight: 2622 });
    const point = canvasPointToDevicePoint(
      {
        frameWidth: 1206,
        frameHeight: 2622,
        displayWidth: 368,
        displayHeight: 816,
        devicePointWidth: size?.width ?? 0,
        devicePointHeight: size?.height ?? 0,
      },
      368 * 0.845,
      816 * 0.365,
    );
    expect(point?.x).toBeCloseTo(340, 0);
    expect(point?.x).toBeLessThan(size?.width ?? 0);
  });
});

describe("pointer gestures", () => {
  it("classifies a stationary press as a tap", () => {
    const gesture = resolveDevicePointerGesture({
      from: { x: 10, y: 10 },
      to: { x: 10, y: 10 },
      durationMs: 120,
    });
    expect(gesture).toEqual({ kind: "tap", point: { x: 10, y: 10 } });
  });

  it("treats jitter under the threshold as a tap", () => {
    const gesture = resolveDevicePointerGesture({
      from: { x: 10, y: 10 },
      to: { x: 10 + DEVICE_TAP_MOVEMENT_THRESHOLD_POINTS, y: 10 },
      durationMs: 80,
    });
    expect(gesture?.kind).toBe("tap");
  });

  it("classifies real movement as a swipe and floors the duration", () => {
    const gesture = resolveDevicePointerGesture({
      from: { x: 10, y: 400 },
      to: { x: 10, y: 100 },
      durationMs: 0,
    });
    expect(gesture).toEqual({
      kind: "swipe",
      from: { x: 10, y: 400 },
      to: { x: 10, y: 100 },
      durationMs: 16,
    });
  });

  it("yields no gesture when the press did not start on the screen", () => {
    expect(
      resolveDevicePointerGesture({ from: null, to: { x: 1, y: 1 }, durationMs: 50 }),
    ).toBeNull();
  });

  it("falls back to a tap at the press origin when the release leaves the screen", () => {
    const gesture = resolveDevicePointerGesture({
      from: { x: 5, y: 5 },
      to: null,
      durationMs: 50,
    });
    expect(gesture).toEqual({ kind: "tap", point: { x: 5, y: 5 } });
  });
});

describe("hardware button shortcuts", () => {
  const base = { metaKey: true, shiftKey: false, altKey: false, ctrlKey: false };

  it("matches the Simulator.app chords the backend can honour", () => {
    expect(resolveDeviceHardwareButtonShortcut({ ...base, shiftKey: true, key: "H" })).toBe("home");
    expect(resolveDeviceHardwareButtonShortcut({ ...base, key: "l" })).toBe("lock");
  });

  it("leaves Simulator.app's rotate chord unclaimed, since the backend cannot honour it", () => {
    // Rotation is a window command with no HID usage and no simctl equivalent.
    // Claiming ⌘→ would swallow the keystroke and then surface an error.
    expect(resolveDeviceHardwareButtonShortcut({ ...base, key: "ArrowRight" })).toBeNull();
  });

  it("matches Simulator.app's volume chords", () => {
    expect(resolveDeviceHardwareButtonShortcut({ ...base, key: "ArrowUp" })).toBe("volume-up");
    expect(resolveDeviceHardwareButtonShortcut({ ...base, key: "ArrowDown" })).toBe("volume-down");
  });

  it("leaves unrelated chords to the app", () => {
    expect(resolveDeviceHardwareButtonShortcut({ ...base, key: "w" })).toBeNull();
    expect(resolveDeviceHardwareButtonShortcut({ ...base, metaKey: false, key: "l" })).toBeNull();
    expect(resolveDeviceHardwareButtonShortcut({ ...base, ctrlKey: true, key: "l" })).toBeNull();
    // Cmd+Shift only maps Home; other Cmd+Shift chords stay with Synara.
    expect(
      resolveDeviceHardwareButtonShortcut({ ...base, shiftKey: true, key: "ArrowUp" }),
    ).toBeNull();
  });
});

describe("key translation", () => {
  it("maps letters, digits, and named keys to HID usages", () => {
    expect(deviceHidUsageForKey("a")).toBe(0x04);
    expect(deviceHidUsageForKey("A")).toBe(0x04);
    expect(deviceHidUsageForKey("z")).toBe(0x1d);
    expect(deviceHidUsageForKey("1")).toBe(0x1e);
    expect(deviceHidUsageForKey("9")).toBe(0x26);
    expect(deviceHidUsageForKey("0")).toBe(0x27);
    expect(deviceHidUsageForKey("Enter")).toBe(0x28);
    expect(deviceHidUsageForKey("Backspace")).toBe(0x2a);
    expect(deviceHidUsageForKey(" ")).toBe(0x2c);
    expect(deviceHidUsageForKey("ArrowUp")).toBe(0x52);
  });

  it("returns null for keys the device has no equivalent for", () => {
    expect(deviceHidUsageForKey("F5")).toBeNull();
    expect(deviceHidUsageForKey("Dead")).toBeNull();
    expect(deviceHidUsageForKey("Unidentified")).toBeNull();
  });

  it("collects the active modifiers", () => {
    expect(
      deviceKeyModifiers({
        key: "a",
        metaKey: true,
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
      }),
    ).toEqual(["command", "shift"]);
    expect(
      deviceKeyModifiers({
        key: "a",
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
      }),
    ).toEqual([]);
  });
});

describe("device picker", () => {
  it("puts the attached device first, then booted, then the rest", () => {
    const entries = buildDevicePickerEntries({
      devices: [
        device({ udid: "d-shutdown" as DeviceUdid, name: "iPad", state: "shutdown" }),
        device({ udid: "d-booted" as DeviceUdid, name: "iPhone 16", state: "booted" }),
        device({ udid: "d-attached" as DeviceUdid, name: "iPhone SE", state: "booted" }),
        device({ udid: "d-booting" as DeviceUdid, name: "iPhone 15", state: "booting" }),
      ],
      attachedDeviceUdid: "d-attached" as DeviceUdid,
    });

    expect(entries.map((entry) => entry.device.udid)).toEqual([
      "d-attached",
      "d-booted",
      "d-booting",
      "d-shutdown",
    ]);
    expect(entries[0]?.attached).toBe(true);
  });

  it("chooses boot-then-attach for a shut-down device and waits mid-transition", () => {
    const entries = buildDevicePickerEntries({
      devices: [
        device({ udid: "a" as DeviceUdid, name: "A", state: "booted" }),
        device({ udid: "b" as DeviceUdid, name: "B", state: "shutdown" }),
        device({ udid: "c" as DeviceUdid, name: "C", state: "booting" }),
        device({ udid: "d" as DeviceUdid, name: "D", state: "shutting-down" }),
      ],
      attachedDeviceUdid: null,
    });

    const actionByUdid = Object.fromEntries(
      entries.map((entry) => [entry.device.udid, entry.action.kind]),
    );
    expect(actionByUdid).toEqual({
      a: "attach",
      b: "boot-then-attach",
      c: "wait",
      d: "wait",
    });
  });

  it("labels each entry with its runtime and state", () => {
    const [entry] = buildDevicePickerEntries({
      devices: [device({ runtime: "iOS 18.2", state: "booted" })],
      attachedDeviceUdid: null,
    });
    expect(entry?.detail).toBe("iOS 18.2 · Booted");
  });
});

describe("availability", () => {
  it("reports ready when the backend is available", () => {
    expect(resolveDeviceAvailabilityView({ kind: "available" })).toEqual({ kind: "ready" });
  });

  it("shows the picker when only the helper build is left", () => {
    // The deadlock this prevents: the helper is built on first attach, so
    // blocking the picker on it means the user is shown a checklist whose one
    // remaining step is the thing the checklist itself makes impossible.
    const view = resolveDeviceAvailabilityView({
      kind: "setup-required",
      steps: [
        { id: "install-xcode", label: "Install Xcode", done: true },
        { id: "install-ios-runtime", label: "Install an iOS runtime", done: true },
        { id: "build-device-helper", label: "Build the Synara device helper", done: false },
      ],
    });
    expect(view).toEqual({ kind: "ready" });
  });

  it("still blocks when a step the user must perform is outstanding", () => {
    // Only the helper is self-healing; anything the user has to install keeps
    // the checklist up.
    const view = resolveDeviceAvailabilityView({
      kind: "setup-required",
      steps: [
        { id: "install-xcode", label: "Install Xcode", done: true },
        { id: "install-ios-runtime", label: "Install an iOS runtime", done: false },
        { id: "build-device-helper", label: "Build the Synara device helper", done: false },
      ],
    });
    expect(view.kind).toBe("blocked");
  });

  it("explains an unsupported platform and marks it unrecoverable", () => {
    const view = resolveDeviceAvailabilityView({
      kind: "unsupported-platform",
      platform: "linux",
    });
    expect(view.kind).toBe("blocked");
    if (view.kind !== "blocked") return;
    expect(view.description).toContain("linux");
    expect(view.retryable).toBe(false);
    expect(view.steps).toEqual([]);
  });

  it("passes setup steps through for the live checklist", () => {
    const steps = [
      { id: "install-xcode", label: "Install Xcode", done: true },
      { id: "install-ios-runtime", label: "Install an iOS runtime", done: false },
    ] as const;
    const view = resolveDeviceAvailabilityView({ kind: "setup-required", steps });

    expect(view.kind).toBe("blocked");
    if (view.kind !== "blocked") return;
    expect(view.steps).toHaveLength(2);
    expect(view.retryable).toBe(true);
    expect(deviceSetupProgress(view.steps)).toEqual({ done: 1, total: 2 });
  });

  it("surfaces the helper failure message verbatim", () => {
    const view = resolveDeviceAvailabilityView({
      kind: "helper-unavailable",
      message: "Swift compile failed: no such module 'SimulatorKit'",
    });
    expect(view.kind).toBe("blocked");
    if (view.kind !== "blocked") return;
    expect(view.description).toBe("Swift compile failed: no such module 'SimulatorKit'");
    expect(view.retryable).toBe(true);
  });

  it("does not block the pane when a capability is degraded", () => {
    const view = resolveDeviceAvailabilityView({
      kind: "degraded",
      capabilities: [
        { id: "framebuffer", ok: true },
        { id: "hid", ok: true },
        { id: "accessibility", ok: false, missingSymbol: "AXPTranslator" },
        { id: "encoder", ok: true },
      ],
      toolchain: { xcodeVersion: "26.3" },
    });

    // Blocking here would cost streaming and input over a broken tree read.
    expect(view.kind).toBe("degraded");
    if (view.kind !== "degraded") return;
    expect(view.brokenCapabilities).toEqual(["accessibility"]);
  });

  it("names what broke, the Xcode, and what still works", () => {
    const notice = describeDegradedCapabilities(
      [
        { id: "framebuffer", ok: true },
        { id: "hid", ok: true },
        { id: "accessibility", ok: false },
        { id: "encoder", ok: true },
      ],
      { xcodeVersion: "26.3" },
    );

    expect(notice).toBe(
      "Accessibility inspection unavailable with Xcode 26.3 — screen capture, touch and keyboard input and video encoding unaffected.",
    );
  });

  it("omits the unaffected clause when nothing else works", () => {
    const notice = describeDegradedCapabilities(
      [
        { id: "accessibility", ok: false },
        { id: "hid", ok: false },
      ],
      undefined,
    );

    expect(notice).toBe("Accessibility inspection and touch and keyboard input unavailable.");
  });
});

describe("stream subscription policy", () => {
  const booted = device({ state: "booted" });

  it("subscribes only for a live, visible pane on a booted device", () => {
    expect(
      shouldSubscribeToDeviceStream({
        runtimeMode: "live",
        isVisible: true,
        attachedDevice: booted,
      }),
    ).toBe(true);
  });

  it("stays unsubscribed for preview panes, hidden tabs, and unbooted devices", () => {
    expect(
      shouldSubscribeToDeviceStream({
        runtimeMode: "preview",
        isVisible: true,
        attachedDevice: booted,
      }),
    ).toBe(false);
    expect(
      shouldSubscribeToDeviceStream({
        runtimeMode: "live",
        isVisible: false,
        attachedDevice: booted,
      }),
    ).toBe(false);
    expect(
      shouldSubscribeToDeviceStream({
        runtimeMode: "live",
        isVisible: true,
        attachedDevice: device({ state: "booting" }),
      }),
    ).toBe(false);
    expect(
      shouldSubscribeToDeviceStream({
        runtimeMode: "live",
        isVisible: true,
        attachedDevice: null,
      }),
    ).toBe(false);
  });
});

describe("thread state helpers", () => {
  it("resolves the attached descriptor from the thread state", () => {
    const state = {
      threadId: "t" as never,
      version: 1,
      attachedDeviceUdid: UDID,
      devices: [device({ udid: OTHER_UDID }), device({ udid: UDID, name: "Attached" })],
      agentActive: false,
      availability: { kind: "available" },
      lastError: null,
    } as never;

    expect(attachedDeviceFromThreadState(state)?.name).toBe("Attached");
  });

  it("returns null when nothing is attached or the state is missing", () => {
    expect(attachedDeviceFromThreadState(undefined)).toBeNull();
    expect(
      attachedDeviceFromThreadState({
        threadId: "t",
        version: 1,
        attachedDeviceUdid: null,
        devices: [device()],
        agentActive: false,
        availability: { kind: "available" },
        lastError: null,
      } as never),
    ).toBeNull();
  });
});

describe("optimistic device selection", () => {
  const threadState = (overrides: Record<string, unknown> = {}) =>
    ({
      threadId: "t",
      version: 1,
      attachedDeviceUdid: null,
      devices: [],
      agentActive: false,
      availability: { kind: "available" },
      lastError: null,
      ...overrides,
    }) as never;

  it("shows the device the user just picked before the server confirms it", () => {
    const picked = device({ udid: OTHER_UDID, name: "iPad Pro 13-inch", state: "shutdown" });

    // A cold boot takes most of a minute; until this, the picker read "Choose a
    // simulator" and the screen stayed blank for the whole of it.
    expect(
      resolveDisplayedDevice({
        threadState: threadState(),
        pending: { device: picked, supersedes: null },
      })?.name,
    ).toBe("iPad Pro 13-inch");
  });

  it("keeps showing the new device while a switch is still in flight", () => {
    const picked = device({ udid: OTHER_UDID, name: "iPhone SE" });
    const old = device({ name: "iPad Air 13-inch" });

    // The thread still names the device being switched away from, so nothing
    // has happened yet. Preferring it here is what made a switch show the old
    // simulator's name and chassis for the length of the new one's boot.
    expect(
      resolveDisplayedDevice({
        threadState: threadState({ attachedDeviceUdid: UDID, devices: [old] }),
        pending: { device: picked, supersedes: UDID },
      })?.name,
    ).toBe("iPhone SE");
  });

  it("prefers the thread's own descriptor for the same device", () => {
    const picked = device({ state: "shutdown" });
    const live = device({
      state: "booted",
      geometry: { pointWidth: 402, pointHeight: 874, scale: 3 },
    });

    const shown = resolveDisplayedDevice({
      threadState: threadState({ attachedDeviceUdid: null, devices: [live] }),
      pending: { device: picked, supersedes: null },
    });

    // The server's copy carries the live runtime state and the helper's
    // measured geometry, both fresher than the listing the pick came from.
    expect(shown?.state).toBe("booted");
    expect(shown?.geometry).toEqual({ pointWidth: 402, pointHeight: 874, scale: 3 });
  });

  it("gives way once the server answers with a different device", () => {
    const picked = device({ udid: OTHER_UDID, name: "iPad Pro 13-inch" });
    const attached = device({ name: "iPhone 16 Pro" });

    // An agent claimed the thread while the pick was in flight: the server has
    // spoken, so its answer wins over the optimistic one.
    expect(
      resolveDisplayedDevice({
        threadState: threadState({ attachedDeviceUdid: UDID, devices: [attached] }),
        pending: { device: picked, supersedes: null },
      })?.name,
    ).toBe("iPhone 16 Pro");
  });

  it("falls back to the thread state when nothing is pending", () => {
    expect(resolveDisplayedDevice({ threadState: threadState(), pending: null })).toBeNull();
  });
});

describe("attach status label", () => {
  it("names the stage the server says it is waiting on", () => {
    const label = (phase: "booting" | "waiting-for-display" | "connecting") =>
      deviceAttachStatusLabel({ phase, deviceState: "booted", pendingSelection: false });

    expect(label("booting")).toBe("Starting up…");
    // The distinction that matters on a cold boot: the device is up, the screen
    // is not, and a bare spinner for that whole window reads as a hang.
    expect(label("waiting-for-display")).toBe("Waiting for the screen…");
    expect(label("connecting")).toBe("Connecting…");
  });

  it("covers the window before the first response, from the click alone", () => {
    expect(
      deviceAttachStatusLabel({
        phase: undefined,
        deviceState: "shutdown",
        pendingSelection: true,
      }),
    ).toBe("Starting up…");
  });

  it("says nothing once the device is simply booted and attached", () => {
    expect(
      deviceAttachStatusLabel({ phase: null, deviceState: "booted", pendingSelection: false }),
    ).toBeNull();
  });

  it("still reports a booting device with no phase from the server", () => {
    expect(
      deviceAttachStatusLabel({ phase: null, deviceState: "booting", pendingSelection: false }),
    ).toBe("Starting up…");
  });
});

describe("device recording state machine", () => {
  it("walks start → recording → stop → idle", () => {
    let state = createDeviceRecordingState();
    expect(deviceRecordingClickIntent(state)).toBe("start");

    state = stepDeviceRecording(state, { kind: "start-requested" });
    expect(state.kind).toBe("starting");
    // Mid-transition a second click must send nothing: the backend refuses a
    // concurrent start, so the UI has to swallow it rather than surface an error.
    expect(deviceRecordingClickIntent(state)).toBeNull();

    state = stepDeviceRecording(state, {
      kind: "started",
      path: "/tmp/sim.mp4",
      startedAtMs: 1000,
    });
    expect(state).toEqual({ kind: "recording", path: "/tmp/sim.mp4", startedAtMs: 1000 });
    expect(isDeviceRecordingActive(state)).toBe(true);
    expect(deviceRecordingClickIntent(state)).toBe("stop");

    state = stepDeviceRecording(state, { kind: "stop-requested" });
    expect(state).toEqual({ kind: "stopping", path: "/tmp/sim.mp4" });
    // Still "active" while stopping: the button must not flip back to an idle
    // record affordance before the file has actually been finalised.
    expect(isDeviceRecordingActive(state)).toBe(true);
    expect(deviceRecordingClickIntent(state)).toBeNull();

    state = stepDeviceRecording(state, { kind: "stopped" });
    expect(state).toEqual({ kind: "idle" });
    expect(isDeviceRecordingActive(state)).toBe(false);
  });

  it("ignores events that do not apply to the current phase", () => {
    const idle = createDeviceRecordingState();
    expect(stepDeviceRecording(idle, { kind: "stop-requested" })).toBe(idle);
    expect(stepDeviceRecording(idle, { kind: "stopped" })).toBe(idle);

    const starting = stepDeviceRecording(idle, { kind: "start-requested" });
    expect(stepDeviceRecording(starting, { kind: "start-requested" })).toBe(starting);
  });

  it("returns to idle on failure or when the device goes away", () => {
    const recording = stepDeviceRecording(
      stepDeviceRecording(createDeviceRecordingState(), { kind: "start-requested" }),
      { kind: "started", path: "/tmp/sim.mp4", startedAtMs: 0 },
    );

    expect(stepDeviceRecording(recording, { kind: "failed" })).toEqual({ kind: "idle" });
    expect(stepDeviceRecording(recording, { kind: "device-lost" })).toEqual({ kind: "idle" });
    // A start that never resolved must clear too, or the toolbar stays stuck.
    const starting = stepDeviceRecording(createDeviceRecordingState(), {
      kind: "start-requested",
    });
    expect(stepDeviceRecording(starting, { kind: "device-lost" })).toEqual({ kind: "idle" });
  });
});
