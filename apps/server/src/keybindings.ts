/**
 * Keybindings - Keybinding configuration service definitions.
 *
 * Owns parsing, validation, merge, and persistence of user keybinding
 * configuration consumed by the server runtime.
 *
 * @module Keybindings
 */
import {
  KeybindingRule,
  KeybindingsConfig,
  KeybindingShortcut,
  KeybindingWhenNode,
  MAX_KEYBINDINGS_COUNT,
  MAX_WHEN_EXPRESSION_DEPTH,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
  type ServerConfigIssue,
} from "@synara/contracts";
import { Mutable } from "effect/Types";
import {
  Array,
  Cache,
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Path,
  Layer,
  Option,
  Predicate,
  PubSub,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
  Ref,
  ServiceMap,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "./atomicWrite";
import { ServerConfig } from "./config";

export class KeybindingsConfigError extends Schema.TaggedErrorClass<KeybindingsConfigError>()(
  "KeybindingsConfigParseError",
  {
    configPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unable to parse keybindings config at ${this.configPath}: ${this.detail}`;
  }
}

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

const SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS = [
  // Cmd-only on macOS so Ctrl+K stays available for kill-to-end-of-line.
  // Keep Ctrl+K on Windows/Linux (where `mod` would otherwise be Ctrl).
  { key: "cmd+k", command: "sidebar.search" },
  { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
] as const satisfies ReadonlyArray<KeybindingRule>;

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  ...SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS,
  { key: "mod+shift+o", command: "sidebar.addProject", when: "!terminalFocus" },
  { key: "mod+i", command: "sidebar.importThread", when: "!terminalFocus" },
  { key: "mod+alt+arrowleft", command: "space.previous", when: "!terminalFocus" },
  { key: "mod+alt+arrowright", command: "space.next", when: "!terminalFocus" },
  // Numbered space jumps address tabs in the switcher's visual order, so mod+alt+1 is
  // always Void. Same `|| isMac` escape hatch as the new-surface chords below: Cmd
  // chords never reach the PTY on macOS, while Ctrl+Alt+digit is AltGr territory on
  // Linux/Windows layouts and must keep yielding to focused terminals there.
  { key: "mod+alt+1", command: "space.jump.1", when: "!terminalFocus || isMac" },
  { key: "mod+alt+2", command: "space.jump.2", when: "!terminalFocus || isMac" },
  { key: "mod+alt+3", command: "space.jump.3", when: "!terminalFocus || isMac" },
  { key: "mod+alt+4", command: "space.jump.4", when: "!terminalFocus || isMac" },
  { key: "mod+alt+5", command: "space.jump.5", when: "!terminalFocus || isMac" },
  { key: "mod+alt+6", command: "space.jump.6", when: "!terminalFocus || isMac" },
  { key: "mod+alt+7", command: "space.jump.7", when: "!terminalFocus || isMac" },
  { key: "mod+alt+8", command: "space.jump.8", when: "!terminalFocus || isMac" },
  { key: "mod+alt+9", command: "space.jump.9", when: "!terminalFocus || isMac" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+arrowright", command: "terminal.splitRight", when: "terminalFocus" },
  { key: "mod+shift+arrowleft", command: "terminal.splitLeft", when: "terminalFocus" },
  { key: "mod+shift+arrowdown", command: "terminal.splitDown", when: "terminalFocus" },
  { key: "mod+shift+arrowup", command: "terminal.splitUp", when: "terminalFocus" },
  // Reserve Cmd/Ctrl+T for the terminal workspace's "new tab" action while focused.
  { key: "mod+t", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+shift+j", command: "terminal.workspace.newFullWidth" },
  { key: "mod+w", command: "terminal.workspace.closeActive", when: "terminalWorkspaceOpen" },
  { key: "mod+1", command: "terminal.workspace.terminal", when: "terminalWorkspaceOpen" },
  { key: "mod+2", command: "terminal.workspace.chat", when: "terminalWorkspaceOpen" },
  { key: "mod+shift+b", command: "browser.toggle", when: "!terminalFocus" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  // Cmd-only instead of mod so Ctrl+L remains available to shells on non-macOS.
  { key: "cmd+l", command: "composer.focus.toggle", when: "!terminalFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  // Cycle models within the active provider (favorites first, then remaining list).
  { key: "alt+]", command: "model.next", when: "!terminalFocus" },
  { key: "alt+[", command: "model.previous", when: "!terminalFocus" },
  { key: "mod+shift+e", command: "traitsPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+u", command: "settings.usage", when: "!terminalFocus" },
  // New thread (chat.new) is the primary create action; it falls back to the most
  // recent project when no project is active.
  //
  // These new-surface chords use `!terminalFocus || isMac`: on macOS `mod` is Cmd and
  // xterm never forwards a Cmd-chord to the PTY, so the bare `!terminalFocus` guard just
  // dropped the chord while the terminal had focus (you couldn't open a new chat/terminal
  // from the terminal). The `|| isMac` escape hatch fires them on macOS regardless of
  // focus, while Linux/Windows keep `!terminalFocus` so Ctrl-chords still reach the shell.
  { key: "mod+n", command: "chat.new", when: "!terminalFocus || isMac" },
  { key: "mod+shift+n", command: "chat.newLatestProject", when: "!terminalFocus || isMac" },
  { key: "mod+alt+n", command: "chat.newChat", when: "!terminalFocus || isMac" },
  { key: "mod+shift+t", command: "chat.newTerminal", when: "!terminalFocus || isMac" },
  { key: "mod+alt+c", command: "chat.newClaude", when: "!terminalFocus || isMac" },
  { key: "mod+alt+x", command: "chat.newCodex", when: "!terminalFocus || isMac" },
  { key: "mod+alt+r", command: "chat.newCursor", when: "!terminalFocus || isMac" },
  { key: "mod+\\", command: "chat.split", when: "!terminalFocus || isMac" },
  // Recent-view switcher (Ctrl+Tab) is an installed-app feature only: Electron and
  // standalone PWA windows have no tab strip, so the chord reaches the page. It remains
  // app-level even with terminal focus; the web route captures it before xterm input.
  { key: "ctrl+tab", command: "view.recent.next" },
  { key: "ctrl+shift+tab", command: "view.recent.previous" },
  { key: "mod+1", command: "thread.jump.1", when: "!terminalFocus && !terminalWorkspaceOpen" },
  { key: "mod+2", command: "thread.jump.2", when: "!terminalFocus && !terminalWorkspaceOpen" },
  { key: "mod+3", command: "thread.jump.3", when: "!terminalFocus && !terminalWorkspaceOpen" },
  { key: "mod+4", command: "thread.jump.4", when: "!terminalFocus && !terminalWorkspaceOpen" },
  { key: "mod+5", command: "thread.jump.5", when: "!terminalFocus && !terminalWorkspaceOpen" },
  { key: "mod+6", command: "thread.jump.6", when: "!terminalFocus && !terminalWorkspaceOpen" },
  { key: "mod+7", command: "thread.jump.7", when: "!terminalFocus && !terminalWorkspaceOpen" },
  { key: "mod+8", command: "thread.jump.8", when: "!terminalFocus && !terminalWorkspaceOpen" },
  { key: "mod+9", command: "thread.jump.9", when: "!terminalFocus && !terminalWorkspaceOpen" },
  { key: "mod+shift+]", command: "chat.visible.next", when: "!terminalFocus" },
  { key: "mod+shift+[", command: "chat.visible.previous", when: "!terminalFocus" },
  { key: "mod+o", command: "editor.openFavorite" },
];

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

/** @internal - Exported for testing */
export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

/** @internal - Exported for testing */
export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
    if (!whenAst) return null;
    return {
      command: rule.command,
      shortcut,
      whenAst,
    };
  }

  return {
    command: rule.command,
    shortcut,
  };
}

export function compileResolvedKeybindingsConfig(
  config: KeybindingsConfig,
): ResolvedKeybindingsConfig {
  const compiled: Mutable<ResolvedKeybindingsConfig> = [];
  for (const rule of config) {
    const result = Schema.decodeExit(ResolvedKeybindingFromConfig)(rule);
    if (result._tag === "Success") {
      compiled.push(result.value);
    }
  }
  return compiled;
}

export const ResolvedKeybindingFromConfig = KeybindingRule.pipe(
  Schema.decodeTo(
    Schema.toType(ResolvedKeybindingRule),
    SchemaTransformation.transformOrFail({
      decode: (rule) =>
        Effect.succeed(compileResolvedKeybindingRule(rule)).pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () =>
              new SchemaIssue.InvalidValue(Option.some(rule), {
                title: "Invalid keybinding rule",
              }),
          ),
          Effect.map((resolved) => resolved),
        ),

      encode: (resolved) =>
        Effect.gen(function* () {
          const key = encodeShortcut(resolved.shortcut);
          if (!key) {
            return yield* Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(resolved), {
                title: "Resolved shortcut cannot be encoded to key string",
              }),
            );
          }

          const when = resolved.whenAst ? encodeWhenAst(resolved.whenAst) : undefined;
          return {
            key,
            command: resolved.command,
            when,
          };
        }),
    }),
  ),
);

export const ResolvedKeybindingsFromConfig = Schema.Array(ResolvedKeybindingFromConfig).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);

function isSameKeybindingRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return (
    left.command === right.command &&
    left.key === right.key &&
    (left.when ?? undefined) === (right.when ?? undefined)
  );
}

function keybindingShortcutContext(rule: KeybindingRule): string | null {
  const parsed = parseKeybindingShortcut(rule.key);
  if (!parsed) return null;
  const encoded = encodeShortcut(parsed);
  if (!encoded) return null;
  return `${encoded}\u0000${rule.when ?? ""}`;
}

function hasSameShortcutContext(left: KeybindingRule, right: KeybindingRule): boolean {
  const leftContext = keybindingShortcutContext(left);
  const rightContext = keybindingShortcutContext(right);
  if (!leftContext || !rightContext) return false;
  return leftContext === rightContext;
}

function encodeShortcut(shortcut: KeybindingShortcut): string | null {
  const modifiers: string[] = [];
  if (shortcut.modKey) modifiers.push("mod");
  if (shortcut.metaKey) modifiers.push("meta");
  if (shortcut.ctrlKey) modifiers.push("ctrl");
  if (shortcut.altKey) modifiers.push("alt");
  if (shortcut.shiftKey) modifiers.push("shift");
  if (!shortcut.key) return null;
  if (shortcut.key !== "+" && shortcut.key.includes("+")) return null;
  const key = shortcut.key === " " ? "space" : shortcut.key;
  return [...modifiers, key].join("+");
}

function encodeWhenAst(node: KeybindingWhenNode): string {
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${encodeWhenAst(node.node)})`;
    case "and":
      return `(${encodeWhenAst(node.left)} && ${encodeWhenAst(node.right)})`;
    case "or":
      return `(${encodeWhenAst(node.left)} || ${encodeWhenAst(node.right)})`;
  }
}

const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

/**
 * Result of normalizing the raw on-disk keybindings config into a list of entries.
 *
 * `migratedShape: true` marks tolerated non-canonical top-level shapes (empty file,
 * `null`, `{}`, `{"keybindings": [...]}`, or a single rule object) so callers can
 * rewrite the file into the canonical JSON-array form instead of surfacing an error
 * on every startup.
 */
type RawKeybindingsEntriesResult =
  | {
      readonly _tag: "success";
      readonly entries: ReadonlyArray<unknown>;
      readonly migratedShape: boolean;
    }
  | { readonly _tag: "failure"; readonly detail: string };

function describeJsonValueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function decodeRawKeybindingsEntries(rawConfig: string): RawKeybindingsEntriesResult {
  if (rawConfig.trim().length === 0) {
    return { _tag: "success", entries: [], migratedShape: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    return { _tag: "failure", detail: `expected JSON array (${String(error)})` };
  }

  if (Array.isArray(parsed)) {
    return { _tag: "success", entries: parsed, migratedShape: false };
  }
  if (parsed === null) {
    return { _tag: "success", entries: [], migratedShape: true };
  }
  if (typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.keybindings)) {
      return { _tag: "success", entries: record.keybindings, migratedShape: true };
    }
    if (Object.keys(record).length === 0) {
      return { _tag: "success", entries: [], migratedShape: true };
    }
    if (typeof record.key === "string" && typeof record.command === "string") {
      return { _tag: "success", entries: [record], migratedShape: true };
    }
  }
  return {
    _tag: "failure",
    detail: `expected JSON array, got ${describeJsonValueShape(parsed)}`,
  };
}

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const PrettyJsonString = SchemaGetter.parseJson<string>().compose(
  SchemaGetter.stringifyJson({ space: 2 }),
);
const KeybindingsConfigPrettyJson = KeybindingsConfigJson.pipe(
  Schema.encode({
    decode: PrettyJsonString,
    encode: PrettyJsonString,
  }),
);

