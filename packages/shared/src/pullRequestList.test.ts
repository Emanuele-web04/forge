import type { PullRequestListEntry } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  coalescePullRequestListEntries,
  pullRequestListRepositoryIdentity,
  updatePullRequestListEntryProjectPin,
} from "./pullRequestList";

function makeEntry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  const entry: PullRequestListEntry = {
    projectId: "project-1" as PullRequestListEntry["projectId"],
    projectTitle: "Project One",
    provider: "github",
    repository: "acme/widgets",
    number: 1,
    title: "PR 1",
    url: "https://github.com/acme/widgets/pull/1",
    author: null,
    headBranch: "feature-1",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    isPinned: false,
    projectContexts: [],
    mergeability: "unknown",
    labels: [],
    ...overrides,
  };
  return {
    ...entry,
    projectContexts: overrides.projectContexts ?? [
      {
        projectId: entry.projectId,
        projectTitle: entry.projectTitle,
        isPinned: entry.isPinned ?? false,
      },
    ],
  };
}

describe("pull request list coalescing", () => {
  it("uses provider, repository, and number as the remote identity", () => {
    expect(pullRequestListRepositoryIdentity(makeEntry({ repository: " Acme/Widgets " }))).toBe(
      "github\u0000acme/widgets\u00001",
    );
    expect(pullRequestListRepositoryIdentity(makeEntry({ provider: "bitbucket" }))).toBe(
      "bitbucket\u0000acme/widgets\u00001",
    );
  });

  it("does not collapse GitHub and Bitbucket rows sharing owner, repository, and number", () => {
    const github = makeEntry({
      provider: "github",
      projectTitle: "GitHub",
      url: "https://github.com/acme/widgets/pull/1",
    });
    const bitbucket = makeEntry({
      provider: "bitbucket",
      projectId: "project-2" as PullRequestListEntry["projectId"],
      projectTitle: "Bitbucket",
      url: "https://bitbucket.org/acme/widgets/pull-requests/1",
    });

    expect(coalescePullRequestListEntries([github, bitbucket])).toEqual([github, bitbucket]);
  });

  it("collapses shared-worktree rows and prefers the head-branch worktree", () => {
    const fallback = makeEntry();
    const branchWorktree = makeEntry({
      projectId: "project-2" as PullRequestListEntry["projectId"],
      projectTitle: "feature-1",
    });

    expect(coalescePullRequestListEntries([fallback, branchWorktree])).toEqual([
      {
        ...branchWorktree,
        projectContexts: [
          {
            projectId: "project-2",
            projectTitle: "feature-1",
            isPinned: false,
          },
          {
            projectId: "project-1",
            projectTitle: "Project One",
            isPinned: false,
          },
        ],
      },
    ]);
  });

  it("prefers pinned context and keeps different remote PRs distinct", () => {
    const first = makeEntry({ projectTitle: "feature-1" });
    const pinned = makeEntry({
      projectId: "project-2" as PullRequestListEntry["projectId"],
      projectTitle: "Pinned workspace",
      isPinned: true,
    });
    const otherRepository = makeEntry({ repository: "acme/other" });

    const [shared, other] = coalescePullRequestListEntries([first, pinned, otherRepository]);
    expect(shared).toMatchObject({
      projectId: first.projectId,
      isPinned: true,
      projectContexts: expect.arrayContaining([
        expect.objectContaining({ projectId: pinned.projectId, isPinned: true }),
      ]),
    });
    expect(other).toMatchObject({ repository: "acme/other" });
  });

  it("keeps an explicitly selected project context stable", () => {
    const first = makeEntry();
    const second = makeEntry({
      projectId: "project-2" as PullRequestListEntry["projectId"],
      projectTitle: "Project Two",
      projectContexts: [
        {
          projectId: "project-2" as PullRequestListEntry["projectId"],
          projectTitle: "Project Two",
          isPinned: false,
        },
      ],
    });
    expect(
      coalescePullRequestListEntries([first, second], {
        preferredProjectId: second.projectId,
      })[0]?.projectId,
    ).toBe(second.projectId);
  });

  it("updates one project pin while preserving aggregate pin state", () => {
    const first = makeEntry({ isPinned: true });
    const second = makeEntry({
      projectId: "project-2" as PullRequestListEntry["projectId"],
      projectTitle: "Project Two",
      isPinned: true,
    });
    const aggregate = coalescePullRequestListEntries([first, second])[0]!;
    const firstCleared = updatePullRequestListEntryProjectPin(aggregate, first.projectId, false);
    const allCleared = updatePullRequestListEntryProjectPin(firstCleared, second.projectId, false);

    expect(firstCleared.isPinned).toBe(true);
    expect(allCleared.isPinned).toBe(false);
  });
});
