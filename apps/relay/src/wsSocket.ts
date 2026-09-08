import type { Duplex } from "node:stream";
import WebSocket, { type RawData } from "ws";

import type { SpliceSocket } from "./splicePair";

type WebSocketWithTransport = WebSocket & { _socket?: Duplex };

/**
 * Cap on frames held while reads are paused and no listener exists. This is
 * the pre-pairing window only — a client's handshake frame or two — so the
 * bound is small on purpose: a peer that floods before it is spliced is
 * refused, not buffered.
 */
const MAX_HELD_BYTES = 64 * 1024;

function frameBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Adapts a `ws` WebSocket to the relay's SpliceSocket contract.
 *
 * Pausing is a real requirement, not an optimization: the relay must not read
 * a client's frames until its host has dialed back and the pair exists, or
 * the frames are delivered to nobody and silently lost — that is the mint
 * request, so the session hangs forever. `_socket.pause()` achieves this on
 * Node by stopping TCP reads. Under Bun the `ws` package is replaced by a
 * shim over Bun's native WebSocket that exposes NO `_socket`, so pause is a
 * no-op there and every frame that arrives before pairing is dropped — which
 * is what the deployed relay image runs on. So this adapter does not trust
 * the transport to pause: while paused and unlistened, frames are held here
 * (bounded) and replayed, in order, to the first listener.
 */
export class WsSpliceSocket implements SpliceSocket {
  readonly #listeners = new Set<(data: Buffer, binary: boolean) => void>();
  readonly #held: Array<{ data: Buffer; binary: boolean }> = [];
  #heldBytes = 0;
  #paused = false;

  constructor(private readonly websocket: WebSocket) {
    // A transport error is followed by close; retaining a listener prevents a
    // malformed peer or reset connection from becoming an uncaught EventEmitter error.
    websocket.on("error", () => undefined);
    websocket.on("message", (data: RawData, binary: boolean) =>
      this.#receive(frameBuffer(data), binary),
    );
  }

  #receive(data: Buffer, binary: boolean): void {
    if (this.#listeners.size > 0) {
      for (const listener of this.#listeners) listener(data, binary);
      return;
    }
    if (!this.#paused) return;
    if (this.#heldBytes + data.byteLength > MAX_HELD_BYTES) {
      this.close(1008, "relay peer sent too much before it was spliced");
      return;
    }
    this.#held.push({ data, binary });
    this.#heldBytes += data.byteLength;
  }

  get bufferedAmount(): number {
    return this.websocket.bufferedAmount;
  }

  send(data: Buffer, binary: boolean): void {
    if (this.websocket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
    this.websocket.send(data, { binary }, (error) => {
      if (error && this.websocket.readyState === WebSocket.OPEN) {
        this.websocket.close(1001, "relay send failed");
      }
    });
  }

  close(code: number, reason: string): void {
    if (
      this.websocket.readyState === WebSocket.OPEN ||
      this.websocket.readyState === WebSocket.CONNECTING
    ) {
      // A paused socket cannot complete the closing handshake: the peer's
      // close frame is never read, so `close` never fires on either side and
      // the connection lingers until TCP timeout. Reads are paused on every
      // client from admission until it is spliced, which is exactly when
      // refusals (bad grant, no host, splice timeout) are sent.
      this.resumeReads();
      this.websocket.close(code, reason);
    }
  }

  pauseReads(): void {
    this.#paused = true;
    (this.websocket as WebSocketWithTransport)._socket?.pause();
  }

  resumeReads(): void {
    this.#paused = false;
    (this.websocket as WebSocketWithTransport)._socket?.resume();
  }

  onMessage(listener: (data: Buffer, binary: boolean) => void): () => void {
    const first = this.#listeners.size === 0;
    this.#listeners.add(listener);
    if (first && this.#held.length > 0) {
      // Replay in arrival order before any newly read frame can overtake.
      const held = this.#held.splice(0);
      this.#heldBytes = 0;
      for (const frame of held) listener(frame.data, frame.binary);
    }
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    const wrapped = (code: number, reason: Buffer) => listener(code, reason.toString("utf8"));
    this.websocket.on("close", wrapped);
    return () => this.websocket.off("close", wrapped);
  }

  onDrain(listener: () => void): () => void {
    const socket = (this.websocket as WebSocketWithTransport)._socket;
    if (!socket) return () => undefined;
    socket.on("drain", listener);
    return () => socket.off("drain", listener);
  }
}
