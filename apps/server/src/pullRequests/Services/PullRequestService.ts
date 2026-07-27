import type {
  PullRequestActionInput,
  PullRequestActionResult,
  PullRequestCommentInput,
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestDiffResult,
  PullRequestReviewRequestCountInput,
  PullRequestReviewRequestCountResult,
  PullRequestReviewDraftCreateInput,
  PullRequestReviewDraftDeleteInput,
  PullRequestReviewDraftDeleteResult,
  PullRequestReviewDraftListInput,
  PullRequestReviewDraftListResult,
  PullRequestReviewDraftResult,
  PullRequestReviewDraftUpdateInput,
  PullRequestReviewSubmitInput,
  PullRequestReviewSubmitResult,
  PullRequestSetPinnedInput,
  PullRequestSetPinnedResult,
  PullRequestsListInput,
  PullRequestsListResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface PullRequestServiceShape {
  readonly list: (input: PullRequestsListInput) => Effect.Effect<PullRequestsListResult, unknown>;
  readonly reviewRequestCount: (
    input: PullRequestReviewRequestCountInput,
  ) => Effect.Effect<PullRequestReviewRequestCountResult, unknown>;
  readonly detail: (input: PullRequestDetailInput) => Effect.Effect<PullRequestDetail, unknown>;
  readonly diff: (input: PullRequestDetailInput) => Effect.Effect<PullRequestDiffResult, unknown>;
  readonly action: (
    input: PullRequestActionInput,
  ) => Effect.Effect<PullRequestActionResult, unknown>;
  readonly comment: (
    input: PullRequestCommentInput,
  ) => Effect.Effect<PullRequestActionResult, unknown>;
  readonly listReviewDrafts: (
    input: PullRequestReviewDraftListInput,
  ) => Effect.Effect<PullRequestReviewDraftListResult, unknown>;
  readonly createReviewDraft: (
    input: PullRequestReviewDraftCreateInput,
  ) => Effect.Effect<PullRequestReviewDraftResult, unknown>;
  readonly updateReviewDraft: (
    input: PullRequestReviewDraftUpdateInput,
  ) => Effect.Effect<PullRequestReviewDraftResult, unknown>;
  readonly deleteReviewDraft: (
    input: PullRequestReviewDraftDeleteInput,
  ) => Effect.Effect<PullRequestReviewDraftDeleteResult, unknown>;
  readonly submitReview: (
    input: PullRequestReviewSubmitInput,
  ) => Effect.Effect<PullRequestReviewSubmitResult, unknown>;
  readonly setPinned: (
    input: PullRequestSetPinnedInput,
  ) => Effect.Effect<PullRequestSetPinnedResult, unknown>;
}

export class PullRequestService extends ServiceMap.Service<
  PullRequestService,
  PullRequestServiceShape
>()("synara/pullRequests/Services/PullRequestService/PullRequestService") {}
