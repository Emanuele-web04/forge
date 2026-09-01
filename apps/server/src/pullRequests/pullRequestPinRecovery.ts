import type {
  OrchestrationProject,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestState,
  PullRequestsListResult,
} from "@synara/contracts";
import { Effect } from "effect";

import type { GitHubCliError } from "../git/Errors";
import type { GitHubPullRequestListItem } from "../git/Services/GitHubCli";
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
  resolvePullRequestViewerInvolvement,
  selectRecoverablePullRequestPins,
} from "../pullRequests.logic";

export const PULL_REQUEST_PIN_RECOVERY_LIMIT = PROJECT_PULL_REQUEST_PIN_LIMIT + 4;
export const PULL_REQUEST_REVIEW_MATCH_LIMIT = 1_000;

export type RecoveredPullRequest =
  | { readonly _tag: "found"; readonly item: GitHubPullRequestListItem }
  | { readonly _tag: "not-found" };

export type ReviewRequestedMatches = {
  readonly numbers: ReadonlySet<number>;
  readonly incomplete: boolean;
};

export type PullRequestPinRecoveryContext = {
  readonly cwd: string;
  readonly repository: string;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly truncated: boolean;
  readonly reviewingNumbers: ReadonlySet<number>;
  readonly reviewingTruncated: boolean;
};

type PullRequestListError = PullRequestsListResult["errors"][number];

