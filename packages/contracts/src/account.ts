import { Schema } from "effect";

import {
  boundedTrimmedNonEmptyString,
  EnvironmentId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas";

// ── Request field bounds ─────────────────────────────────────────────
//
// Every externally-supplied string and array in a request contract carries an
// explicit maximum: an unbounded field on an unauthenticated (or merely
// authenticated) route lets a caller inflate database rows, responses, and
// logs to whatever the transport accepts. The values are generous for honest
// input — display names, hostnames, and URLs are all short in practice — and
// exist to bound abuse, not to police taste. Response-only fields stay
// unbounded (the server is the author of those).

/** Human-entered names: display name, workspace name, host name. */
export const ACCOUNT_NAME_MAX_LENGTH = 200;
/** RFC 5321 caps a mail path at 256 octets; nothing longer is a deliverable address. */
export const ACCOUNT_EMAIL_MAX_LENGTH = 320;
/** A host endpoint URL. Real endpoint origins are tens of characters. */
export const ACCOUNT_ENDPOINT_URL_MAX_LENGTH = 2048;
/** How many endpoints one host may advertise; a real host has a handful. */
export const ACCOUNT_HOST_ENDPOINTS_MAX = 16;
/** A semver-ish app version string. */
export const ACCOUNT_APP_VERSION_MAX_LENGTH = 64;
/** Opaque provider-issued tokens/ids the client echoes back on auth routes. */
export const ACCOUNT_AUTH_TOKEN_MAX_LENGTH = 4096;

const AccountNameString = boundedTrimmedNonEmptyString(ACCOUNT_NAME_MAX_LENGTH);
const AccountEmailString = boundedTrimmedNonEmptyString(ACCOUNT_EMAIL_MAX_LENGTH);
const AccountAuthTokenString = boundedTrimmedNonEmptyString(ACCOUNT_AUTH_TOKEN_MAX_LENGTH);
const AccountAppVersionString = boundedTrimmedNonEmptyString(ACCOUNT_APP_VERSION_MAX_LENGTH);

export const AccountHostTransport = Schema.Literals(["lan", "tailscale"]);
export type AccountHostTransport = typeof AccountHostTransport.Type;

export const AccountHostEndpoint = Schema.Struct({
  url: boundedTrimmedNonEmptyString(ACCOUNT_ENDPOINT_URL_MAX_LENGTH),
  transport: AccountHostTransport,
});
export type AccountHostEndpoint = typeof AccountHostEndpoint.Type;

export const AccountHostPlatform = Schema.Literals(["darwin", "linux", "windows"]);
export type AccountHostPlatform = typeof AccountHostPlatform.Type;

export const AccountHostKind = Schema.Literals(["local", "ssh-managed"]);
export type AccountHostKind = typeof AccountHostKind.Type;

/**
 * A WorkOS organization as this API surfaces it. Organizations are the unit of
 * host ownership: every user has at least a personal one, and a team is the
 * same thing with more members.
 */
export const OrganizationSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type OrganizationSummary = typeof OrganizationSummary.Type;

export const AccountHost = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  platform: AccountHostPlatform,
  kind: AccountHostKind,
  endpoints: Schema.Array(AccountHostEndpoint),
  appVersion: Schema.optional(TrimmedNonEmptyString),
  /** Authorization owner. */
  ownerUserId: TrimmedNonEmptyString,
  /** Whether non-owner members of the owning organization may see and use it. */
  discoverable: Schema.Boolean,
  /** Whether a host public key is currently linked. */
  linked: Schema.Boolean,
  /** Monotonic key epoch; host proofs bind to this value. */
  keyGeneration: NonNegativeInt,
  /** Set by list reads to distinguish an owner row from an org-visible row. */
  mine: Schema.optional(Schema.Boolean),
  createdAt: TrimmedNonEmptyString,
  lastSeenAt: TrimmedNonEmptyString,
});
export type AccountHost = typeof AccountHost.Type;

/**
 * The handle a profile is known by. Lowercase so it reads the same everywhere
 * it is shown and compares the same everywhere it is stored, and bounded at
 * both ends by the pattern: it must start on an alphanumeric and may not end
 * on a hyphen, which is what keeps `-`, `a-`, and `--` out.
 */
export const AccountProfileHandle = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/),
);
export type AccountProfileHandle = typeof AccountProfileHandle.Type;

