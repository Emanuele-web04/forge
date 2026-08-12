import {
  type AccountErrorBody,
  type AccountErrorCode,
  AuthorizeTokenRequest,
  AuthorizeUrlRequest,
  type AuthorizeUrlResponse,
  type AccountMe,
  type AccountProfile,
  type AccountProfileAvatarColor,
  type AccountProfileHandle,
  type AuthTokensResponse,
  type InstanceInfo,
  type ListHostsResponse,
  type OrganizationRequiredBody,
  type OrganizationSummary,
  type OtpSendResponse,
  OtpAuthenticateRequest,
  OtpSendRequest,
  type PublicProfile,
  type PublicProfileHeatmapDay,
  type PublicProfileModelUsage,
  PushUsageRequest,
  type PushUsageResponse,
  type UsageSummary,
  type UsageSummaryDay,
  type UsageSummaryEnvironment,
  type UsageSummaryHour,
  type UsageSummarySkill,
  type RegisterHostResponse,
  RegisterHostRequest,
  RefreshTokenRequest,
  type RefreshTokenResponse,
  UpdateHostRequest,
  UpdateOrganizationRequest,
  UpdateProfileRequest,
} from "@synara/contracts";
import { and, eq, sql } from "drizzle-orm";
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
import { profiles, usageModelStats, usageSkillStats } from "../db/schema";
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

/** Authorize-URL requests (SSO starts) allowed per client per minute. */
export const AUTHORIZE_RATE_LIMIT_PER_MINUTE = 10;

/**
 * Code-redemption attempts allowed per client per minute. Deliberately far
 * below the authorize limit: building an authorize URL is a harmless
 * request, while these carry credentials and are the endpoints worth
 * guessing against. Low enough to make online guessing pointless, high
 * enough to survive a user mistyping a code a few times.
 */
export const OTP_AUTHENTICATE_RATE_LIMIT_PER_MINUTE = 5;

/**
 * Code-sending requests allowed per client per minute. Deliberately the
 * tightest: every request makes the identity provider send somebody an
 * email, and one user legitimately needs at most one retry a minute — the
 * UI enforces a 60s countdown of its own.
 */
export const OTP_SEND_RATE_LIMIT_PER_MINUTE = 2;

/**
 * Email sends allowed per recipient address per hour, across all sender IPs.
 * The per-IP budgets bound a single caller; this bounds the *target*: even a
 * caller who defeats IP keying (a botnet, or a header trick against a
 * misconfigured proxy) cannot flood one mailbox past this. Generous enough
 * that a real user retrying across devices never hits it.
 */
export const PER_EMAIL_SEND_RATE_LIMIT_PER_HOUR = 10;

/**
 * Refresh grants allowed per client per minute. Stricter than polling — a
 * healthy client refreshes once per token lifetime (~5 min), so even a burst
 * of parallel CLI commands stays far under this — but above the redemption
 * budgets, because a refresh storm from one machine is a bug to absorb, not
 * an attack to starve.
 */
export const REFRESH_RATE_LIMIT_PER_MINUTE = 10;

/**
 * Usage pushes allowed per client per minute. Pushes are event-driven with a
 * client-side debounce, so a healthy machine sends a few per minute even
 * under heavy parallel work; the budget only needs to stop pathological
 * hammering — the route is authenticated, so this is belt-and-braces.
 */
export const USAGE_PUSH_RATE_LIMIT_PER_MINUTE = 30;

/**
 * Public profile reads allowed per client per minute. Unauthenticated and
 * cheap (indexed aggregates), but unauthenticated is exactly what needs a
 * budget; generous enough for a page render plus retries.
 */
export const PUBLIC_PROFILE_RATE_LIMIT_PER_MINUTE = 60;

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
    public: row.public,
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

/**
 * Whether `redirectUri` is an http loopback URL — the only redirect shape
 * the PKCE authorize route accepts. The authorize URL embeds whatever the
 * caller sends, so without this the route would happily build a provider
 * sign-in link that delivers a real user's authorization code to an
 * attacker-chosen origin. Loopback (any port, any path) is exactly what the
 * desktop flow needs and nothing more.
 */
