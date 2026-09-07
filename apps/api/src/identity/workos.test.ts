import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkosApiConfig } from "../config";
import { startFakeWorkos, type FakeWorkos } from "../testing/fakeWorkos";
import {
  classifyAuthorizationCodeFailure,
  classifyMagicAuthFailure,
  createWorkosIdentityProvider,
} from "./workos";

/**
 * The flat surface these tests were written against: the verifier plus the
 * raw organization calls, which the provider now returns as two objects.
 */
function createWorkosAuth(config: WorkosApiConfig) {
  const { verifier, organizations } = createWorkosIdentityProvider(config);
  return { ...verifier, ...organizations };
}

let workos: FakeWorkos;

beforeAll(async () => {
  workos = await startFakeWorkos();
});

afterAll(async () => {
  await workos.close();
});

/** The metadata document the service fetches on its first verification. */
function discoveryPath(clientId: string): string {
  return `/user_management/${clientId}/.well-known/openid-configuration`;
}

describe("verifyAccessToken", () => {
  it("returns the user and session ids from a valid token", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({ sub: "user_123", sid: "session_456" });
    await expect(auth.verifyAccessToken(token)).resolves.toEqual({
      userId: "user_123",
      sessionId: "session_456",
    });
  });

  it("rejects an expired token", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      expiresIn: "-1s",
    });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  it("rejects a token signed by a key the JWKS does not publish", async () => {
    const other = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "user_123", sid: "session_456" })
      .setProtectedHeader({ alg: "RS256", kid: "not-in-the-jwks" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(other.privateKey);
    const auth = createWorkosAuth(workos.config());
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  // Guards against a token minted by some other WorkOS tenant/environment that
  // happens to be signature-valid against a JWKS we trust.
  it("rejects a token from an unexpected issuer", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      issuer: "https://evil.example.com/",
    });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  // The bug this discovery path exists to fix: `iss` is scoped to the
  // environment's client id, so the old `${apiUrl}/` guess rejected every real
  // token. Pinning that guess must still be rejected.
  it("rejects a token when a wrong issuer is pinned", async () => {
    const auth = createWorkosAuth(workos.config({ workosIssuer: `${workos.origin}/` }));
    const token = await workos.signAccessToken({ sub: "user_123", sid: "session_456" });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  it("accepts a token whose issuer matches an explicit override", async () => {
    const auth = createWorkosAuth(workos.config({ workosIssuer: "https://auth.example.com" }));
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      issuer: "https://auth.example.com",
    });
    await expect(auth.verifyAccessToken(token)).resolves.toMatchObject({ userId: "user_123" });
  });

  // First sign-in mints org-less tokens, so "no org_id" is the ordinary
  // case and must verify — the route layer, not this one, decides what to do.
  it("omits orgId for a token minted without the claim", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({ sub: "user_123", sid: "session_456" });
    await expect(auth.verifyAccessToken(token)).resolves.toEqual({
      userId: "user_123",
      sessionId: "session_456",
    });
  });

  it("returns the org_id claim when the token carries one", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      orgId: "org_789",
    });
    await expect(auth.verifyAccessToken(token)).resolves.toEqual({
      userId: "user_123",
      sessionId: "session_456",
      orgId: "org_789",
    });
  });

  /**
   * One WorkOS environment serves one issuer across every AuthKit application
   * in it, and they all share a JWKS. Signature, expiry and issuer therefore
   * all pass for a token minted for a *sibling* application — `client_id` is
   * the only claim that says the token was meant for us.
   */
  it("rejects a token minted for a different application in the same environment", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      clientId: "client_01SIBLING",
    });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  // Strict by default: a token with no `client_id` at all cannot be shown to
  // belong to this application, so it is refused rather than waved through.
  it("rejects a token carrying no client_id claim", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      clientId: null,
    });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  it("accepts a token whose client_id is this application's", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      clientId: workos.clientId,
    });
    await expect(auth.verifyAccessToken(token)).resolves.toMatchObject({ userId: "user_123" });
  });

  it("rejects a malformed token", async () => {
    const auth = createWorkosAuth(workos.config());
    await expect(auth.verifyAccessToken("not-a-jwt")).rejects.toThrow();
  });

  // Without `sid` there is no session identity to hang logout or session
  // listing on, so an otherwise well-signed token is still not usable.
  it("rejects a token missing the session id", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({ sub: "user_123" });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });
});

