// FILE: queries.ts
// Purpose: React Query options and invalidation for hosts, devices, and the
//          local enrollment state.
// Layer: Web data-fetching (see accountReactQuery.ts for the conventions).

import type { AccountDevice, AccountHost, HostSession } from "@synara/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { readHostsApi, type HostEnrollment } from "./api";

export const remoteHostQueryKeys = {
  all: ["remoteHosts"] as const,
  hosts: () => ["remoteHosts", "hosts"] as const,
  devices: () => ["remoteHosts", "devices"] as const,
  enrollment: () => ["remoteHosts", "enrollment"] as const,
  sessions: () => ["remoteHosts", "sessions"] as const,
};

/**
 * Thrown when the connected server predates this slice. A distinct type so the
 * panes can render "your server is too old" instead of a generic failure —
 * the difference between an actionable message and a red box.
 */
export class HostsUnsupportedError extends Error {
  constructor() {
    super("This Synara server does not support hosts yet.");
    this.name = "HostsUnsupportedError";
  }
}

/**
 * Every host the signed-in user may see: their own, plus the discoverable
 * rows of the active workspace (ADR 0002).
 *
 * No polling and no refetch interval — ADR 0010 means there is no live state
 * to poll FOR. The list is metadata as of the last read; reachability comes
 * from probing, on demand.
 */
export function hostsQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: remoteHostQueryKeys.hosts(),
    enabled: input.enabled ?? true,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async (): Promise<readonly AccountHost[]> => {
      const hosts = readHostsApi();
      if (!hosts) throw new HostsUnsupportedError();
      return (await hosts.listHosts()).hosts;
    },
  });
}

/** The signed-in user's registered devices, newest activity first. */
export function devicesQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: remoteHostQueryKeys.devices(),
    enabled: input.enabled ?? true,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async (): Promise<readonly AccountDevice[]> => {
      const hosts = readHostsApi();
      if (!hosts) throw new HostsUnsupportedError();
      return (await hosts.listDevices()).devices;
    },
  });
}

/**
 * This machine's own host row and the facts the consent prompt needs. Read
 * separately from the host list because the list is a directory (it can
 * contain hosts this shell is not) and this is an identity statement about
 * the shell itself.
 */
export function remoteHostEnrollmentQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: remoteHostQueryKeys.enrollment(),
    enabled: input.enabled ?? true,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async (): Promise<HostEnrollment> => {
      const hosts = readHostsApi();
      if (!hosts) throw new HostsUnsupportedError();
      return hosts.enrollment();
    },
  });
}

/** Host-local live state. Bounded polling keeps a long-open panel honest. */
export function sessionsQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: remoteHostQueryKeys.sessions(),
    enabled: input.enabled ?? true,
    staleTime: 1_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async (): Promise<readonly HostSession[]> => {
      const hosts = readHostsApi();
      if (!hosts) throw new HostsUnsupportedError();
      return (await hosts.listSessions()).sessions;
    },
  });
}

/**
 * Re-reads hosts and enrollment together. They are two views of one fact —
 * flipping discoverability changes the row in the list AND answers the
 * enrollment prompt — so invalidating one without the other leaves the UI
 * disagreeing with itself.
 */
export async function invalidateRemoteHosts(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: remoteHostQueryKeys.hosts() }),
    queryClient.invalidateQueries({ queryKey: remoteHostQueryKeys.enrollment() }),
  ]);
}

export async function invalidateRemoteDevices(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: remoteHostQueryKeys.devices() });
}

export async function invalidateHostSessions(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: remoteHostQueryKeys.sessions() });
}

/**
 * Drops every remote-host answer. Called on identity change: a host directory
 * and a device list both belong to the account that read them, and neither may
 * render for the next one.
 */
export function removeRemoteHostQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: remoteHostQueryKeys.all });
}
