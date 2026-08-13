/**
 * Device identity: the client half of the host-auth handshake.
 *
 * A device proves who it is with a keypair that never leaves the platform
 * keystore. Every proof this module mints — registration, DPoP, mint request —
 * is signed by that key, so the shapes have to match the verifiers in
 * `apps/api` and (Slice C) the host byte for byte. The claim schemas and `typ`
 * strings live in `@synara/contracts`; nothing here redefines them.
 *
 * Environment-agnostic on purpose: the browser, the Electron renderer, the
 * desktop main process and Node tests all run this same code, so it touches
 * only `globalThis.crypto` (WebCrypto) and `jose`. No `node:crypto`.
 *
 * ES256 (ECDSA P-256) rather than Ed25519, because neither the Secure Enclave
 * nor WebCrypto can do Ed25519. Slice A's device registry accepts either, and
 * the signing algorithm here is derived from the JWK so an EdDSA device key
 * from some future platform keystore still works.
 *
 * @module deviceKey
 */

import {
  DEVICE_REGISTER_JWT_TYP,
  DEVICE_REGISTER_MAX_AGE_SECONDS,
  DPOP_JWT_TYP,
  MINT_REQUEST_JWT_TYP,
  MINT_REQUEST_MAX_AGE_SECONDS,
  SYNARA_DEVICE_ISSUER,
  type AccountDevicePlatform,
  type DevicePublicKeyJwk,
  type Es256PublicKeyJwk,
} from "@synara/contracts";
import { base64url, calculateJwkThumbprint, SignJWT, type JWK } from "jose";

/**
 * WebCrypto generation parameters. Exported so a platform keystore that mints
 * the key itself (Secure Enclave, TPM) can be checked against the same curve.
 */
export const DEVICE_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
export const DEVICE_KEY_JWS_ALGORITHM = "ES256" as const;

/** Audience of everything addressed to one host: `synara-host:<environmentId>`. */
export function hostAudience(environmentId: string): string {
  return `synara-host:${environmentId}`;
}

/**
 * A device key is used only for signing, so callers may hand over either the
 * generated pair or just the private half (a keystore handle, for instance).
 */
export type DeviceSigningKey = CryptoKey | CryptoKeyPair;

function privateKeyOf(key: DeviceSigningKey): CryptoKey {
  return "privateKey" in key ? key.privateKey : key;
}

function publicKeyOf(key: CryptoKey | CryptoKeyPair): CryptoKey {
  return "publicKey" in key ? key.publicKey : key;
}

/**
 * Generate the device keypair.
 *
 * `extractable: false` applies to the private key only — WebCrypto always
 * leaves the public half exportable, which is what {@link exportPublicJwk}
 * needs. A non-extractable private key cannot be read back out of the browser
 * or copied to another device, which is the whole point: possession of the key
 * *is* the device's identity.
 */
