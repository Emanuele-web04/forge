import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DPOP_JWT_TYP,
  GRANT_JWT_TYP,
  HOST_CONNECT_SCOPE,
  MINT_REQUEST_JWT_TYP,
  SESSION_CREDENTIAL_JWT_TYP,
  SYNARA_DEVICE_ISSUER,
  SYNARA_RELAY_AUDIENCE,
  SYNARA_SESSION_AUDIENCE,
  type ApiJwks,
} from "@synara/contracts";
import { HOST_SESSION_CLOSE_AUTH_FAILED } from "@synara/relay-protocol";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  SignJWT,
  type JWK,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import { HostMintService } from "../hostAuth";
import { generateAndPersistHostIdentity, type HostIdentity } from "../hostIdentity";
import type { RelaySocket } from "../relayDial";
import { RemoteConnectionGateway } from "./gateway";
import { RemoteSessionRegistry } from "./sessionRegistry";

const HTU = "synara://remote/session";
const API_ISSUER = "https://accounts.example.test";
const HOST_ID = "2f1f9dd7-56a5-45cf-b847-12e6658f3720";

class TestSocket extends EventEmitter implements RelaySocket {
  readyState = WebSocket.OPEN;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data.toString());
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closes.push({ code, reason });
    this.emit("close", code, Buffer.from(reason));
  }

  receive(frame: object): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)) as RawData, false);
  }

  /** Every handshake frame this socket emitted back to the peer, decoded. */
  frames(type: string): Array<Record<string, unknown>> {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === type);
  }
}

class ObservedSessionRegistry extends RemoteSessionRegistry {
  readonly verificationFinished: Promise<void>;
  #markVerificationFinished: (() => void) | undefined;

  constructor() {
    super();
    this.verificationFinished = new Promise((resolve) => {
      this.#markVerificationFinished = resolve;
    });
  }

  override isDeviceRevoked(deviceJkt: string, nowMs?: number): boolean {
    this.#markVerificationFinished?.();
    return super.isDeviceRevoked(deviceJkt, nowMs);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function hostIdentity(label: string): Promise<HostIdentity> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `synara-gateway-${label}-`));
  temporaryDirectories.push(directory);
  return generateAndPersistHostIdentity(path.join(directory, "host.json"));
}

/** A device key plus the credential/DPoP pair the authorize path really verifies. */
async function devicePeer(identity: HostIdentity, environmentId: string, userId: string) {
  const device = await generateKeyPair("EdDSA", { extractable: true });
  const publicJwk = await exportJWK(device.publicKey);
  const deviceJkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const now = Math.floor(Date.now() / 1_000);
  const credential = await new SignJWT({
    cnf: { jkt: deviceJkt },
    keyGeneration: 1,
    scope: [HOST_CONNECT_SCOPE],
  })
    .setProtectedHeader({ alg: "EdDSA", typ: SESSION_CREDENTIAL_JWT_TYP })
    .setIssuer(`synara-host:${environmentId}`)
    .setSubject(userId)
    .setAudience(SYNARA_SESSION_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3_600)
    .setJti(randomUUID())
    .sign(await importPKCS8(identity.privateKeyPem, "EdDSA"));
  const dpop = async () =>
    new SignJWT({
      htu: HTU,
      htm: "CONNECT",
      ath: createHash("sha256").update(credential).digest("base64url"),
    })
      .setProtectedHeader({ alg: "EdDSA", typ: DPOP_JWT_TYP, jwk: publicJwk })
      .setIssuedAt(now)
      // Fresh jti per proof: the gateway's replay cache would otherwise mask
      // whatever the test is actually trying to observe.
      .setJti(randomUUID())
      .sign(device.privateKey);
  return { deviceJkt, credential, dpop };
}

