import { MODEL_SCREEN_IMAGE_MAX_DIMENSION } from "@synara/shared/modelImageBudget";
import {
  COMPUTER_DELIVERY_PATH_MAX_LENGTH,
  COMPUTER_MESSAGE_MAX_LENGTH,
  type ComputerActionResult,
  type ComputerAvailability,
  type ComputerBuildSignature,
  type ComputerCapabilities,
  type ComputerDeliveryVerification,
  type ComputerHealth,
  type ComputerId,
  type ComputerInputModifier,
  type ComputerInputPause,
  type ComputerLaunchAppResult,
  type ComputerPermission,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenSize,
  type ComputerScreenshot,
  type ComputerState,
  type ComputerTarget,
  type ComputerUiNode,
  type ComputerWindow,
} from "@synara/contracts";

/**
 * The longest side, in pixels, of any screenshot handed to a model.
 *
 * This is a correctness bound before it is a cost one. Vision APIs downscale an
 * image whose long edge exceeds roughly 1568 px before the model ever sees it,
 * and the model then reads coordinates off a picture the server never produced:
 * at the old 2048 budget every pixel the model pointed at was mapped against an
 * image 1.33x larger than the one it looked at, so every click landed short and
 * consistently up-and-left. Nothing in this pipeline may depend on API-side
 * resizing — Synara does the downscale itself, records the resulting frame, and
 * maps the model's pixels through the frame it actually delivered.
 *
 * 1536 rather than something smaller because image tokens scale with area and
 * the temptation is to shrink hard: a 1024 budget did save tokens, but it lost
 * the precision needed to read a dense form or aim at a small field, and the
 * cost came back as mis-aimed clicks and extra re-screenshots that were slower
 * and more expensive than the shot they replaced. At 1536 a browser or editor
 * window comes back at full resolution, only a genuinely large capture is
 * scaled, and the real savings comes from the byte-identical dedupe
 * (`screenshotUnchanged`) that never resends an unchanged frame at all.
 */
export const COMPUTER_AGENT_IMAGE_MAX_DIMENSION = MODEL_SCREEN_IMAGE_MAX_DIMENSION;
/**
 * Longest screenshot side in pixels before a capture is downscaled. Identical
 * to the observation budget, and for the identical reason: both pictures are
 * read by the same eyes and pointed at through the same frame registry.
 */
export const DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION = COMPUTER_AGENT_IMAGE_MAX_DIMENSION;
/** The budget a post-action observation spends. See the constant above. */
export const COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION = COMPUTER_AGENT_IMAGE_MAX_DIMENSION;
/** Native per-side image limit enforced by the KWin capture path. */
export const MAX_COMPUTER_CAPTURE_MAX_DIMENSION = 16_384;
/**
 * Largest clipboard payload a backend moves in either direction. Clipboards
 * hold whole documents, so both directions need a ceiling: without one a read
 * would stream unbounded data into a turn and a write would pipe it back out.
 */
export const MAX_COMPUTER_CLIPBOARD_BYTES = 1024 * 1024;

/**
 * The id every real desktop backend reports for the one computer it drives.
 *
 * Shared rather than repeated because it is the key the frame socket, the pane,
 * and the thread state all address that desktop by: two backends spelling it
 * differently would route a frame to a pane that is not listening.
 */
export const DEFAULT_COMPUTER_ID = "desktop";

/**
 * Refuses a clipboard write past `MAX_COMPUTER_CLIPBOARD_BYTES`.
 *
 * One check for every backend: the Linux path enforced it and the macOS one did
 * not, so the same document that was refused on one desktop was piped through a
 * line-framed helper on the other.
 */
