import { randomUUID } from "node:crypto";

import {
  HOST_LINK_JWT_TYP,
  HOST_LINK_MAX_AGE_SECONDS,
  HOST_PROOF_JWT_TYP,
  HOST_PROOF_MAX_AGE_SECONDS,
  type AccountHostPlatform,
} from "@synara/contracts";
import { importPKCS8, SignJWT } from "jose";

import type { HostIdentity } from "./store";

async function signingKey(identity: HostIdentity): Promise<CryptoKey> {
  return importPKCS8(identity.privateKeyPem, "EdDSA");
}

function hostIssuer(environmentId: string): string {
  return `synara-host:${environmentId}`;
}

export async function mintHostLinkProof(input: {
  readonly identity: HostIdentity;
  readonly apiIssuer: string;
  readonly environmentId: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly name: string;
  readonly platform: AccountHostPlatform;
  readonly appVersion?: string;
  readonly nowSeconds?: number;
}): Promise<string> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  return new SignJWT({
    challengeId: input.challengeId,
    nonce: input.nonce,
    publicKeyJwk: input.identity.publicKeyJwk,
    name: input.name,
    platform: input.platform,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
  })
    .setProtectedHeader({ alg: "EdDSA", typ: HOST_LINK_JWT_TYP })
    .setIssuer(hostIssuer(input.environmentId))
    .setSubject(input.environmentId)
    .setAudience(input.apiIssuer)
    .setIssuedAt(now)
    .setExpirationTime(now + HOST_LINK_MAX_AGE_SECONDS)
    .setJti(randomUUID())
    .sign(await signingKey(input.identity));
}

export async function mintHostProof(input: {
  readonly identity: HostIdentity;
  readonly apiIssuer: string;
  readonly environmentId: string;
  readonly hostId: string;
  readonly keyGeneration: number;
  readonly nowSeconds?: number;
}): Promise<string> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  return new SignJWT({ keyGeneration: input.keyGeneration })
    .setProtectedHeader({ alg: "EdDSA", typ: HOST_PROOF_JWT_TYP })
    .setIssuer(hostIssuer(input.environmentId))
    .setSubject(input.hostId)
    .setAudience(input.apiIssuer)
    .setIssuedAt(now)
    .setExpirationTime(now + HOST_PROOF_MAX_AGE_SECONDS)
    .setJti(randomUUID())
    .sign(await signingKey(input.identity));
}
