import type {
  OrchestrationProject,
  PullRequestAction,
  PullRequestActionResult,
  PullRequestDetail,
  PullRequestDiffResult,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestMergeMethod,
  PullRequestProvider,
  PullRequestState,
} from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Data, Effect } from "effect";

export const PULL_REQUEST_REVIEW_MATCH_LIMIT = 1_000;

type WithoutLocalPullRequestContext<T> = T extends PullRequestListEntry
  ? Omit<T, "projectId" | "projectTitle" | "viewerReviewRequested" | "isPinned" | "projectContexts">
  : never;

/** Provider-owned remote fields. Distributing the omission over the public entry union preserves
 * each provider's discriminants without coupling the adapter contract to local project context. */
export type ProviderPullRequestSummary = WithoutLocalPullRequestContext<PullRequestListEntry>;

export type ProviderViewerInput = {
  readonly cwd: string;
  readonly forceRefresh: boolean;
};

export type ProviderListInput = {
  readonly cwd: string;
  readonly repository: RemoteRepositoryRef;
  readonly state: PullRequestState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string | null;
  readonly forceRefresh: boolean;
};

export type ProviderListResult = {
  readonly entries: ReadonlyArray<ProviderPullRequestSummary>;
  readonly truncated: boolean;
  readonly reviewingNumbers: ReadonlySet<number>;
  readonly reviewingTruncated: boolean;
};

export type ProviderExactSummaryInput = {
  readonly cwd: string;
  readonly repository: RemoteRepositoryRef;
  readonly number: number;
  readonly viewer: string | null;
  readonly matchedReviewingQuery: boolean;
  readonly forceRefresh: boolean;
};

export type ProviderExactSummaryResult =
  | { readonly _tag: "found"; readonly summary: ProviderPullRequestSummary }
  | { readonly _tag: "not-found" };

export type ProviderReviewRequestsInput = {
  readonly cwd: string;
  readonly repository: RemoteRepositoryRef;
  readonly viewer: string | null;
  readonly forceRefresh: boolean;
};

export type ProviderReviewRequestsResult = {
  readonly numbers: ReadonlySet<number>;
  readonly incomplete: boolean;
};

export type ProviderReviewRequestCountResult = {
  readonly count: number;
  readonly incomplete: boolean;
};

export type ProviderPullRequestInput = {
  readonly project: OrchestrationProject;
  readonly repository: RemoteRepositoryRef;
  readonly number: number;
};

export type ProviderActionInput = ProviderPullRequestInput & {
  readonly action: PullRequestAction;
  readonly mergeMethod?: PullRequestMergeMethod;
};

export type ProviderCommentInput = ProviderPullRequestInput & {
  readonly body: string;
};

export type PullRequestProviderErrorReason =
  | "not-installed"
  | "not-authenticated"
  | "not-found"
  | "not-connected"
  | "authorizing"
  | "reconnect-required"
  | "incompatible"
  | "temporarily-unavailable"
  | "invalid-response"
  | "other";

export class PullRequestProviderError extends Data.TaggedError("PullRequestProviderError")<{
  readonly provider: PullRequestProvider;
  readonly host: string;
  readonly operation: string;
  readonly repository: string | null;
  readonly scope: "global" | "repository";
  readonly reason: PullRequestProviderErrorReason;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PullRequestProviderSelectionError extends Data.TaggedError(
  "PullRequestProviderSelectionError",
)<{
  readonly provider: PullRequestProvider;
  readonly host: string;
  readonly matches: number;
}> {
  override get message(): string {
    return this.matches === 0
      ? `No pull request provider is registered for ${this.provider}:${this.host}.`
      : `Multiple pull request providers are registered for ${this.provider}:${this.host}.`;
  }
}

export interface PullRequestProviderShape {
  readonly provider: PullRequestProvider;
  readonly host: string;
  readonly supports: (repository: RemoteRepositoryRef) => boolean;
  readonly viewer?: (input: ProviderViewerInput) => Effect.Effect<string, PullRequestProviderError>;
  readonly list: (
    input: ProviderListInput,
  ) => Effect.Effect<ProviderListResult, PullRequestProviderError>;
  readonly exactSummary: (
    input: ProviderExactSummaryInput,
  ) => Effect.Effect<ProviderExactSummaryResult, PullRequestProviderError>;
  readonly reviewRequests?: (
    input: ProviderReviewRequestsInput,
  ) => Effect.Effect<ProviderReviewRequestsResult, PullRequestProviderError>;
  readonly reviewRequestCount?: (
    input: ProviderReviewRequestsInput,
  ) => Effect.Effect<ProviderReviewRequestCountResult, PullRequestProviderError>;
  readonly detail: (
    input: ProviderPullRequestInput,
  ) => Effect.Effect<PullRequestDetail, PullRequestProviderError>;
  readonly diff: (
    input: ProviderPullRequestInput,
  ) => Effect.Effect<PullRequestDiffResult, PullRequestProviderError>;
  readonly action?: (
    input: ProviderActionInput,
  ) => Effect.Effect<PullRequestActionResult, PullRequestProviderError | Error>;
  readonly comment?: (
    input: ProviderCommentInput,
  ) => Effect.Effect<PullRequestActionResult, PullRequestProviderError>;
}

export interface PullRequestProviderRegistryShape {
  readonly select: (
    repository: RemoteRepositoryRef,
  ) => Effect.Effect<PullRequestProviderShape, PullRequestProviderSelectionError>;
}

const canonicalHost = (host: string): string => host.trim().toLowerCase();

export function makePullRequestProviderRegistry(
  providers: ReadonlyArray<PullRequestProviderShape>,
): PullRequestProviderRegistryShape {
  return {
    select: (repository) =>
      Effect.gen(function* () {
        const host = canonicalHost(repository.host);
        const matches = providers.filter(
          (candidate) =>
            candidate.provider === repository.provider && canonicalHost(candidate.host) === host,
        );
        if (matches.length !== 1) {
          return yield* Effect.fail(
            new PullRequestProviderSelectionError({
              provider: repository.provider,
              host,
              matches: matches.length,
            }),
          );
        }
        const provider = matches[0]!;
        if (!provider.supports(repository)) {
          return yield* Effect.fail(
            new PullRequestProviderSelectionError({
              provider: repository.provider,
              host,
              matches: 0,
            }),
          );
        }
        return provider;
      }),
  };
}

export function isGlobalPullRequestProviderError(error: unknown): boolean {
  return error instanceof PullRequestProviderError && error.scope === "global";
}
