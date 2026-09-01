import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  PullRequestCommentInput,
  PullRequestActionResult,
  PullRequestActionInput,
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestListEntry,
  PullRequestsListResult,
  PullRequestProviderRequirement,
  PullRequestReviewRequestCountResult,
  PullRequestSetPinnedInput,
  PullRequestSetPinnedResult,
} from "./pullRequests";

const decodeListEntry = Schema.decodeUnknownSync(PullRequestListEntry);
const decodeDetail = Schema.decodeUnknownSync(PullRequestDetail);
const decodeDetailInput = Schema.decodeUnknownSync(PullRequestDetailInput);
const decodeListResult = Schema.decodeUnknownSync(PullRequestsListResult);
const decodeProviderRequirement = Schema.decodeUnknownSync(PullRequestProviderRequirement);
const decodeActionInput = Schema.decodeUnknownSync(PullRequestActionInput);
const decodeCommentInput = Schema.decodeUnknownSync(PullRequestCommentInput);
const decodeSetPinnedInput = Schema.decodeUnknownSync(PullRequestSetPinnedInput);
const decodeSetPinnedResult = Schema.decodeUnknownSync(PullRequestSetPinnedResult);
const decodeReviewRequestCountResult = Schema.decodeUnknownSync(
  PullRequestReviewRequestCountResult,
);
const decodeActionResult = Schema.decodeUnknownSync(PullRequestActionResult);

const LEGACY_GITHUB_CAPABILITIES = {
  detail: true,
  diff: true,
  comments: true,
  checks: true,
  comment: true,
  resolveComment: true,
  stateMutation: true,
  merge: true,
} as const;

const READ_ONLY_CAPABILITIES = {
  detail: true,
  diff: true,
  comments: true,
  checks: false,
  comment: false,
  resolveComment: false,
  stateMutation: false,
  merge: false,
} as const;

const BITBUCKET_WRITABLE_CAPABILITY_KEYS = [
  "checks",
  "comment",
  "resolveComment",
  "stateMutation",
  "merge",
] as const;

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
    expect(decoded.provider).toBe("github");
    expect(decoded.viewerInvolvement).toBe("none");
    expect(decoded.capabilities).toEqual(LEGACY_GITHUB_CAPABILITIES);
    expect(decoded.isPinned).toBe(false);
    expect(decoded.projectContexts).toEqual([]);
    expect(decoded.mergeability).toBe("unknown");
    expect(decoded.stack).toBeNull();
    expect(
      decodeListEntry({ ...listEntry(), isPinned: true, mergeability: "conflicting" }),
    ).toMatchObject({ isPinned: true, mergeability: "conflicting" });
  });

  it("decodes compact stack metadata for list rows", () => {
    expect(
      decodeListEntry({
        ...listEntry(),
        stack: {
          number: 8,
          size: 3,
          position: 2,
          baseBranch: "main",
        },
      }).stack,
    ).toEqual({ number: 8, size: 3, position: 2, baseBranch: "main" });
  });

  it("defaults explicit GitHub list rows to legacy GitHub capabilities", () => {
    const decoded = decodeListEntry({ ...listEntry(), provider: "github" });
    expect(decoded.provider).toBe("github");
    expect(decoded.capabilities).toEqual(LEGACY_GITHUB_CAPABILITIES);
  });

  it("rejects explicit Bitbucket list rows without explicit capabilities", () => {
    expect(() => decodeListEntry({ ...listEntry(), provider: "bitbucket" })).toThrow();
  });

  it("rejects explicit Bitbucket list rows with writable capabilities", () => {
    for (const capability of BITBUCKET_WRITABLE_CAPABILITY_KEYS) {
      expect(() =>
        decodeListEntry({
          ...listEntry(),
          provider: "bitbucket",
          repository: "paraty/payment-seeker",
          url: "https://bitbucket.org/paraty/payment-seeker/pull-requests/42",
          capabilities: { ...READ_ONLY_CAPABILITIES, [capability]: true },
          viewerInvolvement: "unknown",
          additions: null,
          deletions: null,
          mergeability: null,
        }),
      ).toThrow();
    }
  });

  it("decodes explicit Bitbucket read-only rows without fabricating unavailable stats", () => {
    const decoded = decodeListEntry({
      ...listEntry(),
      provider: "bitbucket",
      repository: "paraty/payment-seeker",
      url: "https://bitbucket.org/paraty/payment-seeker/pull-requests/42",
      capabilities: READ_ONLY_CAPABILITIES,
      viewerInvolvement: "unknown",
      additions: null,
      deletions: null,
      mergeability: null,
    });

    expect(decoded.provider).toBe("bitbucket");
    expect(decoded.viewerInvolvement).toBe("unknown");
    expect(decoded.capabilities).toEqual(READ_ONLY_CAPABILITIES);
    expect(decoded.additions).toBeNull();
    expect(decoded.deletions).toBeNull();
    expect(decoded.mergeability).toBeNull();
  });
});

