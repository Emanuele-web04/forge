import {
  ComputerId,
  ComputerPoint,
  ComputerScreenSize,
  COMPUTER_TEXT_MAX_LENGTH,
  ThreadId,
  type ComputerActionResult,
  type ComputerAvailability,
  type ComputerCapabilities,
  type ComputerEvent,
  type ComputerHealth,
  type ComputerScreenshot,
  type ComputerGetScreenSizeResult,
  type ComputerListWindowsResult,
  type ComputerLaunchAppResult,
  type ComputerState,
  type ComputerStatusResult,
  type ComputerTarget,
  type ComputerWindow,
  type ThreadComputerState,
} from "@synara/contracts";
import { encodeComputerFrame } from "@synara/shared/computerFrame";
import { FrameTransport, type FrameSink } from "@synara/shared/frameTransport";

import {
  clampComputerMessage,
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  computerBackendActionResult,
  ComputerBackendError,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerCaptureRequest,
  type ComputerStreamFrame,
  type ComputerResolvedTarget,
} from "./ComputerBackend.ts";
import { DesktopOperationQueue } from "./DesktopOperationQueue.ts";
import {
  rectContainsPoint,
  topmostWindowAtPoint,
  windowsCoveringPoint,
} from "./computerGeometry.ts";
import { decodePngLuma, estimateVerticalTravel, ScrollGearingStore } from "./scrollCalibration.ts";
import {
  ComputerTargetError,
  computerTargetCandidates,
  resolveComputerPoint,
  resolveComputerSemanticTarget,
  resolveComputerWindowTarget,
} from "./uiTreeTargeting.ts";

export const COMPUTER_FRAME_QUEUE_LIMIT = 8;
export const COMPUTER_FRAME_SOCKET_BUDGET_BYTES = 2 * 1024 * 1024;

/**
 * Crash backstop for the desktop lease, not the normal release path.
 *
 * There is one desktop, one cursor and one keyboard focus, so exactly one
 * thread may drive it at a time. Ownership is released the moment the owner's
 * turn ends (`releaseDesktopControl`, driven by the provider runtime's
 * terminal turn and session events), because a takeover mid-turn corrupts the
 * owner: its drag is teleported, its typing is retargeted. Idle expiry only
 * covers the case where that signal never arrives — a provider process that
 * died without a terminal event — and so is deliberately long: a model can
 * think for minutes between two tool calls, and expiring under a live turn is
 * the failure this whole mechanism exists to prevent. Five minutes matches the
 * backend session idle timeout, the point past which the desktop session is
 * being torn down anyway.
 */
export const COMPUTER_LEASE_IDLE_MS = 300_000;

/**
 * How long the desktop is given to settle before the screenshot that rides on
 * an action result is captured. Long enough for a menu to open or a keystroke
 * to paint, short enough not to throttle the action loop the screenshot exists
 * to speed up.
 */
export const COMPUTER_ACTION_SETTLE_MS = 300;

/**
 * Trailing-edge window on the republish that a backend window change triggers.
 *
 * A publish costs one availability read, one window read and one screen-size
 * read per thread, and the window read is itself what reports a change — so a
 * desktop with a ticking window title (a clock, a download percentage, a video
 * player's timer) publishes, observes its own read as a change, and publishes
 * again, once per thread, without ever settling. Coalescing turns that into at
 * most one pass per window, which is the only rate that is bounded by something
 * other than how fast D-Bus answers.
 *
 * The window list itself is not delayed by this: `computer.windows-changed` is
 * emitted immediately from the event, with no backend call at all.
 */
export const COMPUTER_WINDOWS_PUBLISH_DEBOUNCE_MS = 250;

/**
 * The first vertical scroll into a window whose gearing is unknown is split:
 * this many requested pixels go first as a probe whose travel is measured and
 * learned, and the remainder is delivered pre-corrected. Sized so that even a
 * client gearing pixels up by the largest believable ratio keeps the probe's
 * travel inside the correlator's measurable band, while staying above the
 * store's minimum learnable injection.
 */
export const SCROLL_PROBE_PX = 48;
/**
 * Requests at or below this skip the probe: they are already probe-sized, and
 * even a heavily geared client keeps their travel measurable. Anything larger
 * into an unmeasured window is split — a 90 px request at 7x already travels
 * past what a window-height capture pair can correlate.
 */
export const SCROLL_PROBE_TRIGGER_PX = SCROLL_PROBE_PX;

/**
 * How long recordError waits before republishing the threads it touched, so an
 * outage that fails ten calls in a burst costs one publish, not ten.
 */
export const COMPUTER_ERROR_REPUBLISH_DEBOUNCE_MS = 250;

export type ComputerEventListener = (event: ComputerEvent) => void;

interface ThreadComputerRuntimeState {
  version: number;
  lastError: string | null;
  windows: readonly ComputerWindow[];
  screenSize: ComputerScreenSize;
  availability: ComputerAvailability;
  cursor?: ComputerPoint;
  /**
   * Whether this thread's agent activity has already asked the UI to open the
   * computer pane. Actions arrive every few seconds, so surfacing is once per
   * thread: repeating the request would emit an event per click and could yank
   * a user who deliberately closed the pane back to it.
   */
  paneSurfaced: boolean;
}

/** The single desktop's exclusive owner, and when it last drove it. */
interface DesktopLease {
  readonly threadId: string;
  lastActivityMs: number;
  /**
   * The owner's turn ended (or its session exited) while one of its calls was
   * still running. Ownership is handed over when that call drains, not now:
   * see `releaseDesktopControl`.
   */
  releaseRequested: boolean;
}

export interface ComputerManagerOptions {
  readonly backend: ComputerBackend;
  readonly transport?: FrameTransport<string, ComputerStreamFrame>;
  /** Injected for tests; the lease is the only clock-dependent state here. */
  readonly now?: () => number;
  readonly leaseIdleMs?: number;
  /** Injected for tests, so action-screenshot tests do not sleep for real. */
  readonly actionSettleMs?: number;
  /** Injected for tests, so window-churn tests do not wait out the real window. */
  readonly windowsPublishDebounceMs?: number;
  /** Injected for tests; decodes and correlates two PNG captures. */
  readonly measureScrollTravel?: (
    before: Uint8Array,
    after: Uint8Array,
  ) => number | undefined | Promise<number | undefined>;
}

/**
 * A resolved pointer target, plus what the window read taken while resolving it
 * showed covering the point. The covering list rides along so the raise-failure
 * path can decide whether to refuse without paying a second window read.
 */
interface ResolvedPointTarget {
  readonly point: ComputerPoint;
  readonly windowId?: string;
  readonly covering?: readonly ComputerWindow[];
}

/**
 * What the raise/focus step needs. The point is optional because keyboard
 * actions name a window without one, and with no point there is nothing an
 * occlusion check could be about.
 */
type PreparedTarget = Omit<ResolvedPointTarget, "point"> & { readonly point?: ComputerPoint };

/** A capture plus which window it covers, when it covers one at all. */
export interface ComputerCapturedWindow {
  readonly screenshot: ComputerScreenshot;
  readonly windowId?: string;
}

/** Post-action capture, or confirmation that the targeted window has closed. */
export type ComputerActionObservation =
  | ComputerCapturedWindow
  | { readonly targetWindowClosed: true };

/**
 * Refusal raised when another thread owns the desktop. It extends
 * `ComputerBackendError` so every existing catch site keeps classifying it,
 * and carries `retryable` because the desktop does come free again — the
 * message tells the model to come back rather than to give up or find another
 * way in.
 */
export class ComputerLeaseError extends ComputerBackendError {
  readonly code = "computer_controlled_by_other_thread";

  constructor() {
    super(
      "The computer is currently controlled by another conversation; try again when it is free. " +
        "Reading the desktop (windows, state, screenshots) still works while it is held.",
      { retryable: true },
    );
    this.name = "ComputerLeaseError";
  }
}

/** Thread state, targeting, action dispatch, and stream ownership for a computer. */
export class ComputerManager {
  readonly computerId: ComputerId;

