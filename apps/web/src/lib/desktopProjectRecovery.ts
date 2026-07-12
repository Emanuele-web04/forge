// FILE: desktopProjectRecovery.ts
// Purpose: Detects desktop startup snapshots that can hide projects while thread rows still exist.
// Exports: snapshot shape guard and hydration recovery classifier for desktop bootstrap.

import type { OrchestrationReadModel, OrchestrationShellSnapshot } from "@synara/contracts";

type ProjectRecoverySnapshot = OrchestrationReadModel | OrchestrationShellSnapshot;

export type DesktopHydrationRecoveryKind = "none" | "missing-threads" | "repair-projects";

export function hasLiveThreadsWithMissingProjects(snapshot: ProjectRecoverySnapshot): boolean {
  const liveProjectIds = new Set(
    snapshot.projects
      .filter((project) => !("deletedAt" in project) || project.deletedAt === null)
      .map((project) => project.id),
  );

  return snapshot.threads.some((thread) => {
    const isLiveThread = !("deletedAt" in thread) || thread.deletedAt === null;
    return isLiveThread && !liveProjectIds.has(thread.projectId);
  });
}

/**
 * A genuinely empty profile is a valid first-run state, not evidence that its
 * projections are damaged. Rebuilding projections in that case is expensive
 * and, when the desktop bootstrap reruns, can keep the orchestration database
 * busy long enough for unrelated provider commands to time out.
 */
export function shouldRepairDesktopProjectSnapshot(snapshot: ProjectRecoverySnapshot): boolean {
  const requiresEmptyProjectShellRepair =
    "requiresEmptyProjectShellRepair" in snapshot &&
    snapshot.requiresEmptyProjectShellRepair === true;

  return (
    hasLiveThreadsWithMissingProjects(snapshot) ||
    (snapshot.projects.length === 0 &&
      snapshot.threads.length === 0 &&
      requiresEmptyProjectShellRepair)
  );
}

export function classifyDesktopHydrationRecovery(state: {
  threadsHydrated: boolean;
  projects: ReadonlyArray<{ id: string }>;
  threads: ReadonlyArray<{ projectId: string }>;
}): DesktopHydrationRecoveryKind {
  if (!state.threadsHydrated) return "none";
  if (state.projects.length > 0 && state.threads.length === 0) return "missing-threads";
  const projectIds = new Set(state.projects.map((project) => project.id));
  const hasThreadWithoutProject = state.threads.some((thread) => !projectIds.has(thread.projectId));
  if (state.projects.length === 0 || hasThreadWithoutProject) return "repair-projects";
  return "none";
}

export type RepairedShellDecision =
  | { action: "confirmed-empty" }
  | { action: "reject-incomplete"; shellThreadCount: number }
  | {
      action: "apply";
      shell: {
        snapshotSequence: OrchestrationReadModel["snapshotSequence"];
        updatedAt: OrchestrationReadModel["updatedAt"];
        spaces: OrchestrationReadModel["spaces"];
        projects: OrchestrationReadModel["projects"];
        threads: OrchestrationReadModel["threads"];
      };
    };

/** Decide how to treat repairState output before any store write. */
export function resolveRepairedShellApplication(
  repaired: OrchestrationReadModel,
): RepairedShellDecision {
  const liveProjects = repaired.projects.filter((project) => project.deletedAt == null);
  const liveThreads = repaired.threads.filter((thread) => thread.deletedAt == null);
  if (liveProjects.length === 0 && liveThreads.length === 0) {
    return { action: "confirmed-empty" };
  }
  const shell = {
    snapshotSequence: repaired.snapshotSequence,
    updatedAt: repaired.updatedAt,
    spaces: repaired.spaces,
    projects: liveProjects,
    threads: liveThreads,
  };
  if (hasLiveThreadsWithMissingProjects(shell)) {
    return { action: "reject-incomplete", shellThreadCount: liveThreads.length };
  }
  return { action: "apply", shell };
}
