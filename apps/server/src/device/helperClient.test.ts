import { describe, expect, it } from "vitest";

import { decodeDeviceFrame, encodeDeviceFrame } from "@synara/shared/deviceFrame";

import { DeviceFramePrefixParser, DeviceHelperError, encodeFrameRecord } from "./helperClient.ts";

const DEVICE = "FAKE-0001";

/**
 * What the helper actually puts on the socket: the contract envelope, wrapped
 * in its own u32 length prefix.
 */
function record(
  options: {
    readonly sequence?: number;
    readonly keyframe?: boolean;
    readonly codecConfig?: boolean;
    readonly payload?: Uint8Array;
  } = {},
) {
  return encodeFrameRecord(
    encodeDeviceFrame({
      header: {
        deviceId: DEVICE,
        sequence: options.sequence ?? 1,
        timestampMs: 100,
        keyframe: options.keyframe ?? false,
        codecConfig: options.codecConfig ?? false,
      },
      payload: options.payload ?? new Uint8Array([1, 2, 3]),
    }),
  );
}

describe("helper frame prefix parser", () => {
  it("unwraps one whole record", () => {
    const parser = new DeviceFramePrefixParser();

    const payloads = parser.push(record({ sequence: 7, keyframe: true }));

    expect(payloads).toHaveLength(1);
    // The payload is passed through untouched: it is already the envelope the
    // transport and the browser decode.
    expect(payloads[0]!.byteLength).toBeGreaterThan(17);
  });

  it("reassembles a record split across chunks", () => {
    const parser = new DeviceFramePrefixParser();
    const bytes = record({ payload: new Uint8Array([4, 5, 6, 7]) });

    const first = parser.push(bytes.subarray(0, 3));
    const second = parser.push(bytes.subarray(3, 12));
    const third = parser.push(bytes.subarray(12));

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
    expect(third[0]!.byteLength).toBe(bytes.byteLength - 4);
  });

  it("returns every record in a chunk carrying several", () => {
    const parser = new DeviceFramePrefixParser();

    const payloads = parser.push(
      Buffer.concat([
        record({ sequence: 1 }),
        record({ sequence: 2, keyframe: true }),
        record({ sequence: 3 }),
      ]),
    );

    expect(payloads).toHaveLength(3);
  });

  it("copies payloads so a later chunk cannot mutate an emitted frame", () => {
    const parser = new DeviceFramePrefixParser();
    const bytes = record({ payload: new Uint8Array([7, 7]) });

    const payloads = parser.push(bytes);
    const before = Array.from(payloads[0]!);
    bytes.fill(0);

    expect(Array.from(payloads[0]!)).toEqual(before);
  });

  it("rejects an implausible length prefix instead of allocating", () => {
    const parser = new DeviceFramePrefixParser();
    const desynced = Buffer.alloc(8);
    desynced.writeUInt32LE(0xff_ff_ff_ff, 0);

    expect(() => parser.push(desynced)).toThrow(DeviceHelperError);
  });

  it("emits nothing for a length prefix with no payload yet", () => {
    const parser = new DeviceFramePrefixParser();
    const prefixOnly = Buffer.alloc(4);
    prefixOnly.writeUInt32LE(64, 0);

    expect(parser.push(prefixOnly)).toHaveLength(0);
  });
});

/**
 * The helper writes a full contract envelope and `DeviceFrameTransport`
 * re-encodes one with the routing device id it already has. Forwarding the
 * helper's record whole therefore leaves two headers in front of the access
 * unit, and every frame fails to decode in the browser with a bare "Decoding
 * error" — which is what shipped before this was caught end to end.
 */
describe("helper frame envelope handling", () => {
  it("yields an access unit the transport can re-envelope exactly once", () => {
    const accessUnit = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x33]);
    const parser = new DeviceFramePrefixParser();

    const [helperRecord] = parser.push(record({ payload: accessUnit, keyframe: true }));
    if (!helperRecord) throw new Error("expected one record");

    // What the socket handler does before handing the frame to the transport.
    const decoded = decodeDeviceFrame(helperRecord);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Array.from(decoded.frame.payload)).toEqual(Array.from(accessUnit));

    // What the transport then puts on the wire, and what the browser decodes.
    const republished = decodeDeviceFrame(
      encodeDeviceFrame({ header: decoded.frame.header, payload: decoded.frame.payload }),
    );
    expect(republished.ok).toBe(true);
    if (!republished.ok) return;
    expect(Array.from(republished.frame.payload)).toEqual(Array.from(accessUnit));
    expect(republished.frame.header.keyframe).toBe(true);
  });
});
