// The hosts RPC owner boundary: every hosts method is owner-only because the
// directory, devices, grants, and local enrollment all expose account state.
// These tests iterate the handler map so a newly added hosts RPC is guarded by
// construction, matching the account RPC boundary.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EnvironmentId, WS_METHODS } from "@synara/contracts";
import { AccountApiError, type AccountClient } from "@synara/shared/account";
import { deviceThumbprint } from "@synara/shared/deviceKey";
import { Effect, Path as EffectPath } from "effect";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAccountSession, type HostsAccountSession } from "./accountSession";
import { readAccountFile, writeAccountCredentials } from "./accountAuth";
import { deriveServerPaths } from "./config";
import { generateAndPersistHostIdentity } from "./hostIdentity";
import { provideWsConnectionSession } from "./wsConnectionSessions";
import { makeHostsRpcHandlers } from "./wsHostsRpc";

const SAMPLE_INPUTS: Record<string, unknown> = {
  [WS_METHODS.hostsList]: undefined,
  [WS_METHODS.hostsUpdate]: { hostId: "host_1", discoverable: false, name: "Ada's Mac" },
  [WS_METHODS.hostsDelete]: { hostId: "host_1" },
  [WS_METHODS.hostsListDevices]: undefined,
  [WS_METHODS.hostsRevokeDevice]: { deviceId: "00000000-0000-4000-8000-000000000001" },
  [WS_METHODS.hostsApproveDeviceLink]: { userCode: "ABCDEFGH" },
  [WS_METHODS.hostsRequestGrant]: { hostId: "host_1" },
  [WS_METHODS.hostsEnrollment]: undefined,
  [WS_METHODS.hostsUnlinkLocalHost]: undefined,
};

function spySession(): { session: HostsAccountSession; calls: () => string[] } {
  const calls: string[] = [];
  const record =
    <A>(name: string, result: A) =>
    (..._args: unknown[]) => {
      calls.push(name);
      return Promise.resolve(result);
    };
  const host = {
    id: "host_1",
    environmentId: EnvironmentId.makeUnsafe("env_1"),
    name: "Ada's Mac",
    platform: "darwin" as const,
    kind: "local" as const,
    endpoints: [],
    ownerUserId: "user_1",
    discoverable: false,
    linked: true,
    keyGeneration: 1,
    mine: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  };
  const session: HostsAccountSession = {
    listHosts: record("listHosts", { hosts: [host] }),
    updateHost: record("updateHost", host),
    deleteHost: record("deleteHost", undefined),
    listDevices: record("listDevices", { devices: [] }),
    revokeDevice: record("revokeDevice", undefined),
    approveDeviceLink: record("approveDeviceLink", undefined),
    requestGrant: record("requestGrant", { grant: "grant-token" }),
    enrollment: record("enrollment", {
      host,
      organizationMemberCount: 1,
      discoverabilityAcknowledged: true,
    }),
    unlinkLocalHost: record("unlinkLocalHost", undefined),
  };
  return { session, calls: () => calls };
}

const CLIENT_SESSION = {
  role: "client" as const,
  attachmentPrincipal: { ownerKind: "session" as const, ownerId: "paired-client" },
};

const OWNER_SESSION = {
  role: "owner" as const,
  attachmentPrincipal: { ownerKind: "session" as const, ownerId: "owner" },
};

const temporaryDirectories: string[] = [];

async function makeBaseDir(): Promise<string> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-ws-hosts-rpc-"));
  temporaryDirectories.push(baseDir);
  return baseDir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("hosts RPC owner boundary", () => {
  const methodNames = Object.keys(makeHostsRpcHandlers({ accountSession: spySession().session }));

  it("covers every hosts WS method", () => {
    const hostsMethods = Object.values(WS_METHODS).filter((method) => method.startsWith("hosts."));
    expect(methodNames.toSorted()).toEqual(hostsMethods.toSorted());
  });

  it.each(methodNames)(
    "refuses a client-role session on %s without touching account state",
    async (method) => {
      const { session, calls } = spySession();
      const handlers = makeHostsRpcHandlers({ accountSession: session }) as unknown as Record<
        string,
        (input?: unknown) => Effect.Effect<unknown, { message: string }>
      >;
      const handler = handlers[method];
      if (!handler) throw new Error(`no handler for ${method}`);

      const result = await Effect.runPromise(
        provideWsConnectionSession(
          handler(SAMPLE_INPUTS[method]).pipe(Effect.flip),
          CLIENT_SESSION,
        ),
      );

      expect(result.message).toMatch(/owner authorization/i);
      expect(calls()).toEqual([]);
    },
  );

  it.each(methodNames)("admits an owner-role session on %s", async (method) => {
    const { session, calls } = spySession();
    const handlers = makeHostsRpcHandlers({ accountSession: session }) as unknown as Record<
      string,
      (input?: unknown) => Effect.Effect<unknown, unknown>
    >;
    const handler = handlers[method];
    if (!handler) throw new Error(`no handler for ${method}`);

    await Effect.runPromise(
      provideWsConnectionSession(handler(SAMPLE_INPUTS[method]), OWNER_SESSION),
    );

    expect(calls()).toHaveLength(1);
  });
});

