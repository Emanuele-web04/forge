// FILE: desktopProjectRecovery.test.ts
// Purpose: Verifies desktop startup detects snapshots where threads outlive visible project rows.

import {
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  hasLiveThreadsWithMissingProjects,
  shouldRepairDesktopProjectSnapshot,
} from "./desktopProjectRecovery";

function makeProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]> = {},
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    kind: "project",
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    scripts: [],
    createdAt: "2026-04-20T08:00:00.000Z",
    updatedAt: "2026-04-20T08:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function makeThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    sidechatLastActivityAt: null,
    sidechatExpiredAt: null,
    lastKnownPr: null,
    latestTurn: null,
    handoff: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    createdAt: "2026-04-20T08:00:00.000Z",
    updatedAt: "2026-04-20T08:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<OrchestrationReadModel> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    spaces: [],
    updatedAt: "2026-04-20T08:00:00.000Z",
    projects: [makeProject()],
    threads: [makeThread()],
    ...overrides,
  };
}

function makeShellSnapshot(
  overrides: Partial<OrchestrationShellSnapshot> = {},
): OrchestrationShellSnapshot {
  const project = makeProject();
  const thread = makeThread();
  return {
    snapshotSequence: 1,
    spaces: [],
    updatedAt: "2026-04-20T08:00:00.000Z",
    projects: [
      {
        id: project.id,
        kind: project.kind,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModelSelection: project.defaultModelSelection,
        scripts: project.scripts,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    ],
    threads: [
      {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        envMode: thread.envMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        associatedWorktreePath: thread.associatedWorktreePath,
        associatedWorktreeBranch: thread.associatedWorktreeBranch,
        associatedWorktreeRef: thread.associatedWorktreeRef,
        createBranchFlowCompleted: thread.createBranchFlowCompleted,
        parentThreadId: thread.parentThreadId,
        subagentAgentId: thread.subagentAgentId,
        subagentNickname: thread.subagentNickname,
        subagentRole: thread.subagentRole,
        forkSourceThreadId: thread.forkSourceThreadId,
        sidechatSourceThreadId: thread.sidechatSourceThreadId,
        sidechatLastActivityAt: thread.sidechatLastActivityAt,
        sidechatExpiredAt: thread.sidechatExpiredAt,
        lastKnownPr: thread.lastKnownPr,
        latestTurn: thread.latestTurn,
        latestUserMessageAt: thread.latestUserMessageAt,
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
        hasActionableProposedPlan: thread.hasActionableProposedPlan,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt,
        handoff: thread.handoff,
        session: thread.session,
      },
    ],
    ...overrides,
  };
}

describe("desktopProjectRecovery", () => {
  it("does not repair a valid empty first-run snapshot", () => {
    expect(
      shouldRepairDesktopProjectSnapshot(
        makeShellSnapshot({
          projects: [],
          threads: [],
        }),
      ),
    ).toBe(false);
  });

  it("repairs an empty shell only when the server found an active durable project", () => {
    expect(
      shouldRepairDesktopProjectSnapshot(
        makeShellSnapshot({
          requiresEmptyProjectShellRepair: true,
          projects: [],
          threads: [],
        }),
      ),
    ).toBe(true);
    expect(
      shouldRepairDesktopProjectSnapshot(
        makeShellSnapshot({ requiresEmptyProjectShellRepair: true }),
      ),
    ).toBe(false);
  });

  it("returns false when live threads still have live project rows", () => {
    const snapshot = makeSnapshot();

    expect(hasLiveThreadsWithMissingProjects(snapshot)).toBe(false);
  });

  it("returns true when a live thread references a missing project row", () => {
    const snapshot = makeSnapshot({
      projects: [],
    });

    expect(hasLiveThreadsWithMissingProjects(snapshot)).toBe(true);
  });

  it("returns true when a live thread references a deleted project row", () => {
    const snapshot = makeSnapshot({
      projects: [makeProject({ deletedAt: "2026-04-20T09:00:00.000Z" })],
    });

    expect(hasLiveThreadsWithMissingProjects(snapshot)).toBe(true);
  });

  it("ignores deleted threads when deciding whether repair is needed", () => {
    const snapshot = makeSnapshot({
      projects: [],
      threads: [makeThread({ deletedAt: "2026-04-20T09:00:00.000Z" })],
    });

    expect(hasLiveThreadsWithMissingProjects(snapshot)).toBe(false);
  });

  it("accepts shell snapshots that do not carry deleted markers", () => {
    expect(hasLiveThreadsWithMissingProjects(makeShellSnapshot())).toBe(false);
    expect(hasLiveThreadsWithMissingProjects(makeShellSnapshot({ projects: [] }))).toBe(true);
  });
});
