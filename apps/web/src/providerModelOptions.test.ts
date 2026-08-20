// FILE: providerModelOptions.test.ts
// Purpose: Verifies provider-aware model-name formatting for picker and composer labels.
// Layer: Web unit tests
// Depends on: providerModelOptions shared formatting helpers.

import { describe, expect, it } from "vitest";

import {
  buildModelSelection,
  buildNextProviderOptions,
  buildProviderOptionPatch,
  formatProviderModelOptionName,
  groupProviderModelOptions,
  groupProviderModelOptionsWithFavorites,
  mergeDynamicModelOptions,
  providerModelCostMultiplierLabel,
  providerModelOptionProvenanceLabel,
  resolveModelGroupDefaultOpen,
  shouldUseCollapsibleModelGroups,
  type ProviderModelOption,
} from "./providerModelOptions";

describe("Antigravity model options", () => {
  it("keeps the base model and effort as separate selection fields", () => {
    const options = buildNextProviderOptions("antigravity", undefined, {
      reasoningEffort: "high",
    });

    expect(options).toEqual({ reasoningEffort: "high" });
    expect(buildModelSelection("antigravity", "Gemini 3.5 Flash", options)).toEqual({
      provider: "antigravity",
      model: "Gemini 3.5 Flash",
      options: { reasoningEffort: "high" },
    });
  });
});

describe("Claude model selections", () => {
  it("preserves the discovered Auto capability with the selected model", () => {
    expect(buildModelSelection("claudeAgent", "claude-haiku-4-5", undefined, false)).toEqual({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      supportsAutoMode: false,
    });
  });
});

describe("formatProviderModelOptionName", () => {
  it("humanizes unknown OpenCode runtime model slugs using the model identifier", () => {
    expect(
      formatProviderModelOptionName({
        provider: "opencode",
        slug: "opencode-go/kimi-k2.6",
      }),
    ).toBe("Kimi K2.6");
  });

  it("keeps known OpenCode-backed models on their shared display names", () => {
    expect(
      formatProviderModelOptionName({
        provider: "opencode",
        slug: "openai/gpt-5",
      }),
    ).toBe("GPT-5");
  });

  it("leaves non-OpenCode unknown slugs unchanged", () => {
    expect(
      formatProviderModelOptionName({
        provider: "codex",
        slug: "custom/internal-model",
      }),
    ).toBe("custom/internal-model");
  });
});

