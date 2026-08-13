import { randomUUID } from "node:crypto";
import {
  GRANT_JWT_TYP,
  GRANT_MAX_AGE_SECONDS,
  GrantClaims,
  type HostPublicKeyJwk,
  RELAY_TICKET_JWT_TYP,
  RELAY_TICKET_MAX_AGE_SECONDS,
  RelayTicketClaims,
} from "@synara/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { Schema } from "effect";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkosApiConfig } from "../config";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { hosts, linkChallenges, revocationEvents } from "../db/schema";
import { createDeviceRegistry } from "../identity/deviceRegistry";
import { createHostGrantIssuer } from "../identity/grantIssuer";
import { createHostKeyRegistry } from "../identity/hostKeyRegistry";
import { createHostSecretStore } from "../identity/hostSecretStore";
import { clearOrgCache } from "../identity/orgProvisioning";
import { createRevocationLog, REVOCATION_RETENTION_MS } from "../identity/revocationLog";
import { createApiSigningService, type ApiSigningService } from "../identity/signing";
import { createWorkosIdentityProvider } from "../identity/workos";
import { startFakeWorkos, type FakeWorkos } from "../testing/fakeWorkos";
import { createInternalRoutes, createV1Routes, LINK_APPROVE_RATE_LIMIT_PER_MINUTE } from "./v1";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

type Session = { token: string; userId: string; orgId: string };
type HostKeyPair = GenerateKeyPairResult & { publicJwk: HostPublicKeyJwk };

const authHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

