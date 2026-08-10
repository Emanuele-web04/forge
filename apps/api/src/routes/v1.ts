import {
  type AccountErrorBody,
  type AccountErrorCode,
  type AccountHost,
  type AccountMe,
  type AccountProfile,
  type AccountProfileAvatarColor,
  type AccountProfileHandle,
  type DeviceAuthorizationResponse,
  type EnvironmentId,
  type InstanceInfo,
  type ListHostsResponse,
  type OrganizationRequiredBody,
  type OrganizationSummary,
  type PasswordAuthResponse,
  PasswordCredentials,
  type RegisterHostResponse,
  RegisterHostRequest,
  UpdateHostRequest,
  UpdateOrganizationRequest,
  UpdateProfileRequest,
} from "@synara/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Schema } from "effect";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { clientIp } from "../clientIp";
import type { ApiConfig } from "../config";
import * as schema from "../db/schema";
import { hosts, hostTokens, profiles } from "../db/schema";
import { mintHostToken } from "../hostTokens";
import { ensurePersonalOrg, invalidateOrgCacheForOrganization } from "../orgProvisioning";
import { createRateLimiter } from "../rateLimit";
import {
  WorkosApiError,
  WorkosPasswordError,
  type WorkosAuth,
  type WorkosOrganization,
  type WorkosPasswordFailure,
  type WorkosUser,
} from "../workos";
import packageJson from "../../package.json" with { type: "json" };
import { authenticateHostToken, extractBearerToken, isHostTokenHeader } from "./hostAuth";

const API_VERSION: string = packageJson.version;

/** Device authorizations allowed per client per minute. */
export const DEVICE_RATE_LIMIT_PER_MINUTE = 10;

/**
 * Password attempts allowed per client per minute. Deliberately far below the
 * device limit: a device authorization is a harmless request for a code, while
 * these carry credentials and are the endpoints worth guessing against. Low
 * enough to make online guessing pointless, high enough to survive a user
 * mistyping a password a few times.
 */
export const PASSWORD_RATE_LIMIT_PER_MINUTE = 5;

type HostRow = typeof hosts.$inferSelect;
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

