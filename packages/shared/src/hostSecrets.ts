// FILE: hostSecrets.ts
// Purpose: The client-side cryptographic core of Host Secrets sync (ADR 0004,
// ADR 0015). Per-host configuration — SSH destination, launcher config,
// host-key verification policy — syncs across the owner's devices through the
// account service, which stores opaque bytes and can never read them.
//
// Everything here runs on WebCrypto through `globalThis.crypto.subtle` and
// nothing else. The same code has to execute in a browser tab, an Electron
// renderer, and Node/bun under vitest; reaching for `node:crypto` would fork
// the implementation and, worse, let the two forks disagree about a byte
// layout that ciphertext already in the database depends on.

import { DEVICE_USER_CODE_ALPHABET } from "@synara/contracts";

/**
 * Why an envelope carries a version at all: the account service does
 * compare-and-swap on it (spec §3), and this module binds it into the AEAD's
 * additional data, so a stale ciphertext replayed at a newer version fails to
 * open rather than silently reviving old config.
 */
export const HOST_SECRET_INITIAL_VERSION = 1;

/** AES-GCM's standard IV width. Fresh random bytes per write, never a counter. */
export const HOST_SECRET_IV_BYTES = 12;

/** Bits of the SHA-256 pairing transcript a user is asked to compare. */
export const PAIRING_VERIFICATION_CODE_LENGTH = 6;

const SYNC_KEY_BITS = 256;
const GCM_TAG_BITS = 128;
const P256_COORDINATE_BYTES = 32;

/**
 * Domain separators. Every hash and KDF invocation in this module is prefixed
 * with one, so a digest computed for pairing can never be mistaken for — or
 * substituted into — the key-derivation transcript, and vice versa.
 */
const SEAL_AAD_DOMAIN = "synara.hostSecret.aad.v1";
const PAIRING_KDF_DOMAIN = "synara.hostSecrets.pairing.kdf.v1";
const PAIRING_CODE_DOMAIN = "synara.hostSecrets.pairing.code.v1";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Why every failure funnels through one class with a coarse `reason`: an
 * attacker who can feed this module candidate envelopes must learn nothing
 * from the error beyond "it did not open". Wrong host, wrong owner, wrong
 * version, flipped byte, and wrong key are all `open-failed` with the same
 * message — distinguishing them would turn a rejection into an oracle for
 * which field was wrong.
 */
export class HostSecretsError extends Error {
  readonly reason: "invalid-input" | "open-failed" | "unwrap-failed";

  constructor(reason: HostSecretsError["reason"], message: string) {
    super(message);
    this.name = "HostSecretsError";
    this.reason = reason;
  }
}

/**
 * The stored form of one host's secrets. Deliberately a plain JSON-safe object
 * so it drops into a `jsonb` column whole, or splits into the spec's
 * `ciphertext bytea` / `nonce bytea` / `version integer` columns via
 * {@link decodeBase64Url} — with no second, divergent codec at the storage
 * layer.
 */
export interface HostSecretEnvelope {
  /** base64url, AES-GCM output with its 16-byte tag appended. */
  readonly ciphertext: string;
  /** base64url, exactly {@link HOST_SECRET_IV_BYTES} random bytes. */
  readonly iv: string;
  /** Monotonic per host; also bound into the AEAD's additional data. */
  readonly version: number;
}

/** A host's envelope alongside the identifiers its ciphertext is bound to. */
export interface HostSecretEntry {
  readonly hostId: string;
  readonly ownerUserId: string;
  readonly envelope: HostSecretEnvelope;
}

/**
 * A P-256 public point in JWK form. Matches `Es256PublicKeyJwk` in
 * `@synara/contracts` structurally on purpose: a device already publishes a
 * P-256 key, and pairing should not introduce a second key shape for the UI
 * and the account service to keep straight.
 */
export interface PairingPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

/** The ephemeral receiving keypair a device generates when it starts pairing. */
export interface PairingKeyPair {
  /** Non-extractable: it only ever needs to derive, never to be copied out. */
  readonly privateKey: CryptoKey;
  readonly publicJwk: PairingPublicJwk;
}

