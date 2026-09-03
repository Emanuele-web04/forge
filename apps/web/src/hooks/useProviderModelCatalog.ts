// FILE: useProviderModelCatalog.ts
// Purpose: Shared provider→model option catalog (static + custom + runtime-discovered)
//          for composer-like surfaces outside ChatView, e.g. the kanban new-task dialog.
// Layer: Web hooks
// Exports: useProviderModelCatalog, ProviderModelCatalog, MODEL_CATALOG_PROVIDERS

import type {
  ProviderAgentDescriptor,
  ProviderKind,
  ProviderListModelsResult,
  ProviderModelDescriptor,
} from "@synara/contracts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getAppModelOptions, getCustomModelsByProvider, useAppSettings } from "../appSettings";
import { resolveRuntimeModelDescriptor } from "../components/chat/runtimeModelCapabilities";
import { collapseCursorModelVariants } from "../cursorModelVariants";
import {
  hasResolvedModelCatalog,
  isInitialModelDiscoveryPending,
  providerAgentsQueryOptions,
  providerModelsQueryOptions,
  resolveModelDiscoveryError,
  resolveProviderModelsQueryInput,
} from "../lib/providerDiscoveryReactQuery";
import { mergeDynamicModelOptions, type ProviderModelOption } from "../providerModelOptions";

export interface ProviderModelCatalog {
  customModelsByProvider: ReturnType<typeof getCustomModelsByProvider>;
  modelOptionsByProvider: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
  >;
  /** Providers whose runtime model discovery is still pending (no usable list yet). */
  loadingModelProviders: Partial<Record<ProviderKind, boolean>>;
  /**
   * Runtime-discovered model descriptors per provider. Composer-style trait
   * controls (effort, fast mode, thinking, context window) are sourced from
   * these for cursor/codex/etc., so any surface that wants the effort picker
   * must feed them through (see {@link selectedRuntimeModel}).
   */
  runtimeModelsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>;
  /** The runtime descriptor matching `selectedProvider` + its selected-model hint. */
  selectedRuntimeModel: ProviderModelDescriptor | undefined;
  /** Runtime-discovered agents/modes for the selected provider (opencode/claude/codex). */
  selectedRuntimeAgents: ReadonlyArray<ProviderAgentDescriptor>;
  /** Loading state used by the selected provider's bootstrap skeleton. */
  selectedProviderModelsLoading: boolean;
  /** Whether the selected provider requires and is still waiting on runtime models. */
  selectedProviderRuntimeModelDiscoveryPending: boolean;
  /** Discovery failure detail per provider (268 passthrough). */
  discoveryErrorsByProvider: Partial<Record<ProviderKind, string | undefined>>;
}

/** Fixed hook-call order for the per-provider model queries. */
export const MODEL_CATALOG_PROVIDERS: ReadonlyArray<ProviderKind> = [
  "claudeAgent",
  "codex",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "opencode",
  "pi",
  "devin",
];

/**
 * Providers whose static list is a thin fallback, so the picker shows a
 * skeleton until runtime discovery settles. Codex/Claude/Grok ship a complete
 * static catalog and paint it immediately while discovery refines it.
 */
const SKELETON_WHILE_DISCOVERING: ReadonlySet<ProviderKind> = new Set<ProviderKind>([
  "antigravity",
  "cursor",
  "droid",
  "opencode",
  "pi",
  "devin",
]);

const EMPTY_PROVIDER_AGENTS: ReadonlyArray<ProviderAgentDescriptor> = [];
const EMPTY_MODELS: ReadonlyArray<ProviderModelDescriptor> = [];

interface ModelCatalogQueryView {
  readonly data: ProviderListModelsResult | undefined;
  readonly error: unknown;
  readonly isFetching: boolean;
  readonly isLoading: boolean;
  readonly isPlaceholderData: boolean;
}

/**
 * Project the useQueries result array onto a provider-keyed record of plain
 * objects. TanStack structurally shares the combined value, so the record (and
 * every memo downstream of it) keeps its identity while nothing changed.
 */
function combineModelCatalogQueries(
  results: ReadonlyArray<{
    readonly data: ProviderListModelsResult | undefined;
    readonly error: unknown;
    readonly isFetching: boolean;
    readonly isLoading: boolean;
    readonly isPlaceholderData: boolean;
  }>,
): Record<ProviderKind, ModelCatalogQueryView> {
  const byProvider = {} as Record<ProviderKind, ModelCatalogQueryView>;
  MODEL_CATALOG_PROVIDERS.forEach((provider, index) => {
    const query = results[index];
    byProvider[provider] = {
      data: query?.data,
      error: query?.error ?? null,
      isFetching: query?.isFetching ?? false,
      isLoading: query?.isLoading ?? false,
      isPlaceholderData: query?.isPlaceholderData ?? false,
    };
  });
  return byProvider;
}

