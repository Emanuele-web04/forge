import type {
  ProjectEntry,
  ProviderAgentDescriptor,
  ProviderNativeCommandDescriptor,
  ProviderKind,
  ProviderMentionReference,
  ProviderPluginDescriptor,
  ProviderSkillDescriptor,
} from "@synara/contracts";
import { getAgentMentionAutocompleteAliases } from "@synara/contracts";
import type { DisplayProvider } from "~/lib/providerIdentity";
import {
  buildCommandSearchFields,
  buildPluginSearchFields,
  buildSkillSearchFields,
  isInstalledProviderPlugin,
  normalizeProviderDiscoveryText,
  rankProviderDiscoveryItems,
} from "~/lib/providerDiscovery";
import {
  LOCAL_FOLDER_MENTION_NAME,
  matchesLocalFolderMentionShortcut,
} from "~/lib/localFolderMentions";
import { basenameOfPath } from "../file-icons";
import type { ComposerTrigger } from "../composer-logic";
import {
  filterComposerSlashCommands,
  getAvailableComposerSlashCommands,
  getProviderNativeSlashCommandSearchTerms,
  shouldHideProviderNativeCommandFromComposerMenu,
} from "../composerSlashCommands";
import { threadMentionPathForThreadId } from "@synara/shared/threadMentions";

import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";
import type { ProviderModelOption } from "../providerModelOptions";
import { compareProvidersByOrder } from "../providerOrdering";
import type { ComposerThreadMentionSource, Project } from "../types";

type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

export type SearchableModelOption = {
  provider: ProviderKind;
  providerLabel: string;
  slug: string;
  name: string;
  searchSlug: string;
  searchName: string;
  searchProvider: string;
  searchUpstreamProvider: string;
};

const THREAD_MENTION_SUGGESTION_LIMIT = 20;

function threadSuggestionTitle(title: string): string {
  return title.trim() || "Untitled thread";
}

function threadSuggestionContainerName(project: Project | undefined): string {
  if (!project) return "Unknown project";
  if (project.kind === "chat") return "Chats";
  if (project.kind === "studio") return "Studio";
  return project.name.trim() || project.folderName.trim() || "Untitled project";
}

function threadSuggestionRecency(thread: ComposerThreadMentionSource): string {
  return thread.latestUserMessageAt ?? thread.lastVisitedAt ?? thread.createdAt;
}

interface ThreadMentionCandidate {
  readonly thread: ComposerThreadMentionSource;
  readonly title: string;
  readonly projectName: string;
  readonly mentionName: string;
}

function mentionNameKey(value: string): string {
  return value.trim().toLowerCase();
}

function makeUniqueMentionName(input: {
  readonly preferredName: string;
  readonly threadId: string;
  readonly reservedNames: ReadonlySet<string>;
  readonly usedNames: ReadonlySet<string>;
}): string {
  let attempt = 0;
  while (true) {
    const suffix =
      attempt === 0
        ? input.threadId.slice(-6) || input.threadId
        : attempt === 1
          ? input.threadId
          : `${input.threadId}:${attempt}`;
    const candidate = `${input.preferredName} (${suffix})`;
    const key = mentionNameKey(candidate);
    if (!input.reservedNames.has(key) && !input.usedNames.has(key)) {
      return candidate;
    }
    attempt += 1;
  }
}

