import { DEFAULT_PROVIDER_PROFILE_ID } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadModelSummary } from "./threadModelSummary";

describe("resolveThreadModelSummary", () => {
  it("returns null without a selection", () => {
    expect(resolveThreadModelSummary(null)).toBeNull();
    expect(resolveThreadModelSummary(undefined)).toBeNull();
  });

  it("summarizes a codex selection with its reasoning effort", () => {
    const summary = resolveThreadModelSummary({
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5.5",
      options: { reasoningEffort: "high" },
    });

    expect(summary?.provider).toBe("codex");
    expect(summary?.modelLabel.length).toBeGreaterThan(0);
    expect(summary?.statusLabel?.toLowerCase()).toBe("high");
  });

  it("falls back to the model's default effort when none is stored", () => {
    const withEffort = resolveThreadModelSummary({
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5.5",
      options: { reasoningEffort: "low" },
    });
    const withoutOptions = resolveThreadModelSummary({
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5.5",
    });

    expect(withEffort?.statusLabel?.toLowerCase()).toBe("low");
    expect(withoutOptions?.statusLabel).not.toBeNull();
    expect(withoutOptions?.statusLabel).not.toBe(withEffort?.statusLabel);
  });

  it("summarizes a claude selection", () => {
    const summary = resolveThreadModelSummary({
      provider: "claudeAgent",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "claude-sonnet-5",
      options: { effort: "high" },
    });

    expect(summary?.provider).toBe("claudeAgent");
    expect(summary?.modelLabel.length).toBeGreaterThan(0);
    expect(summary?.fastMode).toBe(false);
  });
});
