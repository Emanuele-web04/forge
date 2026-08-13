import { randomUUID } from "node:crypto";

import {
  GrantClaims,
  GRANT_JWT_TYP,
  GRANT_MAX_AGE_SECONDS,
  HOST_CONNECT_SCOPE,
  JWT_CLOCK_TOLERANCE_SECONDS,
  MintRequestClaims,
  MINT_REQUEST_JWT_TYP,
  MINT_REQUEST_MAX_AGE_SECONDS,
  SESSION_CREDENTIAL_JWT_TYP,
  SESSION_CREDENTIAL_MAX_AGE_SECONDS,
  SYNARA_DEVICE_ISSUER,
  SYNARA_RELAY_AUDIENCE,
  SYNARA_SESSION_AUDIENCE,
  type ApiJwks,
  type DevicePublicKeyJwk,
  type GrantClaims as GrantClaimsType,
  type HostAuthorizationSnapshot,
} from "@synara/contracts";
import { Schema } from "effect";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  errors,
  importJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTHeaderParameters,
} from "jose";

import type { HostIdentity } from "../hostIdentity";
import { JwtReplayCache } from "./replayCache";

/** jose's unknown-kid signal, matching the relay's detection. */
function isUnknownKidError(error: unknown): boolean {
  return (
    error instanceof errors.JWKSNoMatchingKey ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ERR_JWKS_NO_MATCHING_KEY")
  );
}

export class HostMintError extends Error {
  constructor(
    readonly code: "invalid_grant" | "invalid_mint_request" | "not_authorized",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostMintError";
  }
}

function assertBoundedLifetime(
  claims: { iat: number; exp: number },
  maximumSeconds: number,
  label: string,
): void {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maximumSeconds) {
    throw new Error(`${label} lifetime exceeds ${maximumSeconds}s`);
  }
}

function hostIssuer(environmentId: string): string {
  return `synara-host:${environmentId}`;
}

async function deviceVerificationKey(jwk: DevicePublicKeyJwk): Promise<CryptoKey> {
  return importJWK(jwk as JWK, jwk.kty === "EC" ? "ES256" : "EdDSA") as Promise<CryptoKey>;
}

function assertDeviceHeader(header: JWTHeaderParameters, jwk: DevicePublicKeyJwk): void {
  const expectedAlgorithm = jwk.kty === "EC" ? "ES256" : "EdDSA";
  if (header.typ !== MINT_REQUEST_JWT_TYP || header.alg !== expectedAlgorithm) {
    throw new Error("mint request protected header is invalid");
  }
}

export interface HostMintServiceOptions {
  readonly identity: HostIdentity;
  readonly apiIssuer: string;
  readonly environmentId: string;
  readonly hostId: string;
  readonly keyGeneration: number;
  readonly getApiJwks: () => Promise<ApiJwks>;
  /** Forced refetch when a grant names a kid we do not hold (key rotation). */
  readonly refreshApiJwksForUnknownKid?: () => Promise<ApiJwks | undefined>;
  readonly getAuthorization: () => Promise<HostAuthorizationSnapshot>;
  readonly replayCache?: JwtReplayCache;
  readonly nowSeconds?: () => number;
}

export interface MintedSessionCredential {
  readonly credential: string;
  readonly userId: string;
  readonly deviceJkt: string;
  readonly expiresAtSeconds: number;
}

export class HostMintService {
  readonly #replays: JwtReplayCache;

  constructor(readonly options: HostMintServiceOptions) {
    this.#replays = options.replayCache ?? new JwtReplayCache();
  }

