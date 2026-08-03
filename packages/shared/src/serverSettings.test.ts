import { DEFAULT_SERVER_SETTINGS, ProviderSessionStartInput } from "@synara/contracts";
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
  it("defaults a provider-only patch to the provider's Git writing model", () => {
    const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      textGenerationModelSelection: { provider: "opencode" },
    });

    expect(patched.textGenerationModelSelection).toEqual({
      provider: "opencode",
      model: "opencode/big-pickle",
    });
  });

  it("defaults a provider-only Kilo patch to the Kilo free alias", () => {
    const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      textGenerationModelSelection: { provider: "kilo" },
    });

    expect(patched.textGenerationModelSelection).toEqual({
      provider: "kilo",
      model: "kilo/kilo-auto/free",
    });
  });

  it("preserves the model when a patch only changes the model", () => {
    const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      textGenerationModelSelection: { model: "gpt-5.4-mini" },
    });

    expect(patched.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
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
      textGenerationModelSelection: { provider: "cursor", model: "auto" },
    });

    expect(patched.textGenerationModelSelection).toEqual({
      provider: "cursor",
      model: "auto",
    });
  });

  it("preserves the current selection for an options-only patch", () => {
    const patched = applyServerSettingsPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: {
          provider: "kilo",
          model: "openrouter/custom-model",
          options: { variant: "high" as const },
        },
      },
      {
        textGenerationModelSelection: {
          options: { variant: "low" as const },
        },
      },
    );

    expect(patched.textGenerationModelSelection).toEqual({
      provider: "kilo",
      model: "openrouter/custom-model",
      options: { variant: "low" },
    });
  });
});
