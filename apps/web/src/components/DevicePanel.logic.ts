// FILE: DevicePanel.logic.ts
// Purpose: Pure decision logic for the iOS Simulator dock pane (video gating, input mapping, picker/availability views).
// Layer: Component logic helper
// Exports: frame-gate state machine, canvas/device coordinate mapping, hardware-button and key translation, picker + availability view models
// Depends on: device contracts and the shared frame envelope header only — no DOM, no React.

import type {
  DeviceAvailability,
  DeviceCapabilityId,
  DeviceCapabilityStatus,
  DeviceDescriptor,
  DeviceFrameHeader,
  DeviceGeometry,
  DeviceHardwareButton,
  DeviceKeyModifier,
  DeviceSetupStep,
  DeviceSetupStepId,
  DeviceToolchain,
  DeviceUdid,
  ThreadDeviceState,
} from "@synara/contracts";

import { DEVICE_CAPABILITY_LABELS } from "@synara/contracts";

// ── Frame gating ─────────────────────────────────────────────────────
//
// A WebCodecs VideoDecoder must be configured from a codec-config frame (SPS/PPS)
// before it accepts any sample, and after configuring it must receive a keyframe
// before any delta frame or it errors out. The stream is lossy by design (the
// server drops frames under backpressure), so sequence gaps are expected and must
// re-arm the keyframe requirement rather than kill the pane.

export type DeviceFrameGatePhase =
  /** No codec config seen yet: nothing can be decoded. */
  | "awaiting-config"
  /** Configured, but no keyframe has been admitted since the last configure or gap. */
  | "awaiting-keyframe"
  /** Decoding normally. */
  | "streaming";

export interface DeviceFrameGateState {
  readonly phase: DeviceFrameGatePhase;
  /** Sequence of the last admitted frame; null before the first admission. */
  readonly lastSequence: number | null;
  /** Frames dropped since the gate last reached "streaming". Diagnostics only. */
  readonly droppedSinceResync: number;
}

export type DeviceFrameGateAction =
  /** Hand the payload to `VideoDecoder.configure` (or `decode` for media frames). */
  | { readonly kind: "configure" }
  | { readonly kind: "decode"; readonly keyframe: boolean }
  /** Frame cannot be decoded in the current phase. */
  | { readonly kind: "drop"; readonly reason: DeviceFrameDropReason }
  /** Frame belongs to another device/thread and was never ours to decode. */
  | { readonly kind: "ignore" };

export type DeviceFrameDropReason =
  | "no-codec-config"
  | "awaiting-keyframe"
  | "sequence-gap"
  | "stale-sequence";

export interface DeviceFrameGateStep {
  readonly state: DeviceFrameGateState;
  readonly action: DeviceFrameGateAction;
  /**
   * True when the gate newly needs a keyframe it cannot produce itself, so the
   * caller should ask the server for one instead of waiting for the next
   * natural IDR (which may be seconds away at a low keyframe interval).
   */
  readonly requestKeyframe: boolean;
}

export function createDeviceFrameGateState(): DeviceFrameGateState {
  return { phase: "awaiting-config", lastSequence: null, droppedSinceResync: 0 };
}

// u32 sequence wraps, so "next" is computed modulo 2^32 rather than by addition.
const SEQUENCE_MODULUS = 2 ** 32;

export function isNextDeviceFrameSequence(previous: number, next: number): boolean {
  return (previous + 1) % SEQUENCE_MODULUS === next;
}

/**
 * Distance from `previous` to `next` going forward through the wrap point.
 * Used to tell a small forward gap (dropped frames) from a stale/reordered
 * frame, which would otherwise look like an enormous forward jump.
 */
function forwardSequenceDistance(previous: number, next: number): number {
  return (next - previous + SEQUENCE_MODULUS) % SEQUENCE_MODULUS;
}

// Beyond this, a "forward" jump is far more likely a stale frame from a previous
// stream generation than a real burst of drops, so it is discarded rather than
// treated as a gap.
const MAX_PLAUSIBLE_SEQUENCE_GAP = 1_024;