describe("issuer discovery", () => {
  it("verifies against the environment-scoped issuer the metadata advertises", async () => {
    // Load-bearing: the fake mints `iss` under an environment client id that
    // is not the app's, so only a discovered issuer can match.
    expect(workos.issuer.endsWith(`/${workos.clientId}`)).toBe(false);
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({ sub: "user_disco", sid: "session_disco" });
    await expect(auth.verifyAccessToken(token)).resolves.toEqual({
      userId: "user_disco",
      sessionId: "session_disco",
    });
  });

  it("fetches the metadata document exactly once across concurrent verifications", async () => {
    const auth = createWorkosAuth(workos.config());
    const before = workos.requests.length;
    const tokens = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => workos.signAccessToken({ sub: `user_${n}`, sid: `session_${n}` })),
    );

    await Promise.all(tokens.map((token) => auth.verifyAccessToken(token)));

    const discoveries = workos.requests
      .slice(before)
      .filter((request) => request.path === discoveryPath(workos.clientId));
    expect(discoveries).toHaveLength(1);
  });

  it("throws naming the discovery URL when the metadata cannot be loaded", async () => {
    // An unroutable origin: without a trusted issuer there is nothing safe to
    // fall back to, so verification must fail loudly rather than relax.
    const auth = createWorkosAuth(workos.config({ workosApiUrl: "http://127.0.0.1:1" }));
    const token = await workos.signAccessToken({ sub: "user_123", sid: "session_456" });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow(
      `http://127.0.0.1:1/user_management/${workos.clientId}/.well-known/openid-configuration`,
    );
  });

  // A stalled connection would otherwise wedge every verification behind a
  // memoized promise that never settles — eviction only runs on rejection.
  // Asserting the signal rather than simulating a real hang, which is
  // expensive to stage and slow to run.
  it("bounds the discovery fetch with an abort signal", async () => {
    const realFetch = globalThis.fetch;
    const signals: Array<AbortSignal | null | undefined> = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      ...args: Parameters<typeof fetch>
    ) => {
      const [input, init] = args;
      if (String(input).includes(".well-known/openid-configuration")) {
        signals.push(init?.signal);
      }
      return realFetch(...args);
    }) as typeof fetch);

    try {
      const auth = createWorkosAuth(workos.config());
      const token = await workos.signAccessToken({ sub: "user_abort", sid: "session_abort" });
      await expect(auth.verifyAccessToken(token)).resolves.toMatchObject({ userId: "user_abort" });
    } finally {
      spy.mockRestore();
    }

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("skips discovery entirely when both the issuer and JWKS url are pinned", async () => {
    const auth = createWorkosAuth(
      workos.config({
        workosIssuer: workos.issuer,
        workosJwksUrl: `${workos.origin}/sso/jwks/${workos.clientId}`,
      }),
    );
    const before = workos.requests.length;
    const token = await workos.signAccessToken({ sub: "user_pinned", sid: "session_pinned" });

    await expect(auth.verifyAccessToken(token)).resolves.toMatchObject({ userId: "user_pinned" });
    expect(
      workos.requests.slice(before).filter((r) => r.path === discoveryPath(workos.clientId)),
    ).toHaveLength(0);
  });
});

