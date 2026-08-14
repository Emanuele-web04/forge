import { randomUUID } from "node:crypto";

import {
  HOST_SESSION_CLOSE_AUTH_FAILED,
  HOST_SESSION_CLOSE_PROTOCOL_ERROR,
} from "@synara/relay-protocol";
import type { RawData } from "ws";

import type { HostMintService } from "../hostAuth";
import { JwtReplayCache, verifySessionCredential } from "../hostAuth";
import type { HostIdentity } from "../hostIdentity";
import type { RelaySocket } from "../relayDial";
import { RemoteSessionRegistry } from "./sessionRegistry";

const REMOTE_PROTOCOL_ERROR = HOST_SESSION_CLOSE_PROTOCOL_ERROR;
const REMOTE_AUTH_ERROR = HOST_SESSION_CLOSE_AUTH_FAILED;

type ExpectedPeer = { readonly userId: string; readonly deviceJkt: string };

export interface RemoteConnectionGatewayOptions {
  readonly mintService: HostMintService;
  readonly identity: HostIdentity;
  readonly environmentId: string;
  readonly keyGeneration: number;
  readonly sessions: RemoteSessionRegistry;
  readonly bridgeToLocal: (
    socket: RelaySocket,
    peer: {
      readonly userId: string;
      readonly deviceJkt: string;
      readonly expiresAtSeconds: number;
    },
  ) => Promise<void>;
  readonly presentationHtu?: string;
}

function parseFrame(raw: RawData): Record<string, unknown> {
  const value: unknown = JSON.parse(raw.toString());
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("remote handshake frame must be an object");
  }
  return value as Record<string, unknown>;
}

export class RemoteConnectionGateway {
  readonly #dpopReplays = new JwtReplayCache();

  constructor(readonly options: RemoteConnectionGatewayOptions) {}

  async accept(
    socket: RelaySocket,
    expected?: ExpectedPeer,
    via: "direct" | "relay" | "ssh-forward" = "direct",
  ): Promise<void> {
    let state: "mint" | "authorize" | "bridged" = "mint";
    // Handshake frames are processed STRICTLY SERIALLY. `ws` delivers every
    // frame in a TCP segment synchronously, so an async-per-frame handler
    // would let two `session_authorize` frames both observe state ===
    // "authorize" before either reassigns it — each verifying (distinct DPoP
    // jtis defeat the replay cache) and each bridging the same socket, which
    // registers the forwarder twice and duplicates every subsequent RPC.
    let handshake: Promise<void> = Promise.resolve();
    socket.on("message", (raw) => {
      if (state === "bridged") return;
      handshake = handshake.then(async () => {
        if (state === "bridged") return;
        try {
          const frame = parseFrame(raw);
          if (
            state === "mint" &&
            frame.v === 1 &&
            frame.type === "mint_request" &&
            typeof frame.request === "string"
          ) {
            const minted = await this.options.mintService.mint(frame.request);
            if (
              expected &&
              (minted.userId !== expected.userId || minted.deviceJkt !== expected.deviceJkt)
            ) {
              throw new Error("mint request does not match relay splice identity");
            }
            socket.send(
              JSON.stringify({
                v: 1,
                type: "session_credential",
                credential: minted.credential,
                expiresAtSeconds: minted.expiresAtSeconds,
              }),
            );
            state = "authorize";
            return;
          }
          if (
            frame.v !== 1 ||
            frame.type !== "session_authorize" ||
            typeof frame.credential !== "string" ||
            typeof frame.dpop !== "string"
          ) {
            throw new Error(
              state === "mint"
                ? "expected mint_request or session_authorize frame"
                : "expected session_authorize frame",
            );
          }
          const peer = await verifySessionCredential({
            credential: frame.credential,
            dpop: frame.dpop,
            identity: this.options.identity,
            environmentId: this.options.environmentId,
            keyGeneration: this.options.keyGeneration,
            expectedHtu: this.options.presentationHtu ?? "synara://remote/session",
            expectedHtm: "CONNECT",
            replayCache: this.#dpopReplays,
          });
          if (
            expected &&
            (peer.userId !== expected.userId || peer.deviceJkt !== expected.deviceJkt)
          ) {
            throw new Error("session credential does not match relay splice identity");
          }
          state = "bridged";
          const id = randomUUID();
          const remove = this.options.sessions.add({
            id,
            ...peer,
            startedAt: new Date().toISOString(),
            via,
            close: (code, reason) => socket.close(code, reason),
          });
          socket.on("close", remove);
          await this.options.bridgeToLocal(socket, peer);
          // Do not invite application traffic until the ordinary local WS path is
          // ready to receive it. Otherwise a fast peer can race the async token
          // issuance/local connection setup and lose its first RPC frame.
          socket.send(JSON.stringify({ v: 1, type: "session_ready" }));
        } catch (error) {
          socket.close(
            state === "mint" || state === "authorize" ? REMOTE_AUTH_ERROR : REMOTE_PROTOCOL_ERROR,
            error instanceof Error ? error.message.slice(0, 120) : "remote authentication failed",
          );
        }
      });
    });
  }
}