describe("mergeDynamicModelOptions", () => {
  it("does not offer Pi Anthropic models when discovery only returns local models", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "pi",
        staticOptions: [],
        dynamicModels: [
          {
            slug: "local/glm-5.2",
            name: "GLM 5.2",
            upstreamProviderId: "local",
            upstreamProviderName: "Local",
          },
        ],
      }).map((option) => option.slug),
    ).toEqual(["local/glm-5.2"]);
  });

  it("offers Pi Fable and Opus when authenticated discovery returns them", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "pi",
        staticOptions: [],
        dynamicModels: [
          { slug: "anthropic/claude-fable-5", name: "Claude Fable 5" },
          { slug: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8" },
        ],
      }).map((option) => option.slug),
    ).toEqual(["anthropic/claude-fable-5", "anthropic/claude-opus-4-8"]);
  });

  it("uses the live Antigravity catalog as authoritative and includes newly discovered models", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "antigravity",
        staticOptions: [
          { slug: "Gemini 3.5 Flash", name: "Gemini 3.5 Flash" },
          { slug: "Claude Sonnet 4.6", name: "Claude Sonnet 4.6" },
          { slug: "custom/private-model", name: "custom/private-model", isCustom: true },
        ],
        dynamicModels: [
          { slug: "Gemini 4 Pro", name: "Gemini 4 Pro" },
          { slug: "Claude Sonnet 5", name: "Claude Sonnet 5" },
        ],
      }),
    ).toEqual([
      { slug: "Gemini 4 Pro", name: "Gemini 4 Pro" },
      { slug: "Claude Sonnet 5", name: "Claude Sonnet 5" },
      { slug: "custom/private-model", name: "custom/private-model", isCustom: true },
    ]);
  });

  it("preserves runtime descriptions without inventing them for custom models", () => {
    const options = mergeDynamicModelOptions({
      provider: "droid",
      staticOptions: [{ slug: "custom:model", name: "Custom model", isCustom: true }],
      dynamicModels: [
        {
          slug: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          description: " 0.4x Factory token rate ",
        },
        { slug: "custom:model", name: "Custom model" },
      ],
    });

    expect(options).toEqual([
      {
        slug: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        description: "0.4x Factory token rate",
      },
      { slug: "custom:model", name: "Custom model" },
    ]);
  });

  it("treats the live Droid catalog as authoritative and drops invalid custom slugs", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "droid",
        staticOptions: [
          { slug: "retired-model", name: "Retired" },
          { slug: "made-up-model", name: "Made up", isCustom: true },
        ],
        dynamicModels: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
      }),
    ).toEqual([{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }]);
  });

  it("deduplicates Cursor transport variants by their base model", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "cursor",
        staticOptions: [
          {
            slug: "grok-4.5[thinking=true]",
            name: "Cursor Grok 4.5",
            isCustom: true,
          },
        ],
        dynamicModels: [
          {
            slug: "grok-4.5",
            name: "Cursor Grok 4.5",
            upstreamProviderId: "xai",
            upstreamProviderName: "xAI",
          },
          { slug: "grok-4.5[thinking=true]", name: "Cursor Grok 4.5" },
        ],
      }),
    ).toEqual([
      {
        slug: "grok-4.5",
        name: "Cursor Grok 4.5",
        upstreamProviderId: "xai",
        upstreamProviderName: "xAI",
      },
    ]);
  });

  it("orders discovered Claude models by the curated catalog, not by CLI order", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "claudeAgent",
        staticOptions: [
          { slug: "claude-fable-5", name: "Claude Fable 5" },
          { slug: "claude-opus-5", name: "Claude Opus 5" },
          { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
          { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
          { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        ],
        dynamicModels: [
          { slug: "default", name: "Default (recommended)" },
          { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
          { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
          { slug: "claude-fable-5", name: "Claude Fable 5" },
          { slug: "claude-opus-5", name: "Claude Opus 5" },
        ],
      }).map((option) => option.slug),
    ).toEqual([
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("keeps discovered Claude models the catalog does not know yet at the top", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "claudeAgent",
        staticOptions: [
          { slug: "claude-fable-5", name: "Claude Fable 5" },
          { slug: "claude-opus-5", name: "Claude Opus 5" },
        ],
        dynamicModels: [
          { slug: "claude-opus-5", name: "Claude Opus 5" },
          { slug: "claude-opus-6", name: "Claude Opus 6" },
        ],
      }).map((option) => option.slug),
    ).toEqual(["claude-opus-6", "claude-fable-5", "claude-opus-5"]);
  });

  it("treats the live Grok CLI catalog as authoritative", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "grok",
        staticOptions: [
          { slug: "grok-4.6", name: "Grok 4.6" },
          { slug: "grok-4.5", name: "Grok 4.5" },
          { slug: "grok-build", name: "Grok 4.3" },
          { slug: "custom/grok-fast", name: "custom/grok-fast", isCustom: true },
        ],
        dynamicModels: [{ slug: "grok-4.6", name: "Grok 4.6" }],
      }),
    ).toEqual([
      { slug: "grok-4.6", name: "Grok 4.6" },
      { slug: "custom/grok-fast", name: "custom/grok-fast", isCustom: true },
    ]);
  });
});

describe("providerModelCostMultiplierLabel", () => {
  it("formats live provider multipliers without hardcoding their values", () => {
    expect(providerModelCostMultiplierLabel("0.38x Factory token rate")).toBe("0.38×");
    expect(providerModelCostMultiplierLabel("12x Factory token rate")).toBe("12×");
  });

  it("ignores descriptions that do not begin with a multiplier", () => {
    expect(providerModelCostMultiplierLabel("Launch Pricing")).toBeNull();
    expect(providerModelCostMultiplierLabel()).toBeNull();
  });
});

