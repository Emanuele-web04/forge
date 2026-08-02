/**
 * DeviceManager - thread-scoped device attachment and boot ownership.
 *
 * State the manager owns, and why it owns it rather than the backend:
 *
 * - Attachment is per thread (one device per thread, mirroring
 *   `ThreadBrowserState`). A thread's `ThreadDeviceState` is versioned and
 *   pushed on `device.event` so panes can drop stale snapshots.
 * - Boot source. The backend cannot tell who booted a device, so the manager
 *   records the devices it booted itself. Only those are ever auto-shut-down;
 *   anything the user started (pane picker, Simulator.app) outlives us.
 * - The Synara boot cap (`DEVICE_SYNARA_BOOT_LIMIT`). Boot past the cap is
 *   refusable rather than fatal: the caller is handed the shutdown candidates
 *   so the pane can prompt.
 * - Shutdown triggers: app quit (`dispose`), thread archive
 *   (`handleThreadArchived`), and an idle timeout after the last detach.
 *
 * Everything the manager does to the device itself goes through DeviceBackend,
 * so the whole state machine is testable against `FakeDeviceBackend`.
 *
 * @module device/DeviceManager
 */
import {
  DEVICE_SYNARA_BOOT_LIMIT,
  ThreadId,
  type DeviceAvailability,
  type DeviceBootResult,
  type DeviceDescribeUiResult,
  type DeviceDescriptor,
  type DeviceEvent,
  type DeviceHardwareButton,
  type DeviceInstallAppResult,
  type DeviceLaunchAppResult,
  type DeviceListResult,
  type DeviceOpenPaneReason,
  type DeviceScreenshotResult,
  type ThreadDeviceState,
} from "@synara/contracts";

import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceKeyEvent,
  type DeviceSwipeGesture,
} from "./DeviceBackend.ts";
import { DeviceFrameTransport, type DeviceFrameSink } from "./deviceFrameTransport.ts";

/** How long a Synara-booted device stays up with no thread attached. */
export const DEVICE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

export type DeviceEventListener = (event: DeviceEvent) => void;

export interface DeviceManagerOptions {
  readonly backend: DeviceBackend;
  readonly transport?: DeviceFrameTransport;
  readonly idleShutdownMs?: number;
  readonly bootLimit?: number;
  readonly setTimeout?: (handler: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void;
}

interface ThreadAttachment {
  version: number;
  attachedDeviceUdid: string | null;
  agentActiveCount: number;
  lastError: string | null;
}

export class DeviceManager {
  private readonly backend: DeviceBackend;
  private readonly transport: DeviceFrameTransport;
  private readonly idleShutdownMs: number;
  private readonly bootLimit: number;
  private readonly schedule: (handler: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;

  private readonly threads = new Map<string, ThreadAttachment>();
  /** Devices this manager booted, and therefore may shut down again. */
  private readonly synaraBooted = new Set<string>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly streaming = new Set<string>();
  private readonly listeners = new Set<DeviceEventListener>();
  private disposed = false;

  constructor(options: DeviceManagerOptions) {
    this.backend = options.backend;
    this.transport = options.transport ?? new DeviceFrameTransport();
    this.idleShutdownMs = options.idleShutdownMs ?? DEVICE_IDLE_SHUTDOWN_MS;
    this.bootLimit = options.bootLimit ?? DEVICE_SYNARA_BOOT_LIMIT;
    this.schedule = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle));
  }

  // ── Events ─────────────────────────────────────────────────────────

