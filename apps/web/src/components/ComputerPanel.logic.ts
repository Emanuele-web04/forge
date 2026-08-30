import {
  type ComputerAvailability,
  type ComputerFrameHeader,
  type ComputerHealth,
  type ComputerInputModifier,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenSize,
  type ThreadComputerState,
} from "@synara/contracts";

export interface ComputerFrameGateState {
  readonly lastSequence: number | null;
}

export type ComputerFrameGateAction = "ignore" | "drop-stale" | "decode";

export interface ComputerFrameGateStep {
  readonly state: ComputerFrameGateState;
  readonly action: ComputerFrameGateAction;
  readonly requestResync: boolean;
}

const UINT32_MODULUS = 0x1_0000_0000;
const UINT32_HALF_RANGE = 0x8000_0000;

export function createComputerFrameGateState(): ComputerFrameGateState {
  return { lastSequence: null };
}

export function stepComputerFrameGate(
  state: ComputerFrameGateState,
  header: Pick<ComputerFrameHeader, "computerId" | "sequence">,
  expectedComputerId: string,
): ComputerFrameGateStep {
  if (header.computerId !== expectedComputerId) {
    return { state, action: "ignore", requestResync: false };
  }

  if (state.lastSequence === null) {
    return { state: { lastSequence: header.sequence }, action: "decode", requestResync: false };
  }

  const distance = (header.sequence - state.lastSequence + UINT32_MODULUS) % UINT32_MODULUS;
  if (distance === 0 || distance >= UINT32_HALF_RANGE) {
    return { state, action: "drop-stale", requestResync: false };
  }

  return {
    state: { lastSequence: header.sequence },
    action: "decode",
    requestResync: distance > 1,
  };
}

export type ComputerAvailabilityView =
  | { readonly kind: "checking"; readonly title: string; readonly description: string }
  | { readonly kind: "ready"; readonly title: string; readonly description: string }
  | {
      readonly kind: "blocked";
      readonly title: string;
      readonly description: string;
    };

export function resolveComputerAvailabilityView(
  availability: ComputerAvailability | undefined,
  health?: ComputerHealth,
): ComputerAvailabilityView {
  // A pending retry is not a dead desktop, and the viewport must not say it is:
  // the frames stop either way, but one of the two states ends by itself.
  if (health?.status === "reconnecting") {
    return {
      kind: "checking",
      title: "Reconnecting to the desktop",
      description: health.lastFailure
        ? health.lastFailure.message
        : "The desktop backend dropped out and is being reconnected.",
    };
  }
  if (!availability) {
    return {
      kind: "checking",
      title: "Checking computer availability",
      description: "Waiting for the computer backend.",
    };
  }
  if (availability.kind === "available") {
    return {
      kind: "ready",
      title: "Computer control available",
      description: "The agent can use the desktop through its computer tools.",
    };
  }
  if (availability.kind === "unsupported-platform") {
    return {
      kind: "blocked",
      title: "Computer control is unavailable",
      description: "No computer backend is available on this server.",
    };
  }
  return {
    kind: "blocked",
    title: "Computer control is unavailable",
    description: availability.message,
  };
}

export interface ComputerHealthBadge {
  readonly label: string;
  readonly title: string;
  readonly tone: "warning" | "danger";
  /** A retry is in flight, which the dot animates; a dead backend is still. */
  readonly pulse: boolean;
}

/**
 * Header indicator for a backend that is not connected, or null while it is.
 * This outranks the lease and agent badges: whoever holds the desktop is beside
 * the point once there is no desktop to hold, and a dead backend explains every
 * failure the other two cannot.
 */
export function resolveComputerHealthBadge(
  health: ComputerHealth | undefined,
): ComputerHealthBadge | null {
  if (!health || health.status === "connected") return null;
  const reconnecting = health.status === "reconnecting";
  // A backend that has never connected AND never failed is not broken — it is
  // lazy. The server no longer connects at boot, so the first snapshot a pane
  // sees carries non-connected health with a clean record; opening the pane is
  // itself what engages the backend, and a real failure arrives with a
  // lastFailure to show. Badging the lazy state would flash "Desktop
  // unavailable" at every pane open on a perfectly healthy desktop.
  if (!reconnecting && health.consecutiveFailures === 0 && !health.lastFailure) return null;
  return {
    label: reconnecting ? "Reconnecting to desktop" : "Desktop unavailable",
    title: computerHealthDetail(health),
    tone: reconnecting ? "warning" : "danger",
    pulse: reconnecting,
  };
}

