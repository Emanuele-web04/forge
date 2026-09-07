// FILE: tourContent.ts
// Purpose: Copy and links for the "what Synara can do" tour. Wording mirrors the public
//          docs (trysynara.com/docs) and changelog so onboarding and docs stay consistent.
// Layer: Web content (no React)

import type { LucideIcon } from "~/lib/icons";
import {
  BotIcon,
  ClockIcon,
  GitForkIcon,
  GitPullRequestIcon,
  GlobeIcon,
  KeyboardIcon,
  TerminalIcon,
} from "~/lib/icons";

export const SYNARA_DOCS_URL = "https://trysynara.com/docs";

export interface TourCard {
  readonly id: string;
  /** Short tab label. */
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly highlights: ReadonlyArray<string>;
  readonly docsHref: string;
  readonly icon: LucideIcon;
}

export const TOUR_CARDS: ReadonlyArray<TourCard> = [
  {
    id: "agents",
    label: "Any agent",
    title: "Run every coding agent in one workspace",
    description:
      "Synara sits around the agent runtimes you already trust: Claude Code, Codex, Cursor, Devin, Antigravity, Grok, Factory Droid, OpenCode, and Pi. The provider keeps its account, models, and limits. Synara owns the durable task, environment, transcript, and delivery workflow around it.",
    highlights: [
      "Switch models mid-thread",
      "Hand a thread to another provider",
      "Usage for every provider",
    ],
    docsHref: `${SYNARA_DOCS_URL}/getting-started/providers`,
    icon: BotIcon,
  },
  {
    id: "tasks",
    label: "Tasks & worktrees",
    title: "One task, one isolated environment",
    description:
      "Each task owns one body of work: its conversation, provider session, working environment, tool activity, and Git changes. Run tasks in parallel on managed Git worktrees so two agents never edit the same checkout.",
    highlights: ["Managed worktrees", "Forks from any message", "Subagents and side chats"],
    docsHref: `${SYNARA_DOCS_URL}/workflows/worktrees`,
    icon: GitForkIcon,
  },
  {
    id: "review",
    label: "Review & PRs",
    title: "From objective to evidence",
    description:
      "A task is complete only after you understand and verify its result, not when the provider reports it is finished. Inspect diffs, run terminals, then commit, push, and open a pull request without leaving the workspace.",
    highlights: [
      "Diff review with file tree",
      "Commit → push → PR",
      "Native pull-request workspace",
    ],
    docsHref: `${SYNARA_DOCS_URL}/workflows/pull-requests`,
    icon: GitPullRequestIcon,
  },
  {
    id: "browser",
    label: "Browser & devices",
    title: "Verify in a real browser or simulator",
    description:
      "Agents drive a visible, task-owned browser you can watch and annotate. On macOS, an iOS Simulator pane streams the device so agents can build, launch, and tap through an app while you follow along.",
    highlights: ["Shared Chromium surface", "Element annotations", "iOS Simulator pane"],
    docsHref: `${SYNARA_DOCS_URL}/workflows/browser-verification`,
    icon: GlobeIcon,
  },
  {
    id: "automations",
    label: "Automations & goals",
    title: "Hand off work that should keep moving",
    description:
      "Schedule recurring runs, attach a persistent goal to a thread so it keeps going after each clean turn, and let Synara bring you back when something needs attention. Scheduled does not mean autonomous approval.",
    highlights: [
      "Interval, daily, cron schedules",
      "Natural-language stop conditions",
      "Thread goals",
    ],
    docsHref: `${SYNARA_DOCS_URL}/workflows/automations`,
    icon: ClockIcon,
  },
  {
    id: "gateway",
    label: "Agent Gateway",
    title: "Let agents operate Synara itself",
    description:
      "A built-in MCP surface lets a supported provider session create tasks, wait on them, read transcripts, and steer other threads. Pair Codex, Claude Code, or Claude Desktop from outside with scoped, revocable credentials.",
    highlights: ["Parallel task batches", "External MCP pairing", "Approval boundaries"],
    docsHref: `${SYNARA_DOCS_URL}/workflows/agent-gateway`,
    icon: TerminalIcon,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    title: "Keep your hands on the keyboard",
    description:
      "Everything in the workspace has a shortcut, and the keymap is editable from Settings. A few worth learning on day one:",
    highlights: [],
    docsHref: `${SYNARA_DOCS_URL}/reference/keyboard-shortcuts`,
    icon: KeyboardIcon,
  },
];

/** Keybinding commands surfaced on the shortcuts card and the final step. */
export const TOUR_SHORTCUT_COMMANDS = [
  { command: "chat.new", label: "New task" },
  { command: "sidebar.addProject", label: "Add project" },
  { command: "sidebar.search", label: "Search sidebar" },
  { command: "terminal.toggle", label: "Toggle terminal" },
  { command: "diff.toggle", label: "Toggle diff" },
] as const;
