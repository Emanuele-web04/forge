// FILE: skillPromptInjection.ts
// Purpose: Inlines portable skill instructions into the outgoing prompt for providers
//          that cannot natively load the referenced skill files. This is the fallback
//          that makes Synara catalog skills usable on every provider.
// Layer: Server provider helper
// Exports: shouldInlineSkillForProvider, buildInlineSkillInstructions

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { ProviderKind, ProviderSkillReference } from "@synara/contracts";

// Per-skill cap keeps a single oversized SKILL.md from eating the turn budget.
const MAX_INLINE_SKILL_CONTENT_CHARS = 24_000;

const INLINE_SKILLS_HEADER =
  "The user invoked the following agent skill(s) for this request. Follow each " +
  "skill's instructions. File paths referenced inside a skill are relative to its " +
  '"dir" attribute.';

const CROSS_PROVIDER_SKILL_DIR_NAMES = [
  ".synara",
  ".codex",
  ".cursor",
  ".claude",
  ".agents",
] as const;

function pathSegments(path: string): Set<string> {
  return new Set(nodePath.normalize(path).split(/[\\/]+/));
}

export function shouldInlineSkillForProvider(provider: ProviderKind, skillPath: string): boolean {
  const segments = pathSegments(skillPath);
  switch (provider) {
    case "antigravity":
      return true;
    case "codex":
      // Codex injects structured skill items only from roots it knows: its own
      // folders plus `~/.synara/skills`, which Synara registers at session start
      // via skills/extraRoots/set. Skills resolved from other providers' folders
      // must be inlined.
      return [".claude", ".cursor", ".agents"].some((dir) => segments.has(dir));
    case "cursor":
      // cursor-agent natively scans .cursor/.agents/.claude/.codex skill roots;
      // only Synara-owned paths need inlining.
      return segments.has(".synara");
    case "claudeAgent":
      // Claude Code only loads skills from .claude/skills folders.
      return !segments.has(".claude");
    case "pi":
      // Pi loads its own skill set; anything resolved from a cross-provider
      // folder is portable and must be inlined.
      return CROSS_PROVIDER_SKILL_DIR_NAMES.some((dir) => segments.has(dir));
    default:
      // Antigravity/Grok/Droid/OpenCode have no native skill support.
      return true;
  }
}

export async function buildInlineSkillInstructions(input: {
  readonly provider: ProviderKind;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly maxChars: number;
}): Promise<string> {
  const inlineSkills = input.skills.filter((skill) =>
    shouldInlineSkillForProvider(input.provider, skill.path),
  );
  if (inlineSkills.length === 0 || input.maxChars <= 0) {
    return "";
  }

  let text = "";
  for (const skill of inlineSkills) {
    let content: string;
    try {
      content = await fs.readFile(skill.path, "utf8");
    } catch {
      continue;
    }
    let trimmed = content.trim();
    if (trimmed.length > MAX_INLINE_SKILL_CONTENT_CHARS) {
      trimmed = `${trimmed.slice(0, MAX_INLINE_SKILL_CONTENT_CHARS)}\n[skill content truncated]`;
    }
    const block = `<skill name=${JSON.stringify(skill.name)} dir=${JSON.stringify(
      nodePath.dirname(skill.path),
    )}>\n${trimmed}\n</skill>`;
    const candidate =
      text.length === 0 ? `${INLINE_SKILLS_HEADER}\n\n${block}` : `${text}\n\n${block}`;
    if (candidate.length > input.maxChars) {
      // Keep whatever already fits instead of overflowing the provider turn budget.
      break;
    }
    text = candidate;
  }
  return text;
}