export interface KeybindingsConfigState {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export interface KeybindingsChangeEvent {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid keybindings configuration.";
}

function malformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.malformed-config",
    message: trimIssueMessage(detail),
  };
}

function invalidEntryIssue(index: number, detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.invalid-entry",
    index,
    message: trimIssueMessage(detail),
  };
}

const LEGACY_KEYBINDING_COMMAND_ALIASES = {
  "commandPalette.toggle": "sidebar.search",
  "composer.effortPicker.toggle": "traitsPicker.toggle",
  "composer.modelPicker.toggle": "modelPicker.toggle",
  "effortPicker.toggle": "traitsPicker.toggle",
  "reasoningPicker.toggle": "traitsPicker.toggle",
  "thread.previous": "chat.visible.previous",
  "thread.next": "chat.visible.next",
  // Pre-rename dock/panel commands still present in older userdata configs.
  "rightPanel.toggle": "browser.toggle",
  "terminal.splitVertical": "terminal.split",
} as const satisfies Record<string, KeybindingRule["command"]>;

// Commands removed without a direct replacement are dropped during startup so
// persisted configs from older releases do not produce validation warnings / toasts (#330).
const RETIRED_LEGACY_KEYBINDING_COMMANDS = new Set(["chat.newGemini"]);
const RETIRED_LEGACY_KEYBINDING_COMMAND_PATTERN =
  /^(?:composer\.)?modelPicker\.jump\.[1-9]$|^preview\.(?:toggle|refresh|focusUrl|zoomIn|zoomOut|resetZoom)$/;
