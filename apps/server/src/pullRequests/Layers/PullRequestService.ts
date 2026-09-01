import {
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type ProjectId,
  type PullRequestListEntry,
  type PullRequestProvider,
  type PullRequestsListResult,
} from "@synara/contracts";
import { coalescePullRequestListEntries } from "@synara/shared/githubRepository";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect, Layer, Scope } from "effect";

import { GitCore } from "../../git/Services/GitCore";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import {
  ProjectPullRequestPins,
  type ProjectPullRequestPinsShape,
} from "../../persistence/Services/ProjectPullRequestPins";
import {
  buildPullRequestListEntry,
  isValidGitHubRepositoryNameWithOwner,
  orderPullRequestListEntries,
  projectPullRequestIdentityKey,
} from "../../pullRequests.logic";
import { makeKeyedSingleFlightCache } from "../KeyedSingleFlightCache";
import {
  PullRequestProviderSelectionError,
  isGlobalPullRequestProviderError,
  makePullRequestProviderRegistry,
  type PullRequestProviderShape,
} from "../Services/PullRequestProvider";
import { PullRequestService, type PullRequestServiceShape } from "../Services/PullRequestService";
import {
  GitHubPullRequestProvider,
  isDefinitivePullRequestNotFound,
} from "../providers/GitHubPullRequestProvider";
import { resolveRemoteRepositories, type RemoteRepositoryInventory } from "../repositoryResolution";
import {
  cleanupUnconfiguredPullRequestPins,
  indexProjectRepositoryInventories,
  resolveProjectRepositoryInventories,
} from "../projectRepositoryInventory";
import { makePullRequestOperations } from "../pullRequestOperations";
import { recoverPinnedPullRequests } from "../pullRequestPinRecovery";

export { PULL_REQUEST_PIN_RECOVERY_LIMIT } from "../pullRequestPinRecovery";
export { isDefinitivePullRequestNotFound };

const REMOTE_REPOSITORY_CACHE_MAX_ENTRIES = 256;

type PullRequestListError = PullRequestsListResult["errors"][number];

export interface PullRequestServiceDependencies {
  readonly providers: ReadonlyArray<PullRequestProviderShape>;
  readonly pins: ProjectPullRequestPinsShape;
  /**
   * Live (non-soft-deleted) projects. Deliberately not the full read model: the PR
   * service only ever reads `snapshot.projects`, and hydrating every thread body for a
   * five-minute review-count poll blocked the whole SQLite connection for seconds.
   */
  readonly listProjects: () => Effect.Effect<ReadonlyArray<OrchestrationProject>, unknown>;
  readonly resolveRepositories: (
    project: OrchestrationProject,
  ) => Effect.Effect<RemoteRepositoryInventory, unknown>;
}

/**
 * The shell snapshot already excludes soft-deleted projects, so the field it omits is
 * known to be null. Restoring it keeps the shared PR helpers on one project type.
 */
export function liveProjectFromShell(shell: OrchestrationProjectShell): OrchestrationProject {
  return { ...shell, deletedAt: null };
}

function ignoreUnregisteredProvider(
  error: PullRequestProviderSelectionError,
): Effect.Effect<null, PullRequestProviderSelectionError> {
  return error.matches === 0 ? Effect.succeed(null) : Effect.fail(error);
}

