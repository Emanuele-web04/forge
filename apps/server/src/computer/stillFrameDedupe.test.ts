import { describe, expect, it } from "vitest";

import { frameDigest, StillFrameDedupe } from "./stillFrameDedupe.ts";

const IDLE = new Uint8Array([1, 2, 3, 4]);
const CHANGED = new Uint8Array([1, 2, 3, 5]);
const SHORTER = new Uint8Array([1, 2, 3]);

describe("frameDigest", () => {
  it("separates frames of different sizes before hashing them", () => {
    expect(frameDigest(IDLE)).not.toBe(frameDigest(SHORTER));
    expect(frameDigest(IDLE)).toBe(frameDigest(new Uint8Array([1, 2, 3, 4])));
  });
});

describe("StillFrameDedupe", () => {
  it("publishes the first frame and suppresses an identical repeat", () => {
    const dedupe = new StillFrameDedupe();

    expect(dedupe.shouldPublish(IDLE, dedupe.takeForce(false))).toBe(true);
    // The timer pulls a full-desktop PNG twice a second; an idle desktop
    // encodes the same bytes every time and must not cost the socket anything.
    expect(dedupe.shouldPublish(IDLE, dedupe.takeForce(false))).toBe(false);
    expect(dedupe.shouldPublish(CHANGED, dedupe.takeForce(false))).toBe(true);
  });

  it("publishes an identical frame when the receiver has nothing to draw", () => {
    const dedupe = new StillFrameDedupe();
    dedupe.shouldPublish(IDLE, dedupe.takeForce(false));

    expect(dedupe.shouldPublish(IDLE, dedupe.takeForce(true))).toBe(true);
  });

  it("remembers a keyframe asked for while a capture was already running", () => {
    const dedupe = new StillFrameDedupe();
    dedupe.shouldPublish(IDLE, dedupe.takeForce(false));

    // The request arrives mid-capture and cannot be served now.
    dedupe.deferForce();
    expect(dedupe.forcePending).toBe(true);

    // The next publish honours it even though nothing on screen changed.
    const force = dedupe.takeForce(false);
    expect(force).toBe(true);
    expect(dedupe.forcePending).toBe(false);
    expect(dedupe.shouldPublish(IDLE, force)).toBe(true);
  });

  it("clears both the digest and any owed keyframe on reset", () => {
    const dedupe = new StillFrameDedupe();
    dedupe.shouldPublish(IDLE, dedupe.takeForce(false));
    dedupe.deferForce();

    dedupe.reset();

    // A re-attached pane has seen nothing, so its first frame goes out even
    // though the desktop is byte-identical to what the last one saw.
    expect(dedupe.forcePending).toBe(false);
    expect(dedupe.shouldPublish(IDLE, dedupe.takeForce(false))).toBe(true);
  });
});
