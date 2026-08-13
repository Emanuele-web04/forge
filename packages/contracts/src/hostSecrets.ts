// FILE: hostSecrets.ts
// Purpose: The wire contract for E2E-encrypted Host Secrets sync (ADR 0004,
// spec slice E §3). Every field crossing this boundary is either an opaque
// byte string the account service stores verbatim or an integer it does
// arithmetic on — deliberately nothing it could interpret.
// Layer: contracts (schema-only)
// Depends on: baseSchemas, hostAuth (the pairing JWK shape).

import { Schema } from "effect";

import { Es256PublicKeyJwk } from "./hostAuth";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

/**
 * Byte ceiling on one host's ciphertext, expressed on the base64url string
 * the wire actually carries (~4/3 expansion). Host Secrets are a small JSON
 * object — an SSH destination, a launcher command, a verification policy —
 * so a sealed blob is a few hundred bytes; 16 KB is two orders of magnitude
 * of headroom while keeping a row (and the history table behind it) bounded
 * for a caller the service cannot audit, because it cannot read what it
 * stores. Without a cap the only limit would be the transport's.
 */
export const HOST_SECRET_CIPHERTEXT_MAX_LENGTH = 16 * 1024;

/**
 * Base64url of a 12-byte AES-GCM IV is exactly 16 characters unpadded. Fixed
 * rather than bounded: a nonce of any other width did not come from
 * `sealHostSecret`, and accepting one would store a blob no client can open.
 */
export const HOST_SECRET_IV_LENGTH = 16;

/**
 * How many superseded versions of one host's secrets are retained. Exists to
 * recover from a bad write (a client that sealed garbage, a half-migrated
 * config), which is noticed within a session or not at all — five is several
 * rounds of edit-and-undo and still a hard bound on the history a single host
 * can accumulate.
 */
export const HOST_SECRET_HISTORY_LIMIT = 5;

/**
 * Ceiling on the wrapped Sync Key blob. AES-KW over a 32-byte key is 40
 * bytes (~56 base64url characters); the bound is generous for a future
 * wrapping primitive without becoming a place to park arbitrary data.
 */
export const SYNC_KEY_WRAP_MAX_LENGTH = 1024;

const Base64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

const Ciphertext = Base64Url.check(Schema.isMaxLength(HOST_SECRET_CIPHERTEXT_MAX_LENGTH));
const Iv = Base64Url.check(Schema.isLengthBetween(HOST_SECRET_IV_LENGTH, HOST_SECRET_IV_LENGTH));

/**
 * One host's sealed configuration, exactly as `sealHostSecret` produced it
 * (`@synara/shared/hostSecrets`). The account service round-trips these three
 * fields and never decodes the first two — `version` is the only one it acts
 * on, and only to compare.
 *
 * `version` is bound into the ciphertext's AEAD additional data client-side,
 * so a blob moved to another host, another owner, or another version fails to
 * open rather than silently supplying attacker-chosen SSH config.
 */
export const HostSecretEnvelope = Schema.Struct({
  ciphertext: Ciphertext,
  iv: Iv,
  version: PositiveInt,
});
export type HostSecretEnvelope = typeof HostSecretEnvelope.Type;

/** A stored envelope plus the server-owned write timestamp. */
export const StoredHostSecret = Schema.Struct({
  ...HostSecretEnvelope.fields,
  updatedAt: IsoDateTime,
});
export type StoredHostSecret = typeof StoredHostSecret.Type;

/**
 * `secret` is null when the host has none stored yet. A distinct shape (not a
 * 404) because "no secrets" is the ordinary state of a freshly linked host and
 * a client must be able to tell it apart from "no such host", which IS a 404 —
 * the caller already proved ownership to get here.
 *
 * `version: 0` is what a first write must send as its `expectedVersion`; see
 * {@link PutHostSecretRequest}.
 */
export const GetHostSecretResponse = Schema.Struct({
  secret: Schema.NullOr(StoredHostSecret),
});
export type GetHostSecretResponse = typeof GetHostSecretResponse.Type;

/**
 * A compare-and-swap write. `expectedVersion` is the version the client
 * believes is stored — 0 to claim the row does not exist yet — and the write
 * lands only if that is still true, so a rotation and a concurrent edit
 * cannot silently clobber each other (spec §3). The loser gets a 409 carrying
 * the current version and re-reads.
 *
 * `envelope.version` is validated to be exactly `expectedVersion + 1`: the
 * client seals under the new version, so a mismatch means the ciphertext's
 * AAD disagrees with the row it is about to occupy and nothing would ever
 * open it again.
 */
export const PutHostSecretRequest = Schema.Struct({
  expectedVersion: NonNegativeInt,
  envelope: HostSecretEnvelope,
});
export type PutHostSecretRequest = typeof PutHostSecretRequest.Type;

export const PutHostSecretResponse = Schema.Struct({
  secret: StoredHostSecret,
});
export type PutHostSecretResponse = typeof PutHostSecretResponse.Type;

/**
 * What a stale write is told. The current version is disclosed deliberately:
 * the caller already proved ownership, and without it the client's only
 * recovery would be a blind re-read loop.
 */
export const HostSecretConflictBody = Schema.Struct({
  error: Schema.Literal("host_secret_version_conflict"),
  message: TrimmedNonEmptyString,
  currentVersion: NonNegativeInt,
});
export type HostSecretConflictBody = typeof HostSecretConflictBody.Type;

/**
 * The pairing hand-off blob, mirroring `WrappedSyncKey` in
 * `@synara/shared/hostSecrets` field for field. The service relays it and
 * cannot open it: the Sync Key is wrapped under a key derived from an ECDH
 * shared secret whose private halves never leave the two devices.
 */
export const SyncKeyWrap = Schema.Struct({
  ephemeralPublicJwk: Es256PublicKeyJwk,
  recipientPublicJwk: Es256PublicKeyJwk,
  wrapped: Base64Url.check(Schema.isMaxLength(SYNC_KEY_WRAP_MAX_LENGTH)),
});
export type SyncKeyWrap = typeof SyncKeyWrap.Type;

/**
 * Uploads a wrapped Sync Key addressed to one of the caller's OWN devices.
 * Cross-user delivery is impossible by construction: the route resolves
 * `recipientDeviceId` inside the caller's device set, and a device that is
 * not there is a 404 — the same opacity rule hosts use, so the endpoint
 * cannot be probed for which device ids exist.
 */
export const PutSyncKeyWrapRequest = Schema.Struct({
  recipientDeviceId: Schema.String.check(Schema.isUUID(undefined)),
  wrap: SyncKeyWrap,
});
export type PutSyncKeyWrapRequest = typeof PutSyncKeyWrapRequest.Type;

export const PutSyncKeyWrapResponse = Schema.Struct({
  recipientDeviceId: Schema.String.check(Schema.isUUID(undefined)),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type PutSyncKeyWrapResponse = typeof PutSyncKeyWrapResponse.Type;

/**
 * Single delivery: the recipient fetches its wrap once and the row is deleted
 * in the same statement. A second fetch is a 404, which is also what an
 * unpaired device sees — so a wrap cannot be replayed to a device that
 * observed the exchange, and the endpoint discloses nothing about whether one
 * was ever there.
 */
export const GetSyncKeyWrapResponse = Schema.Struct({
  wrap: SyncKeyWrap,
  createdAt: IsoDateTime,
});
export type GetSyncKeyWrapResponse = typeof GetSyncKeyWrapResponse.Type;
