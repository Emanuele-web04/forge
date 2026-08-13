// FILE: skillsSettingsModel.ts
// Purpose: Groups duplicate skill copies for Settings -> Skills so shared names render once.
// Layer: Settings UI logic
// Exports: origin metadata, canonical skill grouping, and section ordering helpers.

import type { ProviderKind, ProviderSkillDescriptor } from "@synara/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { DEFAULT_PROVIDER_ORDER } from "~/providerOrdering";

export interface SkillOriginInfo {
  readonly label: string;
  readonly provider: ProviderKind | null;
}

export interface SettingsSkillSource {
  readonly skill: ProviderSkillDescriptor;
  readonly origin: string;
  readonly originInfo: SkillOriginInfo;
}

export interface SettingsSkillGroup {
  readonly key: string;
  readonly displayName: string;
  readonly description: string;
  readonly primarySkill: ProviderSkillDescriptor;
  readonly providers: ReadonlyArray<ProviderKind>;
  readonly sources: ReadonlyArray<SettingsSkillSource>;
  readonly section: string;
}

export interface SettingsSkillSection {
  readonly key: string;
  readonly title: string;
  readonly groups: ReadonlyArray<SettingsSkillGroup>;
}

const SHARED_SKILLS_SECTION = "shared";
const PERSONAL_ORIGIN = "personal";
export const ORIGIN_SECTION_ORDER = [
  "synara",
  "codex",
  "claude",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
  "agents",
  "project",
] as const;
export function skillOriginInfo(scope: string | undefined): SkillOriginInfo {
  switch (scope) {
    case "synara":
      return { label: "Synara", provider: null };
    case "codex":
      return { label: PROVIDER_DISPLAY_NAMES.codex, provider: "codex" };
    case "claude":
      return { label: PROVIDER_DISPLAY_NAMES.claudeAgent, provider: "claudeAgent" };
    case "cursor":
      return { label: PROVIDER_DISPLAY_NAMES.cursor, provider: "cursor" };
    case "antigravity":
      return { label: PROVIDER_DISPLAY_NAMES.antigravity, provider: "antigravity" };
    case "grok":
      return { label: PROVIDER_DISPLAY_NAMES.grok, provider: "grok" };
    case "droid":
      return { label: PROVIDER_DISPLAY_NAMES.droid, provider: "droid" };
    case "kilo":
      return { label: PROVIDER_DISPLAY_NAMES.kilo, provider: "kilo" };
    case "opencode":
      return { label: PROVIDER_DISPLAY_NAMES.opencode, provider: "opencode" };
    case "pi":
      return { label: PROVIDER_DISPLAY_NAMES.pi, provider: "pi" };
    case "agents":
      return { label: "Shared (.agents)", provider: null };
    case "project":
      return { label: "Project", provider: null };
    default:
      return { label: scope ?? "Personal", provider: null };
  }
}

export function providersForSkillOrigin(origin: string): ProviderKind[] {
  const provider = skillOriginInfo(origin).provider;
  return provider ? [provider] : [];
}

export function settingsSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function skillDisplayName(skill: ProviderSkillDescriptor): string {
  return skill.interface?.displayName ?? skill.name;
}

export function providerDisplayName(provider: ProviderKind): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

export function sortProviderStack(providers: ReadonlyArray<ProviderKind>): ProviderKind[] {
  return providers.toSorted(
    (left, right) => DEFAULT_PROVIDER_ORDER.indexOf(left) - DEFAULT_PROVIDER_ORDER.indexOf(right),
  );
}

function originRank(origin: string): number {
  const index = (ORIGIN_SECTION_ORDER as readonly string[]).indexOf(origin);
  return index >= 0 ? index : ORIGIN_SECTION_ORDER.length;
}

function sourceSortKey(source: SettingsSkillSource): string {
  return `${originRank(source.origin).toString().padStart(2, "0")}\u0000${source.skill.path}`;
}

function sectionTitle(section: string): string {
  if (section === SHARED_SKILLS_SECTION) {
    return "Shared skills";
  }
  return `From ${skillOriginInfo(section).label}`;
}

function sectionRank(section: string): number {
  if (section === SHARED_SKILLS_SECTION) {
    return -1;
  }
  return originRank(section);
}

// Creates one canonical row per normalized skill name. Duplicate provider copies
// stay visible as sources instead of letting the first origin hide the rest.
export function buildSettingsSkillGroups(
  skills: ReadonlyArray<ProviderSkillDescriptor>,
): SettingsSkillGroup[] {
  const groups = new Map<string, SettingsSkillSource[]>();
  for (const skill of skills) {
    const key = settingsSkillNameKey(skill.name);
    const origin = skill.scope ?? PERSONAL_ORIGIN;
    const source: SettingsSkillSource = {
      skill,
      origin,
      originInfo: skillOriginInfo(origin),
    };
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }

  return [...groups.entries()]
    .map(([key, unsortedSources]): SettingsSkillGroup | null => {
      const sources = unsortedSources.toSorted((left, right) =>
        sourceSortKey(left).localeCompare(sourceSortKey(right)),
      );
      const primarySkill = sources[0]?.skill;
      if (!primarySkill) {
        return null;
      }
      const providers = sortProviderStack(
        sources
          .flatMap((source) => providersForSkillOrigin(source.origin))
          .filter((provider, index, all) => all.indexOf(provider) === index),
      );
      const section =
        sources.length > 1 ? SHARED_SKILLS_SECTION : (sources[0]?.origin ?? PERSONAL_ORIGIN);
      const description =
        primarySkill.interface?.shortDescription ?? primarySkill.description ?? "No description.";
      return {
        key,
        displayName: skillDisplayName(primarySkill),
        description,
        primarySkill,
        providers,
        sources,
        section,
      } satisfies SettingsSkillGroup;
    })
    .filter((group): group is SettingsSkillGroup => group !== null)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function buildSettingsSkillSections(
  skills: ReadonlyArray<ProviderSkillDescriptor>,
): SettingsSkillSection[] {
  const sections = new Map<string, SettingsSkillGroup[]>();
  for (const group of buildSettingsSkillGroups(skills)) {
    sections.set(group.section, [...(sections.get(group.section) ?? []), group]);
  }

  return [...sections.entries()]
    .map(([key, groups]) => ({
      key,
      title: sectionTitle(key),
      groups,
    }))
    .sort((left, right) => sectionRank(left.key) - sectionRank(right.key));
}
