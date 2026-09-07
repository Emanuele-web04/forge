// The outbound handshake against a fake host: the frames a real host's
// gateway expects, in the order it expects them, with the right key.
import { EventEmitter } from "node:events";

import { type EnvironmentId, MINT_REQUEST_JWT_TYP, SYNARA_DEVICE_ISSUER } from "@synara/contracts";
import { exportPublicJwk, generateDeviceKey, hostAudience } from "@synara/shared/deviceKey";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { buildDialCandidates, dialHost, HostDialError } from "./dialer";

const HOST_ID = "2f1f9dd7-56a5-45cf-b847-12e6658f3720";
const ENVIRONMENT_ID = "env-1" as EnvironmentId;

/** A `ws`-shaped client socket whose far end is scripted by the test. */
class FakeSocket extends EventEmitter {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  constructor(readonly url: string) {
    super();
  }
  send(data: string | Buffer, _options: unknown, callback?: (error?: Error) => void): void {
    this.sent.push(data.toString());
    callback?.();
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit("close", code, Buffer.from(reason));
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  reply(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }
  lastFrame(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1) ?? "{}") as Record<string, unknown>;
  }
}

async function makeIdentity() {
  const key = await generateDeviceKey();
  return { userId: "user_1", key, publicJwk: await exportPublicJwk(key) };
}

async function makeCredential(exp: number): Promise<string> {
  const key = await generateDeviceKey();
  return new SignJWT({ scope: ["host:connect"] })
    .setProtectedHeader({ alg: "ES256" })
    .setExpirationTime(exp)
    .sign(key.privateKey);
}

describe("buildDialCandidates", () => {
  it("lists directory endpoints then the relay, and nothing when neither exists", () => {
    const host = {
      id: HOST_ID,
      endpoints: [{ url: "http://10.0.0.5:3773", transport: "lan" as const }],
    };
    expect(buildDialCandidates(host, "https://relay.test").map((c) => c.kind)).toEqual([
      "lan",
      "relay",
    ]);
    expect(buildDialCandidates({ id: HOST_ID, endpoints: [] }, undefined)).toEqual([]);
  });
});

describe("dialHost", () => {
  it("fails closed with no-route before asking for a grant", async () => {
    const requestGrant = vi.fn(async () => "grant");
    await expect(
      dialHost({
        host: { id: HOST_ID, environmentId: ENVIRONMENT_ID, endpoints: [] },
        identity: await makeIdentity(),
        requestGrant,
      }),
    ).rejects.toMatchObject({ name: "HostDialError", detail: { stage: "no-route" } });
    expect(requestGrant).not.toHaveBeenCalled();
  });

  it("dials the relay with the grant, mints with the device key, then DPoP-authorizes", async () => {
    const identity = await makeIdentity();
    const sockets: FakeSocket[] = [];
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const credential = await makeCredential(exp);
    const dialed = dialHost({
      host: { id: HOST_ID, environmentId: ENVIRONMENT_ID, endpoints: [] },
      identity,
      relayUrl: "https://relay.test",
      requestGrant: async () => "grant-jwt",
      probe: async () => true,
      openSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    expect(socket.url).toBe("wss://relay.test/client/session?grant=grant-jwt");

    // 1) mint_request signed by the device key, bound to the host's environment
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const mint = socket.lastFrame();
    expect(mint).toMatchObject({ v: 1, type: "mint_request" });
    const mintJwt = mint.request as string;
    expect(decodeProtectedHeader(mintJwt)).toMatchObject({
      alg: "ES256",
      typ: MINT_REQUEST_JWT_TYP,
    });
    expect(decodeJwt(mintJwt)).toMatchObject({
      iss: SYNARA_DEVICE_ISSUER,
      sub: "user_1",
      aud: hostAudience(ENVIRONMENT_ID),
      grant: "grant-jwt",
      publicKeyJwk: identity.publicJwk,
    });

    // 2) the host answers with a credential; the client authorizes with DPoP over it
    socket.reply({ v: 1, type: "session_credential", credential, expiresAtSeconds: exp });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const authorize = socket.lastFrame();
    expect(authorize).toMatchObject({ v: 1, type: "session_authorize", credential });
    const dpop = decodeJwt(authorize.dpop as string);
    expect(dpop).toMatchObject({ htm: "CONNECT", htu: "synara://remote/session" });
    expect(typeof dpop.ath).toBe("string");
    expect(decodeProtectedHeader(authorize.dpop as string)).toMatchObject({
      typ: "dpop+jwt",
      jwk: identity.publicJwk,
    });

    // 3) ready → session
    socket.reply({ v: 1, type: "session_ready" });
    const session = await dialed;
    expect(session.transport).toBe("relay");
    expect(session.credential).toBe(credential);
    expect(session.credentialExpiresAtSeconds).toBe(exp);
  });

  it("prefers a reachable direct endpoint over the relay and dials its /ws/host", async () => {
    const sockets: FakeSocket[] = [];
    const exp = Math.floor(Date.now() / 1000) + 60;
    const credential = await makeCredential(exp);
    const dialed = dialHost({
      host: {
        id: HOST_ID,
        environmentId: ENVIRONMENT_ID,
        endpoints: [{ url: "http://10.0.0.5:3773", transport: "lan" }],
      },
      identity: await makeIdentity(),
      relayUrl: "https://relay.test",
      requestGrant: async () => "grant-jwt",
      probe: async () => true,
      openSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url).toBe("ws://10.0.0.5:3773/ws/host");
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1));
    sockets[0]!.reply({ v: 1, type: "session_credential", credential, expiresAtSeconds: exp });
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(2));
    sockets[0]!.reply({ v: 1, type: "session_ready" });
    expect((await dialed).transport).toBe("lan");
  });

  it("surfaces the host's close code when the handshake is refused", async () => {
    const sockets: FakeSocket[] = [];
    const dialed = dialHost({
      host: { id: HOST_ID, environmentId: ENVIRONMENT_ID, endpoints: [] },
      identity: await makeIdentity(),
      relayUrl: "https://relay.test",
      requestGrant: async () => "grant-jwt",
      probe: async () => true,
      openSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0]!.close(4501, "grant is not bound to this host");
    const error = await dialed.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HostDialError);
    expect((error as HostDialError).detail).toMatchObject({ stage: "handshake", closeCode: 4501 });
  });

  it("reports unreachable with every attempt when no path answers", async () => {
    const error = await dialHost({
      host: {
        id: HOST_ID,
        environmentId: ENVIRONMENT_ID,
        endpoints: [{ url: "http://10.0.0.5:3773", transport: "lan" }],
      },
      identity: await makeIdentity(),
      relayUrl: "https://relay.test",
      requestGrant: async () => "grant-jwt",
      probe: async () => false,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HostDialError);
    const detail = (error as HostDialError).detail;
    expect(detail.stage).toBe("unreachable");
    expect(detail.race?.attempts.map((attempt) => attempt.candidate.kind).toSorted()).toEqual([
      "lan",
      "relay",
    ]);
  });
});