describe("providerModelOptionProvenanceLabel", () => {
  it("prefers the discovered upstream provider name", () => {
    expect(
      providerModelOptionProvenanceLabel({
        provider: "opencode",
        option: {
          slug: "opencode-go/deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          upstreamProviderId: "opencode-go",
          upstreamProviderName: "OpenCode Go",
        },
      }),
    ).toBe("OpenCode Go");
  });

  it("falls back to a humanized slug provider, then the Synara provider", () => {
    expect(
      providerModelOptionProvenanceLabel({
        provider: "opencode",
        option: {
          slug: "local-runtime/deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
        },
      }),
    ).toBe("Local Runtime");
    expect(
      providerModelOptionProvenanceLabel({
        provider: "cursor",
        option: { slug: "auto", name: "Auto" },
      }),
    ).toBe("Cursor");
  });
});

describe("buildProviderOptionPatch", () => {
  it("passes through option ids unchanged", () => {
    expect(buildProviderOptionPatch("codex", "reasoningEffort", "xhigh")).toEqual({
      reasoningEffort: "xhigh",
    });
    expect(buildProviderOptionPatch("droid", "reasoningEffort", "high")).toEqual({
      reasoningEffort: "high",
    });
    expect(buildProviderOptionPatch("grok", "reasoningEffort", "high")).toEqual({
      reasoningEffort: "high",
    });
    expect(buildProviderOptionPatch("cursor", "fastMode", true)).toEqual({ fastMode: true });
  });
});

describe("groupProviderModelOptions", () => {
  it("groups provider models by upstream provider", () => {
    const options = [
      {
        slug: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
    ] satisfies ProviderModelOption[];

    const groupedOptions = groupProviderModelOptions(options);

    expect(groupedOptions.map((group) => group.label)).toEqual(["Anthropic", "OpenAI"]);
  });
});

describe("groupProviderModelOptionsWithFavorites", () => {
  it("adds a favourites group ahead of the normal provider groups", () => {
    const options = [
      {
        slug: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
    ] satisfies ProviderModelOption[];

    const groupedOptions = groupProviderModelOptionsWithFavorites({
      options,
      favoriteSlugs: new Set(["openai/gpt-5"]),
    });

    expect(groupedOptions.map((group) => group.label)).toEqual(["Favourites", "Anthropic"]);
    expect(groupedOptions[0]?.options.map((option) => option.slug)).toEqual(["openai/gpt-5"]);
    expect(groupedOptions.flatMap((group) => group.options.map((option) => option.slug))).toEqual([
      "openai/gpt-5",
      "anthropic/claude-sonnet",
    ]);
  });
});

describe("collapsible model group helpers", () => {
  it("enables collapsible sections only for long grouped lists while not searching", () => {
    expect(shouldUseCollapsibleModelGroups(2, false)).toBe(false);
    expect(shouldUseCollapsibleModelGroups(3, false)).toBe(true);
    expect(shouldUseCollapsibleModelGroups(4, true)).toBe(false);
  });

  it("keeps favourites and the active model group expanded by default", () => {
    expect(
      resolveModelGroupDefaultOpen({
        groupKey: "__favorites__",
        options: [{ slug: "openai/gpt-5", name: "GPT-5" }],
        activeModel: "anthropic/claude-sonnet",
        groupCount: 4,
      }),
    ).toBe(true);
    expect(
      resolveModelGroupDefaultOpen({
        groupKey: "openai",
        options: [{ slug: "openai/gpt-5", name: "GPT-5" }],
        activeModel: "openai/gpt-5",
        groupCount: 4,
      }),
    ).toBe(true);
    expect(
      resolveModelGroupDefaultOpen({
        groupKey: "anthropic",
        options: [{ slug: "anthropic/claude-sonnet", name: "Claude Sonnet" }],
        activeModel: "openai/gpt-5",
        groupCount: 4,
      }),
    ).toBe(false);
  });
});
