import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateSyncKey, openHostSecret, sealHostSecret } from "@synara/shared/hostSecrets";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hostSecretsSyncKeyPath,
  readHostSecretsPendingRotation,
  readHostSecretsSyncKey,
  writeHostSecretsPendingRotation,
  writeHostSecretsSyncKey,
} from "./syncKeyStore";

const roots: string[] = [];

async function makePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-host-secrets-key-"));
  roots.push(root);
  return hostSecretsSyncKeyPath(path.join(root, "secrets"));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Host Secrets Sync-Key store", () => {
  it("round-trips a Sync Key through an owner-only atomic file", async () => {
    const filePath = await makePath();
    const original = await generateSyncKey();
    await writeHostSecretsSyncKey({
      filePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      syncKey: original,
    });

    const restored = await readHostSecretsSyncKey({
      filePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
    });
    expect(restored).toBeDefined();
    if (!restored) return;
    const envelope = await sealHostSecret({
      syncKey: original,
      hostId: "host-1",
      ownerUserId: "user-1",
      version: 1,
      secret: { ssh: "ada@example.com" },
    });
    await expect(
      openHostSecret({
        syncKey: restored,
        hostId: "host-1",
        ownerUserId: "user-1",
        version: 1,
        envelope,
      }),
    ).resolves.toEqual({ ssh: "ada@example.com" });
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      // A 0600 file inside a group/world-writable directory is not private:
      // any local user can unlink it and drop in a Sync Key of their choosing,
      // which then seals every later Host Secret.
      expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    }
  });

  it("does not reuse key material across accounts or users", async () => {
    const filePath = await makePath();
    const syncKey = await generateSyncKey();
    await writeHostSecretsPendingRotation({
      filePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      syncKey,
      pendingRotation: {
        deviceId: "00000000-0000-4000-8000-000000000099",
        revocationCompleted: false,
        nextSyncKey: await generateSyncKey(),
        entries: [
          {
            hostId: "host-1",
            ownerUserId: "user-1",
            envelope: await sealHostSecret({
              syncKey,
              hostId: "host-1",
              ownerUserId: "user-1",
              version: 2,
              secret: { ssh: "ada@example.com" },
            }),
          },
        ],
      },
    });

    await expect(
      readHostSecretsSyncKey({
        filePath,
        accountUrl: "https://other.example.com",
        userId: "user-1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      readHostSecretsSyncKey({
        filePath,
        accountUrl: "https://accounts.example.com",
        userId: "user-2",
      }),
    ).resolves.toBeUndefined();
    // The journal carries the same ownership as the key. Signing into another
    // account must not resume the previous account's rotation, or its
    // ciphertexts get uploaded under the wrong tenant's key.
    await expect(
      readHostSecretsPendingRotation({
        filePath,
        accountUrl: "https://other.example.com",
        userId: "user-1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      readHostSecretsPendingRotation({
        filePath,
        accountUrl: "https://accounts.example.com",
        userId: "user-2",
      }),
    ).resolves.toBeUndefined();
    await expect(
      readHostSecretsPendingRotation({
        filePath,
        accountUrl: "https://accounts.example.com",
        userId: "user-1",
      }),
    ).resolves.toMatchObject({ deviceId: "00000000-0000-4000-8000-000000000099" });
  });

  it("treats a missing file as an unpaired device", async () => {
    await expect(
      readHostSecretsSyncKey({
        filePath: await makePath(),
        accountUrl: "https://accounts.example.com",
        userId: "user-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("surfaces a read failure instead of reporting the device as unpaired", async () => {
    // Only ENOENT means "unpaired". Any other read error reported as absence
    // makes the caller generate a fresh Sync Key and overwrite this one,
    // permanently orphaning every Host Secret already in the account service.
    const filePath = await makePath();
    await writeHostSecretsSyncKey({
      filePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      syncKey: await generateSyncKey(),
    });
    const readFile = vi
      .spyOn(fs, "readFile")
      .mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    try {
      await expect(
        readHostSecretsSyncKey({
          filePath,
          accountUrl: "https://accounts.example.com",
          userId: "user-1",
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      readFile.mockRestore();
    }

    await expect(
      readHostSecretsSyncKey({
        filePath,
        accountUrl: "https://accounts.example.com",
        userId: "user-1",
      }),
    ).resolves.toBeDefined();
  });
});
