import { describe, expect, it } from "vitest";
import {
  CLAUDE_API_EFFORT_OPTIONS,
  CLAUDE_CODE_MODE_OPTIONS,
  CLAUDE_PROMPT_MODE_OPTIONS,
  DEFAULT_DROID_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_REASONING_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS,
  MODEL_OPTIONS_BY_PROVIDER,
  CODEX_REASONING_EFFORT_OPTIONS,
  GROK_4_5_REASONING_EFFORTS,
  GROK_4_6_REASONING_EFFORTS,
  GROK_BUILD_REASONING_EFFORTS,
} from "@synara/contracts";

import {
  applyClaudePromptEffortPrefix,
  claudeSelectionRequiresRestart,
  formatModelDisplayName,
  getDefaultAutoCompactWindow,
  getDefaultContextWindow,
  getDefaultModel,
  getModelCapabilities,
  getModelOptions,
  hasContextWindowOption,
  hasAutoCompactWindowOption,
  isClaudeUltrathinkPrompt,
  normalizeAntigravityModelOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeCursorModelOptions,
  normalizeGrokModelOptions,
  normalizeModelSlug,
  normalizePiModelOptions,
  parseCursorCliReasoningEffort,
  resolveApiModelId,
  resolveDevinModelVariant,
  resolveSelectableModel,
  resolveModelSlug,
  resolveModelSlugForProvider,
  getDefaultEffort,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  hasEffortLevel,
  resolveGrokEffortFamily,
} from "./model";

describe("Git text generation defaults", () => {
  it("uses GPT-5.6 Luna with high reasoning", () => {
    expect(DEFAULT_GIT_TEXT_GENERATION_MODEL).toBe("gpt-5.6-luna");
    expect(DEFAULT_GIT_TEXT_GENERATION_REASONING_EFFORT).toBe("high");
  });
});

describe("parseCursorCliReasoningEffort", () => {
  it.each([
    ["gpt-5.5-xhigh", "xhigh"],
    ["gpt-5.5-extra-high", "xhigh"],
    ["claude-fable-5-max", "max"],
    ["gpt-5.5-none", "none"],
    ["gpt-5.5-low", "low"],
    ["gpt-5.5-medium", "medium"],
    ["gpt-5.5-high", "high"],
    ["gpt-5.5-fast", undefined],
  ] as const)("parses %s as %s", (model, expected) => {
    expect(parseCursorCliReasoningEffort(model)).toBe(expected);
  });
});

describe("resolveDevinModelVariant", () => {
  it("resolves static SWE fast variants", () => {
    expect(resolveDevinModelVariant({ model: "swe-1-6", fastMode: true })).toBe("swe-1-6-fast");
    expect(resolveDevinModelVariant({ model: "swe-1-7", fastMode: true })).toBe(
      "swe-1-7-lightning",
    );
    expect(resolveDevinModelVariant({ model: "swe-1-7", fastMode: false })).toBe("swe-1-7");
  });

  it("recomputes runtime variants from current traits instead of a stored variant", () => {
    expect(
      resolveDevinModelVariant({
        model: "gpt-5.6-sol",
        modelVariant: "gpt-5-6-sol-high",
        reasoningEffort: "low",
        runtimeModel: {
          slug: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          defaultReasoningEffort: "medium",
          modelVariants: [
            { model: "gpt-5-6-sol-low", reasoningEffort: "low", fastMode: false },
            { model: "gpt-5-6-sol-high", reasoningEffort: "high", fastMode: false },
          ],
        },
      }),
    ).toBe("gpt-5-6-sol-low");
  });

  it("preserves an explicit variant when no supplied trait maps to a variant dimension", () => {
    expect(
      resolveDevinModelVariant({
        model: "custom-family",
        modelVariant: "custom-concrete-model",
        thinking: false,
        runtimeModel: {
          slug: "custom-family",
          name: "Custom Family",
          modelVariants: [{ model: "custom-concrete-model" }],
        },
      }),
    ).toBe("custom-concrete-model");
  });

  it("returns undefined when no variant matches an all-fast matrix", () => {
    expect(
      resolveDevinModelVariant({
        runtimeModel: {
          slug: "devin",
          name: "Devin",
          supportsFastMode: true,
          modelVariants: [
            { model: "devin-fast-1", reasoningEffort: "medium", fastMode: true },
            { model: "devin-fast-2", reasoningEffort: "high", fastMode: true },
          ],
        },
        fastMode: false,
      }),
    ).toBeUndefined();
  });
});

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.5")).toBe("gpt-5.5");
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });

  it("uses provider-specific aliases", () => {
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("claude-sonnet-5");
    expect(normalizeModelSlug("opus", "claudeAgent")).toBe("claude-opus-5");
    expect(normalizeModelSlug("opus-5", "claudeAgent")).toBe("claude-opus-5");
    expect(normalizeModelSlug("claude-opus-5", "claudeAgent")).toBe("claude-opus-5");
    expect(normalizeModelSlug("opus-4.8", "claudeAgent")).toBe("claude-opus-4-8");
    expect(normalizeModelSlug("sonnet-4.6", "claudeAgent")).toBe("claude-sonnet-4-6");
    expect(normalizeModelSlug("opus-4.6", "claudeAgent")).toBe("claude-opus-4-6");
    expect(normalizeModelSlug("claude-haiku-4-5-20251001", "claudeAgent")).toBe("claude-haiku-4-5");
    expect(normalizeModelSlug("4.3", "grok")).toBe("grok-build");
    expect(normalizeModelSlug("grok-latest", "grok")).toBe("grok-build");
    expect(normalizeModelSlug("grok-code-fast-1", "grok")).toBe("grok-build-0.1");
    expect(normalizeModelSlug("grok-code-fast-1-0825", "grok")).toBe("grok-build-0.1");
    expect(normalizeModelSlug("4.5", "grok")).toBe("grok-4.5");
    expect(normalizeModelSlug("grok-4.6", "grok")).toBe("grok-4.6");
    expect(normalizeModelSlug("Vendor/ModelCase-MEDIUM", "devin")).toBe("Vendor/ModelCase-MEDIUM");
    expect(normalizeModelSlug("swe-1-7-medium", "devin")).toBe("swe-1-7");
  });

  it("resolves devin aliases to canonical swe-1-6 / swe-1-7 slugs", () => {
    expect(normalizeModelSlug("swe-1.7", "devin")).toBe("swe-1-7");
    expect(normalizeModelSlug("swe-1.6", "devin")).toBe("swe-1-6");
    expect(normalizeModelSlug("swe-1.6-fast", "devin")).toBe("swe-1-6");
    expect(normalizeModelSlug("fast", "devin")).toBe("swe-1-6");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });

  it("supports provider-aware resolution", () => {
    expect(resolveModelSlugForProvider("claudeAgent", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
    expect(resolveModelSlugForProvider("claudeAgent", "sonnet")).toBe("claude-sonnet-5");
    expect(resolveModelSlugForProvider("claudeAgent", "gpt-5.3-codex")).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
  });

  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS);
    expect(getModelOptions("claudeAgent")).toEqual(MODEL_OPTIONS_BY_PROVIDER.claudeAgent);
  });
});

