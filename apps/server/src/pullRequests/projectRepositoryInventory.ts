import type {
  OrchestrationProject,
  ProjectId,
  PullRequestProvider,
  PullRequestsListResult,
} from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect } from "effect";

import type {
  ProjectPullRequestPin,
  ProjectPullRequestPinsShape,
} from "../persistence/Services/ProjectPullRequestPins";
import type { GitHubRepositoryLink } from "./repositoryResolution";

type RepositoryLink = GitHubRepositoryLink | RemoteRepositoryRef;

type RepositoryInventory<TRepository extends RepositoryLink> = {
  readonly repositories: ReadonlyArray<TRepository>;
  readonly authoritative: boolean;
};

export type ProjectRepositoryResolution<TRepository extends RepositoryLink = GitHubRepositoryLink> =
  {
    readonly project: OrchestrationProject;
    readonly error: unknown | null;
    readonly inventory: RepositoryInventory<TRepository>;
  };

export type ProjectRepositoryIndex<TRepository extends RepositoryLink = GitHubRepositoryLink> = {
  readonly errors: PullRequestsListResult["errors"];
  readonly repositoryKeysByProject: ReadonlyMap<ProjectId, Set<string>>;
  readonly uniqueRepositories: ReadonlyMap<
    string,
    { repository: TRepository; projects: OrchestrationProject[] }
  >;
};

function repositoryIdentityKey(repository: RepositoryLink): string {
  return "identityKey" in repository
    ? repository.identityKey
    : repository.nameWithOwner.toLowerCase();
}

export function pullRequestPinRepositoryKey(
  provider: PullRequestProvider,
  repositoryKey: string,
): string {
  return `${provider}\0${repositoryKey.trim().toLowerCase()}`;
}

function repositoryPinKey(repository: RepositoryLink): string {
  return "identityKey" in repository
    ? pullRequestPinRepositoryKey(repository.provider, `${repository.owner}/${repository.slug}`)
    : pullRequestPinRepositoryKey("github", repository.nameWithOwner);
}

export function resolveProjectRepositoryInventories<
  TRepository extends RepositoryLink = GitHubRepositoryLink,
>(input: {
  projects: ReadonlyArray<OrchestrationProject>;
  resolve: (
    project: OrchestrationProject,
  ) => Effect.Effect<RepositoryInventory<TRepository>, unknown>;
}) {
  return Effect.forEach(
    input.projects,
    (project) =>
      input.resolve(project).pipe(
        Effect.match({
          onFailure: (error): ProjectRepositoryResolution<TRepository> => ({
            project,
            error,
            inventory: { repositories: [], authoritative: false },
          }),
          onSuccess: (inventory): ProjectRepositoryResolution<TRepository> => ({
            project,
            error: null,
            inventory,
          }),
        }),
      ),
    { concurrency: 6 },
  );
}

export function indexProjectRepositoryInventories<TRepository extends RepositoryLink>(
  resolved: ReadonlyArray<ProjectRepositoryResolution<TRepository>>,
): ProjectRepositoryIndex<TRepository> {
  const errors = resolved.flatMap(({ project, error }) =>
    error
      ? [
          {
            projectId: project.id,
            projectTitle: project.title,
            provider: null,
            repository: null,
            message: error instanceof Error ? error.message : "Repository lookup failed.",
          },
        ]
      : [],
  );
  const uniqueRepositories = new Map<
    string,
    { repository: TRepository; projects: OrchestrationProject[] }
  >();
  const repositoryKeysByProject = new Map<ProjectId, Set<string>>();

  for (const item of resolved) {
    repositoryKeysByProject.set(
      item.project.id,
      new Set(item.inventory.repositories.map(repositoryPinKey)),
    );
    for (const repository of item.inventory.repositories) {
      const key = repositoryIdentityKey(repository);
      const existing = uniqueRepositories.get(key);
      if (existing) {
        if (!existing.projects.some((project) => project.id === item.project.id)) {
          existing.projects.push(item.project);
        }
      } else {
        uniqueRepositories.set(key, { repository, projects: [item.project] });
      }
    }
  }

  return { errors, repositoryKeysByProject, uniqueRepositories };
}

/** Remove pins only when an explicitly authoritative inventory proves ownership ended. */
export function cleanupUnconfiguredPullRequestPins<TRepository extends RepositoryLink>(input: {
  pins: ProjectPullRequestPinsShape;
  pinnedRows: ReadonlyArray<ProjectPullRequestPin>;
  projectById: ReadonlyMap<ProjectId, OrchestrationProject>;
  repositoryKeysByProject: ReadonlyMap<ProjectId, Set<string>>;
  resolved: ReadonlyArray<ProjectRepositoryResolution<TRepository>>;
}) {
  const resolutionByProject = new Map(input.resolved.map((item) => [item.project.id, item]));
  const unconfiguredPins = input.pinnedRows.filter((row) => {
    const resolution = resolutionByProject.get(row.projectId);
    return (
      resolution?.inventory.authoritative === true &&
      input.repositoryKeysByProject
        .get(row.projectId)
        ?.has(pullRequestPinRepositoryKey(row.provider, row.repositoryKey)) !== true
    );
  });

  return Effect.forEach(
    unconfiguredPins,
    (row) =>
      input.pins
        .setPinned({
          projectId: row.projectId,
          provider: row.provider,
          repositoryKey: row.repositoryKey,
          number: row.number,
          isPinned: false,
        })
        .pipe(
          Effect.map((): PullRequestsListResult["errors"][number] | null => null),
          Effect.catch((error) => {
            const project = input.projectById.get(row.projectId);
            return Effect.succeed(
              project
                ? {
                    projectId: project.id,
                    projectTitle: project.title,
                    provider: null,
                    repository: null,
                    message: `Stale pull request pin cleanup failed: ${error.message}`,
                  }
                : null,
            );
          }),
        ),
    { concurrency: 3 },
  ).pipe(Effect.map((errors) => errors.filter((error) => error !== null)));
}
