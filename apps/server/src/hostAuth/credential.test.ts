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
const KEY_GENERATION = 4;
const HTU = "synara://remote/session";
const HTM = "CONNECT";
/**
 * Pinned to the literal, not JWT_CLOCK_TOLERANCE_SECONDS: the freshness
 * window is the ONLY bound on a DPoP proof's lifetime (proofs carry no exp),
 * so widening the constant must break these tests rather than move them.
 */
const CLOCK_TOLERANCE_SECONDS = 60;

type KeyPair = GenerateKeyPairResult & { publicJwk: JWK };

async function keyPair(algorithm: "EdDSA" | "ES256" = "EdDSA"): Promise<KeyPair> {
  const pair = await generateKeyPair(algorithm, { extractable: true });
  return { ...pair, publicJwk: await exportJWK(pair.publicKey) };
}

describe("verifySessionCredential", () => {
  let hostIdentity: HostIdentity;
  let api: KeyPair;
  let device: KeyPair;
  /** An unrelated, equally well-formed device key — the attacker's. */
  let otherDevice: KeyPair;
  let deviceJkt: string;
  let jwks: ApiJwks;
  let credential: string;

  beforeEach(async () => {
    hostIdentity = await generateAndPersistHostIdentity(
      path.join(await mkdtemp(path.join(tmpdir(), "synara-credential-")), "host.json"),
    );
    api = await keyPair();
    device = await keyPair();
    otherDevice = await keyPair();
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
    credential = (await mint()).credential;
  });

  async function grant(): Promise<string> {
    return new SignJWT({
      hostId: HOST_ID,
      environmentId: ENVIRONMENT_ID,
      cnf: { jkt: deviceJkt },
      scope: [HOST_CONNECT_SCOPE],
    })
      .setProtectedHeader({ alg: "EdDSA", typ: GRANT_JWT_TYP, kid: "api-1" })
      .setIssuer(API_ISSUER)
      .setSubject(USER_ID)
      .setAudience(SYNARA_RELAY_AUDIENCE)
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 60)
      .setJti(randomUUID())
      .sign(api.privateKey);
  }

  async function mintRequest(grantJwt: string): Promise<string> {
    return new SignJWT({ publicKeyJwk: device.publicJwk, grant: grantJwt })
      .setProtectedHeader({ alg: "EdDSA", typ: MINT_REQUEST_JWT_TYP })
      .setIssuer(SYNARA_DEVICE_ISSUER)
      .setSubject(USER_ID)
      .setAudience(`synara-host:${ENVIRONMENT_ID}`)
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 120)
      .setJti(randomUUID())
      .sign(device.privateKey);
  }

  /** A real host-signed credential, produced by the shipping mint path. */
  async function mint() {
    return new HostMintService({
      identity: hostIdentity,
      apiIssuer: API_ISSUER,
      environmentId: ENVIRONMENT_ID,
      hostId: HOST_ID,
      keyGeneration: KEY_GENERATION,
      ownerUserId: USER_ID,
      getApiJwks: async () => jwks,
      getAuthorization: async () => {
        throw new Error("owner path must not consult the account API");
      },
      nowSeconds: () => NOW,
    }).mint(await mintRequest(await grant()));
  }

  function credentialHash(value: string): string {
    return createHash("sha256").update(value).digest("base64url");
  }

  async function dpopProof(
    options: {
      signer?: KeyPair;
      htu?: string;
      htm?: string;
      iat?: number;
      jti?: string;
      ath?: string;
    } = {},
  ): Promise<string> {
    const signer = options.signer ?? device;
    return new SignJWT({
      htu: options.htu ?? HTU,
      htm: options.htm ?? HTM,
      ath: options.ath ?? credentialHash(credential),
    })
      .setProtectedHeader({
        alg: signer.publicJwk.kty === "EC" ? "ES256" : "EdDSA",
        typ: DPOP_JWT_TYP,
        jwk: signer.publicJwk,
      })
      .setIssuedAt(options.iat ?? NOW)
      .setJti(options.jti ?? randomUUID())
      .sign(signer.privateKey);
  }

  function verify(options: {
    credential?: string;
    dpop: string;
    expectedHtu?: string;
    expectedHtm?: string;
    replayCache?: JwtReplayCache;
    nowSeconds?: number;
  }) {
    return verifySessionCredential({
      credential: options.credential ?? credential,
      dpop: options.dpop,
      identity: hostIdentity,
      environmentId: ENVIRONMENT_ID,
      keyGeneration: KEY_GENERATION,
      expectedHtu: options.expectedHtu ?? HTU,
      expectedHtm: options.expectedHtm ?? HTM,
      replayCache: options.replayCache ?? new JwtReplayCache(),
      nowSeconds: options.nowSeconds ?? NOW,
    });
  }

  it("accepts a well-formed proof from the bound device", async () => {
    // Anchors the builders: every rejection case below differs from this one
    // in exactly one respect, so only the checked guard can explain it.
    await expect(verify({ dpop: await dpopProof() })).resolves.toEqual({
      userId: USER_ID,
      deviceJkt,
      expiresAtSeconds: NOW + 3600,
    });
  });

  it("refuses a stolen credential presented with the thief's own device key", async () => {
    // Without the cnf.jkt binding the credential degrades to a bearer token:
    // this proof is perfectly formed (correct typ/alg/htu/htm/iat, and an
    // `ath` over the credential actually being presented) and signed by a key
    // the host has never seen. Only the sender-constraint can reject it.
    await expect(verify({ dpop: await dpopProof({ signer: otherDevice }) })).rejects.toThrow(
      /does not match credential cnf\.jkt/,
    );
  });

  it("refuses a proof whose ath hashes a different credential", async () => {
    // `ath` pins one proof to one credential. Without it a proof captured
    // alongside credential A is replayable against credential B held by the
    // same device key.
    const otherCredential = (await mint()).credential;
    expect(otherCredential).not.toBe(credential);
    await expect(
      verify({ dpop: await dpopProof({ ath: credentialHash(otherCredential) }) }),
    ).rejects.toThrow(/DPoP claims are invalid/);
  });

  it("refuses a replayed proof against a shared replay cache", async () => {
    const replayCache = new JwtReplayCache();
    const dpop = await dpopProof();
    await expect(verify({ dpop, replayCache })).resolves.toMatchObject({ userId: USER_ID });
    await expect(verify({ dpop, replayCache })).rejects.toThrow(/already been used/);
  });

  it.each([
    ["htu naming another endpoint", { htu: "synara://other" }],
    ["htm naming another method", { htm: "GET" }],
  ])("refuses a proof harvested from another operation: %s", async (_label, overrides) => {
    // htu/htm bind a proof to one endpoint and method; without them a proof
    // minted for any other DPoP-protected call authorizes a session.
    await expect(verify({ dpop: await dpopProof(overrides) })).rejects.toThrow(
      /DPoP claims are invalid/,
    );
  });

  it("refuses a proof one second past the freshness window", async () => {
    // DPoP proofs carry no exp, so this window is their entire lifetime.
    await expect(verify({ dpop: await dpopProof(), nowSeconds: NOW + 60 + 1 })).rejects.toThrow(
      /DPoP claims are invalid/,
    );
  });

  it("refuses a proof issued one second past the freshness window in the future", async () => {
    await expect(verify({ dpop: await dpopProof({ iat: NOW + 60 + 1 }) })).rejects.toThrow(
      /DPoP claims are invalid/,
    );
  });

  it("accepts a proof at exactly the freshness boundary", async () => {
    await expect(
      verify({ dpop: await dpopProof(), nowSeconds: NOW + CLOCK_TOLERANCE_SECONDS }),
    ).resolves.toMatchObject({ userId: USER_ID });
  });
});