/**
 * The pairing hand-off blob. Travels through the account service
 * (`GET/PUT /sync-key-wraps`), which cannot open it: the Sync Key is wrapped
 * under a key derived from an ECDH shared secret whose private halves never
 * leave the two devices.
 */
export interface WrappedSyncKey {
  /** The sender's single-use ECDH public key; half of the KDF transcript. */
  readonly ephemeralPublicJwk: PairingPublicJwk;
  /** Echoed back so the recipient can rebuild the exact transcript. */
  readonly recipientPublicJwk: PairingPublicJwk;
  /** base64url AES-KW output over the 32-byte Sync Key. */
  readonly wrapped: string;
}

/**
 * Bytes backed by a plain `ArrayBuffer`, which is what every `BufferSource`
 * parameter in WebCrypto requires. A bare `Uint8Array` may sit on a
 * `SharedArrayBuffer`, and `subtle` will not touch one — so the narrowing lives
 * in these signatures rather than in a cast at each of the dozen call sites.
 */
type Bytes = Uint8Array<ArrayBuffer>;

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto;
  if (webcrypto?.subtle === undefined) {
    // Reachable in practice: a renderer loaded over plain http is not a secure
    // context and has no `subtle`. Say so, rather than dying on a property read.
    throw new HostSecretsError(
      "invalid-input",
      "WebCrypto is unavailable — Host Secrets require a secure context (https, file, or app scheme).",
    );
  }
  return webcrypto.subtle;
}

function randomBytes(length: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** Encodes to a fresh `ArrayBuffer`-backed view; see {@link Bytes}. */
function utf8(text: string): Bytes {
  return TEXT_ENCODER.encode(text) as Bytes;
}

/**
 * base64url without padding — the encoding every byte string in an envelope
 * uses. Exported as a pair with {@link decodeBase64Url} because storage layers
 * moving envelopes in and out of `bytea` columns need exactly this codec, and
 * a second hand-rolled one is how a padding disagreement corrupts a column.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Strict inverse of {@link encodeBase64Url}. Rejects non-alphabet characters
 * and impossible lengths instead of leaning on `atob`, which quietly accepts
 * some malformed inputs — a decoder that guesses would let two devices
 * disagree about the bytes behind the same string.
 */
export function decodeBase64Url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new HostSecretsError("invalid-input", "Value is not base64url");
  }
  if (text.length % 4 === 1) {
    throw new HostSecretsError("invalid-input", "Value is not a valid base64url length");
  }
  const padding = "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HostSecretsError("invalid-input", `${field} must be a non-empty string`);
  }
  return value;
}

function requireVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new HostSecretsError("invalid-input", "version must be a non-negative integer");
  }
  return version;
}

/**
 * The AEAD's additional data: the identity this ciphertext is allowed to be.
 * JSON-encoded rather than joined with a separator because a `hostId`
 * containing the separator could otherwise be crafted to produce the same AAD
 * as a different `{hostId, ownerUserId}` pair — JSON escapes the delimiters, so
 * the encoding stays injective.
 */
function hostSecretAad(input: { hostId: string; ownerUserId: string; version: number }): Bytes {
  return utf8(JSON.stringify([SEAL_AAD_DOMAIN, input.hostId, input.ownerUserId, input.version]));
}

/**
 * A 256-bit AES-GCM Sync Key, generated once by the owner's first device.
 *
 * Extractable by necessity, not by preference: `SubtleCrypto.wrapKey` refuses
 * a non-extractable key, and pairing exists precisely to hand this key to a
 * second device ({@link wrapSyncKey}). Rotation ({@link rotateHostSecrets})
 * also has to compare key material to prove it is really rotating.
 *
 * The cost is that anything holding the handle can export the raw bytes, so
 * callers must keep it in a store that is not casually enumerable — IndexedDB
 * via structured clone, or the platform keychain — and must never serialize it
 * into logs, telemetry, or a crash report.
 */