export function stepDeviceFrameGate(
  state: DeviceFrameGateState,
  header: Pick<DeviceFrameHeader, "deviceId" | "sequence" | "keyframe" | "codecConfig">,
  expectedDeviceId: DeviceUdid | string | null,
): DeviceFrameGateStep {
  if (expectedDeviceId === null || header.deviceId !== expectedDeviceId) {
    return { state, action: { kind: "ignore" }, requestKeyframe: false };
  }

  // Codec config re-arms the keyframe requirement: a new parameter set means the
  // decoder is reconfigured, and a decoder cannot resume mid-GOP after that.
  if (header.codecConfig) {
    return {
      state: {
        phase: "awaiting-keyframe",
        lastSequence: header.sequence,
        droppedSinceResync: 0,
      },
      action: { kind: "configure" },
      requestKeyframe: state.phase !== "awaiting-keyframe",
    };
  }

  if (state.phase === "awaiting-config") {
    return {
      state: { ...state, droppedSinceResync: state.droppedSinceResync + 1 },
      action: { kind: "drop", reason: "no-codec-config" },
      requestKeyframe: false,
    };
  }

  if (state.lastSequence !== null) {
    const distance = forwardSequenceDistance(state.lastSequence, header.sequence);
    if (distance === 0 || distance > MAX_PLAUSIBLE_SEQUENCE_GAP) {
      // Reordered, duplicated, or from a previous stream generation. Dropping it
      // keeps `lastSequence` monotonic so one stale frame cannot wedge the gate.
      return {
        state: { ...state, droppedSinceResync: state.droppedSinceResync + 1 },
        action: { kind: "drop", reason: "stale-sequence" },
        requestKeyframe: false,
      };
    }
    if (distance > 1 && !header.keyframe && state.phase === "streaming") {
      // Frames were dropped mid-GOP. Decoding onward would render visible
      // corruption, so hold until the next keyframe and ask for one now.
      return {
        state: {
          phase: "awaiting-keyframe",
          lastSequence: header.sequence,
          droppedSinceResync: state.droppedSinceResync + 1,
        },
        action: { kind: "drop", reason: "sequence-gap" },
        requestKeyframe: true,
      };
    }
  }

  if (state.phase === "awaiting-keyframe" && !header.keyframe) {
    return {
      state: {
        ...state,
        lastSequence: header.sequence,
        droppedSinceResync: state.droppedSinceResync + 1,
      },
      action: { kind: "drop", reason: "awaiting-keyframe" },
      requestKeyframe: false,
    };
  }

  return {
    state: { phase: "streaming", lastSequence: header.sequence, droppedSinceResync: 0 },
    action: { kind: "decode", keyframe: header.keyframe },
    requestKeyframe: false,
  };
}

/**
 * Drops back to the pre-config phase. Used on decoder error and on
 * detach/resubscribe, where the next stream may carry different parameter sets.
 */
export function resetDeviceFrameGate(): DeviceFrameGateState {
  return createDeviceFrameGateState();
}

// ── Coordinate mapping ───────────────────────────────────────────────

export interface DeviceCanvasGeometry {
  /** Decoded frame size in pixels. */
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** Rendered canvas size in CSS pixels (its bounding box). */
  readonly displayWidth: number;
  readonly displayHeight: number;
}

export interface DevicePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Frames arrive at the device's native pixel resolution while input is injected
 * in device points, so the scale factor is derived from the frame rather than
 * assumed: `object-fit: contain` letterboxes, and a click in a letterbox band
 * has no device coordinate at all.
 */
