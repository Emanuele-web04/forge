// FILE: useProviderModelCatalog.ts
// Purpose: Shared provider→model option catalog (static + custom + runtime-discovered)
//          for composer-like surfaces outside ChatView, e.g. the kanban new-task dialog.
// Layer: Web hooks
// Exports: useProviderModelCatalog, ProviderModelCatalog

import type {
  ProviderAgentDescriptor,
  ProviderKind,
  ProviderModelDescriptor,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getAppModelOptions, getCustomModelsByProvider, useAppSettings } from "../appSettings";
import { resolveRuntimeModelDescriptor } from "../components/chat/runtimeModelCapabilities";
import { collapseCursorModelVariants } from "../cursorModelVariants";
import {
  isInitialModelDiscoveryPending,
  providerAgentsQueryOptions,
  providerModelsQueryOptions,
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
  /** Runtime-discovered agents/modes for the selected provider (kilo/opencode/claude/codex). */
  selectedRuntimeAgents: ReadonlyArray<ProviderAgentDescriptor>;
  /** Loading state used by the selected provider's bootstrap skeleton. */
  selectedProviderModelsLoading: boolean;
  /** Whether the selected provider requires and is still waiting on runtime models. */
  selectedProviderRuntimeModelDiscoveryPending: boolean;
}

const EMPTY_PROVIDER_AGENTS: ReadonlyArray<ProviderAgentDescriptor> = [];

