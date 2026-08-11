// FILE: identity/interfaces.ts
// Purpose: The identity adapter seam. Synara's domain — the routes and
// everything downstream — depends on these interfaces and their classified
// failure vocabulary only, never on a concrete identity provider. Provider
// SDK-isms, error spellings, and wire shapes stop at the sibling
// implementation modules; nothing provider-specific may appear here.
// Layer: API identity (contract)
// Depends on: @synara/contracts (shared wire types) only.

import type {
  AccountHost,
  AccountSsoProvider,
  DeviceAuthorizationResponse,
  InstanceInfo,
  RegisterHostRequest,
  UpdateHostRequest,
} from "@synara/contracts";

/** The subset of a user this service surfaces (see /me). */
export type IdentityUser = {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
};

export type VerifiedAccessToken = {
  userId: string;
  sessionId: string;
  /**
   * The organization the token is scoped to, when it has one. Absent on every
   * token the device grant mints — the provider only puts an organization
   * claim in a token obtained by authenticating *into* an organization, which
   * for this service means the refresh grant carrying an `organization_id`.
   */
  orgId?: string;
};

/** An organization the caller belongs to, as the identity provider names it. */
export type OrganizationRef = {
  orgId: string;
  orgName: string;
};

/**
 * Why an authentication grant failed, as this service classifies it. Providers
 * report failures in their own spellings, inconsistently placed; each
 * implementation classifies once into this vocabulary, and everything
 * downstream branches on it alone.
 */
export type AuthFailureReason =
  | "email_verification_required"
  | "sso_required"
  /** The grant refused the emailed code itself; retyping it can help. */
  | "invalid_verification_code"
  /** The code (or its pending token) is spent or expired; only a resend recovers. */
  | "verification_expired"
  /**
   * The provider requires the caller to choose between several
   * organizations. V1 is personal-org-only and fails closed on this: the
   * refusal becomes a clear "multiple workspaces aren't supported yet"
   * answer, never a silent first-organization pick and never an opaque 502.
   */
  | "organization_selection_required";

/**
 * What an `email_verification_required` refusal carries beyond its reason —
 * the exact fields completing verification in-app needs, extracted
 * allowlist-style from the provider's refusal. The pending token is a
 * bearer-ish secret: it may travel to the client, but never into a log or an
 * error message.
 */
export type EmailVerificationChallenge = {
  pendingAuthenticationToken: string;
  email: string;
  emailVerificationId: string;
};

/**
 * An authentication grant this service refused to complete. Carries the
 * classified reason and nothing else: notably not the submitted code, and not
 * the provider's raw message, which can echo the submitted credentials back.
 * The one exception is `email_verification_required`, whose refusal names the
 * pending token, email, and verification id — the fields the in-app
 * verification step redeems — and those are carried on {@link verification},
 * allowlisted field by field.
 */
export class IdentityAuthError extends Error {
  constructor(
    readonly reason: AuthFailureReason,
    readonly verification?: EmailVerificationChallenge,
  ) {
    super(reason);
    this.name = "IdentityAuthError";
  }
}

/**
 * An identity-provider call that failed outside the classified vocabulary —
 * an outage, a rejected API key, an unexpected body. Carries the upstream
 * HTTP status so callers can distinguish "this user no longer exists" (404)
 * from "the provider is down", and a message that must never contain request
 * or response fields on a credential path.
 */
export class IdentityProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IdentityProviderError";
  }
}

/**
 * Where an authentication request originally came from, forwarded upstream so
 * the provider's own risk controls see the caller rather than this proxy.
 * Both fields are sanitized before they get here (see clientIp.ts) and are
 * advisory only — absence must never fail a grant.
 */
export type AuthRequestContext = {
  ipAddress?: string;
  userAgent?: string;
};

/** The token pair a successful authentication grant yields. */
export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  user: IdentityUser;
};

/**
 * One answer from the device-token poll. The non-granted statuses are
 * expected states of a healthy flow — a user who has not clicked yet is not
 * an error — so they are values, not exceptions. `slow_down` carries RFC 8628
 * semantics (increase the polling interval); `expired` and `denied` are
 * terminal.
 */