export function assertComputerClipboardWriteFits(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_COMPUTER_CLIPBOARD_BYTES) return;
  throw new ComputerBackendError(
    `Clipboard text is ${bytes} bytes, past the ${MAX_COMPUTER_CLIPBOARD_BYTES} byte limit this tool writes.`,
  );
}

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
  /**
   * Which rung of a backend's delivery ladder actually ran, and what the backend
   * could establish about the outcome.
   *
   * The macOS helper answers both for every input it delivers — keyboard and
   * pointer alike — naming the rung it took (`ax-insert`, `keystrokes`,
   * `foreground`, and so on). `verified` is deliberately three-valued:
   * `confirmed` means the effect was read back, `unconfirmed` means the read-back
   * was attempted and did not show it, and `unverifiable` means the surface
   * exposes no readable value to check against — the ordinary answer for most
   * native controls, and not a sign that anything went wrong.
   *
   * `computerBackendActionResult` projects the pair onto the wire result's
   * optional `delivery` (clamping the path there, so every backend that reports
   * one is bounded by the same rule), so the agent reading a tool result sees
   * the verdict too. Backends with no delivery ladder leave both unset and their
   * results are unchanged.
   */
  readonly deliveryPath?: string;
  readonly verified?: ComputerDeliveryVerification;
  readonly effect?: "not-dispatched" | "dispatched-unknown" | "verified";
  /** Native wheel units converted to injected pixel deltas, before app handling. */
  readonly scrollDelta?: { readonly deltaX: number; readonly deltaY: number };
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
   * The failure is a decision, not a fault: the backend's desktop is
   * deliberately not running right now, and only a real use may start it.
   * Automatic supervision that sees this must report the message and stand
   * down, because retrying cannot conjure a desktop the backend refused to
   * boot — and on a backend that boots on demand, a retry that did boot would
   * respawn a window the human just closed.
   */
  readonly dormant: boolean;
  /**
   * The call the desktop declined, when the failure was a refusal rather than a
   * fault. A refusal means nothing was injected, which is what lets a caller
   * explain the miss instead of reporting a generic failure.
   */
  readonly rejectedOperation: string | undefined;
  /**
   * The desktop refused because the OS has not granted Synara a privacy
   * permission it needs — macOS Screen Recording or Accessibility today. Only
   * the backend can tell this apart from an ordinary action failure, so it is
   * marked here rather than guessed from message text further up: the agent
   * gateway turns exactly this flag into the chat's "needs setup" card, and a
   * card raised for a window that merely moved would be noise.
   */
  readonly setupRequired: boolean;
  /** A recoverable input refusal; observation remains available. */
  readonly inputPause: ComputerInputPause | undefined;

  constructor(
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly dormant?: boolean;
      readonly cause?: unknown;
      readonly rejectedOperation?: string;
      readonly setupRequired?: boolean;
      readonly inputPause?: ComputerInputPause;
    } = {},
  ) {
    super(message, options);
    this.name = "ComputerBackendError";
    this.retryable = options.retryable ?? false;
    this.dormant = options.dormant ?? false;
    this.rejectedOperation = options.rejectedOperation;
    this.setupRequired = options.setupRequired ?? false;
    this.inputPause = options.inputPause;
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
  focus: false,
  raise: false,
  ghostCursor: false,
  visibleDesktop: false,
};

/**
 * Which desktop vocabulary a backend speaks.
 *
 * Not a platform label for its own sake: three agent-facing descriptions are
 * only true of one family — what a keyboard shortcut may contain, which
 * semantic action names the accessibility layer accepts, and what an
 * application identifier looks like — and describing the other family's answer
 * teaches the model to send calls that are guaranteed to be refused. The tool
 * surface branches on this rather than on a delivery flag that happened to
 * correlate with the platform.
 */
export type ComputerAgentDialect = "linux" | "macos";

/** Provider-side contract shared by real display backends and the CI fake. */
export interface ComputerBackend {
  /**
   * The vocabulary this desktop speaks, for the tool descriptions that differ
   * by family. Absent means `"linux"`: the evdev + AT-SPI pair every backend
   * but the macOS one uses.
   */
  readonly agentDialect?: ComputerAgentDialect;
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
   * then cannot provision costs the caller one actionable error card at first
   * use; a probe that says "unavailable" because it refused to look costs the
   * user the feature.
   */
  probeAvailability(): Promise<ComputerAvailability>;
  /**
   * Availability as established, not as guessed: this may connect, install, and
   * load whatever the backend needs, so it belongs on paths that are about to
   * use the desktop. See `probeAvailability` for the passive counterpart.
   */
  availability(): Promise<ComputerAvailability>;