export const makePullRequestService = (
  dependencies: PullRequestServiceDependencies,
): Effect.Effect<PullRequestServiceShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const providerRegistry = makePullRequestProviderRegistry(dependencies.providers);
    const repositoryCache = yield* makeKeyedSingleFlightCache<RemoteRepositoryInventory, unknown>({
      maxEntries: REMOTE_REPOSITORY_CACHE_MAX_ENTRIES,
      ttlMs: 30_000,
    });

    const resolveProjectRepositories = (project: OrchestrationProject) =>
      repositoryCache.get(project.workspaceRoot, dependencies.resolveRepositories(project));

    const findProject = (projectId: ProjectId) =>
      dependencies.listProjects().pipe(
        Effect.flatMap((allProjects) => {
          const project = allProjects.find(
            (candidate) =>
              candidate.id === projectId &&
              candidate.kind === "project" &&
              candidate.deletedAt === null,
          );
          return project ? Effect.succeed(project) : Effect.fail(new Error("Project not found."));
        }),
      );

    const validatePullRequestRepository = (provider: PullRequestProvider, repository: string) => {
      const normalized = repository.trim();
      return isValidGitHubRepositoryNameWithOwner(normalized)
        ? Effect.succeed(normalized)
        : Effect.fail(new Error(`Invalid ${provider} repository identity.`));
    };

    const resolveProjectPullRequestRepository = (
      project: OrchestrationProject,
      provider: PullRequestProvider,
      repositoryInput: string,
    ) =>
      Effect.gen(function* () {
        const repository = yield* validatePullRequestRepository(provider, repositoryInput);
        const inventory = yield* resolveProjectRepositories(project);
        if (!inventory.authoritative) {
          return yield* Effect.fail(new Error("Repository inventory is unavailable."));
        }
        const matched = inventory.repositories.find(
          (candidate) =>
            candidate.provider === provider &&
            candidate.displayName.toLowerCase() === repository.toLowerCase(),
        );
        if (!matched) {
          return yield* Effect.fail(
            new Error(`${provider} repository does not belong to the selected project.`),
          );
        }
        return matched;
      });

    const selectInventoryProviders = (
      repositories: ReadonlyArray<{
        repository: RemoteRepositoryRef;
        projects: OrchestrationProject[];
      }>,
    ) =>
      Effect.forEach(
        repositories,
        (entry) =>
          providerRegistry.select(entry.repository).pipe(
            Effect.map((adapter) => ({ ...entry, adapter })),
            Effect.catch(ignoreUnregisteredProvider),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((entries) => entries.filter((entry) => entry !== null)));

    const loadProviderViewers = (
      repositories: ReadonlyArray<{
        adapter: PullRequestProviderShape;
        projects: OrchestrationProject[];
      }>,
      forceRefresh: boolean,
    ) => {
      const unique = new Map<PullRequestProviderShape, OrchestrationProject>();
      for (const repository of repositories) {
        if (!unique.has(repository.adapter)) {
          unique.set(repository.adapter, repository.projects[0]!);
        }
      }
      return Effect.forEach(
        unique,
        ([adapter, project]) =>
          adapter.viewer
            ? adapter
                .viewer({ cwd: project.workspaceRoot, forceRefresh })
                .pipe(Effect.map((viewer) => [adapter, viewer] as const))
            : Effect.succeed([adapter, ""] as const),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((viewers) => new Map(viewers)));
    };

    const list: PullRequestServiceShape["list"] = (input) =>
      Effect.gen(function* () {
        const forceRefresh = input.forceRefresh === true;
        const involvement = input.involvement ?? "all";
        const projects = (yield* dependencies.listProjects()).filter(
          (project) =>
            project.deletedAt === null &&
            project.kind === "project" &&
            (input.projectId == null || project.id === input.projectId),
        );
        const projectById = new Map(projects.map((project) => [project.id, project]));
        if (forceRefresh) {
          yield* Effect.forEach(
            projects,
            (project) => repositoryCache.invalidate(project.workspaceRoot),
            { concurrency: "unbounded", discard: true },
          );
        }

        const [resolved, pinnedRows] = yield* Effect.all(
          [
            resolveProjectRepositoryInventories({
              projects,
              resolve: resolveProjectRepositories,
            }),
            dependencies.pins.listByProjectIds({
              projectIds: projects.map((project) => project.id),
            }),
          ],
          { concurrency: 2 },
        );
        const pinnedKeys = new Set(
          pinnedRows.map((row) =>
            projectPullRequestIdentityKey({
              projectId: row.projectId,
              provider: row.provider,
              repository: row.repositoryKey,
              number: row.number,
            }),
          ),
        );

        const {
          errors: inventoryErrors,
          repositoryKeysByProject,
          uniqueRepositories,
        } = indexProjectRepositoryInventories(resolved);
        const cleanupErrors = yield* cleanupUnconfiguredPullRequestPins({
          pins: dependencies.pins,
          pinnedRows,
          projectById,
          repositoryKeysByProject,
          resolved,
        });
        const errors: PullRequestListError[] = [...inventoryErrors, ...cleanupErrors];
        const providerRepositories = yield* selectInventoryProviders([
          ...uniqueRepositories.values(),
        ]);
        if (providerRepositories.length === 0) {
          return {
            viewer: null,
            entries: [],
            errors,
            repositoryBatches: [],
            providerRequirements: [],
          };
        }

        const viewers = yield* loadProviderViewers(providerRepositories, forceRefresh);
        const githubViewers = new Set(
          providerRepositories.flatMap(({ adapter }) =>
            adapter.provider === "github" ? [viewers.get(adapter) ?? ""] : [],
          ),
        );
        const viewer = [...githubViewers][0] ?? null;

        const batches = yield* Effect.forEach(
          providerRepositories,
          ({ adapter, projects: repositoryProjects, repository }) =>
            adapter
              .list({
                cwd: repositoryProjects[0]!.workspaceRoot,
                repository,
                state: input.state,
                involvement,
                viewer: viewers.get(adapter) ?? "",
                forceRefresh,
              })
              .pipe(
                Effect.map((result) => ({
                  entries: repositoryProjects.flatMap((project) =>
                    result.entries.map(
                      (summary): PullRequestListEntry =>
                        buildPullRequestListEntry({
                          project,
                          pullRequest: summary,
                          isPinned: pinnedKeys.has(
                            projectPullRequestIdentityKey({
                              projectId: project.id,
                              provider: summary.provider,
                              repository: summary.repository,
                              number: summary.number,
                            }),
                          ),
                        }),
                    ),
                  ),
                  repositoryBatches: repositoryProjects.slice(0, 1).map((project) => ({
                    projectId: project.id,
                    projectTitle: project.title,
                    provider: repository.provider,
                    repository: repository.displayName,
                    truncated: result.truncated,
                  })),
                  errors: [] as PullRequestListError[],
                  recovery: {
                    cwd: repositoryProjects[0]!.workspaceRoot,
                    repository,
                    adapter,
                    projects: repositoryProjects,
                    truncated: result.truncated,
                    reviewingNumbers: result.reviewingNumbers,
                    reviewingTruncated: result.reviewingTruncated,
                  },
                })),
                Effect.catch((error) =>
                  isGlobalPullRequestProviderError(error)
                    ? Effect.fail(error)
                    : Effect.succeed({
                        entries: [] as PullRequestListEntry[],
                        repositoryBatches: [],
                        errors: repositoryProjects.map((project) => ({
                          projectId: project.id,
                          projectTitle: project.title,
                          provider: repository.provider,
                          repository: repository.displayName,
                          message: error.message,
                        })),
                        recovery: null,
                      }),
                ),
              ),
          { concurrency: 6 },
        );
        const batchEntries = batches.flatMap((batch) => batch.entries);
        const recovery = yield* recoverPinnedPullRequests({
          state: input.state,
          involvement,
          viewer: viewer ?? "",
          forceRefresh,
          pins: pinnedRows,
          pinStore: dependencies.pins,
          batchEntries,
          recoveryContexts: batches.flatMap((batch) => (batch.recovery ? [batch.recovery] : [])),
          repositoryKeysByProject,
          projectById,
          isGlobalError: isGlobalPullRequestProviderError,
        });

        const visibleEntries = coalescePullRequestListEntries([
          ...batchEntries,
          ...recovery.entries,
        ]);
        return {
          viewer,
          entries: orderPullRequestListEntries(visibleEntries),
          errors: [...errors, ...batches.flatMap((batch) => batch.errors), ...recovery.errors],
          repositoryBatches: batches.flatMap((batch) => batch.repositoryBatches),
          providerRequirements: [],
        };
      });

    const reviewRequestCount: PullRequestServiceShape["reviewRequestCount"] = (input) =>
      Effect.gen(function* () {
        const projects = (yield* dependencies.listProjects()).filter(
          (project) =>
            project.deletedAt === null &&
            project.kind === "project" &&
            (input.projectId == null || project.id === input.projectId),
        );
        const resolved = yield* resolveProjectRepositoryInventories({
          projects,
          resolve: resolveProjectRepositories,
        });
        const { uniqueRepositories } = indexProjectRepositoryInventories(resolved);
        const inventoryIncomplete = resolved.some(
          (item) => item.error !== null || !item.inventory.authoritative,
        );
        const githubRepositories = [...uniqueRepositories.values()].filter(
          ({ repository }) => repository.provider === "github",
        );
        if (githubRepositories.length === 0) {
          return { count: 0, incomplete: inventoryIncomplete };
        }

        const selected = yield* Effect.forEach(
          githubRepositories,
          (entry) =>
            providerRegistry
              .select(entry.repository)
              .pipe(Effect.map((adapter) => ({ ...entry, adapter }))),
          { concurrency: "unbounded" },
        );
        const viewers = yield* loadProviderViewers(selected, false);
        const repositoryCounts = yield* Effect.forEach(
          selected,
          ({ adapter, projects: repositoryProjects, repository }) => {
            const count = adapter.reviewRequestCount;
            if (!count) return Effect.succeed({ count: 0, incomplete: true });
            return count({
              cwd: repositoryProjects[0]!.workspaceRoot,
              repository,
              viewer: viewers.get(adapter) ?? "",
              forceRefresh: false,
            }).pipe(
              Effect.catch((error) =>
                isGlobalPullRequestProviderError(error)
                  ? Effect.fail(error)
                  : Effect.succeed({ count: 0, incomplete: true }),
              ),
            );
          },
          { concurrency: 6 },
        );

        return {
          count: repositoryCounts.reduce((total, result) => total + result.count, 0),
          incomplete: inventoryIncomplete || repositoryCounts.some((result) => result.incomplete),
        };
      });

    const operations = makePullRequestOperations({
      providers: providerRegistry,
      pins: dependencies.pins,
      findProject,
      validateRepository: validatePullRequestRepository,
      resolveProjectRepository: resolveProjectPullRequestRepository,
    });

    return {
      list,
      reviewRequestCount,
      ...operations,
    } satisfies PullRequestServiceShape;
  });

export const PullRequestServiceLive = Layer.effect(
  PullRequestService,
  Effect.gen(function* () {
    const git = yield* GitCore;
    const githubProvider = yield* GitHubPullRequestProvider;
    const pins = yield* ProjectPullRequestPins;
    const projection = yield* ProjectionSnapshotQuery;
    return yield* makePullRequestService({
      providers: [githubProvider],
      pins,
      listProjects: () =>
        projection
          .getShellSnapshot()
          .pipe(Effect.map((snapshot) => snapshot.projects.map(liveProjectFromShell))),
      resolveRepositories: (project) => resolveRemoteRepositories(git, project.workspaceRoot),
    });
  }),
);
