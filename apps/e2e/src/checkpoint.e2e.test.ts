import { randomBytes } from "node:crypto";

import { HOST_SESSION_CLOSE_REVOKED, RELAY_CLOSE_GRANT_REPLAY } from "@synara/relay-protocol";
import { AccountApiError, createAccountClient } from "@synara/shared/account";
import { generateSyncKey, openHostSecret, sealHostSecret } from "@synara/shared/hostSecrets";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";

import { HeadlessClientError } from "./headlessClient";
import { createE2eFixture } from "./harness/fixture";
import { PairingVerificationError } from "../../server/src/hostSecrets/coordinator";
import {
  readHostSecretsSyncKey,
  writeHostSecretsSyncKey,
} from "../../server/src/hostSecrets/syncKeyStore";
import { REMOTE_SESSION_REVOKED_CLOSE_CODE } from "../../server/src/remoteSessions/sessionRegistry";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("A → B → C slice checkpoint", () => {
  it("enrolls a host and refuses its old proof after re-link key rotation", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const first = await fixture.linkHost();
    expect(first.row.publicKeyJwk).toEqual(first.identity.publicKeyJwk);
    expect(first.row.keyGeneration).toBe(1);

    const oldProof = await fixture.mintHostProof(first);
    const second = await fixture.relinkHost();
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.keyGeneration).toBe(2);
    expect(second.identity.publicKeyJwk).not.toEqual(first.identity.publicKeyJwk);
    await expect(fixture.requestRelayTicket(oldProof, first.row.id)).rejects.toMatchObject({
      code: "bad_proof",
      status: 401,
    });
  });

  it("enrolls a headless host through the device-code flow", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const linked = await fixture.linkHostWithDeviceCode();
    expect(linked.row.publicKeyJwk).toEqual(linked.identity.publicKeyJwk);
    expect(linked.row.keyGeneration).toBe(1);
    expect(linked.stored).toMatchObject({
      hostId: linked.row.id,
      hostOwnerUserId: fixture.owner.userId,
      hostKeyGeneration: 1,
    });
    expect(linked.stored).not.toHaveProperty("accessToken");
  });

  it("carries byte-identical text and binary traffic through a relay session", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const linked = await fixture.linkHost();
    await using host = await fixture.startHost();
    await using client = await fixture.createClient();
    const grant = await client.requestGrant(linked.row.id);
    await using session = await client.connectWithGrant({
      candidates: [{ kind: "relay", url: fixture.relayOrigin }],
      environmentId: linked.row.environmentId,
      grant,
    });

    const text = "relay text — Δ — end";
    expect(await session.echo({ sequence: 1, payload: text })).toEqual({
      sequence: 1,
      payload: text,
      binary: false,
    });
    const bytes = randomBytes(32 * 1024);
    const encoded = bytes.toString("base64");
    const binary = await session.echo({ sequence: 2, payload: encoded, binary: true });
    expect(Buffer.from(binary.payload, "base64")).toEqual(bytes);
    expect(binary.binary).toBe(true);
    expect(session.transport).toBe("relay");
    expect(host.directUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws\/host$/);
  });

  it("reuses one session credential on the direct transport without re-minting", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const linked = await fixture.linkHost();
    await using host = await fixture.startHost();
    await using client = await fixture.createClient();
    const grant = await client.requestGrant(linked.row.id);
    await using relaySession = await client.connectWithGrant({
      candidates: [{ kind: "relay", url: fixture.relayOrigin }],
      environmentId: linked.row.environmentId,
      grant,
    });
    await using directSession = await client.connectWithCredential({
      candidates: [{ kind: "lan", url: host.directUrl }],
      credential: relaySession.credential,
    });

    expect(directSession.minted).toBe(false);
    expect(directSession.transport).toBe("lan");
    await expect(
      directSession.echo({ sequence: 3, payload: "same credential" }),
    ).resolves.toMatchObject({ sequence: 3, payload: "same credential" });
  });

  it("refuses a spent relay grant with the documented replay close code", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const linked = await fixture.linkHost();
    await using _host = await fixture.startHost();
    await using client = await fixture.createClient();
    const grant = await client.requestGrant(linked.row.id);
    await using session = await client.connectWithGrant({
      candidates: [{ kind: "relay", url: fixture.relayOrigin }],
      environmentId: linked.row.environmentId,
      grant,
    });
    const replay = await client.openRelay(grant, fixture.relayOrigin);
    await expect(replay.inbox.waitForClose()).resolves.toMatchObject({
      code: RELAY_CLOSE_GRANT_REPLAY,
    });
    expect(session.socket.readyState).toBe(1);
  });

  it("kills a live member session after discoverability is revoked", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const linked = await fixture.linkHost();
    await using _host = await fixture.startHost();
    const member = await fixture.createMember();
    await using client = await fixture.createClient(member);
    const grant = await client.requestGrant(linked.row.id);
    await using session = await client.connectWithGrant({
      candidates: [{ kind: "relay", url: fixture.relayOrigin }],
      environmentId: linked.row.environmentId,
      grant,
    });
    const closed = session.waitForClose(15_000);

    await fixture.setDiscoverable(linked.row.id, false);
    await expect(closed).resolves.toMatchObject({ code: REMOTE_SESSION_REVOKED_CLOSE_CODE });
  });

  it("degrades cleanly across relay and account API outages", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const linked = await fixture.linkHost();
    await using host = await fixture.startHost();
    await using client = await fixture.createClient();
    const grant = await client.requestGrant(linked.row.id);
    await using relaySession = await client.connectWithGrant({
      candidates: [{ kind: "relay", url: fixture.relayOrigin }],
      environmentId: linked.row.environmentId,
      grant,
    });
    await using directSession = await client.connectWithCredential({
      candidates: [{ kind: "lan", url: host.directUrl }],
      credential: relaySession.credential,
    });
    const relayClosed = relaySession.waitForClose();

    await fixture.stopRelay();
    await expect(relayClosed).resolves.toMatchObject({ code: 1001 });
    await expect(
      directSession.echo({ sequence: 4, payload: "relay offline" }),
    ).resolves.toMatchObject({ payload: "relay offline" });

    await fixture.stopApi();
    await using offlineSession = await client.connectWithCredential({
      candidates: [{ kind: "lan", url: host.directUrl }],
      credential: relaySession.credential,
    });
    await expect(
      offlineSession.echo({ sequence: 5, payload: "api offline" }),
    ).resolves.toMatchObject({ payload: "api offline" });
    await using newDevice = await fixture.createClient();
    await expect(newDevice.register()).rejects.toMatchObject({
      name: HeadlessClientError.name,
      message: "device registration could not reach the account API",
      status: undefined,
    });
  });

  it("preserves every ordered frame under relay backpressure", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const linked = await fixture.linkHost();
    await using _host = await fixture.startHost();
    await using client = await fixture.createClient();
    const grant = await client.requestGrant(linked.row.id);
    await using session = await client.connectWithGrant({
      candidates: [{ kind: "relay", url: fixture.relayOrigin }],
      environmentId: linked.row.environmentId,
      grant,
    });
    const payloads = Array.from(
      { length: 128 },
      (_, index) =>
        `${index.toString().padStart(3, "0")}:${randomBytes(24 * 1024).toString("base64")}`,
    );

    const replies = await session.echoBurst(payloads, { slowReader: true });
    expect(replies).toEqual(payloads.map((payload, sequence) => ({ sequence, payload })));
  });

  it("pairs a Sync Key through the account API and rotates Host Secrets after revocation", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const linked = await fixture.linkHost();
    await using existingClient = await fixture.createClient();
    await using newClient = await fixture.createClient();
    const existingDevice = await existingClient.register();
    const newDevice = await newClient.register();
    const existing = fixture.createHostSecretsCoordinator(existingDevice.id);
    const newcomer = fixture.createHostSecretsCoordinator(newDevice.id);
    const syncKeyOwner = {
      accountUrl: fixture.apiOrigin,
      userId: fixture.owner.userId,
    };
    await writeHostSecretsSyncKey({
      ...syncKeyOwner,
      filePath: existing.syncKeyFilePath,
      syncKey: await generateSyncKey(),
    });

    const request = await newcomer.coordinator.beginPairing();
    const offered = await existing.coordinator.offerSyncKey(request);
    const received = await newcomer.coordinator.receiveSyncKey();
    expect(offered.verificationCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(received.verificationCode).toBe(offered.verificationCode);
    expect(
      await readHostSecretsSyncKey({
        ...syncKeyOwner,
        filePath: newcomer.syncKeyFilePath,
      }),
    ).toBeUndefined();
    await expect(newcomer.coordinator.receiveSyncKey()).rejects.toMatchObject({
      name: AccountApiError.name,
      code: "sync_key_wrap_not_found",
      status: 404,
    });

    await newcomer.coordinator.confirmSyncKey({
      verificationCode: offered.verificationCode,
    });
    const existingSyncKey = await readHostSecretsSyncKey({
      ...syncKeyOwner,
      filePath: existing.syncKeyFilePath,
    });
    const receivedSyncKey = await readHostSecretsSyncKey({
      ...syncKeyOwner,
      filePath: newcomer.syncKeyFilePath,
    });
    if (!existingSyncKey || !receivedSyncKey) {
      throw new Error("confirmed pairing did not persist both devices' Sync Keys");
    }

    const account = createAccountClient({ baseUrl: fixture.apiOrigin });
    const secret = { sshDestination: "e2e@example.test", launcher: ["synara", "open"] };
    const initialEnvelope = await sealHostSecret({
      syncKey: existingSyncKey,
      hostId: linked.row.id,
      ownerUserId: fixture.owner.userId,
      version: 1,
      secret,
    });
    await account.putHostSecret(fixture.owner.accessToken, linked.row.id, {
      expectedVersion: 0,
      envelope: initialEnvelope,
    });
    const storedBeforeRotation = (
      await account.getHostSecret(fixture.owner.accessToken, linked.row.id)
    ).secret;
    if (!storedBeforeRotation) throw new Error("real Host Secret PUT was not readable");
    await expect(
      openHostSecret({
        syncKey: receivedSyncKey,
        hostId: linked.row.id,
        ownerUserId: fixture.owner.userId,
        version: storedBeforeRotation.version,
        envelope: storedBeforeRotation,
      }),
    ).resolves.toEqual(secret);

    await using burnedClient = await fixture.createClient();
    const burnedDevice = await burnedClient.register();
    const burned = fixture.createHostSecretsCoordinator(burnedDevice.id);
    const burnedRequest = await burned.coordinator.beginPairing();
    const burnedOffered = await existing.coordinator.offerSyncKey(burnedRequest);
    const burnedReceived = await burned.coordinator.receiveSyncKey();
    expect(burnedReceived.verificationCode).toBe(burnedOffered.verificationCode);
    const wrongCode = burnedOffered.verificationCode === "AAAAAA" ? "BBBBBB" : "AAAAAA";
    const remainingAttempts: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await burned.coordinator
        .confirmSyncKey({ verificationCode: wrongCode })
        .then(() => undefined)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PairingVerificationError);
      if (error instanceof PairingVerificationError) {
        remainingAttempts.push(error.remainingAttempts);
      }
    }
    expect(remainingAttempts).toEqual([2, 1, 0]);
    await expect(
      burned.coordinator.confirmSyncKey({
        verificationCode: burnedOffered.verificationCode,
      }),
    ).rejects.toThrow("Receive a Sync-Key wrap before confirming pairing");

    await existing.coordinator.revokeDevice(newDevice.id);
    const revoked = (await account.listDevices(fixture.owner.accessToken)).devices.find(
      (device) => device.id === newDevice.id,
    );
    expect(revoked?.revokedAt).toEqual(expect.any(String));
    const rotatedSyncKey = await readHostSecretsSyncKey({
      ...syncKeyOwner,
      filePath: existing.syncKeyFilePath,
    });
    if (!rotatedSyncKey) throw new Error("surviving device did not persist its rotated Sync Key");
    const storedAfterRotation = (
      await account.getHostSecret(fixture.owner.accessToken, linked.row.id)
    ).secret;
    if (!storedAfterRotation) throw new Error("rotation removed the Host Secret");
    expect(storedAfterRotation.version).toBe(storedBeforeRotation.version + 1);
    await expect(
      openHostSecret({
        syncKey: rotatedSyncKey,
        hostId: linked.row.id,
        ownerUserId: fixture.owner.userId,
        version: storedAfterRotation.version,
        envelope: storedAfterRotation,
      }),
    ).resolves.toEqual(secret);
    await expect(
      openHostSecret({
        syncKey: rotatedSyncKey,
        hostId: linked.row.id,
        ownerUserId: fixture.owner.userId,
        version: storedBeforeRotation.version,
        envelope: storedBeforeRotation,
      }),
    ).rejects.toMatchObject({ reason: "open-failed" });
  });

  it("lists relay and direct sessions and ends or expires only the targeted session", async () => {
    await using fixture = await createE2eFixture(TEST_DATABASE_URL as string);
    const linked = await fixture.linkHost();
    await using host = await fixture.startHost();
    await using client = await fixture.createClient();
    const grant = await client.requestGrant(linked.row.id);
    const earliestStart = Date.now();
    await using relaySession = await client.connectWithGrant({
      candidates: [{ kind: "relay", url: fixture.relayOrigin }],
      environmentId: linked.row.environmentId,
      grant,
    });
    const deviceJkt = client.device?.jkt;
    if (!deviceJkt) throw new Error("grant did not register the headless client device");

    const firstListing = await host.listSessions();
    expect(firstListing.sessions).toHaveLength(1);
    expect(firstListing.sessions[0]).toMatchObject({
      userId: fixture.owner.userId,
      deviceJkt,
      transport: "relay",
    });
    expect(Date.parse(firstListing.sessions[0]?.startedAt ?? "")).toBeGreaterThanOrEqual(
      earliestStart,
    );

    await using directSession = await client.connectWithCredential({
      candidates: [{ kind: "lan", url: host.directUrl }],
      credential: relaySession.credential,
    });
    const bothListing = await host.listSessions();
    expect(bothListing.sessions).toHaveLength(2);
    expect(bothListing.sessions.map((session) => session.transport).toSorted()).toEqual([
      "direct",
      "relay",
    ]);
    expect(new Set(bothListing.sessions.map((session) => session.id)).size).toBe(2);
    const relayRegistrySession = bothListing.sessions.find(
      (session) => session.transport === "relay",
    );
    if (!relayRegistrySession) throw new Error("relay session disappeared from the registry");

    const relayClosed = relaySession.waitForClose();
    await host.endSession(relayRegistrySession.id);
    // Pin the NUMBER, not just the constant. Host-session codes live in their
    // own 45xx range precisely so a revoked session can never be read as a
    // relay 44xx meaning (4403 = grant replay) after travelling verbatim
    // through a splice — asserting only the symbol would let the collision be
    // reintroduced by changing the constant, which is exactly how it shipped
    // the first time.
    expect(HOST_SESSION_CLOSE_REVOKED).toBe(4503);
    expect(HOST_SESSION_CLOSE_REVOKED).not.toBe(RELAY_CLOSE_GRANT_REPLAY);
    await expect(relayClosed).resolves.toMatchObject({ code: HOST_SESSION_CLOSE_REVOKED });
    await expect(
      directSession.echo({ sequence: 6, payload: "direct session survived" }),
    ).resolves.toMatchObject({ payload: "direct session survived" });
    const afterEnd = await host.listSessions();
    expect(afterEnd.sessions).toHaveLength(1);
    expect(afterEnd.sessions[0]?.transport).toBe("direct");

    const credentialExpiration = decodeJwt(directSession.credential).exp;
    if (credentialExpiration === undefined) {
      throw new Error("real host credential had no expiration");
    }
    const expiredClosed = directSession.waitForClose();
    host.dropExpiredSessions(credentialExpiration);
    await expect(expiredClosed).resolves.toMatchObject({ code: HOST_SESSION_CLOSE_REVOKED });
    await expect(host.listSessions()).resolves.toEqual({ sessions: [] });
  });
});