  /**
   * Install or compile whatever this backend needs, on explicit request.
   *
   * Optional because not every backend has anything to provision: the fake and
   * the unavailable backends have nothing, and a nested session's compositor
   * arrived with its own. A backend that implements it returns one sentence
   * describing what it did, for the settings card that asked.
   */
  provision?(): Promise<string>;
  /**
   * Live supervision health. Synchronous and side-effect free on purpose: it
   * reports what the connect and reconnect paths already know, so reading it
   * can never cost the display server a round trip, and it stays safe to call
   * from the handler of the very event that changed it. Transitions arrive
   * through `onEvent` as `health-changed`.
   */
  health(): ComputerHealth;
  /**
   * What this backend can do once it is up. Synchronous and cheap by contract:
   * a capability is a property of the display server this process talks to, not
   * a live reading, so it is safe to publish with every state snapshot.
   *
   * Two things it deliberately is *not*. It is not a permission report: an OS
   * grant the user has withheld leaves the capability true and shows up in
   * `probeAvailability()` (`permission-required`) or, for screen capture, in
   * `health().captureAvailable` — the macOS backend advertises the full set on
   * a Mac that has granted it nothing. And it is not a live reading of the
   * running session: only the nested backend varies it at all, reporting the
   * empty set until its compositor and plugin exist so the settings panel can
   * offer Set up, and the full KWin set afterwards. That one transition arrives
   * through `onEvent` as `capabilities-changed`, so a caller may cache this
   * until the event fires.
   */
  capabilities(): ComputerCapabilities;
  /**
   * OS privacy grants this backend needs and does not have, established rather
   * than remembered.
   *
   * Asynchronous because the answer is only allowed to be stale in one
   * direction. The tool surface consults this after every computer call to
   * decide whether the user is owed a setup card, and the moment that matters
   * most is the one just after the user granted something: a cached "missing"
   * kept the card and the model's refusal on screen while the grant was already
   * live, which is the exact failure this signature exists to prevent. A backend
   * that knows nothing is missing answers from memory and costs nothing; one
   * whose last look saw a gap has to look again (behind its own short cache, so
   * a burst of calls still pays for one probe).
   *
   * Empty means either "nothing is missing" or "nothing has looked yet" — both
   * are states in which no user action is owed, so they need not be told apart
   * here.
   *
   * Optional because only macOS has a permission model at all; a backend that
   * omits it is read as missing nothing. `availability()` reports the *blocking*
   * subset of this as `permission-required`; a grant that only degrades the
   * desktop (Screen Recording) shows up here and nowhere else.
   */
  missingPermissions?(): Promise<readonly ComputerPermission[]>;
  /**
   * How this build is code-signed, as the last probe read it, or undefined when
   * nothing has looked yet or the backend has no permission model.
   *
   * Synchronous and free: it is a property of the binary, not a live reading.
   * It travels beside `missingPermissions()` because a missing grant on an
   * ad-hoc build has a second, invisible explanation — the grant is pinned to a
   * cdhash a rebuild replaced — and the card cannot say so without knowing this.
   */
  buildSignature?(): ComputerBuildSignature | undefined;
  listWindows(): Promise<readonly ComputerWindow[]>;
  getScreenSize(): Promise<ComputerScreenSize>;
  getState(options: {
    readonly includeScreenshot?: boolean;
    /**
     * Walk the accessibility tree and return it as `root`.
     *
     * Named for what it costs rather than for what one caller does with it: the
     * agent tool surface needs the tree on every perception read (that is where
     * the elements list comes from) and the text rendering almost never, and
     * while this flag was called `includeText` every backend rendered the whole
     * desktop to prose on each of those reads and the caller threw it away.
     * Rendering now belongs to `ComputerManager`, which knows whether anyone
     * asked for it.
     */
    readonly includeTree?: boolean;
    readonly windowId?: string;
  }): Promise<ComputerState>;
  /**
   * Zoomed perception. `getState` downscales the whole multi-monitor workspace
   * into one screenshot, which loses small text; this captures a single window
   * or region at a far higher effective resolution and returns the same
   * `region` + `scale` mapping so pixels still convert to desktop coordinates.
   */
  captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot>;
  /** Pin or release the plugin's per-seat target window when supported. */
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
  /** Cosmetic activity only: never activates a window or sends input. */
  setCursorActivity?(text: string | null): Promise<void>;
  launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult>;
  /** Fresh exact-window readiness only; never focus, raise, or send input. */
  checkInputReady?(windowId: string): Promise<void>;
  /**
   * `windowId` is the window the caller resolved this point to, when it named
   * one. A backend that injects at a screen coordinate ignores it — whatever is
   * stacked at that point receives the event either way. A backend that posts to
   * a window by id uses it as the delivery target, which is what makes a click
   * on a partially covered window reach the window the caller meant rather than
   * the one drawn on top of it.
   */
  click(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult | void>;
  doubleClick(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult | void>;
  /**
   * Three clicks close enough together for a toolkit to pair them, which is
   * what selects a whole line or paragraph. Optional because it is not the same
   * gesture as three separate clicks — the click count has to reach the target
   * as one number — so a backend that cannot express it must refuse rather than
   * approximate it with a loop the application reads as three carets.
   */
  tripleClick?(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult | void>;
  rightClick(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult | void>;
  moveCursor(point: ComputerPoint, windowId?: string): Promise<ComputerBackendActionResult | void>;
  drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
    windowId?: string,
  ): Promise<ComputerBackendActionResult | void>;
  scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult | void>;
  typeText(text: string, windowId?: string): Promise<ComputerBackendActionResult | void>;
  pressKey(key: string, windowId?: string): Promise<ComputerBackendActionResult | void>;
  hotkey(keys: readonly string[], windowId?: string): Promise<ComputerBackendActionResult | void>;
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
  stopInput?(): Promise<void>;
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
 * D-Bus payload, a plugin diagnostic — so an empty or oversized message must
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
    // Both halves or neither: a path with no verdict cannot tell a caller
    // whether the input landed, which is the only question this field answers.
    // The path is clamped here rather than in each backend, because it is copied
    // verbatim out of a helper reply and an over-long one would otherwise fail
    // the encode of an action that already happened.
    ...(result?.deliveryPath !== undefined && result.verified !== undefined
      ? {
          delivery: {
            path: result.deliveryPath.slice(0, COMPUTER_DELIVERY_PATH_MAX_LENGTH),
            verified: result.verified,
            ...(result.effect ? { effect: result.effect } : {}),
          },
        }
      : {}),
  } as ComputerActionResult;
}