  private readonly backend: ComputerBackend;
  private readonly transport: FrameTransport<string, ComputerStreamFrame>;
  private readonly listeners = new Set<ComputerEventListener>();
  /** Per-thread publish serialization; see `publish`. */
  private readonly publishChains = new Map<string, Promise<unknown>>();
  private errorRepublishTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly threads = new Map<string, ThreadComputerRuntimeState>();
  /**
   * Agent calls in flight, per thread. Deliberately not a field on the thread
   * runtime record: a thread can drive the desktop without any record existing
   * — on a visible-desktop backend no pane is ever surfaced, so nothing creates
   * one until a panel asks for that thread's state, which may be never — and
   * this count is what stops the desktop lease being taken from a thread whose
   * drag or keystroke is still running. Entries are deleted as they reach zero,
   * so nothing accumulates and a removed thread is not resurrected by a late
   * call.
   */
  private readonly agentCallsInFlight = new Map<string, number>();
  /** Display names for the agent cursor badge, keyed by thread id. */
  private readonly threadLabels = new Map<string, string>();
  private readonly backendUnsubscribe?: () => void;
  private readonly now: () => number;
  private readonly leaseIdleMs: number;
  private readonly actionSettleMs: number;
  private readonly windowsPublishDebounceMs: number;
  private readonly measureScrollTravel: (
    before: Uint8Array,
    after: Uint8Array,
  ) => number | undefined | Promise<number | undefined>;
  /** Learned per window and kept for the manager's life; see ScrollGearingStore. */
  private readonly scrollGearing = new ScrollGearingStore();
  /** Depth rather than a flag: a lease publish can nest inside a window one. */
  private publishAllDepth = 0;
  private windowsPublishPending = false;
  private windowsPublishTimer: ReturnType<typeof setTimeout> | undefined;
  private backendHealth: ComputerHealth;
  private lease: DesktopLease | null = null;
  /**
   * Whether anything has yet asked this backend for the desktop itself.
   *
   * Until something has, the manager must not establish the backend. That is
   * the right ordering for an agent's first tool call, a pane the user opened,
   * or input they sent; it is the wrong price for rendering a chat, which is
   * what seeds thread state. So state publishes read the passive probe until a
   * real use flips this, and behave exactly as they always did after.
   */
  private backendEngaged = false;