describe("PullRequestDetail", () => {
  function bitbucketDetail(overrides: Record<string, unknown> = {}) {
    return {
      projectId: "project-1",
      projectTitle: "Project One",
      workspaceRoot: "/workspace/project-one",
      provider: "bitbucket",
      repository: "paraty/payment-seeker",
      number: 12,
      title: "Read-only provider",
      body: "Description",
      url: "https://bitbucket.org/paraty/payment-seeker/pull-requests/12",
      capabilities: READ_ONLY_CAPABILITIES,
      author: null,
      state: "open",
      isDraft: false,
      mergeable: null,
      mergeability: null,
      mergeStateStatus: null,
      reviewDecision: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      headBranch: "feature/readonly",
      baseBranch: "main",
      createdAt: "2026-07-13T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      maintainerCanModify: false,
      reviewers: [],
      labels: [],
      checks: null,
      comments: [],
      commentsTruncated: false,
      commentsIncomplete: false,
      commits: [],
      mergeCapabilities: {
        merge: false,
        squash: false,
        rebase: false,
        deleteBranchOnMerge: false,
      },
      ...overrides,
    };
  }

  it("defaults mergeability for a real pre-field detail payload", () => {
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
    expect(decoded.stack).toBeNull();
    expect(decoded.stackMetadataIncomplete).toBe(false);
    expect(
      decodeDetail({ ...decoded, stackMetadataIncomplete: true }).stackMetadataIncomplete,
    ).toBe(true);
  });

  it("decodes a complete stack while preserving bottom-to-top positions", () => {
    const decoded = decodeDetail({
      projectId: "project-1",
      projectTitle: "Project One",
      workspaceRoot: "/workspace/project-one",
      repository: "acme/widgets",
      number: 43,
      title: "Top layer",
      body: "Description",
      url: "https://github.com/acme/widgets/pull/43",
      author: null,
      state: "open",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeability: "mergeable",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      additions: 2,
      deletions: 1,
      changedFiles: 1,
      headBranch: "feature/top",
      baseBranch: "feature/base",
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
      stack: {
        number: 8,
        size: 2,
        position: 2,
        baseBranch: "main",
        entries: [
          {
            position: 1,
            number: 42,
            title: "Base layer",
            url: "https://github.com/acme/widgets/pull/42",
            headBranch: "feature/base",
            baseBranch: "main",
            state: "open",
            isDraft: false,
            mergeability: "mergeable",
            mergeStateStatus: "CLEAN",
          },
          {
            position: 2,
            number: 43,
            title: "Top layer",
            url: "https://github.com/acme/widgets/pull/43",
            headBranch: "feature/top",
            baseBranch: "feature/base",
            state: "open",
            isDraft: false,
            mergeability: "mergeable",
            mergeStateStatus: "CLEAN",
          },
        ],
      },
    });

    expect(decoded.stack?.entries.map((entry) => entry.number)).toEqual([42, 43]);
  });

  it("rejects explicit Bitbucket detail without explicit capabilities", () => {
    const { capabilities, ...detailWithoutCapabilities } = bitbucketDetail();
    expect(() => decodeDetail(detailWithoutCapabilities)).toThrow();
    expect(capabilities).toEqual(READ_ONLY_CAPABILITIES);
  });

  it("rejects explicit Bitbucket detail with writable capabilities", () => {
    for (const capability of BITBUCKET_WRITABLE_CAPABILITY_KEYS) {
      expect(() =>
        decodeDetail(
          bitbucketDetail({
            capabilities: { ...READ_ONLY_CAPABILITIES, [capability]: true },
          }),
        ),
      ).toThrow();
    }
  });

  it("decodes explicit Bitbucket detail with unavailable provider-owned metadata", () => {
    const decoded = decodeDetail(bitbucketDetail());

    expect(decoded.provider).toBe("bitbucket");
    expect(decoded.capabilities).toEqual(READ_ONLY_CAPABILITIES);
    expect(decoded.additions).toBeNull();
    expect(decoded.deletions).toBeNull();
    expect(decoded.changedFiles).toBeNull();
    expect(decoded.mergeability).toBeNull();
    expect(decoded.checks).toBeNull();
  });
});

