// FILE: testing/fakeWorkos.ts
// Purpose: An in-process stand-in for the WorkOS API — serves a JWKS backed by
// a freshly generated key pair, mints access tokens signed by it, and answers
// the user-lookup, device-authorization, and authenticate endpoints. Lets the
// auth path be exercised end to end with no network and no shared fixtures.
// Layer: API test support (also drives `scripts/fake-workos.ts`, the dev stub)
// Depends on: jose, hono, @hono/node-server.

import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ApiConfig } from "../config";

const KID = "fake-workos-key";

/**
 * The environment-scoped client id this server issues under, derived from the
 * app's so it can never accidentally equal it. Real WorkOS scopes `iss` to the
 * *environment's* client id, which differs from the AuthKit application's
 * whenever the app is not the environment default — a double that reused the
 * app id would let a hand-derived issuer pass and hide the bug discovery
 * exists to fix, so the difference must survive any caller's `clientId`.
 */
function environmentClientId(clientId: string): string {
  return `${clientId}_env`;
}

export type FakeWorkosRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
};

export type FakeWorkosUser = {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  profile_picture_url?: string | null;
};

export type FakeWorkosOrganization = {
  id: string;
  name: string;
};

export type FakeWorkos = {
  origin: string;
  clientId: string;
  apiKey: string;
  /** The `iss` this server mints and advertises through OIDC discovery. */
  issuer: string;
  /** Config pointed at this server; spread overrides on top as needed. */
  config(overrides?: Partial<ApiConfig>): ApiConfig;
  /** Registers a user that `getUser` will return, and returns its id. */
  addUser(user: Partial<FakeWorkosUser> & { id?: string }): FakeWorkosUser;
  /** Registers an organization, as the Organizations API would create it. */
  addOrganization(organization?: { id?: string; name?: string }): FakeWorkosOrganization;
  /** Makes `userId` a member of `orgId`, so membership listing returns it. */
  addMembership(orgId: string, userId: string): void;
  /** Drops a membership, standing in for a user being removed from a team. */
  removeMembership(orgId: string, userId: string): void;
  /**
   * Mints an access token with the given claims; `expiresIn` accepts jose spans.
   * `issuer` defaults to the value this server's config expects — pass a
   * different one to exercise the issuer check. `orgId` mints the `org_id`
   * claim the refresh grant produces; leave it off for a device-grant token.
   */
  signAccessToken(claims: {
    sub: string;
    sid?: string;
    expiresIn?: string;
    issuer?: string;
    orgId?: string;
    /**
     * The `client_id` claim, which real WorkOS puts in every access token and
     * which binds it to one AuthKit application. Defaults to this server's, so
     * ordinary tokens verify; pass another id to mint a sibling application's
     * token, or `null` to omit the claim entirely.
     */
    clientId?: string | null;
  }): Promise<string>;
  /**
   * Approves a pending device authorization, as a human clicking through the
   * hosted page would. Until this is called `authenticate` answers
   * `authorization_pending`, which is what makes the CLI's poll loop real.
   * Registers `user` if it is not already known, so a caller can drive the
   * whole flow with one call.
   */
  approveDevice(
    deviceCode: string,
    user?: Partial<FakeWorkosUser> & { id?: string },
  ): FakeWorkosUser;
  /** Every request the server has seen, oldest first. */
  requests: FakeWorkosRequest[];
  close(): Promise<void>;
};

export const FAKE_DEVICE_AUTHORIZATION = {
  device_code: "dc_fake_123",
  user_code: "ABCD-EFGH",
  verification_uri: "https://auth.example.com/device",
  verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
  expires_in: 600,
  interval: 5,
} as const;

export type StartFakeWorkosOptions = {
  apiKey?: string;
  clientId?: string;
  /**
   * Lifetime of minted access tokens, as a jose span. Short values are how the
   * dev stub forces the CLI down its refresh path within one session.
   */
  accessTokenTtl?: string;
  /**
   * Fixed port to listen on. Defaults to 0 (ephemeral) so parallel test files
   * never collide; the dev stub pins one so its URLs can be printed up front.
   */
  port?: number;
  /**
   * Called whenever a device authorization is issued. The seam the dev stub
   * uses to stand in for a human approving the hosted page; approval stays an
   * action performed on this double from the outside, never something it does
   * to itself.
   */
  onDeviceAuthorization?: (deviceCode: string) => void;
};

