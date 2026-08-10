import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_PROFILE_ID,
  DEFAULT_SERVER_SETTINGS,
  ProviderProfileId,
  ProviderSessionStartInput,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { applyServerSettingsPatch, providerStartOptionsFromServerSettings } from "./serverSettings";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);

describe("applyServerSettingsPatch", () => {
  const workProfileId = ProviderProfileId.makeUnsafe("work");
  const settingsWithWorkProfile = {
    ...DEFAULT_SERVER_SETTINGS,
    textGenerationModelSelection: {
      provider: "codex" as const,
      profileId: workProfileId,
      model: "gpt-5.6-codex",
      options: { reasoningEffort: "high" as const },
    },
  };

  it("preserves the profile when the model changes", () => {
    const next = applyServerSettingsPatch(settingsWithWorkProfile, {
      textGenerationModelSelection: {
        provider: "codex",
        model: "gpt-5.5",
      },
    });

    expect(next.textGenerationModelSelection).toEqual({
      provider: "codex",
      profileId: workProfileId,
      model: "gpt-5.5",
    });
  });

  it("resets the profile when the provider changes without an explicit profile", () => {
    const next = applyServerSettingsPatch(settingsWithWorkProfile, {
      textGenerationModelSelection: { provider: "claudeAgent" },
    });

    expect(next.textGenerationModelSelection).toEqual({
      provider: "claudeAgent",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    });
  });

  it("changes profiles without carrying model options between accounts", () => {
    const personalProfileId = ProviderProfileId.makeUnsafe("personal");
    const next = applyServerSettingsPatch(settingsWithWorkProfile, {
      textGenerationModelSelection: { profileId: personalProfileId },
    });

    expect(next.textGenerationModelSelection).toEqual({
      provider: "codex",
      profileId: personalProfileId,
      model: "gpt-5.6-codex",
    });
  });

  it("preserves an explicit profile when changing providers", () => {
    const claudeWorkProfileId = ProviderProfileId.makeUnsafe("claude_work");
    const next = applyServerSettingsPatch(settingsWithWorkProfile, {
      textGenerationModelSelection: {
        provider: "claudeAgent",
        profileId: claudeWorkProfileId,
      },
    });

    expect(next.textGenerationModelSelection).toEqual({
      provider: "claudeAgent",
      profileId: claudeWorkProfileId,
      model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    });
  });
});

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
