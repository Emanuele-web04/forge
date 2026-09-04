// FILE: useProviderModelCatalog.ts
// Purpose: Shared provider→model option catalog (static + custom + runtime-discovered)
//          for composer-like surfaces outside ChatView, e.g. the kanban new-task dialog.
// Layer: Web hooks
// Exports: useProviderModelCatalog, ProviderModelCatalog

import type {
  ProviderAgentDescriptor,
  ProviderKind,
  ProviderListModelsResult,
  ProviderModelDescriptor,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getAppModelOptions, getCustomModelsByProvider, useAppSettings } from "../appSettings";
import { resolveRuntimeModelDescriptor } from "../components/chat/runtimeModelCapabilities";
import { collapseCursorModelVariants } from "../cursorModelVariants";
import { isUsableModelSource } from "../lib/providerModelCatalogCache";
import {
  isInitialModelDiscoveryPending,
  providerAgentsQueryOptions,
  providerModelsQueryOptions,
} from "../lib/providerDiscoveryReactQuery";
import { mergeDynamicModelOptions, type ProviderModelOption } from "../providerModelOptions";

interface ProviderModelDiscoveryQueryLike {
  readonly status: "error" | "pending" | "success";
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isPlaceholderData: boolean;
  readonly data: ProviderListModelsResult | undefined;
  readonly dataUpdatedAt?: number | undefined;
  readonly errorUpdatedAt?: number | undefined;
}

export type ProviderModelDiscoveryState =
  | { status: "never-loaded"; hasDynamicList: false; refreshing: false }
  | { status: "loading"; hasDynamicList: false; refreshing: boolean }
  | {
      status: "success";
      hasDynamicList: boolean;
      refreshing: boolean;
      fetchedAt?: number | undefined;
    }
  | {
      status: "empty";
      hasDynamicList: false;
      refreshing: boolean;
      fetchedAt?: number | undefined;
    }
  | {
      status: "failed";
      hasDynamicList: boolean;
      refreshing: boolean;
      fetchedAt?: number | undefined;
    };

// Claude and Codex keep their curated static catalogs; runtime discovery never
// owns them, so their discovery state is permanently settled success.
const STATIC_CATALOG_DISCOVERY_SUCCESS: ProviderModelDiscoveryState = {
  status: "success",
  hasDynamicList: false,
  refreshing: false,
};

export function deriveProviderModelDiscoveryState(
  query: ProviderModelDiscoveryQueryLike,
): ProviderModelDiscoveryState {
  const data = query.data;
  const hasList = data !== undefined && isUsableModelSource(data.source) && data.models.length > 0;
  const fetchedAt =
    query.dataUpdatedAt && query.dataUpdatedAt > 0 ? query.dataUpdatedAt : undefined;

  if (!hasList && isInitialModelDiscoveryPending(query)) {
    if ((query.errorUpdatedAt ?? 0) > 0) {
      return { status: "failed", hasDynamicList: false, refreshing: true };
    }
    return { status: "loading", hasDynamicList: false, refreshing: false };
  }

  if (query.status === "error") {
    if (hasList) {
      return {
        status: "failed",
        hasDynamicList: true,
        refreshing: query.isFetching,
        fetchedAt,
      };
    }
    return { status: "failed", hasDynamicList: false, refreshing: query.isFetching };
  }

  if (query.status === "success" && data !== undefined) {
    if (hasList) {
      return {
        status: "success",
        hasDynamicList: true,
        refreshing: query.isFetching,
        fetchedAt,
      };
    }
    if (data.models.length === 0 && isUsableModelSource(data.source)) {
      return {
        status: "empty",
        hasDynamicList: false,
        refreshing: query.isFetching,
        fetchedAt,
      };
    }
  }

  return { status: "never-loaded", hasDynamicList: false, refreshing: false };
}

function useProviderModelDiscoveryState(query: ProviderModelDiscoveryQueryLike) {
  const { data, dataUpdatedAt, errorUpdatedAt, status, isLoading, isFetching, isPlaceholderData } =
    query;
  return useMemo(
    () =>
      deriveProviderModelDiscoveryState({
        data,
        dataUpdatedAt,
        errorUpdatedAt,
        status,
        isLoading,
        isFetching,
        isPlaceholderData,
      }),
    [data, dataUpdatedAt, errorUpdatedAt, status, isLoading, isFetching, isPlaceholderData],
  );
}

