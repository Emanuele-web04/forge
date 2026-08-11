import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

// ── WebSocket surface ────────────────────────────────────────────────

export const DEVICE_WS_METHODS = {
  list: "device.list",
  boot: "device.boot",
  shutdown: "device.shutdown",
  attach: "device.attach",
  detach: "device.detach",
  getThreadState: "device.getThreadState",
  tap: "device.tap",
  swipe: "device.swipe",
  typeText: "device.typeText",
  keyEvent: "device.keyEvent",
  pressButton: "device.pressButton",
  installApp: "device.installApp",
  launchApp: "device.launchApp",
  openUrl: "device.openUrl",
  screenshot: "device.screenshot",
  startRecording: "device.startRecording",
  stopRecording: "device.stopRecording",
  describeUi: "device.describeUi",
  scrollToElement: "device.scrollToElement",
  subscribeEvents: "device.subscribeEvents",
} as const;

// One channel carries every device push so a pane costs a single stream lease
// out of WS_STREAM_LIMITS, the same way orchestration multiplexes its domain events.
export const DEVICE_WS_CHANNELS = {
  event: "device.event",
} as const;

// ── Core identifiers and enums ───────────────────────────────────────

const DEVICE_UDID_MAX_LENGTH = 128;
const DEVICE_TEXT_MAX_LENGTH = 4_096;
const DEVICE_PATH_MAX_LENGTH = 1_024;
const DEVICE_URL_MAX_LENGTH = 8_192;
const DEVICE_MESSAGE_MAX_LENGTH = 2_048;

/**
 * Simulator UDIDs are UUIDs today; the charset is widened so an Android
 * emulator serial (`emulator-5554`) fits the same contract without a schema break.
 */
export const DeviceUdid = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DEVICE_UDID_MAX_LENGTH),
).check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/));
export type DeviceUdid = typeof DeviceUdid.Type;

export const DevicePlatform = Schema.Literals(["ios-simulator"]);
export type DevicePlatform = typeof DevicePlatform.Type;

export const DeviceRuntimeState = Schema.Literals([
  "shutdown",
  "booting",
  "booted",
  "shutting-down",
]);
export type DeviceRuntimeState = typeof DeviceRuntimeState.Type;

/**
 * Who owns the boot. Synara only auto-shuts down devices it booted itself;
 * anything the user started (pane picker, Simulator.app) outlives the session.
 */
export const DeviceBootSource = Schema.Literals(["synara", "user"]);
export type DeviceBootSource = typeof DeviceBootSource.Type;

/**
 * Which chassis a device is drawn in.
 *
 * Comes from the simulator device type's product family rather than from the
 * device's name, which only works for as long as every tablet Apple ships has
 * "iPad" in it. Optional because a backend that cannot read the device type
 * profile still lists devices; the pane falls back to the name there.
 */
export const DeviceFamily = Schema.Literals(["phone", "tablet"]);
export type DeviceFamily = typeof DeviceFamily.Type;

export const DeviceDescriptor = Schema.Struct({
  platform: DevicePlatform,
  udid: DeviceUdid,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /** Human-readable runtime label, e.g. `iOS 18.2`. */
  runtime: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  state: DeviceRuntimeState,
  bootSource: DeviceBootSource,
  family: Schema.optional(DeviceFamily),
  /**
   * Screen size in device points, and the pixel-per-point scale.
   *
   * Input coordinates are device points while video frames are pixels, so a
   * pane mapping a canvas click without dividing by the scale sends
   * coordinates several times too large (1206x2622 pixels against a 402x874
   * point screen). These fields are what let it convert.
   *
   * Populated at discovery from the simulator's device type profile, and
   * confirmed by the native helper's attachment once a device is streamed. The
   * discovery value is what lets the pane draw the right chassis the moment a
   * device is picked, instead of an iPhone-shaped placeholder that snaps to an
   * iPad several seconds later.
   *
   * Optional because a backend that cannot read the profile (or a fake one)
   * still lists devices, and requiring it would break those listings.
   */
  geometry: Schema.optional(
    Schema.Struct({
      pointWidth: Schema.Finite.check(Schema.isGreaterThan(0)),
      pointHeight: Schema.Finite.check(Schema.isGreaterThan(0)),
      scale: Schema.Finite.check(Schema.isGreaterThan(0)),
    }),
  ),
});
export type DeviceDescriptor = typeof DeviceDescriptor.Type;

