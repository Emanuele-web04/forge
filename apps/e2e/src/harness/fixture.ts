import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getRequestListener } from "@hono/node-server";
import type { HostPublicKeyJwk } from "@synara/contracts";
import { createAccountClient } from "@synara/shared/account";

import { HeadlessClient } from "../headlessClient";
import { createApp } from "../../../api/src/app";
import { runMigrations } from "../../../api/src/db/migrate";
import { startFakeWorkos, type FakeWorkos } from "../../../api/src/testing/fakeWorkos";
import { createRelayApp, type RelayApplication } from "../../../relay/src/app";
import {
  accountCredentialsPath,
  readAccountFile,
  runAuthLogin,
  runDeviceCodeHostLink,
  writeAccountCredentials,
  type StoredAccountFile,
} from "../../../server/src/accountAuth";
import {
  deleteHostIdentity,
  mintHostProof as mintHostProofJwt,
  readHostIdentity,
  type HostIdentity,
} from "../../../server/src/hostIdentity";
import { bindEphemeralHttpServer, type EphemeralHttpServer } from "./network";
import { startRealHost, type RunningHost } from "./host";

export type TestSession = {
  readonly userId: string;
  readonly orgId: string;
  readonly accessToken: string;
};

type HostRow = {
  readonly id: string;
  readonly environmentId: string;
  readonly publicKeyJwk: HostPublicKeyJwk | null;
  readonly keyGeneration: number;
};

export type LinkedHost = {
  readonly row: HostRow;
  readonly identity: HostIdentity;
};

export type DeviceCodeLinkedHost = LinkedHost & { readonly stored: StoredAccountFile };

export interface E2eFixture extends AsyncDisposable {
  readonly apiOrigin: string;
  readonly relayOrigin: string;
  readonly owner: TestSession;
  linkHost(): Promise<LinkedHost>;
  relinkHost(): Promise<LinkedHost>;
  linkHostWithDeviceCode(): Promise<DeviceCodeLinkedHost>;
  mintHostProof(host: LinkedHost): Promise<string>;
  requestRelayTicket(proof: string, hostId: string): Promise<void>;
  startHost(): Promise<RunningHost>;
  createMember(): Promise<TestSession>;
  createClient(session?: TestSession): Promise<HeadlessClient>;
  setDiscoverable(hostId: string, discoverable: boolean): Promise<void>;
  stopRelay(): Promise<void>;
  stopApi(): Promise<void>;
}

let migrations: Promise<void> | undefined;

function ensureMigrations(databaseUrl: string): Promise<void> {
  migrations ??= runMigrations(databaseUrl).catch((error) => {
    migrations = undefined;
    throw error;
  });
  return migrations;
}

function hostIdentityPath(baseDir: string): string {
  return path.join(baseDir, "userdata", "secrets", "host-identity.json");
}

async function ownerSession(workos: FakeWorkos): Promise<TestSession> {
  const user = workos.addUser({});
  const org = workos.addOrganization({ name: `E2E workspace ${randomUUID()}` });
  workos.addMembership(org.id, user.id);
  return {
    userId: user.id,
    orgId: org.id,
    accessToken: await workos.signAccessToken({
      sub: user.id,
      sid: randomUUID(),
      orgId: org.id,
    }),
  };
}