/**
 * An avatar accent, as the web app's `PROFILE_AVATAR_COLORS` palette writes
 * them. Checked as a hex triplet rather than against the palette itself: the
 * palette is a web-side design decision that will change without a deploy of
 * the account service, and a server that rejected tomorrow's swatch would be
 * the thing standing between a user and their own profile.
 */
export const AccountProfileAvatarColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
export type AccountProfileAvatarColor = typeof AccountProfileAvatarColor.Type;

/**
 * Where a profile's avatar image comes from:
 *
 *   sso         — mirror the identity provider's picture (the default).
 *   uploaded    — serve the image the owner uploaded via PUT /profile/avatar.
 *   placeholder — no image at all; clients render initials on `avatarColor`.
 */
export const AccountProfileAvatarSource = Schema.Literals(["sso", "uploaded", "placeholder"]);
export type AccountProfileAvatarSource = typeof AccountProfileAvatarSource.Type;

/**
 * The avatar sources PUT /profile may set. Deliberately excludes "uploaded":
 * only the upload route may claim it, because it is the only writer that
 * guarantees a stored object actually backs the claim — a profile write that
 * could say "uploaded" would dangle a key nobody wrote.
 */
export const UpdatableAvatarSource = Schema.Literals(["sso", "placeholder"]);
export type UpdatableAvatarSource = typeof UpdatableAvatarSource.Type;

/**
 * The part of a user's identity Synara owns, as opposed to what WorkOS knows.
 * Its existence is what "onboarding is finished" means — there is no separate
 * flag, so a profile row and a completed onboarding are the same fact.
 */
export const AccountProfile = Schema.Struct({
  handle: AccountProfileHandle,
  displayName: TrimmedNonEmptyString,
  avatarColor: AccountProfileAvatarColor,
  /**
   * Whether the profile is served publicly at trysynara.com/@handle.
   * Optional-with-default rather than required so a client built before
   * visibility existed still decodes a server's answer; absent means
   * private, which is also the default for every new profile.
   */
  public: Schema.optional(Schema.Boolean),
  /**
   * The resolved avatar image URL — an uploaded object's public URL, the
   * identity provider's picture, or null for a placeholder (and for an sso
   * source when the provider has no picture). Optional for wire compat with
   * pre-avatar servers; absent reads the same as null.
   */
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  /** Where the avatar comes from. Optional for wire compat; absent means "sso". */
  avatarSource: Schema.optional(AccountProfileAvatarSource),
});
export type AccountProfile = typeof AccountProfile.Type;

export const AccountMe = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  image: Schema.optional(TrimmedNonEmptyString),
  /** The organization the caller's token is scoped to; hosts belong to it. */
  organization: OrganizationSummary,
  /**
   * The caller's Synara profile, or `null` when they have not onboarded.
   * Optional rather than required so a client built before profiles existed
   * still decodes a response from a server that sends them.
   */
  profile: Schema.optional(Schema.NullOr(AccountProfile)),
});
export type AccountMe = typeof AccountMe.Type;

/**
 * The body of `PUT /api/v1/profile`. `handle` is sent on every update even
 * though V1 refuses to change it: the client always knows the handle it is
 * writing, and accepting it lets the server answer a mismatch explicitly
 * rather than silently ignoring the field.
 */
export const UpdateProfileRequest = Schema.Struct({
  handle: AccountProfileHandle,
  displayName: AccountNameString,
  avatarColor: AccountProfileAvatarColor,
  /** Optional so pre-visibility clients keep writing profiles unchanged. */
  public: Schema.optional(Schema.Boolean),
  /**
   * The owner's UTC offset, stored so the PUBLIC profile buckets days and
   * hours in the owner's time — the page shows the same rhythm the app
   * shows them. Refreshed on every profile save; optional for old clients.
   */
  utcOffsetMinutes: Schema.optional(Schema.Int),
  /**
   * Switches the avatar to the identity provider's picture or a placeholder.
   * "uploaded" is deliberately not accepted here — see
   * {@link UpdatableAvatarSource}; uploads go through PUT /profile/avatar,
   * which is what sets the source to "uploaded". Absent leaves the source
   * alone.
   */
  avatarSource: Schema.optional(UpdatableAvatarSource),
});
export type UpdateProfileRequest = typeof UpdateProfileRequest.Type;

