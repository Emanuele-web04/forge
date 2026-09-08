import { createHash } from "node:crypto";

import {
  DpopProofWithCredentialClaims,
  DPOP_JWT_TYP,
  HOST_CONNECT_SCOPE,
  JWT_CLOCK_TOLERANCE_SECONDS,
  SessionCredentialClaims,
  SESSION_CREDENTIAL_JWT_TYP,
  SESSION_CREDENTIAL_MAX_AGE_SECONDS,
  SYNARA_SESSION_AUDIENCE,
  type DevicePublicKeyJwk,
} from "@synara/contracts";
import { Schema } from "effect";
import { calculateJwkThumbprint, importJWK, importSPKI, jwtVerify, type JWK } from "jose";

import type { HostIdentity } from "../hostIdentity";
import { JwtReplayCache } from "./replayCache";

export interface VerifiedSessionCredential {
  readonly userId: string;
  readonly deviceJkt: string;
  readonly expiresAtSeconds: number;
}

export async function verifySessionCredential(input: {
  readonly credential: string;
  readonly dpop: string;
  readonly identity: HostIdentity;
  readonly environmentId: string;
  readonly keyGeneration: number;
  readonly expectedHtu: string;
  readonly expectedHtm: string;
  readonly replayCache?: JwtReplayCache;
  readonly nowSeconds?: number;
}): Promise<VerifiedSessionCredential> {
  const verifiedCredential = await jwtVerify(
    input.credential,
    await importSPKI(input.identity.publicKeyPem, "EdDSA"),
    {
      algorithms: ["EdDSA"],
      audience: SYNARA_SESSION_AUDIENCE,
      issuer: `synara-host:${input.environmentId}`,
      typ: SESSION_CREDENTIAL_JWT_TYP,
      clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
    },
  );
  const credential = Schema.decodeUnknownSync(SessionCredentialClaims)(verifiedCredential.payload);
  if (
    credential.exp <= credential.iat ||
    credential.exp - credential.iat > SESSION_CREDENTIAL_MAX_AGE_SECONDS ||
    credential.keyGeneration !== input.keyGeneration ||
    credential.scope[0] !== HOST_CONNECT_SCOPE
  ) {
    throw new Error("session credential claims are invalid");
  }

  const headerPart = input.dpop.split(".")[0];
  if (!headerPart) throw new Error("DPoP proof is not a compact JWT");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as {
    alg?: unknown;
    typ?: unknown;
    jwk?: unknown;
  };
  const jwk = Schema.decodeUnknownSync(
    Schema.Union([
      Schema.Struct({
        kty: Schema.Literal("OKP"),
        crv: Schema.Literal("Ed25519"),
        x: Schema.String,
      }),
      Schema.Struct({
        kty: Schema.Literal("EC"),
        crv: Schema.Literal("P-256"),
        x: Schema.String,
        y: Schema.String,
      }),
    ]),
  )(header.jwk) as DevicePublicKeyJwk;
  const algorithm = jwk.kty === "EC" ? "ES256" : "EdDSA";
  if (header.typ !== DPOP_JWT_TYP || header.alg !== algorithm) {
    throw new Error("DPoP protected header is invalid");
  }
  const jkt = await calculateJwkThumbprint(jwk as JWK, "sha256");
  if (jkt !== credential.cnf.jkt) throw new Error("DPoP key does not match credential cnf.jkt");
  const verifiedDpop = await jwtVerify(
    input.dpop,
    (await importJWK(jwk as JWK, algorithm)) as CryptoKey,
    { algorithms: [algorithm], typ: DPOP_JWT_TYP },
  );
  const dpop = Schema.decodeUnknownSync(DpopProofWithCredentialClaims)(verifiedDpop.payload);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (
    dpop.htu !== input.expectedHtu ||
    dpop.htm !== input.expectedHtm ||
    Math.abs(now - dpop.iat) > JWT_CLOCK_TOLERANCE_SECONDS ||
    dpop.ath !== createHash("sha256").update(input.credential).digest("base64url")
  ) {
    throw new Error("DPoP claims are invalid");
  }
  input.replayCache?.consume(dpop.jti, now + JWT_CLOCK_TOLERANCE_SECONDS, now);
  return {
    userId: credential.sub,
    deviceJkt: credential.cnf.jkt,
    expiresAtSeconds: credential.exp,
  };
}
