import {
  GrantResponse,
  RegisterDeviceResponse,
  type AccountDevice,
  type AccountDevicePlatform,
} from "@synara/contracts";
import {
  deviceThumbprint,
  exportPublicJwk,
  generateDeviceKey,
  signDeviceRegistration,
  signDpopProof,
  signMintRequest,
} from "@synara/shared/deviceKey";
import {
  raceTransports,
  type TransportCandidate,
  type TransportKind,
} from "@synara/shared/transportRace";
import { Schema } from "effect";
import WebSocket from "ws";

import {
  openWebSocket,
  pauseSocketReads,
  resumeSocketReads,
  sendFrame,
  type SocketClose,
  type WebSocketInbox,
} from "./harness/websocket";

export class HeadlessClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HeadlessClientError";
  }
}

export type HeadlessClientSession = AsyncDisposable & {
  readonly socket: WebSocket;
  readonly transport: TransportKind;
  readonly credential: string;
  readonly minted: boolean;
  echo(input: { sequence: number; payload: string; binary?: boolean }): Promise<{
    sequence: number;
    payload: string;
    binary: boolean;
  }>;
  echoBurst(
    payloads: readonly string[],
    options?: { readonly slowReader?: boolean },
  ): Promise<readonly { sequence: number; payload: string }[]>;
  waitForClose(timeoutMs?: number): Promise<SocketClose>;
};

type ClientIdentity = {
  readonly key: CryptoKeyPair;
  readonly publicJwk: Awaited<ReturnType<typeof exportPublicJwk>>;
  readonly jkt: string;
};