describe("hosts enrollment", () => {
  it("persists a successful discoverability answer per local host", async () => {
    const baseDir = await makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: "client_1",
      workosApiUrl: "https://api.workos.com",
      organizationId: "org_1",
      userId: "user_1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 1,
    });
    const host = {
      id: "host_1",
      environmentId: EnvironmentId.makeUnsafe("env_1"),
      name: "Ada's Mac",
      platform: "darwin" as const,
      kind: "local" as const,
      endpoints: [],
      ownerUserId: "user_1",
      discoverable: false,
      linked: true,
      keyGeneration: 1,
      mine: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    };
    const client = {
      updateHost: vi.fn(() => Promise.resolve(host)),
      listHosts: vi.fn(() => Promise.resolve({ hosts: [host] })),
      countOrganizationMembers: vi.fn(() => Promise.resolve(2)),
    } as unknown as AccountClient;
    const accountSession = createAccountSession({ baseDir, client });

    await accountSession.updateHost({ hostId: "host_1", discoverable: false });

    expect(await readAccountFile(baseDir)).toMatchObject({
      discoverabilityAcknowledgedByHostId: { host_1: true },
    });
    await expect(accountSession.enrollment()).resolves.toMatchObject({
      host,
      organizationMemberCount: 2,
      discoverabilityAcknowledged: true,
    });
  });

  it("returns a null organization member count when the account provider fails", async () => {
    const baseDir = await makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: "client_1",
      workosApiUrl: "https://api.workos.com",
      organizationId: "org_1",
      userId: "user_1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 1,
    });
    const host = {
      id: "host_1",
      environmentId: EnvironmentId.makeUnsafe("env_1"),
      name: "Ada's Mac",
      platform: "darwin" as const,
      kind: "local" as const,
      endpoints: [],
      ownerUserId: "user_1",
      discoverable: false,
      linked: true,
      keyGeneration: 1,
      mine: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    };
    const countOrganizationMembers = vi.fn(() => Promise.reject(new Error("provider down")));
    const client = {
      listHosts: vi.fn(() => Promise.resolve({ hosts: [host] })),
      countOrganizationMembers,
    } as unknown as AccountClient;
    const accountSession = createAccountSession({ baseDir, client });
    const handler = makeHostsRpcHandlers({ accountSession })[WS_METHODS.hostsEnrollment];

    const enrollment = await Effect.runPromise(
      provideWsConnectionSession(handler(), OWNER_SESSION),
    );

    expect(enrollment).toEqual({
      host,
      organizationMemberCount: null,
      discoverabilityAcknowledged: false,
    });
    expect(countOrganizationMembers).toHaveBeenCalledTimes(1);
  });
});

