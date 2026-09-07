import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AccountDevice, DevicePublicKeyJwk } from "@synara/contracts";
import type { AccountClient } from "@synara/shared/account";
import { deviceThumbprint } from "@synara/shared/deviceKey";
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";

import { ensureAccountDeviceRegistration } from "./accountDeviceRegistration";
import { readAccountFile, writeAccountCredentials } from "./accountAuth";

const ACCOUNT_URL = "https://accounts.example.com";

describe("account device registration", () => {
  it("registers fresh, reuses the row on relaunch, and persists a replacement after revocation", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-device-registration-"));
    await writeAccountCredentials(baseDir, {
      accountUrl: ACCOUNT_URL,
      workosClientId: "client_1",
      workosApiUrl: "https://api.workos.example",
      organizationId: "org_1",
      userId: "user_1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });

    let active: AccountDevice | undefined;
    let nextId = 1;
    const registerDevice = vi.fn(async (_token: string, proof: string) => {
      const claims = decodeJwt(proof) as {
        publicKeyJwk: DevicePublicKeyJwk;
        displayName: string;
        platform: "darwin";
      };
      const jkt = await deviceThumbprint(claims.publicKeyJwk);
      active ??= {
        id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
        publicKeyJwk: claims.publicKeyJwk,
        jkt,
        displayName: claims.displayName,
        platform: claims.platform,
        createdAt: "2026-08-14T12:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      };
      return { device: active };
    });
    const client = { registerDevice } as unknown as AccountClient;

    try {
      const first = await ensureAccountDeviceRegistration({
        baseDir,
        accountUrl: ACCOUNT_URL,
        client,
        displayName: "Ada's Mac",
        platform: "darwin",
      });
      const relaunched = await ensureAccountDeviceRegistration({
        baseDir,
        accountUrl: ACCOUNT_URL,
        client,
        displayName: "Ada's Mac",
        platform: "darwin",
      });

      expect(relaunched).toEqual(first);
      expect(registerDevice).toHaveBeenCalledTimes(2);

      active = undefined;
      const replacement = await ensureAccountDeviceRegistration({
        baseDir,
        accountUrl: ACCOUNT_URL,
        client,
        displayName: "Ada's Mac",
        platform: "darwin",
      });

      expect(replacement.deviceId).not.toBe(first.deviceId);
      expect(replacement.jkt).toBe(first.jkt);
      expect(await readAccountFile(baseDir)).toMatchObject({
        deviceId: replacement.deviceId,
        deviceJkt: replacement.jkt,
      });
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});
