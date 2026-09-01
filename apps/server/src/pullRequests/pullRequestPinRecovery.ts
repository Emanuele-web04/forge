import type {
  OrchestrationProject,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestState,
  PullRequestsListResult,
} from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect } from "effect";

import {
  PROJECT_PULL_REQUEST_PIN_LIMIT,
  type ProjectPullRequestPin,
  type ProjectPullRequestPinsShape,
} from "../persistence/Services/ProjectPullRequestPins";
import {
  buildPullRequestListEntry,
  projectPullRequestIdentityKey,
  pullRequestMatchesInvolvement,
  repositoryPullRequestIdentityKey,
  selectRecoverablePullRequestPins,
} from "../pullRequests.logic";
import type {
  ProviderExactSummaryResult,
  ProviderReviewRequestsResult,
  PullRequestProviderError,
  PullRequestProviderShape,
} from "./Services/PullRequestProvider";
import { PULL_REQUEST_REVIEW_MATCH_LIMIT } from "./Services/PullRequestProvider";
import { pullRequestPinRepositoryKey } from "./projectRepositoryInventory";

export const PULL_REQUEST_PIN_RECOVERY_LIMIT = PROJECT_PULL_REQUEST_PIN_LIMIT + 4;
export { PULL_REQUEST_REVIEW_MATCH_LIMIT };

export type PullRequestPinRecoveryContext = {
  readonly cwd: string;
  readonly repository: RemoteRepositoryRef;
  readonly adapter: PullRequestProviderShape;
  readonly viewer: string | null;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly truncated: boolean;
  readonly reviewingNumbers: ReadonlySet<number>;
  readonly reviewingTruncated: boolean;
};

type PullRequestListError = PullRequestsListResult["errors"][number];

function recoveryKey(provider: "github" | "bitbucket", repository: string): string {
  return pullRequestPinRepositoryKey(provider, repository);
}

