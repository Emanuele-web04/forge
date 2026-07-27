import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  PullRequestCommentInput,
  PullRequestDetail,
  PullRequestDiffResult,
  PullRequestListEntry,
  PullRequestReviewRequestCountResult,
  PullRequestSetPinnedInput,
} from "./pullRequests";

const decodeListEntry = Schema.decodeUnknownSync(PullRequestListEntry);
const decodeDetail = Schema.decodeUnknownSync(PullRequestDetail);
const decodeDiff = Schema.decodeUnknownSync(PullRequestDiffResult);
const decodeCommentInput = Schema.decodeUnknownSync(PullRequestCommentInput);
const decodeSetPinnedInput = Schema.decodeUnknownSync(PullRequestSetPinnedInput);
const decodeReviewRequestCountResult = Schema.decodeUnknownSync(
  PullRequestReviewRequestCountResult,
);

function listEntry() {
  return {
    projectId: "project-1",
    projectTitle: "Project One",
    repository: "acme/widgets",
    number: 42,
    title: "Prioritize this",
    url: "https://github.com/acme/widgets/pull/42",
    author: null,
    headBranch: "feature/pin",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 2,
    deletions: 1,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    labels: [],
  };
}

describe("PullRequestListEntry", () => {
  it("defaults legacy payloads missing pin and mergeability metadata", () => {
    // The fixture deliberately omits both fields — this is what an older server sends.
    const decoded = decodeListEntry(listEntry());
    expect(decoded.isPinned).toBe(false);
    expect(decoded.projectContexts).toEqual([]);
    expect(decoded.mergeability).toBe("unknown");
    expect(
      decodeListEntry({ ...listEntry(), isPinned: true, mergeability: "conflicting" }),
    ).toMatchObject({ isPinned: true, mergeability: "conflicting" });
  });
});

describe("PullRequestDetail", () => {
  it("defaults additive fields for a real pre-field detail payload", () => {
    const decoded = decodeDetail({
      projectId: "project-1",
      projectTitle: "Project One",
      workspaceRoot: "/workspace/project-one",
      repository: "acme/widgets",
      number: 42,
      title: "Prioritize this",
      body: "Description",
      url: "https://github.com/acme/widgets/pull/42",
      author: null,
      state: "open",
      isDraft: false,
      mergeable: null,
      mergeStateStatus: null,
      reviewDecision: null,
      additions: 2,
      deletions: 1,
      changedFiles: 1,
      headBranch: "feature/pin",
      baseBranch: "main",
      createdAt: "2026-07-13T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      maintainerCanModify: true,
      reviewers: [],
      labels: [],
      checks: [],
      comments: [],
      commentsTruncated: false,
      commentsIncomplete: false,
      commits: [],
      mergeCapabilities: {
        merge: true,
        squash: true,
        rebase: true,
        deleteBranchOnMerge: false,
      },
    });

    expect(decoded.mergeability).toBe("unknown");
    expect(decoded.reviewThreads).toEqual([]);
  });
});

describe("PullRequestDiffResult", () => {
  it("defaults head metadata for an older server payload", () => {
    expect(decodeDiff({ patch: "diff", truncated: false })).toEqual({
      patch: "diff",
      truncated: false,
      headSha: "",
      patchSignature: "",
    });
  });
});

describe("PullRequestCommentInput", () => {
  const base = {
    projectId: "project-1",
    repository: "acme/widgets",
    number: 42,
  } as const;

  it("accepts GitHub's maximum comment length and rejects one character more", () => {
    expect(decodeCommentInput({ ...base, body: "x".repeat(65_536) }).body).toHaveLength(65_536);
    expect(() => decodeCommentInput({ ...base, body: "x".repeat(65_537) })).toThrow();
  });
});

describe("PullRequestSetPinnedInput", () => {
  it("decodes a project-scoped idempotent pin setter", () => {
    expect(
      decodeSetPinnedInput({
        projectId: "project-1",
        repository: "acme/widgets",
        number: 42,
        isPinned: true,
      }),
    ).toEqual({
      projectId: "project-1",
      repository: "acme/widgets",
      number: 42,
      isPinned: true,
    });
  });
});

describe("PullRequestReviewRequestCountResult", () => {
  it("requires a non-negative count and explicit completeness", () => {
    expect(decodeReviewRequestCountResult({ count: 2, incomplete: true })).toEqual({
      count: 2,
      incomplete: true,
    });
    expect(() => decodeReviewRequestCountResult({ count: -1, incomplete: false })).toThrow();
    expect(() => decodeReviewRequestCountResult({ count: 2 })).toThrow();
  });
});
