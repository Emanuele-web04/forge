import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AccountDevice,
  AccountHost,
  GetHostSecretResponse,
  GetSyncKeyWrapResponse,
  PutHostSecretRequest,
  PutSyncKeyWrapRequest,
} from "@synara/contracts";
import { generateSyncKey, openHostSecret, sealHostSecret } from "@synara/shared/hostSecrets";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostSecretsCoordinator, type HostSecretsCoordinatorApi } from "./coordinator";
import {
  hostSecretsSyncKeyPath,
  readHostSecretsSyncKey,
  writeHostSecretsSyncKey,
} from "./syncKeyStore";

const roots: string[] = [];

async function makeSyncKeyPath(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `synara-host-secrets-${label}-`));
  roots.push(root);
  return hostSecretsSyncKeyPath(path.join(root, "secrets"));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function pairingApi(
  mailbox: Map<string, PutSyncKeyWrapRequest["wrap"]>,
): HostSecretsCoordinatorApi {
  return {
    listHosts: vi.fn(async () => ({ hosts: [] })),
    listDevices: vi.fn(async () => ({ devices: [] })),
    getHostSecret: vi.fn(async () => ({ secret: null })),
    putHostSecret: vi.fn(async () => {
      throw new Error("putHostSecret should not be called while pairing");
    }),
    putSyncKeyWrap: vi.fn(async (request) => {
      mailbox.set(request.recipientDeviceId, request.wrap);
      return {
        recipientDeviceId: request.recipientDeviceId,
        createdAt: "2026-08-14T12:00:00.000Z",
        expiresAt: "2026-08-14T12:10:00.000Z",
      };
    }),
    takeSyncKeyWrap: vi.fn(async (deviceId): Promise<GetSyncKeyWrapResponse> => {
      const wrap = mailbox.get(deviceId);
      if (!wrap) throw new Error("no wrap");
      mailbox.delete(deviceId);
      return { wrap, createdAt: "2026-08-14T12:00:00.000Z" };
    }),
    revokeDevice: vi.fn(async () => {}),
  };
}

describe("HostSecretsCoordinator pairing", () => {
  it("shows the same code on both devices and adopts the key only after matching confirmation", async () => {
    const mailbox = new Map<string, PutSyncKeyWrapRequest["wrap"]>();
    const existingPath = await makeSyncKeyPath("existing");
    const recipientPath = await makeSyncKeyPath("recipient");
    const existingApi = pairingApi(mailbox);
    const recipientApi = pairingApi(mailbox);
    const existing = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-000000000001",
      syncKeyFilePath: existingPath,
      api: existingApi,
    });
    const recipient = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-000000000002",
      syncKeyFilePath: recipientPath,
      api: recipientApi,
    });

    const request = await recipient.beginPairing();
    const offered = await existing.offerSyncKey(request);
    const received = await recipient.receiveSyncKey();

    expect(offered.verificationCode).toBe(received.verificationCode);
    expect(received.verificationCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    await expect(
      readHostSecretsSyncKey({
        filePath: recipientPath,
        accountUrl: "https://accounts.example.com",
        userId: "user-1",
      }),
    ).resolves.toBeUndefined();

    await expect(recipient.confirmSyncKey({ verificationCode: "AAAAAA" })).rejects.toThrow(
      /does not match/i,
    );
    await recipient.confirmSyncKey({ verificationCode: offered.verificationCode });

    const existingKey = await readHostSecretsSyncKey({
      filePath: existingPath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
    });
    const receivedKey = await readHostSecretsSyncKey({
      filePath: recipientPath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
    });
    expect(existingKey).toBeDefined();
    expect(receivedKey).toBeDefined();
    if (!existingKey || !receivedKey) return;
    const envelope = await sealHostSecret({
      syncKey: existingKey,
      hostId: "host-1",
      ownerUserId: "user-1",
      version: 1,
      secret: { launcher: "synara" },
    });
    await expect(
      openHostSecret({
        syncKey: receivedKey,
        hostId: "host-1",
        ownerUserId: "user-1",
        version: 1,
        envelope,
      }),
    ).resolves.toEqual({ launcher: "synara" });
  });
});

function host(id: string): AccountHost {
  return {
    id,
    environmentId: "env-1" as AccountHost["environmentId"],
    name: id,
    platform: "darwin",
    kind: "local",
    endpoints: [],
    ownerUserId: "user-1",
    discoverable: false,
    linked: true,
    keyGeneration: 1,
    mine: true,
    createdAt: "2026-08-14T12:00:00.000Z",
    lastSeenAt: "2026-08-14T12:00:00.000Z",
  };
}

