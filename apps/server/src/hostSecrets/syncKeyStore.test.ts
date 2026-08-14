import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateSyncKey, openHostSecret, sealHostSecret } from "@synara/shared/hostSecrets";
import { afterEach, describe, expect, it } from "vitest";

import {
  hostSecretsSyncKeyPath,
  readHostSecretsSyncKey,
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
    }
  });

  it("does not reuse key material across accounts or users", async () => {
    const filePath = await makePath();
    await writeHostSecretsSyncKey({
      filePath,
      accountUrl: "https://accounts.example.com",
      userId: "user-1",
      syncKey: await generateSyncKey(),
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
});
