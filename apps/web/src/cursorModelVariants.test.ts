import { describe, expect, it } from "vitest";

import {
  collapseCursorModelVariants,
  normalizeCursorModelVariantBaseId,
} from "./cursorModelVariants";

describe("normalizeCursorModelVariantBaseId", () => {
  it("normalizes Cursor CLI reasoning, fast, and extra-high suffixes", () => {
    expect(normalizeCursorModelVariantBaseId("gpt-5.5-extra-high")).toBe("gpt-5.5");
    expect(normalizeCursorModelVariantBaseId("gpt-5.1-codex-max-medium-fast")).toBe(
      "gpt-5.1-codex-max",
    );
    expect(normalizeCursorModelVariantBaseId("claude-4.6-opus-max-thinking-fast")).toBe(
      "claude-opus-4-6",
    );
    expect(normalizeCursorModelVariantBaseId("claude-5-sonnet-max-fast")).toBe("claude-sonnet-5");
    // Live Cursor Agent CLI naming for xAI Grok (effort is a suffix, not a separate model).
    expect(normalizeCursorModelVariantBaseId("cursor-grok-4.5-high")).toBe("cursor-grok-4.5");
    expect(normalizeCursorModelVariantBaseId("cursor-grok-4.5-medium-fast")).toBe(
      "cursor-grok-4.5",
    );
    expect(normalizeCursorModelVariantBaseId("cursor-grok-4.5-low")).toBe("cursor-grok-4.5");
  });
});

