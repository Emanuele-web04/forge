// FILE: testing/fakeWorkos.ts
// Purpose: An in-process stand-in for the WorkOS API — serves a JWKS backed by
// a freshly generated key pair, mints access tokens signed by it, and answers
// the user-lookup, authorize, and authenticate endpoints. Lets the auth path
// be exercised end to end with no network and no shared fixtures.
// Layer: API test support (also drives `scripts/fake-workos.ts`, the dev stub)
// Depends on: jose, hono, @hono/node-server.

import { createHash, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { WorkosApiConfig } from "../config";

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
  config(overrides?: Partial<WorkosApiConfig>): WorkosApiConfig;
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
   * claim the refresh grant produces; leave it off for an unscoped token.
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
   * Mints an authorization code bound to a PKCE challenge, as completing the
   * hosted authorize page would. Registers `email`'s user if needed. Tests
   * that skip the hosted page drive the exchange with this directly.
   */
  issueAuthorizationCode(email: string, params: { codeChallenge: string }): string;
  /**
   * Makes the next authenticate grant (any grant type) refuse with WorkOS's
   * `organization_selection_required` shape, once — what a multi-org user
   * gets when the environment wants a workspace chosen. How a test proves
   * the service fails closed on it instead of 502ing.
   */
  requireOrganizationSelectionOnNextAuthenticate(): void;
  /**
   * The live Magic Auth for `email`, if one exists — the 6-digit code a real
   * user would read out of their inbox, and when it expires. Same rule as
   * {@link currentVerification}: the code reaches a test only through this
   * accessor, never through the service under test.
   */
  currentMagicAuth(email: string): { code: string; expiresAt: string } | undefined;
  /** Forces the live Magic Auth for `email` past its expiry. */
  expireMagicAuth(email: string): void;
  /** Every request the server has seen, oldest first. */
  requests: FakeWorkosRequest[];
  close(): Promise<void>;
};

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
   * Email domains the fake treats as SSO-governed, refusing Magic Auth with
   * the OAuth-shaped `sso_required` body WorkOS answers for them (observed
   * live via its built-in example.com test connection).
   */
  ssoRequiredDomains?: readonly string[];
  /**
   * Called whenever a Magic Auth code is minted — the seam the dev identity
   * provider uses to print the code that real WorkOS would have emailed.
   * Deliberately an observation hook: the double never delivers codes itself.
   */
  onMagicAuth?: (email: string, code: string) => void;
  /**
   * When set, `GET /user_management/authorize` self-approves as this email:
   * it answers the 302 to `redirect_uri` carrying a fresh authorization code
   * (bound to the request's PKCE challenge) and the echoed `state` — standing
   * in for the human finishing the hosted provider page. Unset, the endpoint
   * refuses: approval stays an action performed on this double from the
   * outside (`issueAuthorizationCode`), exactly like device approval.
   */
  autoApproveAuthorizeAs?: string;
};

