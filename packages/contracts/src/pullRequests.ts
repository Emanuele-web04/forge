import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { GitPullRequestMergeability } from "./git";

export const PullRequestInvolvement = Schema.Literals(["all", "reviewing", "authored"]);
export type PullRequestInvolvement = typeof PullRequestInvolvement.Type;

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestProvider = Schema.Literals(["github", "bitbucket"]);
export type PullRequestProvider = typeof PullRequestProvider.Type;

export const PullRequestViewerInvolvement = Schema.Literals([
  "author",
  "review-requested",
  "none",
  "unknown",
]);
export type PullRequestViewerInvolvement = typeof PullRequestViewerInvolvement.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const PullRequestAction = Schema.Literals(["merge", "ready", "draft", "close", "reopen"]);
export type PullRequestAction = typeof PullRequestAction.Type;

export const PullRequestActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type PullRequestActor = typeof PullRequestActor.Type;

export const PullRequestLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type PullRequestLabel = typeof PullRequestLabel.Type;

export const PullRequestCheckStatus = Schema.Literals([
  "pending",
  "success",
  "failure",
  "skipped",
  "neutral",
  "cancelled",
]);
export type PullRequestCheckStatus = typeof PullRequestCheckStatus.Type;

export const PullRequestCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: PullRequestCheckStatus,
  description: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

export const PullRequestCommentKind = Schema.Literals([
  "issue-comment",
  "review-comment",
  "review",
]);
export type PullRequestCommentKind = typeof PullRequestCommentKind.Type;

export const PullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PullRequestCommentKind,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
});
export type PullRequestComment = typeof PullRequestComment.Type;

export const PullRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  messageBody: Schema.String,
  committedDate: IsoDateTime,
  authors: Schema.Array(PullRequestActor),
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

export const PullRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
  deleteBranchOnMerge: Schema.Boolean,
});
export type PullRequestMergeCapabilities = typeof PullRequestMergeCapabilities.Type;

export const PullRequestCapabilities = Schema.Struct({
  detail: Schema.Boolean,
  diff: Schema.Boolean,
  comments: Schema.Boolean,
  checks: Schema.Boolean,
  comment: Schema.Boolean,
  resolveComment: Schema.Boolean,
  stateMutation: Schema.Boolean,
  merge: Schema.Boolean,
});
export type PullRequestCapabilities = typeof PullRequestCapabilities.Type;

const BitbucketReadOnlyPullRequestCapabilities = Schema.Struct({
  detail: Schema.Literal(true),
  diff: Schema.Literal(true),
  comments: Schema.Literal(true),
  checks: Schema.Literal(false),
  comment: Schema.Literal(false),
  resolveComment: Schema.Literal(false),
  stateMutation: Schema.Literal(false),
  merge: Schema.Literal(false),
});

export const LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
  detail: true,
  diff: true,
  comments: true,
  checks: true,
  comment: true,
  resolveComment: true,
  stateMutation: true,
  merge: true,
};

export const READ_ONLY_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
  detail: true,
  diff: true,
  comments: true,
  checks: false,
  comment: false,
  resolveComment: false,
  stateMutation: false,
  merge: false,
};

export const PullRequestStackEntry = Schema.Struct({
  position: PositiveInt,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: GitPullRequestMergeability,
  mergeStateStatus: Schema.NullOr(Schema.String),
});
export type PullRequestStackEntry = typeof PullRequestStackEntry.Type;

/**
 * GitHub orders stack entries from the ultimate base branch upwards. `position` is the selected
 * pull request's one-based position, so merging that PR affects entries `1...position` atomically.
 */
export const PullRequestStack = Schema.Struct({
  number: PositiveInt,
  size: PositiveInt,
  position: PositiveInt,
  baseBranch: TrimmedNonEmptyString,
  entries: Schema.Array(PullRequestStackEntry),
});
export type PullRequestStack = typeof PullRequestStack.Type;

/** Compact stack identity used by list rows; full entries stay detail-only. */
export const PullRequestStackSummary = Schema.Struct({
  number: PositiveInt,
  size: PositiveInt,
  position: PositiveInt,
  baseBranch: TrimmedNonEmptyString,
});
export type PullRequestStackSummary = typeof PullRequestStackSummary.Type;

export const PullRequestProjectContext = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  isPinned: Schema.Boolean,
});
export type PullRequestProjectContext = typeof PullRequestProjectContext.Type;

const LegacyGitHubProvider = Schema.optional(Schema.Literal("github")).pipe(
  Schema.withDecodingDefault(() => "github" as const),
);

