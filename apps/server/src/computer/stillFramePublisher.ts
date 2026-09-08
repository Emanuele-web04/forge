/**
 * The still-frame stream every Tier-1 desktop backend publishes.
 *
 * A Tier-1 backend has no video encoder: it pulls a whole-desktop PNG on a
 * timer and pushes those stills at whoever is watching the pane. The loop
 * around that is identical on every display server — one interval, one capture
 * in flight at a time, a byte-identity dedupe (`StillFrameDedupe`), and the
 * `force` bookkeeping that guarantees a receiver with nothing to draw gets a
 * picture even when the desktop has not changed. It lived twice, once in the
 * KWin backend and once in the macOS one, and the two copies had already
 * drifted apart in the details.
 *
 * The part worth stating is the failure bound. Both copies re-armed the
 * deferred force whenever a forced capture threw, and the `finally` block then
 * immediately republished because a force was pending — so a desktop whose
 * captures kept failing (a revoked Screen Recording grant, a wedged compositor)
 * span in a tight recursive retry loop for as long as anyone watched the pane,
 * with no delay between attempts. Here a failed force buys exactly one immediate
 * retry; after that the request is dropped and the ordinary timer cadence takes
 * over, so a persistent failure costs two captures per interval instead of an
 * unbounded recursion.
 *
 * @module computer/stillFramePublisher
 */
import type { ComputerFrameListener, ComputerStreamFrame } from "./ComputerBackend.ts";
import { StillFrameDedupe } from "./stillFrameDedupe.ts";

/**
 * Immediate retries a failed forced publish may buy before the request is
 * dropped. One, because the point of a retry here is to ride out a single
 * transient capture failure; anything past that is a broken capture path, and
 * the timer will ask again in a moment anyway.
 */
const MAX_FORCE_RETRIES = 1;

/**
 * How often a Tier-1 backend pulls a still when nobody asked for a faster one.
 * Twice a second: fast enough that the pane reads as live, slow enough that a
 * whole-desktop PNG encode is not the machine's busiest job.
 */
export const DEFAULT_STILL_INTERVAL_MS = 500;

/**
 * The floor a caller-supplied interval is clamped to. Below this the capture
 * for one tick has not finished before the next is due, so the loop only ever
 * queues work it cannot do.
 */
export const MIN_STILL_INTERVAL_MS = 100;

/** The one clamp both Tier-1 backends apply to their configured interval. */
export function resolveStillIntervalMs(intervalMs: number | undefined): number {
  return Math.max(MIN_STILL_INTERVAL_MS, intervalMs ?? DEFAULT_STILL_INTERVAL_MS);
}

export interface StillFramePublisherOptions {
  /**
   * Captures one whole-workspace still as raw PNG bytes.
   *
   * `undefined` means "skip this frame without treating it as a failure" — the
   * backend noticed mid-capture that publishing is no longer appropriate (KWin
   * uses it when a foreground screenshot claimed the capture path). A throw is a
   * real failure and is what the retry bound applies to.
   */
  readonly capture: (force: boolean) => Promise<Uint8Array | undefined>;
  /**
   * Whether a capture could succeed at all right now. Checked before every
   * publish so a backend whose capture grant is missing never spends a round
   * trip discovering that twice a second.
   */
  readonly isCaptureAvailable: () => boolean;
  /** Brought up before the first frame: the helper spawn, the plugin connect. */
  readonly prepare?: () => Promise<void>;
  /**
   * Broadcasts one frame to the backend's event observers. The attached
   * listener is served by the publisher itself; this is the extra hop the
   * backends make so the pane and the event stream see the same still.
   */
  readonly emit: (frame: ComputerStreamFrame) => void;
  readonly now: () => number;
  readonly intervalMs: number;
}

export class StillFramePublisher {
  private readonly options: StillFramePublisherOptions;
  /** Suppresses stills identical to the one the pane already has. */
  private readonly dedupe = new StillFrameDedupe();

  private listener: ComputerFrameListener | undefined;
  private attachmentGeneration = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private nextSequence = 1;
  private forceRetries = 0;

  constructor(options: StillFramePublisherOptions) {
    this.options = options;
  }

  /** True while a receiver is subscribed, which is what a keyframe request needs. */
  get attached(): boolean {
    return this.listener !== undefined;
  }

  async attach(listener: ComputerFrameListener): Promise<void> {
    const generation = ++this.attachmentGeneration;
    this.listener = undefined;
    this.clearTimer();
    this.dedupe.reset();
    await this.options.prepare?.();
    // A detach or newer attach supersedes this preparation, even when callers
    // reuse the same callback or preparations finish out of order.
    if (this.attachmentGeneration !== generation) return;
    this.listener = listener;
    await this.publish({ force: true });
    if (this.attachmentGeneration !== generation) return;
    this.timer = setInterval(() => {
      void this.publish();
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  async detach(): Promise<void> {
    this.attachmentGeneration += 1;
    this.listener = undefined;
    this.clearTimer();
    this.dedupe.reset();
  }

  async requestKeyframe(): Promise<void> {
    if (!this.listener) return;
    // A keyframe is asked for because the receiver has nothing to draw, so it
    // publishes even when the desktop is byte-identical to the last frame.
    await this.publish({ force: true });
  }

  async publish(options: { readonly force?: boolean } = {}): Promise<void> {
    const listener = this.listener;
    const generation = this.attachmentGeneration;
    if (!listener || !this.options.isCaptureAvailable()) return;
    if (this.inFlight) {
      // A keyframe asked for while a still is already in flight used to be
      // dropped outright. The in-flight capture then deduped against the digest
      // it had just published and sent nothing, so the receiver that asked
      // precisely because it had no picture stayed blank until the desktop
      // happened to change. The request is remembered instead.
      if (options.force) {
        this.forceRetries = 0;
        this.dedupe.deferForce();
      }
      return;
    }
    this.inFlight = true;
    // A fresh explicit request gets its own retry budget: the previous
    // receiver's exhausted one says nothing about this one.
    if (options.force === true) this.forceRetries = 0;
    const force = this.dedupe.takeForce(options.force === true);
    try {
      const bytes = await this.options.capture(force);
      if (bytes === undefined) return;
      if (this.attachmentGeneration !== generation) return;
      // An idle desktop encodes the same bytes every tick; republishing them
      // spends about a megabyte of socket to convey nothing.
      if (!this.dedupe.shouldPublish(bytes, force)) return;
      this.forceRetries = 0;
      const frame: ComputerStreamFrame = {
        sequence: this.nextSequence++,
        timestampMs: this.options.now(),
        // Every frame is a complete PNG still. There is no H.264 codec config or
        // delta frame in Tier 1, so the envelope stays keyframe-only.
        keyframe: true,
        codecConfig: false,
        data: bytes,
      };
      listener(frame);
      this.options.emit(frame);
    } catch {
      // A transient capture failure must not tear down a subscribed stream, and
      // a bounded number of retries must not become an unbounded one: past the
      // budget the force is dropped and the timer cadence takes over.
      if (
        this.attachmentGeneration === generation &&
        force &&
        this.forceRetries < MAX_FORCE_RETRIES
      ) {
        this.forceRetries += 1;
        this.dedupe.deferForce();
      }
    } finally {
      this.inFlight = false;
      // A forced request that arrived mid-flight is served now rather than
      // waiting for the next timer tick.
      // A replacement attachment can be waiting on this capture slot too.
      if (this.dedupe.forcePending && this.listener) {
        void this.publish();
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