export type DeviceGeometry = NonNullable<DeviceDescriptor["geometry"]>;

/** Alias kept because the pane talks about "device state" while the manager stores descriptors. */
export const DeviceState = DeviceDescriptor;
export type DeviceState = DeviceDescriptor;

// ── Availability / setup gating ──────────────────────────────────────

export const DeviceSetupStepId = Schema.Literals([
  "install-xcode",
  "accept-xcode-license",
  "select-xcode-command-line-tools",
  "install-ios-runtime",
  "build-device-helper",
]);
export type DeviceSetupStepId = typeof DeviceSetupStepId.Type;

export const DeviceSetupStep = Schema.Struct({
  id: DeviceSetupStepId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  done: Schema.Boolean,
  /** Optional one-line hint, e.g. the command that completes the step. */
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(DEVICE_MESSAGE_MAX_LENGTH))),
});
export type DeviceSetupStep = typeof DeviceSetupStep.Type;

/**
 * The helper capabilities that can fail independently.
 *
 * Each maps to one group of private symbols the helper resolves at runtime
 * (see `apps/server/native/device-helper/Sources/SymbolManifest.swift`). Apple
 * moves these between Xcode releases, and they do not move together: naming
 * them individually is what lets a broken accessibility path leave streaming
 * and input working.
 */
export const DeviceCapabilityId = Schema.Literals([
  /** Reading the device framebuffer — the live video stream. */
  "framebuffer",
  /** Injecting touches, keys and hardware buttons. */
  "hid",
  /** Reading the accessibility tree (`device_describe_ui`). */
  "accessibility",
  /** Hardware H.264 encoding of captured frames. */
  "encoder",
]);
export type DeviceCapabilityId = typeof DeviceCapabilityId.Type;

export const DeviceCapabilityStatus = Schema.Struct({
  id: DeviceCapabilityId,
  ok: Schema.Boolean,
  /** The private symbol that could not be resolved, when that is the cause. */
  missingSymbol: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  /** A failure that is not a missing symbol (framework load, encoder refusal). */
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(DEVICE_MESSAGE_MAX_LENGTH))),
});
export type DeviceCapabilityStatus = typeof DeviceCapabilityStatus.Type;

/** The toolchain a capability report was measured against. */
export const DeviceToolchain = Schema.Struct({
  xcodeVersion: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  xcodeBuild: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  macOS: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type DeviceToolchain = typeof DeviceToolchain.Type;

/**
 * Why (or whether) the pane can run, modelled the way AppSnap models its
 * permission states: the UI renders one of these instead of guessing from errors.
 */
export const DeviceAvailability = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    /**
     * Present when the helper reported per-capability results. Optional so an
     * older server (or a fake backend) that only answers "available" still
     * validates; absent means "no capability detail", not "nothing works".
     */
    capabilities: Schema.optional(
      Schema.Array(DeviceCapabilityStatus).check(Schema.isMaxLength(16)),
    ),
    toolchain: Schema.optional(DeviceToolchain),
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported-platform"),
    platform: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    kind: Schema.Literal("setup-required"),
    steps: Schema.Array(DeviceSetupStep).check(Schema.isMaxLength(16)),
  }),
  /**
   * Setup is complete and the helper runs, but at least one capability failed
   * its preflight — typically a private symbol Apple moved in a new Xcode.
   *
   * Distinct from `setup-required` because there is nothing for the user to
   * install: the pane opens and everything backed by a working capability keeps
   * working. Only the broken parts refuse, and they say which Xcode broke them.
   */
  Schema.Struct({
    kind: Schema.Literal("degraded"),
    capabilities: Schema.Array(DeviceCapabilityStatus).check(Schema.isMaxLength(16)),
    toolchain: Schema.optional(DeviceToolchain),
  }),
  // The private-framework helper is compiled on demand against the user's Xcode;
  // a compile or launch failure is a designed state, not a generic error toast.
  Schema.Struct({
    kind: Schema.Literal("helper-unavailable"),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_MESSAGE_MAX_LENGTH)),
  }),
]);
export type DeviceAvailability = typeof DeviceAvailability.Type;

/** The capabilities each device operation depends on, for precise failures. */
export const DEVICE_CAPABILITY_LABELS: Record<DeviceCapabilityId, string> = {
  framebuffer: "Screen capture",
  hid: "Touch and keyboard input",
  accessibility: "Accessibility inspection",
  encoder: "Video encoding",
};