export async function generateSyncKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: SYNC_KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypts one host's secrets under the Sync Key.
 *
 * `secret` must be JSON-serializable. It is typed `unknown` on the way in and
 * out on purpose: the shape of a host's config belongs to `@synara/contracts`,
 * and a module that claimed to return a typed value would be vouching for
 * bytes it merely decrypted. Callers decode the result with a Schema.
 */
export async function sealHostSecret(input: {
  syncKey: CryptoKey;
  hostId: string;
  ownerUserId: string;
  version: number;
  secret: unknown;
}): Promise<HostSecretEnvelope> {
  const hostId = requireIdentifier(input.hostId, "hostId");
  const ownerUserId = requireIdentifier(input.ownerUserId, "ownerUserId");
  const version = requireVersion(input.version);

  const plaintext = utf8(JSON.stringify(input.secret));
  // Fresh per write. AES-GCM catastrophically loses confidentiality if an IV
  // repeats under one key, and the same host config is rewritten often enough
  // (and identically enough) that a derived or counter IV would be a real risk.
  const iv = randomBytes(HOST_SECRET_IV_BYTES);

  const ciphertext = await subtle().encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: hostSecretAad({ hostId, ownerUserId, version }),
      tagLength: GCM_TAG_BITS,
    },
    input.syncKey,
    plaintext,
  );

  return {
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    iv: encodeBase64Url(iv),
    version,
  };
}

/**
 * Decrypts one host's secrets, refusing any ciphertext not sealed for exactly
 * this `{hostId, ownerUserId, version}`.
 *
 * That refusal is the point of the AAD: the account service hands back rows it
 * cannot inspect, so nothing except this check stops a ciphertext lifted from
 * one host row (or another user's row, or an older version) from being replayed
 * into a different one and silently supplying attacker-chosen SSH config.
 */
export async function openHostSecret(input: {
  syncKey: CryptoKey;
  hostId: string;
  ownerUserId: string;
  version: number;
  envelope: HostSecretEnvelope;
}): Promise<unknown> {
  const hostId = requireIdentifier(input.hostId, "hostId");
  const ownerUserId = requireIdentifier(input.ownerUserId, "ownerUserId");
  const version = requireVersion(input.version);

  // `version` is what the caller expects (the row's version column, the one it
  // did compare-and-swap against); `envelope.version` is what the stored blob
  // claims. Only the former is authenticated by the AAD, so a disagreement
  // means the two travelled apart — a mixed-up row, or a tampered column that
  // would otherwise be invisible because the AAD never saw it. Fail closed
  // rather than quietly trusting whichever one the call site happened to pass.
  if (input.envelope.version !== version) {
    throw new HostSecretsError("open-failed", "Host secret could not be decrypted");
  }

  const iv = decodeBase64Url(input.envelope.iv);
  if (iv.length !== HOST_SECRET_IV_BYTES) {
    throw new HostSecretsError("open-failed", "Host secret could not be decrypted");
  }
  const ciphertext = decodeBase64Url(input.envelope.ciphertext);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: hostSecretAad({ hostId, ownerUserId, version }),
        tagLength: GCM_TAG_BITS,
      },
      input.syncKey,
      ciphertext,
    );
  } catch {
    // Uniform message: see HostSecretsError. Also swallows the underlying
    // DOMException so no call site starts branching on `OperationError`.
    throw new HostSecretsError("open-failed", "Host secret could not be decrypted");
  }

  try {
    return JSON.parse(TEXT_DECODER.decode(plaintext));
  } catch {
    // Authenticated but unparseable means our own writer produced it wrong (or
    // a future format). Not an attack — but not openable either.
    throw new HostSecretsError("open-failed", "Host secret payload is not valid JSON");
  }
}

/**
 * Normalizes a public JWK to the exact bytes both devices must agree on.
 *
 * Re-encoding through a decode is not busywork: base64url coordinates can
 * differ in padding, and a 3-character group's trailing bits are ignored on
 * decode, so two byte-identical keys can arrive as two different strings. Left
 * as-is, that produces a verification-code mismatch (users learn to ignore the
 * check) or a KDF transcript mismatch (pairing fails for no visible reason).
 */
