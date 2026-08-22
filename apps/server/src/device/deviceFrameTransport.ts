/**
 * Device frame transport - fan-out of encoded video frames to WebSocket clients.
 *
 * Video shares the one WebSocket with JSON RPC, so this module's whole job is
 * making sure a slow client can never hurt anything else:
 *
 * - Nothing is ever buffered unboundedly. Each subscriber has a bounded queue
 *   and a byte budget; exceeding either drops frames.
 * - Drops are keyframe-aligned. H.264 P-frames referencing a dropped frame
 *   decode into garbage, so once a subscriber falls behind it stays in a
 *   dropping state until the next keyframe, then resumes cleanly.
 * - A subscriber that is behind on the socket itself (`bufferedAmount` above
 *   the budget) is not written to at all, so video backlog cannot delay the RPC
 *   traffic queued behind it on the same connection.
 *
 * New subscribers are primed with the cached codec-config and the most recent
 * keyframe, so a pane opened mid-stream decodes its first frame rather than
 * waiting for the encoder's next IDR.
 *
 * @module device/deviceFrameTransport
 */
import { encodeDeviceFrame } from "@synara/shared/deviceFrame";

import type { DeviceStreamFrame } from "./DeviceBackend.ts";

/** Frames queued per subscriber before drop-until-keyframe engages. */
export const DEVICE_FRAME_QUEUE_LIMIT = 8;
/** Socket backlog above which a subscriber is considered too slow to write to. */
export const DEVICE_FRAME_SOCKET_BUDGET_BYTES = 2 * 1024 * 1024;

export interface DeviceFrameSink {
  /** Deliver one encoded envelope. */
  readonly send: (bytes: Uint8Array) => void;
  /** Bytes already queued on the underlying socket, if the transport knows. */
  readonly bufferedAmount: () => number;
  /** False once the connection is gone; the subscriber is then dropped. */
  readonly isOpen: () => boolean;
}

export interface DeviceFrameSubscriberStats {
  readonly sent: number;
  readonly dropped: number;
  readonly awaitingKeyframe: boolean;
  readonly queued: number;
}

interface Subscriber {
  readonly id: string;
  readonly deviceId: string;
  readonly sink: DeviceFrameSink;
  readonly queue: Uint8Array[];
  queuedBytes: number;
  awaitingKeyframe: boolean;
  sent: number;
  dropped: number;
}

export interface DeviceFrameTransportOptions {
  readonly queueLimit?: number;
  readonly socketBudgetBytes?: number;
}

/**
 * Routes frames for many devices to many subscribers. One instance per server;
 * subscribers name the device they want.
 */
export class DeviceFrameTransport {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly subscribersByDevice = new Map<string, Set<Subscriber>>();
  private readonly latestKeyframe = new Map<string, Uint8Array>();
  private readonly codecConfig = new Map<string, Uint8Array>();
  private readonly queueLimit: number;
  private readonly socketBudgetBytes: number;
  private nextSubscriberId = 1;