// ── Thread-scoped state ──────────────────────────────────────────────

/**
 * How far along a thread's attachment is.
 *
 * A cold boot takes the better part of a minute and then publishes its display
 * a few seconds after reporting itself booted, so "attached" is not one instant
 * but a sequence. The pane says which stage it is in rather than showing a bare
 * spinner for a minute, and the phases are named for what the user is waiting
 * on, not for the internal call that is in flight.
 */
export const DeviceAttachPhase = Schema.Literals([
  /** The simulator is starting up. */
  "booting",
  /** Booted, but it has not published a screen to capture yet. */
  "waiting-for-display",
  /** The display exists; the video stream is being opened. */
  "connecting",
]);
export type DeviceAttachPhase = typeof DeviceAttachPhase.Type;

export const ThreadDeviceState = Schema.Struct({
  threadId: ThreadId,
  /** Monotonic per thread; lets the pane drop out-of-order pushes. */
  version: NonNegativeInt,
  attachedDeviceUdid: Schema.NullOr(DeviceUdid),
  /**
   * Set while the attachment is still coming up, null once it is streaming or
   * has failed. Non-null with `attachedDeviceUdid` already set is the normal
   * case: the thread's intent is recorded first so the pane can name the device
   * it is waiting on.
   */
  attachPhase: Schema.optional(Schema.NullOr(DeviceAttachPhase)),
  /** Devices the pane may show: booted devices plus anything Synara is booting. */
  devices: Schema.Array(DeviceDescriptor).check(Schema.isMaxLength(64)),
  /** True while an agent tool is driving input, so the pane can show the badge. */
  agentActive: Schema.Boolean,
  availability: DeviceAvailability,
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(DEVICE_MESSAGE_MAX_LENGTH))),
});
export type ThreadDeviceState = typeof ThreadDeviceState.Type;

// ── Control-plane inputs and results ─────────────────────────────────

/** Devices Synara itself booted are capped globally; viewing already-booted devices is not. */
export const DEVICE_SYNARA_BOOT_LIMIT = 3;

const DeviceTargetInput = Schema.Struct({ udid: DeviceUdid });

export const DeviceListInput = Schema.Struct({
  /** Include shut-down devices; the pane picker wants them, the agent usually does not. */
  includeShutdown: Schema.optional(Schema.Boolean),
});
export type DeviceListInput = typeof DeviceListInput.Type;

export const DeviceListResult = Schema.Struct({
  devices: Schema.Array(DeviceDescriptor).check(Schema.isMaxLength(256)),
  availability: DeviceAvailability,
});
export type DeviceListResult = typeof DeviceListResult.Type;

export const DeviceBootInput = DeviceTargetInput;
export type DeviceBootInput = typeof DeviceBootInput.Type;

/**
 * Boot is refusable rather than fatal: past DEVICE_SYNARA_BOOT_LIMIT the caller
 * is handed the shutdown candidates so the pane can prompt instead of erroring.
 */
export const DeviceBootResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("booted"), device: DeviceDescriptor }),
  Schema.Struct({
    kind: Schema.Literal("boot-limit-reached"),
    limit: NonNegativeInt,
    synaraBooted: Schema.Array(DeviceDescriptor).check(Schema.isMaxLength(64)),
  }),
]);
export type DeviceBootResult = typeof DeviceBootResult.Type;

export const DeviceShutdownInput = DeviceTargetInput;
export type DeviceShutdownInput = typeof DeviceShutdownInput.Type;

export const DeviceAttachInput = Schema.Struct({
  threadId: ThreadId,
  udid: DeviceUdid,
});
export type DeviceAttachInput = typeof DeviceAttachInput.Type;

export const DeviceDetachInput = Schema.Struct({ threadId: ThreadId });
export type DeviceDetachInput = typeof DeviceDetachInput.Type;

export const DeviceThreadInput = Schema.Struct({ threadId: ThreadId });
export type DeviceThreadInput = typeof DeviceThreadInput.Type;

// ── Input injection ──────────────────────────────────────────────────

// Device points, not pixels. The ceiling clears any current iPad in points
// while still rejecting nonsense coordinates from a mis-scaled canvas.
const DeviceCoordinate = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }));