describe("resolveSelectableModel", () => {
  it("resolves exact slug matches", () => {
    expect(
      resolveSelectableModel("codex", "gpt-5.3-codex", [
        { slug: "gpt-5.4", name: "GPT-5.4" },
        { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      ]),
    ).toBe("gpt-5.3-codex");
  });

  it("resolves case-insensitive display-name matches", () => {
    expect(
      resolveSelectableModel("codex", "gpt-5.3 codex", [
        { slug: "gpt-5.4", name: "GPT-5.4" },
        { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      ]),
    ).toBe("gpt-5.3-codex");
  });

  it("resolves provider-specific aliases after normalization", () => {
    expect(
      resolveSelectableModel("claudeAgent", "sonnet", [
        { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
        { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ]),
    ).toBe("claude-sonnet-5");
    expect(
      resolveSelectableModel("claudeAgent", "sonnet-4.6", [
        { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ]),
    ).toBe("claude-sonnet-4-6");
  });

  it("returns null for empty input", () => {
    expect(resolveSelectableModel("codex", "", [{ slug: "gpt-5.4", name: "GPT-5.4" }])).toBeNull();
    expect(
      resolveSelectableModel("codex", "   ", [{ slug: "gpt-5.4", name: "GPT-5.4" }]),
    ).toBeNull();
    expect(
      resolveSelectableModel("codex", null, [{ slug: "gpt-5.4", name: "GPT-5.4" }]),
    ).toBeNull();
  });

  it("returns null for unknown values that are not present in options", () => {
    expect(
      resolveSelectableModel("codex", "gpt-4.1", [{ slug: "gpt-5.4", name: "GPT-5.4" }]),
    ).toBeNull();
  });

  it("does not accept normalized custom-looking slugs unless they exist in options", () => {
    expect(
      resolveSelectableModel("codex", "custom/internal-model", [
        { slug: "gpt-5.4", name: "GPT-5.4" },
      ]),
    ).toBeNull();
  });

  it("respects provider boundaries", () => {
    expect(
      resolveSelectableModel("codex", "sonnet", [{ slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" }]),
    ).toBeNull();
    expect(
      resolveSelectableModel("claudeAgent", "5.3", [
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ]),
    ).toBeNull();
  });
});

describe("getModelCapabilities reasoningEffortLevels", () => {
  const values = (provider: "codex" | "claudeAgent" | "grok" | "droid", model: string | null) =>
    getModelCapabilities(provider, model).reasoningEffortLevels.map((l) => l.value);

  it("returns codex reasoning options for codex", () => {
    expect(values("codex", "gpt-5.5")).toEqual([...CODEX_REASONING_EFFORT_OPTIONS]);
    expect(values("codex", "gpt-5.4")).toEqual([...CODEX_REASONING_EFFORT_OPTIONS]);
  });

  it("matches Droid's GPT-5.5 and GPT-5.6 fallback effort ladders", () => {
    expect(values("droid", "gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(values("droid", "gpt-5.5-pro")).toEqual(["medium", "high", "xhigh"]);
    expect(values("droid", "gpt-5.6-sol")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("models Droid fast mode as a separate GPT-5.5 slug, not a GPT-5.6 toggle", () => {
    const droidSlugs = MODEL_OPTIONS_BY_PROVIDER.droid.map((model) => model.slug);

    expect(droidSlugs).toContain("gpt-5.5-fast");
    expect(droidSlugs).toContain(DEFAULT_DROID_GIT_TEXT_GENERATION_MODEL);
    expect(droidSlugs).not.toContain("gpt-5.6-fast");
    expect(getModelCapabilities("droid", "gpt-5.6-sol").supportsFastMode).toBe(false);
  });

  it("returns claude effort options for Opus 4.6", () => {
    expect(values("claudeAgent", "claude-opus-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "ultrathink",
    ]);
  });

  it("returns claude effort options for Fable 5", () => {
    expect(values("claudeAgent", "claude-fable-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
  });

  it("returns claude effort options for Opus 5", () => {
    expect(values("claudeAgent", "claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
  });

  it("returns claude effort options for Opus 4.7", () => {
    expect(values("claudeAgent", "claude-opus-4-7")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultrathink",
      "ultracode",
    ]);
  });

  it("returns claude effort options for Opus 4.8", () => {
    expect(values("claudeAgent", "claude-opus-4-8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultrathink",
      "ultracode",
    ]);
  });

  it("returns claude effort options for Sonnet 5", () => {
    expect(values("claudeAgent", "claude-sonnet-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
  });

  it("marks Claude API efforts separately from Claude Code modes", () => {
    expect([...CLAUDE_API_EFFORT_OPTIONS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect([...CLAUDE_PROMPT_MODE_OPTIONS]).toEqual(["ultrathink"]);
    expect([...CLAUDE_CODE_MODE_OPTIONS]).toEqual(["ultracode"]);

    const sonnet5Levels = getModelCapabilities(
      "claudeAgent",
      "claude-sonnet-5",
    ).reasoningEffortLevels;
    expect(sonnet5Levels.find((option) => option.value === "max")).toMatchObject({
      controlSource: "api-effort",
    });
    expect(sonnet5Levels.find((option) => option.value === "ultracode")).toMatchObject({
      controlSource: "provider-setting",
      apiEffortValue: "xhigh",
    });

    const opus46Levels = getModelCapabilities(
      "claudeAgent",
      "claude-opus-4-6",
    ).reasoningEffortLevels;
    expect(opus46Levels.find((option) => option.value === "ultrathink")).toMatchObject({
      controlSource: "prompt-prefix",
    });
  });

  it("returns claude effort options for Sonnet 4.6", () => {
    expect(values("claudeAgent", "claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "ultrathink",
    ]);
  });

  it("returns no claude effort options for Haiku 4.5", () => {
    expect(values("claudeAgent", "claude-haiku-4-5")).toEqual([]);
  });

  it("returns Grok Build effort options for grok-build models", () => {
    expect(values("grok", "grok-build-0.1")).toEqual([...GROK_BUILD_REASONING_EFFORTS]);
    expect(values("grok", "grok-build")).toEqual([...GROK_BUILD_REASONING_EFFORTS]);
  });

  it("returns Grok 4.5 and 4.6 CLI effort ladders", () => {
    expect(values("grok", "grok-4.5")).toEqual([...GROK_4_5_REASONING_EFFORTS]);
    expect(values("grok", "grok-4.6")).toEqual([...GROK_4_6_REASONING_EFFORTS]);
    expect(values("grok", "grok-4.7")).toEqual([...GROK_4_6_REASONING_EFFORTS]);
  });

  it("co-locates labels with effort values", () => {
    const levels = getModelCapabilities("claudeAgent", "claude-opus-4-6").reasoningEffortLevels;
    const high = levels.find((l) => l.value === "high");
    expect(high).toMatchObject({
      value: "high",
      label: "High",
      isDefault: true,
      controlSource: "api-effort",
    });
    const xhigh = getModelCapabilities("claudeAgent", "claude-opus-4-7").reasoningEffortLevels.find(
      (l) => l.value === "xhigh",
    );
    expect(xhigh).toMatchObject({
      value: "xhigh",
      label: "Extra High",
      controlSource: "api-effort",
    });
    expect(
      getModelCapabilities("grok", "grok-4.6").reasoningEffortLevels.find(
        (l) => l.value === "xhigh",
      ),
    ).toMatchObject({
      value: "xhigh",
      label: "Extra High",
      description: "Highest effort and reasoning level",
    });
  });
});

describe("getDefaultEffort", () => {
  it("returns the default effort from capabilities", () => {
    expect(getDefaultEffort(getModelCapabilities("codex", "gpt-5.5"))).toBe("medium");
    expect(getDefaultEffort(getModelCapabilities("codex", "gpt-5.4"))).toBe("high");
    expect(getDefaultEffort(getModelCapabilities("claudeAgent", "claude-opus-5"))).toBe("high");
    expect(getDefaultEffort(getModelCapabilities("claudeAgent", "claude-opus-4-7"))).toBe("high");
    expect(getDefaultEffort(getModelCapabilities("claudeAgent", "claude-opus-4-6"))).toBe("high");
    expect(getDefaultEffort(getModelCapabilities("claudeAgent", "claude-sonnet-5"))).toBe("high");
    expect(getDefaultEffort(getModelCapabilities("claudeAgent", "claude-haiku-4-5"))).toBeNull();
    expect(getDefaultEffort(getModelCapabilities("grok", "grok-build-0.1"))).toBe("low");
    expect(getDefaultEffort(getModelCapabilities("grok", "grok-build"))).toBe("low");
    expect(getDefaultEffort(getModelCapabilities("grok", "grok-4.5"))).toBe("high");
    expect(getDefaultEffort(getModelCapabilities("grok", "grok-4.6"))).toBe("high");
  });
});

describe("hasEffortLevel", () => {
  it("validates effort against model capabilities", () => {
    const opusCaps = getModelCapabilities("claudeAgent", "claude-opus-4-6");
    expect(hasEffortLevel(opusCaps, "max")).toBe(true);
    expect(hasEffortLevel(opusCaps, "xhigh")).toBe(false);

    const opus47Caps = getModelCapabilities("claudeAgent", "claude-opus-4-7");
    expect(hasEffortLevel(opus47Caps, "xhigh")).toBe(true);

    const codexCaps = getModelCapabilities("codex", "gpt-5.4");
    expect(hasEffortLevel(codexCaps, "xhigh")).toBe(true);
    expect(hasEffortLevel(codexCaps, "max")).toBe(false);

    const grokBuildCaps = getModelCapabilities("grok", "grok-build-0.1");
    expect(hasEffortLevel(grokBuildCaps, "high")).toBe(true);
    expect(hasEffortLevel(grokBuildCaps, "xhigh")).toBe(false);

    const grok46Caps = getModelCapabilities("grok", "grok-4.6");
    expect(hasEffortLevel(grok46Caps, "xhigh")).toBe(true);
    expect(hasEffortLevel(grok46Caps, "none")).toBe(false);
  });
});

describe("resolveGrokEffortFamily", () => {
  it("classifies grok-build, Grok 4.5, and Grok 4.6+ ladders", () => {
    expect(resolveGrokEffortFamily("grok-build")).toBe("build");
    expect(resolveGrokEffortFamily("grok-build-0.1")).toBe("build");
    expect(resolveGrokEffortFamily("grok-code-fast-1")).toBe("build");
    expect(resolveGrokEffortFamily("grok-4.3")).toBe("build");
    expect(resolveGrokEffortFamily("grok-4.5")).toBe("4.5");
    expect(resolveGrokEffortFamily("grok-4.6")).toBe("4.6");
    expect(resolveGrokEffortFamily("grok-4.7")).toBe("4.6");
    expect(resolveGrokEffortFamily("custom/grok-fast")).toBe("build");
  });
});

describe("provider option descriptor helpers", () => {
  it("projects legacy Codex capability flags into generic option descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      provider: "codex",
      caps: getModelCapabilities("codex", "gpt-5.4"),
      selections: { reasoningEffort: "xhigh", fastMode: true },
    });

    const reasoning = descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
    const fastMode = descriptors.find((descriptor) => descriptor.id === "fastMode");

    expect(reasoning).toMatchObject({
      type: "select",
      currentValue: "xhigh",
    });
    expect(getProviderOptionCurrentLabel(reasoning)).toBe("Extra High");
    expect(fastMode).toMatchObject({
      type: "boolean",
      currentValue: true,
    });
  });

  it("projects Grok reasoning effort into a generic option descriptor", () => {
    const descriptors = getProviderOptionDescriptors({
      provider: "grok",
      caps: getModelCapabilities("grok", "grok-build"),
      selections: { reasoningEffort: "high" },
    });

    expect(descriptors.find((descriptor) => descriptor.id === "reasoningEffort")).toMatchObject({
      type: "select",
      currentValue: "high",
    });

    const grok46 = getProviderOptionDescriptors({
      provider: "grok",
      caps: getModelCapabilities("grok", "grok-4.6"),
      selections: { reasoningEffort: "xhigh" },
    });
    expect(grok46.find((descriptor) => descriptor.id === "reasoningEffort")).toMatchObject({
      type: "select",
      currentValue: "xhigh",
    });
    expect(
      getProviderOptionCurrentLabel(
        grok46.find((descriptor) => descriptor.id === "reasoningEffort"),
      ),
    ).toBe("Extra High");
  });

  it("maps Pi reasoning controls onto the thinkingLevel option", () => {
    const descriptors = getProviderOptionDescriptors({
      provider: "pi",
      caps: {
        reasoningEffortLevels: [
          { value: "off", label: "Off" },
          { value: "medium", label: "Medium", isDefault: true },
          { value: "xhigh", label: "Extra High" },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
      selections: { thinkingLevel: "xhigh" },
    });

    expect(descriptors.find((descriptor) => descriptor.id === "thinkingLevel")).toMatchObject({
      type: "select",
      currentValue: "xhigh",
    });
    expect(descriptors.some((descriptor) => descriptor.id === "reasoningEffort")).toBe(false);
  });

  it("surfaces Devin runtime reasoningEffortLevels and keeps effort/fast controls", () => {
    const descriptors = getProviderOptionDescriptors({
      provider: "devin",
      caps: {
        reasoningEffortLevels: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: true,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
      selections: { reasoningEffort: "high" },
    });
    expect(descriptors.find((descriptor) => descriptor.id === "reasoningEffort")).toMatchObject({
      label: "Reasoning",
      type: "select",
      currentValue: "high",
    });
    const reasoning = descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
    if (reasoning?.type === "select") {
      expect(reasoning.options.map((option) => option.id)).toEqual(["low", "medium", "high"]);
    }
    expect(descriptors.some((descriptor) => descriptor.id === "variant")).toBe(false);
    expect(descriptors.find((descriptor) => descriptor.id === "fastMode")).toMatchObject({
      type: "boolean",
    });
    expect(descriptors.find((descriptor) => descriptor.id === "thinking")).toMatchObject({
      type: "boolean",
      currentValue: true,
    });
  });
  it("honors explicit descriptors and serializes their current values", () => {
    const descriptors = getProviderOptionDescriptors({
      provider: "codex",
      caps: {
        ...getModelCapabilities("codex", "gpt-5.4"),
        optionDescriptors: [
          {
            id: "reasoningDepth",
            label: "Reasoning Depth",
            type: "select",
            options: [
              { id: "normal", label: "Normal", isDefault: true },
              { id: "deep", label: "Deep" },
            ],
          },
        ],
      },
      selections: [{ id: "reasoningDepth", value: "deep" }],
    });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({ id: "reasoningDepth", currentValue: "deep" });
    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningDepth", value: "deep" },
    ]);
  });
});

describe("context window helpers", () => {
  it("separates Claude's real context capacity from its auto-compact budget", () => {
    const opusCaps = getModelCapabilities("claudeAgent", "claude-opus-4-6");
    expect(getDefaultContextWindow(opusCaps)).toBeNull();
    expect(getDefaultAutoCompactWindow(opusCaps)).toBe("200k");
    expect(opusCaps.contextWindowTokens).toBe(1_000_000);
    expect(getModelCapabilities("claudeAgent", "claude-opus-4-5").contextWindowTokens).toBe(
      200_000,
    );
    const opus5Caps = getModelCapabilities("claudeAgent", "claude-opus-5");
    expect(opus5Caps.contextWindowTokens).toBe(1_000_000);
    expect(getDefaultAutoCompactWindow(opus5Caps)).toBe("200k");
    expect(getDefaultContextWindow(getModelCapabilities("codex", "gpt-5.4"))).toBeNull();
  });

  it("validates auto-compact budgets against model capabilities", () => {
    const opusCaps = getModelCapabilities("claudeAgent", "claude-opus-4-6");
    expect(hasContextWindowOption(opusCaps, "1m")).toBe(false);
    expect(hasAutoCompactWindowOption(opusCaps, "200k")).toBe(true);
    expect(hasAutoCompactWindowOption(opusCaps, "1m")).toBe(true);
    expect(hasAutoCompactWindowOption(opusCaps, "2m")).toBe(false);
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("prefixes ultrathink prompts exactly once", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this",
    );
    expect(applyClaudePromptEffortPrefix("Ultrathink:\nInvestigate this", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this",
    );
  });

  it("leaves non-ultrathink prompts unchanged", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this", "high")).toBe("Investigate this");
  });
});

describe("formatModelDisplayName", () => {
  it("returns built-in display names for known models", () => {
    expect(formatModelDisplayName("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(formatModelDisplayName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(formatModelDisplayName("claude-opus-5")).toBe("Claude Opus 5");
  });

  it("humanizes unknown GPT model slugs", () => {
    expect(formatModelDisplayName("gpt-5.1-codex-max")).toBe("GPT-5.1 Codex Max");
    expect(formatModelDisplayName("gpt-5.1-codex-mini")).toBe("GPT-5.1 Codex Mini");
  });

  it("leaves non-GPT custom slugs unchanged", () => {
    expect(formatModelDisplayName("custom/internal-model")).toBe("custom/internal-model");
  });
});

describe("normalizeCodexModelOptions", () => {
  it("drops default-only codex options", () => {
    expect(
      normalizeCodexModelOptions("gpt-5.4", { reasoningEffort: "high", fastMode: false }),
    ).toBeUndefined();
  });

  it("preserves non-default codex options", () => {
    expect(
      normalizeCodexModelOptions("gpt-5.4", { reasoningEffort: "xhigh", fastMode: true }),
    ).toEqual({
      reasoningEffort: "xhigh",
      fastMode: true,
    });
  });
});

describe("normalizeClaudeModelOptions", () => {
  it("drops default-only claude options", () => {
    expect(
      normalizeClaudeModelOptions("claude-opus-4-6", {
        effort: "high",
        fastMode: false,
        autoCompactWindow: "200k",
      }),
    ).toBeUndefined();
  });

  it("preserves non-default Claude auto-compact budgets", () => {
    expect(
      normalizeClaudeModelOptions("claude-opus-4-6", {
        autoCompactWindow: "1m",
      }),
    ).toEqual({
      autoCompactWindow: "1m",
    });
  });

  it("migrates the legacy context-window field to the auto-compact budget", () => {
    expect(
      normalizeClaudeModelOptions("claude-opus-4-6", {
        contextWindow: "1m",
      }),
    ).toEqual({
      autoCompactWindow: "1m",
    });
  });

  it("omits unsupported Claude auto-compact budgets", () => {
    expect(
      normalizeClaudeModelOptions("claude-haiku-4-5", {
        thinking: false,
        contextWindow: "1m",
      }),
    ).toEqual({
      thinking: false,
    });
  });

  it("keeps Sonnet 5 xhigh and ultracode options while removing unsupported fast mode", () => {
    expect(
      normalizeClaudeModelOptions("claude-sonnet-5", {
        effort: "xhigh",
        fastMode: true,
      }),
    ).toEqual({
      effort: "xhigh",
    });
    expect(
      normalizeClaudeModelOptions("claude-sonnet-5", {
        effort: "ultracode",
      }),
    ).toEqual({
      effort: "ultracode",
    });
  });

  it("drops unsupported fast mode for Sonnet while preserving max effort", () => {
    expect(
      normalizeClaudeModelOptions("claude-sonnet-4-6", {
        effort: "max",
        fastMode: true,
      }),
    ).toEqual({
      effort: "max",
    });
  });

  it("keeps the Haiku thinking toggle and removes unsupported effort", () => {
    expect(
      normalizeClaudeModelOptions("claude-haiku-4-5", {
        thinking: false,
        effort: "high",
      }),
    ).toEqual({
      thinking: false,
    });
  });
});

describe("resolveApiModelId", () => {
  it("keeps native-1M Claude model ids unchanged", () => {
    expect(
      resolveApiModelId({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { autoCompactWindow: "1m" },
      }),
    ).toBe("claude-opus-4-6");
    expect(
      resolveApiModelId({
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        options: { autoCompactWindow: "1m" },
      }),
    ).toBe("claude-sonnet-5");
  });

  it("leaves Claude models unchanged for the default context window", () => {
    expect(
      resolveApiModelId({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { contextWindow: "200k" },
      }),
    ).toBe("claude-opus-4-6");
  });
});

describe("claudeSelectionRequiresRestart", () => {
  const selection = (
    model: string,
    options?: {
      effort?: string;
      contextWindow?: string;
      autoCompactWindow?: string;
      fastMode?: boolean;
      thinking?: boolean;
    },
  ) =>
    ({
      provider: "claudeAgent",
      model,
      ...(options ? { options } : {}),
    }) as Parameters<typeof claudeSelectionRequiresRestart>[1];

  it("never restarts for non-Claude selections", () => {
    expect(
      claudeSelectionRequiresRestart(
        { provider: "codex", model: "gpt-5.5" },
        { provider: "codex", model: "gpt-5.4" },
      ),
    ).toBe(false);
  });

  it("does not restart on the first observed selection", () => {
    expect(
      claudeSelectionRequiresRestart(undefined, selection("claude-opus-4-8", { effort: "max" })),
    ).toBe(false);
  });

  it("does not restart for a model-only change", () => {
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8", { effort: "max" }),
        selection("claude-fable-5", { effort: "max" }),
      ),
    ).toBe(false);
  });

  it("restarts when a model switch makes a persisted max effort effective", () => {
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-haiku-4-5", { effort: "max" }),
        selection("claude-sonnet-5", { effort: "max" }),
      ),
    ).toBe(true);
  });

  it("restarts when a model switch makes a persisted max effort unsupported", () => {
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-sonnet-5", { effort: "max" }),
        selection("claude-haiku-4-5", { effort: "max" }),
      ),
    ).toBe(true);
  });

  it("does not restart when a model switch carries an unsupported thinking override", () => {
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-haiku-4-5", { thinking: false }),
        selection("claude-opus-4-8", { thinking: false }),
      ),
    ).toBe(false);
  });

  it("does not restart when a model switch carries an unsupported fast-mode flag", () => {
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8", { effort: "high", fastMode: true }),
        selection("claude-sonnet-5", { effort: "high", fastMode: true }),
      ),
    ).toBe(false);
  });

  it("still restarts when spawn-fixed options change together with the model", () => {
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8", { effort: "high" }),
        selection("claude-sonnet-5", { effort: "max" }),
      ),
    ).toBe(true);
  });

  it("does not restart for an auto-compact-budget-only change", () => {
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8", { effort: "xhigh", autoCompactWindow: "200k" }),
        selection("claude-opus-4-8", { effort: "xhigh", autoCompactWindow: "1m" }),
      ),
    ).toBe(false);
  });

  it("restarts when max effort toggles on", () => {
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8", { effort: "high" }),
        selection("claude-opus-4-8", { effort: "max" }),
      ),
    ).toBe(true);
  });

  it("restarts when max effort toggles off", () => {
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8", { effort: "max" }),
        selection("claude-opus-4-8", { effort: "high" }),
      ),
    ).toBe(true);
  });

  it("does not restart for a non-max effort change", () => {
    // Non-max effort rides in the flag-settings layer (`effortLevel`) and
    // switches live via applyFlagSettings.
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8", { effort: "high" }),
        selection("claude-opus-4-8", { effort: "xhigh" }),
      ),
    ).toBe(false);
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8"),
        selection("claude-opus-4-8", { effort: "low" }),
      ),
    ).toBe(false);
  });

  it("treats ultrathink as prompt-injected, not a spawn change", () => {
    // ultrathink carries no API effort, so switching from no effort to ultrathink
    // must not respawn the subprocess.
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8"),
        selection("claude-opus-4-8", { effort: "ultrathink" }),
      ),
    ).toBe(false);
  });

  it("does not restart when ultracode toggles", () => {
    // ultracode is a Settings key (xhigh effortLevel + ultracode) applied live.
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8", { effort: "xhigh" }),
        selection("claude-opus-4-8", { effort: "ultracode" }),
      ),
    ).toBe(false);
  });

  it("does not restart when fast mode toggles", () => {
    // fastMode is a Settings key applied live via applyFlagSettings.
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-opus-4-8", { effort: "high" }),
        selection("claude-opus-4-8", { effort: "high", fastMode: true }),
      ),
    ).toBe(false);
  });

  it("does not restart when the thinking toggle changes", () => {
    // The thinking toggle switches live via the SDK flag-settings control.
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-haiku-4-5"),
        selection("claude-haiku-4-5", { thinking: false }),
      ),
    ).toBe(false);
  });

  it("ignores options the target model does not support", () => {
    // fastMode is not supported on Sonnet models, so toggling it is a no-op.
    expect(
      claudeSelectionRequiresRestart(
        selection("claude-sonnet-5", { effort: "high" }),
        selection("claude-sonnet-5", { effort: "high", fastMode: true }),
      ),
    ).toBe(false);
  });
});