describe("organizations", () => {
  it("lists a user's memberships with the organization names served inline", async () => {
    const auth = createWorkosAuth(workos.config());
    const user = workos.addUser({});
    const acme = workos.addOrganization({ name: "Acme Corp" });
    const other = workos.addOrganization({ name: "Side Project" });
    workos.addMembership(acme.id, user.id);
    workos.addMembership(other.id, user.id);
    const before = workos.requests.length;

    const memberships = await auth.listUserOrganizationMemberships(user.id);

    expect(memberships).toEqual(
      expect.arrayContaining([
        { orgId: acme.id, orgName: "Acme Corp" },
        { orgId: other.id, orgName: "Side Project" },
      ]),
    );
    expect(memberships).toHaveLength(2);
    // One request, not one per organization: the name comes back inline.
    expect(workos.requests.slice(before)).toHaveLength(1);
    expect(workos.requests[before]?.authorization).toBe(`Bearer ${workos.apiKey}`);
    expect(workos.requests[before]?.path).toBe("/user_management/organization_memberships");
  });

  it("paginates membership authorization inputs beyond WorkOS's 100-row cap", async () => {
    const auth = createWorkosAuth(workos.config());
    const user = workos.addUser({});
    for (let index = 0; index < 101; index += 1) {
      const organization = workos.addOrganization({ name: `Org ${index}` });
      workos.addMembership(organization.id, user.id);
    }
    const before = workos.requests.length;
    await expect(auth.listUserOrganizationMemberships(user.id)).resolves.toHaveLength(101);
    expect(
      workos.requests
        .slice(before)
        .filter((request) => request.path === "/user_management/organization_memberships"),
    ).toHaveLength(2);
  });

  it("returns an empty list for a user in no organizations", async () => {
    const auth = createWorkosAuth(workos.config());
    await expect(auth.listUserOrganizationMemberships(workos.addUser({}).id)).resolves.toEqual([]);
  });

  // Isolation is decided on the org id, so a listing that leaked another
  // user's membership would hand them someone else's hosts.
  it("does not return another user's memberships", async () => {
    const auth = createWorkosAuth(workos.config());
    const owner = workos.addUser({});
    const stranger = workos.addUser({});
    const org = workos.addOrganization({ name: "Owner Only" });
    workos.addMembership(org.id, owner.id);

    await expect(auth.listUserOrganizationMemberships(stranger.id)).resolves.toEqual([]);
  });

  /**
   * A membership list is an authorization input: it decides which hosts the
   * caller can see, and an empty one triggers personal-org provisioning. A 200
   * whose body is not the documented shape must therefore fail the request
   * rather than be read as "this user belongs to nothing".
   */
  describe("malformed listing responses", () => {
    const malformed: Array<[string, unknown]> = [
      ["a body with no data array", { object: "list" }],
      ["a data field that is not an array", { object: "list", data: { organization_id: "org_a" } }],
      ["an entry that is not an object", { object: "list", data: ["org_a"] }],
      ["an entry with no organization id", { object: "list", data: [{ status: "active" }] }],
      [
        "an entry whose organization id is blank",
        { object: "list", data: [{ organization_id: "" }] },
      ],
    ];

    it.each(malformed)("throws on %s", async (_label, body) => {
      const auth = createWorkosAuth(
        workos.config({
          workosIssuer: workos.issuer,
          workosJwksUrl: `${workos.origin}/sso/jwks/${workos.clientId}`,
        }),
      );
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      try {
        await expect(auth.listUserOrganizationMemberships("user_1")).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("creates an organization through the Organizations API and returns its id", async () => {
    const auth = createWorkosAuth(workos.config());
    const before = workos.requests.length;

    const created = await auth.createOrganization("Personal — ada@example.com");

    expect(created.orgName).toBe("Personal — ada@example.com");
    expect(created.orgId).toMatch(/^org_/);
    // Not /user_management/organizations: organizations are a top-level API.
    expect(workos.requests[before]?.path).toBe("/organizations");
    expect(workos.requests[before]?.authorization).toBe(`Bearer ${workos.apiKey}`);
  });

  it("creates a membership that the listing then returns", async () => {
    const auth = createWorkosAuth(workos.config());
    const user = workos.addUser({});
    const org = await auth.createOrganization("Fresh Workspace");

    await auth.createOrganizationMembership(org.orgId, user.id);

    await expect(auth.listUserOrganizationMemberships(user.id)).resolves.toEqual([
      { orgId: org.orgId, orgName: "Fresh Workspace" },
    ]);
  });

  // The conflict the provisioning race hinges on: WorkOS refuses a duplicate
  // rather than absorbing it, so the caller must be able to see the refusal.
  it("throws a WorkosApiError when the membership already exists", async () => {
    const auth = createWorkosAuth(workos.config());
    const user = workos.addUser({});
    const org = await auth.createOrganization("Duplicate Test");
    await auth.createOrganizationMembership(org.orgId, user.id);

    await expect(auth.createOrganizationMembership(org.orgId, user.id)).rejects.toMatchObject({
      name: "IdentityProviderError",
      status: 409,
    });
  });
});

describe("getUser", () => {
  it("sends the API key and maps the WorkOS user to our shape", async () => {
    const user = workos.addUser({
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      profile_picture_url: "https://cdn.example.com/ada.png",
    });
    const auth = createWorkosAuth(workos.config());
    const before = workos.requests.length;

    await expect(auth.getUser(user.id)).resolves.toEqual({
      id: user.id,
      email: "ada@example.com",
      name: "Ada Lovelace",
      avatarUrl: "https://cdn.example.com/ada.png",
    });
    expect(workos.requests[before]?.authorization).toBe(`Bearer ${workos.apiKey}`);
  });

  it("omits name and avatar when WorkOS has neither", async () => {
    const user = workos.addUser({ email: "nameless@example.com" });
    const auth = createWorkosAuth(workos.config());
    await expect(auth.getUser(user.id)).resolves.toEqual({
      id: user.id,
      email: "nameless@example.com",
    });
  });

  it("builds a name from whichever name parts exist", async () => {
    const user = workos.addUser({ email: "grace@example.com", first_name: "Grace" });
    const auth = createWorkosAuth(workos.config());
    await expect(auth.getUser(user.id)).resolves.toMatchObject({ name: "Grace" });
  });

  it("throws when WorkOS returns an error status", async () => {
    const auth = createWorkosAuth(workos.config());
    await expect(auth.getUser("user_does_not_exist")).rejects.toThrow();
  });
});

/** The server's bound port, once it is actually listening. */
function boundPort(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("failed to bind"));
      return resolve(address.port);
    }
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("failed to bind"));
      resolve(address.port);
    });
    server.once("error", reject);
  });
}

