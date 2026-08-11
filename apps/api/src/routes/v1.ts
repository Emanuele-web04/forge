import {
  type AccountErrorBody,
  type AccountErrorCode,
  type AccountMe,
  type AccountProfile,
  type AccountProfileAvatarColor,
  type AccountProfileHandle,
  type AuthTokensResponse,
  type DeviceAuthorizationResponse,
  DeviceTokenRequest,
  type DeviceTokenPollResponse,
  type EmailVerificationRequiredBody,
  type InstanceInfo,
  type ListHostsResponse,
  type OrganizationRequiredBody,
  type OrganizationSummary,
  type OtpSendResponse,
  OtpAuthenticateRequest,
  OtpSendRequest,
  type RegisterHostResponse,
  RegisterHostRequest,
  RefreshTokenRequest,
  type RefreshTokenResponse,
  ResendVerificationRequest,
  UpdateHostRequest,
  UpdateOrganizationRequest,
  UpdateProfileRequest,
  VerifyEmailRequest,
} from "@synara/contracts";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Schema } from "effect";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  clientIp,
  DEFAULT_TRUSTED_PROXY_HOPS,
  sanitizeForwardableIp,
  sanitizeForwardableUserAgent,
} from "../clientIp";
import type * as schema from "../db/schema";
import { profiles } from "../db/schema";
import { isUniqueViolation } from "../identity/environmentRegistry";
import {
  EnvironmentAlreadyLinkedError,
  IdentityAuthError,
  IdentityProviderError,
  RefreshRejectedError,
  type AccountIdentityVerifier,
  type AuthFailureReason,
  type AuthTokens,
  type DeviceCredentialStore,
  type EnvironmentGrantIssuer,
  type EnvironmentRegistry,
  type IdentityUser,
  type OrganizationRef,
} from "../identity/interfaces";
import { createRateLimiter } from "../rateLimit";
import packageJson from "../../package.json" with { type: "json" };

const API_VERSION: string = packageJson.version;

/** Device authorizations allowed per client per minute. */
export const DEVICE_RATE_LIMIT_PER_MINUTE = 10;

/**
 * Code-redemption attempts allowed per client per minute. Deliberately far
 * below the device limit: a device authorization is a harmless request for a
 * code, while these carry credentials and are the endpoints worth guessing
 * against. Low enough to make online guessing pointless, high enough to
 * survive a user mistyping a code a few times.
 */
export const OTP_AUTHENTICATE_RATE_LIMIT_PER_MINUTE = 5;

/**
 * Code-sending requests allowed per client per minute — the OTP send and the
 * verification resend share this posture (each has its own budget instance).
 * Deliberately the tightest: every request makes the identity provider send
 * somebody an email, and one user legitimately needs at most one retry a
 * minute — the UI enforces a 60s countdown of its own.
 */
export const OTP_SEND_RATE_LIMIT_PER_MINUTE = 2;

/** Verification-email resends allowed per client per minute. */
export const RESEND_VERIFICATION_RATE_LIMIT_PER_MINUTE = 2;

/**
 * Email sends allowed per recipient address per hour, across all sender IPs.
 * The per-IP budgets bound a single caller; this bounds the *target*: even a
 * caller who defeats IP keying (a botnet, or a header trick against a
 * misconfigured proxy) cannot flood one mailbox past this. Generous enough
 * that a real user retrying across devices never hits it.
 */
export const PER_EMAIL_SEND_RATE_LIMIT_PER_HOUR = 10;

/**
 * Device-token polls allowed per client per minute. Deliberately far above
 * the other auth budgets: polling is chatty BY DESIGN — RFC 8628 has the
 * client re-ask every `interval` seconds (WorkOS hands out 5s, i.e. 12
 * requests a minute) until the user clicks through, and two concurrent
 * sign-ins from one NAT'd office must not starve each other. The device code
 * itself is unguessable, so the budget only needs to stop pathological
 * hammering, not online guessing.
 */
export const DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE = 60;