function canonicalPairingJwk(jwk: PairingPublicJwk, field: string): string {
  if (jwk === null || typeof jwk !== "object") {
    throw new HostSecretsError("invalid-input", `${field} must be a public JWK`);
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new HostSecretsError("invalid-input", `${field} must be an EC P-256 public key`);
  }
  const x = decodeBase64Url(requireIdentifier(jwk.x, `${field}.x`));
  const y = decodeBase64Url(requireIdentifier(jwk.y, `${field}.y`));
  if (x.length !== P256_COORDINATE_BYTES || y.length !== P256_COORDINATE_BYTES) {
    throw new HostSecretsError("invalid-input", `${field} coordinates are not P-256 sized`);
  }
  return `P-256.${encodeBase64Url(x)}.${encodeBase64Url(y)}`;
}

function toPairingPublicJwk(jwk: {
  readonly kty?: string | undefined;
  readonly crv?: string | undefined;
  readonly x?: string | undefined;
  readonly y?: string | undefined;
}): PairingPublicJwk {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.x === undefined || jwk.y === undefined) {
    throw new HostSecretsError("invalid-input", "Generated pairing key is not EC P-256");
  }
  // Drop `ext`, `key_ops`, and anything else the platform attached: only the
  // curve point is part of the transcript, and extra fields would vary by
  // engine.
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

async function importPairingPublicKey(jwk: PairingPublicJwk, field: string): Promise<CryptoKey> {
  canonicalPairingJwk(jwk, field);
  return subtle().importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    // A public ECDH key carries no usages of its own; it is an argument to the
    // private key's derivation.
    [],
  );
}

/**
 * The receiving half of pairing: a single-use ECDH keypair the new device
 * generates and publishes so an existing device can wrap the Sync Key to it.
 *
 * P-256 rather than X25519, per ADR 0004's fallback: it is the curve device
 * keys already use, Secure Enclave will only hold P-256, and X25519 in
 * WebCrypto is still not something every one of browser / Electron / Node can
 * be relied on to provide.
 */
export async function generatePairingKeyPair(): Promise<PairingKeyPair> {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  return {
    privateKey: pair.privateKey,
    publicJwk: toPairingPublicJwk(await subtle().exportKey("jwk", pair.publicKey)),
  };
}

/**
 * The key-encryption key both devices independently arrive at.
 *
 * A raw ECDH result is the shared point's x-coordinate — uniform-ish but not
 * uniform, and never safe to use directly as a key. HKDF-SHA-256 extracts it,
 * with the full pairing transcript (both public keys, in the sender→recipient
 * order) as `info`. Binding the transcript means a wrap produced for one
 * recipient cannot be re-pointed at another: the transcript changes, the KEK
 * changes, and AES-KW's integrity check fails.
 *
 * AES-KW (RFC 3394) rather than AES-GCM for the wrap itself: it is the
 * primitive built for wrapping key material, it is deterministic, and it needs
 * no nonce — and a KEK used exactly once is the situation where an accidental
 * nonce reuse would be least likely to be noticed.
 */
async function derivePairingKek(input: {
  privateKey: CryptoKey;
  peerPublicKey: CryptoKey;
  ephemeralPublicJwk: PairingPublicJwk;
  recipientPublicJwk: PairingPublicJwk;
  usages: readonly ("unwrapKey" | "wrapKey")[];
}): Promise<CryptoKey> {
  const sharedSecret = await subtle().deriveBits(
    { name: "ECDH", public: input.peerPublicKey },
    input.privateKey,
    256,
  );
  const hkdfKey = await subtle().importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  const transcript = utf8(
    JSON.stringify([
      PAIRING_KDF_DOMAIN,
      canonicalPairingJwk(input.ephemeralPublicJwk, "ephemeralPublicJwk"),
      canonicalPairingJwk(input.recipientPublicJwk, "recipientPublicJwk"),
    ]),
  );
  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // A fixed, non-secret salt: there is no shared randomness at extract time
      // beyond the ephemeral key, which is already in `info`. Its job here is
      // domain separation, not entropy.
      salt: utf8(PAIRING_KDF_DOMAIN),
      info: transcript,
    },
    hkdfKey,
    { name: "AES-KW", length: 256 },
    false,
    [...input.usages],
  );
}

