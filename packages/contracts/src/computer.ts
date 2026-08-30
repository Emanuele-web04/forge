import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

// ── WebSocket surface ────────────────────────────────────────────────

export const COMPUTER_WS_METHODS = {
  // Thread-independent backend status for surfaces outside any conversation,
  // such as the settings screen. Everything else on this surface either acts on
  // the desktop or answers for one thread.
  getStatus: "computer.getStatus",
  listWindows: "computer.listWindows",
  getState: "computer.getState",
  getScreenSize: "computer.getScreenSize",
  launchApp: "computer.launchApp",
  click: "computer.click",
  doubleClick: "computer.doubleClick",
  rightClick: "computer.rightClick",
  moveCursor: "computer.moveCursor",
  drag: "computer.drag",
  scroll: "computer.scroll",
  typeText: "computer.typeText",
  pressKey: "computer.pressKey",
  hotkey: "computer.hotkey",
  setValue: "computer.setValue",
  performAction: "computer.performAction",
  getThreadState: "computer.getThreadState",
  subscribeEvents: "computer.subscribeEvents",
  // User-driven input from the computer dock pane. Separate from the tool
  // surface above because it must work with no agent turn in flight, and
  // because a pane only ever sends resolved desktop coordinates — never the
  // semantic (label/role) targets the agent tools resolve through AT-SPI.
  inputClick: "computer.input.click",
  inputScroll: "computer.input.scroll",
  inputKey: "computer.input.key",
} as const;

export const COMPUTER_WS_CHANNELS = {
  event: "computer.event",
} as const;

/**
 * Caps a window or computer identifier, which a compositor-side enumerator
 * copies off the desktop and must clamp to this.
 */
export const COMPUTER_ID_MAX_LENGTH = 128;
/**
 * Exported because it bounds `ComputerActionResult.value`, and the clipboard
 * read path must enforce it before putting clipboard text on that field.
 */
export const COMPUTER_TEXT_MAX_LENGTH = 16 * 1024;
/**
 * Exported because backend window enumerators copy titles and app names
 * verbatim off the desktop, and must clamp them to this before constructing
 * `ComputerWindow` objects.
 */
export const COMPUTER_LABEL_MAX_LENGTH = 1_024;
/**
 * Exported because the backend composes health and availability messages from
 * error text it does not control, and must clamp them to this before they reach
 * a state payload.
 */
export const COMPUTER_MESSAGE_MAX_LENGTH = 2_048;
/**
 * Caps both a reported window list and one window's occluder list. Exported
 * because a backend enumerator must clamp its own list to this.
 */
export const COMPUTER_WINDOW_LIST_MAX_LENGTH = 512;
/**
 * A sane ceiling on one window's `occludedBy` entries, far below the list
 * maximum: stacking metadata is an N² hint in the worst case, and no caller
 * needs hundreds of occluders. Exported for the same reason as above.
 */
export const COMPUTER_OCCLUDERS_MAX_LENGTH = 32;

/**
 * Thread-activity kind appended by the agent gateway when a computer tool call
 * is rejected because the chat does not have computer control enabled. The web
 * app keys its actionable "enable computer control" chat card off this kind.
 */
export const COMPUTER_CONTROL_DENIED_ACTIVITY_KIND = "computer.control-denied";

export const ComputerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COMPUTER_ID_MAX_LENGTH),
).check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/));
export type ComputerId = typeof ComputerId.Type;

export const ComputerWindowId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COMPUTER_ID_MAX_LENGTH),
);
export type ComputerWindowId = typeof ComputerWindowId.Type;

export const ComputerAvailability = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    backend: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported-platform"),
    platform: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    kind: Schema.Literal("backend-unavailable"),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_MESSAGE_MAX_LENGTH)),
  }),
]);
export type ComputerAvailability = typeof ComputerAvailability.Type;

/**
 * What the backend's supervision loop is doing right now, as opposed to what a
 * boot-time availability probe once found. `reconnecting` means the display
 * server dropped out and a retry is pending, which is the state a panel must be
 * able to tell apart from both a healthy desktop and a permanently dead one.
 */
export const ComputerHealthStatus = Schema.Literals(["connected", "reconnecting", "unavailable"]);
export type ComputerHealthStatus = typeof ComputerHealthStatus.Type;

