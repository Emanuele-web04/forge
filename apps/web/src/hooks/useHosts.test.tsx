// FILE: useHosts.test.tsx
// Purpose: The mutations reach the right endpoint with the right arguments,
//          ownership gates the ones the API would refuse, and a device revoke
//          is account-wide.
// Layer: Web remote-access feature tests.

import type { AccountDevice, AccountHost, EnvironmentId, NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { remoteHostQueryKeys } from "~/lib/hosts/queries";
import { useDevices, useHosts } from "./useHosts";

const hostsApiMock = {
  listHosts: vi.fn(),
  updateHost: vi.fn(),
  deleteHost: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
  approveDeviceLink: vi.fn(),
  requestGrant: vi.fn(),
  enrollment: vi.fn(),
  unlinkLocalHost: vi.fn(),
};

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ hosts: hostsApiMock }) as unknown as NativeApi,
  readNativeApi: () => ({ hosts: hostsApiMock }) as unknown as NativeApi,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeHost(overrides: Partial<AccountHost> = {}): AccountHost {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    environmentId: "env_1" as EnvironmentId,
    name: "Ada's MacBook",
    platform: "darwin",
    kind: "local",
    endpoints: [],
    ownerUserId: "user_1",
    discoverable: true,
    linked: true,
    keyGeneration: 1,
    mine: true,
    createdAt: "2026-08-13T10:00:00.000Z",
    lastSeenAt: "2026-08-13T10:00:00.000Z",
    ...overrides,
  };
}

function makeDevice(overrides: Partial<AccountDevice> = {}): AccountDevice {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    jkt: "thumbprint",
    displayName: "Ada's iPhone",
    platform: "ios",
    createdAt: "2026-08-01T10:00:00.000Z",
    lastUsedAt: "2026-08-13T09:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function renderHook<T>(queryClient: QueryClient, use: () => T): T {
  const holder: { current: T | null } = { current: null };
  function Probe() {
    holder.current = use();
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{(<Probe />) as ReactNode}</QueryClientProvider>,
  );
  const captured = holder.current;
  if (!captured) throw new Error("hook did not render");
  return captured;
}