  /**
   * Read live rather than cached at construction: a backend that re-probes or
   * provisions may upgrade a capability when its missing piece appears (a
   * backend state changes), and the call is
   * synchronous and cheap by the backend contract, so freshness costs a state
   * publish nothing. A backend that changes its set announces it as
   * `capabilities-changed`, which is what republishes the thread states that
   * already read it.
   */
  private get backendCapabilities(): ComputerCapabilities {
    return this.backend.capabilities();
  }
  private readonly operations = new DesktopOperationQueue();
  private streamAttached = false;
  private streamDesired = false;
  private streamEpoch = 0;
  private streamTransition: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: ComputerManagerOptions) {
    this.backend = options.backend;
    this.computerId = options.backend.computerId;
    this.now = options.now ?? Date.now;
    this.leaseIdleMs = options.leaseIdleMs ?? COMPUTER_LEASE_IDLE_MS;
    this.actionSettleMs = options.actionSettleMs ?? COMPUTER_ACTION_SETTLE_MS;
    this.windowsPublishDebounceMs =
      options.windowsPublishDebounceMs ?? COMPUTER_WINDOWS_PUBLISH_DEBOUNCE_MS;
    this.measureScrollTravel = options.measureScrollTravel ?? measureScrollTravelFromPng;
    this.backendHealth = options.backend.health();
    this.transport =
      options.transport ??
      new FrameTransport<string, ComputerStreamFrame>({
        encode: (computerId, frame) =>
          encodeComputerFrame({
            header: {
              computerId,
              sequence: frame.sequence,
              timestampMs: frame.timestampMs,
              keyframe: frame.keyframe,
              codecConfig: frame.codecConfig,
            },
            payload: frame.data,
          }),
        queueLimit: COMPUTER_FRAME_QUEUE_LIMIT,
        socketBudgetBytes: COMPUTER_FRAME_SOCKET_BUDGET_BYTES,
        subscriberIdPrefix: "computer-frame-subscriber",
      });
    if (options.backend.onEvent) {
      this.backendUnsubscribe = options.backend.onEvent((event) => {
        if (event.type === "windows-changed") {
          for (const state of this.threads.values()) state.windows = event.windows;
          this.emit({ type: "computer.windows-changed", windows: event.windows });
          this.scheduleWindowsPublish();
        } else if (event.type === "health-changed") {
          this.backendHealth = event.health;
          this.republishAllThreads();
        } else if (event.type === "capabilities-changed") {
          this.republishAllThreads();
        }
      });
    }
  }

  onEvent(listener: ComputerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Marks the desktop as wanted, and repaints every panel once it is.
   *
   * Called by every path that is about to use the backend for a real reason —
   * an agent tool call, a pane attach, pane input — and by nothing else. The
   * republish is what keeps the pane honest: before this point its snapshot
   * carries no windows and a placeholder screen size, and the frames that are
   * about to arrive are letterboxed against exactly that size. It runs detached
   * because the caller is on its way to the compositor and must not wait for a
   * window enumeration to finish first.
   */
  private engageBackend(): void {
    if (this.backendEngaged || this.disposed) return;
    this.backendEngaged = true;
    void this.publishAllThreads().catch(() => undefined);
  }

  async availability(): Promise<ComputerAvailability> {
    this.engageBackend();
    return await this.backend.availability();
  }

  /**
   * Thread-independent status for surfaces outside any conversation, such as
   * the settings screen. A probe failure becomes `backend-unavailable` rather
   * than an error: the caller is asking whether the desktop works, and "the
   * probe itself failed" is an answer to that question, not a failure to
   * answer it.
   */
  async getStatus(): Promise<ComputerStatusResult> {
    // Asked by the settings screen. Once something real has engaged the
    // backend it gets the establishing read, because the screen exists to
    // report what the desktop really is — but merely opening settings must
    // not be the thing that installs and loads compositor code on a machine
    // where nothing has ever used the feature, so before first engagement it
    // answers from the side-effect-free probe.
    let availability: ComputerAvailability;
    try {
      availability = this.backendEngaged
        ? await this.backend.availability()
        : await this.backend.probeAvailability();
    } catch (error) {
      availability = {
        kind: "backend-unavailable",
        message: clampComputerMessage(errorMessage(error), "The computer backend failed."),
      };
    }
    return {
      computerId: this.computerId,
      availability: this.correctedAvailability(availability),
      health: this.backendHealth,
      capabilities: this.backendCapabilities,
    };
  }

  async listWindows(): Promise<ComputerListWindowsResult> {
    this.engageBackend();
    const [availability, windows] = await Promise.all([
      this.backend.availability(),
      this.backend.listWindows(),
    ]);
    return { computerId: this.computerId, windows, availability };
  }

  async getState(
    options: {
      readonly includeScreenshot?: boolean;
      readonly includeText?: boolean;
    } = {},
  ): Promise<ComputerState> {
    this.engageBackend();
    return await this.backend.getState(options);
  }

  /** Zoomed capture of one window or desktop region, with its pixel mapping. */
  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    this.engageBackend();
    return await this.backend.captureScreenshot(request);
  }

  /**
   * Zoomed capture of the window that holds input focus, falling back to the
   * whole workspace when no visible window with known bounds has it. This is
   * what a perception request with no explicit target means: "show me where
   * input is going", at window resolution rather than as a workspace-wide
   * downscale that loses small text.
   */
  async captureFocusedWindow(
    maxDimension?: number,
    options: { readonly agentFocusOnly?: boolean } = {},
  ): Promise<ComputerCapturedWindow> {
    this.engageBackend();
    const limit = maxDimension === undefined ? {} : { maxDimension };
    const window = await this.focusedCapturableWindow(options.agentFocusOnly === true);
    if (window) {
      return {
        screenshot: await this.backend.captureScreenshot({
          kind: "window",
          windowId: window.id,
          ...limit,
        }),
        windowId: window.id,
      };
    }
    const screenSize = await this.backend.getScreenSize();
    return {
      screenshot: await this.backend.captureScreenshot({
        kind: "region",
        region: { x: 0, y: 0, width: screenSize.width, height: screenSize.height },
        ...limit,
      }),
    };
  }

  /**
   * Best-effort perception for an action that already happened: wait for the
   * UI to settle, then capture the window the action affected — the caller's
   * hint when it named one, otherwise the window under the action's own point,
   * otherwise the agent's own focus target. Failures return no screenshot
   * instead of throwing, because the action itself succeeded and a capture
   * problem must not turn that success into an error.
   *
   * A hinted window that has vanished is reported as `targetWindowClosed`,
   * never replaced by another window. The E2E run that forced this rule ended
   * with the close-Firefox click's "fallback" screenshot handing the agent
   * the human's own browser — the focused window is the human's whenever the
   * agent's target is gone — which both leaked their screen and convinced the
   * agent its click had landed there. For the same reason the untargeted path
   * never observes the compositor-active (human's) window as such. The
   * action-point step honors the same rule from the other direction: the
   * compositor routes an unscoped pointer action to the topmost window at its
   * coordinates, so that window is the one the action touched — photographing
   * it is reporting the action's own outcome, not drifting to someone's focus.
   * Without it, every untargeted scroll came back as a workspace-wide
   * downscale too small to read, and the agent scroll-hunted blind (the Codex
   * OSS form run, 2026-08-22).
   */
  async captureActionScreenshot(
    windowIdHint?: string,
    actionPoint?: ComputerPoint,
  ): Promise<ComputerActionObservation | undefined> {
    if (!this.backendCapabilities.capture) return undefined;
    this.engageBackend();
    if (this.actionSettleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.actionSettleMs));
    }
    if (windowIdHint !== undefined) {
      try {
        return {
          screenshot: await this.backend.captureScreenshot({
            kind: "window",
            windowId: windowIdHint,
            maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
          }),
          windowId: windowIdHint,
        };
      } catch {
        try {
          const stillListed = (await this.backend.listWindows()).some(
            (window) => window.id === windowIdHint,
          );
          if (!stillListed) return { targetWindowClosed: true };
        } catch {
          // The listing failed too; report nothing rather than guessing.
        }
        return undefined;
      }
    }
    if (actionPoint) {
      const pointWindowId = await this.windowIdAtActionPoint(actionPoint);
      if (pointWindowId !== undefined) {
        try {
          return {
            screenshot: await this.backend.captureScreenshot({
              kind: "window",
              windowId: pointWindowId,
              maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
            }),
            windowId: pointWindowId,
          };
        } catch {
          // The window vanished between the listing and the capture. It was
          // never named by the caller, so fall through to the focus path
          // rather than reporting a close the caller did not ask about.
        }
      }
    }
    try {
      return await this.captureFocusedWindow(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION, {
        agentFocusOnly: true,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * The window an unscoped pointer action at `point` was delivered to, by the
   * same topmost-at-point rule the compositor routes it with — the server's
   * frame-rect approximation of that rule, which the occlusion refusals
   * already rely on. Unresolvable stacking returns nothing rather than a
   * guess; a listing failure does too, because this only feeds perception.
   */
  private async windowIdAtActionPoint(point: ComputerPoint): Promise<string | undefined> {
    try {
      return topmostWindowAtPoint(await this.backend.listWindows(), point)?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * The window an untargeted capture should cover: the agent seat's focus
   * target first, then the window the compositor reports active, then the
   * topmost visible one. Windows without bounds cannot be captured — a
   * backend without `windowBounds` has no geometry — so they are skipped
   * rather than attempted.
   * `agentFocusOnly` stops after the first step: action observation must not
   * drift to the human's active window when the agent's focus is nowhere.
   */
  private async focusedCapturableWindow(
    agentFocusOnly = false,
  ): Promise<ComputerWindow | undefined> {
    const candidates = (await this.backend.listWindows()).filter(
      (window) => window.bounds !== undefined && window.visible && !window.minimized,
    );
    const agentFocused = candidates.find((window) => window.focused);
    if (agentFocused !== undefined || agentFocusOnly) return agentFocused;
    return (
      candidates.find((window) => window.active === true) ??
      candidates.toSorted(
        (first, second) =>
          (first.stackingIndex ?? Number.MAX_SAFE_INTEGER) -
          (second.stackingIndex ?? Number.MAX_SAFE_INTEGER),
      )[0]
    );
  }

  async getScreenSize(): Promise<ComputerGetScreenSizeResult> {
    this.engageBackend();
    const [availability, screenSize] = await Promise.all([
      this.backend.availability(),
      this.backend.getScreenSize(),
    ]);
    return { computerId: this.computerId, screenSize, availability };
  }

  /** Launching spawns windows on the shared desktop, so it takes the lease too. */
  async launchApp(
    threadId: string | undefined,
    app: string,
    args: readonly string[] = [],
  ): Promise<ComputerLaunchAppResult> {
    return this.withDesktopControl(threadId, async () => {
      const result = await this.backend.launchApp(app, args);
      this.emitAction(threadId, "computer_launch_app");
      return result;
    });
  }

  async getThreadState(threadId: string): Promise<ThreadComputerState> {
    const state = this.threadRuntime(threadId);
    return (await this.publish(threadId, false)) ?? this.threadSnapshot(threadId, state);
  }

  async click(threadId: string | undefined, target: ComputerTarget): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const resolved = await this.resolvePointTarget(target);
      await this.prepareResolvedTarget(resolved);
      const result = await this.injectScoped("computer_click", resolved, () =>
        this.backend.click(resolved.point),
      );
      return this.actionResult(
        threadId,
        "computer_click",
        resolved.point,
        result,
        resolved.windowId,
      );
    });
  }

  async doubleClick(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const resolved = await this.resolvePointTarget(target);
      await this.prepareResolvedTarget(resolved);
      const result = await this.injectScoped("computer_double_click", resolved, () =>
        this.backend.doubleClick(resolved.point),
      );
      return this.actionResult(
        threadId,
        "computer_double_click",
        resolved.point,
        result,
        resolved.windowId,
      );
    });
  }

  async rightClick(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const resolved = await this.resolvePointTarget(target);
      await this.prepareResolvedTarget(resolved);
      const result = await this.injectScoped("computer_right_click", resolved, () =>
        this.backend.rightClick(resolved.point),
      );
      return this.actionResult(
        threadId,
        "computer_right_click",
        resolved.point,
        result,
        resolved.windowId,
      );
    });
  }

  async moveCursor(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const resolved = await this.resolvePointTarget(target);
      await this.prepareResolvedTarget(resolved);
      const result = await this.injectScoped("computer_move_cursor", resolved, () =>
        this.backend.moveCursor(resolved.point),
      );
      return this.actionResult(
        threadId,
        "computer_move_cursor",
        resolved.point,
        result,
        resolved.windowId,
      );
    });
  }

  async drag(
    threadId: string | undefined,
    from: ComputerTarget,
    to: ComputerTarget,
    durationMs = 250,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const [resolvedFrom, resolvedTo] = await Promise.all([
        this.resolvePointTarget(from),
        this.resolvePointTarget(to),
      ]);
      // The drag is grabbed by the window it starts in, so that window is the one
      // raised and focused; the destination only scopes it when the origin names
      // no window at all.
      const grabbed = resolvedFrom.windowId ? resolvedFrom : resolvedTo;
      await this.prepareResolvedTarget(grabbed);
      const result = await this.injectScoped("computer_drag", grabbed, () =>
        this.backend.drag(resolvedFrom.point, resolvedTo.point, durationMs),
      );
      return this.actionResult(
        threadId,
        "computer_drag",
        resolvedTo.point,
        result,
        resolvedTo.windowId ?? resolvedFrom.windowId,
      );
    });
  }

  /**
   * The raw gesture: the deltas given are the deltas injected.
   *
   * This is the pane's path, carrying a human's own wheel events. Their gesture
   * must never be re-geared — they are watching the result and closing the loop
   * themselves, and a correction applied under their hand would fight them.
   * Agent scrolls go through `scrollCalibrated` instead.
   */
  async scroll(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const resolved = await this.prepareScrollTarget(target);
      const result = await this.injectScroll(resolved, deltaX, deltaY);
      return this.actionResult(
        threadId,
        "computer_scroll",
        resolved?.point,
        result,
        resolved?.windowId,
      );
    });
  }

  /**
   * Scroll, then check what the window did with it — the agent's path.
   *
   * A scroll request is in logical pixels, but no desktop client is obliged to
   * treat it that way: some toolkits honor pixel deltas exactly while others
   * convert them to their own scroll units and travel several times as
   * far. Nothing reports that conversion, so the distance is measured from
   * before/after captures of the affected window, returned to the caller as
   * `scroll.traveledY`, and remembered per window so the next request to it is
   * pre-divided by what was learned.
   *
   * Measurement is best-effort throughout: a capture that fails, a window that
   * cannot be identified, or a correlation that will not commit leaves the
   * scroll delivered and simply unmeasured. The after-capture doubles as the
   * caller's observation, so the closed loop costs no extra screenshot.
   *
   * A large request into a window nobody has measured is split: a small probe
   * goes first, its travel is measured and learned, and the remainder — the
   * request minus what the probe already covered — is delivered pre-divided by
   * the fresh gearing. Without the split, the first scroll into a 7x browser
   * travels so far that the before and after captures share no content, the
   * correlation refuses, and nothing is ever learned — the run that exposed
   * this scrolled to the page bottom, clicked coordinates from a layout that
   * no longer existed, and typed into nothing (2026-08-22, run 23556dc6). The
   * probe is sized so that even a heavily geared client keeps its travel
   * inside the measurable band.
   */
  async scrollCalibrated(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
    options: { readonly observe: boolean },
  ): Promise<{
    readonly result: ComputerActionResult;
    readonly observation?: ComputerActionObservation;
  }> {
    return this.withDesktopControl(threadId, async () => {
      // An untargeted scroll routes to whatever sits under the agent's cursor
      // once the pinned focus is cleared — but preparing the target clears that
      // focus, and it was the only fallback naming the observed window. Read the
      // candidates that will not survive the clear first: the cursor position
      // this thread last drove to, and the focus about to be dropped.
      const attributed = agentThreadId(threadId);
      const cursorPoint =
        target !== null ? undefined : attributed ? this.threads.get(attributed)?.cursor : undefined;
      const preClearFocusId = target !== null ? undefined : await this.agentFocusWindowId();
      const resolved = await this.prepareScrollTarget(target);
      // The window the gesture lands in, by the ladder `captureActionScreenshot`
      // already climbs: the one targeting named, else the one the compositor
      // routes an unscoped pointer action to, else the agent's own focus target.
      // A scroll that lands somewhere else measures no travel and so teaches this
      // window nothing, which is the right outcome for a guess.
      const observedWindowId =
        resolved?.windowId ??
        (resolved?.point ? await this.windowIdAtActionPoint(resolved.point) : undefined) ??
        (cursorPoint ? await this.windowIdAtActionPoint(cursorPoint) : undefined) ??
        preClearFocusId ??
        (await this.agentFocusWindowId());
      const before = options.observe
        ? await this.captureForMeasurement(observedWindowId)
        : undefined;

      let injectedX = 0;
      let injectedY = 0;
      let after: ComputerCapturedWindow | undefined;
      let traveledY: number | undefined;
      let result: ComputerBackendActionResult | void;

      if (
        before !== undefined &&
        observedWindowId !== undefined &&
        !this.scrollGearing.has(observedWindowId) &&
        Math.abs(deltaY) > SCROLL_PROBE_TRIGGER_PX
      ) {
        const probe = Math.sign(deltaY) * SCROLL_PROBE_PX;
        result = await this.injectScroll(resolved, 0, probe);
        injectedY += probe;
        const probeLeg = await this.settleAndMeasure(observedWindowId, before, probe);
        after = probeLeg.capture;
        // What the probe already delivered comes off the ask. An unmeasured or
        // wrong-way measurement deducts only the probe's own request, which is
        // the strongest claim it can still make.
        const covered =
          probeLeg.traveled !== undefined && Math.sign(probeLeg.traveled) === Math.sign(deltaY)
            ? probeLeg.traveled
            : probe;
        const remainder = Math.abs(covered) >= Math.abs(deltaY) ? 0 : deltaY - covered;
        // One gearing per window drives both axes: a toolkit's unit conversion is
        // a property of how it reads scroll events, not of which axis they carry,
        // and only the vertical travel is measurable from a row correlation.
        const legX = this.scrollGearing.plan(observedWindowId, deltaX);
        const legY = this.scrollGearing.plan(observedWindowId, remainder);
        if (legX !== 0 || legY !== 0) {
          result = await this.injectScroll(resolved, legX, legY);
          injectedX += legX;
          injectedY += legY;
          if (after) {
            const remainderLeg = await this.settleAndMeasure(observedWindowId, after, legY);
            after = remainderLeg.capture ?? after;
            traveledY =
              probeLeg.traveled !== undefined && remainderLeg.traveled !== undefined
                ? probeLeg.traveled + remainderLeg.traveled
                : undefined;
          }
        } else {
          traveledY = probeLeg.traveled;
        }
      } else {
        injectedX = this.scrollGearing.plan(observedWindowId, deltaX);
        injectedY = this.scrollGearing.plan(observedWindowId, deltaY);
        result = await this.injectScroll(resolved, injectedX, injectedY);
        if (before) {
          const leg = await this.settleAndMeasure(observedWindowId, before, injectedY);
          after = leg.capture;
          traveledY = leg.traveled;
        }
      }

      const base = this.actionResult(
        threadId,
        "computer_scroll",
        resolved?.point,
        result,
        resolved?.windowId,
      );
      return {
        result: {
          ...base,
          scroll: {
            requested: { deltaX, deltaY },
            injected: { deltaX: round2(injectedX), deltaY: round2(injectedY) },
            ...(traveledY === undefined ? {} : { traveledY: round2(traveledY) }),
            ...(observedWindowId === undefined
              ? {}
              : { gearing: round2(this.scrollGearing.gearing(observedWindowId)) }),
          },
        },
        ...(after ? { observation: after } : {}),
      };
    });
  }

  private async prepareScrollTarget(
    target: ComputerTarget | null,
  ): Promise<ResolvedPointTarget | null> {
    const resolved = target ? await this.resolveScrollPointTarget(target) : null;
    await this.prepareResolvedTarget(resolved ?? undefined);
    return resolved;
  }

  /**
   * Scroll accepts one control-less target the semantic resolver refuses: a
   * bare window id, meaning "scroll this window". It resolves to the window's
   * own point — its node in the accessibility tree when it has one, else the
   * centre of its reported bounds — rather than entering label matching,
   * where a query naming no control matches everything in scope.
   */
  private async resolveScrollPointTarget(target: ComputerTarget): Promise<ResolvedPointTarget> {
    const windowId = target.windowId;
    if (
      windowId === undefined ||
      target.x !== undefined ||
      target.y !== undefined ||
      hasLabelFields(target)
    ) {
      return this.resolvePointTarget(target);
    }
    const state = await this.backend.getState({ includeText: false });
    const match = state.root ? resolveComputerWindowTarget(state.root, windowId) : undefined;
    if (match) return { point: match.point, windowId };
    const windows = await this.backend.listWindows();
    const window = windows.find((candidate) => candidate.id === windowId);
    if (!window) throw windowNotFoundError(windowId);
    const bounds = window.bounds;
    if (!bounds) {
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message:
          `This desktop reports no geometry for window ${JSON.stringify(windowId)}, so a scroll ` +
          "point inside it cannot be chosen. Scroll at x/y coordinates instead.",
      });
    }
    return {
      point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      windowId,
    };
  }

  private async injectScroll(
    resolved: ResolvedPointTarget | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerBackendActionResult | void> {
    return this.injectScoped("computer_scroll", resolved ?? {}, () =>
      this.backend.scroll(resolved?.point ?? null, deltaX, deltaY),
    );
  }

  /**
   * One injected leg's perception: settle, recapture, measure against `from`,
   * and teach the store what the window did with the injection. A capture or
   * correlation that fails leaves the leg unmeasured, never undelivered.
   */
  private async settleAndMeasure(
    windowId: string | undefined,
    from: ComputerCapturedWindow,
    injectedY: number,
  ): Promise<{ readonly capture?: ComputerCapturedWindow; readonly traveled?: number }> {
    if (this.actionSettleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.actionSettleMs));
    }
    const capture = await this.captureForMeasurement(windowId);
    if (!capture) return {};
    const measured = await this.measureTravel(from.screenshot, capture.screenshot);
    // A travel opposing the injection is the correlator locking onto the wrong
    // feature — repetitive content aliases — not a page that scrolled
    // backwards. The store would refuse the sample anyway; suppressing it here
    // keeps the caller's traveledY from asserting a direction nothing moved in.
    const traveled =
      measured !== undefined &&
      measured !== 0 &&
      injectedY !== 0 &&
      Math.sign(measured) !== Math.sign(injectedY)
        ? undefined
        : measured;
    if (traveled !== undefined && injectedY !== 0) {
      this.scrollGearing.learn(windowId, injectedY, traveled);
    }
    return { capture, ...(traveled === undefined ? {} : { traveled }) };
  }

  /** The agent seat's focus target, when it has one; never the human's. */
  private async agentFocusWindowId(): Promise<string | undefined> {
    try {
      return (await this.focusedCapturableWindow(true))?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * A capture taken to be measured against another one, and then handed to the
   * caller as the action's observation. It deliberately bypasses
   * screenshot delivery: the before-capture is never shown to anyone, so recording
   * it as the last thing the caller saw would make the after-capture vanish as a
   * repeat of an image that was never sent.
   *
   * With no window to name — no target, no window under the point, no agent
   * focus — it widens to the same workspace capture the observation path would
   * take, which is still comparable to itself even though nothing can be
   * learned from a region that is not one window.
   */
  private async captureForMeasurement(
    windowId: string | undefined,
  ): Promise<ComputerCapturedWindow | undefined> {
    if (!this.backendCapabilities.capture) return undefined;
    this.engageBackend();
    try {
      if (windowId === undefined) {
        return await this.captureFocusedWindow(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION, {
          agentFocusOnly: true,
        });
      }
      return {
        screenshot: await this.backend.captureScreenshot({
          kind: "window",
          windowId,
          maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
        }),
        windowId,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Vertical travel in logical pixels, or nothing when the two captures cannot
   * be compared. Byte equality answers first and for free: pixels that did not
   * change did not move, which is what the end of a page looks like.
   */
  private async measureTravel(
    before: ComputerScreenshot,
    after: ComputerScreenshot,
  ): Promise<number | undefined> {
    if (before.bytesBase64 === after.bytesBase64) return 0;
    // Without a scale on both captures there is no conversion from capture
    // pixels to the logical pixels the request was made in, and two different
    // scales are two different pictures of the window.
    const scale = before.scale;
    if (scale === undefined || scale !== after.scale || scale <= 0) return undefined;
    const traveled = await this.measureScrollTravel(
      Buffer.from(before.bytesBase64, "base64"),
      Buffer.from(after.bytesBase64, "base64"),
    );
    return traveled === undefined ? undefined : traveled / scale;
  }

  async typeText(
    threadId: string | undefined,
    text: string,
    windowId?: string,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      await this.prepareKeyboardTarget(windowId);
      const result = await this.backend.typeText(text);
      return this.actionResult(threadId, "computer_type_text", undefined, result, windowId);
    });
  }

  async pressKey(
    threadId: string | undefined,
    key: string,
    windowId?: string,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      await this.prepareKeyboardTarget(windowId);
      const result = await this.backend.pressKey(key);
      return this.actionResult(threadId, "computer_press_key", undefined, result, windowId);
    });
  }

  async hotkey(
    threadId: string | undefined,
    keys: readonly string[],
    windowId?: string,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      await this.prepareKeyboardTarget(windowId);
      const result = await this.backend.hotkey(keys);
      return this.actionResult(threadId, "computer_hotkey", undefined, result, windowId);
    });
  }

  /**
   * The clipboard is the system one the human shares, and it is optional on the
   * backend, so a backend without it refuses the call instead of the tool
   * layer discovering a missing method at dispatch time.
   *
   * Reading it takes the lease even though it mutates nothing: the clipboard is
   * one shared slot that the owning thread is mid-way through using, and a read
   * from a second thread is either racing that write or reading its private
   * payload. Uniformity also keeps the rule the model must learn simple —
   * perception of the screen is free, everything clipboard is not.
   */
  async readClipboard(threadId: string | undefined): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const read = this.backend.readClipboard?.bind(this.backend);
      if (!read) throw clipboardUnsupportedError();
      const value = await read();
      // `ComputerActionResult.value` is contract-bounded well below the backend's
      // byte cap, and an oversized read must not slip out through the unvalidated
      // MCP result path.
      if (value.length > COMPUTER_TEXT_MAX_LENGTH) {
        throw new ComputerBackendError(
          `The desktop clipboard holds ${value.length} characters of text, more than the ${COMPUTER_TEXT_MAX_LENGTH} this tool returns.`,
        );
      }
      return this.actionResult(threadId, "computer_read_clipboard", undefined, { value });
    });
  }

  async writeClipboard(threadId: string | undefined, text: string): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const write = this.backend.writeClipboard?.bind(this.backend);
      if (!write) throw clipboardUnsupportedError();
      await write(text);
      // The text is not echoed back on `value`: the caller already has it, and it
      // may be far larger than the contract bound on that field.
      return this.actionResult(threadId, "computer_write_clipboard", undefined, undefined);
    });
  }

  async setValue(
    threadId: string | undefined,
    target: ComputerTarget,
    value: string,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const resolved = await this.resolveSemanticTarget(target);
      await this.prepareResolvedTarget(semanticPointTarget(resolved));
      const result = await this.backend.setValue(resolved, value);
      return this.actionResult(
        threadId,
        "computer_set_value",
        resolved.point,
        result,
        resolved.node.windowId ?? undefined,
      );
    });
  }

  async performAction(
    threadId: string | undefined,
    target: ComputerTarget,
    action: string,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const resolved = await this.resolveSemanticTarget(target);
      await this.prepareResolvedTarget(semanticPointTarget(resolved));
      const result = await this.backend.performAction(resolved, action);
      return this.actionResult(
        threadId,
        "computer_perform_action",
        resolved.point,
        result,
        resolved.node.windowId ?? undefined,
      );
    });
  }

  /**
   * Runs one agent tool call with this thread counted as driving the desktop.
   *
   * The count is kept whether or not this thread has a runtime record, because
   * the lease's in-flight guard reads it: while it was a field on the record,
   * every thread on a visible-desktop backend counted as idle from the first
   * call to the last, and the desktop could be taken from a thread in the
   * middle of a drag. Publishing the badge still requires a record, since a
   * thread nobody is watching has no panel to update.
   */
  async withAgentActivity<A>(
    threadId: string,
    action: () => Promise<A>,
    signal?: AbortSignal,
  ): Promise<A> {
    return this.operations.run(async () => {
      const owner = agentThreadId(threadId);
      if (owner === undefined) return await action();
      const depth = (this.agentCallsInFlight.get(owner) ?? 0) + 1;
      this.agentCallsInFlight.set(owner, depth);
      if (depth === 1) await this.publish(owner, true).catch(() => undefined);
      try {
        return await action();
      } finally {
        const remaining = Math.max(0, (this.agentCallsInFlight.get(owner) ?? 1) - 1);
        if (remaining === 0) {
          this.agentCallsInFlight.delete(owner);
          // A release that arrived mid-call waited for this moment; it publishes
          // every thread itself, so the single publish below would be redundant.
          if (this.lease?.threadId === owner && this.lease.releaseRequested) {
            await this.releaseDesktopControl(owner);
          } else {
            await this.publish(owner, true).catch(() => undefined);
          }
        } else {
          this.agentCallsInFlight.set(owner, remaining);
        }
      }
    }, signal);
  }

  private assertDesktopAvailable(threadId: string | undefined): void {
    const owner = agentThreadId(threadId);
    const held = this.lease;
    if (owner && held && held.threadId !== owner && !this.isLeaseStale(held, this.now())) {
      throw new ComputerLeaseError();
    }
  }

  private withDesktopControl<A>(
    threadId: string | undefined,
    action: () => Promise<A>,
  ): Promise<A> {
    // Reject a competing owner promptly, then recheck when this job reaches the front.
    this.assertDesktopAvailable(threadId);
    return this.operations.run(async () => {
      await this.claimDesktopControl(threadId);
      return action();
    });
  }

  /**
   * Take or renew the exclusive desktop lease for a mutating agent action, or
   * refuse the action because another conversation holds it.
   *
   * Ownership is implicit: the first thread to drive the desktop owns it, and
   * keeps owning it until its turn ends. There is no explicit acquire tool
   * because there is nothing sensible for a model to do with one — it would
   * either forget to release, or treat a refusal to acquire as a different
   * failure from a refusal to act.
   *
   * An undefined (or blank) thread is the human driving through the computer
   * pane, which the same rule as `emitAction` identifies. The human is not a
   * competing agent: they are the person the desktop belongs to, so pane input
   * neither takes the lease nor is ever refused by it.
   */
  private async claimDesktopControl(threadId: string | undefined): Promise<void> {
    // Before the early return, not after it: pane input belongs to no thread and
    // takes no lease, but it is still the human asking this backend to drive
    // their desktop, which is exactly what engagement means.
    this.engageBackend();
    const owner = agentThreadId(threadId);
    if (owner === undefined) return;
    const now = this.now();
    const held = this.lease;
    if (held && held.threadId !== owner && !this.isLeaseStale(held, now)) {
      throw new ComputerLeaseError();
    }
    const changed = held?.threadId !== owner;
    // A renewal by the same owner keeps a release that is waiting on its other
    // in-flight calls; resetting it here would leave every other thread blocked
    // until the idle timeout.
    this.lease = {
      threadId: owner,
      lastActivityMs: now,
      releaseRequested: held?.threadId === owner ? held.releaseRequested : false,
    };
    if (changed) {
      await this.announceDrivingAgent(owner);
      // Both panels change: the new owner stops being blocked, and every other
      // thread starts being.
      await this.publishAllThreads();
    }
  }

  /**
   * Names the thread driving the desktop so a backend that draws an agent
   * cursor can label it. Best effort: a missing or failed label is a cosmetic
   * loss, and must never turn into a refused action.
   */
  private async announceDrivingAgent(threadId: string | null): Promise<void> {
    if (!this.backend.setDrivingAgent) return;
    const label = threadId === null ? null : (this.threadLabels.get(threadId) ?? null);
    await this.backend.setDrivingAgent(label).catch(() => undefined);
  }

  /**
   * The display name for a thread's agent cursor badge. Pushed in by the tool
   * layer, which is the only place that knows a thread's title, rather than
   * queried from here — the manager is built without any orchestration
   * dependency and reading a title on every action would put a database read
   * inside the lease claim.
   */
  setThreadLabel(threadId: string, label: string | null): void {
    const owner = agentThreadId(threadId);
    if (owner === undefined) return;
    const trimmed = label?.trim();
    if (trimmed) {
      if (this.threadLabels.get(owner) === trimmed) return;
      this.threadLabels.set(owner, trimmed);
    } else {
      if (!this.threadLabels.delete(owner)) return;
    }
    // Only when this thread is the one on screen; every other thread's label is
    // just recorded for whenever it takes the desktop.
    if (this.lease?.threadId === owner) void this.announceDrivingAgent(owner);
  }

  /**
   * Release the desktop the moment the owning thread stops being able to drive
   * it — its turn reached a terminal state, or its provider session exited.
   * This is the lease's primary release path; idle expiry only covers a runtime
   * that died without reporting either.
   *
   * Scoped to the thread rather than to one turn: the manager never sees turn
   * ids, and it does not need them, because the gateway already refuses every
   * computer tool call outside an active turn. A thread whose turn ended cannot
   * act again regardless of what the lease says.
   *
   * Deferred, not skipped, while one of the owner's calls is still running: a
   * session that exits mid-drag leaves that drag executing, because a gateway
   * call cannot be aborted, and releasing now would let the next conversation
   * take the pointer while the old one is still moving it. The record is
   * marked instead, and `withAgentActivity` completes the release when the
   * owner's activity count reaches zero.
   */
  async releaseDesktopControl(threadId: string): Promise<void> {
    const owner = agentThreadId(threadId);
    if (owner === undefined || this.lease?.threadId !== owner) return;
    if ((this.agentCallsInFlight.get(owner) ?? 0) > 0) {
      this.lease.releaseRequested = true;
      return;
    }
    this.lease = null;
    await this.announceDrivingAgent(null);
    await this.publishAllThreads();
  }

  /**
   * Stale only once nothing is in flight: a call that is still running holds
   * the pointer or the keyboard right now, and elapsed time since it started
   * says nothing about whether it has finished.
   */
  private isLeaseStale(lease: DesktopLease, now: number): boolean {
    if (now - lease.lastActivityMs < this.leaseIdleMs) return false;
    return (this.agentCallsInFlight.get(lease.threadId) ?? 0) === 0;
  }

  async recordThreadError(threadId: string, message: string): Promise<void> {
    const state = this.threads.get(threadId);
    if (!state) return;
    state.lastError = clampComputerMessage(
      message,
      "The computer backend reported an error without a message.",
    );
    await this.publish(threadId, true).catch(() => undefined);
  }

  subscribeFrames(sink: FrameSink): () => void {
    // A pane attach is a user asking to watch the desktop, which is a real use:
    // the stream cannot exist without a connected backend anyway.
    this.engageBackend();
    const unsubscribe = this.transport.subscribe(this.computerId, sink);
    this.streamDesired = true;
    this.streamEpoch += 1;
    void this.reconcileStream().catch((error) => this.recordError(error));
    return () => {
      unsubscribe();
      if (this.transport.streamSubscriberCount(this.computerId) === 0) {
        this.streamDesired = false;
        this.streamEpoch += 1;
        void this.reconcileStream().catch((error) => this.recordError(error));
      }
    };
  }

  async requestKeyframe(): Promise<void> {
    if (!this.streamAttached || this.transport.streamSubscriberCount(this.computerId) === 0) return;
    const epoch = this.streamEpoch;
    await this.enqueueStreamTransition(async () => {
      if (!this.isStreamWanted(epoch) || !this.streamAttached) return;
      if (this.backend.requestKeyframe) {
        await this.backend.requestKeyframe();
        if (!this.isStreamWanted(epoch)) return;
        return;
      }
      await this.backend.detachStream();
      this.streamAttached = false;
      if (!this.isStreamWanted(epoch)) {
        this.transport.reset(this.computerId);
        return;
      }
      this.transport.reset(this.computerId);
      await this.backend.attachStream((frame) => this.handleFrame(frame));
      if (!this.isStreamWanted(epoch)) {
        this.streamAttached = false;
        this.transport.reset(this.computerId);
        await this.backend.detachStream();
        return;
      }
      this.streamAttached = true;
    });
  }

  async flushStreamTransitions(): Promise<void> {
    await this.streamTransition;
  }

  async handleThreadRemoved(threadId: string): Promise<void> {
    this.threads.delete(threadId);
    this.threadLabels.delete(threadId);
    // Deleted after the thread state, so the resulting publish cannot recreate
    // it: a removed thread must not reappear as a lease holder.
    await this.releaseDesktopControl(threadId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.operations.close();
    if (this.windowsPublishTimer !== undefined) clearTimeout(this.windowsPublishTimer);
    this.windowsPublishTimer = undefined;
    this.windowsPublishPending = false;
    if (this.errorRepublishTimer !== undefined) clearTimeout(this.errorRepublishTimer);
    this.errorRepublishTimer = undefined;
    this.streamDesired = false;
    this.streamEpoch += 1;
    await this.enqueueStreamTransition(async () => {
      if (this.streamAttached) {
        this.streamAttached = false;
        this.transport.reset(this.computerId);
        await this.backend.detachStream();
      }
    }).catch(() => undefined);
    this.backendUnsubscribe?.();
    await this.backend.dispose();
    this.listeners.clear();
  }

  private async reconcileStream(): Promise<void> {
    await this.enqueueStreamTransition(async () => {
      if (this.disposed || !this.streamDesired) {
        if (!this.streamAttached) return;
        this.streamAttached = false;
        this.transport.reset(this.computerId);
        await this.backend.detachStream();
        return;
      }
      if (this.streamAttached) return;
      const epoch = this.streamEpoch;
      await this.backend.attachStream((frame) => this.handleFrame(frame));
      if (!this.isStreamWanted(epoch)) {
        await this.backend.detachStream();
        this.transport.reset(this.computerId);
        return;
      }
      this.streamAttached = true;
    });
  }

  private enqueueStreamTransition(action: () => Promise<void>): Promise<void> {
    const next = this.streamTransition.then(action);
    this.streamTransition = next.catch(() => undefined);
    return next;
  }

  /**
   * Frames travel on the binary transport and nowhere else. A parallel
   * `computer.frame` notice on the JSON event channel used to be emitted here
   * too; its only consumer read the header and did nothing with it, so every
   * still frame paid for a serialized event that told no one anything.
   */
  private handleFrame(frame: ComputerStreamFrame): void {
    if (this.disposed || (!this.streamDesired && !this.streamAttached)) return;
    this.transport.publish(this.computerId, frame);
  }

  /**
   * Coordinates plus a window id are a window-scoped click: the point is
   * resolved exactly as a bare coordinate, and the window id only decides which
   * window is raised and receives the input. A label or role instead means the
   * coordinate is at most a hint, so those keep going through AT-SPI
   * resolution, which owns the final point.
   */
  private async resolvePointTarget(target: ComputerTarget): Promise<ResolvedPointTarget> {
    if (hasCoordinates(target) && !hasLabelFields(target)) {
      const point = await this.resolveCoordinatePoint(target);
      if (target.windowId === undefined) return { point };
      const covering = await this.scopedPointOcclusion(point, target.windowId);
      return { point, windowId: target.windowId, covering };
    }
    if (hasSemanticFields(target)) {
      const resolved = await this.resolveSemanticTarget(target);
      return {
        point: resolved.point,
        ...(resolved.node.windowId ? { windowId: resolved.node.windowId } : {}),
      };
    }
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "Computer actions require x/y coordinates or a labelled target.",
    });
  }

  private async resolveCoordinatePoint(target: ComputerTarget): Promise<ComputerPoint> {
    try {
      return resolveComputerPoint(target, await this.backend.getScreenSize());
    } catch (error) {
      if (!(error instanceof ComputerTargetError) || error.code !== "computer_target_offscreen") {
        throw error;
      }
      const state = await this.backend.getState({ includeText: true }).catch(() => undefined);
      throw new ComputerTargetError({
        code: error.code,
        message: error.message,
        candidates: state?.root ? computerTargetCandidates(state.root) : [],
      });
    }
  }

  /**
   * Checks a scoped coordinate against the window it names, and reports the
   * windows stacked above it that also contain the point.
   *
   * A scoped click is refused rather than redirected. Input is routed to the
   * named window regardless of what covers that coordinate, so a point outside
   * its bounds would deliver a click to a part of the window that does not
   * exist — the one failure mode scoping is meant to remove. The covering list
   * comes from the same window read, so the raise path downstream never has to
   * repeat it.
   */
  private async scopedPointOcclusion(
    point: ComputerPoint,
    windowId: string,
  ): Promise<readonly ComputerWindow[]> {
    const windows = await this.backend.listWindows();
    const window = windows.find((candidate) => candidate.id === windowId);
    if (!window) throw windowNotFoundError(windowId);
    const bounds = window.bounds;
    if (!bounds) {
      // Scoping exists to guarantee the point is inside the named window. A
      // display server with no geometry cannot answer that, and letting the
      // click through unchecked would silently drop the guarantee the caller
      // asked for by passing window_id at all.
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message:
          `This desktop reports no geometry for window ${JSON.stringify(windowId)}, so a coordinate ` +
          "cannot be checked against it. Drop window_id to click whatever is topmost at that point, " +
          "or target the control by label instead.",
      });
    }
    if (!rectContainsPoint(bounds, point)) {
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message:
          `Computer target (${point.x}, ${point.y}) is outside window ${JSON.stringify(windowId)}, ` +
          `which covers ${bounds.width}x${bounds.height} at (${bounds.x}, ${bounds.y}). ` +
          "Pass a coordinate inside those bounds, or drop window_id to click whatever is topmost.",
      });
    }
    return windowsCoveringPoint(windows, windowId, point);
  }

  /**
   * Raise before focus: focus alone routes the agent's input to a window that
   * may still be buried, which leaves the human watching clicks land on pixels
   * they cannot see. Both calls are optional so a backend that supports neither
   * keeps working.
   *
   * A raise this desktop cannot perform is not by itself a failed action — the
   * compositor still routes the agent's input to the named window — so it only
   * refuses when a different window really does cover the point, which is the
   * one case where proceeding would deliver the click somewhere the caller did
   * not ask for and could not see coming.
   */
  private async prepareResolvedTarget(target: PreparedTarget | undefined): Promise<void> {
    const windowId = target?.windowId;
    if (windowId === undefined) {
      await this.backend.clearFocusWindow?.();
      return;
    }
    const raiseFailure = await this.raiseTargetWindow(windowId);
    if (raiseFailure !== undefined && target?.point) {
      const covering = target.covering ?? (await this.coveringWindowsAt(target.point, windowId));
      if (covering.length > 0) {
        throw occludedTargetError(windowId, target.point, covering, raiseFailure);
      }
    }
    await this.backend.focusWindow?.(windowId);
  }

  /**
   * Points the agent seat's keyboard at a window before a keystroke, or leaves
   * focus alone when the caller named none.
   *
   * Keyboard input carries no coordinate to scope it, so without a window it
   * lands wherever the seat's focus already is — usually where the last click
   * put it, which is what a click-then-type sequence depends on. Focus is
   * therefore never cleared here; only an explicit window moves it, and a stale
   * id fails before any key is sent rather than typing into another application.
   */
  private async prepareKeyboardTarget(windowId: string | undefined): Promise<void> {
    if (windowId === undefined) return;
    const windows = await this.backend.listWindows();
    if (!windows.some((candidate) => candidate.id === windowId)) {
      throw windowNotFoundError(windowId);
    }
    await this.prepareResolvedTarget({ windowId });
  }

  /** The restack, or the reason this desktop did not perform one. */
  private async raiseTargetWindow(windowId: string): Promise<string | undefined> {
    const raise = this.backend.raiseWindow?.bind(this.backend);
    if (!raise) return "this backend exposes no stacking control";
    try {
      await raise(windowId);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /**
   * Runs a pointer injection that named a window, and replaces the desktop's
   * bare refusal with something the caller can act on.
   *
   * The compositor refuses instead of retargeting, so a refusal is the one
   * failure that guarantees nothing was delivered — worth saying, because the
   * caller's alternative reading is that the control is broken. It reports only
   * which call it declined, so the cause has to be supplied here.
   */
  private async injectScoped<T>(
    action: string,
    target: PreparedTarget,
    inject: () => Promise<T>,
  ): Promise<T> {
    try {
      return await inject();
    } catch (error) {
      const windowId = target.windowId;
      const point = target.point;
      if (windowId === undefined || !point) throw error;
      if (!(error instanceof ComputerBackendError) || error.rejectedOperation === undefined) {
        throw error;
      }
      throw refusedInjectionError(action, windowId, point);
    }
  }

  private async coveringWindowsAt(
    point: ComputerPoint,
    windowId: string,
  ): Promise<readonly ComputerWindow[]> {
    const windows = await this.backend.listWindows().catch(() => []);
    return windowsCoveringPoint(windows, windowId, point);
  }

  private async resolveSemanticTarget(target: ComputerTarget): Promise<ComputerResolvedTarget> {
    // Without a label or role the query matches every control in scope, and
    // the ambiguity refusal that follows would dump the whole tree at the
    // caller. Refuse up front, before paying for the accessibility walk, with
    // what is actually missing.
    if (target.label === undefined && target.role === undefined) {
      throw new ComputerTargetError({
        code: "computer_target_invalid",
        message:
          "This target does not name a control: window_id or coordinates alone match everything in scope. " +
          "Pass label (optionally with role and window_id) to pick a control, or use x/y coordinates " +
          "with the pointer tools. Only computer_scroll takes window_id alone, scrolling that window itself.",
      });
    }
    const state = await this.backend.getState({ includeText: true });
    if (!state.root) {
      throw new ComputerTargetError({
        code: "computer_target_not_found",
        message: "Computer accessibility state did not include a target tree.",
        notFound: true,
      });
    }
    return { target, ...resolveComputerSemanticTarget(state.root, target) };
  }

  /**
   * The window id is the one targeting resolved, so the result reports where
   * input was routed; a backend that reports its own window id wins, being
   * closer to what actually happened.
   */
  private actionResult(
    threadId: string | undefined,
    action: string,
    point: ComputerPoint | undefined,
    result: ComputerBackendActionResult | void,
    windowId?: string,
  ): ComputerActionResult {
    this.emitAction(threadId, action);
    const merged = computerBackendActionResult(this.computerId, action, {
      ...(point ? { point } : {}),
      ...(windowId !== undefined ? { windowId } : {}),
      ...(result === undefined ? {} : result),
    });
    // The pane's agent-cursor dot is fed from here, the one funnel every
    // pointer action passes through: without it the field stayed declared but
    // never assigned, and the overlay never rendered.
    const attributed = agentThreadId(threadId);
    const state = attributed ? this.threads.get(attributed) : undefined;
    if (attributed && state && merged.point) {
      state.cursor = merged.point;
      this.publish(attributed, true).catch(() => undefined);
    }
    return merged;
  }

  /**
   * Desktop activity is attributed to the thread that drove it so an observer
   * can tell one agent's work from another's. Pane input carries no thread and
   * stays unattributed rather than borrowing an unrelated thread id.
   */
  private emitAction(threadId: string | undefined, action: string): void {
    const attributed = agentThreadId(threadId);
    if (attributed) this.surfacePaneForAgent(attributed);
    this.emit({
      type: "computer.action",
      action,
      ok: true,
      ...(attributed ? { threadId: ThreadId.makeUnsafe(attributed) } : {}),
    });
  }

  /**
   * Put the desktop in front of the user the moment an agent starts driving it.
   * Emitted before the action event so the pane is already opening when the
   * first attributed action reaches the store. Mirrors
   * DeviceManager.requestOpenPane; see paneSurfaced for the once-per-thread
   * rule. On a visible-desktop backend the actions are already happening on the
   * human's own screen, so no pane is requested at all — mirroring their
   * display back at them adds nothing.
   *
   * The runtime record is still created in that case, before the decision: it
   * is what carries this thread's activity count and last error, and a thread
   * that drives the desktop needs one whether or not a pane is opened for it.
   */
  private surfacePaneForAgent(threadId: string): void {
    const state = this.threadRuntime(threadId);
    if (this.backendCapabilities.visibleDesktop || state.paneSurfaced) return;
    state.paneSurfaced = true;
    this.emit({
      type: "computer.open-pane-requested",
      threadId: ThreadId.makeUnsafe(threadId),
    });
  }

  /**
   * Serializes publishes per thread. Two overlapping publishes read the same
   * state, each bump `version`, and both emit — the second overwriting the
   * first with a *newer* version number but identical or older content, which
   * is how duplicate versions leaked to the pane. Chaining makes each publish
   * see its predecessor's state.
   */
  private async publish(
    threadId: string,
    increment: boolean,
  ): Promise<ThreadComputerState | undefined> {
    const previous = this.publishChains.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.publishNow(threadId, increment));
    this.publishChains.set(
      threadId,
      next.catch(() => undefined),
    );
    return await next;
  }

  private async publishNow(
    threadId: string,
    increment: boolean,
  ): Promise<ThreadComputerState | undefined> {
    const state = this.threads.get(threadId);
    if (!state) return undefined;
    if (increment) state.version += 1;
    try {
      if (this.backendEngaged) {
        const [availability, windows, screenSize] = await Promise.all([
          this.backend.availability(),
          this.backend.listWindows(),
          this.backend.getScreenSize(),
        ]);
        if (this.disposed || this.threads.get(threadId) !== state) return undefined;
        state.availability = availability;
        state.windows = windows;
        state.screenSize = screenSize;
      } else {
        // Nothing has asked for the desktop yet, so nothing here may reach for
        // it: the probe answers whether the feature could work, and the windows
        // and screen size stay at whatever the last pass cached — empty and a
        // placeholder on a backend that has never connected. A panel showing no
        // windows before anyone opened it is right; provisioning a compositor
        // plugin to fill that list in would not be.
        const availability = await this.backend.probeAvailability();
        if (this.disposed || this.threads.get(threadId) !== state) return undefined;
        state.availability = availability;
      }
      state.lastError = null;
    } catch (error) {
      // Error text the backend does not control, so it meets the contract's
      // bound here rather than failing the state payload that carries it.
      state.lastError = clampComputerMessage(
        errorMessage(error),
        "The computer backend reported an error without a message.",
      );
    }
    if (this.disposed || this.threads.get(threadId) !== state) return undefined;
    const snapshot = this.threadSnapshot(threadId, state);
    this.emit({ type: "computer.thread-state", state: snapshot });
    return snapshot;
  }

  private async publishAllThreads(): Promise<void> {
    this.publishAllDepth += 1;
    try {
      for (const threadId of this.threads.keys()) await this.publish(threadId, true);
    } finally {
      this.publishAllDepth -= 1;
      if (this.publishAllDepth === 0 && this.windowsPublishPending) {
        this.windowsPublishPending = false;
        this.scheduleWindowsPublish();
      }
    }
  }

  /**
   * Queue one republish for a window change, coalescing everything that arrives
   * before it runs — including the changes this pass's own window reads report,
   * which is the loop that made this necessary. A pass already running never
   * starts a second one on top of itself; it re-arms the timer on the way out.
   */
  private scheduleWindowsPublish(): void {
    if (this.disposed) return;
    if (this.publishAllDepth > 0) {
      this.windowsPublishPending = true;
      return;
    }
    if (this.windowsPublishTimer !== undefined) return;
    this.windowsPublishTimer = setTimeout(() => {
      this.windowsPublishTimer = undefined;
      if (this.disposed) return;
      void this.publishAllThreads().catch(() => undefined);
    }, this.windowsPublishDebounceMs);
    this.windowsPublishTimer.unref?.();
  }

  /**
   * Republish every thread from cached state. A backend health transition
   * changes what a panel must show but nothing the backend could tell us, and
   * querying it from the handler of the supervision loop's own event would put
   * a D-Bus round trip — and another connect attempt — on every failure the
   * loop reports, which is how a reconnect turns into a storm.
   */
  private republishAllThreads(): void {
    if (this.disposed) return;
    for (const [threadId, state] of this.threads) {
      state.version += 1;
      this.emit({ type: "computer.thread-state", state: this.threadSnapshot(threadId, state) });
    }
  }

  private threadRuntime(threadId: string): ThreadComputerRuntimeState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        version: 0,
        lastError: null,
        windows: [],
        screenSize: { width: 1, height: 1 },
        availability: {
          kind: "backend-unavailable",
          message: "Computer state has not been queried yet",
        },
        paneSurfaced: false,
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private threadSnapshot(threadId: string, state: ThreadComputerRuntimeState): ThreadComputerState {
    return {
      threadId: ThreadId.makeUnsafe(threadId),
      version: state.version,
      computerId: this.computerId,
      windows: state.windows,
      screenSize: state.screenSize,
      ...(state.cursor ? { cursor: state.cursor } : {}),
      agentActive: (this.agentCallsInFlight.get(threadId) ?? 0) > 0,
      controlledByOtherThread: this.lease !== null && this.lease.threadId !== threadId,
      availability: this.correctedAvailability(state.availability),
      health: this.backendHealth,
      capabilities: this.backendCapabilities,
      lastError: state.lastError,
    };
  }

  /**
   * The last availability read, corrected by live backend health. The cached
   * value is whatever the last successful query said, so without this a panel
   * keeps being told the desktop is available while the supervision loop is
   * still trying to get it back. Only a claim of `available` is overridden:
   * anything already blocked carries its own, better explanation — the platform
   * it is running on, or the plugin it could not load.
   */
  private correctedAvailability(availability: ComputerAvailability): ComputerAvailability {
    // A backend nobody has asked to connect is not disconnected, it is idle, and
    // health says "unavailable" for both. Correcting against it before the first
    // real use would report every desktop as broken until someone clicked
    // something — the exact opposite of what the probe is there to say.
    if (!this.backendEngaged) return availability;
    if (this.backendHealth.status === "connected" || availability.kind !== "available") {
      return availability;
    }
    return { kind: "backend-unavailable", message: healthUnavailableMessage(this.backendHealth) };
  }

  private isStreamWanted(epoch: number): boolean {
    return (
      !this.disposed &&
      this.streamDesired &&
      this.streamEpoch === epoch &&
      this.transport.streamSubscriberCount(this.computerId) > 0
    );
  }

  private recordError(error: unknown): void {
    const message = clampComputerMessage(
      errorMessage(error),
      "The computer backend reported an error without a message.",
    );
    for (const state of this.threads.values()) state.lastError = message;
    // Written without a publish, a stream attach failure never reached the
    // panel it explains. Debounced, because this can fire per frame or per
    // call during an outage.
    if (this.threads.size === 0) return;
    this.errorRepublishTimer ??= setTimeout(() => {
      this.errorRepublishTimer = undefined;
      for (const threadId of this.threads.keys()) {
        void this.publish(threadId, true).catch(() => undefined);
      }
    }, COMPUTER_ERROR_REPUBLISH_DEBOUNCE_MS);
    this.errorRepublishTimer.unref?.();
  }

  private emit(event: ComputerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One observer cannot stop the remaining observers.
      }
    }
  }
}