export const ComputerHealthFailure = Schema.Struct({
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_MESSAGE_MAX_LENGTH)),
  at: IsoDateTime,
});
export type ComputerHealthFailure = typeof ComputerHealthFailure.Type;

export const ComputerHealth = Schema.Struct({
  status: ComputerHealthStatus,
  /**
   * Failures since the last successful connect, back to `0` as soon as one
   * succeeds, so a non-zero count always describes the outage in progress
   * rather than the session's whole history.
   */
  consecutiveFailures: NonNegativeInt,
  /**
   * Connections re-established since the process started. Unlike the
   * consecutive count this is never reset, because a desktop that keeps
   * recovering is still a desktop that keeps dying.
   */
  reconnects: NonNegativeInt,
  /**
   * Newest supervision failure, kept after recovery so a reconnect that already
   * healed can still be explained. Absent until the backend has failed once,
   * which is what "nothing has gone wrong yet" looks like.
   */
  lastFailure: Schema.optional(ComputerHealthFailure),
  /**
   * Whether the connected backend can capture pixels. A backend can be
   * connected and driveable while its capture path is missing, which is the
   * difference between a blank pane and a broken one.
   */
  captureAvailable: Schema.Boolean,
});
export type ComputerHealth = typeof ComputerHealth.Type;

/**
 * What this desktop backend can actually do, as opposed to what the tool
 * surface describes in general.
 *
 * The backends differ in kind, not only in quality: one backend may enumerate
 * windows with geometry, stack them, and draw a ghost cursor, while another may
 * have none of that. A caller that cannot tell those apart lies to the model — "no windows"
 * when the truth is "no window enumeration exists here" — so the answer travels
 * with the state instead of being inferred from the backend's name.
 */
export const ComputerCapabilities = Schema.Struct({
  /** Windows can be enumerated at all. `false` means listing refuses, never `[]`. */
  windows: Schema.Boolean,
  /** Enumerated windows carry `bounds`. False on display servers with no client-visible geometry. */
  windowBounds: Schema.Boolean,
  /** `stackingIndex` and `occludedBy` are reported, so occlusion is knowable. */
  stacking: Schema.Boolean,
  capture: Schema.Boolean,
  input: Schema.Boolean,
  clipboard: Schema.Boolean,
  /** A window can be focused or raised, so window-targeted typing is possible. */
  activation: Schema.Boolean,
  /** A second pointer the agent drives, drawn without moving the human's cursor. */
  ghostCursor: Schema.Boolean,
  /**
   * The driven desktop is the display the human is already looking at, so every
   * action is visible without a preview. Auto-opening the Computer pane keys
   * off this being false: on an offscreen desktop the pane is the only window
   * onto the agent's work, while mirroring the human's own screen back at them
   * is noise. The agent still drives that visible desktop through a seat of its
   * own — never the human's.
   */
  visibleDesktop: Schema.Boolean,
});
export type ComputerCapabilities = typeof ComputerCapabilities.Type;

// ── Perception ──────────────────────────────────────────────────────

export const ComputerRect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ComputerRect = typeof ComputerRect.Type;

export const ComputerPoint = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type ComputerPoint = typeof ComputerPoint.Type;

export const ComputerScreenSize = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  scale: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
});
export type ComputerScreenSize = typeof ComputerScreenSize.Type;

export const ComputerWindow = Schema.Struct({
  id: ComputerWindowId,
  title: Schema.String.check(Schema.isMaxLength(COMPUTER_LABEL_MAX_LENGTH)),
  appName: Schema.optional(Schema.String.check(Schema.isMaxLength(COMPUTER_LABEL_MAX_LENGTH))),
  pid: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * Absent when the backend exposes no window geometry — a client under
   * Some display servers cannot expose client geometry. Callers must treat an
   * absent rect as unknown rather than as the origin, and
   * `ComputerCapabilities.windowBounds` says up front which case this is.
   */
  bounds: Schema.optional(ComputerRect),
  focused: Schema.Boolean,
  /**
   * Whether the compositor reports this window as activated to its client.
   * Distinct from `focused` (the agent's own input target): toolkits gate
   * keyboard-shortcut dispatch on activation, so a hotkey sent to a window
   * that is not active may be silently dropped. Optional because a backend
   * need not expose activation.
   */
  active: Schema.optional(Schema.Boolean),
  minimized: Schema.Boolean,
  visible: Schema.Boolean,
  /**
   * Depth in the compositor stacking order, `0` being the topmost reported
   * window. Optional because a backend need not expose a stacking order.
   */
  stackingIndex: Schema.optional(NonNegativeInt),
  /**
   * Ids of the windows above this one that overlap its bounds, so a caller can
   * tell that a coordinate click would land on a different window.
   */
  occludedBy: Schema.optional(
    Schema.Array(ComputerWindowId).check(Schema.isMaxLength(COMPUTER_WINDOW_LIST_MAX_LENGTH)),
  ),
});
export type ComputerWindow = typeof ComputerWindow.Type;