const PullRequestProviderWithLegacyDefault = Schema.optional(PullRequestProvider).pipe(
  Schema.withDecodingDefault(() => "github" as const),
);

const LegacyGitHubCapabilities = Schema.optional(PullRequestCapabilities).pipe(
  Schema.withDecodingDefault(() => LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES),
);

const LegacyViewerInvolvement = Schema.optional(PullRequestViewerInvolvement).pipe(
  Schema.withDecodingDefault(() => "none" as const),
);

const PullRequestListEntryBaseFields = {
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  reviewDecision: Schema.NullOr(Schema.String),
  viewerReviewRequested: Schema.Boolean,
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  // A repository-level row can belong to several local projects/worktrees. The fallback keeps a
  // newer client compatible with a server that still sends one project-local row at a time.
  projectContexts: Schema.optional(Schema.Array(PullRequestProjectContext)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  // Stack support is additive and the server may briefly be on an older build during restarts.
  stack: Schema.optional(Schema.NullOr(PullRequestStackSummary)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  labels: Schema.Array(PullRequestLabel),
} as const;

const GitHubPullRequestListEntry = Schema.Struct({
  ...PullRequestListEntryBaseFields,
  provider: LegacyGitHubProvider,
  capabilities: LegacyGitHubCapabilities,
  viewerInvolvement: LegacyViewerInvolvement,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  mergeability: Schema.optional(GitPullRequestMergeability).pipe(
    Schema.withDecodingDefault(() => "unknown" as const),
  ),
});

const BitbucketPullRequestListEntry = Schema.Struct({
  ...PullRequestListEntryBaseFields,
  provider: Schema.Literal("bitbucket"),
  capabilities: BitbucketReadOnlyPullRequestCapabilities,
  viewerInvolvement: PullRequestViewerInvolvement,
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
  mergeability: Schema.NullOr(GitPullRequestMergeability),
});

export const PullRequestListEntry = Schema.Union([
  BitbucketPullRequestListEntry,
  GitHubPullRequestListEntry,
]);
export type PullRequestListEntry = typeof PullRequestListEntry.Type;

export const PullRequestsListInput = Schema.Struct({
  involvement: Schema.optional(PullRequestInvolvement),
  state: PullRequestState,
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type PullRequestsListInput = typeof PullRequestsListInput.Type;

const PullRequestsLocalInventoryError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  provider: Schema.optional(Schema.Null).pipe(Schema.withDecodingDefault(() => null)),
  repository: Schema.optional(Schema.Null).pipe(Schema.withDecodingDefault(() => null)),
  message: TrimmedNonEmptyString,
});

const PullRequestsProviderError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  provider: PullRequestProvider,
  repository: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});

export const PullRequestsListError = Schema.Union([
  PullRequestsLocalInventoryError,
  PullRequestsProviderError,
]);

export const PullRequestsListRepositoryBatch = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  provider: PullRequestProviderWithLegacyDefault,
  repository: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type PullRequestsListRepositoryBatch = typeof PullRequestsListRepositoryBatch.Type;

export const PullRequestProviderRequirementStatus = Schema.Literals([
  "not-connected",
  "authorizing",
  "reconnect-required",
  "incompatible",
  "temporarily-unavailable",
]);
export type PullRequestProviderRequirementStatus = typeof PullRequestProviderRequirementStatus.Type;

export const PullRequestProviderRequirement = Schema.Struct({
  provider: PullRequestProvider,
  presetId: TrimmedNonEmptyString,
  status: PullRequestProviderRequirementStatus,
});
export type PullRequestProviderRequirement = typeof PullRequestProviderRequirement.Type;

