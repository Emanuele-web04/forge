// FILE: createRace.test.ts
// Purpose: Unit tests for Model Race planning and validation helpers.

import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId, type ModelSelection } from "@synara/contracts";

import {
  areRaceModelsDistinct,
  buildRaceCandidateTitle,
  clampRaceModelSelections,
  planRaceCandidateCreates,
  RACE_MAX_CANDIDATES,
  RACE_MIN_CANDIDATES,
  validateCreateRaceInput,
} from "./createRace";

function codexSelection(model: string): ModelSelection {
  return {
    provider: "codex",
    model,
    options: { reasoningEffort: "medium", fastMode: false },
  };
}

function claudeSelection(model: string): ModelSelection {
  return {
    provider: "claudeAgent",
    model,
    options: { effort: "medium" },
  };
}

describe("createRace planning", () => {
  it("requires 2–3 distinct models", () => {
    expect(clampRaceModelSelections([codexSelection("gpt-5")])).toBeNull();
    expect(clampRaceModelSelections([codexSelection("gpt-5"), codexSelection("gpt-5")])).toBeNull();
    expect(
      clampRaceModelSelections([
        codexSelection("gpt-5"),
        claudeSelection("claude-opus-4"),
        codexSelection("o3"),
        claudeSelection("claude-sonnet-4"),
      ]),
    ).toBeNull();
    expect(
      clampRaceModelSelections([codexSelection("gpt-5"), claudeSelection("claude-opus-4")]),
    ).toHaveLength(RACE_MIN_CANDIDATES);
    expect(
      clampRaceModelSelections([
        codexSelection("gpt-5"),
        claudeSelection("claude-opus-4"),
        codexSelection("o3"),
      ]),
    ).toHaveLength(RACE_MAX_CANDIDATES);
  });

  it("treats same provider+model as non-distinct even with different options", () => {
    expect(
      areRaceModelsDistinct([
        codexSelection("gpt-5"),
        {
          provider: "codex",
          model: "gpt-5",
          options: { reasoningEffort: "high", fastMode: true },
        },
      ]),
    ).toBe(false);
  });

  it("builds Race · <model> titles and worktree create plans", () => {
    const models = [codexSelection("gpt-5"), claudeSelection("claude-opus-4")];
    const planned = planRaceCandidateCreates({
      raceId: "race-1",
      projectId: ProjectId.makeUnsafe("project-1"),
      sourceThreadId: ThreadId.makeUnsafe("thread-source"),
      modelSelections: models,
      worktreePaths: ["/tmp/wt-a", "/tmp/wt-b"],
    });

    expect(planned).toHaveLength(2);
    expect(planned[0]?.creationSource).toBe("race");
    expect(planned[0]?.raceId).toBe("race-1");
    expect(planned[0]?.envMode).toBe("worktree");
    expect(planned[0]?.runtimeMode).toBe("approval-required");
    expect(planned[0]?.worktreePath).toBe("/tmp/wt-a");
    expect(buildRaceCandidateTitle(models[0]!)).toMatch(/^Race · /);
  });

  it("validates prompt, cwd, and ref before spawn", () => {
    expect(
      validateCreateRaceInput({
        projectId: ProjectId.makeUnsafe("project-1"),
        sourceThreadId: null,
        projectCwd: "/repo",
        worktreeRef: "main",
        copyChangesFrom: null,
        prompt: "  ",
        modelSelections: [codexSelection("gpt-5"), claudeSelection("claude-opus-4")],
      }).ok,
    ).toBe(false);

    expect(
      validateCreateRaceInput({
        projectId: ProjectId.makeUnsafe("project-1"),
        sourceThreadId: null,
        projectCwd: "",
        worktreeRef: "main",
        copyChangesFrom: null,
        prompt: "fix the bug",
        modelSelections: [codexSelection("gpt-5"), claudeSelection("claude-opus-4")],
      }).ok,
    ).toBe(false);

    const ok = validateCreateRaceInput({
      projectId: ProjectId.makeUnsafe("project-1"),
      sourceThreadId: null,
      projectCwd: "/repo",
      worktreeRef: "main",
      copyChangesFrom: null,
      prompt: "fix the bug",
      modelSelections: [codexSelection("gpt-5"), claudeSelection("claude-opus-4")],
    });
    expect(ok.ok).toBe(true);
  });
});
