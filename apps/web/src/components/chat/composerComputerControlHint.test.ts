// FILE: composerComputerControlHint.test.ts
// Purpose: Locks the composer computer-control effort hint to its four conditions
// (control on and available, claudeAgent, Medium on the ladder, effort untouched)
// and to the state transitions its apply/dismiss actions produce.
// Layer: Web chat composer tests
// Depends on: shouldShowComputerControlEffortHint, getComposerTraitSelection

import { type ClaudeModelOptions } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildNextProviderOptions, type ProviderOptions } from "../../providerModelOptions";
import {
  COMPUTER_CONTROL_HINT_EFFORT,
  shouldShowComputerControlEffortHint,
  type ComputerControlEffortHintInput,
} from "./composerComputerControlHint";
import { getComposerTraitSelection } from "./composerTraits";

const OPUS_5 = "claude-opus-5";
// Opus 4.8 carries the Ultrathink prompt mode; Opus 5 does not.
const OPUS_4_8 = "claude-opus-4-8";

function traitsFor(
  model: string,
  modelOptions?: ProviderOptions | undefined,
  prompt = "",
  provider: ComputerControlEffortHintInput["provider"] = "claudeAgent",
) {
  return getComposerTraitSelection(provider, model, prompt, modelOptions);
}

function hintInput(
  overrides: Partial<ComputerControlEffortHintInput> = {},
): ComputerControlEffortHintInput {
  return {
    enableComputerControl: true,
    computerControlAvailable: true,
    dismissed: false,
    provider: "claudeAgent",
    traits: traitsFor(OPUS_5),
    ...overrides,
  };
}

describe("shouldShowComputerControlEffortHint", () => {
  it("shows for a claudeAgent chat driving the desktop at the default effort", () => {
    expect(shouldShowComputerControlEffortHint(hintInput())).toBe(true);
  });

  it("resolves the default effort as High, so Medium is a real change", () => {
    const traits = traitsFor(OPUS_5);
    expect(traits.defaultEffort).toBe("high");
    expect(traits.effort).toBe("high");
    expect(traits.effortLevels.map((level) => level.value)).toContain(COMPUTER_CONTROL_HINT_EFFORT);
  });

  it("stays hidden while computer control is off", () => {
    expect(shouldShowComputerControlEffortHint(hintInput({ enableComputerControl: false }))).toBe(
      false,
    );
  });

  it("stays hidden while the desktop backend is unavailable", () => {
    expect(
      shouldShowComputerControlEffortHint(hintInput({ computerControlAvailable: false })),
    ).toBe(false);
  });

  it("stays hidden once dismissed", () => {
    expect(shouldShowComputerControlEffortHint(hintInput({ dismissed: true }))).toBe(false);
  });

  it("stays hidden for other providers", () => {
    expect(
      shouldShowComputerControlEffortHint(
        hintInput({
          provider: "codex",
          traits: traitsFor("gpt-5.1-codex", undefined, "", "codex"),
        }),
      ),
    ).toBe(false);
  });

  it("stays hidden once the user has picked an effort", () => {
    for (const effort of ["low", "medium", "xhigh", "max"] as const) {
      const traits = traitsFor(OPUS_5, { effort } satisfies ClaudeModelOptions);
      expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(false);
    }
  });

  it("stays hidden while an Ultrathink prompt owns the effort", () => {
    const traits = traitsFor(OPUS_4_8, undefined, "Ultrathink: rewrite the loop");
    expect(traits.ultrathinkPromptControlled).toBe(true);
    expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(false);
  });

  it("stays hidden for a model with no effort ladder", () => {
    const traits = traitsFor("some-unknown-model");
    expect(traits.effortLevels).toHaveLength(0);
    expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(false);
  });

  it("ignores unrelated trait changes such as fast mode", () => {
    const traits = traitsFor(OPUS_5, { fastMode: true } satisfies ClaudeModelOptions);
    expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(true);
  });
});

describe("computer-control effort hint actions", () => {
  it("apply writes Medium through the picker's option patch and hides the hint", () => {
    const nextOptions = buildNextProviderOptions("claudeAgent", undefined, {
      effort: COMPUTER_CONTROL_HINT_EFFORT,
    });
    expect(nextOptions).toEqual({ effort: "medium" });

    const traits = traitsFor(OPUS_5, nextOptions);
    expect(traits.effort).toBe("medium");
    expect(shouldShowComputerControlEffortHint(hintInput({ traits }))).toBe(false);
  });

  it("apply preserves other provider options", () => {
    const nextOptions = buildNextProviderOptions(
      "claudeAgent",
      { fastMode: true, autoCompactWindow: "1m" } satisfies ClaudeModelOptions,
      { effort: COMPUTER_CONTROL_HINT_EFFORT },
    );
    expect(nextOptions).toEqual({ fastMode: true, autoCompactWindow: "1m", effort: "medium" });
  });

  it("dismiss hides the hint without touching the selected effort", () => {
    const traits = traitsFor(OPUS_5);
    expect(shouldShowComputerControlEffortHint(hintInput({ traits, dismissed: true }))).toBe(false);
    expect(traits.effort).toBe("high");
  });
});
