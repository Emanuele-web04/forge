// FILE: forkDenial.ts
// Purpose: Centralized satirical fork-denial stage copy for parody surfaces.
// Layer: Shared web runtime utility

export const FORK_DENIAL_STAGES = [
  { id: "not-a-fork", label: "Not a fork" },
  { id: "technically-not-a-fork", label: "Technically not a fork" },
  { id: "mostly-not-a-fork", label: "Mostly not a fork" },
  { id: "forks-are-normal", label: "Forks are normal" },
  { id: "fork-isnt-that-bad", label: "The fork isn't that bad" },
] as const;

export const FORK_DENIAL_FINAL_STAGE = {
  id: "okay-its-a-fork",
  label: "Okay, it's a fork",
} as const;

export type ForkDenialStage = (typeof FORK_DENIAL_STAGES)[number] | typeof FORK_DENIAL_FINAL_STAGE;

export function getForkDenialStages(
  input: { includeFinalForkState?: boolean } = {},
): readonly ForkDenialStage[] {
  return input.includeFinalForkState
    ? [...FORK_DENIAL_STAGES, FORK_DENIAL_FINAL_STAGE]
    : [...FORK_DENIAL_STAGES];
}

export function isFinalForkDenialStage(
  stage: ForkDenialStage,
): stage is typeof FORK_DENIAL_FINAL_STAGE {
  return stage.id === "okay-its-a-fork";
}
