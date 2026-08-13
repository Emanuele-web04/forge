import { assert, describe, it } from "vitest";

import {
  matchSidebarSearchActions,
  matchSidebarSearchProjects,
  matchSidebarSearchThemes,
  matchSidebarSearchThreads,
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchTheme,
  type SidebarSearchThread,
} from "./SidebarSearchPalette.logic";

const actions: SidebarSearchAction[] = [
  {
    id: "new-thread",
    label: "New thread",
    description: "Start a fresh chat",
    keywords: ["chat", "new"],
  },
  {
    id: "plugins",
    label: "Plugins",
    description: "Browse installed plugins",
    keywords: ["extensions"],
  },
  {
    id: "feedback",
    label: "Feedback Synara",
    description: "Send feedback or report an issue to the Synara team.",
    keywords: ["feedback", "bug", "issue", "report", "support"],
  },
  {
    id: "usage-settings",
    label: "Usage settings",
    description: "Open provider usage and remaining credits.",
    keywords: ["usage", "limits", "credits", "quota", "providers"],
    shortcutLabel: "⇧⌘U",
  },
];

const projects: SidebarSearchProject[] = [
  {
    id: "project-alpha",
    name: "Alpha Repo",
    remoteName: "Alpha Repo",
    folderName: "alpha-repo",
    localName: null,
    cwd: "/repos/alpha-repo",
    spaceName: "Work",
    updatedAt: "2026-04-09T10:00:00.000Z",
  },
  {
    id: "project-beta",
    name: "Docs",
    remoteName: "Beta Repo",
    folderName: "beta-repo",
    localName: "Docs",
    cwd: "/repos/beta-repo",
    spaceName: "Void",
    updatedAt: "2026-04-09T11:00:00.000Z",
  },
];

const themes: SidebarSearchTheme[] = [
  {
    id: "theme-mode-system",
    type: "mode",
    label: "System",
    description: "Match your OS appearance setting.",
    keywords: ["appearance", "theme", "mode", "os"],
    mode: "system",
    isActive: true,
  },
  {
    id: "theme-mode-dark",
    type: "mode",
    label: "Dark",
    description: "Always use the dark theme.",
    keywords: ["appearance", "theme", "mode", "night"],
    mode: "dark",
    isActive: false,
  },
  {
    id: "theme-codex-dark",
    type: "code-theme",
    label: "Codex",
    description: "Apply to the current dark theme slot.",
    keywords: ["appearance", "theme", "dark"],
    codeThemeId: "codex",
    variant: "dark",
    isActive: true,
  },
  {
    id: "theme-linear-dark",
    type: "code-theme",
    label: "Linear",
    description: "Apply to the current dark theme slot.",
    keywords: ["appearance", "theme", "dark"],
    codeThemeId: "linear",
    variant: "dark",
    isActive: false,
  },
];

const threads: SidebarSearchThread[] = [
  {
    id: "thread-alpha-composer",
    title: "Composer refactor",
    projectId: "project-alpha",
    projectName: "Alpha Repo",
    projectRemoteName: "Alpha Repo",
    spaceName: "Work",
    provider: "claudeAgent",
    createdAt: "2026-04-09T09:00:00.000Z",
    updatedAt: "2026-04-09T11:30:00.000Z",
    messages: [
      {
        text: "Need to clean up the composer shell and remove duplicated state.",
      },
    ],
  },
  {
    id: "thread-alpha-compose-prompt",
    title: "composePrompt follow-up",
    projectId: "project-alpha",
    projectName: "Alpha Repo",
    projectRemoteName: "Alpha Repo",
    spaceName: "Work",
    provider: "codex",
    createdAt: "2026-04-09T08:00:00.000Z",
    updatedAt: "2026-04-09T10:30:00.000Z",
    messages: [
      {
        text: "composePrompt still leaks prompt state after retries.",
      },
      {
        text: "Let's make composePrompt smaller before we move it.",
      },
    ],
  },
  {
    id: "thread-beta-settings",
    title: "Settings cleanup",
    projectId: "project-beta",
    projectName: "Docs",
    projectRemoteName: "Beta Repo",
    spaceName: "Void",
    provider: "claudeAgent",
    createdAt: "2026-04-09T07:00:00.000Z",
    updatedAt: "2026-04-09T09:00:00.000Z",
    messages: [
      {
        text: "Settings page should expose desktop notification toggles.",
      },
    ],
  },
];