describe.skipIf(!TEST_DATABASE_URL)("Slice A host account API", () => {
  const databaseUrl = TEST_DATABASE_URL as string;
  let pool: ReturnType<typeof createDb>["pool"];
  let workos: FakeWorkos;
  let config: WorkosApiConfig;
  let signing: ApiSigningService;

  async function signIn(existing?: { userId: string; orgId: string }): Promise<Session> {
    const user = existing ? workos.addUser({ id: existing.userId }) : workos.addUser({});
    const org = existing
      ? workos.addOrganization({ id: existing.orgId })
      : workos.addOrganization({ name: `Workspace ${user.id}` });
    workos.addMembership(org.id, user.id);
    return {
      userId: user.id,
      orgId: org.id,
      token: await workos.signAccessToken({ sub: user.id, sid: randomUUID(), orgId: org.id }),
    };
  }

  async function teammate(owner: Session): Promise<Session> {
    const user = workos.addUser({});
    workos.addMembership(owner.orgId, user.id);
    return {
      userId: user.id,
      orgId: owner.orgId,
      token: await workos.signAccessToken({
        sub: user.id,
        sid: randomUUID(),
        orgId: owner.orgId,
      }),
    };
  }

  function buildApp() {
    const { db } = createDb(databaseUrl);
    const { verifier, grants } = createWorkosIdentityProvider(config);
    const app = new Hono();
    const revocations = createRevocationLog(db);
    app.route(
      "/api/v1",
      createV1Routes({
        verifier,
        grants,
        signing,
        hostKeys: createHostKeyRegistry(db, config.apiPublicUrl),
        devices: createDeviceRegistry(db, config.apiPublicUrl),
        hostGrants: createHostGrantIssuer(signing),
        hostSecrets: createHostSecretStore(db),
        accountBaseUrl: config.baseUrl,
        relayServiceToken: config.relayServiceToken,
        db,
        trustedProxyHops: 1,
      }),
    );
    app.route(
      "/internal",
      createInternalRoutes({ revocations, relayServiceToken: config.relayServiceToken }),
    );
    return { app, db };
  }

  async function hostKeyPair(): Promise<HostKeyPair> {
    const keys = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    return {
      ...keys,
      publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x as string },
    };
  }

  async function linkProof(
    key: HostKeyPair,
    challenge: { challengeId: string; nonce: string },
    environmentId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      publicKeyJwk: key.publicJwk,
      name: "Linked host",
      platform: "darwin",
      ...overrides,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "synara-host-link+jwt" })
      .setIssuer(`synara-host:${environmentId}`)
      .setSubject(environmentId)
      .setAudience(config.apiPublicUrl)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(key.privateKey);
  }

  async function hostProof(
    key: HostKeyPair,
    host: { id: string; environmentId: string; keyGeneration: number },
    overrides: {
      audience?: string;
      issuedAt?: number;
      expiresAt?: number;
      keyGeneration?: number;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ keyGeneration: overrides.keyGeneration ?? host.keyGeneration })
      .setProtectedHeader({ alg: "EdDSA", typ: "synara-host-proof+jwt" })
      .setIssuer(`synara-host:${host.environmentId}`)
      .setSubject(host.id)
      .setAudience(overrides.audience ?? config.apiPublicUrl)
      .setIssuedAt(overrides.issuedAt ?? now)
      .setExpirationTime(overrides.expiresAt ?? now + 60)
      .setJti(randomUUID())
      .sign(key.privateKey);
  }

  async function linkHost(
    app: Hono,
    owner: Session,
    options: { environmentId?: string; key?: HostKeyPair } = {},
  ) {
    const environmentId = options.environmentId ?? randomUUID();
    const key = options.key ?? (await hostKeyPair());
    const start = await app.request("/api/v1/hosts/link/start", {
      method: "POST",
      headers: authHeaders(owner.token),
      body: JSON.stringify(
        options.environmentId === undefined
          ? {}
          : {
              environmentId,
              name: "Started host",
              platform: "darwin",
              kind: "local",
            },
      ),
    });
    expect(start.status).toBe(201);
    const challenge = (await start.json()) as {
      challengeId: string;
      nonce: string;
      hostId?: string;
    };
    const complete = await app.request("/api/v1/hosts/link/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        proof: await linkProof(key, challenge, environmentId),
      }),
    });
    expect(complete.status).toBe(200);
    const body = (await complete.json()) as {
      host: { id: string; environmentId: string; keyGeneration: number; linked: boolean };
    };
    return { ...body.host, key, challenge };
  }

  async function deviceProof(
    key: GenerateKeyPairResult,
    userId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const publicKeyJwk = await exportJWK(key.publicKey);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      publicKeyJwk,
      displayName: "Test device",
      platform: "ios",
      ...overrides,
    })
      .setProtectedHeader({
        alg: publicKeyJwk.kty === "EC" ? "ES256" : "EdDSA",
        typ: "synara-device-register+jwt",
      })
      .setIssuer("synara-device")
      .setSubject(userId)
      .setAudience(config.apiPublicUrl)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomUUID())
      .sign(key.privateKey);
  }

  async function registerDevice(app: Hono, session: Session, suppliedKey?: GenerateKeyPairResult) {
    const key = suppliedKey ?? (await generateKeyPair("ES256", { extractable: true }));
    const response = await app.request("/api/v1/devices", {
      method: "POST",
      headers: authHeaders(session.token),
      body: JSON.stringify({ proof: await deviceProof(key, session.userId) }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { device: { id: string; jkt: string } };
    return { ...body.device, key };
  }

  beforeAll(async () => {
    await runMigrations(databaseUrl);
    workos = await startFakeWorkos();
    config = workos.config({ databaseUrl });
    signing = await createApiSigningService({
      issuer: config.apiPublicUrl,
      seed: config.apiSigningKey,
    });
    pool = createDb(databaseUrl).pool;
  });

  afterAll(async () => {
    await pool.end();
    await workos.close();
  });

  beforeEach(() => clearOrgCache());

  describe("1. link", () => {
    it("links with both bound and host-reported environment ids", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const boundId = randomUUID();
      const bound = await linkHost(app, owner, { environmentId: boundId });
      const unbound = await linkHost(app, owner);
      expect(bound).toMatchObject({ environmentId: boundId, keyGeneration: 1, linked: true });
      expect(unbound).toMatchObject({ keyGeneration: 1, linked: true });
    });

    it("consumes a challenge atomically so a double complete has one winner", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const environmentId = randomUUID();
      const key = await hostKeyPair();
      const start = await app.request("/api/v1/hosts/link/start", {
        method: "POST",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ environmentId, name: "Race", platform: "linux", kind: "local" }),
      });
      const challenge = (await start.json()) as { challengeId: string; nonce: string };
      const body = JSON.stringify({
        challengeId: challenge.challengeId,
        proof: await linkProof(key, challenge, environmentId),
      });
      const complete = () =>
        app.request("/api/v1/hosts/link/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
      const statuses = (await Promise.all([complete(), complete()])).map(
        (response) => response.status,
      );
      expect(statuses.toSorted()).toEqual([200, 409]);
    });

    it("burns bad signatures and nonce mismatches and classifies expired challenges", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      for (const failure of ["bad-signature", "bad-nonce", "expired"] as const) {
        const environmentId = randomUUID();
        const key = await hostKeyPair();
        const start = await app.request("/api/v1/hosts/link/start", {
          method: "POST",
          headers: authHeaders(owner.token),
          body: JSON.stringify({ environmentId, name: "Bad", platform: "darwin", kind: "local" }),
        });
        const challenge = (await start.json()) as { challengeId: string; nonce: string };
        if (failure === "expired") {
          await db
            .update(linkChallenges)
            .set({ expiresAt: new Date(Date.now() - 1) })
            .where(eq(linkChallenges.id, challenge.challengeId));
        }
        const signingKey = failure === "bad-signature" ? await hostKeyPair() : key;
        const proof = await linkProof(signingKey, challenge, environmentId, {
          ...(failure === "bad-nonce" ? { nonce: "wrong" } : {}),
          publicKeyJwk: key.publicJwk,
        });
        const response = await app.request("/api/v1/hosts/link/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challengeId: challenge.challengeId, proof }),
        });
        expect(response.status).toBe(failure === "expired" ? 400 : 401);
      }
    });

    it("refuses same-org takeover without changing the victim generation", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const environmentId = randomUUID();
      const victim = await linkHost(app, owner, { environmentId });
      const response = await app.request("/api/v1/hosts/link/start", {
        method: "POST",
        headers: authHeaders(member.token),
        body: JSON.stringify({ environmentId, name: "Takeover", platform: "linux", kind: "local" }),
      });
      expect(response.status).toBe(409);
      const [row] = await db.select().from(hosts).where(eq(hosts.id, victim.id));
      expect(row?.keyGeneration).toBe(victim.keyGeneration);
    });

    it("relink bumps generation and invalidates the old HostProof", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const environmentId = randomUUID();
      const first = await linkHost(app, owner, { environmentId });
      const oldProof = await hostProof(first.key, first);
      const nextKey = await hostKeyPair();
      // The start contract makes metadata optional. An existing row already
      // has it, so an owner may relink by environment id alone.
      const start = await app.request("/api/v1/hosts/link/start", {
        method: "POST",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ environmentId }),
      });
      expect(start.status).toBe(201);
      const challenge = (await start.json()) as { challengeId: string; nonce: string };
      const complete = await app.request("/api/v1/hosts/link/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          proof: await linkProof(nextKey, challenge, environmentId),
        }),
      });
      expect(complete.status).toBe(200);
      const second = (await complete.json()) as {
        host: { id: string; environmentId: string; keyGeneration: number };
      };
      expect(second.host.keyGeneration).toBe(first.keyGeneration + 1);
      expect(
        (
          await app.request(`/api/v1/hosts/${first.id}/relay-ticket`, {
            method: "POST",
            headers: { authorization: `HostProof ${oldProof}` },
          })
        ).status,
      ).toBe(401);
    });

    it("re-linking the same environment under another of the OWNER's orgs sweeps their old row", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const secondOrg = workos.addOrganization({ name: "Second workspace" });
      workos.addMembership(secondOrg.id, owner.userId);
      const ownerInSecondOrg: Session = {
        userId: owner.userId,
        orgId: secondOrg.id,
        token: await workos.signAccessToken({
          sub: owner.userId,
          sid: randomUUID(),
          orgId: secondOrg.id,
        }),
      };
      const environmentId = randomUUID();
      const first = await linkHost(app, owner, { environmentId });
      await linkHost(app, ownerInSecondOrg, { environmentId });
      const [old] = await db.select().from(hosts).where(eq(hosts.id, first.id));
      expect(old).toMatchObject({ publicKeyJwk: null, discoverable: false });
      expect(
        await db
          .select()
          .from(revocationEvents)
          .where(
            and(eq(revocationEvents.hostId, first.id), eq(revocationEvents.kind, "host_unlinked")),
          ),
      ).toHaveLength(1);
    });

    it("linking an environmentId NEVER touches another user's rows (no cross-user unlink DoS)", async () => {
      // environmentId is self-asserted in the proof and visible to org
      // members via GET /hosts. If the one-slot sweep crossed user
      // boundaries, anyone could force-unlink a victim's host by linking a
      // machine that merely claims the victim's environmentId.
      const { app, db } = buildApp();
      const victim = await signIn();
      const attacker = await signIn();
      const environmentId = randomUUID();
      const victimHost = await linkHost(app, victim, { environmentId });
      await linkHost(app, attacker, { environmentId });
      const [untouched] = await db.select().from(hosts).where(eq(hosts.id, victimHost.id));
      expect(untouched?.publicKeyJwk).not.toBeNull();
      expect(untouched).toMatchObject({ discoverable: true, ownerUserId: victim.userId });
      expect(
        await db.select().from(revocationEvents).where(eq(revocationEvents.hostId, victimHost.id)),
      ).toHaveLength(0);
    });
  });

  describe("2. device code", () => {
    it("mints, waits for approval, delivers once, and completes through the common proof", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const minted = await app.request("/api/v1/hosts/link/device", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      const code = (await minted.json()) as {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        interval: number;
      };
      expect(code.verificationUri).toBe(new URL("/link", config.baseUrl).toString());
      const tokenRequest = () =>
        app.request("/api/v1/hosts/link/device/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: code.deviceCode }),
        });
      expect((await tokenRequest()).status).toBe(428);
      expect(
        (
          await app.request("/api/v1/hosts/link/approve", {
            method: "POST",
            headers: { ...authHeaders(owner.token), "x-forwarded-for": "203.0.113.11" },
            body: JSON.stringify({ userCode: code.userCode }),
          })
        ).status,
      ).toBe(204);
      const delivered = await tokenRequest();
      expect(delivered.status).toBe(200);
      expect((await tokenRequest()).status).toBe(409);
      const challenge = (await delivered.json()) as { challengeId: string; nonce: string };
      const environmentId = randomUUID();
      const key = await hostKeyPair();
      const complete = await app.request("/api/v1/hosts/link/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          proof: await linkProof(key, challenge, environmentId),
        }),
      });
      expect(complete.status).toBe(200);
      expect(code.interval).toBe(5);
    });

    it("rejects expired codes and rate-limits user-code guessing", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const minted = await app.request("/api/v1/hosts/link/device", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.12" },
      });
      const code = (await minted.json()) as { deviceCode: string; userCode: string };
      await db
        .update(linkChallenges)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(linkChallenges.userCode, code.userCode));
      const expired = await app.request("/api/v1/hosts/link/approve", {
        method: "POST",
        headers: { ...authHeaders(owner.token), "x-forwarded-for": "203.0.113.13" },
        body: JSON.stringify({ userCode: code.userCode }),
      });
      expect(expired.status).toBe(400);

      for (let attempt = 0; attempt < LINK_APPROVE_RATE_LIMIT_PER_MINUTE; attempt += 1) {
        await app.request("/api/v1/hosts/link/approve", {
          method: "POST",
          headers: { ...authHeaders(owner.token), "x-forwarded-for": "203.0.113.14" },
          body: JSON.stringify({ userCode: "AAAAAAAA" }),
        });
      }
      expect(
        (
          await app.request("/api/v1/hosts/link/approve", {
            method: "POST",
            headers: { ...authHeaders(owner.token), "x-forwarded-for": "203.0.113.14" },
            body: JSON.stringify({ userCode: "BBBBBBBB" }),
          })
        ).status,
      ).toBe(429);
    });

    it("reserves unique user codes among live challenges", async () => {
      const { app } = buildApp();
      const codes = await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          const response = await app.request("/api/v1/hosts/link/device", {
            method: "POST",
            headers: { "x-forwarded-for": `203.0.114.${index + 1}` },
          });
          return ((await response.json()) as { userCode: string }).userCode;
        }),
      );
      expect(new Set(codes).size).toBe(codes.length);
    });
  });

  describe("3. HostProof", () => {
    it("accepts valid proof and rejects stale expiry, audience, generation, and unlink", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const valid = await hostProof(host.key, host);
      expect(
        await Promise.all(
          [0, 1].map(
            async () =>
              (
                await app.request(`/api/v1/hosts/${host.id}/relay-ticket`, {
                  method: "POST",
                  headers: { authorization: `HostProof ${valid}` },
                })
              ).status,
          ),
        ),
      ).toEqual([200, 200]);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/endpoints`, {
            method: "PUT",
            headers: { authorization: `HostProof ${valid}`, "content-type": "application/json" },
            body: JSON.stringify({
              endpoints: [{ url: "http://192.168.1.10:48090", transport: "lan" }],
            }),
          })
        ).status,
      ).toBe(200);
      const ticketResponse = await app.request(`/api/v1/hosts/${host.id}/relay-ticket`, {
        method: "POST",
        headers: { authorization: `HostProof ${valid}` },
      });
      expect(ticketResponse.status).toBe(200);
      const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;
      const ticketPayload = await signing.verify(ticket, {
        typ: RELAY_TICKET_JWT_TYP,
        audience: "synara-relay",
        maxAgeSeconds: RELAY_TICKET_MAX_AGE_SECONDS,
      });
      expect(Schema.decodeUnknownSync(RelayTicketClaims)(ticketPayload)).toMatchObject({
        sub: host.id,
        environmentId: host.environmentId,
        keyGeneration: host.keyGeneration,
      });
      const authorization = await app.request(`/api/v1/hosts/${host.id}/authorization`, {
        headers: { authorization: `HostProof ${valid}` },
      });
      expect(await authorization.json()).toMatchObject({
        discoverable: true,
        ownerUserId: owner.userId,
        orgId: owner.orgId,
        ownerInOrg: true,
      });
      expect((await app.request(`/api/v1/hosts/${host.id}/authorization`)).status).toBe(401);
      const malformedSubject = await new SignJWT({ keyGeneration: host.keyGeneration })
        .setProtectedHeader({ alg: "EdDSA", typ: "synara-host-proof+jwt" })
        .setIssuer(`synara-host:${host.environmentId}`)
        .setSubject("not-a-uuid")
        .setAudience(config.apiPublicUrl)
        .setIssuedAt()
        .setExpirationTime("60s")
        .setJti(randomUUID())
        .sign(host.key.privateKey);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/relay-ticket`, {
            method: "POST",
            headers: { authorization: `HostProof ${malformedSubject}` },
          })
        ).status,
      ).toBe(401);
      const now = Math.floor(Date.now() / 1000);
      for (const proof of [
        await hostProof(host.key, host, { issuedAt: now - 122, expiresAt: now - 62 }),
        await hostProof(host.key, host, { audience: "https://wrong.example" }),
        await hostProof(host.key, host, { keyGeneration: host.keyGeneration - 1 }),
      ]) {
        expect(
          (
            await app.request(`/api/v1/hosts/${host.id}/relay-ticket`, {
              method: "POST",
              headers: { authorization: `HostProof ${proof}` },
            })
          ).status,
        ).toBe(401);
      }
      await db.update(hosts).set({ publicKeyJwk: null }).where(eq(hosts.id, host.id));
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/relay-ticket`, {
            method: "POST",
            headers: { authorization: `HostProof ${valid}` },
          })
        ).status,
      ).toBe(401);
    });
  });

  describe("4. devices", () => {
    it("registers, lists, and removes devices with an org-less user session", async () => {
      const { app } = buildApp();
      const user = workos.addUser({});
      const token = await workos.signAccessToken({ sub: user.id, sid: randomUUID() });
      const key = await generateKeyPair("ES256", { extractable: true });
      const registered = await app.request("/api/v1/devices", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ proof: await deviceProof(key, user.id) }),
      });
      expect(registered.status).toBe(201);
      const device = (await registered.json()) as { device: { id: string } };
      expect(
        (
          (await (
            await app.request("/api/v1/devices", { headers: authHeaders(token) })
          ).json()) as { devices: Array<{ id: string }> }
        ).devices,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: device.device.id })]));
      expect(
        (
          await app.request(`/api/v1/devices/${device.device.id}`, {
            method: "DELETE",
            headers: authHeaders(token),
          })
        ).status,
      ).toBe(204);
    });

    it("requires PoP, scopes identical jkt per user, and permits re-register after revoke", async () => {
      const { app } = buildApp();
      const a = await signIn();
      const b = await signIn();
      const key = await generateKeyPair("ES256", { extractable: true });
      const publicKeyJwk = await exportJWK(key.publicKey);
      const impostor = await generateKeyPair("ES256", { extractable: true });
      const bad = await app.request("/api/v1/devices", {
        method: "POST",
        headers: authHeaders(a.token),
        body: JSON.stringify({
          proof: await deviceProof(impostor, a.userId, { publicKeyJwk }),
        }),
      });
      expect(bad.status).toBe(401);
      const first = await registerDevice(app, a, key);
      expect(
        (
          (await (
            await app.request("/api/v1/devices", { headers: authHeaders(a.token) })
          ).json()) as { devices: Array<{ id: string; publicKeyJwk: unknown }> }
        ).devices,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, publicKeyJwk: expect.any(Object) }),
        ]),
      );
      expect(
        (
          await app.request(`/api/v1/devices/${first.id}`, {
            method: "DELETE",
            headers: authHeaders(b.token),
          })
        ).status,
      ).toBe(404);
      const second = await registerDevice(app, b, key);
      expect(second.id).not.toBe(first.id);
      expect(second.jkt).toBe(first.jkt);
      expect(
        (
          await app.request(`/api/v1/devices/${first.id}`, {
            method: "DELETE",
            headers: authHeaders(a.token),
          })
        ).status,
      ).toBe(204);
      const replacement = await registerDevice(app, a, key);
      expect(replacement.id).not.toBe(first.id);
      expect(replacement.jkt).toBe(first.jkt);
    });

    it("revocation over-notifies every host in the user's organizations", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const mate = await teammate(owner);
      const ownHost = await linkHost(app, owner, { environmentId: randomUUID() });
      const mateHost = await linkHost(app, mate, { environmentId: randomUUID() });
      const device = await registerDevice(app, owner);
      await app.request(`/api/v1/devices/${device.id}`, {
        method: "DELETE",
        headers: authHeaders(owner.token),
      });
      const events = await db
        .select()
        .from(revocationEvents)
        .where(
          and(
            inArray(revocationEvents.hostId, [ownHost.id, mateHost.id]),
            eq(revocationEvents.kind, "device_revoked"),
          ),
        );
      expect(new Set(events.map((event) => event.hostId))).toEqual(
        new Set([ownHost.id, mateHost.id]),
      );
    });
  });

  describe("5. grants", () => {
    it("issues owner and discoverable-member grants carrying the device cnf", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      for (const session of [owner, member]) {
        const device = await registerDevice(app, session);
        const response = await app.request(`/api/v1/hosts/${host.id}/grant`, {
          method: "POST",
          headers: authHeaders(session.token),
          body: JSON.stringify({ deviceJkt: device.jkt }),
        });
        expect(response.status).toBe(200);
        const { grant } = (await response.json()) as { grant: string };
        const payload = await signing.verify(grant, {
          typ: GRANT_JWT_TYP,
          audience: "synara-relay",
          maxAgeSeconds: GRANT_MAX_AGE_SECONDS,
        });
        expect(Schema.decodeUnknownSync(GrantClaims)(payload).cnf.jkt).toBe(device.jkt);
      }
    });

    it("refuses hidden/nonmember, unregistered/revoked, and unlinked combinations", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const outsider = await signIn();
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const memberDevice = await registerDevice(app, member);
      const outsiderDevice = await registerDevice(app, outsider);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(owner.token),
            body: JSON.stringify({ deviceJkt: memberDevice.jkt }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(owner.token),
            body: JSON.stringify({ deviceJkt: "not-registered" }),
          })
        ).status,
      ).toBe(403);
      // An outsider must not be able to tell a host they cannot see from one
      // that does not exist — the grant route answers 404, exactly like
      // requireHostOwner, so it is not an existence oracle.
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(outsider.token),
            body: JSON.stringify({ deviceJkt: outsiderDevice.jkt }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "PATCH",
            headers: authHeaders(owner.token),
            body: JSON.stringify({ discoverable: false }),
          })
        ).status,
      ).toBe(200);
      // Undiscoverable makes the host invisible to org-mates too: 404, not a
      // 403 that would confirm it exists.
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(member.token),
            body: JSON.stringify({ deviceJkt: memberDevice.jkt }),
          })
        ).status,
      ).toBe(404);
      await app.request(`/api/v1/devices/${memberDevice.id}`, {
        method: "DELETE",
        headers: authHeaders(member.token),
      });
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(member.token),
            body: JSON.stringify({ deviceJkt: memberDevice.jkt }),
          })
        ).status,
      ).toBe(404);
      const ownerDevice = await registerDevice(app, owner);
      await app.request(`/api/v1/hosts/${host.id}/unlink`, {
        method: "POST",
        headers: authHeaders(owner.token),
      });
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/grant`, {
            method: "POST",
            headers: authHeaders(owner.token),
            body: JSON.stringify({ deviceJkt: ownerDevice.jkt }),
          })
        ).status,
      ).toBe(409);
    });

    it("refuses a departed owner and lazily emits org_departure", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const device = await registerDevice(app, member);
      workos.removeMembership(owner.orgId, owner.userId);
      clearOrgCache();
      const response = await app.request(`/api/v1/hosts/${host.id}/grant`, {
        method: "POST",
        headers: authHeaders(member.token),
        body: JSON.stringify({ deviceJkt: device.jkt }),
      });
      expect(response.status).toBe(403);
      expect(
        await db
          .select()
          .from(revocationEvents)
          .where(
            and(eq(revocationEvents.hostId, host.id), eq(revocationEvents.kind, "org_departure")),
          ),
      ).not.toHaveLength(0);
    });

    it("does not mint across a concurrent device revoke or host unlink", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const device = await registerDevice(app, owner);
      const requestGrant = () =>
        app.request(`/api/v1/hosts/${host.id}/grant`, {
          method: "POST",
          headers: authHeaders(owner.token),
          body: JSON.stringify({ deviceJkt: device.jkt }),
        });

      const revoking = await pool.connect();
      try {
        await revoking.query("BEGIN");
        await revoking.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [device.id]);
        const pending = requestGrant();
        await Promise.resolve();
        await revoking.query("COMMIT");
        expect((await pending).status).toBe(403);
      } finally {
        await revoking.query("ROLLBACK").catch(() => {});
        revoking.release();
      }

      const replacement = await registerDevice(app, owner, device.key);
      const unlinking = await pool.connect();
      try {
        await unlinking.query("BEGIN");
        await unlinking.query("UPDATE hosts SET public_key_jwk = NULL WHERE id = $1", [host.id]);
        const pending = app.request(`/api/v1/hosts/${host.id}/grant`, {
          method: "POST",
          headers: authHeaders(owner.token),
          body: JSON.stringify({ deviceJkt: replacement.jkt }),
        });
        await Promise.resolve();
        await unlinking.query("COMMIT");
        expect((await pending).status).toBe(409);
      } finally {
        await unlinking.query("ROLLBACK").catch(() => {});
        unlinking.release();
      }
    });
  });

  describe("6. host management", () => {
    it("enforces visibility/owner writes and emits durable management events", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const outsider = await signIn();
      const host = await linkHost(app, owner, { environmentId: randomUUID() });
      const otherOrg = workos.addOrganization({ name: "Owner's other workspace" });
      workos.addMembership(otherOrg.id, owner.userId);
      const ownerOtherOrgToken = await workos.signAccessToken({
        sub: owner.userId,
        sid: randomUUID(),
        orgId: otherOrg.id,
      });
      clearOrgCache();
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(owner.token) })
          ).json()) as { hosts: Array<{ mine: boolean }> }
        ).hosts.find((entry) => entry.mine),
      ).toBeTruthy();
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(member.token) })
          ).json()) as { hosts: unknown[] }
        ).hosts,
      ).not.toHaveLength(0);
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(outsider.token) })
          ).json()) as { hosts: Array<{ id: string }> }
        ).hosts.find((entry) => entry.id === host.id),
      ).toBeUndefined();
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(ownerOtherOrgToken) })
          ).json()) as { hosts: Array<{ id: string; mine: boolean }> }
        ).hosts,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: host.id, mine: true })]));
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "PATCH",
            headers: authHeaders(member.token),
            body: JSON.stringify({ discoverable: false }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/unlink`, {
            method: "POST",
            headers: authHeaders(member.token),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "DELETE",
            headers: authHeaders(member.token),
          })
        ).status,
      ).toBe(403);
      await app.request(`/api/v1/hosts/${host.id}`, {
        method: "PATCH",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ discoverable: false }),
      });
      expect(
        (
          (await (
            await app.request("/api/v1/hosts", { headers: authHeaders(member.token) })
          ).json()) as { hosts: Array<{ id: string }> }
        ).hosts.find((entry) => entry.id === host.id),
      ).toBeUndefined();
      const selfProof = await hostProof(host.key, host);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}/unlink`, {
            method: "POST",
            headers: { authorization: `HostProof ${selfProof}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "DELETE",
            headers: authHeaders(owner.token),
          })
        ).status,
      ).toBe(204);
      const kinds = (
        await db.select().from(revocationEvents).where(eq(revocationEvents.hostId, host.id))
      ).map((event) => event.kind);
      // Multiplicity matters and arrayContaining ignores it: the unlink and
      // the delete must EACH emit host_unlinked, so a delete that silently
      // dropped its event would still satisfy a containment-only assertion.
      expect(kinds.filter((kind) => kind === "discoverability_off")).toHaveLength(1);
      expect(kinds.filter((kind) => kind === "host_unlinked")).toHaveLength(2);
      expect(await db.select().from(hosts).where(eq(hosts.id, host.id))).toHaveLength(0);
    });
  });

  describe("7. revocations feed", () => {
    it("authenticates the relay and re-delivers an out-of-order commit inside the lag window", async () => {
      const { app } = buildApp();
      const baselineResult = await pool.query<{ id: string }>(
        "SELECT COALESCE(MAX(id), 0)::text AS id FROM revocation_events",
      );
      const baseline = Number(baselineResult.rows[0]?.id ?? 0);
      expect((await app.request("/internal/revocations?after=0")).status).toBe(401);
      const lowerTransaction = await pool.connect();
      let committed = false;
      try {
        await lowerTransaction.query("BEGIN");
        const lower = await lowerTransaction.query<{ id: string }>(
          `INSERT INTO revocation_events (host_id, kind)
           VALUES ($1, 'host_unlinked') RETURNING id::text`,
          [randomUUID()],
        );
        const lowerId = Number(lower.rows[0]?.id);
        const higher = await pool.query<{ id: string }>(
          `INSERT INTO revocation_events (host_id, kind)
           VALUES ($1, 'device_revoked') RETURNING id::text`,
          [randomUUID()],
        );
        const higherId = Number(higher.rows[0]?.id);
        expect(lowerId).toBeLessThan(higherId);

        const first = await app.request(`/internal/revocations?after=${baseline}`, {
          headers: { authorization: `Bearer ${config.relayServiceToken}` },
        });
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as {
          events: Array<{ id: number }>;
          watermark: number;
        };
        expect(firstBody.events.map((event) => event.id)).toContain(higherId);
        expect(firstBody.events.map((event) => event.id)).not.toContain(lowerId);
        expect(firstBody.watermark).toBe(baseline);

        await lowerTransaction.query("COMMIT");
        committed = true;
        const trailing = await app.request(`/internal/revocations?after=${firstBody.watermark}`, {
          headers: { authorization: `Bearer ${config.relayServiceToken}` },
        });
        const trailingBody = (await trailing.json()) as {
          events: Array<{ id: number }>;
          watermark: number;
        };
        expect(trailingBody.events.map((event) => event.id)).toEqual(
          expect.arrayContaining([lowerId, higherId]),
        );
        // Once the straggler commits nothing can still land below higherId,
        // so the watermark advances immediately — no wall-clock wait.
        expect(trailingBody.watermark).toBe(higherId);
      } finally {
        if (!committed) await lowerTransaction.query("ROLLBACK");
        lowerTransaction.release();
      }
    });

    it("never skips an event whose writer transaction outlived any wall-clock window", async () => {
      // created_at defaults to now() = transaction START time. A writer that
      // blocks on a row lock for a minute inserts a row that is already
      // "old" by wall clock the moment it becomes visible. An age-based
      // watermark would have advanced past it while it was invisible and
      // lost it forever; the xmin boundary must hold the line instead.
      const { app } = buildApp();
      const baselineResult = await pool.query<{ id: string }>(
        "SELECT COALESCE(MAX(id), 0)::text AS id FROM revocation_events",
      );
      const baseline = Number(baselineResult.rows[0]?.id ?? 0);
      const slowWriter = await pool.connect();
      let committed = false;
      try {
        await slowWriter.query("BEGIN");
        // Age the transaction clock well past any lag window before inserting.
        await slowWriter.query("SELECT pg_sleep(0.05)");
        const slow = await slowWriter.query<{ id: string }>(
          `INSERT INTO revocation_events (host_id, kind, created_at)
           VALUES ($1, 'host_unlinked', now() - interval '10 minutes') RETURNING id::text`,
          [randomUUID()],
        );
        const slowId = Number(slow.rows[0]?.id);
        const fast = await pool.query<{ id: string }>(
          `INSERT INTO revocation_events (host_id, kind)
           VALUES ($1, 'device_revoked') RETURNING id::text`,
          [randomUUID()],
        );
        const fastId = Number(fast.rows[0]?.id);

        const poll = await app.request(`/internal/revocations?after=${baseline}`, {
          headers: { authorization: `Bearer ${config.relayServiceToken}` },
        });
        const body = (await poll.json()) as { events: Array<{ id: number }>; watermark: number };
        expect(body.events.map((event) => event.id)).not.toContain(slowId);
        // The decisive assertion: the visible fast row looks committed, but
        // the invisible slow row holds a LOWER id, so the watermark must not
        // pass it despite the slow row's ten-minute-old created_at.
        expect(body.watermark).toBeLessThan(slowId);

        await slowWriter.query("COMMIT");
        committed = true;
        const after = await app.request(`/internal/revocations?after=${body.watermark}`, {
          headers: { authorization: `Bearer ${config.relayServiceToken}` },
        });
        const afterBody = (await after.json()) as {
          events: Array<{ id: number }>;
          watermark: number;
        };
        expect(afterBody.events.map((event) => event.id)).toEqual(
          expect.arrayContaining([slowId, fastId]),
        );
        expect(afterBody.watermark).toBe(fastId);
      } finally {
        if (!committed) await slowWriter.query("ROLLBACK");
        slowWriter.release();
      }
    });

    it("cleans events older than 24 hours on read, never on write", async () => {
      // Retention lives on the poll path: writers hold host row locks and
      // must not pay (or serialize behind) a backlog sweep.
      const { db } = buildApp();
      const log = createRevocationLog(db);
      const oldHost = randomUUID();
      await db.insert(revocationEvents).values({
        hostId: oldHost,
        kind: "host_unlinked",
        createdAt: new Date(Date.now() - REVOCATION_RETENTION_MS - 1),
      });
      await log.record(randomUUID(), "host_unlinked");
      expect(
        await db.select().from(revocationEvents).where(eq(revocationEvents.hostId, oldHost)),
      ).toHaveLength(1);
      await log.read(0);
      expect(
        await db.select().from(revocationEvents).where(eq(revocationEvents.hostId, oldHost)),
      ).toHaveLength(0);
    });
  });

  describe("8. JWKS", () => {
    it("serves a stable current kid and the configured previous key publicly", async () => {
      const { db } = buildApp();
      const rotated = await createApiSigningService({
        issuer: config.apiPublicUrl,
        seed: config.apiSigningKey,
        previousSeed: Buffer.alloc(32, 2).toString("base64url"),
      });
      const { verifier, grants } = createWorkosIdentityProvider(config);
      const app = new Hono();
      app.route(
        "/api/v1",
        createV1Routes({
          verifier,
          grants,
          signing: rotated,
          hostKeys: createHostKeyRegistry(db, config.apiPublicUrl),
          devices: createDeviceRegistry(db, config.apiPublicUrl),
          hostGrants: createHostGrantIssuer(rotated),
          hostSecrets: createHostSecretStore(db),
          accountBaseUrl: config.baseUrl,
          relayServiceToken: config.relayServiceToken,
          db,
        }),
      );
      const response = await app.request("/api/v1/keys/jwks");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { keys: Array<{ kid: string }> };
      expect(body.keys).toHaveLength(2);
      expect(body.keys[0]?.kid).toBe(signing.currentKid);
    });
  });

  describe("9. cutover", () => {
    it("removes legacy registration and rejects synhost bearer credentials", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const registered = await app.request("/api/v1/hosts", {
        method: "POST",
        headers: authHeaders(owner.token),
        body: JSON.stringify({
          environmentId: randomUUID(),
          name: "Legacy",
          platform: "darwin",
          kind: "local",
          endpoints: [],
        }),
      });
      expect(registered.status).toBe(404);
      expect(
        (
          await app.request(`/api/v1/hosts/${randomUUID()}`, {
            method: "PATCH",
            headers: authHeaders("synhost_removed"),
            body: JSON.stringify({ name: "Must not apply" }),
          })
        ).status,
      ).toBe(401);
    });

    it("does not let an org-mate relink the owner's environment", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const environmentId = randomUUID();
      const host = await linkHost(app, owner, { environmentId });
      const takeover = await app.request("/api/v1/hosts/link/start", {
        method: "POST",
        headers: authHeaders(member.token),
        body: JSON.stringify({
          environmentId,
          name: "Legacy takeover",
          platform: "darwin",
          kind: "local",
        }),
      });
      expect(takeover.status).toBe(409);
      expect(
        (
          await app.request(`/api/v1/hosts/${host.id}`, {
            method: "DELETE",
            headers: authHeaders(member.token),
          })
        ).status,
      ).toBe(403);
    });
  });
});
