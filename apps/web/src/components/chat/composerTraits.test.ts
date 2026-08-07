import { assert, describe, it } from "vitest";

import { resolveEffortCommitOptionId } from "./composerTraits";

describe("resolveEffortCommitOptionId", () => {
  it("prefers the primary select descriptor id when present", () => {
    assert.strictEqual(resolveEffortCommitOptionId("codex", "thinkingBudget"), "thinkingBudget");
    assert.strictEqual(resolveEffortCommitOptionId("kilo", "customVariant"), "customVariant");
  });

  it("falls back to the per-provider effort option id", () => {
    assert.strictEqual(resolveEffortCommitOptionId("kilo", undefined), "variant");
    assert.strictEqual(resolveEffortCommitOptionId("opencode", undefined), "variant");
    assert.strictEqual(resolveEffortCommitOptionId("pi", undefined), "thinkingLevel");
    assert.strictEqual(resolveEffortCommitOptionId("claudeAgent", undefined), "effort");
    assert.strictEqual(resolveEffortCommitOptionId("codex", undefined), "reasoningEffort");
    assert.strictEqual(resolveEffortCommitOptionId("cursor", undefined), "reasoningEffort");
    assert.strictEqual(resolveEffortCommitOptionId("grok", undefined), "reasoningEffort");
  });
});
