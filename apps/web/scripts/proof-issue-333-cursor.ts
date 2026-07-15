// Run: cd apps/web && bun scripts/proof-issue-333-cursor.ts
import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { collapseCursorModelVariants } from "../src/cursorModelVariants.ts";
import type { ProviderModelDescriptor } from "@synara/contracts";
import { groupProviderModelOptions } from "../src/providerModelOptions.ts";

// Local-only output (gitignored via .synara-*/). No personal paths in the report body.
const outDir = Path.resolve("../../.synara-pr/issue-333");
FS.mkdirSync(outDir, { recursive: true });

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseCursorCliModels(stdout: string): ProviderModelDescriptor[] {
  const models: ProviderModelDescriptor[] = [];
  for (const line of stripAnsi(stdout).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "Available models" || trimmed.startsWith("Tip:")) continue;
    // format: "slug - Display Name"  (display may include "(default)")
    const sep = trimmed.indexOf(" - ");
    if (sep <= 0) continue;
    const slug = trimmed.slice(0, sep).trim();
    const name = trimmed
      .slice(sep + 3)
      .replace(/\s*\(default\)\s*$/iu, "")
      .trim();
    if (!slug) continue;
    // Heuristic upstream from slug/name (CLI list has no provider meta)
    let upstreamProviderId: string | undefined;
    let upstreamProviderName: string | undefined;
    const lower = `${slug} ${name}`.toLowerCase();
    if (lower.includes("grok") || lower.includes("xai")) {
      upstreamProviderId = "xai";
      upstreamProviderName = "xAI";
    } else if (
      lower.includes("claude") ||
      lower.includes("opus") ||
      lower.includes("sonnet") ||
      lower.includes("fable") ||
      lower.includes("haiku")
    ) {
      upstreamProviderId = "anthropic";
      upstreamProviderName = "Anthropic";
    } else if (lower.includes("gpt") || lower.includes("codex") || lower.includes("composer")) {
      upstreamProviderId = "openai";
      upstreamProviderName = "OpenAI";
    } else if (lower.includes("gemini")) {
      upstreamProviderId = "google";
      upstreamProviderName = "Google";
    }
    models.push({
      slug,
      name,
      ...(upstreamProviderId ? { upstreamProviderId } : {}),
      ...(upstreamProviderName ? { upstreamProviderName } : {}),
    });
  }
  return models;
}

// OLD behavior (what merge used to do)
function mergeOldStyle(models: ReadonlyArray<ProviderModelDescriptor>): ProviderModelDescriptor[] {
  const collapsed = collapseCursorModelVariants(models);
  const seen = new Set<string>();
  const out: ProviderModelDescriptor[] = [];
  for (const model of [...collapsed, ...models]) {
    const key = model.slug.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

const result = spawnSync("cursor-agent", ["--list-models"], {
  encoding: "utf8",
  env: process.env,
  timeout: 30_000,
});
if (result.status !== 0) {
  console.error("cursor-agent --list-models failed:", result.stderr || result.stdout);
  process.exit(1);
}

const rawModels = parseCursorCliModels(result.stdout || "");
const before = mergeOldStyle(rawModels);
const after = collapseCursorModelVariants(rawModels);

const xaiBefore = before.filter(
  (m) => m.upstreamProviderId === "xai" || /grok/i.test(m.slug) || /grok/i.test(m.name),
);
const xaiAfter = after.filter(
  (m) => m.upstreamProviderId === "xai" || /grok/i.test(m.slug) || /grok/i.test(m.name),
);

const report = [
  "══════════════════════════════════════════════════════════════",
  "  #333 LIVE CURSOR CLI PROOF (authenticated cursor-agent)",
  "══════════════════════════════════════════════════════════════",
  "",
  `cursor-agent --list-models total parsed: ${rawModels.length}`,
  `Grok/xAI raw CLI rows: ${rawModels.filter((m) => /grok/i.test(m.slug)).length}`,
  "",
  "RAW CLI Grok rows:",
  ...rawModels.filter((m) => /grok/i.test(m.slug)).map((m) => `  ${m.slug}  (${m.name})`),
  "",
  "── BEFORE (old merge: collapsed base + every raw variant) ──",
  `  total picker rows: ${before.length}`,
  `  xAI/Grok picker rows: ${xaiBefore.length}`,
  ...xaiBefore.map((m) => `    - ${m.slug}  |  ${m.name}`),
  "",
  "── AFTER (fix: collapse only) ──",
  `  total picker rows: ${after.length}`,
  `  xAI/Grok picker rows: ${xaiAfter.length}`,
  ...xaiAfter.map((m) => {
    const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.value).join(",");
    return `    - ${m.slug}  |  ${m.name}  | efforts=[${efforts}]`;
  }),
  "",
  "── GROUPING (how submenu labels) ──",
  "BEFORE xAI group options:",
  ...groupProviderModelOptions(
    xaiBefore.map((m) => ({
      slug: m.slug,
      name: m.name,
      upstreamProviderId: m.upstreamProviderId,
      upstreamProviderName: m.upstreamProviderName,
    })),
  ).flatMap((g) => [
    `  [${g.label ?? g.key}]`,
    ...g.options.map((o) => `    ${o.slug} (${o.name})`),
  ]),
  "",
  "AFTER xAI group options:",
  ...groupProviderModelOptions(
    xaiAfter.map((m) => ({
      slug: m.slug,
      name: m.name,
      upstreamProviderId: m.upstreamProviderId,
      upstreamProviderName: m.upstreamProviderName,
    })),
  ).flatMap((g) => [
    `  [${g.label ?? g.key}]`,
    ...g.options.map((o) => `    ${o.slug} (${o.name})`),
  ]),
  "",
  xaiBefore.length > xaiAfter.length && xaiAfter.length === 1
    ? "RESULT: PASS — xAI Grok collapsed from multiple effort rows to one base model."
    : xaiAfter.length < xaiBefore.length
      ? `RESULT: PASS — xAI/Grok rows reduced ${xaiBefore.length} → ${xaiAfter.length}`
      : `RESULT: CHECK — before=${xaiBefore.length} after=${xaiAfter.length}`,
  "",
].join("\n");

FS.writeFileSync(Path.join(outDir, "live-cli-proof.txt"), report, "utf8");
FS.writeFileSync(
  Path.join(outDir, "raw-cli-models.json"),
  JSON.stringify(rawModels, null, 2) + "\n",
);
FS.writeFileSync(Path.join(outDir, "before-catalog.json"), JSON.stringify(before, null, 2) + "\n");
FS.writeFileSync(Path.join(outDir, "after-catalog.json"), JSON.stringify(after, null, 2) + "\n");
console.log(report);
// Relative path only — never log absolute home directories in proof output.
console.log("Wrote proofs to .synara-pr/issue-333/");
