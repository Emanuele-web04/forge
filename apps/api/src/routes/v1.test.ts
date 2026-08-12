import { createHash, randomUUID } from "node:crypto";
import {
  type AccountErrorBody,
  InstanceInfo,
  OrganizationRequiredBody,
  PublicProfile,
  UsageSummary,
  USAGE_PUSH_MAX_BUCKETS,
} from "@synara/contracts";
import { eq } from "drizzle-orm";
import { Schema } from "effect";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkosApiConfig } from "../config";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { usageModelStats, usageSkillStats } from "../db/schema";
import { createDeviceCredentialStore } from "../identity/deviceCredentialStore";
import { createEnvironmentRegistry } from "../identity/environmentRegistry";
import { clearOrgCache } from "../identity/orgProvisioning";
import { createWorkosIdentityProvider } from "../identity/workos";
import { startFakeWorkos, type FakeWorkos } from "../testing/fakeWorkos";
import {
  createV1Routes,
  OTP_AUTHENTICATE_RATE_LIMIT_PER_MINUTE,
  OTP_SEND_RATE_LIMIT_PER_MINUTE,
  PER_EMAIL_SEND_RATE_LIMIT_PER_HOUR,
  PUBLIC_PROFILE_RATE_LIMIT_PER_MINUTE,
  REFRESH_RATE_LIMIT_PER_MINUTE,
} from "./v1";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** JSON POST with a per-test client IP, so rate budgets never couple tests. */
function postJson(app: Hono, path: string, body: unknown, clientIp: string) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": clientIp },
    body: JSON.stringify(body),
  });
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
  let config: WorkosApiConfig;

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
   * A user with a token that names no organization — exactly what the first
   * sign-in grant hands back, before the client refreshes into a workspace.
   */
  async function signInWithoutOrg(): Promise<{ token: string; userId: string }> {
    const user = workos.addUser({ first_name: "Orgless", last_name: "User" });
    const token = await workos.signAccessToken({ sub: user.id, sid: `session_${randomUUID()}` });
    return { token, userId: user.id };
  }

  /** Routes wired to a full adapter set built from `config`. */
  function routesFor(
    db: ReturnType<typeof createDb>["db"],
    forConfig: WorkosApiConfig,
    trustedProxyHops?: number,
  ) {
    const { verifier, grants } = createWorkosIdentityProvider(forConfig);
    return createV1Routes({
      verifier,
      grants,
      deviceCredentials: createDeviceCredentialStore(db),
      environments: createEnvironmentRegistry(db),
      db,
      ...(trustedProxyHops !== undefined ? { trustedProxyHops } : {}),
    });
  }

  function buildApp(options: { trustedProxyHops?: number } = {}) {
    const { db } = createDb(databaseUrl);
    const app = new Hono();
    app.route("/api/v1", routesFor(db, config, options.trustedProxyHops));
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
    const brokenConfig: WorkosApiConfig = {
      ...config,
      workosApiUrl: "http://127.0.0.1:1",
      workosIssuer: workos.issuer,
      workosJwksUrl: `${workos.origin}/sso/jwks/${workos.clientId}`,
    };
    const app = new Hono();
    app.route("/api/v1", routesFor(db, brokenConfig));

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

  // M4: the membership cache is a read-path convenience with a ≤60s staleness
  // SLA — it must never be the authorization answer for a mutation. A member
  // removed after priming the cache may still read, but registering a host
  // (mutating, credential-minting) resolves membership live and is refused.
  it("refuses a mutating op for a member revoked after the cache was primed", async () => {
    const { app } = buildApp();
    const { token, userId, orgId } = await signIn();

    // Prime the cache with a read.
    const primed = await app.request("/api/v1/hosts", { headers: authHeaders(token) });
    expect(primed.status).toBe(200);

    workos.removeMembership(orgId, userId);

    // The read path may still serve the cached membership within the TTL.
    const readAfter = await app.request("/api/v1/hosts", { headers: authHeaders(token) });
    expect(readAfter.status).toBe(200);

    // The mutating path must not: fresh membership, immediate refusal.
    const registerRes = await app.request("/api/v1/hosts", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(registerHostBody(randomUUID())),
    });
    expect(registerRes.status).toBe(403);
    expect(await registerRes.json()).toMatchObject({ error: "organization_required" });
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

  describe("email OTP authentication", () => {
    /** Sends the code and reads it from the fake, as a human reads their inbox. */
    async function sendCode(app: Hono, email: string, clientIp: string) {
      const res = await postJson(app, "/api/v1/auth/otp/send", { email }, clientIp);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { email: string; expiresAt: string };
      expect(body.email).toBe(email);
      expect(typeof body.expiresAt).toBe("string");
      const live = workos.currentMagicAuth(email);
      if (!live) throw new Error("fake WorkOS minted no magic auth code");
      return { body, code: live.code };
    }

    it("signs in a brand-new email — send, redeem, usable token pair", async () => {
      const { app } = buildApp();
      const email = `new-${randomUUID()}@example.com`;

      const { code } = await sendCode(app, email, "203.0.113.20");
      const res = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code },
        "203.0.113.20",
      );
      expect(res.status).toBe(200);
      const auth = (await res.json()) as {
        accessToken: string;
        user: { id: string; email: string };
      };
      expect(auth.user.email).toBe(email);
      expect(typeof auth.accessToken).toBe("string");

      // The account is real afterwards: a second send-and-redeem signs the
      // same user in again rather than provisioning a duplicate.
      const { code: secondCode } = await sendCode(app, email, "203.0.113.20");
      const again = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code: secondCode },
        "203.0.113.20",
      );
      expect(again.status).toBe(200);
      const secondAuth = (await again.json()) as { user: { id: string } };
      expect(secondAuth.user.id).toBe(auth.user.id);
    });

    it("signs in an existing user with the same flow", async () => {
      const { app } = buildApp();
      const existing = workos.addUser({ email: `ada-${randomUUID()}@example.com` });

      const { code } = await sendCode(app, existing.email, "203.0.113.21");
      const res = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email: existing.email, code },
        "203.0.113.21",
      );
      expect(res.status).toBe(200);
      const auth = (await res.json()) as { accessToken: string; user: { id: string } };
      // The existing account, not a duplicate.
      expect(auth.user.id).toBe(existing.id);

      // And the token reaches an authenticated route once scoped.
      const organization = workos.addOrganization({ name: "Analytical Engines" });
      workos.addMembership(organization.id, existing.id);
      clearOrgCache();
      const scoped = await workos.signAccessToken({
        sub: existing.id,
        sid: `session_${randomUUID()}`,
        orgId: organization.id,
      });
      const meRes = await app.request("/api/v1/me", { headers: authHeaders(scoped) });
      expect(meRes.status).toBe(200);
    });

    it("answers 401 invalid_verification_code for a wrong code", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      const { code } = await sendCode(app, email, "203.0.113.22");
      const wrongCode = code === "999999" ? "999998" : "999999";

      const res = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code: wrongCode },
        "203.0.113.22",
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "invalid_verification_code" });
    });

    it("answers 401 invalid_verification_code for an expired code", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      const { code } = await sendCode(app, email, "203.0.113.23");
      workos.expireMagicAuth(email);

      const res = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code },
        "203.0.113.23",
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "invalid_verification_code" });
    });

    it("invalidates the old code when a new one is sent", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      const { code: oldCode } = await sendCode(app, email, "203.0.113.24");
      const { code: newCode } = await sendCode(app, email, "203.0.113.24");
      expect(newCode).not.toBe(oldCode);

      const stale = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code: oldCode },
        "203.0.113.24",
      );
      expect(stale.status).toBe(401);

      const current = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code: newCode },
        "203.0.113.24",
      );
      expect(current.status).toBe(200);
    });

    // A send that said "unknown email" would let anyone enumerate which
    // addresses have accounts; existing and new addresses answer identically.
    it("answers the same 202 shape whether or not the address has an account", async () => {
      const { app } = buildApp();
      const existing = workos.addUser({ email: `known-${randomUUID()}@example.com` });
      const unknown = `unknown-${randomUUID()}@example.com`;

      const knownRes = await postJson(
        app,
        "/api/v1/auth/otp/send",
        { email: existing.email },
        "203.0.113.25",
      );
      const unknownRes = await postJson(
        app,
        "/api/v1/auth/otp/send",
        { email: unknown },
        "203.0.113.26",
      );
      expect(knownRes.status).toBe(202);
      expect(unknownRes.status).toBe(202);
      const knownBody = (await knownRes.json()) as Record<string, unknown>;
      const unknownBody = (await unknownRes.json()) as Record<string, unknown>;
      expect(Object.keys(knownBody).toSorted()).toEqual(Object.keys(unknownBody).toSorted());
    });

    it.each([
      ["a missing email", {}],
      ["a blank email", { email: "  " }],
    ])("answers 400 validation_failed for %s on send", async (_label, body) => {
      const { app } = buildApp();
      const res = await postJson(app, "/api/v1/auth/otp/send", body, "203.0.113.27");
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_failed" });
    });

    it.each([
      ["a missing code", { email: "ada@example.com" }],
      ["a non-numeric code", { email: "ada@example.com", code: "abc123" }],
      ["a short code", { email: "ada@example.com", code: "12345" }],
    ])("answers 400 validation_failed for %s on authenticate", async (_label, body) => {
      const { app } = buildApp();
      const res = await postJson(app, "/api/v1/auth/otp/authenticate", body, "203.0.113.28");
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_failed" });
    });

    it("rate limits sends on the email-sending budget", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      const clientIp = "203.0.113.29";

      for (let i = 0; i < OTP_SEND_RATE_LIMIT_PER_MINUTE; i += 1) {
        expect((await postJson(app, "/api/v1/auth/otp/send", { email }, clientIp)).status).toBe(
          202,
        );
      }
      const limited = await postJson(app, "/api/v1/auth/otp/send", { email }, clientIp);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });

      // The redemption budget is separate: authenticate is still reachable
      // from the same client, and another client can still send.
      const live = workos.currentMagicAuth(email);
      if (!live) throw new Error("fake WorkOS minted no magic auth code");
      const auth = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code: live.code },
        clientIp,
      );
      expect(auth.status).toBe(200);
      const other = await postJson(
        app,
        "/api/v1/auth/otp/send",
        { email: `other-${randomUUID()}@example.com` },
        "203.0.113.30",
      );
      expect(other.status).toBe(202);
    });

    // The spoof the leftmost-entry key allowed: with one trusted hop only the
    // rightmost entry counts, so an attacker-chosen prefix lands in the same
    // bucket as the honest request and cannot mint fresh budgets.
    it("does not grant a fresh budget to a spoofed leftmost x-forwarded-for entry", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      const realIp = "203.0.113.40";

      const send = (spoofedPrefix: string) =>
        app.request("/api/v1/auth/otp/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `${spoofedPrefix}, ${realIp}`,
          },
          body: JSON.stringify({ email }),
        });

      for (let i = 0; i < OTP_SEND_RATE_LIMIT_PER_MINUTE; i += 1) {
        expect((await send(`10.0.${i}.1`)).status).toBe(202);
      }
      // A fresh spoofed prefix must not escape the per-IP budget.
      const limited = await send("10.0.99.1");
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    });

    // The target-side bound: even when the caller rotates real IPs, mail into
    // one mailbox stops at the per-email budget.
    it("throttles repeated sends to one address across differing client IPs", async () => {
      const { app } = buildApp();
      const email = `Ada-${randomUUID()}@Example.com`;

      for (let i = 0; i < PER_EMAIL_SEND_RATE_LIMIT_PER_HOUR; i += 1) {
        const res = await postJson(app, "/api/v1/auth/otp/send", { email }, `203.0.114.${i + 1}`);
        expect(res.status).toBe(202);
      }
      // Case-folded: the same mailbox under different spelling shares the key.
      const limited = await postJson(
        app,
        "/api/v1/auth/otp/send",
        { email: email.toLowerCase() },
        "203.0.114.200",
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });

      // Another mailbox is unaffected.
      const other = await postJson(
        app,
        "/api/v1/auth/otp/send",
        { email: `other-${randomUUID()}@example.com` },
        "203.0.114.201",
      );
      expect(other.status).toBe(202);
    });

    // Multi-org fail-closed (personal-org-only V1): a provider that wants an
    // organization chosen gets a clear classified 403, never a silent
    // first-organization pick and never an unclassified 502.
    it("answers 403 multiple_organizations_unsupported when the provider requires org selection", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      const { code } = await sendCode(app, email, "203.0.113.90");

      workos.requireOrganizationSelectionOnNextAuthenticate();
      const res = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code },
        "203.0.113.90",
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "multiple_organizations_unsupported",
        message: expect.stringContaining("aren't supported yet"),
      });
    });

    // hops=0 is the no-proxy deployment: the forwarded header must be inert,
    // so every synthetic request (no socket) shares the one fallback bucket.
    it("keys on the socket and ignores x-forwarded-for entirely with zero trusted hops", async () => {
      const { app } = buildApp({ trustedProxyHops: 0 });
      const email = `ada-${randomUUID()}@example.com`;

      for (let i = 0; i < OTP_SEND_RATE_LIMIT_PER_MINUTE; i += 1) {
        expect(
          (await postJson(app, "/api/v1/auth/otp/send", { email }, `203.0.115.${i + 1}`)).status,
        ).toBe(202);
      }
      // A fresh forwarded value would have escaped the budget under header
      // keying; with hops=0 it must not.
      const limited = await postJson(app, "/api/v1/auth/otp/send", { email }, "203.0.115.99");
      expect(limited.status).toBe(429);
    });

    // codex H7 tail: the grant calls forward the sanitized caller identity so
    // WorkOS risk controls see the caller, not this proxy.
    it("forwards the sanitized client ip and user agent to the provider on authenticate", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      const { code } = await sendCode(app, email, "203.0.113.77");

      const res = await app.request("/api/v1/auth/otp/authenticate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.77",
          "user-agent": "synara-test/1.0",
        },
        body: JSON.stringify({ email, code }),
      });
      expect(res.status).toBe(200);

      const grant = workos.requests.findLast(
        (request) =>
          request.path === "/user_management/authenticate" &&
          request.body.includes("magic-auth:code"),
      );
      if (!grant) throw new Error("fake WorkOS saw no magic auth grant");
      const body = JSON.parse(grant.body) as Record<string, unknown>;
      expect(body.ip_address).toBe("203.0.113.77");
      expect(body.user_agent).toBe("synara-test/1.0");
    });

    it("rate limits redemption attempts on their own budget", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;
      const clientIp = "203.0.113.31";

      for (let i = 0; i < OTP_AUTHENTICATE_RATE_LIMIT_PER_MINUTE; i += 1) {
        const res = await postJson(
          app,
          "/api/v1/auth/otp/authenticate",
          { email, code: "000000" },
          clientIp,
        );
        expect(res.status).toBe(401);
      }
      const limited = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code: "000000" },
        clientIp,
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });

      // A different client is unaffected.
      const other = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code: "000000" },
        "203.0.113.32",
      );
      expect(other.status).toBe(401);

      // The sending budget is separate: the same client can still request a
      // fresh code after burning its redemption attempts.
      const send = await postJson(app, "/api/v1/auth/otp/send", { email }, clientIp);
      expect(send.status).toBe(202);
    });

    // WorkOS refuses Magic Auth outright for a domain governed by an SSO
    // connection. Surfaced as its own 403 — "use your company sign-on" is the
    // only actionable answer — identically whether or not an account exists,
    // since the refusal is domain policy, not an account property.
    it("surfaces an SSO-governed domain as 403 sso_required on send", async () => {
      const ssoWorkos = await startFakeWorkos({ ssoRequiredDomains: ["example.com"] });
      try {
        const { db } = buildApp();
        const ssoConfig = ssoWorkos.config({ databaseUrl });
        const app = new Hono();
        app.route("/api/v1", routesFor(db, ssoConfig));

        const res = await postJson(
          app,
          "/api/v1/auth/otp/send",
          { email: `sso-${randomUUID()}@example.com` },
          "203.0.113.33",
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: "sso_required" });
      } finally {
        await ssoWorkos.close();
      }
    });

    // The OTP code is a credential — and the WorkOS create-magic-auth
    // response literally contains it. Asserted rather than trusted, because
    // the natural implementations of the send route (return the upstream
    // body) and of every refusal (schema decoder message, upstream echo)
    // leak it.
    it("never emits the code in a response body or a log line", async () => {
      const { app } = buildApp();
      const email = `ada-${randomUUID()}@example.com`;

      const logged: string[] = [];
      const capture = (...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(capture);
      const logSpy = vi.spyOn(console, "log").mockImplementation(capture);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(capture);
      try {
        // The send response is where the code most plausibly leaks: the
        // WorkOS body carries it, and only allowlist parsing keeps it out.
        const sendRes = await postJson(app, "/api/v1/auth/otp/send", { email }, "203.0.113.34");
        expect(sendRes.status).toBe(202);
        const live = workos.currentMagicAuth(email);
        if (!live) throw new Error("fake WorkOS minted no magic auth code");
        expect(await sendRes.text()).not.toContain(live.code);

        // A wrong code and a malformed body: the refusals whose natural
        // implementations (upstream echo, schema decoder message) quote the
        // submitted value.
        const wrongCode = live.code === "999999" ? "999998" : "999999";
        const wrong = await postJson(
          app,
          "/api/v1/auth/otp/authenticate",
          { email, code: wrongCode },
          "203.0.113.34",
        );
        const malformed = await postJson(
          app,
          "/api/v1/auth/otp/authenticate",
          { email, code: { nested: wrongCode } },
          "203.0.113.34",
        );
        for (const res of [wrong, malformed]) {
          expect(await res.text()).not.toContain(wrongCode);
        }

        const joined = logged.join("\n");
        expect(joined).not.toContain(live.code);
        expect(joined).not.toContain(wrongCode);
      } finally {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    // The adversarial variant: the refusal's `code`/`error` fields are
    // free-form provider strings, and the unclassified-failure log line is
    // the one place they used to travel verbatim. A provider edge case that
    // echoes the submitted secret into them must still never reach a log —
    // only allowlisted labels do.
    it("never logs unclassified provider code/error fields that echo the submitted secret", async () => {
      const { serve } = await import("@hono/node-server");
      const submittedCode = "654321";
      const providerSecret = "provider_secret_echo_test";
      const hostile = new Hono();
      // Every grant refuses with the secrets embedded in the two fields the
      // log line reads, under spellings no classifier recognizes.
      hostile.post("/user_management/authenticate", (c) =>
        c.json(
          { code: `weird_refusal ${submittedCode}`, error: `edge ${providerSecret}` },
          400 as 400,
        ),
      );
      const server = serve({ fetch: hostile.fetch, port: 0 });

      const logged: string[] = [];
      const capture = (...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(capture);
      const logSpy = vi.spyOn(console, "log").mockImplementation(capture);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(capture);
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("failed to bind");
        const { db } = buildApp();
        const app = new Hono();
        app.route(
          "/api/v1",
          routesFor(
            db,
            workos.config({ databaseUrl, workosApiUrl: `http://127.0.0.1:${address.port}` }),
          ),
        );

        const otp = await postJson(
          app,
          "/api/v1/auth/otp/authenticate",
          { email: "ada@example.com", code: submittedCode },
          "203.0.113.35",
        );
        expect(otp.status).toBe(502);

        const joined = logged.join("\n");
        // The refusal was logged (as unclassified) ...
        expect(joined).toContain("unclassified WorkOS");
        // ... but nothing provider-supplied travelled verbatim.
        expect(joined).not.toContain(submittedCode);
        expect(joined).not.toContain(providerSecret);
        expect(joined).toContain("unrecognized");
      } finally {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        warnSpy.mockRestore();
        server.close();
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

  /** Auth headers plus a per-test client IP, so usage budgets never couple tests. */
  function usageHeaders(token: string, clientIp: string): Record<string, string> {
    return { ...authHeaders(token), "x-forwarded-for": clientIp };
  }

  /** A UTC minute bucket key, ISO-8601 with seconds zeroed, offset from now. */
  function minuteIso(offsetMinutes = 0): string {
    const now = Date.now() + offsetMinutes * 60_000;
    return new Date(Math.floor(now / 60_000) * 60_000).toISOString();
  }

  function modelBucket(overrides: Record<string, unknown> = {}) {
    return {
      minute: minuteIso(),
      provider: "claudeAgent",
      model: "claude-fable-5",
      reasoning: null,
      tokens: 1000,
      turns: 2,
      prompts: 1,
      ...overrides,
    };
  }

  function usageBody(environmentId: string, overrides: Record<string, unknown> = {}) {
    return { environmentId, models: [], skills: [], ...overrides };
  }

  function pushUsage(app: Hono, token: string, body: unknown, clientIp: string) {
    return app.request("/api/v1/usage", {
      method: "POST",
      headers: usageHeaders(token, clientIp),
      body: JSON.stringify(body),
    });
  }

  describe("POST /usage", () => {
    it("rejects unauthenticated pushes", async () => {
      const { app } = buildApp();
      const res = await app.request("/api/v1/usage", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.116.1" },
        body: JSON.stringify(usageBody(randomUUID())),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
    });

    it("writes model and skill buckets and reports the count", async () => {
      const { app, db } = buildApp();
      const { token, userId, orgId } = await signIn();
      const environmentId = randomUUID();

      const res = await pushUsage(
        app,
        token,
        usageBody(environmentId, {
          models: [
            modelBucket(),
            modelBucket({ model: "claude-opus-4.8", reasoning: "high", tokens: 500 }),
          ],
          skills: [{ minute: minuteIso(), name: "code-review", kind: "skill", runs: 3 }],
        }),
        "203.0.116.2",
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ written: 3 });

      const modelRows = await db
        .select()
        .from(usageModelStats)
        .where(eq(usageModelStats.userId, userId));
      expect(modelRows).toHaveLength(2);
      expect(modelRows.every((row) => row.orgId === orgId)).toBe(true);
      expect(modelRows.every((row) => row.environmentId === environmentId)).toBe(true);

      const skillRows = await db
        .select()
        .from(usageSkillStats)
        .where(eq(usageSkillStats.userId, userId));
      expect(skillRows).toHaveLength(1);
      expect(skillRows[0]).toMatchObject({ name: "code-review", kind: "skill", runs: 3 });
    });

    // Buckets carry ABSOLUTE values: re-pushing the same key with grown
    // counters must replace, not add — that is what makes retries idempotent.
    it("upserts absolutely: a re-pushed grown bucket replaces, never sums", async () => {
      const { app, db } = buildApp();
      const { token, userId } = await signIn();
      const environmentId = randomUUID();
      const minute = minuteIso();

      const first = await pushUsage(
        app,
        token,
        usageBody(environmentId, {
          models: [modelBucket({ minute, tokens: 100, turns: 1, prompts: 1 })],
          skills: [{ minute, name: "code-review", kind: "skill", runs: 1 }],
        }),
        "203.0.116.3",
      );
      expect(first.status).toBe(202);

      const second = await pushUsage(
        app,
        token,
        usageBody(environmentId, {
          models: [modelBucket({ minute, tokens: 250, turns: 3, prompts: 2 })],
          skills: [{ minute, name: "code-review", kind: "skill", runs: 4 }],
        }),
        "203.0.116.3",
      );
      expect(second.status).toBe(202);

      const modelRows = await db
        .select()
        .from(usageModelStats)
        .where(eq(usageModelStats.userId, userId));
      expect(modelRows).toHaveLength(1);
      // The grown values, not 350/4/3.
      expect(modelRows[0]).toMatchObject({ tokens: 250, turns: 3, prompts: 2 });

      const skillRows = await db
        .select()
        .from(usageSkillStats)
        .where(eq(usageSkillStats.userId, userId));
      expect(skillRows).toHaveLength(1);
      expect(skillRows[0]).toMatchObject({ runs: 4 });
    });

    // Reasoning is part of the key: the same model with and without a
    // reasoning setting is two buckets, not one.
    it("keeps null and 'high' reasoning as distinct buckets", async () => {
      const { app, db } = buildApp();
      const { token, userId } = await signIn();
      const minute = minuteIso();

      const res = await pushUsage(
        app,
        token,
        usageBody(randomUUID(), {
          models: [
            modelBucket({ minute, reasoning: null, tokens: 100 }),
            modelBucket({ minute, reasoning: "high", tokens: 200 }),
          ],
        }),
        "203.0.116.4",
      );
      expect(res.status).toBe(202);

      const rows = await db
        .select()
        .from(usageModelStats)
        .where(eq(usageModelStats.userId, userId));
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.reasoning).toSorted()).toEqual(["", "high"]);
    });

    // The ''-sentinel regression case: NULLs are distinct under a Postgres
    // unique index, so a NULL-stored reasoning would duplicate the bucket on
    // every push. Stored as '' it must conflict — one row, updated in place.
    it("does not duplicate a null-reasoning bucket pushed twice", async () => {
      const { app, db } = buildApp();
      const { token, userId } = await signIn();
      const environmentId = randomUUID();
      const minute = minuteIso();

      for (const tokens of [100, 300]) {
        const res = await pushUsage(
          app,
          token,
          usageBody(environmentId, {
            models: [modelBucket({ minute, reasoning: null, tokens })],
          }),
          "203.0.116.5",
        );
        expect(res.status).toBe(202);
      }

      const rows = await db
        .select()
        .from(usageModelStats)
        .where(eq(usageModelStats.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reasoning: "", tokens: 300 });
    });

    it("keeps the same minute from two environments as separate rows", async () => {
      const { app, db } = buildApp();
      const { token, userId } = await signIn();
      const minute = minuteIso();
      const environmentA = randomUUID();
      const environmentB = randomUUID();

      for (const [environmentId, tokens] of [
        [environmentA, 100],
        [environmentB, 200],
      ] as const) {
        const res = await pushUsage(
          app,
          token,
          usageBody(environmentId, { models: [modelBucket({ minute, tokens })] }),
          "203.0.116.6",
        );
        expect(res.status).toBe(202);
      }

      const rows = await db
        .select()
        .from(usageModelStats)
        .where(eq(usageModelStats.userId, userId));
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.environmentId).toSorted()).toEqual(
        [environmentA, environmentB].toSorted(),
      );
    });

    it.each([
      ["a missing environment id", () => ({ models: [], skills: [] })],
      [
        "a loose minute spelling",
        () =>
          usageBody(randomUUID(), { models: [modelBucket({ minute: "2026-08-11T21:34:05Z" })] }),
      ],
      [
        "a negative counter",
        () => usageBody(randomUUID(), { models: [modelBucket({ tokens: -1 })] }),
      ],
      ["a non-array models field", () => usageBody(randomUUID(), { models: {} })],
    ] as const)("answers 400 validation_failed for %s", async (_label, makeBody) => {
      const { app } = buildApp();
      const { token } = await signIn();

      const res = await pushUsage(app, token, makeBody(), "203.0.116.7");
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_failed" });
    });

    it("refuses a batch past USAGE_PUSH_MAX_BUCKETS", async () => {
      const { app, db } = buildApp();
      const { token, userId } = await signIn();

      const minute = minuteIso();
      const oversized = Array.from({ length: USAGE_PUSH_MAX_BUCKETS + 1 }, (_, index) =>
        modelBucket({ minute, model: `model-${index}` }),
      );
      const res = await pushUsage(
        app,
        token,
        usageBody(randomUUID(), { models: oversized }),
        "203.0.116.8",
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation_failed" });

      // Refused before the transaction: nothing landed.
      const rows = await db
        .select()
        .from(usageModelStats)
        .where(eq(usageModelStats.userId, userId));
      expect(rows).toHaveLength(0);
    });
  });


  describe("GET /usage/summary", () => {
    it("rejects unauthenticated reads", async () => {
      const { app } = buildApp();
      const res = await app.request("/api/v1/usage/summary", {
        headers: { "x-forwarded-for": "203.0.121.1" },
      });
      expect(res.status).toBe(401);
    });

    it("aggregates the owner's usage at full depth, skills included", async () => {
      const { app } = buildApp();
      const { token } = await signIn();
      const environmentId = randomUUID();
      const otherEnvironment = randomUUID();
      await pushUsage(
        app,
        token,
        usageBody(environmentId, {
          models: [
            modelBucket({ tokens: 1000, turns: 2, prompts: 1 }),
            modelBucket({ model: "claude-opus-4.8", reasoning: "high", tokens: 400, turns: 1, prompts: 1 }),
          ],
          skills: [{ minute: minuteIso(), name: "code-review", kind: "skill", runs: 3 }],
        }),
        "203.0.121.2",
      );
      await pushUsage(
        app,
        token,
        usageBody(otherEnvironment, {
          models: [modelBucket({ tokens: 600, turns: 1, prompts: 2 })],
        }),
        "203.0.121.2",
      );

      const res = await app.request("/api/v1/usage/summary?utcOffsetMinutes=0", {
        headers: usageHeaders(token, "203.0.121.3"),
      });
      expect(res.status).toBe(200);
      const body = Schema.decodeUnknownSync(UsageSummary)(await res.json());

      expect(body.lifetimeTokens).toBe(2000);
      expect(body.lifetimePrompts).toBe(4);
      expect(body.lifetimeTurns).toBe(4);
      // Same bucket key from two environments sums into one model row.
      const fable = body.models.find((row) => row.model === "claude-fable-5");
      expect(fable).toMatchObject({ reasoning: null, tokens: 1600, turns: 3, prompts: 3 });
      const opus = body.models.find((row) => row.model === "claude-opus-4.8");
      expect(opus).toMatchObject({ reasoning: "high", tokens: 400 });
      // Skills are owner-only data and DO appear here, unlike the public read.
      expect(body.skills).toEqual([{ name: "code-review", kind: "skill", runs: 3 }]);
      // Per-environment shares stay separable.
      const shares = new Map(body.environments.map((row) => [row.environmentId, row.tokens]));
      expect(shares.get(environmentId)).toBe(1400);
      expect(shares.get(otherEnvironment)).toBe(600);
      expect(body.days).toHaveLength(1);
      expect(body.hours.reduce((total, row) => total + row.prompts, 0)).toBe(4);
    });

    it("localizes day bucketing to the caller's UTC offset", async () => {
      const { app } = buildApp();
      const { token } = await signIn();
      // A bucket at 23:30 UTC lands on the NEXT local day for UTC+120.
      const lateUtc = "2026-03-01T23:30:00.000Z";
      await pushUsage(
        app,
        token,
        usageBody(randomUUID(), { models: [modelBucket({ minute: lateUtc, tokens: 100 })] }),
        "203.0.121.4",
      );
      const res = await app.request("/api/v1/usage/summary?utcOffsetMinutes=120", {
        headers: usageHeaders(token, "203.0.121.5"),
      });
      const body = Schema.decodeUnknownSync(UsageSummary)(await res.json());
      expect(body.days.map((row) => row.day)).toContain("2026-03-02");
      // And the hour shifts with it: 23:30 UTC is 01:30 local.
      expect(body.hours.find((row) => row.prompts > 0)?.hour).toBe(1);
    });
  });

  describe("GET /profiles/:handle", () => {
    /** A signed-in user with an onboarded profile, public or not. */
    async function onboardedUser(app: Hono, options: { public?: boolean } = {}) {
      const session = await signIn();
      const handle = `pub-${randomUUID().slice(0, 8)}`;
      const res = await app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(session.token),
        body: JSON.stringify({
          handle,
          displayName: "Ada Lovelace",
          avatarColor: "#22c55e",
          ...(options.public !== undefined ? { public: options.public } : {}),
        }),
      });
      expect(res.status).toBe(200);
      return { ...session, handle };
    }

    function getProfile(app: Hono, handle: string, clientIp: string) {
      return app.request(`/api/v1/profiles/${handle}`, {
        headers: { "x-forwarded-for": clientIp },
      });
    }

    it("answers the same 404 for an unknown handle and a private profile", async () => {
      const { app } = buildApp();
      const privateProfile = await onboardedUser(app); // public defaults to false

      const unknownRes = await getProfile(app, `ghost-${randomUUID().slice(0, 8)}`, "203.0.117.1");
      const privateRes = await getProfile(app, privateProfile.handle, "203.0.117.1");

      expect(unknownRes.status).toBe(404);
      expect(privateRes.status).toBe(404);
      const unknownBody = (await unknownRes.json()) as AccountErrorBody;
      const privateBody = (await privateRes.json()) as AccountErrorBody;
      expect(unknownBody.error).toBe("profile_not_found");
      // Indistinguishable: an existence probe learns nothing from the body.
      expect(privateBody).toEqual(unknownBody);
    });

    it("serves identity, cross-environment aggregates, lifetime totals, and the heatmap", async () => {
      const { app } = buildApp();
      const owner = await onboardedUser(app, { public: true });
      const minute = minuteIso();

      // The same bucket key from two environments: the public view must sum
      // them without ever naming either environment.
      for (const [environmentId, tokens, turns, prompts] of [
        [randomUUID(), 100, 2, 1],
        [randomUUID(), 250, 3, 2],
      ] as const) {
        const res = await pushUsage(
          app,
          owner.token,
          usageBody(environmentId, {
            models: [modelBucket({ minute, reasoning: "high", tokens, turns, prompts })],
          }),
          "203.0.117.2",
        );
        expect(res.status).toBe(202);
      }

      const res = await getProfile(app, owner.handle, "203.0.117.3");
      expect(res.status).toBe(200);
      const body = Schema.decodeUnknownSync(PublicProfile)(await res.json());

      expect(body.handle).toBe(owner.handle);
      expect(body.displayName).toBe("Ada Lovelace");
      expect(body.avatarColor).toBe("#22c55e");
      expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);

      expect(body.models).toEqual([
        {
          provider: "claudeAgent",
          model: "claude-fable-5",
          reasoning: "high",
          tokens: 350,
          turns: 5,
          prompts: 3,
        },
      ]);
      expect(body.lifetimeTokens).toBe(350);
      expect(body.lifetimeTurns).toBe(5);
      expect(body.lifetimePrompts).toBe(3);

      const day = minute.slice(0, 10);
      expect(body.heatmap).toEqual([{ day, tokens: 350, prompts: 3 }]);

      // Environment ids never appear anywhere in a public payload.
      expect(JSON.stringify(body)).not.toContain("environment");
    });

    it("serves ''-stored reasoning back as null", async () => {
      const { app } = buildApp();
      const owner = await onboardedUser(app, { public: true });

      const push = await pushUsage(
        app,
        owner.token,
        usageBody(randomUUID(), { models: [modelBucket({ reasoning: null })] }),
        "203.0.117.4",
      );
      expect(push.status).toBe(202);

      const res = await getProfile(app, owner.handle, "203.0.117.5");
      expect(res.status).toBe(200);
      const body = (await res.json()) as PublicProfile;
      expect(body.models).toHaveLength(1);
      expect(body.models[0]?.reasoning).toBeNull();
    });

    // Which skills someone runs reveals what they work on. Skill rows exist
    // for this user; the public payload must not carry a trace of them.
    it("never serves skill data, even when skill rows exist", async () => {
      const { app, db } = buildApp();
      const owner = await onboardedUser(app, { public: true });
      const skillName = `secret-skill-${randomUUID().slice(0, 8)}`;

      const push = await pushUsage(
        app,
        owner.token,
        usageBody(randomUUID(), {
          models: [modelBucket()],
          skills: [{ minute: minuteIso(), name: skillName, kind: "skill", runs: 7 }],
        }),
        "203.0.117.6",
      );
      expect(push.status).toBe(202);
      // The rows are really there — the absence below is filtering, not a
      // write that never happened.
      const skillRows = await db
        .select()
        .from(usageSkillStats)
        .where(eq(usageSkillStats.userId, owner.userId));
      expect(skillRows).toHaveLength(1);

      const res = await getProfile(app, owner.handle, "203.0.117.7");
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain(skillName);
      expect(raw).not.toContain("skill");
      expect(Object.keys(JSON.parse(raw) as Record<string, unknown>)).not.toContain("skills");
    });

    // The public URL spells it /@handle, and people type handles in any case.
    it("tolerates a leading @ and uppercase in the lookup", async () => {
      const { app } = buildApp();
      const owner = await onboardedUser(app, { public: true });

      const res = await getProfile(app, `@${owner.handle.toUpperCase()}`, "203.0.117.8");
      expect(res.status).toBe(200);
      const body = (await res.json()) as PublicProfile;
      expect(body.handle).toBe(owner.handle);
    });

    it("rate limits reads past the public profile budget", async () => {
      const { app } = buildApp();
      const clientIp = "203.0.117.9";
      const handle = `ghost-${randomUUID().slice(0, 8)}`;

      for (let i = 0; i < PUBLIC_PROFILE_RATE_LIMIT_PER_MINUTE; i += 1) {
        expect((await getProfile(app, handle, clientIp)).status).toBe(404);
      }
      const limited = await getProfile(app, handle, clientIp);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });

      // Another client is unaffected.
      expect((await getProfile(app, handle, "203.0.117.10")).status).toBe(404);
    });
  });

  describe("PUT /profile public flag", () => {
    function profilePut(app: Hono, token: string, body: Record<string, unknown>) {
      return app.request("/api/v1/profile", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });
    }

    it("flips visibility on, /me echoes it, and omitting it later leaves it alone", async () => {
      const { app } = buildApp();
      const { token } = await signIn();
      const handle = `flag-${randomUUID().slice(0, 8)}`;
      const base = { handle, displayName: "Ada Lovelace", avatarColor: "#22c55e" };

      // First write without the flag: private by default, so the public
      // route does not serve it.
      const created = await profilePut(app, token, base);
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({ profile: { public: false } });
      const hidden = await app.request(`/api/v1/profiles/${handle}`, {
        headers: { "x-forwarded-for": "203.0.118.1" },
      });
      expect(hidden.status).toBe(404);

      // public: true flips visibility.
      const published = await profilePut(app, token, { ...base, public: true });
      expect(published.status).toBe(200);
      expect(await published.json()).toMatchObject({ profile: { public: true } });
      const visible = await app.request(`/api/v1/profiles/${handle}`, {
        headers: { "x-forwarded-for": "203.0.118.2" },
      });
      expect(visible.status).toBe(200);

      // A later update that omits the flag leaves visibility unchanged.
      const renamed = await profilePut(app, token, { ...base, displayName: "Ada L." });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({
        profile: { displayName: "Ada L.", public: true },
      });
      const stillVisible = await app.request(`/api/v1/profiles/${handle}`, {
        headers: { "x-forwarded-for": "203.0.118.3" },
      });
      expect(stillVisible.status).toBe(200);

      // And /me reports the flag.
      const meRes = await app.request("/api/v1/me", { headers: authHeaders(token) });
      expect(await meRes.json()).toMatchObject({ profile: { public: true } });
    });

    it("flips visibility back off with public: false", async () => {
      const { app } = buildApp();
      const { token } = await signIn();
      const handle = `flag-${randomUUID().slice(0, 8)}`;
      const base = { handle, displayName: "Ada Lovelace", avatarColor: "#22c55e" };

      await profilePut(app, token, { ...base, public: true });
      const unpublished = await profilePut(app, token, { ...base, public: false });
      expect(unpublished.status).toBe(200);
      expect(await unpublished.json()).toMatchObject({ profile: { public: false } });

      const res = await app.request(`/api/v1/profiles/${handle}`, {
        headers: { "x-forwarded-for": "203.0.118.4" },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "profile_not_found" });
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

    // V1 is personal-org-only: membership alone must not let one member of a
    // shared team rename the workspace out from under the rest. With
    // multi-org sign-in failing closed this is defense-in-depth.
    it("refuses to rename a multi-member organization", async () => {
      const { app } = buildApp();
      const { token, orgId, orgName } = await signIn();
      const teammate = workos.addUser({ first_name: "Team", last_name: "Mate" });
      workos.addMembership(orgId, teammate.id);

      const res = await app.request("/api/v1/organization", {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Hijacked" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "organization_rename_not_allowed" });

      // The name is untouched.
      const meRes = await app.request("/api/v1/me", { headers: authHeaders(token) });
      expect(await meRes.json()).toMatchObject({ organization: { id: orgId, name: orgName } });
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
     * The first call after `synara auth`: the sign-in grant mints an org-less
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
      const { organizations } = createWorkosIdentityProvider(config);
      await expect(organizations.listUserOrganizationMemberships(userId)).resolves.toEqual([
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
      const { organizations } = createWorkosIdentityProvider(config);
      await expect(organizations.listUserOrganizationMemberships(userId)).resolves.toHaveLength(1);
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

  describe("PKCE authorize routes", () => {
    const CODE_VERIFIER = "verifier_1234567890_1234567890_1234567890_123";
    const codeChallenge = () =>
      // The S256 challenge the server-side flow would derive.
      createHash("sha256").update(CODE_VERIFIER).digest("base64url");

    function authorizeBody(overrides: Record<string, unknown> = {}) {
      return {
        provider: "google",
        redirectUri: "http://127.0.0.1:49321/callback",
        codeChallenge: codeChallenge(),
        state: "state_abc123",
        ...overrides,
      };
    }

    it("builds a WorkOS authorize URL carrying the provider, S256 challenge, and state", async () => {
      const { app } = buildApp();

      const res = await postJson(app, "/api/v1/auth/authorize", authorizeBody(), "203.0.113.50");
      expect(res.status).toBe(200);
      const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
      const url = new URL(authorizeUrl);
      expect(`${url.origin}${url.pathname}`).toBe(`${workos.origin}/user_management/authorize`);
      expect(url.searchParams.get("client_id")).toBe(workos.clientId);
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("provider")).toBe("GoogleOAuth");
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:49321/callback");
      expect(url.searchParams.get("code_challenge")).toBe(codeChallenge());
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")).toBe("state_abc123");
      // The API key must not appear anywhere in a URL handed to a browser.
      expect(authorizeUrl).not.toContain(workos.apiKey);
    });

    it.each([
      ["github", "GitHubOAuth"],
      ["apple", "AppleOAuth"],
    ])("maps the %s provider to WorkOS's spelling", async (provider, workosProvider) => {
      const { app } = buildApp();
      const res = await postJson(
        app,
        "/api/v1/auth/authorize",
        authorizeBody({ provider }),
        "203.0.113.51",
      );
      expect(res.status).toBe(200);
      const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
      expect(new URL(authorizeUrl).searchParams.get("provider")).toBe(workosProvider);
    });

    it("refuses a non-loopback redirect URI", async () => {
      const { app } = buildApp();
      for (const redirectUri of [
        "https://evil.example.com/callback",
        "http://synara.example.com/callback",
        "http://127.0.0.1.evil.example/callback",
        "not-a-url",
      ]) {
        const res = await postJson(
          app,
          "/api/v1/auth/authorize",
          authorizeBody({ redirectUri }),
          "203.0.113.52",
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "validation_failed" });
      }
    });

    it("exchanges a challenge-bound code for a token pair", async () => {
      const { app } = buildApp();
      const code = workos.issueAuthorizationCode("pkce-user@example.com", {
        codeChallenge: codeChallenge(),
      });

      const res = await postJson(
        app,
        "/api/v1/auth/authorize/token",
        { code, codeVerifier: CODE_VERIFIER },
        "203.0.113.53",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        accessToken: string;
        refreshToken: string;
        user: { email: string };
      };
      expect(body.user.email).toBe("pkce-user@example.com");
      expect(body.accessToken.length).toBeGreaterThan(0);
      expect(body.refreshToken.length).toBeGreaterThan(0);
    });

    it("refuses a wrong verifier and spends the code doing so", async () => {
      const { app } = buildApp();
      const code = workos.issueAuthorizationCode("pkce-user2@example.com", {
        codeChallenge: codeChallenge(),
      });

      const wrong = await postJson(
        app,
        "/api/v1/auth/authorize/token",
        { code, codeVerifier: "wrong_verifier_wrong_verifier_wrong_verifie" },
        "203.0.113.54",
      );
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toMatchObject({ error: "invalid_verification_code" });

      // Single-use: the failed proof killed the code.
      const retry = await postJson(
        app,
        "/api/v1/auth/authorize/token",
        { code, codeVerifier: CODE_VERIFIER },
        "203.0.113.54",
      );
      expect(retry.status).toBe(401);
    });

    it("refuses a spent or unknown code with the no-leak error contract", async () => {
      const { app } = buildApp();
      const res = await postJson(
        app,
        "/api/v1/auth/authorize/token",
        { code: "authz_fake_never_issued", codeVerifier: CODE_VERIFIER },
        "203.0.113.55",
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as AccountErrorBody;
      expect(body.error).toBe("invalid_verification_code");
      // Neither credential may be echoed anywhere in the response.
      expect(JSON.stringify(body)).not.toContain("authz_fake_never_issued");
      expect(JSON.stringify(body)).not.toContain(CODE_VERIFIER);
    });
  });

  describe("POST /auth/refresh", () => {
    /** A signed-in user's refresh token, minted through the whole OTP flow. */
    async function mintedRefreshToken(app: Hono, ip: string): Promise<string> {
      const email = `refresh-${randomUUID()}@example.com`;
      await postJson(app, "/api/v1/auth/otp/send", { email }, ip);
      const live = workos.currentMagicAuth(email);
      if (!live) throw new Error("fake WorkOS minted no magic auth code");
      const res = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code: live.code },
        ip,
      );
      const body = (await res.json()) as { refreshToken: string };
      return body.refreshToken;
    }

    it("rotates the pair through the proxy and the old token dies", async () => {
      const { app } = buildApp();
      const refreshToken = await mintedRefreshToken(app, "203.0.113.70");

      const res = await postJson(app, "/api/v1/auth/refresh", { refreshToken }, "203.0.113.70");
      expect(res.status).toBe(200);
      const rotated = (await res.json()) as { accessToken: string; refreshToken: string };
      expect(rotated.refreshToken).not.toBe(refreshToken);

      // Single-use upstream: replaying the spent token is a terminal refusal.
      const replay = await postJson(app, "/api/v1/auth/refresh", { refreshToken }, "203.0.113.70");
      expect(replay.status).toBe(401);
      expect(await replay.json()).toMatchObject({ error: "unauthorized" });

      // And the rotated pair keeps working.
      const again = await postJson(
        app,
        "/api/v1/auth/refresh",
        { refreshToken: rotated.refreshToken },
        "203.0.113.70",
      );
      expect(again.status).toBe(200);
    });

    it("scopes the new token to the named workspace", async () => {
      const { app } = buildApp();
      // A user with a real membership: the fake refuses a refresh into a
      // workspace the user does not belong to, exactly as the provider does.
      const fresh = workos.addUser({});
      const org = workos.addOrganization({ name: "Scoped Workspace" });
      workos.addMembership(org.id, fresh.id);
      const email = fresh.email;
      await postJson(app, "/api/v1/auth/otp/send", { email }, "203.0.113.72");
      const live = workos.currentMagicAuth(email);
      if (!live) throw new Error("fake WorkOS minted no magic auth code");
      const authed = await postJson(
        app,
        "/api/v1/auth/otp/authenticate",
        { email, code: live.code },
        "203.0.113.72",
      );
      const tokens = (await authed.json()) as { refreshToken: string };

      const res = await postJson(
        app,
        "/api/v1/auth/refresh",
        { refreshToken: tokens.refreshToken, organizationId: org.id },
        "203.0.113.72",
      );
      expect(res.status).toBe(200);
      const scoped = (await res.json()) as { accessToken: string; organizationId?: string };

      // The scoped token reaches the host routes without the 403 dance.
      const hosts = await app.request("/api/v1/hosts", {
        headers: authHeaders(scoped.accessToken),
      });
      expect(hosts.status).toBe(200);
    });

    it("refuses a workspace the user does not belong to as a dead session", async () => {
      const { app } = buildApp();
      const refreshToken = await mintedRefreshToken(app, "203.0.113.73");
      const stranger = workos.addOrganization({ name: "Not Yours" });

      const res = await postJson(
        app,
        "/api/v1/auth/refresh",
        { refreshToken, organizationId: stranger.id },
        "203.0.113.73",
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
    });

    it("refuses a body without a refresh token, without echoing anything", async () => {
      const { app } = buildApp();
      const res = await postJson(app, "/api/v1/auth/refresh", {}, "203.0.113.74");
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "validation_failed",
        message: "A refresh token is required",
      });
    });

    it("rate limits refreshes on their own budget", async () => {
      const { app } = buildApp();
      const ip = "203.0.113.75";

      for (let attempt = 0; attempt < REFRESH_RATE_LIMIT_PER_MINUTE; attempt += 1) {
        // Budget consumption happens before the grant, so a garbage token is
        // enough to spend it.
        const res = await postJson(app, "/api/v1/auth/refresh", { refreshToken: "rt_x" }, ip);
        expect([401, 502]).toContain(res.status);
      }
      const limited = await postJson(app, "/api/v1/auth/refresh", { refreshToken: "rt_x" }, ip);
      expect(limited.status).toBe(429);

      // Exhausting refresh must not lock the same client out of sending a
      // fresh sign-in code.
      const send = await postJson(
        app,
        "/api/v1/auth/otp/send",
        { email: `after-refresh-${randomUUID()}@example.com` },
        ip,
      );
      expect(send.status).toBe(202);
    });
  });
});