  onEvent(listener: DeviceEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Queries ────────────────────────────────────────────────────────

  async availability(): Promise<DeviceAvailability> {
    return await this.backend.availability();
  }

  async list(options: { readonly includeShutdown?: boolean } = {}): Promise<DeviceListResult> {
    const availability = await this.backend.availability();
    if (availability.kind !== "available") return { devices: [], availability };
    const devices = await this.backend.listDevices(options);
    return { devices: devices.map((device) => this.withBootSource(device)), availability };
  }

  async getThreadState(threadId: string): Promise<ThreadDeviceState> {
    return await this.snapshot(threadId);
  }

  /** Devices the pane may offer as shutdown candidates when the cap is hit. */
  async synaraBootedDevices(): Promise<readonly DeviceDescriptor[]> {
    const devices = await this.backend.listDevices({ includeShutdown: true }).catch(() => []);
    return devices
      .filter((device) => this.synaraBooted.has(device.udid))
      .map((device) => this.withBootSource(device));
  }

  // ── Boot / shutdown ────────────────────────────────────────────────

  async boot(udid: string): Promise<DeviceBootResult> {
    const known = await this.backend
      .listDevices({ includeShutdown: true })
      .then((devices) => devices.find((device) => device.udid === udid) ?? null)
      .catch(() => null);
    // Viewing an already-booted device is uncapped: the cap exists to stop
    // Synara from accumulating simulators, not to limit what the user watches.
    if (known?.state === "booted") {
      return { kind: "booted", device: this.withBootSource(known) };
    }
    if (this.synaraBooted.size >= this.bootLimit) {
      return {
        kind: "boot-limit-reached",
        limit: this.bootLimit,
        synaraBooted: await this.synaraBootedDevices(),
      };
    }

    const device = await this.backend.boot(udid);
    this.synaraBooted.add(udid);
    // A device booted for a new purpose is no longer idle-condemned.
    this.clearIdleTimer(udid);
    await this.publishAllThreads();
    return { kind: "booted", device: { ...device, bootSource: "synara" } };
  }

  async shutdown(udid: string): Promise<void> {
    await this.stopStream(udid);
    await this.backend.shutdown(udid);
    this.synaraBooted.delete(udid);
    this.clearIdleTimer(udid);
    // Any thread watching this device loses its attachment rather than pointing
    // at a shut-down simulator.
    for (const [threadId, attachment] of this.threads) {
      if (attachment.attachedDeviceUdid !== udid) continue;
      attachment.attachedDeviceUdid = null;
      await this.publish(threadId);
    }
    await this.publishAllThreads();
  }

  // ── Attachment ─────────────────────────────────────────────────────

  async attach(threadId: string, udid: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    const previous = attachment.attachedDeviceUdid;
    // Cleared before releasing: `releaseDevice` asks whether anyone still holds
    // the device, and this thread must no longer count as a holder.
    attachment.attachedDeviceUdid = udid;
    if (previous !== null && previous !== udid) await this.releaseDevice(previous);
    attachment.lastError = null;
    this.clearIdleTimer(udid);
    await this.startStream(udid).catch((error: unknown) => {
      // A stream failure must not cost the attachment: control RPCs and MCP
      // tools still work, and the pane shows the error next to a static screen.
      attachment.lastError = errorMessage(error);
    });
    return await this.publish(threadId);
  }

  async detach(threadId: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    const udid = attachment.attachedDeviceUdid;
    attachment.attachedDeviceUdid = null;
    if (udid !== null) await this.releaseDevice(udid);
    return await this.publish(threadId);
  }

  /** Thread archive is terminal for its attachment; treat it as a detach. */
  async handleThreadArchived(threadId: string): Promise<void> {
    if (!this.threads.has(threadId)) return;
    await this.detach(threadId);
    this.threads.delete(threadId);
  }

  // ── Streaming ──────────────────────────────────────────────────────

  /**
   * Register a WebSocket sink for a device's video. The backend stream is
   * started lazily and stopped when the last subscriber and attachment go away.
   */
  subscribeFrames(udid: string, sink: DeviceFrameSink): () => void {
    const unsubscribe = this.transport.subscribe(udid, sink);
    void this.startStream(udid).catch(() => undefined);
    return () => {
      unsubscribe();
      if (this.transport.deviceSubscriberCount(udid) === 0 && !this.isAttachedAnywhere(udid)) {
        void this.stopStream(udid).catch(() => undefined);
      }
    };
  }

  // ── Control plane ──────────────────────────────────────────────────

  async tap(udid: string, x: number, y: number): Promise<void> {
    await this.backend.tap(udid, x, y);
  }

  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    await this.backend.swipe(udid, gesture);
  }

