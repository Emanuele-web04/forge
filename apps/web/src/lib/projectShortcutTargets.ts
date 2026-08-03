import type { ProjectId } from "@synara/contracts";

import type { Project } from "../types";

function resolveUsableProjectId(
  projects: readonly Project[],
  projectId: ProjectId | null,
): ProjectId | null {
  if (!projectId) {
    return null;
  }

  const project = projects.find(
    (candidate) => candidate.id === projectId && candidate.kind === "project",
  );
  return project?.id ?? null;
}

export function resolveCurrentProjectTargetId(
  projects: readonly Project[],
  focusedProjectId: ProjectId | null,
): ProjectId | null {
  return resolveUsableProjectId(projects, focusedProjectId);
}

export function resolveLatestProjectTargetId(
  projects: readonly Project[],
  latestProjectId: ProjectId | null,
): ProjectId | null {
  return resolveUsableProjectId(projects, latestProjectId);
}

/**
 * Last time each project was used, keyed by project id (see
 * `createProjectLastActivityAtSelector`). Projects absent from the map have no threads yet.
 */
export type ProjectLastActivityAt = ReadonlyMap<ProjectId, string>;

/**
 * Ranks a project by when it was last *used* — the newest user message across its threads — and
 * only falls back to its metadata timestamps when it has no threads at all. Ranking by
 * `Project.updatedAt` alone would order by "most recently created/renamed project", which is not
 * what "last used project" means to the user.
 */
function projectRecencyKey(project: Project, lastActivityAt: ProjectLastActivityAt): string {
  return lastActivityAt.get(project.id) ?? project.updatedAt ?? project.createdAt ?? "";
}

const NO_PROJECT_ACTIVITY: ProjectLastActivityAt = new Map<ProjectId, string>();

export function resolveLatestProjectTargetIdWithFallback(
  projects: readonly Project[],
  latestProjectId: ProjectId | null,
  lastActivityAt: ProjectLastActivityAt = NO_PROJECT_ACTIVITY,
): ProjectId | null {
  return (
    resolveLatestProjectTargetId(projects, latestProjectId) ??
    projects
      .filter((project) => project.kind === "project")
      .toSorted((left, right) =>
        projectRecencyKey(right, lastActivityAt).localeCompare(
          projectRecencyKey(left, lastActivityAt),
        ),
      )
      .at(0)?.id ??
    null
  );
}

export interface NewThreadTarget {
  readonly projectId: ProjectId;
  /**
   * Whether the new thread should inherit the active surface's branch/worktree/env.
   * True only when we target the focused project; on the latest-project fallback that
   * context belongs to a project no longer in view, so we defer to its own defaults.
   */
  readonly inheritContext: boolean;
}

// Single rule for which project a global "new thread" action targets: the focused project
// when one is usable, otherwise the most recently used project. Shared by click, palette,
// and keyboard entry points so they never disagree on the fallback.
export function resolveNewThreadTarget(input: {
  currentProjectId: ProjectId | null;
  latestUsableProjectId: ProjectId | null;
}): NewThreadTarget | null {
  if (input.currentProjectId) {
    return { projectId: input.currentProjectId, inheritContext: true };
  }
  if (input.latestUsableProjectId) {
    return { projectId: input.latestUsableProjectId, inheritContext: false };
  }
  return null;
}
