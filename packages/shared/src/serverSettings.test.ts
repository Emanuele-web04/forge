import {
  DEFAULT_SERVER_SETTINGS,
  ProviderSessionStartInput,
  type ModelSelection,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { applyServerSettingsPatch, providerStartOptionsFromServerSettings } from "./serverSettings";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);

describe("providerStartOptionsFromServerSettings", () => {
  it("omits blank launch settings from provider session input", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "",
          homePath: "",
        },
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          binaryPath: "",
        },
        cursor: {
          ...DEFAULT_SERVER_SETTINGS.providers.cursor,
          binaryPath: "",
          apiEndpoint: "",
        },
        antigravity: {
          ...DEFAULT_SERVER_SETTINGS.providers.antigravity,
          binaryPath: "",
        },
        grok: {
          ...DEFAULT_SERVER_SETTINGS.providers.grok,
          binaryPath: "",
        },
        droid: {
          ...DEFAULT_SERVER_SETTINGS.providers.droid,
          binaryPath: "",
        },
        kilo: {
          ...DEFAULT_SERVER_SETTINGS.providers.kilo,
          binaryPath: "",
          serverUrl: "",
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          binaryPath: "",
          serverUrl: "",
        },
        pi: {
          ...DEFAULT_SERVER_SETTINGS.providers.pi,
          binaryPath: "",
          agentDir: "",
        },
      },
    };

    const providerOptions = providerStartOptionsFromServerSettings(settings);

    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        providerOptions,
        runtimeMode: "full-access",
      }),
    ).not.toThrow();
    expect(providerOptions.codex).toEqual({});
    expect(providerOptions.claudeAgent).toEqual({});
    expect(providerOptions.cursor).toEqual({});
    expect(providerOptions.antigravity).toEqual({});
    expect(providerOptions.grok).toEqual({});
    expect(providerOptions.droid).toEqual({});
    expect(providerOptions.kilo).toEqual({});
    expect(providerOptions.opencode).toEqual({ experimentalWebSockets: false });
    expect(providerOptions.pi).toEqual({});
  });

  it("preserves configured launch settings", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "/custom/bin/codex",
          homePath: "/custom/codex-home",
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          binaryPath: "/custom/bin/opencode",
          serverUrl: "http://127.0.0.1:4096",
          experimentalWebSockets: true,
        },
      },
    };

    const providerOptions = providerStartOptionsFromServerSettings(settings);

    expect(providerOptions.codex).toEqual({
      binaryPath: "/custom/bin/codex",
      homePath: "/custom/codex-home",
    });
    expect(providerOptions.opencode).toEqual({
      binaryPath: "/custom/bin/opencode",
      serverUrl: "http://127.0.0.1:4096",
      experimentalWebSockets: true,
    });
  });
});

