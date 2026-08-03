import { assert, describe, it } from "vitest";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@synara/contracts";
import {
  formatShortcutLabel,
  isBrowserToggleShortcut,
  isChatNewShortcut,
  isChatNewChatShortcut,
  isDiffToggleShortcut,
  isKeyboardShortcutsHelpShortcut,
  isOpenFavoriteEditorShortcut,
  isSidebarToggleShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalToggleShortcut,
  resolveShortcutCommand,
  shouldShowThreadJumpHints,
  shortcutLabelForCommand,
  spaceJumpIndexFromCommand,
  terminalNavigationShortcutData,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("isKeyboardShortcutsHelpShortcut", () => {
  it("does not mistake the physical minus keys for shortcuts help on Windows", () => {
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(event({ ctrlKey: true, key: "/", code: "Minus" }), "Win32"),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "NumpadSubtract" }),
        "Win32",
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(event({ ctrlKey: true, key: "-", code: "Slash" }), "Win32"),
    );
  });

  it("recognizes the physical slash keys on Windows", () => {
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(event({ ctrlKey: true, key: "/", code: "Slash" }), "Win32"),
    );
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "NumpadDivide" }),
        "Win32",
      ),
    );
  });

  it("uses Cmd+/ on macOS without accepting Ctrl+/", () => {
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ metaKey: true, key: "/", code: "Slash" }),
        "MacIntel",
      ),
    );
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ metaKey: true, key: "/", code: "Minus" }),
        "MacIntel",
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "Slash" }),
        "MacIntel",
      ),
    );
  });

  it("uses Ctrl+/ on Linux without accepting Meta+/", () => {
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "Slash" }),
        "Linux x86_64",
      ),
    );
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "Minus" }),
        "Linux x86_64",
      ),
    );
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "NumpadSubtract" }),
        "Linux x86_64",
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ metaKey: true, key: "/", code: "Slash" }),
        "Linux x86_64",
      ),
    );
  });

  it("ignores key-up, auto-repeat, and modified slash events", () => {
    const platform = "Win32";
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ type: "keyup", ctrlKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ repeat: true, ctrlKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, shiftKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, altKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
  });
});

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function ctrlShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    modKey: false,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

function whenOr(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "or", left, right };
}

// Mirrors the production `whenCreationAllowed` guard: new-surface chords fire outside the
// terminal everywhere, and also from the terminal on macOS (where Cmd-chords never reach
// the shell). `isMac` is derived from the platform inside resolveContext.
const whenCreationAllowed = whenOr(
  whenNot(whenIdentifier("terminalFocus")),
  whenIdentifier("isMac"),
);

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