/**
 * The default travel measurement: decode both captures and correlate them. Both
 * halves already answer with undefined for anything they cannot handle, so a
 * capture in a format this does not decode costs the measurement, not the
 * scroll.
 */
async function measureScrollTravelFromPng(
  before: Uint8Array,
  after: Uint8Array,
): Promise<number | undefined> {
  const decodedBefore = await decodePngLuma(before);
  const decodedAfter = await decodePngLuma(after);
  if (!decodedBefore || !decodedAfter) return undefined;
  return estimateVerticalTravel(decodedBefore, decodedAfter);
}

/** Scroll telemetry is a reading, not a measurement instrument: two decimals is all it means. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The caller as an agent thread, or undefined for desktop input that belongs to
 * no thread — the human at the computer pane. Attribution and the desktop lease
 * must agree on who that is, so both read it here.
 */
function agentThreadId(threadId: string | undefined): string | undefined {
  const trimmed = threadId?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Why a healthy-looking availability is being withheld. The failure text comes
 * from the display server, so the whole message is clamped rather than only the
 * part this composes.
 */
function healthUnavailableMessage(health: ComputerHealth): string {
  const reason =
    health.status === "reconnecting"
      ? "Reconnecting to the desktop."
      : "The desktop backend is not connected.";
  return clampComputerMessage(
    health.lastFailure ? `${reason} Last failure: ${health.lastFailure.message}` : reason,
    reason,
  );
}

function windowNotFoundError(windowId: string): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_not_found",
    message:
      `No desktop window has id ${JSON.stringify(windowId)}. ` +
      "Call computer_list_windows for the current window ids.",
    notFound: true,
  });
}

