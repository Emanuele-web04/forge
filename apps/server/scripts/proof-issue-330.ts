// FILE: proof-issue-330.ts
// Purpose: Strong before/after proof for #330 — dirty keybindings.json, issues before
//          startup sync, cleaned file + zero issues after.
// Run from apps/server:
//   bun scripts/proof-issue-330.ts
// Writes to repo .synara-pr-dilip/issue-330/

import * as NodeServices from "@effect/platform-node/NodeServices";
import { KeybindingsConfig } from "@synara/contracts";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as FS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ServerConfig } from "../src/config.ts";
import { Keybindings, KeybindingsLive } from "../src/keybindings.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT_DIR = NodePath.join(repoRoot, ".synara-pr-dilip/issue-330");

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);

const DIRTY_CONFIG = [
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+b", command: "rightPanel.toggle" },
  { key: "mod+shift+\\", command: "terminal.splitVertical" },
  { key: "mod+p", command: "preview.toggle" },
  { key: "mod+x", command: "invalid.command" },
] as const;

function formatIssues(
  issues: ReadonlyArray<{ kind: string; index?: number; message: string }>,
): string {
  if (issues.length === 0) return "  (none)";
  return issues
    .map((issue, i) => {
      const indexPart = typeof issue.index === "number" ? ` index=${issue.index}` : "";
      const firstLine = issue.message.split("\n")[0] ?? issue.message;
      return `  ${i + 1}. [${issue.kind}]${indexPart}\n     ${firstLine}`;
    })
    .join("\n");
}

function formatCommands(
  rules: ReadonlyArray<{ key?: string; command: string; shortcut?: { key: string } }>,
): string {
  if (rules.length === 0) return "  (none)";
  return rules
    .map((rule) => {
      const key = rule.key ?? (rule.shortcut ? `…+${rule.shortcut.key}` : "?");
      return `  - ${key} → ${rule.command}`;
    })
    .join("\n");
}

