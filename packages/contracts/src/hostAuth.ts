import { Schema } from "effect";

import {
  ACCOUNT_APP_VERSION_MAX_LENGTH,
  ACCOUNT_AUTH_TOKEN_MAX_LENGTH,
  ACCOUNT_NAME_MAX_LENGTH,
  AccountHost,
  AccountHostKind,
  AccountHostPlatform,
} from "./account";
import {
  boundedTrimmedNonEmptyString,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas";

/** Protected-header `typ` values. Consumers must exact-match them. */
export const HOST_LINK_JWT_TYP = "synara-host-link+jwt" as const;
export const HOST_PROOF_JWT_TYP = "synara-host-proof+jwt" as const;
export const DEVICE_REGISTER_JWT_TYP = "synara-device-register+jwt" as const;
export const GRANT_JWT_TYP = "synara-grant+jwt" as const;
export const RELAY_TICKET_JWT_TYP = "synara-relay-ticket+jwt" as const;
export const MINT_REQUEST_JWT_TYP = "synara-mint-request+jwt" as const;
export const SESSION_CREDENTIAL_JWT_TYP = "synara-session-credential+jwt" as const;
export const DPOP_JWT_TYP = "dpop+jwt" as const;

// Claim KEY names are not exported as constants: the Schema.Struct claim
// definitions below are the single source of the wire shape — a drifted key
// fails schema decode on the consumer side, which is the real guarantee.

export const HOST_LINK_MAX_AGE_SECONDS = 5 * 60;
export const HOST_PROOF_MAX_AGE_SECONDS = 60;
export const DEVICE_REGISTER_MAX_AGE_SECONDS = 60;
export const GRANT_MAX_AGE_SECONDS = 60;
export const RELAY_TICKET_MAX_AGE_SECONDS = 5 * 60;
export const MINT_REQUEST_MAX_AGE_SECONDS = 2 * 60;
export const SESSION_CREDENTIAL_MAX_AGE_SECONDS = 60 * 60;
export const JWT_CLOCK_TOLERANCE_SECONDS = 60;

export const HOST_CONNECT_SCOPE = "host:connect" as const;
export const RELAY_CONTROL_SCOPE = "relay:control" as const;
export const SYNARA_RELAY_AUDIENCE = "synara-relay" as const;
export const SYNARA_SESSION_AUDIENCE = "synara-session" as const;
export const SYNARA_DEVICE_ISSUER = "synara-device" as const;

const Uuid = Schema.String.check(Schema.isUUID(undefined));
const JwtString = boundedTrimmedNonEmptyString(ACCOUNT_AUTH_TOKEN_MAX_LENGTH * 4);
const Base64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const Jkt = boundedTrimmedNonEmptyString(256);
const JwtTime = NonNegativeInt;
const Jti = Schema.String.check(Schema.isUUID(4));
/**
 * The display alphabet excludes I and O (and 0/1) so a code read aloud or
 * copied by hand cannot be ambiguous. The schema mirrors the generator
 * exactly: accepting a character no code can contain would let a typo burn
 * an approval attempt against the rate limit.
 */
export const DEVICE_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DeviceUserCode = Schema.String.check(
  Schema.isPattern(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/),
);

export const HostPublicKeyJwk = Schema.Struct({
  kty: Schema.Literal("OKP"),
  crv: Schema.Literal("Ed25519"),
  x: Base64Url,
});
export type HostPublicKeyJwk = typeof HostPublicKeyJwk.Type;

export const Es256PublicKeyJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Base64Url,
  y: Base64Url,
});
export type Es256PublicKeyJwk = typeof Es256PublicKeyJwk.Type;

export const DevicePublicKeyJwk = Schema.Union([HostPublicKeyJwk, Es256PublicKeyJwk]);
export type DevicePublicKeyJwk = typeof DevicePublicKeyJwk.Type;

export const AccountDevicePlatform = Schema.Literals(["darwin", "ios", "linux", "windows", "web"]);
export type AccountDevicePlatform = typeof AccountDevicePlatform.Type;