/**
 * Refresh grants allowed per client per minute. Stricter than polling — a
 * healthy client refreshes once per token lifetime (~5 min), so even a burst
 * of parallel CLI commands stays far under this — but above the redemption
 * budgets, because a refresh storm from one machine is a bug to absorb, not
 * an attack to starve.
 */
export const REFRESH_RATE_LIMIT_PER_MINUTE = 10;

type ProfileRow = typeof profiles.$inferSelect;

function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  error: AccountErrorCode,
  message: string,
) {
  const body: AccountErrorBody = { error, message };
  return c.json(body, status);
}

/**
 * Widens a stored row to the contract. The two branded strings are asserted
 * rather than re-validated: the route validates on the way in, so a row that
 * failed the check here would be a schema drift no read path can repair, and
 * refusing to serve someone their own profile is the worse answer.
 */
function toAccountProfile(row: ProfileRow): AccountProfile {
  return {
    handle: row.handle as AccountProfileHandle,
    displayName: row.displayName,
    avatarColor: row.avatarColor as AccountProfileAvatarColor,
  };
}

function toOrganizationSummary(organization: OrganizationRef): OrganizationSummary {
  return { id: organization.orgId, name: organization.orgName };
}

/** The response body every successful authentication grant answers with. */
/** One rate-limit key per mailbox: case-folded, trimmed. */
function emailRateKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

function authTokensBody(auth_: AuthTokens): AuthTokensResponse {
  return {
    accessToken: auth_.accessToken,
    refreshToken: auth_.refreshToken,
    user: {
      id: auth_.user.id,
      email: auth_.user.email,
      ...(auth_.user.name ? { name: auth_.user.name } : {}),
    },
  };
}

