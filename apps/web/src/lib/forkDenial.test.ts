import { describe, expect, it } from "vitest";

import {
  FORK_DENIAL_FINAL_STAGE,
  FORK_DENIAL_STAGES,
  getForkDenialStages,
  isFinalForkDenialStage,
} from "./forkDenial";

describe("forkDenial", () => {
  it("defines the escalation order for fork-denial copy", () => {
    expect(FORK_DENIAL_STAGES.map((stage) => stage.label)).toEqual([
      "Not a fork",
      "Technically not a fork",
      "Mostly not a fork",
      "Forks are normal",
      "The fork isn't that bad",
    ]);
    expect(FORK_DENIAL_STAGES.map((stage) => stage.id)).toEqual([
      "not-a-fork",
      "technically-not-a-fork",
      "mostly-not-a-fork",
      "forks-are-normal",
      "fork-isnt-that-bad",
    ]);
  });

  it("supports an optional final fork state", () => {
    const withFinal = getForkDenialStages({ includeFinalForkState: true });

    expect(withFinal).toHaveLength(6);
    expect(withFinal).toContain(FORK_DENIAL_FINAL_STAGE);
    expect(isFinalForkDenialStage(withFinal[5]!)).toBe(true);
  });

  it("keeps default stages limited to the core satire ladder", () => {
    const core = getForkDenialStages();
    expect(core).toHaveLength(5);
    expect(core).toEqual(FORK_DENIAL_STAGES);
  });
});
