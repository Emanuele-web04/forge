import { type ProviderModelDescriptor, ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderRegistry";
import { getComposerTraitSelection } from "./composerTraits";

const OPENCODE_RUNTIME_MODEL_WITH_REASONING: ProviderModelDescriptor = {
  slug: "openai/gpt-5.4",
  name: "GPT-5.4",
  upstreamProviderId: "openai",
  upstreamProviderName: "OpenAI",
  supportedReasoningEfforts: [
    { value: "none" },
    { value: "low" },
    { value: "medium" },
    { value: "high" },
    { value: "xhigh" },
  ],
  defaultReasoningEffort: "medium",
};

const OPENCODE_RUNTIME_MODEL_WITHOUT_DEFAULT: ProviderModelDescriptor = {
  slug: "opencode/gpt-5-nano",
  name: "GPT-5 Nano",
  upstreamProviderId: "opencode",
  upstreamProviderName: "OpenCode",
  supportedReasoningEfforts: [
    { value: "minimal" },
    { value: "low" },
    { value: "medium" },
    { value: "high" },
  ],
};

const CURSOR_RUNTIME_MODEL_300K: ProviderModelDescriptor = {
  slug: "claude-opus-4-7",
  name: "Claude Opus 4.7",
  upstreamProviderId: "anthropic",
  upstreamProviderName: "Anthropic",
  supportedReasoningEfforts: [
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ],
  defaultReasoningEffort: "high",
  contextWindowOptions: [{ value: "300k", label: "300K", isDefault: true }],
  defaultContextWindow: "300k",
};

const PI_RUNTIME_MODEL_WITH_REASONING: ProviderModelDescriptor = {
  slug: "openai/gpt-5.5",
  name: "GPT-5.5",
  upstreamProviderId: "openai",
  upstreamProviderName: "OpenAI",
  supportedReasoningEfforts: [
    { value: "off", label: "Off" },
    { value: "medium", label: "Medium" },
    { value: "xhigh", label: "Extra High" },
  ],
  defaultReasoningEffort: "medium",
};

const DROID_RUNTIME_GPT_5_6_WITH_REASONING: ProviderModelDescriptor = {
  slug: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  supportedReasoningEfforts: [
    { value: "none", label: "None" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
  ],
  defaultReasoningEffort: "medium",
};

const ANTIGRAVITY_RUNTIME_GEMINI_WITH_REASONING: ProviderModelDescriptor = {
  slug: "Gemini 3.5 Flash",
  name: "Gemini 3.5 Flash",
  supportedReasoningEfforts: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  defaultReasoningEffort: "medium",
};

const ANTIGRAVITY_RUNTIME_CLAUDE_WITH_SINGLE_EFFORT: ProviderModelDescriptor = {
  slug: "Claude Sonnet 4.6",
  name: "Claude Sonnet 4.6",
  supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
  defaultReasoningEffort: "thinking",
};

const GROK_RUNTIME_4_5_WITH_REASONING: ProviderModelDescriptor = {
  slug: "grok-4.5",
  name: "Grok 4.5",
  supportedReasoningEfforts: [
    { value: "none" },
    { value: "low" },
    { value: "medium" },
    { value: "high" },
  ],
  defaultReasoningEffort: "low",
};

describe("getComposerProviderState", () => {
  it("dispatches Antigravity effort separately from its base model", () => {
    const state = getComposerProviderState({
      provider: "antigravity",
      model: "Gemini 3.5 Flash",
      runtimeModel: ANTIGRAVITY_RUNTIME_GEMINI_WITH_REASONING,
      prompt: "",
      modelOptions: { antigravity: { reasoningEffort: "high" } },
    });

    expect(state).toEqual({
      provider: "antigravity",
      promptEffort: "high",
      modelOptionsForDispatch: { reasoningEffort: "high" },
    });
    expect(
      getComposerTraitSelection(
        "antigravity",
        "Gemini 3.5 Flash",
        "",
        { reasoningEffort: "high" },
        ANTIGRAVITY_RUNTIME_GEMINI_WITH_REASONING,
      ).effortLevels.map((effort) => effort.value),
    ).toEqual(["low", "medium", "high"]);
    expect(
      renderProviderTraitsPicker({
        provider: "antigravity",
        threadId: ThreadId.makeUnsafe("thread-antigravity-effort"),
        model: "Gemini 3.5 Flash",
        runtimeModel: ANTIGRAVITY_RUNTIME_GEMINI_WITH_REASONING,
        modelOptions: { reasoningEffort: "high" },
        prompt: "",
        onPromptChange: vi.fn(),
      }),
    ).not.toBeNull();
  });

  it("hides Antigravity effort controls when the selected model has only one effort", () => {
    const selection = getComposerTraitSelection(
      "antigravity",
      "Claude Sonnet 4.6",
      "",
      undefined,
      ANTIGRAVITY_RUNTIME_CLAUDE_WITH_SINGLE_EFFORT,
    );

    expect(selection.effortLevels).toEqual([]);
    expect(
      renderProviderTraitsPicker({
        provider: "antigravity",
        threadId: ThreadId.makeUnsafe("thread-antigravity-single-effort"),
        model: "Claude Sonnet 4.6",
        runtimeModel: ANTIGRAVITY_RUNTIME_CLAUDE_WITH_SINGLE_EFFORT,
        modelOptions: undefined,
        prompt: "",
        onPromptChange: vi.fn(),
      }),
    ).toBeNull();
  });

  it("returns codex defaults when no codex draft options exist", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("normalizes codex dispatch options while preserving the selected effort", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "low",
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "low",
      modelOptionsForDispatch: {
        reasoningEffort: "low",
        fastMode: true,
      },
    });
  });

  it("reads only Codex options when other provider effort state is present", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "",
      modelOptions: {
        codex: { reasoningEffort: "xhigh" },
        cursor: { reasoningEffort: "low" },
      },
    });

    expect(state.modelOptionsForDispatch).toEqual({ reasoningEffort: "xhigh" });
    expect(state.promptEffort).toBe("xhigh");
  });

  it("reads only Cursor options when Codex runtime effort state is present", () => {
    const state = getComposerProviderState({
      provider: "cursor",
      model: "claude-opus-4-7",
      runtimeModel: CURSOR_RUNTIME_MODEL_300K,
      prompt: "",
      modelOptions: {
        codex: { reasoningEffort: "ultra" },
        cursor: { reasoningEffort: "xhigh" },
      },
    });

    expect(state.modelOptionsForDispatch).toEqual({ reasoningEffort: "xhigh" });
    expect(state.promptEffort).toBe("xhigh");
  });

  it("preserves a stored runtime Codex effort for dispatch before discovery resolves", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.6-sol",
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "ultra",
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "ultra",
      modelOptionsForDispatch: {
        reasoningEffort: "ultra",
      },
    });
  });

  it("rejects an unsupported effort for a known static Codex model before discovery", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "ultra",
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it.each([
    {
      shape: "omits the effort list",
      runtimeModel: { slug: "gpt-5.4", name: "GPT-5.4" },
    },
    {
      shape: "reports an empty effort list",
      runtimeModel: {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        supportedReasoningEfforts: [],
      },
    },
  ])("falls back to static Codex efforts when runtime metadata $shape", ({ runtimeModel }) => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      runtimeModel,
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "xhigh",
      modelOptionsForDispatch: {
        reasoningEffort: "xhigh",
      },
    });
  });

  it("drops a stored runtime Codex effort after discovery proves it unsupported", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.6-terra",
      runtimeModel: {
        slug: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        supportedReasoningEfforts: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
          { value: "max" },
        ],
        defaultReasoningEffort: "low",
      },
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "ultra",
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "low",
      modelOptionsForDispatch: undefined,
    });
  });

  it("preserves codex fast mode when it is the only active option", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "",
      modelOptions: {
        codex: {
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        fastMode: true,
      },
    });
  });

  it("preserves codex fast mode for runtime-discovered models that advertise support", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.6-preview",
      runtimeModel: {
        slug: "gpt-5.6-preview",
        name: "GPT-5.6 Preview",
        supportsFastMode: true,
        supportedReasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        defaultReasoningEffort: "medium",
      },
      prompt: "",
      modelOptions: {
        codex: {
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "medium",
      modelOptionsForDispatch: {
        fastMode: true,
      },
    });
  });

  it("drops codex fast mode when runtime discovery does not advertise support", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4-mini",
      runtimeModel: {
        slug: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        supportedReasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        defaultReasoningEffort: "medium",
      },
      prompt: "",
      modelOptions: {
        codex: {
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "medium",
      modelOptionsForDispatch: undefined,
    });
  });

  it("drops explicit codex default/off overrides from dispatch while keeping the selected effort label", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("returns Claude defaults for effort-capable models", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("tracks Claude ultrathink from the prompt without changing dispatch effort", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      prompt: "Ultrathink:\nInvestigate this failure",
      modelOptions: {
        claudeAgent: {
          effort: "medium",
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "medium",
      modelOptionsForDispatch: {
        effort: "medium",
      },
      composerFrameClassName: "ultrathink-frame",
      modelPickerIconClassName: "ultrathink-chroma",
    });
  });

  it("treats descriptor prompt-injected choices like legacy prompt-controlled efforts", () => {
    const selection = getComposerTraitSelection(
      "claudeAgent",
      "claude-sonnet-4-6",
      "Ultrathink:\nInvestigate this",
      { effort: "ultrathink" },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            promptInjectedValues: ["ultrathink"],
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "ultrathink", label: "Ultrathink" },
            ],
          },
        ],
      },
    );

    expect(selection.promptInjectedValues).toContain("ultrathink");
    expect(selection.effort).toBe("high");
    expect(selection.ultrathinkPromptControlled).toBe(true);
  });

  it("drops unsupported Claude effort options for models without effort controls", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "max",
          thinking: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: null,
      modelOptionsForDispatch: {
        thinking: false,
      },
    });
  });

  it("preserves Claude fast mode when it is the only active option", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      prompt: "",
      modelOptions: {
        claudeAgent: {
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "high",
      modelOptionsForDispatch: {
        fastMode: true,
      },
    });
  });

  it("drops explicit Claude default/off overrides from dispatch while keeping the selected effort label", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          fastMode: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("normalizes Grok reasoning effort options for dispatch", () => {
    const state = getComposerProviderState({
      provider: "grok",
      model: "grok-build",
      prompt: "",
      modelOptions: {
        grok: {
          reasoningEffort: "high",
        },
      },
    });

    expect(state).toEqual({
      provider: "grok",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
      },
    });
  });

  it("drops explicit Grok default reasoning effort from dispatch", () => {
    const state = getComposerProviderState({
      provider: "grok",
      model: "grok-build",
      prompt: "",
      modelOptions: {
        grok: {
          reasoningEffort: "low",
        },
      },
    });

    expect(state).toEqual({
      provider: "grok",
      promptEffort: "low",
      modelOptionsForDispatch: undefined,
    });
  });

  it("exposes and dispatches efforts for dynamically discovered Grok models", () => {
    const selection = getComposerTraitSelection(
      "grok",
      "grok-4.5",
      "",
      { reasoningEffort: "high" },
      GROK_RUNTIME_4_5_WITH_REASONING,
    );
    const state = getComposerProviderState({
      provider: "grok",
      model: "grok-4.5",
      runtimeModel: GROK_RUNTIME_4_5_WITH_REASONING,
      prompt: "",
      modelOptions: { grok: { reasoningEffort: "high" } },
    });

    expect(selection.effortLevels.map((effort) => effort.value)).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(selection.defaultEffort).toBe("low");
    expect(selection.effort).toBe("high");
    expect(state).toEqual({
      provider: "grok",
      promptEffort: "high",
      modelOptionsForDispatch: { reasoningEffort: "high" },
    });
  });

  it("exposes Grok efforts before runtime model discovery resolves", () => {
    const selection = getComposerTraitSelection("grok", "grok-4.5", "", undefined);

    expect(selection.effortLevels.map((effort) => effort.value)).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(selection.defaultEffort).toBe("low");
    expect(selection.effort).toBe("low");
  });

  it("exposes and dispatches runtime-discovered Droid efforts for GPT-5.6", () => {
    const threadId = ThreadId.makeUnsafe("thread-droid-gpt-5-6-effort");
    const selection = getComposerTraitSelection(
      "droid",
      "gpt-5.6-sol",
      "",
      { reasoningEffort: "xhigh" },
      DROID_RUNTIME_GPT_5_6_WITH_REASONING,
    );
    const state = getComposerProviderState({
      provider: "droid",
      model: "gpt-5.6-sol",
      runtimeModel: DROID_RUNTIME_GPT_5_6_WITH_REASONING,
      prompt: "",
      modelOptions: { droid: { reasoningEffort: "xhigh" } },
    });
    const picker = renderProviderTraitsPicker({
      provider: "droid",
      threadId,
      model: "gpt-5.6-sol",
      runtimeModel: DROID_RUNTIME_GPT_5_6_WITH_REASONING,
      modelOptions: { reasoningEffort: "xhigh" },
      prompt: "",
      includeFastMode: false,
      onPromptChange: vi.fn(),
    });

    expect(selection.effortLevels.map((effort) => effort.value)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(selection.effort).toBe("xhigh");
    expect(state).toEqual({
      provider: "droid",
      promptEffort: "xhigh",
      modelOptionsForDispatch: { reasoningEffort: "xhigh" },
    });
    expect(picker).not.toBeNull();
  });

  it("dispatches an explicitly selected Droid effort even when ACP reports it as current", () => {
    expect(
      getComposerProviderState({
        provider: "droid",
        model: "gpt-5.6-sol",
        runtimeModel: DROID_RUNTIME_GPT_5_6_WITH_REASONING,
        prompt: "",
        modelOptions: { droid: { reasoningEffort: "medium" } },
      }),
    ).toMatchObject({
      promptEffort: "medium",
      modelOptionsForDispatch: { reasoningEffort: "medium" },
    });
  });

  it("dispatches Cursor fast mode off when the lightning bolt is inactive", () => {
    const state = getComposerProviderState({
      provider: "cursor",
      model: "grok-4.5",
      prompt: "",
      modelOptions: {
        cursor: {
          reasoningEffort: "medium",
        },
      },
    });

    expect(state).toEqual({
      provider: "cursor",
      promptEffort: "medium",
      modelOptionsForDispatch: {
        reasoningEffort: "medium",
        fastMode: false,
      },
    });
  });

  it("dispatches Cursor fast mode off for runtime Grok models that advertise the toggle", () => {
    const state = getComposerProviderState({
      provider: "cursor",
      model: "grok-4.6",
      runtimeModel: {
        slug: "grok-4.6",
        name: "Grok 4.6",
        upstreamProviderId: "xai",
        upstreamProviderName: "xAI",
        supportsFastMode: true,
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra High" },
        ],
        defaultReasoningEffort: "high",
      },
      prompt: "",
      modelOptions: {
        cursor: {
          reasoningEffort: "medium",
          fastMode: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "cursor",
      promptEffort: "medium",
      modelOptionsForDispatch: {
        reasoningEffort: "medium",
        fastMode: false,
      },
    });
  });

  it("drops stale Cursor context options once runtime metadata is authoritative", () => {
    const state = getComposerProviderState({
      provider: "cursor",
      model: "claude-opus-4-7",
      runtimeModel: CURSOR_RUNTIME_MODEL_300K,
      prompt: "",
      modelOptions: {
        cursor: {
          reasoningEffort: "xhigh",
          contextWindow: "1m",
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "cursor",
      promptEffort: "xhigh",
      modelOptionsForDispatch: {
        reasoningEffort: "xhigh",
      },
    });
  });

  it("keeps Pi runtime thinking selections on the thinkingLevel field", () => {
    const selection = getComposerTraitSelection(
      "pi",
      "openai/gpt-5.5",
      "",
      { thinkingLevel: "xhigh" },
      PI_RUNTIME_MODEL_WITH_REASONING,
    );
    const state = getComposerProviderState({
      provider: "pi",
      model: "openai/gpt-5.5",
      runtimeModel: PI_RUNTIME_MODEL_WITH_REASONING,
      prompt: "",
      modelOptions: {
        pi: {
          thinkingLevel: "xhigh",
        },
      },
    });

    expect(selection.primarySelectDescriptor?.id).toBe("thinkingLevel");
    expect(selection.effort).toBe("xhigh");
    expect(state).toEqual({
      provider: "pi",
      promptEffort: "xhigh",
      modelOptionsForDispatch: {
        thinkingLevel: "xhigh",
      },
    });
  });

  it("keeps Pi max thinking selections when discovery advertises max", () => {
    const runtimeModel: ProviderModelDescriptor = {
      slug: "moonshotai/kimi-k3",
      name: "Kimi K3",
      upstreamProviderId: "moonshotai",
      upstreamProviderName: "Moonshot AI",
      supportedReasoningEfforts: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ],
      defaultReasoningEffort: "high",
    };
    const selection = getComposerTraitSelection(
      "pi",
      "moonshotai/kimi-k3",
      "",
      { thinkingLevel: "max" },
      runtimeModel,
    );
    const state = getComposerProviderState({
      provider: "pi",
      model: "moonshotai/kimi-k3",
      runtimeModel,
      prompt: "",
      modelOptions: {
        pi: {
          thinkingLevel: "max",
        },
      },
    });

    expect(selection.effort).toBe("max");
    expect(selection.primarySelectDescriptor).toMatchObject({
      id: "thinkingLevel",
      currentValue: "max",
    });
    expect(state).toEqual({
      provider: "pi",
      promptEffort: "max",
      modelOptionsForDispatch: {
        thinkingLevel: "max",
      },
    });
  });

  it("does not render a traits picker for OpenCode models without exposed controls", () => {
    const threadId = ThreadId.makeUnsafe("thread-opencode-traits-hidden");

    const picker = renderProviderTraitsPicker({
      provider: "opencode",
      threadId,
      model: "openrouter/gpt-oss-120b:free",
      modelOptions: undefined,
      prompt: "",
      includeFastMode: false,
      onPromptChange: vi.fn(),
    });

    const menuContent = renderProviderTraitsMenuContent({
      provider: "opencode",
      threadId,
      model: "openrouter/gpt-oss-120b:free",
      modelOptions: undefined,
      prompt: "",
      onPromptChange: vi.fn(),
    });

    expect(picker).toBeNull();
    expect(menuContent).toBeNull();
  });

  it("keeps OpenCode runtime thinking selections on the variant field", () => {
    const state = getComposerProviderState({
      provider: "opencode",
      model: "openai/gpt-5.4",
      runtimeModel: OPENCODE_RUNTIME_MODEL_WITH_REASONING,
      prompt: "",
      modelOptions: {
        opencode: {
          variant: "xhigh",
        },
      },
    });

    expect(state).toEqual({
      provider: "opencode",
      promptEffort: "xhigh",
      modelOptionsForDispatch: {
        variant: "xhigh",
      },
    });
  });

  it("uses the runtime default thinking level for OpenCode trigger state", () => {
    const state = getComposerProviderState({
      provider: "opencode",
      model: "openai/gpt-5.4",
      runtimeModel: OPENCODE_RUNTIME_MODEL_WITH_REASONING,
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "opencode",
      promptEffort: "medium",
      modelOptionsForDispatch: undefined,
    });
  });

  it("falls back to the first OpenCode runtime variant when metadata omits a default", () => {
    const state = getComposerProviderState({
      provider: "opencode",
      model: "opencode/gpt-5-nano",
      runtimeModel: OPENCODE_RUNTIME_MODEL_WITHOUT_DEFAULT,
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "opencode",
      promptEffort: "minimal",
      modelOptionsForDispatch: undefined,
    });
  });

  it("renders OpenCode thinking controls when runtime metadata exposes levels without a default", () => {
    const threadId = ThreadId.makeUnsafe("thread-opencode-runtime-thinking");

    const picker = renderProviderTraitsPicker({
      provider: "opencode",
      threadId,
      model: "opencode/gpt-5-nano",
      runtimeModel: OPENCODE_RUNTIME_MODEL_WITHOUT_DEFAULT,
      modelOptions: undefined,
      prompt: "",
      includeFastMode: false,
      onPromptChange: vi.fn(),
    });

    const menuContent = renderProviderTraitsMenuContent({
      provider: "opencode",
      threadId,
      model: "opencode/gpt-5-nano",
      runtimeModel: OPENCODE_RUNTIME_MODEL_WITHOUT_DEFAULT,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: vi.fn(),
    });

    expect(picker).not.toBeNull();
    expect(menuContent).not.toBeNull();
  });
});
