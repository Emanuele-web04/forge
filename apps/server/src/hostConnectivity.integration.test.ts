import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DPOP_JWT_TYP,
  GRANT_JWT_TYP,
  HOST_CONNECT_SCOPE,
  MINT_REQUEST_JWT_TYP,
  SYNARA_DEVICE_ISSUER,
  SYNARA_RELAY_AUDIENCE,
  type AccountHost,
  type ApiJwks,
  EnvironmentId,
} from "@synara/contracts";
import type { AccountClient } from "@synara/shared/account";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type RawData } from "ws";

import { readAccountFile, runAuthLogin, writeAccountCredentials } from "./accountAuth";
import { HostMintService } from "./hostAuth";
import { readHostIdentity } from "./hostIdentity";
import { RelayDialSupervisor, type RelaySocket } from "./relayDial";
import { RemoteConnectionGateway, RemoteSessionRegistry } from "./remoteSessions";

class FakeRelaySocket extends EventEmitter implements RelaySocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  send(data: string | Uint8Array): void {
    this.sent.push(data.toString());
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit("close", code, Buffer.from(reason));
  }
  open(): void {
    this.emit("open");
  }
  receive(data: string | object): void {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    this.emit("message", Buffer.from(raw) as RawData);
  }
}

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories)
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("host connectivity integration", () => {
  it("links, dials, splices, mints, carries traffic, and kills the revoked session", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-connectivity-integration-"));
    temporaryDirectories.push(baseDir);
    const environmentId = "integration-environment";
    fs.mkdirSync(path.join(baseDir, "userdata"), { recursive: true });
    fs.writeFileSync(path.join(baseDir, "userdata", "environment-id"), environmentId);
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.test",
      workosClientId: "workos-client",
      workosApiUrl: "https://workos.example.test",
      organizationId: "org",
      userId: "owner",
      accessToken: "account-session",
      refreshToken: "account-refresh",
    });
    const host: AccountHost = {
      id: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
      environmentId: EnvironmentId.makeUnsafe(environmentId),
      name: "Integration host",
      platform: "linux",
      kind: "local",
      endpoints: [],
      ownerUserId: "owner",
      discoverable: true,
      linked: true,
      keyGeneration: 1,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    let linkProof = "";
    const linkClient = {
      startHostLink: async () => ({
        challengeId: "ea4fc40a-a4f7-498f-bf78-c6a69536ecab",
        nonce: "aW50ZWdyYXRpb24tbm9uY2U",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
      completeHostLink: async (request: { proof: string }) => {
        linkProof = request.proof;
        return { host };
      },
    } as unknown as AccountClient;
    await runAuthLogin({
      accountUrl: "https://accounts.example.test",
      baseDir,
      client: linkClient,
      platform: "linux",
      hostname: host.name,
      stdout: () => {},
    });
    expect(linkProof.split(".")).toHaveLength(3);
    expect(await readAccountFile(baseDir)).toMatchObject({
      hostId: host.id,
      hostOwnerUserId: host.ownerUserId,
      hostKeyGeneration: 1,
    });

    const identity = await readHostIdentity(
      path.join(baseDir, "userdata", "secrets", "host-identity.json"),
    );
    if (!identity) throw new Error("link did not persist a host identity");
    const api = await generateKeyPair("EdDSA", { extractable: true });
    const apiPublic = await exportJWK(api.publicKey);
    const jwks: ApiJwks = {
      keys: [
        {
          kty: "OKP",
          crv: "Ed25519",
          x: apiPublic.x as string,
          kid: "integration-api",
          alg: "EdDSA",
          use: "sig",
        },
      ],
    };
    const device = await generateKeyPair("EdDSA", { extractable: true });
    const devicePublic = await exportJWK(device.publicKey);
    const deviceJkt = await calculateJwkThumbprint(devicePublic, "sha256");
    const now = Math.floor(Date.now() / 1_000);
    const grant = await new SignJWT({
      hostId: host.id,
      environmentId,
      cnf: { jkt: deviceJkt },
      scope: [HOST_CONNECT_SCOPE],
    })
      .setProtectedHeader({ alg: "EdDSA", typ: GRANT_JWT_TYP, kid: "integration-api" })
      .setIssuer("https://accounts.example.test")
      .setSubject("member")
      .setAudience(SYNARA_RELAY_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomUUID())
      .sign(api.privateKey);
    const mintRequest = await new SignJWT({ publicKeyJwk: devicePublic, grant })
      .setProtectedHeader({ alg: "EdDSA", typ: MINT_REQUEST_JWT_TYP })
      .setIssuer(SYNARA_DEVICE_ISSUER)
      .setSubject("member")
      .setAudience(`synara-host:${environmentId}`)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(randomUUID())
      .sign(device.privateKey);

    const registry = new RemoteSessionRegistry();
    const mint = new HostMintService({
      identity,
      apiIssuer: "https://accounts.example.test",
      environmentId,
      hostId: host.id,
      keyGeneration: 1,
      getApiJwks: async () => jwks,
      getAuthorization: async () => ({
        discoverable: true,
        ownerUserId: "owner",
        orgId: "org",
        ownerInOrg: true,
      }),
    });
    const traffic: string[] = [];
    let releaseBridge!: () => void;
    const bridgeReleased = new Promise<void>((resolve) => {
      releaseBridge = resolve;
    });
    let markBridgeStarted!: () => void;
    const bridgeStarted = new Promise<void>((resolve) => {
      markBridgeStarted = resolve;
    });
    const gateway = new RemoteConnectionGateway({
      mintService: mint,
      identity,
      environmentId,
      keyGeneration: 1,
      sessions: registry,
      bridgeToLocal: async (socket) => {
        markBridgeStarted();
        await bridgeReleased;
        socket.on("message", (raw) => {
          const value = raw.toString();
          if (!value.startsWith("{")) traffic.push(value);
        });
      },
    });

    const sockets: FakeRelaySocket[] = [];
    const controller = new AbortController();
    const supervisor = new RelayDialSupervisor({
      relayUrl: "https://relay.example.test",
      hostId: host.id,
      requestTicket: async () => "relay-ticket",
      reverifySessions: (event) =>
        registry.reverify(
          { discoverable: true, ownerUserId: "owner", orgId: "org", ownerInOrg: true },
          event,
        ),
      acceptSplice: (socket, splice) =>
        gateway.accept(socket, { userId: splice.userId, deviceJkt: splice.deviceJkt }),
      socketFactory: () => {
        const socket = new FakeRelaySocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
      sleep: async () => controller.abort(),
    });
    const running = supervisor.run(controller.signal);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const control = sockets[0]!;
    control.receive({
      v: 1,
      type: "splice_request",
      spliceId: "a".repeat(43),
      hostId: host.id,
      userId: "member",
      deviceJkt,
      expiresAtMs: Date.now() + 30_000,
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const data = sockets[1]!;
    await vi.waitFor(() => expect(data.listenerCount("message")).toBeGreaterThan(0));
    data.receive({ v: 1, type: "mint_request", request: mintRequest });
    await vi.waitFor(() =>
      expect(
        data.sent.some((frame) => JSON.parse(frame).type === "session_credential"),
        JSON.stringify(data.closes),
      ).toBe(true),
    );
    const credentialFrame = data.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "session_credential") as { credential: string };
    const dpop = await new SignJWT({
      htu: "synara://remote/session",
      htm: "CONNECT",
      ath: createHash("sha256").update(credentialFrame.credential).digest("base64url"),
    })
      .setProtectedHeader({ alg: "EdDSA", typ: DPOP_JWT_TYP, jwk: devicePublic })
      .setIssuedAt()
      .setJti(randomUUID())
      .sign(device.privateKey);
    data.receive({
      v: 1,
      type: "session_authorize",
      credential: credentialFrame.credential,
      dpop,
    });
    await vi.waitFor(() => expect(registry.size).toBe(1));
    await bridgeStarted;
    expect(data.sent.some((frame) => JSON.parse(frame).type === "session_ready")).toBe(false);
    releaseBridge();
    await vi.waitFor(() =>
      expect(data.sent.some((frame) => JSON.parse(frame).type === "session_ready")).toBe(true),
    );
    data.receive("rpc-traffic");
    await vi.waitFor(() => expect(traffic).toEqual(["rpc-traffic"]));

    control.receive({
      v: 1,
      type: "revocation",
      events: [
        {
          id: 1,
          hostId: host.id,
          kind: "device_revoked",
          subject: deviceJkt,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await vi.waitFor(() => expect(data.closes[0]).toMatchObject({ code: 4403 }));
    controller.abort();
    control.close();
    await running;
  });
});