export function recoverPinnedPullRequests(input: {
  state: PullRequestState;
  involvement: PullRequestInvolvement;
  viewer: string;
  forceRefresh: boolean;
  pins: ReadonlyArray<ProjectPullRequestPin>;
  pinStore: ProjectPullRequestPinsShape;
  batchEntries: ReadonlyArray<PullRequestListEntry>;
  recoveryContexts: ReadonlyArray<PullRequestPinRecoveryContext>;
  repositoryKeysByProject: ReadonlyMap<ProjectId, Set<string>>;
  projectById: ReadonlyMap<ProjectId, OrchestrationProject>;
  // Deliberately boolean, not a type predicate: callers check values already typed
  // GitHubCliError, and a predicate would narrow the false branch to `never`.
  isGlobalError: (error: unknown) => boolean;
  invalidateReviewMatches: (repository: string, viewer: string) => Effect.Effect<void, never>;
  loadReviewMatches: (
    cwd: string,
    repository: string,
    viewer: string,
  ) => Effect.Effect<ReviewRequestedMatches, GitHubCliError>;
  invalidateItem: (identityKey: string) => Effect.Effect<void, never>;
  loadItem: (
    cwd: string,
    repository: string,
    number: number,
  ) => Effect.Effect<RecoveredPullRequest, GitHubCliError>;
}) {
  return Effect.gen(function* () {
    const errors = new Map<string, PullRequestListError>();
    const addError = (project: OrchestrationProject, repository: string, message: string) => {
      errors.set(`${project.id}\u0000github\u0000${repository}\u0000${message}`, {
        projectId: project.id,
        projectTitle: project.title,
        provider: "github",
        repository,
        message,
      });
    };
    if (input.pins.length === 0) {
      return { entries: [] as PullRequestListEntry[], errors: [] as PullRequestListError[] };
    }

    const recoveryByRepository = new Map(
      input.recoveryContexts.map((context) => [context.repository.toLowerCase(), context]),
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
        repository: context.repository,
        truncated: context.truncated,
        projectIds: context.projects.map((project) => project.id),
      })),
    });

    // Budget unique remote lookups rather than project-local rows. Shared repositories fan one
    // result out to every owning project without consuming the recovery budget repeatedly.
    const pinsByLookup = new Map<string, typeof allMissingPins>();
    for (const row of allMissingPins) {
      const recovery = recoveryByRepository.get(row.repositoryKey.trim().toLowerCase());
      if (!recovery) continue;
      const lookupKey = repositoryPullRequestIdentityKey({
        provider: "github",
        repository: recovery.repository,
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
      if (project) {
        addError(
          project,
          row.repositoryKey,
          `Pinned pull request recovery was limited to ${PULL_REQUEST_PIN_RECOVERY_LIMIT} items. ` +
            "Open this project directly to recover the remaining pins.",
        );
      }
    }

    const reviewMatchInputs = new Map<string, { cwd: string; repository: string }>();
    for (const row of missingPins) {
      const repositoryKey = row.repositoryKey.trim().toLowerCase();
      const recovery = recoveryByRepository.get(repositoryKey);
      if (
        !recovery ||
        input.state !== "open" ||
        (input.involvement !== "reviewing" &&
          !(input.involvement === "all" && recovery.reviewingTruncated))
      ) {
        continue;
      }
      reviewMatchInputs.set(repositoryKey, {
        cwd: recovery.cwd,
        repository: recovery.repository,
      });
    }
    if (input.forceRefresh) {
      yield* Effect.forEach(
        reviewMatchInputs.values(),
        ({ repository }) => input.invalidateReviewMatches(repository, input.viewer),
        { concurrency: "unbounded", discard: true },
      );
    }
    const reviewMatches = new Map<
      string,
      ReviewRequestedMatches & { error: GitHubCliError | null }
    >(
      yield* Effect.forEach(
        reviewMatchInputs,
        ([repositoryKey, lookup]) =>
          input.loadReviewMatches(lookup.cwd, lookup.repository, input.viewer).pipe(
            Effect.map((matches) => [repositoryKey, { ...matches, error: null }] as const),
            Effect.catch((error) =>
              input.isGlobalError(error)
                ? Effect.fail(error)
                : Effect.succeed([
                    repositoryKey,
                    { numbers: new Set<number>(), incomplete: false, error },
                  ] as const),
            ),
          ),
        { concurrency: 3 },
      ),
    );
    for (const [repositoryKey, result] of reviewMatches) {
      if (!result.error && !result.incomplete) continue;
      const affectedProjectIds = new Set(
        missingPins
          .filter((row) => row.repositoryKey.trim().toLowerCase() === repositoryKey)
          .map((row) => row.projectId),
      );
      for (const projectId of affectedProjectIds) {
        const project = input.projectById.get(projectId);
        if (project) {
          addError(
            project,
            repositoryKey,
            result.error
              ? `Review-requested pin recovery failed for ${repositoryKey}: ${result.error.message}`
              : `Review-requested pin recovery for ${repositoryKey} reached GitHub's ` +
                  `${PULL_REQUEST_REVIEW_MATCH_LIMIT.toLocaleString("en-US")}-item limit ` +
                  "and may be incomplete.",
          );
        }
      }
    }

    const lookupInputs = new Map<string, { cwd: string; repository: string; number: number }>();
    for (const row of missingPins) {
      const recovery = recoveryByRepository.get(row.repositoryKey.trim().toLowerCase());
      const project = input.projectById.get(row.projectId);
      if (!recovery || !project) continue;
      const lookupKey = repositoryPullRequestIdentityKey({
        provider: "github",
        repository: recovery.repository,
        number: row.number,
      });
      lookupInputs.set(lookupKey, {
        cwd: project.workspaceRoot,
        repository: recovery.repository,
        number: row.number,
      });
    }
    if (input.forceRefresh) {
      yield* Effect.forEach(lookupInputs.keys(), input.invalidateItem, {
        concurrency: "unbounded",
        discard: true,
      });
    }
    const recoveredByLookup = new Map<
      string,
      { result: RecoveredPullRequest | null; error: GitHubCliError | null }
    >(
      yield* Effect.forEach(
        lookupInputs,
        ([key, lookup]) =>
          input.loadItem(lookup.cwd, lookup.repository, lookup.number).pipe(
            Effect.map((result) => [key, { result, error: null }] as const),
            Effect.catch((error) =>
              input.isGlobalError(error)
                ? Effect.fail(error)
                : Effect.succeed([key, { result: null, error }] as const),
            ),
          ),
        { concurrency: 3 },
      ),
    );

    // Only an exact PR lookup can prove remote deletion. Permission, auth, timeout, and generic
    // 404 failures preserve the pin for a later retry.
    const definitivelyMissingPins = missingPins.filter((row) => {
      const recovery = recoveryByRepository.get(row.repositoryKey.trim().toLowerCase());
      if (!recovery) return false;
      return (
        recoveredByLookup.get(
          repositoryPullRequestIdentityKey({
            provider: "github",
            repository: recovery.repository,
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
            repositoryKey: row.repositoryKey,
            number: row.number,
            isPinned: false,
          })
          .pipe(
            Effect.catch((error) => {
              const project = input.projectById.get(row.projectId);
              if (project) {
                addError(
                  project,
                  row.repositoryKey,
                  `Missing pull request pin cleanup failed: ${error.message}`,
                );
              }
              return Effect.void;
            }),
          ),
      { concurrency: 3, discard: true },
    );

    const entries = missingPins.flatMap((row) => {
      const repositoryKey = row.repositoryKey.trim().toLowerCase();
      const recovery = recoveryByRepository.get(repositoryKey);
      const project = input.projectById.get(row.projectId);
      if (!recovery || !project) return [];
      const lookup = recoveredByLookup.get(
        repositoryPullRequestIdentityKey({
          provider: "github",
          repository: recovery.repository,
          number: row.number,
        }),
      );
      if (lookup?.error) {
        addError(
          project,
          repositoryKey,
          `Pinned pull request #${row.number} could not be recovered: ${lookup.error.message}`,
        );
        return [];
      }
      if (!lookup?.result || lookup.result._tag === "not-found") return [];
      const item = lookup.result.item;
      const matchedReviewingQuery =
        recovery.reviewingNumbers.has(row.number) ||
        reviewMatches.get(repositoryKey)?.numbers.has(row.number) === true;
      if (
        item.state !== input.state ||
        !pullRequestMatchesInvolvement(item, input.involvement, input.viewer, matchedReviewingQuery)
      ) {
        return [];
      }
      const viewerInvolvement = resolvePullRequestViewerInvolvement(
        item.author,
        item.reviewRequestLogins,
        input.viewer,
        matchedReviewingQuery,
      );
      return [
        buildPullRequestListEntry({
          project,
          repository: recovery.repository,
          pullRequest: item,
          viewerReviewRequested: viewerInvolvement === "review-requested",
          viewerInvolvement,
          isPinned: true,
        }),
      ];
    });

    return { entries, errors: [...errors.values()] };
  });
}