describe("applyServerSettingsPatch textGenerationModelSelection", () => {
  const GIT_TEXT_GENERATION_PROVIDERS = ["codex", "kilo", "opencode"] as const;
  const REGISTERED_DEFAULT_MODEL: Record<(typeof GIT_TEXT_GENERATION_PROVIDERS)[number], string> = {
    codex: "gpt-5.6-luna",
    kilo: "kilo/kilo-auto/free",
    opencode: "opencode/big-pickle",
  };

  it.each(GIT_TEXT_GENERATION_PROVIDERS)(
    "defaults a provider-only %s patch to that provider's own registered pair",
    (provider) => {
      const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        textGenerationModelSelection: { provider },
      });

      expect(patched.textGenerationModelSelection).toEqual({
        provider,
        model: REGISTERED_DEFAULT_MODEL[provider],
      });
    },
  );

  it.each([
    { provider: "codex", model: "gpt-5.4-mini" },
    { provider: "kilo", model: "kilo/kilo-auto/free" },
    { provider: "opencode", model: "opencode/big-pickle" },
  ] as const)("keeps an explicit provider+model pair ($provider/$model) unchanged", (selection) => {
    const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      textGenerationModelSelection: selection,
    });

    expect(patched.textGenerationModelSelection).toEqual({
      provider: selection.provider,
      model: selection.model,
    });
  });

  it.each([
    {
      model: "gpt-5.4-mini",
      current: "codex",
      expected: { provider: "codex", model: "gpt-5.4-mini" },
    },
    {
      model: "kilo/kilo-auto/free",
      current: "opencode",
      expected: { provider: "kilo", model: "kilo/kilo-auto/free" },
    },
    {
      model: "opencode/big-pickle",
      current: "kilo",
      expected: { provider: "opencode", model: "opencode/big-pickle" },
    },
  ] as const)(
    "infers the provider from a model-only patch ($model)",
    ({ model, current, expected }) => {
      const patched = applyServerSettingsPatch(
        {
          ...DEFAULT_SERVER_SETTINGS,
          textGenerationModelSelection: {
            provider: current,
            model: "current-model",
          } as ModelSelection,
        },
        {
          textGenerationModelSelection: { model },
        },
      );

      expect(patched.textGenerationModelSelection).toEqual(expected);
    },
  );

  it("keeps a bare non-Codex model on a legacy active provider instead of borrowing Codex", () => {
    // Cursor is not a Git text generation provider in this registry, but an
    // explicitly persisted legacy Cursor pair must still round-trip safely.
    const patched = applyServerSettingsPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: { provider: "cursor", model: "auto" },
      },
      {
        textGenerationModelSelection: { model: "composer-2.5" },
      },
    );

    expect(patched.textGenerationModelSelection).toEqual({
      provider: "cursor",
      model: "composer-2.5",
    });
  });

  it.each(GIT_TEXT_GENERATION_PROVIDERS)(
    "preserves the persisted pair for an empty %s-selection patch",
    (provider) => {
      const current = {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: {
          provider,
          model: REGISTERED_DEFAULT_MODEL[provider],
        } as ModelSelection,
      };
      const patched = applyServerSettingsPatch(current, {
        textGenerationModelSelection: {},
      });

      expect(patched.textGenerationModelSelection).toEqual(current.textGenerationModelSelection);
    },
  );

  it.each(GIT_TEXT_GENERATION_PROVIDERS)(
    "preserves the persisted pair for an options-only %s-selection patch",
    (provider) => {
      const current = {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: {
          provider,
          model: "custom/model",
          options: { variant: "high" as const },
        } as ModelSelection,
      };
      const patched = applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: { variant: "low" as const },
        },
      });

      expect(patched.textGenerationModelSelection).toEqual({
        provider,
        model: "custom/model",
        options: { variant: "low" },
      });
    },
  );

  it("preserves a legacy non-default Codex pair across options-only and empty patches", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" } as ModelSelection,
    };

    expect(
      applyServerSettingsPatch(current, { textGenerationModelSelection: {} })
        .textGenerationModelSelection,
    ).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: { options: { reasoningEffort: "high" as const } },
      }).textGenerationModelSelection,
    ).toEqual({ provider: "codex", model: "gpt-5.4-mini", options: { reasoningEffort: "high" } });
  });

  it("resolves an unsupported provider-only patch to the complete Codex/Luna pair", () => {
    const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      textGenerationModelSelection: { provider: "claudeAgent" },
    });

    // Unsupported provider with no explicit model resolves to the complete
    // Codex/Luna pair instead of the invalid {claudeAgent, gpt-5.6-luna}.
    expect(patched.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
    });
  });

  it("keeps an unsupported provider when an explicit model is supplied (legacy)", () => {
    const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      textGenerationModelSelection: { provider: "claudeAgent", model: "sonnet" },
    });

    expect(patched.textGenerationModelSelection).toEqual({
      provider: "claudeAgent",
      model: "sonnet",
    });
  });

  it("keeps the current selection when a model-only patch is rejected (foreign slug under codex)", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.6-luna" } as ModelSelection,
    };
    // "composer-2.5"/"auto" are Cursor models; pairing them with Codex would be
    // a mismatched pair, so the resolver REJECTS and the selection stays.
    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: { model: "composer-2.5" },
      }).textGenerationModelSelection,
    ).toEqual({ provider: "codex", model: "gpt-5.6-luna" });
    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: { model: "auto" },
      }).textGenerationModelSelection,
    ).toEqual({ provider: "codex", model: "gpt-5.6-luna" });
  });

  it("keeps the persisted pair and options when a model-only patch is rejected", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        provider: "codex",
        model: "gpt-5.6-luna",
        options: { reasoningEffort: "high" as const },
      } as ModelSelection,
    };
    const patched = applyServerSettingsPatch(current, {
      textGenerationModelSelection: { model: "composer-2.5" },
    });
    expect(patched.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      options: { reasoningEffort: "high" },
    });
  });

  it("preserves the legacy provider pair for a model-only patch (claudeAgent)", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: { provider: "claudeAgent", model: "sonnet" } as ModelSelection,
    };
    // A model-only patch under a legacy chat provider stays on that provider
    // with the requested model: never discard the model to Codex.
    const patched = applyServerSettingsPatch(current, {
      textGenerationModelSelection: { model: "sonnet-4-6" },
    });
    expect(patched.textGenerationModelSelection).toEqual({
      provider: "claudeAgent",
      model: "sonnet-4-6",
    });
  });

  it("drops persisted option overrides when a patch replaces provider/model (documented)", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        provider: "codex",
        model: "gpt-5.4-mini",
        options: { reasoningEffort: "high" as const },
      } as ModelSelection,
    };
    const patched = applyServerSettingsPatch(current, {
      textGenerationModelSelection: { provider: "codex" },
    });
    // A provider-only patch is a reset to the provider's registered default,
    // and the patch's options (none here) replace the persisted overrides.
    expect(patched.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
    });
  });

  it("treats a null provider+model patch as a reset to the active provider's registered default", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" } as ModelSelection,
    };
    const patched = applyServerSettingsPatch(current, {
      textGenerationModelSelection: { provider: null, model: null },
    } as unknown as ServerSettingsPatch);
    expect(patched.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
    });
  });

  it("merges against the raw persisted row but resolves a deliberate edit against the effective view", () => {
    const raw: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        provider: "kilo",
        model: "kilo/kilo-auto/free",
        options: { variant: "high" },
      } as ModelSelection,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        kilo: {
          ...DEFAULT_SERVER_SETTINGS.providers.kilo,
          enabled: false,
        },
      },
    };
    // The effective view the UI displays while the persisted kilo is disabled.
    const effective: ServerSettings = {
      ...raw,
      textGenerationModelSelection: {
        provider: "codex",
        model: "gpt-5.6-luna",
      } as ModelSelection,
    };

    // Unrelated patch: the persisted kilo pair survives, options included.
    expect(
      applyServerSettingsPatch(raw, { enableAssistantStreaming: true }, effective)
        .textGenerationModelSelection,
    ).toEqual({ provider: "kilo", model: "kilo/kilo-auto/free", options: { variant: "high" } });

    // Options-only patch: pair preserved, options replaced.
    expect(
      applyServerSettingsPatch(
        raw,
        { textGenerationModelSelection: { options: { variant: "low" } } },
        effective,
      ).textGenerationModelSelection,
    ).toEqual({ provider: "kilo", model: "kilo/kilo-auto/free", options: { variant: "low" } });

    // Empty selection patch: pair and options preserved unchanged.
    expect(
      applyServerSettingsPatch(raw, { textGenerationModelSelection: {} }, effective)
        .textGenerationModelSelection,
    ).toEqual({ provider: "kilo", model: "kilo/kilo-auto/free", options: { variant: "high" } });

    // Deliberate model-only edit: resolved against the effective (displayed)
    // provider, so it becomes the codex pair and replaces the persisted pair.
    expect(
      applyServerSettingsPatch(
        raw,
        { textGenerationModelSelection: { model: "gpt-5.4-mini" } },
        effective,
      ).textGenerationModelSelection,
    ).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
  });
});
