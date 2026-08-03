// FILE: shortcutsSheet.test.ts
// Purpose: Verify the shortcuts sheet builder reflects current context and dynamic script bindings.
// Layer: UI helper tests

import { describe, expect, it } from "vitest";

import { buildShortcutSheetSections } from "./shortcutsSheet";
import type { ProjectScript } from "./types";

const PROJECT_SCRIPTS: ProjectScript[] = [
  {
    id: "lint",
    name: "Lint",
    command: "bun lint",
    icon: "lint",
    runOnWorktreeCreate: false,
  },
];

describe("buildShortcutSheetSections", () => {
  it("includes the help shortcut and current thread jumps outside workspace mode", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [
        {
          command: "script.lint.run",
          shortcut: {
            key: "r",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
          },
        },
      ],
      projectScripts: PROJECT_SCRIPTS,
      platform: "MacIntel",
      context: {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
      },
    });

    expect(sections[0]?.entries.some((entry) => entry.id === "shortcuts.show")).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "thread.jump.1" && entry.shortcutLabel === "⌘1",
      ),
    ).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "composer.focus.toggle" && entry.shortcutLabel === "⌘L",
      ),
    ).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "sidebar.activity" && entry.shortcutLabel === "⌥⌘U",
      ),
    ).toBe(true);
    expect(sections[1]?.title).toBe("In workspace mode");
    expect(sections[2]?.entries[0]?.shortcutLabel).toBe("⌘R");
  });

  it("switches to workspace shortcuts when the workspace is open", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [],
      projectScripts: [],
      platform: "Linux",
      context: {
        terminalFocus: false,
        terminalOpen: true,
        terminalWorkspaceOpen: true,
      },
    });

    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "terminal.workspace.terminal" && entry.shortcutLabel === "Ctrl+1",
      ),
    ).toBe(true);
    expect(sections[1]?.title).toBe("Outside workspace mode");
    expect(
      sections[1]?.entries.some(
        (entry) => entry.id === "thread.jump.1" && entry.shortcutLabel === "Ctrl+1",
      ),
    ).toBe(true);
  });

  it("falls back to the legacy new-chat alias when needed", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [
        {
          command: "chat.newLocal",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: true,
          },
        },
      ],
      projectScripts: [],
      platform: "MacIntel",
      context: {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
      },
    });

    expect(
      sections[0]?.entries.some(
        (entry) => entry.label === "New chat" && entry.shortcutLabel === "⌥⌘N",
      ),
    ).toBe(true);
  });

  it("lists the sidebar toggle regardless of platform", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [
        {
          command: "sidebar.toggle",
          shortcut: {
            key: "b",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
          },
        },
      ],
      projectScripts: [],
      platform: "Linux",
      context: {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
      },
    });

    expect(sections[0]?.entries.some((entry) => entry.id === "sidebar.toggle")).toBe(true);
  });
});