export interface ProviderModelCatalog {
  customModelsByProvider: ReturnType<typeof getCustomModelsByProvider>;
  modelOptionsByProvider: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
  >;
  modelDiscoveryByProvider: Record<ProviderKind, ProviderModelDiscoveryState>;
  runtimeModelsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>;
  selectedRuntimeModel: ProviderModelDescriptor | undefined;
  selectedRuntimeAgents: ReadonlyArray<ProviderAgentDescriptor>;
  selectedProviderRuntimeModelDiscoveryPending: boolean;
}

function useProviderModelsQuery(
  provider: ProviderKind,
  input: {
    binaryPath?: string | null;
    apiEndpoint?: string | null;
    agentDir?: string | null;
    cwd?: string | null;
    enabled?: boolean;
  },
) {
  const { binaryPath, apiEndpoint, agentDir, cwd, enabled } = input;
  return useQuery(
    useMemo(
      () =>
        providerModelsQueryOptions({
          provider,
          binaryPath,
          apiEndpoint,
          agentDir,
          cwd,
          enabled,
        }),
      [provider, binaryPath, apiEndpoint, agentDir, cwd, enabled],
    ),
  );
}

export function useProviderModelCatalog(input: {
  selectedProvider: ProviderKind;
  discoveryEnabled: boolean;
  cwd?: string | null;
  modelHintByProvider?: Partial<Record<ProviderKind, string | null>>;
  prefetchProviders?: ReadonlyArray<ProviderKind>;
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
  const shouldDiscoverProvider = (
    provider: ProviderKind,
    prefetchRequested = discoveryEnabled,
  ): boolean => {
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
  // ponytail: explicit prefetch only; picker surfaces stay cold (see droid query comment below).
  const droidPrefetchRequested = discoveryEnabled && (prefetchProviderSet?.has("droid") ?? false);
  const claudeModelDiscoveryEnabled = shouldDiscoverProvider("claudeAgent");
  const codexModelDiscoveryEnabled = shouldDiscoverProvider("codex");
  const cursorModelDiscoveryEnabled = shouldDiscoverProvider("cursor");
  const antigravityModelDiscoveryEnabled = shouldDiscoverProvider("antigravity");
  const grokModelDiscoveryEnabled = shouldDiscoverProvider("grok");
  const droidModelDiscoveryEnabled = shouldDiscoverProvider("droid", droidPrefetchRequested);
  const openCodeModelDiscoveryEnabled = shouldDiscoverProvider("opencode");
  const piModelDiscoveryEnabled = shouldDiscoverProvider("pi");
  const devinModelDiscoveryEnabled = shouldDiscoverProvider("devin");

  const claudeDynamicModelsQuery = useProviderModelsQuery("claudeAgent", {
    binaryPath: settings.claudeBinaryPath || null,
    enabled: claudeModelDiscoveryEnabled,
  });
  const codexDynamicModelsQuery = useProviderModelsQuery("codex", {
    enabled: codexModelDiscoveryEnabled,
  });
  const cursorDynamicModelsQuery = useProviderModelsQuery("cursor", {
    binaryPath: settings.cursorBinaryPath || null,
    apiEndpoint: settings.cursorApiEndpoint || null,
    enabled: cursorModelDiscoveryEnabled,
  });
  const antigravityModelsQuery = useProviderModelsQuery("antigravity", {
    binaryPath: settings.antigravityBinaryPath || null,
    cwd: discoveryCwd,
    enabled: antigravityModelDiscoveryEnabled,
  });
  const grokDynamicModelsQuery = useProviderModelsQuery("grok", {
    binaryPath: settings.grokBinaryPath || null,
    enabled: grokModelDiscoveryEnabled,
  });
  const droidDynamicModelsQuery = useProviderModelsQuery("droid", {
    binaryPath: settings.droidBinaryPath || null,
    cwd: discoveryCwd,
    enabled: droidModelDiscoveryEnabled,
  });
  const openCodeDynamicModelsQuery = useProviderModelsQuery("opencode", {
    binaryPath: settings.openCodeBinaryPath || null,
    cwd: discoveryCwd,
    enabled: openCodeModelDiscoveryEnabled,
  });
  const piDynamicModelsQuery = useProviderModelsQuery("pi", {
    binaryPath: settings.piBinaryPath || null,
    agentDir: settings.piAgentDir || null,
    cwd: discoveryCwd,
    enabled: piModelDiscoveryEnabled,
  });
  const devinDynamicModelsQuery = useProviderModelsQuery("devin", {
    binaryPath: settings.devinBinaryPath || null,
    cwd: discoveryCwd,
    enabled: devinModelDiscoveryEnabled,
  });

  const claudeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "claudeAgent",
      enabled: shouldDiscoverProvider("claudeAgent", agentDiscoveryPolicy === "eager-core"),
    }),
  );
  const codexDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "codex",
      enabled: shouldDiscoverProvider("codex", agentDiscoveryPolicy === "eager-core"),
    }),
  );
  const openCodeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
      cwd: discoveryCwd,
      enabled: openCodeModelDiscoveryEnabled,
    }),
  );

  const cursorRuntimeModels = useMemo(
    () => collapseCursorModelVariants(cursorDynamicModelsQuery.data?.models ?? []),
    [cursorDynamicModelsQuery.data?.models],
  );

  const antigravityDiscovery = useProviderModelDiscoveryState(antigravityModelsQuery);
  const cursorDiscovery = useProviderModelDiscoveryState(cursorDynamicModelsQuery);
  const droidDiscovery = useProviderModelDiscoveryState(droidDynamicModelsQuery);
  const grokDiscovery = useProviderModelDiscoveryState(grokDynamicModelsQuery);
  const openCodeDiscovery = useProviderModelDiscoveryState(openCodeDynamicModelsQuery);
  const piDiscovery = useProviderModelDiscoveryState(piDynamicModelsQuery);
  const devinDiscovery = useProviderModelDiscoveryState(devinDynamicModelsQuery);

  const modelDiscoveryByProvider = useMemo<Record<ProviderKind, ProviderModelDiscoveryState>>(
    () => ({
      antigravity: antigravityDiscovery,
      claudeAgent: STATIC_CATALOG_DISCOVERY_SUCCESS,
      codex: STATIC_CATALOG_DISCOVERY_SUCCESS,
      cursor: cursorDiscovery,
      devin: devinDiscovery,
      droid: droidDiscovery,
      grok: grokDiscovery,
      opencode: openCodeDiscovery,
      pi: piDiscovery,
    }),
    [
      antigravityDiscovery,
      cursorDiscovery,
      devinDiscovery,
      droidDiscovery,
      grokDiscovery,
      openCodeDiscovery,
      piDiscovery,
    ],
  );

  const modelOptionsByProvider = useMemo(() => {
    const staticOptions: Record<ProviderKind, ReturnType<typeof getAppModelOptions>> = {
      codex: getAppModelOptions("codex", customModelsByProvider.codex, modelHintByProvider?.codex),
      claudeAgent: getAppModelOptions(
        "claudeAgent",
        customModelsByProvider.claudeAgent,
        modelHintByProvider?.claudeAgent,
      ),
      cursor: getAppModelOptions(
        "cursor",
        customModelsByProvider.cursor,
        modelHintByProvider?.cursor,
      ),
      antigravity: getAppModelOptions(
        "antigravity",
        customModelsByProvider.antigravity,
        modelHintByProvider?.antigravity,
      ),
      grok: getAppModelOptions("grok", customModelsByProvider.grok, modelHintByProvider?.grok),
      droid: getAppModelOptions("droid", customModelsByProvider.droid, modelHintByProvider?.droid),
      devin: getAppModelOptions("devin", customModelsByProvider.devin, modelHintByProvider?.devin),
      opencode: getAppModelOptions(
        "opencode",
        customModelsByProvider.opencode,
        modelHintByProvider?.opencode,
      ),
      pi: getAppModelOptions("pi", customModelsByProvider.pi, modelHintByProvider?.pi),
    };
    const result: Record<
      ProviderKind,
      ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
    > = { ...staticOptions };
    const dynamicSources: Record<ProviderKind, typeof claudeDynamicModelsQuery.data> = {
      claudeAgent: claudeDynamicModelsQuery.data,
      codex: codexDynamicModelsQuery.data,
      cursor:
        cursorDynamicModelsQuery.data === undefined
          ? undefined
          : { ...cursorDynamicModelsQuery.data, models: cursorRuntimeModels },
      antigravity: antigravityModelsQuery.data,
      grok: grokDynamicModelsQuery.data,
      droid: droidDynamicModelsQuery.data,
      devin: devinDynamicModelsQuery.data,
      opencode: openCodeDynamicModelsQuery.data,
      pi: piDynamicModelsQuery.data,
    };
    for (const provider of [
      "claudeAgent",
      "codex",
      "cursor",
      "antigravity",
      "grok",
      "droid",
      "devin",
      "opencode",
      "pi",
    ] as const) {
      const dynamicSource = dynamicSources[provider];
      if (
        dynamicSource &&
        isUsableModelSource(dynamicSource.source) &&
        dynamicSource.models.length > 0
      ) {
        result[provider] = mergeDynamicModelOptions({
          provider,
          staticOptions: staticOptions[provider],
          dynamicModels: dynamicSource.models,
        });
      }
    }
    return result;
  }, [
    antigravityModelsQuery.data,
    claudeDynamicModelsQuery.data,
    codexDynamicModelsQuery.data,
    cursorDynamicModelsQuery.data,
    cursorRuntimeModels,
    customModelsByProvider,
    devinDynamicModelsQuery.data,
    droidDynamicModelsQuery.data,
    grokDynamicModelsQuery.data,
    modelHintByProvider,
    openCodeDynamicModelsQuery.data,
    piDynamicModelsQuery.data,
  ]);

  const runtimeModelsByProvider = useMemo<
    Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>
  >(
    () => ({
      claudeAgent: claudeDynamicModelsQuery.data?.models ?? [],
      codex: codexDynamicModelsQuery.data?.models ?? [],
      cursor: cursorRuntimeModels,
      antigravity: antigravityModelsQuery.data?.models ?? [],
      grok: grokDynamicModelsQuery.data?.models ?? [],
      droid: droidDynamicModelsQuery.data?.models ?? [],
      devin: devinDynamicModelsQuery.data?.models ?? [],
      opencode: openCodeDynamicModelsQuery.data?.models ?? [],
      pi: piDynamicModelsQuery.data?.models ?? [],
    }),
    [
      antigravityModelsQuery.data?.models,
      claudeDynamicModelsQuery.data?.models,
      codexDynamicModelsQuery.data?.models,
      cursorRuntimeModels,
      devinDynamicModelsQuery.data?.models,
      droidDynamicModelsQuery.data?.models,
      grokDynamicModelsQuery.data?.models,
      openCodeDynamicModelsQuery.data?.models,
      piDynamicModelsQuery.data?.models,
    ],
  );

  const selectedRuntimeModel = useMemo(
    () =>
      resolveRuntimeModelDescriptor({
        provider: selectedProvider,
        model: modelHintByProvider?.[selectedProvider] ?? null,
        runtimeModels: runtimeModelsByProvider[selectedProvider],
      }),
    [modelHintByProvider, runtimeModelsByProvider, selectedProvider],
  );

  const agentQueriesByProvider: Partial<Record<ProviderKind, typeof claudeDynamicAgentsQuery>> = {
    claudeAgent: claudeDynamicAgentsQuery,
    codex: codexDynamicAgentsQuery,
    opencode: openCodeDynamicAgentsQuery,
  };
  const selectedDynamicAgents = agentQueriesByProvider[selectedProvider]?.data?.agents;
  const selectedRuntimeAgents = useMemo<ReadonlyArray<ProviderAgentDescriptor>>(
    () =>
      (selectedDynamicAgents ?? []).map((agent) =>
        agent.description
          ? { name: agent.name, displayName: agent.displayName, description: agent.description }
          : { name: agent.name, displayName: agent.displayName },
      ),
    [selectedDynamicAgents],
  );

  const selectedProviderRuntimeModelDiscoveryPending =
    modelDiscoveryByProvider[selectedProvider].status === "loading";

  return useMemo(
    () => ({
      customModelsByProvider,
      modelOptionsByProvider,
      modelDiscoveryByProvider,
      runtimeModelsByProvider,
      selectedRuntimeModel,
      selectedRuntimeAgents,
      selectedProviderRuntimeModelDiscoveryPending,
    }),
    [
      customModelsByProvider,
      modelDiscoveryByProvider,
      modelOptionsByProvider,
      runtimeModelsByProvider,
      selectedProviderRuntimeModelDiscoveryPending,
      selectedRuntimeAgents,
      selectedRuntimeModel,
    ],
  );
}
