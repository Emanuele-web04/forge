import { decodeFrameEnvelope, encodeFrameEnvelope, FrameEncodeError } from "./frameTransport";
import {
  DEVICE_FRAME_MAGIC,
  DEVICE_FRAME_MAX_DEVICE_ID_BYTES,
  DEVICE_FRAME_VERSION,
  type DeviceFrameDecodeErrorReason,
  type DeviceFrameHeader,
} from "@synara/contracts";

/** Encoded device frames use a dedicated, uncompressed WebSocket connection. */
export const DEVICE_FRAME_WS_PATH = "/ws/device-frames";
export const DEVICE_FRAME_WS_UDID_PARAM = "udid";
export const DEVICE_FRAME_RESYNC_MESSAGE = "device.frame.resync";

export interface DeviceFrame {
  readonly header: DeviceFrameHeader;
  readonly payload: Uint8Array;
}

export type DeviceFrameDecodeResult =
  | { readonly ok: true; readonly frame: DeviceFrame }
  | { readonly ok: false; readonly reason: DeviceFrameDecodeErrorReason };

export class DeviceFrameEncodeError extends Error {}

const DEVICE_FRAME_CODEC = {
  magic: DEVICE_FRAME_MAGIC,
  version: DEVICE_FRAME_VERSION,
  streamIdLabel: "deviceId",
  frameLabel: "Device",
  maxStreamIdBytes: DEVICE_FRAME_MAX_DEVICE_ID_BYTES,
} as const;

/**
 * Serializes a device frame through the shared binary envelope codec. The
 * device-shaped wrapper preserves the existing wire format and error names.
 */
export const encodeDeviceFrame = (frame: DeviceFrame): Uint8Array => {
  try {
    return encodeFrameEnvelope(DEVICE_FRAME_CODEC, {
      header: {
        streamId: frame.header.deviceId,
        sequence: frame.header.sequence,
        timestampMs: frame.header.timestampMs,
        keyframe: frame.header.keyframe,
        codecConfig: frame.header.codecConfig,
      },
      payload: frame.payload,
    });
  } catch (error) {
    if (error instanceof FrameEncodeError) {
      throw new DeviceFrameEncodeError(error.message);
    }
    throw error;
  }
};

/** Parses a binary device-frame message without copying its payload. */
export const decodeDeviceFrame = (bytes: Uint8Array): DeviceFrameDecodeResult => {
  const result = decodeFrameEnvelope(DEVICE_FRAME_CODEC, bytes);
  if (!result.ok) {
    return { ok: false, reason: mapDecodeReason(result.reason) };
  }
  return {
    ok: true,
    frame: {
      header: {
        deviceId: result.frame.header.streamId,
        sequence: result.frame.header.sequence,
        timestampMs: result.frame.header.timestampMs,
        keyframe: result.frame.header.keyframe,
        codecConfig: result.frame.header.codecConfig,
      },
      payload: result.frame.payload,
    },
  };
};

function mapDecodeReason(
  reason:
    | "too-short"
    | "bad-magic"
    | "unsupported-version"
    | "truncated-stream-id"
    | "invalid-stream-id",
): DeviceFrameDecodeErrorReason {
  return reason === "truncated-stream-id"
    ? "truncated-device-id"
    : reason === "invalid-stream-id"
      ? "invalid-device-id"
      : reason;
}
