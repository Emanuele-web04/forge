// FILE: PluginLibrary.tsx
// Purpose: Hosts the plugin and skill browser surfaced from provider discovery APIs.
// Layer: Route-level screen
// Exports: PluginLibrary

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import React, { useMemo, type ReactNode, useDeferredValue, useState } from "react";
import type { IconType } from "react-icons";
import {
  SiCanva,
  SiFigma,
  SiGithub,
  SiGmail,
  SiGooglecalendar,
  SiGoogledrive,
  SiHuggingface,
  SiLinear,
  SiNotion,
  SiSlack,
  SiStripe,
  SiVercel,
} from "react-icons/si";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "./ProviderIcon";
import { useStore } from "~/store";
import { DEFAULT_PROVIDER_ORDER } from "~/providerOrdering";
import {
  buildPluginSearchFields,
  buildSkillSearchFields,
  isInstalledProviderPlugin,
  normalizeProviderDiscoveryText,
  rankProviderDiscoveryItems,
  resolveProviderDiscoveryCwd,
} from "~/lib/providerDiscovery";
import { createFirstProjectSelector } from "~/storeSelectors";
import {
  providerComposerCapabilitiesQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
} from "~/lib/providerDiscoveryReactQuery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useFocusedChatContext } from "~/focusedChatContext";
import {
  CheckIcon,
  CircleAlertIcon,
  HammerIcon,
  ListChecksIcon,
  PluginIcon,
  SearchIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "./ui/input-group";
import { SidebarInset } from "./ui/sidebar";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { Skeleton } from "./ui/skeleton";

// ── Types ──────────────────────────────────────────────────────────────────

type DiscoveryTab = "plugins" | "skills";
type ProviderCapabilities = { plugins: boolean; skills: boolean };
type PluginEntry = {
  marketplaceName: string;
  marketplacePath: string;
  plugin: ProviderPluginDescriptor;
  isFeatured: boolean;
};
type PluginBrandArtwork = {
  color: string;
  icon: IconType;
};

// ── Constants ──────────────────────────────────────────────────────────────

const PROVIDER_ICON: Record<ProviderKind, React.FC<React.SVGProps<SVGSVGElement>>> = {
  ...PROVIDER_ICON_COMPONENT_BY_PROVIDER,
  codex: HammerIcon,
};
const KNOWN_PLUGIN_BRANDS: Record<string, PluginBrandArtwork> = {
  canva: { icon: SiCanva, color: "#00C4CC" },
  figma: { icon: SiFigma, color: "#F24E1E" },
  github: { icon: SiGithub, color: "#181717" },
  gmail: { icon: SiGmail, color: "#EA4335" },
  googlecalendar: { icon: SiGooglecalendar, color: "#4285F4" },
  googledrive: { icon: SiGoogledrive, color: "#0F9D58" },
  huggingface: { icon: SiHuggingface, color: "#FF9D00" },
  linear: { icon: SiLinear, color: "#5E6AD2" },
  notion: { icon: SiNotion, color: "#111111" },
  slack: { icon: SiSlack, color: "#4A154B" },
  stripe: { icon: SiStripe, color: "#635BFF" },
  vercel: { icon: SiVercel, color: "#111111" },
};

// ── Utilities ──────────────────────────────────────────────────────────────

function pluginEntryKey(entry: Pick<PluginEntry, "marketplacePath" | "plugin">): string {
  return `${entry.marketplacePath}::${entry.plugin.name}`;
}

function sectionTitle(value: string): string {
  const n = value.trim();
  return n.length === 0 ? "Unknown" : n;
}

function resolvePluginAccent(plugin: ProviderPluginDescriptor): string | undefined {
  return plugin.interface?.brandColor?.trim() || undefined;
}

function normalizeBrandKey(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolvePluginLogo(plugin: ProviderPluginDescriptor): string | undefined {
  return plugin.interface?.logo?.trim() || undefined;
}

function resolvePluginBrand(plugin: ProviderPluginDescriptor): PluginBrandArtwork | undefined {
  const candidates = [
    plugin.interface?.composerIcon,
    plugin.interface?.displayName,
    plugin.name,
  ].map(normalizeBrandKey);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const knownBrand = KNOWN_PLUGIN_BRANDS[candidate];
    if (knownBrand) return knownBrand;
  }

  return undefined;
}

/** Stable hue 0–359 from a string, for consistent per-item icon colors. */
function nameToHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = name.charCodeAt(i) + ((h << 5) - h);
  }
  return Math.abs(h) % 360;
}

