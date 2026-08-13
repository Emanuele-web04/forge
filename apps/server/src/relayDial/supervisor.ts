import { RelayToHostControlMessage, type SpliceRequest } from "@synara/relay-protocol";
import { Schema } from "effect";
import WebSocket, { type RawData } from "ws";

export interface RelaySocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
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

function openSocket(socket: RelaySocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      socket.close();
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.on("open", () => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    socket.on("error", reject);
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
    // Reaching a live, ready control socket is what "healthy" means; the
    // caller resets backoff on this signal so a host stable for days does not
    // still carry a saturated cap from an old blip.
    this.#connected = true;
    await this.options.reverifySessions();
    control.send(JSON.stringify({ v: 1, type: "ready" }));
    control.on("message", (raw) => {
      void this.handleControlMessage(control, raw).catch(() => {
        control.close(1002, "invalid control message");
      });
    });
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
        await this.options.reverifySessions({ kind: event.kind, subject: event.subject });
      }
      return;
    }
    if ((this.options.nowMs?.() ?? Date.now()) >= message.expiresAtMs) return;
    const dials = this.#spliceDials;
    const data = this.#socketFactory(this.dataUrl(message.spliceId));
    try {
      await openSocket(data, dials.signal);
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
    await this.options.acceptSplice(data, message);
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