/** A real mint service plus a factory for genuinely valid mint requests. */
async function mintFixture(identity: HostIdentity, environmentId: string, userId: string) {
  const api = await generateKeyPair("EdDSA", { extractable: true });
  const apiJwk = await exportJWK(api.publicKey);
  const device = await generateKeyPair("EdDSA", { extractable: true });
  const publicKeyJwk = await exportJWK(device.publicKey);
  const deviceJkt = await calculateJwkThumbprint(publicKeyJwk, "sha256");
  const jwks: ApiJwks = {
    keys: [
      { kty: "OKP", crv: "Ed25519", x: apiJwk.x as string, kid: "api-1", alg: "EdDSA", use: "sig" },
    ],
  };
  const mintService = new HostMintService({
    identity,
    apiIssuer: API_ISSUER,
    environmentId,
    hostId: HOST_ID,
    keyGeneration: 1,
    // Owner path: no account API round trip, so the fixture stays offline.
    ownerUserId: userId,
    getApiJwks: async () => jwks,
    getAuthorization: async () => ({
      discoverable: true,
      ownerUserId: userId,
      orgId: "org_1",
      revokedDeviceJkts: [],
      ownerInOrg: true,
    }),
  });
  // Each call carries a fresh grant jti so a second request is not rejected by
  // the mint service's own replay cache — the gateway's state machine, not the
  // replay cache, is what must refuse it.
  const mintRequest = async (): Promise<string> => {
    const now = Math.floor(Date.now() / 1_000);
    const grant = await new SignJWT({
      hostId: HOST_ID,
      environmentId,
      cnf: { jkt: deviceJkt },
      scope: [HOST_CONNECT_SCOPE],
    })
      .setProtectedHeader({ alg: "EdDSA", typ: GRANT_JWT_TYP, kid: "api-1" })
      .setIssuer(API_ISSUER)
      .setSubject(userId)
      .setAudience(SYNARA_RELAY_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomUUID())
      .sign(api.privateKey);
    return new SignJWT({ publicKeyJwk: publicKeyJwk as JWK, grant })
      .setProtectedHeader({ alg: "EdDSA", typ: MINT_REQUEST_JWT_TYP })
      .setIssuer(SYNARA_DEVICE_ISSUER)
      .setSubject(userId)
      .setAudience(`synara-host:${environmentId}`)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(randomUUID())
      .sign(device.privateKey);
  };
  return { mintService, deviceJkt, mintRequest };
}

