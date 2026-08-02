// FILE: raceSessionStore.ts
// Purpose: Client-side Model Race session state for Best-of-N candidate threads.
// Layer: Web UI state store
// Exports: race session types and zustand store helpers.

import type { ModelSelection, ProjectId, ThreadId } from "@synara/contracts";
import { create } from "zustand";

export type RaceCandidateStatus = "starting" | "running" | "settled" | "failed" | "archived";

export interface RaceCandidate {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly worktreePath: string;
  readonly status: RaceCandidateStatus;
}

export interface RaceSession {
  readonly raceId: string;
  readonly sourceThreadId: ThreadId | null;
  readonly projectId: ProjectId;
  readonly prompt: string;
  readonly candidates: readonly RaceCandidate[];
  readonly createdAt: string;
  readonly winnerThreadId: ThreadId | null;
}

interface RaceSessionStore {
  readonly sessionsById: Record<string, RaceSession | undefined>;
  readonly raceIdByThreadId: Record<string, string | undefined>;
  registerSession: (session: RaceSession) => void;
  updateCandidateStatus: (raceId: string, threadId: ThreadId, status: RaceCandidateStatus) => void;
  markWinner: (raceId: string, winnerThreadId: ThreadId) => void;
  clearSession: (raceId: string) => void;
  getSessionForThread: (threadId: ThreadId) => RaceSession | null;
}

export const useRaceSessionStore = create<RaceSessionStore>((set, get) => ({
  sessionsById: {},
  raceIdByThreadId: {},

  registerSession: (session) => {
    set((state) => {
      const raceIdByThreadId = { ...state.raceIdByThreadId };
      for (const candidate of session.candidates) {
        raceIdByThreadId[candidate.threadId] = session.raceId;
      }
      return {
        sessionsById: {
          ...state.sessionsById,
          [session.raceId]: session,
        },
        raceIdByThreadId,
      };
    });
  },

  updateCandidateStatus: (raceId, threadId, status) => {
    set((state) => {
      const existing = state.sessionsById[raceId];
      if (!existing) {
        return state;
      }
      const candidates = existing.candidates.map((candidate) =>
        candidate.threadId === threadId ? { ...candidate, status } : candidate,
      );
      return {
        ...state,
        sessionsById: {
          ...state.sessionsById,
          [raceId]: { ...existing, candidates },
        },
      };
    });
  },

  markWinner: (raceId, winnerThreadId) => {
    set((state) => {
      const existing = state.sessionsById[raceId];
      if (!existing) {
        return state;
      }
      const candidates = existing.candidates.map((candidate) =>
        candidate.threadId === winnerThreadId
          ? candidate
          : { ...candidate, status: "archived" as const },
      );
      return {
        ...state,
        sessionsById: {
          ...state.sessionsById,
          [raceId]: {
            ...existing,
            candidates,
            winnerThreadId,
          },
        },
      };
    });
  },

  clearSession: (raceId) => {
    set((state) => {
      const existing = state.sessionsById[raceId];
      if (!existing) {
        return state;
      }
      const sessionsById = { ...state.sessionsById };
      delete sessionsById[raceId];
      const raceIdByThreadId = { ...state.raceIdByThreadId };
      for (const candidate of existing.candidates) {
        if (raceIdByThreadId[candidate.threadId] === raceId) {
          delete raceIdByThreadId[candidate.threadId];
        }
      }
      return { sessionsById, raceIdByThreadId };
    });
  },

  getSessionForThread: (threadId) => {
    const raceId = get().raceIdByThreadId[threadId];
    if (!raceId) {
      return null;
    }
    return get().sessionsById[raceId] ?? null;
  },
}));

export function selectRaceSessionForThread(
  state: RaceSessionStore,
  threadId: ThreadId,
): RaceSession | null {
  const raceId = state.raceIdByThreadId[threadId];
  if (!raceId) {
    return null;
  }
  return state.sessionsById[raceId] ?? null;
}
