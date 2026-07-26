// FILE: serverReactQuery.test.ts
// Purpose: Locks down server React Query polling profiles and cache options.
// Layer: Web data-fetching unit tests

import type { ServerConfig, ServerProviderStatus } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS,
  reconcileServerProviderStatuses,
  refreshServerConfigAfterTransportOpen,
  serverAllProviderUsageQueryOptions,
  serverLocalServersQueryOptions,
  serverProviderUsageSnapshotQueryOptions,
  serverQueryKeys,
  sidebarLocalServersQueryOptions,
} from "./serverReactQuery";

const READY_CODEX_STATUS = {
  provider: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-07-26T16:41:38.945Z",
} satisfies ServerProviderStatus;

function makeServerConfig(providers: readonly ServerProviderStatus[]): ServerConfig {
  return {
    cwd: "G:\\synara",
    homeDir: "C:\\Users\\tester",
    chatWorkspaceRoot: "C:\\Users\\tester\\Documents\\Synara",
    studioWorkspaceRoot: "C:\\Users\\tester\\Documents\\Synara\\Studio",
    worktreesDir: "C:\\SynaraDev\\worktrees",
    keybindingsConfigPath: "C:\\SynaraDev\\keybindings.json",
    keybindings: [],
    issues: [],
    providers,
    availableEditors: [],
  };
}

describe("server provider status reconciliation", () => {
  it("applies a missed live snapshot after the config projection hydrates", async () => {
    const queryClient = new QueryClient();
    let resolveConfig!: (config: ServerConfig) => void;
    const configProjection = new Promise<ServerConfig>((resolve) => {
      resolveConfig = resolve;
    });

    const reconciliation = reconcileServerProviderStatuses(queryClient, [READY_CODEX_STATUS], {
      loadConfig: () => configProjection,
    });

    expect(queryClient.getQueryData(serverQueryKeys.config())).toBeUndefined();

    resolveConfig(makeServerConfig([]));
    await reconciliation;

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });

  it("keeps the newest provider snapshot when hydration overlaps multiple events", async () => {
    const queryClient = new QueryClient();
    let resolveConfig!: (config: ServerConfig) => void;
    const configProjection = new Promise<ServerConfig>((resolve) => {
      resolveConfig = resolve;
    });
    const unavailableStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;

    const first = reconcileServerProviderStatuses(queryClient, [unavailableStatus], {
      loadConfig: () => configProjection,
    });
    const second = reconcileServerProviderStatuses(queryClient, [READY_CODEX_STATUS], {
      loadConfig: () => configProjection,
    });

    resolveConfig(makeServerConfig([]));
    await Promise.all([first, second]);

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });

  it("keeps a provider snapshot that arrives during reconnect config refresh", async () => {
    const queryClient = new QueryClient();
    const unavailableStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([unavailableStatus]));
    let resolveConfig!: (config: ServerConfig) => void;
    const configProjection = new Promise<ServerConfig>((resolve) => {
      resolveConfig = resolve;
    });

    const refresh = refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: () => configProjection,
    });
    await reconcileServerProviderStatuses(queryClient, [READY_CODEX_STATUS]);
    resolveConfig(makeServerConfig([unavailableStatus]));
    await refresh;

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });

  it("accepts reconnect config when no newer provider snapshot arrives", async () => {
    const queryClient = new QueryClient();
    const unavailableStatus = {
      ...READY_CODEX_STATUS,
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: "2026-07-26T16:40:00.000Z",
    } satisfies ServerProviderStatus;
    queryClient.setQueryData(serverQueryKeys.config(), makeServerConfig([unavailableStatus]));
    await reconcileServerProviderStatuses(queryClient, [unavailableStatus]);

    await refreshServerConfigAfterTransportOpen(queryClient, {
      loadConfig: async () => makeServerConfig([READY_CODEX_STATUS]),
    });

    expect(queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers).toEqual([
      READY_CODEX_STATUS,
    ]);
  });
});

describe("serverLocalServersQueryOptions", () => {
  it("uses the visible polling interval by default", () => {
    const options = serverLocalServersQueryOptions(true);

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS);
  });

  it("disables polling when disabled", () => {
    const options = serverLocalServersQueryOptions(false);

    expect(options.enabled).toBe(false);
    expect(options.refetchInterval).toBe(false);
  });

  it("keeps sidebar attribution enabled without idle polling", () => {
    const options = sidebarLocalServersQueryOptions({
      hasActiveProjectRun: false,
      hasProjects: true,
    });

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(true);
  });

  it("uses visible polling while a Synara-owned project run is active", () => {
    const options = sidebarLocalServersQueryOptions({
      hasActiveProjectRun: true,
      hasProjects: true,
    });

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS);
  });

  it("disables sidebar attribution when no projects or project runs exist", () => {
    const options = sidebarLocalServersQueryOptions({
      hasActiveProjectRun: false,
      hasProjects: false,
    });

    expect(options.enabled).toBe(false);
    expect(options.refetchInterval).toBe(false);
  });
});

describe("serverAllProviderUsageQueryOptions", () => {
  it("can be disabled by provider-scoped usage surfaces", () => {
    const options = serverAllProviderUsageQueryOptions(false);

    expect(options.enabled).toBe(false);
  });

  it("keys provider-scoped usage separately from the all-provider batch", () => {
    const scoped = serverAllProviderUsageQueryOptions({ provider: "claudeAgent" });
    const all = serverAllProviderUsageQueryOptions();

    expect(scoped.queryKey).toEqual(serverQueryKeys.allProviderUsage("claudeAgent"));
    expect(all.queryKey).toEqual(serverQueryKeys.allProviderUsage(null));
  });
});

describe("serverProviderUsageSnapshotQueryOptions", () => {
  it("can be disabled by privacy-safe active surfaces", () => {
    const options = serverProviderUsageSnapshotQueryOptions({
      provider: "cursor",
      enabled: false,
    });

    expect(options.enabled).toBe(false);
  });
});