describe("collapseCursorModelVariants", () => {
  it("keeps transport variants out of the model picker", () => {
    expect(
      collapseCursorModelVariants([
        {
          slug: "grok-4.5",
          name: "Cursor Grok 4.5",
          upstreamProviderId: "xai",
          upstreamProviderName: "xAI",
          supportsThinkingToggle: true,
        },
        {
          slug: "grok-4.5[thinking=true]",
          name: "Cursor Grok 4.5",
          upstreamProviderId: "xai",
          upstreamProviderName: "xAI",
        },
        {
          slug: "grok-4.5[thinking=false]",
          name: "Cursor Grok 4.5",
          upstreamProviderId: "xai",
          upstreamProviderName: "xAI",
        },
      ]),
    ).toEqual([
      {
        slug: "grok-4.5",
        name: "Cursor Grok 4.5",
        upstreamProviderId: "xai",
        upstreamProviderName: "xAI",
        supportsThinkingToggle: true,
      },
    ]);
  });

  // Live CLI lists effort as suffix rows (cursor-grok-4.5-high, …); picker must collapse to one base.
  it("collapses live cursor-grok-4.5 effort rows into one xAI model with traits", () => {
    const collapsed = collapseCursorModelVariants([
      {
        slug: "cursor-grok-4.5-high",
        name: "Cursor Grok 4.5",
        upstreamProviderId: "xai",
        upstreamProviderName: "xAI",
        supportedReasoningEfforts: [{ value: "high", label: "High" }],
        defaultReasoningEffort: "high",
      },
      {
        slug: "cursor-grok-4.5-medium",
        name: "Cursor Grok 4.5 Medium",
        upstreamProviderId: "xai",
        upstreamProviderName: "xAI",
        supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
        defaultReasoningEffort: "medium",
      },
      {
        slug: "cursor-grok-4.5-low-fast",
        name: "Cursor Grok 4.5 Low Fast",
        upstreamProviderId: "xai",
        upstreamProviderName: "xAI",
        supportedReasoningEfforts: [{ value: "low", label: "Low" }],
        defaultReasoningEffort: "low",
        supportsFastMode: true,
      },
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      slug: "cursor-grok-4.5",
      name: "Cursor Grok 4.5",
      upstreamProviderId: "xai",
      upstreamProviderName: "xAI",
      supportedReasoningEfforts: [
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      defaultReasoningEffort: "high",
      supportsFastMode: true,
    });
    expect(collapsed.some((model) => /-high$|-medium$|-low$/.test(model.slug))).toBe(false);
  });

  it("collapses Cursor CLI variants into one model with trait capabilities", () => {
    expect(
      collapseCursorModelVariants([
        {
          slug: "gpt-5.5-medium",
          name: "GPT-5.5 1M",
          upstreamProviderId: "openai",
          upstreamProviderName: "OpenAI",
          supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
          defaultReasoningEffort: "medium",
          contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
          defaultContextWindow: "1m",
        },
        {
          slug: "gpt-5.5-extra-high",
          name: "GPT-5.5 1M Extra High",
          upstreamProviderId: "openai",
          upstreamProviderName: "OpenAI",
          supportedReasoningEfforts: [{ value: "xhigh", label: "Extra High" }],
          defaultReasoningEffort: "xhigh",
          contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
          defaultContextWindow: "1m",
        },
      ]),
    ).toEqual([
      {
        slug: "gpt-5.5",
        name: "GPT-5.5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        supportedReasoningEfforts: [
          { value: "medium", label: "Medium", isDefault: true },
          { value: "xhigh", label: "Extra High" },
        ],
        defaultReasoningEffort: "medium",
        contextWindowOptions: [
          { value: "272k", label: "272K", isDefault: true },
          { value: "1m", label: "1M" },
        ],
        defaultContextWindow: "272k",
      },
    ]);
  });

  it("restores Cursor CLI fallback context choices for Fable 5 variants", () => {
    expect(
      collapseCursorModelVariants([
        {
          slug: "claude-fable-5-high",
          name: "Fable 5 1M",
          upstreamProviderId: "anthropic",
          upstreamProviderName: "Anthropic",
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
          defaultReasoningEffort: "high",
        },
        {
          slug: "claude-fable-5-max",
          name: "Fable 5 1M Max",
          upstreamProviderId: "anthropic",
          upstreamProviderName: "Anthropic",
          supportedReasoningEfforts: [{ value: "max", label: "Max" }],
          defaultReasoningEffort: "max",
        },
      ]),
    ).toEqual([
      {
        slug: "claude-fable-5",
        name: "Fable 5",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportedReasoningEfforts: [
          { value: "high", label: "High", isDefault: true },
          { value: "max", label: "Max" },
        ],
        defaultReasoningEffort: "high",
        contextWindowOptions: [
          { value: "300k", label: "300K", isDefault: true },
          { value: "1m", label: "1M" },
        ],
        defaultContextWindow: "300k",
      },
    ]);
  });

  it("restores Cursor CLI fallback context choices for Sonnet 5 variants", () => {
    expect(
      collapseCursorModelVariants([
        {
          slug: "claude-sonnet-5-xhigh",
          name: "Sonnet 5 1M Extra High",
          upstreamProviderId: "anthropic",
          upstreamProviderName: "Anthropic",
          supportedReasoningEfforts: [{ value: "xhigh", label: "Extra High" }],
          defaultReasoningEffort: "xhigh",
        },
        {
          slug: "claude-sonnet-5-max",
          name: "Sonnet 5 1M Max",
          upstreamProviderId: "anthropic",
          upstreamProviderName: "Anthropic",
          supportedReasoningEfforts: [{ value: "max", label: "Max" }],
          defaultReasoningEffort: "max",
        },
      ]),
    ).toEqual([
      {
        slug: "claude-sonnet-5",
        name: "Sonnet 5",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportedReasoningEfforts: [
          { value: "xhigh", label: "Extra High", isDefault: true },
          { value: "max", label: "Max" },
        ],
        defaultReasoningEffort: "xhigh",
        contextWindowOptions: [
          { value: "300k", label: "300K", isDefault: true },
          { value: "1m", label: "1M" },
        ],
        defaultContextWindow: "300k",
      },
    ]);
  });
});
