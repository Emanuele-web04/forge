import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultKeyProtection, type VaultKeyStore } from "./vaultKeyProtection";

const homes: string[] = [];
const password = "synthetic-master-test-password";
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function directory() {
  const home = await mkdtemp(join(tmpdir(), "synara-vault-key-"));
  homes.push(home);
  return home;
}

function keyStore(): VaultKeyStore {
  const key = randomBytes(32);
  return {
    available: async () => true,
    encrypt: (value) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt: (value) => {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}

describe("vault key protection", () => {
  it("requires setup without OS storage, persists only a wrapped key, and locks on restart", async () => {
    const home = await directory();
    const keys = new VaultKeyProtection(home);
    await expect(keys.provide()).rejects.toThrow("Unlock");
    await expect(keys.setup("short")).rejects.toThrow("12 characters");
    await keys.setup(password);
    const original = await keys.provide();
    const file = await readFile(join(home, "key-protection.json"), "utf8");
    expect(file).not.toContain(original.toString("base64"));
    expect(file).not.toContain(password);
    const restarted = new VaultKeyProtection(home);
    expect(await restarted.status()).toEqual({
      configured: true,
      locked: true,
      osProtected: false,
    });
    await restarted.authenticate(password);
    expect(await restarted.provide()).toEqual(original);
    const copy = await restarted.provide();
    copy.fill(0);
    expect(await restarted.provide()).toEqual(original);
    await expect(restarted.setup(password)).rejects.toThrow();
    await restarted.lock();
    await expect(restarted.provide()).rejects.toThrow();
    keys.dispose();
    restarted.dispose();
  });

  it("migrates the existing key without changing it and supports OS-backed agent access", async () => {
    const home = await directory();
    const original = randomBytes(32);
    await writeFile(join(home, "vault.key"), original);
    const store = keyStore();
    const keys = new VaultKeyProtection(home, store);
    expect(await keys.provide()).toEqual(original);
    await expect(readFile(join(home, "vault.key"))).rejects.toThrow();
    await keys.setup(password);
    const restarted = new VaultKeyProtection(home, store);
    expect(await restarted.provide()).toEqual(original);
    await expect(restarted.authenticate("wrong-password")).rejects.toThrow("verification failed");
    keys.dispose();
    restarted.dispose();
  });

  it("can recover with the master password if the OS-backed copy becomes unavailable", async () => {
    const home = await directory();
    const keys = new VaultKeyProtection(home, keyStore());
    await keys.setup(password);
    const original = await keys.provide();
    const restarted = new VaultKeyProtection(home, keyStore());
    expect((await restarted.status()).locked).toBe(true);
    await restarted.authenticate(password);
    expect(await restarted.provide()).toEqual(original);
    keys.dispose();
    restarted.dispose();
  });

  it("refuses to generate a replacement key when encrypted credentials already exist", async () => {
    const home = await directory();
    await writeFile(join(home, "vault.enc"), "existing-encrypted-data");
    const keys = new VaultKeyProtection(home, keyStore());
    await expect(keys.provide()).rejects.toThrow("refusing to replace");
    await expect(readFile(join(home, "key-protection.json"))).rejects.toThrow();
    keys.dispose();
  });

  it("resumes an interrupted migration only when the remaining legacy key matches", async () => {
    const home = await directory();
    const store = keyStore();
    const keys = new VaultKeyProtection(home, store);
    const original = await keys.provide();
    await writeFile(join(home, "vault.key"), original);
    const resumed = new VaultKeyProtection(home, store);
    expect(await resumed.provide()).toEqual(original);
    await expect(readFile(join(home, "vault.key"))).rejects.toThrow();
    const mismatched = randomBytes(32);
    await writeFile(join(home, "vault.key"), mismatched);
    const refused = new VaultKeyProtection(home, store);
    await expect(refused.provide()).rejects.toThrow("could not be verified");
    expect(await readFile(join(home, "vault.key"))).toEqual(mismatched);
    keys.dispose();
    resumed.dispose();
    refused.dispose();
  });

  it("refuses corrupt wrapping data without overwriting it or accepting a master password", async () => {
    const home = await directory();
    const keys = new VaultKeyProtection(home);
    await keys.setup(password);
    const path = join(home, "key-protection.json");
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.master.tag = randomBytes(16).toString("base64");
    const corrupted = JSON.stringify(envelope);
    await writeFile(path, corrupted);
    const restarted = new VaultKeyProtection(home);
    await expect(restarted.authenticate(password)).rejects.toThrow("verification failed");
    await expect(restarted.provide()).rejects.toThrow("Unlock");
    await expect(restarted.setup(password)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(corrupted);
    keys.dispose();
    restarted.dispose();
  });
});