export function createV1Routes(deps: {
  verifier: AccountIdentityVerifier;
  grants: EnvironmentGrantIssuer;
  deviceCredentials: DeviceCredentialStore;
  environments: EnvironmentRegistry;
  db: NodePgDatabase<typeof schema>;
  /**
   * How many proxies in front of this service append to `x-forwarded-for`;
   * see clientIp.ts. Defaults to the deployed shape (Railway, one hop).
   */
  trustedProxyHops?: number;
}): Hono {
  const { verifier, grants, deviceCredentials, environments, db } = deps;
  const trustedProxyHops = deps.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS;
  const v1 = new Hono();

  /** The rate-limiting caller identity for this deployment's proxy shape. */
  const callerIp = (c: Context): string => clientIp(c, trustedProxyHops);

  /**
   * Sanitized caller facts forwarded to the identity provider on the grant
   * calls, so upstream risk controls see the actual caller rather than this
   * proxy. Advisory: absent or unusable values are simply omitted.
   */
  const authContext = (c: Context) => {
    const ipAddress = sanitizeForwardableIp(callerIp(c));
    const userAgent = sanitizeForwardableUserAgent(c.req.header("user-agent"));
    return {
      ...(ipAddress ? { ipAddress } : {}),
      ...(userAgent ? { userAgent } : {}),
    };
  };

  // Per router instance, not module-global: two routers in one process (tests,
  // or a future multi-tenant mount) must not share a budget.
  const deviceRateLimiter = createRateLimiter({
    limit: DEVICE_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  // Separate budget from the device routes, so exhausting one cannot lock a
  // user out of the other.
  const otpAuthenticateRateLimiter = createRateLimiter({
    limit: OTP_AUTHENTICATE_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  // Verify-email has its own instance at the same posture: it shares the
  // redemption budget's SIZE, but a user who exhausted the OTP budget
  // mistyping codes must still be able to complete the verification step
  // mid-flow (and vice versa) — one instance would couple the two.
  const verifyEmailRateLimiter = createRateLimiter({
    limit: OTP_AUTHENTICATE_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  // Its own budget: sends trigger outbound email, and exhausting the
  // redemption budget must not stop a user from asking for a fresh code (or
  // vice versa).
  const otpSendRateLimiter = createRateLimiter({
    limit: OTP_SEND_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  // And again for verification resends, for the same reason.
  const resendVerificationRateLimiter = createRateLimiter({
    limit: RESEND_VERIFICATION_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  // Polling has its own generous budget (see the constant) so a normal RFC
  // 8628 loop never trips it, and exhausting it cannot lock anyone out of
  // starting a flow or refreshing a session.
  const deviceTokenRateLimiter = createRateLimiter({
    limit: DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  const refreshRateLimiter = createRateLimiter({
    limit: REFRESH_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  // The per-recipient budget behind the two email-sending routes. One
  // limiter shared by send and resend deliberately — both put mail in the
  // same mailbox, so they must draw down one target-side allowance — keyed
  // by normalized address (send) or verification id (resend). BOTH the
  // per-IP budget and this must pass.
  const perEmailSendRateLimiter = createRateLimiter({
    limit: PER_EMAIL_SEND_RATE_LIMIT_PER_HOUR,
    windowMs: 60 * 60_000,
  });

  /**
   * Resolves the caller from an access token. Verification is stateless
   * (JWKS signature + expiry), so a revoked session stays valid until its short
   * token lifetime runs out; the client refreshes against the identity
   * provider, which is where revocation takes effect.
   */
  async function getDeviceSession(
    c: Context,
  ): Promise<{ userId: string; sessionId: string; orgId?: string } | null> {
    const authorization = c.req.header("authorization");
    const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
    const token = match?.[1];
    if (!token) return null;
    try {
      return await verifier.verifyAccessToken(token);
    } catch {
      return null;
    }
  }

  /**
   * An authenticated caller acting inside an organization. `orgId` is the only
   * key the host routes authorize on; `userId` is carried for audit stamping
   * and must never be used to decide access.
   */
  type OrgSession = {
    userId: string;
    orgId: string;
    organization: OrganizationSummary;
  };

  function organizationRequired(
    c: Context,
    message: string,
    organizations: readonly OrganizationRef[],
  ) {
    const body: OrganizationRequiredBody = {
      error: "organization_required",
      message,
      organizations: organizations.map(toOrganizationSummary),
    };
    return c.json(body, 403);
  }

  /**
   * The authorization gate for every device-token route: turns a verified
   * token into the organization it may act inside, or the 403 that tells the
   * client how to obtain one.
   *
   * A device-grant token has no organization claim at all — the provider only
   * mints one when the client authenticates *into* an organization — so the
   * first call after `synara auth` always lands here, provisions the user's
   * personal workspace if they have none, and answers 403 with the list to
   * pick from. The client re-runs the refresh grant with `organization_id`
   * and retries. A token naming an organization the caller has since left
   * takes the same path — on reads within the membership cache's ≤60s TTL,
   * and immediately on mutating routes, which resolve membership live.
   *
   * Returns the session, or a Response that the caller must return as-is.
   *
   * Freshness: plain reads (`/me`, host listing, profile) accept the
   * membership cache — a revoked member can retain READ access for up to the
   * cache TTL (≤60s), the documented read-path SLA. PRIVILEGED/MUTATING
   * routes (host register, owner host delete, organization rename) pass
   * `{ freshMembership: true }` so the membership is resolved live and
   * revocation takes effect immediately on anything that changes state.
   */
  async function requireOrgSession(
    c: Context,
    options?: { freshMembership?: boolean },
  ): Promise<OrgSession | Response> {
    const session = await getDeviceSession(c);
    if (!session) return errorResponse(c, 401, "unauthorized", "Not authenticated");

    let user: IdentityUser;
    let scope: Awaited<ReturnType<EnvironmentGrantIssuer["resolveEnvironmentScope"]>>;
    try {
      user = await verifier.getUser(session.userId);
      scope = await grants.resolveEnvironmentScope(session, user.email, options);
    } catch (error) {
      if (error instanceof IdentityProviderError && error.status === 404) {
        return errorResponse(c, 401, "unauthorized", "This account no longer exists");
      }
      console.error("[api] organization resolution failed:", error);
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }

    if (scope.kind === "selection_required") {
      return organizationRequired(
        c,
        scope.why === "unscoped"
          ? "This token is not scoped to a workspace. Refresh it with an organization_id and retry."
          : "You are not a member of the workspace this token names. Refresh it with one of these and retry.",
        scope.organizations,
      );
    }

    return {
      userId: session.userId,
      orgId: scope.organization.orgId,
      organization: toOrganizationSummary(scope.organization),
    };
  }

  /**
   * The caller's profile, or null when they have not onboarded. Read on every
   * `/me` and after every profile write, so it is one indexed primary-key
   * lookup by design.
   */
  async function readProfile(userId: string): Promise<AccountProfile | null> {
    const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
    return row ? toAccountProfile(row) : null;
  }

  /**
   * The `/me` body. Built in one place because three routes answer with it —
   * `/me`, the profile write, and the workspace rename — and a client that saw
   * a different shape from any of them would have to special-case it.
   */
  async function accountMe(
    user: IdentityUser,
    organization: OrganizationSummary,
  ): Promise<AccountMe> {
    return {
      id: user.id,
      name: user.name ?? user.email,
      email: user.email,
      ...(user.avatarUrl ? { image: user.avatarUrl } : {}),
      organization,
      profile: await readProfile(user.id),
    };
  }

  /**
   * The user behind a session, mapping the two failures that matter: a deleted
   * account is the caller's authentication problem, anything else is ours.
   * Returns the user, or the Response to return as-is.
   */
  async function loadSessionUser(c: Context, userId: string): Promise<IdentityUser | Response> {
    try {
      return await verifier.getUser(userId);
    } catch (error) {
      // The token verified, so the caller held a valid session — but the
      // provider will not describe the user. A 404 means the account was
      // deleted while the token was still live, which is an authentication
      // failure from the client's point of view; anything else is an upstream
      // fault and must not be reported as the caller's error.
      if (error instanceof IdentityProviderError && error.status === 404) {
        return errorResponse(c, 401, "unauthorized", "This account no longer exists");
      }
      // Logged because the response deliberately says nothing: a rejected API
      // key, a provider outage, and a mapping bug are one opaque 502 to the
      // caller and would otherwise be indistinguishable in production too.
      console.error("[api] user lookup failed:", error);
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }
  }

  v1.get("/me", async (c) => {
    const session = await requireOrgSession(c);
    if (session instanceof Response) return session;

    const user = await loadSessionUser(c, session.userId);
    if (user instanceof Response) return user;

    return c.json(await accountMe(user, session.organization));
  });

  /**
   * Upserts the caller's profile — the write that completes onboarding.
   *
   * The handle is immutable in V1: it is the closest thing to a public
   * identifier a user has, and a rename needs a redirect story (and a decision
   * about whether the freed handle is claimable) that V1 does not have. So a
   * changed handle is refused rather than silently ignored, which is the
   * failure a client can act on.
   */
  v1.put("/profile", async (c) => {
    const session = await requireOrgSession(c);
    if (session instanceof Response) return session;

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: UpdateProfileRequest;
    try {
      parsed = Schema.decodeUnknownSync(UpdateProfileRequest)(json);
    } catch (error) {
      return errorResponse(
        c,
        400,
        "validation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    const user = await loadSessionUser(c, session.userId);
    if (user instanceof Response) return user;

    const existing = await readProfile(session.userId);
    if (existing && existing.handle !== parsed.handle) {
      return errorResponse(
        c,
        400,
        "validation_failed",
        "Your handle cannot be changed once it is set",
      );
    }

    try {
      await db
        .insert(profiles)
        .values({
          userId: session.userId,
          handle: parsed.handle,
          displayName: parsed.displayName,
          avatarColor: parsed.avatarColor,
        })
        // Only the editable columns are updated. `handle` is excluded rather
        // than written back identically: the guard above already refused a
        // change, and leaving it out of the statement means a future guard bug
        // cannot rewrite someone's handle through this path.
        .onConflictDoUpdate({
          target: profiles.userId,
          set: {
            displayName: parsed.displayName,
            avatarColor: parsed.avatarColor,
            updatedAt: new Date(),
          },
        });
    } catch (error) {
      // The unique index on `handle` is the reservation; a violation here means
      // somebody else holds it, including when two first-time writes race.
      if (isUniqueViolation(error)) {
        return errorResponse(c, 409, "handle_taken", "That handle is already taken");
      }
      throw error;
    }

    return c.json(await accountMe(user, session.organization));
  });

  /**
   * Renames the workspace. The name lives on the identity provider's
   * organization rather than here, so this is a write-through — gated on
   * membership by `requireOrgSession` (which stops a caller renaming an
   * organization they merely know the id of) AND on the organization being
   * single-member. V1 is personal-org-only: membership alone must not let
   * one member of a shared team rename the workspace for everyone, and with
   * multi-org sign-in failing closed this is defense-in-depth, not the
   * primary control.
   */
  v1.patch("/organization", async (c) => {
    // Mutating and privileged: membership resolved live, never off the cache.
    const session = await requireOrgSession(c, { freshMembership: true });
    if (session instanceof Response) return session;

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: UpdateOrganizationRequest;
    try {
      parsed = Schema.decodeUnknownSync(UpdateOrganizationRequest)(json);
    } catch (error) {
      return errorResponse(
        c,
        400,
        "validation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    const user = await loadSessionUser(c, session.userId);
    if (user instanceof Response) return user;

    try {
      // Asking for up to 2 answers "single-member or not" in one bounded
      // request; an unanswerable count fails the request (authorization
      // input), it does not degrade to a guess.
      const members = await grants.countOrganizationMembers(session.orgId, 2);
      if (members > 1) {
        return errorResponse(
          c,
          403,
          "organization_rename_not_allowed",
          "Only a personal workspace can be renamed",
        );
      }
    } catch (error) {
      console.error("[api] organization member count failed:", error);
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }

    let renamed: OrganizationRef;
    try {
      renamed = await grants.renameOrganization(session.orgId, parsed.name);
    } catch (error) {
      console.error("[api] organization rename failed:", error);
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }

    return c.json(await accountMe(user, toOrganizationSummary(renamed)));
  });

  v1.get("/hosts", async (c) => {
    const session = await requireOrgSession(c);
    if (session instanceof Response) return session;

    const body: ListHostsResponse = { hosts: await environments.list(session.orgId) };
    return c.json(body);
  });

  v1.post("/hosts", async (c) => {
    // Mutating: registering mints a host credential, so membership is
    // resolved live — a just-revoked member must not link machines.
    const session = await requireOrgSession(c, { freshMembership: true });
    if (session instanceof Response) return session;

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: RegisterHostRequest;
    try {
      parsed = Schema.decodeUnknownSync(RegisterHostRequest)(json);
    } catch (error) {
      return errorResponse(
        c,
        400,
        "validation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    try {
      const { host, created } = await environments.register(session.orgId, session.userId, parsed);
      // Registering is also the (re-)link that rotates the host's credential:
      // any previously issued token is revoked and the fresh one returned —
      // shown exactly once.
      const hostToken = await deviceCredentials.rotate(host.id);

      const body: RegisterHostResponse = { host, hostToken };
      return c.json(body, created ? 201 : 200);
    } catch (error) {
      if (error instanceof EnvironmentAlreadyLinkedError) {
        return errorResponse(c, 409, "environment_already_linked", error.message);
      }
      throw error;
    }
  });

  v1.patch("/hosts/:id", async (c) => {
    const id = c.req.param("id");
    const authHeader = c.req.header("authorization");

    const result = await deviceCredentials.authenticate(authHeader);
    if (!result.ok) return errorResponse(c, result.status, result.error, "Host token invalid");
    if (result.hostId !== id) {
      return errorResponse(c, 401, "unauthorized", "Host token does not match this host");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: UpdateHostRequest;
    try {
      parsed = Schema.decodeUnknownSync(UpdateHostRequest)(json);
    } catch (error) {
      return errorResponse(
        c,
        400,
        "validation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    const updated = await environments.update(id, parsed);
    if (!updated) return errorResponse(c, 404, "host_not_found", "Host not found");

    return c.json({ host: updated });
  });

  v1.delete("/hosts/:id", async (c) => {
    const id = c.req.param("id");
    const authHeader = c.req.header("authorization");

    if (deviceCredentials.isDeviceCredential(authHeader)) {
      const result = await deviceCredentials.authenticate(authHeader);
      if (!result.ok) return errorResponse(c, result.status, result.error, "Host token invalid");
      if (result.hostId !== id) {
        return errorResponse(c, 401, "unauthorized", "Host token does not match this host");
      }
      await environments.deleteById(id);
      return c.body(null, 204);
    }

    // Mutating: owner deletion is resolved against live membership.
    const session = await requireOrgSession(c, { freshMembership: true });
    if (session instanceof Response) return session;

    const deleted = await environments.deleteForOrg(id, session.orgId);
    if (!deleted) return errorResponse(c, 404, "host_not_found", "Host not found");

    return c.body(null, 204);
  });

  v1.get("/instance", (c) => {
    const body: InstanceInfo = {
      version: API_VERSION,
      ...verifier.describeInstanceAuth(),
    };
    return c.json(body);
  });

  /**
   * The in-app email OTP routes.
   *
   * These exist because the one-time-code grant is a confidential-client
   * grant: it requires the client secret, so the app cannot make the call
   * itself and something holding the secret has to proxy it. The emailed code
   * is a credential and is pass-through at every step here — it is read off
   * the request, handed to the identity provider, and never written to the
   * database, a log line, or an error message. Nothing below may start doing
   * so.
   *
   * SSO (Google/GitHub) does not come through here; it takes the device flow.
   */
  const authFailureResponses: Record<
    AuthFailureReason,
    { status: ContentfulStatusCode; code: AccountErrorCode; message: string }
  > = {
    // Should not arrive on the OTP grant — redeeming the code proves email
    // ownership — but the verification machinery still serves it.
    email_verification_required: {
      status: 403,
      code: "email_verification_required",
      message: "Check your email to verify your address, then sign in",
    },
    // Domain policy: the address belongs to a domain with an SSO connection,
    // so the identity provider refuses email-code auth for it categorically.
    sso_required: {
      status: 403,
      code: "sso_required",
      message: "That email's domain uses single sign-on — continue with your provider instead",
    },
    // The next two share one contract code: the recovery the client offers is
    // what differs, and the message is what tells the user which they hit.
    invalid_verification_code: {
      status: 401,
      code: "invalid_verification_code",
      message: "That code didn't work — check it and try again",
    },
    verification_expired: {
      status: 401,
      code: "invalid_verification_code",
      message: "That code has expired — request a new one and try again",
    },
    // The personal-org-only decision, fail closed: an account that resolves
    // to several organizations is refused with a clear answer, never
    // silently scoped to the provider's first listing and never a 502.
    organization_selection_required: {
      status: 403,
      code: "multiple_organizations_unsupported",
      message: "Multiple workspaces aren't supported yet",
    },
  };

  /** Turns an authentication outcome into the error contract. */
  function authErrorResponse(c: Context, error: unknown): Response {
    if (error instanceof IdentityAuthError) {
      const mapped = authFailureResponses[error.reason];
      // The one refusal with a richer body: the refusal's own fields are what
      // completing verification in-app redeems, so they travel to the client
      // (allowlisted in the implementation — extraction never widens past
      // these three). Without them the plain body still tells the user to use
      // the emailed link, so an upstream that omits them degrades, not breaks.
      if (error.reason === "email_verification_required" && error.verification) {
        const body: EmailVerificationRequiredBody = {
          error: "email_verification_required",
          message: "Enter the 6-digit code we sent to your email",
          pendingAuthenticationToken: error.verification.pendingAuthenticationToken,
          email: error.verification.email,
          emailVerificationId: error.verification.emailVerificationId,
        };
        return c.json(body, 403);
      }
      return errorResponse(c, mapped.status, mapped.code, mapped.message);
    }
    // No body, no cause: whatever went wrong upstream, the log line must not
    // become the place a credential ends up.
    console.error("[api] authentication failed upstream");
    return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
  }

  /**
   * Asks the identity provider to mint and email a 6-digit sign-in code.
   * Answers 202 with the address echo and expiry whether or not the address
   * maps to an existing account: sign-up happens on redemption, so a send
   * that said "unknown email" would be an account-existence oracle for no
   * benefit.
   *
   * The provider's response contains the code itself; the implementation
   * parses it allowlist-style and the code never reaches this function.
   */
  v1.post("/auth/otp/send", async (c) => {
    if (!otpSendRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many code requests — wait a minute");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: OtpSendRequest;
    try {
      parsed = Schema.decodeUnknownSync(OtpSendRequest)(json);
    } catch {
      return errorResponse(c, 400, "validation_failed", "An email address is required");
    }

    // Second gate, keyed on the recipient rather than the caller: bounds
    // mail into one mailbox even when the per-IP key is defeated.
    if (!perEmailSendRateLimiter.tryConsume(emailRateKey(parsed.email))) {
      return errorResponse(c, 429, "rate_limited", "Too many code requests — wait a minute");
    }

    try {
      const challenge = await verifier.createOtpChallenge({ email: parsed.email });
      const body: OtpSendResponse = { email: challenge.email, expiresAt: challenge.expiresAt };
      return c.json(body, 202);
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  /**
   * Redeems the emailed 6-digit code for a token pair — the one sign-in AND
   * sign-up route: the provider provisions the user on first successful
   * redemption when sign-up is allowed. The code is a credential, so the
   * no-echo validation message and the no-leak error mapping both apply.
   */
  v1.post("/auth/otp/authenticate", async (c) => {
    if (!otpAuthenticateRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many attempts — wait a minute and retry");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: OtpAuthenticateRequest;
    try {
      parsed = Schema.decodeUnknownSync(OtpAuthenticateRequest)(json);
    } catch {
      // Deliberately not the decoder's message: effect/Schema quotes the
      // offending value, which here is the emailed code.
      return errorResponse(c, 400, "validation_failed", "An email and 6-digit code are required");
    }

    try {
      return c.json(
        authTokensBody(await verifier.authenticateWithOtp({ ...parsed, context: authContext(c) })),
      );
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  /**
   * Redeems the emailed 6-digit code plus the pending authentication token an
   * `email_verification_required` refusal carried. Both are bearer-ish
   * secrets, so the no-leak handling, the redemption rate budget, and the
   * no-echo validation message all apply. Redeeming an OTP implicitly
   * verifies the email, so this should not trigger on the OTP path — it stays
   * for any flow the provider still answers the challenge on.
   */
  v1.post("/auth/verify-email", async (c) => {
    if (!verifyEmailRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many attempts — wait a minute and retry");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: VerifyEmailRequest;
    try {
      parsed = Schema.decodeUnknownSync(VerifyEmailRequest)(json);
    } catch {
      // Not the decoder's message: it quotes the offending value, which here
      // is a code and a pending token.
      return errorResponse(
        c,
        400,
        "validation_failed",
        "A 6-digit code and its pending authentication token are required",
      );
    }

    try {
      return c.json(
        authTokensBody(await verifier.verifyEmailCode({ ...parsed, context: authContext(c) })),
      );
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  /**
   * Emails the user a fresh verification code. Answers 202 with an empty body
   * on success AND on an unknown or expired verification id: a resend
   * endpoint that confirmed which ids exist would be an oracle, and the
   * caller's next step — wait for the email — is the same either way.
   */
  v1.post("/auth/resend-verification", async (c) => {
    if (!resendVerificationRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many resend requests — wait a minute");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: ResendVerificationRequest;
    try {
      parsed = Schema.decodeUnknownSync(ResendVerificationRequest)(json);
    } catch {
      return errorResponse(c, 400, "validation_failed", "A verification id is required");
    }

    // Second gate keyed on the verification id — each id names exactly one
    // recipient, so this bounds mail into that mailbox across caller IPs.
    if (!perEmailSendRateLimiter.tryConsume(`verification:${parsed.emailVerificationId.trim()}`)) {
      return errorResponse(c, 429, "rate_limited", "Too many resend requests — wait a minute");
    }

    try {
      await verifier.resendVerificationEmail(parsed.emailVerificationId);
    } catch (error) {
      if (error instanceof IdentityProviderError && error.status === 404) {
        // Indistinguishable from success by design; see the route comment.
        return c.body(null, 202);
      }
      // No body and no cause in the log, as on every credential-path failure.
      console.error("[api] verification resend failed upstream");
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }
    return c.body(null, 202);
  });

  /**
   * Starts the SSO device flow, which is how "Continue with Google/GitHub"
   * reaches the provider. Unauthenticated by nature — the caller has no
   * credentials yet. Every leg of the flow is proxied: start here, polling
   * at /auth/device/token, refresh at /auth/refresh — so the client speaks
   * only to this service and the identity vendor is invisible on its wire.
   */
  v1.post("/auth/device", async (c) => {
    if (!deviceRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many device authorization requests");
    }

    try {
      const body: DeviceAuthorizationResponse = await verifier.requestDeviceAuthorization();
      return c.json(body);
    } catch (error) {
      // Every failure here is upstream — a rejected API key, a provider
      // outage, a transport error. None is the caller's fault and none may
      // leak the upstream message, which can quote the credentials we sent;
      // the operator still needs to be able to tell them apart, hence the log.
      console.error("[api] device authorization proxy failed:", error);
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }
  });

  /**
   * One poll of the device grant. Answers 200 with a `status` discriminant
   * (`granted` | `pending` | `slow_down` | `expired` | `denied`) rather than
   * OAuth error bodies: the non-granted outcomes are expected states of a
   * healthy flow, and a client should never sniff refusal bodies to keep its
   * loop going. The device code is bearer-ish, so the no-echo validation
   * message and the no-leak error mapping apply.
   */
  v1.post("/auth/device/token", async (c) => {
    if (!deviceTokenRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Polling too fast — slow down and retry");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: DeviceTokenRequest;
    try {
      parsed = Schema.decodeUnknownSync(DeviceTokenRequest)(json);
    } catch {
      // Not the decoder's message: it quotes the offending value, which here
      // is the device code.
      return errorResponse(c, 400, "validation_failed", "A device code is required");
    }

    try {
      const result = await verifier.pollDeviceToken({ ...parsed, context: authContext(c) });
      const body: DeviceTokenPollResponse =
        result.status === "granted"
          ? { status: "granted", tokens: authTokensBody(result.tokens) }
          : { status: result.status };
      return c.json(body);
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  /**
   * Redeems a refresh token for a rotated pair, optionally authenticating
   * into a workspace. A terminal refusal answers 401 `unauthorized` — the
   * stored session is dead and only a fresh sign-in recovers — while a
   * provider fault stays a 502, so a client never burns a possibly-valid
   * session over an outage. The refresh token is a credential: no-echo
   * validation message, no-leak error mapping.
   */
  v1.post("/auth/refresh", async (c) => {
    if (!refreshRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many refresh attempts — wait a minute");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: RefreshTokenRequest;
    try {
      parsed = Schema.decodeUnknownSync(RefreshTokenRequest)(json);
    } catch {
      // Not the decoder's message: it quotes the offending value, which here
      // is the refresh token.
      return errorResponse(c, 400, "validation_failed", "A refresh token is required");
    }

    try {
      const refreshed = await verifier.refreshTokens({
        refreshToken: parsed.refreshToken,
        ...(parsed.organizationId ? { organizationId: parsed.organizationId } : {}),
        context: authContext(c),
      });
      const body: RefreshTokenResponse = {
        ...authTokensBody(refreshed),
        ...(refreshed.organizationId ? { organizationId: refreshed.organizationId } : {}),
      };
      return c.json(body);
    } catch (error) {
      if (error instanceof RefreshRejectedError) {
        return errorResponse(c, 401, "unauthorized", "The session has expired — sign in again");
      }
      // 408 and 429 are 4xx by number but transient by meaning, and the
      // client's grant-rejected check keys on the status it receives — so
      // they must survive this proxy leg as themselves, not collapse into a
      // 502 (which would be fine) or, worse, into anything terminal.
      if (
        error instanceof IdentityProviderError &&
        (error.status === 408 || error.status === 429)
      ) {
        return errorResponse(
          c,
          error.status,
          error.status === 429 ? "rate_limited" : "internal_error",
          "Identity provider did not answer — retry shortly",
        );
      }
      return authErrorResponse(c, error);
    }
  });

  return v1;
}