async function readHostRow(
  pool: Awaited<ReturnType<typeof createApp>>["pool"],
  ownerUserId: string,
): Promise<HostRow> {
  const result = await pool.query<{
    id: string;
    environment_id: string;
    public_key_jwk: HostPublicKeyJwk | null;
    key_generation: number;
  }>(
    `SELECT id, environment_id, public_key_jwk, key_generation
       FROM hosts
      WHERE owner_user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [ownerUserId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("linked host row was not persisted");
  return {
    id: row.id,
    environmentId: row.environment_id,
    publicKeyJwk: row.public_key_jwk,
    keyGeneration: row.key_generation,
  };
}

export async function createE2eFixture(databaseUrl: string): Promise<E2eFixture> {
  await ensureMigrations(databaseUrl);
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-slice-e2e-"));
  const apiHttp = await bindEphemeralHttpServer().catch(async (error) => {
    await fs.rm(baseDir, { recursive: true, force: true });
    throw error;
  });
  let relayHttp: EphemeralHttpServer | undefined;
  let workos: FakeWorkos | undefined;
  let relay: RelayApplication | undefined;
  let api: Awaited<ReturnType<typeof createApp>> | undefined;
  let owner: TestSession | undefined;
  let disposed = false;
  const userIds = new Set<string>();
  const hosts = new Set<RunningHost>();
  const clients = new Set<HeadlessClient>();

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    for (const client of clients) await client[Symbol.asyncDispose]().catch(() => undefined);
    clients.clear();
    for (const host of hosts) {
      try {
        await host[Symbol.asyncDispose]();
      } catch {
        // Continue releasing the rest of the fixture after a partial host shutdown.
      }
    }
    hosts.clear();
    relay?.close();
    await relayHttp?.close().catch(() => undefined);
    if (api && owner) {
      const hostIds = await api.pool
        .query<{ id: string }>("SELECT id FROM hosts WHERE owner_user_id = $1", [owner.userId])
        .then((result) => result.rows.map((row) => row.id))
        .catch(() => []);
      if (hostIds.length > 0) {
        await api.pool
          .query("DELETE FROM revocation_events WHERE host_id = ANY($1::uuid[])", [hostIds])
          .catch(() => undefined);
      }
      await api.pool
        .query("DELETE FROM link_challenges WHERE owner_user_id = ANY($1::text[])", [[...userIds]])
        .catch(() => undefined);
      await api.pool
        .query("DELETE FROM devices WHERE user_id = ANY($1::text[])", [[...userIds]])
        .catch(() => undefined);
      await api.pool
        .query("DELETE FROM hosts WHERE owner_user_id = $1", [owner.userId])
        .catch(() => undefined);
    }
    await apiHttp.close().catch(() => undefined);
    await api?.pool.end().catch(() => undefined);
    await workos?.close().catch(() => undefined);
    await fs.rm(baseDir, { recursive: true, force: true });
  }

  try {
    workos = await startFakeWorkos();
    const relayServiceToken = `e2e-relay-${randomUUID()}`;
    api = await createApp(
      workos.config({
        databaseUrl,
        baseUrl: apiHttp.origin,
        apiPublicUrl: `${apiHttp.origin}/api/v1`,
        relayServiceToken,
        port: 0,
        trustedProxyHops: 0,
      }),
    );
    apiHttp.setRequestListener(getRequestListener(api.app.fetch));

    relayHttp = await bindEphemeralHttpServer();
    relay = await createRelayApp(
      {
        port: 0,
        apiBaseUrl: apiHttp.origin,
        apiIssuer: `${apiHttp.origin}/api/v1`,
        relayServiceToken,
        maxPairs: 64,
        highWaterBytes: 32 * 1024,
      },
      {
        pendingTimeoutMs: 2_000,
        keepaliveIntervalMs: 250,
        revocationPollIntervalMs: 25,
        revocationInitialBackoffMs: 10,
        revocationMaxBackoffMs: 100,
        stallTimeoutMs: 15_000,
        backpressurePollMs: 5,
        logger: { error() {}, warn() {} },
      },
    );
    relayHttp.setRequestListener(getRequestListener(relay.app.fetch));
    relayHttp.server.on("upgrade", relay.handleUpgrade);

    owner = await ownerSession(workos);
    userIds.add(owner.userId);
    await writeAccountCredentials(baseDir, {
      accountUrl: apiHttp.origin,
      workosClientId: workos.clientId,
      workosApiUrl: workos.origin,
      organizationId: owner.orgId,
      userId: owner.userId,
      accessToken: owner.accessToken,
      refreshToken: `unused-e2e-refresh-${randomUUID()}`,
    });
  } catch (error) {
    await dispose();
    throw error;
  }

  if (!api || !owner || !workos || !relayHttp) {
    await dispose();
    throw new Error("E2E fixture startup did not initialize every service");
  }
  const activeApi = api;
  const activeOwner = owner;
  const activeWorkos = workos;
  const activeRelayHttp = relayHttp;
  const account = createAccountClient({ baseUrl: apiHttp.origin });

  async function linkedHost(): Promise<LinkedHost> {
    const row = await readHostRow(activeApi.pool, activeOwner.userId);
    const identity = await readHostIdentity(hostIdentityPath(baseDir));
    if (!identity) throw new Error("host identity was not persisted");
    return { row, identity };
  }

  async function runLink(): Promise<LinkedHost> {
    const output: string[] = [];
    await runAuthLogin({
      accountUrl: apiHttp.origin,
      baseDir,
      platform: "linux",
      hostname: `E2E host ${randomUUID()}`,
      stdout: (line) => output.push(line),
    });
    const stored = await readAccountFile(baseDir);
    if (!stored?.hostId) {
      throw new Error(`real host link did not complete:\n${output.join("")}`);
    }
    return linkedHost();
  }

  return {
    apiOrigin: apiHttp.origin,
    relayOrigin: activeRelayHttp.origin,
    owner: activeOwner,
    linkHost: runLink,
    async relinkHost() {
      const stored = await readAccountFile(baseDir);
      if (!stored) throw new Error("host credentials disappeared before re-link");
      const {
        hostId: _hostId,
        hostOwnerUserId: _hostOwnerUserId,
        hostKeyGeneration: _hostKeyGeneration,
        ...session
      } = stored;
      await writeAccountCredentials(baseDir, session);
      await deleteHostIdentity(hostIdentityPath(baseDir));
      return runLink();
    },
    async mintHostProof(host) {
      return mintHostProofJwt({
        identity: host.identity,
        apiIssuer: `${apiHttp.origin}/api/v1`,
        environmentId: host.row.environmentId,
        hostId: host.row.id,
        keyGeneration: host.row.keyGeneration,
      });
    },
    async requestRelayTicket(proof, hostId) {
      await account.requestRelayTicket(proof, hostId);
    },
    async linkHostWithDeviceCode() {
      // The headless flow must prove it needs no pre-existing app session.
      // The owner token remains only in this fixture so the separate approval
      // request can stand in for the user acting from another signed-in device.
      await fs.rm(accountCredentialsPath(baseDir), { force: true });
      let resolveUserCode!: (code: string) => void;
      const userCode = new Promise<string>((resolve) => {
        resolveUserCode = resolve;
      });
      const linking = runDeviceCodeHostLink({
        accountUrl: apiHttp.origin,
        baseDir,
        platform: "linux",
        hostname: `E2E headless host ${randomUUID()}`,
        devicePollDelayMs: 10,
        stdout: (line) => {
          const match = /enter code ([A-Z2-9]{8})/.exec(line);
          if (match?.[1]) resolveUserCode(match[1]);
        },
      });
      await account.approveDeviceHostLink(activeOwner.accessToken, {
        userCode: await userCode,
      });
      await linking;
      const linked = await linkedHost();
      const stored = await readAccountFile(baseDir);
      if (!stored) throw new Error("device-code link did not persist host credentials");
      return { ...linked, stored };
    },
    async startHost() {
      const host = await startRealHost({ baseDir, relayOrigin: activeRelayHttp.origin });
      hosts.add(host);
      const deadline = Date.now() + 10_000;
      while (relay?.core.hostCount !== 1) {
        if (Date.now() >= deadline) {
          await host[Symbol.asyncDispose]();
          hosts.delete(host);
          throw new Error("real host did not establish its relay control socket");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return host;
    },
    async createMember() {
      const member = activeWorkos.addUser({});
      activeWorkos.addMembership(activeOwner.orgId, member.id);
      const session = {
        userId: member.id,
        orgId: activeOwner.orgId,
        accessToken: await activeWorkos.signAccessToken({
          sub: member.id,
          sid: randomUUID(),
          orgId: activeOwner.orgId,
        }),
      };
      userIds.add(session.userId);
      return session;
    },
    async createClient(session = activeOwner) {
      const client = new HeadlessClient({
        apiOrigin: apiHttp.origin,
        userId: session.userId,
        accessToken: session.accessToken,
      });
      clients.add(client);
      return client;
    },
    async setDiscoverable(hostId, discoverable) {
      await account.updateHost(activeOwner.accessToken, hostId, { discoverable });
    },
    async stopRelay() {
      relay?.close();
      relay = undefined;
      await activeRelayHttp.close();
    },
    async stopApi() {
      await apiHttp.close();
    },
    async [Symbol.asyncDispose]() {
      await dispose();
    },
  };
}
