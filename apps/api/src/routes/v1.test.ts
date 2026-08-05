import { randomUUID } from "node:crypto";
import type { AccountErrorBody } from "@synara/contracts";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiConfig } from "../config";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { startFakeWorkos, type FakeWorkos } from "../testing/fakeWorkos";
import { createWorkosAuth } from "../workos";
import { createV1Routes } from "./v1";

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

  /** A signed-in user: a WorkOS user record plus an access token naming it. */
  async function signIn(): Promise<{ token: string; userId: string }> {
    const user = workos.addUser({ first_name: "Test", last_name: "User" });
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

  it("returns the WorkOS profile from /me", async () => {
    const { app } = buildApp();
    const user = workos.addUser({
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      profile_picture_url: "https://cdn.example.com/ada.png",
    });
    const token = await workos.signAccessToken({ sub: user.id, sid: `session_${randomUUID()}` });

    const res = await app.request("/api/v1/me", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: user.id,
      name: "Ada Lovelace",
      email: "ada@example.com",
      image: "https://cdn.example.com/ada.png",
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

  it("returns 502 in the error contract when the identity provider fails", async () => {
    const { db } = buildApp();
    // Point at a closed port so the user lookup fails as a transport error
    // rather than a 404 — the upstream-fault branch, not the deleted-user one.
    const brokenConfig: ApiConfig = { ...config, workosApiUrl: "http://127.0.0.1:1" };
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

    const res = await app.request("/api/v1/me", { headers: authHeaders(token) });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ error: "internal_error" });
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

  it("isolates hosts across users: list is empty and delete 404s", async () => {
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

  it("reports instance info without authentication", async () => {
    const { app } = buildApp();

    const res = await app.request("/api/v1/instance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBeTruthy();
  });
});
