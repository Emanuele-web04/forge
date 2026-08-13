// FILE: providerModelPrefetch.ts
// Purpose: Warm provider model discovery and composer capabilities into the
//          React Query cache before a new thread mounts ChatView, so the
//          composer can skip the "Loading models" skeleton and capability
//          round-trips on the common new-thread path.
// Layer: Web lib
// Exports: resolve + prefetch helpers that mirror ChatView's listModels query keys.

import type { ProviderKind } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type { AppSettings } from "../appSettings";
import { resolveProviderDiscoveryCwd } from "./providerDiscovery";
import {
  providerAgentsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";

export type ProviderModelPrefetchSettings = Pick<
  AppSettings,
  | "defaultProvider"
  | "cursorBinaryPath"
  | "cursorApiEndpoint"
  | "antigravityBinaryPath"
  | "grokBinaryPath"
  | "droidBinaryPath"
  | "kiloBinaryPath"
  | "openCodeBinaryPath"
  | "piBinaryPath"
  | "piAgentDir"
>;

export function resolveNewThreadModelPrefetchProvider(input: {
  draftActiveProvider?: ProviderKind | null | undefined;
  stickyActiveProvider?: ProviderKind | null | undefined;
  projectDefaultProvider?: ProviderKind | null | undefined;
  defaultProvider: ProviderKind;
}): ProviderKind {
  return (
    input.draftActiveProvider ??
    input.stickyActiveProvider ??
    input.projectDefaultProvider ??
    input.defaultProvider ??
    "codex"
  );
}

export function resolveNewThreadModelPrefetchCwd(input: {
  draftWorktreePath?: string | null | undefined;
  projectCwd?: string | null | undefined;
  serverCwd?: string | null | undefined;
}): string | null {
  return resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: input.draftWorktreePath ?? null,
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
}) {
  const { provider, settings } = input;
  const cwd = input.cwd ?? null;

  switch (provider) {
    case "claudeAgent":
      return providerModelsQueryOptions({ provider: "claudeAgent" });
    case "codex":
      return providerModelsQueryOptions({ provider: "codex" });
    case "cursor":
      return providerModelsQueryOptions({
        provider: "cursor",
        binaryPath: settings.cursorBinaryPath || null,
        apiEndpoint: settings.cursorApiEndpoint || null,
      });
    case "antigravity":
      return providerModelsQueryOptions({
        provider: "antigravity",
        binaryPath: settings.antigravityBinaryPath || null,
        cwd,
      });
    case "grok":
      return providerModelsQueryOptions({
        provider: "grok",
        binaryPath: settings.grokBinaryPath || null,
      });
    case "droid":
      return providerModelsQueryOptions({
        provider: "droid",
        binaryPath: settings.droidBinaryPath || null,
        cwd,
      });
    case "kilo":
      return providerModelsQueryOptions({
        provider: "kilo",
        binaryPath: settings.kiloBinaryPath || null,
        cwd,
      });
    case "opencode":
      return providerModelsQueryOptions({
        provider: "opencode",
        binaryPath: settings.openCodeBinaryPath || null,
        cwd,
      });
    case "minimax":
      // MiniMax has no CLI to discover models from; its catalog is owned by opencode.
      return null;
    case "pi":
      return providerModelsQueryOptions({
        provider: "pi",
        binaryPath: settings.piBinaryPath || null,
        agentDir: settings.piAgentDir || null,
        cwd,
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
    case "kilo":
      return providerAgentsQueryOptions({
        provider: "kilo",
        binaryPath: settings.kiloBinaryPath || null,
        cwd,
      });
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
    provider: ProviderKind;
    settings: ProviderModelPrefetchSettings;
    cwd?: string | null;
  },
): void {
  const cwd = input.cwd ?? null;
  const modelsOptions = providerModelsPrefetchQueryOptions({
    provider: input.provider,
    settings: input.settings,
    cwd,
  });
  if (modelsOptions) {
    void queryClient.prefetchQuery(modelsOptions);
  }

  // Agent/mode lists ride along for providers that surface them next to models.
  const agentsOptions = providerAgentsPrefetchQueryOptions({
    provider: input.provider,
    settings: input.settings,
    cwd,
  });
  if (agentsOptions) {
    void queryClient.prefetchQuery(agentsOptions);
  }

  // Composer capabilities gate composer affordances on ChatView mount; the query
  // has staleTime Infinity, so this costs one IPC per provider per session.
  void queryClient.prefetchQuery(providerComposerCapabilitiesQueryOptions(input.provider));
}