/** The body of `PATCH /api/v1/organization` — the workspace rename. */
export const UpdateOrganizationRequest = Schema.Struct({
  name: AccountNameString,
});
export type UpdateOrganizationRequest = typeof UpdateOrganizationRequest.Type;

/**
 * The bounded count used by the host-enrollment consent decision. The account
 * API may stop at two because clients only distinguish a personal workspace
 * from a workspace with more than one member.
 */
export const OrganizationMemberCountResponse = Schema.Struct({
  organizationMemberCount: NonNegativeInt,
});
export type OrganizationMemberCountResponse = typeof OrganizationMemberCountResponse.Type;

export const UpdateHostRequest = Schema.Struct({
  name: Schema.optional(AccountNameString),
  discoverable: Schema.optional(Schema.Boolean),
  endpoints: Schema.optional(
    Schema.Array(AccountHostEndpoint).check(Schema.isMaxLength(ACCOUNT_HOST_ENDPOINTS_MAX)),
  ),
  appVersion: Schema.optional(AccountAppVersionString),
});
export type UpdateHostRequest = typeof UpdateHostRequest.Type;

export const ListHostsResponse = Schema.Struct({
  hosts: Schema.Array(AccountHost),
});
export type ListHostsResponse = typeof ListHostsResponse.Type;

/**
 * What `/instance` publishes about this deployment's identity wiring.
 *
 * `clientId` and `workosApiUrl` are DEPRECATED: every provider call is
 * proxied through this service, so Synara's own clients no longer talk to
 * the identity provider directly and need neither field. They stay in the
 * wire contract for stability — do not remove or repurpose them.
 */
export const InstanceInfo = Schema.Struct({
  version: TrimmedNonEmptyString,
  authMode: Schema.Literal("workos"),
  clientId: TrimmedNonEmptyString,
  workosApiUrl: TrimmedNonEmptyString,
});
export type InstanceInfo = typeof InstanceInfo.Type;

export const AccountErrorCode = Schema.Literals([
  "unauthorized",
  "host_not_found",
  /**
   * The public-profile read for a handle that is unknown OR private —
   * deliberately one code for both, so the route reveals nothing an owner
   * did not publish.
   */
  "profile_not_found",
  "token_revoked",
  "organization_required",
  "environment_already_linked",
  "not_host_owner",
  "host_not_linked",
  "device_revoked",
  "device_not_registered",
  "challenge_expired",
  "challenge_consumed",
  /**
   * A Host Secrets write whose `expectedVersion` no longer matches the stored
   * row — a rotation and a concurrent edit raced, and this one lost. The
   * client re-reads and re-seals; the body carries the current version so it
   * does not have to guess. CAS makes the loss visible rather than silent
   * (ADR 0004, spec slice E §3).
   */
  "host_secret_version_conflict",
  /**
   * No wrapped Sync Key is waiting for this device. Deliberately ONE code for
   * every reason — never uploaded, already delivered (wraps are single
   * delivery), expired, or addressed to a device the caller does not own — so
   * the endpoint cannot be probed for which device ids exist or which
   * pairings are in flight.
   */
  "sync_key_wrap_not_found",
  "approval_pending",
  "bad_proof",
  "handle_taken",
  /**
   * The identity provider will not authenticate this account until its email
   * address is verified. Not expected on the OTP path — redeeming a Magic
   * Auth code proves email ownership — kept as a classified terse dead-end
   * (sign in with an emailed code instead) should WorkOS ever answer it.
   */
  "email_verification_required",
  /**
   * The email's domain is governed by an SSO connection, so the identity
   * provider refuses email-code authentication for it outright. Not a
   * credential failure and not account-specific — it is domain policy.
   */
  "sso_required",
  /**
   * The emailed code was refused — wrong, expired, or already spent. One code
   * for all three deliberately: WorkOS does not reliably distinguish them,
   * and the user's recovery is the same either way (retype the code, or
   * resend and start over).
   */
  "invalid_verification_code",
  /**
   * The account resolved to more than one organization, and V1 is
   * personal-org-only: rather than silently scoping to whichever the
   * provider listed first, sign-in fails closed until workspace selection
   * ships.
   */
  "multiple_organizations_unsupported",
  /**
   * Workspace rename is limited to single-member (personal) organizations
   * in V1: membership alone must not let one member rename a workspace out
   * from under the rest.
   */
  "organization_rename_not_allowed",
  "validation_failed",
  "rate_limited",
  "internal_error",
]);
export type AccountErrorCode = typeof AccountErrorCode.Type;

