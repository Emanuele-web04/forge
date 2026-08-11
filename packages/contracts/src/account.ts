import { Schema } from "effect";

import { boundedTrimmedNonEmptyString, EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas";

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

export const AccountHostTransport = Schema.Literals(["lan", "tailscale", "public"]);
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
  /** WorkOS user id of whoever ran the registration. Audit only — the
   * organization owns the host, so this grants no access of its own. */
  registeredByUserId: TrimmedNonEmptyString,
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
 * The part of a user's identity Synara owns, as opposed to what WorkOS knows.
 * Its existence is what "onboarding is finished" means — there is no separate
 * flag, so a profile row and a completed onboarding are the same fact.
 */
export const AccountProfile = Schema.Struct({
  handle: AccountProfileHandle,
  displayName: TrimmedNonEmptyString,
  avatarColor: AccountProfileAvatarColor,
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
});
export type UpdateProfileRequest = typeof UpdateProfileRequest.Type;

/** The body of `PATCH /api/v1/organization` — the workspace rename. */
export const UpdateOrganizationRequest = Schema.Struct({
  name: AccountNameString,
});
export type UpdateOrganizationRequest = typeof UpdateOrganizationRequest.Type;

export const RegisterHostRequest = Schema.Struct({
  environmentId: EnvironmentId,
  name: AccountNameString,
  platform: AccountHostPlatform,
  kind: AccountHostKind,
  endpoints: Schema.Array(AccountHostEndpoint).check(
    Schema.isMaxLength(ACCOUNT_HOST_ENDPOINTS_MAX),
  ),
  appVersion: Schema.optional(AccountAppVersionString),
});
export type RegisterHostRequest = typeof RegisterHostRequest.Type;

export const RegisterHostResponse = Schema.Struct({
  host: AccountHost,
  hostToken: TrimmedNonEmptyString,
});
export type RegisterHostResponse = typeof RegisterHostResponse.Type;

export const UpdateHostRequest = Schema.Struct({
  name: Schema.optional(AccountNameString),
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
 * `clientId` and `workosApiUrl` are DEPRECATED: every leg of the device flow
 * (start, poll, refresh) is now proxied through this service, so Synara's own
 * clients no longer talk to the identity provider directly and need neither
 * field. They stay in the wire contract because clients built before the
 * proxy cutover still consume them to poll the provider themselves — do not
 * remove or repurpose them.
 */
export const InstanceInfo = Schema.Struct({
  version: TrimmedNonEmptyString,
  authMode: Schema.Literal("workos"),
  clientId: TrimmedNonEmptyString,
  workosApiUrl: TrimmedNonEmptyString,
});
export type InstanceInfo = typeof InstanceInfo.Type;

/** RFC 8628 device authorization response, camelCased. */
export const DeviceAuthorizationResponse = Schema.Struct({
  deviceCode: TrimmedNonEmptyString,
  userCode: TrimmedNonEmptyString,
  verificationUri: TrimmedNonEmptyString,
  verificationUriComplete: TrimmedNonEmptyString,
  expiresIn: Schema.Number,
  interval: Schema.Number,
});
export type DeviceAuthorizationResponse = typeof DeviceAuthorizationResponse.Type;

/**
 * One poll of the device-token proxy. The device code is bearer-ish — it
 * redeems into a session once approved — so requests carrying it take the
 * no-leak handling rules on the service side.
 */
export const DeviceTokenRequest = Schema.Struct({
  deviceCode: AccountAuthTokenString,
});
export type DeviceTokenRequest = typeof DeviceTokenRequest.Type;

export const AccountErrorCode = Schema.Literals([
  "unauthorized",
  "host_not_found",
  "token_revoked",
  "organization_required",
  "environment_already_linked",
  "handle_taken",
  /**
   * The identity provider will not authenticate this account until its email
   * address is verified. Not expected on the OTP path — redeeming a Magic
   * Auth code proves email ownership — but kept because the challenge
   * machinery below still serves it, defensively, should WorkOS answer it.
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

/**
 * The 403 a sign-in or sign-up gets when the identity provider refuses to
 * authenticate until the email address is verified. Like
 * {@link OrganizationRequiredBody}, a distinct richer body for one code rather
 * than a widening of the generic one: it is not a dead end, because WorkOS has
 * already emailed the user a 6-digit code and the fields here are exactly what
 * completing verification in-app needs.
 *
 * `pendingAuthenticationToken` is a bearer-ish secret — redeeming it plus the
 * emailed code yields a session. It must live only in the client's in-memory
 * dialog state: never logged, never persisted.
 */
export const EmailVerificationRequiredBody = Schema.Struct({
  error: Schema.Literal("email_verification_required"),
  message: TrimmedNonEmptyString,
  /** Redeemed together with the emailed code by the verification grant. */
  pendingAuthenticationToken: TrimmedNonEmptyString,
  /** The address the code was sent to, for "We sent a code to {email}". */
  email: TrimmedNonEmptyString,
  /** Names the verification server-side; what a resend request carries. */
  emailVerificationId: TrimmedNonEmptyString,
});
export type EmailVerificationRequiredBody = typeof EmailVerificationRequiredBody.Type;

/**
 * {@link EmailVerificationRequiredBody} as an RPC error, so the fields survive
 * the WebSocket hop. The sensitive RPCs' error channel is a union of this and
 * the generic `WsRpcError` (the same shape the pull-request RPCs use for their
 * unavailable state): the ordinary mapping strips everything but a message and
 * code off a credential-carrying failure, and this is the one refusal whose
 * payload the client genuinely needs — it is what the in-app verification
 * step redeems.
 *
 * The same no-persistence rule as the HTTP body applies: dialog state only.
 */
export class AccountEmailVerificationRequiredError extends Schema.TaggedErrorClass<AccountEmailVerificationRequiredError>()(
  "AccountEmailVerificationRequiredError",
  {
    message: TrimmedNonEmptyString,
    pendingAuthenticationToken: TrimmedNonEmptyString,
    email: TrimmedNonEmptyString,
    emailVerificationId: TrimmedNonEmptyString,
  },
) {}

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
// SSO (Google/GitHub) does not use these — it takes the device-grant flow
// below, which hands the user to the provider's page in a real browser.

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

/**
 * The body of `POST /api/v1/auth/verify-email` — the emailed code plus the
 * pending token an `email_verification_required` refusal carried. Both are
 * bearer-ish secrets and take the credential handling rules: never logged,
 * never echoed back.
 */
export const VerifyEmailRequest = Schema.Struct({
  code: EmailVerificationCode,
  pendingAuthenticationToken: AccountAuthTokenString,
});
export type VerifyEmailRequest = typeof VerifyEmailRequest.Type;

/** The body of `POST /api/v1/auth/resend-verification`. */
export const ResendVerificationRequest = Schema.Struct({
  emailVerificationId: AccountAuthTokenString,
});
export type ResendVerificationRequest = typeof ResendVerificationRequest.Type;

// ── SSO via authorization code + PKCE (desktop/app path) ─────────────
//
// "Continue with Google/GitHub" on a machine that owns a browser takes the
// authorization-code grant with PKCE and a loopback redirect: the server
// starts a one-shot listener on 127.0.0.1, asks the account service for the
// provider's authorize URL (so the identity vendor stays invisible on this
// wire), opens it in the system browser, and exchanges the returned code —
// again through the account service. The CLI keeps the device grant; it has
// no browser to redirect to. Both converge on the same session establishment.

/**
 * Which identity provider an SSO button deep-links to. Deliberately Synara's
 * own vocabulary, not any vendor's spelling: the account service translates
 * to whatever its identity provider calls them.
 */
export const AccountSsoProvider = Schema.Literals(["google", "github"]);
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
 * What a successful authentication grant yields: the same token pair the
 * device grant produces, so everything downstream — workspace scoping,
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

/**
 * One answer from the device-token proxy (`POST /api/v1/auth/device/token`).
 *
 * Always a 200 with a `status` discriminant rather than an OAuth-style error
 * body: the poll's non-granted outcomes are expected states of a healthy
 * flow, not errors, and a client should never have to sniff refusal bodies
 * to keep looping. `slow_down` carries RFC 8628 semantics — increase the
 * polling interval by at least 5 seconds. `expired` and `denied` are
 * terminal; only a fresh authorization recovers.
 */
export const DeviceTokenPollResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("granted"),
    tokens: AuthTokensResponse,
  }),
  Schema.Struct({
    status: Schema.Literals(["pending", "slow_down", "expired", "denied"]),
  }),
]);
export type DeviceTokenPollResponse = typeof DeviceTokenPollResponse.Type;

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
//   SSO       — "Continue with Google/GitHub" takes the device grant below,
//               which opens the provider's page in a real browser. Sign-in is
//               two calls rather than a polling loop in the app because the
//               server does the waiting.
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

/**
 * What the sign-in modal needs to show. `verificationUriComplete` embeds the
 * user code, so the browser hand-off is one click; `userCode` is still shown
 * because the user must be able to confirm the code on the page matches, and
 * to type it in if the hand-off lands somewhere unexpected.
 */
export const AccountBeginSignInResult = Schema.Struct({
  deviceCode: TrimmedNonEmptyString,
  userCode: TrimmedNonEmptyString,
  verificationUriComplete: TrimmedNonEmptyString,
  expiresIn: Schema.Number,
  interval: Schema.Number,
});
export type AccountBeginSignInResult = typeof AccountBeginSignInResult.Type;

export const AccountCompleteSignInInput = Schema.Struct({
  deviceCode: TrimmedNonEmptyString,
});
export type AccountCompleteSignInInput = typeof AccountCompleteSignInInput.Type;

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
 * In-app email verification: the code the user typed plus the pending token
 * from the `email_verification_required` refusal. Same handling rules as
 * {@link OtpAuthenticateRequest} — the payload is a secret, so it must never
 * be logged by transport-level request tracing.
 */
export const AccountVerifyEmailInput = VerifyEmailRequest;
export type AccountVerifyEmailInput = typeof AccountVerifyEmailInput.Type;

/** Asks the identity provider to email a fresh verification code. */
export const AccountResendVerificationEmailInput = ResendVerificationRequest;
export type AccountResendVerificationEmailInput = typeof AccountResendVerificationEmailInput.Type;

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
 * the chosen provider) for the browser hand-off. Unlike the device grant
 * there is no user code — the loopback redirect is the binding.
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
 * The URL to hand to the system browser. Constrained to the verification URL
 * the account service just issued: the server refuses anything else, so this
 * method can never become a general "open any URL for me" primitive.
 */
export const AccountOpenVerificationUrlInput = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type AccountOpenVerificationUrlInput = typeof AccountOpenVerificationUrlInput.Type;
