import { ThreadId, type ModelSelection } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deriveEffectiveComposerModelState,
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "./composerDraftStore";
import {
  modelSelection,
  providerModelOptions,
  resetComposerDraftStore,
} from "./composerDraftStoreTestFixtures";

describe("resolvePreferredComposerModelSelection", () => {
  it("prefers the active draft provider selection over thread and project defaults", () => {
    expect(
      resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: {
            claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6", {
              effort: "max",
            }),
          },
          activeProvider: "claudeAgent",
        },
        threadModelSelection: modelSelection("codex", "gpt-5"),
        projectModelSelection: modelSelection("codex", "gpt-5.4"),
      }),
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
    );
  });

  it("can prefer Grok draft selections", () => {
    expect(
      resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: {
            grok: modelSelection("grok", "grok-build"),
          },
          activeProvider: "grok",
        },
        threadModelSelection: modelSelection("codex", "gpt-5"),
        projectModelSelection: modelSelection("codex", "gpt-5.4"),
      }),
    ).toEqual(modelSelection("grok", "grok-build"));
  });

  it("uses only the active provider selection for terminal-first promotion", () => {
    const cursorSelection = modelSelection("cursor", "cursor-auto", {
      reasoningEffort: "high",
    });
    expect(
      resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: {
            codex: modelSelection("codex", "gpt-5.6-sol", { reasoningEffort: "ultra" }),
            cursor: cursorSelection,
          },
          activeProvider: "cursor",
        },
        threadModelSelection: null,
        projectModelSelection: null,
      }),
    ).toEqual(cursorSelection);
  });
});