export async function generateDeviceKey(): Promise<CryptoKeyPair> {
  return (await globalThis.crypto.subtle.generateKey(DEVICE_KEY_ALGORITHM, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

/**
 * The public JWK exactly as `DeviceRegisterClaims.publicKeyJwk` expects it.
 *
 * WebCrypto's export carries `ext`, `key_ops` and `alg` alongside the key
 * material. Those are stripped: the API persists this object verbatim and
 * thumbprints it, and an RFC 7638 thumbprint is only defined over the required
 * members — carrying the extras invites a JWK that hashes one way here and
 * another way somewhere that normalized first.
 */
export async function exportPublicJwk(key: CryptoKey | CryptoKeyPair): Promise<Es256PublicKeyJwk> {
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", publicKeyOf(key));
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("Device key is not an ECDSA P-256 key");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/**
 * RFC 7638 JWK thumbprint (SHA-256, base64url) — the `jkt` the account API
 * stores, the grant's `cnf.jkt`, and the identifier a host matches a mint
 * request against.
 *
 * Delegated to jose rather than reimplemented: `apps/api` derives its `jkt`
 * with the very same call, and two hand-rolled canonicalizations that disagree
 * on one byte would reject every grant with an error that points nowhere.
 */
export async function deviceThumbprint(jwk: DevicePublicKeyJwk): Promise<string> {
  return calculateJwkThumbprint(jwk as JWK, "sha256");
}

/** ES256 for EC device keys, EdDSA for OKP — mirrors the API's verifier. */
function jwsAlgorithmFor(jwk: DevicePublicKeyJwk): string {
  return jwk.kty === "EC" ? DEVICE_KEY_JWS_ALGORITHM : "EdDSA";
}

/**
 * UUIDv4 for the `jti` claim. `crypto.randomUUID` is absent in insecure
 * browser contexts; `getRandomValues` is guaranteed wherever `subtle` is, so
 * the fallback costs nothing and removes a whole class of "works everywhere
 * except this one embed" bug.
 */
function newJti(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  // Version 4, variant 10xx, per RFC 4122 §4.4.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Timing knobs shared by every proof.
 *
 * `lifetimeSeconds` is clamped to the contract's cap rather than validated:
 * a client that mints a proof one second over the cap gets a token every
 * verifier rejects, and the failure surfaces as an opaque 401 long after the
 * mistake. Clamping keeps the proof valid and the caller's intent ("as long as
 * allowed") satisfied.
 */
export interface ProofTiming {
  readonly nowSeconds?: number;
  readonly lifetimeSeconds?: number;
}

interface ProofWindow {
  readonly iat: number;
  readonly exp: number;
}

function proofWindow(timing: ProofTiming, capSeconds: number): ProofWindow {
  const iat = Math.floor(timing.nowSeconds ?? Date.now() / 1000);
  const requested = timing.lifetimeSeconds ?? capSeconds;
  const lifetime = Math.min(Math.max(Math.floor(requested), 1), capSeconds);
  return { iat, exp: iat + lifetime };
}

export interface DeviceRegistrationInput extends ProofTiming {
  readonly key: DeviceSigningKey;
  readonly publicJwk: DevicePublicKeyJwk;
  readonly userId: string;
  readonly displayName: string;
  readonly platform: AccountDevicePlatform;
  /** The account API's issuer string (`API_PUBLIC_URL`). */
  readonly audience: string;
}

/**
 * `synara-device-register+jwt` — proof of possession for `POST /devices`.
 *
 * Trust-on-first-use: the API has never seen this key, so the proof carries
 * the public JWK and is verified against it, then thumbprinted into the `jkt`
 * the device is known by from then on.
 */
export async function signDeviceRegistration(input: DeviceRegistrationInput): Promise<string> {
  const { iat, exp } = proofWindow(input, DEVICE_REGISTER_MAX_AGE_SECONDS);
  return new SignJWT({
    publicKeyJwk: input.publicJwk,
    displayName: input.displayName,
    platform: input.platform,
  })
    .setProtectedHeader({
      alg: jwsAlgorithmFor(input.publicJwk),
      typ: DEVICE_REGISTER_JWT_TYP,
    })
    .setIssuer(SYNARA_DEVICE_ISSUER)
    .setSubject(input.userId)
    .setAudience(input.audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(newJti())
    .sign(privateKeyOf(input.key));
}

/**
 * RFC 9449 `htu`: the target URI with query and fragment removed.
 *
 * Built from protocol + host + path rather than `URL.origin` because the
 * relay is dialed over `wss:` and `origin` is only reliably a tuple for the
 * http(s) schemes.
 */
export function dpopHttpUri(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/** base64url(SHA-256(credential)) — RFC 9449's `ath` claim. */
export async function credentialHash(credential: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(credential),
  );
  return base64url.encode(new Uint8Array(digest));
}

export interface DpopProofInput extends Pick<ProofTiming, "nowSeconds"> {
  readonly key: DeviceSigningKey;
  readonly publicJwk: DevicePublicKeyJwk;
  readonly method: string;
  readonly url: string;
  /**
   * The session credential this proof is presented with. Omit it only for the
   * one handshake that has no credential yet (the mint request); note that
   * `DpopProofClaims` requires `ath`, so a proof minted without one is
   * deliberately outside that schema.
   */
  readonly accessToken?: string;
}

/**
 * RFC 9449 DPoP proof.
 *
 * No `exp`: DPoP proofs are bounded by `iat` plus the verifier's acceptance
 * window, and the public key travels in the `jwk` header parameter, which is
 * what binds the proof to the credential's `cnf.jkt`.
 */
export async function signDpopProof(input: DpopProofInput): Promise<string> {
  const iat = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const claims: Record<string, unknown> = {
    htu: dpopHttpUri(input.url),
    htm: input.method.toUpperCase(),
    jti: newJti(),
    iat,
  };
  if (input.accessToken !== undefined) {
    claims.ath = await credentialHash(input.accessToken);
  }
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: jwsAlgorithmFor(input.publicJwk),
      typ: DPOP_JWT_TYP,
      jwk: input.publicJwk as JWK,
    })
    .sign(privateKeyOf(input.key));
}

export interface MintRequestInput extends ProofTiming {
  readonly key: DeviceSigningKey;
  readonly publicJwk: DevicePublicKeyJwk;
  readonly userId: string;
  /** The API-issued `synara-grant+jwt`, echoed whole. */
  readonly grant: string;
  readonly environmentId: string;
}

/**
 * `synara-mint-request+jwt` — asks a host to mint a session credential.
 *
 * The grant is echoed verbatim rather than summarized: the host verifies the
 * grant's own signature against the API's JWKS, so anything this client says
 * about it is untrusted. What the request adds is proof that the device
 * holding the grant's `cnf.jkt` is the one asking.
 */
export async function signMintRequest(input: MintRequestInput): Promise<string> {
  const { iat, exp } = proofWindow(input, MINT_REQUEST_MAX_AGE_SECONDS);
  return new SignJWT({ publicKeyJwk: input.publicJwk, grant: input.grant })
    .setProtectedHeader({
      alg: jwsAlgorithmFor(input.publicJwk),
      typ: MINT_REQUEST_JWT_TYP,
    })
    .setIssuer(SYNARA_DEVICE_ISSUER)
    .setSubject(input.userId)
    .setAudience(hostAudience(input.environmentId))
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(newJti())
    .sign(privateKeyOf(input.key));
}
