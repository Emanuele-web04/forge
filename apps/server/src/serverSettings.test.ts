import * as NodeServices from "@effect/platform-node/NodeServices";
import { dirname } from "node:path";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL, DEFAULT_MODEL_BY_PROVIDER } from "@synara/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-settings-test-",
}).pipe(Layer.provide(NodeServices.layer));
const makeTestLayer = Layer.merge(NodeServices.layer, serverConfigLayer);
const testLayer = Layer.merge(makeTestLayer, ServerSettingsLive.pipe(Layer.provide(makeTestLayer)));

const runWithSettings = <A, E>(
  effect: Effect.Effect<A, E, ServerSettingsService | ServerConfig | FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

describe("ServerSettingsService", () => {
  it("loads defaults when settings file does not exist", async () => {
    const settings = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.start;
        return yield* service.getSettings;
      }),
    );

    expect(settings.providers.codex.binaryPath).toBe("codex");
    expect(settings.providers.grok.binaryPath).toBe("grok");
    expect(settings.defaultThreadEnvMode).toBe("local");
    expect(settings.enableProviderUpdateChecks).toBe(true);
  });

  it("persists updates and reloads them", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;

        const updated = yield* service.updateSettings({
          enableAssistantStreaming: true,
          enableProviderUpdateChecks: false,
          providers: {
            codex: {
              enabled: false,
              binaryPath: "/usr/local/bin/codex",
              customModels: ["gpt-custom"],
            },
          },
        });
        const raw = yield* fs.readFileString(settingsPath);
        return { updated, parsed: JSON.parse(raw) as unknown };
      }),
    );

    expect(result.updated.enableAssistantStreaming).toBe(true);
    expect(result.updated.enableProviderUpdateChecks).toBe(false);
    expect(result.updated.providers.codex.enabled).toBe(false);
    expect(result.updated.providers.codex.binaryPath).toBe("/usr/local/bin/codex");
    expect(result.parsed).toMatchObject({
      revision: 1,
      migrationVersion: 2,
      settings: {
        enableAssistantStreaming: true,
        enableProviderUpdateChecks: false,
        providers: {
          codex: {
            enabled: false,
            binaryPath: "/usr/local/bin/codex",
            customModels: ["gpt-custom"],
          },
        },
      },
    });
  });

  it("migrates the previous Git writing default to GPT-5.6 Luna", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(dirname(settingsPath), { recursive: true });
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            revision: 7,
            migrationVersion: 1,
            settings: {
              textGenerationModelSelection: {
                provider: "codex",
                model: "gpt-5.4-mini",
              },
            },
          }),
        );

        yield* service.start;
        const settings = yield* service.getSettings;
        const persisted = JSON.parse(yield* fs.readFileString(settingsPath)) as {
          migrationVersion: number;
          settings: { textGenerationModelSelection: { model: string } };
        };
        return { settings, persisted };
      }),
    );

    expect(result.settings.textGenerationModelSelection.model).toBe(
      DEFAULT_GIT_TEXT_GENERATION_MODEL,
    );
    expect(result.persisted.migrationVersion).toBe(2);
    expect(result.persisted.settings.textGenerationModelSelection.model).toBe(
      DEFAULT_GIT_TEXT_GENERATION_MODEL,
    );
  });

  it("migrates a removed Kilo text-generation selection to OpenCode", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(dirname(settingsPath), { recursive: true });
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            revision: 3,
            migrationVersion: 2,
            settings: {
              enableProviderUpdateChecks: false,
              textGenerationModelSelection: {
                provider: "kilo",
                model: "kilo/kilo-auto/free",
              },
              providers: {
                kilo: {
                  enabled: true,
                  binaryPath: "/opt/kilo",
                  serverUrl: "http://127.0.0.1:4096",
                  customModels: ["provider/shared-model"],
                },
                opencode: {
                  enabled: false,
                  binaryPath: "/opt/opencode",
                  customModels: ["provider/opencode-model"],
                },
              },
            },
          }),
        );

        yield* service.start;
        const settings = yield* service.getSettings;
        const settingsFileExists = yield* fs.exists(settingsPath);
        return { settings, settingsFileExists };
      }),
    );

    // The rest of the settings and the OpenCode-compatible model survive.
    expect(result.settingsFileExists).toBe(true);
    expect(result.settings.enableProviderUpdateChecks).toBe(false);
    expect(result.settings.textGenerationModelSelection).toMatchObject({
      provider: "opencode",
      model: "kilo/kilo-auto/free",
    });
    expect(result.settings.providers.opencode).toMatchObject({
      enabled: true,
      binaryPath: "/opt/opencode",
      customModels: ["provider/opencode-model", "provider/shared-model"],
    });
    expect(result.settings.providers.opencode.serverUrl).toBe("");
  });

  it("keeps provider passwords server-only and returns configured flags to clients", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;
        const view = yield* service.updateSettingsView({
          providers: {
            opencode: { serverPassword: "opencode-secret" },
          },
        });
        const internal = yield* service.getSettings;
        const persisted = yield* fs.readFileString(settingsPath);
        return { view, internal, persisted };
      }),
    );

    expect(result.internal.providers.opencode.serverPasswordConfigured).toBe(true);
    expect(result.view.providers.opencode).toMatchObject({ serverPasswordConfigured: true });
    expect(JSON.stringify(result.internal)).not.toContain("opencode-secret");
    expect(JSON.stringify(result.view)).not.toContain("opencode-secret");
    expect(JSON.stringify(result.view)).not.toContain('"serverPassword"');
    expect(result.persisted).not.toContain("opencode-secret");
  });

  it.each([
    {
      name: "resolves text generation selection away from disabled providers",
      overrides: {
        textGenerationModelSelection: {
          provider: "antigravity" as const,
          model: DEFAULT_MODEL_BY_PROVIDER.antigravity,
        },
        providers: { antigravity: { enabled: false } },
      },
      expectedProvider: "codex" as const,
    },
    {
      name: "falls back only to providers with dedicated Git text generation",
      overrides: {
        textGenerationModelSelection: {
          provider: "codex" as const,
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        providers: {
          codex: { enabled: false },
          claudeAgent: { enabled: true },
          cursor: { enabled: false },
          opencode: { enabled: true },
        },
      },
      expectedProvider: "opencode" as const,
    },
    {
      name: "normalizes enabled but unsupported Git text generation selections",
      overrides: {
        textGenerationModelSelection: {
          provider: "claudeAgent" as const,
          model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
        },
      },
      expectedProvider: "codex" as const,
    },
  ])("$name", async ({ overrides, expectedProvider }) => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(Effect.provide(ServerSettingsService.layerTest(overrides))),
    );

    expect(settings.textGenerationModelSelection.provider).toBe(expectedProvider);
    expect(settings.textGenerationModelSelection.model).toBe(
      DEFAULT_MODEL_BY_PROVIDER[expectedProvider],
    );
  });
});