export const AccountErrorBody = Schema.Struct({
  error: AccountErrorCode,
  message: TrimmedNonEmptyString,
});
export type AccountErrorBody = typeof AccountErrorBody.Type;

/**
 * The 403 a device token gets when it is not scoped to an organization the
 * caller belongs to — either it carries no `org_id` at all (every device-grant
 * token, since WorkOS mints those org-less) or it names one the caller has
 * since left. It is not a dead end: `organizations` lists what the caller can
 * refresh into, so the client re-runs the refresh grant with one of them and
 * retries. Distinct from {@link AccountErrorBody} by that list alone, which is
 * why the client must try this shape first.
 */
export const OrganizationRequiredBody = Schema.Struct({
  error: Schema.Literal("organization_required"),
  message: TrimmedNonEmptyString,
  organizations: Schema.Array(OrganizationSummary),
});
export type OrganizationRequiredBody = typeof OrganizationRequiredBody.Type;

// ── Email OTP authentication (WorkOS Magic Auth) ─────────────────────
//
// Email sign-in happens inside the app: the user types their address, WorkOS
// emails them a 6-digit code, and redeeming it yields a session. Sign-in and
// sign-up are one path — WorkOS provisions the user on first successful
// redemption when sign-up is allowed. The code is a credential and travels
// pass-through at every hop: never persisted, never logged, and never echoed
// back in an error. The account service must proxy rather than let the client
// call WorkOS directly, because the Magic Auth grant requires the client
// secret.
//
// SSO (Google/Apple/GitHub) does not use these — it takes the PKCE authorize
// flow below, which hands the user to the provider's page in a real browser.

/**
 * The 6-digit code WorkOS emails — the Magic Auth OTP and the email
 * verification code share the format. Fixed-format by the provider, so it is
 * checkable here — and a malformed code can be refused before it travels
 * anywhere.
 */
export const EmailVerificationCode = Schema.String.check(Schema.isPattern(/^[0-9]{6}$/));
export type EmailVerificationCode = typeof EmailVerificationCode.Type;

/** The body of `POST /api/v1/auth/otp/send` — just the address to email. */
export const OtpSendRequest = Schema.Struct({
  email: AccountEmailString,
});
export type OtpSendRequest = typeof OtpSendRequest.Type;

/**
 * The 202 the send route answers. Deliberately identical whether or not the
 * address maps to an existing account — the pair of fields here is everything
 * the client may learn, and the emailed code itself must never appear.
 */
export const OtpSendResponse = Schema.Struct({
  /** Echo of the address the code was sent to. */
  email: TrimmedNonEmptyString,
  /** When the emailed code stops working, ISO-8601. */
  expiresAt: TrimmedNonEmptyString,
});
export type OtpSendResponse = typeof OtpSendResponse.Type;

/**
 * The body of `POST /api/v1/auth/otp/authenticate`. The code is a credential
 * — never logged, never echoed back in an error.
 */
export const OtpAuthenticateRequest = Schema.Struct({
  email: AccountEmailString,
  code: EmailVerificationCode,
});
export type OtpAuthenticateRequest = typeof OtpAuthenticateRequest.Type;

// ── SSO via authorization code + PKCE (desktop/app path) ─────────────
//
// "Continue with Google/Apple/GitHub" takes the authorization-code grant
// with PKCE and a loopback redirect: the server starts a one-shot listener
// on 127.0.0.1, asks the account service for the provider's authorize URL
// (so the identity vendor stays invisible on this wire), opens it in the
// system browser, and exchanges the returned code — again through the
// account service. Every path converges on the same session establishment.

/**
 * Which identity provider an SSO button deep-links to. Deliberately Synara's
 * own vocabulary, not any vendor's spelling: the account service translates
 * to whatever its identity provider calls them.
 */
export const AccountSsoProvider = Schema.Literals(["google", "apple", "github"]);
export type AccountSsoProvider = typeof AccountSsoProvider.Type;

