import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../auth";
import type { ApiConfig } from "../config";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { createV1Routes } from "./v1";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function uniqueEmail(): string {
  return `${randomUUID()}@x.com`;
}

// BetterAuth's built-in rate limiter buckets by client IP; the test harness
// has no real IP, so each sign-up/sign-in round trip gets a distinct
// `x-forwarded-for` to avoid cross-test 429s on a shared bucket.
let nextFakeIpSuffix = 1;
function uniqueIp(): string {
  const n = nextFakeIpSuffix++;
  return `10.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
}

async function signUpAndGetToken(
  app: Hono,
  email: string,
): Promise<{ token: string; userId: string }> {
  const ip = uniqueIp();
  await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password: "hunter2hunter2", name: "Test User" }),
  });
  const signInRes = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  const signInBody = (await signInRes.json()) as { token: string; user: { id: string } };
  return { token: signInBody.token, userId: signInBody.user.id };
}

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

  const baseConfig: ApiConfig = {
    databaseUrl,
    baseUrl: "http://localhost:8788",
    authSecret: "s".repeat(32),
    port: 8788,
    providers: {},
  };

  async function buildApp() {
    const { db } = createDb(databaseUrl);
    const auth = createAuth(baseConfig, db);
    const app = new Hono();
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    app.route("/api/v1", createV1Routes({ auth, db, config: baseConfig }));
    return { app, auth, db };
  }

  beforeAll(async () => {
    await runMigrations(databaseUrl);
    const created = createDb(databaseUrl);
    pool = created.pool;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects unauthenticated requests to /me and /hosts", async () => {
    const { app } = await buildApp();

    const meRes = await app.request("/api/v1/me");
    expect(meRes.status).toBe(401);
    expect(await meRes.json()).toMatchObject({ error: "unauthorized" });

    const hostsRes = await app.request("/api/v1/hosts");
    expect(hostsRes.status).toBe(401);
  });

  it("registers a host and lists it back", async () => {
    const { app } = await buildApp();
    const email = uniqueEmail();
    const { token } = await signUpAndGetToken(app, email);
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
    const { app } = await buildApp();
    const email = uniqueEmail();
    const { token } = await signUpAndGetToken(app, email);
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
    const { app } = await buildApp();
    const email = uniqueEmail();
    const { token } = await signUpAndGetToken(app, email);
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
    const { app } = await buildApp();
    const email = uniqueEmail();
    const { token } = await signUpAndGetToken(app, email);

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

  it("isolates hosts across users: list is empty and delete 404s", async () => {
    const { app } = await buildApp();
    const ownerToken = (await signUpAndGetToken(app, uniqueEmail())).token;
    const otherToken = (await signUpAndGetToken(app, uniqueEmail())).token;

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
  });

  it("deletes a host and its token with the device token", async () => {
    const { app } = await buildApp();
    const { token } = await signUpAndGetToken(app, uniqueEmail());

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
    const { app } = await buildApp();
    const { token } = await signUpAndGetToken(app, uniqueEmail());

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

  it("lists and revokes device sessions", async () => {
    const { app } = await buildApp();
    const email = uniqueEmail();
    // Signing up auto-creates a session, so this account already has one
    // before the explicit sign-in below.
    const { token: firstToken } = await signUpAndGetToken(app, email);

    const secondSignIn = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": uniqueIp() },
      body: JSON.stringify({ email, password: "hunter2hunter2" }),
    });
    const secondSignInBody = (await secondSignIn.json()) as { token: string };

    const listRes = await app.request("/api/v1/sessions", { headers: authHeaders(firstToken) });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    expect(listBody.sessions.length).toBeGreaterThanOrEqual(3);
    expect(listBody.sessions.some((s) => s.current)).toBe(true);

    const nonCurrent = listBody.sessions.filter((s) => !s.current);
    expect(nonCurrent.length).toBeGreaterThanOrEqual(2);

    for (const s of nonCurrent) {
      const revokeRes = await app.request(`/api/v1/sessions/${s.id}`, {
        method: "DELETE",
        headers: authHeaders(firstToken),
      });
      expect(revokeRes.status).toBe(204);
    }

    const listAfterRevoke = await app.request("/api/v1/sessions", {
      headers: authHeaders(firstToken),
    });
    const listAfterRevokeBody = (await listAfterRevoke.json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(listAfterRevokeBody.sessions).toHaveLength(1);

    // secondSignIn's session was among those revoked; it must stop authenticating.
    const secondMeAfter = await app.request("/api/v1/me", {
      headers: authHeaders(secondSignInBody.token),
    });
    expect(secondMeAfter.status).toBe(401);

    // The current (firstToken) session is untouched.
    const meAfterRevoke = await app.request("/api/v1/me", { headers: authHeaders(firstToken) });
    expect(meAfterRevoke.status).toBe(200);
  });

  it("reports instance info without authentication", async () => {
    const { app } = await buildApp();

    const res = await app.request("/api/v1/instance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      authMethods: { emailPassword: boolean; social: string[] };
      emailDelivery: boolean;
      signupRestricted: boolean;
    };
    expect(body.version).toBeTruthy();
    expect(body.authMethods.emailPassword).toBe(true);
    expect(body.authMethods.social).toEqual([]);
    expect(body.emailDelivery).toBe(false);
    expect(body.signupRestricted).toBe(false);
  });
});
