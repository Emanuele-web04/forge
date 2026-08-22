import { describe, expect, it } from "vitest";

import { decodeDeviceFrame } from "@synara/shared/deviceFrame";

import type { DeviceStreamFrame } from "./DeviceBackend.ts";
import { DeviceFrameTransport, type DeviceFrameSink } from "./deviceFrameTransport.ts";

const DEVICE = "FAKE-0001";

/** A sink whose socket backlog and open state the test drives directly. */
class RecordingSink implements DeviceFrameSink {
  readonly received: Uint8Array[] = [];
  buffered = 0;
  open = true;

  send = (bytes: Uint8Array): void => {
    this.received.push(bytes);
  };
  bufferedAmount = (): number => this.buffered;
  isOpen = (): boolean => this.open;

  get headers() {
    return this.received.map((bytes) => {
      const decoded = decodeDeviceFrame(bytes);
      if (!decoded.ok) throw new Error(`undecodable frame: ${decoded.reason}`);
      return decoded.frame.header;
    });
  }

  get sequences(): number[] {
    return this.headers.map((header) => header.sequence);
  }
}

let nextSequence = 0;
function frame(overrides: Partial<DeviceStreamFrame> = {}): DeviceStreamFrame {
  nextSequence += 1;
  return {
    sequence: overrides.sequence ?? nextSequence,
    timestampMs: overrides.timestampMs ?? nextSequence * 16.7,
    keyframe: overrides.keyframe ?? false,
    codecConfig: overrides.codecConfig ?? false,
    data: overrides.data ?? new Uint8Array([nextSequence & 0xff, 0x42]),
  };
}

