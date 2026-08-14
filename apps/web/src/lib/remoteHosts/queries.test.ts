// FILE: queries.test.ts
// Purpose: The remote-host queries fail with a nameable error on an old
//          server, stay disabled while signed out, and do not poll.
// Layer: Web remote-access feature tests.

import { describe, expect, it, vi } from "vitest";

const nativeApiMock: { current: unknown } = { current: null };
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => nativeApiMock.current,
  readNativeApi: () => nativeApiMock.current,
}));

const {
  RemoteHostsUnsupportedError,
  remoteDevicesQueryOptions,
  remoteHostEnrollmentQueryOptions,
  remoteHostQueryKeys,
  remoteHostsQueryOptions,
} = await import("./queries");

describe("remoteHostQueryKeys", () => {
  it("nests every key under one prefix so an identity change can drop them all", () => {
    for (const key of [
      remoteHostQueryKeys.hosts(),
      remoteHostQueryKeys.devices(),
      remoteHostQueryKeys.enrollment(),
    ]) {
      expect(key[0]).toBe(remoteHostQueryKeys.all[0]);
    }
  });

  it("keeps hosts, devices, and enrollment on distinct keys", () => {
    const keys = [
      remoteHostQueryKeys.hosts(),
      remoteHostQueryKeys.devices(),
      remoteHostQueryKeys.enrollment(),
    ].map((key) => key.join("/"));

    expect(new Set(keys).size).toBe(3);
  });
});

describe("query options", () => {
  it("is disabled when the caller says so (signed out)", () => {
    expect(remoteHostsQueryOptions({ enabled: false }).enabled).toBe(false);
    expect(remoteDevicesQueryOptions({ enabled: false }).enabled).toBe(false);
    expect(remoteHostEnrollmentQueryOptions({ enabled: false }).enabled).toBe(false);
  });

  it("is enabled by default", () => {
    expect(remoteHostsQueryOptions().enabled).toBe(true);
  });

  // ADR 0010: there is no live state to poll for. A refetch interval here
  // would be a presence system built by accident.
  it("does not poll", () => {
    for (const options of [
      remoteHostsQueryOptions(),
      remoteDevicesQueryOptions(),
      remoteHostEnrollmentQueryOptions(),
    ]) {
      expect(options).not.toHaveProperty("refetchInterval");
    }
  });

  // "Your server is too old" is actionable; a generic failure is not.
  it("fails with a nameable error when the shell has no hosts namespace", async () => {
    nativeApiMock.current = { account: {} };

    for (const options of [
      remoteHostsQueryOptions(),
      remoteDevicesQueryOptions(),
      remoteHostEnrollmentQueryOptions(),
    ]) {
      await expect((options.queryFn as () => Promise<unknown>)()).rejects.toBeInstanceOf(
        RemoteHostsUnsupportedError,
      );
    }
  });

  it("unwraps the list responses", async () => {
    const hosts = [{ id: "host_1" }];
    const devices = [{ id: "device_1" }];
    const enrollment = {
      host: null,
      organizationMemberCount: 1,
      discoverabilityAcknowledged: true,
    };
    nativeApiMock.current = {
      hosts: {
        listHosts: vi.fn().mockResolvedValue({ hosts }),
        updateHost: vi.fn(),
        deleteHost: vi.fn(),
        listDevices: vi.fn().mockResolvedValue({ devices }),
        revokeDevice: vi.fn(),
        approveDeviceLink: vi.fn(),
        requestGrant: vi.fn(),
        enrollment: vi.fn().mockResolvedValue(enrollment),
        unlinkLocalHost: vi.fn(),
      },
    };

    await expect((remoteHostsQueryOptions().queryFn as () => Promise<unknown>)()).resolves.toEqual(
      hosts,
    );
    await expect(
      (remoteDevicesQueryOptions().queryFn as () => Promise<unknown>)(),
    ).resolves.toEqual(devices);
    await expect(
      (remoteHostEnrollmentQueryOptions().queryFn as () => Promise<unknown>)(),
    ).resolves.toEqual(enrollment);
  });

  // A namespace missing even one method is a partial implementation, and
  // calling into it fails deep inside a query instead of at the boundary.
  it("treats an incomplete hosts namespace as unsupported", async () => {
    nativeApiMock.current = { hosts: { listHosts: vi.fn() } };

    await expect(
      (remoteHostsQueryOptions().queryFn as () => Promise<unknown>)(),
    ).rejects.toBeInstanceOf(RemoteHostsUnsupportedError);
  });
});
