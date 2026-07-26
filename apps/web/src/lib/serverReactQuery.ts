import type {
  ProviderKind,
  ServerConfig,
  ServerListProviderUsageInput,
  ServerProviderStatus,
  ServerStopLocalServerInput,
  ThreadId,
} from "@synara/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS = 10_000;
const LOCAL_SERVERS_DEFAULT_STALE_TIME_MS = 3_000;

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  authSession: () => ["server", "auth", "session"] as const,
  environment: () => ["server", "environment"] as const,
  settings: () => ["server", "settings"] as const,
  worktrees: () => ["server", "worktrees"] as const,
  localServers: () => ["server", "localServers"] as const,
  providerUsage: (provider: ProviderKind | null | undefined, homePath?: string | null) =>
    ["server", "providerUsage", provider ?? null, homePath ?? null] as const,
  allProviderUsage: (provider?: ProviderKind | null) =>
    ["server", "allProviderUsage", provider ?? null] as const,
  profileStats: (utcOffsetMinutes: number) =>
    ["server", "profileStats", "peak-hour-v2", utcOffsetMinutes] as const,
  profileTokenStats: (utcOffsetMinutes: number) =>
    ["server", "profileTokenStats", utcOffsetMinutes] as const,
  studioThreadOutputs: (threadId: ThreadId | null) =>
    ["server", "studioThreadOutputs", threadId] as const,
};

export const serverMutationKeys = {
  stopLocalServer: () => ["server", "mutation", "stopLocalServer"] as const,
};

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
    staleTime: Infinity,
  });
}

interface ProviderStatusSnapshot {
  readonly revision: number;
  readonly providers: readonly ServerProviderStatus[];
}

const latestProviderStatusSnapshotByQueryClient = new WeakMap<QueryClient, ProviderStatusSnapshot>();

function recordProviderStatusSnapshot(
  queryClient: QueryClient,
  providers: readonly ServerProviderStatus[],
): ProviderStatusSnapshot {
  const snapshot = {
    revision: (latestProviderStatusSnapshotByQueryClient.get(queryClient)?.revision ?? 0) + 1,
    providers,
  };
  latestProviderStatusSnapshotByQueryClient.set(queryClient, snapshot);
  return snapshot;
}

/**
 * Folds an authoritative provider snapshot into server.config. Provider streams
 * can win the race against the initial config query, so retain the latest
 * snapshot and apply it after config hydration instead of dropping it.
 */
export async function reconcileServerProviderStatuses(
  queryClient: QueryClient,
  providers: readonly ServerProviderStatus[],
  options?: {
    readonly loadConfig?: () => Promise<ServerConfig>;
  },
): Promise<void> {
  recordProviderStatusSnapshot(queryClient, providers);

  let applied = false;
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) => {
    if (!current) return current;
    applied = true;
    return { ...current, providers };
  });
  if (applied) return;

  const loadConfig =
    options?.loadConfig ??
    (() =>
      queryClient.fetchQuery({
        ...serverConfigQueryOptions(),
        staleTime: 0,
      }));
  const hydratedConfig = await loadConfig();
  const latestProviders =
    latestProviderStatusSnapshotByQueryClient.get(queryClient)?.providers ?? providers;
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) => ({
    ...(current ?? hydratedConfig),
    providers: latestProviders,
  }));
}

/**
 * Refreshes the config projection when the WebSocket reopens without letting
 * the response overwrite a provider snapshot that arrived while it was in flight.
 */
export async function refreshServerConfigAfterTransportOpen(
  queryClient: QueryClient,
  options?: {
    readonly loadConfig?: () => Promise<ServerConfig>;
  },
): Promise<void> {
  const providerRevisionAtStart =
    latestProviderStatusSnapshotByQueryClient.get(queryClient)?.revision ?? 0;
  const loadConfig =
    options?.loadConfig ??
    (() =>
      queryClient.fetchQuery({
        ...serverConfigQueryOptions(),
        staleTime: 0,
      }));
  const config = await loadConfig();
  const latestProviderSnapshot = latestProviderStatusSnapshotByQueryClient.get(queryClient);
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), {
    ...config,
    providers:
      latestProviderSnapshot && latestProviderSnapshot.revision > providerRevisionAtStart
        ? latestProviderSnapshot.providers
        : config.providers,
  });
}

export function serverAuthSessionQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.authSession(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getAuthSession();
    },
    staleTime: 15_000,
  });
}