function httpUrlForProbe(candidate: TransportCandidate): string {
  const url = new URL(candidate.url);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function decodeFailure(response: Response): Promise<never> {
  const body: unknown = await response.json().catch(() => null);
  const message =
    body && typeof body === "object" && "message" in body && typeof body.message === "string"
      ? body.message
      : `request failed with HTTP ${response.status}`;
  throw new HeadlessClientError(message, response.status, body);
}

function websocketSessionUrl(candidate: TransportCandidate, grant?: string): string {
  const url = new URL(candidate.url);
  if (candidate.kind === "relay") {
    url.pathname = "/client/session";
    url.search = new URLSearchParams({ grant: grant ?? "" }).toString();
  }
  return url.toString();
}

type RpcSuccess = {
  readonly requestId: string;
  readonly value: { readonly sequence: number; readonly payload: string };
};

function decodeRpcSuccess(frame: Buffer): RpcSuccess | undefined {
  let value: unknown;
  try {
    value = JSON.parse(frame.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const envelope = value as Record<string, unknown>;
  if (envelope._tag !== "Exit" || typeof envelope.requestId !== "string") return undefined;
  const exit = envelope.exit;
  if (!exit || typeof exit !== "object" || (exit as Record<string, unknown>)._tag !== "Success") {
    throw new Error(`RPC ${envelope.requestId} failed: ${frame.toString("utf8")}`);
  }
  const result = (exit as Record<string, unknown>).value;
  if (!result || typeof result !== "object") {
    throw new Error(`RPC ${envelope.requestId} returned no value`);
  }
  const record = result as Record<string, unknown>;
  if (typeof record.sequence !== "number" || typeof record.payload !== "string") {
    throw new Error(`RPC ${envelope.requestId} returned a malformed echo`);
  }
  return {
    requestId: envelope.requestId,
    value: { sequence: record.sequence, payload: record.payload },
  };
}

function rpcExit(frame: Buffer, requestId: string): RpcSuccess["value"] | undefined {
  const success = decodeRpcSuccess(frame);
  return success?.requestId === requestId ? success.value : undefined;
}

/** Effect RPC request IDs are bigint values encoded as decimal strings. */
export function makeRpcRequestIdGenerator(): () => string {
  let nextRequestId = 0n;
  return () => String(nextRequestId++);
}

function makeSession(input: {
  socket: WebSocket;
  inbox: WebSocketInbox;
  transport: TransportKind;
  credential: string;
  minted: boolean;
  onClose: () => void;
}): HeadlessClientSession {
  let disposed = false;
  const nextRequestId = makeRpcRequestIdGenerator();
  const echo = async (request: { sequence: number; payload: string; binary?: boolean }) => {
    const requestId = nextRequestId();
    const frame = JSON.stringify({
      _tag: "Request",
      id: requestId,
      tag: "e2e.echo",
      payload: { sequence: request.sequence, payload: request.payload },
      headers: [],
    });
    const response = input.inbox.next(
      (candidate) => rpcExit(candidate.data, requestId) !== undefined,
    );
    await sendFrame(input.socket, request.binary ? Buffer.from(frame) : frame, request.binary);
    const received = await response;
    const value = rpcExit(received.data, requestId);
    if (!value) throw new Error(`RPC ${requestId} response disappeared`);
    return { ...value, binary: received.binary };
  };
  return {
    socket: input.socket,
    transport: input.transport,
    credential: input.credential,
    minted: input.minted,
    echo,
    async echoBurst(payloads, options = {}) {
      if (options.slowReader) pauseSocketReads(input.socket);
      const requestIds = new Set<string>();
      const sends = payloads.map((payload, sequence) => {
        const requestId = nextRequestId();
        requestIds.add(requestId);
        const frame = JSON.stringify({
          _tag: "Request",
          id: requestId,
          tag: "e2e.echo",
          payload: { sequence, payload },
          headers: [],
        });
        return sendFrame(input.socket, Buffer.from(frame), true);
      });
      await Promise.all(sends);
      if (options.slowReader) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        resumeSocketReads(input.socket);
      }
      const replies: Array<{ sequence: number; payload: string }> = [];
      while (requestIds.size > 0) {
        const received = await input.inbox.next((candidate) => {
          const success = decodeRpcSuccess(candidate.data);
          return success !== undefined && requestIds.has(success.requestId);
        });
        const success = decodeRpcSuccess(received.data);
        if (!success || !requestIds.delete(success.requestId)) {
          throw new Error("matched RPC burst response disappeared");
        }
        replies.push(success.value);
      }
      return replies;
    },
    waitForClose(timeoutMs) {
      return input.inbox.waitForClose(timeoutMs);
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      input.onClose();
      if (input.socket.readyState === WebSocket.OPEN) input.socket.close(1000, "test complete");
      else if (input.socket.readyState === WebSocket.CONNECTING) input.socket.terminate();
    },
  };
}

export class HeadlessClient implements AsyncDisposable {
  readonly #sockets = new Set<WebSocket>();
  #identity: ClientIdentity | undefined;
  #device: AccountDevice | undefined;

  constructor(
    readonly options: {
      readonly apiOrigin: string;
      readonly userId: string;
      readonly accessToken: string;
      readonly displayName?: string;
      readonly platform?: AccountDevicePlatform;
    },
  ) {}

  get device() {
    return this.#device;
  }

  async #getIdentity(): Promise<ClientIdentity> {
    if (this.#identity) return this.#identity;
    const key = await generateDeviceKey();
    const publicJwk = await exportPublicJwk(key);
    this.#identity = { key, publicJwk, jkt: await deviceThumbprint(publicJwk) };
    return this.#identity;
  }

  async register(): Promise<AccountDevice> {
    const identity = await this.#getIdentity();
    const proof = await signDeviceRegistration({
      key: identity.key,
      publicJwk: identity.publicJwk,
      userId: this.options.userId,
      displayName: this.options.displayName ?? "E2E device",
      platform: this.options.platform ?? "linux",
      audience: `${this.options.apiOrigin}/api/v1`,
    });
    let response: Response;
    try {
      response = await fetch(`${this.options.apiOrigin}/api/v1/devices`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ proof }),
      });
    } catch (cause) {
      throw new HeadlessClientError(
        "device registration could not reach the account API",
        undefined,
        undefined,
        { cause },
      );
    }
    if (!response.ok) return decodeFailure(response);
    const decoded = Schema.decodeUnknownSync(RegisterDeviceResponse)(await response.json());
    this.#device = decoded.device;
    return decoded.device;
  }

  async requestGrant(hostId: string): Promise<string> {
    const device = this.#device ?? (await this.register());
    let response: Response;
    try {
      response = await fetch(
        `${this.options.apiOrigin}/api/v1/hosts/${encodeURIComponent(hostId)}/grant`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ deviceJkt: device.jkt }),
        },
      );
    } catch (cause) {
      throw new HeadlessClientError(
        "grant request could not reach the account API",
        undefined,
        undefined,
        { cause },
      );
    }
    if (!response.ok) return decodeFailure(response);
    return Schema.decodeUnknownSync(GrantResponse)(await response.json()).grant;
  }

  async selectTransport(candidates: readonly TransportCandidate[]): Promise<TransportCandidate> {
    const result = await raceTransports(
      candidates,
      async (candidate, signal) => {
        try {
          await fetch(httpUrlForProbe(candidate), { signal });
          return true;
        } catch {
          return false;
        }
      },
      { probeTimeoutMs: 1_000, deadlineMs: 2_000 },
    );
    if (result.outcome !== "reachable") {
      throw new HeadlessClientError(`no host transport was reachable (${result.outcome})`);
    }
    return result.candidate;
  }

  async openRelay(grant: string, relayOrigin: string) {
    const candidate = { kind: "relay" as const, url: relayOrigin };
    const opened = await openWebSocket(websocketSessionUrl(candidate, grant));
    this.#sockets.add(opened.socket);
    opened.socket.once("close", () => this.#sockets.delete(opened.socket));
    return opened;
  }

  async connectWithGrant(input: {
    readonly candidates: readonly TransportCandidate[];
    readonly environmentId: string;
    readonly grant: string;
  }): Promise<HeadlessClientSession> {
    const candidate = await this.selectTransport(input.candidates);
    const opened =
      candidate.kind === "relay"
        ? await this.openRelay(input.grant, candidate.url)
        : await openWebSocket(websocketSessionUrl(candidate));
    this.#sockets.add(opened.socket);
    const identity = await this.#getIdentity();
    const mintRequest = await signMintRequest({
      key: identity.key,
      publicJwk: identity.publicJwk,
      userId: this.options.userId,
      grant: input.grant,
      environmentId: input.environmentId,
    });
    await sendFrame(
      opened.socket,
      JSON.stringify({ v: 1, type: "mint_request", request: mintRequest }),
      false,
    );
    const minted = await opened.inbox.nextJson("session_credential");
    if (typeof minted.credential !== "string") throw new Error("host returned no credential");
    await this.#authorize(opened.socket, opened.inbox, identity, minted.credential);
    return makeSession({
      ...opened,
      transport: candidate.kind,
      credential: minted.credential,
      minted: true,
      onClose: () => this.#sockets.delete(opened.socket),
    });
  }

  async connectWithCredential(input: {
    readonly candidates: readonly TransportCandidate[];
    readonly credential: string;
  }): Promise<HeadlessClientSession> {
    const candidate = await this.selectTransport(input.candidates);
    const opened = await openWebSocket(websocketSessionUrl(candidate));
    this.#sockets.add(opened.socket);
    await this.#authorize(opened.socket, opened.inbox, await this.#getIdentity(), input.credential);
    return makeSession({
      ...opened,
      transport: candidate.kind,
      credential: input.credential,
      minted: false,
      onClose: () => this.#sockets.delete(opened.socket),
    });
  }

  async #authorize(
    socket: WebSocket,
    inbox: WebSocketInbox,
    identity: ClientIdentity,
    credential: string,
  ): Promise<void> {
    const dpop = await signDpopProof({
      key: identity.key,
      publicJwk: identity.publicJwk,
      method: "CONNECT",
      url: "synara://remote/session",
      accessToken: credential,
    });
    await sendFrame(
      socket,
      JSON.stringify({ v: 1, type: "session_authorize", credential, dpop }),
      false,
    );
    await inbox.nextJson("session_ready");
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const socket of this.#sockets) socket.terminate();
    this.#sockets.clear();
  }
}
