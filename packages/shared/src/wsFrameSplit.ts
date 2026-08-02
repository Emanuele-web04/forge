// FILE: wsFrameSplit.ts
// Purpose: Split a raw WebSocket byte stream into whole frames WITHOUT decoding
//          them, so a proxy can prioritise control frames while re-emitting
//          every byte exactly as it arrived.
// Layer: Shared runtime
// Exports: WsFrameSplitter, makeWsFrameSplitter, SplitWsFrame, WsFrameSplitError
//
// Why not just splice the two TCP sockets?
//
// Because a spliced stream has no frames, only bytes, and a 15-byte Pong queued
// behind a multi-megabyte snapshot arrives after the peer's heartbeat deadline.
// The peer then tears down a perfectly healthy connection and reconnects — the
// reconnect churn this design exists to avoid.
//
// Why not decode the frames?
//
// Because decoding is what breaks a byte-for-byte proxy. We read the HEADER
// only: opcode, mask bit, and length. The payload is never unmasked, never
// inflated, never re-encoded — `bytes` is the exact input slice, header
// included, so re-emitting it reproduces the original stream verbatim. That is
// also why permessage-deflate negotiates end to end: RSV1-compressed payloads
// pass through as opaque bytes and only the endpoints ever inflate them.

/** Opcodes 0x8-0xF are control frames (RFC 6455 §5.5). */
const CONTROL_OPCODE_FLOOR = 0x8;
/**
 * Close (RFC 6455 §5.5.1). Numerically equal to CONTROL_OPCODE_FLOOR, but that
 * is a coincidence of the opcode table, not a relationship: one is "the lowest
 * control opcode", the other is "the terminal frame". Named separately so
 * neither can be edited on the assumption it moves the other.
 */
const CLOSE_OPCODE = 0x8;
const LENGTH_16BIT_MARKER = 126;
const LENGTH_64BIT_MARKER = 127;
const MAX_CONTROL_PAYLOAD_BYTES = 125;

/**
 * What a relay is allowed to DO with a frame, which is not the same question as
 * what the frame IS.
 *
 * These three exist as named intents rather than an `isControl` boolean because
 * that boolean conflated two frames with opposite scheduling requirements:
 *
 *  - `expedited` — Ping and Pong. Idempotent and time-critical: a heartbeat
 *    stuck behind a multi-megabyte snapshot misses the peer's deadline and a
 *    healthy connection churns through a reconnect. Safe to reorder ahead of
 *    data precisely because losing ordering costs nothing.
 *  - `terminal` — Close. Once the peer sees it, it completes the closing
 *    handshake and stops processing, so ANY data still queued behind it is
 *    silently discarded. Must keep FIFO with respect to data.
 *  - `ordered` — everything else. The protocol's own ordering; never touched.
 *
 * `isControl` remains for the RFC payload cap, which genuinely means "is this
 * a control frame" — but it is deliberately no longer what scheduling reads.
 */
export type WsFrameRelayIntent = "expedited" | "terminal" | "ordered";

export interface SplitWsFrame {
  /** The complete frame, header and payload, byte-identical to the input. */
  readonly bytes: Uint8Array;
  readonly opcode: number;
  /** RFC 6455 control frame (opcode >= 0x8). Governs the payload cap, NOT priority. */
  readonly isControl: boolean;
  /**
   * How a relay may schedule this frame. Read this, never `isControl`, when
   * deciding queue priority — see the type's own comment for why.
   */
  readonly relayIntent: WsFrameRelayIntent;
}

function relayIntentOf(opcode: number, isControl: boolean): WsFrameRelayIntent {
  if (!isControl) return "ordered";
  return opcode === CLOSE_OPCODE ? "terminal" : "expedited";
}

export class WsFrameSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WsFrameSplitError";
  }
}

export interface WsFrameSplitterOptions {
  /**
   * Refuse any single frame larger than this. The proxy must not buffer an
   * unbounded frame while waiting for its tail: a peer that announces a 2^63
   * byte payload and then trickles it would otherwise pin memory for as long as
   * it likes. Callers pass the same ceiling their WS server enforces.
   */
  readonly maxFrameBytes: number;
}

/**
 * Incremental splitter. Feed it whatever the socket produced; it returns the
 * frames that are now complete and retains the partial tail.
 */
export class WsFrameSplitter {
  readonly #maxFrameBytes: number;
  #buffer: Uint8Array = new Uint8Array(0);