/**
 * The raise/focus target for a control resolved through the accessibility tree.
 * The point comes along so a failed raise is still checked for occlusion:
 * nothing consulted the stacking order while matching the label, and the click
 * that follows is as misroutable as any other.
 */
function semanticPointTarget(resolved: ComputerResolvedTarget): PreparedTarget {
  return {
    point: resolved.point,
    ...(resolved.node.windowId ? { windowId: resolved.node.windowId } : {}),
  };
}

/**
 * Refusal for a scoped action whose window is covered at the point and could
 * not be raised out from under the windows covering it.
 *
 * Refusing beats warning. The input would land in another application, and a
 * warning read after the fact cannot undo a click that already fired — the live
 * failure this exists for was a model clicking a buried window repeatedly and
 * concluding the button was broken. The message names what is in the way and
 * both ways out, so the next call is a correct one rather than a retry.
 */
function occludedTargetError(
  windowId: string,
  point: ComputerPoint,
  covering: readonly ComputerWindow[],
  reason: string,
): ComputerTargetError {
  const blockers = covering
    .slice(0, 4)
    .map((window) => `${JSON.stringify(window.title || window.id)} (${window.id})`)
    .join(", ");
  return new ComputerTargetError({
    code: "computer_target_occluded",
    message:
      `Window ${JSON.stringify(windowId)} is covered at (${point.x}, ${point.y}) by ${blockers}, ` +
      `and this desktop could not raise it: ${reason}. The input would go to the covering window. ` +
      "Aim at a part of the target window that nothing covers, or move the covering window out of " +
      "the way first; or drop window_id to act on whatever is topmost at that point.",
  });
}

