// FILE: composerSlashCommands.ts
// Purpose: Share Synara's built-in composer slash command names across web UI
//          parsing and server-side profile stats backfills.
// Layer: Shared runtime utility
// Exports: command-name constants and normalization helpers.

export const BUILT_IN_COMPOSER_SLASH_COMMANDS = [
  "clear",
  "compact",
  "model",
  "plan",
  "debug",
  "default",
  "review",
  "fork",
  "side",
  "status",
  "subagents",
  "fast",
  "export",
  "goal",
  "feedback",
  "automation",
] as const;

export type BuiltInComposerSlashCommand = (typeof BUILT_IN_COMPOSER_SLASH_COMMANDS)[number];

export function normalizeComposerSlashCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

export function isBuiltInComposerSlashCommandName(
  value: string,
): value is BuiltInComposerSlashCommand {
  const normalizedValue = normalizeComposerSlashCommandName(value);
  return BUILT_IN_COMPOSER_SLASH_COMMANDS.some((command) => command === normalizedValue);
}
