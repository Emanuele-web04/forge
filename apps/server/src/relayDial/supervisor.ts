import { RelayToHostControlMessage, type SpliceRequest } from "@synara/relay-protocol";
import { Schema } from "effect";
import WebSocket, { type RawData } from "ws";

export interface RelaySocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData, binary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeAllListeners(event?: "open" | "message" | "close" | "error"): this;
}

export type RelaySocketFactory = (url: string) => RelaySocket;

export interface RelayDialSupervisorOptions {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly requestTicket: () => Promise<string>;
  readonly reverifySessions: (event?: {
    readonly kind: "discoverability_off" | "org_departure" | "device_revoked" | "host_unlinked";
    readonly subject: string | null;
  }) => Promise<void>;
  readonly acceptSplice: (socket: RelaySocket, request: SpliceRequest) => Promise<void>;
  readonly socketFactory?: RelaySocketFactory;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly nowMs?: () => number;
  /** Observability hook: session reverification failed but the socket lives. */
  readonly onReverifyFailed?: (error: unknown) => void;
  readonly baseBackoffMs?: number;
  readonly maximumBackoffMs?: number;
}

function websocketBase(relayUrl: string): URL {
  const url = new URL(relayUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported relay protocol ${url.protocol}`);
  }
  return url;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

function openSocket(
  socket: RelaySocket,
  signal: AbortSignal,
  onOpen?: () => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.on("open", () => {
      if (settled) return;
      signal.removeEventListener("abort", abort);
      try {
        const opened = onOpen?.();
        Promise.resolve(opened).then(() => {
          if (settled) return;
          settled = true;
          resolve();
        }, fail);
      } catch (error) {
        fail(error);
      }
    });
    socket.on("error", fail);
  });
}

function socketLifetime(socket: RelaySocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => socket.close();
    signal.addEventListener("abort", abort, { once: true });
    socket.on("close", () => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    socket.on("error", reject);
  });
}

export class RelayDialSupervisor {
  readonly #socketFactory: RelaySocketFactory;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** True once a control socket opened, so backoff resets only on real health. */
  #connected = false;
  /** Aborts splice dials in flight when their control socket goes away. */
  #spliceDials = new AbortController();

  constructor(readonly options: RelayDialSupervisorOptions) {
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.#sleep = options.sleep ?? defaultSleep;
  }

  private controlUrl(ticket: string): string {
    const url = websocketBase(this.options.relayUrl);
    url.pathname = "/host/control";
    url.search = new URLSearchParams({ ticket }).toString();
    return url.toString();
  }

  private dataUrl(spliceId: string): string {
    const url = websocketBase(this.options.relayUrl);
    url.pathname = "/host/data";
    url.search = new URLSearchParams({ splice: spliceId }).toString();
    return url.toString();
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    const ticket = await this.options.requestTicket();
    if (signal.aborted) return;
    const control = this.#socketFactory(this.controlUrl(ticket));
    await openSocket(control, signal);
    // Attach BEFORE any await. The relay adds a host to its delivery map the
    // moment its ticket verifies — readiness is not a gate on revocation — so
    // frames can arrive during the reverify round trip below, and `ws` drops
    // frames nobody is listening for. A dropped frame here is a revocation
    // that silently never happens.
    control.on("message", (raw) => {
      void this.handleControlMessage(control, raw).catch(() => {
        control.close(1002, "invalid control message");
      });
    });
    try {
      // Best-effort: reverification needs the account API, which needs the
      // identity provider. Letting it throw here would abandon a control
      // socket that is otherwise fine — and because it throws AFTER the
      // connection is established, every attempt would look healthy, reset
      // the backoff, and turn a provider outage into a fleet-wide dial storm.
      await this.options.reverifySessions();
    } catch (error) {
      this.options.onReverifyFailed?.(error);
    }
    // Only now is the connection genuinely healthy: socket open and the
    // supervisor committed to running it. Backoff resets on this signal.
    this.#connected = true;
    control.send(JSON.stringify({ v: 1, type: "ready" }));
    try {
      await socketLifetime(control, signal);
    } finally {
      // Splices signaled on a socket that is going away must not land after
      // teardown: the in-flight dial is aborted and the handler detached.
      control.removeAllListeners("message");
      this.#spliceDials.abort();
      this.#spliceDials = new AbortController();
    }
  }

  private async handleControlMessage(control: RelaySocket, raw: RawData): Promise<void> {
    const message = Schema.decodeUnknownSync(RelayToHostControlMessage)(JSON.parse(raw.toString()));
    if (message.type === "ping") {
      control.send(JSON.stringify({ v: 1, type: "pong" }));
      return;
    }
    if (message.type === "revocation") {
      for (const event of message.events) {
        if (event.hostId !== this.options.hostId) continue;
        try {
          await this.options.reverifySessions({ kind: event.kind, subject: event.subject });
        } catch (error) {
          // The frame was valid; only the cloud refresh behind reverification
          // failed. Keep the splice-signalling socket alive and report the
          // transient failure instead of misclassifying it as protocol error.
          this.options.onReverifyFailed?.(error);
        }
      }
      return;
    }
    if ((this.options.nowMs?.() ?? Date.now()) >= message.expiresAtMs) return;
    const dials = this.#spliceDials;
    const data = this.#socketFactory(this.dataUrl(message.spliceId));
    try {
      await openSocket(data, dials.signal, () => {
        // `ws` can deliver the first data frame immediately after its `open`
        // listeners return. Admit synchronously from that event so the
        // gateway's message listener exists before the peer can speak.
        if (dials.signal.aborted) {
          data.close(1001, "control socket closed during splice dial");
          return;
        }
        return this.options.acceptSplice(data, message);
      });
    } catch (error) {
      data.close(1001, "splice dial aborted");
      throw error;
    }
    // The control socket may have died while the data socket was opening.
    // Accepting now would create a remote session nothing is supervising.
    if (dials.signal.aborted) {
      data.close(1001, "control socket closed during splice dial");
      return;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      this.#connected = false;
      try {
        await this.connectOnce(signal);
      } catch {
        // fall through to backoff
      }
      // A connection that came up healthy clears the backoff. Counting it as
      // a failure (as before) meant the cap only ever ratcheted upward, so a
      // long-lived host turned a single blip into a multi-second outage.
      failures = this.#connected ? 0 : failures + 1;
      if (signal.aborted) break;
      const cap = Math.min(
        this.options.maximumBackoffMs ?? 30_000,
        (this.options.baseBackoffMs ?? 500) * 2 ** Math.min(failures, 16),
      );
      const delay = Math.floor((this.options.random?.() ?? Math.random()) * cap);
      try {
        await this.#sleep(delay, signal);
      } catch {
        break;
      }
    }
  }
}
