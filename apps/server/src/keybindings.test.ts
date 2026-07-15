import { KeybindingCommand, KeybindingRule, KeybindingsConfig } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { Effect, FileSystem, Layer, Logger, Path, Result, Schema } from "effect";
import { ServerConfig } from "./config";

import {
  DEFAULT_KEYBINDINGS,
  Keybindings,
  KeybindingsConfigError,
  KeybindingsLive,
  ResolvedKeybindingFromConfig,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  parseKeybindingShortcut,
} from "./keybindings";

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const makeKeybindingsLayer = () => {
  return KeybindingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "synara-keybindings-test-",
        }),
      ),
    ),
  );
};

const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* Schema.encodeEffect(KeybindingsConfigJson)(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* Schema.decodeUnknownEffect(KeybindingsConfigJson)(rawConfig);
  });

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("parses shortcuts including plus key", () =>
    Effect.sync(() => {
      assert.deepEqual(parseKeybindingShortcut("mod+j"), {
        key: "j",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
      assert.deepEqual(parseKeybindingShortcut("mod++"), {
        key: "+",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
    }),
  );

  it.effect("defaults sidebar.search to Cmd+K on macOS and Ctrl+K elsewhere", () =>
    Effect.sync(() => {
      const searchDefaults = DEFAULT_KEYBINDINGS.filter(
        (rule) => rule.command === "sidebar.search",
      );
      assert.deepEqual(searchDefaults, [
        { key: "cmd+k", command: "sidebar.search" },
        { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
      ]);
      assert.isUndefined(
        DEFAULT_KEYBINDINGS.find(
          (rule) => rule.command === "sidebar.search" && rule.key === "mod+k",
        ),
      );
    }),
  );

  it.effect("compiles valid rule with parsed when AST", () =>
    Effect.sync(() => {
      const compiled = compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalOpen && !terminalFocus",
      });

      assert.deepEqual(compiled, {
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
    }),
  );

  it.effect("encodes resolved plus-key shortcuts", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(ResolvedKeybindingFromConfig)({
        command: "terminal.toggle",
        shortcut: {
          key: "+",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      });

      assert.equal(encoded.key, "mod++");
      assert.equal(encoded.command, "terminal.toggle");
    }),
  );

  it.effect("rejects invalid rules", () =>
    Effect.sync(() => {
      assert.isNull(
        compileResolvedKeybindingRule({
          key: "mod+shift+d+o",
          command: "terminal.new",
        }),
      );

      assert.isNull(
        compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: "terminalFocus && (",
        }),
      );

      assert.isNull(
        compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: `${"!".repeat(300)}terminalFocus`,
        }),
      );
    }),
  );

  it.effect("bootstraps default keybindings when config file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      assert.isFalse(yield* fs.exists(keybindingsConfigPath));

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("uses defaults in runtime when config is malformed without overriding file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(
        configState.keybindings,
        compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("treats empty object config as empty and heals file on startup sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{}\n");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.deepEqual(
        configState.keybindings,
        compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("treats a whitespace-only config file as empty config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "  \n");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.deepEqual(
        configState.keybindings,
        compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("treats a null config file as empty config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "null");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.deepEqual(
        configState.keybindings,
        compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("unwraps object config with a keybindings array and heals file on startup sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify({ keybindings: [{ key: "mod+9", command: "terminal.toggle" }] }),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "terminal.toggle" && entry.shortcut.key === "9",
        ),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some((entry) => entry.key === "mod+9" && entry.command === "terminal.toggle"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("wraps a single keybinding rule object into a one-entry config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        '{"key":"mod+9","command":"terminal.toggle"}',
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "terminal.toggle" && entry.shortcut.key === "9",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("upserts keybindings on top of an empty object config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{}");

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("ignores invalid entries in runtime and reports them as issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+shift+d+o", command: "terminal.new" },
          { key: "mod+x", command: "invalid.command" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "invalid.command"),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: configState.issues[0]?.message ?? "",
        },
        {
          kind: "keybindings.invalid-entry",
          index: 2,
          message: configState.issues[1]?.message ?? "",
        },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  // Malformed whole-file JSON must not be rewritten on startup (#339 review): the cleaned
  // path is an empty rule set, and writing it would erase the user's file.
  it.effect("does not rewrite malformed keybindings config on startup sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      const malformed = "{ not-json";
      yield* fs.writeFileString(keybindingsConfigPath, malformed);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      assert.equal(yield* fs.readFileString(keybindingsConfigPath), malformed);

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.equal(configState.issues[0]?.kind, "keybindings.malformed-config");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  // Regression for #330: invalid/retired entries used to skip startup rewrite forever,
  // so the Invalid keybindings toast reappeared on every launch.
  it.effect("rewrites invalid and retired keybindings on startup so issues do not persist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+b", command: "rightPanel.toggle" },
          { key: "mod+shift+\\", command: "terminal.splitVertical" },
          { key: "mod+p", command: "preview.toggle" },
          { key: "mod+x", command: "invalid.command" },
        ]),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const afterSync = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(afterSync.issues, []);
      assert.isTrue(afterSync.keybindings.some((entry) => entry.command === "terminal.toggle"));
      assert.isTrue(
        afterSync.keybindings.some(
          (entry) => entry.command === "browser.toggle" && entry.shortcut.key === "b",
        ),
      );
      assert.isTrue(afterSync.keybindings.some((entry) => entry.command === "terminal.split"));
      assert.isFalse(
        afterSync.keybindings.some((entry) => String(entry.command) === "preview.toggle"),
      );
      assert.isFalse(
        afterSync.keybindings.some((entry) => String(entry.command) === "invalid.command"),
      );

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(persisted.some((entry) => entry.command === "terminal.toggle"));
      assert.isTrue(
        persisted.some((entry) => entry.key === "mod+b" && entry.command === "browser.toggle"),
      );
      assert.isTrue(
        persisted.some(
          (entry) => entry.key === "mod+shift+\\" && entry.command === "terminal.split",
        ),
      );
      assert.isFalse(persisted.some((entry) => String(entry.command) === "preview.toggle"));
      assert.isFalse(persisted.some((entry) => String(entry.command) === "invalid.command"));
      assert.isFalse(persisted.some((entry) => String(entry.command) === "rightPanel.toggle"));
      assert.isFalse(persisted.some((entry) => String(entry.command) === "terminal.splitVertical"));

      // Second load after rewrite stays clean (no recurring toast source).
      const secondLoad = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(secondLoad.issues, []);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("migrates legacy command palette keybindings without startup issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([{ key: "mod+shift+p", command: "commandPalette.toggle" }]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(configState.issues, []);
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "sidebar.search" && entry.shortcut.key === "p",
        ),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) => entry.key === "mod+shift+p" && entry.command === "sidebar.search",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("migrates old recent-view defaults to work with terminal focus", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "ctrl+tab", command: "view.recent.next", when: "!terminalFocus" },
        { key: "ctrl+shift+tab", command: "view.recent.previous", when: "!terminalFocus" },
      ]);

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      const next = configState.keybindings.find((entry) => entry.command === "view.recent.next");
      const previous = configState.keybindings.find(
        (entry) => entry.command === "view.recent.previous",
      );
      assert.isUndefined(next?.whenAst);
      assert.isUndefined(previous?.whenAst);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "ctrl+tab" &&
            entry.command === "view.recent.next" &&
            entry.when === undefined,
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "ctrl+shift+tab" &&
            entry.command === "view.recent.previous" &&
            entry.when === undefined,
        ),
      );
      assert.isFalse(
        persisted.some(
          (entry) => entry.command === "view.recent.next" && entry.when === "!terminalFocus",
        ),
      );
      assert.isFalse(
        persisted.some(
          (entry) => entry.command === "view.recent.previous" && entry.when === "!terminalFocus",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("migrates the old sidebar search default without preserving macOS Ctrl+K", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+k", command: "sidebar.search" },
      ]);

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      const searchBindings = configState.keybindings.filter(
        (entry) => entry.command === "sidebar.search",
      );
      assert.deepEqual(
        searchBindings.map((entry) => ({
          shortcut: entry.shortcut,
          whenAst: entry.whenAst,
        })),
        [
          {
            shortcut: {
              key: "k",
              metaKey: true,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: false,
            },
            whenAst: undefined,
          },
          {
            shortcut: {
              key: "k",
              metaKey: false,
              ctrlKey: true,
              shiftKey: false,
              altKey: false,
              modKey: false,
            },
            whenAst: { type: "not", node: { type: "identifier", name: "isMac" } },
          },
        ],
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "sidebar.search"),
        [
          { key: "cmd+k", command: "sidebar.search" },
          { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
        ],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("preserves new-chat Cmd/Option/N while relaxing its terminal guard", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      // Existing configs already persisted the old shipped keys. Startup should only
      // relax the creation guard; it must not move new-chat away from Cmd/Option/N.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+o", command: "sidebar.addProject", when: "!terminalFocus" },
        { key: "mod+alt+n", command: "chat.newChat", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+shift+o" &&
            entry.command === "sidebar.addProject" &&
            entry.when === "!terminalFocus",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+alt+n" &&
            entry.command === "chat.newChat" &&
            entry.when === "!terminalFocus || isMac",
        ),
      );
      assert.isFalse(
        persisted.some((entry) => entry.key === "mod+shift+o" && entry.command === "chat.newChat"),
      );
      assert.isFalse(
        persisted.some(
          (entry) => entry.key === "mod+shift+p" && entry.command === "sidebar.addProject",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("relaxes creation-command terminal guards so macOS can create from the terminal", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      // A config still carrying the old bare `!terminalFocus` guard on creation commands,
      // including one the user rebound to a custom key, plus a non-creation command.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+shift+k", command: "chat.newTerminal", when: "!terminalFocus" },
        { key: "mod+shift+u", command: "settings.usage", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      // Creation commands gain the `|| isMac` escape hatch, even on a rebound key.
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+n" &&
            entry.command === "chat.new" &&
            entry.when === "!terminalFocus || isMac",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+shift+k" &&
            entry.command === "chat.newTerminal" &&
            entry.when === "!terminalFocus || isMac",
        ),
      );
      // Non-creation commands keep their original guard untouched.
      assert.isTrue(
        persisted.some(
          (entry) => entry.command === "settings.usage" && entry.when === "!terminalFocus",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("accepts synced composer picker keybindings without startup issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+shift+m", command: "modelPicker.toggle" },
          { key: "mod+shift+e", command: "effortPicker.toggle" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(configState.issues, []);
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "modelPicker.toggle" && entry.shortcut.key === "m",
        ),
      );
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "traitsPicker.toggle" && entry.shortcut.key === "e",
        ),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) => entry.key === "mod+shift+m" && entry.command === "modelPicker.toggle",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) => entry.key === "mod+shift+e" && entry.command === "traitsPicker.toggle",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("drops retired legacy keybindings without startup issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+1", command: "modelPicker.jump.1" },
          { key: "mod+2", command: "composer.modelPicker.jump.2" },
          { key: "mod+alt+g", command: "chat.newGemini" },
          { key: "mod+k", command: "sidebar.search" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(configState.issues, []);
      assert.isFalse(
        configState.keybindings.some((entry) =>
          String(entry.command).includes("modelPicker.jump."),
        ),
      );
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "chat.newGemini"),
      );
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "modelPicker.toggle" && entry.shortcut.key === "m",
        ),
      );
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "thread.jump.1" && entry.shortcut.key === "1",
        ),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(
        persisted.some((entry) => String(entry.command).includes("modelPicker.jump.")),
      );
      assert.isFalse(persisted.some((entry) => String(entry.command) === "chat.newGemini"));
      assert.isFalse(
        persisted.some((entry) => entry.command === "modelPicker.toggle" && entry.key === "mod+1"),
      );
      assert.isTrue(
        persisted.some(
          (entry) => entry.key === "mod+shift+m" && entry.command === "modelPicker.toggle",
        ),
      );
      assert.isTrue(
        persisted.some((entry) => entry.key === "mod+1" && entry.command === "thread.jump.1"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect(
    "upserts missing default keybindings on startup without overriding existing command rules",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+shift+t", command: "terminal.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
        ]);

        yield* Effect.gen(function* () {
          const keybindings = yield* Keybindings;
          yield* keybindings.syncDefaultKeybindingsOnStartup;
        });

        const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
        const byCommand = new Map(persisted.map((entry) => [entry.command, entry]));

        const persistedToggle = byCommand.get("terminal.toggle");
        assert.isNotNull(persistedToggle);
        assert.equal(persistedToggle?.key, "mod+shift+t");
        assert.isFalse(
          persisted.some((entry) => entry.command === "terminal.toggle" && entry.key === "mod+j"),
        );

        const persistedNewTerminalThread = byCommand.get("chat.newTerminal");
        assert.isNotNull(persistedNewTerminalThread);
        assert.equal(persistedNewTerminalThread?.key, "mod+shift+t");

        for (const defaultRule of DEFAULT_KEYBINDINGS) {
          assert.isTrue(byCommand.has(defaultRule.command), `expected ${defaultRule.command}`);
        }
        assert.isTrue(byCommand.has("script.run-tests.run"));
      }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("skips conflicting default keybindings on startup and logs a detailed warning", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "script.custom-action.run" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "terminal.toggle"));
      assert.isTrue(persisted.some((entry) => entry.command === "script.custom-action.run"));

      assert.isTrue(
        messages.some((message) =>
          message.includes("skipping default keybinding due to shortcut conflict"),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeKeybindingsLayer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("upserts custom keybindings to configured path", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const resolved = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));

      assert.deepEqual(persistedView, [
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      assert.isTrue(resolved.some((entry) => entry.command === "script.run-tests.run"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("replaces existing custom keybinding for the same command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assert.isTrue(Result.isFailure(result));
      assert.match(Result.isFailure(result) ? result.failure : "", /^expected JSON array/);

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("reports non-array config parse errors without duplicate prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, '{"keybindings":{"key":"mod+j"}}');

      const firstResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(firstResult, "expected JSON array, got object");

      const secondResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(secondResult, "expected JSON array, got object");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("fails when config directory is not writable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      const { dirname } = yield* Path.Path;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);
      yield* fs.chmod(dirname(keybindingsConfigPath), 0o500);

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "failed to write keybindings config");

      yield* fs.chmod(dirname(keybindingsConfigPath), 0o700);

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+j", command: "terminal.toggle" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("caches loaded resolved config across repeated reads", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const [first, second] = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        const firstLoad = (yield* keybindings.loadConfigState).keybindings;
        const secondLoad = (yield* keybindings.loadConfigState).keybindings;
        return [firstLoad, secondLoad] as const;
      });

      assert.deepEqual(first, second);
      assert.isTrue(second.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("updates cached resolved config after upsert", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const loadedAfterUpsert = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.loadConfigState;
        yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
        return (yield* keybindings.loadConfigState).keybindings;
      });

      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "script.run-tests.run"));
      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* Effect.all(
          commands.map((command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          ),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));
      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );
});
