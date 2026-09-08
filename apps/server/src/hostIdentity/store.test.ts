import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { generateAndPersistHostIdentity, hostIdentityPath, readHostIdentity } from "./store";

describe("host identity persistence", () => {
  it("persists a reloadable Ed25519 PKCS8/SPKI keypair with owner-only permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-host-identity-"));
    const filePath = hostIdentityPath(path.join(root, "secrets"));

    try {
      const created = await generateAndPersistHostIdentity(filePath);
      const reloaded = await readHostIdentity(filePath);

      expect(reloaded).toEqual(created);
      expect(created.privateKeyPem).toContain("BEGIN PRIVATE KEY");
      expect(created.publicKeyPem).toContain("BEGIN PUBLIC KEY");
      if (process.platform !== "win32") {
        expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("re-link atomically replaces the complete document with a fresh keypair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-host-identity-relink-"));
    const filePath = hostIdentityPath(path.join(root, "secrets"));

    try {
      const first = await generateAndPersistHostIdentity(filePath);
      const replacements = await Promise.all(
        Array.from({ length: 12 }, () => generateAndPersistHostIdentity(filePath)),
      );
      const persisted = await readHostIdentity(filePath);

      expect(persisted).toBeDefined();
      expect(persisted).not.toEqual(first);
      expect(replacements).toContainEqual(persisted);
      expect(
        (await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses malformed or mismatched key documents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-host-identity-invalid-"));
    const filePath = hostIdentityPath(path.join(root, "secrets"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 1, privateKeyPem: "not-pem", publicKeyPem: "not-pem" }),
    );

    try {
      await expect(readHostIdentity(filePath)).rejects.toThrow("host identity");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