describe("device frame transport framing", () => {
  it("round-trips header fields and payload through the envelope", () => {
    const transport = new DeviceFrameTransport();
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    transport.publish(
      DEVICE,
      frame({ sequence: 7, timestampMs: 123.5, keyframe: true, data: payload }),
    );

    const decoded = decodeDeviceFrame(sink.received[0]!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.header).toEqual({
      deviceId: DEVICE,
      sequence: 7,
      timestampMs: 123.5,
      keyframe: true,
      codecConfig: false,
    });
    expect(Array.from(decoded.frame.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it("delivers frames in sequence order with no gaps to a keeping-up client", () => {
    const transport = new DeviceFrameTransport();
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);

    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));
    for (let sequence = 2; sequence <= 10; sequence += 1) {
      transport.publish(DEVICE, frame({ sequence }));
    }

    expect(sink.sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("routes only the frames of the device a subscriber asked for", () => {
    const transport = new DeviceFrameTransport();
    const sinkA = new RecordingSink();
    const sinkB = new RecordingSink();
    transport.subscribe(DEVICE, sinkA);
    transport.subscribe("FAKE-0002", sinkB);

    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));

    expect(sinkA.received).toHaveLength(1);
    expect(sinkB.received).toHaveLength(0);
  });
});

describe("device frame transport keyframe gating", () => {
  it("withholds frames from a new subscriber until a keyframe arrives", () => {
    const transport = new DeviceFrameTransport();
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);

    transport.publish(DEVICE, frame({ sequence: 1 }));
    transport.publish(DEVICE, frame({ sequence: 2 }));
    transport.publish(DEVICE, frame({ sequence: 3, keyframe: true }));
    transport.publish(DEVICE, frame({ sequence: 4 }));

    expect(sink.sequences).toEqual([3, 4]);
  });

  it("primes a late subscriber with the codec config and the last keyframe", () => {
    const transport = new DeviceFrameTransport();
    const early = new RecordingSink();
    transport.subscribe(DEVICE, early);

    transport.publish(DEVICE, frame({ sequence: 1, codecConfig: true }));
    transport.publish(DEVICE, frame({ sequence: 2, keyframe: true }));
    transport.publish(DEVICE, frame({ sequence: 3 }));

    const late = new RecordingSink();
    transport.subscribe(DEVICE, late);

    expect(late.headers.map((header) => [header.sequence, header.codecConfig])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("forgets cached keyframes once the device stream ends", () => {
    const transport = new DeviceFrameTransport();
    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));

    transport.resetDevice(DEVICE);
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);

    expect(sink.received).toHaveLength(0);
  });
});

describe("device frame transport backpressure", () => {
  it("queues rather than writing while the socket is backed up", () => {
    const transport = new DeviceFrameTransport({ queueLimit: 4, socketBudgetBytes: 100 });
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);
    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));

    sink.buffered = 1_000;
    transport.publish(DEVICE, frame({ sequence: 2 }));

    expect(sink.sequences).toEqual([1]);
    expect(transport.statsFor(DEVICE)[0]?.queued).toBe(1);
  });

  it("flushes the queue in order once the socket drains", () => {
    const transport = new DeviceFrameTransport({ queueLimit: 4, socketBudgetBytes: 100 });
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);
    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));

    sink.buffered = 1_000;
    transport.publish(DEVICE, frame({ sequence: 2 }));
    transport.publish(DEVICE, frame({ sequence: 3 }));
    sink.buffered = 0;
    transport.publish(DEVICE, frame({ sequence: 4 }));

    expect(sink.sequences).toEqual([1, 2, 3, 4]);
  });

  it("drops the backlog and waits for the next keyframe when the queue overflows", () => {
    const transport = new DeviceFrameTransport({ queueLimit: 2, socketBudgetBytes: 100 });
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);
    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));

    sink.buffered = 1_000;
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      transport.publish(DEVICE, frame({ sequence }));
    }
    sink.buffered = 0;
    transport.publish(DEVICE, frame({ sequence: 9 }));
    transport.publish(DEVICE, frame({ sequence: 10, keyframe: true }));
    transport.publish(DEVICE, frame({ sequence: 11 }));

    // Nothing between the overflow and the re-sync keyframe is delivered, and
    // delivery resumes exactly at that keyframe.
    expect(sink.sequences).toEqual([1, 10, 11]);
    expect(transport.statsFor(DEVICE)[0]?.dropped).toBeGreaterThan(0);
  });

  it("never lets a stalled subscriber's queue grow past the limit", () => {
    const transport = new DeviceFrameTransport({ queueLimit: 3, socketBudgetBytes: 0 });
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);
    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));

    sink.buffered = 1;
    for (let sequence = 2; sequence <= 500; sequence += 1) {
      transport.publish(DEVICE, frame({ sequence, keyframe: sequence % 5 === 0 }));
      expect(transport.statsFor(DEVICE)[0]!.queued).toBeLessThanOrEqual(3);
    }
  });

  it("still delivers codec config to a stalled subscriber", () => {
    const transport = new DeviceFrameTransport({ queueLimit: 1, socketBudgetBytes: 0 });
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);
    sink.buffered = 10_000;

    for (let sequence = 1; sequence <= 20; sequence += 1) {
      transport.publish(DEVICE, frame({ sequence }));
    }
    transport.publish(DEVICE, frame({ sequence: 21, codecConfig: true }));
    sink.buffered = 0;
    transport.publish(DEVICE, frame({ sequence: 22, keyframe: true }));

    expect(sink.headers.some((header) => header.codecConfig)).toBe(true);
  });

  it("drops a subscriber whose connection closed", () => {
    const transport = new DeviceFrameTransport();
    const sink = new RecordingSink();
    transport.subscribe(DEVICE, sink);
    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));

    sink.open = false;
    transport.publish(DEVICE, frame({ sequence: 2, keyframe: true }));

    expect(sink.received).toHaveLength(1);
    expect(transport.deviceSubscriberCount(DEVICE)).toBe(0);
  });

  it("stops routing to a subscriber after it unsubscribes", () => {
    const transport = new DeviceFrameTransport();
    const sink = new RecordingSink();
    const unsubscribe = transport.subscribe(DEVICE, sink);
    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));

    unsubscribe();
    transport.publish(DEVICE, frame({ sequence: 2, keyframe: true }));

    expect(sink.received).toHaveLength(1);
    expect(transport.subscriberCount).toBe(0);
  });

  it("isolates a slow subscriber from a fast one on the same device", () => {
    const transport = new DeviceFrameTransport({ queueLimit: 1, socketBudgetBytes: 100 });
    const fast = new RecordingSink();
    const slow = new RecordingSink();
    transport.subscribe(DEVICE, fast);
    transport.subscribe(DEVICE, slow);
    transport.publish(DEVICE, frame({ sequence: 1, keyframe: true }));
    slow.buffered = 10_000;

    for (let sequence = 2; sequence <= 20; sequence += 1) {
      transport.publish(DEVICE, frame({ sequence }));
    }

    expect(fast.sequences).toHaveLength(20);
    expect(slow.received.length).toBeLessThan(fast.received.length);
  });
});