/**
 * Wraps the Sync Key to a new device's pairing key — the existing device's half
 * of the hand-off. No cloud escrow: the result is opaque to the account service
 * that relays it.
 *
 * Ordering the caller must honor: publish the result, let both devices derive
 * {@link pairingVerificationCode} from `ephemeralPublicJwk` and
 * `recipientPublicJwk`, and only adopt the unwrapped key once the user has
 * confirmed the codes match. Unwrapping before confirmation would defeat the
 * check — the blob is useless to anyone else, but the user's confirmation is
 * what rules out having wrapped to a hostile prompt's key in the first place.
 */
export async function wrapSyncKey(input: {
  syncKey: CryptoKey;
  recipientPublicJwk: PairingPublicJwk;
}): Promise<WrappedSyncKey> {
  const recipientPublicKey = await importPairingPublicKey(
    input.recipientPublicJwk,
    "recipientPublicJwk",
  );
  const ephemeral = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const ephemeralPublicJwk = toPairingPublicJwk(
    await subtle().exportKey("jwk", ephemeral.publicKey),
  );

  const kek = await derivePairingKek({
    privateKey: ephemeral.privateKey,
    peerPublicKey: recipientPublicKey,
    ephemeralPublicJwk,
    recipientPublicJwk: input.recipientPublicJwk,
    usages: ["wrapKey"],
  });

  const wrapped = await subtle().wrapKey("raw", input.syncKey, kek, "AES-KW");
  return {
    ephemeralPublicJwk,
    recipientPublicJwk: input.recipientPublicJwk,
    wrapped: encodeBase64Url(new Uint8Array(wrapped)),
  };
}

/**
 * The new device's half of the hand-off.
 *
 * The recipient's own public JWK is read back out of the blob rather than
 * passed in, because it is not a secret and it is not trusted: it only feeds
 * the KDF transcript, so a tampered echo derives a different KEK and the
 * unwrap fails closed.
 *
 * The recovered key is extractable for the same reason the original is — this
 * device must be able to wrap it onward for a third device.
 */
export async function unwrapSyncKey(input: {
  wrapped: WrappedSyncKey;
  recipientPrivateKey: CryptoKey;
}): Promise<CryptoKey> {
  const ephemeralPublicKey = await importPairingPublicKey(
    input.wrapped.ephemeralPublicJwk,
    "ephemeralPublicJwk",
  );
  const kek = await derivePairingKek({
    privateKey: input.recipientPrivateKey,
    peerPublicKey: ephemeralPublicKey,
    ephemeralPublicJwk: input.wrapped.ephemeralPublicJwk,
    recipientPublicJwk: input.wrapped.recipientPublicJwk,
    usages: ["unwrapKey"],
  });

  try {
    return await subtle().unwrapKey(
      "raw",
      decodeBase64Url(input.wrapped.wrapped),
      kek,
      "AES-KW",
      { name: "AES-GCM", length: SYNC_KEY_BITS },
      true,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new HostSecretsError("unwrap-failed", "Sync key could not be unwrapped");
  }
}

/**
 * The short code shown on both devices during pairing, so the user can see that
 * the peer they are about to trust is the one in front of them and not a
 * hostile prompt that raced the real device.
 *
 * **Argument order does not matter.** The two canonical key encodings are
 * sorted before hashing, so a device that believes it is the sender and one
 * that believes it is the recipient still derive the same code. That is
 * deliberate: role confusion between two peers would otherwise show a spurious
 * mismatch, and a check that cries wolf is a check users click through. Nothing
 * is lost — the code commits to the *set* of two keys, and a MITM necessarily
 * substitutes a key that is not in the set.
 *
 * Six characters over the 32-symbol unambiguous alphabet already used for
 * device codes: 30 bits, so an attacker who must make the user's two codes
 * collide gets roughly one chance in a billion, and 32 being a power of two
 * means slicing 5 bits per character is exactly uniform — no modulo bias.
 */
export async function pairingVerificationCode(input: {
  senderPublicJwk: PairingPublicJwk;
  recipientPublicJwk: PairingPublicJwk;
}): Promise<string> {
  const sender = canonicalPairingJwk(input.senderPublicJwk, "senderPublicJwk");
  const recipient = canonicalPairingJwk(input.recipientPublicJwk, "recipientPublicJwk");
  // Default sort compares UTF-16 code units, which is engine-independent here
  // (both operands are ASCII base64url).
  const ordered = [sender, recipient].toSorted();

  const digest = new Uint8Array(
    await subtle().digest("SHA-256", utf8(JSON.stringify([PAIRING_CODE_DOMAIN, ...ordered]))),
  );
  // Top 30 bits of the digest, unsigned: 6 characters x 5 bits.
  let remaining = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0) >>> 2;

  const characters: string[] = [];
  for (let index = 0; index < PAIRING_VERIFICATION_CODE_LENGTH; index += 1) {
    characters.push(DEVICE_USER_CODE_ALPHABET.charAt(remaining % DEVICE_USER_CODE_ALPHABET.length));
    remaining = Math.floor(remaining / DEVICE_USER_CODE_ALPHABET.length);
  }
  return characters.toReversed().join("");
}

