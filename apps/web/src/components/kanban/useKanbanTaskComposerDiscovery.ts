// FILE: useKanbanTaskComposerDiscovery.ts
// Purpose: Builds kanban task composer autocomplete items from provider/workspace discovery.
// Layer: Kanban UI hook
// Exports: useKanbanTaskComposerDiscovery

import type {
  ProjectEntry,
  ProviderAgentDescriptor,
  ProviderKind,
  ProviderMentionReference,
  ProviderNativeCommandDescriptor,
  ProviderPluginDescriptor,
  ProviderSkillDescriptor,
  ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";

import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";
import type { ComposerTrigger } from "~/composer-logic";
import {
  buildSearchableModelOptions,
  useComposerCommandMenuItems,
} from "~/hooks/useComposerCommandMenuItems";
import { getLocalFolderBrowseRootPath, isLocalFolderMentionQuery } from "~/lib/localFolderMentions";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  providerCommandsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsNativeSlashCommandDiscovery,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
} from "~/lib/providerDiscoveryReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { isMacPlatform } from "~/lib/utils";
import { AVAILABLE_PROVIDER_OPTIONS } from "../chat/ProviderModelPicker";
import type { ProviderModelOption } from "../../providerModelOptions";

type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
const EMPTY_COMPOSER_PLUGIN_SUGGESTIONS: ComposerPluginSuggestion[] = [];
const KANBAN_SUPPORTED_APP_SLASH_COMMANDS = new Set(["clear", "default", "plan"]);

interface UseKanbanTaskComposerDiscoveryInput {
  readonly composerTrigger: ComposerTrigger | null;
  readonly selectedProvider: ProviderKind;
  readonly targetExecutable: boolean;
  readonly modelOptionsByProvider: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
  >;
  readonly selectedRuntimeAgents: readonly ProviderAgentDescriptor[];
  readonly selectedProjectCwd: string | null;
  readonly serverCwd: string | null;
  readonly serverHomeDir: string | null;
  readonly scratchThreadId: ThreadId;
  readonly providerOptionsForDispatch: ProviderStartOptions | undefined;
  readonly hiddenProviders: readonly ProviderKind[];
  readonly providerOrder: readonly ProviderKind[];
  readonly piAgentDir: string | null;
}