export const ApiSigningPublicJwk = Schema.Struct({
  ...HostPublicKeyJwk.fields,
  kid: TrimmedNonEmptyString,
  alg: Schema.Literal("EdDSA"),
  use: Schema.Literal("sig"),
});
export type ApiSigningPublicJwk = typeof ApiSigningPublicJwk.Type;

export const ApiJwks = Schema.Struct({ keys: Schema.Array(ApiSigningPublicJwk) });
export type ApiJwks = typeof ApiJwks.Type;

const StandardJwtClaims = {
  iss: TrimmedNonEmptyString,
  sub: TrimmedNonEmptyString,
  aud: TrimmedNonEmptyString,
  iat: JwtTime,
  exp: JwtTime,
  jti: Jti,
};

export const HostLinkClaims = Schema.Struct({
  ...StandardJwtClaims,
  challengeId: Uuid,
  nonce: Base64Url,
  publicKeyJwk: HostPublicKeyJwk,
  name: boundedTrimmedNonEmptyString(ACCOUNT_NAME_MAX_LENGTH),
  platform: AccountHostPlatform,
  appVersion: Schema.optional(boundedTrimmedNonEmptyString(ACCOUNT_APP_VERSION_MAX_LENGTH)),
});
export type HostLinkClaims = typeof HostLinkClaims.Type;

export const HostProofClaims = Schema.Struct({
  ...StandardJwtClaims,
  sub: Uuid,
  keyGeneration: NonNegativeInt,
});
export type HostProofClaims = typeof HostProofClaims.Type;

export const DeviceRegisterClaims = Schema.Struct({
  ...StandardJwtClaims,
  publicKeyJwk: DevicePublicKeyJwk,
  displayName: boundedTrimmedNonEmptyString(ACCOUNT_NAME_MAX_LENGTH),
  platform: AccountDevicePlatform,
});
export type DeviceRegisterClaims = typeof DeviceRegisterClaims.Type;

const Confirmation = Schema.Struct({ jkt: Jkt });

export const GrantClaims = Schema.Struct({
  ...StandardJwtClaims,
  hostId: Uuid,
  environmentId: EnvironmentId,
  cnf: Confirmation,
  scope: Schema.Tuple([Schema.Literal(HOST_CONNECT_SCOPE)]),
});
export type GrantClaims = typeof GrantClaims.Type;

export const RelayTicketClaims = Schema.Struct({
  ...StandardJwtClaims,
  sub: Uuid,
  environmentId: EnvironmentId,
  keyGeneration: NonNegativeInt,
  scope: Schema.Tuple([Schema.Literal(RELAY_CONTROL_SCOPE)]),
});
export type RelayTicketClaims = typeof RelayTicketClaims.Type;

export const MintRequestClaims = Schema.Struct({
  ...StandardJwtClaims,
  publicKeyJwk: DevicePublicKeyJwk,
  grant: JwtString,
});
export type MintRequestClaims = typeof MintRequestClaims.Type;

export const SessionCredentialClaims = Schema.Struct({
  ...StandardJwtClaims,
  cnf: Confirmation,
  keyGeneration: NonNegativeInt,
  scope: Schema.Tuple([Schema.Literal(HOST_CONNECT_SCOPE)]),
});
export type SessionCredentialClaims = typeof SessionCredentialClaims.Type;

export const DpopProofClaims = Schema.Struct({
  htu: TrimmedNonEmptyString,
  htm: TrimmedNonEmptyString,
  jti: Jti,
  iat: JwtTime,
  ath: Base64Url,
});
export type DpopProofClaims = typeof DpopProofClaims.Type;

export const LinkStartRequest = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  name: Schema.optional(boundedTrimmedNonEmptyString(ACCOUNT_NAME_MAX_LENGTH)),
  platform: Schema.optional(AccountHostPlatform),
  kind: Schema.optional(AccountHostKind),
});
export type LinkStartRequest = typeof LinkStartRequest.Type;

export const LinkStartResponse = Schema.Struct({
  challengeId: Uuid,
  nonce: Base64Url,
  hostId: Schema.optional(Uuid),
  expiresAt: IsoDateTime,
});
export type LinkStartResponse = typeof LinkStartResponse.Type;

export const LinkCompleteRequest = Schema.Struct({ challengeId: Uuid, proof: JwtString });
export type LinkCompleteRequest = typeof LinkCompleteRequest.Type;