const OUTDATED_RECENT_VIEW_TERMINAL_GUARD = "!terminalFocus";
const OUTDATED_SIDEBAR_SEARCH_SHORTCUT = "mod+k";
const RECENT_VIEW_SHORTCUT_BY_COMMAND: Partial<Record<KeybindingRule["command"], string>> = {
  "view.recent.next": "ctrl+tab",
  "view.recent.previous": "ctrl+shift+tab",
};

// New-surface creation commands shipped guarded by a bare `!terminalFocus`. On macOS
// `mod` is Cmd and xterm never forwards a Cmd-chord to the PTY, so that guard silently
// dropped "new chat/terminal" chords whenever the terminal had focus. The relaxed guard
// adds an `|| isMac` escape hatch (see DEFAULT_KEYBINDINGS) so the chord fires on macOS
// regardless of focus while Linux/Windows keep yielding Ctrl-chords to the shell.
const OUTDATED_CREATION_TERMINAL_GUARD = "!terminalFocus";
const RELAXED_CREATION_TERMINAL_GUARD = "!terminalFocus || isMac";
const CREATION_COMMANDS_WITH_TERMINAL_ESCAPE = new Set<KeybindingRule["command"]>([
  "chat.new",
  "chat.newLatestProject",
  "chat.newChat",
  "chat.newLocal",
  "chat.newTerminal",
  "chat.newClaude",
  "chat.newCodex",
  "chat.newCursor",
  "chat.split",
]);