export type DeviceTokenPollResult =
  | { status: "granted"; tokens: AuthTokens }
  | { status: "pending" | "slow_down" | "expired" | "denied" };

/**
 * What a successful refresh yields: the rotated pair plus which workspace the
 * new access token is scoped to, when the provider reports one.
 */
export type RefreshedTokens = AuthTokens & { organizationId?: string };

/**
 * The provider terminally refused a refresh — the token is spent, revoked, or
 * names a workspace the user has left. Distinct from
 * {@link IdentityProviderError} because the caller's recovery differs: a
 * refusal means the stored session is dead and a fresh sign-in is the only
 * cure, while a provider fault says nothing about the token at all.
 */
export class RefreshRejectedError extends Error {
  constructor() {
    super("The refresh token was rejected");
    this.name = "RefreshRejectedError";
  }
}

/**
 * What creating a one-time sign-in code reports back. Deliberately NOT the
 * provider's whole response: that response can contain the code itself, which
 * is a credential and must never leave the implementation module — not in a
 * return value, not in a log, not in an error.
 */
export type OtpChallenge = {
  email: string;
  /** When the emailed code stops working, ISO-8601. */
  expiresAt: string;
};

/**
 * What `/instance` publishes about this deployment's identity wiring. The
 * client id and provider origin are deprecated-but-present: every provider
 * call is proxied now, so Synara's own clients ignore them, but clients from
 * before the proxy cutover still poll the provider directly with them. The
 * field names are wire contract and must stay stable; `authMode` may grow
 * into a literal union as more provider families ship, but existing values
 * must keep meaning what they mean today.
 */
export type InstanceAuthInfo = Omit<InstanceInfo, "version">;

/**
 * Verifies who a caller is and performs the authentication grants — the seam
 * between Synara's account routes and whichever identity provider backs them.
 * Every leg of every flow goes through here: the identity vendor is invisible
 * on the client wire, which is what makes a self-hosted or generic-OIDC
 * implementation a drop-in rather than a client change.
 */