// Mirror the server defaults here so frontend shortcut resolution stays aligned.
const DEFAULT_BINDINGS = compile([
  {
    shortcut: modShortcut("b"),
    command: "sidebar.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  // Mirror server defaults: Cmd+K everywhere; Ctrl+K only off macOS.
  { shortcut: modShortcut("k", { metaKey: true, modKey: false }), command: "sidebar.search" },
  {
    shortcut: ctrlShortcut("k"),
    command: "sidebar.search",
    whenAst: whenNot(whenIdentifier("isMac")),
  },
  {
    shortcut: modShortcut("u", { altKey: true }),
    command: "sidebar.activity",
    whenAst: whenCreationAllowed,
  },
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("t"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("j", { shiftKey: true }),
    command: "terminal.workspace.newFullWidth",
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.workspace.closeActive",
    whenAst: whenIdentifier("terminalWorkspaceOpen"),
  },
  {
    shortcut: modShortcut("1"),
    command: "terminal.workspace.terminal",
    whenAst: whenIdentifier("terminalWorkspaceOpen"),
  },
  {
    shortcut: modShortcut("2"),
    command: "terminal.workspace.chat",
    whenAst: whenIdentifier("terminalWorkspaceOpen"),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("b", { shiftKey: true }),
    command: "browser.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("]", { altKey: true, modKey: false }),
    command: "model.next",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("[", { altKey: true, modKey: false }),
    command: "model.previous",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("e", { shiftKey: true }),
    command: "traitsPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("l", { metaKey: true, modKey: false }),
    command: "composer.focus.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("u", { shiftKey: true }),
    command: "settings.usage",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("o", { shiftKey: true }),
    command: "sidebar.addProject",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("i"),
    command: "sidebar.importThread",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("n"),
    command: "chat.new",
    whenAst: whenCreationAllowed,
  },
  {
    shortcut: modShortcut("n", { shiftKey: true }),
    command: "chat.newLatestProject",
    whenAst: whenCreationAllowed,
  },
  {
    shortcut: modShortcut("n", { altKey: true }),
    command: "chat.newChat",
    whenAst: whenCreationAllowed,
  },
  {
    shortcut: modShortcut("t", { shiftKey: true }),
    command: "chat.newTerminal",
    whenAst: whenCreationAllowed,
  },
  {
    shortcut: modShortcut("c", { altKey: true }),
    command: "chat.newClaude",
    whenAst: whenCreationAllowed,
  },
  {
    shortcut: modShortcut("x", { altKey: true }),
    command: "chat.newCodex",
    whenAst: whenCreationAllowed,
  },
  {
    shortcut: modShortcut("r", { altKey: true }),
    command: "chat.newCursor",
    whenAst: whenCreationAllowed,
  },
  {
    shortcut: ctrlShortcut("tab"),
    command: "view.recent.next",
  },
  {
    shortcut: ctrlShortcut("tab", { shiftKey: true }),
    command: "view.recent.previous",
  },
  ...Array.from({ length: 9 }, (_, index) => ({
    shortcut: modShortcut(String(index + 1), { altKey: true }),
    command: `space.jump.${index + 1}` as KeybindingCommand,
    whenAst: whenCreationAllowed,
  })),
  {
    shortcut: modShortcut("1"),
    command: "thread.jump.1",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("terminalWorkspaceOpen")),
    ),
  },
  {
    shortcut: modShortcut("2"),
    command: "thread.jump.2",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("terminalWorkspaceOpen")),
    ),
  },
  {
    shortcut: modShortcut("3"),
    command: "thread.jump.3",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("terminalWorkspaceOpen")),
    ),
  },
  {
    shortcut: modShortcut("4"),
    command: "thread.jump.4",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("terminalWorkspaceOpen")),
    ),
  },
  {
    shortcut: modShortcut("5"),
    command: "thread.jump.5",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("terminalWorkspaceOpen")),
    ),
  },
  {
    shortcut: modShortcut("6"),
    command: "thread.jump.6",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("terminalWorkspaceOpen")),
    ),
  },
  {
    shortcut: modShortcut("7"),
    command: "thread.jump.7",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("terminalWorkspaceOpen")),
    ),
  },
  {
    shortcut: modShortcut("8"),
    command: "thread.jump.8",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("terminalWorkspaceOpen")),
    ),
  },
  {
    shortcut: modShortcut("9"),
    command: "thread.jump.9",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("terminalWorkspaceOpen")),
    ),
  },
  {
    shortcut: modShortcut("]", { shiftKey: true }),
    command: "chat.visible.next",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("[", { shiftKey: true }),
    command: "chat.visible.previous",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
]);

describe("isTerminalToggleShortcut", () => {
  it("matches Cmd+J on macOS", () => {
    assert.isTrue(
      isTerminalToggleShortcut(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
  });

  it("matches Ctrl+J on non-macOS", () => {
    assert.isTrue(
      isTerminalToggleShortcut(event({ ctrlKey: true }), DEFAULT_BINDINGS, { platform: "Win32" }),
    );
  });
});

describe("split/new/close terminal shortcuts", () => {
  it("requires terminalFocus for default split/new/close bindings", () => {
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "t", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalCloseShortcut(event({ key: "w", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });

  it("matches split/new when terminalFocus is true", () => {
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "t", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isTerminalCloseShortcut(event({ key: "w", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });

  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "terminal.new",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      { shortcut: modShortcut("j"), command: "terminal.toggle" },
    ]);
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, terminalFocus: false },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
  });

  it("matches physical digit shortcuts even when event.key is layout-shifted", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({
          code: "Digit1",
          key: "&",
          ctrlKey: true,
        }),
        DEFAULT_BINDINGS,
        {
          platform: "Win32",
          context: { terminalWorkspaceOpen: true },
        },
      ),
      "terminal.workspace.terminal",
    );
  });

  it("matches physical bracket shortcuts even when event.key differs from the printed symbol", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("[", { shiftKey: true }),
        command: "chat.visible.previous",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(
        event({
          code: "BracketLeft",
          key: "^",
          ctrlKey: true,
          shiftKey: true,
        }),
        keybindings,
        {
          platform: "Win32",
          context: { terminalFocus: false },
        },
      ),
      "chat.visible.previous",
    );
  });

  it("supports when boolean literals", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "terminal.new", whenAst: whenIdentifier("true") },
      { shortcut: modShortcut("m"), command: "terminal.new", whenAst: whenIdentifier("false") },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "m", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
    );
  });
});