describe("normalizeCursorModelOptions", () => {
  it("sends the selected Cursor Grok effort even when it is the model default", () => {
    expect(
      normalizeCursorModelOptions("grok-4.6", { reasoningEffort: "high", fastMode: true }),
    ).toEqual({
      reasoningEffort: "high",
      fastMode: true,
    });
    expect(normalizeCursorModelOptions("grok-4.6", { fastMode: true })).toEqual({
      reasoningEffort: "high",
      fastMode: true,
    });
    expect(normalizeCursorModelOptions("grok-4.6", { reasoningEffort: "high" })).toEqual({
      reasoningEffort: "high",
      fastMode: false,
    });
  });

  it("keeps a non-default Cursor Grok effort when fast mode is enabled", () => {
    expect(
      normalizeCursorModelOptions("grok-4.6", { reasoningEffort: "low", fastMode: true }),
    ).toEqual({
      reasoningEffort: "low",
      fastMode: true,
    });
  });
});

describe("normalizeGrokModelOptions", () => {
  it("drops default Grok reasoning effort options and preserves supported overrides", () => {
    expect(normalizeGrokModelOptions("grok-build", { reasoningEffort: "low" })).toBeUndefined();
    expect(normalizeGrokModelOptions("grok-build-0.1", { reasoningEffort: "low" })).toBeUndefined();
    expect(
      normalizeGrokModelOptions("grok-build", { reasoningEffort: "max" as never }),
    ).toBeUndefined();
    expect(
      normalizeGrokModelOptions("grok-build", { reasoningEffort: "xhigh" as never }),
    ).toBeUndefined();
    expect(normalizeGrokModelOptions("grok-build-0.1", { reasoningEffort: "high" })).toEqual({
      reasoningEffort: "high",
    });
    expect(normalizeGrokModelOptions("grok-4.5", { reasoningEffort: "high" })).toBeUndefined();
    expect(normalizeGrokModelOptions("grok-4.6", { reasoningEffort: "high" })).toBeUndefined();
    expect(normalizeGrokModelOptions("grok-4.6", { reasoningEffort: "xhigh" })).toEqual({
      reasoningEffort: "xhigh",
    });
    expect(normalizeGrokModelOptions("grok-4.6", { reasoningEffort: "none" })).toBeUndefined();
  });
});

