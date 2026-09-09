// FILE: providerModelPrefetch.ts
// Purpose: Warm provider model discovery and composer capabilities into the
//          React Query cache before a new thread mounts ChatView, so the
//          composer can skip the "Loading models" skeleton and capability
//          round-trips on the common new-thread path.
// Layer: Web lib
// Exports: resolve + prefetch helpers that mirror ChatView's listModels query keys.

import type { ProviderKind, ServerProviderStatus, ServerSettings } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type { AppSettings } from "../appSettings";
import type { DraftThreadEnvMode } from "../composerDraftDomain";
import { findProviderStatus, resolveAvailableProviderPreference } from "./providerAvailability";
import { resolveProviderDiscoveryCwd } from "./providerDiscovery";
import {
  prioritizeProviderModelDiscovery,
  providerAgentsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerDiscoveryQueryKeys,
  providerModelDiscoveryRetry,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";

export type ProviderModelPrefetchSettings = Pick<
  AppSettings,
  | "defaultProvider"
  | "claudeBinaryPath"
  | "cursorBinaryPath"
  | "cursorApiEndpoint"
  | "devinBinaryPath"
  | "antigravityBinaryPath"
  | "grokBinaryPath"
  | "droidBinaryPath"
  | "openCodeBinaryPath"
  | "piBinaryPath"
  | "piAgentDir"
>;

/**
 * Providers whose model catalogs are runtime-discovered (not static) and thus
 * need warming before the picker can show anything beyond the static fallback.
 * Droid is excluded: its discovery spins a disposable ACP session per model,
 * so it warms only on explicit new-thread intent.
 */
export const NEW_THREAD_MODEL_PREFETCH_PROVIDERS: ReadonlyArray<Exclude<ProviderKind, "droid">> = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "opencode",
  "pi",
  "devin",
];

/** Warm results stay fresh for 30 minutes instead of the interactive 60s. */
export const NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS = 30 * 60_000;

const EMPTY_PROVIDER_STATUSES: readonly ServerProviderStatus[] = [];

export function resolveNewThreadModelPrefetchProvider(input: {
  providerOverride?: ProviderKind | null | undefined;
  draftActiveProvider?: ProviderKind | null | undefined;
  stickyActiveProvider?: ProviderKind | null | undefined;
  projectDefaultProvider?: ProviderKind | null | undefined;
  defaultProvider: ProviderKind;
}): ProviderKind {
  return (
    input.providerOverride ??
    input.draftActiveProvider ??
    input.stickyActiveProvider ??
    input.projectDefaultProvider ??
    input.defaultProvider
  );
}

export function resolveNewThreadModelPrefetchCwd(input: {
  /** options.worktreePath from the new-thread call (only meaningful with hasExplicitWorktreePath). */
  worktreePath?: string | null | undefined;
  /** True when the caller passed options.worktreePath (even as null) — explicit intent always wins. */
  hasExplicitWorktreePath?: boolean;
  /** options.fresh — a forced-fresh thread never inherits the stored draft's worktree. */
  fresh?: boolean;
  /** options.envMode — "local" clears the draft worktree unless one is passed explicitly. */
  envMode?: DraftThreadEnvMode | null;
  draftWorktreePath?: string | null | undefined;
  projectCwd?: string | null | undefined;
  serverCwd?: string | null | undefined;
}): string | null {
  // Mirrors the new thread's real worktree resolution:
  // - buildDraftThreadContextPatch (threadBootstrap): explicit worktreePath wins,
  //   envMode "local" without an explicit worktree clears it.
  // - createFreshDraftThreadSeed: fresh seeds ignore the stored draft entirely.
  let worktreePath: string | null;
  if (input.hasExplicitWorktreePath === true) {
    worktreePath = input.worktreePath ?? null;
  } else if (input.fresh === true) {
    worktreePath = null;
  } else if (input.envMode === "local") {
    worktreePath = null;
  } else {
    worktreePath = input.draftWorktreePath ?? null;
  }
  return resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: worktreePath,
    activeProjectCwd: input.projectCwd ?? null,
    serverCwd: input.serverCwd ?? null,
  });
}