// Mention tokens/chips resolve back to their reference by name, so two chats
// sharing a title would be indistinguishable once inserted (wrong provider
// icon, ambiguous context). Build friendly project-qualified names first, then
// guarantee uniqueness across the final serialized names with a stable id suffix.
function withDisambiguatedMentionNames(
  candidates: ReadonlyArray<Omit<ThreadMentionCandidate, "mentionName">>,
): ThreadMentionCandidate[] {
  const titleCounts = new Map<string, number>();
  const qualifiedCounts = new Map<string, number>();
  for (const candidate of candidates) {
    titleCounts.set(candidate.title, (titleCounts.get(candidate.title) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    if ((titleCounts.get(candidate.title) ?? 0) > 1) {
      const qualified = `${candidate.title} (${candidate.projectName})`;
      qualifiedCounts.set(qualified, (qualifiedCounts.get(qualified) ?? 0) + 1);
    }
  }
  const preferredCandidates = candidates.map((candidate) => {
    const qualified = `${candidate.title} (${candidate.projectName})`;
    const preferredName =
      (titleCounts.get(candidate.title) ?? 0) <= 1
        ? candidate.title
        : (qualifiedCounts.get(qualified) ?? 0) > 1
          ? `${candidate.title} (${candidate.projectName}, ${candidate.thread.id.slice(-6)})`
          : qualified;
    return {
      thread: candidate.thread,
      title: candidate.title,
      projectName: candidate.projectName,
      preferredName,
    };
  });
  const preferredNameCounts = new Map<string, number>();
  for (const candidate of preferredCandidates) {
    const key = mentionNameKey(candidate.preferredName);
    preferredNameCounts.set(key, (preferredNameCounts.get(key) ?? 0) + 1);
  }
  const reservedNames = new Set(preferredNameCounts.keys());
  const usedNames = new Set<string>();

  return preferredCandidates.map((candidate) => {
    const preferredKey = mentionNameKey(candidate.preferredName);
    const mentionName =
      (preferredNameCounts.get(preferredKey) ?? 0) === 1 && !usedNames.has(preferredKey)
        ? candidate.preferredName
        : makeUniqueMentionName({
            preferredName: candidate.preferredName,
            threadId: candidate.thread.id,
            reservedNames,
            usedNames,
          });
    usedNames.add(mentionNameKey(mentionName));
    return {
      thread: candidate.thread,
      title: candidate.title,
      projectName: candidate.projectName,
      mentionName,
    };
  });
}

export function buildThreadMentionComposerItems(input: {
  readonly threads: readonly ComposerThreadMentionSource[];
  readonly projects: readonly Project[];
  readonly currentThreadId: string | null;
  readonly query: string;
}): ComposerCommandItem[] {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const candidates = withDisambiguatedMentionNames(
    input.threads
      .filter(
        (thread) => thread.id !== input.currentThreadId && (thread.archivedAt ?? null) === null,
      )
      .map((thread) => ({
        thread,
        title: threadSuggestionTitle(thread.title),
        projectName: threadSuggestionContainerName(projectById.get(thread.projectId)),
      })),
  );
  const query = normalizeProviderDiscoveryText(input.query);
  const ranked = (
    query
      ? rankProviderDiscoveryItems(candidates, query, ({ title }) => [{ value: title }])
      : candidates.toSorted((left, right) =>
          threadSuggestionRecency(right.thread).localeCompare(threadSuggestionRecency(left.thread)),
        )
  ).slice(0, THREAD_MENTION_SUGGESTION_LIMIT);

  return ranked.map(({ thread, title, projectName, mentionName }) => ({
    id: `thread:${thread.id}`,
    type: "thread" as const,
    threadId: thread.id,
    provider: thread.provider,
    mention: { name: mentionName, path: threadMentionPathForThreadId(thread.id) },
    label: title,
    description: projectName,
  }));
}

export function buildSearchableModelOptions(input: {
  providerOptions: ReadonlyArray<{ value: ProviderKind; label: string }>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  providerOrder: readonly ProviderKind[];
  hiddenProviders: readonly ProviderKind[];
  protectedProviders: readonly ProviderKind[];
  lockedProvider?: ProviderKind | null;
}): SearchableModelOption[] {
  const hiddenProviderSet = new Set(input.hiddenProviders);
  const protectedProviderSet = new Set(input.protectedProviders);
  return input.providerOptions
    .toSorted((left, right) =>
      compareProvidersByOrder(input.providerOrder, left.value, right.value),
    )
    .filter((option) =>
      input.lockedProvider
        ? option.value === input.lockedProvider
        : protectedProviderSet.has(option.value) || !hiddenProviderSet.has(option.value),
    )
    .flatMap((option) =>
      input.modelOptionsByProvider[option.value].map(
        ({ slug, name, upstreamProviderId, upstreamProviderName }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
          searchUpstreamProvider: (upstreamProviderName ?? upstreamProviderId ?? "").toLowerCase(),
        }),
      ),
    );
}

export function useComposerCommandMenuItems(input: {
  composerTrigger: ComposerTrigger | null;
  provider: ProviderKind;
  providerPlugins: readonly ComposerPluginSuggestion[];
  providerNativeCommands: readonly ProviderNativeCommandDescriptor[];
  providerSkills: readonly ProviderSkillDescriptor[];
  workspaceEntries: readonly ProjectEntry[];
  searchableModelOptions: readonly SearchableModelOption[];
  supportsFastSlashCommand: boolean;
  canOfferCompactCommand: boolean;
  canOfferReviewCommand: boolean;
  canOfferForkCommand: boolean;
  canOfferSideCommand: boolean;
  canOfferExportCommand: boolean;
  surfaceAppSlashCommands?: ReadonlySet<string>;
  dynamicAgents: readonly ProviderAgentDescriptor[];
  threadMentionSources?: {
    readonly threads: readonly ComposerThreadMentionSource[];
    readonly projects: readonly Project[];
    readonly currentThreadId: string | null;
  };
}): ComposerCommandItem[] {
  const {
    composerTrigger,
    provider,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    workspaceEntries,
    searchableModelOptions,
    supportsFastSlashCommand,
    canOfferCompactCommand,
    canOfferReviewCommand,
    canOfferForkCommand,
    canOfferSideCommand,
    canOfferExportCommand,
    surfaceAppSlashCommands,
    dynamicAgents,
    threadMentionSources,
  } = input;

  if (!composerTrigger) return [];

  // Keep trigger-specific discovery outside ChatView so the view mostly orchestrates state.
  if (composerTrigger.kind === "mention") {
    const query = normalizeProviderDiscoveryText(composerTrigger.query);

    const agentItems: ComposerCommandItem[] = (() => {
      // Use dynamic agents when available, fallback to static
      if (dynamicAgents.length > 0) {
        return rankProviderDiscoveryItems(dynamicAgents, query, ({ name, displayName }) => [
          { value: name },
          { value: displayName },
        ]).map(({ name, displayName }) => ({
          id: `agent:${provider}:${name}`,
          type: "agent" as const,
          provider,
          alias: name,
          color: "violet" as const,
          label: `@${name}`,
          description: displayName,
        }));
      }
      // Static fallback
      return rankProviderDiscoveryItems(
        getAgentMentionAutocompleteAliases(provider),
        query,
        ({ alias, displayName }) => [{ value: alias }, { value: displayName }],
      ).map(({ alias, displayName, color }) => ({
        id: `agent:${provider}:${alias}`,
        type: "agent" as const,
        provider,
        alias,
        color,
        label: `@${alias}`,
        description: displayName,
      }));
    })();

    const pluginItems = rankProviderDiscoveryItems(
      providerPlugins.filter(({ plugin }) => isInstalledProviderPlugin(plugin)),
      query,
      ({ plugin }) => buildPluginSearchFields(plugin),
    ).map(({ plugin, mention }) => ({
      id: `plugin:${plugin.id}`,
      type: "plugin" as const,
      plugin,
      mention,
      label: plugin.interface?.displayName ?? plugin.name,
      description: plugin.interface?.shortDescription ?? plugin.source.path,
    }));
    const localRootItems =
      matchesLocalFolderMentionShortcut(composerTrigger.query) && composerTrigger.query !== "/"
        ? [
            {
              id: "local-root",
              type: "local-root" as const,
              label: `@${LOCAL_FOLDER_MENTION_NAME}`,
              description: "Browse folders on this computer",
            },
          ]
        : [];
    const pathItems = workspaceEntries.map((entry) => ({
      id: `path:${entry.kind}:${entry.path}`,
      type: "path" as const,
      path: entry.path,
      pathKind: entry.kind,
      label: basenameOfPath(entry.path),
      description: entry.parentPath ?? "",
    }));
    const threadItems = threadMentionSources
      ? buildThreadMentionComposerItems({
          ...threadMentionSources,
          query: composerTrigger.query,
        })
      : [];
    // Keep mention suggestions ordered by primary intent: plugins and chats
    // first, then local context, then subagent delegation targets.
    return [...pluginItems, ...threadItems, ...localRootItems, ...pathItems, ...agentItems];
  }

  if (composerTrigger.kind === "slash-command") {
    const query = normalizeProviderDiscoveryText(composerTrigger.query);
    const availableCommands = getAvailableComposerSlashCommands({
      provider,
      supportsFastSlashCommand,
      canOfferCompactCommand,
      canOfferReviewCommand,
      canOfferForkCommand,
      canOfferSideCommand,
      canOfferExportCommand,
      providerNativeCommandNames: providerNativeCommands.map((command) => command.name),
    });
    const visibleAppCommands = surfaceAppSlashCommands
      ? availableCommands.filter((command) => surfaceAppSlashCommands.has(command))
      : availableCommands;
    const visibleAppCommandSet = new Set(visibleAppCommands);
    const builtInItems = filterComposerSlashCommands(composerTrigger.query, visibleAppCommands).map(
      (definition) => ({
        id: `slash:${definition.command}`,
        type: "slash-command" as const,
        command: definition.command,
        label: definition.label,
        description: definition.description,
        source: definition.source,
      }),
    );
    const providerCommandItems = providerNativeCommands
      .filter(
        (command) =>
          !shouldHideProviderNativeCommandFromComposerMenu(provider, command.name, {
            availableAppCommands: visibleAppCommandSet,
          }),
      )
      .map((command) => ({
        command,
        aliasFields: getProviderNativeSlashCommandSearchTerms(provider, command.name).map(
          (term) => ({
            value: term,
          }),
        ),
      }));
    const rankedProviderCommandItems = rankProviderDiscoveryItems(
      providerCommandItems,
      query,
      ({ command, aliasFields }) => [...aliasFields, ...buildCommandSearchFields(command)],
    ).map(({ command }) => ({
      id: `provider-command:${provider}:${command.name}`,
      type: "provider-native-command" as const,
      provider,
      command: command.name,
      label: `/${command.name}`,
      description: command.description ?? `Run ${provider} native command`,
    }));
    // `/` is the universal picker surface; provider dispatch can adapt the
    // visible slash token to backend-specific skill syntax when needed.
    const skillItems: ComposerCommandItem[] = rankProviderDiscoveryItems(
      providerSkills,
      query,
      buildSkillSearchFields,
    ).map((skill) => ({
      id: `skill:${skill.path}`,
      type: "skill" as const,
      skill,
      label: skill.interface?.displayName ?? skill.name,
      description: skill.interface?.shortDescription ?? skill.description ?? skill.path,
    }));
    return [...builtInItems, ...rankedProviderCommandItems, ...skillItems];
  }

  if (composerTrigger.kind === "skill") {
    const query = normalizeProviderDiscoveryText(composerTrigger.query);
    return rankProviderDiscoveryItems(providerSkills, query, buildSkillSearchFields).map(
      (skill) => ({
        id: `skill:${skill.path}`,
        type: "skill" as const,
        skill,
        label: skill.interface?.displayName ?? skill.name,
        description: skill.interface?.shortDescription ?? skill.description ?? skill.path,
      }),
    );
  }

  return rankProviderDiscoveryItems(searchableModelOptions, composerTrigger.query, (option) => [
    { value: option.name },
    { value: option.slug },
    { value: option.searchName },
    { value: option.searchSlug },
    { value: option.providerLabel, weight: 200 },
    { value: option.searchProvider, weight: 200 },
    { value: option.searchUpstreamProvider, weight: 200 },
  ]).map(({ provider, providerLabel, slug, name }) => ({
    id: `model:${provider}:${slug}`,
    type: "model" as const,
    provider,
    model: slug,
    label: name,
    description: `${providerLabel} · ${slug}`,
  }));
}
