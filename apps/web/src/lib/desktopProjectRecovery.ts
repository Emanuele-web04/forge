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

 /** True when any client-side normalized thread evidence exists.
 *
 * Reads legacy `threads`, normalized `threadIds`, `threadShellById`,
 * `threadSessionById`, and `threadTurnStateById`. This prevents repair paths
 * from declaring the database empty when a hot-path detail snapshot has
 * already created normalized thread state while the derived `threads` array
 * remains empty. */
export function hasClientLiveThreadEvidence(state: {
  threads?: ReadonlyArray<unknown> | undefined;
  threadIds?: ReadonlyArray<unknown> | undefined;
  threadShellById?: Readonly<Record<string, unknown>> | undefined;
  threadSessionById?: Readonly<Record<string, unknown>> | undefined;
  threadTurnStateById?: Readonly<Record<string, unknown>> | undefined;
}): boolean {
  if ((state.threads?.length ?? 0) > 0) return true;
  if ((state.threadIds?.length ?? 0) > 0) return true;
  if (Object.keys(state.threadShellById ?? {}).length > 0) return true;
  if (Object.keys(state.threadSessionById ?? {}).length > 0) return true;
  if (Object.keys(state.threadTurnStateById ?? {}).length > 0) return true;
  return false;
}

export function classifyDesktopHydrationRecovery(state: {
  threadsHydrated: boolean;
  projects: ReadonlyArray<{ id: string }>;
  threads: ReadonlyArray<{ projectId: string }>;
  threadIds?: ReadonlyArray<string> | undefined;
  threadShellById?: Readonly<Record<string, { projectId: string }>> | undefined;
  threadSessionById?: Readonly<Record<string, unknown>> | undefined;
  threadTurnStateById?: Readonly<Record<string, unknown>> | undefined;
}): DesktopHydrationRecoveryKind {
  if (!state.threadsHydrated) return "none";

  const hasThreadEvidence = hasClientLiveThreadEvidence({
    threads: state.threads,
    threadIds: state.threadIds,
    threadShellById: state.threadShellById,
    threadSessionById: state.threadSessionById,
    threadTurnStateById: state.threadTurnStateById,
  });

  if (state.projects.length > 0 && state.threads.length === 0 && !hasThreadEvidence) {
    return "missing-threads";
  }

  const projectIds = new Set(state.projects.map((project) => project.id));
  const shellThreads = Object.values(state.threadShellById ?? {});
  const hasThreadWithoutProject = [...state.threads, ...shellThreads].some(
    (thread) => !projectIds.has(thread.projectId),
  );

  if (state.projects.length === 0 || hasThreadWithoutProject) return "repair-projects";
  return "none";
}

export type RepairedShellDecision =
  | { action: "confirmed-empty" }
  | { action: "inconsistent-empty"; shellThreadCount: number }
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
export function resolveRepairedShellApplication(input: {
  repaired: OrchestrationReadModel;
  /** True if this recovery attempt already observed live threads (client, shell, or full snapshot). */
  observedLiveThreadEvidence: boolean;
}): RepairedShellDecision {
  const liveProjects = input.repaired.projects.filter((project) => project.deletedAt == null);
  const liveThreads = input.repaired.threads.filter((thread) => thread.deletedAt == null);

  // Once a recovery attempt has observed live threads, a zero-live-thread result
  // is contradictory even if it restores projects. Treating it as terminal would
  // hide the client’s known live threads behind a project-only shell.
  if (input.observedLiveThreadEvidence && liveThreads.length === 0) {
    return { action: "inconsistent-empty", shellThreadCount: 0 };
  }

  if (liveProjects.length === 0 && liveThreads.length === 0) {
    return { action: "confirmed-empty" };
  }

  const shell = {
    snapshotSequence: input.repaired.snapshotSequence,
    updatedAt: input.repaired.updatedAt,
    spaces: input.repaired.spaces,
    projects: liveProjects,
    threads: liveThreads,
  };
  if (hasLiveThreadsWithMissingProjects(shell)) {
    return { action: "reject-incomplete", shellThreadCount: liveThreads.length };
  }
  return { action: "apply", shell };
}