describe("normalizePiModelOptions", () => {
  it("keeps supported Pi thinking levels including max", () => {
    expect(normalizePiModelOptions({ thinkingLevel: "high" })).toEqual({ thinkingLevel: "high" });
    expect(normalizePiModelOptions({ thinkingLevel: "max" })).toEqual({ thinkingLevel: "max" });
    expect(normalizePiModelOptions({ thinkingLevel: "ultra" as never })).toBeUndefined();
    expect(normalizePiModelOptions({})).toBeUndefined();
  });
});

describe("normalizeAntigravityModelOptions", () => {
  it("stores only supported non-default effort overrides", () => {
    const runtimeCapabilities = {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true as const },
        { value: "high", label: "High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      promptInjectedEffortLevels: [],
      contextWindowOptions: [],
    };
    expect(
      normalizeAntigravityModelOptions(
        "Gemini 3.5 Flash",
        { reasoningEffort: "medium" },
        runtimeCapabilities,
      ),
    ).toBeUndefined();
    expect(
      normalizeAntigravityModelOptions(
        "Gemini 3.5 Flash",
        { reasoningEffort: "ultra" },
        runtimeCapabilities,
      ),
    ).toBeUndefined();
    expect(
      normalizeAntigravityModelOptions(
        "Gemini 3.5 Flash",
        { reasoningEffort: "high" },
        runtimeCapabilities,
      ),
    ).toEqual({ reasoningEffort: "high" });
  });
});

