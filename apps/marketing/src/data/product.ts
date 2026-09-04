// FILE: data/product.ts
// Purpose: Canonical public product language shared by marketing, metadata,
//          structured data, FAQs, and AI-readable discovery surfaces.
// Layer: static content (server/client importable).

export const PRODUCT_NAME = "Synara";

export const PRODUCT_CATEGORY = "The local-first workspace and control plane for coding agents.";

export const PRODUCT_HERO_TITLE = "Run every coding agent in one workspace";

export const PRODUCT_HERO_DESCRIPTION =
  "Synara is the local-first command center for serious agentic work—run every coding agent in parallel and ship without losing context.";

export const PRODUCT_META_DESCRIPTION =
  "Synara is a free, open-source, local-first workspace for coding agents with separate tasks, Git worktrees, terminals, browser verification, diffs, handoffs, and pull-request delivery.";

export const PRODUCT_DESCRIPTION =
  "Synara is a free, open-source, local-first workspace and control plane for coding agents. Run Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok Build, Devin CLI, Pi, and Factory Droid across separate tasks with terminals, browser verification, diffs, Git worktrees, handoffs, and pull-request delivery in one desktop app.";

export const SUPPORTED_PROVIDERS = [
  "Claude Code",
  "Codex",
  "OpenCode",
  "Cursor",
  "Antigravity",
  "Grok Build",
  "Devin CLI",
  "Pi",
  "Factory Droid",
] as const;

export const PRODUCT_PILLARS = [
  {
    title: "One task owns one line of work",
    description:
      "Keep the objective, provider session, working directory, terminal, browser, diff, and delivery state attached to the same task.",
  },
  {
    title: "Providers stay portable",
    description:
      "Use the coding-agent runtimes and accounts already configured on your machine instead of moving every workflow into one vendor account.",
  },
  {
    title: "Parallel work stays isolated",
    description:
      "Give concurrent tasks separate Git worktrees and visible ownership so agents can build, test, and review without overwriting one another.",
  },
  {
    title: "Results stay reviewable",
    description:
      "Inspect commands, browser evidence, file changes, diffs, checks, commits, and pull requests before accepting the result.",
  },
] as const;
