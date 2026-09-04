import type { OrchestrationThreadPullRequest } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadPullRequestFallback } from "./useThreadPullRequests";

const staleOpenPullRequest: OrchestrationThreadPullRequest = {
  number: 841,
  title: "Previous branch pull request",
  url: "https://github.com/acme/synara/pull/841",
  baseBranch: "main",
  headBranch: "feat/previous-branch",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 12,
  deletions: 4,
  changedFiles: 2,
};

describe("resolveThreadPullRequestFallback", () => {
  it("rejects a stale open PR for a dedicated worktree on another branch", () => {
    expect(
      resolveThreadPullRequestFallback({
        branch: "feat/current-branch",
        hasDedicatedWorktree: true,
        lastKnownPr: staleOpenPullRequest,
      }),
    ).toBeNull();
  });
});
