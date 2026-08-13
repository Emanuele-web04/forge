import type { Duplex } from "node:stream";
import WebSocket, { type RawData } from "ws";

import type { SpliceSocket } from "./splicePair";

type WebSocketWithTransport = WebSocket & { _socket?: Duplex };

function frameBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class WsSpliceSocket implements SpliceSocket {
  constructor(private readonly websocket: WebSocket) {
    // A transport error is followed by close; retaining a listener prevents a
    // malformed peer or reset connection from becoming an uncaught EventEmitter error.
    websocket.on("error", () => undefined);
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
    (this.websocket as WebSocketWithTransport)._socket?.pause();
  }

  resumeReads(): void {
    (this.websocket as WebSocketWithTransport)._socket?.resume();
  }

  onMessage(listener: (data: Buffer, binary: boolean) => void): () => void {
    const wrapped = (data: RawData, binary: boolean) => listener(frameBuffer(data), binary);
    this.websocket.on("message", wrapped);
    return () => this.websocket.off("message", wrapped);
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
