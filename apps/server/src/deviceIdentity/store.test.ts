import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { signDeviceRegistration } from "@synara/shared/deviceKey";
import { importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import { deviceIdentityPath, loadOrCreateDeviceIdentity } from "./store";

describe("device identity persistence", () => {
  it("atomically persists a reloadable ES256 key and returns a non-extractable signer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-device-identity-"));
    const filePath = deviceIdentityPath(path.join(root, "secrets"));

    try {
      const created = await loadOrCreateDeviceIdentity(filePath);
      const reloaded = await loadOrCreateDeviceIdentity(filePath);

      expect(reloaded.publicJwk).toEqual(created.publicJwk);
      expect(reloaded.jkt).toBe(created.jkt);
      expect(reloaded.key.extractable).toBe(false);
      if (process.platform !== "win32") {
        expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      }

      const proof = await signDeviceRegistration({
        key: reloaded.key,
        publicJwk: reloaded.publicJwk,
        userId: "user_1",
        displayName: "Ada's Mac",
        platform: "darwin",
        audience: "https://accounts.example.com/api/v1",
        nowSeconds: 1_786_704_000,
      });
      const verificationKey = await importJWK(reloaded.publicJwk, "ES256");
      await expect(
        jwtVerify(proof, verificationKey, {
          audience: "https://accounts.example.com/api/v1",
          subject: "user_1",
          currentDate: new Date(1_786_704_001_000),
        }),
      ).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