describe("RemoteConnectionGateway", () => {
  it("does not register a peer that closed while its credential was being verified", async () => {
    const identity = await hostIdentity("race");
    const environmentId = "gateway-race-environment";
    const peer = await devicePeer(identity, environmentId, "user-1");
    const sessions = new ObservedSessionRegistry();
    const bridgeToLocal = vi.fn(async () => {});
    const gateway = new RemoteConnectionGateway({
      mintService: {} as HostMintService,
      identity,
      environmentId,
      keyGeneration: 1,
      sessions,
      bridgeToLocal,
    });
    const socket = new TestSocket();
    await gateway.accept(socket);

    socket.receive({
      v: 1,
      type: "session_authorize",
      credential: peer.credential,
      dpop: await peer.dpop(),
    });
    socket.close(1000, "peer left");
    await sessions.verificationFinished;

    expect(sessions.size).toBe(0);
    expect(bridgeToLocal).not.toHaveBeenCalled();
  });

  it("refuses a mint whose identity differs from the one the relay spliced", async () => {
    // The relay attests WHO it spliced. A peer that mints under a different
    // identity on that socket breaks the attestation, so the credential must
    // never reach it.
    const identity = await hostIdentity("mint-splice");
    const environmentId = "gateway-mint-splice-environment";
    const fixture = await mintFixture(identity, environmentId, "minted-user");
    const sessions = new RemoteSessionRegistry();
    const gateway = new RemoteConnectionGateway({
      mintService: fixture.mintService,
      identity,
      environmentId,
      keyGeneration: 1,
      sessions,
      bridgeToLocal: vi.fn(async () => {}),
    });
    const socket = new TestSocket();
    await gateway.accept(socket, { userId: "expected-user", deviceJkt: "expected-jkt" }, "relay");

    socket.receive({ v: 1, type: "mint_request", request: await fixture.mintRequest() });
    await vi.waitFor(() => expect(socket.closes).toHaveLength(1));

    expect(HOST_SESSION_CLOSE_AUTH_FAILED).toBe(4501);
    expect(socket.closes[0]?.code).toBe(4501);
    expect(socket.closes[0]?.reason).toMatch(/does not match relay splice identity/);
    expect(socket.frames("session_credential")).toHaveLength(0);
  });

  it("refuses a credential whose identity differs from the one the relay spliced", async () => {
    // The twin of the mint check, and the more dangerous one: it is the last
    // gate before the session is registered and bridged to local RPC.
    const identity = await hostIdentity("authorize-splice");
    const environmentId = "gateway-authorize-splice-environment";
    const peer = await devicePeer(identity, environmentId, "user-a");
    const sessions = new RemoteSessionRegistry();
    const bridgeToLocal = vi.fn(async () => {});
    const gateway = new RemoteConnectionGateway({
      mintService: {} as HostMintService,
      identity,
      environmentId,
      keyGeneration: 1,
      sessions,
      bridgeToLocal,
    });
    const socket = new TestSocket();
    await gateway.accept(socket, { userId: "user-b", deviceJkt: "jkt-b" }, "relay");

    socket.receive({
      v: 1,
      type: "session_authorize",
      credential: peer.credential,
      dpop: await peer.dpop(),
    });
    await vi.waitFor(() => expect(socket.closes).toHaveLength(1));

    expect(HOST_SESSION_CLOSE_AUTH_FAILED).toBe(4501);
    expect(socket.closes[0]?.code).toBe(4501);
    expect(socket.closes[0]?.reason).toMatch(/does not match relay splice identity/);
    expect(sessions.size).toBe(0);
    expect(bridgeToLocal).not.toHaveBeenCalled();
  });

  it("bridges only once when two authorize frames arrive in the same tick", async () => {
    // `ws` delivers every frame in a TCP segment synchronously. Without the
    // serial handshake chain both frames observe state === "authorize", both
    // verify (distinct DPoP jtis defeat the replay cache), and both bridge the
    // same socket — registering the forwarder twice and duplicating every RPC.
    const identity = await hostIdentity("serial");
    const environmentId = "gateway-serial-environment";
    const peer = await devicePeer(identity, environmentId, "user-1");
    const sessions = new RemoteSessionRegistry();
    const bridgeToLocal = vi.fn(async () => {});
    const gateway = new RemoteConnectionGateway({
      mintService: {} as HostMintService,
      identity,
      environmentId,
      keyGeneration: 1,
      sessions,
      bridgeToLocal,
    });
    const socket = new TestSocket();
    await gateway.accept(socket);
    const first = await peer.dpop();
    const second = await peer.dpop();
    expect(first).not.toBe(second);

    socket.receive({ v: 1, type: "session_authorize", credential: peer.credential, dpop: first });
    socket.receive({ v: 1, type: "session_authorize", credential: peer.credential, dpop: second });
    await vi.waitFor(() => expect(socket.frames("session_ready").length).toBeGreaterThan(0));
    // Let a concurrent second handshake finish before asserting it never ran.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridgeToLocal).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(1);
    expect(socket.frames("session_ready")).toHaveLength(1);
    expect(socket.closes).toEqual([]);
  });

  it("refuses a second mint request once the handshake has left the mint state", async () => {
    // The handshake is one-shot. Re-entering mint would let one socket issue
    // unlimited credentials.
    const identity = await hostIdentity("mint-once");
    const environmentId = "gateway-mint-once-environment";
    const fixture = await mintFixture(identity, environmentId, "minted-user");
    const sessions = new RemoteSessionRegistry();
    const gateway = new RemoteConnectionGateway({
      mintService: fixture.mintService,
      identity,
      environmentId,
      keyGeneration: 1,
      sessions,
      bridgeToLocal: vi.fn(async () => {}),
    });
    const socket = new TestSocket();
    await gateway.accept(socket);

    socket.receive({ v: 1, type: "mint_request", request: await fixture.mintRequest() });
    await vi.waitFor(() => expect(socket.frames("session_credential")).toHaveLength(1));
    socket.receive({ v: 1, type: "mint_request", request: await fixture.mintRequest() });
    await vi.waitFor(() => expect(socket.closes).toHaveLength(1));

    expect(socket.frames("session_credential")).toHaveLength(1);
    expect(socket.closes[0]?.code).toBe(4501);
  });
});