describe("settings shortcuts", () => {
  it("opens usage settings with Cmd+Shift+U outside terminal focus", () => {
    assert.equal(
      resolveShortcutCommand(event({ key: "u", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "settings.usage",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "u", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("Activity shortcut", () => {
  it("opens Activity with Cmd+Option+U, including from a focused macOS terminal", () => {
    for (const terminalFocus of [false, true]) {
      assert.equal(
        resolveShortcutCommand(event({ key: "u", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
          platform: "MacIntel",
          context: { terminalFocus },
        }),
        "sidebar.activity",
      );
    }
    assert.equal(shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.activity", "MacIntel"), "⌥⌘U");
  });

  it("uses Ctrl+Alt+U off macOS without stealing input from a focused terminal", () => {
    const shortcut = event({ key: "u", ctrlKey: true, altKey: true });
    assert.equal(
      resolveShortcutCommand(shortcut, DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "sidebar.activity",
    );
    assert.isNull(
      resolveShortcutCommand(shortcut, DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("composer focus shortcuts", () => {
  it("toggles composer focus with Cmd+L outside terminal focus", () => {
    assert.equal(
      resolveShortcutCommand(event({ key: "l", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "composer.focus.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "l", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("does not treat Ctrl+L as the composer focus shortcut on non-macOS", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "l", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });
});

describe("recent view shortcuts", () => {
  it("resolves Ctrl+Tab outside terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "Tab", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "view.recent.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "Tab", ctrlKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
      "view.recent.previous",
    );
  });

  it("resolves Ctrl+Tab while a terminal has focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "Tab", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "view.recent.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "Tab", ctrlKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: true },
        },
      ),
      "view.recent.previous",
    );
  });
});

describe("thread jump shortcuts", () => {
  it("maps thread jump indices to commands and back", () => {
    assert.strictEqual(threadJumpCommandForIndex(0), "thread.jump.1");
    assert.strictEqual(threadJumpCommandForIndex(8), "thread.jump.9");
    assert.isNull(threadJumpCommandForIndex(9));
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.4"), 3);
    assert.isNull(threadJumpIndexFromCommand("chat.new"));
  });

  it("resolves numbered thread jumps when the terminal workspace is closed", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "3", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false, terminalWorkspaceOpen: false },
      }),
      "thread.jump.3",
    );
  });

  it("preserves terminal workspace shortcuts when the workspace is open", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "1", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false, terminalWorkspaceOpen: true },
      }),
      "terminal.workspace.terminal",
    );
  });

  it("shows thread jump hints only while a numbered jump modifier combo is active", () => {
    assert.isTrue(
      shouldShowThreadJumpHints(event({ key: "Meta", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: false },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHints(event({ key: "Control", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalWorkspaceOpen: false },
      }),
    );
    assert.isFalse(
      shouldShowThreadJumpHints(event({ key: "Meta", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true },
      }),
    );
  });
});

describe("space jump shortcuts", () => {
  it("maps space jump commands to strip indices", () => {
    assert.strictEqual(spaceJumpIndexFromCommand("space.jump.1"), 0);
    assert.strictEqual(spaceJumpIndexFromCommand("space.jump.9"), 8);
    assert.isNull(spaceJumpIndexFromCommand("thread.jump.1"));
  });

  it("resolves Cmd+Alt+digit even when Option shifts event.key on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "Digit2", key: "™", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: false, terminalWorkspaceOpen: false },
        },
      ),
      "space.jump.2",
    );
  });

  it("resolves space jumps from the built-in fallbacks when no config is present", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ code: "Digit1", key: "1", metaKey: true, altKey: true }), [], {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "space.jump.1",
    );
  });

  it("does not shadow plain numbered thread jumps", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "2", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false, terminalWorkspaceOpen: false },
      }),
      "thread.jump.2",
    );
  });

  it("fires from a focused terminal on macOS but yields to it elsewhere", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "Digit3", key: "3", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel", context: { terminalFocus: true } },
      ),
      "space.jump.3",
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ code: "Digit3", key: "3", ctrlKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        { platform: "Linux", context: { terminalFocus: true } },
      ),
    );
  });
});

