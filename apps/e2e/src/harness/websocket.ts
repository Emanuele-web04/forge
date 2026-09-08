import type { Duplex } from "node:stream";

import WebSocket, { type RawData } from "ws";

export type ReceivedFrame = {
  readonly data: Buffer;
  readonly binary: boolean;
};

export type SocketClose = {
  readonly code: number;
  readonly reason: string;
};

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class WebSocketInbox {
  readonly #frames: ReceivedFrame[] = [];
  readonly #waiters: Array<{
    predicate: (frame: ReceivedFrame) => boolean;
    resolve: (frame: ReceivedFrame) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  #closed: SocketClose | undefined;
  readonly #closeWaiters: Array<(close: SocketClose) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, binary) => this.#receive({ data: rawBuffer(data), binary }));
    socket.on("close", (code, reason) => {
      this.#closed = { code, reason: reason.toString("utf8") };
      for (const resolve of this.#closeWaiters.splice(0)) resolve(this.#closed);
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(
          new Error(`WebSocket closed ${code} (${this.#closed.reason}) while waiting for a frame`),
        );
      }
    });
  }

  #receive(frame: ReceivedFrame): void {
    const index = this.#waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index < 0) {
      this.#frames.push(frame);
      return;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    waiter.resolve(frame);
  }

  next(
    predicate: (frame: ReceivedFrame) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<ReceivedFrame> {
    const index = this.#frames.findIndex(predicate);
    if (index >= 0) {
      const [frame] = this.#frames.splice(index, 1);
      if (frame) return Promise.resolve(frame);
    }
    if (this.#closed) {
      return Promise.reject(
        new Error(`WebSocket already closed ${this.#closed.code} (${this.#closed.reason})`),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const waiterIndex = this.#waiters.indexOf(waiter);
          if (waiterIndex >= 0) this.#waiters.splice(waiterIndex, 1);
          reject(
            new Error(
              `timed out waiting for WebSocket frame; closed=${JSON.stringify(this.#closed)} seen=${JSON.stringify(this.#frames?.slice?.(0, 3) ?? "n/a")}`,
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  nextJson(type?: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    return this.next((frame) => {
      try {
        const decoded = JSON.parse(frame.data.toString("utf8")) as Record<string, unknown>;
        return type === undefined || decoded.type === type;
      } catch {
        return false;
      }
    }, timeoutMs).then(
      (frame) => JSON.parse(frame.data.toString("utf8")) as Record<string, unknown>,
    );
  }

  waitForClose(timeoutMs = 10_000): Promise<SocketClose> {
    if (this.#closed) return Promise.resolve(this.#closed);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#closeWaiters.indexOf(onClose);
        if (index >= 0) this.#closeWaiters.splice(index, 1);
        reject(new Error("timed out waiting for WebSocket close"));
      }, timeoutMs);
      const onClose = (close: SocketClose) => {
        clearTimeout(timeout);
        resolve(close);
      };
      this.#closeWaiters.push(onClose);
    });
  }
}

export async function openWebSocket(url: string): Promise<{
  readonly socket: WebSocket;
  readonly inbox: WebSocketInbox;
}> {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  const inbox = new WebSocketInbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`WebSocket upgrade failed with HTTP ${response.statusCode}`));
    });
  });
  return { socket, inbox };
}

export function sendFrame(
  socket: WebSocket,
  data: string | Buffer,
  binary = Buffer.isBuffer(data),
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(data, { binary }, (error) => (error ? reject(error) : resolve()));
  });
}

type WebSocketWithTransport = WebSocket & { readonly _socket?: Duplex };

export function pauseSocketReads(socket: WebSocket): void {
  (socket as WebSocketWithTransport)._socket?.pause();
}

export function resumeSocketReads(socket: WebSocket): void {
  (socket as WebSocketWithTransport)._socket?.resume();
}
