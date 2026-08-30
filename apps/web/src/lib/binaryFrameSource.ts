// FILE: binaryFrameSource.ts
// Purpose: Deliver encoded frames (device video, computer desktop captures) from
// the server to a pane's decoder over a dedicated binary WebSocket.
// Layer: Web transport helper
// Exports: the shared frame-source mechanism plus the URL builder; the
// device/computer modules wrap it with their route constants and decoders.

import { makeSocketUrl } from "../wsTransport";

export type FrameSourceResetReason = "closed" | "error" | "decode-failed";

/** The narrow slice of WebSocket the frame path uses, so tests need no DOM. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState?: number;
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly addEventListener: (
    type: "message" | "close" | "error" | "open",
    listener: (event: never) => void,
  ) => void;
}

interface BinaryFrameSourceOptions<Frame> {
  readonly streamId: string;
  readonly streamIdParam: string;
  readonly wsPath: string;
  readonly resyncMessage: string;
  readonly handlers: {
    readonly onFrame: (frame: Frame) => void;
    /**
     * The socket dropped. The pane resets its decoder because the next
     * connection starts a new stream generation with its own parameter sets.
     */
    readonly onReset: (reason: FrameSourceResetReason) => void;
  };
  /** Test seam; defaults to the browser's WebSocket against the resolved server URL. */
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly explicitUrl?: string | null;
  readonly decode: (
    bytes: Uint8Array,
  ) =>
    | { readonly ok: true; readonly frame: Frame }
    | { readonly ok: false; readonly reason: unknown };
  /** Test seam for the resync cooldown clock. */
  readonly now?: () => number;
  /**
   * Rebuilding a capture session is expensive (the device route tears down and
   * recreates a VideoToolbox encoder; the computer route re-primes compositor
   * capture), so a gate that fires on every dropped frame must not be allowed
   * to thrash it. One request is in flight at a time and further requests
   * inside this window are dropped rather than queued — the resync already in
   * flight will deliver the keyframe they wanted.
   */
  readonly resyncCooldownMs: number;
}

export interface BinaryFrameSource {
  /**
   * Ask the server for a fresh keyframe (and parameter sets, for codec streams)
   * after a gap or decode error. Debounced; returns true when the request
   * actually went out.
   */
  readonly requestResync: () => boolean;
  /** Idempotent; a source is single-use and cannot be restarted after close. */
  readonly close: () => void;
}

/**
 * Frames are lossy, high-rate, and useless the moment they are late, which is
 * the opposite of everything the Effect RPC feature socket carries. They ride a
 * dedicated binary WebSocket so a frame burst can never delay an RPC response or
 * a domain-event push, and so a slow consumer drops frames instead of stalling
 * the control plane. The subscription is the URL, so frames start with no
 * handshake message. It keys on the stream (device, computer) rather than the
 * thread: two threads watching one source share the same capture output.
 */
export function binaryFrameSocketUrl(input: {
  readonly streamId: string;
  readonly streamIdParam: string;
  readonly wsPath: string;
  readonly explicitUrl?: string | null;
}): string {
  const url = new URL(makeSocketUrl(input.explicitUrl ?? null, input.wsPath));
  url.searchParams.set(input.streamIdParam, input.streamId);
  return url.toString();
}

export function createBinaryFrameSource<Frame>(
  options: BinaryFrameSourceOptions<Frame>,
): BinaryFrameSource {
  const url = binaryFrameSocketUrl({
    streamId: options.streamId,
    streamIdParam: options.streamIdParam,
    wsPath: options.wsPath,
    ...(options.explicitUrl !== undefined ? { explicitUrl: options.explicitUrl } : {}),
  });
  const socket = (options.createSocket ?? defaultCreateSocket)(url);
  socket.binaryType = "arraybuffer";

  const now = options.now ?? (() => Date.now());
  let closed = false;
  let open = false;
  let lastResyncAt: number | null = null;
  // A gap can be detected before the socket finishes opening (the first frames
  // of a fresh connection). Remember the intent and send it on open rather than
  // dropping it, or the canvas waits for the server's next natural keyframe.
  let resyncPending = false;

  const reset = (reason: FrameSourceResetReason) => {
    if (closed) return;
    options.handlers.onReset(reason);
  };

  const sendResync = (): boolean => {
    if (closed) return false;
    try {
      socket.send(JSON.stringify({ type: options.resyncMessage }));
      return true;
    } catch {
      // A socket that dropped between the readyState check and the send; the
      // close handler already resets the decoder.
      return false;
    }
  };

  socket.addEventListener("open", (() => {
    open = true;
    if (!resyncPending) return;
    resyncPending = false;
    sendResync();
  }) as (event: never) => void);

  socket.addEventListener("message", ((event: { data: unknown }) => {
    if (closed) return;
    const bytes = frameBytes(event.data);
    // Text on this socket is a protocol violation, not a frame; ignoring it
    // keeps a stray server log line from tearing down a healthy stream.
    if (!bytes) return;

    const result = options.decode(bytes);
    if (!result.ok) {
      // A malformed envelope means the two sides disagree about the wire format.
      // Resetting the decoder is the only safe response; the payload after a bad
      // header cannot be trusted to be a valid frame.
      reset("decode-failed");
      return;
    }
    options.handlers.onFrame(result.frame);
  }) as (event: never) => void);

  socket.addEventListener("close", (() => reset("closed")) as (event: never) => void);
  socket.addEventListener("error", (() => reset("error")) as (event: never) => void);

  return {
    requestResync: () => {
      if (closed) return false;
      const at = now();
      if (lastResyncAt !== null && at - lastResyncAt < options.resyncCooldownMs) {
        return false;
      }
      lastResyncAt = at;
      if (!open) {
        resyncPending = true;
        return false;
      }
      return sendResync();
    },
    close: () => {
      if (closed) return;
      closed = true;
      resyncPending = false;
      try {
        socket.close();
      } catch {
        // Some browsers throw when closing a socket that never opened.
      }
    },
  };
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

function defaultCreateSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}
