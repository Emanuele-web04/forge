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

export const PullRequestReviewSide = Schema.Literals(["LEFT", "RIGHT"]);
export type PullRequestReviewSide = typeof PullRequestReviewSide.Type;

export const PullRequestReviewEvent = Schema.Literals(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
export type PullRequestReviewEvent = typeof PullRequestReviewEvent.Type;

export const PullRequestReviewDraft = Schema.Struct({
  id: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  headSha: TrimmedNonEmptyString,
  patchSignature: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  line: PositiveInt,
  side: PullRequestReviewSide,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PullRequestReviewDraft = typeof PullRequestReviewDraft.Type;

export const PullRequestReviewThreadComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(Schema.String),
});
export type PullRequestReviewThreadComment = typeof PullRequestReviewThreadComment.Type;

export const PullRequestReviewThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  line: PositiveInt,
  side: PullRequestReviewSide,
  isResolved: Schema.Boolean,
  comments: Schema.Array(PullRequestReviewThreadComment),
});
export type PullRequestReviewThread = typeof PullRequestReviewThread.Type;

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

export const PullRequestProjectContext = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  isPinned: Schema.Boolean,
});
export type PullRequestProjectContext = typeof PullRequestProjectContext.Type;

export const PullRequestListEntry = Schema.Struct({
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
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
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
  // Decoding default keeps a newer client compatible with an older server that predates
  // the field (brief version skew during dev restarts must not reject whole payloads).
  mergeability: Schema.optional(GitPullRequestMergeability).pipe(
    Schema.withDecodingDefault(() => "unknown"),
  ),
  labels: Schema.Array(PullRequestLabel),
});
export type PullRequestListEntry = typeof PullRequestListEntry.Type;

export const PullRequestsListInput = Schema.Struct({
  involvement: Schema.optional(PullRequestInvolvement),
  state: PullRequestState,
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type PullRequestsListInput = typeof PullRequestsListInput.Type;

export const PullRequestsListError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});

export const PullRequestsListRepositoryBatch = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type PullRequestsListRepositoryBatch = typeof PullRequestsListRepositoryBatch.Type;

