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

  it("defaults collapsed Cursor Grok variants to high and keeps fast as a toggle", () => {
    expect(
      collapseCursorModelVariants([
        {
          slug: "grok-4.6-low",
          name: "Cursor Grok 4.6 Low",
          upstreamProviderId: "xai",
          upstreamProviderName: "xAI",
          supportedReasoningEfforts: [{ value: "low", label: "Low" }],
          defaultReasoningEffort: "low",
        },
        {
          slug: "grok-4.6-high",
          name: "Cursor Grok 4.6 High",
          upstreamProviderId: "xai",
          upstreamProviderName: "xAI",
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
          defaultReasoningEffort: "high",
        },
        {
          slug: "grok-4.6-low-fast",
          name: "Cursor Grok 4.6 Low Fast",
          upstreamProviderId: "xai",
          upstreamProviderName: "xAI",
          supportedReasoningEfforts: [{ value: "low", label: "Low" }],
          defaultReasoningEffort: "low",
          supportsFastMode: true,
        },
      ]),
    ).toEqual([
      {
        slug: "grok-4.6",
        name: "Cursor Grok 4.6",
        upstreamProviderId: "xai",
        upstreamProviderName: "xAI",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "high", label: "High", isDefault: true },
        ],
        defaultReasoningEffort: "high",
        supportsFastMode: true,
      },
    ]);
  });
});