async function exportSyncKeyBytes(key: CryptoKey, field: string): Promise<Bytes> {
  try {
    return new Uint8Array(await subtle().exportKey("raw", key));
  } catch {
    throw new HostSecretsError(
      "invalid-input",
      `${field} must be an extractable AES-GCM sync key (see generateSyncKey)`,
    );
  }
}

function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Re-encrypts every Host Secret to a new Sync Key at `version + 1` — what a
 * surviving device runs after a device is removed (ADR 0015). The removed
 * device keeps whatever plaintext it already cached; what it loses is the
 * ability to read anything written from now on.
 *
 * All-or-nothing by construction: validation happens before any crypto, the
 * new envelopes are built into a fresh array, and a single failure rejects. The
 * caller therefore either gets a complete replacement set to upload or an
 * error — never a half-rotated mixture, which would leave some hosts readable
 * by the removed device with nothing recording which.
 */
export async function rotateHostSecrets(input: {
  oldSyncKey: CryptoKey;
  newSyncKey: CryptoKey;
  entries: readonly HostSecretEntry[];
}): Promise<readonly HostSecretEntry[]> {
  const seen = new Set<string>();
  for (const entry of input.entries) {
    const hostId = requireIdentifier(entry.hostId, "hostId");
    requireIdentifier(entry.ownerUserId, "ownerUserId");
    requireVersion(entry.envelope.version);
    if (seen.has(hostId)) {
      // Two rows for one host would make the upload's compare-and-swap
      // order-dependent, and the loser silently disappears.
      throw new HostSecretsError("invalid-input", `Duplicate hostId in rotation: ${hostId}`);
    }
    seen.add(hostId);
  }

  // Rotating onto the same key is a no-op that looks like a successful
  // rotation, which is the one failure mode that matters here: the whole point
  // is that the removed device's copy of the key stops working.
  const oldBytes = await exportSyncKeyBytes(input.oldSyncKey, "oldSyncKey");
  const newBytes = await exportSyncKeyBytes(input.newSyncKey, "newSyncKey");
  if (bytesEqual(oldBytes, newBytes)) {
    throw new HostSecretsError("invalid-input", "newSyncKey must differ from oldSyncKey");
  }

  return Promise.all(
    input.entries.map(async (entry): Promise<HostSecretEntry> => {
      const secret = await openHostSecret({
        syncKey: input.oldSyncKey,
        hostId: entry.hostId,
        ownerUserId: entry.ownerUserId,
        version: entry.envelope.version,
        envelope: entry.envelope,
      });
      return {
        hostId: entry.hostId,
        ownerUserId: entry.ownerUserId,
        envelope: await sealHostSecret({
          syncKey: input.newSyncKey,
          hostId: entry.hostId,
          ownerUserId: entry.ownerUserId,
          version: entry.envelope.version + 1,
          secret,
        }),
      };
    }),
  );
}
