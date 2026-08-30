import type {
  PullRequestActionInput,
  PullRequestActionResult,
  PullRequestCommentInput,
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestDiffResult,
  PullRequestReviewRequestCountInput,
  PullRequestReviewRequestCountResult,
  PullRequestSetPinnedInput,
  PullRequestSetPinnedResult,
  PullRequestsListInput,
  PullRequestsListResult,
  WorkItemSearchInput,
  WorkItemSearchResult,
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
  readonly setPinned: (
    input: PullRequestSetPinnedInput,
  ) => Effect.Effect<PullRequestSetPinnedResult, unknown>;
  /**
   * Search the project's GitHub repository for open issues and pull requests.
   */
  readonly searchWorkItems: (
    input: WorkItemSearchInput & { repository: string },
  ) => Effect.Effect<WorkItemSearchResult, unknown>;
}

export class PullRequestService extends ServiceMap.Service<
  PullRequestService,
  PullRequestServiceShape
>()("synara/pullRequests/Services/PullRequestService/PullRequestService") {}
