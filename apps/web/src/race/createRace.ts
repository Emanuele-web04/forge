// FILE: createRace.ts
// Purpose: Orchestrates Best-of-N Model Race candidate worktree + thread spawn.
// Layer: Web orchestration helper
// Exports: planning validators and createRace saga.

import type {
  ClientOrchestrationCommand,
  ModelSelection,
  NativeApi,
  OrchestrationShellSnapshot,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { formatProviderModelOptionName } from "../providerModelOptions";
import { newCommandId, newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { archiveThreadFromClient } from "../lib/threadArchive";
import type { RaceCandidate, RaceSession } from "./raceSessionStore";
import { useRaceSessionStore } from "./raceSessionStore";

type ThreadCreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;

export const RACE_MIN_CANDIDATES = 2;
export const RACE_MAX_CANDIDATES = 3;

export type RaceModelIdentity = {
  readonly provider: ModelSelection["provider"];
  readonly model: ModelSelection["model"];
};

export function raceModelIdentityKey(selection: ModelSelection): string {
  return `${selection.provider}:${selection.model}`;
}

export function areRaceModelsDistinct(selections: readonly ModelSelection[]): boolean {
  const seen = new Set<string>();
  for (const selection of selections) {
    const key = raceModelIdentityKey(selection);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

export function clampRaceModelSelections(
  selections: readonly ModelSelection[],
): ModelSelection[] | null {
  if (selections.length < RACE_MIN_CANDIDATES || selections.length > RACE_MAX_CANDIDATES) {
    return null;
  }
  if (!areRaceModelsDistinct(selections)) {
    return null;
  }
  return [...selections];
}

export function buildRaceCandidateTitle(modelSelection: ModelSelection): string {
  const modelLabel = formatProviderModelOptionName({
    provider: modelSelection.provider,
    slug: modelSelection.model,
  });
  return `Race · ${modelLabel.length > 0 ? modelLabel : modelSelection.model}`;
}

export function planRaceCandidateCreates(input: {
  readonly raceId: string;
  readonly projectId: ProjectId;
  readonly sourceThreadId: ThreadId | null;
  readonly modelSelections: readonly ModelSelection[];
  readonly worktreePaths: readonly string[];
}): Array<{
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly worktreePath: string;
  readonly creationSource: "race";
  readonly raceId: string;
  readonly sourceThreadId: ThreadId | null;
  readonly projectId: ProjectId;
  readonly envMode: "worktree";
  readonly runtimeMode: "approval-required";
}> {
  if (input.modelSelections.length !== input.worktreePaths.length) {
    throw new Error("Race create payloads require matching model and worktree lists.");
  }
  const models = clampRaceModelSelections(input.modelSelections);
  if (!models) {
    throw new Error(
      `Pick ${RACE_MIN_CANDIDATES}–${RACE_MAX_CANDIDATES} distinct models for a race.`,
    );
  }

  return models.map((modelSelection, index) => ({
    title: buildRaceCandidateTitle(modelSelection),
    modelSelection,
    worktreePath: input.worktreePaths[index]!,
    creationSource: "race" as const,
    raceId: input.raceId,
    sourceThreadId: input.sourceThreadId,
    projectId: input.projectId,
    envMode: "worktree" as const,
    runtimeMode: "approval-required" as const,
  }));
}

export type CreateRaceInput = {
  readonly projectId: ProjectId;
  readonly sourceThreadId: ThreadId | null;
  readonly projectCwd: string;
  readonly worktreeRef: string;
  readonly copyChangesFrom: string | null;
  readonly prompt: string;
  readonly modelSelections: readonly ModelSelection[];
};

export type CreateRaceResult = {
  readonly session: RaceSession;
  readonly candidateThreadIds: readonly ThreadId[];
};

export type CreateRaceDeps = {
  readonly api: Pick<NativeApi, "git"> & {
    readonly orchestration: Pick<
      NativeApi["orchestration"],
      "dispatchCommand" | "getShellSnapshot"
    >;
  };
  readonly syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
  readonly registerSession?: (session: RaceSession) => void;
  readonly generateRaceId?: () => string;
  readonly now?: () => string;
};

type CreatedCandidate = {
  readonly threadId: ThreadId;
  readonly worktreePath: string;
  readonly modelSelection: ModelSelection;
};

export function validateCreateRaceInput(
  input: CreateRaceInput,
): { ok: true; models: ModelSelection[] } | { ok: false; error: string } {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    return { ok: false, error: "Add a prompt before starting a Model Race." };
  }
  if (!input.projectCwd.trim()) {
    return { ok: false, error: "Open a git project before starting a Model Race." };
  }
  if (!input.worktreeRef.trim()) {
    return {
      ok: false,
      error: "Could not resolve a git ref for race worktrees. Check the project branch.",
    };
  }
  const models = clampRaceModelSelections(input.modelSelections);
  if (!models) {
    return {
      ok: false,
      error: `Pick ${RACE_MIN_CANDIDATES}–${RACE_MAX_CANDIDATES} distinct models for a race.`,
    };
  }
  return { ok: true, models };
}

async function compensateCreatedCandidates(
  deps: CreateRaceDeps,
  input: CreateRaceInput,
  created: readonly CreatedCandidate[],
): Promise<void> {
  for (const candidate of [...created].reverse()) {
    try {
      await archiveThreadFromClient(deps.api.orchestration, candidate.threadId);
    } catch {
      // Best-effort compensation; surface the original spawn failure to the user.
    }
    try {
      await deps.api.git.removeWorktree({
        cwd: input.projectCwd,
        path: candidate.worktreePath,
        force: true,
      });
    } catch {
      // Best-effort compensation.
    }
  }
}

export async function createRace(
  input: CreateRaceInput,
  deps: CreateRaceDeps,
): Promise<CreateRaceResult> {
  const validated = validateCreateRaceInput(input);
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  const raceId = deps.generateRaceId?.() ?? randomUUID();
  const createdAt = deps.now?.() ?? new Date().toISOString();
  const created: CreatedCandidate[] = [];
  const candidates: RaceCandidate[] = [];

  try {
    for (const modelSelection of validated.models) {
      const worktree = await deps.api.git.createDetachedWorktree({
        cwd: input.projectCwd,
        ref: input.worktreeRef,
        path: null,
        ...(input.copyChangesFrom ? { copyChangesFrom: input.copyChangesFrom } : {}),
      });

      const threadId = newThreadId();
      const worktreeBranch = worktree.worktree.branch ?? worktree.worktree.ref;
      const createCommand: ThreadCreateCommand = {
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId: input.projectId,
        title: buildRaceCandidateTitle(modelSelection),
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "worktree",
        branch: worktreeBranch,
        worktreePath: worktree.worktree.path,
        workingDirectory: worktree.worktree.path,
        associatedWorktreePath: worktree.worktree.path,
        associatedWorktreeBranch: worktreeBranch,
        associatedWorktreeRef: worktree.worktree.ref,
        creationSource: "race",
        raceId,
        ...(input.sourceThreadId ? { sourceThreadId: input.sourceThreadId } : {}),
        createdAt,
      };

      await deps.api.orchestration.dispatchCommand(createCommand);
      created.push({
        threadId,
        worktreePath: worktree.worktree.path,
        modelSelection,
      });

      await deps.api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: input.prompt.trim(),
          attachments: [],
        },
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      });

      candidates.push({
        threadId,
        modelSelection,
        worktreePath: worktree.worktree.path,
        status: "running",
      });
    }

    const snapshot = await deps.api.orchestration.getShellSnapshot();
    deps.syncServerShellSnapshot(snapshot);

    const session: RaceSession = {
      raceId,
      sourceThreadId: input.sourceThreadId,
      projectId: input.projectId,
      prompt: input.prompt.trim(),
      candidates,
      createdAt,
      winnerThreadId: null,
    };
    (deps.registerSession ?? useRaceSessionStore.getState().registerSession)(session);

    return {
      session,
      candidateThreadIds: candidates.map((candidate) => candidate.threadId),
    };
  } catch (error) {
    await compensateCreatedCandidates(deps, input, created);
    try {
      const snapshot = await deps.api.orchestration.getShellSnapshot();
      deps.syncServerShellSnapshot(snapshot);
    } catch {
      // Ignore snapshot recovery failures after compensation.
    }
    throw error;
  }
}
