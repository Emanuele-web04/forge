import { describe, expect, it, vi } from "vitest";

import { StillFramePublisher } from "./stillFramePublisher.ts";
import type { ComputerStreamFrame } from "./ComputerBackend.ts";

const FRAME_A = new Uint8Array([1, 2, 3]);
const FRAME_B = new Uint8Array([4, 5, 6, 7]);

interface Harness {
  readonly publisher: StillFramePublisher;
  readonly frames: ComputerStreamFrame[];
  readonly observed: ComputerStreamFrame[];
  captures: number;
}

function makePublisher(
  capture: (force: boolean) => Promise<Uint8Array | undefined>,
  options: {
    readonly captureAvailable?: () => boolean;
    readonly intervalMs?: number;
    readonly prepare?: () => Promise<void>;
  } = {},
): Harness {
  const frames: ComputerStreamFrame[] = [];
  const observed: ComputerStreamFrame[] = [];
  const harness: Harness = {
    frames,
    observed,
    captures: 0,
    publisher: new StillFramePublisher({
      capture: async (force) => {
        harness.captures += 1;
        return await capture(force);
      },
      isCaptureAvailable: options.captureAvailable ?? (() => true),
      emit: (frame) => observed.push(frame),
      now: () => 0,
      intervalMs: options.intervalMs ?? 100,
      ...(options.prepare ? { prepare: options.prepare } : {}),
    }),
  };
  return harness;
}

