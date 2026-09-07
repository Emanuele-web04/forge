// FILE: dialer.ts
// Purpose: The outbound half of a host session — what a client does to reach
//          another host. Picks a transport (ADR 0007), presents the grant,
//          mints the session credential (ADR 0011), and DPoP-authorizes.
// Layer: server host connections
//
// This is the same handshake `apps/e2e`'s headless client speaks, moved into
// the shell that actually owns the device key. The renderer never sees a
// grant, a credential, or a DPoP proof: it is handed a local socket that is
// already on the far side of all of that.

import type { AccountHost, Es256PublicKeyJwk } from "@synara/contracts";
import { signDpopProof, signMintRequest, type DeviceSigningKey } from "@synara/shared/deviceKey";
import {
  raceTransports,
  type TransportCandidate,
  type TransportKind,
  type TransportRaceResult,
} from "@synara/shared/transportRace";
import { decodeJwt } from "jose";
import WebSocket, { type RawData } from "ws";

/** The DPoP `htu` every host expects on session_authorize (gateway.ts). */
const SESSION_PRESENTATION_HTU = "synara://remote/session";
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface DialIdentity {
  readonly userId: string;
  readonly key: DeviceSigningKey;
  readonly publicJwk: Es256PublicKeyJwk;
}

export interface DialInput {
  readonly host: Pick<AccountHost, "id" | "environmentId" | "endpoints">;
  readonly identity: DialIdentity;
  /** Relay root URL (http(s) or ws(s)); omitted when no relay is configured. */
  readonly relayUrl?: string | undefined;
  readonly requestGrant: () => Promise<string>;
  /** Injectable for tests; production opens a real `ws` socket. */
  readonly openSocket?: (url: string) => WebSocket;
  readonly probe?: (candidate: TransportCandidate, signal: AbortSignal) => Promise<boolean>;
}

export interface DialedSession {
  readonly socket: WebSocket;
  readonly transport: TransportKind;
  readonly credential: string;
  readonly credentialExpiresAtSeconds: number;
  readonly race: TransportRaceResult;
}

export class HostDialError extends Error {
  constructor(
    message: string,
    readonly detail: {
      readonly stage: "no-route" | "unreachable" | "grant" | "handshake";
      readonly race?: TransportRaceResult;
      readonly closeCode?: number;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostDialError";
  }
}

function toWebSocketUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol === "http:") parsed.protocol = "ws:";
  return parsed;
}

/** The host's own `/ws/host` on a direct transport, or the relay's client path. */
function sessionUrl(candidate: TransportCandidate, grant: string): string {
  const url = toWebSocketUrl(candidate.url);
  if (candidate.kind === "relay") {
    url.pathname = "/client/session";
    url.search = new URLSearchParams({ grant }).toString();
  } else {
    url.pathname = "/ws/host";
    url.search = "";
  }
  url.hash = "";
  return url.toString();
}

/**
 * Liveness probe per candidate. Direct endpoints answer `/health`; the relay
 * answers `/healthz/host/:id`, which says whether THIS host's control socket
 * is registered — the aggregate `/healthz` only proves the relay is up.
 */
function defaultProbe(hostId: string) {
  return async (candidate: TransportCandidate, signal: AbortSignal): Promise<boolean> => {
    const url = new URL(candidate.url);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    url.search = "";
    url.hash = "";
    if (candidate.kind === "relay") {
      url.pathname = `/healthz/host/${encodeURIComponent(hostId)}`;
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) return false;
        const body = (await response.json()) as { ready?: boolean };
        return body.ready === true;
      } catch {
        return false;
      }
    }
    url.pathname = "/health";
    try {
      return (await fetch(url, { signal })).ok;
    } catch {
      return false;
    }
  };
}

