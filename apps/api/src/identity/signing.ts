import type { ApiJwks, ApiSigningPublicJwk, DevicePublicKeyJwk } from "@synara/contracts";
import { JWT_CLOCK_TOLERANCE_SECONDS } from "@synara/contracts";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  importJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";

export type JwtVerificationKey = CryptoKey | KeyObject | JWK | Uint8Array | JWTVerifyGetKey;

export type BoundedJwtOptions = {
  typ: string;
  audience: string;
  issuer?: string;
  algorithms: readonly string[];
  maxAgeSeconds: number;
  now?: number;
};

function assertProtectedHeader(token: string, typ: string, algorithms: readonly string[]): void {
  const header = decodeProtectedHeader(token);
  if (header.typ !== typ) throw new Error(`JWT typ must be ${typ}`);
  if (typeof header.alg !== "string" || !algorithms.includes(header.alg)) {
    throw new Error("JWT signing algorithm is not allowed");
  }
}

function assertBoundedLifetime(
  payload: JWTPayload,
  maxAgeSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    throw new Error("JWT requires integer iat and exp claims");
  }
  const issuedAt = payload.iat as number;
  const expiresAt = payload.exp as number;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxAgeSeconds) {
    throw new Error("JWT lifetime exceeds its allowed bound");
  }
  if (issuedAt > nowSeconds + JWT_CLOCK_TOLERANCE_SECONDS) {
    throw new Error("JWT iat is too far in the future");
  }
  // jose honors a token until exp + clockTolerance, which on a 60s proof adds
  // another minute of replay window on top of the forward-stamping the iat
  // tolerance already allows (~3x the intended window in the worst case).
  // Skew tolerance belongs on the not-yet-valid side; an expired short-lived
  // proof is simply expired.
  if (expiresAt < nowSeconds) {
    throw new Error("JWT has expired");
  }
}

/** Verifies signature/registered claims, then applies the spec's lifetime cap. */
export async function verifyBoundedJwt(
  token: string,
  key: JwtVerificationKey,
  options: BoundedJwtOptions,
) {
  assertProtectedHeader(token, options.typ, options.algorithms);
  const verificationOptions = {
    audience: options.audience,
    ...(options.issuer ? { issuer: options.issuer } : {}),
    algorithms: [...options.algorithms],
    clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
    ...(options.now === undefined ? {} : { currentDate: new Date(options.now * 1000) }),
  };
  // jose overloads jwtVerify on key vs getKey; the union needs one cast.
  const verified = await jwtVerify(
    token,
    key as Parameters<typeof jwtVerify>[1],
    verificationOptions,
  );
  assertBoundedLifetime(verified.payload, options.maxAgeSeconds, options.now);
  return verified;
}

/** TOFU/device-PoP verification against the public JWK carried by the claim. */
export async function verifyJwtWithEmbeddedJwk(
  token: string,
  options: BoundedJwtOptions & { publicKeyJwk: DevicePublicKeyJwk },
) {
  const expectedAlgorithm = options.publicKeyJwk.kty === "EC" ? "ES256" : "EdDSA";
  if (!options.algorithms.includes(expectedAlgorithm)) {
    throw new Error("Embedded JWK algorithm is not allowed");
  }
  const key = await importJWK(options.publicKeyJwk as JWK, expectedAlgorithm);
  return verifyBoundedJwt(token, key, {
    ...options,
    algorithms: [expectedAlgorithm],
  });
}

export async function publicJwkThumbprint(jwk: DevicePublicKeyJwk): Promise<string> {
  return calculateJwkThumbprint(jwk as JWK, "sha256");
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function decodeSeed(seed: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(seed)) throw new Error("API signing key is not base64url");
  const bytes = Buffer.from(seed, "base64url");
  if (bytes.length !== 32) throw new Error("API signing key must decode to exactly 32 bytes");
  return bytes;
}

function pkcs8PemForSeed(seed: string): string {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, decodeSeed(seed)]);
  const encoded =
    der
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

async function importApiKey(seed: string): Promise<{
  privateKey: CryptoKey;
  publicJwk: ApiSigningPublicJwk;
}> {
  const privateKey = await importPKCS8(pkcs8PemForSeed(seed), "EdDSA", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  if (privateJwk.kty !== "OKP" || privateJwk.crv !== "Ed25519" || !privateJwk.x) {
    throw new Error("Imported API signing key is not Ed25519");
  }
  const thumbprintInput = { kty: "OKP", crv: "Ed25519", x: privateJwk.x } as const;
  const kid = await calculateJwkThumbprint(thumbprintInput, "sha256");
  return {
    privateKey,
    publicJwk: { ...thumbprintInput, kid, alg: "EdDSA", use: "sig" },
  };
}

export type ApiSigningService = {
  issuer: string;
  currentKid: string;
  jwks: ApiJwks;
  sign(input: {
    typ: string;
    audience: string;
    subject: string;
    expiresInSeconds: number;
    claims?: JWTPayload;
  }): Promise<string>;
  /**
   * Verifies a token this service issued. The issuer is pinned to our own
   * configured issuer and is deliberately NOT a caller option: two
   * deployments sharing a signing seed must not accept each other's tokens
   * because a call site forgot to pass it.
   */
  verify(
    token: string,
    options: Omit<BoundedJwtOptions, "algorithms" | "issuer">,
  ): Promise<JWTPayload>;
};

export async function createApiSigningService(input: {
  issuer: string;
  seed: string;
  previousSeed?: string;
}): Promise<ApiSigningService> {
  const current = await importApiKey(input.seed);
  const previous = input.previousSeed ? await importApiKey(input.previousSeed) : undefined;
  if (previous?.publicJwk.kid === current.publicJwk.kid) {
    throw new Error("API_SIGNING_KEY_PREVIOUS must differ from API_SIGNING_KEY");
  }
  const jwks: ApiJwks = {
    keys: [current.publicJwk, ...(previous ? [previous.publicJwk] : [])],
  };
  const localJwks = createLocalJWKSet(jwks as JSONWebKeySet);

  return {
    issuer: input.issuer,
    currentKid: current.publicJwk.kid,
    jwks,
    async sign({ typ, audience, subject, expiresInSeconds, claims = {} }) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA", typ, kid: current.publicJwk.kid })
        .setIssuer(input.issuer)
        .setSubject(subject)
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + expiresInSeconds)
        .setJti(randomUUID())
        .sign(current.privateKey);
    },
    async verify(token, options) {
      return (
        await verifyBoundedJwt(token, localJwks, {
          ...options,
          issuer: input.issuer,
          algorithms: ["EdDSA"],
        })
      ).payload;
    },
  };
}