export const ComputerUiFrame = ComputerRect;
export type ComputerUiFrame = typeof ComputerUiFrame.Type;

export const ComputerUiPoint = ComputerPoint;
export type ComputerUiPoint = typeof ComputerUiPoint.Type;

/** Deepest accessibility path a backend may address, matching the helper's cap. */
const COMPUTER_NODE_PATH_MAX_DEPTH = 64;

export interface ComputerUiNode {
  readonly role: string;
  readonly label: string | null;
  readonly value: string | null;
  readonly description: string | null;
  readonly frame: ComputerUiFrame;
  readonly activationPoint: ComputerUiPoint | null;
  readonly onScreen: boolean;
  readonly windowId: ComputerWindowId | null;
  /**
   * Child-index path from the owning window's accessibility root, present when
   * the perception source can re-resolve a node without holding a live handle.
   * A semantic write addresses `windowId` + `nodePath` on a fresh read, so the
   * pair stays valid across helper restarts while the tree is unchanged.
   */
  readonly nodePath?: readonly number[] | undefined;
  /** The node accepts a semantic text write (AT-SPI `EditableText`). */
  readonly editable?: boolean | undefined;
  readonly children: readonly ComputerUiNode[];
}

export const ComputerUiNode: Schema.Schema<ComputerUiNode> = Schema.Struct({
  role: Schema.String.check(Schema.isMaxLength(128)),
  label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(COMPUTER_LABEL_MAX_LENGTH))),
  value: Schema.NullOr(Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH))),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH))),
  frame: ComputerUiFrame,
  activationPoint: Schema.NullOr(ComputerUiPoint),
  onScreen: Schema.Boolean,
  windowId: Schema.NullOr(ComputerWindowId),
  nodePath: Schema.optional(
    Schema.Array(NonNegativeInt).check(Schema.isMaxLength(COMPUTER_NODE_PATH_MAX_DEPTH)),
  ),
  editable: Schema.optional(Schema.Boolean),
  children: Schema.Array(Schema.suspend((): Schema.Schema<ComputerUiNode> => ComputerUiNode)).check(
    Schema.isMaxLength(2_048),
  ),
});

export const ComputerScreenshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 * 1024 * 1024 })),
  bytesBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(88 * 1024 * 1024)),
  /** Desktop rect the capture covers, in the same global space as window bounds. */
  region: Schema.optional(ComputerRect),
  /** Screenshot pixels per desktop pixel, so `desktop = region.origin + pixel / scale`. */
  scale: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  capturedAt: IsoDateTime,
});
export type ComputerScreenshot = typeof ComputerScreenshot.Type;

export const ComputerState = Schema.Struct({
  computerId: ComputerId,
  windows: Schema.Array(ComputerWindow).check(Schema.isMaxLength(COMPUTER_WINDOW_LIST_MAX_LENGTH)),
  screenSize: ComputerScreenSize,
  root: Schema.optional(ComputerUiNode),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024))),
  screenshot: Schema.optional(ComputerScreenshot),
  capturedAt: IsoDateTime,
});
export type ComputerState = typeof ComputerState.Type;

