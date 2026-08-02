// FILE: keepRaceWinner.ts
// Purpose: Promote a Model Race winner and archive/cleanup losing candidates.
// Layer: Web orchestration helper
// Exports: resolveRaceLosers, keepRaceWinner

import type { NativeApi, ProjectId, ThreadId } from "@synara/contracts";
import { archiveThreadFromClient } from "../lib/threadArchive";
import { getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { newCommandId } from "../lib/utils";
import type { Project, Thread } from "../types";
import type { RaceSession } from "./raceSessionStore";
import { useRaceSessionStore } from "./raceSessionStore";

export function resolveRaceLoserThreadIds(
  session: RaceSession,
  winnerThreadId: ThreadId,
): ThreadId[] {
  return session.candidates
    .map((candidate) => candidate.threadId)
    .filter((threadId) => threadId !== winnerThreadId);
}

export type KeepRaceWinnerInput = {
  readonly raceId: string;
  readonly winnerThreadId: ThreadId;
  readonly project: Pick<Project, "id" | "cwd">;
  readonly threads: readonly Thread[];
};

export type KeepRaceWinnerResult = {
  readonly winnerThreadId: ThreadId;
  readonly archivedThreadIds: readonly ThreadId[];
  readonly removedWorktreePaths: readonly string[];
};

export type KeepRaceWinnerDeps = {
  readonly api: {
    readonly orchestration: Pick<NativeApi["orchestration"], "dispatchCommand">;
    readonly git: Pick<NativeApi["git"], "removeWorktree">;
  };
  readonly markWinner?: (raceId: string, winnerThreadId: ThreadId) => void;
  readonly clearSession?: (raceId: string) => void;
  readonly getSession?: (raceId: string) => RaceSession | null;
};

export async function keepRaceWinner(
  input: KeepRaceWinnerInput,
  deps: KeepRaceWinnerDeps,
): Promise<KeepRaceWinnerResult> {
  const session =
    deps.getSession?.(input.raceId) ??
    useRaceSessionStore.getState().sessionsById[input.raceId] ??
    null;
  if (!session) {
    throw new Error("This Model Race session is no longer available.");
  }

  const winner = session.candidates.find(
    (candidate) => candidate.threadId === input.winnerThreadId,
  );
  if (!winner) {
    throw new Error("Selected thread is not part of this Model Race.");
  }

  const loserThreadIds = resolveRaceLoserThreadIds(session, input.winnerThreadId);
  const removedWorktreePaths: string[] = [];

  for (const loserThreadId of loserThreadIds) {
    try {
      await deps.api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: loserThreadId,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Interrupt is best-effort when a turn is already settled or unavailable.
    }

    await archiveThreadFromClient(deps.api.orchestration, loserThreadId);

    const orphanedWorktreePath = getOrphanedWorktreePathForThread(
      input.threads.filter((thread) => thread.id !== input.winnerThreadId),
      loserThreadId,
    );
    const sessionWorktreePath =
      session.candidates.find((candidate) => candidate.threadId === loserThreadId)?.worktreePath ??
      null;
    const worktreePath = orphanedWorktreePath ?? sessionWorktreePath;
    if (!worktreePath || !input.project.cwd) {
      continue;
    }
    try {
      await deps.api.git.removeWorktree({
        cwd: input.project.cwd,
        path: worktreePath,
        force: true,
      });
      removedWorktreePaths.push(worktreePath);
    } catch {
      // Archive succeeded; worktree cleanup is best-effort.
    }
  }

  (deps.markWinner ?? useRaceSessionStore.getState().markWinner)(
    input.raceId,
    input.winnerThreadId,
  );
  (deps.clearSession ?? useRaceSessionStore.getState().clearSession)(input.raceId);

  return {
    winnerThreadId: input.winnerThreadId,
    archivedThreadIds: loserThreadIds,
    removedWorktreePaths,
  };
}

export function assertProjectIdMatches(session: RaceSession, projectId: ProjectId): void {
  if (session.projectId !== projectId) {
    throw new Error("Race winner project mismatch.");
  }
}
