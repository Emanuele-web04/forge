// FILE: useHosts.ts
// Purpose: Hosts and devices as the web app consumes them — the directory
//          query plus the owner-only mutations, each settling its cache.
// Layer: Web remote-access feature hook.
// Exports: useHosts, useDevices

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { canManageHost, ensureHostsApi } from "~/lib/hosts/api";
import {
  invalidateRemoteDevices,
  invalidateRemoteHosts,
  devicesQueryOptions,
  remoteHostEnrollmentQueryOptions,
  hostsQueryOptions,
} from "~/lib/hosts/queries";

/**
 * The host directory and the owner's controls over it.
 *
 * `enabled` is the signed-in gate: every route behind this needs an account
 * token the server holds, so a signed-out app must not fire the queries at all
 * (they would fail with an auth error and render as a broken pane rather than
 * the honest "sign in to use hosts").
 */
export function useHosts(input: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const hostsQuery = useQuery(hostsQueryOptions({ enabled: input.enabled }));
  const enrollmentQuery = useQuery(remoteHostEnrollmentQueryOptions({ enabled: input.enabled }));

  /**
   * The single sharing switch (ADR 0002): off means only the owner sees the
   * host, on means the whole workspace can see AND use it. Owner-only, and
   * checked here as well as server-side — an org member's toggle would 403,
   * and a control that visibly moves before failing is worse than one that
   * was never offered.
   */
  const setDiscoverable = useMutation({
    mutationFn: async (variables: { hostId: string; discoverable: boolean }) => {
      const hosts = ensureHostsApi();
      return hosts.updateHost({ hostId: variables.hostId, discoverable: variables.discoverable });
    },
    onSettled: () => invalidateRemoteHosts(queryClient),
  });

  const renameHost = useMutation({
    mutationFn: async (variables: { hostId: string; name: string }) => {
      const hosts = ensureHostsApi();
      return hosts.updateHost({ hostId: variables.hostId, name: variables.name });
    },
    onSettled: () => invalidateRemoteHosts(queryClient),
  });

  /** Irreversible: the row and the host's stored secrets both go. */
  const deleteHost = useMutation({
    mutationFn: async (variables: { hostId: string }) => {
      const hosts = ensureHostsApi();
      await hosts.deleteHost({ hostId: variables.hostId });
    },
    onSettled: () => invalidateRemoteHosts(queryClient),
  });

  /**
   * Sign-out's counterpart for the bundled host (ADR 0015): the public key
   * leaves the directory and other devices' sessions to it die. The app keeps
   * working fully locally, which is what makes this safe to offer.
   */
  const unlinkLocalHost = useMutation({
    mutationFn: async () => {
      const hosts = ensureHostsApi();
      await hosts.unlinkLocalHost();
    },
    onSettled: () => invalidateRemoteHosts(queryClient),
  });

  /**
   * Records the owner's answer to the multi-member-org consent prompt. Writing
   * discoverability is what acknowledges it — there is no separate flag, so
   * declining (`false`) is as much an answer as accepting.
   */
  const answerDiscoverabilityPrompt = useMutation({
    mutationFn: async (variables: { hostId: string; discoverable: boolean }) => {
      const hosts = ensureHostsApi();
      return hosts.updateHost({ hostId: variables.hostId, discoverable: variables.discoverable });
    },
    onSettled: () => invalidateRemoteHosts(queryClient),
  });

  return {
    hostsQuery,
    enrollmentQuery,
    hosts: hostsQuery.data ?? [],
    enrollment: enrollmentQuery.data ?? null,
    canManageHost,
    setDiscoverable,
    renameHost,
    deleteHost,
    unlinkLocalHost,
    answerDiscoverabilityPrompt,
  } as const;
}

/** The user's registered devices and the one destructive thing you do to one. */
export function useDevices(input: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const devicesQuery = useQuery(devicesQueryOptions({ enabled: input.enabled }));

  /**
   * Revocation is account-wide by construction: the API refuses the device key
   * from here on and push-revokes its live sessions on every host (ADR 0013).
   * The confirmation copy has to say that plainly — "remove device" reads
   * local, and it is not.
   */
  const revokeDevice = useMutation({
    mutationFn: async (variables: { deviceId: string }) => {
      const hosts = ensureHostsApi();
      await hosts.revokeDevice({ deviceId: variables.deviceId });
    },
    onSettled: () => invalidateRemoteDevices(queryClient),
  });

  return {
    devicesQuery,
    devices: devicesQuery.data ?? [],
    revokeDevice,
  } as const;
}
