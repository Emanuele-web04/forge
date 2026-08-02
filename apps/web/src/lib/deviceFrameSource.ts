// FILE: deviceFrameSource.ts
// Purpose: Deliver encoded device video frames from the server to a pane's decoder.
// Layer: Web transport helper
// Exports: DeviceFrameSource contract, the WebSocket-backed implementation, and the pane-facing factory
// Depends on: @synara/shared/deviceFrame for the binary envelope, wsTransport for URL resolution

import {
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
  decodeDeviceFrame,
  type DeviceFrame,
} from "@synara/shared/deviceFrame";
import type { DeviceUdid } from "@synara/contracts";

import { makeSocketUrl } from "../wsTransport";

export interface DeviceFrameSourceHandlers {
  readonly onFrame: (frame: DeviceFrame) => void;
  /**
   * The socket dropped. The pane resets its decoder because the next connection
   * starts a new stream generation with its own parameter sets.
   */
  readonly onReset: (reason: DeviceFrameSourceResetReason) => void;
}

export type DeviceFrameSourceResetReason = "closed" | "error" | "decode-failed";

export interface DeviceFrameSource {
  /** Idempotent; a source is single-use and cannot be restarted after close. */
  readonly close: () => void;
}

export interface DeviceFrameSourceOptions {
  readonly udid: DeviceUdid;
  readonly handlers: DeviceFrameSourceHandlers;
  /** Test seam; defaults to the browser's WebSocket against the resolved server URL. */
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly explicitUrl?: string | null;
}

/** The narrow slice of WebSocket the frame path uses, so tests need no DOM. */
export interface WebSocketLike {
  binaryType: string;
  readonly close: () => void;
  readonly addEventListener: (
    type: "message" | "close" | "error",
    listener: (event: never) => void,
  ) => void;
}

/**
 * Frames are lossy, high-rate, and useless the moment they are late, which is
 * the opposite of everything the Effect RPC feature socket carries. They ride a
 * dedicated binary WebSocket so a frame burst can never delay an RPC response or
 * a domain-event push, and so a slow consumer drops video instead of stalling
 * the control plane. The subscription is the URL, so frames start with no
 * handshake message. It keys on the device rather than the thread: two threads
 * watching one simulator share the same encoder output.
 */
export function deviceFrameSocketUrl(input: {
  readonly udid: DeviceUdid;
  readonly explicitUrl?: string | null;
}): string {
  const url = new URL(makeSocketUrl(input.explicitUrl ?? null, DEVICE_FRAME_WS_PATH));
  url.searchParams.set(DEVICE_FRAME_WS_UDID_PARAM, input.udid);
  return url.toString();
}

/**
 * Normalizes a binary WebSocket payload to bytes. Blob delivery is async and
 * would reorder frames against ArrayBuffer delivery, so the socket is pinned to
 * `arraybuffer` and a Blob here means a misconfigured socket rather than a
 * frame worth rescuing.
 */
function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function createDeviceFrameSource(options: DeviceFrameSourceOptions): DeviceFrameSource {
  const url = deviceFrameSocketUrl({
    udid: options.udid,
    ...(options.explicitUrl !== undefined ? { explicitUrl: options.explicitUrl } : {}),
  });
  const socket = (options.createSocket ?? defaultCreateSocket)(url);
  socket.binaryType = "arraybuffer";

  let closed = false;
  const reset = (reason: DeviceFrameSourceResetReason) => {
    if (closed) return;
    options.handlers.onReset(reason);
  };

  socket.addEventListener("message", ((event: { data: unknown }) => {
    if (closed) return;
    const bytes = frameBytes(event.data);
    // Text on this socket is a protocol violation, not a frame; ignoring it
    // keeps a stray server log line from tearing down a healthy stream.
    if (!bytes) return;

    const result = decodeDeviceFrame(bytes);
    if (!result.ok) {
      // A malformed envelope means the two sides disagree about the wire format.
      // Resetting the decoder is the only safe response; the payload after a bad
      // header cannot be trusted to be a valid access unit.
      reset("decode-failed");
      return;
    }
    options.handlers.onFrame(result.frame);
  }) as (event: never) => void);

  socket.addEventListener("close", (() => reset("closed")) as (event: never) => void);
  socket.addEventListener("error", (() => reset("error")) as (event: never) => void);

  return {
    close: () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        // A socket that never opened throws on close in some browsers; the
        // listener guard above already makes further callbacks inert.
      }
    },
  };
}

function defaultCreateSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}
