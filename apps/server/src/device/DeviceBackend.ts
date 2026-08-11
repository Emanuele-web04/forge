/**
 * DeviceBackend - platform abstraction behind the device pane.
 *
 * One interface, one implementation per device platform. The iOS simulator
 * backend is the only one today; the contracts and this interface are written
 * so an Android emulator backend can be added without touching the manager,
 * the WebSocket surface, or the MCP tools.
 *
 * Backends speak plain promises rather than Effect: they are thin adapters over
 * subprocesses and sockets, and keeping them promise-shaped makes the fake
 * backend (and therefore every manager test) trivial to drive.
 *
 * @module device/DeviceBackend
 */
import type {
  DeviceAvailability,
  DeviceGeometry,
  DeviceDescribeUiResult,
  DeviceDescriptor,
  DeviceHardwareButton,
  DeviceInstallAppResult,
  DeviceKeyModifier,
  DeviceLaunchAppResult,
  DevicePlatform,
  DeviceScreenshotResult,
  DeviceStartRecordingResult,
  DeviceStopRecordingResult,
} from "@synara/contracts";

/**
 * One encoded video frame as the backend produces it. `sequence` is owned by
 * the backend (per device, monotonic) so the transport can detect gaps without
 * re-deriving them, and `codecConfig` marks parameter sets that a late
 * subscriber must receive before any keyframe decodes.
 */
export interface DeviceStreamFrame {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
  readonly data: Uint8Array;
}

export type DeviceFrameListener = (frame: DeviceStreamFrame) => void;

/**
 * Failure surfaced to the pane as `ThreadDeviceState.lastError`. `retryable`
 * separates transient trouble (device still booting) from a permanent refusal
 * (no such device), so the manager can decide whether to keep the attachment.
 */
export class DeviceBackendError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DeviceBackendError";
    this.retryable = options?.retryable ?? false;
  }
}

export interface DeviceListOptions {
  readonly includeShutdown?: boolean;
}

export interface DeviceSwipeGesture {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly durationMs: number;
}

export interface DeviceKeyEvent {
  readonly keyCode: number;
  readonly modifiers: readonly DeviceKeyModifier[];
  readonly direction: "down" | "up";
}

export interface DeviceBackend {
  readonly platform: DevicePlatform;

  /**
   * Whether the pane can run at all, and which setup steps remain. Cheap enough
   * to call on every list; backends cache their own probes.
   */
  availability(): Promise<DeviceAvailability>;

  /**
   * Discovered devices. `bootSource` is always reported as `"user"` here: the
   * backend cannot know who asked for a boot, so the manager overrides the
   * field for devices it booted itself.
   */
  listDevices(options?: DeviceListOptions): Promise<readonly DeviceDescriptor[]>;

  boot(udid: string): Promise<DeviceDescriptor>;
  shutdown(udid: string): Promise<void>;

  install(udid: string, appPath: string): Promise<DeviceInstallAppResult>;
  launch(
    udid: string,
    bundleId: string,
    launchArguments?: readonly string[],
  ): Promise<DeviceLaunchAppResult>;
  openUrl(udid: string, url: string): Promise<void>;

  tap(udid: string, x: number, y: number): Promise<void>;
  swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void>;
  typeText(udid: string, text: string): Promise<void>;
  keyEvent(udid: string, event: DeviceKeyEvent): Promise<void>;
  pressButton(udid: string, button: DeviceHardwareButton): Promise<void>;

  /** `save` writes the PNG beside recordings and reports its path. */
  screenshot(udid: string, options?: { readonly save?: boolean }): Promise<DeviceScreenshotResult>;
  startRecording(udid: string): Promise<DeviceStartRecordingResult>;
  stopRecording(udid: string): Promise<DeviceStopRecordingResult>;
  describeUi(udid: string): Promise<DeviceDescribeUiResult>;

  /**
   * Begin (or join) the encoded video stream for a device. Calling twice for
   * the same udid replaces the listener rather than starting a second capture.
   */
  /**
   * Screen geometry for a device, when the backend knows it. Null until
   * something has attached to the device, since the values come from the
   * native helper rather than from discovery.
   */
  geometry(udid: string): DeviceGeometry | null;

  attachStream(udid: string, onFrame: DeviceFrameListener): Promise<void>;
  detachStream(udid: string): Promise<void>;

  /** Release every process, socket, and timer the backend owns. */
  dispose(): Promise<void>;
}