describe("workspace terminal tab shortcuts", () => {
  it("resolves the full-width terminal shortcut", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "j", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "terminal.workspace.newFullWidth",
    );
  });

  it("resolves the active workspace close shortcut only while the terminal workspace is open", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "w", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true, terminalFocus: true },
      }),
      "terminal.workspace.closeActive",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "w", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: false, terminalFocus: false },
      }),
    );
  });

  it("prefers workspace tab shortcuts while open and thread jumps otherwise", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "1", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true },
      }),
      "terminal.workspace.terminal",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "2", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalWorkspaceOpen: true },
      }),
      "terminal.workspace.chat",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "1", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: false },
      }),
      "thread.jump.1",
    );
  });

  it("falls back to workspace defaults when the runtime config is missing them", () => {
    const legacyBindings = DEFAULT_BINDINGS.filter(
      (binding) =>
        binding.command !== "terminal.workspace.newFullWidth" &&
        binding.command !== "terminal.workspace.closeActive" &&
        binding.command !== "terminal.workspace.terminal" &&
        binding.command !== "terminal.workspace.chat",
    );

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "j", metaKey: true, shiftKey: true }), legacyBindings, {
        platform: "MacIntel",
      }),
      "terminal.workspace.newFullWidth",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "w", metaKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true },
      }),
      "terminal.workspace.closeActive",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "1", metaKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true },
      }),
      "terminal.workspace.terminal",
    );
    assert.strictEqual(
      shortcutLabelForCommand(legacyBindings, "terminal.workspace.chat", "Linux"),
      "Ctrl+2",
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns the most recent binding label", () => {
    const bindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
      {
        shortcut: modShortcut("\\", { shiftKey: true }),
        command: "terminal.split",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", "Linux"),
      "Ctrl+Shift+\\",
    );
  });

  it("respects explicit context when resolving conflicting labels", () => {
    const bindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
      {
        shortcut: modShortcut("\\", { shiftKey: true }),
        command: "terminal.split",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+Shift+\\",
    );
  });

  it("returns labels for non-terminal commands", () => {
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.addProject", "MacIntel"),
      "⇧⌘O",
    );
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.new", "MacIntel"), "⌘N");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.newLatestProject", "MacIntel"),
      "⇧⌘N",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.newChat", "MacIntel"),
      "⌥⌘N",
    );
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "terminal.new", "MacIntel"), "⌘T");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.newTerminal", "MacIntel"),
      "⇧⌘T",
    );
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "diff.toggle", "Linux"), "Ctrl+D");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.toggle", "MacIntel"),
      "⌘B",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.search", "MacIntel"),
      "⌘K",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "browser.toggle", "MacIntel"),
      "⇧⌘B",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "modelPicker.toggle", "MacIntel"),
      "⇧⌘M",
    );
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "model.next", "MacIntel"), "⌥]");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "model.previous", "MacIntel"),
      "⌥[",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "traitsPicker.toggle", "MacIntel"),
      "⇧⌘E",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "composer.focus.toggle", "MacIntel"),
      "⌘L",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "terminal.workspace.terminal", "MacIntel"),
      "⌘1",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "terminal.workspace.newFullWidth", "MacIntel"),
      "⇧⌘J",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "terminal.workspace.chat", "Linux"),
      "Ctrl+2",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.visible.next", "MacIntel"),
      "⇧⌘]",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.visible.previous", "MacIntel"),
      "⇧⌘[",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "editor.openFavorite", "Linux"),
      "Ctrl+O",
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("matches chat.new shortcut", () => {
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
    // macOS: Cmd+N still creates a new chat even from terminal focus — xterm never
    // forwards the Cmd-chord to the shell, so the old `!terminalFocus` block just lost it.
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    // Linux/Windows: Ctrl+N is real shell input, so terminal focus must still block it.
    assert.isFalse(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches chat.newChat shortcut", () => {
    assert.isTrue(
      isChatNewChatShortcut(event({ key: "n", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isChatNewChatShortcut(event({ key: "n", ctrlKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("resolves chat.newLatestProject shortcut", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.newLatestProject",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "chat.newLatestProject",
    );
  });

  it("resolves sidebar.addProject shortcut", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "o", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "sidebar.addProject",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "o", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "sidebar.addProject",
    );
  });

  it("resolves chat.newTerminal shortcut", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "t", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.newTerminal",
    );
  });

  it("resolves provider-specific new chat shortcuts", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "c", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.newClaude",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "x", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.newCodex",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "r", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.newCursor",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "KeyC", key: "ç", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
      "chat.newClaude",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "KeyX", key: "≈", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
      "chat.newCodex",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "KeyR", key: "®", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
      "chat.newCursor",
    );
  });

  it("resolves new-surface chords from terminal focus on macOS but not on other platforms", () => {
    const macTerminal = { platform: "MacIntel", context: { terminalFocus: true } } as const;
    const linuxTerminal = { platform: "Linux", context: { terminalFocus: true } } as const;

    // macOS: Cmd-chords never reach the shell, so creating a new surface still works.
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "t", metaKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        macTerminal,
      ),
      "chat.newTerminal",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "n", metaKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        macTerminal,
      ),
      "chat.newLatestProject",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "n", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        macTerminal,
      ),
      "chat.newChat",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "c", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        macTerminal,
      ),
      "chat.newClaude",
    );

    // Linux/Windows: the same chords are real shell input, so terminal focus blocks them.
    assert.isNull(
      resolveShortcutCommand(
        event({ key: "t", ctrlKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        linuxTerminal,
      ),
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: "c", ctrlKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        linuxTerminal,
      ),
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: "n", ctrlKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        linuxTerminal,
      ),
    );
  });

  it("resolves visible chat cycle shortcuts", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.visible.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "[", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.visible.previous",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "}", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.visible.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "{", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.visible.previous",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "]", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches editor.openFavorite shortcut", () => {
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches diff.toggle shortcut outside terminal focus", () => {
    assert.isTrue(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches sidebar.toggle shortcut outside terminal focus", () => {
    assert.isTrue(
      isSidebarToggleShortcut(event({ key: "b", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isSidebarToggleShortcut(event({ key: "b", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("resolves sidebar.search regardless of terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "sidebar.search",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "sidebar.search",
    );
  });

  it("keeps Cmd+K for sidebar.search on macOS and releases Ctrl+K", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "sidebar.search",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      null,
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.search", "MacIntel"),
      "⌘K",
    );
  });

  it("keeps Ctrl+K for sidebar.search on Windows and Linux", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Win32",
      }),
      "sidebar.search",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux x86_64",
      }),
      "sidebar.search",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.search", "Win32"),
      "Ctrl+K",
    );
  });

  it("matches browser.toggle shortcut outside terminal focus", () => {
    assert.isTrue(
      isBrowserToggleShortcut(
        event({ key: "b", metaKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
    );
    assert.isFalse(
      isBrowserToggleShortcut(
        event({ key: "b", metaKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: true },
        },
      ),
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("resolveShortcutCommand", () => {
  it("resolves model cycle commands outside terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "model.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "[", altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "model.previous",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "‘", code: "BracketRight", altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
      "model.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      null,
    );
  });

  it("returns dynamic script commands", () => {
    const keybindings = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "r", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
  });

  it("resolves configurable composer picker commands", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("m", { altKey: true }),
        command: "modelPicker.toggle",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
      {
        shortcut: modShortcut("e", { altKey: true }),
        command: "traitsPicker.toggle",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", metaKey: true, altKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "modelPicker.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "e", metaKey: true, altKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "traitsPicker.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", metaKey: true, altKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      null,
    );
  });

  it("falls back to composer picker defaults when runtime config is missing them", () => {
    const legacyBindings = DEFAULT_BINDINGS.filter(
      (binding) =>
        binding.command !== "modelPicker.toggle" &&
        binding.command !== "model.next" &&
        binding.command !== "model.previous" &&
        binding.command !== "traitsPicker.toggle",
    );

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", metaKey: true, shiftKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "modelPicker.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "e", metaKey: true, shiftKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "traitsPicker.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", altKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "model.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "[", altKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "model.previous",
    );
  });

  it("falls back to creation defaults with the macOS terminal-focus escape hatch", () => {
    const legacyBindings = DEFAULT_BINDINGS.filter(
      (binding) => binding.command !== "chat.new" && binding.command !== "chat.newTerminal",
    );
    const macTerminal = { platform: "MacIntel", context: { terminalFocus: true } } as const;
    const linuxTerminal = { platform: "Linux", context: { terminalFocus: true } } as const;

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), legacyBindings, macTerminal),
      "chat.new",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "t", metaKey: true, shiftKey: true }),
        legacyBindings,
        macTerminal,
      ),
      "chat.newTerminal",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), legacyBindings, linuxTerminal),
    );
  });

  it("falls back to the composer focus default when runtime config is missing it", () => {
    const legacyBindings = DEFAULT_BINDINGS.filter(
      (binding) => binding.command !== "composer.focus.toggle",
    );

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "l", metaKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "composer.focus.toggle",
    );
  });

  it("falls back to provider-specific new chat defaults when runtime config is missing them", () => {
    const legacyBindings = DEFAULT_BINDINGS.filter(
      (binding) =>
        binding.command !== "chat.newClaude" &&
        binding.command !== "chat.newCodex" &&
        binding.command !== "chat.newCursor",
    );

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "c", metaKey: true, altKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.newClaude",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "x", metaKey: true, altKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.newCodex",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "r", metaKey: true, altKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.newCursor",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "KeyC", key: "ç", metaKey: true, altKey: true }),
        legacyBindings,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
      "chat.newClaude",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "KeyX", key: "≈", metaKey: true, altKey: true }),
        legacyBindings,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
      "chat.newCodex",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "KeyR", key: "®", metaKey: true, altKey: true }),
        legacyBindings,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
      "chat.newCursor",
    );
  });
});