export function useProviderModelCatalog(input: {
  selectedProvider: ProviderKind;
  /**
   * Enables discovery for the on-demand providers (cursor/grok/droid/kilo/opencode/pi)
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
  const shouldDiscoverProvider = (
    provider: ProviderKind,
    prefetchRequested = discoveryEnabled,
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

  const claudeModelDiscoveryEnabled = shouldDiscoverProvider("claudeAgent");
  const codexModelDiscoveryEnabled = shouldDiscoverProvider("codex");
  const cursorModelDiscoveryEnabled = shouldDiscoverProvider("cursor");
  const antigravityModelDiscoveryEnabled = shouldDiscoverProvider("antigravity");
  const grokModelDiscoveryEnabled = shouldDiscoverProvider("grok");
  const droidModelDiscoveryEnabled = shouldDiscoverProvider("droid", false);
  const kiloModelDiscoveryEnabled = shouldDiscoverProvider("kilo");
  const openCodeModelDiscoveryEnabled = shouldDiscoverProvider("opencode");
  const piModelDiscoveryEnabled = shouldDiscoverProvider("pi");

  const claudeDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "claudeAgent",
      binaryPath: settings.claudeBinaryPath || null,
      enabled: claudeModelDiscoveryEnabled,
    }),
  );
  const codexDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "codex",
      enabled: codexModelDiscoveryEnabled,
    }),
  );
  const cursorDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "cursor",
      binaryPath: settings.cursorBinaryPath || null,
      apiEndpoint: settings.cursorApiEndpoint || null,
      enabled: cursorModelDiscoveryEnabled,
    }),
  );
  const antigravityModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "antigravity",
      binaryPath: settings.antigravityBinaryPath || null,
      cwd: discoveryCwd,
      enabled: antigravityModelDiscoveryEnabled,
    }),
  );
  const grokDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "grok",
      binaryPath: settings.grokBinaryPath || null,
      enabled: grokModelDiscoveryEnabled,
    }),
  );
  const droidDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "droid",
      binaryPath: settings.droidBinaryPath || null,
      cwd: discoveryCwd,
      // Droid probes every model through a disposable ACP session. Keep it
      // provider-scoped instead of warming it from unrelated picker/settings UI.
      enabled: droidModelDiscoveryEnabled,
    }),
  );
  const openCodeDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
      cwd: discoveryCwd,
      enabled: openCodeModelDiscoveryEnabled,
    }),
  );
  const kiloDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "kilo",
      binaryPath: settings.kiloBinaryPath || null,
      cwd: discoveryCwd,
      enabled: kiloModelDiscoveryEnabled,
    }),
  );
  const piDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "pi",
      binaryPath: settings.piBinaryPath || null,
      agentDir: settings.piAgentDir || null,
      cwd: discoveryCwd,
      enabled: piModelDiscoveryEnabled,
    }),
  );

  // Agent/mode discovery (kilo/opencode "Mode"/"Agent" picker, claude/codex subagents).
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
  const kiloDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "kilo",
      binaryPath: settings.kiloBinaryPath || null,
      cwd: discoveryCwd,
      enabled: kiloModelDiscoveryEnabled,
    }),
  );

  const cursorRuntimeModels = useMemo(
    () => collapseCursorModelVariants(cursorDynamicModelsQuery.data?.models ?? []),
    [cursorDynamicModelsQuery.data?.models],
  );

  const hasResolvedCursorModelDiscovery =
    (cursorDynamicModelsQuery.data?.source === "cursor.cli" ||
      cursorDynamicModelsQuery.data?.source === "cursor.acp") &&
    (cursorDynamicModelsQuery.data.models.length ?? 0) > 0;
  const cursorModelDiscoveryPending =
    cursorModelDiscoveryEnabled &&
    !hasResolvedCursorModelDiscovery &&
    isInitialModelDiscoveryPending(cursorDynamicModelsQuery);
  const hasResolvedDroidModelDiscovery =
    droidDynamicModelsQuery.data?.source === "droid-acp" &&
    (droidDynamicModelsQuery.data.models.length ?? 0) > 0;
  const droidModelDiscoveryPending =
    droidModelDiscoveryEnabled &&
    !hasResolvedDroidModelDiscovery &&
    isInitialModelDiscoveryPending(droidDynamicModelsQuery);
  const hasResolvedKiloModelDiscovery =
    (kiloDynamicModelsQuery.data?.source === "kilo-cli" ||
      kiloDynamicModelsQuery.data?.source === "kilo") &&
    (kiloDynamicModelsQuery.data.models.length ?? 0) > 0;
  const kiloModelDiscoveryPending =
    kiloModelDiscoveryEnabled &&
    !hasResolvedKiloModelDiscovery &&
    isInitialModelDiscoveryPending(kiloDynamicModelsQuery);
  const hasResolvedOpenCodeModelDiscovery =
    (openCodeDynamicModelsQuery.data?.source === "opencode-cli" ||
      openCodeDynamicModelsQuery.data?.source === "opencode") &&
    (openCodeDynamicModelsQuery.data.models.length ?? 0) > 0;
  const openCodeModelDiscoveryPending =
    openCodeModelDiscoveryEnabled &&
    !hasResolvedOpenCodeModelDiscovery &&
    isInitialModelDiscoveryPending(openCodeDynamicModelsQuery);
  const hasResolvedPiModelDiscovery =
    piDynamicModelsQuery.data?.source?.startsWith("pi.sdk") === true &&
    (piDynamicModelsQuery.data.models.length ?? 0) > 0;
  const piModelDiscoveryPending =
    piModelDiscoveryEnabled &&
    !hasResolvedPiModelDiscovery &&
    isInitialModelDiscoveryPending(piDynamicModelsQuery);
  const antigravityModelDiscoveryPending =
    antigravityModelDiscoveryEnabled &&
    !(
      antigravityModelsQuery.data?.source === "antigravity.cli" &&
      (antigravityModelsQuery.data.models.length ?? 0) > 0
    ) &&
    isInitialModelDiscoveryPending(antigravityModelsQuery);

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
      kilo: getAppModelOptions("kilo", customModelsByProvider.kilo, modelHintByProvider?.kilo),
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
      kilo: kiloDynamicModelsQuery.data,
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
      "kilo",
      "opencode",
      "pi",
    ] as const) {
      const dynamicModels = dynamicSources[provider]?.models;
      if (dynamicModels && dynamicModels.length > 0) {
        result[provider] = mergeDynamicModelOptions({
          provider,
          staticOptions: staticOptions[provider],
          dynamicModels,
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
    droidDynamicModelsQuery.data,
    grokDynamicModelsQuery.data,
    kiloDynamicModelsQuery.data,
    modelHintByProvider,
    openCodeDynamicModelsQuery.data,
    piDynamicModelsQuery.data,
  ]);

  const loadingModelProviders = useMemo<Partial<Record<ProviderKind, boolean>>>(
    () => ({
      antigravity: antigravityModelDiscoveryPending,
      cursor: cursorModelDiscoveryPending,
      droid: droidModelDiscoveryPending,
      kilo: kiloModelDiscoveryPending,
      opencode: openCodeModelDiscoveryPending,
      pi: piModelDiscoveryPending,
    }),
    [
      antigravityModelDiscoveryPending,
      cursorModelDiscoveryPending,
      droidModelDiscoveryPending,
      kiloModelDiscoveryPending,
      openCodeModelDiscoveryPending,
      piModelDiscoveryPending,
    ],
  );

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
      kilo: kiloDynamicModelsQuery.data?.models ?? [],
      opencode: openCodeDynamicModelsQuery.data?.models ?? [],
      pi: piDynamicModelsQuery.data?.models ?? [],
    }),
    [
      antigravityModelsQuery.data?.models,
      claudeDynamicModelsQuery.data?.models,
      codexDynamicModelsQuery.data?.models,
      cursorRuntimeModels,
      droidDynamicModelsQuery.data?.models,
      grokDynamicModelsQuery.data?.models,
      kiloDynamicModelsQuery.data?.models,
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

  const selectedDynamicAgents =
    selectedProvider === "claudeAgent"
      ? (claudeDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
      : selectedProvider === "kilo"
        ? (kiloDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
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

  const selectedProviderRuntimeModelDiscoveryPending =
    loadingModelProviders[selectedProvider] ?? false;
  const selectedProviderModelsQuery =
    selectedProvider === "claudeAgent"
      ? claudeDynamicModelsQuery
      : selectedProvider === "codex"
        ? codexDynamicModelsQuery
        : selectedProvider === "cursor"
          ? cursorDynamicModelsQuery
          : selectedProvider === "antigravity"
            ? antigravityModelsQuery
            : selectedProvider === "grok"
              ? grokDynamicModelsQuery
              : selectedProvider === "droid"
                ? droidDynamicModelsQuery
                : selectedProvider === "kilo"
                  ? kiloDynamicModelsQuery
                  : selectedProvider === "opencode"
                    ? openCodeDynamicModelsQuery
                    : piDynamicModelsQuery;
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
    }),
    [
      customModelsByProvider,
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