export async function startFakeWorkos(options: StartFakeWorkosOptions = {}): Promise<FakeWorkos> {
  const apiKey = options.apiKey ?? "sk_test_fake";
  const clientId = options.clientId ?? "client_01FAKE";
  const accessTokenTtl = options.accessTokenTtl ?? "5m";

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };

  const users = new Map<string, FakeWorkosUser>();
  const organizations = new Map<string, FakeWorkosOrganization>();
  /**
   * Membership edges, held as records rather than joined strings: WorkOS ids
   * are opaque, so any separator is a guess about what they cannot contain.
   */
  const memberships: Array<{ orgId: string; userId: string }> = [];
  const requests: FakeWorkosRequest[] = [];
  /** Device codes handed out but not yet approved, and who approved them. */
  const deviceGrants = new Map<string, { approvedBy?: string }>();
  /** Live refresh tokens → the user they belong to. Single-use, as WorkOS's are. */
  const refreshTokens = new Map<string, string>();

  const hasMembership = (orgId: string, userId: string): boolean =>
    memberships.some((entry) => entry.orgId === orgId && entry.userId === userId);

  function addMembership(orgId: string, userId: string): void {
    if (!hasMembership(orgId, userId)) memberships.push({ orgId, userId });
  }

  // Declared up front rather than only on the returned object: the
  // `authenticate` route below needs to mint tokens and register users too.
  let origin = "";
  let issuer = "";

  function addUser(user: Partial<FakeWorkosUser> & { id?: string }): FakeWorkosUser {
    // Random, not sequential: host rows are keyed by WorkOS user id and the
    // test database outlives a run, so a counter would make the second run
    // against the same database inherit the first run's hosts.
    const id = user.id ?? `user_fake_${randomUUID()}`;
    // Explicitly-undefined keys are dropped before the spread: `{id: undefined}`
    // would otherwise overwrite the id resolved just above.
    const provided = Object.fromEntries(
      Object.entries(user).filter(([, value]) => value !== undefined),
    );
    const record: FakeWorkosUser = {
      id,
      email: `${id}@example.com`,
      ...provided,
    };
    users.set(record.id, record);
    return record;
  }

  function addOrganization(
    organization: { id?: string; name?: string } = {},
  ): FakeWorkosOrganization {
    const id = organization.id ?? `org_fake_${randomUUID()}`;
    const record: FakeWorkosOrganization = { id, name: organization.name ?? `Organization ${id}` };
    organizations.set(id, record);
    return record;
  }

  function signAccessToken({
    sub,
    sid,
    expiresIn = accessTokenTtl,
    issuer: issuerOverride,
    orgId,
    clientId: clientIdClaim,
  }: {
    sub: string;
    sid?: string;
    expiresIn?: string;
    issuer?: string;
    orgId?: string;
    clientId?: string | null;
  }): Promise<string> {
    const claims: Record<string, unknown> = { sub };
    if (sid !== undefined) claims.sid = sid;
    if (orgId !== undefined) claims.org_id = orgId;
    // Present on every real access token, so present by default here too:
    // a double that omitted it would let a service skip the application
    // binding and still pass its whole suite.
    if (clientIdClaim !== null) claims.client_id = clientIdClaim ?? clientId;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(issuerOverride ?? issuer)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  /**
   * Mints the pair WorkOS returns from `authenticate`. The refresh token is
   * single-use here as it is there: redeeming one deletes it and issues a
   * replacement, so a client that fails to persist the rotation is locked out
   * exactly the way it would be in production.
   */
  async function issueTokenPair(userId: string, orgId?: string) {
    const user = users.get(userId) ?? addUser({ id: userId });
    const refreshToken = `rt_fake_${randomUUID()}`;
    refreshTokens.set(refreshToken, user.id);
    return {
      access_token: await signAccessToken({
        sub: user.id,
        sid: `session_${randomUUID()}`,
        ...(orgId !== undefined ? { orgId } : {}),
      }),
      refresh_token: refreshToken,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name ?? null,
        last_name: user.last_name ?? null,
      },
    };
  }

  const app = new Hono();
  app.use("*", async (c, next) => {
    requests.push({
      method: c.req.method,
      path: c.req.path,
      authorization: c.req.header("authorization"),
      body: c.req.method === "GET" ? "" : await c.req.raw.clone().text(),
    });
    await next();
  });

  app.get(`/sso/jwks/${clientId}`, (c) => c.json({ keys: [publicJwk] }));

  // The OIDC metadata document, queried by the *app* client id but answering
  // with the environment-scoped issuer — exactly how real WorkOS behaves, and
  // the only way a caller can learn the issuer it must expect.
  app.get(`/user_management/${clientId}/.well-known/openid-configuration`, (c) =>
    c.json({
      issuer,
      jwks_uri: `${origin}/sso/jwks/${clientId}`,
      token_endpoint: `${origin}/user_management/authenticate`,
    }),
  );

  app.post("/user_management/authorize/device", (c) => {
    // Same fixed code every time, so tests can assert against the exported
    // constant; re-issuing simply resets it to unapproved.
    deviceGrants.set(FAKE_DEVICE_AUTHORIZATION.device_code, {});
    options.onDeviceAuthorization?.(FAKE_DEVICE_AUTHORIZATION.device_code);
    return c.json(FAKE_DEVICE_AUTHORIZATION);
  });

  /**
   * The token endpoint, covering the two grants Synara uses: the device grant
   * the CLI polls after `synara auth`, and the refresh grant it falls back to
   * when an access token expires mid-command. Error bodies use the OAuth
   * `error`/`error_description` shape the client decodes.
   */
  app.post("/user_management/authenticate", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const grantType = typeof body?.grant_type === "string" ? body.grant_type : "";

    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const deviceCode = typeof body?.device_code === "string" ? body.device_code : "";
      const grant = deviceGrants.get(deviceCode);
      if (!grant) {
        return c.json(
          { error: "invalid_grant", error_description: "Unknown or expired device code" },
          400,
        );
      }
      if (!grant.approvedBy) {
        return c.json(
          {
            error: "authorization_pending",
            error_description: "The user has not yet approved this device",
          },
          400,
        );
      }
      // Consumed on success: a device code is redeemable exactly once.
      deviceGrants.delete(deviceCode);
      return c.json(await issueTokenPair(grant.approvedBy));
    }

    if (grantType === "refresh_token") {
      const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : "";
      const userId = refreshTokens.get(refreshToken);
      if (!userId) {
        return c.json(
          { error: "invalid_grant", error_description: "Refresh token is invalid or spent" },
          400,
        );
      }
      refreshTokens.delete(refreshToken);
      const orgId = typeof body?.organization_id === "string" ? body.organization_id : undefined;
      // Authenticating into an organization the user does not belong to is
      // refused, as real WorkOS refuses it — otherwise a stale stored org id
      // would keep minting usable tokens forever.
      if (orgId !== undefined && !hasMembership(orgId, userId)) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "User is not a member of the requested organization",
          },
          400,
        );
      }
      return c.json(await issueTokenPair(userId, orgId));
    }

    return c.json(
      { error: "unsupported_grant_type", error_description: `Unsupported grant: ${grantType}` },
      400,
    );
  });

  app.get("/user_management/users/:id", (c) => {
    const user = users.get(c.req.param("id"));
    if (!user) return c.json({ message: "User not found" }, 404);
    return c.json(user);
  });

  // Memberships carry `organization_name` inline, as the real listing does —
  // a caller that had to fan out over the Organizations API for names would
  // pass against a double that omitted it and fail against WorkOS.
  app.get("/user_management/organization_memberships", (c) => {
    const userId = c.req.query("user_id");
    const data = memberships
      .filter((entry) => entry.userId === userId)
      .map((entry) => ({
        object: "organization_membership",
        id: `om_fake_${entry.orgId}_${entry.userId}`,
        user_id: entry.userId,
        organization_id: entry.orgId,
        organization_name: organizations.get(entry.orgId)?.name ?? null,
        status: "active",
      }));
    return c.json({ object: "list", data, list_metadata: { before: null, after: null } });
  });

  // The Organizations API, deliberately not under /user_management: a caller
  // that guessed the user-management path would 404 here as it would there.
  app.post("/organizations", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name : "";
    if (!name) return c.json({ message: "name is required" }, 422);
    const organization = addOrganization({ name });
    return c.json({ object: "organization", ...organization }, 201);
  });

  app.post("/user_management/organization_memberships", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const orgId = typeof body?.organization_id === "string" ? body.organization_id : "";
    const userId = typeof body?.user_id === "string" ? body.user_id : "";
    if (!orgId || !userId) {
      return c.json({ message: "organization_id and user_id are required" }, 422);
    }
    // WorkOS rejects a duplicate membership rather than making it idempotent,
    // which is precisely the conflict the provisioning race has to survive.
    if (hasMembership(orgId, userId)) {
      return c.json({ code: "entity_already_exists", message: "Membership already exists" }, 409);
    }
    addMembership(orgId, userId);
    return c.json(
      {
        object: "organization_membership",
        id: `om_fake_${orgId}_${userId}`,
        user_id: userId,
        organization_id: orgId,
        organization_name: organizations.get(orgId)?.name ?? null,
        status: "active",
      },
      201,
    );
  });

  const server = serve({ fetch: app.fetch, port: options.port ?? 0 });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake WorkOS server failed to bind a port");
  }
  origin = `http://127.0.0.1:${address.port}`;
  issuer = `${origin}/user_management/${environmentClientId(clientId)}`;

  return {
    origin,
    clientId,
    apiKey,
    issuer,
    requests,
    addUser,
    addOrganization,
    addMembership,
    signAccessToken,

    removeMembership(orgId, userId) {
      const index = memberships.findIndex(
        (entry) => entry.orgId === orgId && entry.userId === userId,
      );
      if (index >= 0) memberships.splice(index, 1);
    },

    // No issuer or JWKS url by default: the service discovers both from the
    // metadata document above, which is the path production takes.
    config(overrides = {}) {
      return {
        databaseUrl: "postgres://unused",
        baseUrl: "http://localhost:8788",
        port: 8788,
        workosApiKey: apiKey,
        workosClientId: clientId,
        workosApiUrl: origin,
        ...overrides,
      };
    },

    approveDevice(deviceCode, user = {}) {
      const record = user.id ? (users.get(user.id) ?? addUser(user)) : addUser(user);
      deviceGrants.set(deviceCode, { approvedBy: record.id });
      return record;
    },

    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