function readKeybindingEntryCommand(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }

  const command = (entry as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function isRetiredLegacyKeybindingCommand(command: string): boolean {
  return (
    RETIRED_LEGACY_KEYBINDING_COMMANDS.has(command) ||
    RETIRED_LEGACY_KEYBINDING_COMMAND_PATTERN.test(command)
  );
}

// Cross-device configs can lag behind command renames; normalize known aliases
// before schema validation so stale synced files do not become warning toasts.
function normalizeLegacyKeybindingEntry(entry: unknown): {
  readonly entry: unknown;
  readonly migrated: boolean;
} {
  const command = readKeybindingEntryCommand(entry);
  if (typeof command !== "string" || !(command in LEGACY_KEYBINDING_COMMAND_ALIASES)) {
    return { entry, migrated: false };
  }

  // `readKeybindingEntryCommand` only yields a string command for non-null object
  // entries, so the spread target is guaranteed to be an object here.
  return {
    entry: {
      ...(entry as Record<string, unknown>),
      command:
        LEGACY_KEYBINDING_COMMAND_ALIASES[
          command as keyof typeof LEGACY_KEYBINDING_COMMAND_ALIASES
        ],
    },
    migrated: true,
  };
}

// Update exact old recent-view defaults so existing configs gain terminal-focus support
// (drop the `!terminalFocus` guard). Per-rule because it never changes the key, so it
// cannot collide with a sibling entry.
function migrateOutdatedDefaultKeybindingRule(rule: KeybindingRule): {
  readonly rule: KeybindingRule;
  readonly migrated: boolean;
} {
  const recentViewShortcut = RECENT_VIEW_SHORTCUT_BY_COMMAND[rule.command];
  if (
    recentViewShortcut === undefined ||
    rule.key !== recentViewShortcut ||
    rule.when !== OUTDATED_RECENT_VIEW_TERMINAL_GUARD
  ) {
    return { rule, migrated: false };
  }

  return {
    rule: {
      key: rule.key,
      command: rule.command,
    },
    migrated: true,
  };
}

// The original sidebar search default used `mod+k`, which resolves to Ctrl+K on
// Windows/Linux but also captures the native kill-to-end-of-line chord on macOS.
// Expand only that exact shipped default so other user-defined search chords remain intact.
function migrateOutdatedSidebarSearchDefault(rules: readonly KeybindingRule[]): {
  readonly rules: KeybindingRule[];
  readonly migratedCount: number;
} {
  let migratedCount = 0;
  const next = rules.flatMap((rule) => {
    if (
      rule.command !== "sidebar.search" ||
      rule.key !== OUTDATED_SIDEBAR_SEARCH_SHORTCUT ||
      rule.when !== undefined
    ) {
      return [rule];
    }

    migratedCount += 1;
    return SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS.map((binding) => ({ ...binding }));
  });
  return { rules: next, migratedCount };
}

// Add the `|| isMac` escape hatch to new-surface creation commands still pinned to the
// bare `!terminalFocus` guard, so existing configs gain the macOS terminal-focus fix the
// shipped defaults already carry. Matched on command + exact old guard (not key) so it
// also reaches a creation command the user rebound to a different chord — the guard, not
// the key, is what was too aggressive. Idempotent: once relaxed the guard no longer
// matches the old one.
function relaxCreationCommandTerminalGuards(rules: readonly KeybindingRule[]): {
  readonly rules: KeybindingRule[];
  readonly migratedCount: number;
} {
  let migratedCount = 0;
  const next = rules.map((rule) => {
    if (
      rule.when !== OUTDATED_CREATION_TERMINAL_GUARD ||
      !CREATION_COMMANDS_WITH_TERMINAL_ESCAPE.has(rule.command)
    ) {
      return rule;
    }
    migratedCount += 1;
    return { ...rule, when: RELAXED_CREATION_TERMINAL_GUARD };
  });
  return { rules: next, migratedCount };
}

function mergeWithDefaultKeybindings(custom: ResolvedKeybindingsConfig): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  // Keep the latest rules when the config exceeds max size; later rules have higher precedence.
  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}

