import { randomUUID } from "node:crypto";
import {
  HOST_SECRET_HISTORY_LIMIT,
  type HostPublicKeyJwk,
  type SyncKeyWrap,
} from "@synara/contracts";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkosApiConfig } from "../config";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { hostSecretVersions, hostSecrets, hosts, syncKeyWraps } from "../db/schema";
import { createDeviceRegistry } from "../identity/deviceRegistry";
import { createHostGrantIssuer } from "../identity/grantIssuer";
import { createHostKeyRegistry } from "../identity/hostKeyRegistry";
import { createHostSecretStore, SYNC_KEY_WRAP_TTL_MS } from "../identity/hostSecretStore";
import { clearOrgCache } from "../identity/orgProvisioning";
import { createApiSigningService, type ApiSigningService } from "../identity/signing";
import { createWorkosIdentityProvider } from "../identity/workos";
import { startFakeWorkos, type FakeWorkos } from "../testing/fakeWorkos";
import { createV1Routes } from "./v1";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

type Session = { token: string; userId: string; orgId: string };
type HostKeyPair = GenerateKeyPairResult & { publicJwk: HostPublicKeyJwk };

const authHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

/**
 * A stand-in for real ciphertext. Deliberately NOT produced by
 * `sealHostSecret`: these tests assert that the API stores and returns
 * whatever bytes it is handed, so using a value the service could not
 * possibly interpret is the point — if a round trip ever mangled it, no
 * amount of correct crypto elsewhere would save the stored config.
 */
function opaqueCiphertext(seed: string): string {
  return Buffer.from(`ciphertext:${seed}:${randomUUID()}`).toString("base64url");
}

/** Base64url of exactly 12 bytes, the width sealHostSecret emits. */
function opaqueIv(): string {
  return Buffer.from(randomUUID().replaceAll("-", "").slice(0, 24), "hex").toString("base64url");
}

function envelope(version: number, seed = "v") {
  return { ciphertext: opaqueCiphertext(`${seed}${version}`), iv: opaqueIv(), version };
}