function toAccountHost(row: HostRow): AccountHost {
  return {
    id: row.id,
    environmentId: row.environmentId as EnvironmentId,
    name: row.name,
    platform: row.platform,
    kind: row.kind,
    endpoints: row.endpoints,
    ...(row.appVersion ? { appVersion: row.appVersion } : {}),
    registeredByUserId: row.registeredByUserId,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
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

function toOrganizationSummary(organization: WorkosOrganization): OrganizationSummary {
  return { id: organization.orgId, name: organization.orgName };
}

/**
 * Whether a failed write was refused by a unique index.
 *
 * The chain is walked rather than the error inspected directly: Drizzle wraps
 * driver errors in a `DrizzleQueryError` that carries no `code` of its own, so
 * reading only the top-level object turns every conflict into an unhandled
 * 500 — which is exactly what a duplicate handle or a re-linked environment
 * would have become.
 */
function isUniqueViolation(error: unknown): boolean {
  for (
    let current = error;
    current instanceof Object;
    current = (current as { cause?: unknown }).cause
  ) {
    if ("code" in current && current.code === "23505") return true;
  }
  return false;
}

export function createV1Routes(deps: {
  auth: WorkosAuth;
  db: NodePgDatabase<typeof schema>;
  config: ApiConfig;
}): Hono {
  const { auth, db, config } = deps;
  const v1 = new Hono();

  // Per router instance, not module-global: two routers in one process (tests,
  // or a future multi-tenant mount) must not share a budget.
  const deviceRateLimiter = createRateLimiter({
    limit: DEVICE_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  // Separate budget from the device routes, so exhausting one cannot lock a
  // user out of the other.
  const passwordRateLimiter = createRateLimiter({
    limit: PASSWORD_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });

  /**
   * Resolves the caller from a WorkOS access token. Verification is stateless
   * (JWKS signature + expiry), so a revoked session stays valid until its short
   * token lifetime runs out; the client refreshes against WorkOS, which is
   * where revocation takes effect.
   */
  async function getDeviceSession(
    c: Context,
  ): Promise<{ userId: string; sessionId: string; orgId?: string } | null> {
    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) return null;
    try {
      return await auth.verifyAccessToken(token);
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
    organizations: readonly WorkosOrganization[],
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
   * A device-grant token has no `org_id` at all — WorkOS only mints that claim
   * when the client authenticates *into* an organization — so the first call
   * after `synara auth` always lands here, provisions the user's personal
   * workspace if they have none, and answers 403 with the list to pick from.
   * The client re-runs the refresh grant with `organization_id` and retries.
   * A token naming an organization the caller has since left takes the same
   * path, which is what makes a revoked membership stop granting access
   * without waiting for anything to be purged.
   *
   * Returns the session, or a Response that the caller must return as-is.
   */
  async function requireOrgSession(c: Context): Promise<OrgSession | Response> {
    const session = await getDeviceSession(c);
    if (!session) return errorResponse(c, 401, "unauthorized", "Not authenticated");

    let user: WorkosUser;
    let memberships: WorkosOrganization[];
    try {
      user = await auth.getUser(session.userId);
      memberships = await ensurePersonalOrg(auth, session.userId, user.email);
    } catch (error) {
      if (error instanceof WorkosApiError && error.status === 404) {
        return errorResponse(c, 401, "unauthorized", "This account no longer exists");
      }
      console.error("[api] organization resolution failed:", error);
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }

    if (!session.orgId) {
      return organizationRequired(
        c,
        "This token is not scoped to a workspace. Refresh it with an organization_id and retry.",
        memberships,
      );
    }

    const active = memberships.find((membership) => membership.orgId === session.orgId);
    if (!active) {
      return organizationRequired(
        c,
        "You are not a member of the workspace this token names. Refresh it with one of these and retry.",
        memberships,
      );
    }

    return {
      userId: session.userId,
      orgId: active.orgId,
      organization: toOrganizationSummary(active),
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
    user: WorkosUser,
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
  async function loadSessionUser(c: Context, userId: string): Promise<WorkosUser | Response> {
    try {
      return await auth.getUser(userId);
    } catch (error) {
      // The token verified, so the caller held a valid session — but WorkOS
      // will not describe the user. A 404 means the account was deleted while
      // the token was still live, which is an authentication failure from the
      // client's point of view; anything else is an upstream fault and must not
      // be reported as the caller's error.
      if (error instanceof WorkosApiError && error.status === 404) {
        return errorResponse(c, 401, "unauthorized", "This account no longer exists");
      }
      // Logged because the response deliberately says nothing: a rejected API
      // key, a WorkOS outage, and a mapping bug are one opaque 502 to the
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
   * Renames the workspace. The name lives on the WorkOS organization rather
   * than here, so this is a write-through — and it is gated on membership by
   * `requireOrgSession`, which is what stops a caller renaming an organization
   * they merely know the id of.
   */
  v1.patch("/organization", async (c) => {
    const session = await requireOrgSession(c);
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

    let renamed: WorkosOrganization;
    try {
      renamed = await auth.updateOrganization(session.orgId, parsed.name);
    } catch (error) {
      console.error("[api] organization rename failed:", error);
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }

    // Membership lists carry the organization name, so they are stale the
    // moment the rename lands — including the one this request populated.
    invalidateOrgCacheForOrganization(session.orgId);

    return c.json(await accountMe(user, toOrganizationSummary(renamed)));
  });

  v1.get("/hosts", async (c) => {
    const session = await requireOrgSession(c);
    if (session instanceof Response) return session;

    const rows = await db.select().from(hosts).where(eq(hosts.ownerOrgId, session.orgId));
    const body: ListHostsResponse = { hosts: rows.map(toAccountHost) };
    return c.json(body);
  });

  v1.post("/hosts", async (c) => {
    const session = await requireOrgSession(c);
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
      const [existing] = await db
        .select()
        .from(hosts)
        .where(
          and(eq(hosts.ownerOrgId, session.orgId), eq(hosts.environmentId, parsed.environmentId)),
        )
        .limit(1);

      let hostRow: HostRow;
      if (existing) {
        const [updated] = await db
          .update(hosts)
          .set({
            name: parsed.name,
            platform: parsed.platform,
            kind: parsed.kind,
            endpoints: [...parsed.endpoints],
            appVersion: parsed.appVersion ?? null,
            lastSeenAt: new Date(),
          })
          .where(eq(hosts.id, existing.id))
          .returning();
        if (!updated) throw new Error("failed to update host row");
        hostRow = updated;

        await db
          .update(hostTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(hostTokens.hostId, hostRow.id), isNull(hostTokens.revokedAt)));
      } else {
        const [inserted] = await db
          .insert(hosts)
          .values({
            ownerOrgId: session.orgId,
            // Audit only. Ownership is the organization's, so this is never
            // consulted when deciding who may reach the host.
            registeredByUserId: session.userId,
            environmentId: parsed.environmentId,
            name: parsed.name,
            platform: parsed.platform,
            kind: parsed.kind,
            endpoints: [...parsed.endpoints],
            appVersion: parsed.appVersion ?? null,
          })
          .returning();
        if (!inserted) throw new Error("failed to insert host row");
        hostRow = inserted;
      }

      const { token, hash } = mintHostToken();
      await db.insert(hostTokens).values({ hostId: hostRow.id, tokenHash: hash });

      const body: RegisterHostResponse = { host: toAccountHost(hostRow), hostToken: token };
      return c.json(body, existing ? 200 : 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return errorResponse(
          c,
          409,
          "environment_already_linked",
          "This environment is already linked to another host record",
        );
      }
      throw error;
    }
  });

  v1.patch("/hosts/:id", async (c) => {
    const id = c.req.param("id");
    const authHeader = c.req.header("authorization");

    const result = await authenticateHostToken(db, authHeader);
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

    const [row] = await db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
    if (!row) return errorResponse(c, 404, "host_not_found", "Host not found");

    const [updated] = await db
      .update(hosts)
      .set({
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.endpoints !== undefined ? { endpoints: [...parsed.endpoints] } : {}),
        ...(parsed.appVersion !== undefined ? { appVersion: parsed.appVersion } : {}),
        lastSeenAt: new Date(),
      })
      .where(eq(hosts.id, id))
      .returning();
    if (!updated) return errorResponse(c, 404, "host_not_found", "Host not found");

    return c.json({ host: toAccountHost(updated) });
  });

  v1.delete("/hosts/:id", async (c) => {
    const id = c.req.param("id");
    const authHeader = c.req.header("authorization");

    if (isHostTokenHeader(authHeader)) {
      const result = await authenticateHostToken(db, authHeader);
      if (!result.ok) return errorResponse(c, result.status, result.error, "Host token invalid");
      if (result.hostId !== id) {
        return errorResponse(c, 401, "unauthorized", "Host token does not match this host");
      }
      await db.delete(hosts).where(eq(hosts.id, id));
      return c.body(null, 204);
    }

    const session = await requireOrgSession(c);
    if (session instanceof Response) return session;

    const deleted = await db
      .delete(hosts)
      .where(and(eq(hosts.id, id), eq(hosts.ownerOrgId, session.orgId)))
      .returning();
    if (deleted.length === 0) return errorResponse(c, 404, "host_not_found", "Host not found");

    return c.body(null, 204);
  });

  v1.get("/instance", (c) => {
    const body: InstanceInfo = {
      version: API_VERSION,
      authMode: "workos",
      clientId: config.workosClientId,
      workosApiUrl: config.workosApiUrl,
    };
    return c.json(body);
  });

  /**
   * The two in-app password routes.
   *
   * These exist because the WorkOS password grant is a confidential-client
   * grant: it requires the client secret, so the app cannot make the call
   * itself and something holding the secret has to proxy it. The password is
   * pass-through at every step here — it is read off the request, handed to
   * WorkOS, and never written to the database, a log line, or an error
   * message. Nothing below may start doing so.
   *
   * SSO (Google/GitHub) does not come through here; it takes the device flow.
   */
  const passwordFailureResponses: Record<
    WorkosPasswordFailure,
    { status: ContentfulStatusCode; code: AccountErrorCode; message: string }
  > = {
    // Never says which half was wrong: that difference is an account-existence
    // oracle, and it is not useful to the honest user either.
    invalid_credentials: {
      status: 401,
      code: "invalid_credentials",
      message: "That email and password do not match an account",
    },
    email_taken: {
      status: 409,
      code: "email_taken",
      message: "An account with that email already exists",
    },
    // The credentials were right; the account simply is not usable yet.
    // Completing verification is the identity provider's own flow in V1.
    email_verification_required: {
      status: 403,
      code: "email_verification_required",
      message: "Check your email to verify your address, then sign in",
    },
    // Domain policy: the address belongs to a domain with an SSO connection,
    // so the identity provider refuses password auth for it categorically.
    sso_required: {
      status: 403,
      code: "sso_required",
      message: "That email's domain uses single sign-on — continue with your provider instead",
    },
  };

  /**
   * Reads and validates credentials from the request. Returns the credentials,
   * or the Response to return as-is — never logs the body, and never quotes
   * the password back in the validation message.
   */
  async function readPasswordCredentials(c: Context): Promise<PasswordCredentials | Response> {
    if (!passwordRateLimiter.tryConsume(clientIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many attempts — wait a minute and retry");
    }

    const json = await c.req.json().catch(() => null);
    if (json === null) return errorResponse(c, 400, "validation_failed", "Invalid JSON body");

    try {
      return Schema.decodeUnknownSync(PasswordCredentials)(json);
    } catch {
      // Deliberately not the decoder's message: effect/Schema quotes the
      // offending value, which here is somebody's password.
      return errorResponse(c, 400, "validation_failed", "An email and password are required");
    }
  }

  /** Turns a WorkOS password outcome into the error contract. */
  function passwordErrorResponse(c: Context, error: unknown): Response {
    if (error instanceof WorkosPasswordError) {
      const mapped = passwordFailureResponses[error.reason];
      return errorResponse(c, mapped.status, mapped.code, mapped.message);
    }
    // No body, no cause: whatever went wrong upstream, the log line must not
    // become the place a password ends up.
    console.error("[api] password authentication failed upstream");
    return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
  }

  v1.post("/auth/password/sign-in", async (c) => {
    const credentials = await readPasswordCredentials(c);
    if (credentials instanceof Response) return credentials;

    try {
      const auth_ = await auth.authenticateWithPassword(credentials);
      const body: PasswordAuthResponse = {
        accessToken: auth_.accessToken,
        refreshToken: auth_.refreshToken,
        user: {
          id: auth_.user.id,
          email: auth_.user.email,
          ...(auth_.user.name ? { name: auth_.user.name } : {}),
        },
      };
      return c.json(body);
    } catch (error) {
      return passwordErrorResponse(c, error);
    }
  });

  v1.post("/auth/password/sign-up", async (c) => {
    const credentials = await readPasswordCredentials(c);
    if (credentials instanceof Response) return credentials;

    try {
      const auth_ = await auth.createUserWithPassword(credentials);
      const body: PasswordAuthResponse = {
        accessToken: auth_.accessToken,
        refreshToken: auth_.refreshToken,
        user: {
          id: auth_.user.id,
          email: auth_.user.email,
          ...(auth_.user.name ? { name: auth_.user.name } : {}),
        },
      };
      return c.json(body, 201);
    } catch (error) {
      return passwordErrorResponse(c, error);
    }
  });

  /**
   * Starts the SSO device flow, which is how "Continue with Google/GitHub"
   * reaches the provider. Unauthenticated by nature — the caller has no
   * credentials yet — and, alongside the password routes above, a reason this
   * service holds the WorkOS API key: the request WorkOS requires is
   * authenticated with a secret a public client cannot be trusted with.
   * Everything after this (polling for the token) goes straight to WorkOS,
   * which is why /instance publishes the client id and API origin.
   */
  v1.post("/auth/device", async (c) => {
    if (!deviceRateLimiter.tryConsume(clientIp(c))) {
      return errorResponse(c, 429, "rate_limited", "Too many device authorization requests");
    }

    try {
      const body: DeviceAuthorizationResponse = await auth.requestDeviceAuthorization();
      return c.json(body);
    } catch (error) {
      // Every failure here is upstream — a rejected API key, a WorkOS outage, a
      // transport error. None is the caller's fault and none may leak the
      // upstream message, which can quote the credentials we sent; the operator
      // still needs to be able to tell them apart, hence the log.
      console.error("[api] device authorization proxy failed:", error);
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }
  });

  return v1;
}
