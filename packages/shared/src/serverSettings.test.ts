import {
  DEFAULT_SERVER_SETTINGS,
  ProviderSessionStartInput,
  type ModelSelection,
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
  const GIT_WRITING_PROVIDERS = ["codex", "kilo", "opencode", "cursor"] as const;
  const REGISTERED_DEFAULT_MODEL: Record<(typeof GIT_WRITING_PROVIDERS)[number], string> = {
    codex: "gpt-5.6-luna",
    kilo: "kilo/kilo-auto/free",
    opencode: "opencode/big-pickle",
    cursor: "auto",
  };

  it.each(GIT_WRITING_PROVIDERS)(
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
    { provider: "cursor", model: "composer-2.5" },
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

  it("keeps a bare non-Codex model on the active Git writing provider instead of borrowing Codex", () => {
    // "composer-2.5" is a Cursor model. With Cursor active, a model-only patch
    // must not produce the mismatched pair {codex, composer-2.5}.
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

  it.each(GIT_WRITING_PROVIDERS)(
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

  it.each(GIT_WRITING_PROVIDERS)(
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

  it("never pairs an unsupported provider with Codex's model", () => {
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
});