describe("getModelCapabilities Claude capability flags", () => {
  it("enables adaptive reasoning for supported Claude models", () => {
    const has = (m: string | undefined) =>
      getModelCapabilities("claudeAgent", m).reasoningEffortLevels.length > 0;
    expect(has("claude-opus-5")).toBe(true);
    expect(has("claude-opus-4-8")).toBe(true);
    expect(has("claude-opus-4-7")).toBe(true);
    expect(has("claude-opus-4-6")).toBe(true);
    expect(has("claude-sonnet-5")).toBe(true);
    expect(has("claude-sonnet-4-6")).toBe(true);
    expect(has("claude-haiku-4-5")).toBe(false);
    expect(has(undefined)).toBe(false);
  });

  it("enables max effort for supported Claude models", () => {
    const has = (m: string | undefined) =>
      getModelCapabilities("claudeAgent", m).reasoningEffortLevels.some((l) => l.value === "max");
    expect(has("claude-opus-5")).toBe(true);
    expect(has("claude-opus-4-8")).toBe(true);
    expect(has("claude-opus-4-7")).toBe(true);
    expect(has("claude-opus-4-6")).toBe(true);
    expect(has("claude-sonnet-5")).toBe(true);
    expect(has("claude-sonnet-4-6")).toBe(true);
    expect(has("claude-haiku-4-5")).toBe(false);
    expect(has(undefined)).toBe(false);
  });

  it("only enables Claude fast mode for Opus 4.6", () => {
    const has = (m: string | undefined) => getModelCapabilities("claudeAgent", m).supportsFastMode;
    expect(has("claude-opus-5")).toBe(true);
    expect(has("claude-opus-4-8")).toBe(true);
    expect(has("claude-opus-4-7")).toBe(true);
    expect(has("claude-opus-4-6")).toBe(true);
    expect(has("opus")).toBe(true);
    expect(has("claude-sonnet-5")).toBe(false);
    expect(has("claude-sonnet-4-6")).toBe(false);
    expect(has("claude-haiku-4-5")).toBe(false);
    expect(has(undefined)).toBe(false);
  });

  it("only enables ultrathink keyword handling for Opus 4.6 and Sonnet 4.6", () => {
    const has = (m: string | undefined) =>
      getModelCapabilities("claudeAgent", m).promptInjectedEffortLevels.includes("ultrathink");
    expect(has("claude-fable-5")).toBe(false);
    expect(has("claude-opus-5")).toBe(false);
    expect(has("claude-opus-4-8")).toBe(true);
    expect(has("claude-opus-4-7")).toBe(true);
    expect(has("claude-opus-4-6")).toBe(true);
    expect(has("claude-sonnet-5")).toBe(false);
    expect(has("claude-sonnet-4-6")).toBe(true);
    expect(has("claude-haiku-4-5")).toBe(false);
  });

  it("only enables the Claude thinking toggle for Haiku 4.5", () => {
    const has = (m: string | undefined) =>
      getModelCapabilities("claudeAgent", m).supportsThinkingToggle;
    expect(has("claude-opus-5")).toBe(false);
    expect(has("claude-opus-4-6")).toBe(false);
    expect(has("claude-sonnet-5")).toBe(false);
    expect(has("claude-sonnet-4-6")).toBe(false);
    expect(has("claude-haiku-4-5")).toBe(true);
    expect(has("haiku")).toBe(true);
    expect(has(undefined)).toBe(false);
  });
});

describe("isClaudeUltrathinkPrompt", () => {
  it("detects ultrathink prompts case-insensitively", () => {
    expect(isClaudeUltrathinkPrompt("Please ultrathink about this")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Ultrathink:\nInvestigate")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Think hard about this")).toBe(false);
    expect(isClaudeUltrathinkPrompt(undefined)).toBe(false);
  });
});