export function buildDialCandidates(
  host: Pick<AccountHost, "id" | "endpoints">,
  relayUrl: string | undefined,
): readonly TransportCandidate[] {
  const candidates: TransportCandidate[] = host.endpoints.map((endpoint) => ({
    kind: endpoint.transport,
    url: endpoint.url,
    label: endpoint.transport,
  }));
  if (relayUrl) candidates.push({ kind: "relay", url: relayUrl, label: "relay" });
  return candidates;
}

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Waits for the next JSON control frame of `type`, or the socket closing. */
function nextHandshakeFrame(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new HostDialError(`host did not answer ${type} in time`, { stage: "handshake" }));
    }, HANDSHAKE_TIMEOUT_MS);
    const onMessage = (data: RawData, binary: boolean) => {
      if (binary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBuffer(data).toString("utf8"));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const frame = parsed as Record<string, unknown>;
      if (frame.type !== type) return;
      cleanup();
      resolve(frame);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(
        new HostDialError(
          `connection closed during handshake (${code}${reason.length ? `: ${reason.toString("utf8")}` : ""})`,
          { stage: "handshake", closeCode: code },
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(
        new HostDialError(
          "connection failed during handshake",
          { stage: "handshake" },
          { cause: error },
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

function openSocket(url: string, factory: (url: string) => WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = factory(url);
    const onOpen = () => {
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpected);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(
        new HostDialError(
          "could not open the session socket",
          { stage: "handshake" },
          { cause: error },
        ),
      );
    };
    const onUnexpected = (_request: unknown, response: { statusCode?: number }) => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      reject(
        new HostDialError(`session upgrade refused with HTTP ${response.statusCode ?? "?"}`, {
          stage: "handshake",
        }),
      );
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onUnexpected);
  });
}

function send(socket: WebSocket, frame: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(JSON.stringify(frame), { binary: false }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

/**
 * `grant → race → connect → mint → authorize`, once.
 *
 * The grant is fetched before the race even though only the winner uses it:
 * grants live 60 seconds and a slow race can leave a valid path holding a
 * grant that expires between winning and being presented.
 */
export async function dialHost(input: DialInput): Promise<DialedSession> {
  const candidates = buildDialCandidates(input.host, input.relayUrl);
  if (candidates.length === 0) {
    throw new HostDialError("that host has no published address and no relay is configured", {
      stage: "no-route",
    });
  }
  let grant: string;
  try {
    grant = await input.requestGrant();
  } catch (error) {
    throw new HostDialError(
      "could not obtain a connection grant",
      { stage: "grant" },
      { cause: error },
    );
  }
  const race = await raceTransports(candidates, input.probe ?? defaultProbe(input.host.id));
  if (race.outcome !== "reachable") {
    throw new HostDialError(
      race.outcome === "timed-out"
        ? "that host did not answer on any path"
        : "that host is not reachable right now",
      { stage: "unreachable", race },
    );
  }

  const factory =
    input.openSocket ?? ((url: string) => new WebSocket(url, { perMessageDeflate: false }));
  const socket = await openSocket(sessionUrl(race.candidate, grant), factory);
  try {
    const mintRequest = await signMintRequest({
      key: input.identity.key,
      publicJwk: input.identity.publicJwk,
      userId: input.identity.userId,
      grant,
      environmentId: input.host.environmentId,
    });
    const credentialFrame = nextHandshakeFrame(socket, "session_credential");
    await send(socket, { v: 1, type: "mint_request", request: mintRequest });
    const minted = await credentialFrame;
    const credential = minted.credential;
    if (typeof credential !== "string") {
      throw new HostDialError("host returned no session credential", { stage: "handshake" });
    }
    const dpop = await signDpopProof({
      key: input.identity.key,
      publicJwk: input.identity.publicJwk,
      method: "CONNECT",
      url: SESSION_PRESENTATION_HTU,
      accessToken: credential,
    });
    const ready = nextHandshakeFrame(socket, "session_ready");
    await send(socket, { v: 1, type: "session_authorize", credential, dpop });
    await ready;
    const exp = decodeJwt(credential).exp;
    return {
      socket,
      transport: race.candidate.kind,
      credential,
      credentialExpiresAtSeconds:
        typeof exp === "number" ? exp : Math.floor(Date.now() / 1000) + 3600,
      race,
    };
  } catch (error) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "handshake failed");
    }
    throw error;
  }
}
