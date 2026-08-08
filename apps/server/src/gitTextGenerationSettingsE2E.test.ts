// FILE: gitTextGenerationSettingsE2E.test.ts
// Purpose: E2E round-trip of the Git text generation model selection through the
// real server settings service (real file IO under a scratch directory, real
// atomic writes, real disabled-provider fallback). Drives every patch shape
// across all four Git text generation providers. The returned selection is
// asserted after each step; the persisted pair is asserted on disk once, for
// the final state. The full loop runs twice and must produce identical results.
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
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer)));

const GIT_TEXT_GENERATION_PROVIDERS = ["codex", "kilo", "opencode", "cursor"] as const;

const REGISTERED_DEFAULT_MODEL: Record<(typeof GIT_TEXT_GENERATION_PROVIDERS)[number], string> = {
  codex: "gpt-5.6-luna",
  kilo: "kilo/kilo-auto/free",
  opencode: "opencode/big-pickle",
  cursor: "auto",
};

// A provider-scoped model for the model-only shape. Cursor models are bare
// slugs, so the cursor case keeps the active (cursor) provider instead of
// borrowing Codex.
const MODEL_ONLY_MODEL: Record<(typeof GIT_TEXT_GENERATION_PROVIDERS)[number], string> = {
  codex: "gpt-5.4-mini",
  kilo: "kilo/kilo-auto/free",
  opencode: "opencode/big-pickle",
  cursor: "composer-2.5",
};

// Provider-valid option overrides: options are schema-filtered per provider.
const OPTIONS_HIGH: Record<
  (typeof GIT_TEXT_GENERATION_PROVIDERS)[number],
  Record<string, string>
> = {
  codex: { reasoningEffort: "high" },
  kilo: { variant: "high" },
  opencode: { variant: "high" },
  cursor: { reasoningEffort: "high" },
};

const OPTIONS_LOW: Record<
  (typeof GIT_TEXT_GENERATION_PROVIDERS)[number],
  Record<string, string>
