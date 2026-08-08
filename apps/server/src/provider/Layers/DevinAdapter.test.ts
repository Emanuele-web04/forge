import { describe, expect, it } from "vitest";

import { mergeDevinModelDescriptors, parseDevinCliModelList } from "./DevinAdapter.ts";

describe("Devin model discovery", () => {
  it("publishes reasoning, fast, context, and concrete variant metadata", () => {
    const models = parseDevinCliModelList(
      JSON.stringify({
        families: [
          {
            family_uid: "gpt-5.6-sol",
            family_label: "GPT-5.6 Sol",
            slug: "gpt-5.6-sol",
            variants: [
              {
                model_uid: "gpt-5-6-sol-medium",
                label: "GPT-5.6 Sol Medium",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "gpt-5-6-sol-low",
                label: "GPT-5.6 Sol Low",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "gpt-5-6-sol-high",
                label: "GPT-5.6 Sol High",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "gpt-5-6-sol-medium-priority",
                label: "GPT-5.6 Sol Medium Priority",
                max_context_tokens: 1_000_000,
              },
            ],
          },
        ],
      }),
    );

    const [model] = mergeDevinModelDescriptors([models]);
    if (!model) throw new Error("Expected GPT-5.6 Sol to be discovered");
    expect(model).toMatchObject({
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportsFastMode: true,
      defaultContextWindow: "200k",
    });
    expect(model.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(model.contextWindowOptions?.map((option) => option.value)).toEqual(["200k", "1m"]);
    expect(model.modelVariants).toContainEqual({
      model: "gpt-5-6-sol-medium-priority",
      reasoningEffort: "medium",
      contextWindow: "1m",
      fastMode: true,
    });
  });

  it("exposes thinking and long-context toggles for Claude-style variants", () => {
    const models = parseDevinCliModelList(
      JSON.stringify({
        families: [
          {
            family_uid: "claude-opus-4.6",
            family_label: "Claude Opus 4.6",
            slug: "claude-opus-4.6",
            variants: [
              {
                model_uid: "claude-opus-4-6",
                label: "Claude Opus 4.6",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "claude-opus-4-6-thinking",
                label: "Claude Opus 4.6 Thinking",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "claude-opus-4-6-1m",
                label: "Claude Opus 4.6 1M",
                max_context_tokens: 1_000_000,
              },
              {
                model_uid: "claude-opus-4-6-thinking-1m",
                label: "Claude Opus 4.6 Thinking 1M",
                max_context_tokens: 1_000_000,
              },
            ],
          },
        ],
      }),
    );

    const [model] = mergeDevinModelDescriptors([models]);
    if (!model) throw new Error("Expected Claude Opus 4.6 to be discovered");
    expect(model).toMatchObject({
      supportsThinkingToggle: true,
      defaultContextWindow: "200k",
    });
    expect(model.contextWindowOptions?.map((option) => option.value)).toEqual(["200k", "1m"]);
    expect(model.modelVariants).toContainEqual({
      model: "claude-opus-4-6-thinking-1m",
      contextWindow: "1m",
      thinking: true,
    });
    expect(model.modelVariants).toContainEqual({
      model: "claude-opus-4-6",
      contextWindow: "200k",
      thinking: false,
    });
  });
});