  async mint(mintRequestJwt: string): Promise<MintedSessionCredential> {
    let grant: GrantClaimsType;
    let grantJwt: string;
    let deviceJkt: string;
    try {
      const unverifiedParts = mintRequestJwt.split(".");
      if (unverifiedParts.length !== 3) throw new Error("mint request is not a compact JWT");
      const unverifiedPayload = JSON.parse(
        Buffer.from(unverifiedParts[1] ?? "", "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const publicKeyJwk = Schema.decodeUnknownSync(MintRequestClaims.fields.publicKeyJwk)(
        unverifiedPayload.publicKeyJwk,
      );
      const mintVerified = await jwtVerify(
        mintRequestJwt,
        await deviceVerificationKey(publicKeyJwk),
        {
          algorithms: [publicKeyJwk.kty === "EC" ? "ES256" : "EdDSA"],
          audience: hostIssuer(this.options.environmentId),
          issuer: SYNARA_DEVICE_ISSUER,
          clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
        },
      );
      assertDeviceHeader(mintVerified.protectedHeader, publicKeyJwk);
      const mint = Schema.decodeUnknownSync(MintRequestClaims)(mintVerified.payload);
      assertBoundedLifetime(mint, MINT_REQUEST_MAX_AGE_SECONDS, "mint request");
      grantJwt = mint.grant;
      deviceJkt = await calculateJwkThumbprint(publicKeyJwk as JWK, "sha256");

      const verifyGrant = async (jwks: ApiJwks) =>
        jwtVerify(
          grantJwt as string,
          createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]),
          {
            algorithms: ["EdDSA"],
            audience: SYNARA_RELAY_AUDIENCE,
            issuer: this.options.apiIssuer,
            typ: GRANT_JWT_TYP,
            clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
          },
        );
      let grantVerified: Awaited<ReturnType<typeof verifyGrant>>;
      try {
        grantVerified = await verifyGrant(await this.options.getApiJwks());
      } catch (cause) {
        // An unknown `kid` means the API rotated its signing key. Without a
        // forced refetch every mint fails until the periodic refresh window
        // elapses — a total outage of remote access after a routine rotation.
        const rotated =
          isUnknownKidError(cause) && (await this.options.refreshApiJwksForUnknownKid?.());
        if (!rotated) throw cause;
        grantVerified = await verifyGrant(rotated);
      }
      grant = Schema.decodeUnknownSync(GrantClaims)(grantVerified.payload);
      assertBoundedLifetime(grant, GRANT_MAX_AGE_SECONDS, "grant");
      if (
        grant.hostId !== this.options.hostId ||
        grant.environmentId !== this.options.environmentId ||
        grant.sub !== mint.sub ||
        grant.cnf.jkt !== deviceJkt
      ) {
        throw new Error("grant is not bound to this host, user, and device key");
      }

      const authorization = await this.options.getAuthorization();
      const owner = grant.sub === authorization.ownerUserId;
      if (!owner && (!authorization.discoverable || !authorization.ownerInOrg)) {
        throw new HostMintError("not_authorized", "user is no longer authorized for this host");
      }

      this.#replays.consume(
        grant.jti,
        grant.exp,
        this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1_000),
      );
    } catch (cause) {
      if (cause instanceof HostMintError) throw cause;
      const message = cause instanceof Error ? cause.message : "invalid mint request";
      const code =
        message.includes("grant") || message.includes("jti")
          ? "invalid_grant"
          : "invalid_mint_request";
      throw new HostMintError(code, message, { cause });
    }

    const now = this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1_000);
    const expiresAtSeconds = now + SESSION_CREDENTIAL_MAX_AGE_SECONDS;
    const credential = await new SignJWT({
      cnf: { jkt: deviceJkt },
      keyGeneration: this.options.keyGeneration,
      scope: [HOST_CONNECT_SCOPE],
    })
      .setProtectedHeader({ alg: "EdDSA", typ: SESSION_CREDENTIAL_JWT_TYP })
      .setIssuer(hostIssuer(this.options.environmentId))
      .setSubject(grant.sub)
      .setAudience(SYNARA_SESSION_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(expiresAtSeconds)
      .setJti(randomUUID())
      .sign(await importPKCS8(this.options.identity.privateKeyPem, "EdDSA"));
    return { credential, userId: grant.sub, deviceJkt, expiresAtSeconds };
  }
}
