import type { ComputerId } from "@synara/contracts";
import {
  COMPUTER_FRAME_RESYNC_MESSAGE,
  COMPUTER_FRAME_WS_COMPUTER_ID_PARAM,
  COMPUTER_FRAME_WS_PATH,
  decodeComputerFrame,
  type ComputerFrame,
} from "@synara/shared/computerFrame";

import {
  createBinaryFrameSource,
  type FrameSourceResetReason,
  type WebSocketLike,
} from "./binaryFrameSource";

export interface ComputerFrameSourceHandlers {
  readonly onFrame: (frame: ComputerFrame) => void;
  readonly onReset: (reason: ComputerFrameSourceResetReason) => void;
}

export type ComputerFrameSourceResetReason = FrameSourceResetReason;

export const COMPUTER_FRAME_RESYNC_COOLDOWN_MS = 1_000;

export interface ComputerFrameSource {
  readonly requestResync: () => boolean;
  readonly close: () => void;
}

export interface ComputerFrameSourceOptions {
  readonly computerId: ComputerId;
  readonly handlers: ComputerFrameSourceHandlers;
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly explicitUrl?: string | null;
  readonly now?: () => number;
  readonly resyncCooldownMs?: number;
}

export type { WebSocketLike };

export function createComputerFrameSource(
  options: ComputerFrameSourceOptions,
): ComputerFrameSource {
  return createBinaryFrameSource({
    streamId: options.computerId,
    streamIdParam: COMPUTER_FRAME_WS_COMPUTER_ID_PARAM,
    wsPath: COMPUTER_FRAME_WS_PATH,
    resyncMessage: COMPUTER_FRAME_RESYNC_MESSAGE,
    handlers: options.handlers,
    decode: decodeComputerFrame,
    ...(options.createSocket !== undefined ? { createSocket: options.createSocket } : {}),
    ...(options.explicitUrl !== undefined ? { explicitUrl: options.explicitUrl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    resyncCooldownMs: options.resyncCooldownMs ?? COMPUTER_FRAME_RESYNC_COOLDOWN_MS,
  });
}
