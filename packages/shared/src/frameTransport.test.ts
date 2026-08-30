import { describe, expect, it } from "vitest";

import {
  decodeFrameEnvelope,
  decodeFrameResyncRequest,
  encodeFrameEnvelope,
  FrameEncodeError,
  FRAME_HEADER_FIXED_BYTES,
  FrameTransport,
  makeFrameSink,
} from "./frameTransport";
import {
  DEVICE_FRAME_HEADER_FIXED_BYTES,
  DEVICE_FRAME_MAGIC,
  DEVICE_FRAME_MAX_DEVICE_ID_BYTES,
  DEVICE_FRAME_VERSION,
} from "@synara/contracts";

interface TestFrame {
  readonly sequence: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
}

class Sink {
  readonly received: number[] = [];
  open = true;
  buffered = 0;

  readonly send = (bytes: Uint8Array): void => {
    this.received.push(bytes[0] ?? 0);
  };
  readonly bufferedAmount = (): number => this.buffered;
  readonly isOpen = (): boolean => this.open;
}

function makeTransport(options: { queueLimit?: number; socketBudgetBytes?: number } = {}) {
  return new FrameTransport<string, TestFrame>({
    encode: (_streamId, frame) => Uint8Array.of(frame.sequence),
    subscriberIdPrefix: "test",
    ...options,
  });
}

