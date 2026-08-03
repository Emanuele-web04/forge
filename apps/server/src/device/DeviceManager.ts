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
  type DeviceUiNode,
  type ThreadDeviceState,
} from "@synara/contracts";

import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceKeyEvent,
  type DeviceSwipeGesture,
} from "./DeviceBackend.ts";
import { DeviceFrameTransport, type DeviceFrameSink } from "./deviceFrameTransport.ts";
import {
  DeviceUiTargetError,
  SCROLL_SWIPE_DURATION_MS,
  findTarget,
  planScrollStep,
  visibleLabels,
  type DeviceUiTarget,
  type DeviceUiTargetMatch,
} from "./uiTreeTargeting.ts";

/** How long a Synara-booted device stays up with no thread attached. */
export const DEVICE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

/** Enough to cross a long Settings list; short enough to fail fast on a typo. */
export const DEVICE_DEFAULT_MAX_SCROLLS = 8;

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
    const devices = await this.discover(availability, options);
    return { devices, availability };
  }

  /**
   * Devices to show alongside an availability state.
   *
   * Discovery is gated only on the platform, never on full availability.
   * Listing runs on `simctl`, which works long before the native helper exists,
   * and the helper is only built on first attach. Requiring `available` here
   * deadlocked a fresh machine: the picker stayed empty because the helper was
   * unbuilt, and the helper stayed unbuilt because attaching needs a udid from
   * the picker. The pane shows the devices and the remaining setup step
   * together, which is what the setup checklist is for.
   */
  private async discover(
    availability: DeviceAvailability,
    options: { readonly includeShutdown?: boolean } = {},
  ): Promise<readonly DeviceDescriptor[]> {
    if (availability.kind === "unsupported-platform") return [];
    // Already reported through `availability`; an empty list is the honest
    // answer when simctl itself cannot run.
    const devices = await this.backend.listDevices(options).catch(() => []);
    return devices.map((device) => this.describe(device));
  }

  async getThreadState(threadId: string): Promise<ThreadDeviceState> {
    return await this.snapshot(threadId);
  }

  /** Devices the pane may offer as shutdown candidates when the cap is hit. */
  async synaraBootedDevices(): Promise<readonly DeviceDescriptor[]> {
    const devices = await this.backend.listDevices({ includeShutdown: true }).catch(() => []);
    return devices
      .filter((device) => this.synaraBooted.has(device.udid))
      .map((device) => this.describe(device));
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
      return { kind: "booted", device: this.describe(known) };
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

  /**
   * Point a thread at the device its agent is driving, unless the user already
   * pointed it somewhere else.
   *
   * Auto-opening the pane is only useful if there is something to watch: before
   * this, an agent's launch opened a pane still asking the user to pick a
   * simulator, so they stared at a black phone while the agent worked. The
   * attachment is what makes `ThreadDeviceState.attachedDeviceUdid` non-null,
   * and the pane's existing logic starts the stream from there.
   *
   * Never steals: a thread already attached to a different device keeps it,
   * because that attachment reflects a deliberate choice by the user and the
   * agent's device is still reachable through the picker. Idempotent, so
   * repeated launches on the same device cost nothing.
   */
  async ensureThreadAttached(threadId: string, udid: string): Promise<void> {
    const attached = this.threadState(threadId).attachedDeviceUdid;
    if (attached === udid) return;
    if (attached !== null) return;
    await this.attach(threadId, udid);
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

  /**
   * Tap the element a label names, scrolling it into view first if needed.
   *
   * The tree is read fresh rather than cached: a stale frame is exactly how a
   * tap lands on whatever scrolled into that position instead. Returns the
   * node so the caller can report what it actually hit and its state.
   */
  async tapElement(
    udid: string,
    target: DeviceUiTarget,
    options: { readonly maxScrolls?: number | undefined } = {},
  ): Promise<DeviceUiTargetMatch> {
    const match = await this.scrollToElement(udid, target, options);
    await this.backend.tap(udid, match.point.x, match.point.y);
    return match;
  }

  /**
   * Bring the element a label names into the tappable band and return it.
   *
   * The swipe-describe-check loop lives here rather than in the agent because
   * it is motor control, not judgement: an agent driving it by hand guesses
   * distances, overshoots, and re-describes between every attempt. Already
   * visible targets cost one describe and no swipes.
   *
   * A label missing from the tree is treated as "not reached yet" rather than
   * as a failure. Long lists are virtualized, so UIKit only materializes the
   * rows near the viewport: Settings genuinely has no "Developer" node until
   * scrolling gets close to it. The loop keeps paging down while the label is
   * absent, and only reports it missing once the list stops moving.
   */
  async scrollToElement(
    udid: string,
    target: DeviceUiTarget,
    options: { readonly maxScrolls?: number | undefined } = {},
  ): Promise<DeviceUiTargetMatch> {
    const maxScrolls = options.maxScrolls ?? DEVICE_DEFAULT_MAX_SCROLLS;
    let tree = await this.describeUi(udid);
    let match = this.locate(tree.root, target);
    let previousPosition: string | null = null;

    for (let scrolls = 0; scrolls < maxScrolls; scrolls += 1) {
      // Nothing to aim at yet: page down by a screenful to materialize more of
      // the list. Once the node exists, the planner takes over and aims at it.
      const step =
        match === null ? this.pageDownStep(tree.root) : planScrollStep(match.node, tree.root);
      if (step === null) return match as DeviceUiTargetMatch;

      await this.backend.swipe(udid, step);
      tree = await this.describeUi(udid);
      match = this.locate(tree.root, target);

      // A list at its end keeps rendering the same thing; swiping again would
      // burn the whole budget to no effect. Compared across the visible labels
      // as well as the target's own position, since an absent target has none.
      const position = match === null ? this.treeFingerprint(tree.root) : `y:${match.node.frame.y}`;
      if (previousPosition !== null && position === previousPosition) {
        throw new DeviceUiTargetError(
          match === null
            ? `No element labelled ${JSON.stringify(target.label)} appeared after scrolling to the end of the screen.`
            : `Scrolling stopped moving ${JSON.stringify(target.label)} after ${scrolls + 1} ` +
                `swipe${scrolls === 0 ? "" : "s"}; the list appears to be at its end and the element is still out of reach.`,
          match === null ? visibleLabels(tree.root) : [],
          match === null,
        );
      }
      previousPosition = position;
    }

    if (match !== null && planScrollStep(match.node, tree.root) === null) return match;
    throw new DeviceUiTargetError(
      `Could not bring ${JSON.stringify(target.label)} into view within ${maxScrolls} swipes. ` +
        `Raise maxSwipes, or scroll manually with device_swipe if it sits in a nested scroll area.`,
      match === null ? visibleLabels(tree.root) : [],
      match === null,
    );
  }

  /** The match, or null when the label has not been rendered into the tree yet. */
  private locate(root: DeviceUiNode, target: DeviceUiTarget): DeviceUiTargetMatch | null {
    try {
      return findTarget(root, target);
    } catch (error) {
      // Only absence means "keep scrolling". An ambiguous label is a real
      // answer the caller must resolve, so it propagates immediately.
      if (error instanceof DeviceUiTargetError && error.notFound) return null;
      throw error;
    }
  }

  /** A blind screenful downward, for when the target has not appeared yet. */
  private pageDownStep(root: DeviceUiNode): DeviceSwipeGesture {
    const midX = root.frame.x + root.frame.width / 2;
    const centre = root.frame.y + root.frame.height / 2;
    const distance = root.frame.height * 0.6;
    return {
      fromX: midX,
      fromY: centre + distance / 2,
      toX: midX,
      toY: centre - distance / 2,
      durationMs: SCROLL_SWIPE_DURATION_MS,
    };
  }

  /** What is on screen right now, to tell a moving list from a stuck one. */
  private treeFingerprint(root: DeviceUiNode): string {
    return visibleLabels(root).join("|");
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

  /**
   * Fill in the fields discovery cannot know: who booted the device, and its
   * screen geometry. Every descriptor the manager hands out passes through
   * here, so the pane always sees geometry once the device has been attached.
   */
  private describe(device: DeviceDescriptor): DeviceDescriptor {
    const bootSource = this.synaraBooted.has(device.udid) ? "synara" : device.bootSource;
    const geometry = this.backend.geometry(device.udid) ?? device.geometry;
    if (bootSource === device.bootSource && geometry === device.geometry) return device;
    return { ...device, bootSource, ...(geometry ? { geometry } : {}) };
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

  /**
   * Force a fresh codec-config frame followed by a keyframe.
   *
   * There is no "emit an IDR now" call in the helper, and the encoder's natural
   * keyframe interval is seconds away, so a decoder that has lost sync would
   * otherwise sit frozen. Restarting the stream builds a new compression
   * session, which always emits parameter sets and an IDR as its first frames.
   *
   * Cached frames are dropped first so a late subscriber cannot be primed with
   * a keyframe from the previous generation.
   */
  async requestKeyframe(udid: string): Promise<void> {
    if (!this.streaming.has(udid) || this.disposed) return;
    await this.stopStream(udid);
    await this.startStream(udid);
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
    const devices = await this.discover(availability, { includeShutdown: true });
    return {
      threadId: threadId as ThreadDeviceState["threadId"],
      version: attachment.version,
      attachedDeviceUdid: attachment.attachedDeviceUdid as ThreadDeviceState["attachedDeviceUdid"],
      devices,
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