export const ThreadComputerState = Schema.Struct({
  threadId: ThreadId,
  version: NonNegativeInt,
  computerId: ComputerId,
  windows: Schema.Array(ComputerWindow).check(Schema.isMaxLength(COMPUTER_WINDOW_LIST_MAX_LENGTH)),
  screenSize: ComputerScreenSize,
  cursor: Schema.optional(ComputerPoint),
  agentActive: Schema.Boolean,
  /**
   * Another conversation holds the exclusive desktop lease, so this thread's
   * agent actions are refused until it is released. Perception is unaffected.
   * The owning thread is deliberately not named: a thread's state is delivered
   * to that thread's clients, and nothing else here crosses conversations.
   */
  controlledByOtherThread: Schema.Boolean,
  availability: ComputerAvailability,
  /**
   * Live backend health, republished whenever the supervision loop changes it.
   * Required rather than optional: an absent health field would be
   * indistinguishable from a healthy one, and every producer of this state has
   * a backend to read it from.
   */
  health: ComputerHealth,
  /**
   * What this backend can do. Required for the same reason `health` is: an
   * absent capability set is indistinguishable from a fully capable backend,
   * and every producer of this state has a backend to ask.
   */
  capabilities: ComputerCapabilities,
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(COMPUTER_MESSAGE_MAX_LENGTH))),
});
export type ThreadComputerState = typeof ThreadComputerState.Type;

export const ComputerGetStatusInput = Schema.Struct({});
export type ComputerGetStatusInput = typeof ComputerGetStatusInput.Type;

/**
 * `ThreadComputerState` without the thread: the settings screen asks how this
 * server's desktop backend is doing, and there is no conversation to attribute
 * the answer to. Availability is corrected by live health the same way a thread
 * snapshot's is.
 */
export const ComputerStatusResult = Schema.Struct({
  computerId: ComputerId,
  availability: ComputerAvailability,
  health: ComputerHealth,
  capabilities: ComputerCapabilities,
});
export type ComputerStatusResult = typeof ComputerStatusResult.Type;

export const ComputerListWindowsInput = Schema.Struct({});
export type ComputerListWindowsInput = typeof ComputerListWindowsInput.Type;

export const ComputerListWindowsResult = Schema.Struct({
  computerId: ComputerId,
  windows: Schema.Array(ComputerWindow).check(Schema.isMaxLength(COMPUTER_WINDOW_LIST_MAX_LENGTH)),
  availability: ComputerAvailability,
});
export type ComputerListWindowsResult = typeof ComputerListWindowsResult.Type;

export const ComputerGetStateInput = Schema.Struct({
  includeScreenshot: Schema.optional(Schema.Boolean),
  includeText: Schema.optional(Schema.Boolean),
});
export type ComputerGetStateInput = typeof ComputerGetStateInput.Type;

export const ComputerGetScreenSizeInput = Schema.Struct({});
export type ComputerGetScreenSizeInput = typeof ComputerGetScreenSizeInput.Type;

export const ComputerGetScreenSizeResult = Schema.Struct({
  computerId: ComputerId,
  screenSize: ComputerScreenSize,
  availability: ComputerAvailability,
});
export type ComputerGetScreenSizeResult = typeof ComputerGetScreenSizeResult.Type;

export const ComputerThreadInput = Schema.Struct({ threadId: ThreadId });
export type ComputerThreadInput = typeof ComputerThreadInput.Type;

export const ComputerLaunchAppInput = Schema.Struct({
  app: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  arguments: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(Schema.isMaxLength(128)),
  ),
});
export type ComputerLaunchAppInput = typeof ComputerLaunchAppInput.Type;

export const ComputerLaunchAppResult = Schema.Struct({
  computerId: ComputerId,
  app: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  /**
   * The executable the requested name resolved to. Reported back so a caller
   * that passed a flatpak app id or a .desktop id learns what actually ran.
   */
  resolvedCommand: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  window: Schema.NullOr(ComputerWindow),
});
export type ComputerLaunchAppResult = typeof ComputerLaunchAppResult.Type;

// ── Action inputs ───────────────────────────────────────────────────

const ComputerTargetFields = {
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  label: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_LABEL_MAX_LENGTH)),
  ),
  role: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  windowId: Schema.optional(ComputerWindowId),
} as const;

export const ComputerTarget = Schema.Struct(ComputerTargetFields);
export type ComputerTarget = typeof ComputerTarget.Type;

export const ComputerClickInput = ComputerTarget;
export type ComputerClickInput = typeof ComputerClickInput.Type;
export const ComputerDoubleClickInput = ComputerTarget;
export type ComputerDoubleClickInput = typeof ComputerDoubleClickInput.Type;
export const ComputerRightClickInput = ComputerTarget;
export type ComputerRightClickInput = typeof ComputerRightClickInput.Type;
export const ComputerMoveCursorInput = ComputerTarget;
export type ComputerMoveCursorInput = typeof ComputerMoveCursorInput.Type;