describe("composerDraftStore modelSelection", () => {
  const threadId = ThreadId.makeUnsafe("thread-model-options");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a model selection in the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );
  });

  it.each(["max", "ultra"])(
    "retains runtime-discovered Codex %s effort in thread and sticky selections",
    (reasoningEffort) => {
      const store = useComposerDraftStore.getState();
      const selection = modelSelection("codex", "gpt-5.6-sol", { reasoningEffort });

      store.setModelSelection(threadId, selection);
      store.setStickyModelSelection(selection);

      const state = useComposerDraftStore.getState();
      expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.codex).toEqual(selection);
      expect(state.stickyModelSelectionByProvider.codex).toEqual(selection);
    },
  );

  it("drops malformed Codex reasoning efforts while preserving other options", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(
      threadId,
      "codex",
      { reasoningEffort: "   ", fastMode: true },
      { model: "gpt-5.6-sol" },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(modelSelection("codex", "gpt-5.6-sol", { fastMode: true }));
  });

  it("keeps default-only model selections on the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(modelSelection("codex", "gpt-5.4"));
  });

  it("stores Grok selections instead of dropping them during normalization", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("grok", "grok-build"));
    store.setStickyModelSelection(modelSelection("grok", "grok-build"));

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.grok).toEqual(
      modelSelection("grok", "grok-build"),
    );
    expect(state.draftsByThreadId[threadId]?.activeProvider).toBe("grok");
    expect(state.stickyModelSelectionByProvider.grok).toEqual(modelSelection("grok", "grok-build"));
    expect(state.stickyActiveProvider).toBe("grok");
  });

  it("stores Antigravity base models and effort options separately", () => {
    const store = useComposerDraftStore.getState();
    const selection = modelSelection("antigravity", "Gemini 3.5 Flash", {
      reasoningEffort: "high",
    });

    store.setModelSelection(threadId, selection);
    store.setStickyModelSelection(selection);

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.antigravity).toEqual(
      selection,
    );
    expect(state.draftsByThreadId[threadId]?.activeProvider).toBe("antigravity");
    expect(state.stickyModelSelectionByProvider.antigravity).toEqual(selection);
    expect(state.stickyActiveProvider).toBe("antigravity");
  });

  it("replaces only the targeted provider options on the current model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );
    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      {
        thinking: false,
      },
      { persistSticky: true },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
  });

  it("keeps explicit default-state overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
    );

    store.setProviderModelOptions(threadId, "claudeAgent", {
      thinking: true,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
  });

  it("keeps explicit off/default codex overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4", { fastMode: true }));

    store.setProviderModelOptions(threadId, "codex", {
      reasoningEffort: "high",
      fastMode: false,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: false,
      }),
    );
  });

  it.each([
    { label: "omitted", options: undefined },
    { label: "disabled", options: { persistSticky: false } as const },
  ])("updates only the draft when sticky persistence is $label", ({ options }) => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(threadId, "claudeAgent", { thinking: false }, options);

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = useComposerDraftStore.getState();

    // Set options for both providers
    store.setModelOptions(
      threadId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    // Now set options for only codex — claudeAgent should be untouched
    store.setModelOptions(threadId, providerModelOptions({ codex: { reasoningEffort: "xhigh" } }));

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual({ reasoningEffort: "xhigh" });
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual({ effort: "max" });
  });

  it("preserves other provider options when switching the active model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(
      threadId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    store.setModelSelection(threadId, modelSelection("claudeAgent", "claude-opus-4-6"));

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual({ fastMode: true });
    expect(draft?.activeProvider).toBe("claudeAgent");
  });

  it("creates the first sticky snapshot from provider option changes", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));

    store.setProviderModelOptions(
      threadId,
      "codex",
      {
        fastMode: true,
      },
      { persistSticky: true },
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4", {
        fastMode: true,
      }),
    );
  });

  it("prefers the active OpenCode thread model over a stale draft default when runtime models are available", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {
          opencode: modelSelection("opencode", "openai/gpt-5"),
        },
        activeProvider: "opencode",
      },
      selectedProvider: "opencode",
      threadModelSelection: modelSelection("opencode", "opencode/gpt-5-nano"),
      projectModelSelection: null,
      customModelsByProvider: {
        codex: [],
        claudeAgent: [],
        cursor: [],
        antigravity: [],
        grok: [],
        droid: [],
        opencode: [],
        pi: [],
      },
      availableModelOptionsByProvider: {
        opencode: [{ slug: "opencode/gpt-5-nano", name: "GPT-5 Nano" }],
      },
    });

    expect(state.selectedModel).toBe("opencode/gpt-5-nano");
  });

  it("preserves the persisted OpenCode thread model when discovery omits it", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {},
        activeProvider: "opencode",
      },
      selectedProvider: "opencode",
      threadModelSelection: modelSelection("opencode", "openai/gpt-5.4"),
      projectModelSelection: null,
      customModelsByProvider: {
        codex: [],
        claudeAgent: [],
        cursor: [],
        antigravity: [],
        grok: [],
        droid: [],
        opencode: [],
        pi: [],
      },
      availableModelOptionsByProvider: {
        opencode: [
          { slug: "openai/gpt-5-codex", name: "GPT-5-Codex" },
          { slug: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini" },
        ],
      },
    });

    expect(state.selectedModel).toBe("openai/gpt-5.4");
  });

  it("falls back to the first exposed OpenCode runtime model when the draft selection is stale", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {
          opencode: modelSelection("opencode", "openai/gpt-5"),
        },
        activeProvider: "opencode",
      },
      selectedProvider: "opencode",
      threadModelSelection: null,
      projectModelSelection: null,
      customModelsByProvider: {
        codex: [],
        claudeAgent: [],
        cursor: [],
        antigravity: [],
        grok: [],
        droid: [],
        opencode: [],
        pi: [],
      },
      availableModelOptionsByProvider: {
        opencode: [
          { slug: "opencode/gpt-5-nano", name: "GPT-5 Nano" },
          { slug: "opencode/big-pickle", name: "Big Pickle" },
        ],
      },
    });

    expect(state.selectedModel).toBe("opencode/gpt-5-nano");
  });

  it("preserves a selected Pi custom model when discovery omits it", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {
          pi: modelSelection("pi", "openai/gpt-5.5"),
        },
        activeProvider: "pi",
      },
      selectedProvider: "pi",
      threadModelSelection: null,
      projectModelSelection: null,
      customModelsByProvider: {
        codex: [],
        claudeAgent: [],
        cursor: [],
        antigravity: [],
        grok: [],
        droid: [],
        opencode: [],
        pi: [],
      },
      availableModelOptionsByProvider: {
        pi: [
          { slug: "openai/gpt-5.1", name: "GPT-5.1" },
          { slug: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        ],
      },
    });

    expect(state.selectedModel).toBe("openai/gpt-5.5");
  });
});