export function serverSettingsQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.settings(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getSettings();
    },
    staleTime: Infinity,
  });
}

export function serverWorktreesQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.worktrees(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.listWorktrees();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function serverLocalServersQueryOptions(
  input:
    | boolean
    | {
        enabled?: boolean;
        refetchInterval?: number | false;
        staleTime?: number;
      } = true,
) {
  const options = typeof input === "boolean" ? { enabled: input } : input;
  const enabled = options.enabled ?? true;
  return queryOptions({
    queryKey: serverQueryKeys.localServers(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.listLocalServers();
    },
    enabled,
    staleTime: options.staleTime ?? LOCAL_SERVERS_DEFAULT_STALE_TIME_MS,
    refetchInterval: enabled
      ? (options.refetchInterval ?? LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS)
      : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// Sidebar project badges need a snapshot, but idle Home should not keep shelling out
// through lsof/ps; active Synara-owned runs still poll for responsive status.
export function sidebarLocalServersQueryOptions(input: {
  hasActiveProjectRun: boolean;
  hasProjects: boolean;
}) {
  const enabled = input.hasProjects || input.hasActiveProjectRun;
  return serverLocalServersQueryOptions({
    enabled,
    refetchInterval: input.hasActiveProjectRun ? LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS : false,
  });
}

const STUDIO_THREAD_OUTPUTS_STALE_TIME_MS = 10_000;

/**
 * Outbox files attributed server-side to one Studio chat. Domain events invalidate this
 * query after checkpoint and non-Git file-change updates.
 */
export function studioThreadOutputsQueryOptions(input: {
  threadId: ThreadId | null;
  enabled?: boolean;
}) {
  const threadId = input.threadId;
  return queryOptions({
    queryKey: serverQueryKeys.studioThreadOutputs(threadId),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!threadId) {
        return { entries: [] };
      }
      return api.studio.listThreadOutputs({ threadId });
    },
    enabled: (input.enabled ?? true) && threadId !== null,
    staleTime: STUDIO_THREAD_OUTPUTS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function serverStopLocalServerMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: serverMutationKeys.stopLocalServer(),
    mutationFn: async (server: ServerStopLocalServerInput) => {
      const api = ensureNativeApi();
      return api.server.stopLocalServer(server);
    },
    onSettled: () => {
      void input.queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
    },
  });
}

export function serverProviderUsageSnapshotQueryOptions(input: {
  provider: ProviderKind | null | undefined;
  homePath?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: serverQueryKeys.providerUsage(input.provider, input.homePath),
    enabled: (input.enabled ?? true) && input.provider !== null && input.provider !== undefined,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      if (!input.provider) return null;
      const api = ensureNativeApi();
      return api.server.getProviderUsageSnapshot({
        provider: input.provider,
        ...(input.homePath ? { homePath: input.homePath } : {}),
      });
    },
  });
}

export async function fetchAllProviderUsage(input: ServerListProviderUsageInput = {}) {
  const api = ensureNativeApi();
  return api.server.listProviderUsage(input);
}

// Local profile + shareable-card core statistics. The client passes its own fixed
// UTC offset; all metrics are computed from Synara's local DB projections.
export function serverProfileStatsQueryOptions(input: { enabled?: boolean } = {}) {
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  return queryOptions({
    queryKey: serverQueryKeys.profileStats(utcOffsetMinutes),
    enabled: input.enabled ?? true,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.stats.getProfileStats({
        utcOffsetMinutes,
      });
    },
  });
}

// DB-backed token totals and token heatmap, split from core stats so the Profile
// page can paint first and upgrade token-only surfaces later.
export function serverProfileTokenStatsQueryOptions(input: { enabled?: boolean } = {}) {
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  return queryOptions({
    queryKey: serverQueryKeys.profileTokenStats(utcOffsetMinutes),
    enabled: input.enabled ?? true,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.stats.getProfileTokenStats({
        utcOffsetMinutes,
      });
    },
  });
}

// Live remaining-usage for every provider in Settings or a single provider in active usage UI.
export function serverAllProviderUsageQueryOptions(
  input:
    | boolean
    | {
        enabled?: boolean;
        provider?: ProviderKind | null;
      } = true,
) {
  const enabled = typeof input === "boolean" ? input : (input.enabled ?? true);
  const provider = typeof input === "boolean" ? null : (input.provider ?? null);
  return queryOptions({
    queryKey: serverQueryKeys.allProviderUsage(provider),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => fetchAllProviderUsage(provider ? { provider } : {}),
  });
}
