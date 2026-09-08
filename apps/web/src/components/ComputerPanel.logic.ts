import {
  COMPUTER_INPUT_SCROLL_LIMIT,
  COMPUTER_MAC_BACKEND,
  COMPUTER_NESTED_KWIN_BACKEND,
  COMPUTER_RELEASE_CONTROL_HOTKEY,
  COMPUTER_RELEASE_HOTKEY_BACKENDS,
  type ComputerActionEvent,
  type ComputerActionResult,
  type ComputerAvailability,
  type ComputerFrameHeader,
  type ComputerHealth,
  type ComputerInputModifier,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenSize,
  type ComputerStatusResult,
  type ComputerWindow,
  type ThreadComputerState,
} from "@synara/contracts";
import { isComputerNamedKey } from "@synara/shared/computerKeyNames";
import { listComputerPermissions } from "@synara/shared/computerPermissions";

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
      description: health.lastFailure ? health.lastFailure.message : COMPUTER_RECONNECTING_NOTE,
    };
  }
  if (!availability) {
    return {
      kind: "checking",
      title: "Checking computer availability",
      description: "Waiting for the desktop backend.",
    };
  }
  if (availability.kind === "available") {
    if (health && health.status !== "connected") {
      return {
        kind: "checking",
        title: "Computer access has not been checked",
        description: "Choose Set up to check that Synara can see and control the desktop.",
      };
    }
    if (health?.captureAvailable === false) {
      return {
        kind: "blocked",
        title: "Screen capture is unavailable",
        description:
          "Desktop input is connected, but Synara cannot take screenshots. Choose Set up to check access.",
      };
    }
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
      description: `This server is running on ${availability.platform}. Computer control needs macOS, or a Wayland desktop on Linux — KWin or Hyprland, or Synara's own nested desktop.`,
    };
  }
  // A withheld grant is blocked like anything else, but it is the one blocked
  // state with a name and a fix, so the title says which permission rather than
  // making the user read the paragraph to find out.
  if (availability.kind === "permission-required") {
    return {
      kind: "blocked",
      title: `Computer control needs ${listComputerPermissions(availability.missing)}`,
      description: availability.message,
    };
  }
  return {
    kind: "blocked",
    title: "Computer control is unavailable",
    description: availability.message,
  };
}

/**
 * Whether this desktop still needs something installed or granted — the test
 * behind the settings panel's "Set up" button and behind the chat setup card's
 * "did that work?" answer, which must agree.
 *
 * Keyed on live state, never on the static capability flags alone. Those
 * describe what the backend *is able to* do — on macOS the helper advertises
 * input and capture on a machine that has been granted neither, so a
 * capabilities-only test never offers Set up at all. What separates "nothing to
 * do" from "not ready" is whether a backend resolved, whether it can currently
 * capture, and only then whether it claims the two abilities. A platform that
 * can never run this is not a machine with something left to install.
 *
 * Typed on the three fields rather than on `ComputerStatusResult`, because the
 * thread-scoped state a chat receives by push carries the same three and has to
 * be answerable by the same question — the chat's setup card reads the live
 * thread state, the settings panel reads the polled status, and a second copy
 * of this rule for the other shape is how they would start disagreeing.
 */
export type ComputerSetupProbe = Pick<
  ComputerStatusResult,
  "availability" | "health" | "capabilities"
>;

export function computerStatusNeedsSetup(status: ComputerSetupProbe | undefined): boolean {
  if (!status) return false;
  if (status.availability.kind === "unsupported-platform") return false;
  return (
    status.availability.kind === "backend-unavailable" ||
    status.availability.kind === "permission-required" ||
    status.health.captureAvailable === false ||
    !status.capabilities.input ||
    !status.capabilities.capture
  );
}

/**
 * What the chat's setup card should say right now, from live state alone.
 *
 * The card used to latch: a boolean was set once inside the provision callback
 * and never cleared, so every later card in that conversation claimed "Computer
 * control is ready" — including after a rebuild invalidated the cdhash the
 * grant was pinned to. And because only that callback could set it, the
 * *expected* path — the user allowing the dialog macOS had already put on
 * screen, without pressing anything in Synara — left the card saying "needs
 * Accessibility" forever.
 *
 * So there is no remembered answer here at all: `unknown` while no live state
 * has arrived (the conservative reading — offer Set up rather than claim
 * readiness), and otherwise whatever the desktop currently reports.
 */
export type ComputerControlReadiness = "unknown" | "ready" | "needs-setup";

