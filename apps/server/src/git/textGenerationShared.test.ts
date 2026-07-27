// FILE: textGenerationShared.test.ts
// Purpose: Verifies shared structured text-generation parsing helpers.
// Layer: Server git utility test
// Depends on: Effect schema decoding and automation completion prompt schemas.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildAutomationCompletionEvaluationPrompt,
  buildAutomationIntentPrompt,
  buildPrContentPrompt,
  decodeStructuredTextGenerationOutput,
} from "./textGenerationShared.ts";

describe("textGenerationShared", () => {
  it("accepts out-of-range automation completion confidence for downstream clamping", async () => {
    const { outputSchemaJson } = buildAutomationCompletionEvaluationPrompt({
      automationName: "Watch PR",
      automationPrompt: "Check the PR.",
      stopWhen: "the PR is ready",
      runUserMessage: "Check the PR.",
      runAssistantText: "The PR is ready.",
    });

    const result = await Effect.runPromise(
      decodeStructuredTextGenerationOutput({
        schema: outputSchemaJson,
        raw: JSON.stringify({
          stopMatched: true,
          confidence: 1.2,
          reason: "The run says the PR is ready.",
        }),
        operation: "automation completion evaluation",
        providerLabel: "Test provider",
      }),
    );

    expect(result).toEqual({
      stopMatched: true,
      confidence: 1.2,
      reason: "The run says the PR is ready.",
    });
  });

  it("asks automation intent generation for detailed prompts without invented context", () => {
    const { prompt } = buildAutomationIntentPrompt({
      message: "every 6h check the site",
      nowIso: "2026-06-21T20:00:00.000Z",
    });

    expect(prompt).toContain("detailed, self-contained recurring instruction");
    expect(prompt).toContain("Do not invent repo-specific files, commands");
    expect(prompt).toContain("schedule, stop, or run-count scaffolding");
    expect(prompt).toContain("maxIterations: positive integer");
    expect(prompt).toContain("Task prompt quality checklist");
    expect(prompt).toContain("Decision gates");
    expect(prompt).toContain("commit/push only if there is an actual count change");
  });

  it("uses the default Summary/Testing body shape when no PR template is provided", () => {
    const { prompt } = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature",
      commitSummary: "abc Add feature",
      diffSummary: "1 file changed",
      diffPatch: "diff --git a/a.ts b/a.ts",
    });

    expect(prompt).toContain("## Summary");
    expect(prompt).toContain("## Testing");
    expect(prompt).not.toContain("Repository pull request template:");
  });

  it("asks the model to fill a repository PR template when provided", () => {
    const { prompt } = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature",
      commitSummary: "abc Add feature",
      diffSummary: "1 file changed",
      diffPatch: "diff --git a/a.ts b/a.ts",
      prTemplate: "## What Changed\n\n## Checklist\n\n- [ ] Tests",
    });

    expect(prompt).toContain("follow the repository pull request template structure");
    expect(prompt).toContain("drop HTML comments from the template");
    expect(prompt).toContain("Repository pull request template:");
    expect(prompt).toContain("## What Changed");
    expect(prompt).toContain("## Checklist");
    expect(prompt).not.toContain("include headings '## Summary' and '## Testing'");
  });
});