export const PullRequestsListResult = Schema.Struct({
  viewer: Schema.NullOr(TrimmedNonEmptyString),
  entries: Schema.Array(PullRequestListEntry),
  errors: Schema.Array(PullRequestsListError),
  repositoryBatches: Schema.Array(PullRequestsListRepositoryBatch),
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
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestDetailInput = typeof PullRequestDetailInput.Type;

export const PullRequestDetail = Schema.Struct({
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
  // Decoding default keeps a newer client compatible with an older server that predates
  // the field (brief version skew during dev restarts must not reject whole payloads).
  mergeability: Schema.optional(GitPullRequestMergeability).pipe(
    Schema.withDecodingDefault(() => "unknown"),
  ),
  mergeStateStatus: Schema.NullOr(Schema.String),
  reviewDecision: Schema.NullOr(Schema.String),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  maintainerCanModify: Schema.Boolean,
  reviewers: Schema.Array(PullRequestActor),
  labels: Schema.Array(PullRequestLabel),
  checks: Schema.Array(PullRequestCheck),
  comments: Schema.Array(PullRequestComment),
  commentsTruncated: Schema.Boolean,
  commentsIncomplete: Schema.Boolean,
  reviewThreads: Schema.optional(Schema.Array(PullRequestReviewThread)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  commits: Schema.Array(PullRequestCommit),
  mergeCapabilities: PullRequestMergeCapabilities,
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

export const PullRequestDiffResult = Schema.Struct({
  patch: Schema.String,
  truncated: Schema.Boolean,
  headSha: Schema.optional(Schema.String).pipe(Schema.withDecodingDefault(() => "")),
  patchSignature: Schema.optional(Schema.String).pipe(Schema.withDecodingDefault(() => "")),
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

export const PullRequestActionInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  action: PullRequestAction,
  mergeMethod: Schema.optional(PullRequestMergeMethod),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

export const PullRequestCommentInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  // GitHub rejects comment bodies past 65536 characters; enforcing it here keeps oversized
  // payloads off the wire and out of subprocess plumbing entirely.
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

export const PullRequestReviewDraftListInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestReviewDraftListInput = typeof PullRequestReviewDraftListInput.Type;

export const PullRequestReviewDraftListResult = Schema.Struct({
  drafts: Schema.Array(PullRequestReviewDraft),
});
export type PullRequestReviewDraftListResult = typeof PullRequestReviewDraftListResult.Type;

export const PullRequestReviewDraftCreateInput = Schema.Struct({
  ...PullRequestReviewDraftListInput.fields,
  headSha: TrimmedNonEmptyString,
  patchSignature: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  line: PositiveInt,
  side: PullRequestReviewSide,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
});
export type PullRequestReviewDraftCreateInput = typeof PullRequestReviewDraftCreateInput.Type;

export const PullRequestReviewDraftUpdateInput = Schema.Struct({
  ...PullRequestReviewDraftListInput.fields,
  id: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
});
export type PullRequestReviewDraftUpdateInput = typeof PullRequestReviewDraftUpdateInput.Type;

export const PullRequestReviewDraftDeleteInput = Schema.Struct({
  ...PullRequestReviewDraftListInput.fields,
  id: TrimmedNonEmptyString,
});
export type PullRequestReviewDraftDeleteInput = typeof PullRequestReviewDraftDeleteInput.Type;

export const PullRequestReviewDraftResult = Schema.Struct({
  draft: PullRequestReviewDraft,
});
export type PullRequestReviewDraftResult = typeof PullRequestReviewDraftResult.Type;

export const PullRequestReviewDraftDeleteResult = Schema.Struct({
  deletedId: TrimmedNonEmptyString,
});
export type PullRequestReviewDraftDeleteResult = typeof PullRequestReviewDraftDeleteResult.Type;

export const PullRequestReviewSubmitInput = Schema.Struct({
  ...PullRequestReviewDraftListInput.fields,
  event: PullRequestReviewEvent,
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))).pipe(
    Schema.withDecodingDefault(() => ""),
  ),
  draftIds: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(500)),
  ).pipe(Schema.withDecodingDefault(() => [])),
});
export type PullRequestReviewSubmitInput = typeof PullRequestReviewSubmitInput.Type;

export const PullRequestReviewSubmitResult = Schema.Struct({
  status: Schema.Literals(["submitted", "blocked"]),
  submittedDraftIds: Schema.Array(TrimmedNonEmptyString),
  staleDraftIds: Schema.Array(TrimmedNonEmptyString),
  invalidDraftIds: Schema.Array(TrimmedNonEmptyString),
});
export type PullRequestReviewSubmitResult = typeof PullRequestReviewSubmitResult.Type;

export const PullRequestSetPinnedInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  isPinned: Schema.Boolean,
});
export type PullRequestSetPinnedInput = typeof PullRequestSetPinnedInput.Type;

export const PullRequestSetPinnedResult = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  isPinned: Schema.Boolean,
});
export type PullRequestSetPinnedResult = typeof PullRequestSetPinnedResult.Type;

// Actions acknowledge the mutation independently from the follow-up detail refetch. This keeps
// a successful GitHub mutation from being reported as failed when a later read is unavailable.
export const PullRequestActionResult = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  workspaceRoot: TrimmedNonEmptyString,
});
export type PullRequestActionResult = typeof PullRequestActionResult.Type;

export class PullRequestsUnavailableError extends Schema.TaggedErrorClass<PullRequestsUnavailableError>()(
  "PullRequestsUnavailableError",
  {
    reason: Schema.Literals(["gh-not-installed", "gh-not-authenticated"]),
    message: TrimmedNonEmptyString,
  },
) {}