/**
 * A tap names either a point or an element.
 *
 * Element targeting exists because the coordinate arithmetic is where taps go
 * wrong: the caller must pick the right node and then the right coordinate
 * within it, and a control merged into its row has a frame centre that does
 * nothing at all. Naming the label lets the server resolve both. The point
 * form stays for anything the accessibility tree does not label.
 */
export const DeviceTapInput = Schema.Struct({
  udid: DeviceUdid,
  x: Schema.optional(DeviceCoordinate),
  y: Schema.optional(DeviceCoordinate),
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
  role: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type DeviceTapInput = typeof DeviceTapInput.Type;

export const DEVICE_SWIPE_DURATION_MIN_MS = 0;
export const DEVICE_SWIPE_DURATION_MAX_MS = 10_000;

export const DeviceSwipeInput = Schema.Struct({
  udid: DeviceUdid,
  fromX: DeviceCoordinate,
  fromY: DeviceCoordinate,
  toX: DeviceCoordinate,
  toY: DeviceCoordinate,
  durationMs: Schema.Int.check(
    Schema.isBetween({
      minimum: DEVICE_SWIPE_DURATION_MIN_MS,
      maximum: DEVICE_SWIPE_DURATION_MAX_MS,
    }),
  ),
});
export type DeviceSwipeInput = typeof DeviceSwipeInput.Type;

/** Bulk entry: the helper synthesizes the key sequence so the agent sends one call. */
export const DeviceTypeTextInput = Schema.Struct({
  udid: DeviceUdid,
  text: Schema.String.check(Schema.isMaxLength(DEVICE_TEXT_MAX_LENGTH)),
});
export type DeviceTypeTextInput = typeof DeviceTypeTextInput.Type;

export const DeviceKeyModifier = Schema.Literals([
  "command",
  "shift",
  "option",
  "control",
  "function",
]);
export type DeviceKeyModifier = typeof DeviceKeyModifier.Type;

/**
 * Per-key HID, used by the pane's keyboard passthrough. `keyCode` is a HID
 * usage code, and down/up stay separate so held keys and repeats survive the hop.
 */
export const DeviceKeyEventInput = Schema.Struct({
  udid: DeviceUdid,
  keyCode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  modifiers: Schema.Array(DeviceKeyModifier).check(Schema.isMaxLength(5)),
  direction: Schema.Literals(["down", "up"]),
});
export type DeviceKeyEventInput = typeof DeviceKeyEventInput.Type;

export const DeviceHardwareButton = Schema.Literals([
  "home",
  "lock",
  "volume-up",
  "volume-down",
  "rotate",
]);
export type DeviceHardwareButton = typeof DeviceHardwareButton.Type;

export const DevicePressButtonInput = Schema.Struct({
  udid: DeviceUdid,
  button: DeviceHardwareButton,
});
export type DevicePressButtonInput = typeof DevicePressButtonInput.Type;

// ── App lifecycle ────────────────────────────────────────────────────

export const DeviceBundleId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type DeviceBundleId = typeof DeviceBundleId.Type;

export const DeviceInstallAppInput = Schema.Struct({
  udid: DeviceUdid,
  /** Absolute path to a built `.app` bundle; Synara never runs the build itself. */
  appPath: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_PATH_MAX_LENGTH)),
});
export type DeviceInstallAppInput = typeof DeviceInstallAppInput.Type;

export const DeviceInstallAppResult = Schema.Struct({
  udid: DeviceUdid,
  bundleId: DeviceBundleId,
});
export type DeviceInstallAppResult = typeof DeviceInstallAppResult.Type;

export const DeviceLaunchAppInput = Schema.Struct({
  udid: DeviceUdid,
  bundleId: DeviceBundleId,
  arguments: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(1_024))).check(Schema.isMaxLength(64)),
  ),
});
export type DeviceLaunchAppInput = typeof DeviceLaunchAppInput.Type;

export const DeviceLaunchAppResult = Schema.Struct({
  udid: DeviceUdid,
  bundleId: DeviceBundleId,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type DeviceLaunchAppResult = typeof DeviceLaunchAppResult.Type;

export const DeviceOpenUrlInput = Schema.Struct({
  udid: DeviceUdid,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_URL_MAX_LENGTH)),
});
export type DeviceOpenUrlInput = typeof DeviceOpenUrlInput.Type;

// ── Read tools ───────────────────────────────────────────────────────