/** Counters belong in the badge's tooltip, not in chrome of their own. */
function computerHealthDetail(health: ComputerHealth): string {
  const parts = [
    health.status === "reconnecting"
      ? "The desktop backend dropped out and is being reconnected."
      : "The desktop backend is not connected.",
  ];
  if (health.lastFailure) parts.push(`Last failure: ${health.lastFailure.message}`);
  if (health.consecutiveFailures > 0) {
    parts.push(`Failed attempts since the last connection: ${health.consecutiveFailures}.`);
  }
  if (health.reconnects > 0) parts.push(`Reconnects since startup: ${health.reconnects}.`);
  return parts.join(" ");
}

export function shouldSubscribeToComputerStream(input: {
  readonly runtimeMode: "live" | "preview";
  readonly isVisible: boolean;
  readonly threadState: ThreadComputerState | undefined;
}): boolean {
  return (
    input.runtimeMode === "live" &&
    input.isVisible &&
    input.threadState?.availability.kind === "available"
  );
}

export interface ComputerContainRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function computerContainRect(input: {
  readonly source: ComputerScreenSize;
  readonly containerWidth: number;
  readonly containerHeight: number;
}): ComputerContainRect | null {
  if (
    !Number.isFinite(input.containerWidth) ||
    !Number.isFinite(input.containerHeight) ||
    input.containerWidth <= 0 ||
    input.containerHeight <= 0
  ) {
    return null;
  }
  const scale = Math.min(
    input.containerWidth / input.source.width,
    input.containerHeight / input.source.height,
  );
  const width = input.source.width * scale;
  const height = input.source.height * scale;
  return {
    left: (input.containerWidth - width) / 2,
    top: (input.containerHeight - height) / 2,
    width,
    height,
  };
}

// ── User input mapping ───────────────────────────────────────────────

/**
 * The desktop rect the drawn frame covers. The live stream is the whole
 * workspace today, so it is the screen rect at the origin; the parameter exists
 * because a windowed or zoomed stream would carry its own region, and every
 * caller already goes through this one conversion.
 */
export function computerStreamRegion(
  screenSize: ComputerScreenSize | undefined,
  region?: ComputerRect | undefined,
): ComputerRect | null {
  if (region) return region;
  if (!screenSize) return null;
  return { x: 0, y: 0, width: screenSize.width, height: screenSize.height };
}

/**
 * Inverts the letterbox: a pane pixel becomes the desktop logical pixel drawn
 * under it, or null when the pointer is on the padding beside the image. The
 * contain rect is the same geometry the ghost cursor is drawn with, so a click
 * lands exactly where the panel shows the cursor.
 */
export function computerViewportPointToDesktop(input: {
  readonly pointer: { readonly x: number; readonly y: number };
  readonly containRect: ComputerContainRect | null;
  readonly region: ComputerRect | null;
}): ComputerPoint | null {
  const { containRect, region, pointer } = input;
  if (!containRect || !region) return null;
  if (containRect.width <= 0 || containRect.height <= 0) return null;
  if (region.width <= 0 || region.height <= 0) return null;
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return null;

  const withinX = pointer.x - containRect.left;
  const withinY = pointer.y - containRect.top;
  if (withinX < 0 || withinY < 0 || withinX > containRect.width || withinY > containRect.height) {
    return null;
  }

  // Round to whole desktop pixels: the backend injects integral pointer
  // positions, and a fractional coordinate would be truncated inconsistently.
  // The right and bottom edges map onto the last pixel rather than one past it.
  return {
    x: clampToRange(
      Math.round(region.x + (withinX / containRect.width) * region.width),
      region.x,
      region.x + region.width - 1,
    ),
    y: clampToRange(
      Math.round(region.y + (withinY / containRect.height) * region.height),
      region.y,
      region.y + region.height - 1,
    ),
  };
}