/**
 * Refusal for a scoped pointer action the desktop declined to deliver.
 *
 * A coordinate is validated against the window's frame, which includes the
 * invisible resize and shadow margins around it, so a point can sit inside
 * those bounds and still be outside the region the window accepts input in.
 * The window may equally have closed since it was listed. Either way the
 * remedy is the same, and it is not retrying the identical coordinate.
 */
function refusedInjectionError(
  action: string,
  windowId: string,
  point: ComputerPoint,
): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_refused",
    message:
      `The desktop refused to deliver ${action} to window ${JSON.stringify(windowId)} at ` +
      `(${point.x}, ${point.y}), so no input was sent. The window is not accepting input at that ` +
      "point: a window's bounds include invisible resize and shadow margins, and the window may " +
      "also have closed since it was listed. Aim nearer the middle of the control, target it by " +
      "label instead of a coordinate, or drop window_id to act on whatever is topmost there.",
  });
}

function clipboardUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError("This computer backend does not support clipboard access.");
}

function hasCoordinates(target: ComputerTarget): boolean {
  return typeof target.x === "number" && typeof target.y === "number";
}

/** Fields that only the accessibility tree can resolve. */
function hasLabelFields(target: ComputerTarget): boolean {
  return target.label !== undefined || target.role !== undefined;
}

function hasSemanticFields(target: ComputerTarget): boolean {
  return hasLabelFields(target) || target.windowId !== undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ComputerBackendError || error instanceof ComputerTargetError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
