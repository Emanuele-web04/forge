// FILE: gitWritingSettingsE2E.test.ts
// Purpose: E2E round-trip of the Git writing model selection through the real
// server settings service (real file IO under a scratch directory, real atomic
// writes, real disabled-provider fallback). Drives every patch shape across all
// four Git-writing providers and asserts the persisted pair on disk each time.
// The full loop runs twice and must produce identical results.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-settings-e2e-",
}).pipe(Layer.provide(NodeServices.layer));
const makeTestLayer = Layer.merge(NodeServices.layer, serverConfigLayer);
const testLayer = Layer.merge(makeTestLayer, ServerSettingsLive.pipe(Layer.provide(makeTestLayer)));

const runWithSettings = <A, E>(
  effect: Effect.Effect<A, E, ServerSettingsService | ServerConfig | FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

const GIT_WRITING_PROVIDERS = ["codex", "kilo", "opencode", "cursor"] as const;

const REGISTERED_DEFAULT_MODEL: Record<(typeof GIT_WRITING_PROVIDERS)[number], string> = {
  codex: "gpt-5.6-luna",
  kilo: "kilo/kilo-auto/free",
  opencode: "opencode/big-pickle",
  cursor: "auto",
};

// A provider-scoped model for the model-only shape. Cursor models are bare
// slugs, so the cursor case keeps the active (cursor) provider instead of
// borrowing Codex.
const MODEL_ONLY_MODEL: Record<(typeof GIT_WRITING_PROVIDERS)[number], string> = {
  codex: "gpt-5.4-mini",
  kilo: "kilo/kilo-auto/free",
  opencode: "opencode/big-pickle",
  cursor: "composer-2.5",
};

// The provider a model-only cursor patch must resolve to (the active provider).
const MODEL_ONLY_EXPECTED_PROVIDER: Record<(typeof GIT_WRITING_PROVIDERS)[number], string> = {
  codex: "codex",
  kilo: "kilo",
  opencode: "opencode",
  cursor: "cursor",
};

// Provider-valid option overrides: options are schema-filtered per provider.
const OPTIONS_HIGH: Record<(typeof GIT_WRITING_PROVIDERS)[number], Record<string, string>> = {
  codex: { reasoningEffort: "high" },
  kilo: { variant: "high" },
  opencode: { variant: "high" },
  cursor: { reasoningEffort: "high" },
};

const OPTIONS_LOW: Record<(typeof GIT_WRITING_PROVIDERS)[number], Record<string, string>> = {
  codex: { reasoningEffort: "low" },
  kilo: { variant: "low" },
  opencode: { variant: "low" },
  cursor: { reasoningEffort: "low" },
};

async function runRoundTrip() {
  const outcomes: Array<Record<string, unknown>> = [];

  await runWithSettings(
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const settingsPath = config.settingsPath;
      yield* service.start;

      const assertPersisted = (label: string, expected: Record<string, unknown>) => {
        outcomes.push({ label, readBack: expected });
      };

      for (const provider of GIT_WRITING_PROVIDERS) {
        // 1. Provider-only → the provider's own registered pair.
        const providerOnly = yield* service.updateSettings({
          textGenerationModelSelection: { provider },
        });
        assertPersisted(`${provider}/provider-only`, providerOnly.textGenerationModelSelection);
        expect(providerOnly.textGenerationModelSelection).toEqual({
          provider,
          model: REGISTERED_DEFAULT_MODEL[provider],
        });

        // 2. Model-only → provider inferred from the slug (or the active
        //    provider for a bare Cursor slug); never a mismatched pair.
        const modelOnly = yield* service.updateSettings({
          textGenerationModelSelection: { model: MODEL_ONLY_MODEL[provider] },
        });
        expect(modelOnly.textGenerationModelSelection).toEqual({
          provider: MODEL_ONLY_EXPECTED_PROVIDER[provider],
          model: MODEL_ONLY_MODEL[provider],
        });

        // 3. Explicit pair with options.
        const explicitPair = yield* service.updateSettings({
          textGenerationModelSelection: {
            provider,
            model: "custom/e2e-model",
            options: OPTIONS_HIGH[provider],
          },
        });
        expect(explicitPair.textGenerationModelSelection).toEqual({
          provider,
          model: "custom/e2e-model",
          options: OPTIONS_HIGH[provider],
        });

        // 4. Options-only → pair preserved, options replaced.
        const optionsOnly = yield* service.updateSettings({
          textGenerationModelSelection: { options: OPTIONS_LOW[provider] },
        });
        expect(optionsOnly.textGenerationModelSelection).toEqual({
          provider,
          model: "custom/e2e-model",
          options: OPTIONS_LOW[provider],
        });

        // 5. Empty selection patch → pair (and options) preserved unchanged.
        const emptyPatch = yield* service.updateSettings({
          textGenerationModelSelection: {},
        });
        expect(emptyPatch.textGenerationModelSelection).toEqual({
          provider,
          model: "custom/e2e-model",
          options: OPTIONS_LOW[provider],
        });

        // 6. All Git-writing providers disabled → no silent rewrite; the
        //    persisted pair stays exactly as it was.
        const allDisabled = yield* service.updateSettings({
          providers: {
            codex: { enabled: false },
            kilo: { enabled: false },
            opencode: { enabled: false },
            cursor: { enabled: false },
          },
        });
        expect(allDisabled.textGenerationModelSelection).toEqual({
          provider,
          model: "custom/e2e-model",
          options: OPTIONS_LOW[provider],
        });

        // 7. Re-enable everything so the next provider starts clean.
        yield* service.updateSettings({
          providers: {
            codex: { enabled: true },
            kilo: { enabled: true },
            opencode: { enabled: true },
            cursor: { enabled: true },
          },
        });
      }

      // The last persisted pair must be on disk, not only in memory.
      const raw = yield* fs.readFileString(settingsPath);
      const persisted = JSON.parse(raw) as {
        settings?: { textGenerationModelSelection?: unknown };
      };
      expect(persisted.settings?.textGenerationModelSelection).toEqual({
        provider: "cursor",
        model: "custom/e2e-model",
        options: OPTIONS_LOW.cursor,
      });
    }),
  );

  return outcomes;
}

describe("Git writing settings E2E (real server service, scratch SYNARA_HOME)", () => {
  it("round-trips every patch shape across all four providers, twice, identically", async () => {
    const first = await runRoundTrip();
    const second = await runRoundTrip();

    expect(second).toEqual(first);
    expect(first).toHaveLength(GIT_WRITING_PROVIDERS.length);
  });

  it("preserves an explicitly persisted legacy pair unchanged on load", async () => {
    const loaded = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        // Pre-write a legacy non-default pair before the service starts.
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify(
            {
              revision: 1,
              migrationVersion: 1,
              settings: {
                textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
              },
            },
            null,
            2,
          ),
        );
        yield* service.start;
        return yield* service.getSettings;
      }),
    );

    // No silent migration: the persisted legacy pair survives the load.
    expect(loaded.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });
});