describe("shared frame transport", () => {
  const deviceCodec = {
    magic: DEVICE_FRAME_MAGIC,
    version: DEVICE_FRAME_VERSION,
    streamIdLabel: "deviceId",
    frameLabel: "Device",
    maxStreamIdBytes: DEVICE_FRAME_MAX_DEVICE_ID_BYTES,
  } as const;

  it("keeps the fixed header layout and round-trips the real codec", () => {
    expect(FRAME_HEADER_FIXED_BYTES).toBe(DEVICE_FRAME_HEADER_FIXED_BYTES);

    const encoded = encodeFrameEnvelope(deviceCodec, {
      header: {
        streamId: "d",
        sequence: 0x0102_0304,
        timestampMs: 1.5,
        keyframe: true,
        codecConfig: true,
      },
      payload: Uint8Array.of(0xaa, 0xbb),
    });

    expect(Array.from(encoded.subarray(0, FRAME_HEADER_FIXED_BYTES))).toEqual([
      0x46, 0x53, 0x01, 0x03, 0x04, 0x03, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8,
      0x3f, 0x01,
    ]);
    expect(decodeFrameEnvelope(deviceCodec, encoded)).toEqual({
      ok: true,
      frame: {
        header: {
          streamId: "d",
          sequence: 0x0102_0304,
          timestampMs: 1.5,
          keyframe: true,
          codecConfig: true,
        },
        payload: Uint8Array.of(0xaa, 0xbb),
      },
    });
  });

  it("rejects invalid stream ids, magic, and versions", () => {
    const frame = {
      header: {
        streamId: "d",
        sequence: 1,
        timestampMs: 0,
        keyframe: false,
        codecConfig: false,
      },
      payload: new Uint8Array(),
    } as const;

    expect(() =>
      encodeFrameEnvelope(deviceCodec, { ...frame, header: { ...frame.header, streamId: "" } }),
    ).toThrow(FrameEncodeError);
    expect(() =>
      encodeFrameEnvelope(deviceCodec, {
        ...frame,
        header: { ...frame.header, streamId: "x".repeat(DEVICE_FRAME_MAX_DEVICE_ID_BYTES + 1) },
      }),
    ).toThrow(FrameEncodeError);

    const encoded = encodeFrameEnvelope(deviceCodec, frame);
    const wrongMagic = encoded.slice();
    new DataView(wrongMagic.buffer, wrongMagic.byteOffset, wrongMagic.byteLength).setUint16(
      0,
      DEVICE_FRAME_MAGIC ^ 0xffff,
      true,
    );
    expect(decodeFrameEnvelope(deviceCodec, wrongMagic)).toEqual({
      ok: false,
      reason: "bad-magic",
    });

    const unsupportedVersion = encoded.slice();
    unsupportedVersion[2] = DEVICE_FRAME_VERSION + 1;
    expect(decodeFrameEnvelope(deviceCodec, unsupportedVersion)).toEqual({
      ok: false,
      reason: "unsupported-version",
    });
  });

  it("gates new subscribers and primes them with codec config and keyframe", () => {
    const transport = makeTransport();
    const early = new Sink();
    transport.subscribe("desktop", early);
    transport.publish("desktop", { sequence: 1, keyframe: false, codecConfig: true });
    transport.publish("desktop", { sequence: 2, keyframe: true, codecConfig: false });
    transport.publish("desktop", { sequence: 3, keyframe: false, codecConfig: false });

    const late = new Sink();
    transport.subscribe("desktop", late);
    expect(late.received).toEqual([1, 2]);

    transport.publish("desktop", { sequence: 4, keyframe: false, codecConfig: false });
    expect(early.received).toEqual([1, 2, 3, 4]);
  });

  it("drops a stalled backlog until the next keyframe", () => {
    const transport = makeTransport({ queueLimit: 2, socketBudgetBytes: 0 });
    const sink = new Sink();
    transport.subscribe("desktop", sink);
    transport.publish("desktop", { sequence: 1, keyframe: true, codecConfig: false });
    sink.buffered = 100;
    transport.publish("desktop", { sequence: 2, keyframe: false, codecConfig: false });
    transport.publish("desktop", { sequence: 3, keyframe: false, codecConfig: false });
    transport.publish("desktop", { sequence: 4, keyframe: false, codecConfig: false });
    sink.buffered = 0;
    transport.publish("desktop", { sequence: 5, keyframe: true, codecConfig: false });
    transport.publish("desktop", { sequence: 6, keyframe: false, codecConfig: false });

    expect(sink.received).toEqual([1, 5, 6]);
    expect(transport.statsFor("desktop")[0]?.awaitingKeyframe).toBe(false);
  });

  it("keeps only the latest codec config for a stalled subscriber", () => {
    const transport = makeTransport({ queueLimit: 2, socketBudgetBytes: 10 });
    const sink = new Sink();
    transport.subscribe("desktop", sink);
    transport.publish("desktop", { sequence: 1, keyframe: true, codecConfig: false });
    sink.buffered = 100;
    for (let sequence = 2; sequence <= 40; sequence += 1) {
      transport.publish("desktop", { sequence, keyframe: false, codecConfig: true });
    }
    expect(transport.statsFor("desktop")[0]?.queued).toBe(1);

    // Deltas before the next keyframe are undecodable under the new config.
    transport.publish("desktop", { sequence: 41, keyframe: false, codecConfig: false });
    transport.publish("desktop", { sequence: 42, keyframe: true, codecConfig: false });
    expect(transport.statsFor("desktop")[0]?.queued).toBe(2);

    sink.buffered = 0;
    transport.publish("desktop", { sequence: 43, keyframe: false, codecConfig: false });
    expect(sink.received).toEqual([1, 40, 42, 43]);
  });

  it("shares bounded sink accounting and resync parsing", async () => {
    let open = true;
    let sent = 0;
    const sink = makeFrameSink({
      send: async (bytes) => {
        sent += bytes.byteLength;
      },
      isOpen: () => open,
    });
    sink.send(Uint8Array.of(1, 2, 3));
    await Promise.resolve();
    expect(sink.bufferedAmount()).toBe(0);
    expect(sent).toBe(3);
    expect(decodeFrameResyncRequest('{"type":"device.frame.resync"}', "device.frame.resync")).toBe(
      "resync",
    );
    expect(decodeFrameResyncRequest('{"type":"wrong"}', "device.frame.resync")).toBeNull();
    open = false;
    expect(sink.isOpen()).toBe(false);
  });
});