/**
 * The body of `POST /api/v1/auth/authorize` — asks the account service to
 * build the provider's authorize URL. The challenge and state are one-way
 * values (the verifier never travels here); the redirect URI must be a
 * loopback URL, which the service enforces.
 */
export const AuthorizeUrlRequest = Schema.Struct({
  provider: AccountSsoProvider,
  redirectUri: boundedTrimmedNonEmptyString(ACCOUNT_ENDPOINT_URL_MAX_LENGTH),
  /** base64url S256 challenge derived from the (never-transmitted) verifier. */
  codeChallenge: AccountAuthTokenString,
  /** Random CSRF binder echoed back on the loopback callback. */
  state: AccountAuthTokenString,
});
export type AuthorizeUrlRequest = typeof AuthorizeUrlRequest.Type;

export const AuthorizeUrlResponse = Schema.Struct({
  authorizeUrl: TrimmedNonEmptyString,
});
export type AuthorizeUrlResponse = typeof AuthorizeUrlResponse.Type;

/**
 * The body of `POST /api/v1/auth/authorize/token` — redeems the authorization
 * code the loopback callback delivered, proving possession with the PKCE
 * verifier. Both fields are single-use credentials with the full no-leak
 * handling rules: never logged, never persisted, never echoed in an error.
 */
export const AuthorizeTokenRequest = Schema.Struct({
  code: AccountAuthTokenString,
  codeVerifier: AccountAuthTokenString,
});
export type AuthorizeTokenRequest = typeof AuthorizeTokenRequest.Type;

/**
 * What a successful authentication grant yields: one token-pair shape for
 * every sign-in path, so everything downstream — workspace scoping,
 * credential persistence, refresh — is one code path regardless of how the
 * user signed in.
 */
export const AuthTokensResponse = Schema.Struct({
  accessToken: TrimmedNonEmptyString,
  refreshToken: TrimmedNonEmptyString,
  user: Schema.Struct({
    id: TrimmedNonEmptyString,
    email: TrimmedNonEmptyString,
    name: Schema.optional(TrimmedNonEmptyString),
  }),
});
export type AuthTokensResponse = typeof AuthTokensResponse.Type;

/** The body of `POST /api/v1/auth/refresh`. The refresh token is a credential. */
export const RefreshTokenRequest = Schema.Struct({
  refreshToken: AccountAuthTokenString,
  /**
   * Which workspace to authenticate into. The resulting access token carries
   * the organization claim the host routes authorize on, so a refresh
   * without this yields a token those routes will refuse.
   */
  organizationId: Schema.optional(AccountAuthTokenString),
});
export type RefreshTokenRequest = typeof RefreshTokenRequest.Type;

/**
 * What a successful refresh yields. `organizationId` echoes the workspace
 * the new token is scoped to when the provider reports one; a caller that
 * asked for a specific workspace can check the echo instead of trusting
 * blindly.
 */
export const RefreshTokenResponse = Schema.Struct({
  ...AuthTokensResponse.fields,
  organizationId: Schema.optional(TrimmedNonEmptyString),
});
export type RefreshTokenResponse = typeof RefreshTokenResponse.Type;

// ── In-app account session (server-brokered, not the CLI) ────────────
//
// The app never holds account *session* credentials: the server owns the
// stored credential file and every WorkOS round trip, and the schemas below
// are what it reports over the WebSocket RPC.
//
// There are two ways in, and they differ only in how the tokens are obtained:
//
//   email OTP — the user types their email in the app, WorkOS emails a
//               6-digit code, and redeeming it in the same dialog signs them
//               in (provisioning the account first if it is new). The code
//               passes through server and account service to WorkOS and is
//               stored nowhere along the way.
//   SSO       — "Continue with Google/Apple/GitHub" takes the PKCE authorize
//               flow below, which opens the provider's page in a real
//               browser. Sign-in is two calls rather than a polling loop in
//               the app because the server does the waiting.
//
// Both end in the same place: a scoped token pair persisted server-side, and
// an {@link AccountStatus} describing it.

/**
 * Whether this machine currently has a usable account session, and who it
 * belongs to. Deliberately not a boolean plus a nullable user: a signed-in
 * state without an identity is not representable.
 */
export const AccountStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("signed-out") }),
  Schema.Struct({ state: Schema.Literal("signed-in"), me: AccountMe }),
]);
export type AccountStatus = typeof AccountStatus.Type;

