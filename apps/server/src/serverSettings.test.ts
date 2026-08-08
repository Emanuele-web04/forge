import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL_BY_PROVIDER } from "@synara/contracts";
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
    expect(result.updated.providers.codex.binaryPath).toBe("/usr/local/bin/codex");
    expect(result.parsed).toMatchObject({
      revision: 1,
      migrationVersion: 1,
      settings: {
        enableAssistantStreaming: true,
        enableProviderUpdateChecks: false,
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            customModels: ["gpt-custom"],
          },
        },
      },
    });
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
            kilo: { serverPassword: "kilo-secret" },
            opencode: { serverPassword: "opencode-secret" },
          },
        });
        const internal = yield* service.getSettings;
        const persisted = yield* fs.readFileString(settingsPath);
        return { view, internal, persisted };
      }),
    );

    expect(result.internal.providers.kilo.serverPasswordConfigured).toBe(true);
    expect(result.internal.providers.opencode.serverPasswordConfigured).toBe(true);
    expect(result.view.providers.kilo).toMatchObject({ serverPasswordConfigured: true });
    expect(result.view.providers.opencode).toMatchObject({ serverPasswordConfigured: true });
    expect(JSON.stringify(result.internal)).not.toContain("kilo-secret");
    expect(JSON.stringify(result.internal)).not.toContain("opencode-secret");
    expect(JSON.stringify(result.view)).not.toContain("kilo-secret");
    expect(JSON.stringify(result.view)).not.toContain("opencode-secret");
    expect(JSON.stringify(result.view)).not.toContain('"serverPassword"');
    expect(result.persisted).not.toContain("kilo-secret");
    expect(result.persisted).not.toContain("opencode-secret");
  });

  it("resolves text generation selection away from disabled providers", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              provider: "antigravity",
              model: DEFAULT_MODEL_BY_PROVIDER.antigravity,
            },
            providers: {
              antigravity: { enabled: false },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection.provider).toBe("codex");
    // The fallback is a Git writing default, not the general chat default.
    expect(settings.textGenerationModelSelection.model).toBe("gpt-5.6-luna");
  });

  it("skips disabled Codex and picks an enabled Git-writing provider", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              provider: "antigravity",
              model: DEFAULT_MODEL_BY_PROVIDER.antigravity,
            },
            providers: {
              codex: { enabled: false },
              claudeAgent: { enabled: true },
              kilo: { enabled: true },
              opencode: { enabled: false },
              antigravity: { enabled: false },
            },
          }),
        ),
      ),
    );

    // The fallback search only considers Git-writing-capable providers, so it
    // skips both the disabled Codex and the enabled-but-unsupported Claude.
    expect(settings.textGenerationModelSelection.provider).toBe("kilo");
    expect(settings.textGenerationModelSelection.model).toBe("kilo/kilo-auto/free");
  });

  it("falls back to an enabled Cursor when the persisted Git-writing provider is disabled", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              provider: "codex",
              model: "gpt-5.6-luna",
            },
            providers: {
              codex: { enabled: false },
              kilo: { enabled: false },
              opencode: { enabled: false },
              cursor: { enabled: true },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection).toEqual({
      provider: "cursor",
      model: "auto",
    });
  });

  it("preserves the persisted selection without a rewrite when every Git-writing provider is disabled", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              provider: "cursor",
              model: "auto",
            },
            providers: {
              codex: { enabled: false },
              kilo: { enabled: false },
              opencode: { enabled: false },
              cursor: { enabled: false },
              claudeAgent: { enabled: true },
            },
          }),
        ),
      ),
    );

    // No silent rewrite: the all-disabled guard keeps the persisted pair even
    // though an unrelated chat provider (claudeAgent) is enabled.
    expect(settings.textGenerationModelSelection).toEqual({
      provider: "cursor",
      model: "auto",
    });
  });

  it("keeps a provider-only Cursor patch on Cursor with its registered default", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.start;
        const updated = yield* service.updateSettings({
          textGenerationModelSelection: { provider: "cursor" },
        });
        const persisted = yield* service.getSettings;
        return { updated, persisted };
      }),
    );

    // The direct server patch path must never rewrite a provider-only Cursor
    // selection to Codex/Luna, and the pair must round-trip to disk.
    expect(result.updated.textGenerationModelSelection).toEqual({
      provider: "cursor",
      model: "auto",
    });
    expect(result.persisted.textGenerationModelSelection).toEqual({
      provider: "cursor",
      model: "auto",
    });
  });
});