describe("composerDraftStore setModelSelection", () => {
  const threadId = ThreadId.makeUnsafe("thread-model");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps explicit model overrides instead of coercing to null", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.3-codex"));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(modelSelection("codex", "gpt-5.3-codex"));
  });

  it("preserves newly discovered Droid effort strings in composer state", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadId, modelSelection("droid", "future-droid-model"));

    store.setProviderModelOptions(threadId, "droid", { reasoningEffort: "ultra" });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.droid,
    ).toEqual(modelSelection("droid", "future-droid-model", { reasoningEffort: "ultra" }));
  });

  it("drops a runtime Codex effort when switching models before terminal promotion", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelectionAndSticky(
      threadId,
      modelSelection("codex", "gpt-5.6-sol", {
        reasoningEffort: "ultra",
        fastMode: true,
      }),
    );

    store.setModelSelectionAndSticky(threadId, modelSelection("codex", "gpt-5.4"));

    const state = useComposerDraftStore.getState();
    const draft = state.draftsByThreadId[threadId];
    const expectedSelection = modelSelection("codex", "gpt-5.4", { fastMode: true });
    expect(draft?.modelSelectionByProvider.codex).toEqual(expectedSelection);
    expect(state.stickyModelSelectionByProvider.codex).toEqual(expectedSelection);
    expect(
      resolvePreferredComposerModelSelection({
        draft,
        threadModelSelection: null,
        projectModelSelection: null,
      }),
    ).toEqual(expectedSelection);
  });

  it("retains a runtime Codex effort when reselecting the same model", () => {
    const store = useComposerDraftStore.getState();
    const selection = modelSelection("codex", "gpt-5.6-sol", {
      reasoningEffort: "max",
      fastMode: true,
    });
    store.setModelSelectionAndSticky(threadId, selection);

    store.setModelSelectionAndSticky(threadId, modelSelection("codex", "gpt-5.6-sol"));

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.codex).toEqual(selection);
    expect(state.stickyModelSelectionByProvider.codex).toEqual(selection);
  });

  it("preserves a built-in Codex effort supported by both models", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelectionAndSticky(
      threadId,
      modelSelection("codex", "gpt-5.5", { reasoningEffort: "xhigh", fastMode: true }),
    );

    store.setModelSelectionAndSticky(threadId, modelSelection("codex", "gpt-5.4"));

    const expectedSelection = modelSelection("codex", "gpt-5.4", {
      reasoningEffort: "xhigh",
      fastMode: true,
    });
    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.codex).toEqual(
      expectedSelection,
    );
    expect(state.stickyModelSelectionByProvider.codex).toEqual(expectedSelection);
  });

  it("restores Cursor state without transferring the active Codex effort", () => {
    const store = useComposerDraftStore.getState();
    const cursorSelection = modelSelection("cursor", "cursor-auto", {
      reasoningEffort: "high",
    });
    store.setModelSelectionAndSticky(threadId, cursorSelection);
    store.setModelSelectionAndSticky(
      threadId,
      modelSelection("codex", "gpt-5.6-sol", { reasoningEffort: "ultra" }),
    );

    store.setModelSelectionAndSticky(threadId, modelSelection("cursor", "cursor-auto"));

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.cursor).toEqual(
      cursorSelection,
    );
    expect(state.stickyModelSelectionByProvider.cursor).toEqual(cursorSelection);
  });

  it("restores Codex state without transferring the active Cursor effort", () => {
    const store = useComposerDraftStore.getState();
    const codexSelection = modelSelection("codex", "gpt-5.4", {
      reasoningEffort: "xhigh",
    });
    store.setModelSelectionAndSticky(threadId, codexSelection);
    store.setModelSelectionAndSticky(
      threadId,
      modelSelection("cursor", "cursor-auto", { reasoningEffort: "high" }),
    );

    store.setModelSelectionAndSticky(threadId, modelSelection("codex", "gpt-5.4"));

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.codex).toEqual(
      codexSelection,
    );
    expect(state.stickyModelSelectionByProvider.codex).toEqual(codexSelection);
  });

  it("uses destination defaults when switching providers without saved state", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelectionAndSticky(
      threadId,
      modelSelection("codex", "gpt-5.6-sol", { reasoningEffort: "ultra" }),
    );

    store.setModelSelectionAndSticky(threadId, modelSelection("claudeAgent", "claude-opus-4-6"));

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6"),
    );
    expect(state.stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6"),
    );
  });
});