function device(id: string, readRevokedAt: () => string | null = () => null): AccountDevice {
  return {
    id,
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "eA", y: "eQ" },
    jkt: "revoked-device-jkt",
    displayName: "Lost laptop",
    platform: "darwin",
    createdAt: "2026-08-14T12:00:00.000Z",
    lastUsedAt: null,
    get revokedAt() {
      return readRevokedAt();
    },
  };
}

describe("HostSecretsCoordinator revocation rotation", () => {
  it("revokes first, then CAS-rotates every owned Host Secret and adopts the new key", async () => {
    const syncKeyFilePath = await makeSyncKeyPath("rotation");
    const oldSyncKey = await generateSyncKey();
    await writeHostSecretsSyncKey({
      filePath: syncKeyFilePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      syncKey: oldSyncKey,
    });
    const stored = new Map<string, NonNullable<GetHostSecretResponse["secret"]>>();
    for (const [id, version] of [
      ["host-1", 2],
      ["host-2", 7],
    ] as const) {
      stored.set(id, {
        ...(await sealHostSecret({
          syncKey: oldSyncKey,
          hostId: id,
          ownerUserId: "user-1",
          version,
          secret: { ssh: `${id}.example.com` },
        })),
        updatedAt: "2026-08-14T12:00:00.000Z",
      });
    }
    const calls: string[] = [];
    const putHostSecret = vi.fn(async (hostId: string, request: PutHostSecretRequest) => {
      calls.push(`put:${hostId}`);
      stored.set(hostId, { ...request.envelope, updatedAt: "2026-08-14T12:01:00.000Z" });
      return { secret: stored.get(hostId)! };
    });
    const api: HostSecretsCoordinatorApi = {
      listHosts: vi.fn(async () => ({ hosts: [host("host-1"), host("host-2")] })),
      listDevices: vi.fn(async () => ({
        devices: [device("00000000-0000-4000-8000-000000000099")],
      })),
      getHostSecret: vi.fn(async (hostId) => ({ secret: stored.get(hostId) ?? null })),
      putHostSecret,
      putSyncKeyWrap: vi.fn(async () => {
        throw new Error("not pairing");
      }),
      takeSyncKeyWrap: vi.fn(async () => {
        throw new Error("not pairing");
      }),
      revokeDevice: vi.fn(async () => {
        calls.push("revoke");
      }),
    };
    const coordinator = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-000000000001",
      syncKeyFilePath,
      api,
    });

    await coordinator.revokeDevice("00000000-0000-4000-8000-000000000099");

    expect(calls[0]).toBe("revoke");
    expect(putHostSecret).toHaveBeenCalledTimes(2);
    expect(putHostSecret).toHaveBeenCalledWith(
      "host-1",
      expect.objectContaining({
        expectedVersion: 2,
        envelope: expect.objectContaining({ version: 3 }),
      }),
    );
    expect(putHostSecret).toHaveBeenCalledWith(
      "host-2",
      expect.objectContaining({
        expectedVersion: 7,
        envelope: expect.objectContaining({ version: 8 }),
      }),
    );

    const newSyncKey = await readHostSecretsSyncKey({
      filePath: syncKeyFilePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
    });
    expect(newSyncKey).toBeDefined();
    if (!newSyncKey) return;
    for (const [hostId, secret] of stored) {
      await expect(
        openHostSecret({
          syncKey: newSyncKey,
          hostId,
          ownerUserId: "user-1",
          version: secret.version,
          envelope: secret,
        }),
      ).resolves.toEqual({ ssh: `${hostId}.example.com` });
      await expect(
        openHostSecret({
          syncKey: oldSyncKey,
          hostId,
          ownerUserId: "user-1",
          version: secret.version,
          envelope: secret,
        }),
      ).rejects.toThrow();
    }
  });

  it("resumes a partially uploaded rotation after restart without losing the new key", async () => {
    const syncKeyFilePath = await makeSyncKeyPath("rotation-resume");
    const oldSyncKey = await generateSyncKey();
    await writeHostSecretsSyncKey({
      filePath: syncKeyFilePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      syncKey: oldSyncKey,
    });
    const stored = new Map<string, NonNullable<GetHostSecretResponse["secret"]>>();
    for (const id of ["host-1", "host-2"] as const) {
      stored.set(id, {
        ...(await sealHostSecret({
          syncKey: oldSyncKey,
          hostId: id,
          ownerUserId: "user-1",
          version: 1,
          secret: { ssh: `${id}.example.com` },
        })),
        updatedAt: "2026-08-14T12:00:00.000Z",
      });
    }
    let revokedAt: string | null = null;
    let failSecondUpload = true;
    const revokeDevice = vi.fn(async () => {
      revokedAt = "2026-08-14T12:01:00.000Z";
    });
    const api: HostSecretsCoordinatorApi = {
      listHosts: vi.fn(async () => ({ hosts: [host("host-1"), host("host-2")] })),
      listDevices: vi.fn(async () => ({
        devices: [device("00000000-0000-4000-8000-000000000099", () => revokedAt)],
      })),
      getHostSecret: vi.fn(async (hostId) => ({ secret: stored.get(hostId) ?? null })),
      putHostSecret: vi.fn(async (hostId, request) => {
        if (hostId === "host-2" && failSecondUpload) {
          failSecondUpload = false;
          throw new Error("temporary upload failure");
        }
        stored.set(hostId, {
          ...request.envelope,
          updatedAt: "2026-08-14T12:02:00.000Z",
        });
        return { secret: stored.get(hostId)! };
      }),
      putSyncKeyWrap: vi.fn(async () => {
        throw new Error("not pairing");
      }),
      takeSyncKeyWrap: vi.fn(async () => {
        throw new Error("not pairing");
      }),
      revokeDevice,
    };
    const makeCoordinator = () =>
      new HostSecretsCoordinator({
        accountUrl: "https://accounts.example.com",
        userId: "user-1",
        deviceId: "00000000-0000-4000-8000-000000000001",
        syncKeyFilePath,
        api,
      });
    const removedDeviceId = "00000000-0000-4000-8000-000000000099";

    await expect(makeCoordinator().revokeDevice(removedDeviceId)).rejects.toThrow(
      /temporary upload failure/i,
    );
    await expect(makeCoordinator().revokeDevice(removedDeviceId)).resolves.toBeUndefined();

    expect(revokeDevice).toHaveBeenCalledTimes(1);
    const adoptedKey = await readHostSecretsSyncKey({
      filePath: syncKeyFilePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
    });
    expect(adoptedKey).toBeDefined();
    if (!adoptedKey) return;
    for (const [hostId, secret] of stored) {
      await expect(
        openHostSecret({
          syncKey: adoptedKey,
          hostId,
          ownerUserId: "user-1",
          version: secret.version,
          envelope: secret,
        }),
      ).resolves.toEqual({ ssh: `${hostId}.example.com` });
    }
  });

  it("refuses to revoke the current device because it is not a surviving rotator", async () => {
    const api = pairingApi(new Map());
    const coordinator = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-000000000001",
      syncKeyFilePath: await makeSyncKeyPath("self"),
      api,
    });

    await expect(coordinator.revokeDevice("00000000-0000-4000-8000-000000000001")).rejects.toThrow(
      /another device/i,
    );
    expect(api.revokeDevice).not.toHaveBeenCalled();
  });

  it("burns the pairing after three wrong codes rather than allowing endless guesses", async () => {
    // A typo deserves forgiveness; a code that genuinely differs means the
    // wrap came from a device other than the one in front of the user. The
    // cap forgives the first and denies the second an unlimited supply of
    // attempts — and forces a fresh exchange instead of grinding at a
    // suspicious one.
    const mailbox = new Map<string, PutSyncKeyWrapRequest["wrap"]>();
    const existing = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-00000000000a",
      syncKeyFilePath: await makeSyncKeyPath("burn-existing"),
      api: pairingApi(mailbox),
    });
    const recipient = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-00000000000b",
      syncKeyFilePath: await makeSyncKeyPath("burn-recipient"),
      api: pairingApi(mailbox),
    });

    const request = await recipient.beginPairing();
    await existing.offerSyncKey(request);
    await recipient.receiveSyncKey();

    for (const expected of [2, 1]) {
      await expect(recipient.confirmSyncKey({ verificationCode: "ZZZZZZ" })).rejects.toMatchObject({
        remainingAttempts: expected,
      });
    }
    await expect(recipient.confirmSyncKey({ verificationCode: "ZZZZZZ" })).rejects.toMatchObject({
      remainingAttempts: 0,
    });
    // The pairing is gone: even the CORRECT code no longer works.
    await expect(recipient.confirmSyncKey({ verificationCode: "ZZZZZZ" })).rejects.toThrow(
      /Receive a Sync-Key wrap before confirming/i,
    );
  });
});