export function useKanbanTaskComposerDiscovery(input: UseKanbanTaskComposerDiscoveryInput): {
  readonly mentionTriggerQuery: string;
  readonly isLocalFolderBrowserOpen: boolean;
  readonly localFolderBrowseRootPath: string | null;
  readonly composerMenuItems: ComposerCommandItem[];
  readonly isComposerMenuLoading: boolean;
} {
  const {
    composerTrigger,
    selectedProvider,
    targetExecutable,
    modelOptionsByProvider,
    selectedRuntimeAgents,
    selectedProjectCwd,
    serverCwd,
    serverHomeDir,
    scratchThreadId,
    providerOptionsForDispatch,
    hiddenProviders,
    providerOrder,
    piAgentDir,
  } = input;

  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const localFolderBrowseRootPath = getLocalFolderBrowseRootPath(
    serverHomeDir,
    isMacPlatform(platform),
  );
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const mentionTriggerQuery = composerTrigger?.kind === "mention" ? composerTrigger.query : "";
  const isMentionTrigger = composerTriggerKind === "mention";
  const isLocalFolderBrowserOpen =
    isMentionTrigger && isLocalFolderMentionQuery(mentionTriggerQuery);
  const isSkillTrigger = composerTriggerKind === "skill";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    mentionTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectiveMentionQuery = mentionTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const composerSkillCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: null,
    activeProjectCwd: selectedProjectCwd,
    serverCwd,
  });

  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider, targetExecutable),
  );
  const providerComposerCapabilities = targetExecutable
    ? providerComposerCapabilitiesQuery.data
    : undefined;
  const providerCommandsQuery = useQuery(
    providerCommandsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId: scratchThreadId,
      binaryPath:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.binaryPath
          : selectedProvider === "kilo"
            ? providerOptionsForDispatch?.kilo?.binaryPath
            : null) ?? null,
      serverUrl:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.serverUrl
          : selectedProvider === "kilo"
            ? providerOptionsForDispatch?.kilo?.serverUrl
            : null) ?? null,
      experimentalWebSockets:
        selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.experimentalWebSockets
          : undefined,
      agentDir: selectedProvider === "pi" ? piAgentDir : null,
      enabled:
        targetExecutable &&
        (composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model") &&
        supportsNativeSlashCommandDiscovery(providerComposerCapabilities) &&
        composerSkillCwd !== null,
    }),
  );
  const canDiscoverProviderSkills =
    selectedProvider === "pi" || supportsSkillDiscovery(providerComposerCapabilities);
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId: scratchThreadId,
      agentDir: selectedProvider === "pi" ? piAgentDir : null,
      enabled:
        targetExecutable &&
        (isSkillTrigger || composerTriggerKind === "slash-command" || selectedProvider === "pi") &&
        canDiscoverProviderSkills &&
        composerSkillCwd !== null,
    }),
  );
  const providerPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId: scratchThreadId,
      enabled:
        targetExecutable &&
        supportsPluginDiscovery(providerComposerCapabilities) &&
        composerSkillCwd !== null,
    }),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: selectedProjectCwd,
      query: effectiveMentionQuery,
      enabled: isMentionTrigger && !isLocalFolderBrowserOpen,
      limit: 80,
    }),
  );

  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const providerPlugins = targetExecutable
    ? (providerPluginsQuery.data?.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => ({
          plugin,
          mention: {
            name: plugin.name,
            path: `plugin://${plugin.name}@${marketplace.name}`,
          } satisfies ProviderMentionReference,
        })),
      ) ?? EMPTY_COMPOSER_PLUGIN_SUGGESTIONS)
    : EMPTY_COMPOSER_PLUGIN_SUGGESTIONS;
  const providerNativeCommands = targetExecutable
    ? (providerCommandsQuery.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS)
    : EMPTY_PROVIDER_NATIVE_COMMANDS;
  const providerSkills = targetExecutable
    ? (providerSkillsQuery.data?.skills ?? EMPTY_PROVIDER_SKILLS)
    : EMPTY_PROVIDER_SKILLS;
  const searchableModelOptions = buildSearchableModelOptions({
    providerOptions: AVAILABLE_PROVIDER_OPTIONS,
    modelOptionsByProvider,
    providerOrder,
    hiddenProviders,
    protectedProviders: [selectedProvider],
  });
  const dynamicAgents = selectedRuntimeAgents.map((agent) =>
    agent.description
      ? { name: agent.name, displayName: agent.displayName, description: agent.description }
      : { name: agent.name, displayName: agent.displayName },
  );
  const rawComposerMenuItems = useComposerCommandMenuItems({
    composerTrigger,
    provider: selectedProvider,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    workspaceEntries,
    searchableModelOptions,
    supportsFastSlashCommand: false,
    canOfferCompactCommand: false,
    canOfferReviewCommand: false,
    canOfferForkCommand: false,
    canOfferSideCommand: false,
    canOfferExportCommand: false,
    surfaceAppSlashCommands: KANBAN_SUPPORTED_APP_SLASH_COMMANDS,
    dynamicAgents,
  });
  const composerMenuItems = rawComposerMenuItems.filter(
    (item) =>
      item.type !== "slash-command" || KANBAN_SUPPORTED_APP_SLASH_COMMANDS.has(item.command),
  );
  const isComposerMenuLoading =
    (composerTriggerKind === "mention" &&
      ((mentionTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching ||
        (targetExecutable &&
          (providerPluginsQuery.isLoading || providerPluginsQuery.isFetching)))) ||
    (composerTriggerKind === "slash-command" &&
      targetExecutable &&
      (providerCommandsQuery.isLoading ||
        providerCommandsQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching)) ||
    (composerTriggerKind === "skill" &&
      targetExecutable &&
      (providerComposerCapabilitiesQuery.isLoading ||
        providerComposerCapabilitiesQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching));

  return {
    mentionTriggerQuery,
    isLocalFolderBrowserOpen,
    localFolderBrowseRootPath,
    composerMenuItems,
    isComposerMenuLoading,
  };
}
