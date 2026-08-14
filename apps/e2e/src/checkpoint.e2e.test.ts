import { randomBytes } from "node:crypto";

import { RELAY_CLOSE_GRANT_REPLAY } from "@synara/relay-protocol";
import { describe, expect, it } from "vitest";

import { HeadlessClientError } from "./headlessClient";
import { createE2eFixture } from "./harness/fixture";
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
});
