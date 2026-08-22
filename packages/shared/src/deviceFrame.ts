import {
  DEVICE_FRAME_FLAG_CODEC_CONFIG,
  DEVICE_FRAME_FLAG_KEYFRAME,
  DEVICE_FRAME_HEADER_FIXED_BYTES,
  DEVICE_FRAME_MAGIC,
  DEVICE_FRAME_MAX_DEVICE_ID_BYTES,
  DEVICE_FRAME_VERSION,
  type DeviceFrameDecodeErrorReason,
  type DeviceFrameHeader,
} from "@synara/contracts";

/**
 * Encoded video rides its own WebSocket rather than the JSON RPC socket: a
 * separate connection means a video backlog can never sit in front of an RPC
 * response in the same send queue, and this path is deliberately excluded from
 * per-message deflate (H.264 is already compressed).
 *
 * The device to stream is named by the `udid` query parameter.
 */
export const DEVICE_FRAME_WS_PATH = "/ws/device-frames";
export const DEVICE_FRAME_WS_UDID_PARAM = "udid";

/**
 * The one message a client may send on the frame socket, as
 * `{"type":"device.frame.resync"}`.
 *
 * A decoder that hits a sequence gap or a decode error needs fresh parameter
 * sets and an IDR, and the encoder's next natural keyframe can be seconds
 * away. The server answers by restarting the capture session, which always
 * emits a codec-config frame followed by a keyframe.
 *
 * It rides this socket rather than the RPC one because it is a property of
 * this stream, and a frozen canvas should not depend on a second socket being
 * healthy. Unrecognized messages are ignored rather than treated as errors.
 */
export const DEVICE_FRAME_RESYNC_MESSAGE = "device.frame.resync";

export interface DeviceFrame {
  readonly header: DeviceFrameHeader;
  readonly payload: Uint8Array;
}

export type DeviceFrameDecodeResult =
  | { readonly ok: true; readonly frame: DeviceFrame }
  | { readonly ok: false; readonly reason: DeviceFrameDecodeErrorReason };

const textEncoder = new TextEncoder();
// `fatal` makes malformed UTF-8 in the device id a rejection rather than a
// string full of replacement characters that would later fail to match a device.
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class DeviceFrameEncodeError extends Error {}

/**
 * Serializes one encoded video frame into the binary envelope described in
 * `@synara/contracts` (`DeviceFrameHeader`). Little-endian throughout.
 */
export const encodeDeviceFrame = (frame: DeviceFrame): Uint8Array => {
  const deviceIdBytes = textEncoder.encode(frame.header.deviceId);
  if (deviceIdBytes.byteLength === 0) {
    throw new DeviceFrameEncodeError("Device frame header requires a non-empty deviceId");
  }
  if (deviceIdBytes.byteLength > DEVICE_FRAME_MAX_DEVICE_ID_BYTES) {
    throw new DeviceFrameEncodeError(
      `Device frame deviceId exceeds ${DEVICE_FRAME_MAX_DEVICE_ID_BYTES} UTF-8 bytes`,
    );
  }

  const buffer = new ArrayBuffer(
    DEVICE_FRAME_HEADER_FIXED_BYTES + deviceIdBytes.byteLength + frame.payload.byteLength,
  );
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let flags = 0;
  if (frame.header.keyframe) flags |= DEVICE_FRAME_FLAG_KEYFRAME;
  if (frame.header.codecConfig) flags |= DEVICE_FRAME_FLAG_CODEC_CONFIG;

  view.setUint16(0, DEVICE_FRAME_MAGIC, true);
  view.setUint8(2, DEVICE_FRAME_VERSION);
  view.setUint8(3, flags);
  // Sequence wraps rather than throwing: a long-lived stream must not die at 2^32.
  view.setUint32(4, frame.header.sequence >>> 0, true);
  view.setFloat64(8, frame.header.timestampMs, true);
  view.setUint8(16, deviceIdBytes.byteLength);
  bytes.set(deviceIdBytes, DEVICE_FRAME_HEADER_FIXED_BYTES);
  bytes.set(frame.payload, DEVICE_FRAME_HEADER_FIXED_BYTES + deviceIdBytes.byteLength);

  return bytes;
};

/**
 * Parses a binary WebSocket message as a device frame. Returns a reason instead
 * of throwing so the transport can drop a bad frame and keep the socket alive.
 */
export const decodeDeviceFrame = (bytes: Uint8Array): DeviceFrameDecodeResult => {
  if (bytes.byteLength < DEVICE_FRAME_HEADER_FIXED_BYTES) {
    return { ok: false, reason: "too-short" };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== DEVICE_FRAME_MAGIC) {
    return { ok: false, reason: "bad-magic" };
  }
  if (view.getUint8(2) !== DEVICE_FRAME_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }

  const flags = view.getUint8(3);
  const deviceIdLength = view.getUint8(16);
  const payloadOffset = DEVICE_FRAME_HEADER_FIXED_BYTES + deviceIdLength;
  if (deviceIdLength === 0 || bytes.byteLength < payloadOffset) {
    return { ok: false, reason: "truncated-device-id" };
  }

  let deviceId: string;
  try {
    deviceId = textDecoder.decode(bytes.subarray(DEVICE_FRAME_HEADER_FIXED_BYTES, payloadOffset));
  } catch {
    return { ok: false, reason: "invalid-device-id" };
  }

  return {
    ok: true,
    frame: {
      header: {
        deviceId,
        sequence: view.getUint32(4, true),
        timestampMs: view.getFloat64(8, true),
        keyframe: (flags & DEVICE_FRAME_FLAG_KEYFRAME) !== 0,
        codecConfig: (flags & DEVICE_FRAME_FLAG_CODEC_CONFIG) !== 0,
      },
      // A view, not a copy: the decode path runs per frame and the caller hands
      // the payload straight to VideoDecoder.
      payload: bytes.subarray(payloadOffset),
    },
  };
};

/**
 * Reads only the routing fields. Used by fan-out paths that need to decide
 * which pane (if any) wants a frame before touching the payload.
 */
export const peekDeviceFrameHeader = (bytes: Uint8Array): DeviceFrameHeader | null => {
  const result = decodeDeviceFrame(bytes);
  return result.ok ? result.frame.header : null;
};
