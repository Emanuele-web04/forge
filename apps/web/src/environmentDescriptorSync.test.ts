// FILE: environmentDescriptorSync.test.ts
// Purpose: Proves the directory learns each host's real name, marks a host that
//          cannot describe itself as unreachable, and forgets departed hosts.
// Layer: Web environment UX tests

import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");

// Held on an object rather than in `let` bindings: `vi.mock` factories are
// hoisted above module initialisation, and the directory reads the registry at
// import time — a bare `let` would still be in its temporal dead zone.
const registryState = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  clients: [] as readonly unknown[],
}));

vi.mock("./wsEnvironmentRegistry", () => ({
  listWsEnvironmentClients: () => registryState.clients,
  onWsEnvironmentRegistryChange: (listener: () => void) => {
    registryState.listeners.add(listener);
    return () => registryState.listeners.delete(listener);
  },
}));

import {
  environmentDirectorySnapshot,
  environmentLabel,
  resetEnvironmentDirectory,
} from "./environmentDirectory";
import { createEnvironmentDescriptorSync } from "./environmentDescriptorSync";

function descriptor(label: string): ExecutionEnvironmentDescriptor {
  return {
    environmentId: REMOTE_ENVIRONMENT_ID,
    label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.6.3",
    capabilities: { repositoryIdentity: true },
  };
}

function makeClient(input: {
  readonly environmentId: EnvironmentId;
  readonly wsUrl: string | null;
  readonly getEnvironment: () => Promise<ExecutionEnvironmentDescriptor>;
}) {
  return {
    environmentId: input.environmentId,
    wsUrl: input.wsUrl,
    api: { server: { getEnvironment: input.getEnvironment } },
  };
}

function notifyRegistry(clients: readonly unknown[]): void {
  registryState.clients = clients;
  for (const listener of registryState.listeners) listener();
}

beforeEach(() => {
  registryState.clients = [];
  resetEnvironmentDirectory();
});

afterEach(() => {
  resetEnvironmentDirectory();
});

describe("environment descriptor sync", () => {
  it("records a host's real label so the picker can name it", async () => {
    const client = makeClient({
      environmentId: REMOTE_ENVIRONMENT_ID,
      wsUrl: "wss://vps.example.com/ws",
      getEnvironment: async () => descriptor("prod-vps"),
    });
    notifyRegistry([client]);

    const sync = createEnvironmentDescriptorSync();
    sync.sync([client] as never);
    await vi.waitFor(() => {
      expect(environmentLabel(REMOTE_ENVIRONMENT_ID)).toBe("prod-vps");
    });

    const entry = environmentDirectorySnapshot().find(
      (candidate) => candidate.environmentId === REMOTE_ENVIRONMENT_ID,
    );
    expect(entry?.reachability).toBe("reachable");
    sync.dispose();
  });

  it("marks a host that cannot describe itself as unreachable, not perpetually checking", async () => {
    // A permanently-"checking" host is indistinguishable from a working but slow
    // one, so the user would keep clicking a row that never responds. The picker
    // refuses an unreachable host explicitly instead.
    const client = makeClient({
      environmentId: REMOTE_ENVIRONMENT_ID,
      wsUrl: "wss://vps.example.com/ws",
      getEnvironment: async () => {
        throw new Error("connection refused");
      },
    });
    notifyRegistry([client]);

    const sync = createEnvironmentDescriptorSync();
    sync.sync([client] as never);

    await vi.waitFor(() => {
      const entry = environmentDirectorySnapshot().find(
        (candidate) => candidate.environmentId === REMOTE_ENVIRONMENT_ID,
      );
      expect(entry?.reachability).toBe("unreachable");
    });
    sync.dispose();
  });

  it("forgets a departed host's label rather than naming a machine that left", async () => {
    const client = makeClient({
      environmentId: REMOTE_ENVIRONMENT_ID,
      wsUrl: "wss://vps.example.com/ws",
      getEnvironment: async () => descriptor("prod-vps"),
    });
    notifyRegistry([client]);
    const sync = createEnvironmentDescriptorSync();
    sync.sync([client] as never);
    await vi.waitFor(() => {
      expect(environmentLabel(REMOTE_ENVIRONMENT_ID)).toBe("prod-vps");
    });

    // The host is removed; a re-registered id may be a different machine, so the
    // old label must not survive.
    notifyRegistry([]);
    sync.sync([]);
    expect(environmentLabel(REMOTE_ENVIRONMENT_ID)).toBe(REMOTE_ENVIRONMENT_ID);
    sync.dispose();
  });

  it("treats the page's own server as reachable without asking", () => {
    const local = makeClient({
      environmentId: LOCAL_ENVIRONMENT_ID,
      wsUrl: null,
      getEnvironment: async () => descriptor("local"),
    });
    notifyRegistry([local]);
    const entry = environmentDirectorySnapshot().find((candidate) => candidate.isLocal);
    // The page loaded from it, so "checking" would be a lie that blocks starts.
    expect(entry?.reachability).toBe("reachable");
  });
});