describe("device-bound grants", () => {
  it("registers this shell's key and passes its real jkt to grant issuance", async () => {
    const baseDir = await makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: "client_1",
      workosApiUrl: "https://api.workos.com",
      organizationId: "org_1",
      userId: "user_1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    let registeredJkt: string | undefined;
    const registerDevice = vi.fn(async (_token: string, proof: string) => {
      const claims = decodeJwt(proof) as {
        publicKeyJwk: Parameters<typeof deviceThumbprint>[0];
        displayName: string;
        platform: "darwin" | "linux" | "windows";
      };
      registeredJkt = await deviceThumbprint(claims.publicKeyJwk);
      return {
        device: {
          id: "00000000-0000-4000-8000-000000000001",
          publicKeyJwk: claims.publicKeyJwk,
          jkt: registeredJkt,
          displayName: claims.displayName,
          platform: claims.platform,
          createdAt: "2026-08-14T12:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        },
      };
    });
    const requestGrant = vi.fn((_token: string, _hostId: string, jkt: string) =>
      Promise.resolve({ grant: `grant-for:${jkt}` }),
    );
    const client = { registerDevice, requestGrant } as unknown as AccountClient;
    const accountSession = createAccountSession({ baseDir, client });
    const handler = makeHostsRpcHandlers({ accountSession })[WS_METHODS.hostsRequestGrant];

    const result = await Effect.runPromise(
      provideWsConnectionSession(handler({ hostId: "host_1" }), OWNER_SESSION),
    );

    expect(registerDevice).toHaveBeenCalledOnce();
    expect(registeredJkt).toBeDefined();
    expect(requestGrant).toHaveBeenCalledWith("access-token", "host_1", registeredJkt);
    expect(result).toEqual({ grant: `grant-for:${registeredJkt}` });
    expect(await readAccountFile(baseDir)).toMatchObject({
      deviceId: "00000000-0000-4000-8000-000000000001",
      deviceJkt: registeredJkt,
    });
  });

  it("re-registers a revoked local device before retrying the grant", async () => {
    const baseDir = await makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: "client_1",
      workosApiUrl: "https://api.workos.com",
      organizationId: "org_1",
      userId: "user_1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    let revoked = false;
    let registrationNumber = 0;
    let jkt = "";
    const registerDevice = vi.fn(async (_token: string, proof: string) => {
      const claims = decodeJwt(proof) as {
        publicKeyJwk: Parameters<typeof deviceThumbprint>[0];
        displayName: string;
        platform: "darwin" | "linux" | "windows";
      };
      jkt = await deviceThumbprint(claims.publicKeyJwk);
      revoked = false;
      registrationNumber += 1;
      return {
        device: {
          id: `00000000-0000-4000-8000-${String(registrationNumber).padStart(12, "0")}`,
          publicKeyJwk: claims.publicKeyJwk,
          jkt,
          displayName: claims.displayName,
          platform: claims.platform,
          createdAt: "2026-08-14T12:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        },
      };
    });
    const requestGrant = vi.fn(async () => {
      if (revoked) {
        throw new AccountApiError({
          code: "device_not_registered",
          status: 403,
          message: "The device was revoked",
        });
      }
      return { grant: `grant-for:${jkt}` };
    });
    const refreshAccessToken = vi.fn(() => Promise.reject(new Error("must not refresh")));
    const client = {
      registerDevice,
      requestGrant,
      refreshAccessToken,
    } as unknown as AccountClient;
    const accountSession = createAccountSession({ baseDir, client });
    const handler = makeHostsRpcHandlers({ accountSession })[WS_METHODS.hostsRequestGrant];
    const request = () =>
      Effect.runPromise(provideWsConnectionSession(handler({ hostId: "host_1" }), OWNER_SESSION));

    const first = await request();
    expect(first).toEqual({ grant: `grant-for:${jkt}` });
    revoked = true;
    const replacement = await request();
    expect(replacement).toEqual({ grant: `grant-for:${jkt}` });

    expect(registerDevice).toHaveBeenCalledTimes(2);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(await readAccountFile(baseDir)).toMatchObject({
      deviceId: "00000000-0000-4000-8000-000000000002",
      deviceJkt: jkt,
    });
  });
});

describe("local host unlink", () => {
  it("uses HostProof and clears only the local host registration", async () => {
    const baseDir = await makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: "client_1",
      workosApiUrl: "https://api.workos.com",
      organizationId: "org_1",
      userId: "user_1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 3,
      discoverabilityAcknowledgedByHostId: { host_1: true },
    });
    const { hostIdentityPath } = await Effect.runPromise(
      deriveServerPaths(baseDir, undefined).pipe(Effect.provide(EffectPath.layer)),
    );
    await generateAndPersistHostIdentity(hostIdentityPath);
    const unlinkHost = vi.fn(() => Promise.resolve({}));
    const client = { unlinkHost } as unknown as AccountClient;
    const accountSession = createAccountSession({ baseDir, client });

    await accountSession.unlinkLocalHost();

    expect(unlinkHost).toHaveBeenCalledWith(expect.stringMatching(/^eyJ/), "host_1");
    expect(await readAccountFile(baseDir)).toEqual({
      accountUrl: "https://accounts.example.com",
      workosClientId: "client_1",
      workosApiUrl: "https://api.workos.com",
      organizationId: "org_1",
      userId: "user_1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    await expect(fs.access(hostIdentityPath)).rejects.toThrow();
  });
});
