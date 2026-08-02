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
  describeUi: "device.describeUi",
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

export const DeviceDescriptor = Schema.Struct({
  platform: DevicePlatform,
  udid: DeviceUdid,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /** Human-readable runtime label, e.g. `iOS 18.2`. */
  runtime: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  state: DeviceRuntimeState,
  bootSource: DeviceBootSource,
});
export type DeviceDescriptor = typeof DeviceDescriptor.Type;

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
 * Why (or whether) the pane can run, modelled the way AppSnap models its
 * permission states: the UI renders one of these instead of guessing from errors.
 */
export const DeviceAvailability = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("available") }),
  Schema.Struct({
    kind: Schema.Literal("unsupported-platform"),
    platform: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    kind: Schema.Literal("setup-required"),
    steps: Schema.Array(DeviceSetupStep).check(Schema.isMaxLength(16)),
  }),
  // The private-framework helper is compiled on demand against the user's Xcode;
  // a compile or launch failure is a designed state, not a generic error toast.
  Schema.Struct({
    kind: Schema.Literal("helper-unavailable"),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_MESSAGE_MAX_LENGTH)),
  }),
]);
export type DeviceAvailability = typeof DeviceAvailability.Type;

// ── Thread-scoped state ──────────────────────────────────────────────

export const ThreadDeviceState = Schema.Struct({
  threadId: ThreadId,
  /** Monotonic per thread; lets the pane drop out-of-order pushes. */
  version: NonNegativeInt,
  attachedDeviceUdid: Schema.NullOr(DeviceUdid),
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

export const DeviceTapInput = Schema.Struct({
  udid: DeviceUdid,
  x: DeviceCoordinate,
  y: DeviceCoordinate,
});
export type DeviceTapInput = typeof DeviceTapInput.Type;

export const DeviceSwipeInput = Schema.Struct({
  udid: DeviceUdid,
  fromX: DeviceCoordinate,
  fromY: DeviceCoordinate,
  toX: DeviceCoordinate,
  toY: DeviceCoordinate,
  durationMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
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

export const DeviceScreenshotInput = DeviceTargetInput;
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
});
export type DeviceScreenshotResult = typeof DeviceScreenshotResult.Type;

export const DeviceDescribeUiInput = DeviceTargetInput;
export type DeviceDescribeUiInput = typeof DeviceDescribeUiInput.Type;

export const DeviceUiFrame = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type DeviceUiFrame = typeof DeviceUiFrame.Type;

export interface DeviceUiNode {
  readonly role: string;
  readonly label: string | null;
  readonly value: string | null;
  readonly frame: DeviceUiFrame;
  readonly children: readonly DeviceUiNode[];
}

export const DeviceUiNode: Schema.Schema<DeviceUiNode> = Schema.Struct({
  role: Schema.String.check(Schema.isMaxLength(128)),
  label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  value: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  frame: DeviceUiFrame,
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
