// FILE: settingsNavigation.ts
// Purpose: Share the settings topic taxonomy between the main sidebar and the settings screen.
// Layer: Route/UI support
// Exports: section ids, nav items, and search normalization helper

export const SETTINGS_SECTION_IDS = [
  "general",
  "profile",
  "appearance",
  "notifications",
  "behavior",
  "appsnap",
  "shortcuts",
  "worktrees",
  "archived",
  "models",
  "providers",
  "skills",
  "usage",
  "integrations",
  "advanced",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];
export type SettingsNavGroupId = "app" | "synara";

/**
 * Deep-link scroll targets inside settings panels. Each id is shared by its DOM owner and callers
 * that navigate with `?target=…`; the settings route resolves every target after the active panel
 * mounts.
 */
export const SETTINGS_TARGETS = {
  providerUpdates: "provider-updates",
  environmentPanel: "environment-panel",
} as const;

export type SettingsNavItem = {
  id: SettingsSectionId;
  group: SettingsNavGroupId;
  label: string;
  description: string;
  /** Basename of a SVG under `/central-icons-reversed`. */
  icon: string;
  eyebrow: string;
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: SettingsNavGroupId;
  label: string;
}> = [
  { id: "app", label: "App" },
  { id: "synara", label: "Synara" },
] as const;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    id: "general",
    group: "app",
    label: "General",
    description: "Default provider, thread mode, and sidebar organization.",
    icon: "settings-gear-4",
    eyebrow: "Workflow defaults",
  },
  {
    id: "profile",
    group: "app",
    label: "Profile",
    description: "Your local activity, streaks, and a shareable stats card.",
    icon: "user",
    eyebrow: "Your stats",
  },
  {
    id: "appearance",
    group: "app",
    label: "Appearance",
    description: "Theme, typography, and timestamp formatting.",
    icon: "color-palette",
    eyebrow: "Visual language",
  },
  {
    id: "notifications",
    group: "app",
    label: "Notifications",
    description: "In-app toasts and desktop alerts.",
    icon: "bell",
    eyebrow: "Alerts",
  },
  {
    id: "behavior",
    group: "app",
    label: "Behavior",
    description: "Follow-ups, streaming, diff handling, and destructive confirmations.",
    icon: "settings-slider-hor",
    eyebrow: "Interaction rules",
  },
  {
    id: "appsnap",
    group: "app",
    label: "AppSnap",
    description: "Snap another app's window straight into a task with one key chord.",
    icon: "screen-capture",
    eyebrow: "Screen capture",
  },
  {
    id: "shortcuts",
    group: "app",
    label: "Keyboard Shortcuts",
    description: "Every keyboard shortcut available in Synara, grouped by context.",
    icon: "shortcut",
    eyebrow: "Key bindings",
  },
  {
    id: "worktrees",
    group: "app",
    label: "Worktrees",
    description: "Review and clean up the worktrees created by Synara.",
    icon: "branch-simple",
    eyebrow: "Workspace management",
  },
  {
    id: "archived",
    group: "app",
    label: "Archived",
    description: "View and restore archived threads.",
    icon: "archive",
    eyebrow: "Thread management",
  },
  {
    id: "models",
    group: "synara",
    label: "Models",
    description: "Git writing defaults and custom model slugs.",
    icon: "brain",
    eyebrow: "AI configuration",
  },
  {
    id: "providers",
    group: "synara",
    label: "Providers",
    description: "Choose visible providers, review CLI installs, and update provider tools.",
    icon: "puzzle",
    eyebrow: "Picker visibility",
  },
  {
    id: "skills",
    group: "synara",
    label: "Skills",
    description: "Every skill found across providers, with toggles to control availability.",
    icon: "building-blocks",
    eyebrow: "Agent skills",
  },
  {
    id: "usage",
    group: "synara",
    label: "Usage",
    description: "Remaining quota and credits for each signed-in provider.",
    icon: "gauge",
    eyebrow: "Limits & credits",
  },
  {
    id: "integrations",
    group: "synara",
    label: "Integrations",
    description: "Pair local MCP clients with scoped, revocable access to Synara tasks.",
    icon: "plugin-1",
    eyebrow: "External MCP",
  },
  {
    id: "advanced",
    group: "synara",
    label: "Advanced",
    description: "Keybindings, recovery, and version info.",
    icon: "toolbox",
    eyebrow: "System tools",
  },
] as const;

/**
 * Stable DOM id for a settings row, derived from its (string) title. Shared by the row that
 * renders the anchor and by the search index that deep-links to it via `?target=…`, so the
 * two can't drift. Panels stay mounted and render null while inactive, so the slug only needs
 * to be unique within a section.
 */
export function settingRowAnchorId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `setting-${slug}`;
}

export function normalizeSettingsSection(value: unknown): SettingsSectionId {
  if (typeof value !== "string") {
    return "general";
  }
  return SETTINGS_SECTION_IDS.find((candidate) => candidate === value) ?? "general";
}