export const DeviceScreenshotInput = Schema.Struct({
  udid: DeviceUdid,
  /**
   * Write the PNG next to screen recordings and return its path instead of
   * relying on the caller to save the bytes.
   *
   * The pane sets this. It used to hand the base64 to a browser download, which
   * put the file wherever the browser felt like — or nowhere at all in a
   * headless or download-blocked context — while recordings landed on the
   * Desktop. Same button, same expectation, so the same destination.
   *
   * Agents leave it unset: they want the bytes, not a file on the user's disk.
   */
  save: Schema.optional(Schema.Boolean),
});
export type DeviceScreenshotInput = typeof DeviceScreenshotInput.Type;

const DevicePixelDimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16_384 }));

/**
 * Screenshots cross the JSON WebSocket, so bytes travel base64-encoded the way
 * voice uploads do; the Uint8Array shape stays on the Electron-only IPC surface.
 */
export const DeviceScreenshotResult = Schema.Struct({
  udid: DeviceUdid,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  mimeType: Schema.Literal("image/png"),
  width: DevicePixelDimension,
  height: DevicePixelDimension,
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 * 1024 * 1024 })),
  bytesBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(44 * 1024 * 1024)),
  capturedAt: IsoDateTime,
  /** Where the PNG was written, when the caller asked for it to be saved. */
  path: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_PATH_MAX_LENGTH))),
});
export type DeviceScreenshotResult = typeof DeviceScreenshotResult.Type;

export const DeviceStartRecordingInput = DeviceTargetInput;
export type DeviceStartRecordingInput = typeof DeviceStartRecordingInput.Type;

export const DeviceStartRecordingResult = Schema.Struct({
  udid: DeviceUdid,
  /** Absolute so the pane can reveal the eventual file without reconstructing server paths. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_PATH_MAX_LENGTH)),
  /** Server time keeps elapsed recording UI independent of request latency and client clocks. */
  startedAt: IsoDateTime,
});
export type DeviceStartRecordingResult = typeof DeviceStartRecordingResult.Type;

export const DeviceStopRecordingInput = DeviceTargetInput;
export type DeviceStopRecordingInput = typeof DeviceStopRecordingInput.Type;

export const DeviceStopRecordingResult = Schema.Struct({
  udid: DeviceUdid,
  /** Repeated because stopping can finish after the pane that started the recording is gone. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_PATH_MAX_LENGTH)),
  /** Zero remains representable when simctl had to be killed before its first frame was flushed. */
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  /** Measured on the server so RPC transit time is not counted as recorded footage. */
  durationMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  /** A stable completion time lets callers order recordings completed after reconnects. */
  stoppedAt: IsoDateTime,
});
export type DeviceStopRecordingResult = typeof DeviceStopRecordingResult.Type;

export const DeviceDescribeUiInput = DeviceTargetInput;
export type DeviceDescribeUiInput = typeof DeviceDescribeUiInput.Type;

export const DeviceUiFrame = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type DeviceUiFrame = typeof DeviceUiFrame.Type;

export const DeviceUiPoint = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type DeviceUiPoint = typeof DeviceUiPoint.Type;

export interface DeviceUiNode {
  readonly role: string;
  /** Separates controls that share a role, e.g. `Switch` inside `CheckBox`. */
  readonly subrole: string | null;
  readonly label: string | null;
  readonly value: string | null;
  readonly frame: DeviceUiFrame;
  /**
   * The control's own hit point in device points. UIKit merges a settings row
   * and the control inside it into a single element whose frame spans the row,
   * so for a switch the frame centre is dead space and only this point toggles
   * it. Tap this instead of the frame centre whenever it is present.
   */
  readonly activationPoint: DeviceUiPoint | null;
  readonly children: readonly DeviceUiNode[];
}

export const DeviceUiNode: Schema.Schema<DeviceUiNode> = Schema.Struct({
  role: Schema.String.check(Schema.isMaxLength(128)),
  subrole: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  value: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  frame: DeviceUiFrame,
  activationPoint: Schema.NullOr(DeviceUiPoint),
  children: Schema.Array(Schema.suspend((): Schema.Schema<DeviceUiNode> => DeviceUiNode)).check(
    Schema.isMaxLength(512),
  ),
});

export const DeviceDescribeUiResult = Schema.Struct({
  udid: DeviceUdid,
  capturedAt: IsoDateTime,
  root: DeviceUiNode,
});
export type DeviceDescribeUiResult = typeof DeviceDescribeUiResult.Type;