describe("request deadlines", () => {
  // A connection that is accepted and then stalls must fail the one call at
  // the per-attempt deadline as a retryable provider fault (504) — never a
  // refusal of whatever credential it carried, and never a hang that pins
  // the request behind it.
  it("aborts a hung provider call at the deadline as a 504 provider fault", async () => {
    const { serve } = await import("@hono/node-server");
    const { Hono } = await import("hono");
    const app = new Hono();
    // Accept and never answer.
    app.all("*", () => new Promise<Response>(() => {}));
    const server = serve({ fetch: app.fetch, port: 0 });
    try {
      const port = await boundPort(server as unknown as import("node:http").Server);
      const auth = createWorkosAuth(
        workos.config({
          workosApiUrl: `http://127.0.0.1:${port}`,
          workosRequestTimeoutMs: 200,
        }),
      );

      const caught = await auth.getUser("user_1").catch((error: unknown) => error);
      expect(caught).toMatchObject({ name: "IdentityProviderError", status: 504 });
      // The message must name only the path — no request fields, which on
      // credential routes include the secret.
      expect((caught as Error).message).toBe("WorkOS /user_management/users/user_1 timed out");
    } finally {
      server.close();
    }
  });

  // The grant deadline is the timeout-regression fix's backbone: a grant that
  // outlives the cheap-call deadline must NOT be aborted, because aborting a
  // call that spends a single-use credential turns a slow success into a
  // reported failure for a user who is actually signed in.
  it("gives grant calls the longer grant deadline, not the request one", async () => {
    const { WORKOS_GRANT_TIMEOUT_MS, WORKOS_REQUEST_TIMEOUT_MS } = await import("./workos");
    expect(WORKOS_GRANT_TIMEOUT_MS).toBeGreaterThan(WORKOS_REQUEST_TIMEOUT_MS);

    const { serve } = await import("@hono/node-server");
    const { Hono } = await import("hono");
    const app = new Hono();
    // The grant answers AFTER the (tiny) request deadline but inside the
    // grant one — a slow-but-successful provider.
    app.post("/user_management/authenticate", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const body = (await c.req.json()) as Record<string, unknown>;
      // Ride the real fake for token minting: answer through it.
      const upstream = await fetch(`${workos.origin}/user_management/authenticate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return c.json((await upstream.json()) as object, upstream.status as 200);
    });
    const server = serve({ fetch: app.fetch, port: 0 });
    try {
      const port = await boundPort(server as unknown as import("node:http").Server);
      const auth = createWorkosAuth(
        workos.config({
          workosApiUrl: `http://127.0.0.1:${port}`,
          // A request deadline the slow grant clearly exceeds…
          workosRequestTimeoutMs: 100,
          // …and a grant deadline it comfortably fits inside.
          workosGrantTimeoutMs: 5_000,
        }),
      );

      workos.addUser({ email: "slow-grant@example.com" });
      // Mint a live magic auth directly against the real fake.
      await fetch(`${workos.origin}/user_management/magic_auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "slow-grant@example.com" }),
      });
      const live = workos.currentMagicAuth("slow-grant@example.com");
      if (!live) throw new Error("no live magic auth");

      const tokens = await auth.authenticateWithOtp({
        email: "slow-grant@example.com",
        code: live.code,
      });
      expect(tokens.user.email).toBe("slow-grant@example.com");
    } finally {
      server.close();
    }
  });

  it("still aborts a grant call that exceeds the grant deadline", async () => {
    const { serve } = await import("@hono/node-server");
    const { Hono } = await import("hono");
    const app = new Hono();
    app.all("*", () => new Promise<Response>(() => {}));
    const server = serve({ fetch: app.fetch, port: 0 });
    try {
      const port = await boundPort(server as unknown as import("node:http").Server);
      const auth = createWorkosAuth(
        workos.config({
          workosApiUrl: `http://127.0.0.1:${port}`,
          workosRequestTimeoutMs: 50,
          workosGrantTimeoutMs: 200,
        }),
      );
      const caught = await auth
        .authenticateWithOtp({ email: "hang@example.com", code: "123456" })
        .catch((error: unknown) => error);
      expect(caught).toMatchObject({ name: "IdentityProviderError", status: 504 });
      expect((caught as Error).message).toBe("WorkOS /user_management/authenticate timed out");
    } finally {
      server.close();
    }
  });
});