// ── Icon glyphs ────────────────────────────────────────────────────────────

function PluginGlyph({ plugin }: { plugin: ProviderPluginDescriptor }) {
  const accent = resolvePluginAccent(plugin);
  const logo = resolvePluginLogo(plugin);
  const brand = resolvePluginBrand(plugin);
  const hue = nameToHue(plugin.interface?.displayName ?? plugin.name);
  const [logoFailed, setLogoFailed] = useState(false);
  const style = accent
    ? {
        background: `linear-gradient(145deg, ${accent}cc, ${accent}77)`,
        boxShadow: `0 0 0 0.5px ${accent}35`,
      }
    : {
        background: `linear-gradient(145deg, hsl(${hue} 55% 30%), hsl(${hue} 45% 18%))`,
        boxShadow: `0 0 0 0.5px hsl(${hue} 40% 30% / 0.35)`,
      };

  // Prefer metadata-provided artwork so marketplace plugins keep their own branding.
  if (logo && !logoFailed) {
    return (
      <span
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-border/60 bg-background"
        style={accent ? { boxShadow: `0 0 0 0.5px ${accent}25` } : undefined}
      >
        <img
          src={logo}
          alt=""
          className="size-6 object-contain"
          loading="lazy"
          onError={() => setLogoFailed(true)}
        />
      </span>
    );
  }

  if (brand) {
    const BrandIcon = brand.icon;
    return (
      <span
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-border/60 bg-background"
        style={accent ? { boxShadow: `0 0 0 0.5px ${accent}25` } : undefined}
      >
        <BrandIcon className="size-5" style={{ color: brand.color }} />
      </span>
    );
  }

  return (
    <span
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px]"
      style={style}
    >
      <PluginIcon className="size-5 text-white/80" />
    </span>
  );
}

function SkillGlyph({ skill }: { skill: ProviderSkillDescriptor }) {
  const hue = nameToHue(skill.interface?.displayName ?? skill.name);
  return (
    <span
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px]"
      style={{
        background: `linear-gradient(145deg, hsl(${hue} 55% 30%), hsl(${hue} 45% 18%))`,
        boxShadow: `0 0 0 0.5px hsl(${hue} 40% 30% / 0.35)`,
      }}
    >
      <ListChecksIcon className="size-5 text-white/80" />
    </span>
  );
}

// ── UI controls ────────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-10 items-center border-b-2 px-1 text-[13px] font-medium transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground/80",
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ProviderToggleButton({
  label,
  active,
  disabled,
  onClick,
  provider,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  provider: ProviderKind;
}) {
  const Icon = PROVIDER_ICON[provider] ?? HammerIcon;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors",
        active
          ? "bg-[var(--color-text-foreground)] text-[var(--color-background-surface)] shadow-xs"
          : "text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground",
        disabled && "pointer-events-none opacity-35",
      )}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      <Icon className="size-3.5 shrink-0" />
      {label}
    </button>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border/60 bg-background/40 px-5 py-6 text-center">
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function InlineWarning({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/6 px-3 py-2.5 text-xs text-muted-foreground">
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div>{children}</div>
    </div>
  );
}

function InstalledStatus({ installed }: { installed: boolean }) {
  if (!installed) return null;
  return (
    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/40 text-muted-foreground/60">
      <CheckIcon className="size-3.5" />
    </span>
  );
}

// ── Grid items ─────────────────────────────────────────────────────────────

function PluginGridItem({ entry }: { entry: PluginEntry }) {
  const description =
    entry.plugin.interface?.shortDescription ??
    entry.plugin.interface?.longDescription ??
    entry.plugin.source.path;

  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-[var(--sidebar-accent)]">
      <PluginGlyph plugin={entry.plugin} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-snug text-foreground">
          {entry.plugin.interface?.displayName ?? entry.plugin.name}
        </p>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
      </div>
      <InstalledStatus installed={isInstalledProviderPlugin(entry.plugin)} />
    </div>
  );
}