/**
 * KeybindingsShape - Service API for keybinding configuration operations.
 */
export interface KeybindingsShape {
  /**
   * Start the keybindings runtime and attach file watching.
   *
   * Safe to call multiple times. The first successful call establishes the
   * runtime; later calls await the same startup.
   */
  readonly start: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Await keybindings runtime readiness.
   *
   * Readiness means the config directory exists, the watcher is attached, the
   * startup sync has completed, and the current snapshot has been loaded.
   */
  readonly ready: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Ensure the on-disk keybindings file exists and includes all default
   * commands so newly-added defaults are backfilled on startup.
   */
  readonly syncDefaultKeybindingsOnStartup: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Load runtime keybindings state along with non-fatal configuration issues.
   */
  readonly loadConfigState: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Read the latest keybindings snapshot from cache/disk.
   */
  readonly getSnapshot: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Stream of keybindings config change events.
   */
  readonly streamChanges: Stream.Stream<KeybindingsChangeEvent>;

  /**
   * Upsert a keybinding rule and persist the resulting configuration.
   *
   * Writes config atomically and enforces the max rule count by truncating
   * oldest entries when needed.
   */
  readonly upsertKeybindingRule: (
    rule: KeybindingRule,
  ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsConfigError>;
}

/**
 * Keybindings - Service tag for keybinding configuration operations.
 */
export class Keybindings extends ServiceMap.Service<Keybindings, KeybindingsShape>()(
  "synara/keybindings",
) {}

const makeKeybindings = Effect.gen(function* () {
  const { keybindingsConfigPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const upsertSemaphore = yield* Semaphore.make(1);
  const resolvedConfigCacheKey = "resolved" as const;
  const changesPubSub = yield* PubSub.unbounded<KeybindingsChangeEvent>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, KeybindingsConfigError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
  const emitChange = (configState: KeybindingsConfigState) =>
    PubSub.publish(changesPubSub, configState).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to access keybindings config",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to read keybindings config",
          cause,
        }),
    ),
  );

  const loadWritableCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    readonly KeybindingRule[],
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return [];
    }

    const rawConfig = yield* readRawConfig;
    const decodedEntries = decodeRawKeybindingsEntries(rawConfig);
    if (decodedEntries._tag === "failure") {
      return yield* new KeybindingsConfigError({
        configPath: keybindingsConfigPath,
        detail: decodedEntries.detail,
      });
    }

    return yield* Effect.forEach(decodedEntries.entries, (entry) =>
      Effect.gen(function* () {
        const command = readKeybindingEntryCommand(entry);
        if (command !== null && isRetiredLegacyKeybindingCommand(command)) {
          return null;
        }

        const normalized = normalizeLegacyKeybindingEntry(entry);
        const decodedRule = Schema.decodeUnknownExit(KeybindingRule)(normalized.entry);
        if (decodedRule._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: keybindingsConfigPath,
            entry,
            error: Cause.pretty(decodedRule.cause),
          });
          return null;
        }
        const resolved = Schema.decodeExit(ResolvedKeybindingFromConfig)(decodedRule.value);
        if (resolved._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: keybindingsConfigPath,
            entry,
            error: Cause.pretty(resolved.cause),
          });
          return null;
        }
        return decodedRule.value;
      }),
    ).pipe(Effect.map(Array.filter(Predicate.isNotNull)));
  });

  const loadRuntimeCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    {
      readonly keybindings: readonly KeybindingRule[];
      readonly issues: readonly ServerConfigIssue[];
      readonly migratedLegacyCommandCount: number;
      readonly migratedDefaultRuleCount: number;
      readonly migratedConfigShape: boolean;
    },
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return {
        keybindings: [],
        issues: [],
        migratedLegacyCommandCount: 0,
        migratedDefaultRuleCount: 0,
        migratedConfigShape: false,
      };
    }

    const rawConfig = yield* readRawConfig;
    const decodedEntries = decodeRawKeybindingsEntries(rawConfig);
    if (decodedEntries._tag === "failure") {
      return {
        keybindings: [],
        issues: [malformedConfigIssue(decodedEntries.detail)],
        migratedLegacyCommandCount: 0,
        migratedDefaultRuleCount: 0,
        migratedConfigShape: false,
      };
    }
    if (decodedEntries.migratedShape) {
      yield* Effect.logWarning("migrating keybindings config with non-array top-level shape", {
        path: keybindingsConfigPath,
      });
    }

    const keybindings: KeybindingRule[] = [];
    const issues: ServerConfigIssue[] = [];
    let migratedLegacyCommandCount = 0;
    let migratedDefaultRuleCount = 0;
    for (const [index, entry] of decodedEntries.entries.entries()) {
      const command = readKeybindingEntryCommand(entry);
      if (command !== null && isRetiredLegacyKeybindingCommand(command)) {
        migratedLegacyCommandCount += 1;
        continue;
      }

      const normalized = normalizeLegacyKeybindingEntry(entry);
      if (normalized.migrated) {
        migratedLegacyCommandCount += 1;
      }
      const decodedRule = Schema.decodeUnknownExit(KeybindingRule)(normalized.entry);
      if (decodedRule._tag === "Failure") {
        const detail = Cause.pretty(decodedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }

      const resolvedRule = Schema.decodeExit(ResolvedKeybindingFromConfig)(decodedRule.value);
      if (resolvedRule._tag === "Failure") {
        const detail = Cause.pretty(resolvedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }
      const migratedDefaultRule = migrateOutdatedDefaultKeybindingRule(decodedRule.value);
      if (migratedDefaultRule.migrated) {
        migratedDefaultRuleCount += 1;
      }
      keybindings.push(migratedDefaultRule.rule);
    }

    const sidebarSearchMigration = migrateOutdatedSidebarSearchDefault(keybindings);
    migratedDefaultRuleCount += sidebarSearchMigration.migratedCount;
    const relaxed = relaxCreationCommandTerminalGuards(sidebarSearchMigration.rules);
    migratedDefaultRuleCount += relaxed.migratedCount;

    return {
      keybindings: relaxed.rules,
      issues,
      migratedLegacyCommandCount,
      migratedDefaultRuleCount,
      migratedConfigShape: decodedEntries.migratedShape,
    };
  });

  const writeConfigAtomically = (rules: readonly KeybindingRule[]) => {
    return Schema.encodeEffect(KeybindingsConfigPrettyJson)(rules).pipe(
      Effect.map((encoded) => `${encoded}\n`),
      Effect.flatMap((encoded) =>
        writeFileStringAtomically({ filePath: keybindingsConfigPath, contents: encoded }),
      ),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to write keybindings config",
            cause,
          }),
      ),
    );
  };

  const loadConfigStateFromDisk = loadRuntimeCustomKeybindingsConfig().pipe(
    Effect.map(({ keybindings, issues }) => ({
      keybindings: mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(keybindings)),
      issues,
    })),
  );

  const resolvedConfigCache = yield* Cache.make<
    typeof resolvedConfigCacheKey,
    KeybindingsConfigState,
    KeybindingsConfigError
  >({
    capacity: 1,
    lookup: () => loadConfigStateFromDisk,
  });

  const loadConfigStateFromCacheOrDisk = Cache.get(resolvedConfigCache, resolvedConfigCacheKey);

  const revalidateAndEmit = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      const configState = yield* loadConfigStateFromCacheOrDisk;
      yield* emitChange(configState);
    }),
  );

  const syncDefaultKeybindingsOnStartup = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const configExists = yield* readConfigExists;
      if (!configExists) {
        yield* writeConfigAtomically(DEFAULT_KEYBINDINGS);
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const runtimeConfig = yield* loadRuntimeCustomKeybindingsConfig();
      // Malformed whole-file configs must not be rewritten: the cleaned path yields an empty
      // rule set, and persisting that would erase the user's file. Only drop invalid *entries*.
      const hasMalformedConfig = runtimeConfig.issues.some(
        (issue) => issue.kind === "keybindings.malformed-config",
      );
      if (hasMalformedConfig) {
        yield* Effect.logWarning(
          "skipping startup keybindings default sync because config is malformed",
          {
            path: keybindingsConfigPath,
            issues: runtimeConfig.issues,
          },
        );
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      // Always continue from the cleaned/migrated rule set for invalid entries / aliases (#330).
      const customConfig = runtimeConfig.keybindings;
      const droppedInvalidCount = runtimeConfig.issues.filter(
        (issue) => issue.kind === "keybindings.invalid-entry",
      ).length;
      if (droppedInvalidCount > 0) {
        yield* Effect.logWarning("dropping invalid keybinding entries from user config", {
          path: keybindingsConfigPath,
          issueCount: droppedInvalidCount,
          issues: runtimeConfig.issues,
          retainedRuleCount: customConfig.length,
        });
      }
      const existingCommands = new Set(customConfig.map((entry) => entry.command));
      const missingDefaults: KeybindingRule[] = [];
      const shortcutConflictWarnings: Array<{
        defaultCommand: KeybindingRule["command"];
        conflictingCommand: KeybindingRule["command"];
        key: string;
        when: string | null;
      }> = [];
      for (const defaultRule of DEFAULT_KEYBINDINGS) {
        if (existingCommands.has(defaultRule.command)) {
          continue;
        }
        const conflictingEntry = customConfig.find((entry) =>
          hasSameShortcutContext(entry, defaultRule),
        );
        if (conflictingEntry) {
          shortcutConflictWarnings.push({
            defaultCommand: defaultRule.command,
            conflictingCommand: conflictingEntry.command,
            key: defaultRule.key,
            when: defaultRule.when ?? null,
          });
          continue;
        }
        missingDefaults.push(defaultRule);
      }
      for (const conflict of shortcutConflictWarnings) {
        yield* Effect.logWarning("skipping default keybinding due to shortcut conflict", {
          path: keybindingsConfigPath,
          defaultCommand: conflict.defaultCommand,
          conflictingCommand: conflict.conflictingCommand,
          key: conflict.key,
          when: conflict.when,
          reason: "shortcut context already used by existing rule",
        });
      }

      const migratedKeybindingCount =
        runtimeConfig.migratedLegacyCommandCount + runtimeConfig.migratedDefaultRuleCount;
      const shouldRewrite =
        droppedInvalidCount > 0 ||
        migratedKeybindingCount > 0 ||
        runtimeConfig.migratedConfigShape ||
        missingDefaults.length > 0;

      if (!shouldRewrite) {
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      if (missingDefaults.length > 0) {
        const matchingDefaults = DEFAULT_KEYBINDINGS.filter((defaultRule) =>
          customConfig.some((entry) => isSameKeybindingRule(entry, defaultRule)),
        ).map((rule) => rule.command);
        if (matchingDefaults.length > 0) {
          yield* Effect.logWarning("default keybinding rule already defined in user config", {
            path: keybindingsConfigPath,
            commands: matchingDefaults,
          });
        }
      }

      const nextConfig = [...customConfig, ...missingDefaults];
      const cappedConfig =
        nextConfig.length > MAX_KEYBINDINGS_COUNT
          ? nextConfig.slice(-MAX_KEYBINDINGS_COUNT)
          : nextConfig;
      if (nextConfig.length > MAX_KEYBINDINGS_COUNT) {
        yield* Effect.logWarning("truncating keybindings config to max entries", {
          path: keybindingsConfigPath,
          maxEntries: MAX_KEYBINDINGS_COUNT,
        });
      }

      if (migratedKeybindingCount > 0) {
        yield* Effect.logInfo("migrated keybinding config entries", {
          path: keybindingsConfigPath,
          count: migratedKeybindingCount,
        });
      }
      if (droppedInvalidCount > 0) {
        yield* Effect.logInfo("rewrote keybindings config without invalid entries", {
          path: keybindingsConfigPath,
          droppedIssueCount: droppedInvalidCount,
          retainedRuleCount: customConfig.length,
        });
      }
      yield* writeConfigAtomically(cappedConfig);
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const keybindingsConfigDir = path.dirname(keybindingsConfigPath);
    const keybindingsConfigFile = path.basename(keybindingsConfigPath);
    const keybindingsConfigPathResolved = path.resolve(keybindingsConfigPath);

    yield* fs.makeDirectory(keybindingsConfigDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to prepare keybindings config directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    yield* Stream.runForEach(fs.watch(keybindingsConfigDir), (event) => {
      const isTargetConfigEvent =
        event.path === keybindingsConfigFile ||
        event.path === keybindingsConfigPath ||
        path.resolve(keybindingsConfigDir, event.path) === keybindingsConfigPathResolved;
      if (!isTargetConfigEvent) {
        return Effect.void;
      }
      return revalidateAndEmitSafely;
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope), Effect.asVoid);
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* syncDefaultKeybindingsOnStartup;
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      yield* loadConfigStateFromCacheOrDisk;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    syncDefaultKeybindingsOnStartup,
    loadConfigState: loadConfigStateFromCacheOrDisk,
    getSnapshot: loadConfigStateFromCacheOrDisk,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    upsertKeybindingRule: (rule) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const nextConfig = [
            ...customConfig.filter((entry) => entry.command !== rule.command),
            rule,
          ];
          const cappedConfig =
            nextConfig.length > MAX_KEYBINDINGS_COUNT
              ? nextConfig.slice(-MAX_KEYBINDINGS_COUNT)
              : nextConfig;
          if (nextConfig.length > MAX_KEYBINDINGS_COUNT) {
            yield* Effect.logWarning("truncating keybindings config to max entries", {
              path: keybindingsConfigPath,
              maxEntries: MAX_KEYBINDINGS_COUNT,
            });
          }
          yield* writeConfigAtomically(cappedConfig);
          const nextResolved = mergeWithDefaultKeybindings(
            compileResolvedKeybindingsConfig(cappedConfig),
          );
          yield* Cache.set(resolvedConfigCache, resolvedConfigCacheKey, {
            keybindings: nextResolved,
            issues: [],
          });
          yield* emitChange({
            keybindings: nextResolved,
            issues: [],
          });
          return nextResolved;
        }),
      ),
  } satisfies KeybindingsShape;
});

export const KeybindingsLive = Layer.effect(Keybindings, makeKeybindings);
