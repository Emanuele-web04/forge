import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractInternalLinks, parseFrontmatter } from "./check-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = path.join(ROOT, "content", "docs");
const HELP_DIR = path.join(DOCS_DIR, "troubleshooting");

const HELP_PAGES = [
  {
    slug: "index",
    title: "Troubleshooting",
    requiredSections: [
      "Use the safest-first sequence",
      "Find the right guide",
      "Common symptoms",
      "Stop before making it worse",
    ],
    markers: ["A timeout does not prove", "Never post raw diagnostics blindly"],
  },
  {
    slug: "desktop-and-updates",
    title: "Desktop and updates",
    requiredSections: [
      "Synara will not launch",
      "The window is blank or unresponsive",
      "The local server does not become ready",
      "The packaged update failed",
      "Synara opens but providers changed after an update",
      "Source build and packaged build behave differently",
      "Safe reinstall checklist",
      "Still failing",
    ],
    markers: ["Do not delete data as a first step", "application bundle", "CPU architecture"],
  },
  {
    slug: "providers",
    title: "Provider troubleshooting",
    requiredSections: [
      "Provider is not detected",
      "Provider is detected but not authenticated",
      "Authentication state is unknown or stale",
      "Models are missing",
      "The wrong executable is used",
      "Provider is outdated",
      "Provider works directly but fails in Synara",
      "Provider process exits immediately",
      "Provider-specific guides",
      "Provider troubleshooting checklist",
    ],
    markers: ["command -v", "Never paste an API key", "fresh terminal"],
  },
  {
    slug: "tasks-and-runtime",
    title: "Tasks and runtime",
    requiredSections: [
      "Understand the task status",
      "Task appears stuck",
      "Task is waiting for approval",
      "Task is waiting for user input",
      "Turn was interrupted",
      "Provider reports completion but the task is not complete",
      "Session failed to resume",
      "Repeated runtime errors",
      "Journal or event-delivery warnings",
      "Two tasks touched the same checkout",
      "Runtime recovery checklist",
    ],
    markers: [
      "waiting-for-approval",
      "waiting-for-user-input",
      "synara_diagnose_thread",
      "source reports complete coverage",
    ],
  },
  {
    slug: "git-and-worktrees",
    title: "Git and worktrees",
    requiredSections: [
      "Start in the task’s working directory",
      "Detached HEAD in a managed worktree",
      "Repository lock error",
      "Merge or rebase is in progress",
      "Worktree path is missing",
      "Git says a branch is already checked out",
      "Two tasks edited one checkout",
      "Worktree cannot be removed",
      "Wrong base branch",
      "Untracked or generated files appeared",
      "Safe recovery commands",
      "Git recovery checklist",
    ],
    markers: ["git worktree list --porcelain", "Do not force the same branch", "git reflog"],
  },
  {
    slug: "browser",
    title: "Browser troubleshooting",
    requiredSections: [
      "Browser is unavailable",
      "No tab is assigned",
      "Snapshot reference is stale",
      "Action timed out",
      "Typing produced no visible text",
      "Click opened an OAuth or permission popup",
      "Navigation succeeded but the page is not ready",
      "Browser logs are empty",
      "Upload was rejected",
      "Keyboard command was rejected",
      "Screenshot differs from semantic snapshot",
      "Evaluation failed or changed the page",
      "Browser crashed or disconnected",
      "Browser recovery checklist",
    ],
    markers: [
      "browser_status",
      "browser_snapshot",
      "browser_logs",
      "browser_evaluate",
      "snapshotId",
      "Do not immediately repeat the mutation",
    ],
  },
  {
    slug: "automations-and-integrations",
    title: "Automations and integrations",
    requiredSections: [
      "Automation did not run",
      "Automation ran but produced no useful result",
      "Automation created duplicate effects",
      "Stop condition did not disable the automation",
      "Automation is blocked on approval",
      "Agent Gateway tool is unavailable",
      "Agent Gateway creation was rejected",
      "Agent Gateway wait appears stuck",
      "External MCP is waiting for pairing",
      "External MCP is paired but not connected",
      "External MCP reports no allowed projects",
      "External MCP cannot create a task",
      "External MCP reports a rate or active-task limit",
      "Integration targets the wrong Synara instance",
      "Revoked or expired integration",
      "Integration troubleshooting checklist",
    ],
    markers: [
      "synara_context",
      "synara_capabilities",
      "synara_create_thread",
      "synara_wait_for_threads",
      "Resume pairing",
      "Continue setup",
      "Do not copy the raw integration credential",
      "Revocation takes effect immediately",
    ],
  },
  {
    slug: "diagnostics",
    title: "Diagnostics",
    requiredSections: [
      "Diagnostic sources",
      "Start with the forensic snapshot",
      "Read projected activity",
      "Read durable thread events",
      "Read provider-runtime events",
      "Read source coverage first",
      "Use stable pagination",
      "Include details only when necessary",
      "Built-in redaction and bounds",
      "Manual redaction checklist",
      "Build a useful timeline",
      "Compare sources without rewriting history",
      "Minimal diagnostic bundle",
      "Diagnostic completion checklist",
    ],
    markers: [
      "synara_diagnose_thread",
      "synara_read_thread_activity",
      "synara_read_thread_events",
      "synara_read_thread_runtime_events",
      "sourceComplete: false",
      "Absence is not proof",
      "redaction is not a substitute",
    ],
  },
  {
    slug: "faq",
    title: "Frequently asked questions",
    requiredSections: ["Still have a question?"],
    markers: ["Agent Gateway", "External MCP", "worktree", "privacy", "stable behavior"],
  },
  {
    slug: "report-a-problem",
    title: "Report a problem",
    requiredSections: [
      "Before opening an issue",
      "Define the failure boundary",
      "Build a minimal reproduction",
      "Environment information",
      "Exact task evidence",
      "Git evidence",
      "Provider evidence",
      "Browser evidence",
      "Automation and integration evidence",
      "Diagnostic evidence",
      "Secret and privacy review",
      "Bug report template",
      "What not to do",
      "Reporting checklist",
    ],
    markers: [
      "rotate or revoke",
      "complete Synara data directory",
      "Expected behavior",
      "Actual behavior",
      "Time range and timezone",
    ],
  },
];

