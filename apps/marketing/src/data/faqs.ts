// FILE: data/faqs.ts
// Purpose: Shared FAQ copy used by the homepage UI and FAQPage JSON-LD.
// Layer: static content (server/client importable).

import { PRODUCT_DESCRIPTION } from "@/data/product";

export const FAQ_ITEMS = [
  {
    question: "What is Synara?",
    answer: PRODUCT_DESCRIPTION,
  },
  {
    question: "Does Synara include models or require another AI subscription?",
    answer:
      "Synara does not sell a separate model plan. It connects to supported coding-agent runtimes and the provider accounts already configured on your machine. Each provider keeps its own authentication, models, limits, tools, and permissions.",
  },
  {
    question: "What must be installed before I start?",
    answer:
      "Install the Synara desktop app and at least one supported coding-agent runtime. Authenticate that runtime outside Synara, verify that its executable works from a fresh terminal, then confirm that Synara detects it in provider settings.",
  },
  {
    question: "Can several agents work at the same time?",
    answer:
      "Yes. Create separate tasks and use isolated Git worktrees when agents may edit concurrently. Each task keeps its own provider session, working directory, terminal, browser, diff, and delivery state so ownership remains visible.",
  },
  {
    question: "Can I switch providers without starting the task over?",
    answer:
      "Synara supports provider handoffs for supported runtimes. The next provider continues in the same task environment with the context Synara passes forward. Review the working tree before and after a handoff because providers do not have identical tools or session semantics.",
  },
  {
    question: "How does Synara fit into Git and pull-request workflows?",
    answer:
      "Use a normal branch or an isolated worktree, inspect the resulting diff, run the required checks, commit the intended changes, push the branch, and open or review the pull request from the same task workflow.",
  },
  {
    question: "Does Synara upload my code to its own cloud?",
    answer:
      "Synara does not require a Synara cloud workspace account or proxy normal provider traffic through its own model service. The selected provider still receives the prompts, files, diffs, command output, and tool results required for that provider session.",
  },
] as const;