export const PullRequestsListResult = Schema.Struct({
  viewer: Schema.NullOr(TrimmedNonEmptyString),
  entries: Schema.Array(PullRequestListEntry),
  errors: Schema.Array(PullRequestsListError),
  repositoryBatches: Schema.Array(PullRequestsListRepositoryBatch),
  providerRequirements: Schema.optional(Schema.Array(PullRequestProviderRequirement)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
});
export type PullRequestsListResult = typeof PullRequestsListResult.Type;

export const PullRequestReviewRequestCountInput = Schema.Struct({
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type PullRequestReviewRequestCountInput = typeof PullRequestReviewRequestCountInput.Type;

export const PullRequestReviewRequestCountResult = Schema.Struct({
  count: NonNegativeInt,
  /** True means at least one repository could not be counted or reached the search cap. */
  incomplete: Schema.Boolean,
});
export type PullRequestReviewRequestCountResult = typeof PullRequestReviewRequestCountResult.Type;

export const PullRequestDetailInput = Schema.Struct({
  projectId: ProjectId,
  provider: PullRequestProviderWithLegacyDefault,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestDetailInput = typeof PullRequestDetailInput.Type;

const PullRequestDetailBaseFields = {
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.String),
  mergeStateStatus: Schema.NullOr(Schema.String),
  reviewDecision: Schema.NullOr(Schema.String),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  maintainerCanModify: Schema.Boolean,
  reviewers: Schema.Array(PullRequestActor),
  labels: Schema.Array(PullRequestLabel),
  comments: Schema.Array(PullRequestComment),
  commentsTruncated: Schema.Boolean,
  commentsIncomplete: Schema.Boolean,
  commits: Schema.Array(PullRequestCommit),
  mergeCapabilities: PullRequestMergeCapabilities,
  // A missing field is a standalone PR or a brief older-server/newer-client version skew.
  stack: Schema.optional(Schema.NullOr(PullRequestStack)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  // Stack lookup is optional for rendering detail, but merge UX must distinguish an unavailable
  // lookup from a confirmed standalone pull request.
  stackMetadataIncomplete: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
} as const;

const GitHubPullRequestDetail = Schema.Struct({
  ...PullRequestDetailBaseFields,
  provider: LegacyGitHubProvider,
  capabilities: LegacyGitHubCapabilities,
  // Decoding default keeps a newer client compatible with an older server that predates
  // the field (brief version skew during dev restarts must not reject whole payloads).
  mergeability: Schema.optional(GitPullRequestMergeability).pipe(
    Schema.withDecodingDefault(() => "unknown" as const),
  ),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  checks: Schema.Array(PullRequestCheck),
});

const BitbucketPullRequestDetail = Schema.Struct({
  ...PullRequestDetailBaseFields,
  provider: Schema.Literal("bitbucket"),
  capabilities: BitbucketReadOnlyPullRequestCapabilities,
  mergeability: Schema.NullOr(GitPullRequestMergeability),
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
  changedFiles: Schema.NullOr(NonNegativeInt),
  checks: Schema.NullOr(Schema.Array(PullRequestCheck)),
});

export const PullRequestDetail = Schema.Union([
  BitbucketPullRequestDetail,
  GitHubPullRequestDetail,
]);
export type PullRequestDetail = typeof PullRequestDetail.Type;

export const PullRequestDiffResult = Schema.Struct({
  patch: Schema.String,
  truncated: Schema.Boolean,
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

export const PullRequestActionInput = Schema.Struct({
  projectId: ProjectId,
  provider: PullRequestProviderWithLegacyDefault,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  action: PullRequestAction,
  mergeMethod: Schema.optional(PullRequestMergeMethod),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

export const PullRequestCommentInput = Schema.Struct({
  projectId: ProjectId,
  provider: PullRequestProviderWithLegacyDefault,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  // GitHub rejects comment bodies past 65536 characters; enforcing it here keeps oversized
  // payloads off the wire and out of subprocess plumbing entirely.
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

export const PullRequestSetPinnedInput = Schema.Struct({
  projectId: ProjectId,
  provider: PullRequestProviderWithLegacyDefault,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  isPinned: Schema.Boolean,
});
export type PullRequestSetPinnedInput = typeof PullRequestSetPinnedInput.Type;

export const PullRequestSetPinnedResult = Schema.Struct({
  projectId: ProjectId,
  provider: PullRequestProviderWithLegacyDefault,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  isPinned: Schema.Boolean,
});
export type PullRequestSetPinnedResult = typeof PullRequestSetPinnedResult.Type;

// Actions acknowledge the mutation independently from the follow-up detail refetch. This keeps
// a successful GitHub mutation from being reported as failed when a later read is unavailable.
export const PullRequestActionResult = Schema.Struct({
  projectId: ProjectId,
  provider: PullRequestProviderWithLegacyDefault,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  workspaceRoot: TrimmedNonEmptyString,
  // Async merges may finish immediately or be handed to GitHub's merge queue. Older servers and
  // non-merge actions omit the field, which decodes as null for rolling dev restarts.
  mergeOutcome: Schema.optional(Schema.NullOr(Schema.Literals(["merged", "enqueued"]))).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type PullRequestActionResult = typeof PullRequestActionResult.Type;

export class PullRequestsUnavailableError extends Schema.TaggedErrorClass<PullRequestsUnavailableError>()(
  "PullRequestsUnavailableError",
  {
    reason: Schema.Literals(["gh-not-installed", "gh-not-authenticated"]),
    message: TrimmedNonEmptyString,
  },
) {}