/**
 * Build the same listModels query options ChatView uses for a provider, so a
 * prefetch lands on the exact cache key the composer will read on mount.
 */
export function providerModelsPrefetchQueryOptions(input: {
  provider: ProviderKind;
  settings: ProviderModelPrefetchSettings;
  cwd?: string | null;
  priority?: "background" | "prefetch" | undefined;
}) {
  const { priority, provider, settings } = input;
  const cwd = input.cwd ?? null;

  switch (provider) {
    case "claudeAgent":
      return providerModelsQueryOptions({
        provider: "claudeAgent",
        binaryPath: settings.claudeBinaryPath || null,
        priority,
      });
    case "codex":
      return providerModelsQueryOptions({ provider: "codex", priority });
    case "cursor":
      return providerModelsQueryOptions({
        provider: "cursor",
        binaryPath: settings.cursorBinaryPath || null,
        apiEndpoint: settings.cursorApiEndpoint || null,
        priority,
      });
    case "devin":
      return providerModelsQueryOptions({
        provider: "devin",
        binaryPath: settings.devinBinaryPath || null,
        cwd,
        priority,
      });
    case "antigravity":
      return providerModelsQueryOptions({
        provider: "antigravity",
        binaryPath: settings.antigravityBinaryPath || null,
        cwd,
        priority,
      });
    case "grok":
      return providerModelsQueryOptions({
        provider: "grok",
        binaryPath: settings.grokBinaryPath || null,
        priority,
      });
    case "droid":
      return providerModelsQueryOptions({
        provider: "droid",
        binaryPath: settings.droidBinaryPath || null,
        cwd,
        priority,
      });
    case "opencode":
      return providerModelsQueryOptions({
        provider: "opencode",
        binaryPath: settings.openCodeBinaryPath || null,
        cwd,
        priority,
      });
    case "pi":
      return providerModelsQueryOptions({
        provider: "pi",
        binaryPath: settings.piBinaryPath || null,
        agentDir: settings.piAgentDir || null,
        cwd,
        priority,
      });
  }
}

function providerAgentsPrefetchQueryOptions(input: {
  provider: ProviderKind;
  settings: ProviderModelPrefetchSettings;
  cwd?: string | null;
}) {
  const { provider, settings } = input;
  const cwd = input.cwd ?? null;

  switch (provider) {
    case "claudeAgent":
      return providerAgentsQueryOptions({ provider: "claudeAgent" });
    case "codex":
      return providerAgentsQueryOptions({ provider: "codex" });
    case "opencode":
      return providerAgentsQueryOptions({
        provider: "opencode",
        binaryPath: settings.openCodeBinaryPath || null,
        cwd,
      });
    default:
      return null;
  }
}

export function prefetchProviderModelsForNewThread(
  queryClient: QueryClient,
  input: {
    settings: ProviderModelPrefetchSettings;
    cwd?: string | null;
    providers?: ReadonlyArray<ProviderKind>;
    foregroundProvider?: ProviderKind;
  },
): void {
  const cwd = input.cwd ?? null;
  const providers = (input.providers ?? NEW_THREAD_MODEL_PREFETCH_PROVIDERS).filter(
    (provider) => provider !== "droid",
  );

  for (const provider of providers) {
    const modelsOptions = providerModelsPrefetchQueryOptions({
      provider,
      settings: input.settings,
      cwd,
      priority: provider === (input.foregroundProvider ?? providers[0]) ? "prefetch" : "background",
    });
    void queryClient.prefetchQuery({
      ...modelsOptions,
      retry:
        provider === "codex" || provider === "claudeAgent"
          ? 0
          : providerModelDiscoveryRetry(provider),
      staleTime:
        provider === "devin"
          ? (query) => (query.state.data?.error ? 0 : NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS)
          : NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
      gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
    });

    // Agent/mode lists ride along for providers that surface them next to models.
    const agentsOptions = providerAgentsPrefetchQueryOptions({
      provider,
      settings: input.settings,
      cwd,
    });
    if (agentsOptions) {
      void queryClient.prefetchQuery({
        ...agentsOptions,
        retry: 0,
        staleTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
        gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
      });
    }

    // Composer capabilities gate composer affordances on ChatView mount; the query
    // has staleTime Infinity, so this costs one IPC per provider per session.
    // retry: 0 keeps a failing capabilities probe from multiplying per hover —
    // ChatView's own mount query still retries by its defaults if it refetches.
    void queryClient.prefetchQuery({
      ...providerComposerCapabilitiesQueryOptions(provider),
      retry: 0,
      gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
    });
  }
}

