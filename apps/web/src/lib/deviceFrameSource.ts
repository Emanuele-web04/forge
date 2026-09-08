// FILE: deviceFrameSource.ts
// Purpose: Deliver encoded device video frames from the server to a pane's decoder.
// Layer: Web transport helper
// Exports: DeviceFrameSource contract and the pane-facing factory, both thin
// wrappers over the shared binaryFrameSource mechanism.
// Depends on: @synara/shared/deviceFrame for the binary envelope

import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
  decodeDeviceFrame,
  type DeviceFrame,
} from "@synara/shared/deviceFrame";
import type { DeviceUdid } from "@synara/contracts";

import {
  binaryFrameSocketUrl,
  createBinaryFrameSource,
  type FrameSourceResetReason,
  type WebSocketLike,
} from "./binaryFrameSource";

export interface DeviceFrameSourceHandlers {
  readonly onFrame: (frame: DeviceFrame) => void;
  readonly onReset: (reason: DeviceFrameSourceResetReason) => void;
}

export type DeviceFrameSourceResetReason = FrameSourceResetReason;

/**
 * Rebuilding the capture session is expensive (it tears down and recreates the
 * VideoToolbox encoder), so resync requests are debounced to this window; see
 * `resyncCooldownMs` in binaryFrameSource for the mechanism.
 */
export const DEVICE_FRAME_RESYNC_COOLDOWN_MS = 1_000;

export interface DeviceFrameSource {
  readonly requestResync: () => boolean;
  readonly close: () => void;
}

export interface DeviceFrameSourceOptions {
  readonly udid: DeviceUdid;
  readonly handlers: DeviceFrameSourceHandlers;
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly explicitUrl?: string | null;
  readonly now?: () => number;
  readonly resyncCooldownMs?: number;
}

export type { WebSocketLike };

export function deviceFrameSocketUrl(input: {
  readonly udid: DeviceUdid;
  readonly explicitUrl?: string | null;
}): string {
  return binaryFrameSocketUrl({
    streamId: input.udid,
    streamIdParam: DEVICE_FRAME_WS_UDID_PARAM,
    wsPath: DEVICE_FRAME_WS_PATH,
    ...(input.explicitUrl !== undefined ? { explicitUrl: input.explicitUrl } : {}),
  });
}

export function createDeviceFrameSource(options: DeviceFrameSourceOptions): DeviceFrameSource {
  return createBinaryFrameSource({
    streamId: options.udid,
    streamIdParam: DEVICE_FRAME_WS_UDID_PARAM,
    wsPath: DEVICE_FRAME_WS_PATH,
    resyncMessage: DEVICE_FRAME_RESYNC_MESSAGE,
    handlers: options.handlers,
    decode: decodeDeviceFrame,
    ...(options.createSocket !== undefined ? { createSocket: options.createSocket } : {}),
    ...(options.explicitUrl !== undefined ? { explicitUrl: options.explicitUrl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    resyncCooldownMs: options.resyncCooldownMs ?? DEVICE_FRAME_RESYNC_COOLDOWN_MS,
  });
}