describe("composerDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a sticky model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("preserves Claude Auto support through sticky updates, options, and hydration", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-claude-auto-capability");
    const selection: ModelSelection = {
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      supportsAutoMode: false,
    };

    store.setModelSelectionAndSticky(threadId, selection);
    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      { effort: "high" },
      { persistSticky: true },
    );

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.claudeAgent).toEqual({
      ...selection,
      options: { effort: "high" },
    });
    expect(state.stickyModelSelectionByProvider.claudeAgent).toEqual({
      ...selection,
      options: { effort: "high" },
    });

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (persistedState: unknown, currentState: unknown) => unknown;
      };
    };
    const merged = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: state.draftsByThreadId[threadId],
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
        stickyModelSelectionByProvider: {
          claudeAgent: state.stickyModelSelectionByProvider.claudeAgent,
        },
        stickyActiveProvider: "claudeAgent",
      },
      useComposerDraftStore.getState(),
    ) as {
      draftsByThreadId: typeof state.draftsByThreadId;
      stickyModelSelectionByProvider: Partial<Record<ModelSelection["provider"], ModelSelection>>;
    };

    const hydratedClaudeSelection =
      merged.draftsByThreadId[threadId]?.modelSelectionByProvider.claudeAgent;
    expect(
      hydratedClaudeSelection?.provider === "claudeAgent"
        ? hydratedClaudeSelection.supportsAutoMode
        : undefined,
    ).toBe(false);
    expect(merged.stickyModelSelectionByProvider.claudeAgent).toMatchObject({
      supportsAutoMode: false,
    });
  });

  it("does not copy Claude Auto support metadata to a different model", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-claude-auto-model-switch");
    store.setModelSelection(threadId, {
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      supportsAutoMode: false,
    });

    store.setModelSelection(threadId, {
      provider: "claudeAgent",
      model: "claude-sonnet-5",
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-5",
    });
  });

  it("normalizes empty sticky model options by dropping selection options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection("codex", "gpt-5.4"));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4"),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("preserves current sticky model fields during storage-version migration", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
      };
    };
    const migratedState = persistApi.getOptions().migrate(
      {
        draftsByThreadId: {},
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
        stickyModelSelectionByProvider: {
          claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6", {
            effort: "max",
          }),
        },
        stickyActiveProvider: "claudeAgent",
        stickyProvider: "codex",
        stickyModel: "gpt-5",
      },
      4,
    ) as {
      stickyModelSelectionByProvider: Partial<Record<ModelSelection["provider"], ModelSelection>>;
      stickyActiveProvider: ModelSelection["provider"] | null;
    };

    expect(migratedState.stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
    );
    expect(migratedState.stickyActiveProvider).toBe("claudeAgent");
  });

  it("applies sticky activeProvider to new drafts", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-sticky-active-provider");

    store.setStickyModelSelection(modelSelection("claudeAgent", "claude-opus-4-6"));
    store.applyStickyState(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      modelSelectionByProvider: {
        claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6"),
      },
      activeProvider: "claudeAgent",
    });
  });

  it("does not overwrite existing model-scoped options with another sticky model", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-sticky-model-scope");
    const currentSelection = modelSelection("codex", "gpt-5.4", {
      reasoningEffort: "xhigh",
    });
    store.setStickyModelSelection(
      modelSelection("codex", "gpt-5.6-sol", { reasoningEffort: "ultra" }),
    );
    store.setModelSelection(threadId, currentSelection);

    store.applyStickyState(threadId);

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(currentSelection);
  });

  it("restores sticky options for the same provider and model", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-sticky-same-model");
    const stickySelection = modelSelection("codex", "gpt-5.4", {
      reasoningEffort: "xhigh",
    });
    store.setStickyModelSelection(stickySelection);
    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));

    store.applyStickyState(threadId);

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(stickySelection);
  });

  it("strips the Claude context window from sticky selections", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        contextWindow: "1m",
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });

  it("drops sticky Claude options entirely when only the context window was set", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", { contextWindow: "1m" }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6"),
    );
  });

  it("keeps the Claude auto-compact budget thread-local", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-sticky-auto-compact-window");

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      { effort: "xhigh", autoCompactWindow: "1m" },
      { persistSticky: true, model: "claude-opus-4-7" },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent?.options,
    ).toEqual({ effort: "xhigh", autoCompactWindow: "1m" });
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-7", { effort: "xhigh" }),
    );
  });

  it("does not persist Claude context window changes through sticky provider options", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-sticky-context-window");

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      { effort: "xhigh", contextWindow: "1m" },
      { persistSticky: true, model: "claude-opus-4-7" },
    );

    const state = useComposerDraftStore.getState();
    // The thread keeps its own choice and migrates the legacy field name.
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.claudeAgent?.options).toEqual(
      {
        effort: "xhigh",
        autoCompactWindow: "1m",
      },
    );
    // The sticky snapshot only carries options that are safe to inherit.
    expect(state.stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-7", { effort: "xhigh" }),
    );
  });

  it("sanitizes a persisted sticky Claude context window during hydration", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (persistedState: unknown, currentState: unknown) => unknown;
      };
    };
    const merged = persistApi.getOptions().merge(
      {
        draftsByThreadId: {},
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
        stickyModelSelectionByProvider: {
          claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6", {
            effort: "max",
            contextWindow: "1m",
          }),
        },
        stickyActiveProvider: "claudeAgent",
      },
      useComposerDraftStore.getState(),
    ) as {
      stickyModelSelectionByProvider: Partial<Record<ModelSelection["provider"], ModelSelection>>;
    };

    expect(merged.stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });
});

describe("composerDraftStore provider-scoped option updates", () => {
  const threadId = ThreadId.makeUnsafe("thread-provider");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("retains off-provider option memory without changing the active selection", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
      }),
    );
    store.setProviderModelOptions(threadId, "claudeAgent", { effort: "max" });
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", { reasoningEffort: "medium" }),
    );
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual({ effort: "max" });
    expect(draft?.activeProvider).toBe("codex");
  });

  it("retains Claude xhigh effort in provider-scoped options", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      { effort: "xhigh" },
      { model: "claude-opus-4-7" },
    );

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-7", {
        effort: "xhigh",
      }),
    );
  });

  it("retains Grok reasoning effort in provider-scoped options", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(
      threadId,
      "grok",
      { reasoningEffort: "high" },
      { model: "grok-build" },
    );

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.grok).toEqual(
      modelSelection("grok", "grok-build", {
        reasoningEffort: "high",
      }),
    );
  });
});