const makeKeybindingsLayer = () =>
  KeybindingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "synara-issue-330-proof-",
        }),
      ),
    ),
  );

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { keybindingsConfigPath } = yield* ServerConfig;
  const keybindings = yield* Keybindings;

  yield* fs.makeDirectory(path.dirname(keybindingsConfigPath), { recursive: true });
  const dirtyJson = `${JSON.stringify([...DIRTY_CONFIG], null, 2)}\n`;
  yield* fs.writeFileString(keybindingsConfigPath, dirtyJson);

  // ── BEFORE: load only (no startup rewrite) ─────────────────────────────
  const beforeRaw = yield* fs.readFileString(keybindingsConfigPath);
  const beforeState = yield* keybindings.loadConfigState;
  const beforeValidCommands = beforeState.keybindings
    .filter((entry) =>
      ["terminal.toggle", "browser.toggle", "terminal.split"].includes(entry.command),
    )
    .map((entry) => ({
      command: entry.command,
      shortcut: entry.shortcut,
    }));

  const beforeReport = [
    "══════════════════════════════════════════════════════════════",
    "  ISSUE #330 PROOF — BEFORE (dirty config, no startup rewrite)",
    "══════════════════════════════════════════════════════════════",
    "",
    "keybindings.json path:",
    `  ${keybindingsConfigPath}`,
    "",
    "FILE CONTENTS (on disk):",
    beforeRaw.trimEnd(),
    "",
    'ISSUES reported to UI (drives "Invalid keybindings configuration" toast):',
    `  count = ${beforeState.issues.length}`,
    formatIssues(beforeState.issues),
    "",
    "VALID COMMANDS active in runtime (invalid rows ignored but STILL ON DISK):",
    formatCommands(beforeValidCommands),
    "",
    "ON-DISK COMMANDS (unfiltered):",
    ...DIRTY_CONFIG.map((row) => `  - ${row.key} → ${row.command}`),
    "",
    "PROBLEM: Without rewrite, the next app launch reloads this same file and",
    "toasts again forever (old code skipped sync when issues.length > 0).",
    "",
  ].join("\n");

  // ── APPLY FIX PATH: startup sync rewrites cleaned config ───────────────
  yield* keybindings.syncDefaultKeybindingsOnStartup;

  // ── AFTER: load again ──────────────────────────────────────────────────
  const afterRaw = yield* fs.readFileString(keybindingsConfigPath);
  const afterState = yield* keybindings.loadConfigState;
  const afterPersisted = yield* Schema.decodeUnknownEffect(KeybindingsConfigJson)(afterRaw);

  const interestingCommands = new Set([
    "terminal.toggle",
    "browser.toggle",
    "terminal.split",
    "rightPanel.toggle",
    "terminal.splitVertical",
    "preview.toggle",
    "invalid.command",
  ]);
  const interesting = afterPersisted.filter((entry) =>
    interestingCommands.has(String(entry.command)),
  );

  const afterReport = [
    "══════════════════════════════════════════════════════════════",
    "  ISSUE #330 PROOF — AFTER (startup sync rewrite)",
    "══════════════════════════════════════════════════════════════",
    "",
    "keybindings.json path:",
    `  ${keybindingsConfigPath}`,
    "",
    "FILE CONTENTS (on disk after rewrite, first 80 lines / interesting only below):",
    afterRaw.trimEnd().split("\n").slice(0, 80).join("\n"),
    afterRaw.split("\n").length > 80 ? "  … (file continues with backfilled defaults)" : "",
    "",
    "ISSUES reported to UI:",
    `  count = ${afterState.issues.length}`,
    formatIssues(afterState.issues),
    "",
    "PERSISTED COMMANDS of interest:",
    formatCommands(
      interesting.map((entry) => ({
        key: entry.key,
        command: String(entry.command),
      })),
    ),
    "",
    "TRANSFORMATIONS:",
    "  rightPanel.toggle      → browser.toggle   (alias)",
    "  terminal.splitVertical → terminal.split   (alias)",
    "  preview.toggle         → DROPPED (retired)",
    "  invalid.command        → DROPPED (invalid)",
    "  terminal.toggle        → kept",
    "",
    "SECOND-LOAD CHECK (simulates next app launch):",
    `  issues.count = ${afterState.issues.length}  (must be 0 → no recurring toast)`,
    "",
    afterState.issues.length === 0
      ? "RESULT: PASS — cleaned config persists; toast source is gone."
      : "RESULT: FAIL — issues still present.",
    "",
  ].join("\n");

  const commandOf = (entry: { command: unknown }) => String(entry.command);
  const flags = {
    terminalToggle: afterPersisted.some((e) => commandOf(e) === "terminal.toggle"),
    browserToggle: afterPersisted.some((e) => commandOf(e) === "browser.toggle"),
    terminalSplit: afterPersisted.some((e) => commandOf(e) === "terminal.split"),
    rightPanel: afterPersisted.some((e) => commandOf(e) === "rightPanel.toggle"),
    splitVertical: afterPersisted.some((e) => commandOf(e) === "terminal.splitVertical"),
    preview: afterPersisted.some((e) => commandOf(e) === "preview.toggle"),
    invalid: afterPersisted.some((e) => commandOf(e) === "invalid.command"),
  };

  const summary = [
    "══════════════════════════════════════════════════════════════",
    "  SUMMARY",
    "══════════════════════════════════════════════════════════════",
    "",
    `Before issues: ${beforeState.issues.length}`,
    `After issues:  ${afterState.issues.length}`,
    "",
    "Before on-disk commands:",
    ...DIRTY_CONFIG.map((row) => `  ${row.command}`),
    "",
    "After on-disk flags:",
    `  has terminal.toggle:        ${flags.terminalToggle}`,
    `  has browser.toggle:         ${flags.browserToggle}`,
    `  has terminal.split:         ${flags.terminalSplit}`,
    `  has rightPanel.toggle:      ${flags.rightPanel}  (want false)`,
    `  has terminal.splitVertical: ${flags.splitVertical}  (want false)`,
    `  has preview.toggle:         ${flags.preview}  (want false)`,
    `  has invalid.command:        ${flags.invalid}  (want false)`,
    "",
    beforeState.issues.length > 0 &&
    afterState.issues.length === 0 &&
    flags.browserToggle &&
    flags.terminalSplit &&
    !flags.rightPanel &&
    !flags.preview &&
    !flags.invalid
      ? "OVERALL: PASS"
      : "OVERALL: FAIL",
    "",
  ].join("\n");

  FS.mkdirSync(OUT_DIR, { recursive: true });
  FS.writeFileSync(NodePath.join(OUT_DIR, "before-output.txt"), beforeReport, "utf8");
  FS.writeFileSync(NodePath.join(OUT_DIR, "after-output.txt"), afterReport, "utf8");
  FS.writeFileSync(NodePath.join(OUT_DIR, "summary.txt"), summary, "utf8");
  FS.writeFileSync(
    NodePath.join(OUT_DIR, "dirty-config.json"),
    `${JSON.stringify([...DIRTY_CONFIG], null, 2)}\n`,
    "utf8",
  );
  FS.writeFileSync(NodePath.join(OUT_DIR, "cleaned-config-snippet.json"), afterRaw, "utf8");

  // Combined human report
  const combined = `${beforeReport}\n${afterReport}\n${summary}`;
  FS.writeFileSync(NodePath.join(OUT_DIR, "FULL-PROOF.txt"), combined, "utf8");

  console.log(combined);
  console.log(`Wrote proof files to: ${OUT_DIR}`);
}).pipe(Effect.provide(makeKeybindingsLayer()), Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
