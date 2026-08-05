import {
  type AccountErrorBody,
  type AccountErrorCode,
  type AccountHost,
  type AccountMe,
  type EnvironmentId,
  type InstanceInfo,
  type ListHostsResponse,
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
import type { ApiConfig } from "../config";
import * as schema from "../db/schema";
import { hosts, hostTokens } from "../db/schema";
import { mintHostToken } from "../hostTokens";
import { WorkosApiError, type WorkosAuth, type WorkosUser } from "../workos";
import packageJson from "../../package.json" with { type: "json" };
import { authenticateHostToken, extractBearerToken, isHostTokenHeader } from "./hostAuth";

const API_VERSION: string = packageJson.version;

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
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

export function createV1Routes(deps: {
  auth: WorkosAuth;
  db: NodePgDatabase<typeof schema>;
  config: ApiConfig;
}): Hono {
  // TASK2: `config` is unused since /instance stopped reading it. Kept in the
  // deps because the AuthKit callback and device routes will need it.
  const { auth, db } = deps;
  const v1 = new Hono();

  /**
   * Resolves the caller from a WorkOS access token. Verification is stateless
   * (JWKS signature + expiry), so a revoked session stays valid until its short
   * token lifetime runs out; the client refreshes against WorkOS, which is
   * where revocation takes effect.
   */
  async function getDeviceSession(
    c: Context,
  ): Promise<{ userId: string; sessionId: string } | null> {
    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) return null;
    try {
      return await auth.verifyAccessToken(token);
    } catch {
      return null;
    }
  }

  v1.get("/me", async (c) => {
    const session = await getDeviceSession(c);
    if (!session) return errorResponse(c, 401, "unauthorized", "Not authenticated");

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
      return errorResponse(c, 502, "internal_error", "Identity provider is unavailable");
    }

    const me: AccountMe = {
      id: user.id,
      name: user.name ?? user.email,
      email: user.email,
      ...(user.avatarUrl ? { image: user.avatarUrl } : {}),
    };
    return c.json(me);
  });

  v1.get("/hosts", async (c) => {
    const session = await getDeviceSession(c);
    if (!session) return errorResponse(c, 401, "unauthorized", "Not authenticated");

    const rows = await db.select().from(hosts).where(eq(hosts.userId, session.userId));
    const body: ListHostsResponse = { hosts: rows.map(toAccountHost) };
    return c.json(body);
  });

  v1.post("/hosts", async (c) => {
    const session = await getDeviceSession(c);
    if (!session) return errorResponse(c, 401, "unauthorized", "Not authenticated");

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
        .where(and(eq(hosts.userId, session.userId), eq(hosts.environmentId, parsed.environmentId)))
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
            userId: session.userId,
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

    const session = await getDeviceSession(c);
    if (!session) return errorResponse(c, 401, "unauthorized", "Not authenticated");

    const deleted = await db
      .delete(hosts)
      .where(and(eq(hosts.id, id), eq(hosts.userId, session.userId)))
      .returning();
    if (deleted.length === 0) return errorResponse(c, 404, "host_not_found", "Host not found");

    return c.body(null, 204);
  });

  // TASK2: GET /sessions and DELETE /sessions/:id were BetterAuth session-table
  // reads. WorkOS owns sessions now, so they have to be rebuilt on the WorkOS
  // sessions API (and the InstanceInfo contract below reworked with them).

  v1.get("/instance", (c) => {
    // TASK2: InstanceInfo still describes BetterAuth's capability flags. Sign-in
    // methods are WorkOS dashboard toggles this service cannot enumerate, so
    // these are placeholders until the contract changes.
    const body: InstanceInfo = {
      version: API_VERSION,
      authMethods: { emailPassword: true, social: [] },
      emailDelivery: false,
      signupRestricted: false,
    };
    return c.json(body);
  });

  return v1;
}