describe("formatShortcutLabel", () => {
  it("formats labels for macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "MacIntel"),
      "⇧⌘D",
    );
  });

  it("formats labels for non-macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "Linux"),
      "Ctrl+Shift+D",
    );
  });

  it("formats labels for plus key", () => {
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "MacIntel"), "⌘+");
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "Linux"), "Ctrl++");
  });
});

describe("isTerminalClearShortcut", () => {
  it("matches Ctrl+L", () => {
    assert.isTrue(isTerminalClearShortcut(event({ key: "l", ctrlKey: true })));
  });

  it("does not match Cmd+K (reserved for sidebar search)", () => {
    assert.isFalse(isTerminalClearShortcut(event({ key: "k", metaKey: true })));
  });

  it("ignores non-keydown events", () => {
    assert.isFalse(isTerminalClearShortcut(event({ type: "keyup", key: "l", ctrlKey: true })));
  });
});

describe("terminalNavigationShortcutData", () => {
  it("maps Option+Arrow on macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", altKey: true }), "MacIntel"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", altKey: true }), "MacIntel"),
      "\u001bf",
    );
  });

  it("maps Cmd+Arrow on macOS to line movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "MacIntel"),
      "\u0001",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", metaKey: true }), "MacIntel"),
      "\u0005",
    );
  });

  it("maps Ctrl+Arrow on non-macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", ctrlKey: true }), "Win32"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", ctrlKey: true }), "Linux"),
      "\u001bf",
    );
  });

  it("rejects unsupported combinations", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ key: "ArrowLeft", shiftKey: true, altKey: true }),
        "MacIntel",
      ),
    );
    assert.isNull(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "Linux"),
    );
    assert.isNull(terminalNavigationShortcutData(event({ key: "a", altKey: true }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ type: "keyup", key: "ArrowLeft", altKey: true }),
        "MacIntel",
      ),
    );
  });
});

describe("plus key parsing", () => {
  it("matches the plus key shortcut", () => {
    const plusBindings = compile([{ shortcut: modShortcut("+"), command: "terminal.toggle" }]);
    assert.isTrue(
      isTerminalToggleShortcut(event({ key: "+", metaKey: true }), plusBindings, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isTerminalToggleShortcut(event({ key: "+", ctrlKey: true }), plusBindings, {
        platform: "Linux",
      }),
    );
  });
});