describe("SidebarSearchPalette.logic", () => {
  it("keeps suggested actions in source order for an empty query", () => {
    const result = matchSidebarSearchActions(actions, "");

    assert.deepEqual(
      result.map((action) => action.id),
      ["new-thread", "plugins", "feedback", "usage-settings"],
    );
  });

  it("matches Feedback Synara by feedback and issue keywords", () => {
    assert.deepEqual(
      matchSidebarSearchActions(actions, "feedback").map((action) => action.id),
      ["feedback"],
    );
    assert.deepEqual(
      matchSidebarSearchActions(actions, "bug").map((action) => action.id),
      ["feedback"],
    );
  });

  it("hides requiresQuery actions from the empty palette but matches them once typed", () => {
    const withSpaceJump: SidebarSearchAction[] = [
      ...actions,
      {
        id: "switch-space-work",
        label: "Switch to Work",
        description: "Jump to this space.",
        keywords: ["space", "switch", "Work"],
        requiresQuery: true,
      },
    ];

    const emptyQuery = matchSidebarSearchActions(withSpaceJump, "");
    assert.equal(
      emptyQuery.some((action) => action.id === "switch-space-work"),
      false,
    );

    const typed = matchSidebarSearchActions(withSpaceJump, "work");
    assert.equal(typed[0]?.id, "switch-space-work");
  });

  it("matches usage settings by keyword", () => {
    const result = matchSidebarSearchActions(actions, "quota");

    assert.deepEqual(
      result.map((action) => action.id),
      ["usage-settings"],
    );
    assert.equal(result[0]?.shortcutLabel, "⇧⌘U");
  });

  it("keeps theme entries in source order for an empty query", () => {
    const result = matchSidebarSearchThemes(themes, "");

    assert.deepEqual(
      result.map((theme) => theme.id),
      ["theme-mode-system", "theme-mode-dark", "theme-codex-dark", "theme-linear-dark"],
    );
  });

  it("matches themes by query relevance", () => {
    const result = matchSidebarSearchThemes(themes, "dark");

    assert.deepEqual(
      result.map((theme) => theme.id),
      ["theme-mode-dark", "theme-codex-dark", "theme-linear-dark"],
    );
  });

  it("matches projects by repo name before cwd fragments", () => {
    const result = matchSidebarSearchProjects(projects, "alpha");

    assert.lengthOf(result, 1);
    assert.equal(result[0]?.project.id, "project-alpha");
  });

  it("matches projects by original name when a local name override exists", () => {
    const result = matchSidebarSearchProjects(projects, "beta");

    assert.lengthOf(result, 1);
    assert.equal(result[0]?.project.id, "project-beta");
  });

  it("matches projects and threads through their space label", () => {
    assert.deepEqual(
      matchSidebarSearchProjects(projects, "work").map((match) => match.project.id),
      ["project-alpha"],
    );
    assert.deepEqual(
      matchSidebarSearchThreads(threads, "void").map((match) => match.thread.id),
      ["thread-beta-settings"],
    );
  });

  it("prefers thread title matches and then recency", () => {
    const result = matchSidebarSearchThreads(threads, "comp");

    assert.deepEqual(
      result.map((match) => match.thread.id),
      ["thread-alpha-composer", "thread-alpha-compose-prompt"],
    );
  });

  it("can match threads through the project name", () => {
    const result = matchSidebarSearchThreads(threads, "docs");

    assert.deepEqual(
      result.map((match) => match.thread.id),
      ["thread-beta-settings"],
    );
    assert.equal(result[0]?.matchKind, "project");
  });

  it("can match threads through the original project name", () => {
    const result = matchSidebarSearchThreads(threads, "beta");

    assert.deepEqual(
      result.map((match) => match.thread.id),
      ["thread-beta-settings"],
    );
    assert.equal(result[0]?.matchKind, "project");
  });

  it("can match message content and returns a snippet", () => {
    const result = matchSidebarSearchThreads(threads, "desktop notification");

    assert.lengthOf(result, 1);
    assert.equal(result[0]?.thread.id, "thread-beta-settings");
    assert.equal(result[0]?.matchKind, "message");
    assert.equal(result[0]?.messageMatchCount, 1);
    assert.include(result[0]?.snippet ?? "", "desktop notification toggles");
  });

  it("keeps title matches ahead of message-only matches", () => {
    const result = matchSidebarSearchThreads(threads, "composer");

    assert.deepEqual(
      result.map((match) => match.thread.id),
      ["thread-alpha-composer"],
    );
    assert.equal(result[0]?.matchKind, "title");
  });

  it("counts multiple message hits in the same thread", () => {
    const result = matchSidebarSearchThreads(threads, "composeprompt");

    assert.equal(result[0]?.thread.id, "thread-alpha-compose-prompt");
    assert.equal(result[0]?.matchKind, "title");
    assert.equal(result[0]?.messageMatchCount, 2);
  });
});
