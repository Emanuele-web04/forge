import { Effect, Layer, Schema } from "effect";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type GitPullRequestCheck,
  type GitPullRequestCheckStatus,
  type GitPullRequestComment,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestLabel,
  type PullRequestMergeCapabilities,
  type PullRequestStack,
  type PullRequestStackSummary,
} from "@synara/contracts";
import { githubAvatarUrlForLogin } from "@synara/shared/githubAvatar";
import {
  isValidGitHubRepositoryNameWithOwner,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
} from "@synara/shared/githubRepository";

import { runProcess } from "../../processRunner";
import { GitHubCliError } from "../Errors.ts";
import {
  GitHubCli,
  PULL_REQUEST_SUMMARY_JSON_FIELDS,
  type GitHubRepositoryCloneUrls,
  type GitHubCliShape,
  type GitHubPullRequestDetailData,
  type GitHubPullRequestListBatch,
  type GitHubPullRequestListItem,
  type GitHubPullRequestSummary,
} from "../Services/GitHubCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const PULL_REQUEST_DIFF_MAX_BYTES = 8 * 1024 * 1024;
const GITHUB_HOST = "github.com";

export const PULL_REQUEST_LIST_JSON_FIELDS =
  "number,title,url,author,headRefName,baseRefName,state,isDraft,additions,deletions,updatedAt,createdAt,reviewDecision,reviewRequests,labels,mergedAt,mergeable";
export const PULL_REQUEST_DETAIL_JSON_FIELDS =
  "number,title,body,url,author,state,isDraft,mergeable,mergeStateStatus,additions,deletions,changedFiles,headRefName,baseRefName,reviewDecision,reviewRequests,reviews,comments,statusCheckRollup,commits,labels,maintainerCanModify,createdAt,updatedAt,mergedAt,closedAt";

function normalizeGitHubCliError(operation: "execute" | "stdout", error: unknown): GitHubCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: gh")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        reason: "not-installed",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("gh auth login") ||
      lower.includes("no oauth token") ||
      lower.includes("bad credentials") ||
      lower.includes("http 401") ||
      lower.includes("401 unauthorized")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        reason: "not-authenticated",
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve to a pullrequest") ||
      lower.includes("repository.pullrequest") ||
      lower.includes("no pull requests found for branch") ||
      lower.includes("pull request not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        reason: "other",
        cause: error,
      });
    }

    return new GitHubCliError({
      operation,
      detail: `GitHub CLI command failed: ${error.message}`,
      reason: "other",
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: "GitHub CLI command failed.",
    reason: "other",
    cause: error,
  });
}

// GitHub reports MERGEABLE/CONFLICTING/UNKNOWN; UNKNOWN also stands in for the
// transient window right after a push while GitHub recomputes mergeability.
function normalizePullRequestMergeability(
  mergeable: string | null | undefined,
): "mergeable" | "conflicting" | "unknown" {
  switch (mergeable) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function normalizeDiffCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizePullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const mergedAt = input.mergedAt;
  const state = input.state;
  if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  return "open";
}

const RawGitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  changedFiles: Schema.optional(Schema.NullOr(Schema.Number)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

// `gh pr view --json statusCheckRollup` mixes CheckRun and StatusContext nodes; both are
// covered by one permissive shape and told apart by which fields are populated.
const RawStatusCheckRollupItemSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestChecksSchema = Schema.Struct({
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(RawStatusCheckRollupItemSchema))),
});

const RawActorSchema = Schema.Struct({
  __typename: Schema.optional(Schema.NullOr(Schema.String)),
  login: Schema.optional(TrimmedNonEmptyString),
  slug: Schema.optional(TrimmedNonEmptyString),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabelSchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
});

const RawIssueCommentSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
});

const RawCommitSchema = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.optional(Schema.NullOr(Schema.String)),
  messageBody: Schema.optional(Schema.NullOr(Schema.String)),
  committedDate: TrimmedNonEmptyString,
  authors: Schema.optional(Schema.NullOr(Schema.Array(RawActorSchema))),
});

const RawRepositoryMergeCapabilitiesSchema = Schema.Struct({
  mergeCommitAllowed: Schema.Boolean,
  squashMergeAllowed: Schema.Boolean,
  rebaseMergeAllowed: Schema.Boolean,
  deleteBranchOnMerge: Schema.Boolean,
});

const RawPullRequestListItemSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  headRefName: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  reviewRequests: Schema.optional(Schema.NullOr(Schema.Array(RawActorSchema))),
  reviews: Schema.optional(Schema.NullOr(Schema.Array(RawReviewSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawLabelSchema))),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestNumberSchema = Schema.Struct({
  number: PositiveInt,
});