export function computerControlReadiness(
  state: ComputerSetupProbe | undefined,
): ComputerControlReadiness {
  if (!state) return "unknown";
  return computerStatusNeedsSetup(state) ? "needs-setup" : "ready";
}

/**
 * Whether the desktop this backend drives is the one the user is looking at.
 *
 * The distinction decides real UI, not just wording. On a shared desktop the
 * server never asks Synara to open a Computer pane — the actions are already
 * happening on the screen in front of the user, and
 * `ComputerManager.surfacePaneForAgent` returns early — so the "Open
 * automatically" preference controls nothing, and the pane's interactive mode
 * would be a second cursor fighting the user's own on their real machine.
 */
export function computerBackendIsVisibleDesktop(
  state: Pick<ComputerStatusResult, "capabilities"> | undefined,
): boolean {
  return state?.capabilities.visibleDesktop === true;
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

/**
 * How a non-connected backend is described, in one place.
 *
 * Three surfaces said this — the pane's blocked view, the header badge's
 * tooltip, and the settings panel's health notes — and three copies is three
 * chances to describe the same supervision state differently.
 */
export const COMPUTER_RECONNECTING_NOTE =
  "The desktop backend dropped out and is being reconnected.";
const COMPUTER_DISCONNECTED_NOTE = "The desktop backend is not connected.";

/** The note naming what the supervisor last saw fail, or null when nothing has. */
export function computerLastFailureNote(health: ComputerHealth | undefined): string | null {
  return health?.lastFailure ? `Last failure: ${health.lastFailure.message}` : null;
}

/** The note counting reconnects since startup, or null when there were none. */
export function computerReconnectsNote(health: ComputerHealth | undefined): string | null {
  const reconnects = health?.reconnects ?? 0;
  if (reconnects <= 0) return null;
  return `Reconnected ${reconnects === 1 ? "once" : `${reconnects} times`} since startup.`;
}

/** Counters belong in the badge's tooltip, not in chrome of their own. */
function computerHealthDetail(health: ComputerHealth): string {
  const parts = [
    health.status === "reconnecting" ? COMPUTER_RECONNECTING_NOTE : COMPUTER_DISCONNECTED_NOTE,
  ];
  const lastFailure = computerLastFailureNote(health);
  if (lastFailure) parts.push(lastFailure);
  if (health.consecutiveFailures > 0) {
    parts.push(`Failed attempts since the last connection: ${health.consecutiveFailures}.`);
  }
  const reconnects = computerReconnectsNote(health);
  if (reconnects) parts.push(reconnects);
  return parts.join(" ");
}

/**
 * The emergency-release hint for the viewport, or null where it would be a lie.
 *
 * The hotkey is a compositor shortcut the KWin and Hyprland plugins register,
 * so it exists only on those backends. It also has to be the human's own
 * compositor: a nested, offscreen KWin session registers the
 * same shortcut, but the host desktop the human is typing at never routes keys
 * into it. The hint is also only worth the pixels while the agent is acting.
 */
export interface ComputerReleaseControlHint {
  readonly text: string;
  /** Whether it is worth the pixels right now; the text stays put so it can fade. */
  readonly visible: boolean;
}

export function computerReleaseControlHint(input: {
  readonly availability: ComputerAvailability | undefined;
  readonly visibleDesktop: boolean;
  readonly agentActive: boolean;
}): ComputerReleaseControlHint | null {
  const availability = input.availability;
  if (
    availability?.kind !== "available" ||
    availability.backend === undefined ||
    !COMPUTER_RELEASE_HOTKEY_BACKENDS.includes(availability.backend) ||
    !input.visibleDesktop
  ) {
    return null;
  }
  return {
    text: `Press ${COMPUTER_RELEASE_CONTROL_HOTKEY} to stop the agent at any time.`,
    visible: input.agentActive,
  };
}

/**
 * What the canvas is a picture of, for a screen reader.
 *
 * It said "Linux desktop" on every backend, including the Mac one, which is
 * both wrong and the single most important fact about the surface: whether the
 * agent is driving a sandbox or the machine the user is sitting at.
 */
export function computerCanvasLabel(input: {
  readonly availability: ComputerAvailability | undefined;
  readonly visibleDesktop: boolean;
}): string {
  const backend = input.availability?.kind === "available" ? input.availability.backend : undefined;
  if (backend === COMPUTER_MAC_BACKEND) return "This Mac's desktop";
  if (backend === COMPUTER_NESTED_KWIN_BACKEND) return "The agent's own desktop";
  if (input.visibleDesktop) return "This computer's desktop";
  return "The agent's desktop";
}

/**
 * Whether the pane may forward the user's own clicks and keys to the desktop.
 *
 * Two separate refusals, and the first is not a policy but a category error: on
 * a backend that shows the desktop the user is already sitting at, the pane is a
 * mirror. Clicking it means clicking a picture of your own screen — including a
 * picture of Synara, recursively — to reach something you could reach directly,
 * with a round trip's worth of staleness in between. There is nothing to
 * interact *with* that the mouse in the user's hand cannot reach first.
 *
 * The second is the desktop lease: while an agent is acting, pane input and the
 * agent's input interleave on the same seat with no ordering between them, so a
 * stray click lands in the middle of a drag. The pane does not take a lease, so
 * the gate is the only thing standing between the two.
 */
export function computerPaneInputMode(input: {
  readonly streamEnabled: boolean;
  readonly visibleDesktop: boolean;
  readonly agentActive: boolean;
}): "hidden" | "blocked-by-agent" | "available" {
  if (input.visibleDesktop) return "hidden";
  if (!input.streamEnabled) return "hidden";
  return input.agentActive ? "blocked-by-agent" : "available";
}

/**
 * Whether to offer "Stop the agent" in the pane header, and what it means here.
 *
 * On a shared desktop this is the *only* stop there is: the emergency release is
 * a compositor shortcut the KWin and Hyprland plugins register, and macOS has no
 * such global — so `computerReleaseControlHint` is correctly null there and the
 * user is left watching their own machine being driven with nothing to press.
 * Stopping the turn is what actually ends it: the desktop lease is released the
 * moment the owning thread stops being able to drive
 * (`ComputerManager.releaseDesktopControl`, on turn end).
 */
export function computerStopControlLabel(input: {
  readonly agentActive: boolean;
  readonly visibleDesktop: boolean;
}): string | null {
  if (!input.agentActive) return null;
  return input.visibleDesktop
    ? "Stop the agent controlling this computer"
    : "Stop the agent controlling the desktop";
}

/**
 * The one delivery verdict a person needs to see.
 *
 * `confirmed` and `unverifiable` are both "nothing is wrong" — most native
 * controls expose no readable value at all, so `unverifiable` is the ordinary
 * answer and reporting it would train the user to ignore the row. `unconfirmed`
 * is the backend saying it looked and could not see its own input arrive, which
 * is the one case where what is on screen may not be what was asked for.
 */
export function computerDeliveryWarning(
  result: Pick<ComputerActionResult, "delivery"> | undefined,
): string | null {
  return result?.delivery?.verified === "unconfirmed"
    ? "The desktop accepted that input but could not confirm it arrived. Check the screen before relying on it."
    : null;
}

/**
 * The newest desktop action, in the words a person would use.
 *
 * The backend's `action` is a tool-shaped identifier (`computer_double_click`,
 * `type_text`) and the pane is not a log viewer, so it is spoken rather than
 * printed. A failure keeps its message, because that is the only part of a
 * failed action worth the space.
 */
export function computerActionLabel(
  action: Pick<ComputerActionEvent, "action" | "ok" | "message"> | undefined,
): string | null {
  if (!action) return null;
  const spoken = action.action
    .replace(/^computer[_.]/, "")
    .replace(/[_.]+/g, " ")
    .trim();
  if (spoken.length === 0) return null;
  const capitalized = `${spoken[0]!.toUpperCase()}${spoken.slice(1)}`;
  if (action.ok) return capitalized;
  return action.message ? `${capitalized} failed: ${action.message}` : `${capitalized} failed`;
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
  return clampToRange(Math.round(value), -COMPUTER_INPUT_SCROLL_LIMIT, COMPUTER_INPUT_SCROLL_LIMIT);
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
  // The shared named-key vocabulary, which the server's evdev table is built
  // from too: the pane must swallow exactly the keys the seat can synthesize,
  // since a key it forwards is a key the browser never sees. Modifiers are
  // deliberately not in that list — the browser needs to see a bare modifier
  // press to keep its own state straight.
  const normalized = key.toLowerCase();
  return isComputerNamedKey(normalized) ? normalized : null;
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

/** The action, target application, and actual delivery mode for the desktop overlay. */
export function computerActionStatusLabel(
  action: ComputerActionEvent | undefined,
  windows: readonly ComputerWindow[] | undefined,
): string | null {
  const label = computerActionLabel(action);
  if (!label) return null;
  const app = windows?.find((window) => window.id === action?.windowId)?.appName;
  const path = action?.delivery?.path;
  const delivery = path
    ? path.includes("foreground")
      ? "Brought app forward"
      : "Background input"
    : undefined;
  return [label, app, delivery].filter(Boolean).join(" · ");
}
