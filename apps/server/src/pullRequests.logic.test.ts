import { describe, expect, it } from "vitest";

import {
  isPullRequestMergeMethodAllowed,
  isValidGitHubRepositoryNameWithOwner,
  isViewerReviewRequested,
  orderPullRequestListEntries,
  projectPullRequestIdentityKey,
  pullRequestMatchesInvolvement,
  pullRequestListCacheKey,
  pullRequestListForceRefreshCacheKeys,
  repositoryPullRequestIdentityKey,
  selectRecoverablePullRequestPins,
  shouldLoadReviewingCompanion,
} from "./pullRequests.logic";

import type { PullRequestListEntry } from "@synara/contracts";

function makeEntry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
    projectId: "project-1" as PullRequestListEntry["projectId"],
    projectTitle: "Project One",
    repository: "acme/widgets",
    number: 1,
    title: "Untitled",
    url: "https://github.com/acme/widgets/pull/1",
    author: null,
    headBranch: "feature",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    isPinned: false,
    projectContexts: [
      {
        projectId: "project-1" as PullRequestListEntry["projectId"],
        projectTitle: "Project One",
        isPinned: false,
      },
    ],
    mergeability: "unknown",
    stack: null,
    labels: [],
    ...overrides,
  };
}

describe("isValidGitHubRepositoryNameWithOwner", () => {
  it.each(["openai/codex", "OpenAI/Codex.js", "owner-1/repo_name"])("accepts %s", (repository) =>
    expect(isValidGitHubRepositoryNameWithOwner(repository)).toBe(true),
  );

  it.each([
    "",
    "owner",
    "owner/repo/extra",
    "owner repo/name",
    "-owner/name",
    "owner/--flag value",
  ])("rejects %s", (repository) =>
    expect(isValidGitHubRepositoryNameWithOwner(repository)).toBe(false),
  );
});

describe("pullRequestListCacheKey", () => {
  it("separates involvement filters and normalizes repository casing", () => {
    expect(pullRequestListCacheKey("OpenAI/Codex", "open", "authored", "OctoCat")).toBe(
      "openai/codex:open:authored:octocat",
    );
    expect(pullRequestListCacheKey("openai/codex", "open", "reviewing", "octocat")).not.toBe(
      pullRequestListCacheKey("openai/codex", "open", "all", "octocat"),
    );
  });

  it("separates cached lists belonging to different authenticated viewers", () => {
    expect(pullRequestListCacheKey("openai/codex", "open", "authored", "alice")).not.toBe(
      pullRequestListCacheKey("openai/codex", "open", "authored", "bob"),
    );
  });

  it("invalidates every sibling involvement without changing repository, state, or viewer", () => {
    expect(
      pullRequestListForceRefreshCacheKeys({
        repository: "OpenAI/Codex",
        state: "closed",
        viewer: "OctoCat",
      }),
    ).toEqual([
      "openai/codex:closed:all:octocat",
      "openai/codex:closed:authored:octocat",
      "openai/codex:closed:reviewing:octocat",
    ]);
  });
});