export type AccountIdentityVerifier = {
  /** Rejects on any invalid, expired, or unverifiable token; callers answer 401. */
  verifyAccessToken(token: string): Promise<VerifiedAccessToken>;
  getUser(userId: string): Promise<IdentityUser>;
  /**
   * Starts the SSO device-authorization flow — how "Continue with
   * Google/GitHub" and the CLI's `synara auth` reach the provider. Runs here
   * because starting it needs a secret a public client cannot hold.
   */
  requestDeviceAuthorization(): Promise<DeviceAuthorizationResponse>;
  /**
   * Builds the provider's authorization-code + PKCE authorize URL for the
   * desktop SSO path, deep-linked to `provider`. `redirectUri` must be a
   * loopback URL (the route enforces this before calling); `codeChallenge` is
   * the S256 challenge — one-way, so it may travel — and `state` is the
   * caller's CSRF binder, echoed back on the redirect. Building the URL
   * consumes nothing; the credential work happens at the exchange.
   */
  buildAuthorizeUrl(input: {
    provider: AccountSsoProvider;
    redirectUri: string;
    codeChallenge: string;
    state: string;
  }): string;
  /**
   * Exchanges the authorization code the loopback callback delivered for a
   * token pair, proving possession with the PKCE verifier. Both inputs are
   * single-use credentials and take the no-leak handling rules. Rejects with
   * {@link IdentityAuthError} for a classified refusal and
   * {@link IdentityProviderError} for provider faults.
   */
  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    context?: AuthRequestContext;
  }): Promise<AuthTokens>;
  /**
   * One poll of the device grant: redeems the device code once the user has
   * approved, and reports the flow's state until then. The non-granted
   * outcomes come back as values (see {@link DeviceTokenPollResult}) — a
   * user who has not clicked yet is not an exception. The device code is
   * bearer-ish and takes the no-leak handling rules.
   */
  pollDeviceToken(input: {
    deviceCode: string;
    context?: AuthRequestContext;
  }): Promise<DeviceTokenPollResult>;
  /**
   * Redeems a refresh token for a rotated pair, optionally authenticating
   * into `organizationId` so the new access token carries the organization
   * claim the host routes authorize on. Rejects with
   * {@link RefreshRejectedError} when the provider terminally refuses the
   * token — spent, revoked, or naming a workspace the user has left — and
   * with {@link IdentityProviderError} for provider faults, which say nothing
   * about the token. The refresh token is a credential and takes the no-leak
   * handling rules.
   */
  refreshTokens(input: {
    refreshToken: string;
    organizationId?: string;
    context?: AuthRequestContext;
  }): Promise<RefreshedTokens>;
  /**
   * Creates a one-time sign-in code: the provider mints a 6-digit code and
   * delivers it to `email` itself. Only the address echo and expiry are
   * returned — the code must never leave the implementation module.
   */
  createOtpChallenge(input: { email: string }): Promise<OtpChallenge>;
  /**
   * Redeems the emailed 6-digit code for a token pair, provisioning the user
   * first when sign-up is allowed and the address is new. Requires the
   * provider's client secret, which is the whole reason this runs here rather
   * than in the app. The code is a credential and takes the no-leak handling
   * rules. Rejects with {@link IdentityAuthError} carrying
   * `invalid_verification_code` (retry in place) or `verification_expired`
   * (only a resend recovers).
   */
  authenticateWithOtp(input: {
    email: string;
    code: string;
    context?: AuthRequestContext;
  }): Promise<AuthTokens>;
  /**
   * Redeems the emailed 6-digit code together with the pending authentication
   * token an `email_verification_required` refusal carried. Both inputs are
   * bearer-ish secrets and take the no-leak handling rules. Rejects with
   * {@link IdentityAuthError} carrying `invalid_verification_code` (retry in
   * place) or `verification_expired` (the token or code is spent; only a
   * resend recovers).
   */
  verifyEmailCode(input: {
    code: string;
    pendingAuthenticationToken: string;
    context?: AuthRequestContext;
  }): Promise<AuthTokens>;
  /**
   * Emails the user a fresh verification code, invalidating the old one. The
   * user is resolved from the verification object server-side — the caller
   * only ever holds the verification id. Rejects with a 404-status
   * {@link IdentityProviderError} for an unknown or expired id; the route
   * deliberately flattens that into the same 202 as success.
   */
  resendVerificationEmail(emailVerificationId: string): Promise<void>;
  /**
   * What `/instance` publishes about this deployment's identity wiring.
   * Every provider call is proxied through this service now; the client id
   * and provider origin in here are deprecated-but-present solely for
   * clients built before the proxy cutover, which still poll the provider
   * directly with them.
   */
  describeInstanceAuth(): InstanceAuthInfo;
};

/**
 * The outcome of asking which environment scope a verified token may act
 * inside. `selection_required` carries the caller's organizations so the
 * client can re-scope its token and retry; `why` distinguishes a token that
 * never named a workspace from one naming a workspace the caller has left.
 */
export type EnvironmentScopeResolution =
  | { kind: "scoped"; organization: OrganizationRef }
  | {
      kind: "selection_required";
      why: "unscoped" | "not_a_member";
      organizations: OrganizationRef[];
    };

/**
 * Decides which environment scope a caller acts inside — today, which
 * organization a token is honoured for: membership check plus personal-org
 * provisioning on first use.
 *
 * The name is for what this grows into, not only what it does now. Today the
 * "grant" is implicit: the access token itself carries the organization claim
 * and membership is re-checked per request. Step 10 of the agreed sequence
 * makes the grant explicit — `establishSession` (apps/server) is the
 * client-side seam — so this issuer's future shape is "exchange a verified
 * identity for a short-lived, environment-scoped grant, eventually bound to a
 * device credential (proof-of-possession)". When that lands, issuance methods
 * are added here; the resolution below remains the authorization backbone.
 */