describe("PullRequestActionResult", () => {
  it("defaults old mutation acknowledgements to no merge outcome", () => {
    const decoded = decodeActionResult({
      projectId: "project-1",
      repository: "acme/widgets",
      number: 42,
      workspaceRoot: "/workspace/project-one",
    });
    expect(decoded.provider).toBe("github");
    expect(decoded.mergeOutcome).toBeNull();
  });
});

describe("PullRequestsListResult", () => {
  it("defaults provider requirements during rolling restarts", () => {
    const decoded = decodeListResult({
      viewer: "octocat",
      entries: [],
      errors: [],
      repositoryBatches: [],
    });
    expect(decoded.providerRequirements).toEqual([]);
  });

  it("keeps provider/repository nullable only for legacy local inventory errors", () => {
    expect(
      decodeListResult({
        viewer: null,
        entries: [],
        errors: [
          {
            projectId: "project-1",
            projectTitle: "Project One",
            message: "git config unavailable",
          },
        ],
        repositoryBatches: [],
      }).errors[0],
    ).toMatchObject({ provider: null, repository: null });

    expect(() =>
      decodeListResult({
        viewer: null,
        entries: [],
        errors: [
          {
            projectId: "project-1",
            projectTitle: "Project One",
            provider: "bitbucket",
            message: "MCP unavailable",
          },
        ],
        repositoryBatches: [],
      }),
    ).toThrow();

    expect(
      decodeListResult({
        viewer: null,
        entries: [],
        errors: [
          {
            projectId: "project-1",
            projectTitle: "Project One",
            provider: "bitbucket",
            repository: "paraty/payment-seeker",
            message: "MCP unavailable",
          },
        ],
        repositoryBatches: [],
      }).errors[0],
    ).toMatchObject({ provider: "bitbucket", repository: "paraty/payment-seeker" });
  });
});

describe("PullRequestProviderRequirement", () => {
  it("includes the authorizing lifecycle state", () => {
    expect(
      decodeProviderRequirement({
        provider: "bitbucket",
        presetId: "paraty-mcp",
        status: "authorizing",
      }),
    ).toEqual({
      provider: "bitbucket",
      presetId: "paraty-mcp",
      status: "authorizing",
    });
  });
});

describe("PullRequestDetailInput", () => {
  it("defaults old detail links to GitHub", () => {
    expect(
      decodeDetailInput({
        projectId: "project-1",
        repository: "owner/repo",
        number: 12,
      }).provider,
    ).toBe("github");
  });
});

describe("PullRequestActionInput", () => {
  it("defaults old action inputs to GitHub", () => {
    expect(
      decodeActionInput({
        projectId: "project-1",
        repository: "acme/widgets",
        number: 42,
        action: "ready",
      }).provider,
    ).toBe("github");
  });
});

describe("PullRequestCommentInput", () => {
  const base = {
    projectId: "project-1",
    repository: "acme/widgets",
    number: 42,
  } as const;

  it("defaults old comment inputs to GitHub", () => {
    expect(decodeCommentInput({ ...base, body: "Looks good" }).provider).toBe("github");
  });

  it("accepts GitHub's maximum comment length and rejects one character more", () => {
    expect(decodeCommentInput({ ...base, body: "x".repeat(65_536) }).body).toHaveLength(65_536);
    expect(() => decodeCommentInput({ ...base, body: "x".repeat(65_537) })).toThrow();
  });
});

describe("PullRequestSetPinnedInput", () => {
  it("decodes a project-scoped idempotent pin setter with a legacy GitHub default", () => {
    expect(
      decodeSetPinnedInput({
        projectId: "project-1",
        repository: "acme/widgets",
        number: 42,
        isPinned: true,
      }),
    ).toEqual({
      projectId: "project-1",
      provider: "github",
      repository: "acme/widgets",
      number: 42,
      isPinned: true,
    });
  });

  it("keeps pin results provider-scoped", () => {
    expect(
      decodeSetPinnedResult({
        projectId: "project-1",
        provider: "bitbucket",
        repository: "paraty/payment-seeker",
        number: 42,
        isPinned: true,
      }),
    ).toEqual({
      projectId: "project-1",
      provider: "bitbucket",
      repository: "paraty/payment-seeker",
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
