// FILE: proxyFrameQueue.ts
// Purpose: The bounded, control-frame-prioritising queue that governs ONE
//          direction of the environment proxy. Pure data structure so the flow
//          control rules are testable without a socket.
// Layer: Shared runtime
// Exports: ProxyFrameQueue, makeProxyFrameQueue, ProxyFramePriority,
//          DEFAULT_PROXY_QUEUE_BYTES, DEFAULT_PROXY_QUEUE_FRAMES
//
// Two failures this exists to prevent, both observed in comparable systems:
//
//  1. UNBOUNDED QUEUEING. A consumer on a slow cellular link stops draining
//     while the producer keeps streaming. A queue with no ceiling is a memory
//     leak with extra steps, and the process dies long after the user gave up.
//     Here the queue has a hard byte AND frame ceiling; crossing it does not
//     drop a frame silently — it puts the queue into a terminal `overflowed`
//     state that the caller MUST surface as an explicit resync.
//
//  2. HEAD-OF-LINE BLOCKING OF CONTROL FRAMES. A 15-byte Pong queued behind a
//     multi-megabyte snapshot arrives after the peer's heartbeat deadline, so a
//     perfectly healthy connection is torn down and reconnects — repeatedly.
//     Control frames therefore jump the queue: they are drained before any
//     pending data frame regardless of arrival order.
//
// The queue never REORDERS data frames relative to each other. Data ordering is
// the protocol's business and the proxy has no license to touch it.

export type ProxyFramePriority = "control" | "data";

export interface ProxyFrame<T> {
  readonly priority: ProxyFramePriority;
  readonly payload: T;
  /** Wire size used for accounting. Callers pass the real byte length. */
  readonly byteLength: number;
}

/**
 * Ceiling per direction.
 *
 * 8 MiB is roughly four maximum-size Synara WS messages (`maxPayload` is 2 MiB):
 * enough that a brief stall rides through, small enough that a stuck consumer
 * is detected in seconds rather than after the heap is gone. The frame ceiling
 * catches the other shape of the same failure — many tiny frames, which cost
 * per-frame overhead the byte count does not see.
 */
export const DEFAULT_PROXY_QUEUE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_PROXY_QUEUE_FRAMES = 4_096;

export type ProxyEnqueueResult =
  | { readonly accepted: true }
  /**
   * The queue is now terminally overflowed. The caller must close the
   * connection with the resync close code — NOT drop this frame and continue.
   */
  | { readonly accepted: false; readonly overflowed: true };

export interface ProxyFrameQueueOptions {
  readonly maxBytes?: number;
  readonly maxFrames?: number;
}

export class ProxyFrameQueue<T> {
  readonly #maxBytes: number;
  readonly #maxFrames: number;
  readonly #control: ProxyFrame<T>[] = [];
  readonly #data: ProxyFrame<T>[] = [];
  #queuedBytes = 0;
  #overflowed = false;

  constructor(options: ProxyFrameQueueOptions = {}) {
    // A non-positive or non-finite bound would disable the ceiling entirely,
    // which is the exact failure this class exists to prevent. Clamp rather
    // than trust the caller.
    this.#maxBytes = normalizePositiveBound(options.maxBytes, DEFAULT_PROXY_QUEUE_BYTES);
    this.#maxFrames = normalizePositiveBound(options.maxFrames, DEFAULT_PROXY_QUEUE_FRAMES);
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  get queuedFrames(): number {
    return this.#control.length + this.#data.length;
  }

  get overflowed(): boolean {
    return this.#overflowed;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  get maxFrames(): number {
    return this.#maxFrames;
  }

  /**
   * Admits a frame, or reports terminal overflow.
   *
   * Control frames are admitted under the same ceiling as data frames: an
   * attacker who could enqueue unbounded pings would otherwise have an
   * unbounded queue by another name. They are prioritised on the way OUT, not
   * exempted on the way in.
   */
  enqueue(frame: ProxyFrame<T>): ProxyEnqueueResult {
    if (this.#overflowed) return { accepted: false, overflowed: true };
    const byteLength = Number.isFinite(frame.byteLength) ? Math.max(0, frame.byteLength) : 0;
    if (
      this.#queuedBytes + byteLength > this.#maxBytes ||
      this.queuedFrames + 1 > this.#maxFrames
    ) {
      // Terminal on purpose. Dropping the frame and carrying on is the silent
      // data loss this design forbids: the consumer would keep applying a
      // stream with a hole in it and never learn its state was wrong.
      this.#overflowed = true;
      this.#control.length = 0;
      this.#data.length = 0;
      this.#queuedBytes = 0;
      return { accepted: false, overflowed: true };
    }
    (frame.priority === "control" ? this.#control : this.#data).push({ ...frame, byteLength });
    this.#queuedBytes += byteLength;
    return { accepted: true };
  }

  /** Next frame to write: every pending control frame first, then data in order. */
  dequeue(): ProxyFrame<T> | undefined {
    const frame = this.#control.shift() ?? this.#data.shift();
    if (frame) this.#queuedBytes -= frame.byteLength;
    return frame;
  }

  clear(): void {
    this.#control.length = 0;
    this.#data.length = 0;
    this.#queuedBytes = 0;
  }
}

function normalizePositiveBound(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function makeProxyFrameQueue<T>(options?: ProxyFrameQueueOptions): ProxyFrameQueue<T> {
  return new ProxyFrameQueue<T>(options);
}
