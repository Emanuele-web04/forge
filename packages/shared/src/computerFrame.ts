import { decodeFrameEnvelope, encodeFrameEnvelope, FrameEncodeError } from "./frameTransport";
import {
  COMPUTER_FRAME_MAGIC,
  COMPUTER_FRAME_MAX_COMPUTER_ID_BYTES,
  COMPUTER_FRAME_VERSION,
  type ComputerFrameDecodeErrorReason,
  type ComputerFrameHeader,
} from "@synara/contracts";

export const COMPUTER_FRAME_WS_PATH = "/ws/computer-frames";
export const COMPUTER_FRAME_WS_COMPUTER_ID_PARAM = "computerId";
export const COMPUTER_FRAME_RESYNC_MESSAGE = "computer.frame.resync";

export interface ComputerFrame {
  readonly header: ComputerFrameHeader;
  readonly payload: Uint8Array;
}

export type ComputerFrameDecodeResult =
  | { readonly ok: true; readonly frame: ComputerFrame }
  | { readonly ok: false; readonly reason: ComputerFrameDecodeErrorReason };

export class ComputerFrameEncodeError extends Error {}

const COMPUTER_FRAME_CODEC = {
  magic: COMPUTER_FRAME_MAGIC,
  version: COMPUTER_FRAME_VERSION,
  streamIdLabel: "computerId",
  frameLabel: "Computer",
  maxStreamIdBytes: COMPUTER_FRAME_MAX_COMPUTER_ID_BYTES,
} as const;

export const encodeComputerFrame = (frame: ComputerFrame): Uint8Array => {
  try {
    return encodeFrameEnvelope(COMPUTER_FRAME_CODEC, {
      header: {
        streamId: frame.header.computerId,
        sequence: frame.header.sequence,
        timestampMs: frame.header.timestampMs,
        keyframe: frame.header.keyframe,
        codecConfig: frame.header.codecConfig,
      },
      payload: frame.payload,
    });
  } catch (error) {
    if (error instanceof FrameEncodeError) {
      throw new ComputerFrameEncodeError(error.message);
    }
    throw error;
  }
};

export const decodeComputerFrame = (bytes: Uint8Array): ComputerFrameDecodeResult => {
  const result = decodeFrameEnvelope(COMPUTER_FRAME_CODEC, bytes);
  if (!result.ok) {
    return { ok: false, reason: mapDecodeReason(result.reason) };
  }
  return {
    ok: true,
    frame: {
      header: {
        computerId: result.frame.header.streamId,
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
): ComputerFrameDecodeErrorReason {
  return reason === "truncated-stream-id"
    ? "truncated-computer-id"
    : reason === "invalid-stream-id"
      ? "invalid-computer-id"
      : reason;
}