describe("StillFramePublisher", () => {
  it("does not start capturing when detached during preparation", async () => {
    vi.useFakeTimers();
    const preparation = Promise.withResolvers<void>();
    const harness = makePublisher(async () => FRAME_A, { prepare: () => preparation.promise });
    try {
      const attaching = harness.publisher.attach((frame) => harness.frames.push(frame));
      await harness.publisher.detach();
      preparation.resolve();
      await attaching;
      await vi.advanceTimersByTimeAsync(500);
      expect(harness.publisher.attached).toBe(false);
      expect(harness.captures).toBe(0);
      expect(harness.observed).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await harness.publisher.detach();
      vi.useRealTimers();
    }
  });

  it("keeps the newest listener when preparations finish out of order", async () => {
    vi.useFakeTimers();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const prepare = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const harness = makePublisher(async () => FRAME_A, { prepare });
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    try {
      const firstAttach = harness.publisher.attach(firstListener);
      const secondAttach = harness.publisher.attach(secondListener);
      second.resolve();
      await secondAttach;
      first.resolve();
      await firstAttach;
      await harness.publisher.requestKeyframe();
      expect(firstListener).not.toHaveBeenCalled();
      expect(secondListener).toHaveBeenCalledTimes(2);
      expect(harness.captures).toBe(2);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await harness.publisher.detach();
      vi.useRealTimers();
    }
  });

  it("keeps one timer when overlapping attaches reuse the same listener", async () => {
    vi.useFakeTimers();
    const harness = makePublisher(async () => FRAME_A);
    const listener = vi.fn();
    try {
      await Promise.all([harness.publisher.attach(listener), harness.publisher.attach(listener)]);
      expect(vi.getTimerCount()).toBe(1);
      await harness.publisher.detach();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await harness.publisher.detach();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "immediately serves a replacement listener after an old capture settles (failure: %s)",
    async (fails) => {
      vi.useFakeTimers();
      const capture = Promise.withResolvers<Uint8Array>();
      let firstCapture = true;
      const harness = makePublisher(() => {
        if (firstCapture) {
          firstCapture = false;
          return capture.promise;
        }
        return Promise.resolve(FRAME_B);
      });
      // Reusing the callback must still identify this as a new attachment.
      const listener = vi.fn();
      try {
        const firstAttach = harness.publisher.attach(listener);
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.captures).toBe(1);
        await harness.publisher.detach();
        await harness.publisher.attach(listener);
        if (fails) capture.reject(new Error("old capture failed"));
        else capture.resolve(FRAME_A);
        await firstAttach;
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.captures).toBe(2);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0]?.[0].data).toEqual(FRAME_B);
        expect(harness.observed.map((frame) => frame.data)).toEqual([FRAME_B]);
        expect(vi.getTimerCount()).toBe(1);
      } finally {
        await harness.publisher.detach();
        vi.useRealTimers();
      }
    },
  );

  it("publishes the first frame, dedupes identical ones, and republishes on a keyframe", async () => {
    let bytes = FRAME_A;
    const harness = makePublisher(async () => bytes);
    await harness.publisher.attach((frame) => harness.frames.push(frame));

    expect(harness.frames).toHaveLength(1);
    // Both the attached pane and the event observers see the same still.
    expect(harness.observed).toEqual(harness.frames);

    await harness.publisher.publish();
    expect(harness.frames).toHaveLength(1);

    // A receiver with nothing to draw asks for one anyway.
    await harness.publisher.requestKeyframe();
    expect(harness.frames).toHaveLength(2);

    bytes = FRAME_B;
    await harness.publisher.publish();
    expect(harness.frames).toHaveLength(3);
    await harness.publisher.detach();
  });

  it("passes keyframe force to native deduplication after idle ticks and reattach", async () => {
    const forces: boolean[] = [];
    const harness = makePublisher(async (force) => {
      forces.push(force);
      return force ? FRAME_A : undefined;
    });
    await harness.publisher.attach((frame) => harness.frames.push(frame));
    await harness.publisher.publish();
    await harness.publisher.publish();
    expect(harness.frames).toHaveLength(1);
    await harness.publisher.requestKeyframe();
    expect(harness.frames).toHaveLength(2);
    await harness.publisher.detach();
    await harness.publisher.attach((frame) => harness.frames.push(frame));
    expect(harness.frames).toHaveLength(3);
    expect(forces).toEqual([true, false, false, true, true]);
    await harness.publisher.detach();
  });

  it("bounds the retries a failing forced capture buys", async () => {
    // The unbounded version re-armed the force on every failure, and the
    // `finally` block republished because a force was pending — a tight
    // recursion that never yielded to the timer for as long as captures failed.
    const harness = makePublisher(async () => {
      throw new Error("capture failed");
    });
    await harness.publisher.attach((frame) => harness.frames.push(frame));

    expect(harness.frames).toHaveLength(0);
    // The forced attach, plus exactly one immediate retry.
    expect(harness.captures).toBe(2);

    // The timer cadence takes over from here: one capture per tick, not a loop.
    await harness.publisher.publish();
    expect(harness.captures).toBe(3);
    await harness.publisher.detach();
  });

  it("gives a fresh keyframe request its own retry budget", async () => {
    const harness = makePublisher(async () => {
      throw new Error("capture failed");
    });
    await harness.publisher.attach((frame) => harness.frames.push(frame));
    expect(harness.captures).toBe(2);

    // A later receiver's request must not inherit the exhausted budget of the
    // one before it: it has no picture either.
    await harness.publisher.requestKeyframe();
    expect(harness.captures).toBe(4);
    await harness.publisher.detach();
  });

  it("serves a keyframe requested while a capture was already in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes = FRAME_A;
    let gated = false;
    const harness = makePublisher(async () => {
      if (gated) {
        gated = false;
        await gate;
      }
      return bytes;
    });

    await harness.publisher.attach((frame) => harness.frames.push(frame));
    expect(harness.frames).toHaveLength(1);

    gated = true;
    const inFlight = harness.publisher.publish();
    // Asked for precisely because the pane is blank; dropping it left the pane
    // blank until the desktop happened to change on its own.
    const keyframe = harness.publisher.requestKeyframe();
    release();
    await inFlight;
    await keyframe;

    // The in-flight capture deduped against what it had just published, and the
    // deferred force then published anyway despite the bytes being identical.
    expect(harness.frames).toHaveLength(2);
    await harness.publisher.detach();
  });

  it("skips a tick the backend declines without spending the force", async () => {
    // `undefined` is "step aside", not "failed": the backend noticed mid-capture
    // that another request owns the capture path.
    const harness = makePublisher(async () => undefined);
    await harness.publisher.attach((frame) => harness.frames.push(frame));
    expect(harness.frames).toHaveLength(0);
    expect(harness.captures).toBe(1);
    await harness.publisher.detach();
  });

  it("never captures while the backend says capture is unavailable", async () => {
    const harness = makePublisher(async () => FRAME_A, { captureAvailable: () => false });
    await harness.publisher.attach((frame) => harness.frames.push(frame));
    await harness.publisher.publish();
    await harness.publisher.requestKeyframe();
    expect(harness.captures).toBe(0);
    expect(harness.frames).toHaveLength(0);
    await harness.publisher.detach();
  });

  it("stops the timer loop on detach", async () => {
    vi.useFakeTimers();
    try {
      let bytes = FRAME_A;
      const harness = makePublisher(async () => bytes, { intervalMs: 100 });
      await harness.publisher.attach((frame) => harness.frames.push(frame));
      await vi.advanceTimersByTimeAsync(250);
      const whileAttached = harness.captures;
      expect(whileAttached).toBeGreaterThan(1);

      await harness.publisher.detach();
      bytes = FRAME_B;
      await vi.advanceTimersByTimeAsync(500);
      // A detached publisher owns no timer, so nothing keeps pulling captures
      // out of a desktop nobody is watching.
      expect(harness.captures).toBe(whileAttached);
      expect(harness.frames).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps exactly the newest attach's timer when two attaches overlap", async () => {
    vi.useFakeTimers();
    try {
      const harness = makePublisher(async () => FRAME_A, { intervalMs: 100 });
      const firstFrames: ComputerStreamFrame[] = [];
      const secondFrames: ComputerStreamFrame[] = [];
      await Promise.all([
        harness.publisher.attach((frame) => firstFrames.push(frame)),
        harness.publisher.attach((frame) => secondFrames.push(frame)),
      ]);
      const settled = harness.captures;
      await vi.advanceTimersByTimeAsync(100);
      // One interval, not two: an orphaned timer nothing can clear would keep
      // capturing for the life of the process.
      expect(harness.captures).toBe(settled + 1);
      await harness.publisher.detach();
    } finally {
      vi.useRealTimers();
    }
  });
});