  async typeText(udid: string, text: string): Promise<void> {
    await this.backend.typeText(udid, text);
  }

  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    await this.backend.keyEvent(udid, event);
  }

  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    await this.backend.pressButton(udid, button);
  }

  async install(udid: string, appPath: string): Promise<DeviceInstallAppResult> {
    return await this.backend.install(udid, appPath);
  }

  async launch(
    udid: string,
    bundleId: string,
    launchArguments?: readonly string[],
  ): Promise<DeviceLaunchAppResult> {
    return await this.backend.launch(udid, bundleId, launchArguments);
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await this.backend.openUrl(udid, url);
  }

  async screenshot(udid: string): Promise<DeviceScreenshotResult> {
    return await this.backend.screenshot(udid);
  }

  async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    return await this.backend.describeUi(udid);
  }

  // ── Agent integration ──────────────────────────────────────────────

  /**
   * Wrap one agent-driven action so the pane can show its "agent is using this
   * device" badge for exactly as long as the action runs. Nested calls are
   * counted, so overlapping tool calls do not clear the badge early.
   */
  async withAgentActivity<A>(threadId: string, action: () => Promise<A>): Promise<A> {
    const attachment = this.threadState(threadId);
    attachment.agentActiveCount += 1;
    if (attachment.agentActiveCount === 1) await this.publish(threadId);
    try {
      return await action();
    } finally {
      attachment.agentActiveCount = Math.max(0, attachment.agentActiveCount - 1);
      if (attachment.agentActiveCount === 0) await this.publish(threadId);
    }
  }

  /** Auto-open the pane when an agent puts an app on a device. */
  requestOpenPane(threadId: string, udid: string, reason: DeviceOpenPaneReason): void {
    this.emit({
      type: "device.open-pane-requested",
      threadId: ThreadId.makeUnsafe(threadId),
      udid,
      reason,
    });
  }

  async recordThreadError(threadId: string, message: string): Promise<void> {
    this.threadState(threadId).lastError = message;
    await this.publish(threadId);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * App quit: shut down everything Synara booted, leave the user's devices
   * alone, and release the backend.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, timer] of this.idleTimers) this.cancel(timer);
    this.idleTimers.clear();
    // Snapshotted: both loops mutate the set they are walking.
    const streaming = Array.from(this.streaming);
    const booted = Array.from(this.synaraBooted);
    for (const udid of streaming) await this.stopStream(udid).catch(() => undefined);
    for (const udid of booted) {
      await this.backend.shutdown(udid).catch(() => undefined);
      this.synaraBooted.delete(udid);
    }
    this.listeners.clear();
    await this.backend.dispose().catch(() => undefined);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private threadState(threadId: string): ThreadAttachment {
    let attachment = this.threads.get(threadId);
    if (!attachment) {
      attachment = { version: 0, attachedDeviceUdid: null, agentActiveCount: 0, lastError: null };
      this.threads.set(threadId, attachment);
    }
    return attachment;
  }

  private withBootSource(device: DeviceDescriptor): DeviceDescriptor {
    return this.synaraBooted.has(device.udid) ? { ...device, bootSource: "synara" } : device;
  }

  private isAttachedAnywhere(udid: string): boolean {
    for (const [, attachment] of this.threads) {
      if (attachment.attachedDeviceUdid === udid) return true;
    }
    return false;
  }

  private async startStream(udid: string): Promise<void> {
    if (this.streaming.has(udid) || this.disposed) return;
    this.streaming.add(udid);
    try {
      await this.backend.attachStream(udid, (frame) => this.transport.publish(udid, frame));
    } catch (error) {
      this.streaming.delete(udid);
      throw error;
    }
  }

  private async stopStream(udid: string): Promise<void> {
    if (!this.streaming.delete(udid)) return;
    this.transport.resetDevice(udid);
    await this.backend.detachStream(udid);
  }

  /**
   * Nobody is watching this device any more. Stop the stream, and start the
   * idle countdown if Synara booted it.
   */
  private async releaseDevice(udid: string): Promise<void> {
    if (this.isAttachedAnywhere(udid)) return;
    if (this.transport.deviceSubscriberCount(udid) === 0) {
      await this.stopStream(udid).catch(() => undefined);
    }
    if (!this.synaraBooted.has(udid)) return;
    this.clearIdleTimer(udid);
    const timer = this.schedule(() => {
      this.idleTimers.delete(udid);
      void this.shutdownIfStillIdle(udid);
    }, this.idleShutdownMs);
    // A pending idle shutdown must not keep the process alive at exit; quit
    // shuts these devices down anyway.
    timer.unref?.();
    this.idleTimers.set(udid, timer);
  }

  private async shutdownIfStillIdle(udid: string): Promise<void> {
    if (this.disposed) return;
    // Re-checked at fire time: a thread may have re-attached during the wait.
    if (this.isAttachedAnywhere(udid) || !this.synaraBooted.has(udid)) return;
    await this.shutdown(udid).catch(() => undefined);
  }

  private clearIdleTimer(udid: string): void {
    const timer = this.idleTimers.get(udid);
    if (!timer) return;
    this.cancel(timer);
    this.idleTimers.delete(udid);
  }

  private async snapshot(threadId: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    const availability = await this.backend.availability();
    const devices =
      availability.kind === "available"
        ? await this.backend.listDevices({ includeShutdown: true }).catch(() => [])
        : [];
    return {
      threadId: threadId as ThreadDeviceState["threadId"],
      version: attachment.version,
      attachedDeviceUdid: attachment.attachedDeviceUdid as ThreadDeviceState["attachedDeviceUdid"],
      devices: devices.map((device) => this.withBootSource(device)),
      agentActive: attachment.agentActiveCount > 0,
      availability,
      lastError: attachment.lastError,
    };
  }

  private async publish(threadId: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    attachment.version += 1;
    const state = await this.snapshot(threadId);
    this.emit({ type: "device.thread-state", state });
    return state;
  }

  /** A boot or shutdown changes the device list every open pane is showing. */
  private async publishAllThreads(): Promise<void> {
    for (const [threadId] of this.threads) await this.publish(threadId);
  }

  private emit(event: DeviceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One bad listener must not stop the rest from seeing device events.
      }
    }
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof DeviceBackendError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