export function deviceContainRect(geometry: DeviceCanvasGeometry): {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
} | null {
  const { frameWidth, frameHeight, displayWidth, displayHeight } = geometry;
  if (
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    displayWidth <= 0 ||
    displayHeight <= 0
  ) {
    return null;
  }
  const scale = Math.min(displayWidth / frameWidth, displayHeight / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return {
    offsetX: (displayWidth - width) / 2,
    offsetY: (displayHeight - height) / 2,
    width,
    height,
  };
}

/**
 * Maps a pointer position (relative to the canvas bounding box) to device
 * points. Returns null for clicks in the letterbox bands, which must not be
 * clamped onto the screen edge — a stray tap at (0, y) is worse than no tap.
 */
export function canvasPointToDevicePoint(
  geometry: DeviceCanvasGeometry & {
    /** Device screen size in points; falls back to frame pixels when unknown. */
    readonly devicePointWidth?: number;
    readonly devicePointHeight?: number;
  },
  canvasX: number,
  canvasY: number,
): DevicePoint | null {
  const rect = deviceContainRect(geometry);
  if (!rect) return null;

  const withinX = canvasX - rect.offsetX;
  const withinY = canvasY - rect.offsetY;
  if (withinX < 0 || withinY < 0 || withinX > rect.width || withinY > rect.height) {
    return null;
  }

  const pointWidth = geometry.devicePointWidth ?? geometry.frameWidth;
  const pointHeight = geometry.devicePointHeight ?? geometry.frameHeight;
  // Round to whole points: the helper injects integral HID coordinates, and a
  // fractional point would be truncated inconsistently across the hop.
  return {
    x: clampToRange(Math.round((withinX / rect.width) * pointWidth), 0, pointWidth),
    y: clampToRange(Math.round((withinY / rect.height) * pointHeight), 0, pointHeight),
  };
}

function clampToRange(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

// ── Tap vs swipe ─────────────────────────────────────────────────────

/**
 * Below this movement a drag is a tap: trackpads and touchscreens jitter a few
 * pixels during a press, and sending a 3px swipe instead of a tap makes buttons
 * feel unreliable.
 */
export const DEVICE_TAP_MOVEMENT_THRESHOLD_POINTS = 8;

export type DevicePointerGesture =
  | { readonly kind: "tap"; readonly point: DevicePoint }
  | {
      readonly kind: "swipe";
      readonly from: DevicePoint;
      readonly to: DevicePoint;
      readonly durationMs: number;
    };

/**
 * Classifies a completed pointer interaction. A press that started or ended
 * outside the screen area yields no gesture rather than a clamped one.
 */
export function resolveDevicePointerGesture(input: {
  readonly from: DevicePoint | null;
  readonly to: DevicePoint | null;
  readonly durationMs: number;
  readonly movementThreshold?: number;
}): DevicePointerGesture | null {
  const { from, to } = input;
  if (!from) return null;
  if (!to) return { kind: "tap", point: from };

  const threshold = input.movementThreshold ?? DEVICE_TAP_MOVEMENT_THRESHOLD_POINTS;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance <= threshold) {
    return { kind: "tap", point: to };
  }
  return {
    kind: "swipe",
    from,
    to,
    // A zero-duration swipe is rejected by the helper as a flick with infinite
    // velocity; clamp to a single frame's worth of time.
    durationMs: Math.max(16, Math.round(input.durationMs)),
  };
}

// ── Hardware buttons and keyboard ────────────────────────────────────

export interface DeviceShortcutEventLike {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * Simulator.app's hardware chords, matched before keyboard passthrough so the
 * muscle memory carries over. Everything else with Cmd held is left to the
 * browser/app rather than injected, since Cmd+W/Cmd+R on a focused canvas must
 * still reach Synara.
 *
 * One of Simulator.app's chords is deliberately absent, for one reason:
 * claiming a chord swallows the keystroke, so a chord the backend refuses is
 * worse than no chord at all. ⌘→ rotate is a window command with no HID usage
 * and no simctl equivalent.
 */
export function resolveDeviceHardwareButtonShortcut(
  event: DeviceShortcutEventLike,
): DeviceHardwareButton | null {
  if (!event.metaKey || event.ctrlKey) return null;

  const key = event.key.toLowerCase();
  if (event.shiftKey) {
    return key === "h" ? "home" : null;
  }
  if (key === "arrowup") return "volume-up";
  if (key === "arrowdown") return "volume-down";
  return key === "l" ? "lock" : null;
}

export function deviceKeyModifiers(event: DeviceShortcutEventLike): DeviceKeyModifier[] {
  const modifiers: DeviceKeyModifier[] = [];
  if (event.metaKey) modifiers.push("command");
  if (event.shiftKey) modifiers.push("shift");
  if (event.altKey) modifiers.push("option");
  if (event.ctrlKey) modifiers.push("control");
  return modifiers;
}

// HID usage codes (page 0x07) for the keys the pane forwards. Letters and digits
// are computed; only the named keys need a table.
const HID_USAGE_BY_KEY: Readonly<Record<string, number>> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  " ": 0x2c,
  "-": 0x2d,
  "=": 0x2e,
  "[": 0x2f,
  "]": 0x30,
  "\\": 0x31,
  ";": 0x33,
  "'": 0x34,
  "`": 0x35,
  ",": 0x36,
  ".": 0x37,
  "/": 0x38,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
};

const HID_USAGE_A = 0x04;
const HID_USAGE_1 = 0x1e;
const HID_USAGE_0 = 0x27;

/**
 * Translates a DOM key to a HID usage code. Returns null for keys the device
 * has no equivalent for (function keys, dead keys, IME composition), which are
 * dropped rather than guessed at.
 */
export function deviceHidUsageForKey(key: string): number | null {
  if (key.length === 1) {
    const lower = key.toLowerCase();
    const codePoint = lower.codePointAt(0);
    if (codePoint === undefined) return null;
    if (lower >= "a" && lower <= "z") {
      return HID_USAGE_A + (codePoint - 97);
    }
    if (lower === "0") return HID_USAGE_0;
    if (lower >= "1" && lower <= "9") {
      return HID_USAGE_1 + (codePoint - 49);
    }
  }
  return HID_USAGE_BY_KEY[key] ?? null;
}

// ── Device picker ────────────────────────────────────────────────────

export type DevicePickerAction =
  /** Already booted: attaching is all that is needed. */
  | { readonly kind: "attach" }
  /** Shut down: boot first, then attach when the boot resolves. */
  | { readonly kind: "boot-then-attach" }
  /** Mid-transition: selecting would race the state machine. */
  | { readonly kind: "wait" };

export interface DevicePickerEntry {
  readonly device: DeviceDescriptor;
  readonly attached: boolean;
  readonly action: DevicePickerAction;
  /** Secondary line, e.g. `iOS 18.2 · Booted`. */
  readonly detail: string;
}

const RUNTIME_STATE_LABELS = {
  shutdown: "Shut down",
  booting: "Booting",
  booted: "Booted",
  "shutting-down": "Shutting down",
} as const satisfies Record<DeviceDescriptor["state"], string>;

export function deviceRuntimeStateLabel(state: DeviceDescriptor["state"]): string {
  return RUNTIME_STATE_LABELS[state];
}

function devicePickerAction(state: DeviceDescriptor["state"]): DevicePickerAction {
  switch (state) {
    case "booted":
      return { kind: "attach" };
    case "shutdown":
      return { kind: "boot-then-attach" };
    default:
      return { kind: "wait" };
  }
}

/**
 * Booted devices sort first so the common case (pick the running simulator) is
 * one click away; within a group, name order keeps the list stable as states
 * churn during boots.
 */
export function buildDevicePickerEntries(input: {
  readonly devices: readonly DeviceDescriptor[];
  readonly attachedDeviceUdid: DeviceUdid | null;
}): readonly DevicePickerEntry[] {
  const rank = (device: DeviceDescriptor): number => {
    if (device.udid === input.attachedDeviceUdid) return 0;
    if (device.state === "booted") return 1;
    if (device.state === "booting") return 2;
    return 3;
  };

  return input.devices
    .toSorted((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name))
    .map((device) => ({
      device,
      attached: device.udid === input.attachedDeviceUdid,
      action: devicePickerAction(device.state),
      detail: `${device.runtime} · ${deviceRuntimeStateLabel(device.state)}`,
    }));
}

// ── Availability ─────────────────────────────────────────────────────

export type DeviceAvailabilityView =
  | { readonly kind: "ready" }
  /**
   * The pane opens and works, but some capability failed its preflight. Kept
   * separate from "blocked" because the user has nothing to fix and everything
   * else still runs: blocking the pane over a broken accessibility path would
   * cost streaming and input for no reason.
   */
  | {
      readonly kind: "degraded";
      readonly notice: string;
      readonly brokenCapabilities: readonly DeviceCapabilityId[];
    }
  | {
      readonly kind: "blocked";
      readonly title: string;
      readonly description: string;
      /** Present only for setup-required; drives the live checklist. */
      readonly steps: readonly DeviceSetupStep[];
      /** Whether the pane should keep polling/listening for a state change. */
      readonly retryable: boolean;
    };

/**
 * "Accessibility inspection unavailable with Xcode 26.3 — streaming and input
 * unaffected": names what broke, the toolchain that broke it, and what still
 * works, so the notice answers the obvious next question in one line.
 */
export function describeDegradedCapabilities(
  capabilities: readonly DeviceCapabilityStatus[],
  toolchain: DeviceToolchain | undefined,
): string {
  const broken = capabilities.filter((capability) => !capability.ok);
  const working = capabilities.filter((capability) => capability.ok);
  const list = (entries: readonly DeviceCapabilityStatus[]): string => {
    const names = entries.map((entry) => DEVICE_CAPABILITY_LABELS[entry.id]);
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!.toLowerCase()}`;
  };

  const xcode = toolchain?.xcodeVersion
    ? ` with Xcode ${toolchain.xcodeVersion}`
    : toolchain?.xcodeBuild
      ? ` with Xcode build ${toolchain.xcodeBuild}`
      : "";
  const unaffected = working.length > 0 ? ` — ${list(working).toLowerCase()} unaffected` : "";
  return `${list(broken)} unavailable${xcode}${unaffected}.`;
}

/**
 * True when every setup step the user can act on is done and only the helper
 * build is left. Xcode, the license and a runtime all need the user; the helper
 * only needs an attach, which the picker provides.
 */
function onlyHelperBuildRemains(steps: readonly DeviceSetupStep[]): boolean {
  const remaining = steps.filter((step) => !step.done);
  return remaining.length > 0 && remaining.every((step) => step.id === "build-device-helper");
}

export function resolveDeviceAvailabilityView(
  availability: DeviceAvailability,
): DeviceAvailabilityView {
  switch (availability.kind) {
    case "available":
      return { kind: "ready" };
    case "unsupported-platform":
      return {
        kind: "blocked",
        title: "iOS Simulator needs macOS",
        description: `This Synara server runs on ${availability.platform}. Simulators are only available when the server runs on a Mac with Xcode installed.`,
        steps: [],
        retryable: false,
      };
    case "setup-required":
      // The helper is the one step the user cannot perform: it is built on
      // first attach. Blocking on it hid the picker, so there was no way to
      // attach, so it never built — the setup card asked for the one thing it
      // prevented. When it is all that remains, show the picker and let
      // choosing a device do the build.
      if (onlyHelperBuildRemains(availability.steps)) return { kind: "ready" };
      return {
        kind: "blocked",
        title: "Set up the iOS Simulator",
        description: "Progress updates automatically as each step finishes.",
        steps: availability.steps,
        retryable: true,
      };
    case "degraded":
      return {
        kind: "degraded",
        notice: describeDegradedCapabilities(availability.capabilities, availability.toolchain),
        brokenCapabilities: availability.capabilities
          .filter((capability) => !capability.ok)
          .map((capability) => capability.id),
      };
    case "helper-unavailable":
      return {
        kind: "blocked",
        title: "Simulator helper could not start",
        description: availability.message,
        steps: [],
        retryable: true,
      };
  }
}

export function deviceSetupProgress(steps: readonly DeviceSetupStep[]): {
  readonly done: number;
  readonly total: number;
} {
  return { done: steps.filter((step) => step.done).length, total: steps.length };
}

// ── Device screen geometry ───────────────────────────────────────────

/**
 * Every Apple display ships at 1x, 2x, or 3x. Frames arrive in pixels and input
 * is injected in points, so the pane must divide by the scale — sending pixels
 * puts a tap several hundred points off the right edge of the screen, where the
 * backend silently clamps it and nothing happens.
 *
 * The authoritative point size comes from the accessibility tree's root frame;
 * this is the fallback for before that first read resolves, and it only has to
 * pick between three candidates.
 */
export const DEVICE_SCALE_FACTORS = [3, 2, 1] as const;

/**
 * Every 3x device Apple ships is a phone, and every phone is narrow: 3x frames
 * land at 1080-1320px. Wider frames are iPads, which are always 2x. Choosing on
 * the frame width directly avoids the trap of a plausible-looking point width —
 * an iPad's 1640px divides by 3 into 547, which is a perfectly reasonable
 * number and completely wrong.
 */
export function inferDeviceScaleFactor(framePixelWidth: number): number {
  if (!Number.isFinite(framePixelWidth) || framePixelWidth <= 0) return 1;
  if (framePixelWidth >= 1000 && framePixelWidth <= 1400) return 3;
  if (framePixelWidth > 1400) return 2;
  // Below 1000px: a 2x phone (750-828px) or a 1x frame. Point widths under 320
  // do not exist on shipping hardware, so anything that small is already points.
  return framePixelWidth >= 640 ? 2 : 1;
}

function usablePointSize(
  size: { readonly width: number; readonly height: number } | null | undefined,
): { readonly width: number; readonly height: number } | null {
  if (!size) return null;
  const { width, height } = size;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Resolves the device's point dimensions, in descending order of authority:
 *
 * 1. `geometry` from the device descriptor. This is the helper's own attachment
 *    geometry — the exact numbers the backend validates input against — so a
 *    coordinate derived from it can never be rejected as out of bounds.
 * 2. The accessibility tree's root frame, for a server that predates the
 *    geometry field or a device attached elsewhere.
 * 3. The scale inferred from the frame width, which only has to pick between
 *    Apple's three scale factors.
 */
export function resolveDevicePointSize(input: {
  readonly framePixelWidth: number;
  readonly framePixelHeight: number;
  readonly geometry?: DeviceGeometry | null | undefined;
  readonly measured?: { readonly width: number; readonly height: number } | null | undefined;
}): { readonly width: number; readonly height: number } | null {
  const { framePixelWidth, framePixelHeight, geometry, measured } = input;
  const fromContract = usablePointSize(
    geometry ? { width: geometry.pointWidth, height: geometry.pointHeight } : null,
  );
  if (fromContract) return fromContract;
  const fromAccessibility = usablePointSize(measured);
  if (fromAccessibility) return fromAccessibility;
  if (framePixelWidth <= 0 || framePixelHeight <= 0) return null;
  const scale = inferDeviceScaleFactor(framePixelWidth);
  return {
    width: Math.round(framePixelWidth / scale),
    height: Math.round(framePixelHeight / scale),
  };
}

// ── Screen recording ─────────────────────────────────────────────────

/**
 * The pane's view of a recording.
 *
 * `starting` and `stopping` exist because both RPCs are slow enough to see:
 * the server waits for simctl's "Recording started" before acking, and stopping
 * sends SIGINT and waits for the container to finalise. Without the two
 * transitional phases the toolbar button would sit in its old state for a
 * second and invite a second click, which is exactly the double-start the
 * backend refuses.
 */
export type DeviceRecordingState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "recording"; readonly path: string; readonly startedAtMs: number }
  | { readonly kind: "stopping"; readonly path: string };

export type DeviceRecordingEvent =
  | { readonly kind: "start-requested" }
  | { readonly kind: "started"; readonly path: string; readonly startedAtMs: number }
  | { readonly kind: "stop-requested" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed" }
  /** The device went away (detached, shut down, or the stream ended). */
  | { readonly kind: "device-lost" };

export function createDeviceRecordingState(): DeviceRecordingState {
  return { kind: "idle" };
}

/**
 * Advances the recording state, ignoring events that do not apply to the
 * current phase. Ignoring rather than throwing is deliberate: a stop that
 * arrives after a failure, or a second click that beats the first response, is
 * a race the UI should absorb silently rather than a bug to surface.
 */
export function stepDeviceRecording(
  state: DeviceRecordingState,
  event: DeviceRecordingEvent,
): DeviceRecordingState {
  if (event.kind === "device-lost" || event.kind === "failed") {
    return { kind: "idle" };
  }
  switch (state.kind) {
    case "idle":
      return event.kind === "start-requested" ? { kind: "starting" } : state;
    case "starting":
      return event.kind === "started"
        ? { kind: "recording", path: event.path, startedAtMs: event.startedAtMs }
        : state;
    case "recording":
      return event.kind === "stop-requested" ? { kind: "stopping", path: state.path } : state;
    case "stopping":
      return event.kind === "stopped" ? { kind: "idle" } : state;
  }
}

/** Whether the toolbar's record button should read as active. */
export function isDeviceRecordingActive(state: DeviceRecordingState): boolean {
  return state.kind === "recording" || state.kind === "stopping";
}

/**
 * Which RPC a click on the record button should send, or null while a
 * transition is already in flight and a second call would be refused.
 */
export function deviceRecordingClickIntent(state: DeviceRecordingState): "start" | "stop" | null {
  if (state.kind === "idle") return "start";
  if (state.kind === "recording") return "stop";
  return null;
}

export interface DeviceSetupAction {
  readonly label: string;
  readonly url: string;
}

/**
 * The one thing the user can act on right now. Only Xcode installation has a
 * destination Synara can send them to — every other step either completes on
 * its own or is driven from Xcode itself — so the screen shows a single button
 * or none, rather than a row of links that mostly go nowhere.
 */
const DEVICE_SETUP_ACTIONS: Partial<Record<DeviceSetupStepId, DeviceSetupAction>> = {
  // The https form rather than macappstore://: the shell bridge only forwards
  // http(s), and macOS hands this link to the App Store app regardless.
  "install-xcode": {
    label: "Open Mac App Store",
    url: "https://apps.apple.com/app/xcode/id497799835",
  },
};

export function resolveDeviceSetupAction(
  steps: readonly DeviceSetupStep[],
): DeviceSetupAction | null {
  const next = steps.find((step) => !step.done);
  return next ? (DEVICE_SETUP_ACTIONS[next.id] ?? null) : null;
}

/**
 * The checklist re-reports on its own, so a "checking" line is only honest while
 * steps remain. Once everything is done the pane is about to flip to the picker
 * and a spinner would be a lie.
 */
export function deviceSetupCheckingLabel(steps: readonly DeviceSetupStep[]): string | null {
  const next = steps.find((step) => !step.done);
  if (!next) return null;
  return next.id === "install-xcode" ? "Checking for Xcode…" : "Checking your setup…";
}

// ── Thread state helpers ─────────────────────────────────────────────

export function attachedDeviceFromThreadState(
  state: ThreadDeviceState | undefined,
): DeviceDescriptor | null {
  if (!state?.attachedDeviceUdid) return null;
  return state.devices.find((device) => device.udid === state.attachedDeviceUdid) ?? null;
}

/**
 * A device the user picked, before the server has confirmed it.
 *
 * `supersedes` is the attachment the pick was made against. It is what tells a
 * selection still in flight from one the server has already answered: while the
 * thread still reports that old attachment, nothing has happened yet and the
 * pick stands; the moment it reports anything else, the server has spoken and
 * its answer wins — whether that is the picked device, or a different one an
 * agent claimed in the meantime.
 */
export interface PendingDeviceSelection {
  readonly device: DeviceDescriptor;
  readonly supersedes: DeviceUdid | null;
}

/**
 * The device the pane should be showing right now: the one the user just
 * picked, until the server's state catches up with that choice.
 *
 * Booting a cold simulator takes the better part of a minute, and until the
 * attach resolved the thread state named no device at all — so the picker sat
 * on "Choose a simulator" and the screen stayed blank while the machine was
 * visibly working. Preferring the pending selection makes the pane reflect the
 * intent immediately and reconcile when the real descriptor arrives.
 */
export function resolveDisplayedDevice(input: {
  readonly threadState: ThreadDeviceState | undefined;
  readonly pending: PendingDeviceSelection | null;
}): DeviceDescriptor | null {
  const attached = attachedDeviceFromThreadState(input.threadState);
  const { pending } = input;
  if (!pending) return attached;

  const reported = input.threadState?.attachedDeviceUdid ?? null;
  // The server has moved off the attachment this pick was made against, so its
  // answer is the current truth even when it is not the device that was picked.
  if (reported !== pending.supersedes) return attached;

  // Still pending. Prefer the thread's own copy of the descriptor where it has
  // one: it carries the live runtime state and the helper's measured geometry,
  // both fresher than the listing the pick came from.
  const known = input.threadState?.devices.find((device) => device.udid === pending.device.udid);
  return known ?? pending.device;
}

/**
 * What the phone's screen should say while an attachment comes up.
 *
 * Driven by the server's phase where there is one, because only the server
 * knows whether it is waiting on the boot or on the display. `selecting` is the
 * client-only stage before the first response, and every stage names the device
 * so the pane never shows an anonymous spinner.
 */
export function deviceAttachStatusLabel(input: {
  readonly phase: ThreadDeviceState["attachPhase"] | undefined;
  readonly deviceState: DeviceDescriptor["state"];
  readonly pendingSelection: boolean;
}): string | null {
  switch (input.phase) {
    case "booting":
      return "Starting up…";
    case "waiting-for-display":
      return "Waiting for the screen…";
    case "connecting":
      return "Connecting…";
    default:
      break;
  }
  if (input.deviceState === "booting") return "Starting up…";
  if (input.deviceState === "shutdown") return input.pendingSelection ? "Starting up…" : null;
  return input.pendingSelection ? "Connecting…" : null;
}

/**
 * The stream is only worth holding when the pane is live, a device is attached,
 * and that device is actually booted. Preview panes (restored but not yet
 * activated) and hidden tabs unsubscribe so a background thread never decodes
 * H.264 it will not paint.
 */
export function shouldSubscribeToDeviceStream(input: {
  readonly runtimeMode: "live" | "preview";
  readonly isVisible: boolean;
  readonly attachedDevice: DeviceDescriptor | null;
}): boolean {
  return (
    input.runtimeMode === "live" &&
    input.isVisible &&
    input.attachedDevice !== null &&
    input.attachedDevice.state === "booted"
  );
}