/**
 * Scroll a labelled element into the tappable band.
 *
 * The swipe loop belongs to the server: driven by hand it becomes a guess at
 * distances, an overshoot, and a describe between every attempt.
 */
export const DEVICE_SCROLL_MIN_SWIPES = 1;
export const DEVICE_SCROLL_MAX_SWIPES = 32;

export const DeviceScrollToElementInput = Schema.Struct({
  udid: DeviceUdid,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  role: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  maxSwipes: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: DEVICE_SCROLL_MIN_SWIPES, maximum: DEVICE_SCROLL_MAX_SWIPES }),
    ),
  ),
});
export type DeviceScrollToElementInput = typeof DeviceScrollToElementInput.Type;

export const DeviceScrollToElementResult = Schema.Struct({
  udid: DeviceUdid,
  /** The element as it stands after scrolling, ready to tap without re-reading. */
  element: DeviceUiNode,
  tapPoint: DeviceUiPoint,
});
export type DeviceScrollToElementResult = typeof DeviceScrollToElementResult.Type;

// ── Push events ──────────────────────────────────────────────────────

/** Why the pane is being opened without the user asking, so the UI can explain itself. */
export const DeviceOpenPaneReason = Schema.Literals([
  "agent-install",
  "agent-launch",
  "agent-tool",
]);
export type DeviceOpenPaneReason = typeof DeviceOpenPaneReason.Type;

export const DeviceThreadStateEvent = Schema.Struct({
  type: Schema.Literal("device.thread-state"),
  state: ThreadDeviceState,
});
export type DeviceThreadStateEvent = typeof DeviceThreadStateEvent.Type;

/**
 * Carries the thread so whichever chat happens to be visible cannot steal the
 * pane, mirroring BrowserUseOpenPanelRequest.
 */
export const DeviceOpenPaneRequestedEvent = Schema.Struct({
  type: Schema.Literal("device.open-pane-requested"),
  threadId: ThreadId,
  udid: DeviceUdid,
  reason: DeviceOpenPaneReason,
});
export type DeviceOpenPaneRequestedEvent = typeof DeviceOpenPaneRequestedEvent.Type;

export const DeviceEvent = Schema.Union([DeviceThreadStateEvent, DeviceOpenPaneRequestedEvent]);
export type DeviceEvent = typeof DeviceEvent.Type;

// ── Frame channel envelope (type-level contract only) ────────────────

/**
 * Encoded video frames ride the existing WebSocket as binary messages prefixed
 * with this header, so a frame can be routed to the right pane without parsing
 * the bitstream. Runtime encode/decode lives in `@synara/shared/deviceFrame`;
 * this module stays schema-only.
 *
 * Little-endian layout:
 *
 * ```
 * 0  u16  magic (DEVICE_FRAME_MAGIC)
 * 2  u8   version (DEVICE_FRAME_VERSION)
 * 3  u8   flags (bit 0 = keyframe, bit 1 = codec config / parameter sets)
 * 4  u32  sequence (per device, wraps at 2^32; gaps mean dropped frames)
 * 8  f64  timestampMs (helper capture clock, milliseconds)
 * 16 u8   deviceId byte length
 * 17 ..   deviceId (UTF-8)
 * ..      payload
 * ```
 */
export const DEVICE_FRAME_MAGIC = 0x5346;
export const DEVICE_FRAME_VERSION = 1;
export const DEVICE_FRAME_FLAG_KEYFRAME = 0b0000_0001;
export const DEVICE_FRAME_FLAG_CODEC_CONFIG = 0b0000_0010;
/** Bytes before the variable-length device id. */
export const DEVICE_FRAME_HEADER_FIXED_BYTES = 17;
export const DEVICE_FRAME_MAX_DEVICE_ID_BYTES = 255;

export const DeviceFrameHeader = Schema.Struct({
  deviceId: DeviceUdid,
  sequence: NonNegativeInt,
  timestampMs: Schema.Finite,
  keyframe: Schema.Boolean,
  codecConfig: Schema.Boolean,
});
export type DeviceFrameHeader = typeof DeviceFrameHeader.Type;

export const DeviceFrameDecodeErrorReason = Schema.Literals([
  "too-short",
  "bad-magic",
  "unsupported-version",
  "truncated-device-id",
  "invalid-device-id",
]);
export type DeviceFrameDecodeErrorReason = typeof DeviceFrameDecodeErrorReason.Type;
