import { Schema } from "effect";
import { TrimmedString } from "./baseSchemas";

export const MAX_KEYBINDING_VALUE_LENGTH = 64;
const MAX_KEYBINDING_WHEN_LENGTH = 256;
export const MAX_WHEN_EXPRESSION_DEPTH = 64;
export const MAX_SCRIPT_ID_LENGTH = 24;
export const MAX_KEYBINDINGS_COUNT = 256;

const STATIC_KEYBINDING_COMMANDS = [
  "sidebar.toggle",
  "sidebar.search",
  "sidebar.activity",
  "sidebar.addProject",
  "sidebar.importThread",
  "space.previous",
  "space.next",
  "space.jump.1",
  "space.jump.2",
  "space.jump.3",
  "space.jump.4",
  "space.jump.5",
  "space.jump.6",
  "space.jump.7",
  "space.jump.8",
  "space.jump.9",
  "terminal.toggle",
  "terminal.split",
  "terminal.splitRight",
  "terminal.splitLeft",
  "terminal.splitDown",
  "terminal.splitUp",
  "terminal.new",
  "terminal.close",
  "terminal.workspace.newFullWidth",
  "terminal.workspace.closeActive",
  "terminal.workspace.terminal",
  "terminal.workspace.chat",
  "browser.toggle",
  "diff.toggle",
  "composer.focus.toggle",
  "modelPicker.toggle",
  "model.next",
  "model.previous",
  "traitsPicker.toggle",
  "settings.usage",
  "chat.new",
  "chat.newLatestProject",
  "chat.newChat",
  "chat.newLocal",
  "chat.newTerminal",
  "chat.newClaude",
  "chat.newCodex",
  "chat.newCursor",
  "chat.split",
  "view.recent.next",
  "view.recent.previous",
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
  "chat.visible.next",
  "chat.visible.previous",
  "editor.openFavorite",
  "git.commitAndPush",
] as const;

// Shared list of numbered thread-jump commands used by the web shortcut UI.
export const THREAD_JUMP_KEYBINDING_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const;
export type ThreadJumpKeybindingCommand = (typeof THREAD_JUMP_KEYBINDING_COMMANDS)[number];

// Shared list of numbered space-jump commands used by the web shortcut UI. Index 0 is
// the first tab in the space strip (Void), matching the visual order of the switcher.
export const SPACE_JUMP_KEYBINDING_COMMANDS = [
  "space.jump.1",
  "space.jump.2",
  "space.jump.3",
  "space.jump.4",
  "space.jump.5",
  "space.jump.6",
  "space.jump.7",
  "space.jump.8",
  "space.jump.9",
] as const;
export type SpaceJumpKeybindingCommand = (typeof SPACE_JUMP_KEYBINDING_COMMANDS)[number];

export const SCRIPT_RUN_COMMAND_PATTERN = Schema.TemplateLiteral([
  Schema.Literal("script."),
  Schema.NonEmptyString.check(
    Schema.isMaxLength(MAX_SCRIPT_ID_LENGTH),
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  ),
  Schema.Literal(".run"),
]);

export const KeybindingCommand = Schema.Union([
  Schema.Literals(STATIC_KEYBINDING_COMMANDS),
  SCRIPT_RUN_COMMAND_PATTERN,
]);
export type KeybindingCommand = typeof KeybindingCommand.Type;

const KeybindingValue = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_VALUE_LENGTH),
);

const KeybindingWhen = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_WHEN_LENGTH),
);
export const KeybindingRule = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});
export type KeybindingRule = typeof KeybindingRule.Type;

export const KeybindingsConfig = Schema.Array(KeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type KeybindingsConfig = typeof KeybindingsConfig.Type;

export const KeybindingShortcut = Schema.Struct({
  key: KeybindingValue,
  metaKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
  altKey: Schema.Boolean,
  modKey: Schema.Boolean,
});
export type KeybindingShortcut = typeof KeybindingShortcut.Type;

export const KeybindingWhenNode: Schema.Schema<KeybindingWhenNode> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("identifier"),
    name: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("not"),
    node: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
  }),
  Schema.Struct({
    type: Schema.Literal("and"),
    left: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
    right: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
  }),
  Schema.Struct({
    type: Schema.Literal("or"),
    left: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
    right: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
  }),
]);
export type KeybindingWhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: KeybindingWhenNode }
  | { type: "and"; left: KeybindingWhenNode; right: KeybindingWhenNode }
  | { type: "or"; left: KeybindingWhenNode; right: KeybindingWhenNode };

export const ResolvedKeybindingRule = Schema.Struct({
  command: KeybindingCommand,
  shortcut: KeybindingShortcut,
  whenAst: Schema.optional(KeybindingWhenNode),
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
export type ResolvedKeybindingRule = typeof ResolvedKeybindingRule.Type;

export const ResolvedKeybindingsConfig = Schema.Array(ResolvedKeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type ResolvedKeybindingsConfig = typeof ResolvedKeybindingsConfig.Type;
