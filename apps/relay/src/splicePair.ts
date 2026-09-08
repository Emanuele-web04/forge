import { RELAY_CLOSE_OVERLOADED } from "@synara/relay-protocol";

export interface SpliceSocket {
  readonly bufferedAmount: number;
  send(data: Buffer, binary: boolean): void;
  close(code: number, reason: string): void;
  pauseReads(): void;
  resumeReads(): void;
  onMessage(listener: (data: Buffer, binary: boolean) => void): () => void;
  onClose(listener: (code: number, reason: string) => void): () => void;
  onDrain(listener: () => void): () => void;
}

export type SplicePair = {
  readonly id: string;
  readonly hostId: string;
  close(code: number, reason?: string): void;
};

export type CreateSplicePairOptions = {
  id: string;
  hostId: string;
  client: SpliceSocket;
  host: SpliceSocket;
  highWaterBytes: number;
  stallTimeoutMs?: number;
  backpressurePollMs?: number;
  onClosed: () => void;
};

type Flow = {
  source: SpliceSocket;
  target: SpliceSocket;
  paused: boolean;
  /**
   * Frames that arrived after reads were paused. Pausing the TCP socket does
   * NOT stop `ws` from emitting the frames already parsed out of the chunk it
   * has in hand, so without this queue those frames would be dropped —
   * silently punching a hole in a tunneled protocol that both peers believe
   * was delivered intact. Bounded: past the cap the pair is closed rather
   * than buffering without limit.
   */
  queue: Array<{ data: Buffer; binary: boolean }>;
  queuedBytes: number;
  pollTimer: ReturnType<typeof setInterval> | undefined;
  stallTimer: ReturnType<typeof setTimeout> | undefined;
};

function clearFlow(flow: Flow): void {
  if (flow.pollTimer) clearInterval(flow.pollTimer);
  if (flow.stallTimer) clearTimeout(flow.stallTimer);
  flow.pollTimer = undefined;
  flow.stallTimer = undefined;
  if (flow.paused) flow.source.resumeReads();
  flow.paused = false;
  flow.queue.length = 0;
  flow.queuedBytes = 0;
}

function isValidClientCloseCode(code: number): boolean {
  return (
    code === 1000 ||
    code === 1001 ||
    code === 1002 ||
    code === 1003 ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}

export function createSplicePair(options: CreateSplicePairOptions): SplicePair {
  const stallTimeoutMs = options.stallTimeoutMs ?? 30_000;
  const backpressurePollMs = options.backpressurePollMs ?? 25;
  const resumeWaterBytes = options.highWaterBytes / 2;
  // Cap on frames already parsed by the receiver when reads were paused. This
  // is a spillover buffer, not a send queue: it only ever holds what the
  // socket had in flight, so a small multiple of the high-water mark is
  // ample, and exceeding it means the peer is hopeless — close, don't grow.
  const maxQueuedBytes = options.highWaterBytes * 2;
  let closed = false;
  const cleanups: Array<() => void> = [];

  const clientToHost: Flow = {
    source: options.client,
    target: options.host,
    paused: false,
    queue: [],
    queuedBytes: 0,
    pollTimer: undefined,
    stallTimer: undefined,
  };
  const hostToClient: Flow = {
    source: options.host,
    target: options.client,
    paused: false,
    queue: [],
    queuedBytes: 0,
    pollTimer: undefined,
    stallTimer: undefined,
  };
  const flows = [clientToHost, hostToClient];

  function finish(): void {
    if (closed) return;
    closed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const flow of flows) clearFlow(flow);
    options.onClosed();
  }

  function closeBoth(code: number, reason: string): void {
    if (closed) return;
    finish();
    options.client.close(code, reason);
    options.host.close(code, reason);
  }

  function maybeResume(flow: Flow): void {
    if (!flow.paused || closed || flow.target.bufferedAmount > resumeWaterBytes) return;
    // Drain in arrival order BEFORE resuming reads, so queued frames can
    // never be overtaken by newly read ones.
    while (flow.queue.length > 0) {
      const frame = flow.queue.shift();
      if (!frame) break;
      flow.queuedBytes -= frame.data.byteLength;
      try {
        flow.target.send(frame.data, frame.binary);
      } catch {
        closeBoth(1001, "relay forwarding failed");
        return;
      }
      if (flow.target.bufferedAmount > options.highWaterBytes) return;
    }
    clearFlow(flow);
  }

  function applyBackpressure(flow: Flow): void {
    if (flow.paused || closed || flow.target.bufferedAmount <= options.highWaterBytes) return;
    flow.paused = true;
    flow.source.pauseReads();
    flow.pollTimer = setInterval(() => maybeResume(flow), backpressurePollMs);
    flow.pollTimer.unref?.();
    flow.stallTimer = setTimeout(() => {
      if (flow.paused) {
        closeBoth(RELAY_CLOSE_OVERLOADED, "relay peer remained backpressured");
      }
    }, stallTimeoutMs);
    flow.stallTimer.unref?.();
  }

  function forward(flow: Flow, data: Buffer, binary: boolean): void {
    if (closed) return;
    if (flow.paused) {
      // Frames the receiver had already parsed when we paused the socket.
      // Queue them; dropping would corrupt the tunneled stream invisibly.
      if (flow.queuedBytes + data.byteLength > maxQueuedBytes) {
        closeBoth(RELAY_CLOSE_OVERLOADED, "relay peer fell too far behind");
        return;
      }
      flow.queue.push({ data, binary });
      flow.queuedBytes += data.byteLength;
      return;
    }
    try {
      flow.target.send(data, binary);
      applyBackpressure(flow);
    } catch {
      closeBoth(1001, "relay forwarding failed");
    }
  }

  function propagateClose(peer: SpliceSocket, code: number, reason: string): void {
    if (closed) return;
    finish();
    peer.close(isValidClientCloseCode(code) ? code : 1001, reason);
  }

  cleanups.push(
    options.client.onMessage((data, binary) => forward(clientToHost, data, binary)),
    options.host.onMessage((data, binary) => forward(hostToClient, data, binary)),
    options.client.onClose((code, reason) => propagateClose(options.host, code, reason)),
    options.host.onClose((code, reason) => propagateClose(options.client, code, reason)),
    options.host.onDrain(() => maybeResume(clientToHost)),
    options.client.onDrain(() => maybeResume(hostToClient)),
  );

  return {
    id: options.id,
    hostId: options.hostId,
    close(code, reason = "") {
      closeBoth(code, reason);
    },
  };
}