export function useProviderModelCatalog(input: {
  selectedProvider: ProviderKind;
  /**
   * Enables discovery for the on-demand providers (cursor/grok/droid/opencode/pi)
   * even when they are not selected — pass the picker's open state so their lists
   * are warm by the time the user browses them.
   */
  discoveryEnabled: boolean;
  /** Effective cwd for providers whose model catalog can be extended by project resources. */
  cwd?: string | null;
  /** Per-provider selected-model hints so an unknown selection still lists itself. */
  modelHintByProvider?: Partial<Record<ProviderKind, string | null>>;
  /**
   * Restrict background discovery to the providers used by a non-picker surface.
   * Picker surfaces can omit this to use the visible-provider list from settings.
   */
  prefetchProviders?: ReadonlyArray<ProviderKind>;
  /** Preserve eager Claude/Codex agent discovery on surfaces that already prefetch both. */
  agentDiscoveryPolicy?: "selected" | "eager-core";
}): ProviderModelCatalog {
  const { selectedProvider, discoveryEnabled, modelHintByProvider } = input;
  const agentDiscoveryPolicy = input.agentDiscoveryPolicy ?? "selected";
  const discoveryCwd = input.cwd ?? null;
  const { settings, serverSettings } = useAppSettings();
  const customModelsByProvider = useMemo(() => getCustomModelsByProvider(settings), [settings]);
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const prefetchProviderSet = useMemo(
    () =>
      input.prefetchProviders === undefined ? null : new Set<ProviderKind>(input.prefetchProviders),
    [input.prefetchProviders],
  );
  const discoveryPlan = useMemo(() => {
    const shouldDiscoverProvider = (
      provider: ProviderKind,
      prefetchRequested: boolean,
    ): boolean => {
      // The enabled flag is a short-circuit, not a precondition. `serverSettings` is
      // undefined while the settings query is in flight and stays undefined if it
      // fails — and it never refetches on its own (`staleTime: Infinity`). Treating
      // that as "disabled" would silence discovery for every provider, including the
      // selected one, which is precisely the "my model disappeared" symptom. Mirrors
      // the server-side fallback in ProviderDiscoveryService.listModels.
      if (serverSettings?.providers[provider]?.enabled === false) {
        return false;
      }
      if (provider === selectedProvider) {
        return true;
      }
      if (!prefetchRequested) {
        return false;
      }
      return prefetchProviderSet?.has(provider) ?? !hiddenProviderSet.has(provider);
    };
    const models = {} as Record<ProviderKind, boolean>;
    for (const provider of MODEL_CATALOG_PROVIDERS) {
      models[provider] =
        provider === "droid"
          ? // Droid probes every model through a disposable ACP session. Keep it
            // provider-scoped: explicit prefetch only, picker surfaces stay cold.
            shouldDiscoverProvider(
              "droid",
              discoveryEnabled && (prefetchProviderSet?.has("droid") ?? false),
            )
          : shouldDiscoverProvider(provider, discoveryEnabled);
    }
    const eagerCoreAgents = agentDiscoveryPolicy === "eager-core";
    return {
      models,
      coreAgents: {
        claudeAgent: shouldDiscoverProvider("claudeAgent", eagerCoreAgents),
        codex: shouldDiscoverProvider("codex", eagerCoreAgents),
      },
    };
  }, [
    agentDiscoveryPolicy,
    discoveryEnabled,
    hiddenProviderSet,
    prefetchProviderSet,
    selectedProvider,
    serverSettings,
  ]);

  const modelQueries = useQueries({
    queries: MODEL_CATALOG_PROVIDERS.map((provider) =>
      providerModelsQueryOptions({
        ...resolveProviderModelsQueryInput({ provider, settings, cwd: discoveryCwd }),
        enabled: discoveryPlan.models[provider],
      }),
    ),
    combine: combineModelCatalogQueries,
  });

  // Agent/mode discovery (opencode "Agent" picker, claude/codex subagents).
  const claudeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "claudeAgent",
      enabled: discoveryPlan.coreAgents.claudeAgent,
    }),
  );
  const codexDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "codex",
      enabled: discoveryPlan.coreAgents.codex,
    }),
  );
  const openCodeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
      cwd: discoveryCwd,
      enabled: discoveryPlan.models.opencode,
    }),
  );

  const runtimeModelsByProvider = useMemo<
    Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>
  >(() => {
    const result = {} as Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>;
    for (const provider of MODEL_CATALOG_PROVIDERS) {
      const models = modelQueries[provider].data?.models ?? EMPTY_MODELS;
      result[provider] = provider === "cursor" ? collapseCursorModelVariants(models) : models;
    }
    return result;
  }, [modelQueries]);

  const modelOptionsByProvider = useMemo(() => {
    const result = {} as Record<
      ProviderKind,
      ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
    >;
    for (const provider of MODEL_CATALOG_PROVIDERS) {
      const staticOptions = getAppModelOptions(
        provider,
        customModelsByProvider[provider],
        modelHintByProvider?.[provider],
      );
      const dynamicModels = runtimeModelsByProvider[provider];
      result[provider] =
        dynamicModels.length > 0
          ? mergeDynamicModelOptions({ provider, staticOptions, dynamicModels })
          : staticOptions;
    }
    return result;
  }, [customModelsByProvider, modelHintByProvider, runtimeModelsByProvider]);

  const loadingModelProviders = useMemo<Partial<Record<ProviderKind, boolean>>>(() => {
    const result: Partial<Record<ProviderKind, boolean>> = {};
    for (const provider of SKELETON_WHILE_DISCOVERING) {
      const query = modelQueries[provider];
      // A settled catalog (including adapter static fallbacks such as
      // `devin.static`) never re-blanks the picker during background refetches.
      result[provider] =
        discoveryPlan.models[provider] &&
        !hasResolvedModelCatalog(query.data) &&
        isInitialModelDiscoveryPending(query);
    }
    return result;
  }, [discoveryPlan, modelQueries]);

  const selectedRuntimeModel = useMemo(
    () =>
      resolveRuntimeModelDescriptor({
        provider: selectedProvider,
        model: modelHintByProvider?.[selectedProvider] ?? null,
        runtimeModels: runtimeModelsByProvider[selectedProvider],
      }),
    [modelHintByProvider, runtimeModelsByProvider, selectedProvider],
  );

  const selectedDynamicAgents =
    selectedProvider === "claudeAgent"
      ? (claudeDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
      : selectedProvider === "opencode"
        ? (openCodeDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
        : (codexDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS);
  const selectedRuntimeAgents = useMemo<ReadonlyArray<ProviderAgentDescriptor>>(
    () =>
      selectedDynamicAgents.map((agent) =>
        agent.description
          ? { name: agent.name, displayName: agent.displayName, description: agent.description }
          : { name: agent.name, displayName: agent.displayName },
      ),
    [selectedDynamicAgents],
  );

  // Discovery failures per provider, surfaced as a subtle inline note by the
  // model pickers. Includes rejected queries so a missing CLI or a timeout is
  // visible instead of silently rendering the static list as authoritative.
  const discoveryErrorsByProvider = useMemo(() => {
    const result: Partial<Record<ProviderKind, string | undefined>> = {};
    for (const provider of MODEL_CATALOG_PROVIDERS) {
      result[provider] = resolveModelDiscoveryError(modelQueries[provider]);
    }
    return result;
  }, [modelQueries]);

  const selectedProviderRuntimeModelDiscoveryPending =
    loadingModelProviders[selectedProvider] ?? false;
  const selectedProviderModelsQuery = modelQueries[selectedProvider];
  const selectedProviderModelsLoading =
    selectedProviderRuntimeModelDiscoveryPending ||
    (loadingModelProviders[selectedProvider] === undefined &&
      (selectedProviderModelsQuery.isLoading ||
        (selectedProviderModelsQuery.isFetching &&
          selectedProviderModelsQuery.data === undefined)));

  return useMemo(
    () => ({
      customModelsByProvider,
      modelOptionsByProvider,
      loadingModelProviders,
      runtimeModelsByProvider,
      selectedRuntimeModel,
      selectedRuntimeAgents,
      selectedProviderModelsLoading,
      selectedProviderRuntimeModelDiscoveryPending,
      discoveryErrorsByProvider,
    }),
    [
      customModelsByProvider,
      discoveryErrorsByProvider,
      loadingModelProviders,
      modelOptionsByProvider,
      runtimeModelsByProvider,
      selectedProviderModelsLoading,
      selectedProviderRuntimeModelDiscoveryPending,
      selectedRuntimeAgents,
      selectedRuntimeModel,
    ],
  );
}
