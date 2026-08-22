import { Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  KeybindingsConfig,
  KeybindingRule,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "./keybindings";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const decodeResolvedRule = Schema.decodeUnknownEffect(ResolvedKeybindingRule as never);

it.effect("parses keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingRule, {
      key: "mod+b",
      command: "sidebar.toggle",
    });
    assert.strictEqual(parsed.command, "sidebar.toggle");

    const parsedSearch = yield* decode(KeybindingRule, {
      key: "mod+k",
      command: "sidebar.search",
    });
    assert.strictEqual(parsedSearch.command, "sidebar.search");

    const parsedActivity = yield* decode(KeybindingRule, {
      key: "mod+alt+u",
      command: "sidebar.activity",
    });
    assert.strictEqual(parsedActivity.command, "sidebar.activity");

    const parsedAddProject = yield* decode(KeybindingRule, {
      key: "mod+shift+o",
      command: "sidebar.addProject",
    });
    assert.strictEqual(parsedAddProject.command, "sidebar.addProject");

    const parsedTerminalToggle = yield* decode(KeybindingRule, {
      key: "mod+j",
      command: "terminal.toggle",
    });
    assert.strictEqual(parsedTerminalToggle.command, "terminal.toggle");

    const parsedClose = yield* decode(KeybindingRule, {
      key: "mod+w",
      command: "terminal.close",
    });
    assert.strictEqual(parsedClose.command, "terminal.close");

    const parsedWorkspaceNew = yield* decode(KeybindingRule, {
      key: "mod+shift+j",
      command: "terminal.workspace.newFullWidth",
    });
    assert.strictEqual(parsedWorkspaceNew.command, "terminal.workspace.newFullWidth");

    const parsedWorkspaceClose = yield* decode(KeybindingRule, {
      key: "mod+w",
      command: "terminal.workspace.closeActive",
    });
    assert.strictEqual(parsedWorkspaceClose.command, "terminal.workspace.closeActive");

    const parsedWorkspaceTerminal = yield* decode(KeybindingRule, {
      key: "mod+1",
      command: "terminal.workspace.terminal",
    });
    assert.strictEqual(parsedWorkspaceTerminal.command, "terminal.workspace.terminal");

    const parsedWorkspaceChat = yield* decode(KeybindingRule, {
      key: "mod+2",
      command: "terminal.workspace.chat",
    });
    assert.strictEqual(parsedWorkspaceChat.command, "terminal.workspace.chat");

    const parsedDiffToggle = yield* decode(KeybindingRule, {
      key: "mod+d",
      command: "diff.toggle",
    });
    assert.strictEqual(parsedDiffToggle.command, "diff.toggle");

    const parsedBrowserToggle = yield* decode(KeybindingRule, {
      key: "mod+shift+b",
      command: "browser.toggle",
    });
    assert.strictEqual(parsedBrowserToggle.command, "browser.toggle");

    const parsedModelPickerToggle = yield* decode(KeybindingRule, {
      key: "mod+shift+m",
      command: "modelPicker.toggle",
    });
    assert.strictEqual(parsedModelPickerToggle.command, "modelPicker.toggle");

    const parsedNextModel = yield* decode(KeybindingRule, {
      key: "alt+]",
      command: "model.next",
    });
    assert.strictEqual(parsedNextModel.command, "model.next");

    const parsedPreviousModel = yield* decode(KeybindingRule, {
      key: "alt+[",
      command: "model.previous",
    });
    assert.strictEqual(parsedPreviousModel.command, "model.previous");

    const parsedTraitsPickerToggle = yield* decode(KeybindingRule, {
      key: "mod+shift+e",
      command: "traitsPicker.toggle",
    });
    assert.strictEqual(parsedTraitsPickerToggle.command, "traitsPicker.toggle");

    const parsedComposerFocusToggle = yield* decode(KeybindingRule, {
      key: "cmd+l",
      command: "composer.focus.toggle",
    });
    assert.strictEqual(parsedComposerFocusToggle.command, "composer.focus.toggle");

    const parsedNewChat = yield* decode(KeybindingRule, {
      key: "mod+alt+n",
      command: "chat.newChat",
    });
    assert.strictEqual(parsedNewChat.command, "chat.newChat");

    const parsedLatestProject = yield* decode(KeybindingRule, {
      key: "mod+shift+n",
      command: "chat.newLatestProject",
    });
    assert.strictEqual(parsedLatestProject.command, "chat.newLatestProject");

    const parsedLegacyLocal = yield* decode(KeybindingRule, {
      key: "mod+shift+n",
      command: "chat.newLocal",
    });
    assert.strictEqual(parsedLegacyLocal.command, "chat.newLocal");

    const parsedTerminal = yield* decode(KeybindingRule, {
      key: "mod+shift+t",
      command: "chat.newTerminal",
    });
    assert.strictEqual(parsedTerminal.command, "chat.newTerminal");

    const parsedCursor = yield* decode(KeybindingRule, {
      key: "mod+alt+r",
      command: "chat.newCursor",
    });
    assert.strictEqual(parsedCursor.command, "chat.newCursor");

    const parsedThreadJump = yield* decode(KeybindingRule, {
      key: "mod+3",
      command: "thread.jump.3",
    });
    assert.strictEqual(parsedThreadJump.command, "thread.jump.3");

    const parsedSpaceJump = yield* decode(KeybindingRule, {
      key: "mod+alt+5",
      command: "space.jump.5",
    });
    assert.strictEqual(parsedSpaceJump.command, "space.jump.5");

    const parsedVisibleNext = yield* decode(KeybindingRule, {
      key: "mod+shift+]",
      command: "chat.visible.next",
    });
    assert.strictEqual(parsedVisibleNext.command, "chat.visible.next");

    const parsedVisiblePrevious = yield* decode(KeybindingRule, {
      key: "mod+shift+[",
      command: "chat.visible.previous",
    });
    assert.strictEqual(parsedVisiblePrevious.command, "chat.visible.previous");

    const parsedRecentNext = yield* decode(KeybindingRule, {
      key: "ctrl+tab",
      command: "view.recent.next",
    });
    assert.strictEqual(parsedRecentNext.command, "view.recent.next");

    const parsedRecentPrevious = yield* decode(KeybindingRule, {
      key: "ctrl+shift+tab",
      command: "view.recent.previous",
    });
    assert.strictEqual(parsedRecentPrevious.command, "view.recent.previous");
  }),
);

it.effect("rejects invalid command values", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(KeybindingRule, {
        key: "mod+j",
        command: "script.Test.run",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts dynamic script run commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingRule, {
      key: "mod+r",
      command: "script.setup.run",
    });
    assert.strictEqual(parsed.command, "script.setup.run");
  }),
);

it.effect("parses keybindings array payload", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingsConfig, [
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
    ]);
    assert.lengthOf(parsed, 2);
  }),
);

it.effect("parses resolved keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingRule, {
      command: "terminal.split",
      shortcut: {
        key: "d",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      whenAst: {
        type: "and",
        left: { type: "identifier", name: "terminalOpen" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
    });
    assert.strictEqual(parsed.shortcut.key, "d");
  }),
);

it.effect("parses resolved keybindings arrays", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ]);
    assert.lengthOf(parsed, 1);
  }),
);

it.effect("drops unknown fields in resolved keybinding rules", () =>
  decodeResolvedRule({
    command: "terminal.toggle",
    shortcut: {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    key: "mod+j",
  }).pipe(
    Effect.map((parsed) => {
      const view = parsed as Record<string, unknown>;
      assert.strictEqual("key" in view, false);
      assert.strictEqual(view.command, "terminal.toggle");
    }),
  ),
);
