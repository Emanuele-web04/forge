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
  readHostSecretsPendingRotation,
  readHostSecretsSyncKey,
  writeHostSecretsSyncKey,
} from "./syncKeyStore";

const roots: string[] = [];

/** The unambiguous 32-symbol code alphabet, pinned here rather than imported. */
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function makeSyncKeyPath(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `synara-host-secrets-${label}-`));
  roots.push(root);
  return hostSecretsSyncKeyPath(path.join(root, "secrets"));
}

/** Asserts a device is still unpaired: no Sync Key was adopted at that path. */
async function expectUnpaired(filePath: string): Promise<void> {
  await expect(
    readHostSecretsSyncKey({
      filePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
    }),
  ).resolves.toBeUndefined();
}

/** Next character in the code alphabet: a near-miss that is still a valid code. */
function rotateCodeCharacter(code: string, index: number): string {
  const current = PAIRING_CODE_ALPHABET.indexOf(code.charAt(index));
  if (current < 0) throw new Error(`code character ${index} is outside the alphabet`);
  const rotated = PAIRING_CODE_ALPHABET.charAt((current + 1) % PAIRING_CODE_ALPHABET.length);
  return `${code.slice(0, index)}${rotated}${code.slice(index + 1)}`;
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
    // The thrown rejection is what the UI shows; the file is what the attacker
    // wanted. A mismatch must leave nothing on disk, or the user sees a refusal
    // while an unverified key is already sealing every later Host Secret.
    await expectUnpaired(recipientPath);

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
  async function interruptSecondHostRotation(label: string) {
    const syncKeyFilePath = await makeSyncKeyPath(label);
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
    const firstDeviceId = "00000000-0000-4000-8000-000000000099";
    const secondDeviceId = "00000000-0000-4000-8000-000000000098";
    const revoked = new Set<string>();
    let failSecondUpload = true;
    const revokeDevice = vi.fn(async (deviceId: string) => {
      revoked.add(deviceId);
    });
    const putHostSecret = vi.fn(async (hostId: string, request: PutHostSecretRequest) => {
      if (hostId === "host-2" && failSecondUpload) {
        failSecondUpload = false;
        throw new Error("temporary upload failure");
      }
      const current = stored.get(hostId);
      if (!current || current.version !== request.expectedVersion) {
        throw new Error("test CAS conflict");
      }
      const secret = {
        ...request.envelope,
        updatedAt: "2026-08-14T12:02:00.000Z",
      };
      stored.set(hostId, secret);
      return { secret };
    });
    const api: HostSecretsCoordinatorApi = {
      listHosts: vi.fn(async () => ({ hosts: [host("host-1"), host("host-2")] })),
      listDevices: vi.fn(async () => ({
        devices: [
          device(firstDeviceId, () => (revoked.has(firstDeviceId) ? "2026-08-14" : null)),
          device(secondDeviceId, () => (revoked.has(secondDeviceId) ? "2026-08-14" : null)),
        ],
      })),
      getHostSecret: vi.fn(async (hostId) => ({ secret: stored.get(hostId) ?? null })),
      putHostSecret,
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

    await expect(makeCoordinator().revokeDevice(firstDeviceId)).rejects.toThrow(
      "temporary upload failure",
    );
    return {
      api,
      firstDeviceId,
      makeCoordinator,
      oldSyncKey,
      putHostSecret,
      revokeDevice,
      secondDeviceId,
      stored,
      syncKeyFilePath,
    };
  }

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

  it("skips a deleted host and finishes the journal before revoking another device", async () => {
    const setup = await interruptSecondHostRotation("rotation-deleted-host");
    setup.stored.delete("host-2");

    await expect(
      setup.makeCoordinator().revokeDevice(setup.secondDeviceId),
    ).resolves.toBeUndefined();

    expect(setup.revokeDevice.mock.calls.map(([deviceId]) => deviceId)).toEqual([
      setup.firstDeviceId,
      setup.secondDeviceId,
    ]);
    const adoptedKey = await readHostSecretsSyncKey({
      filePath: setup.syncKeyFilePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
    });
    const hostOne = setup.stored.get("host-1");
    expect(adoptedKey).toBeDefined();
    expect(hostOne).toBeDefined();
    if (!adoptedKey || !hostOne) return;
    await expect(
      openHostSecret({
        syncKey: adoptedKey,
        hostId: "host-1",
        ownerUserId: "user-1",
        version: hostOne.version,
        envelope: hostOne,
      }),
    ).resolves.toEqual({ ssh: "host-1.example.com" });
  });

  it("re-reads and re-seals a host that changed while its rotation was interrupted", async () => {
    const setup = await interruptSecondHostRotation("rotation-version-bump");
    setup.stored.set("host-2", {
      ...(await sealHostSecret({
        syncKey: setup.oldSyncKey,
        hostId: "host-2",
        ownerUserId: "user-1",
        version: 2,
        secret: { ssh: "edited-while-rotation-paused.example.com" },
      })),
      updatedAt: "2026-08-14T12:03:00.000Z",
    });

    await expect(
      setup.makeCoordinator().revokeDevice(setup.firstDeviceId),
    ).resolves.toBeUndefined();

    expect(setup.putHostSecret).toHaveBeenLastCalledWith(
      "host-2",
      expect.objectContaining({
        expectedVersion: 2,
        envelope: expect.objectContaining({ version: 3 }),
      }),
    );
    const adoptedKey = await readHostSecretsSyncKey({
      filePath: setup.syncKeyFilePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
    });
    const hostTwo = setup.stored.get("host-2");
    expect(adoptedKey).toBeDefined();
    expect(hostTwo).toBeDefined();
    if (!adoptedKey || !hostTwo) return;
    await expect(
      openHostSecret({
        syncKey: adoptedKey,
        hostId: "host-2",
        ownerUserId: "user-1",
        version: hostTwo.version,
        envelope: hostTwo,
      }),
    ).resolves.toEqual({ ssh: "edited-while-rotation-paused.example.com" });
  });

  it("still revokes a device when this account has no Host Secrets to rotate", async () => {
    // Nothing to re-seal is the common case for a new account, and it is the
    // one shortcut in this method that can return success without doing
    // anything. The DELETE is the whole point of the call: skipping it leaves
    // the removed device holding a live credential while the UI says it is gone.
    const api = pairingApi(new Map());
    const coordinator = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-000000000001",
      syncKeyFilePath: await makeSyncKeyPath("no-hosts"),
      api,
    });

    await expect(
      coordinator.revokeDevice("00000000-0000-4000-8000-0000000000ff"),
    ).resolves.toBeUndefined();

    expect(api.revokeDevice).toHaveBeenCalledWith("00000000-0000-4000-8000-0000000000ff");
    expect(api.putHostSecret).not.toHaveBeenCalled();
  });

  it("finishes an unrelated device's journal and then actually revokes the requested device", async () => {
    // Returning after the resumed rotation would report success for a device
    // the API was never asked to remove — a silent no-op in exactly the state
    // where a removal is most urgent.
    const setup = await interruptSecondHostRotation("rotation-other-device");

    await expect(
      setup.makeCoordinator().revokeDevice(setup.secondDeviceId),
    ).resolves.toBeUndefined();

    expect(setup.revokeDevice.mock.calls.map(([deviceId]) => deviceId)).toEqual([
      setup.firstDeviceId,
      setup.secondDeviceId,
    ]);
    const adoptedKey = await readHostSecretsSyncKey({
      filePath: setup.syncKeyFilePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
    });
    expect(adoptedKey).toBeDefined();
    if (!adoptedKey) return;
    // Both rotations landed: every stored secret opens under the finally
    // adopted key and no longer under the key the removed devices held.
    for (const [hostId, secret] of setup.stored) {
      await expect(
        openHostSecret({
          syncKey: adoptedKey,
          hostId,
          ownerUserId: "user-1",
          version: secret.version,
          envelope: secret,
        }),
      ).resolves.toEqual({ ssh: `${hostId}.example.com` });
      await expect(
        openHostSecret({
          syncKey: setup.oldSyncKey,
          hostId,
          ownerUserId: "user-1",
          version: secret.version,
          envelope: secret,
        }),
      ).rejects.toThrow();
    }
  });

  it("refuses to rotate against a device that is absent or already revoked", async () => {
    // A full re-seal and version bump of every Host Secret is the cost of a
    // revocation. Spending it on an id the account service will reject buys
    // nothing and rewrites every host for no removal at all.
    const syncKeyFilePath = await makeSyncKeyPath("unknown-target");
    const oldSyncKey = await generateSyncKey();
    await writeHostSecretsSyncKey({
      filePath: syncKeyFilePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      syncKey: oldSyncKey,
    });
    const alreadyRevokedId = "00000000-0000-4000-8000-0000000000aa";
    const stored: NonNullable<GetHostSecretResponse["secret"]> = {
      ...(await sealHostSecret({
        syncKey: oldSyncKey,
        hostId: "host-1",
        ownerUserId: "user-1",
        version: 1,
        secret: { ssh: "host-1.example.com" },
      })),
      updatedAt: "2026-08-14T12:00:00.000Z",
    };
    const api: HostSecretsCoordinatorApi = {
      listHosts: vi.fn(async () => ({ hosts: [host("host-1")] })),
      listDevices: vi.fn(async () => ({
        devices: [device(alreadyRevokedId, () => "2026-08-14T12:00:00.000Z")],
      })),
      getHostSecret: vi.fn(async () => ({ secret: stored })),
      putHostSecret: vi.fn(async () => {
        throw new Error("putHostSecret should not be called for an unrevocable device");
      }),
      putSyncKeyWrap: vi.fn(async () => {
        throw new Error("not pairing");
      }),
      takeSyncKeyWrap: vi.fn(async () => {
        throw new Error("not pairing");
      }),
      revokeDevice: vi.fn(async () => {}),
    };
    const makeCoordinator = () =>
      new HostSecretsCoordinator({
        accountUrl: "https://accounts.example.com",
        userId: "user-1",
        deviceId: "00000000-0000-4000-8000-000000000001",
        syncKeyFilePath,
        api,
      });

    await expect(
      makeCoordinator().revokeDevice("00000000-0000-4000-8000-0000000000bb"),
    ).rejects.toThrow(/not found or already revoked/i);
    await expect(makeCoordinator().revokeDevice(alreadyRevokedId)).rejects.toThrow(
      /not found or already revoked/i,
    );

    expect(api.revokeDevice).not.toHaveBeenCalled();
    expect(api.putHostSecret).not.toHaveBeenCalled();
    // The refusal is total: no journal was left behind to resume later.
    await expect(
      readHostSecretsPendingRotation({
        filePath: syncKeyFilePath,
        accountUrl: "https://accounts.example.com",
        userId: "user-1",
      }),
    ).resolves.toBeUndefined();
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
    const recipientPath = await makeSyncKeyPath("burn-recipient");
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
      syncKeyFilePath: recipientPath,
      api: pairingApi(mailbox),
    });

    const request = await recipient.beginPairing();
    await existing.offerSyncKey(request);
    await recipient.receiveSyncKey();

    for (const expected of [2, 1]) {
      await expect(recipient.confirmSyncKey({ verificationCode: "ZZZZZZ" })).rejects.toMatchObject({
        remainingAttempts: expected,
      });
      await expectUnpaired(recipientPath);
    }
    await expect(recipient.confirmSyncKey({ verificationCode: "ZZZZZZ" })).rejects.toMatchObject({
      remainingAttempts: 0,
    });
    // Burning the pairing must also leave the disk untouched: the last attempt
    // is the one an attacker times a crash against.
    await expectUnpaired(recipientPath);
    // The pairing is gone: even the CORRECT code no longer works.
    await expect(recipient.confirmSyncKey({ verificationCode: "ZZZZZZ" })).rejects.toThrow(
      /Receive a Sync-Key wrap before confirming/i,
    );
  });

  it("rejects a code that differs in any single position, not just an obviously wrong one", async () => {
    // Six characters over a 32-symbol alphabet is 30 bits, and that number IS
    // the security margin: a comparison that inspects only some positions
    // silently drops it to the handful of bits it does look at. Wholly wrong
    // codes cannot detect that — only a code that differs in exactly one place.
    const mailbox = new Map<string, PutSyncKeyWrapRequest["wrap"]>();
    const recipientPath = await makeSyncKeyPath("near-miss-recipient");
    const existing = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-00000000000c",
      syncKeyFilePath: await makeSyncKeyPath("near-miss-existing"),
      api: pairingApi(mailbox),
    });
    const recipient = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-00000000000d",
      syncKeyFilePath: recipientPath,
      api: pairingApi(mailbox),
    });
    // A fresh pairing per near-miss: three attempts is the cap, and a burned
    // pairing would start rejecting for the wrong reason.
    const freshCode = async (): Promise<string> => {
      const offered = await existing.offerSyncKey(await recipient.beginPairing());
      const received = await recipient.receiveSyncKey();
      expect(received.verificationCode).toBe(offered.verificationCode);
      return offered.verificationCode;
    };

    for (let index = 0; index < 6; index += 1) {
      const code = await freshCode();
      expect(code).toHaveLength(6);
      const nearMiss = rotateCodeCharacter(code, index);
      expect(nearMiss).not.toBe(code);
      expect(nearMiss).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
      await expect(recipient.confirmSyncKey({ verificationCode: nearMiss })).rejects.toThrow(
        /does not match/i,
      );
      await expectUnpaired(recipientPath);
    }

    // ...and the exact code still pairs, so the rejections above are precision
    // rather than a gate that refuses everything.
    const code = await freshCode();
    await recipient.confirmSyncKey({ verificationCode: code });
    await expect(
      readHostSecretsSyncKey({
        filePath: recipientPath,
        accountUrl: "https://accounts.example.com",
        userId: "user-1",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses to re-pair a device that already holds the Sync Key", async () => {
    // A second successful pairing would overwrite the current key and orphan
    // every Host Secret sealed under it — data loss from a stray re-pair prompt.
    const syncKeyFilePath = await makeSyncKeyPath("already-paired");
    await writeHostSecretsSyncKey({
      filePath: syncKeyFilePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      syncKey: await generateSyncKey(),
    });
    const coordinator = new HostSecretsCoordinator({
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      deviceId: "00000000-0000-4000-8000-00000000000e",
      syncKeyFilePath,
      api: pairingApi(new Map()),
    });

    await expect(coordinator.beginPairing()).rejects.toThrow(/already has/i);
  });
});