/** How long a fake Magic Auth code lives — WorkOS's documented 10 minutes. */
const MAGIC_AUTH_TTL_MS = 10 * 60 * 1000;

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
  /** One-shot: the next authenticate grant refuses with org selection. */
  let organizationSelectionNext = false;
  /** Live refresh tokens → the user they belong to. Single-use, as WorkOS's are. */
  const refreshTokens = new Map<string, string>();
  /**
   * Live Magic Auth codes by email — what WorkOS would have emailed, and when
   * it stops working. Held in clear only because this is an in-process double
   * that dies with the test: it exists so the grant can actually reject a
   * wrong or expired code, which a stub that accepted anything could not do.
   * A re-send replaces the entry in place, invalidating the old code.
   */
  const magicAuths = new Map<string, { code: string; expiresAtMs: number }>();
  /**
   * Live authorization codes → the user they sign in and the PKCE challenge
   * the exchange must prove. Single-use, as WorkOS's are, and the challenge
   * binding is enforced so a service that dropped the verifier (or hashed it
   * wrong) fails here as it would in production.
   */
  const authorizationCodes = new Map<string, { userId: string; codeChallenge: string }>();
  /**
   * Deterministic, sequential 6-digit codes. Sequential rather than random so
   * a test that needs "a wrong code" can rely on any other six digits being
   * wrong, and so a resend visibly changes the code.
   */
  let nextVerificationCode = 0;

  function mintVerificationCode(): string {
    nextVerificationCode += 1;
    return String(nextVerificationCode).padStart(6, "0");
  }

  const ssoRequiredDomains = new Set(options.ssoRequiredDomains ?? []);

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

  function issueAuthorizationCode(email: string, params: { codeChallenge: string }): string {
    const record = [...users.values()].find((user) => user.email === email) ?? addUser({ email });
    const code = `authz_fake_${randomUUID()}`;
    authorizationCodes.set(code, { userId: record.id, codeChallenge: params.codeChallenge });
    return code;
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

  /**
   * The hosted authorize page, reduced to its outcome. Real WorkOS serves the
   * provider's sign-in UI here; this double either self-approves (the dev
   * provider's mode) with a 302 back to `redirect_uri` carrying the code and
   * echoed state, or refuses so a test approves via `issueAuthorizationCode`.
   */
  app.get("/user_management/authorize", (c) => {
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const state = c.req.query("state") ?? "";
    if (
      c.req.query("client_id") !== clientId ||
      c.req.query("response_type") !== "code" ||
      c.req.query("code_challenge_method") !== "S256" ||
      !redirectUri ||
      !codeChallenge
    ) {
      return c.json({ error: "invalid_request", error_description: "Malformed authorize" }, 400);
    }
    const approveAs = options.autoApproveAuthorizeAs;
    if (!approveAs) {
      return c.json(
        { error: "access_denied", error_description: "No auto-approval configured" },
        403,
      );
    }
    const code = issueAuthorizationCode(approveAs, { codeChallenge });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return c.redirect(target.toString(), 302);
  });

  /**
   * The token endpoint, covering the grants Synara uses: Magic Auth, the
   * PKCE code exchange, and refresh. Error bodies use the OAuth
   * `error`/`error_description` shape the client decodes.
   */
  app.post("/user_management/authenticate", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const grantType = typeof body?.grant_type === "string" ? body.grant_type : "";

    if (organizationSelectionNext) {
      organizationSelectionNext = false;
      // The shape WorkOS answers a multi-org user with: an error naming the
      // required selection, a pending token to complete it, and the
      // organizations on offer.
      return c.json(
        {
          error: "organization_selection_required",
          pending_authentication_token: `pat_fake_${randomUUID()}`,
          organizations: [...organizations.values()].map((organization) => ({
            id: organization.id,
            name: organization.name,
          })),
        },
        400,
      );
    }

    // The Magic Auth grant. Confidential-client, so the secret is checked
    // here as WorkOS checks it — a proxy that forgot to send it must fail
    // against this double too, not just in production.
    if (grantType === "urn:workos:oauth:grant-type:magic-auth:code") {
      if (body?.client_secret !== apiKey) {
        return c.json(
          { error: "invalid_client", error_description: "Missing or invalid client secret" },
          401,
        );
      }
      const email = typeof body?.email === "string" ? body.email : "";
      const submitted = typeof body?.code === "string" ? body.code : "";
      const live = magicAuths.get(email);
      if (!live || live.code !== submitted) {
        // One OAuth-shaped answer for "no live code for that address" and
        // "wrong code", as WorkOS answers a refused one-time code.
        return c.json({ error: "invalid_grant", error_description: "Invalid code" }, 401);
      }
      if (live.expiresAtMs <= Date.now()) {
        magicAuths.delete(email);
        return c.json({ error: "invalid_grant", error_description: "The code has expired" }, 401);
      }
      // Redeemed: the code is single-use, and the user is provisioned on
      // first successful redemption — WorkOS's create-on-redeem behavior when
      // sign-up is allowed.
      magicAuths.delete(email);
      const record = [...users.values()].find((user) => user.email === email) ?? addUser({ email });
      return c.json(await issueTokenPair(record.id));
    }

    // The authorization-code + PKCE exchange. The challenge binding is real:
    // S256(verifier) must equal the challenge the code was minted against, so
    // a proxy that lost or mangled the verifier fails here as in production.
    if (grantType === "authorization_code") {
      const code = typeof body?.code === "string" ? body.code : "";
      const codeVerifier = typeof body?.code_verifier === "string" ? body.code_verifier : "";
      const grant = authorizationCodes.get(code);
      if (!grant) {
        return c.json(
          { error: "invalid_grant", error_description: "Authorization code is invalid or spent" },
          400,
        );
      }
      const hashed = createHash("sha256").update(codeVerifier).digest("base64url");
      if (hashed !== grant.codeChallenge) {
        // The code dies with a failed proof, as a single-use credential must.
        authorizationCodes.delete(code);
        return c.json(
          { error: "invalid_grant", error_description: "PKCE verification failed" },
          400,
        );
      }
      authorizationCodes.delete(code);
      return c.json(await issueTokenPair(grant.userId));
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

  // Create Magic Auth. Mints (and "emails") the 6-digit code; the response
  // contains the code itself, exactly as WorkOS's does — which is what makes
  // the service's allowlist parsing testable. Refuses SSO-governed domains
  // before anything else, as WorkOS refuses them by domain policy.
  app.post("/user_management/magic_auth", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email : "";
    if (!email) return c.json({ message: "email is required" }, 422);
    const domain = email.split("@")[1] ?? "";
    if (ssoRequiredDomains.has(domain)) {
      return c.json(
        {
          error: "sso_required",
          error_description: "User must authenticate using one of the matching connections.",
        },
        400,
      );
    }
    // A new code replaces any live one, so an earlier emailed code stops
    // working — exactly the invalidation a resend must cause.
    const code = mintVerificationCode();
    const expiresAtMs = Date.now() + MAGIC_AUTH_TTL_MS;
    magicAuths.set(email, { code, expiresAtMs });
    options.onMagicAuth?.(email, code);
    return c.json(
      {
        object: "magic_auth",
        id: `magic_auth_fake_${randomUUID()}`,
        user_id: [...users.values()].find((user) => user.email === email)?.id ?? null,
        email,
        expires_at: new Date(expiresAtMs).toISOString(),
        code,
      },
      201,
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
    const orgId = c.req.query("organization_id");
    const after = c.req.query("after");
    const limitParam = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 100;
    const matching = memberships.filter(
      (entry) =>
        (userId === undefined || entry.userId === userId) &&
        (orgId === undefined || entry.orgId === orgId),
    );
    const start = after
      ? Math.max(
          0,
          matching.findIndex((entry) => `om_fake_${entry.orgId}_${entry.userId}` === after) + 1,
        )
      : 0;
    const page = matching.slice(start, start + limit);
    const data = page.map((entry) => ({
      object: "organization_membership",
      id: `om_fake_${entry.orgId}_${entry.userId}`,
      user_id: entry.userId,
      organization_id: entry.orgId,
      organization_name: organizations.get(entry.orgId)?.name ?? null,
      status: "active",
    }));
    const next = start + page.length < matching.length ? (data.at(-1)?.id ?? null) : null;
    return c.json({ object: "list", data, list_metadata: { before: null, after: next } });
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

  // Update Organization. PUT, not PATCH: WorkOS models the rename as a full
  // replacement, and a caller that guessed PATCH would 404 here as it would
  // there.
  app.put("/organizations/:id", async (c) => {
    const organization = organizations.get(c.req.param("id"));
    if (!organization) return c.json({ message: "Organization not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name : "";
    if (!name) return c.json({ message: "name is required" }, 422);
    const updated = { ...organization, name };
    organizations.set(updated.id, updated);
    return c.json({ object: "organization", ...updated });
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

    currentMagicAuth(email) {
      const live = magicAuths.get(email);
      return live
        ? { code: live.code, expiresAt: new Date(live.expiresAtMs).toISOString() }
        : undefined;
    },

    expireMagicAuth(email) {
      const live = magicAuths.get(email);
      if (live) magicAuths.set(email, { ...live, expiresAtMs: Date.now() - 1 });
    },

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
        identityProvider: "workos",
        databaseUrl: "postgres://unused",
        baseUrl: "http://localhost:8788",
        apiPublicUrl: "http://localhost:8788/api/v1",
        apiSigningKey: Buffer.alloc(32, 1).toString("base64url"),
        relayServiceToken: "relay-test-secret",
        port: 8788,
        trustedProxyHops: 1,
        workosApiKey: apiKey,
        workosClientId: clientId,
        workosApiUrl: origin,
        ...overrides,
      };
    },

    issueAuthorizationCode,

    requireOrganizationSelectionOnNextAuthenticate() {
      organizationSelectionNext = true;
    },

    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
