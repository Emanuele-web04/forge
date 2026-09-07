import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type AccountHost, EnvironmentId } from "@synara/contracts";
import { AccountApiError, type AccountClient } from "@synara/shared/account";
import { describe, expect, it } from "vitest";

import { readAccountFile, runDeviceCodeHostLink } from "./accountAuth";

describe("runDeviceCodeHostLink", () => {
  it("polls approval and links a headless host with a fresh persisted key", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-device-code-link-"));
    fs.mkdirSync(path.join(baseDir, "userdata"), { recursive: true });
    fs.writeFileSync(path.join(baseDir, "userdata", "environment-id"), "device-env");
    let polls = 0;
    let proof = "";
    const host: AccountHost = {
      id: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
      environmentId: EnvironmentId.makeUnsafe("device-env"),
      name: "Headless",
      platform: "linux",
      kind: "local",
      endpoints: [],
      ownerUserId: "owner",
      discoverable: true,
      linked: true,
      keyGeneration: 1,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    const client = {
      startDeviceHostLink: async () => ({
        deviceCode: "device-code",
        userCode: "ABCDEFGH",
        verificationUri: "https://accounts.example.test/link",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        interval: 5 as const,
      }),
      exchangeDeviceHostLink: async () => {
        polls += 1;
        if (polls === 1) {
          throw new AccountApiError({
            code: "approval_pending",
            status: 428,
            message: "pending",
          });
        }
        return {
          challengeId: "ea4fc40a-a4f7-498f-bf78-c6a69536ecab",
          nonce: "ZGV2aWNlLW5vbmNl",
        };
      },
      completeHostLink: async (request: { proof: string }) => {
        proof = request.proof;
        return { host };
      },
      instance: async () => ({
        version: "0.7.1",
        authMode: "workos" as const,
        clientId: "client",
        workosApiUrl: "https://workos.example.test",
      }),
      replaceHostEndpoints: async () => host,
    } as unknown as AccountClient;
    try {
      await runDeviceCodeHostLink({
        accountUrl: "https://accounts.example.test",
        baseDir,
        client,
        platform: "linux",
        hostname: "Headless",
        devicePollDelayMs: 0,
        stdout: () => {},
      });
      expect(polls).toBe(2);
      expect(proof.split(".")).toHaveLength(3);
      expect(await readAccountFile(baseDir)).toMatchObject({
        hostId: host.id,
        hostOwnerUserId: "owner",
        hostKeyGeneration: 1,
      });
      expect(fs.existsSync(path.join(baseDir, "userdata", "secrets", "host-identity.json"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