/** Asks WorkOS to email the 6-digit sign-in code to `email`. */
export const AccountSendOtpInput = OtpSendRequest;
export type AccountSendOtpInput = typeof AccountSendOtpInput.Type;

/** What a successful send reports back — never the code itself. */
export const AccountSendOtpResult = OtpSendResponse;
export type AccountSendOtpResult = typeof AccountSendOtpResult.Type;

/**
 * In-app OTP sign-in: the emailed 6-digit code plus the address it was sent
 * to. The code is a credential with the same handling rules as a password —
 * it must never be logged by transport-level request tracing.
 */
export const AccountAuthenticateOtpInput = OtpAuthenticateRequest;
export type AccountAuthenticateOtpInput = typeof AccountAuthenticateOtpInput.Type;

/**
 * Starts the desktop PKCE SSO path for one provider. The server owns the
 * loopback listener, the verifier, and the state — none of them travel to the
 * app; the dialog only ever sees the id to complete with and the URL to open.
 */
export const AccountBeginSsoInput = Schema.Struct({
  provider: AccountSsoProvider,
});
export type AccountBeginSsoInput = typeof AccountBeginSsoInput.Type;

/**
 * What the sign-in dialog needs from a started SSO attempt: the handle to
 * complete/abandon it by, and the provider's authorize URL (deep-linked to
 * the chosen provider) for the browser hand-off. There is no user code —
 * the loopback redirect is the binding.
 */
export const AccountBeginSsoResult = Schema.Struct({
  ssoId: TrimmedNonEmptyString,
  authorizeUrl: TrimmedNonEmptyString,
});
export type AccountBeginSsoResult = typeof AccountBeginSsoResult.Type;

export const AccountCompleteSsoInput = Schema.Struct({
  ssoId: TrimmedNonEmptyString,
});
export type AccountCompleteSsoInput = typeof AccountCompleteSsoInput.Type;

/**
 * The onboarding write. `workspaceName` renames the WorkOS organization, and
 * travels with the profile because onboarding presents them as one step; it is
 * optional so later edits to the profile alone do not have to restate it.
 */
export const AccountUpdateProfileInput = Schema.Struct({
  ...UpdateProfileRequest.fields,
  workspaceName: Schema.optional(AccountNameString),
});
export type AccountUpdateProfileInput = typeof AccountUpdateProfileInput.Type;

/**
 * Byte budget of an avatar upload as it crosses the WS JSON protocol: the
 * service caps the raw image at 300KB (`AVATAR_MAX_BYTES` in the API), and
 * base64 inflates bytes 4/3 — 400k characters decode to at most 300,000
 * bytes, so the schema refuses anything the service would refuse anyway
 * before it is decoded or forwarded. The web app's compressor produces
 * ~5–12KB images, nowhere near the bound.
 */
export const ACCOUNT_AVATAR_BASE64_MAX_LENGTH = 400_000;

/** The image types PUT /profile/avatar accepts, mirrored client-side. */
export const AccountAvatarContentType = Schema.Literals(["image/webp", "image/jpeg", "image/png"]);
export type AccountAvatarContentType = typeof AccountAvatarContentType.Type;

/**
 * The avatar upload as the web app hands it to the server: the compressed
 * image bytes base64-encoded (the WS protocol is JSON, and at ≤300KB raw the
 * 4/3 inflation is a fine trade for staying on the one transport), plus the
 * content type the compressor produced. The server decodes and forwards the
 * raw bytes to PUT /profile/avatar, which is the only writer of
 * `avatarSource: "uploaded"`.
 */
export const AccountUploadAvatarInput = Schema.Struct({
  bytes: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ACCOUNT_AVATAR_BASE64_MAX_LENGTH),
  ),
  contentType: AccountAvatarContentType,
});
export type AccountUploadAvatarInput = typeof AccountUploadAvatarInput.Type;

/**
 * The URL to hand to the system browser. Constrained to the authorize URL of
 * an SSO attempt this server just started: the server refuses anything else,
 * so this method can never become a general "open any URL for me" primitive.
 */
export const AccountOpenVerificationUrlInput = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type AccountOpenVerificationUrlInput = typeof AccountOpenVerificationUrlInput.Type;