function SkillGridItem({ skill }: { skill: ProviderSkillDescriptor }) {
  const description =
    skill.interface?.shortDescription ?? skill.description ?? "No description available.";

  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-[var(--sidebar-accent)]">
      <SkillGlyph skill={skill} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-snug text-foreground">
          {skill.interface?.displayName ?? skill.name}
        </p>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
      </div>
      <InstalledStatus installed={skill.enabled} />
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <h2 className="px-3 pb-1 pt-2 text-[15px] font-semibold text-foreground">{title}</h2>;
}

// ── Main component ─────────────────────────────────────────────────────────

export function PluginLibrary() {
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const firstProject = useStore(useMemo(() => createFirstProjectSelector(), []));
  const { activeProject: focusedProject, activeThread, focusedThreadId } = useFocusedChatContext();
  const activeProject = focusedProject ?? firstProject ?? null;

  const preferredProvider =
    activeThread?.modelSelection.provider ??
    activeProject?.defaultModelSelection?.provider ??
    "codex";

  const [selectedProvider, setSelectedProvider] = useState<ProviderKind>(preferredProvider);
  const [selectedTab, setSelectedTab] = useState<DiscoveryTab>("plugins");
  const [pluginSearch, setPluginSearch] = useState("");
  const [skillSearch, setSkillSearch] = useState("");
  const deferredPluginSearch = useDeferredValue(pluginSearch);
  const deferredSkillSearch = useDeferredValue(skillSearch);
  const providerThreadId = focusedThreadId;

  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const codexCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("codex"));
  const claudeCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("claudeAgent"));
  const cursorCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("cursor"));
  const antigravityCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions("antigravity"),
  );
  const grokCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("grok"));
  const droidCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("droid"));
  const kiloCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("kilo"));
  const openCodeCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("opencode"));
  const piCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("pi"));

  const providerCapabilities: Record<ProviderKind, ProviderCapabilities> = {
    codex: {
      plugins: supportsPluginDiscovery(codexCapabilitiesQuery.data),
      skills: supportsSkillDiscovery(codexCapabilitiesQuery.data),
    },
    claudeAgent: {
      plugins: supportsPluginDiscovery(claudeCapabilitiesQuery.data),
      skills: supportsSkillDiscovery(claudeCapabilitiesQuery.data),
    },
    cursor: {
      plugins: supportsPluginDiscovery(cursorCapabilitiesQuery.data),
      skills: supportsSkillDiscovery(cursorCapabilitiesQuery.data),
    },
    antigravity: {
      plugins: supportsPluginDiscovery(antigravityCapabilitiesQuery.data),
      skills: supportsSkillDiscovery(antigravityCapabilitiesQuery.data),
    },
    grok: {
      plugins: supportsPluginDiscovery(grokCapabilitiesQuery.data),
      skills: supportsSkillDiscovery(grokCapabilitiesQuery.data),
    },
    deepseek: { plugins: false, skills: false },
    droid: {
      plugins: supportsPluginDiscovery(droidCapabilitiesQuery.data),
      skills: supportsSkillDiscovery(droidCapabilitiesQuery.data),
    },
    kilo: {
      plugins: supportsPluginDiscovery(kiloCapabilitiesQuery.data),
      skills: supportsSkillDiscovery(kiloCapabilitiesQuery.data),
    },
    opencode: {
      plugins: supportsPluginDiscovery(openCodeCapabilitiesQuery.data),
      skills: supportsSkillDiscovery(openCodeCapabilitiesQuery.data),
    },
    pi: {
      plugins: supportsPluginDiscovery(piCapabilitiesQuery.data),
      skills: supportsSkillDiscovery(piCapabilitiesQuery.data),
    },
  };

  // Auto-fallback: when the current tab/provider combo is unsupported, render
  // the first capable provider. Derived (not synced into state) so switching
  // tabs never renders an unsupported frame, and the user's own selection
  // resurfaces if its provider becomes capable again.
  const supportsSelectedTab =
    selectedTab === "plugins"
      ? providerCapabilities[selectedProvider].plugins
      : providerCapabilities[selectedProvider].skills;
  const providerFallbackOrder =
    selectedTab === "plugins"
      ? DEFAULT_PROVIDER_ORDER
      : [preferredProvider, ...DEFAULT_PROVIDER_ORDER.filter((p) => p !== preferredProvider)];
  const effectiveProvider = supportsSelectedTab
    ? selectedProvider
    : (providerFallbackOrder.find((provider) =>
        selectedTab === "plugins"
          ? providerCapabilities[provider].plugins
          : providerCapabilities[provider].skills,
      ) ?? selectedProvider);

  const discoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: activeThread?.worktreePath ?? null,
    activeProjectCwd: activeProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });

  const providerLabel = PROVIDER_DISPLAY_NAMES[effectiveProvider];
  const canListPlugins = providerCapabilities[effectiveProvider].plugins;
  const canListSkills = providerCapabilities[effectiveProvider].skills;

  const pluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: effectiveProvider,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      enabled: selectedTab === "plugins" && canListPlugins,
    }),
  );

  const skillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: effectiveProvider,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      enabled: selectedTab === "skills" && canListSkills && discoveryCwd !== null,
    }),
  );

  const discoveredSkills = skillsQuery.data?.skills ?? [];

  const featuredPluginIds = new Set(pluginsQuery.data?.featuredPluginIds ?? []);
  const pluginEntries: PluginEntry[] = (pluginsQuery.data?.marketplaces ?? []).flatMap((m) =>
    m.plugins.map((plugin) => ({
      marketplaceName: m.name,
      marketplacePath: m.path,
      plugin,
      isFeatured: featuredPluginIds.has(plugin.id),
    })),
  );

  const installedPluginEntries = pluginEntries.filter((entry) =>
    isInstalledProviderPlugin(entry.plugin),
  );

  const pluginSearchQuery = normalizeProviderDiscoveryText(deferredPluginSearch);
  const filteredPluginEntries = pluginSearchQuery
    ? rankProviderDiscoveryItems(installedPluginEntries, pluginSearchQuery, (entry) =>
        buildPluginSearchFields(entry.plugin),
      )
    : installedPluginEntries;

  const marketplaceSectionsByPath = new Map<string, { title: string; entries: PluginEntry[] }>();
  for (const entry of filteredPluginEntries) {
    const existing = marketplaceSectionsByPath.get(entry.marketplacePath);
    if (existing) {
      existing.entries.push(entry);
    } else {
      marketplaceSectionsByPath.set(entry.marketplacePath, {
        title: sectionTitle(entry.marketplaceName),
        entries: [entry],
      });
    }
  }
  const marketplaceSections = Array.from(marketplaceSectionsByPath.entries()).map(([key, v]) => ({
    key,
    title: v.title,
    entries: v.entries,
  }));

  const skillSearchQuery = normalizeProviderDiscoveryText(deferredSkillSearch);
  const filteredSkills = skillSearchQuery
    ? rankProviderDiscoveryItems(discoveredSkills, skillSearchQuery, buildSkillSearchFields)
    : discoveredSkills;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden isolate">
      <div className="flex h-full flex-col">
        {/* ── Top nav ───────────────────────────────────────────────────── */}
        <div
          className={cn(
            "drag-region flex shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6",
            desktopTopBarTrafficLightGutterClassName,
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <SidebarHeaderNavigationControls />
          <div className="flex items-end gap-3">
            <TabButton
              label="Plugins"
              active={selectedTab === "plugins"}
              onClick={() => setSelectedTab("plugins")}
            />
            <TabButton
              label="Skills"
              active={selectedTab === "skills"}
              onClick={() => setSelectedTab("skills")}
            />
          </div>
          <div className="flex-1" />
          <div className="inline-flex rounded-full border border-border/60 bg-background/60 p-0.5">
            {DEFAULT_PROVIDER_ORDER.map((provider) => {
              const capabilities = providerCapabilities[provider];
              const label = PROVIDER_DISPLAY_NAMES[provider];
              return (
                <ProviderToggleButton
                  key={provider}
                  label={label}
                  provider={provider}
                  active={effectiveProvider === provider}
                  disabled={!capabilities.plugins && !capabilities.skills}
                  onClick={() => {
                    setSelectedProvider(provider);
                    if (selectedTab === "plugins" && !capabilities.plugins && capabilities.skills) {
                      setSelectedTab("skills");
                    }
                    if (selectedTab === "skills" && !capabilities.skills && capabilities.plugins) {
                      setSelectedTab("plugins");
                    }
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* ── Scrollable body ───────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Hero */}
          <div className="px-6 py-10 text-center">
            <h1 className="text-[28px] font-semibold text-foreground">
              Make {providerLabel} work your way
            </h1>
          </div>

          {/* Search */}
          <div className="mx-auto max-w-2xl px-6 pb-6">
            <InputGroup className="rounded-xl bg-background/70 shadow-xs">
              <InputGroupAddon>
                <InputGroupText>
                  <SearchIcon className="size-4 text-muted-foreground/60" />
                </InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                value={selectedTab === "plugins" ? pluginSearch : skillSearch}
                onChange={(e) => {
                  if (selectedTab === "plugins") setPluginSearch(e.target.value);
                  else setSkillSearch(e.target.value);
                }}
                placeholder={selectedTab === "plugins" ? "Search plugins" : "Search skills"}
                className="text-sm"
              />
            </InputGroup>
          </div>

          {/* Warnings */}
          {((!discoveryCwd && selectedTab === "skills") ||
            (selectedTab === "plugins" && !!pluginsQuery.data?.remoteSyncError) ||
            (selectedTab === "plugins" &&
              (pluginsQuery.data?.marketplaceLoadErrors.length ?? 0) > 0)) && (
            <div className="mx-auto max-w-2xl space-y-1.5 px-6 pb-4">
              {!discoveryCwd && selectedTab === "skills" ? (
                <InlineWarning>
                  Skills need a workspace path. Open a project or thread first.
                </InlineWarning>
              ) : null}
              {selectedTab === "plugins" && pluginsQuery.data?.remoteSyncError ? (
                <InlineWarning>{pluginsQuery.data.remoteSyncError}</InlineWarning>
              ) : null}
              {selectedTab === "plugins" &&
              (pluginsQuery.data?.marketplaceLoadErrors.length ?? 0) > 0 ? (
                <InlineWarning>
                  {pluginsQuery.data?.marketplaceLoadErrors
                    .map((err) => `${sectionTitle(err.marketplacePath)}: ${err.message}`)
                    .join(" • ")}
                </InlineWarning>
              ) : null}
            </div>
          )}

          {/* Grid content */}
          <div className="px-3 pb-10 sm:px-5">
            {selectedTab === "plugins" ? (
              <>
                {!canListPlugins ? (
                  <div className="mx-auto max-w-2xl">
                    <EmptyPanel
                      title={`Plugins unavailable for ${providerLabel}`}
                      description="This provider does not expose plugin discovery."
                    />
                  </div>
                ) : pluginsQuery.isLoading && pluginEntries.length === 0 ? (
                  <div className="space-y-1">
                    {["1", "2", "3", "4", "5", "6"].map((k) => (
                      <Skeleton key={k} className="h-[68px] w-full rounded-xl" />
                    ))}
                  </div>
                ) : filteredPluginEntries.length === 0 ? (
                  <EmptyPanel
                    title="No installed plugins found"
                    description="This view only shows plugins already available in your Codex setup."
                  />
                ) : (
                  <div className="space-y-6">
                    {marketplaceSections.map((section) => (
                      <div key={section.key}>
                        <SectionHeader title={section.title} />
                        <div className="grid grid-cols-1 sm:grid-cols-2">
                          {section.entries.map((entry) => (
                            <PluginGridItem key={pluginEntryKey(entry)} entry={entry} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                {!canListSkills ? (
                  <div className="mx-auto max-w-2xl">
                    <EmptyPanel
                      title={`Skills unavailable for ${providerLabel}`}
                      description="This provider does not expose skill discovery."
                    />
                  </div>
                ) : skillsQuery.isLoading && discoveredSkills.length === 0 ? (
                  <div className="space-y-1">
                    {["1", "2", "3", "4", "5", "6"].map((k) => (
                      <Skeleton key={k} className="h-[68px] w-full rounded-xl" />
                    ))}
                  </div>
                ) : filteredSkills.length === 0 ? (
                  <EmptyPanel title="No skills found" description="No skills match this search." />
                ) : (
                  <div>
                    <SectionHeader title="Skills" />
                    <div className="grid grid-cols-1 sm:grid-cols-2">
                      {filteredSkills.map((skill) => (
                        <SkillGridItem key={skill.path} skill={skill} />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