describe("project pull request priority", () => {
  it("keeps identical repository PRs independent across projects and repository casing", () => {
    const first = projectPullRequestIdentityKey({
      projectId: "project-1",
      repository: " Acme/Widgets ",
      number: 42,
    });
    expect(first).toBe(
      projectPullRequestIdentityKey({
        projectId: "project-1",
        repository: "acme/widgets",
        number: 42,
      }),
    );
    expect(first).not.toBe(
      projectPullRequestIdentityKey({
        projectId: "project-2",
        repository: "acme/widgets",
        number: 42,
      }),
    );
  });

  it("recovers only missing pins from truncated batches owned by the same project", () => {
    const pins = [
      { projectId: "project-a", repositoryKey: "acme/widgets", number: 1 },
      { projectId: "project-b", repositoryKey: "acme/widgets", number: 2 },
      { projectId: "project-a", repositoryKey: "acme/complete", number: 3 },
      { projectId: "project-a", repositoryKey: "acme/widgets", number: 4 },
    ];
    const presentKeys = new Set([
      projectPullRequestIdentityKey({
        projectId: "project-a",
        repository: "acme/widgets",
        number: 4,
      }),
    ]);
    const recovered = selectRecoverablePullRequestPins({
      pins,
      presentKeys,
      repositoryKeysByProject: new Map([
        ["project-a", new Set(["acme/widgets", "acme/complete"])],
        ["project-b", new Set(["acme/other"])],
      ]),
      batches: [
        {
          repository: "Acme/Widgets",
          truncated: true,
          projectIds: ["project-a"],
        },
        {
          repository: "acme/complete",
          truncated: false,
          projectIds: ["project-a"],
        },
      ],
    });

    expect(recovered).toEqual([pins[0]]);
  });

  it("coalesces remote lookups across projects without coalescing different repositories", () => {
    expect(repositoryPullRequestIdentityKey({ repository: " Acme/Widgets ", number: 42 })).toBe(
      repositoryPullRequestIdentityKey({ repository: "acme/widgets", number: 42 }),
    );
    expect(repositoryPullRequestIdentityKey({ repository: "acme/widgets", number: 42 })).not.toBe(
      repositoryPullRequestIdentityKey({ repository: "acme/other", number: 42 }),
    );
  });

  it("places pinned pull requests first while keeping newest-first order in each section", () => {
    const olderPinned = makeEntry({ number: 1, isPinned: true });
    const newerPinned = makeEntry({
      number: 2,
      isPinned: true,
      updatedAt: "2026-07-04T00:00:00.000Z",
    });
    const newestUnpinned = makeEntry({
      number: 3,
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
    const olderUnpinned = makeEntry({ number: 4 });

    expect(
      orderPullRequestListEntries([olderUnpinned, olderPinned, newestUnpinned, newerPinned]).map(
        (entry) => entry.number,
      ),
    ).toEqual([2, 1, 3, 4]);
  });
});

describe("isViewerReviewRequested", () => {
  const viewer = { login: "Viewer", name: null, avatarUrl: null, url: null };
  const teammate = { login: "teammate", name: null, avatarUrl: null, url: null };

  it("does not flag a self-authored pull request", () => {
    expect(isViewerReviewRequested(viewer, ["viewer"], "VIEWER")).toBe(false);
  });

  it("flags a teammate pull request that explicitly requests the viewer", () => {
    expect(isViewerReviewRequested(teammate, ["Viewer"], "viewer")).toBe(true);
  });

  it("flags team-only matches returned by the reviewing query", () => {
    expect(isViewerReviewRequested(teammate, [], "viewer", true)).toBe(true);
  });

  it("does not flag self-authored matches returned by the reviewing query", () => {
    expect(isViewerReviewRequested(viewer, [], "viewer", true)).toBe(false);
  });
});

describe("pull request list filtering", () => {
  const viewer = { login: "Viewer", name: null, avatarUrl: null, url: null };
  const teammate = { login: "teammate", name: null, avatarUrl: null, url: null };

  it("matches exact authored and explicitly requested reviewing pins", () => {
    expect(
      pullRequestMatchesInvolvement(
        { author: viewer, reviewRequestLogins: [] },
        "authored",
        "viewer",
      ),
    ).toBe(true);
    expect(
      pullRequestMatchesInvolvement(
        { author: teammate, reviewRequestLogins: ["VIEWER"] },
        "reviewing",
        "viewer",
      ),
    ).toBe(true);
  });

  it("uses an authoritative reviewing-query match for team requests but rejects self-authored PRs", () => {
    expect(
      pullRequestMatchesInvolvement(
        { author: teammate, reviewRequestLogins: [] },
        "reviewing",
        "viewer",
        true,
      ),
    ).toBe(true);
    expect(
      pullRequestMatchesInvolvement(
        { author: viewer, reviewRequestLogins: [] },
        "reviewing",
        "viewer",
        true,
      ),
    ).toBe(false);
  });

  it("loads the team-aware companion query only for open all-involvement results", () => {
    expect(shouldLoadReviewingCompanion("open", "all")).toBe(true);
    expect(shouldLoadReviewingCompanion("closed", "all")).toBe(false);
    expect(shouldLoadReviewingCompanion("merged", "all")).toBe(false);
    expect(shouldLoadReviewingCompanion("open", "authored")).toBe(false);
    expect(shouldLoadReviewingCompanion("open", "reviewing")).toBe(false);
  });
});

describe("isPullRequestMergeMethodAllowed", () => {
  const capabilities = {
    merge: false,
    squash: true,
    rebase: false,
    deleteBranchOnMerge: true,
  };

  it("uses repository capabilities for the requested method", () => {
    expect(isPullRequestMergeMethodAllowed(capabilities, "squash")).toBe(true);
    expect(isPullRequestMergeMethodAllowed(capabilities, "merge")).toBe(false);
  });
});