function readHelpPage(slug) {
  return readFileSync(path.join(HELP_DIR, `${slug}.mdx`), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("the legacy troubleshooting URL is preserved by a directory index", () => {
  assert.equal(existsSync(path.join(DOCS_DIR, "troubleshooting.mdx")), false);
  assert.equal(existsSync(path.join(HELP_DIR, "index.mdx")), true);

  const rootMeta = JSON.parse(readFileSync(path.join(DOCS_DIR, "meta.json"), "utf8"));
  assert.ok(rootMeta.pages.includes("troubleshooting"));
});

test("troubleshooting navigation has the exact help page set and order", () => {
  const meta = JSON.parse(readFileSync(path.join(HELP_DIR, "meta.json"), "utf8"));
  assert.deepEqual(
    meta.pages,
    HELP_PAGES.map(({ slug }) => slug),
  );
  assert.equal(new Set(meta.pages).size, meta.pages.length, "help navigation contains duplicates");
});

test("every help page satisfies its branch-specific content contract", () => {
  for (const page of HELP_PAGES) {
    const file = path.join(HELP_DIR, `${page.slug}.mdx`);
    assert.equal(existsSync(file), true, `${page.slug} help page is missing`);

    const source = readHelpPage(page.slug);
    const frontmatter = parseFrontmatter(source);
    assert.equal(frontmatter.error, undefined, `${page.slug} has invalid frontmatter`);
    assert.equal(frontmatter.values.title, page.title, `${page.slug} has the wrong title`);
    assert.ok(frontmatter.values.description?.trim(), `${page.slug} needs a description`);

    for (const section of page.requiredSections) {
      assert.match(
        source,
        new RegExp(`^## ${escapeRegExp(section)}$`, "m"),
        `${page.slug} is missing “${section}”`,
      );
    }

    for (const marker of page.markers) {
      assert.ok(source.includes(marker), `${page.slug} is missing required marker: ${marker}`);
    }
  }
});

test("the troubleshooting index links to every detailed help route", () => {
  const links = extractInternalLinks(readHelpPage("index"));
  for (const { slug } of HELP_PAGES.filter(({ slug }) => slug !== "index")) {
    const route = `/docs/troubleshooting/${slug}`;
    assert.ok(links.includes(route), `troubleshooting index does not link to ${route}`);
  }
});

test("the FAQ has broad question coverage", () => {
  const source = readHelpPage("faq");
  const questions = source.match(/<Accordion title=/g) ?? [];
  assert.ok(
    questions.length >= 25,
    `expected at least 25 FAQ questions, received ${questions.length}`,
  );

  for (const topic of [
    "model access",
    "provider",
    "GitHub",
    "worktree",
    "task",
    "browser",
    "automations",
    "Studio",
    "Agent Gateway",
    "External MCP",
    "diagnostics",
    "bug report",
  ]) {
    assert.ok(source.toLowerCase().includes(topic.toLowerCase()), `FAQ does not cover ${topic}`);
  }
});

test("diagnostics and reporting require manual privacy review", () => {
  const diagnostics = readHelpPage("diagnostics");
  const reporting = readHelpPage("report-a-problem");

  for (const source of [diagnostics, reporting]) {
    assert.match(source, /API keys|api keys/i);
    assert.match(source, /tokens/i);
    assert.match(source, /private prompts/i);
    assert.match(source, /proprietary source/i);
    assert.match(source, /manually redact|manual redaction|manually reviewed/i);
  }

  assert.ok(reporting.includes("If a real credential was posted, rotate or revoke it immediately"));
});

test("recovery guidance avoids unsafe destructive shortcuts", () => {
  assert.ok(readHelpPage("desktop-and-updates").includes("reinstall the application first"));
  assert.ok(readHelpPage("git-and-worktrees").includes("preserve the combined state"));
  assert.ok(readHelpPage("browser").includes("Retry only when the observed state proves"));
  assert.ok(readHelpPage("tasks-and-runtime").includes("Do not assume interruption rolled back"));
  assert.ok(
    readHelpPage("automations-and-integrations").includes(
      "Do not create another integration to bypass a safety limit",
    ),
  );
});