export function recoverPinnedPullRequests(input: {
  state: PullRequestState;
  involvement: PullRequestInvolvement;
  forceRefresh: boolean;
  pins: ReadonlyArray<ProjectPullRequestPin>;
  pinStore: ProjectPullRequestPinsShape;
  batchEntries: ReadonlyArray<PullRequestListEntry>;
  recoveryContexts: ReadonlyArray<PullRequestPinRecoveryContext>;
  repositoryKeysByProject: ReadonlyMap<ProjectId, Set<string>>;
  projectById: ReadonlyMap<ProjectId, OrchestrationProject>;
  isGlobalError: (error: unknown) => boolean;
  isRequirementError?: (error: unknown) => boolean;
}) {
  return Effect.gen(function* () {
    const errors = new Map<string, PullRequestListError>();
    const addError = (
      project: OrchestrationProject,
      repository: RemoteRepositoryRef,
      message: string,
    ) => {
      errors.set(`${project.id}\u0000${repository.identityKey}\u0000${message}`, {
        projectId: project.id,
        projectTitle: project.title,
        provider: repository.provider,
        repository: repository.displayName,
        message,
      });
    };
    if (input.pins.length === 0) {
      return { entries: [] as PullRequestListEntry[], errors: [] as PullRequestListError[] };
    }

    const recoveryByRepository = new Map(
      input.recoveryContexts.map((context) => [
        recoveryKey(context.repository.provider, context.repository.displayName),
        context,
      ]),
    );
    const presentKeys = new Set(
      input.batchEntries.map((entry) =>
        projectPullRequestIdentityKey({
          projectId: entry.projectId,
          provider: entry.provider,
          repository: entry.repository,
          number: entry.number,
        }),
      ),
    );
    const allMissingPins = selectRecoverablePullRequestPins({
      pins: input.pins,
      presentKeys,
      repositoryKeysByProject: input.repositoryKeysByProject,
      batches: input.recoveryContexts.map((context) => ({
        provider: context.repository.provider,
        repository: context.repository.displayName,
        truncated: context.truncated,
        projectIds: context.projects.map((project) => project.id),
      })),
    });

    const pinsByLookup = new Map<string, typeof allMissingPins>();
    for (const row of allMissingPins) {
      const recovery = recoveryByRepository.get(recoveryKey(row.provider, row.repositoryKey));
      if (!recovery) continue;
      const lookupKey = repositoryPullRequestIdentityKey({
        provider: recovery.repository.provider,
        repository: recovery.repository.displayName,
        number: row.number,
      });
      const rows = pinsByLookup.get(lookupKey) ?? [];
      rows.push(row);
      pinsByLookup.set(lookupKey, rows);
    }
    const lookupGroups = [...pinsByLookup.values()];
    const missingPins = lookupGroups.slice(0, PULL_REQUEST_PIN_RECOVERY_LIMIT).flat();
    for (const row of lookupGroups.slice(PULL_REQUEST_PIN_RECOVERY_LIMIT).flat()) {
      const project = input.projectById.get(row.projectId);
      const recovery = recoveryByRepository.get(recoveryKey(row.provider, row.repositoryKey));
      if (project && recovery) {
        addError(
          project,
          recovery.repository,
          `Pinned pull request recovery was limited to ${PULL_REQUEST_PIN_RECOVERY_LIMIT} items. ` +
            "Open this project directly to recover the remaining pins.",
        );
      }
    }

    const reviewMatchInputs = new Map<string, PullRequestPinRecoveryContext>();
    for (const row of missingPins) {
      const key = recoveryKey(row.provider, row.repositoryKey);
      const recovery = recoveryByRepository.get(key);
      if (
        !recovery ||
        input.state !== "open" ||
        (input.involvement !== "reviewing" &&
          !(input.involvement === "all" && recovery.reviewingTruncated))
      ) {
        continue;
      }
      reviewMatchInputs.set(key, recovery);
    }
    const reviewMatches = new Map<
      string,
      ProviderReviewRequestsResult & { error: PullRequestProviderError | null }
    >(
      yield* Effect.forEach(
        reviewMatchInputs,
        ([key, recovery]) => {
          const reviewRequests = recovery.adapter.reviewRequests;
          if (!reviewRequests) {
            return Effect.succeed([
              key,
              { numbers: new Set<number>(), incomplete: true, error: null },
            ] as const);
          }
          return reviewRequests({
            cwd: recovery.cwd,
            repository: recovery.repository,
            viewer: recovery.viewer,
            forceRefresh: input.forceRefresh,
          }).pipe(
            Effect.map((matches) => [key, { ...matches, error: null }] as const),
            Effect.catch((error) =>
              input.isRequirementError?.(error)
                ? Effect.succeed([
                    key,
                    { numbers: new Set<number>(), incomplete: false, error: null },
                  ] as const)
                : input.isGlobalError(error)
                ? Effect.fail(error)
                : Effect.succeed([
                    key,
                    { numbers: new Set<number>(), incomplete: false, error },
                  ] as const),
            ),
          );
        },
        { concurrency: 3 },
      ),
    );
    for (const [key, result] of reviewMatches) {
      if (!result.error && !result.incomplete) continue;
      const recovery = recoveryByRepository.get(key);
      if (!recovery) continue;
      const affectedProjectIds = new Set(
        missingPins
          .filter((row) => recoveryKey(row.provider, row.repositoryKey) === key)
          .map((row) => row.projectId),
      );
      for (const projectId of affectedProjectIds) {
        const project = input.projectById.get(projectId);
        if (project) {
          addError(
            project,
            recovery.repository,
            result.error
              ? `Review-requested pin recovery failed for ${recovery.repository.displayName}: ${result.error.message}`
              : `Review-requested pin recovery for ${recovery.repository.displayName} reached ` +
                  "the provider search limit of " +
                  `${PULL_REQUEST_REVIEW_MATCH_LIMIT.toLocaleString("en-US")} items and may be incomplete.`,
          );
        }
      }
    }

    const lookupInputs = new Map<
      string,
      {
        context: PullRequestPinRecoveryContext;
        cwd: string;
        number: number;
        matchedReviewingQuery: boolean;
      }
    >();
    for (const row of missingPins) {
      const key = recoveryKey(row.provider, row.repositoryKey);
      const recovery = recoveryByRepository.get(key);
      const project = input.projectById.get(row.projectId);
      if (!recovery || !project) continue;
      const lookupKey = repositoryPullRequestIdentityKey({
        provider: recovery.repository.provider,
        repository: recovery.repository.displayName,
        number: row.number,
      });
      lookupInputs.set(lookupKey, {
        context: recovery,
        cwd: project.workspaceRoot,
        number: row.number,
        matchedReviewingQuery:
          recovery.reviewingNumbers.has(row.number) ||
          reviewMatches.get(key)?.numbers.has(row.number) === true,
      });
    }
    const recoveredByLookup = new Map<
      string,
      { result: ProviderExactSummaryResult | null; error: PullRequestProviderError | null }
    >(
      yield* Effect.forEach(
        lookupInputs,
        ([key, lookup]) =>
          lookup.context.adapter
            .exactSummary({
              cwd: lookup.cwd,
              repository: lookup.context.repository,
              number: lookup.number,
              viewer: lookup.context.viewer,
              matchedReviewingQuery: lookup.matchedReviewingQuery,
              forceRefresh: input.forceRefresh,
            })
            .pipe(
              Effect.map((result) => [key, { result, error: null }] as const),
              Effect.catch((error) =>
                input.isRequirementError?.(error)
                  ? Effect.succeed([key, { result: null, error: null }] as const)
                  : input.isGlobalError(error)
                  ? Effect.fail(error)
                  : Effect.succeed([key, { result: null, error }] as const),
              ),
            ),
        { concurrency: 3 },
      ),
    );

    const definitivelyMissingPins = missingPins.filter((row) => {
      const recovery = recoveryByRepository.get(recoveryKey(row.provider, row.repositoryKey));
      if (!recovery) return false;
      return (
        recoveredByLookup.get(
          repositoryPullRequestIdentityKey({
            provider: recovery.repository.provider,
            repository: recovery.repository.displayName,
            number: row.number,
          }),
        )?.result?._tag === "not-found"
      );
    });
    yield* Effect.forEach(
      definitivelyMissingPins,
      (row) =>
        input.pinStore
          .setPinned({
            projectId: row.projectId,
            provider: row.provider,
            repositoryKey: row.repositoryKey,
            number: row.number,
            isPinned: false,
          })
          .pipe(
            Effect.catch((error) => {
              const project = input.projectById.get(row.projectId);
              const recovery = recoveryByRepository.get(
                recoveryKey(row.provider, row.repositoryKey),
              );
              if (project && recovery) {
                addError(
                  project,
                  recovery.repository,
                  `Missing pull request pin cleanup failed: ${error.message}`,
                );
              }
              return Effect.void;
            }),
          ),
      { concurrency: 3, discard: true },
    );

    const entries = missingPins.flatMap((row) => {
      const recovery = recoveryByRepository.get(recoveryKey(row.provider, row.repositoryKey));
      const project = input.projectById.get(row.projectId);
      if (!recovery || !project) return [];
      const lookup = recoveredByLookup.get(
        repositoryPullRequestIdentityKey({
          provider: recovery.repository.provider,
          repository: recovery.repository.displayName,
          number: row.number,
        }),
      );
      if (lookup?.error) {
        addError(
          project,
          recovery.repository,
          `Pinned pull request #${row.number} could not be recovered: ${lookup.error.message}`,
        );
        return [];
      }
      if (!lookup?.result || lookup.result._tag === "not-found") return [];
      const summary = lookup.result.summary;
      if (
        summary.state !== input.state ||
        !pullRequestMatchesInvolvement(summary, input.involvement, recovery.viewer ?? "")
      ) {
        return [];
      }
      return [buildPullRequestListEntry({ project, pullRequest: summary, isPinned: true })];
    });

    return { entries, errors: [...errors.values()] };
  });
}