export function isLoopbackRedirectUri(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
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
  const authorizeRateLimiter = createRateLimiter({
    limit: AUTHORIZE_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  // Separate budget from the authorize route, so exhausting one cannot lock
  // a user out of the other.
  const otpAuthenticateRateLimiter = createRateLimiter({
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

  const refreshRateLimiter = createRateLimiter({
    limit: REFRESH_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  const usagePushRateLimiter = createRateLimiter({
    limit: USAGE_PUSH_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  const publicProfileRateLimiter = createRateLimiter({
    limit: PUBLIC_PROFILE_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  // The per-recipient budget behind the email-sending route, keyed by
  // normalized address. Bounds the *target*: even a caller who defeats IP
  // keying cannot flood one mailbox past this. BOTH the per-IP budget and
  // this must pass.
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
          // Absent means "leave visibility alone" on update and "private" on
          // first write — the safe default either way.
          ...(parsed.public !== undefined ? { public: parsed.public } : {}),
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
            ...(parsed.public !== undefined ? { public: parsed.public } : {}),
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

  /**
   * Ingests a batch of per-minute usage buckets — the account-side mirror of
   * the local profile stats, at the same depth and with NO content. Buckets
   * carry ABSOLUTE values and are upserted: one environment is the sole
   * writer of its own buckets and re-pushes them as they grow, so conflicts
   * replace rather than add, which is what makes retries and mid-minute
   * re-pushes idempotent.
   *
   * Authenticated with the user access token: usage accrues to the person,
   * and a machine whose session expired stops accruing to them. The
   * environment id is self-reported and scoped per user in the unique key,
   * so one user cannot write into another's buckets whatever they claim.
   */
  v1.post("/usage", async (c) => {
    if (!usagePushRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many usage pushes — slow down");
    }

    const session = await requireOrgSession(c);
    if (session instanceof Response) return session;

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: PushUsageRequest;
    try {
      parsed = Schema.decodeUnknownSync(PushUsageRequest)(json);
    } catch (error) {
      return errorResponse(
        c,
        400,
        "validation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    // One transaction for the whole batch: a push either lands entirely or
    // not at all, so the client's dirty-set bookkeeping stays truthful.
    await db.transaction(async (tx) => {
      for (const bucket of parsed.models) {
        await tx
          .insert(usageModelStats)
          .values({
            userId: session.userId,
            orgId: session.orgId,
            environmentId: parsed.environmentId,
            minute: new Date(bucket.minute),
            provider: bucket.provider,
            model: bucket.model,
            // '' is the stored spelling of "no reasoning setting": NULL would
            // be distinct-per-row under the unique index and duplicate the
            // bucket on every push.
            reasoning: bucket.reasoning ?? "",
            tokens: bucket.tokens,
            turns: bucket.turns,
            prompts: bucket.prompts,
          })
          // Absolute replace, not increment — see the route comment.
          .onConflictDoUpdate({
            target: [
              usageModelStats.userId,
              usageModelStats.environmentId,
              usageModelStats.minute,
              usageModelStats.provider,
              usageModelStats.model,
              usageModelStats.reasoning,
            ],
            set: {
              tokens: bucket.tokens,
              turns: bucket.turns,
              prompts: bucket.prompts,
              orgId: session.orgId,
              updatedAt: new Date(),
            },
          });
      }
      for (const bucket of parsed.skills) {
        await tx
          .insert(usageSkillStats)
          .values({
            userId: session.userId,
            orgId: session.orgId,
            environmentId: parsed.environmentId,
            minute: new Date(bucket.minute),
            name: bucket.name,
            kind: bucket.kind,
            runs: bucket.runs,
          })
          .onConflictDoUpdate({
            target: [
              usageSkillStats.userId,
              usageSkillStats.environmentId,
              usageSkillStats.minute,
              usageSkillStats.name,
              usageSkillStats.kind,
            ],
            set: { runs: bucket.runs, orgId: session.orgId, updatedAt: new Date() },
          });
      }
    });

    const body: PushUsageResponse = { written: parsed.models.length + parsed.skills.length };
    return c.json(body, 202);
  });


  /**
   * The signed-in owner's account-wide usage — the "Account" side of the
   * usage tab's device/account toggle. Same buckets as the public profile,
   * plus the owner-only extras a public payload must never carry: skill
   * runs, per-environment shares, and days/hours localized to the caller's
   * UTC offset so the account view buckets time exactly the way the local
   * dashboard does.
   */
  v1.get("/usage/summary", async (c) => {
    const session = await requireOrgSession(c);
    if (session instanceof Response) return session;

    // Clamped to real-world offsets (UTC-12 … UTC+14) rather than refused:
    // an out-of-range value is a client bug, and answering UTC beats a 400
    // that hides the whole dashboard.
    const rawOffset = Number.parseInt(c.req.query("utcOffsetMinutes") ?? "0", 10);
    const offsetMinutes = Number.isFinite(rawOffset)
      ? Math.max(-720, Math.min(840, rawOffset))
      : 0;
    // Interval arithmetic instead of a timezone name: the client knows its
    // offset, and Postgres shifting by a fixed interval is DST-agnostic in
    // exactly the way the local dashboard's own bucketing is. Inlined rather
    // than parameterized — safe because the value is a clamped integer, and
    // necessary because a placeholder appears as DIFFERENT params in SELECT
    // and GROUP BY, which Postgres refuses to unify.
    const localMinute = sql`(${usageModelStats.minute} + make_interval(mins => ${sql.raw(String(offsetMinutes))}))`;

    const models = await db
      .select({
        provider: usageModelStats.provider,
        model: usageModelStats.model,
        reasoning: usageModelStats.reasoning,
        tokens: sql<string>`COALESCE(SUM(${usageModelStats.tokens}), 0)`,
        turns: sql<string>`COALESCE(SUM(${usageModelStats.turns}), 0)`,
        prompts: sql<string>`COALESCE(SUM(${usageModelStats.prompts}), 0)`,
      })
      .from(usageModelStats)
      .where(eq(usageModelStats.userId, session.userId))
      .groupBy(usageModelStats.provider, usageModelStats.model, usageModelStats.reasoning)
      .orderBy(sql`SUM(${usageModelStats.tokens}) DESC`);

    const days = await db
      .select({
        day: sql<string>`to_char(${localMinute} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        tokens: sql<string>`COALESCE(SUM(${usageModelStats.tokens}), 0)`,
        prompts: sql<string>`COALESCE(SUM(${usageModelStats.prompts}), 0)`,
        turns: sql<string>`COALESCE(SUM(${usageModelStats.turns}), 0)`,
      })
      .from(usageModelStats)
      .where(
        and(
          eq(usageModelStats.userId, session.userId),
          sql`${usageModelStats.minute} >= now() - interval '366 days'`,
        ),
      )
      .groupBy(sql`to_char(${localMinute} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

    const hours = await db
      .select({
        hour: sql<string>`extract(hour from ${localMinute} AT TIME ZONE 'UTC')`,
        prompts: sql<string>`COALESCE(SUM(${usageModelStats.prompts}), 0)`,
      })
      .from(usageModelStats)
      .where(eq(usageModelStats.userId, session.userId))
      .groupBy(sql`extract(hour from ${localMinute} AT TIME ZONE 'UTC')`);

    const skills = await db
      .select({
        name: usageSkillStats.name,
        kind: usageSkillStats.kind,
        runs: sql<string>`COALESCE(SUM(${usageSkillStats.runs}), 0)`,
      })
      .from(usageSkillStats)
      .where(eq(usageSkillStats.userId, session.userId))
      .groupBy(usageSkillStats.name, usageSkillStats.kind)
      .orderBy(sql`SUM(${usageSkillStats.runs}) DESC`);

    const environments = await db
      .select({
        environmentId: usageModelStats.environmentId,
        tokens: sql<string>`COALESCE(SUM(${usageModelStats.tokens}), 0)`,
        prompts: sql<string>`COALESCE(SUM(${usageModelStats.prompts}), 0)`,
      })
      .from(usageModelStats)
      .where(eq(usageModelStats.userId, session.userId))
      .groupBy(usageModelStats.environmentId)
      .orderBy(sql`SUM(${usageModelStats.tokens}) DESC`);

    const modelRows = models.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      reasoning: entry.reasoning === "" ? null : entry.reasoning,
      tokens: Number(entry.tokens),
      turns: Number(entry.turns),
      prompts: Number(entry.prompts),
    }));
    const dayRows: UsageSummaryDay[] = days.map((entry) => ({
      day: entry.day,
      tokens: Number(entry.tokens),
      prompts: Number(entry.prompts),
      turns: Number(entry.turns),
    }));
    const hourRows: UsageSummaryHour[] = hours.map((entry) => ({
      hour: Number(entry.hour),
      prompts: Number(entry.prompts),
    }));
    const skillRows: UsageSummarySkill[] = skills.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      runs: Number(entry.runs),
    }));
    const environmentRows: UsageSummaryEnvironment[] = environments.map((entry) => ({
      environmentId: entry.environmentId,
      tokens: Number(entry.tokens),
      prompts: Number(entry.prompts),
    }));

    const body: UsageSummary = {
      lifetimeTokens: modelRows.reduce((total, entry) => total + entry.tokens, 0),
      lifetimePrompts: modelRows.reduce((total, entry) => total + entry.prompts, 0),
      lifetimeTurns: modelRows.reduce((total, entry) => total + entry.turns, 0),
      models: modelRows,
      days: dayRows,
      hours: hourRows,
      skills: skillRows,
      environments: environmentRows,
    };
    return c.json(body);
  });

  /**
   * The public profile behind a handle. Unauthenticated by design — it is
   * the page at trysynara.com/@handle — and served ONLY when the owner made
   * the profile public. An unknown handle and a private profile answer the
   * same 404, so the route reveals nothing the owner did not publish.
   *
   * The payload is identity plus usage aggregated across every environment:
   * per provider/model/reasoning splits and a daily heatmap. Skill stats and
   * environment ids never appear — which skills someone runs reveals what
   * they work on, and which machines they own is nobody's business.
   */
  v1.get("/profiles/:handle", async (c) => {
    if (!publicProfileRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many requests — slow down");
    }

    // Handles are stored lowercase; fold the lookup so /profiles/@Dylan and
    // a bare /profiles/dylan both resolve. A leading @ is tolerated because
    // the public URL spells it that way.
    const handle = c.req.param("handle").replace(/^@/, "").toLowerCase();
    const [row] = await db.select().from(profiles).where(eq(profiles.handle, handle)).limit(1);
    if (!row || !row.public) {
      return errorResponse(c, 404, "profile_not_found", "No public profile by that handle");
    }

    const models = await db
      .select({
        provider: usageModelStats.provider,
        model: usageModelStats.model,
        reasoning: usageModelStats.reasoning,
        tokens: sql<string>`COALESCE(SUM(${usageModelStats.tokens}), 0)`,
        turns: sql<string>`COALESCE(SUM(${usageModelStats.turns}), 0)`,
        prompts: sql<string>`COALESCE(SUM(${usageModelStats.prompts}), 0)`,
      })
      .from(usageModelStats)
      .where(eq(usageModelStats.userId, row.userId))
      .groupBy(usageModelStats.provider, usageModelStats.model, usageModelStats.reasoning)
      .orderBy(sql`SUM(${usageModelStats.tokens}) DESC`);

    const heatmap = await db
      .select({
        day: sql<string>`to_char(${usageModelStats.minute} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        tokens: sql<string>`COALESCE(SUM(${usageModelStats.tokens}), 0)`,
        prompts: sql<string>`COALESCE(SUM(${usageModelStats.prompts}), 0)`,
      })
      .from(usageModelStats)
      .where(
        and(
          eq(usageModelStats.userId, row.userId),
          // A year of days bounds the payload however long the account lives.
          sql`${usageModelStats.minute} >= now() - interval '366 days'`,
        ),
      )
      .groupBy(sql`to_char(${usageModelStats.minute} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

    const modelRows: PublicProfileModelUsage[] = models.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      // '' is the stored spelling of "no reasoning setting"; the wire says null.
      reasoning: entry.reasoning === "" ? null : entry.reasoning,
      tokens: Number(entry.tokens),
      turns: Number(entry.turns),
      prompts: Number(entry.prompts),
    }));
    const heatmapRows: PublicProfileHeatmapDay[] = heatmap.map((entry) => ({
      day: entry.day,
      tokens: Number(entry.tokens),
      prompts: Number(entry.prompts),
    }));

    const body: PublicProfile = {
      handle: row.handle,
      displayName: row.displayName,
      avatarColor: row.avatarColor,
      createdAt: row.createdAt.toISOString(),
      lifetimeTokens: modelRows.reduce((total, entry) => total + entry.tokens, 0),
      lifetimePrompts: modelRows.reduce((total, entry) => total + entry.prompts, 0),
      lifetimeTurns: modelRows.reduce((total, entry) => total + entry.turns, 0),
      models: modelRows,
      heatmap: heatmapRows,
    };
    return c.json(body);
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
   * SSO (Google/Apple/GitHub) does not come through here; it takes the PKCE
   * authorize routes below.
   */
  const authFailureResponses: Record<
    AuthFailureReason,
    { status: ContentfulStatusCode; code: AccountErrorCode; message: string }
  > = {
    // Should not arrive on the OTP grant — redeeming the code proves email
    // ownership. Kept as a classified terse dead-end (no in-app challenge
    // flow): the emailed-code sign-in is itself the verification path.
    email_verification_required: {
      status: 403,
      code: "email_verification_required",
      message: "This account's email isn't verified — sign in with an emailed code instead",
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
   * Builds the provider's authorize URL for the desktop PKCE flow — how
   * "Continue with Google/Apple/GitHub" deep-links to the chosen provider.
   * Unauthenticated by nature; nothing is consumed by building a URL. The
   * redirect URI must be loopback: this route otherwise mints provider
   * sign-in links that hand a user's authorization code to whatever origin
   * the caller named.
   */
  v1.post("/auth/authorize", async (c) => {
    if (!authorizeRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many sign-in requests");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: AuthorizeUrlRequest;
    try {
      parsed = Schema.decodeUnknownSync(AuthorizeUrlRequest)(json);
    } catch {
      // Not the decoder's message: it quotes offending values, and the
      // challenge/state fields are flow secrets' derivatives.
      return errorResponse(
        c,
        400,
        "validation_failed",
        "A provider, loopback redirect URI, code challenge, and state are required",
      );
    }

    if (!isLoopbackRedirectUri(parsed.redirectUri)) {
      return errorResponse(
        c,
        400,
        "validation_failed",
        "The redirect URI must be an http loopback address",
      );
    }

    const body: AuthorizeUrlResponse = { authorizeUrl: verifier.buildAuthorizeUrl(parsed) };
    return c.json(body);
  });

  /**
   * Redeems the authorization code from the loopback callback, proving
   * possession with the PKCE verifier. Both fields are single-use
   * credentials: redemption budget, no-echo validation message, no-leak
   * error mapping — the same posture as the OTP redemption.
   */
  v1.post("/auth/authorize/token", async (c) => {
    if (!otpAuthenticateRateLimiter.tryConsume(callerIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many attempts — wait a minute and retry");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    let parsed: AuthorizeTokenRequest;
    try {
      parsed = Schema.decodeUnknownSync(AuthorizeTokenRequest)(json);
    } catch {
      // Not the decoder's message: it quotes the offending value, which here
      // is the authorization code and PKCE verifier.
      return errorResponse(
        c,
        400,
        "validation_failed",
        "An authorization code and its PKCE verifier are required",
      );
    }

    try {
      return c.json(
        authTokensBody(
          await verifier.exchangeAuthorizationCode({ ...parsed, context: authContext(c) }),
        ),
      );
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
