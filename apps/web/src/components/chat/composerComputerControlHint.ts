// FILE: composerComputerControlHint.ts
// Purpose: Visibility rule and copy for the composer hint that suggests Medium
//   effort while a chat drives the desktop. Desktop turns are dominated by
//   per-step model think time, and the act loop ("look at the screenshot, click
//   the obvious thing") reads the same at Medium as at High.
// Layer: Chat composer state helpers
// Exports: shouldShowComputerControlEffortHint + hint constants
// Depends on: resolved composer trait selection (composerTraits)

import { type ProviderKind } from "@synara/contracts";

import type { ComposerTraitSelection } from "./composerTraits";

/** Effort rung the hint offers; must exist on the model's ladder to be offered. */
export const COMPUTER_CONTROL_HINT_EFFORT = "medium";

export const COMPUTER_CONTROL_HINT_MESSAGE = "Desktop actions are faster at Medium effort";
export const COMPUTER_CONTROL_HINT_ACTION_LABEL = "Use Medium";

/**
 * Effort is only "still on the default" when the thread carries no explicit
 * pick: provider option normalization drops a selection that equals the default,
 * so `effort === defaultEffort` is exactly the untouched state.
 */
export type ComputerControlEffortHintTraits = Pick<
  ComposerTraitSelection,
  "effort" | "defaultEffort" | "effortLevels" | "ultrathinkPromptControlled"
>;

export interface ComputerControlEffortHintInput {
  /** Resolved per-chat computer-control choice (draft override or new-chat default). */
  readonly enableComputerControl: boolean;
  /** Server-side desktop control availability; a tip about speed is noise without it. */
  readonly computerControlAvailable: boolean;
  /** `dismissedComputerControlEffortHint` — set by both the apply and dismiss actions. */
  readonly dismissed: boolean;
  readonly provider: ProviderKind;
  readonly traits: ComputerControlEffortHintTraits;
}

/**
 * Shows only for a claudeAgent chat that drives the desktop, on a model whose
 * effort ladder offers Medium, while effort is untouched at its default. Effort
 * for this provider applies per turn, so acting on the hint costs nothing.
 */
export function shouldShowComputerControlEffortHint(
  input: ComputerControlEffortHintInput,
): boolean {
  if (!input.enableComputerControl || !input.computerControlAvailable || input.dismissed) {
    return false;
  }
  if (input.provider !== "claudeAgent") {
    return false;
  }
  const { effort, defaultEffort, effortLevels, ultrathinkPromptControlled } = input.traits;
  // A prompt-driven mode (Ultrathink) owns effort; the picker refuses changes too.
  if (ultrathinkPromptControlled) {
    return false;
  }
  if (!effortLevels.some((level) => level.value === COMPUTER_CONTROL_HINT_EFFORT)) {
    return false;
  }
  // Nothing to suggest when the model already defaults to Medium (or has no default).
  if (defaultEffort === null || defaultEffort === COMPUTER_CONTROL_HINT_EFFORT) {
    return false;
  }
  return effort === defaultEffort;
}
