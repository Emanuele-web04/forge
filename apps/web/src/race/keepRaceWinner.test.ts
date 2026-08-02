// FILE: keepRaceWinner.test.ts
// Purpose: Unit tests for Model Race winner promotion helpers.

import { describe, expect, it, vi } from "vitest";
import { ProjectId, ThreadId, type ModelSelection } from "@synara/contracts";

import { keepRaceWinner, resolveRaceLoserThreadIds } from "./keepRaceWinner";
import type { RaceSession } from "./raceSessionStore";

function model(provider: "codex" | "claudeAgent", name: string): ModelSelection {
  if (provider === "codex") {
    return {
      provider,
      model: name,
      options: { reasoningEffort: "medium", fastMode: false },
    };
  }
  return {
    provider,
    model: name,
    options: { effort: "medium" },
  };
}

function session(): RaceSession {
  return {
    raceId: "race-1",
    sourceThreadId: ThreadId.makeUnsafe("source"),
    projectId: ProjectId.makeUnsafe("project-1"),
    prompt: "do the thing",
    createdAt: new Date().toISOString(),
    winnerThreadId: null,
    candidates: [
      {
        threadId: ThreadId.makeUnsafe("winner"),
        modelSelection: model("codex", "gpt-5"),
        worktreePath: "/tmp/wt-winner",
        status: "running",
      },
      {
        threadId: ThreadId.makeUnsafe("loser-a"),
        modelSelection: model("claudeAgent", "claude-opus-4"),
        worktreePath: "/tmp/wt-loser-a",
        status: "running",
      },
      {
        threadId: ThreadId.makeUnsafe("loser-b"),
        modelSelection: model("codex", "o3"),
        worktreePath: "/tmp/wt-loser-b",
        status: "running",
      },
    ],
  };
}

describe("keepRaceWinner", () => {
  it("resolves losers only", () => {
    const race = session();
    expect(resolveRaceLoserThreadIds(race, ThreadId.makeUnsafe("winner"))).toEqual([
      ThreadId.makeUnsafe("loser-a"),
      ThreadId.makeUnsafe("loser-b"),
    ]);
  });

  it("archives losers, keeps the winner id, and clears the session", async () => {
    const race = session();
    const archived: string[] = [];
    const removed: string[] = [];
    const markWinner = vi.fn();
    const clearSession = vi.fn();

    const result = await keepRaceWinner(
      {
        raceId: race.raceId,
        winnerThreadId: ThreadId.makeUnsafe("winner"),
        project: { id: race.projectId, cwd: "/repo" },
        threads: [],
      },
      {
        api: {
          orchestration: {
            dispatchCommand: async (command) => {
              if (command.type === "thread.archive") {
                archived.push(String(command.threadId));
              }
              return { sequence: archived.length };
            },
          },
          git: {
            removeWorktree: async (input) => {
              removed.push(input.path);
            },
          },
        },
        getSession: () => race,
        markWinner,
        clearSession,
      },
    );

    expect(result.winnerThreadId).toBe(ThreadId.makeUnsafe("winner"));
    expect(result.archivedThreadIds).toEqual([
      ThreadId.makeUnsafe("loser-a"),
      ThreadId.makeUnsafe("loser-b"),
    ]);
    expect(archived).toEqual(["loser-a", "loser-b"]);
    expect(removed).toEqual(["/tmp/wt-loser-a", "/tmp/wt-loser-b"]);
    expect(markWinner).toHaveBeenCalledWith("race-1", ThreadId.makeUnsafe("winner"));
    expect(clearSession).toHaveBeenCalledWith("race-1");
  });
});