describe("useHosts", () => {
  it("projects the cached host directory", () => {
    const queryClient = new QueryClient();
    const hosts = [makeHost(), makeHost({ id: "other", mine: false })];
    queryClient.setQueryData(remoteHostQueryKeys.hosts(), hosts);

    const remote = renderHook(queryClient, () => useHosts({ enabled: true }));

    expect(remote.hosts).toEqual(hosts);
  });

  it("reports an empty directory rather than undefined", () => {
    const remote = renderHook(new QueryClient(), () => useHosts({ enabled: true }));

    expect(remote.hosts).toEqual([]);
    expect(remote.enrollment).toBeNull();
  });

  // The single sharing switch (ADR 0002) — one PATCH, one field.
  it("turns discoverability on through updateHost", async () => {
    const queryClient = new QueryClient();
    hostsApiMock.updateHost.mockResolvedValue(makeHost({ discoverable: true }));

    const remote = renderHook(queryClient, () => useHosts({ enabled: true }));
    await remote.setDiscoverable.mutateAsync({ hostId: "host_1", discoverable: true });

    expect(hostsApiMock.updateHost).toHaveBeenCalledWith({
      hostId: "host_1",
      discoverable: true,
    });
  });

  it("turns discoverability off through the same endpoint", async () => {
    const queryClient = new QueryClient();
    hostsApiMock.updateHost.mockResolvedValue(makeHost({ discoverable: false }));

    const remote = renderHook(queryClient, () => useHosts({ enabled: true }));
    await remote.setDiscoverable.mutateAsync({ hostId: "host_1", discoverable: false });

    expect(hostsApiMock.updateHost).toHaveBeenCalledWith({
      hostId: "host_1",
      discoverable: false,
    });
  });

  it("re-reads the directory after a discoverability change", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    hostsApiMock.updateHost.mockResolvedValue(makeHost());

    const remote = renderHook(queryClient, () => useHosts({ enabled: true }));
    await remote.setDiscoverable.mutateAsync({ hostId: "host_1", discoverable: true });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: remoteHostQueryKeys.hosts() });
    // Enrollment is the same fact seen from the local shell; leaving it stale
    // would let the consent prompt disagree with the row the user just moved.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: remoteHostQueryKeys.enrollment() });
  });

  // Only the owner may flip the switch; the API answers 403 to anyone else,
  // so the control must not be offered in the first place.
  it("reports the discoverability switch as owner-only", () => {
    const remote = renderHook(new QueryClient(), () => useHosts({ enabled: true }));

    expect(remote.canManageHost(makeHost({ mine: true }))).toBe(true);
    expect(remote.canManageHost(makeHost({ mine: false }))).toBe(false);
  });

  it("surfaces a failed toggle rather than swallowing it", async () => {
    const queryClient = new QueryClient();
    hostsApiMock.updateHost.mockRejectedValue(new Error("host_not_found"));

    const remote = renderHook(queryClient, () => useHosts({ enabled: true }));

    await expect(
      remote.setDiscoverable.mutateAsync({ hostId: "host_1", discoverable: true }),
    ).rejects.toThrow("host_not_found");
  });

  it("records the consent answer as a discoverability write", async () => {
    const queryClient = new QueryClient();
    hostsApiMock.updateHost.mockResolvedValue(makeHost({ discoverable: false }));

    const remote = renderHook(queryClient, () => useHosts({ enabled: true }));
    await remote.answerDiscoverabilityPrompt.mutateAsync({
      hostId: "host_1",
      discoverable: false,
    });

    expect(hostsApiMock.updateHost).toHaveBeenCalledWith({
      hostId: "host_1",
      discoverable: false,
    });
  });

  it("unlinks the local host without arguments", async () => {
    const queryClient = new QueryClient();
    hostsApiMock.unlinkLocalHost.mockResolvedValue(undefined);

    const remote = renderHook(queryClient, () => useHosts({ enabled: true }));
    await remote.unlinkLocalHost.mutateAsync();

    expect(hostsApiMock.unlinkLocalHost).toHaveBeenCalledTimes(1);
  });

  it("deletes a host by id", async () => {
    const queryClient = new QueryClient();
    hostsApiMock.deleteHost.mockResolvedValue(undefined);

    const remote = renderHook(queryClient, () => useHosts({ enabled: true }));
    await remote.deleteHost.mutateAsync({ hostId: "host_1" });

    expect(hostsApiMock.deleteHost).toHaveBeenCalledWith({ hostId: "host_1" });
  });
});

describe("useDevices", () => {
  it("projects the cached device list", () => {
    const queryClient = new QueryClient();
    const devices = [makeDevice()];
    queryClient.setQueryData(remoteHostQueryKeys.devices(), devices);

    const remote = renderHook(queryClient, () => useDevices({ enabled: true }));

    expect(remote.devices).toEqual(devices);
  });

  it("reports an empty list rather than undefined", () => {
    const remote = renderHook(new QueryClient(), () => useDevices({ enabled: true }));

    expect(remote.devices).toEqual([]);
  });

  it("revokes a device by id", async () => {
    const queryClient = new QueryClient();
    hostsApiMock.revokeDevice.mockResolvedValue(undefined);

    const remote = renderHook(queryClient, () => useDevices({ enabled: true }));
    await remote.revokeDevice.mutateAsync({ deviceId: "device_1" });

    expect(hostsApiMock.revokeDevice).toHaveBeenCalledWith({ deviceId: "device_1" });
  });

  it("re-reads the device list after a revoke", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    hostsApiMock.revokeDevice.mockResolvedValue(undefined);

    const remote = renderHook(queryClient, () => useDevices({ enabled: true }));
    await remote.revokeDevice.mutateAsync({ deviceId: "device_1" });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: remoteHostQueryKeys.devices() });
  });

  it("surfaces a failed revoke", async () => {
    const queryClient = new QueryClient();
    hostsApiMock.revokeDevice.mockRejectedValue(new Error("device_not_registered"));

    const remote = renderHook(queryClient, () => useDevices({ enabled: true }));

    await expect(remote.revokeDevice.mutateAsync({ deviceId: "device_1" })).rejects.toThrow(
      "device_not_registered",
    );
  });
});
