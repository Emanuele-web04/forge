import {
  COMPUTER_MESSAGE_MAX_LENGTH,
  type ComputerActionResult,
  type ComputerAvailability,
  type ComputerCapabilities,
  type ComputerHealth,
  type ComputerId,
  type ComputerLaunchAppResult,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenSize,
  type ComputerScreenshot,
  type ComputerState,
  type ComputerTarget,
  type ComputerUiNode,
  type ComputerWindow,
} from "@synara/contracts";

/** Longest screenshot side in pixels before a capture is downscaled. */
export const DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION = 2_048;
/**
 * The budget a post-action observation spends, rather than the perception one.
 *
 * Image tokens scale with pixel area — roughly `width * height / 750` — so the
 * temptation is to shrink every after-action shot hard. A tighter 1024 budget
 * did save tokens, but it lost the precision the agent needs to read a dense
 * form or aim at a small field, and the cost came back as mis-aimed clicks and
 * extra re-screenshots that were both slower and more expensive than the shot
 * they replaced. So this matches the height of a typical application window:
 * a browser or editor at ~1400 px tall is captured at full resolution, only a
 * genuinely large capture is scaled, and the real savings comes from the
 * byte-identical dedupe (`screenshotUnchanged`) that never resends a frame that
 * did not change — a token win with no quality cost at all. When still more
 * detail is needed, `computer_screenshot` zooms in at the perception budget with
 * the identical `region`/`scale` mapping.
 */
export const COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION = 1_536;
/** Native per-side image limit enforced by a backend. */
export const MAX_COMPUTER_CAPTURE_MAX_DIMENSION = 16_384;
/**
 * Largest clipboard payload a backend moves in either direction. Clipboards
 * hold whole documents, so both directions need a ceiling: without one a read
 * would stream unbounded data into a turn and a write would pipe it back out.
 */
export const MAX_COMPUTER_CLIPBOARD_BYTES = 1024 * 1024;

/**
 * A zoomed capture request: one window, or one rect of the global desktop
 * coordinate space that window bounds and pointer actions already use.
 */
export type ComputerCaptureRequest =
  | { readonly kind: "window"; readonly windowId: string; readonly maxDimension?: number }
  | { readonly kind: "region"; readonly region: ComputerRect; readonly maxDimension?: number };

export interface ComputerStreamFrame {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
  readonly data: Uint8Array;
}

export interface ComputerResolvedTarget {
  readonly target: ComputerTarget;
  readonly point: ComputerPoint;
  readonly node: ComputerUiNode;
}

export interface ComputerBackendActionResult {
  readonly point?: ComputerPoint;
  /**
   * Set when the display server refused the requested point and moved the
   * pointer elsewhere, which happens on multi-monitor layouts whose global
   * coordinate space has gaps between outputs.
   */
  readonly clampedTo?: ComputerPoint;
  readonly windowId?: string;
  readonly value?: string;
}

export type ComputerBackendEvent =
  | { readonly type: "windows-changed"; readonly windows: readonly ComputerWindow[] }
  | { readonly type: "health-changed"; readonly health: ComputerHealth }
  | { readonly type: "capabilities-changed"; readonly capabilities: ComputerCapabilities }
  | { readonly type: "frame"; readonly frame: ComputerStreamFrame };

export type ComputerFrameListener = (frame: ComputerStreamFrame) => void;
export type ComputerBackendEventListener = (event: ComputerBackendEvent) => void;

export class ComputerBackendError extends Error {
  readonly retryable: boolean;
  /**
   * The call the desktop declined, when the failure was a refusal rather than a
   * fault. A refusal means nothing was injected, which is what lets a caller
   * explain the miss instead of reporting a generic failure.
   */
  readonly rejectedOperation: string | undefined;

  constructor(
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly cause?: unknown;
      readonly rejectedOperation?: string;
    } = {},
  ) {
    super(message, options);
    this.name = "ComputerBackendError";
    this.retryable = options.retryable ?? false;
    this.rejectedOperation = options.rejectedOperation;
  }
}

/**
 * What a backend that does not exist can do, which is nothing.
 *
 * Used where a state payload has to be produced with no backend behind it — an
 * unsupported host, a service that never started. The alternative is omitting
 * the field, and an absent capability set reads as a fully capable one, which
 * is how a panel ends up offering desktop control on a machine that has none.
 */
export const NO_COMPUTER_CAPABILITIES: ComputerCapabilities = {
  windows: false,
  windowBounds: false,
  stacking: false,
  capture: false,
  input: false,
  clipboard: false,
  activation: false,
  ghostCursor: false,
  visibleDesktop: false,
};

/** Provider-side contract shared by real display backends and the CI fake. */
export interface ComputerBackend {
  readonly computerId: ComputerId;
  /**
   * Whether this host could drive a desktop, answered without doing anything to
   * it. Side-effect-free by contract: no session is started, nothing is
   * installed, nothing is loaded into a compositor, and no connection outlives
   * the call — the most a backend may spend is the cheap questions a desktop
   * answers for free, such as who owns a bus name and what is on disk.
   *
   * This is what boot and the UI's thread-state seeding read, because both run
   * for every user on every launch, long before anyone has asked for a desktop.
   * `availability()` is the opposite trade: it establishes the real thing and
   * reports what actually happened, so it belongs only on paths that were about
   * to use the desktop anyway.
   *
   * Optimism is the intended failure mode. A probe that says "available" and
   * then fails at first use costs the caller one actionable error card; a probe
   * that says "unavailable" because it refused to look costs the user the
   * feature.
   */
  probeAvailability(): Promise<ComputerAvailability>;
  /**
   * Availability as established, not as guessed: this may connect, install, and
   * load whatever the backend needs, so it belongs on paths that are about to
   * use the desktop. See `probeAvailability` for the passive counterpart.
   */
  availability(): Promise<ComputerAvailability>;

