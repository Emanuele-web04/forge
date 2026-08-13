import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DPOP_JWT_TYP,
  GRANT_JWT_TYP,
  HOST_CONNECT_SCOPE,
  MINT_REQUEST_JWT_TYP,
  SYNARA_DEVICE_ISSUER,
  SYNARA_RELAY_AUDIENCE,
  type ApiJwks,
} from "@synara/contracts";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type GenerateKeyPairResult,
  type JWK,
} from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import { generateAndPersistHostIdentity, type HostIdentity } from "../hostIdentity";
import { verifySessionCredential } from "./credential";
import { HostMintService } from "./mintService";
import { JwtReplayCache } from "./replayCache";

const NOW = 1_800_000_000;
const API_ISSUER = "https://accounts.example.test";
const ENVIRONMENT_ID = "env-test";
const HOST_ID = "2f1f9dd7-56a5-45cf-b847-12e6658f3720";
const USER_ID = "user_1";

type KeyPair = GenerateKeyPairResult & { publicJwk: JWK };

async function keyPair(algorithm: "EdDSA" | "ES256" = "EdDSA"): Promise<KeyPair> {
  const pair = await generateKeyPair(algorithm, { extractable: true });
  return { ...pair, publicJwk: await exportJWK(pair.publicKey) };
}

describe("HostMintService", () => {
  let hostIdentity: HostIdentity;
  let api: KeyPair;
  let wrongApi: KeyPair;
  let device: KeyPair;
  let deviceJkt: string;
  let jwks: ApiJwks;

  beforeEach(async () => {
    hostIdentity = await generateAndPersistHostIdentity(
      path.join(await mkdtemp(path.join(tmpdir(), "synara-mint-")), "host.json"),
    );
    api = await keyPair();
    wrongApi = await keyPair();
    device = await keyPair();
    deviceJkt = await calculateJwkThumbprint(device.publicJwk, "sha256");
    jwks = {
      keys: [
        {
          kty: "OKP",
          crv: "Ed25519",
          x: api.publicJwk.x as string,
          kid: "api-1",
          alg: "EdDSA",
          use: "sig",
        },
      ],
    };
  });

  async function grant(
    options: {
      signingKey?: CryptoKey;
      audience?: string;
      expiresAt?: number;
      jti?: string;
      jkt?: string;
    } = {},
  ): Promise<string> {
    return new SignJWT({
      hostId: HOST_ID,
      environmentId: ENVIRONMENT_ID,
      cnf: { jkt: options.jkt ?? deviceJkt },
      scope: [HOST_CONNECT_SCOPE],
    })
      .setProtectedHeader({ alg: "EdDSA", typ: GRANT_JWT_TYP, kid: "api-1" })
      .setIssuer(API_ISSUER)
      .setSubject(USER_ID)
      .setAudience(options.audience ?? SYNARA_RELAY_AUDIENCE)
      .setIssuedAt(NOW)
      .setExpirationTime(options.expiresAt ?? NOW + 60)
      .setJti(options.jti ?? randomUUID())
      .sign(options.signingKey ?? api.privateKey);
  }

  async function mintRequest(grantJwt: string, signingKey = device.privateKey): Promise<string> {
    return new SignJWT({ publicKeyJwk: device.publicJwk, grant: grantJwt })
      .setProtectedHeader({
        alg: device.publicJwk.kty === "EC" ? "ES256" : "EdDSA",
        typ: MINT_REQUEST_JWT_TYP,
      })
      .setIssuer(SYNARA_DEVICE_ISSUER)
      .setSubject(USER_ID)
      .setAudience(`synara-host:${ENVIRONMENT_ID}`)
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 120)
      .setJti(randomUUID())
      .sign(signingKey);
  }

  function service(overrides: Partial<ConstructorParameters<typeof HostMintService>[0]> = {}) {
    return new HostMintService({
      identity: hostIdentity,
      apiIssuer: API_ISSUER,
      environmentId: ENVIRONMENT_ID,
      hostId: HOST_ID,
      keyGeneration: 4,
      getApiJwks: async () => jwks,
      getAuthorization: async () => ({
        discoverable: true,
        ownerUserId: "owner_1",
        orgId: "org_1",
        ownerInOrg: true,
      }),
      nowSeconds: () => NOW,
      ...overrides,
    });
  }

  it("mints a one-hour host-signed credential bound to the device key", async () => {
    const result = await service().mint(await mintRequest(await grant()));
    expect(result).toMatchObject({ userId: USER_ID, deviceJkt, expiresAtSeconds: NOW + 3600 });
  });

  it.each([
    ["bad signature", async () => mintRequest(await grant({ signingKey: wrongApi.privateKey }))],
    ["expired", async () => mintRequest(await grant({ expiresAt: NOW - 1 }))],
    ["wrong audience", async () => mintRequest(await grant({ audience: "wrong" }))],
    ["jkt mismatch", async () => mintRequest(await grant({ jkt: "not-the-device" }))],
  ])("rejects %s", async (_label, makeRequest) => {
    await expect(service().mint(await makeRequest())).rejects.toThrow();
  });

  it("rejects grant jti replay", async () => {
    const grantJwt = await grant({ jti: "2e670ffc-3092-4c4a-a220-e682bea95b20" });
    const mint = service();
    await mint.mint(await mintRequest(grantJwt));
    await expect(mint.mint(await mintRequest(grantJwt))).rejects.toThrow(/already been used/);
  });

  it("accepts ES256 device keys and verifies credential plus DPoP", async () => {
    device = await keyPair("ES256");
    deviceJkt = await calculateJwkThumbprint(device.publicJwk, "sha256");
    const result = await service().mint(await mintRequest(await grant()));
    const htu = "synara://remote/session";
    const dpop = await new SignJWT({
      htu,
      htm: "CONNECT",
      ath: createHash("sha256").update(result.credential).digest("base64url"),
    })
      .setProtectedHeader({ alg: "ES256", typ: DPOP_JWT_TYP, jwk: device.publicJwk })
      .setIssuedAt(NOW)
      .setJti(randomUUID())
      .sign(device.privateKey);
    await expect(
      verifySessionCredential({
        credential: result.credential,
        dpop,
        identity: hostIdentity,
        environmentId: ENVIRONMENT_ID,
        keyGeneration: 4,
        expectedHtu: htu,
        expectedHtm: "CONNECT",
        replayCache: new JwtReplayCache(),
        nowSeconds: NOW,
      }),
    ).resolves.toEqual({ userId: USER_ID, deviceJkt, expiresAtSeconds: NOW + 3600 });
  });
});
