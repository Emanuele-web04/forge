// FILE: skillPromptInjection.test.ts
// Purpose: Verifies which providers receive inlined portable skill instructions
//          and that the inline text respects the turn character budget.
// Layer: Server provider tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildInlineSkillInstructions,
  shouldInlineSkillForProvider,
} from "./skillPromptInjection.ts";

const synaraSkillPath = "/Users/me/.synara/skills/reviewer/SKILL.md";
const codexSkillPath = "/Users/me/.codex/skills/reviewer/SKILL.md";
const claudeSkillPath = "/Users/me/.claude/skills/reviewer/SKILL.md";
const cursorSkillPath = "/Users/me/.cursor/skills/reviewer/SKILL.md";
const piSkillPath = "/Users/me/.pi/agent/skills/reviewer/SKILL.md";
const devinSkillPath = "/Users/me/.config/devin/skills/reviewer/SKILL.md";
const cognitionSkillPath = "/Users/me/.config/cognition/skills/reviewer/SKILL.md";
const agentsSkillPath = "/Users/me/.agents/skills/reviewer/SKILL.md";
const windsurfSkillPath = "/repo/.windsurf/skills/reviewer/SKILL.md";
const codeiumSkillPath = "/Users/me/.codeium/windsurf/skills/reviewer/SKILL.md";

describe("shouldInlineSkillForProvider", () => {
  it("skips codex-native and synara roots for codex but inlines foreign provider roots", () => {
    // Codex loads .codex roots natively and ~/.synara/skills via the extra
    // skill root registered at session start.
    expect(shouldInlineSkillForProvider("codex", synaraSkillPath)).toBe(false);
    expect(shouldInlineSkillForProvider("codex", codexSkillPath)).toBe(false);
    expect(shouldInlineSkillForProvider("codex", claudeSkillPath)).toBe(true);
    expect(shouldInlineSkillForProvider("codex", cursorSkillPath)).toBe(true);
  });

  it("inlines only Synara-owned paths for cursor", () => {
    expect(shouldInlineSkillForProvider("cursor", synaraSkillPath)).toBe(true);
    expect(shouldInlineSkillForProvider("cursor", cursorSkillPath)).toBe(false);
    expect(shouldInlineSkillForProvider("cursor", codexSkillPath)).toBe(false);
  });

  it("inlines everything except .claude paths for claudeAgent", () => {
    expect(shouldInlineSkillForProvider("claudeAgent", claudeSkillPath)).toBe(false);
    expect(shouldInlineSkillForProvider("claudeAgent", synaraSkillPath)).toBe(true);
    expect(shouldInlineSkillForProvider("claudeAgent", codexSkillPath)).toBe(true);
  });

  it("inlines cross-provider paths for pi but not pi-native skills", () => {
    expect(shouldInlineSkillForProvider("pi", synaraSkillPath)).toBe(true);
    expect(shouldInlineSkillForProvider("pi", claudeSkillPath)).toBe(true);
    expect(shouldInlineSkillForProvider("pi", piSkillPath)).toBe(false);
  });

  it("skips Devin-native skill roots and inlines foreign roots", () => {
    for (const nativePath of [
      devinSkillPath,
      cognitionSkillPath,
      agentsSkillPath,
      windsurfSkillPath,
      codeiumSkillPath,
      claudeSkillPath,
      "C:\\Users\\me\\AppData\\Roaming\\devin\\skills\\reviewer\\SKILL.md",
    ]) {
      expect(shouldInlineSkillForProvider("devin", nativePath)).toBe(false);
    }
    for (const foreignPath of [synaraSkillPath, codexSkillPath, cursorSkillPath, piSkillPath]) {
      expect(shouldInlineSkillForProvider("devin", foreignPath)).toBe(true);
    }
  });

  it("always inlines for providers without native skill support", () => {
    for (const provider of ["antigravity", "grok", "opencode"] as const) {
      expect(shouldInlineSkillForProvider(provider, synaraSkillPath)).toBe(true);
      expect(shouldInlineSkillForProvider(provider, claudeSkillPath)).toBe(true);
    }
  });
});

describe("buildInlineSkillInstructions", () => {
  it("inlines skill content for non-native providers and skips unreadable paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-inline-"));
    const skillDir = path.join(root, ".synara", "skills", "reviewer");
    try {
      await mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      await writeFile(skillPath, "# Reviewer\n\nAlways review carefully.");

      const text = await buildInlineSkillInstructions({
        provider: "antigravity",
        skills: [
          { name: "reviewer", path: skillPath },
          { name: "missing", path: path.join(root, ".synara", "skills", "missing", "SKILL.md") },
        ],
        maxChars: 10_000,
      });

      expect(text).toContain('<skill name="reviewer"');
      expect(text).toContain("Always review carefully.");
      expect(text).not.toContain("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty text when nothing fits in the budget", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-inline-budget-"));
    const skillDir = path.join(root, ".synara", "skills", "reviewer");
    try {
      await mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      await writeFile(skillPath, "content".repeat(100));

      const text = await buildInlineSkillInstructions({
        provider: "antigravity",
        skills: [{ name: "reviewer", path: skillPath }],
        maxChars: 50,
      });

      expect(text).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not inline synara-rooted skills for codex (covered by the extra skill root)", async () => {
    const text = await buildInlineSkillInstructions({
      provider: "codex",
      skills: [{ name: "reviewer", path: synaraSkillPath }],
      maxChars: 10_000,
    });
    expect(text).toBe("");
  });
});
