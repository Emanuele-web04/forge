import {
  type AccountErrorBody,
  type AccountErrorCode,
  type AccountHost,
  type AccountMe,
  type DeviceAuthorizationResponse,
  type EnvironmentId,
  type InstanceInfo,
  type ListHostsResponse,
  type OrganizationRequiredBody,
  type OrganizationSummary,
  type RegisterHostResponse,
  RegisterHostRequest,
  UpdateHostRequest,
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
import { hosts, hostTokens } from "../db/schema";
import { mintHostToken } from "../hostTokens";
import { ensurePersonalOrg } from "../orgProvisioning";
import { createRateLimiter } from "../rateLimit";
import { WorkosApiError, type WorkosAuth, type WorkosOrganization, type WorkosUser } from "../workos";
import packageJson from "../../package.json" with { type: "json" };
import { authenticateHostToken, extractBearerToken, isHostTokenHeader } from "./hostAuth";

const API_VERSION: string = packageJson.version;

/** Device authorizations allowed per client per minute. */
export const DEVICE_RATE_LIMIT_PER_MINUTE = 10;

type HostRow = typeof hosts.$inferSelect;

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

function toOrganizationSummary(organization: WorkosOrganization): OrganizationSummary {
  return { id: organization.orgId, name: organization.orgName };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
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

  v1.get("/me", async (c) => {
    const session = await requireOrgSession(c);
    if (session instanceof Response) return session;

    let user: WorkosUser;
    try {
      user = await auth.getUser(session.userId);
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

    const me: AccountMe = {
      id: user.id,
      name: user.name ?? user.email,
      email: user.email,
      ...(user.avatarUrl ? { image: user.avatarUrl } : {}),
      organization: session.organization,
    };
    return c.json(me);
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
        .where(and(eq(hosts.ownerOrgId, session.orgId), eq(hosts.environmentId, parsed.environmentId)))
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
   * Starts the CLI device flow. Unauthenticated by nature — the caller has no
   * credentials yet — and it is the only reason this service holds the WorkOS
   * API key: the request WorkOS requires is authenticated with a secret a
   * public client cannot be trusted with. Everything after this (polling for
   * the token) goes straight to WorkOS, which is why /instance publishes the
   * client id and API origin.
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