  /**
   * Live supervision health. Synchronous and side-effect free on purpose: it
   * reports what the connect and reconnect paths already know, so reading it
   * can never cost the display server a round trip, and it stays safe to call
   * from the handler of the very event that changed it. Transitions arrive
   * through `onEvent` as `health-changed`.
   */
  health(): ComputerHealth;
  /**
   * What this backend can do, decided by which providers its probe resolved.
   * Synchronous and cheap by contract: a capability is a property of the
   * display server this process is talking to, not a live reading, so it is
   * safe to publish with every state snapshot. It changes for exactly one
   * reason — provisioning installed something the construction probe did not
   * see — and that transition arrives through `onEvent` as
   * `capabilities-changed`, so a caller may cache this until that event fires.
   */
  capabilities(): ComputerCapabilities;
  listWindows(): Promise<readonly ComputerWindow[]>;
  getScreenSize(): Promise<ComputerScreenSize>;
  getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeText?: boolean;
  }): Promise<ComputerState>;
  /**
   * Zoomed perception. `getState` downscales the whole multi-monitor workspace
   * into one screenshot, which loses small text; this captures a single window
   * or region at a far higher effective resolution and returns the same
   * `region` + `scale` mapping so pixels still convert to desktop coordinates.
   */
  captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot>;
  /** Pin or release the target window when supported. */
  focusWindow?(windowId: string): Promise<void>;
  /**
   * Restack a window above the ones covering it, without moving the user's
   * keyboard focus. Focus alone routes the agent's input to the window even
   * while it is buried, which leaves the human watching a click land on pixels
   * they cannot see.
   */
  raiseWindow?(windowId: string): Promise<void>;
  clearFocusWindow?(): Promise<void>;
  /**
   * Names the thread currently holding the desktop, for backends that draw an
   * agent cursor the human can see. `null` when nobody holds it. Best effort by
   * design: a label is presentation, so failing to set one must never fail the
   * action that changed the holder.
   */
  setDrivingAgent?(name: string | null): Promise<void>;
  launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult>;
  click(point: ComputerPoint): Promise<ComputerBackendActionResult | void>;
  doubleClick(point: ComputerPoint): Promise<ComputerBackendActionResult | void>;
  rightClick(point: ComputerPoint): Promise<ComputerBackendActionResult | void>;
  moveCursor(point: ComputerPoint): Promise<ComputerBackendActionResult | void>;
  drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<ComputerBackendActionResult | void>;
  scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerBackendActionResult | void>;
  typeText(text: string): Promise<ComputerBackendActionResult | void>;
  pressKey(key: string): Promise<ComputerBackendActionResult | void>;
  hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult | void>;
  /**
   * The system clipboard the human user shares, not an agent-private one.
   * Toolkits bind their data device to the session's primary seat whichever
   * seat delivered the input, so a dedicated agent seat cannot own a working
   * clipboard of its own: reading returns whatever anyone last copied, and
   * writing replaces it for the human too.
   */
  readClipboard?(): Promise<string>;
  /** Writes the same shared system clipboard `readClipboard` reads. */
  writeClipboard?(text: string): Promise<void>;
  setValue(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<ComputerBackendActionResult | void>;
  performAction(
    target: ComputerResolvedTarget,
    action: string,
  ): Promise<ComputerBackendActionResult | void>;
  onEvent?(listener: ComputerBackendEventListener): () => void;
  attachStream(listener: ComputerFrameListener): Promise<void>;
  detachStream(): Promise<void>;
  requestKeyframe?(): Promise<void>;
  dispose(): Promise<void> | void;
}

/**
 * Overlap of two desktop rects, or `undefined` when they do not overlap. Both
 * backends clip a capture request to what actually exists on the workspace, so
 * the region metadata describes the pixels the caller really received.
 */
export function intersectComputerRects(
  first: ComputerRect,
  second: ComputerRect,
): ComputerRect | undefined {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Message text that satisfies the contract's bound on availability and health
 * strings. Both are built from error text the backend does not control — a
 * D-Bus payload, a backend diagnostic — so an empty or oversized message must
 * degrade here rather than fail the state payload carrying it.
 */
export function clampComputerMessage(text: string, fallback: string): string {
  const trimmed = text.trim();
  const message = trimmed.length > 0 ? trimmed : fallback;
  return message.length > COMPUTER_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, COMPUTER_MESSAGE_MAX_LENGTH - 1)}…`
    : message;
}

export function computerBackendActionResult(
  computerId: string,
  action: string,
  result: ComputerBackendActionResult | void,
): ComputerActionResult {
  return {
    computerId,
    action,
    ...(result?.point ? { point: result.point } : {}),
    ...(result?.clampedTo ? { clampedTo: result.clampedTo } : {}),
    ...(result?.windowId ? { windowId: result.windowId } : {}),
    ...(result?.value !== undefined ? { value: result.value } : {}),
  } as ComputerActionResult;
}