> = {
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

      // Records the returned selection for the run-to-run equality check. The
      // on-disk pair is asserted separately, once, after the loop.
      const recordOutcome = (label: string, result: Record<string, unknown>) => {
        outcomes.push({ label, result });
      };

      for (const provider of GIT_TEXT_GENERATION_PROVIDERS) {
        // 1. Provider-only → the provider's own registered pair.
        const providerOnly = yield* service.updateSettings({
          textGenerationModelSelection: { provider },
        });
        recordOutcome(`${provider}/provider-only`, providerOnly.textGenerationModelSelection);
        expect(providerOnly.textGenerationModelSelection).toEqual({
          provider,
          model: REGISTERED_DEFAULT_MODEL[provider],
        });

        // 2. Model-only → provider inferred from the slug (or the active
        //    provider for a bare Cursor slug); never a mismatched pair. The
        //    resolved provider is the loop's own provider in every case.
        const modelOnly = yield* service.updateSettings({
          textGenerationModelSelection: { model: MODEL_ONLY_MODEL[provider] },
        });
        expect(modelOnly.textGenerationModelSelection).toEqual({
          provider,
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

        // 6. All Git text generation providers disabled → no silent rewrite;
        //    the persisted pair stays exactly as it was.
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

describe("Git text generation settings E2E (real server service, scratch SYNARA_HOME)", () => {
  it("round-trips every patch shape across all four providers, twice, identically", async () => {
    const first = await runRoundTrip();
    const second = await runRoundTrip();

    expect(second).toEqual(first);
    expect(first).toHaveLength(GIT_TEXT_GENERATION_PROVIDERS.length);
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

  it("resolves a model-only patch against the effective provider while a fallback is active", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        // Persist a kilo selection while kilo is disabled (codex stays enabled),
        // so the effective view resolves to the codex fallback.
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify(
            {
              revision: 1,
              migrationVersion: 1,
              settings: {
                textGenerationModelSelection: { provider: "kilo", model: "kilo/kilo-auto/free" },
                providers: { kilo: { enabled: false } },
              },
            },
            null,
            2,
          ),
        );
        yield* service.start;

        const initial = yield* service.getSettings;
        const patched = yield* service.updateSettings({
          textGenerationModelSelection: { model: "gpt-5.4-mini" },
        });
        const afterPatch = yield* service.getSettings;
        const reenabled = yield* service.updateSettings({
          providers: { kilo: { enabled: true } },
        });
        const afterReenable = yield* service.getSettings;
        const raw = yield* fs.readFileString(config.settingsPath);
        const persisted = JSON.parse(raw) as {
          settings?: { textGenerationModelSelection?: unknown };
        };
        return { initial, patched, afterPatch, reenabled, afterReenable, persisted };
      }),
    );

    // The read view shows the fallback; the disk file still holds the kilo pair
    // until a deliberate edit replaces it.
    expect(result.initial.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
    });
    // A deliberate model-only edit while viewing the fallback is resolved
    // against the displayed provider (codex), not the hidden persisted kilo row.
    expect(result.patched.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
    expect(result.afterPatch.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
    // Re-enabling kilo does not flip the persisted pair (deliberate-edit
    // semantics only; no surprise flip).
    expect(result.afterReenable.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
    expect(result.persisted.settings?.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("keeps the persisted pair across unrelated, options-only, and empty patches while a fallback is active", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        // Persist a kilo pair (with options) while kilo is disabled (codex stays
        // enabled), so the effective view resolves to the codex fallback.
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify(
            {
              revision: 1,
              migrationVersion: 1,
              settings: {
                textGenerationModelSelection: {
                  provider: "kilo",
                  model: "kilo/kilo-auto/free",
                  options: { variant: "high" },
                },
                providers: { kilo: { enabled: false } },
              },
            },
            null,
            2,
          ),
        );
        yield* service.start;

        const initial = yield* service.getSettings;
        // Unrelated patch (no selection part): must not touch the persisted pair.
        const unrelated = yield* service.updateSettings({
          enableAssistantStreaming: true,
        });
        const persistedAfterUnrelated = JSON.parse(
          yield* fs.readFileString(config.settingsPath),
        ) as {
          settings?: { textGenerationModelSelection?: unknown };
        };
        // Options-only patch: pair preserved, options replaced.
        const optionsOnly = yield* service.updateSettings({
          textGenerationModelSelection: { options: { variant: "low" } },
        });
        const persistedAfterOptionsOnly = JSON.parse(
          yield* fs.readFileString(config.settingsPath),
        ) as {
          settings?: { textGenerationModelSelection?: unknown };
        };
        // Empty selection patch: pair and options preserved unchanged.
        const emptySelection = yield* service.updateSettings({
          textGenerationModelSelection: {},
        });
        // Re-enable kilo: no deliberate edit happened, so the ORIGINAL persisted
        // kilo pair (with the options-only override) must still be intact.
        const reenabled = yield* service.updateSettings({
          providers: { kilo: { enabled: true } },
        });
        const afterReenable = yield* service.getSettings;
        const raw = yield* fs.readFileString(config.settingsPath);
        const persisted = JSON.parse(raw) as {
          settings?: { textGenerationModelSelection?: unknown };
        };
        return {
          initial,
          unrelated,
          persistedAfterUnrelated,
          optionsOnly,
          persistedAfterOptionsOnly,
          emptySelection,
          reenabled,
          afterReenable,
          persisted,
        };
      }),
    );

    // The read view shows the codex fallback the whole time.
    expect(result.initial.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
    });
    // The unrelated patch must not replace the persisted kilo pair.
    expect(result.persistedAfterUnrelated.settings?.textGenerationModelSelection).toEqual({
      provider: "kilo",
      model: "kilo/kilo-auto/free",
      options: { variant: "high" },
    });
    // The options-only patch replaces the options but keeps the persisted pair.
    expect(result.persistedAfterOptionsOnly.settings?.textGenerationModelSelection).toEqual({
      provider: "kilo",
      model: "kilo/kilo-auto/free",
      options: { variant: "low" },
    });
    // Every returned view still shows the fallback (the persisted row is not
    // the view while kilo stays disabled).
    expect(result.unrelated.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
    });
    expect(result.optionsOnly.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
    });
    expect(result.emptySelection.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
    });
    // Re-enabling kilo surfaces the ORIGINAL persisted kilo pair again: no
    // surprise flip to the fallback pair.
    expect(result.reenabled.textGenerationModelSelection).toEqual({
      provider: "kilo",
      model: "kilo/kilo-auto/free",
      options: { variant: "low" },
    });
    expect(result.afterReenable.textGenerationModelSelection).toEqual({
      provider: "kilo",
      model: "kilo/kilo-auto/free",
      options: { variant: "low" },
    });
    // The final on-disk row still holds the kilo pair.
    expect(result.persisted.settings?.textGenerationModelSelection).toEqual({
      provider: "kilo",
      model: "kilo/kilo-auto/free",
      options: { variant: "low" },
    });
  });
});