  constructor(options: WsFrameSplitterOptions) {
    this.#maxFrameBytes = options.maxFrameBytes;
  }

  /** Bytes held pending completion of the current frame. */
  get pendingBytes(): number {
    return this.#buffer.byteLength;
  }

  push(chunk: Uint8Array): readonly SplitWsFrame[] {
    this.#buffer = concat(this.#buffer, chunk);
    const frames: SplitWsFrame[] = [];
    for (;;) {
      const frame = this.#takeOne();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  #takeOne(): SplitWsFrame | undefined {
    const buffer = this.#buffer;
    if (buffer.byteLength < 2) return undefined;
    const opcode = buffer[0]! & 0x0f;
    const masked = (buffer[1]! & 0x80) !== 0;
    const lengthMarker = buffer[1]! & 0x7f;
    const isControl = opcode >= CONTROL_OPCODE_FLOOR;

    let headerLength = 2;
    let payloadLength: number;
    if (lengthMarker < LENGTH_16BIT_MARKER) {
      payloadLength = lengthMarker;
    } else if (lengthMarker === LENGTH_16BIT_MARKER) {
      if (buffer.byteLength < 4) return undefined;
      payloadLength = (buffer[2]! << 8) | buffer[3]!;
      headerLength = 4;
    } else {
      if (buffer.byteLength < 10) return undefined;
      // Read as BigInt: a 64-bit length does not fit a JS number safely, and
      // silently truncating one would desynchronise the frame boundaries — the
      // proxy would then re-emit garbage that both endpoints try to parse.
      const view = new DataView(buffer.buffer, buffer.byteOffset + 2, 8);
      const wide = view.getBigUint64(0);
      if (wide > BigInt(this.#maxFrameBytes)) {
        throw new WsFrameSplitError(
          `WebSocket frame of ${wide} bytes exceeds the ${this.#maxFrameBytes} byte proxy limit.`,
        );
      }
      payloadLength = Number(wide);
      headerLength = 10;
    }
    if (masked) headerLength += 4;

    if (isControl && payloadLength > MAX_CONTROL_PAYLOAD_BYTES) {
      // A "control frame" with a data-sized payload is a protocol violation and
      // also the shape that would let control-priority traffic bypass the
      // head-of-line protection by carrying megabytes at the front of the queue.
      throw new WsFrameSplitError(
        `Control frame opcode 0x${opcode.toString(16)} carries ${payloadLength} bytes; the maximum is ${MAX_CONTROL_PAYLOAD_BYTES}.`,
      );
    }
    const totalLength = headerLength + payloadLength;
    if (totalLength > this.#maxFrameBytes) {
      throw new WsFrameSplitError(
        `WebSocket frame of ${totalLength} bytes exceeds the ${this.#maxFrameBytes} byte proxy limit.`,
      );
    }
    if (buffer.byteLength < totalLength) return undefined;

    // COPY, explicitly. `buffer.slice` is NOT enough: Node's Buffer overrides
    // `slice` with `subarray` semantics, so on a Buffer input it returns a view
    // that keeps the whole underlying ArrayBuffer alive and mutates when the
    // source chunk does. A 5-byte frame carved out of a 64 KiB socket read
    // would then report 5 bytes to the bounded queue while retaining 65536,
    // letting true memory use overshoot the ceiling by orders of magnitude
    // before it ever fires — and the emitted frame's bytes would still change
    // if the source buffer were reused. `Uint8Array.prototype.slice` is the
    // copying one regardless of the subclass.
    const bytes = copyOf(buffer, 0, totalLength);
    this.#buffer = copyOf(buffer, totalLength, buffer.byteLength);
    return { bytes, opcode, isControl, relayIntent: relayIntentOf(opcode, isControl) };
  }
}

/** A real copy, even when `input` is a Node Buffer (whose `slice` aliases). */
function copyOf(input: Uint8Array, start: number, end: number): Uint8Array {
  return Uint8Array.prototype.slice.call(input, start, end);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  // Same reason as `copyOf` above: `right.slice()` on a Buffer returns a view
  // over the socket's read buffer, and the retained tail must never alias
  // memory the caller may reuse.
  if (left.byteLength === 0) return copyOf(right, 0, right.byteLength);
  if (right.byteLength === 0) return left;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

export function makeWsFrameSplitter(options: WsFrameSplitterOptions): WsFrameSplitter {
  return new WsFrameSplitter(options);
}