export const ComputerDragInput = Schema.Struct({
  from: ComputerTarget,
  to: ComputerTarget,
  durationMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))),
});
export type ComputerDragInput = typeof ComputerDragInput.Type;

export const ComputerScrollInput = Schema.Struct({
  ...ComputerTargetFields,
  deltaX: Schema.Finite,
  deltaY: Schema.Finite,
});
export type ComputerScrollInput = typeof ComputerScrollInput.Type;

export const ComputerTypeTextInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH)),
});
export type ComputerTypeTextInput = typeof ComputerTypeTextInput.Type;

export const ComputerPressKeyInput = Schema.Struct({
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type ComputerPressKeyInput = typeof ComputerPressKeyInput.Type;

export const ComputerHotkeyInput = Schema.Struct({
  keys: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
});
export type ComputerHotkeyInput = typeof ComputerHotkeyInput.Type;

export const ComputerSetValueInput = Schema.Struct({
  ...ComputerTargetFields,
  value: Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH)),
});
export type ComputerSetValueInput = typeof ComputerSetValueInput.Type;

export const ComputerPerformActionInput = Schema.Struct({
  ...ComputerTargetFields,
  action: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type ComputerPerformActionInput = typeof ComputerPerformActionInput.Type;

// ── User input from the computer dock pane ──────────────────────────

/** Largest desktop coordinate a pane may address, matching `ComputerScreenSize`. */
const COMPUTER_INPUT_COORDINATE_MAX = 32_767;
/**
 * Per-event scroll ceiling. A wheel notch is tens of pixels; anything past this
 * is a runaway accumulator rather than a gesture, and forwarding it would spin
 * the desktop through thousands of lines.
 */
const COMPUTER_INPUT_SCROLL_LIMIT = 4_096;

/**
 * Desktop logical pixels, the same space as window bounds. Integers only: the
 * pane resolves a pointer to exactly one desktop pixel, and a fractional
 * coordinate would round differently on each hop.
 */
const ComputerInputCoordinate = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: COMPUTER_INPUT_COORDINATE_MAX }),
);

const ComputerInputDelta = Schema.Finite.check(
  Schema.isBetween({ minimum: -COMPUTER_INPUT_SCROLL_LIMIT, maximum: COMPUTER_INPUT_SCROLL_LIMIT }),
);

/** Only the buttons the seat can synthesize as a complete press/release pair. */
export const ComputerInputButton = Schema.Literals(["left", "right"]);
export type ComputerInputButton = typeof ComputerInputButton.Type;

export const ComputerInputModifier = Schema.Literals(["ctrl", "alt", "shift", "meta"]);
export type ComputerInputModifier = typeof ComputerInputModifier.Type;

export const ComputerInputClickInput = Schema.Struct({
  x: ComputerInputCoordinate,
  y: ComputerInputCoordinate,
  /** Defaults to the left button. */
  button: Schema.optional(ComputerInputButton),
  /**
   * `2` issues the backend's double click, whose two presses are spaced closely
   * enough for a toolkit to pair them; two separate single clicks cannot be,
   * because each one pays a browser round trip and a pointer glide.
   */
  clickCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 }))),
});
export type ComputerInputClickInput = typeof ComputerInputClickInput.Type;

export const ComputerInputScrollInput = Schema.Struct({
  x: ComputerInputCoordinate,
  y: ComputerInputCoordinate,
  deltaX: ComputerInputDelta,
  deltaY: ComputerInputDelta,
});
export type ComputerInputScrollInput = typeof ComputerInputScrollInput.Type;

export const ComputerInputKeyInput = Schema.Struct({
  /**
   * One key in the backend's vocabulary: a single printable character, or a
   * name such as `enter`, `escape`, `arrowleft`, `f5`, `space`.
   */
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** Held for the duration of the key press, in the order given. */
  modifiers: Schema.optional(Schema.Array(ComputerInputModifier).check(Schema.isMaxLength(4))),
});
export type ComputerInputKeyInput = typeof ComputerInputKeyInput.Type;