describe("refreshTokens classification", () => {
  /** A stand-in that answers the refresh grant with a fixed response. */
  async function refreshAgainst(status: number, body: unknown) {
    const { serve } = await import("@hono/node-server");
    const { Hono } = await import("hono");
    const app = new Hono();
    app.post("/user_management/authenticate", (c) => c.json(body as object, status as 400));
    const server = serve({ fetch: app.fetch, port: 0 });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to bind");
      const auth = createWorkosAuth(
        workos.config({ workosApiUrl: `http://127.0.0.1:${address.port}` }),
      );
      return await auth.refreshTokens({ refreshToken: "rt_test" }).catch((error: unknown) => error);
    } finally {
      server.close();
    }
  }

  // Only the allowlisted OAuth refusal is terminal: HTTP 400 invalid_grant.
  it("classifies 400 invalid_grant as a terminal refusal", async () => {
    const caught = await refreshAgainst(400, {
      error: "invalid_grant",
      error_description: "Refresh token is invalid or spent",
    });
    expect(caught).toMatchObject({ name: "RefreshRejectedError" });
  });

  // 408, 429, other 4xx shapes, and 5xx say nothing about the token: they
  // must surface as provider faults, never clear a stored session.
  it.each([
    [408, { message: "timeout" }],
    [429, { message: "slow down" }],
    [400, { error: "invalid_request", error_description: "malformed" }],
    [403, { message: "forbidden" }],
    [502, { message: "bad gateway" }],
  ])("keeps %i (non-invalid_grant) a retryable provider fault", async (status, body) => {
    const caught = await refreshAgainst(status, body);
    expect(caught).toMatchObject({ name: "IdentityProviderError", status });
  });
});

describe("grant failure classification", () => {
  // The verification challenge flow was removed; the classified reason
  // survives so the route can answer a terse dead-end instead of a 502.
  it("classifies email_verification_required off the Magic Auth grant", () => {
    expect(classifyMagicAuthFailure({ code: "email_verification_required" })).toBe(
      "email_verification_required",
    );
  });

  it("classifies it off the authorization-code grant too", () => {
    expect(classifyAuthorizationCodeFailure({ code: "email_verification_required" })).toBe(
      "email_verification_required",
    );
  });

  it("yields undefined for an unrecognised refusal body", () => {
    expect(classifyMagicAuthFailure({ code: "something_new" })).toBeUndefined();
  });
});
