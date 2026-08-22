import {
  DEVICE_FRAME_HEADER_FIXED_BYTES,
  DEVICE_FRAME_MAGIC,
  DEVICE_FRAME_VERSION,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  DeviceFrameEncodeError,
  decodeDeviceFrame,
  encodeDeviceFrame,
  peekDeviceFrameHeader,
} from "./deviceFrame";

const header = {
  deviceId: "A1B2C3D4-1111-2222-3333-444455556666",
  sequence: 42,
  timestampMs: 1_234.5,
  keyframe: false,
  codecConfig: false,
};

const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0xff]);

describe("encodeDeviceFrame / decodeDeviceFrame", () => {
  it("round-trips header fields and payload bytes", () => {
    const result = decodeDeviceFrame(encodeDeviceFrame({ header, payload }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.header).toEqual(header);
    expect(Array.from(result.frame.payload)).toEqual(Array.from(payload));
  });

  it("round-trips an empty payload", () => {
    const result = decodeDeviceFrame(encodeDeviceFrame({ header, payload: new Uint8Array() }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.payload.byteLength).toBe(0);
  });

  it("round-trips multibyte device ids", () => {
    const unicodeId = "emulator-5554-日本語";
    const result = decodeDeviceFrame(
      encodeDeviceFrame({ header: { ...header, deviceId: unicodeId }, payload }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.header.deviceId).toBe(unicodeId);
  });

  it("carries the keyframe and codec-config flags independently", () => {
    const keyframeOnly = decodeDeviceFrame(
      encodeDeviceFrame({ header: { ...header, keyframe: true }, payload }),
    );
    expect(keyframeOnly.ok && keyframeOnly.frame.header.keyframe).toBe(true);
    expect(keyframeOnly.ok && keyframeOnly.frame.header.codecConfig).toBe(false);

    const both = decodeDeviceFrame(
      encodeDeviceFrame({ header: { ...header, keyframe: true, codecConfig: true }, payload }),
    );
    expect(both.ok && both.frame.header.keyframe).toBe(true);
    expect(both.ok && both.frame.header.codecConfig).toBe(true);
  });

  it("wraps the sequence counter instead of corrupting the frame", () => {
    const result = decodeDeviceFrame(
      encodeDeviceFrame({ header: { ...header, sequence: 0xffff_ffff + 1 }, payload }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.header.sequence).toBe(0);
  });

  it("decodes a frame carried at a non-zero offset in a larger buffer", () => {
    const encoded = encodeDeviceFrame({ header, payload });
    const backing = new Uint8Array(encoded.byteLength + 8);
    backing.set(encoded, 8);

    const result = decodeDeviceFrame(backing.subarray(8));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.header.deviceId).toBe(header.deviceId);
    expect(Array.from(result.frame.payload)).toEqual(Array.from(payload));
  });

  it("rejects an empty or oversized device id at encode time", () => {
    expect(() => encodeDeviceFrame({ header: { ...header, deviceId: "" }, payload })).toThrow(
      DeviceFrameEncodeError,
    );
    expect(() =>
      encodeDeviceFrame({ header: { ...header, deviceId: "u".repeat(256) }, payload }),
    ).toThrow(DeviceFrameEncodeError);
  });
});

describe("decodeDeviceFrame malformed input", () => {
  const encoded = encodeDeviceFrame({ header, payload });

  it("rejects buffers shorter than the fixed header", () => {
    expect(decodeDeviceFrame(new Uint8Array(DEVICE_FRAME_HEADER_FIXED_BYTES - 1))).toEqual({
      ok: false,
      reason: "too-short",
    });
  });

  it("rejects a wrong magic", () => {
    const corrupted = encoded.slice();
    new DataView(corrupted.buffer).setUint16(0, DEVICE_FRAME_MAGIC ^ 0xffff, true);

    expect(decodeDeviceFrame(corrupted)).toEqual({ ok: false, reason: "bad-magic" });
  });

  it("rejects a future protocol version", () => {
    const corrupted = encoded.slice();
    corrupted[2] = DEVICE_FRAME_VERSION + 1;

    expect(decodeDeviceFrame(corrupted)).toEqual({ ok: false, reason: "unsupported-version" });
  });

  it("rejects a device id length that runs past the buffer", () => {
    const corrupted = encoded.slice();
    corrupted[16] = 255;

    expect(decodeDeviceFrame(corrupted)).toEqual({ ok: false, reason: "truncated-device-id" });
  });

  it("rejects a zero-length device id", () => {
    const corrupted = encoded.slice();
    corrupted[16] = 0;

    expect(decodeDeviceFrame(corrupted)).toEqual({ ok: false, reason: "truncated-device-id" });
  });

  it("rejects a device id that is not valid UTF-8", () => {
    const corrupted = encoded.slice();
    corrupted[DEVICE_FRAME_HEADER_FIXED_BYTES] = 0xff;

    expect(decodeDeviceFrame(corrupted)).toEqual({ ok: false, reason: "invalid-device-id" });
  });
});

describe("peekDeviceFrameHeader", () => {
  it("returns the header for a valid frame and null otherwise", () => {
    expect(peekDeviceFrameHeader(encodeDeviceFrame({ header, payload }))).toEqual(header);
    expect(peekDeviceFrameHeader(new Uint8Array(4))).toBeNull();
  });
});
