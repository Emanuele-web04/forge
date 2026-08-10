import { randomUUID } from "node:crypto";
import {
  type AccountErrorBody,
  DeviceAuthorizationResponse,
  InstanceInfo,
  OrganizationRequiredBody,
} from "@synara/contracts";
import { Schema } from "effect";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "../config";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { clearOrgCache } from "../orgProvisioning";
import { FAKE_DEVICE_AUTHORIZATION, startFakeWorkos, type FakeWorkos } from "../testing/fakeWorkos";
import { createWorkosAuth } from "../workos";
import { createV1Routes, DEVICE_RATE_LIMIT_PER_MINUTE, PASSWORD_RATE_LIMIT_PER_MINUTE } from "./v1";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function registerHostBody(environmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    environmentId,
    name: "Dylan's Mac",
    platform: "darwin" as const,
    kind: "local" as const,
    endpoints: [{ url: "http://192.168.1.5:4830", transport: "lan" as const }],
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)("createV1Routes", () => {
  const databaseUrl = TEST_DATABASE_URL as string;
  let pool: Awaited<ReturnType<typeof createDb>>["pool"];
  let workos: FakeWorkos;
  let config: ApiConfig;

  /**
   * A signed-in user acting inside their own organization — the state the CLI
   * reaches after the 403/refresh dance, and what every host route requires.
   */
  async function signIn(): Promise<{
    token: string;
    userId: string;
    orgId: string;
    orgName: string;
  }> {
    const user = workos.addUser({ first_name: "Test", last_name: "User" });
    const organization = workos.addOrganization({ name: `Workspace ${user.id}` });
    workos.addMembership(organization.id, user.id);
    const token = await workos.signAccessToken({
      sub: user.id,
      sid: `session_${randomUUID()}`,
      orgId: organization.id,
    });
    return { token, userId: user.id, orgId: organization.id, orgName: organization.name };
  }

  /**
   * A user with a token that names no organization — exactly what the WorkOS
   * device grant hands back, before the client refreshes into a workspace.
   */
  async function signInWithoutOrg(): Promise<{ token: string; userId: string }> {
    const user = workos.addUser({ first_name: "Orgless", last_name: "User" });
    const token = await workos.signAccessToken({ sub: user.id, sid: `session_${randomUUID()}` });
    return { token, userId: user.id };
  }

  function buildApp() {
    const { db } = createDb(databaseUrl);
    const auth = createWorkosAuth(config);
    const app = new Hono();
    app.route("/api/v1", createV1Routes({ auth, db, config }));
    return { app, db };
  }

  beforeAll(async () => {
    await runMigrations(databaseUrl);
    workos = await startFakeWorkos();
    config = workos.config({ databaseUrl });
    pool = createDb(databaseUrl).pool;
  });

  afterAll(async () => {
    await pool.end();
    await workos.close();
  });

  // The membership cache is process-global and outlives a single request, so a
  // test that changes someone's memberships would otherwise leak into the next.
  beforeEach(() => {
    clearOrgCache();
  });

  it("rejects unauthenticated requests to /me and /hosts", async () => {
    const { app } = buildApp();

    const meRes = await app.request("/api/v1/me");
    expect(meRes.status).toBe(401);
    expect(await meRes.json()).toMatchObject({ error: "unauthorized" });

    const hostsRes = await app.request("/api/v1/hosts");
    expect(hostsRes.status).toBe(401);
  });

  it("rejects an expired access token", async () => {
    const { app } = buildApp();
    const user = workos.addUser({});
    const token = await workos.signAccessToken({
      sub: user.id,
      sid: `session_${randomUUID()}`,
      expiresIn: "-1s",
    });

    const res = await app.request("/api/v1/hosts", { headers: authHeaders(token) });
    expect(res.status).toBe(401);
  });

  it("returns the WorkOS profile and active organization from /me", async () => {
    const { app } = buildApp();
    const user = workos.addUser({
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      profile_picture_url: "https://cdn.example.com/ada.png",
    });
    const organization = workos.addOrganization({ name: "Analytical Engines" });
    workos.addMembership(organization.id, user.id);
    const token = await workos.signAccessToken({
      sub: user.id,
      sid: `session_${randomUUID()}`,
      orgId: organization.id,
    });

    const res = await app.request("/api/v1/me", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: user.id,
      name: "Ada Lovelace",
      email: "ada@example.com",
      image: "https://cdn.example.com/ada.png",
      organization: { id: organization.id, name: "Analytical Engines" },
      profile: null,
    });
  });

  // A live token whose user WorkOS will not describe must still answer inside
  // the error contract, not escape as a plain-text 500.
  it("returns 401 in the error contract when the account no longer exists", async () => {
    const { app } = buildApp();
    // Never registered with the fake, so the lookup 404s.
    const token = await workos.signAccessToken({
      sub: "user_deleted_mid_session",
      sid: `session_${randomUUID()}`,
    });

    const res = await app.request("/api/v1/me", { headers: authHeaders(token) });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as AccountErrorBody;
    expect(body.error).toBe("unauthorized");
    expect(typeof body.message).toBe("string");
  });

  // The 502 body says nothing on purpose, so the log is the only place an
  // operator can tell a rejected API key from an outage. Asserted so it cannot
  // be dropped silently later.
  it("returns 502 in the error contract and logs when the identity provider fails", async () => {
    const { db } = buildApp();
    // Point at a closed port so the user lookup fails as a transport error
    // rather than a 404 — the upstream-fault branch, not the deleted-user one.
    // Issuer and JWKS stay pinned at the live fake so token verification still
    // succeeds; otherwise discovery would fail first and answer 401.
    const brokenConfig: ApiConfig = {
      ...config,
      workosApiUrl: "http://127.0.0.1:1",
      workosIssuer: workos.issuer,
      workosJwksUrl: `${workos.origin}/sso/jwks/${workos.clientId}`,
    };
    const app = new Hono();
    app.route(
      "/api/v1",
      createV1Routes({ auth: createWorkosAuth(brokenConfig), db, config: brokenConfig }),
    );

    const user = workos.addUser({});
    const token = await workos.signAccessToken({
      sub: user.id,
      sid: `session_${randomUUID()}`,
    });

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request("/api/v1/me", { headers: authHeaders(token) });
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ error: "internal_error" });
      expect(logged).toHaveBeenCalledWith(
        "[api] organization resolution failed:",
        expect.anything(),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("registers a host and lists it back", async () => {
    const { app } = buildApp();
    const { token } = await signIn();
    const environmentId = randomUUID();

    const registerRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(registerHostBody(environmentId)),
    });
    expect(registerRes.status).toBe(201);
    const registerBody = (await registerRes.json()) as {
      host: { id: string; environmentId: string };
      hostToken: string;
    };
    expect(registerBody.host.environmentId).toBe(environmentId);
    expect(registerBody.hostToken).toMatch(/^synhost_/);

    const listRes = await app.request("/api/v1/hosts", { headers: authHeaders(token) });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { hosts: Array<{ id: string }> };
    expect(listBody.hosts).toHaveLength(1);
    expect(listBody.hosts[0]?.id).toBe(registerBody.host.id);
  });

  it("rotates the host token when the same environment re-registers", async () => {
    const { app } = buildApp();
    const { token } = await signIn();
    const environmentId = randomUUID();

    const firstRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(registerHostBody(environmentId)),
    });
    const firstBody = (await firstRes.json()) as { host: { id: string }; hostToken: string };

    const secondRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(registerHostBody(environmentId, { name: "Renamed Mac" })),
    });
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as {
      host: { id: string; name: string };
      hostToken: string;
    };
    expect(secondBody.host.id).toBe(firstBody.host.id);
    expect(secondBody.host.name).toBe("Renamed Mac");
    expect(secondBody.hostToken).not.toBe(firstBody.hostToken);

    // Old host token is revoked.
    const oldTokenPatch = await app.request(`/api/v1/hosts/${firstBody.host.id}`, {
      method: "PATCH",
      headers: authHeaders(firstBody.hostToken),
      body: JSON.stringify({ name: "Should not apply" }),
    });
    expect(oldTokenPatch.status).toBe(403);
    expect(await oldTokenPatch.json()).toMatchObject({ error: "token_revoked" });

    // New host token works.
    const newTokenPatch = await app.request(`/api/v1/hosts/${firstBody.host.id}`, {
      method: "PATCH",
      headers: authHeaders(secondBody.hostToken),
      body: JSON.stringify({ name: "Via new token" }),
    });
    expect(newTokenPatch.status).toBe(200);
    const newTokenPatchBody = (await newTokenPatch.json()) as { host: { name: string } };
    expect(newTokenPatchBody.host.name).toBe("Via new token");
  });

  it("updates endpoints and bumps lastSeenAt via PATCH with the host token", async () => {
    const { app } = buildApp();
    const { token } = await signIn();
    const environmentId = randomUUID();

    const registerRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(registerHostBody(environmentId)),
    });
    const registerBody = (await registerRes.json()) as {
      host: { id: string; lastSeenAt: string };
      hostToken: string;
    };

    await new Promise((resolve) => setTimeout(resolve, 10));

    const newEndpoints = [{ url: "https://example.tailnet.ts.net:4830", transport: "tailscale" }];
    const patchRes = await app.request(`/api/v1/hosts/${registerBody.host.id}`, {
      method: "PATCH",
      headers: authHeaders(registerBody.hostToken),
      body: JSON.stringify({ endpoints: newEndpoints }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      host: { endpoints: Array<{ url: string }>; lastSeenAt: string };
    };
    expect(patchBody.host.endpoints).toEqual(newEndpoints);
    expect(new Date(patchBody.host.lastSeenAt).getTime()).toBeGreaterThan(
      new Date(registerBody.host.lastSeenAt).getTime(),
    );
  });

  it("rejects PATCH with another host's token", async () => {
    const { app } = buildApp();
    const { token } = await signIn();

    const hostARes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(registerHostBody(randomUUID())),
    });
    const hostA = (await hostARes.json()) as { host: { id: string }; hostToken: string };

    const hostBRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(registerHostBody(randomUUID())),
    });
    const hostB = (await hostBRes.json()) as { host: { id: string }; hostToken: string };

    const crossPatch = await app.request(`/api/v1/hosts/${hostA.host.id}`, {
      method: "PATCH",
      headers: authHeaders(hostB.hostToken),
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(crossPatch.status).toBe(401);
    expect(await crossPatch.json()).toMatchObject({ error: "unauthorized" });
  });

  it("isolates hosts across organizations: list is empty and delete 404s", async () => {
    const { app } = buildApp();
    const ownerToken = (await signIn()).token;
    const otherToken = (await signIn()).token;

    const registerRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify(registerHostBody(randomUUID())),
    });
    const registerBody = (await registerRes.json()) as { host: { id: string } };

    const otherList = await app.request("/api/v1/hosts", { headers: authHeaders(otherToken) });
    const otherListBody = (await otherList.json()) as { hosts: unknown[] };
    expect(otherListBody.hosts).toHaveLength(0);

    const otherDelete = await app.request(`/api/v1/hosts/${registerBody.host.id}`, {
      method: "DELETE",
      headers: authHeaders(otherToken),
    });
    expect(otherDelete.status).toBe(404);
    expect(await otherDelete.json()).toMatchObject({ error: "host_not_found" });

    // The owner still has it: the delete was refused, not silently applied.
    const ownerList = await app.request("/api/v1/hosts", { headers: authHeaders(ownerToken) });
    expect(((await ownerList.json()) as { hosts: unknown[] }).hosts).toHaveLength(1);
  });

  // Two members of one organization share its hosts. This is the whole point
  // of keying on the org: adding a teammate is a membership, not a migration.
  it("shares hosts between two members of the same organization", async () => {
    const { app } = buildApp();
    const owner = await signIn();
    const teammate = workos.addUser({ first_name: "Team", last_name: "Mate" });
    workos.addMembership(owner.orgId, teammate.id);
    const teammateToken = await workos.signAccessToken({
      sub: teammate.id,
      sid: `session_${randomUUID()}`,
      orgId: owner.orgId,
    });

    const registerRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(owner.token),
      body: JSON.stringify(registerHostBody(randomUUID())),
    });
    const registered = (await registerRes.json()) as { host: { id: string } };

    const teammateList = await app.request("/api/v1/hosts", {
      headers: authHeaders(teammateToken),
    });
    const listBody = (await teammateList.json()) as { hosts: Array<{ id: string }> };
    expect(listBody.hosts.map((h) => h.id)).toContain(registered.host.id);
  });

  // The unique index moved from (user, environment) to (org, environment).
  // One machine linked from two workspaces is now an ordinary thing to do.
  it("lets two organizations register the same environment id", async () => {
    const { app } = buildApp();
    const first = await signIn();
    const second = await signIn();
    const environmentId = randomUUID();

    const firstRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(first.token),
      body: JSON.stringify(registerHostBody(environmentId)),
    });
    expect(firstRes.status).toBe(201);

    const secondRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(second.token),
      body: JSON.stringify(registerHostBody(environmentId)),
    });
    expect(secondRes.status).toBe(201);

    const firstBody = (await firstRes.json()) as { host: { id: string } };
    const secondBody = (await secondRes.json()) as { host: { id: string } };
    expect(secondBody.host.id).not.toBe(firstBody.host.id);
  });

  it("stamps the registering user on the host without granting them access", async () => {
    const { app } = buildApp();
    const owner = await signIn();

    const registerRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(owner.token),
      body: JSON.stringify(registerHostBody(randomUUID())),
    });
    const body = (await registerRes.json()) as { host: { registeredByUserId: string } };
    expect(body.host.registeredByUserId).toBe(owner.userId);

    // Same user, a different organization: the audit stamp is not a key, so
    // the host they registered is out of reach from anywhere else.
    const elsewhere = workos.addOrganization({ name: "Elsewhere" });
    workos.addMembership(elsewhere.id, owner.userId);
    clearOrgCache();
    const elsewhereToken = await workos.signAccessToken({
      sub: owner.userId,
      sid: `session_${randomUUID()}`,
      orgId: elsewhere.id,
    });

    const list = await app.request("/api/v1/hosts", { headers: authHeaders(elsewhereToken) });
    expect(((await list.json()) as { hosts: unknown[] }).hosts).toHaveLength(0);
  });

  it("deletes a host and its token with the device token", async () => {
    const { app } = buildApp();
    const { token } = await signIn();

    const registerRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(registerHostBody(randomUUID())),
    });
    const registerBody = (await registerRes.json()) as {
      host: { id: string };
      hostToken: string;
    };

    const deleteRes = await app.request(`/api/v1/hosts/${registerBody.host.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(deleteRes.status).toBe(204);

    const listRes = await app.request("/api/v1/hosts", { headers: authHeaders(token) });
    const listBody = (await listRes.json()) as { hosts: unknown[] };
    expect(listBody.hosts).toHaveLength(0);

    // The cascaded host token no longer authorizes anything.
    const patchAfterDelete = await app.request(`/api/v1/hosts/${registerBody.host.id}`, {
      method: "PATCH",
      headers: authHeaders(registerBody.hostToken),
      body: JSON.stringify({ name: "Ghost" }),
    });
    expect(patchAfterDelete.status).toBe(401);
  });

  it("allows a host to delete itself with its own host token", async () => {
    const { app } = buildApp();
    const { token } = await signIn();

    const registerRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(registerHostBody(randomUUID())),
    });
    const registerBody = (await registerRes.json()) as {
      host: { id: string };
      hostToken: string;
    };

    const deleteRes = await app.request(`/api/v1/hosts/${registerBody.host.id}`, {
      method: "DELETE",
      headers: authHeaders(registerBody.hostToken),
    });
    expect(deleteRes.status).toBe(204);
  });

  describe("password authentication", () => {
    const PASSWORD = "correct-horse-battery-staple";

    function passwordHeaders(): Record<string, string> {
      return { "content-type": "application/json" };
    }

    async function signInRequest(app: Hono, body: unknown, path = "/api/v1/auth/password/sign-in") {
      return app.request(path, {
        method: "POST",
        headers: passwordHeaders(),
        body: JSON.stringify(body),
      });
    }

    it("signs in with a correct password and returns a usable token pair", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      const user = workos.addPasswordUser({ email, password: PASSWORD });

      const res = await signInRequest(app, { email, password: PASSWORD });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accessToken: string; user: { id: string } };
      expect(body.user.id).toBe(user.id);
      expect(typeof body.accessToken).toBe("string");

      // The token is real: it reaches an authenticated route, which is what
      // makes this a sign-in rather than a well-shaped JSON response.
      const organization = workos.addOrganization({ name: "Analytical Engines" });
      workos.addMembership(organization.id, user.id);
      clearOrgCache();
      const scoped = await workos.signAccessToken({
        sub: user.id,
        sid: `session_${randomUUID()}`,
        orgId: organization.id,
      });
      const meRes = await app.request("/api/v1/me", { headers: authHeaders(scoped) });
      expect(meRes.status).toBe(200);
    });

    it("answers 401 invalid_credentials for a wrong password", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      workos.addPasswordUser({ email, password: PASSWORD });

      const res = await signInRequest(app, { email, password: "not-the-password" });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "invalid_credentials" });
    });

    // Same answer as a wrong password: telling them apart would let anyone
    // enumerate which email addresses have accounts.
    it("answers the same 401 for an unknown email as for a wrong password", async () => {
      const { app } = buildApp();
      const res = await signInRequest(app, {
        email: `nobody-${randomUUID()}@example.com`,
        password: PASSWORD,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "invalid_credentials" });
    });

    it("signs up, creating the user and returning a session", async () => {
      const { app } = buildApp();
      const email = `new-${randomUUID()}@example.com`;

      const res = await signInRequest(
        app,
        { email, password: PASSWORD },
        "/api/v1/auth/password/sign-up",
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { accessToken: string; user: { email: string } };
      expect(body.user.email).toBe(email);
      expect(typeof body.accessToken).toBe("string");

      // The account is real afterwards: the same credentials sign in again.
      const again = await signInRequest(app, { email, password: PASSWORD });
      expect(again.status).toBe(200);
    });

    it("answers 409 email_taken when the address is already registered", async () => {
      const { app } = buildApp();
      const email = `dup-${randomUUID()}@example.com`;
      workos.addPasswordUser({ email, password: PASSWORD });

      const res = await signInRequest(
        app,
        { email, password: PASSWORD },
        "/api/v1/auth/password/sign-up",
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "email_taken" });
    });

    it.each([
      ["a missing password", { email: "ada@example.com" }],
      ["a missing email", { password: PASSWORD }],
      ["an empty password", { email: "ada@example.com", password: "" }],
    ])("answers 400 validation_failed for %s", async (_label, body) => {
      const { app } = buildApp();
      const res = await signInRequest(app, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_failed" });
    });

    // The whole point of the amendment's "never log or store passwords" rule.
    // Asserted rather than trusted, because the natural implementations of
    // both paths (a schema decoder's message, an upstream error body) quote
    // the offending value.
    it("never emits the password in a response body or a log line", async () => {
      const { app } = buildApp();
      const secret = `pw-${randomUUID()}`;
      const email = `ada-${randomUUID()}@example.com`;
      workos.addPasswordUser({ email, password: PASSWORD });

      const logged: string[] = [];
      const capture = (...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(capture);
      const logSpy = vi.spyOn(console, "log").mockImplementation(capture);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(capture);
      try {
        // A wrong password, a malformed body, and a sign-up conflict: the
        // three paths that produce an error mentioning the request.
        const wrong = await signInRequest(app, { email, password: secret });
        const malformed = await signInRequest(app, { email, password: { nested: secret } });
        const conflict = await signInRequest(
          app,
          { email, password: secret },
          "/api/v1/auth/password/sign-up",
        );

        for (const res of [wrong, malformed, conflict]) {
          expect(await res.text()).not.toContain(secret);
        }
        expect(logged.join("\n")).not.toContain(secret);
      } finally {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("rate limits password attempts well below the device limit", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      workos.addPasswordUser({ email, password: PASSWORD });
      const headers = { ...passwordHeaders(), "x-forwarded-for": "203.0.113.9" };

      const attempt = () =>
        app.request("/api/v1/auth/password/sign-in", {
          method: "POST",
          headers,
          body: JSON.stringify({ email, password: "wrong" }),
        });

      for (let i = 0; i < PASSWORD_RATE_LIMIT_PER_MINUTE; i += 1) {
        expect((await attempt()).status).toBe(401);
      }
      const limited = await attempt();
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });

      // A different client is unaffected, and the device budget is separate.
      const other = await app.request("/api/v1/auth/password/sign-in", {
        method: "POST",
        headers: { ...passwordHeaders(), "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      expect(other.status).toBe(200);
    });

    it("surfaces email verification as 403 email_verification_required", async () => {
      const verifying = await startFakeWorkos({ requireEmailVerification: true });
      try {
        const { db } = buildApp();
        const verifyingConfig = verifying.config({ databaseUrl });
        const app = new Hono();
        app.route(
          "/api/v1",
          createV1Routes({
            auth: createWorkosAuth(verifyingConfig),
            db,
            config: verifyingConfig,
          }),
        );

        const res = await app.request("/api/v1/auth/password/sign-up", {
          method: "POST",
          headers: passwordHeaders(),
          body: JSON.stringify({
            email: `unverified-${randomUUID()}@example.com`,
            password: PASSWORD,
          }),
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: "email_verification_required" });
      } finally {
        await verifying.close();
      }
    });
  });

  describe("profile", () => {
    function profileBody(overrides: Record<string, unknown> = {}) {
      return {
        handle: `user-${randomUUID().slice(0, 8)}`,
        displayName: "Ada Lovelace",
        avatarColor: "#22c55e",
        ...overrides,
      };
    }

    it("creates a profile and reports it from /me", async () => {
      const { app } = buildApp();
      const { token } = await signIn();
      const body = profileBody();

      const putRes = await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });
      expect(putRes.status).toBe(200);
      expect(await putRes.json()).toMatchObject({ profile: body });

      const meRes = await app.request("/api/v1/me", { headers: authHeaders(token) });
      expect(await meRes.json()).toMatchObject({ profile: body });
    });

    it("updates the display name and avatar color of an existing profile", async () => {
      const { app } = buildApp();
      const { token } = await signIn();
      const created = profileBody();

      await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(created),
      });

      const res = await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ ...created, displayName: "Ada L.", avatarColor: "#3b82f6" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        profile: { handle: created.handle, displayName: "Ada L.", avatarColor: "#3b82f6" },
      });
    });

    // The handle is the closest thing to a public identifier a user has, and
    // V1 has no redirect story for a rename — so a change is refused loudly
    // rather than silently ignored.
    it("refuses to change the handle once it is set", async () => {
      const { app } = buildApp();
      const { token } = await signIn();
      const created = profileBody();

      await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(created),
      });

      const res = await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ ...created, handle: `${created.handle}x` }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_failed" });
    });

    it("answers 409 handle_taken when another user holds the handle", async () => {
      const { app } = buildApp();
      const first = await signIn();
      const second = await signIn();
      const body = profileBody();

      const firstRes = await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(first.token),
        body: JSON.stringify(body),
      });
      expect(firstRes.status).toBe(200);

      const res = await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(second.token),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "handle_taken" });
    });

    it.each([
      ["uppercase", "Ada"],
      ["trailing hyphen", "ada-"],
      ["leading hyphen", "-ada"],
      ["too short", "ad"],
      ["illegal character", "ada_lovelace"],
    ])("rejects a handle with a %s", async (_label, handle) => {
      const { app } = buildApp();
      const { token } = await signIn();

      const res = await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(profileBody({ handle })),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_failed" });
    });

    it("rejects an avatar color that is not a hex triplet", async () => {
      const { app } = buildApp();
      const { token } = await signIn();

      const res = await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(profileBody({ avatarColor: "emerald" })),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_failed" });
    });

    it("requires authentication", async () => {
      const { app } = buildApp();
      const res = await app.request("/api/v1/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profileBody()),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("organization rename", () => {
    it("renames the workspace and reports the new name", async () => {
      const { app } = buildApp();
      const { token, orgId } = await signIn();

      const res = await app.request("/api/v1/organization", {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Analytical Engines" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        organization: { id: orgId, name: "Analytical Engines" },
      });

      const meRes = await app.request("/api/v1/me", { headers: authHeaders(token) });
      expect(await meRes.json()).toMatchObject({
        organization: { id: orgId, name: "Analytical Engines" },
      });
    });

    it("rejects an empty name", async () => {
      const { app } = buildApp();
      const { token } = await signIn();

      const res = await app.request("/api/v1/organization", {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "   " }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_failed" });
    });

    // Membership, not knowledge of the id, is what authorizes the rename.
    it("refuses a caller whose token names an organization they have left", async () => {
      const { app } = buildApp();
      const { token, userId, orgId } = await signIn();
      workos.removeMembership(orgId, userId);
      clearOrgCache();

      const res = await app.request("/api/v1/organization", {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Not Mine" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("organization gate", () => {
    /**
     * The first call after `synara auth`: the device grant mints an org-less
     * token, so the caller is authenticated but has nowhere to act. Answering
     * 403 with the list is what lets the client refresh into a workspace
     * rather than dead-end.
     */
    it("answers 403 organization_required for a token with no org, provisioning one lazily", async () => {
      const { app } = buildApp();
      const { token, userId } = await signInWithoutOrg();

      const res = await app.request("/api/v1/hosts", { headers: authHeaders(token) });

      expect(res.status).toBe(403);
      const body = Schema.decodeUnknownSync(OrganizationRequiredBody)(await res.json());
      expect(body.error).toBe("organization_required");
      // Lazily provisioned: this user was in no organization a moment ago.
      expect(body.organizations).toHaveLength(1);
      expect(body.organizations[0]?.name).toContain("@example.com");

      // And it is a real WorkOS organization the user is now a member of, not
      // a value invented for the response.
      const auth = createWorkosAuth(config);
      await expect(auth.listUserOrganizationMemberships(userId)).resolves.toEqual([
        { orgId: body.organizations[0]?.id, orgName: body.organizations[0]?.name },
      ]);
    });

    it("provisions only once across repeated org-less calls", async () => {
      const { app } = buildApp();
      const { token, userId } = await signInWithoutOrg();

      const first = await app.request("/api/v1/hosts", { headers: authHeaders(token) });
      const firstBody = (await first.json()) as { organizations: Array<{ id: string }> };
      clearOrgCache();
      const second = await app.request("/api/v1/hosts", { headers: authHeaders(token) });
      const secondBody = (await second.json()) as { organizations: Array<{ id: string }> };

      expect(secondBody.organizations).toEqual(firstBody.organizations);
      const auth = createWorkosAuth(config);
      await expect(auth.listUserOrganizationMemberships(userId)).resolves.toHaveLength(1);
    });

    // Revoked membership. Verification is stateless, so the old token still
    // has a valid signature and a real org_id — only the membership check
    // stops it, which is what makes removal take effect at all.
    it("answers 403 for a token naming an organization the caller has left", async () => {
      const { app } = buildApp();
      const owner = await signIn();

      const beforeRemoval = await app.request("/api/v1/hosts", {
        headers: authHeaders(owner.token),
      });
      expect(beforeRemoval.status).toBe(200);

      workos.removeMembership(owner.orgId, owner.userId);
      workos.addMembership(workos.addOrganization({ name: "Somewhere Else" }).id, owner.userId);
      clearOrgCache();

      const res = await app.request("/api/v1/hosts", { headers: authHeaders(owner.token) });
      expect(res.status).toBe(403);
      const body = Schema.decodeUnknownSync(OrganizationRequiredBody)(await res.json());
      // The list is the caller's *current* memberships, not the dead one.
      expect(body.organizations.map((org) => org.id)).toEqual([
        expect.not.stringMatching(owner.orgId),
      ]);
      expect(body.organizations.map((org) => org.name)).toEqual(["Somewhere Else"]);
    });

    // A stale org id must not reach data, not merely be reported on. Asserted
    // separately because the 403 above says nothing about the query.
    it("does not expose another organization's hosts to a stale token", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      await app.request("/api/v1/hosts", {
        method: "POST",
        headers: authHeaders(owner.token),
        body: JSON.stringify(registerHostBody(randomUUID())),
      });

      const intruder = workos.addUser({});
      // Never a member, but names the org anyway — a forged or leaked claim.
      workos.addMembership(workos.addOrganization({ name: "Intruder Co" }).id, intruder.id);
      clearOrgCache();
      const intruderToken = await workos.signAccessToken({
        sub: intruder.id,
        sid: `session_${randomUUID()}`,
        orgId: owner.orgId,
      });

      const res = await app.request("/api/v1/hosts", { headers: authHeaders(intruderToken) });
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain(owner.orgId);
    });

    it("gates every device-token route, not just listing", async () => {
      const { app } = buildApp();
      const { token } = await signInWithoutOrg();

      const me = await app.request("/api/v1/me", { headers: authHeaders(token) });
      expect(me.status).toBe(403);

      const register = await app.request("/api/v1/hosts", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(registerHostBody(randomUUID())),
      });
      expect(register.status).toBe(403);

      const remove = await app.request(`/api/v1/hosts/${randomUUID()}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      expect(remove.status).toBe(403);
    });

    // An unauthenticated caller has no organizations to be told about; the
    // 403 path must not become a way to skip the 401.
    it("still answers 401 before any organization work when the token is absent or bad", async () => {
      const { app } = buildApp();

      expect((await app.request("/api/v1/hosts")).status).toBe(401);
      expect(
        (await app.request("/api/v1/hosts", { headers: authHeaders("not-a-jwt") })).status,
      ).toBe(401);
    });
  });

  it("reports instance info without authentication", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/instance");
    expect(res.status).toBe(200);
    const body = Schema.decodeUnknownSync(InstanceInfo)(await res.json());
    expect(body).toEqual({
      version: expect.any(String),
      authMode: "workos",
      clientId: workos.clientId,
      workosApiUrl: workos.origin,
    });
  });

  describe("POST /auth/device", () => {
    it("passes the WorkOS device authorization through without the API key", async () => {
      const { app } = buildApp();

      const res = await app.request("/api/v1/auth/device", { method: "POST" });
      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = Schema.decodeUnknownSync(DeviceAuthorizationResponse)(JSON.parse(raw));
      expect(body).toEqual({
        deviceCode: FAKE_DEVICE_AUTHORIZATION.device_code,
        userCode: FAKE_DEVICE_AUTHORIZATION.user_code,
        verificationUri: FAKE_DEVICE_AUTHORIZATION.verification_uri,
        verificationUriComplete: FAKE_DEVICE_AUTHORIZATION.verification_uri_complete,
        expiresIn: FAKE_DEVICE_AUTHORIZATION.expires_in,
        interval: FAKE_DEVICE_AUTHORIZATION.interval,
      });
      // The whole point of proxying: the secret stays server-side.
      expect(raw).not.toContain(workos.apiKey);
    });

    it("answers 502 in the error contract and logs when WorkOS is unreachable", async () => {
      const { db } = buildApp();
      const brokenConfig: ApiConfig = { ...config, workosApiUrl: "http://127.0.0.1:1" };
      const app = new Hono();
      app.route(
        "/api/v1",
        createV1Routes({ auth: createWorkosAuth(brokenConfig), db, config: brokenConfig }),
      );

      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await app.request("/api/v1/auth/device", { method: "POST" });
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ error: "internal_error" });
        expect(logged).toHaveBeenCalledWith(
          "[api] device authorization proxy failed:",
          expect.anything(),
        );
      } finally {
        logged.mockRestore();
      }
    });

    it("rate limits a single client and leaves other clients alone", async () => {
      const { app } = buildApp();
      const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
      const request = (forwardedFor: string) =>
        app.request("/api/v1/auth/device", {
          method: "POST",
          headers: { "x-forwarded-for": forwardedFor },
        });

      for (let attempt = 0; attempt < DEVICE_RATE_LIMIT_PER_MINUTE; attempt += 1) {
        expect((await request(ip)).status).toBe(200);
      }

      const limited = await request(ip);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });

      const otherIp = await request("198.51.100.7");
      expect(otherIp.status).toBe(200);
    });

    it("keys the limit on the first hop of a forwarded chain", async () => {
      const { app } = buildApp();
      const client = `192.0.2.${Math.floor(Math.random() * 250) + 1}`;

      for (let attempt = 0; attempt < DEVICE_RATE_LIMIT_PER_MINUTE; attempt += 1) {
        const res = await app.request("/api/v1/auth/device", {
          method: "POST",
          headers: { "x-forwarded-for": `${client}, 10.0.0.${attempt}` },
        });
        expect(res.status).toBe(200);
      }

      // Same client, a different proxy hop: still the same bucket.
      const limited = await app.request("/api/v1/auth/device", {
        method: "POST",
        headers: { "x-forwarded-for": `${client}, 10.0.99.1` },
      });
      expect(limited.status).toBe(429);
    });
  });
});
