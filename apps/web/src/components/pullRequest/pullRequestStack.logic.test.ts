import type { PullRequestStack, PullRequestStackEntry } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  assessPullRequestStack,
  pullRequestMergeBlocker,
  pullRequestStackTargetEntries,
} from "./pullRequestStack.logic";

function entry(
  position: number,
  overrides: Partial<PullRequestStackEntry> = {},
): PullRequestStackEntry {
  return {
    position,
    number: 100 + position,
    title: `Layer ${position}`,
    url: `https://github.com/acme/app/pull/${100 + position}`,
    headBranch: `layer-${position}`,
    baseBranch: position === 1 ? "main" : `layer-${position - 1}`,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

function stack(overrides: Partial<PullRequestStack> = {}): PullRequestStack {
  return {
    number: 7,
    size: 3,
    position: 2,
    baseBranch: "main",
    entries: [entry(1), entry(2), entry(3)],
    ...overrides,
  };
}

describe("pullRequestStackTargetEntries", () => {
  it("includes only unmerged entries through the selected pull request", () => {
    const source = stack({ entries: [entry(1, { state: "merged" }), entry(2), entry(3)] });
    expect(pullRequestStackTargetEntries(source).map((member) => member.number)).toEqual([102]);
  });
});

describe("assessPullRequestStack", () => {
  it("reports a ready atomic merge and its effective target count", () => {
    expect(assessPullRequestStack(stack())).toMatchObject({
      label: "Ready to merge",
      mergeTargetCount: 2,
      canAttemptMerge: true,
    });
  });

  it("blocks a stack when any affected pull request is a draft", () => {
    expect(
      assessPullRequestStack(stack({ entries: [entry(1, { isDraft: true }), entry(2), entry(3)] })),
    ).toMatchObject({
      label: "Stack needs attention",
      canAttemptMerge: false,
      blocker: "#101 is still a draft.",
    });
  });

  it("keeps uncertain GitHub state attemptable so the async merge API stays authoritative", () => {
    expect(
      assessPullRequestStack(
        stack({ entries: [entry(1), entry(2, { mergeStateStatus: "UNKNOWN" }), entry(3)] }),
      ),
    ).toMatchObject({
      label: "Merge status pending",
      canAttemptMerge: true,
    });
  });
});

describe("pullRequestMergeBlocker", () => {
  it("blocks merge when stack metadata could not be verified", () => {
    expect(
      pullRequestMergeBlocker({ stackMetadataIncomplete: true, mergeability: "mergeable" }, null),
    ).toBe("Stack details are temporarily unavailable. Refresh before merging.");
  });
});