function clampToRange(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** Matches the contract's per-event scroll ceiling. */
export const COMPUTER_SCROLL_DELTA_LIMIT = 4_096;
/** Typical line box, used to turn a line-mode wheel event into pixels. */
const COMPUTER_WHEEL_LINE_PX = 16;
/** A page-mode notch is a viewport jump; the desktop expects pixels. */
const COMPUTER_WHEEL_PAGE_PX = 400;

export interface ComputerWheelEventLike {
  readonly deltaX: number;
  readonly deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
}

/**
 * Wheel deltas in the desktop's pixel units, clamped so one runaway event (or a
 * coalesced burst) cannot spin the desktop through thousands of lines.
 */
export function computerWheelScrollDelta(event: ComputerWheelEventLike): {
  readonly deltaX: number;
  readonly deltaY: number;
} {
  const unit =
    event.deltaMode === 1
      ? COMPUTER_WHEEL_LINE_PX
      : event.deltaMode === 2
        ? COMPUTER_WHEEL_PAGE_PX
        : 1;
  return {
    deltaX: clampComputerScrollDelta(event.deltaX * unit),
    deltaY: clampComputerScrollDelta(event.deltaY * unit),
  };
}

/** Whole pixels inside the contract's range, used per event and per coalesced burst. */
export function clampComputerScrollDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clampToRange(Math.round(value), -COMPUTER_SCROLL_DELTA_LIMIT, COMPUTER_SCROLL_DELTA_LIMIT);
}

export interface ComputerKeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export interface ComputerKeyCommand {
  readonly key: string;
  readonly modifiers: readonly ComputerInputModifier[];
}

/**
 * DOM key names the seat can synthesize, lowercased. This mirrors the server's
 * server key name table rather than replacing it: the server stays the authority and
 * rejects anything else, but the pane must know what it may swallow, since a
 * key it forwards is a key the browser never sees.
 */
const FORWARDED_NAMED_KEYS: ReadonlySet<string> = new Set([
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);

const PRINTABLE_ASCII_MIN = 0x21;
const PRINTABLE_ASCII_MAX = 0x7e;

/**
 * Translates a keydown into one backend key press, or null for keys the seat
 * cannot express — modifier-only presses, IME composition, dead keys, and
 * non-ASCII characters the US-QWERTY table has no code for. A null must not be
 * swallowed by the pane: leaving it to the browser is the honest outcome.
 */
export function computerKeyCommand(event: ComputerKeyEventLike): ComputerKeyCommand | null {
  const key = resolveComputerKeyName(event.key);
  if (key === null) return null;

  const modifiers: ComputerInputModifier[] = [];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  // A printable character already encodes its own shift state ("A", "!"), so
  // adding the modifier would press shift a second time around the same stroke.
  if (event.shiftKey && key.length !== 1) modifiers.push("shift");
  if (event.metaKey) modifiers.push("meta");
  return { key, modifiers };
}

function resolveComputerKeyName(key: string): string | null {
  if (key === " " || key === "Spacebar") return "space";
  if (key.length === 1) {
    const codePoint = key.codePointAt(0) ?? 0;
    return codePoint >= PRINTABLE_ASCII_MIN && codePoint <= PRINTABLE_ASCII_MAX ? key : null;
  }
  const normalized = key.toLowerCase();
  return FORWARDED_NAMED_KEYS.has(normalized) ? normalized : null;
}

export function computerCursorPosition(input: {
  readonly cursor: ComputerPoint | undefined;
  readonly screenSize: ComputerScreenSize | undefined;
  readonly containRect: ComputerContainRect | null;
}): { readonly left: number; readonly top: number } | null {
  if (!input.cursor || !input.screenSize || !input.containRect) {
    return null;
  }
  return {
    left:
      input.containRect.left + (input.cursor.x / input.screenSize.width) * input.containRect.width,
    top:
      input.containRect.top + (input.cursor.y / input.screenSize.height) * input.containRect.height,
  };
}
