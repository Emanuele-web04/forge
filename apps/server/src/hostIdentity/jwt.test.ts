import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HOST_LINK_JWT_TYP,
  HOST_LINK_MAX_AGE_SECONDS,
  HOST_PROOF_JWT_TYP,
  HOST_PROOF_MAX_AGE_SECONDS,
  HostLinkClaims,
  HostProofClaims,
} from "@synara/contracts";
import { Schema } from "effect";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { mintHostLinkProof, mintHostProof } from "./jwt";
import { generateAndPersistHostIdentity, hostIdentityPath } from "./store";

const roots: string[] = [];

async function identity() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-host-jwt-"));
  roots.push(root);
  return generateAndPersistHostIdentity(hostIdentityPath(path.join(root, "secrets")));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("host JWT minting", () => {
  it("mints an exact bounded synara-host-link+jwt proof", async () => {
    const keypair = await identity();
    const now = 1_786_640_000;
    const token = await mintHostLinkProof({
      identity: keypair,
      apiIssuer: "https://api.example.test",
      environmentId: "1bf09f13-24ff-4a10-bd79-ff8be153b593",
      challengeId: "b9f2d8f1-03c4-4678-bf1e-a9915245f9da",
      nonce: "nonce_value",
      name: "build-host",
      platform: "linux",
      appVersion: "0.7.1",
      nowSeconds: now,
    });

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", typ: HOST_LINK_JWT_TYP });
    const publicKey = await importJWK(keypair.publicKeyJwk, "EdDSA");
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: "synara-host:1bf09f13-24ff-4a10-bd79-ff8be153b593",
      audience: "https://api.example.test",
      currentDate: new Date(now * 1_000),
    });
    const claims = Schema.decodeUnknownSync(HostLinkClaims)(payload);
    expect(claims).toMatchObject({
      sub: "1bf09f13-24ff-4a10-bd79-ff8be153b593",
      challengeId: "b9f2d8f1-03c4-4678-bf1e-a9915245f9da",
      nonce: "nonce_value",
      publicKeyJwk: keypair.publicKeyJwk,
      name: "build-host",
      platform: "linux",
      appVersion: "0.7.1",
      iat: now,
      exp: now + HOST_LINK_MAX_AGE_SECONDS,
    });
  });

  it("mints a HostProof with the exact host id, key generation, and 60 second cap", async () => {
    const keypair = await identity();
    const now = 1_786_640_000;
    const token = await mintHostProof({
      identity: keypair,
      apiIssuer: "https://api.example.test",
      environmentId: "1bf09f13-24ff-4a10-bd79-ff8be153b593",
      hostId: "7175ad5d-d6f7-40ee-9c3a-b93f812a75d8",
      keyGeneration: 4,
      nowSeconds: now,
    });

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", typ: HOST_PROOF_JWT_TYP });
    const publicKey = await importJWK(keypair.publicKeyJwk, "EdDSA");
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: "synara-host:1bf09f13-24ff-4a10-bd79-ff8be153b593",
      audience: "https://api.example.test",
      currentDate: new Date(now * 1_000),
    });
    expect(Schema.decodeUnknownSync(HostProofClaims)(payload)).toMatchObject({
      sub: "7175ad5d-d6f7-40ee-9c3a-b93f812a75d8",
      keyGeneration: 4,
      iat: now,
      exp: now + HOST_PROOF_MAX_AGE_SECONDS,
    });
  });
});
