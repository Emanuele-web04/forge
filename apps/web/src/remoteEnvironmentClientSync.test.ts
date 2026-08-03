// FILE: remoteEnvironmentClientSync.test.ts
// Purpose: The CLIENT half of the composition — a host the server reports as
//          ready must become a registered WebSocket client, and a host that
//          goes away must be deregistered.
// Layer: Web transport aggregation tests
//
// This is the last link in the chain the feature was missing. The server can
// publish an environment to the proxy perfectly and the UI still shows nothing
// unless something calls `ensureWsEnvironmentClient` with the provisioned id.
// Delete that call, or the removal call, and a DIFFERENT test here fails.

import { readFile } from "node:fs/promises";

import type { RemoteEnvironmentStatus, RemoteHostId } from "@synara/contracts";
import { EnvironmentId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureMock = vi.fn();
const removeMock = vi.fn((_id: unknown) => Promise.resolve());
let emit: ((payload: { statuses: readonly RemoteEnvironmentStatus[] }) => void) | undefined;

vi.mock("./wsEnvironmentRegistry", () => ({
  ensureWsEnvironmentClient: (input: unknown) => ensureMock(input),
  removeWsEnvironmentClient: (id: unknown) => removeMock(id),
  onRemoteEnvironmentStatusesUpdated: (
    listener: (payload: { statuses: readonly RemoteEnvironmentStatus[] }) => void,
  ) => {
    emit = listener;
    return () => {
      emit = undefined;
    };
  },
}));

const { createRemoteEnvironmentClientSync, remoteEnvironmentIdsToRegister } =
  await import("./remoteEnvironmentClientSync");

const ENVIRONMENT_ID = EnvironmentId.makeUnsafe("6f9d0c6e-7a1f-4d2b-9a3c-0e5d1b2c3d4e");

function status(overrides: Partial<RemoteEnvironmentStatus> = {}): RemoteEnvironmentStatus {
  return {
    hostId: "host-1" as RemoteHostId,
    phase: "ready",
    environmentId: ENVIRONMENT_ID,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as RemoteEnvironmentStatus;
}

beforeEach(() => {
  ensureMock.mockClear();
  removeMock.mockClear();
  emit = undefined;
});

describe("remoteEnvironmentIdsToRegister", () => {
  it("selects ready hosts that reported an environment id", () => {
    expect(remoteEnvironmentIdsToRegister([status()])).toEqual([ENVIRONMENT_ID]);
  });

  it("ignores a host that is not ready", () => {
    expect(remoteEnvironmentIdsToRegister([status({ phase: "bootstrapping" })])).toEqual([]);
  });

  it("ignores a ready host with no environment id rather than inventing one", () => {
    // The invariant: an id is only ever the one the handshake proved. A client
    // that synthesised one here would open a socket for a path the proxy has no
    // entry for.
    const withoutId = { ...status() } as Record<string, unknown>;
    delete withoutId.environmentId;
    expect(
      remoteEnvironmentIdsToRegister([withoutId as unknown as RemoteEnvironmentStatus]),
    ).toEqual([]);
  });
});

describe("createRemoteEnvironmentClientSync", () => {
  it("registers a client for a ready host, on the proxy route", () => {
    const sync = createRemoteEnvironmentClientSync();
    emit?.({ statuses: [status()] });

    // THE LAST LINK. Without this call nothing in the UI ever observes the
    // remote server, no matter how correctly the server published it.
    expect(ensureMock).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      url: `/env/${ENVIRONMENT_ID}/ws`,
    });
    sync.dispose();
  });

  it("registers each environment once across repeated status pushes", () => {
    const sync = createRemoteEnvironmentClientSync();
    emit?.({ statuses: [status()] });
    emit?.({ statuses: [status()] });
    expect(ensureMock).toHaveBeenCalledTimes(1);
    sync.dispose();
  });

  it("deregisters when the host stops being ready", () => {
    const sync = createRemoteEnvironmentClientSync();
    emit?.({ statuses: [status()] });
    emit?.({ statuses: [status({ phase: "failed" })] });

    // The tunnel is gone and the proxy already retracted; leaving the client
    // registered would keep a socket retrying against a path that now 404s.
    expect(removeMock).toHaveBeenCalledWith(ENVIRONMENT_ID);
    sync.dispose();
  });

  it("deregisters when the host disappears from settings entirely", () => {
    const sync = createRemoteEnvironmentClientSync();
    emit?.({ statuses: [status()] });
    emit?.({ statuses: [] });
    expect(removeMock).toHaveBeenCalledWith(ENVIRONMENT_ID);
    sync.dispose();
  });

  it("does not deregister working hosts on dispose", () => {
    // Dispose runs on effect teardown (remount, hot reload). Dropping every
    // remote socket there would disconnect healthy hosts for no reason.
    const sync = createRemoteEnvironmentClientSync();
    emit?.({ statuses: [status()] });
    sync.dispose();
    expect(removeMock).not.toHaveBeenCalled();
  });
});

/**
 * The MOUNT POINT, asserted as source.
 *
 * Every test above constructs the sync itself, so they all pass even if nothing
 * in the app ever mounts it — the same shape as the original bug: a working
 * part with no wire. The router's effect is not run in this suite, so reading
 * the source is the honest way to pin it.
 */
describe("the client sync is actually mounted", () => {
  it("__root mounts and disposes it alongside the other environment syncs", async () => {
    const source = await readFile(new URL("./routes/__root.tsx", import.meta.url), "utf8");
    expect(source).toContain("createRemoteEnvironmentClientSync()");
    expect(source).toContain("remoteClients.dispose()");
  });
});