export type EnvironmentGrantIssuer = {
  /**
   * Which organization the session may act inside, provisioning a personal
   * one on first use so each user has a workspace from their first sign-in.
   * Membership is an authorization input: implementations must fail a request
   * they cannot answer rather than degrade to an empty list.
   *
   * Two freshness levels, chosen by the route. Reads/display may serve a
   * short-lived cached membership (staleness SLA ≤60s: a revoked member can
   * keep read access for at most that long). PRIVILEGED/MUTATING operations
   * pass `freshMembership: true` and get a live provider answer, so
   * revocation takes effect immediately where it matters. Mutations are
   * rare; the extra provider round trip is the accepted price.
   */
  resolveEnvironmentScope(
    session: VerifiedAccessToken,
    email: string,
    options?: { freshMembership?: boolean },
  ): Promise<EnvironmentScopeResolution>;
  /**
   * Renames an organization and invalidates whatever the implementation
   * caches about it. Callers must have checked membership first.
   */
  renameOrganization(orgId: string, name: string): Promise<OrganizationRef>;
  /**
   * How many members `orgId` has, up to `atLeast` — the caller only ever
   * needs "is this a single-member (personal) organization", so
   * implementations may stop counting at the bound rather than paginate a
   * large team. An authorization input: implementations must fail a request
   * they cannot answer rather than degrade to a guess.
   */
  countOrganizationMembers(orgId: string, atLeast: number): Promise<number>;
};

export type DeviceCredentialAuthResult =
  | { ok: true; hostId: string }
  | { ok: false; status: 401; error: "unauthorized" }
  | { ok: false; status: 403; error: "token_revoked" };

/**
 * Mints, verifies, and revokes the long-lived credentials machines hold —
 * today the `synhost_` host tokens, hashed at rest, one active per host.
 * The future device-bound PoP credentials (maintainer step 10) slot in here.
 */
export type DeviceCredentialStore = {
  /**
   * Revokes every active credential for `hostId` and mints a fresh one,
   * returning the only copy of the plaintext token that will ever exist.
   * On a freshly registered host there is nothing to revoke and this is
   * simply the first mint.
   */
  rotate(hostId: string): Promise<string>;
  /** Resolves an Authorization header to its owning host, or a typed failure. */
  authenticate(authorizationHeader: string | undefined | null): Promise<DeviceCredentialAuthResult>;
  /** Whether the header carries a device credential (vs. a user access token). */
  isDeviceCredential(authorizationHeader: string | undefined | null): boolean;
};

/**
 * A registration refused because the environment is already linked to another
 * host record in the same organization.
 */
export class EnvironmentAlreadyLinkedError extends Error {
  constructor() {
    super("This environment is already linked to another host record");
    this.name = "EnvironmentAlreadyLinkedError";
  }
}

/**
 * The directory of environments (hosts) an organization owns — the registry
 * half of the control plane. Speaks contract types on the way out so callers
 * never touch storage rows.
 */
export type EnvironmentRegistry = {
  list(orgId: string): Promise<AccountHost[]>;
  /**
   * Registers an environment, or refreshes its record when the organization
   * already linked this `environmentId`. `registeredByUserId` is audit only
   * and must never be consulted for access. Rejects with
   * {@link EnvironmentAlreadyLinkedError} when the environment is linked to a
   * different host record.
   */
  register(
    orgId: string,
    registeredByUserId: string,
    request: RegisterHostRequest,
  ): Promise<{ host: AccountHost; created: boolean }>;
  /** Applies a host's self-reported update, bumping lastSeenAt. Undefined when unknown. */
  update(hostId: string, request: UpdateHostRequest): Promise<AccountHost | undefined>;
  /** Owner removal: scoped to the organization. False when nothing matched. */
  deleteForOrg(hostId: string, orgId: string): Promise<boolean>;
  /** Self-removal by the host itself, already authenticated by its credential. */
  deleteById(hostId: string): Promise<void>;
};

/**
 * The four adapters, built together by the factory so wiring stays in one
 * place. `close` releases whatever the provider holds open (the dev provider
 * runs an in-process endpoint); for the hosted provider it is a no-op.
 */
export type IdentityAdapters = {
  verifier: AccountIdentityVerifier;
  grants: EnvironmentGrantIssuer;
  deviceCredentials: DeviceCredentialStore;
  environments: EnvironmentRegistry;
  close(): Promise<void>;
};
