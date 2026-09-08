/**
 * Suppressing still frames that carry no new picture.
 *
 * Every Tier-1 backend publishes a whole-desktop PNG on a timer — twice a
 * second, for as long as the pane is open. An idle desktop encodes to the same
 * bytes every time, and republishing them spends about a megabyte of socket to
 * convey nothing. Byte identity is the test rather than a similarity threshold:
 * it is exact, and a threshold can be wrong about "nothing changed" in both
 * directions.
 *
 * The subtle part is `force`, which is why this is a small object rather than a
 * comparison inlined at each call site. A receiver that has no picture must get
 * one even when the desktop is byte-identical to what the *previous* receiver
 * saw — a fresh attach, an explicit keyframe request — and a force that arrives
 * while a capture is already in flight has to survive until that capture lands,
 * or the receiver that asked precisely because its pane was blank stays blank
 * until the desktop happens to change on its own.
 *
 * @module computer/stillFrameDedupe
 */
import { createHash } from "node:crypto";

/**
 * Byte-identity key for a captured still. Length first so two frames of
 * different sizes never even reach the hash, then a digest of the pixels —
 * cheap next to the PNG encode that produced them.
 */
export function frameDigest(bytes: Uint8Array): string {
  return `${bytes.byteLength}:${createHash("sha1").update(bytes).digest("hex")}`;
}

export class StillFrameDedupe {
  #publishedDigest: string | undefined;
  #pendingForce = false;

  /**
   * Records a keyframe request that could not be served now. The next publish
   * consumes it, so a request arriving mid-capture is not lost.
   */
  deferForce(): void {
    this.#pendingForce = true;
  }

  /**
   * Whether this publish must go out regardless of the digest, consuming any
   * deferred request. Call once per publish attempt, before capturing.
   */
  takeForce(explicit: boolean): boolean {
    const force = explicit || this.#pendingForce;
    this.#pendingForce = false;
    return force;
  }

  /** True when a deferred keyframe is still owed to the receiver. */
  get forcePending(): boolean {
    return this.#pendingForce;
  }

  /**
   * Whether `bytes` should go on the wire, recording it as published when so.
   * `force` comes from `takeForce`.
   */
  shouldPublish(bytes: Uint8Array, force: boolean): boolean {
    const digest = frameDigest(bytes);
    if (!force && digest === this.#publishedDigest) return false;
    this.#publishedDigest = digest;
    return true;
  }

  /**
   * Forgets what was published. Called whenever the receiver changes or goes
   * away: a re-attached pane has seen nothing, so the memory of what the last
   * one saw must not suppress its first frame.
   */
  reset(): void {
    this.#publishedDigest = undefined;
    this.#pendingForce = false;
  }
}