describe.skipIf(!TEST_DATABASE_URL)("Slice E host secrets API", () => {
  const databaseUrl = TEST_DATABASE_URL as string;
  let pool: ReturnType<typeof createDb>["pool"];
  let workos: FakeWorkos;
  let config: WorkosApiConfig;
  let signing: ApiSigningService;

  async function signIn(): Promise<Session> {
    const user = workos.addUser({});
    const org = workos.addOrganization({ name: `Workspace ${user.id}` });
    workos.addMembership(org.id, user.id);
    return {
      userId: user.id,
      orgId: org.id,
      token: await workos.signAccessToken({ sub: user.id, sid: randomUUID(), orgId: org.id }),
    };
  }

  /** A second member of the SAME workspace — the org-mate opacity case. */
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
    return { app, db };
  }

  async function hostKeyPair(): Promise<HostKeyPair> {
    const keys = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    return { ...keys, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x as string } };
  }

  async function linkHost(app: Hono, owner: Session): Promise<{ id: string }> {
    const environmentId = randomUUID();
    const key = await hostKeyPair();
    const start = await app.request("/api/v1/hosts/link/start", {
      method: "POST",
      headers: authHeaders(owner.token),
      body: JSON.stringify({
        environmentId,
        name: "Secrets host",
        platform: "darwin",
        kind: "local",
      }),
    });
    expect(start.status).toBe(201);
    const challenge = (await start.json()) as { challengeId: string; nonce: string };
    const now = Math.floor(Date.now() / 1000);
    const proof = await new SignJWT({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      publicKeyJwk: key.publicJwk,
      name: "Secrets host",
      platform: "darwin",
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "synara-host-link+jwt" })
      .setIssuer(`synara-host:${environmentId}`)
      .setSubject(environmentId)
      .setAudience(config.apiPublicUrl)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(key.privateKey);
    const complete = await app.request("/api/v1/hosts/link/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, proof }),
    });
    expect(complete.status).toBe(200);
    const body = (await complete.json()) as { host: { id: string } };
    return body.host;
  }

  async function registerDevice(app: Hono, session: Session) {
    const key = await generateKeyPair("ES256", { extractable: true });
    const publicKeyJwk = await exportJWK(key.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const proof = await new SignJWT({
      publicKeyJwk,
      displayName: "Pairing device",
      platform: "ios",
    })
      .setProtectedHeader({ alg: "ES256", typ: "synara-device-register+jwt" })
      .setIssuer("synara-device")
      .setSubject(session.userId)
      .setAudience(config.apiPublicUrl)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomUUID())
      .sign(key.privateKey);
    const response = await app.request("/api/v1/devices", {
      method: "POST",
      headers: authHeaders(session.token),
      body: JSON.stringify({ proof }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { device: { id: string } };
    return body.device;
  }

  function putSecret(
    app: Hono,
    session: Session,
    hostId: string,
    expectedVersion: number,
    body = envelope(expectedVersion + 1),
  ) {
    return app.request(`/api/v1/hosts/${hostId}/secrets`, {
      method: "PUT",
      headers: authHeaders(session.token),
      body: JSON.stringify({ expectedVersion, envelope: body }),
    });
  }

  function getSecret(app: Hono, session: Session, hostId: string) {
    return app.request(`/api/v1/hosts/${hostId}/secrets`, { headers: authHeaders(session.token) });
  }

  /** A structurally valid wrap. The API never opens it; only shape matters. */
  function syncKeyWrap(): SyncKeyWrap {
    const point = () => Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString("base64url");
    const jwk = { kty: "EC" as const, crv: "P-256" as const, x: point(), y: point() };
    return {
      ephemeralPublicJwk: jwk,
      recipientPublicJwk: { ...jwk, x: point() },
      wrapped: Buffer.from(`wrapped:${randomUUID()}`).toString("base64url"),
    };
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

  describe("1. ownership", () => {
    it("lets the owner write and read back its own secrets", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);

      const empty = await getSecret(app, owner, host.id);
      expect(empty.status).toBe(200);
      // A linked host with nothing stored is `{ secret: null }`, NOT a 404 —
      // the caller owns it, and "no secrets yet" is its ordinary state.
      expect(await empty.json()).toEqual({ secret: null });

      const written = envelope(1);
      const put = await putSecret(app, owner, host.id, 0, written);
      expect(put.status).toBe(200);

      const read = await getSecret(app, owner, host.id);
      expect(read.status).toBe(200);
      expect((await read.json()) as { secret: { version: number } }).toMatchObject({
        secret: { ciphertext: written.ciphertext, iv: written.iv, version: 1 },
      });
    });

    it("hides a host's secrets from an org-mate with 404, never 403", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const member = await teammate(owner);
      const host = await linkHost(app, owner);
      await expect(putSecret(app, owner, host.id, 0)).resolves.toMatchObject({ status: 200 });

      // Same workspace, and the host is discoverable — so host METADATA
      // routes would answer this caller 403. Secrets never cross a user
      // boundary at all, so existence itself must not leak.
      const read = await getSecret(app, member, host.id);
      expect(read.status).toBe(404);
      expect(await read.json()).toMatchObject({ error: "host_not_found" });

      const write = await putSecret(app, member, host.id, 1);
      expect(write.status).toBe(404);
      expect(await write.json()).toMatchObject({ error: "host_not_found" });
    });

    it("refuses a foreign user with the same 404 and leaves the row untouched", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const stranger = await signIn();
      const host = await linkHost(app, owner);
      const written = envelope(1);
      await putSecret(app, owner, host.id, 0, written);

      expect((await getSecret(app, stranger, host.id)).status).toBe(404);
      expect((await putSecret(app, stranger, host.id, 1)).status).toBe(404);

      const [row] = await db.select().from(hostSecrets).where(eq(hostSecrets.hostId, host.id));
      expect(row).toMatchObject({
        ciphertext: written.ciphertext,
        version: 1,
        ownerUserId: owner.userId,
      });
    });

    it("answers 404 for an unknown host id and a malformed one alike", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      expect((await getSecret(app, owner, randomUUID())).status).toBe(404);
      // Not a 400: a well-formed-id hint would tell a prober which ids to try.
      expect((await getSecret(app, owner, "not-a-uuid")).status).toBe(404);
    });

    it("rejects an unauthenticated read", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      const response = await app.request(`/api/v1/hosts/${host.id}/secrets`);
      expect(response.status).toBe(401);
    });
  });

  describe("2. compare-and-swap", () => {
    it("accepts a matching version and rejects a stale one without modifying the row", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      await putSecret(app, owner, host.id, 0, envelope(1, "first"));
      const second = envelope(2, "second");
      expect((await putSecret(app, owner, host.id, 1, second)).status).toBe(200);

      // A writer still holding version 1 — the rotation-vs-edit race.
      const stale = await putSecret(app, owner, host.id, 1, envelope(2, "stale"));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: "host_secret_version_conflict",
        // The current version is disclosed so the loser can re-read rather
        // than poll blindly.
        currentVersion: 2,
      });

      const [row] = await db.select().from(hostSecrets).where(eq(hostSecrets.hostId, host.id));
      expect(row).toMatchObject({ ciphertext: second.ciphertext, version: 2 });
    });

    it("rejects a duplicate first write with 409 rather than clobbering", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      expect((await putSecret(app, owner, host.id, 0)).status).toBe(200);
      const again = await putSecret(app, owner, host.id, 0);
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ currentVersion: 1 });
    });

    it("gives concurrent writers exactly one winner", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      await putSecret(app, owner, host.id, 0, envelope(1));

      const winner = envelope(2, "a");
      const loser = envelope(2, "b");
      const statuses = (
        await Promise.all([
          putSecret(app, owner, host.id, 1, winner),
          putSecret(app, owner, host.id, 1, loser),
        ])
      ).map((response) => response.status);
      expect(statuses.toSorted()).toEqual([200, 409]);

      const [row] = await db.select().from(hostSecrets).where(eq(hostSecrets.hostId, host.id));
      expect(row?.version).toBe(2);
      // Whichever won, the stored bytes are exactly one of the two payloads —
      // never a blend, and never the loser's.
      expect([winner.ciphertext, loser.ciphertext]).toContain(row?.ciphertext);
    });

    it("also gives concurrent FIRST writers exactly one winner", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      // No row exists, so there is nothing to lock FOR UPDATE — the unique
      // primary key is what has to break the tie.
      const responses = await Promise.all([
        putSecret(app, owner, host.id, 0, envelope(1, "a")),
        putSecret(app, owner, host.id, 0, envelope(1, "b")),
      ]);
      expect(responses.map((response) => response.status).toSorted()).toEqual([200, 409]);

      // The loser must learn the version that actually won. Echoing its own
      // stale expectedVersion (0) back would send it straight into a retry
      // loop against a row that will never be at 0 again.
      const conflict = responses.find((response) => response.status === 409);
      expect(await conflict?.json()).toMatchObject({ currentVersion: 1 });
    });

    it("refuses an envelope whose version does not follow expectedVersion", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      // The client seals under the version it is writing, and that version is
      // bound into the AEAD's additional data. A mismatch would store a blob
      // nothing could ever open at the version it lands on.
      for (const bad of [envelope(1), envelope(3)]) {
        const response = await putSecret(app, owner, host.id, 1, bad);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_failed" });
      }
    });

    it("rejects a malformed envelope at the schema boundary", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      const bodies = [
        {
          expectedVersion: 0,
          envelope: { ciphertext: "not base64!!", iv: opaqueIv(), version: 1 },
        },
        // An IV that is not 12 bytes did not come from sealHostSecret.
        {
          expectedVersion: 0,
          envelope: { ciphertext: opaqueCiphertext("x"), iv: "short", version: 1 },
        },
        { expectedVersion: -1, envelope: envelope(1) },
      ];
      for (const body of bodies) {
        const response = await app.request(`/api/v1/hosts/${host.id}/secrets`, {
          method: "PUT",
          headers: authHeaders(owner.token),
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
    });
  });

  describe("3. history", () => {
    it(`retains the newest ${HOST_SECRET_HISTORY_LIMIT} superseded versions and evicts the oldest`, async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);

      // Two writes past the limit, so eviction has to have happened twice.
      const total = HOST_SECRET_HISTORY_LIMIT + 3;
      for (let version = 1; version <= total; version += 1) {
        const response = await putSecret(app, owner, host.id, version - 1, envelope(version));
        expect(response.status).toBe(200);
      }

      const rows = await db
        .select()
        .from(hostSecretVersions)
        .where(eq(hostSecretVersions.hostId, host.id));
      expect(rows).toHaveLength(HOST_SECRET_HISTORY_LIMIT);
      // The archived set is versions 1..total-1 trimmed to the newest N: the
      // current version is never in history, and 1 and 2 were evicted.
      expect(rows.map((row) => row.version).toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: HOST_SECRET_HISTORY_LIMIT }, (_, index) => total - 1 - index).toSorted(
          (a, b) => a - b,
        ),
      );
      // The live row is the newest write and is NOT duplicated into history.
      const [current] = await db.select().from(hostSecrets).where(eq(hostSecrets.hostId, host.id));
      expect(current?.version).toBe(total);
    });

    it("archives the superseded ciphertext verbatim, so a bad write is recoverable", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      const good = envelope(1, "good");
      await putSecret(app, owner, host.id, 0, good);
      await putSecret(app, owner, host.id, 1, envelope(2, "bad"));

      const [archived] = await db
        .select()
        .from(hostSecretVersions)
        .where(eq(hostSecretVersions.hostId, host.id));
      expect(archived).toMatchObject({
        ciphertext: good.ciphertext,
        iv: good.iv,
        version: 1,
        ownerUserId: owner.userId,
      });
    });

    it("reads the retained versions back newest-first, scoped to the owner", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const stranger = await signIn();
      const host = await linkHost(app, owner);
      const written = [envelope(1), envelope(2), envelope(3)];
      for (const [index, value] of written.entries()) {
        await putSecret(app, owner, host.id, index, value);
      }

      // The recovery reader behind a bad write. Version 3 is current, so
      // history holds 1 and 2, newest first.
      const store = createHostSecretStore(db);
      const recovered = await store.history(host.id, owner.userId);
      expect(recovered.map((entry) => entry.version)).toEqual([2, 1]);
      expect(recovered[0]?.ciphertext).toBe(written[1]?.ciphertext);
      // Scoped by owner, so it cannot become a back door around the route.
      expect(await store.history(host.id, stranger.userId)).toEqual([]);
    });

    it("writes no history for a rejected write", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      await putSecret(app, owner, host.id, 0, envelope(1));
      expect((await putSecret(app, owner, host.id, 0, envelope(1))).status).toBe(409);

      const rows = await db
        .select()
        .from(hostSecretVersions)
        .where(eq(hostSecretVersions.hostId, host.id));
      // The first write superseded nothing, and the second never landed.
      expect(rows).toHaveLength(0);
    });
  });

  describe("4. opacity", () => {
    it("returns the exact bytes it was given, having decoded nothing", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);

      // Deliberately not real ciphertext, and deliberately full-width
      // base64url: whatever the client seals, the service is a pipe.
      const ciphertext = Buffer.from(
        Uint8Array.from({ length: 512 }, (_, index) => (index * 37 + 11) % 256),
      ).toString("base64url");
      const iv = Buffer.from(Uint8Array.from({ length: 12 }, (_, index) => 255 - index)).toString(
        "base64url",
      );
      const put = await putSecret(app, owner, host.id, 0, { ciphertext, iv, version: 1 });
      expect(put.status).toBe(200);
      expect((await put.json()) as { secret: unknown }).toMatchObject({
        secret: { ciphertext, iv, version: 1 },
      });

      const read = await getSecret(app, owner, host.id);
      const body = (await read.json()) as { secret: { ciphertext: string; iv: string } };
      expect(body.secret.ciphertext).toBe(ciphertext);
      expect(body.secret.iv).toBe(iv);
      // And byte-identical at rest, not merely equal after some normalization.
      const [row] = await db.select().from(hostSecrets).where(eq(hostSecrets.hostId, host.id));
      expect(row?.ciphertext).toBe(ciphertext);
      expect(row?.iv).toBe(iv);
    });
  });

  describe("5. sync key wraps", () => {
    it("delivers a wrap to the addressed device exactly once", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const device = await registerDevice(app, owner);
      const wrap = syncKeyWrap();

      const put = await app.request("/api/v1/sync-key-wraps", {
        method: "PUT",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ recipientDeviceId: device.id, wrap }),
      });
      expect(put.status).toBe(201);
      expect(await put.json()).toMatchObject({ recipientDeviceId: device.id });

      const first = await app.request(`/api/v1/sync-key-wraps/${device.id}`, {
        headers: authHeaders(owner.token),
      });
      expect(first.status).toBe(200);
      // Relayed verbatim: the service cannot open it and must not reshape it.
      expect(await first.json()).toMatchObject({ wrap });

      // Single delivery — a replay against a device that watched the exchange
      // gets nothing.
      const second = await app.request(`/api/v1/sync-key-wraps/${device.id}`, {
        headers: authHeaders(owner.token),
      });
      expect(second.status).toBe(404);
      expect(await second.json()).toMatchObject({ error: "sync_key_wrap_not_found" });
    });

    it("refuses a wrap addressed to another user's device with 404", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const stranger = await signIn();
      const strangerDevice = await registerDevice(app, stranger);

      const response = await app.request("/api/v1/sync-key-wraps", {
        method: "PUT",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ recipientDeviceId: strangerDevice.id, wrap: syncKeyWrap() }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "sync_key_wrap_not_found" });
      // Nothing was stored, so the refusal is not merely a hidden success.
      const rows = await db
        .select()
        .from(syncKeyWraps)
        .where(eq(syncKeyWraps.recipientDeviceId, strangerDevice.id));
      expect(rows).toHaveLength(0);
    });

    it("refuses a wrap for an unknown or revoked device", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const device = await registerDevice(app, owner);

      const unknown = await app.request("/api/v1/sync-key-wraps", {
        method: "PUT",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ recipientDeviceId: randomUUID(), wrap: syncKeyWrap() }),
      });
      expect(unknown.status).toBe(404);

      // Handing the Sync Key to a device that was just removed is the exact
      // inverse of the rotation ADR 0015 requires.
      const revoke = await app.request(`/api/v1/devices/${device.id}`, {
        method: "DELETE",
        headers: authHeaders(owner.token),
      });
      expect(revoke.status).toBe(204);
      const revoked = await app.request("/api/v1/sync-key-wraps", {
        method: "PUT",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ recipientDeviceId: device.id, wrap: syncKeyWrap() }),
      });
      expect(revoked.status).toBe(404);
    });

    it("does not let another user collect a wrap addressed to someone else's device", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const stranger = await signIn();
      const device = await registerDevice(app, owner);
      await app.request("/api/v1/sync-key-wraps", {
        method: "PUT",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ recipientDeviceId: device.id, wrap: syncKeyWrap() }),
      });

      const stolen = await app.request(`/api/v1/sync-key-wraps/${device.id}`, {
        headers: authHeaders(stranger.token),
      });
      expect(stolen.status).toBe(404);
      // And the refusal must not have consumed it — the rightful recipient
      // still gets its wrap.
      const rightful = await app.request(`/api/v1/sync-key-wraps/${device.id}`, {
        headers: authHeaders(owner.token),
      });
      expect(rightful.status).toBe(200);
    });

    it("replaces a waiting wrap rather than queueing a second one", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const device = await registerDevice(app, owner);
      const stale = syncKeyWrap();
      const fresh = syncKeyWrap();
      for (const wrap of [stale, fresh]) {
        const response = await app.request("/api/v1/sync-key-wraps", {
          method: "PUT",
          headers: authHeaders(owner.token),
          body: JSON.stringify({ recipientDeviceId: device.id, wrap }),
        });
        expect(response.status).toBe(201);
      }
      const rows = await db
        .select()
        .from(syncKeyWraps)
        .where(eq(syncKeyWraps.recipientDeviceId, device.id));
      expect(rows).toHaveLength(1);
      // A retried pairing delivers the newest attempt, not the first.
      const delivered = await app.request(`/api/v1/sync-key-wraps/${device.id}`, {
        headers: authHeaders(owner.token),
      });
      expect(await delivered.json()).toMatchObject({ wrap: fresh });
    });

    it("consumes but does not serve an expired wrap", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const device = await registerDevice(app, owner);
      await app.request("/api/v1/sync-key-wraps", {
        method: "PUT",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ recipientDeviceId: device.id, wrap: syncKeyWrap() }),
      });
      await db
        .update(syncKeyWraps)
        .set({ expiresAt: new Date(Date.now() - SYNC_KEY_WRAP_TTL_MS) })
        .where(eq(syncKeyWraps.recipientDeviceId, device.id));

      const response = await app.request(`/api/v1/sync-key-wraps/${device.id}`, {
        headers: authHeaders(owner.token),
      });
      expect(response.status).toBe(404);
      const rows = await db
        .select()
        .from(syncKeyWraps)
        .where(eq(syncKeyWraps.recipientDeviceId, device.id));
      expect(rows).toHaveLength(0);
    });

    it("gives concurrent collectors exactly one delivery", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const device = await registerDevice(app, owner);
      await app.request("/api/v1/sync-key-wraps", {
        method: "PUT",
        headers: authHeaders(owner.token),
        body: JSON.stringify({ recipientDeviceId: device.id, wrap: syncKeyWrap() }),
      });
      const collect = () =>
        app.request(`/api/v1/sync-key-wraps/${device.id}`, { headers: authHeaders(owner.token) });
      const statuses = (await Promise.all([collect(), collect()])).map(
        (response) => response.status,
      );
      // DELETE ... RETURNING is one statement, so only one caller sees a row.
      expect(statuses.toSorted()).toEqual([200, 404]);
    });

    it("rejects an unauthenticated upload and collection", async () => {
      const { app } = buildApp();
      const owner = await signIn();
      const device = await registerDevice(app, owner);
      const put = await app.request("/api/v1/sync-key-wraps", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipientDeviceId: device.id, wrap: syncKeyWrap() }),
      });
      expect(put.status).toBe(401);
      expect((await app.request(`/api/v1/sync-key-wraps/${device.id}`)).status).toBe(401);
    });
  });

  describe("6. host deletion", () => {
    /**
     * The tables carry NO foreign key to `hosts` (mirroring
     * `revocation_events`), so deletion ORDER can never destroy the
     * ciphertext by cascade. This implementation therefore removes the rows
     * DELIBERATELY, in the host-delete transaction — the owner asking for the
     * host to go is the one event that should take its secrets with it.
     */
    it("removes secrets and history in the owner's host delete, atomically", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      await putSecret(app, owner, host.id, 0, envelope(1));
      await putSecret(app, owner, host.id, 1, envelope(2));

      const response = await app.request(`/api/v1/hosts/${host.id}`, {
        method: "DELETE",
        headers: authHeaders(owner.token),
      });
      expect(response.status).toBe(204);
      expect(await db.select().from(hosts).where(eq(hosts.id, host.id))).toHaveLength(0);
      expect(
        await db.select().from(hostSecrets).where(eq(hostSecrets.hostId, host.id)),
      ).toHaveLength(0);
      expect(
        await db.select().from(hostSecretVersions).where(eq(hostSecretVersions.hostId, host.id)),
      ).toHaveLength(0);
    });

    /**
     * The property the missing foreign key buys: a host row disappearing for
     * any reason OTHER than the owner's delete — a future cleanup job, a
     * manual fix, a repair script — leaves the ciphertext intact and
     * recoverable rather than silently cascaded away.
     */
    it("keeps secrets when the host row is removed out from under them", async () => {
      const { app, db } = buildApp();
      const owner = await signIn();
      const host = await linkHost(app, owner);
      const written = envelope(1);
      await putSecret(app, owner, host.id, 0, written);

      await db.delete(hosts).where(eq(hosts.id, host.id));

      const [row] = await db.select().from(hostSecrets).where(eq(hostSecrets.hostId, host.id));
      expect(row).toMatchObject({ ciphertext: written.ciphertext, ownerUserId: owner.userId });
      // The route still refuses to serve them: authorization reads the host
      // row, which is gone, so the data survives without becoming readable.
      expect((await getSecret(app, owner, host.id)).status).toBe(404);
    });
  });
});
