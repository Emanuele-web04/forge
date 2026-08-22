// FILE: slashCommandIcons.ts
// Purpose: Single source of truth mapping built-in slash commands to their glyph,
//          shared by the composer command menu, the Lexical inline chip, and the
//          read-only echo in sent messages so `/goal` looks the same everywhere.
// Layer: Web UI utility
// Exports: SLASH_COMMAND_ICONS, slashCommandIcon

import {
  BotIcon,
  BrainIcon,
  BugIcon,
  ClockIcon,
  EraserIcon,
  FastModeIcon,
  GitForkIcon,
  GoalIcon,
  InfoIcon,
  ListTodoIcon,
  type LucideIcon,
  MessageCircleIcon,
  Minimize2,
  TemporaryThreadIcon,
} from "./icons";

// Reuse the app's existing icon components for each concept so slash commands
// stay coherent with how plan/fork/review/model/etc. appear everywhere else.
// Don't introduce bespoke glyphs here — map to the shared `~/lib/icons` exports.
export const SLASH_COMMAND_ICONS: Record<string, LucideIcon> = {
  clear: EraserIcon,
  compact: Minimize2,
  model: BrainIcon,
  fast: FastModeIcon,
  plan: ListTodoIcon,
  debug: BugIcon,
  default: MessageCircleIcon,
  review: BugIcon,
  fork: GitForkIcon,
  side: TemporaryThreadIcon,
  status: InfoIcon,
  subagents: BotIcon,
  feedback: BugIcon,
  automation: ClockIcon,
  goal: GoalIcon,
};

/** Glyph for a slash command, falling back to `fallback` for unmapped commands. */
export function slashCommandIcon(command: string, fallback: LucideIcon): LucideIcon {
  return SLASH_COMMAND_ICONS[command] ?? fallback;
}