/**
 * AccountHost keeps its new fields optional at the legacy shared boundary so
 * pre-Slice-A consumers remain source-compatible. New link responses are
 * strict: linked hosts always carry the complete authorization/key state.
 */
export const LinkedAccountHost = Schema.Struct({
  ...AccountHost.fields,
  ownerUserId: TrimmedNonEmptyString,
  discoverable: Schema.Boolean,
  linked: Schema.Boolean,
  keyGeneration: NonNegativeInt,
});
export type LinkedAccountHost = typeof LinkedAccountHost.Type;

export const LinkCompleteResponse = Schema.Struct({ host: LinkedAccountHost });
export type LinkCompleteResponse = typeof LinkCompleteResponse.Type;

export const LinkDeviceStartResponse = Schema.Struct({
  deviceCode: Base64Url,
  userCode: DeviceUserCode,
  verificationUri: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  interval: Schema.Literal(5),
});
export type LinkDeviceStartResponse = typeof LinkDeviceStartResponse.Type;

export const LinkDeviceApproveRequest = Schema.Struct({
  userCode: DeviceUserCode,
});
export type LinkDeviceApproveRequest = typeof LinkDeviceApproveRequest.Type;

export const LinkDeviceTokenRequest = Schema.Struct({
  deviceCode: boundedTrimmedNonEmptyString(128),
});
export type LinkDeviceTokenRequest = typeof LinkDeviceTokenRequest.Type;

export const LinkDeviceTokenResponse = Schema.Struct({ challengeId: Uuid, nonce: Base64Url });
export type LinkDeviceTokenResponse = typeof LinkDeviceTokenResponse.Type;

export const AccountDevice = Schema.Struct({
  id: Uuid,
  publicKeyJwk: DevicePublicKeyJwk,
  jkt: TrimmedNonEmptyString,
  displayName: boundedTrimmedNonEmptyString(ACCOUNT_NAME_MAX_LENGTH),
  platform: AccountDevicePlatform,
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type AccountDevice = typeof AccountDevice.Type;

export const RegisterDeviceRequest = Schema.Struct({ proof: JwtString });
export type RegisterDeviceRequest = typeof RegisterDeviceRequest.Type;

export const RegisterDeviceResponse = Schema.Struct({ device: AccountDevice });
export type RegisterDeviceResponse = typeof RegisterDeviceResponse.Type;

export const ListDevicesResponse = Schema.Struct({ devices: Schema.Array(AccountDevice) });
export type ListDevicesResponse = typeof ListDevicesResponse.Type;

export const GrantRequest = Schema.Struct({ deviceJkt: Jkt });
export type GrantRequest = typeof GrantRequest.Type;

export const GrantResponse = Schema.Struct({ grant: JwtString });
export type GrantResponse = typeof GrantResponse.Type;

export const RelayTicketResponse = Schema.Struct({ ticket: JwtString });
export type RelayTicketResponse = typeof RelayTicketResponse.Type;

export const HostAuthorizationSnapshot = Schema.Struct({
  discoverable: Schema.Boolean,
  ownerUserId: TrimmedNonEmptyString,
  orgId: TrimmedNonEmptyString,
  ownerInOrg: Schema.Boolean,
});
export type HostAuthorizationSnapshot = typeof HostAuthorizationSnapshot.Type;

export const RevocationKind = Schema.Literals([
  "discoverability_off",
  "org_departure",
  "device_revoked",
  "host_unlinked",
]);
export type RevocationKind = typeof RevocationKind.Type;

export const RevocationEvent = Schema.Struct({
  id: PositiveInt,
  hostId: Uuid,
  kind: RevocationKind,
  subject: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type RevocationEvent = typeof RevocationEvent.Type;

/**
 * Duplicate events are expected. Poll `id > cursor`, deliver every event,
 * and only advance to `watermark`; the five-second trailing window is read
 * again so a lower id that commits late is not skipped. De-duplicate by id.
 */
export const RevocationEventsResponse = Schema.Struct({
  events: Schema.Array(RevocationEvent),
  watermark: NonNegativeInt,
});
export type RevocationEventsResponse = typeof RevocationEventsResponse.Type;