  constructor(options: DeviceFrameTransportOptions = {}) {
    this.queueLimit = options.queueLimit ?? DEVICE_FRAME_QUEUE_LIMIT;
    this.socketBudgetBytes = options.socketBudgetBytes ?? DEVICE_FRAME_SOCKET_BUDGET_BYTES;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  deviceSubscriberCount(deviceId: string): number {
    return this.subscribersByDevice.get(deviceId)?.size ?? 0;
  }

  /**
   * Register a sink for one device's stream. Returns an unsubscribe function.
   * The subscriber is immediately primed with codec config and the last
   * keyframe when the stream has already produced them.
   */
  subscribe(deviceId: string, sink: DeviceFrameSink): () => void {
    const subscriber: Subscriber = {
      id: `device-frame-subscriber:${this.nextSubscriberId++}`,
      deviceId,
      sink,
      queue: [],
      queuedBytes: 0,
      // Priming below clears this when a keyframe is available; otherwise the
      // subscriber correctly waits for the encoder's next one.
      awaitingKeyframe: true,
      sent: 0,
      dropped: 0,
    };
    this.subscribers.set(subscriber.id, subscriber);
    let deviceSubscribers = this.subscribersByDevice.get(deviceId);
    if (!deviceSubscribers) {
      deviceSubscribers = new Set();
      this.subscribersByDevice.set(deviceId, deviceSubscribers);
    }
    deviceSubscribers.add(subscriber);

    const config = this.codecConfig.get(deviceId);
    if (config) this.deliver(subscriber, config);
    const keyframe = this.latestKeyframe.get(deviceId);
    if (keyframe) {
      subscriber.awaitingKeyframe = false;
      this.deliver(subscriber, keyframe);
    }

    return () => this.removeSubscriber(subscriber);
  }

  /** Encode one frame and fan it out to every subscriber of that device. */
  publish(deviceId: string, frame: DeviceStreamFrame): void {
    const encoded = encodeDeviceFrame({
      header: {
        deviceId,
        sequence: frame.sequence,
        timestampMs: frame.timestampMs,
        keyframe: frame.keyframe,
        codecConfig: frame.codecConfig,
      },
      payload: frame.data,
    });

    // Cached for late subscribers. Codec config and keyframes are the only two
    // records a decoder needs to start, so nothing else is retained.
    if (frame.codecConfig) this.codecConfig.set(deviceId, encoded);
    else if (frame.keyframe) this.latestKeyframe.set(deviceId, encoded);

    const deviceSubscribers = this.subscribersByDevice.get(deviceId);
    if (!deviceSubscribers || deviceSubscribers.size === 0) return;

    // Snapshotted: a closed sink is removed from the set during the walk.
    for (const subscriber of Array.from(deviceSubscribers)) {
      if (!subscriber.sink.isOpen()) {
        this.removeSubscriber(subscriber);
        continue;
      }
      // Codec config is never dropped: without it nothing downstream decodes.
      if (frame.codecConfig) {
        this.deliver(subscriber, encoded);
        continue;
      }
      if (subscriber.awaitingKeyframe) {
        if (!frame.keyframe) {
          subscriber.dropped += 1;
          continue;
        }
        subscriber.awaitingKeyframe = false;
      }
      this.deliver(subscriber, encoded);
    }
  }

  /** Forget cached keyframes for a device whose stream ended. */
  resetDevice(deviceId: string): void {
    this.latestKeyframe.delete(deviceId);
    this.codecConfig.delete(deviceId);
    for (const subscriber of this.subscribersByDevice.get(deviceId) ?? []) {
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      subscriber.awaitingKeyframe = true;
    }
  }

  statsFor(deviceId: string): readonly DeviceFrameSubscriberStats[] {
    return [...(this.subscribersByDevice.get(deviceId) ?? [])].map((subscriber) => ({
      sent: subscriber.sent,
      dropped: subscriber.dropped,
      awaitingKeyframe: subscriber.awaitingKeyframe,
      queued: subscriber.queue.length,
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Write when the socket has room, otherwise queue; a full queue discards the
   * whole backlog and waits for the next keyframe rather than shipping frames
   * whose references are already gone.
   */
  private deliver(subscriber: Subscriber, encoded: Uint8Array): void {
    if (!subscriber.sink.isOpen()) {
      this.removeSubscriber(subscriber);
      return;
    }

    if (subscriber.sink.bufferedAmount() <= this.socketBudgetBytes) {
      this.flush(subscriber);
      subscriber.sink.send(encoded);
      subscriber.sent += 1;
      return;
    }

    if (subscriber.queue.length >= this.queueLimit) {
      subscriber.dropped += subscriber.queue.length + 1;
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      subscriber.awaitingKeyframe = true;
      return;
    }
    subscriber.queue.push(encoded);
    subscriber.queuedBytes += encoded.byteLength;
  }

  private flush(subscriber: Subscriber): void {
    if (subscriber.queue.length === 0) return;
    for (const queued of subscriber.queue) {
      subscriber.sink.send(queued);
      subscriber.sent += 1;
    }
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
  }

  private removeSubscriber(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber.id);
    const deviceSubscribers = this.subscribersByDevice.get(subscriber.deviceId);
    deviceSubscribers?.delete(subscriber);
    if (deviceSubscribers && deviceSubscribers.size === 0) {
      this.subscribersByDevice.delete(subscriber.deviceId);
    }
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
  }
}