const RawPullRequestDetailSchema = Schema.Struct({
  ...RawPullRequestListItemSchema.fields,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  changedFiles: Schema.optional(Schema.NullOr(Schema.Number)),
  comments: Schema.optional(Schema.NullOr(Schema.Array(RawIssueCommentSchema))),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(RawStatusCheckRollupItemSchema))),
  commits: Schema.optional(Schema.NullOr(Schema.Array(RawCommitSchema))),
  maintainerCanModify: Schema.optional(Schema.NullOr(Schema.Boolean)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubPullRequestWithChecksSchema = Schema.Struct({
  ...RawGitHubPullRequestSchema.fields,
  ...RawPullRequestChecksSchema.fields,
});

const PULL_REQUEST_REVIEW_THREAD_PAGE_SIZE = 50;
const PULL_REQUEST_REVIEW_THREAD_PAGE_LIMIT = 5;
const PULL_REQUEST_REVIEW_COMMENT_LIMIT = 20;
const PULL_REQUEST_STACK_ENTRY_LIMIT = 100;
const PULL_REQUEST_ASYNC_MERGE_POLL_LIMIT = 300;

// GraphQL review-threads query: resolved threads are filtered after fetch because GitHub's
// reviewThreads connection does not expose an unresolved-only argument.
const PULL_REQUEST_REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: $first, after: $after) {
        nodes {
          isResolved
          comments(first: 1) {
            nodes {
              id
              body
              path
              url
              createdAt
              author { login }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const PULL_REQUEST_STACK_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      stackEntry { position }
      stack {
        number
        size
        baseRefName
        entries(first: $first, after: $after) {
          totalCount
          nodes {
            position
            pullRequest {
              number
              title
              url
              headRefName
              baseRefName
              state
              isDraft
              mergedAt
              mergeable
              mergeStateStatus
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
}`;

function buildPullRequestStackSummariesQuery(numbers: ReadonlyArray<number>): string {
  const selections = numbers
    .map(
      (number) => `    pr_${number}: pullRequest(number: ${number}) {
      stackEntry { position }
      stack { number size baseRefName }
    }`,
    )
    .join("\n");
  return `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${selections}
  }
}`;
}

const RawGraphQlErrorSchema = Schema.Struct({
  message: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewThreadCommentSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawReviewThreadSchema = Schema.Struct({
  isResolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(
          Schema.NullOr(Schema.Array(Schema.NullOr(RawReviewThreadCommentSchema))),
        ),
      }),
    ),
  ),
});

const RawReviewThreadsResponseSchema = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawGraphQlErrorSchema)))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              pullRequest: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    reviewThreads: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          nodes: Schema.optional(
                            Schema.NullOr(Schema.Array(Schema.NullOr(RawReviewThreadSchema))),
                          ),
                          pageInfo: Schema.optional(
                            Schema.NullOr(
                              Schema.Struct({
                                hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)),
                                endCursor: Schema.optional(Schema.NullOr(Schema.String)),
                              }),
                            ),
                          ),
                        }),
                      ),
                    ),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});

const RawPullRequestStackEntrySchema = Schema.Struct({
  position: PositiveInt,
  pullRequest: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: PositiveInt,
        title: TrimmedNonEmptyString,
        url: TrimmedNonEmptyString,
        headRefName: TrimmedNonEmptyString,
        baseRefName: TrimmedNonEmptyString,
        state: Schema.optional(Schema.NullOr(Schema.String)),
        isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
        mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
        mergeable: Schema.optional(Schema.NullOr(Schema.String)),
        mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawPullRequestStackResponseSchema = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawGraphQlErrorSchema)))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              pullRequest: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    stackEntry: Schema.optional(
                      Schema.NullOr(Schema.Struct({ position: PositiveInt })),
                    ),
                    stack: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          number: PositiveInt,
                          size: PositiveInt,
                          baseRefName: TrimmedNonEmptyString,
                          entries: Schema.Struct({
                            totalCount: PositiveInt,
                            nodes: Schema.optional(
                              Schema.NullOr(
                                Schema.Array(Schema.NullOr(RawPullRequestStackEntrySchema)),
                              ),
                            ),
                            pageInfo: Schema.optional(
                              Schema.NullOr(
                                Schema.Struct({
                                  hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)),
                                  endCursor: Schema.optional(Schema.NullOr(Schema.String)),
                                }),
                              ),
                            ),
                          }),
                        }),
                      ),
                    ),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});

type RawPullRequestStackEntry = Schema.Schema.Type<typeof RawPullRequestStackEntrySchema>;
type RawPullRequestStackResponse = Schema.Schema.Type<typeof RawPullRequestStackResponseSchema>;

const RawPullRequestStackSummarySchema = Schema.Struct({
  stackEntry: Schema.optional(Schema.NullOr(Schema.Struct({ position: PositiveInt }))),
  stack: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: PositiveInt,
        size: PositiveInt,
        baseRefName: TrimmedNonEmptyString,
      }),
    ),
  ),
});

const RawPullRequestStackSummariesResponseSchema = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawGraphQlErrorSchema)))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Record(Schema.String, Schema.NullOr(RawPullRequestStackSummarySchema)),
          ),
        ),
      }),
    ),
  ),
});

const RawAsyncMergeResultSchema = Schema.Struct({
  status: Schema.Literals(["pending", "merged", "enqueued", "failed"]),
  details: Schema.Struct({
    message: Schema.optional(Schema.NullOr(Schema.String)),
    uuid: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

function normalizePullRequestSummary(
  raw: Schema.Schema.Type<typeof RawGitHubPullRequestSchema>,
): GitHubPullRequestSummary {
  const headRepositoryNameWithOwner = raw.headRepository?.nameWithOwner ?? null;
  const headRepositoryOwnerLogin =
    raw.headRepositoryOwner?.login ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizePullRequestState(raw),
    isDraft: raw.isDraft === true,
    mergeability: normalizePullRequestMergeability(raw.mergeable),
    additions: normalizeDiffCount(raw.additions),
    deletions: normalizeDiffCount(raw.deletions),
    changedFiles: normalizeDiffCount(raw.changedFiles),
    updatedAt: raw.updatedAt?.trim() || null,
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

// Maps StatusContext states and CheckRun statuses/conclusions onto the shared check status.
function normalizeCheckStatus(
  item: Schema.Schema.Type<typeof RawStatusCheckRollupItemSchema>,
): GitPullRequestCheckStatus {
  if (typeof item.state === "string" && item.state.length > 0) {
    switch (item.state) {
      case "SUCCESS":
        return "success";
      case "FAILURE":
      case "ERROR":
        return "failure";
      default:
        return "pending";
    }
  }

  if (typeof item.status === "string" && item.status !== "COMPLETED") {
    return "pending";
  }

  switch (item.conclusion) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "failure";
    case "SKIPPED":
      return "skipped";
    case "CANCELLED":
      return "cancelled";
    case "NEUTRAL":
    case "STALE":
      return "neutral";
    default:
      return "pending";
  }
}

function normalizePullRequestChecks(
  raw: Schema.Schema.Type<typeof RawPullRequestChecksSchema>,
): GitPullRequestCheck[] {
  const checks: GitPullRequestCheck[] = [];
  for (const item of raw.statusCheckRollup ?? []) {
    const name = (item.name ?? item.context ?? "").trim();
    if (name.length === 0) {
      continue;
    }
    checks.push({
      name,
      status: normalizeCheckStatus(item),
      url: item.detailsUrl ?? item.targetUrl ?? null,
    });
  }
  return checks;
}

function normalizeActor(
  raw: Schema.Schema.Type<typeof RawActorSchema> | null | undefined,
): PullRequestActor | null {
  if (!raw) return null;
  const login = raw.login ?? raw.slug;
  if (!login) return null;
  return {
    login,
    name: raw.name?.trim() || null,
    // gh's JSON never includes avatar URLs, so derive the canonical login-addressed one —
    // but only from a real user login. A team's slug is not a username, and deriving from it
    // could show an unrelated user who happens to share the name.
    avatarUrl: raw.avatarUrl?.trim() || (raw.login ? githubAvatarUrlForLogin(raw.login) : null),
    url: raw.url?.trim() || null,
  };
}

function normalizeLabels(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawLabelSchema>> | null | undefined,
): PullRequestLabel[] {
  return (raw ?? []).map((label) => ({ name: label.name, color: label.color?.trim() || null }));
}

function nonNegativeCount(value: number | null | undefined): number {
  return normalizeDiffCount(value) ?? 0;
}

function normalizePullRequestListItem(
  raw: Schema.Schema.Type<typeof RawPullRequestListItemSchema>,
): GitHubPullRequestListItem {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: normalizeActor(raw.author),
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    state: normalizePullRequestState(raw),
    isDraft: raw.isDraft === true,
    additions: nonNegativeCount(raw.additions),
    deletions: nonNegativeCount(raw.deletions),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    reviewDecision: raw.reviewDecision?.trim() || null,
    // Only User review requests have a login. A Team slug is not a viewer identity and
    // comparing it with the current user's login would create false-positive badges.
    reviewRequestLogins: (raw.reviewRequests ?? []).flatMap((actor) =>
      actor.login ? [actor.login] : [],
    ),
    labels: normalizeLabels(raw.labels),
    mergeability: normalizePullRequestMergeability(raw.mergeable),
    stack: null,
  };
}

function normalizeDetailedChecks(
  raw: Schema.Schema.Type<typeof RawPullRequestChecksSchema>,
): PullRequestCheck[] {
  return (raw.statusCheckRollup ?? []).flatMap((item) => {
    const name = (item.name ?? item.context ?? "").trim();
    if (!name) return [];
    return [
      {
        name,
        status: normalizeCheckStatus(item),
        description: item.description?.trim() || null,
        url: item.detailsUrl ?? item.targetUrl ?? null,
        startedAt: item.startedAt?.trim() || null,
        completedAt: item.completedAt?.trim() || null,
      },
    ];
  });
}

function normalizeDetailComments(
  raw: Schema.Schema.Type<typeof RawPullRequestDetailSchema>,
): PullRequestComment[] {
  const issueComments: PullRequestComment[] = (raw.comments ?? []).flatMap((comment, index) => {
    if (!comment.createdAt) return [];
    return [
      {
        id: comment.id?.trim() || `issue-comment-${index}-${comment.createdAt}`,
        kind: "issue-comment" as const,
        author: normalizeActor(comment.author),
        body: comment.body ?? "",
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt?.trim() || null,
        url: comment.url?.trim() || null,
        path: null,
        reviewState: null,
      },
    ];
  });
  const reviews: PullRequestComment[] = (raw.reviews ?? []).flatMap((review, index) => {
    const createdAt = review.submittedAt?.trim() || review.updatedAt?.trim();
    if (!createdAt) return [];
    return [
      {
        id: review.id?.trim() || `review-${index}-${createdAt}`,
        kind: "review" as const,
        author: normalizeActor(review.author),
        body: review.body ?? "",
        createdAt,
        updatedAt: review.updatedAt?.trim() || null,
        url: review.url?.trim() || null,
        path: null,
        reviewState: review.state?.trim() || null,
      },
    ];
  });
  return [...issueComments, ...reviews];
}

function normalizePullRequestDetail(
  raw: Schema.Schema.Type<typeof RawPullRequestDetailSchema>,
): GitHubPullRequestDetailData {
  const reviewers = new Map<string, PullRequestActor>();
  for (const actor of [
    ...(raw.reviewRequests ?? []),
    ...(raw.reviews ?? []).flatMap((review) => (review.author ? [review.author] : [])),
  ]) {
    const normalized = normalizeActor(actor);
    if (normalized) reviewers.set(normalized.login.toLowerCase(), normalized);
  }
  return {
    ...normalizePullRequestListItem(raw),
    body: raw.body ?? "",
    mergeable: raw.mergeable?.trim() || null,
    mergeStateStatus: raw.mergeStateStatus?.trim() || null,
    changedFiles: nonNegativeCount(raw.changedFiles),
    mergedAt: raw.mergedAt?.trim() || null,
    closedAt: raw.closedAt?.trim() || null,
    maintainerCanModify: raw.maintainerCanModify === true,
    reviewers: [...reviewers.values()],
    checks: normalizeDetailedChecks(raw),
    comments: normalizeDetailComments(raw),
    commits: (raw.commits ?? []).map(
      (commit): PullRequestCommit => ({
        oid: commit.oid,
        messageHeadline: commit.messageHeadline?.trim() ?? "",
        messageBody: commit.messageBody ?? "",
        committedDate: commit.committedDate,
        authors: (commit.authors ?? []).flatMap((actor) => {
          const normalized = normalizeActor(actor);
          return normalized ? [normalized] : [];
        }),
      }),
    ),
  };
}

const decodeRawPullRequestListItem = Schema.decodeUnknownSync(RawPullRequestListItemSchema);

export function decodeRepositoryPullRequestListJson(
  raw: string,
): Effect.Effect<GitHubPullRequestListBatch, GitHubCliError> {
  const trimmed = raw.trim();
  if (!trimmed) return Effect.succeed({ entries: [], rawCount: 0 });
  return decodeGitHubJson(
    trimmed,
    Schema.Array(Schema.Unknown),
    "listRepositoryPullRequests",
    "GitHub CLI returned invalid repository PR list JSON.",
  ).pipe(
    Effect.map((rawEntries) => ({
      rawCount: rawEntries.length,
      entries: rawEntries.flatMap((entry) => {
        try {
          return [normalizePullRequestListItem(decodeRawPullRequestListItem(entry))];
        } catch {
          return [];
        }
      }),
    })),
  );
}

function normalizePullRequestReviewComments(
  raw: Schema.Schema.Type<typeof RawReviewThreadsResponseSchema>,
): GitPullRequestComment[] {
  const threads = raw.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const comments: GitPullRequestComment[] = [];
  for (const thread of threads) {
    if (!thread || thread.isResolved === true) {
      continue;
    }
    const rootComment = thread.comments?.nodes?.find((node) => node !== null) ?? null;
    if (!rootComment) {
      continue;
    }
    comments.push({
      id: rootComment.id,
      author: rootComment.author?.login?.trim() || null,
      body: rootComment.body ?? "",
      path: rootComment.path?.trim() || null,
      url: rootComment.url ?? null,
      createdAt: rootComment.createdAt?.trim() || null,
    });
  }
  return comments;
}

function getGraphQlErrorDetail(raw: {
  readonly errors?:
    | ReadonlyArray<{ readonly message?: string | null | undefined } | null>
    | null
    | undefined;
}): string | null {
  const messages =
    raw.errors
      ?.flatMap((error) => {
        const message = error?.message?.trim();
        return message ? [message] : [];
      })
      .join("; ") ?? "";
  return messages.length > 0 ? `GitHub GraphQL returned errors: ${messages}` : null;
}

function getPullRequestReviewThreadsPageInfo(
  raw: Schema.Schema.Type<typeof RawReviewThreadsResponseSchema>,
): { hasNextPage: boolean; endCursor: string | null } {
  const pageInfo = raw.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
  return {
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: pageInfo?.endCursor?.trim() || null,
  };
}

function normalizePullRequestStack(
  raw: RawPullRequestStackResponse,
  selectedPullRequestNumber: number,
  rawEntries = raw.data?.repository?.pullRequest?.stack?.entries.nodes ?? [],
): Effect.Effect<PullRequestStack | null, GitHubCliError> {
  const graphQlErrorDetail = getGraphQlErrorDetail(raw);
  if (graphQlErrorDetail) {
    return Effect.fail(
      new GitHubCliError({
        operation: "getPullRequestStack",
        detail: graphQlErrorDetail,
        reason: "other",
      }),
    );
  }

  const pullRequest = raw.data?.repository?.pullRequest;
  const stack = pullRequest?.stack;
  const selectedEntry = pullRequest?.stackEntry;
  if (!stack && !selectedEntry) return Effect.succeed(null);
  if (!stack || !selectedEntry) {
    return Effect.fail(
      new GitHubCliError({
        operation: "getPullRequestStack",
        detail: "GitHub returned incomplete pull request stack metadata.",
        reason: "other",
      }),
    );
  }

  const entries = rawEntries
    .flatMap((entry) => {
      const member = entry?.pullRequest;
      if (!entry || !member) return [];
      return [
        {
          position: entry.position,
          number: member.number,
          title: member.title,
          url: member.url,
          headBranch: member.headRefName,
          baseBranch: member.baseRefName,
          state: normalizePullRequestState(member),
          isDraft: member.isDraft === true,
          mergeability: normalizePullRequestMergeability(member.mergeable),
          mergeStateStatus: member.mergeStateStatus?.trim() || null,
        },
      ];
    })
    .toSorted((left, right) => left.position - right.position);

  if (
    stack.size !== stack.entries.totalCount ||
    entries.length !== stack.size ||
    selectedEntry.position > stack.size ||
    entries.some((entry, index) => entry.position !== index + 1) ||
    entries[selectedEntry.position - 1]?.number !== selectedPullRequestNumber
  ) {
    return Effect.fail(
      new GitHubCliError({
        operation: "getPullRequestStack",
        detail: "GitHub returned a partial or inconsistent pull request stack.",
        reason: "other",
      }),
    );
  }

  return Effect.succeed({
    number: stack.number,
    size: stack.size,
    position: selectedEntry.position,
    baseBranch: stack.baseRefName,
    entries,
  });
}

function getPullRequestStackPageInfo(raw: RawPullRequestStackResponse): {
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const pageInfo = raw.data?.repository?.pullRequest?.stack?.entries.pageInfo;
  return {
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: pageInfo?.endCursor?.trim() || null,
  };
}

function normalizePullRequestStackSummaries(
  raw: Schema.Schema.Type<typeof RawPullRequestStackSummariesResponseSchema>,
  numbers: ReadonlyArray<number>,
): Effect.Effect<ReadonlyMap<number, PullRequestStackSummary>, GitHubCliError> {
  const graphQlErrorDetail = getGraphQlErrorDetail(raw);
  if (graphQlErrorDetail) {
    return Effect.fail(
      new GitHubCliError({
        operation: "listRepositoryPullRequests",
        detail: graphQlErrorDetail,
        reason: "other",
      }),
    );
  }

  const repository = raw.data?.repository;
  if (!repository) {
    return Effect.fail(
      new GitHubCliError({
        operation: "listRepositoryPullRequests",
        detail: "GitHub returned incomplete pull request stack summaries.",
        reason: "other",
      }),
    );
  }

  const summaries = new Map<number, PullRequestStackSummary>();
  for (const number of numbers) {
    const pullRequest = repository[`pr_${number}`];
    const stack = pullRequest?.stack;
    const stackEntry = pullRequest?.stackEntry;
    if (!stack || !stackEntry || stackEntry.position > stack.size) continue;
    summaries.set(number, {
      number: stack.number,
      size: stack.size,
      position: stackEntry.position,
      baseBranch: stack.baseRefName,
    });
  }
  return Effect.succeed(summaries);
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation:
    | "listOpenPullRequests"
    | "listPullRequests"
    | "getPullRequest"
    | "getRepositoryCloneUrls"
    | "getPullRequestWithChecks"
    | "getPullRequestReviewComments"
    | "getPullRequestStack"
    | "listRepositoryPullRequests"
    | "getPullRequestDetail"
    | "getPullRequestListItem"
    | "listReviewRequestedPullRequestNumbers"
    | "getRepositoryMergeCapabilities"
    | "runPullRequestAction",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail: error instanceof Error ? `${invalidDetail}: ${error.message}` : invalidDetail,
          cause: error,
        }),
    ),
  );
}

const decodeRawPullRequestEntry = Schema.decodeUnknownSync(RawGitHubPullRequestSchema);

/**
 * Decode + normalize a `gh pr list --json` payload. Exported so test fakes parse fixtures
 * through the exact same schema/normalization as the live layer instead of re-implementing it.
 *
 * Entries are decoded individually: one malformed PR (a gh quirk or API oddity) must not
 * hide the healthy PRs in the same list. Only a payload that is not a JSON array fails.
 */
export function decodePullRequestListJson(
  raw: string,
  operation: "listOpenPullRequests" | "listPullRequests" = "listPullRequests",
): Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Effect.succeed([]);
  }
  return decodeGitHubJson(
    trimmed,
    Schema.Array(Schema.Unknown),
    operation,
    "GitHub CLI returned invalid PR list JSON.",
  ).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) => {
        try {
          return [normalizePullRequestSummary(decodeRawPullRequestEntry(entry))];
        } catch {
          return [];
        }
      }),
    ),
  );
}

const makeGitHubCli = Effect.sync(() => {
  const execute: GitHubCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: (signal) =>
        runProcess("gh", input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal,
          // Repository discovery accepts GitHub.com remotes only. Pin the CLI host as well so a
          // caller-level GH_HOST override cannot redirect commands that lack a --hostname flag.
          env: { ...process.env, ...input.env, GH_HOST: GITHUB_HOST },
          ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
          ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
          ...(input.allowNonZeroExit !== undefined
            ? { allowNonZeroExit: input.allowNonZeroExit }
            : {}),
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
          ...(input.onStdoutChunk !== undefined ? { onStdoutChunk: input.onStdoutChunk } : {}),
          ...(input.onStderrChunk !== undefined ? { onStderrChunk: input.onStderrChunk } : {}),
        }),
      catch: (error) => normalizeGitHubCliError("execute", error),
    });

  const PULL_REQUEST_DIFF_TOO_LARGE_PATTERN = /exceeded the maximum number of files|too_large/i;
  const PULL_REQUEST_DIFF_MISSING_OBJECT_PATTERN =
    /bad object|unknown revision|not a valid object name|no merge base|bad revision/i;
  const PULL_REQUEST_DIFF_NO_MERGE_BASE_PATTERN = /no merge base/i;
  // Deepen incrementally instead of turning an intentionally shallow checkout into a full clone.
  // Additional fetched history is bounded to 1,344 generations per oversized-diff recovery.
  const PULL_REQUEST_DIFF_INITIAL_DEEPEN = 64;
  const PULL_REQUEST_DIFF_DEEPEN_STEPS = [256, 1_024] as const;

  const runGit = (gitInput: {
    cwd: string;
    args: readonly string[];
    maxBufferBytes?: number;
    outputMode?: "error" | "truncate";
    timeoutMs?: number;
  }) =>
    Effect.tryPromise({
      try: (signal) =>
        runProcess("git", gitInput.args, {
          cwd: gitInput.cwd,
          timeoutMs: gitInput.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal,
          // Never let git block on an interactive credential prompt; fail instead so the
          // caller can surface the error.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          ...(gitInput.maxBufferBytes !== undefined
            ? { maxBufferBytes: gitInput.maxBufferBytes }
            : {}),
          ...(gitInput.outputMode !== undefined ? { outputMode: gitInput.outputMode } : {}),
        }),
      catch: (error) => normalizeGitHubCliError("execute", error),
    });

  const repositoryFromConfiguredRemoteUrl = (remoteUrl: string): string | null => {
    const direct = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
    if (direct) return direct;
    try {
      const parsed = new URL(remoteUrl);
      if (!parsed.username && !parsed.password) return null;
      parsed.username = "";
      parsed.password = "";
      return parseGitHubRepositoryNameWithOwnerFromRemoteUrl(parsed.toString());
    } catch {
      return null;
    }
  };

  // Prefer the name of a configured remote that already points at the repository. Git resolves its
  // URL and credentials internally, so an HTTPS token embedded in remote config never enters argv
  // or process-runner error text. `--` makes the name an operand; suspicious leading-dash names are
  // ignored entirely and use the anonymous HTTPS fallback instead.
  const resolvePullRequestFetchSource = (cwd: string, repository: string) =>
    runGit({ cwd, args: ["remote", "-v"] }).pipe(
      Effect.map((result) => {
        const target = repository.toLowerCase();
        for (const line of result.stdout.split("\n")) {
          const match = /^(\S+)\t(\S+)\s+\(fetch\)$/.exec(line);
          const remoteName = match?.[1];
          const remoteUrl = match?.[2];
          if (!remoteName || !remoteUrl) continue;
          const parsed = repositoryFromConfiguredRemoteUrl(remoteUrl);
          if (parsed?.toLowerCase() === target && !remoteName.startsWith("-")) {
            return remoteName;
          }
        }
        return `https://github.com/${repository}.git`;
      }),
      Effect.catch(() => Effect.succeed(`https://github.com/${repository}.git`)),
    );

  // Local fallback for oversized pull request diffs: resolve the PR's base/head commits via
  // the REST API, diff them with `git diff base...head` (the same merge-base semantics the
  // GitHub diff uses), and fetch the advertised pull head ref plus the base branch first only
  // when the commits are not already in the local object database.
  const localPullRequestDiff = (
    cwd: string,
    repository: string,
    number: number,
  ): Effect.Effect<{ patch: string; truncated: boolean }, GitHubCliError> =>
    Effect.gen(function* () {
      const meta = yield* execute({
        cwd,
        args: [
          "api",
          "--hostname",
          GITHUB_HOST,
          `repos/${repository}/pulls/${number}`,
          "--jq",
          '[.base.ref, .base.sha, .head.sha] | join(" ")',
        ],
      });
      const [baseRef, baseSha, headSha] = meta.stdout.trim().split(/\s+/);
      if (!baseRef || !baseSha || !headSha) {
        return yield* Effect.fail(
          new GitHubCliError({
            operation: "getPullRequestDiff",
            detail: "Could not resolve the pull request's base and head commits.",
            reason: "other",
          }),
        );
      }
      const diff = runGit({
        cwd,
        args: ["diff", "--no-color", `${baseSha}...${headSha}`],
        maxBufferBytes: PULL_REQUEST_DIFF_MAX_BYTES,
        outputMode: "truncate",
      });
      const fetchPullRequestRefs = (fetchSource: string, history?: { deepen: number }) =>
        runGit({
          cwd,
          args: [
            "fetch",
            "--quiet",
            ...(history === undefined ? [] : [`--deepen=${history.deepen}`]),
            "--",
            fetchSource,
            `refs/pull/${number}/head`,
            baseRef,
          ],
          timeoutMs: 120_000,
        });
      const deepenShallowHistoryAndDiff = (fetchSource: string, initialError: GitHubCliError) =>
        Effect.gen(function* () {
          let lastError = initialError;
          for (const deepenBy of PULL_REQUEST_DIFF_DEEPEN_STEPS) {
            yield* fetchPullRequestRefs(fetchSource, { deepen: deepenBy });
            const attempt = yield* diff.pipe(
              Effect.map((value) => ({ success: true as const, value })),
              Effect.catch((error) => Effect.succeed({ success: false as const, error })),
            );
            if (attempt.success) return attempt.value;
            lastError = attempt.error;
            if (!PULL_REQUEST_DIFF_NO_MERGE_BASE_PATTERN.test(lastError.detail)) {
              return yield* Effect.fail(lastError);
            }
          }
          return yield* Effect.fail(lastError);
        });
      const result = yield* diff.pipe(
        Effect.catch((error) =>
          // Fetch-and-retry only when the failure means the commits are absent locally;
          // timeouts, permission errors, or an unrelated git failure must surface as-is.
          !PULL_REQUEST_DIFF_MISSING_OBJECT_PATTERN.test(error.detail)
            ? Effect.fail(error)
            : resolvePullRequestFetchSource(cwd, repository).pipe(
                Effect.flatMap((fetchSource) =>
                  runGit({ cwd, args: ["rev-parse", "--is-shallow-repository"] }).pipe(
                    Effect.flatMap((shallowResult) => {
                      const isShallow = shallowResult.stdout.trim() === "true";
                      return fetchPullRequestRefs(
                        fetchSource,
                        isShallow ? { deepen: PULL_REQUEST_DIFF_INITIAL_DEEPEN } : undefined,
                      ).pipe(
                        Effect.flatMap(() =>
                          diff.pipe(
                            Effect.catch((retryError) =>
                              isShallow &&
                              PULL_REQUEST_DIFF_NO_MERGE_BASE_PATTERN.test(retryError.detail)
                                ? deepenShallowHistoryAndDiff(fetchSource, retryError)
                                : Effect.fail(retryError),
                            ),
                          ),
                        ),
                      );
                    }),
                  ),
                ),
              ),
        ),
      );
      return { patch: result.stdout, truncated: result.stdoutTruncated === true };
    });

  const validateRepository = (
    repository: string,
    operation: string,
  ): Effect.Effect<string, GitHubCliError> => {
    const normalized = repository.trim();
    return isValidGitHubRepositoryNameWithOwner(normalized)
      ? Effect.succeed(normalized)
      : Effect.fail(
          new GitHubCliError({
            operation,
            detail: "Invalid GitHub repository identity.",
            reason: "other",
          }),
        );
  };
  const repositorySelector = (repository: string) => `${GITHUB_HOST}/${repository}`;

  const enrichPullRequestListItemsWithStack = (input: {
    cwd: string;
    repository: string;
    entries: ReadonlyArray<GitHubPullRequestListItem>;
  }): Effect.Effect<ReadonlyArray<GitHubPullRequestListItem>> => {
    const numbers = [...new Set(input.entries.map((entry) => entry.number))];
    if (numbers.length === 0) return Effect.succeed(input.entries);
    const [owner = "", repo = ""] = input.repository.split("/");
    return execute({
      cwd: input.cwd,
      args: [
        "api",
        "graphql",
        "--hostname",
        GITHUB_HOST,
        "-f",
        `query=${buildPullRequestStackSummariesQuery(numbers)}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repo}`,
      ],
    }).pipe(
      Effect.flatMap((result) =>
        decodeGitHubJson(
          result.stdout.trim(),
          RawPullRequestStackSummariesResponseSchema,
          "listRepositoryPullRequests",
          "GitHub CLI returned invalid pull request stack summaries JSON.",
        ),
      ),
      Effect.flatMap((raw) => normalizePullRequestStackSummaries(raw, numbers)),
      Effect.map((summaries) =>
        input.entries.map((entry) => ({
          ...entry,
          stack: summaries.get(entry.number) ?? null,
        })),
      ),
      // Stack metadata is a progressive enhancement. A GraphQL/version/auth mismatch must not
      // make the primary pull request list disappear.
      Effect.catch(() => Effect.succeed(input.entries)),
    );
  };

  // One implementation behind both list methods so the field list, decoding, and
  // normalization cannot drift between the open-only and any-state lookups.
  const listPullRequestsWithState = (
    input: { readonly cwd: string; readonly headSelector: string; readonly limit?: number },
    options: {
      readonly state: "open" | "all";
      readonly defaultLimit: number;
      readonly operation: "listOpenPullRequests" | "listPullRequests";
    },
  ) =>
    execute({
      cwd: input.cwd,
      args: [
        "pr",
        "list",
        "--head",
        input.headSelector,
        "--state",
        options.state,
        "--limit",
        String(input.limit ?? options.defaultLimit),
        "--json",
        PULL_REQUEST_SUMMARY_JSON_FIELDS,
      ],
    }).pipe(
      Effect.flatMap((result) => decodePullRequestListJson(result.stdout, options.operation)),
    );

  const decodeAsyncMergeResult = (result: Awaited<ReturnType<typeof runProcess>>) => {
    if (result.timedOut) {
      return Effect.fail(
        new GitHubCliError({
          operation: "runPullRequestAction",
          detail: "GitHub's asynchronous merge request timed out.",
          reason: "other",
        }),
      );
    }
    if (!result.stdout.trim()) {
      return Effect.fail(
        new GitHubCliError({
          operation: "runPullRequestAction",
          detail:
            result.stderr.trim() ||
            `GitHub returned an empty asynchronous merge response (command exit ${result.code ?? "unknown"}).`,
          reason: "other",
        }),
      );
    }
    return decodeGitHubJson(
      result.stdout.trim(),
      RawAsyncMergeResultSchema,
      "runPullRequestAction",
      "GitHub returned an invalid asynchronous merge response.",
    );
  };

  const runAsyncPullRequestMerge = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly mergeMethod: "merge" | "squash" | "rebase";
  }): Effect.Effect<
    { readonly mergeOutcome: "merged" | "enqueued" | "unavailable" },
    GitHubCliError
  > =>
    Effect.gen(function* () {
      const endpoint = `repos/${input.repository}/pulls/${input.number}/merge-async`;
      const submission = yield* execute({
        cwd: input.cwd,
        args: ["api", "--hostname", GITHUB_HOST, "--method", "PUT", endpoint, "--input", "-"],
        stdin: JSON.stringify({ merge_method: input.mergeMethod, merge_action: "default" }),
        // A duplicate in-flight request is HTTP 409 but returns the existing UUID, while a
        // closed/draft PR is HTTP 400 with a terminal `failed` result. Both bodies are useful.
        allowNonZeroExit: true,
      });
      if (
        submission.code !== 0 &&
        /(?:HTTP\s+404|not found)/i.test(`${submission.stdout}\n${submission.stderr}`)
      ) {
        // Async merge is a stacked-PR preview API. A repository without the preview returns 404;
        // its standalone PRs must retain the existing synchronous merge path.
        return { mergeOutcome: "unavailable" };
      }
      let result = yield* decodeAsyncMergeResult(submission);

      for (let pollCount = 0; pollCount <= PULL_REQUEST_ASYNC_MERGE_POLL_LIMIT; pollCount += 1) {
        switch (result.status) {
          case "merged":
            return { mergeOutcome: "merged" };
          case "enqueued":
            return { mergeOutcome: "enqueued" };
          case "failed":
            return yield* Effect.fail(
              new GitHubCliError({
                operation: "runPullRequestAction",
                detail:
                  result.details.message?.trim() || "GitHub could not merge the pull request.",
                reason: "other",
              }),
            );
          case "pending": {
            const uuid = result.details.uuid?.trim();
            if (!uuid) {
              return yield* Effect.fail(
                new GitHubCliError({
                  operation: "runPullRequestAction",
                  detail: "GitHub returned a pending merge request without an identifier.",
                  reason: "other",
                }),
              );
            }
            if (pollCount === PULL_REQUEST_ASYNC_MERGE_POLL_LIMIT) break;
            yield* Effect.sleep("1 second");
            result = yield* execute({
              cwd: input.cwd,
              args: ["api", "--hostname", GITHUB_HOST, `${endpoint}/${uuid}`],
            }).pipe(Effect.flatMap(decodeAsyncMergeResult));
            break;
          }
        }
      }

      return yield* Effect.fail(
        new GitHubCliError({
          operation: "runPullRequestAction",
          detail: "GitHub's asynchronous merge did not finish within five minutes.",
          reason: "other",
        }),
      );
    });

  const service = {
    execute,
    getViewerLogin: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", "user", "--hostname", GITHUB_HOST, "--jq", ".login"],
      }).pipe(
        Effect.flatMap((result) => {
          const login = result.stdout.trim();
          return login.length > 0
            ? Effect.succeed(login)
            : Effect.fail(
                new GitHubCliError({
                  operation: "getViewerLogin",
                  detail: "GitHub CLI returned an empty viewer login.",
                  reason: "other",
                }),
              );
        }),
      ),
    listRepositoryPullRequests: (input) => {
      const searchTerms = [
        ...(input.involvement === "reviewing" ? [`review-requested:${input.viewer}`] : []),
        ...(input.state === "closed" ? ["is:unmerged"] : []),
      ];
      const involvementArgs = [
        ...(input.involvement === "authored" ? ["--author", input.viewer] : []),
        ...(searchTerms.length > 0 ? ["--search", searchTerms.join(" ")] : []),
      ];
      return validateRepository(input.repository, "listRepositoryPullRequests").pipe(
        Effect.flatMap((repository) =>
          execute({
            cwd: input.cwd,
            args: [
              "pr",
              "list",
              "--repo",
              repositorySelector(repository),
              ...involvementArgs,
              "--state",
              input.state,
              "--limit",
              String(input.limit ?? 50),
              "--json",
              PULL_REQUEST_LIST_JSON_FIELDS,
            ],
          }).pipe(
            Effect.flatMap((result) => decodeRepositoryPullRequestListJson(result.stdout)),
            Effect.flatMap((batch) =>
              enrichPullRequestListItemsWithStack({
                cwd: input.cwd,
                repository,
                entries: batch.entries,
              }).pipe(Effect.map((entries) => ({ ...batch, entries }))),
            ),
          ),
        ),
      );
    },
    getPullRequestListItem: (input) =>
      validateRepository(input.repository, "getPullRequestListItem").pipe(
        Effect.flatMap((repository) =>
          execute({
            cwd: input.cwd,
            args: [
              "pr",
              "view",
              String(input.number),
              "--repo",
              repositorySelector(repository),
              "--json",
              PULL_REQUEST_LIST_JSON_FIELDS,
            ],
          }).pipe(
            Effect.flatMap((result) =>
              decodeGitHubJson(
                result.stdout.trim(),
                Schema.Unknown,
                "getPullRequestListItem",
                "GitHub CLI returned invalid pull request JSON.",
              ),
            ),
            Effect.flatMap((entry) =>
              Effect.try({
                try: () => normalizePullRequestListItem(decodeRawPullRequestListItem(entry)),
                catch: () =>
                  new GitHubCliError({
                    operation: "getPullRequestListItem",
                    detail: "GitHub CLI returned an unrecognized pull request shape.",
                    reason: "other",
                  }),
              }),
            ),
            Effect.flatMap((entry) =>
              enrichPullRequestListItemsWithStack({
                cwd: input.cwd,
                repository,
                entries: [entry],
              }).pipe(Effect.map((entries) => entries[0] ?? entry)),
            ),
          ),
        ),
      ),
    listReviewRequestedPullRequestNumbers: (input) =>
      validateRepository(input.repository, "listReviewRequestedPullRequestNumbers").pipe(
        Effect.flatMap((repository) =>
          execute({
            cwd: input.cwd,
            args: [
              "search",
              "prs",
              "--repo",
              repository,
              "--review-requested",
              input.viewer,
              "--state",
              "open",
              "--limit",
              String(input.limit ?? 1_000),
              "--json",
              "number",
            ],
          }),
        ),
        Effect.flatMap((result) =>
          decodeGitHubJson(
            result.stdout.trim(),
            Schema.Array(RawPullRequestNumberSchema),
            "listReviewRequestedPullRequestNumbers",
            "GitHub CLI returned invalid review-requested pull request JSON.",
          ),
        ),
        Effect.map((entries) => entries.map((entry) => entry.number)),
      ),
    getPullRequestDetail: (input) =>
      validateRepository(input.repository, "getPullRequestDetail").pipe(
        Effect.flatMap((repository) =>
          execute({
            cwd: input.cwd,
            args: [
              "pr",
              "view",
              String(input.number),
              "--repo",
              repositorySelector(repository),
              "--json",
              PULL_REQUEST_DETAIL_JSON_FIELDS,
            ],
          }),
        ),
        Effect.flatMap((result) =>
          decodeGitHubJson(
            result.stdout.trim(),
            RawPullRequestDetailSchema,
            "getPullRequestDetail",
            "GitHub CLI returned invalid pull request detail JSON.",
          ),
        ),
        Effect.map(normalizePullRequestDetail),
      ),
    getPullRequestStack: (input) =>
      Effect.gen(function* () {
        const repository = yield* validateRepository(input.repository, "getPullRequestStack");
        const [owner = "", repo = ""] = repository.split("/");
        const loadPage = (after: string | null) =>
          Effect.gen(function* () {
            const result = yield* execute({
              cwd: input.cwd,
              args: [
                "api",
                "graphql",
                "--hostname",
                GITHUB_HOST,
                "-f",
                `query=${PULL_REQUEST_STACK_QUERY}`,
                "-F",
                `owner=${owner}`,
                "-F",
                `repo=${repo}`,
                "-F",
                `number=${input.number}`,
                "-F",
                `first=${PULL_REQUEST_STACK_ENTRY_LIMIT}`,
                ...(after ? ["-F", `after=${after}`] : []),
              ],
            });
            const page = yield* decodeGitHubJson(
              result.stdout.trim(),
              RawPullRequestStackResponseSchema,
              "getPullRequestStack",
              "GitHub CLI returned invalid pull request stack JSON.",
            );
            const graphQlErrorDetail = getGraphQlErrorDetail(page);
            if (graphQlErrorDetail) {
              return yield* Effect.fail(
                new GitHubCliError({
                  operation: "getPullRequestStack",
                  detail: graphQlErrorDetail,
                  reason: "other",
                }),
              );
            }
            return page;
          });

        const firstPage = yield* loadPage(null);
        const entries: Array<RawPullRequestStackEntry | null> = [];
        const seenCursors = new Set<string>();
        let page = firstPage;

        while (true) {
          entries.push(...(page.data?.repository?.pullRequest?.stack?.entries.nodes ?? []));
          const pageInfo = getPullRequestStackPageInfo(page);
          if (!pageInfo.hasNextPage) {
            break;
          }
          if (pageInfo.endCursor === null || seenCursors.has(pageInfo.endCursor)) {
            return yield* Effect.fail(
              new GitHubCliError({
                operation: "getPullRequestStack",
                detail: "GitHub returned invalid pull request stack pagination metadata.",
                reason: "other",
              }),
            );
          }
          seenCursors.add(pageInfo.endCursor);
          page = yield* loadPage(pageInfo.endCursor);
        }

        return yield* normalizePullRequestStack(firstPage, input.number, entries);
      }),
    getRepositoryMergeCapabilities: (input) =>
      validateRepository(input.repository, "getRepositoryMergeCapabilities").pipe(
        Effect.flatMap((repository) =>
          execute({
            cwd: input.cwd,
            args: [
              "repo",
              "view",
              repositorySelector(repository),
              "--json",
              "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge",
            ],
          }),
        ),
        Effect.flatMap((result) =>
          decodeGitHubJson(
            result.stdout.trim(),
            RawRepositoryMergeCapabilitiesSchema,
            "getRepositoryMergeCapabilities",
            "GitHub CLI returned invalid repository merge settings JSON.",
          ),
        ),
        Effect.map(
          (raw): PullRequestMergeCapabilities => ({
            merge: raw.mergeCommitAllowed,
            squash: raw.squashMergeAllowed,
            rebase: raw.rebaseMergeAllowed,
            deleteBranchOnMerge: raw.deleteBranchOnMerge,
          }),
        ),
      ),
    getPullRequestDiff: (input) =>
      validateRepository(input.repository, "getPullRequestDiff").pipe(
        Effect.flatMap((repository) =>
          execute({
            cwd: input.cwd,
            args: [
              "pr",
              "diff",
              String(input.number),
              "--repo",
              repositorySelector(repository),
              "--color",
              "never",
              "--patch",
            ],
            maxBufferBytes: PULL_REQUEST_DIFF_MAX_BYTES,
            outputMode: "truncate",
          }).pipe(
            Effect.map((result) => ({
              patch: result.stdout,
              truncated: result.stdoutTruncated === true,
            })),
            // GitHub's diff media type rejects pull requests touching more than 300 files
            // (HTTP 406 "diff exceeded the maximum number of files" / "too_large"). The
            // repository is checked out locally, so recover by producing the same merge-base
            // diff with git itself.
            Effect.catch((error) =>
              PULL_REQUEST_DIFF_TOO_LARGE_PATTERN.test(error.detail)
                ? localPullRequestDiff(input.cwd, repository, input.number)
                : Effect.fail(error),
            ),
          ),
        ),
      ),
    runPullRequestAction: (input) =>
      validateRepository(input.repository, "runPullRequestAction").pipe(
        Effect.flatMap(
          (
            repository,
          ): Effect.Effect<
            { readonly mergeOutcome: "merged" | "enqueued" | null },
            GitHubCliError
          > => {
            const reference = String(input.number);
            const repoArgs = ["--repo", repositorySelector(repository)];
            if (input.action === "merge") {
              return runAsyncPullRequestMerge({
                cwd: input.cwd,
                repository,
                number: input.number,
                mergeMethod: input.mergeMethod ?? "merge",
              }).pipe(
                Effect.flatMap((result) =>
                  result.mergeOutcome !== "unavailable"
                    ? Effect.succeed({ mergeOutcome: result.mergeOutcome })
                    : execute({
                        cwd: input.cwd,
                        args: [
                          "pr",
                          "merge",
                          reference,
                          ...repoArgs,
                          `--${input.mergeMethod ?? "merge"}`,
                        ],
                      }).pipe(Effect.as({ mergeOutcome: "merged" as const })),
                ),
              );
            }
            let args: string[];
            switch (input.action) {
              case "ready":
                args = ["pr", "ready", reference, ...repoArgs];
                break;
              case "draft":
                args = ["pr", "ready", reference, ...repoArgs, "--undo"];
                break;
              case "close":
                args = ["pr", "close", reference, ...repoArgs];
                break;
              case "reopen":
                args = ["pr", "reopen", reference, ...repoArgs];
                break;
            }
            return execute({ cwd: input.cwd, args }).pipe(
              Effect.as({ mergeOutcome: null } as const),
            );
          },
        ),
      ),
    commentOnPullRequest: (input) =>
      validateRepository(input.repository, "commentOnPullRequest").pipe(
        Effect.flatMap((repository) =>
          // Body travels over stdin (--body-file -): argv is visible in process listings and
          // is echoed back inside process-runner failure messages, so it must never carry
          // user-authored content.
          execute({
            cwd: input.cwd,
            args: [
              "pr",
              "comment",
              String(input.number),
              "--repo",
              repositorySelector(repository),
              "--body-file",
              "-",
            ],
            stdin: input.body,
          }),
        ),
        Effect.asVoid,
      ),
    listOpenPullRequests: (input) =>
      listPullRequestsWithState(input, {
        state: "open",
        defaultLimit: 1,
        operation: "listOpenPullRequests",
      }),
    listPullRequests: (input) =>
      listPullRequestsWithState(input, {
        state: "all",
        defaultLimit: 20,
        operation: "listPullRequests",
      }),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "view", input.reference, "--json", PULL_REQUEST_SUMMARY_JSON_FIELDS],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestSchema,
            "getPullRequest",
            "GitHub CLI returned invalid pull request JSON.",
          ),
        ),
        Effect.map(normalizePullRequestSummary),
      ),
    getPullRequestWithChecks: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          `${PULL_REQUEST_SUMMARY_JSON_FIELDS},statusCheckRollup`,
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestWithChecksSchema,
            "getPullRequestWithChecks",
            "GitHub CLI returned invalid pull request JSON.",
          ),
        ),
        Effect.map((decoded) => ({
          summary: normalizePullRequestSummary(decoded),
          checks: normalizePullRequestChecks(decoded),
        })),
      ),
    getPullRequestReviewComments: (input) =>
      Effect.gen(function* () {
        const comments: GitPullRequestComment[] = [];
        let after: string | null = null;
        let fetchedPages = 0;
        let truncated = false;

        do {
          fetchedPages += 1;
          const args = [
            "api",
            "graphql",
            "--hostname",
            input.host,
            "-f",
            `query=${PULL_REQUEST_REVIEW_THREADS_QUERY}`,
            "-F",
            `owner=${input.owner}`,
            "-F",
            `repo=${input.repo}`,
            "-F",
            `number=${input.number}`,
            "-F",
            `first=${PULL_REQUEST_REVIEW_THREAD_PAGE_SIZE}`,
            ...(after ? ["-F", `after=${after}`] : []),
          ];

          const raw = yield* execute({ cwd: input.cwd, args }).pipe(
            Effect.map((result) => result.stdout.trim()),
          );
          const decoded = yield* decodeGitHubJson(
            raw,
            RawReviewThreadsResponseSchema,
            "getPullRequestReviewComments",
            "GitHub CLI returned invalid review threads JSON.",
          );
          const errorDetail = getGraphQlErrorDetail(decoded);
          if (errorDetail) {
            return yield* Effect.fail(
              new GitHubCliError({
                operation: "getPullRequestReviewComments",
                detail: errorDetail,
              }),
            );
          }

          const remaining = PULL_REQUEST_REVIEW_COMMENT_LIMIT - comments.length;
          const pageComments = normalizePullRequestReviewComments(decoded);
          if (pageComments.length > remaining) {
            truncated = true;
          }
          comments.push(...pageComments.slice(0, Math.max(remaining, 0)));

          const pageInfo = getPullRequestReviewThreadsPageInfo(decoded);
          const canFetchNextPage =
            pageInfo.hasNextPage &&
            pageInfo.endCursor !== null &&
            comments.length < PULL_REQUEST_REVIEW_COMMENT_LIMIT &&
            fetchedPages < PULL_REQUEST_REVIEW_THREAD_PAGE_LIMIT;
          // hasNextPage alone marks truncation: a null endCursor still means threads remain,
          // we just cannot page to them.
          if (!canFetchNextPage && pageInfo.hasNextPage) {
            truncated = true;
          }
          after = canFetchNextPage ? pageInfo.endCursor : null;
        } while (after !== null);

        return { comments, truncated };
      }),
    getRepositoryCloneUrls: (input) =>
      validateRepository(input.repository, "getRepositoryCloneUrls").pipe(
        Effect.flatMap((repository) =>
          execute({
            cwd: input.cwd,
            args: [
              "repo",
              "view",
              // Preserve gh's current-host selection for existing fork/Enterprise flows.
              // The pull-request browser methods above intentionally pin github.com.
              repository,
              "--json",
              "nameWithOwner,url,sshUrl",
            ],
          }),
        ),
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
          ...(input.draft === true ? ["--draft"] : []),
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