/**
 * Warm Droid's model catalog on explicit new-thread intent only. Droid
 * discovery spins a disposable ACP session per model (expensive), so it must
 * never run from idle project focus.
 */
export function prefetchDroidModelsForNewThread(
  queryClient: QueryClient,
  input: {
    settings: ProviderModelPrefetchSettings;
    cwd?: string | null;
  },
): void {
  const cwd = input.cwd ?? null;
  void queryClient.prefetchQuery({
    ...providerModelsPrefetchQueryOptions({
      provider: "droid",
      settings: input.settings,
      cwd,
      priority: "prefetch",
    }),
    staleTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
    gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
  });
  void queryClient.prefetchQuery({
    ...providerComposerCapabilitiesQueryOptions("droid"),
    retry: 0,
    gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
  });
}

/**
 * Warm every visible provider for the next new thread: the selected provider
 * first, hidden/disabled/confirmed-uninstalled providers skipped, Droid only on
 * explicit intent. Provider availability mirrors the model picker on main
 * (#652): the picker lists only `status.available` providers, so warming a
 * provider that is confirmed absent would only produce failing spawns.
 */
export function prefetchModelsForNewThread(
  queryClient: QueryClient,
  input: {
    settings: ProviderModelPrefetchSettings;
    serverSettings?: ServerSettings | null;
    hiddenProviders?: ReadonlyArray<ProviderKind>;
    /** Normalized provider health (custom binary paths applied), see useProviderStatusesForLocalConfig. */
    providerStatuses?: readonly ServerProviderStatus[] | null;
    /** True once the server config's provider statuses have been reconciled (#652). */
    statusesReconciled?: boolean;
    providerOrder?: readonly ProviderKind[];
    providerOverride?: ProviderKind | null;
    draftActiveProvider?: ProviderKind | null;
    stickyActiveProvider?: ProviderKind | null;
    projectDefaultProvider?: ProviderKind | null;
    projectCwd?: string | null;
    draftWorktreePath?: string | null;
    serverCwd?: string | null;
    worktreePath?: string | null;
    hasExplicitWorktreePath?: boolean;
    fresh?: boolean;
    envMode?: DraftThreadEnvMode | null;
    includeDroid?: boolean;
  },
): void {
  const resolvedProvider = resolveNewThreadModelPrefetchProvider({
    providerOverride: input.providerOverride,
    draftActiveProvider: input.draftActiveProvider,
    stickyActiveProvider: input.stickyActiveProvider,
    projectDefaultProvider: input.projectDefaultProvider,
    defaultProvider: input.settings.defaultProvider,
  });
  // ChatView resolves the new thread's provider with the same availability
  // preference (resolveAvailableProviderPreference) once statuses are reconciled,
  // so the warm-first provider is the one the composer will actually show.
  const selectedProvider =
    input.statusesReconciled === true
      ? resolveAvailableProviderPreference({
          preferredProvider: resolvedProvider,
          statuses: input.providerStatuses ?? EMPTY_PROVIDER_STATUSES,
          providerOrder: input.providerOrder ?? [],
          hiddenProviders: input.hiddenProviders ?? [],
        })
      : resolvedProvider;
  const cwd = resolveNewThreadModelPrefetchCwd({
    worktreePath: input.worktreePath ?? null,
    hasExplicitWorktreePath: input.hasExplicitWorktreePath === true,
    fresh: input.fresh === true,
    envMode: input.envMode ?? null,
    draftWorktreePath: input.draftWorktreePath,
    projectCwd: input.projectCwd,
    serverCwd: input.serverCwd,
  });
  const hiddenProviderSet = new Set(input.hiddenProviders ?? []);
  const statusesReconciled = input.statusesReconciled === true;
  const providerStatuses = input.providerStatuses ?? EMPTY_PROVIDER_STATUSES;
  const isProviderWarmable = (provider: ProviderKind): boolean => {
    // Mirrors useProviderModelCatalog.shouldDiscoverProvider exactly:
    // the enabled flag short-circuits even the selected provider, then the
    // selected provider always wins, then hidden providers are skipped.
    if (input.serverSettings?.providers[provider]?.enabled === false) {
      return false;
    }
    // ChatView's useProviderModelCatalog always discovers the selected provider
    // (even hidden/unavailable — the picker preserves it as protected), so the
    // warm must too, or mount re-runs discovery with the loading state this
    // prefetch exists to remove.
    if (provider === selectedProvider) {
      return true;
    }
    if (hiddenProviderSet.has(provider)) {
      return false;
    }
    // The picker only lists installed providers once statuses are reconciled.
    // A confirmed-unavailable provider would only produce a failing spawn, so
    // skip it; unresolved statuses stay warmable (safe default).
    if (statusesReconciled) {
      const status = findProviderStatus(providerStatuses, provider);
      if (status !== null && status.available === false) {
        return false;
      }
    }
    return true;
  };
  const providers = NEW_THREAD_MODEL_PREFETCH_PROVIDERS.filter(isProviderWarmable);
  const orderedProviders =
    selectedProvider === "droid" || !isProviderWarmable(selectedProvider)
      ? providers
      : [selectedProvider, ...providers.filter((provider) => provider !== selectedProvider)];
  const shouldWarmSelectedDroid =
    input.includeDroid === true && selectedProvider === "droid" && isProviderWarmable("droid");
  const desiredModelQueryKeys = orderedProviders.map(
    (provider) =>
      providerModelsPrefetchQueryOptions({
        provider,
        settings: input.settings,
        cwd,
      }).queryKey,
  );
  if (shouldWarmSelectedDroid) {
    desiredModelQueryKeys.push(
      providerModelsPrefetchQueryOptions({
        provider: "droid",
        settings: input.settings,
        cwd,
      }).queryKey,
    );
  }
  const selectedModelQueryKey = desiredModelQueryKeys.find(
    (queryKey) => queryKey[2] === selectedProvider,
  );
  if (selectedModelQueryKey) {
    prioritizeProviderModelDiscovery(selectedModelQueryKey, "prefetch");
  }

  // Hovering another project supersedes only inactive model prefetches. Active
  // composer queries and exact-key prefetches keep running. Include both
  // fetching and offline-paused queries so stale hover work cannot revive on
  // reconnect and consume native admission.
  void queryClient.cancelQueries({
    queryKey: providerDiscoveryQueryKeys.modelsAll,
    type: "inactive",
    predicate: (query) =>
      !desiredModelQueryKeys.some(
        (queryKey) =>
          query.queryKey.length === queryKey.length &&
          query.queryKey.every((value, index) => Object.is(value, queryKey[index])),
      ),
  });

  if (shouldWarmSelectedDroid) {
    prefetchDroidModelsForNewThread(queryClient, { settings: input.settings, cwd });
  }
  prefetchProviderModelsForNewThread(queryClient, {
    settings: input.settings,
    cwd,
    providers: orderedProviders,
    foregroundProvider: selectedProvider,
  });
}