export const ComputerActionResult = Schema.Struct({
  computerId: ComputerId,
  action: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  point: Schema.optional(ComputerPoint),
  /** Where the pointer actually landed when the display server clamped the request. */
  clampedTo: Schema.optional(ComputerPoint),
  windowId: Schema.optional(ComputerWindowId),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH))),
  /**
   * Scroll telemetry: what was asked, what was injected after gearing
   * correction, and what the window content measurably did. `traveledY` is in
   * logical pixels with the same sign convention as `deltaY` (positive = toward
   * the end of the content); absent when the travel could not be measured.
   * `gearing` is the learned travel-per-requested-pixel for this window — 1
   * means pixel-true.
   */
  scroll: Schema.optional(
    Schema.Struct({
      requested: Schema.Struct({ deltaX: Schema.Number, deltaY: Schema.Number }),
      injected: Schema.Struct({ deltaX: Schema.Number, deltaY: Schema.Number }),
      traveledY: Schema.optional(Schema.Number),
      gearing: Schema.optional(Schema.Number),
    }),
  ),
});
export type ComputerActionResult = typeof ComputerActionResult.Type;

// ── Push events ─────────────────────────────────────────────────────

export const ComputerThreadStateEvent = Schema.Struct({
  type: Schema.Literal("computer.thread-state"),
  state: ThreadComputerState,
});
export type ComputerThreadStateEvent = typeof ComputerThreadStateEvent.Type;

export const ComputerWindowsChangedEvent = Schema.Struct({
  type: Schema.Literal("computer.windows-changed"),
  windows: Schema.Array(ComputerWindow).check(Schema.isMaxLength(COMPUTER_WINDOW_LIST_MAX_LENGTH)),
});
export type ComputerWindowsChangedEvent = typeof ComputerWindowsChangedEvent.Type;

export const ComputerActionEvent = Schema.Struct({
  type: Schema.Literal("computer.action"),
  action: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(COMPUTER_MESSAGE_MAX_LENGTH))),
  /**
   * The thread whose agent turn drove the action. Absent for desktop input the
   * user sent from a computer pane, which belongs to no thread.
   */
  threadId: Schema.optional(ThreadId),
});
export type ComputerActionEvent = typeof ComputerActionEvent.Type;

export const ComputerFrameEvent = Schema.Struct({
  type: Schema.Literal("computer.frame"),
  header: Schema.Struct({
    computerId: ComputerId,
    sequence: NonNegativeInt,
    timestampMs: Schema.Finite,
    keyframe: Schema.Boolean,
    codecConfig: Schema.Boolean,
  }),
});
export type ComputerFrameEvent = typeof ComputerFrameEvent.Type;

/**
 * Carries the thread so whichever chat happens to be visible cannot steal the
 * pane, mirroring DeviceOpenPaneRequestedEvent.
 */
export const ComputerOpenPaneRequestedEvent = Schema.Struct({
  type: Schema.Literal("computer.open-pane-requested"),
  threadId: ThreadId,
});
export type ComputerOpenPaneRequestedEvent = typeof ComputerOpenPaneRequestedEvent.Type;

export const ComputerEvent = Schema.Union([
  ComputerThreadStateEvent,
  ComputerWindowsChangedEvent,
  ComputerActionEvent,
  ComputerFrameEvent,
  ComputerOpenPaneRequestedEvent,
]);
export type ComputerEvent = typeof ComputerEvent.Type;

// ── Frame channel envelope (type-level contract only) ────────────────

export const COMPUTER_FRAME_MAGIC = 0x5343;
export const COMPUTER_FRAME_VERSION = 1;
export const COMPUTER_FRAME_FLAG_KEYFRAME = 0b0000_0001;
export const COMPUTER_FRAME_FLAG_CODEC_CONFIG = 0b0000_0010;
export const COMPUTER_FRAME_HEADER_FIXED_BYTES = 17;
export const COMPUTER_FRAME_MAX_COMPUTER_ID_BYTES = 255;

export const ComputerFrameHeader = Schema.Struct({
  computerId: ComputerId,
  sequence: NonNegativeInt,
  timestampMs: Schema.Finite,
  keyframe: Schema.Boolean,
  codecConfig: Schema.Boolean,
});
export type ComputerFrameHeader = typeof ComputerFrameHeader.Type;

export const ComputerFrameDecodeErrorReason = Schema.Literals([
  "too-short",
  "bad-magic",
  "unsupported-version",
  "truncated-computer-id",
  "invalid-computer-id",
]);
export type ComputerFrameDecodeErrorReason = typeof ComputerFrameDecodeErrorReason.Type;
