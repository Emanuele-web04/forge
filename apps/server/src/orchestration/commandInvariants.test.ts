import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireProjectHasNoThreads,
  requireThread,
  requireThreadAbsent,
  requireThreadArchived,
  requireThreadNotArchived,
  threadHasActiveTurn,
  threadHasInFlightTurn,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  spaces: [],
  projects: [
    {
      id: ProjectId.makeUnsafe("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.makeUnsafe("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-a"),
      title: "Thread A",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      latestTurn: null,
      handoff: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.makeUnsafe("thread-2"),
      projectId: ProjectId.makeUnsafe("project-b"),
      title: "Thread B",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      latestTurn: null,
      handoff: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.makeUnsafe("thread-archived"),
      projectId: ProjectId.makeUnsafe("project-a"),
      title: "Archived Thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
      latestTurn: null,
      handoff: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.makeUnsafe("thread-deleted"),
      projectId: ProjectId.makeUnsafe("project-a"),
      title: "Deleted Thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      latestTurn: null,
      handoff: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: now,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.makeUnsafe("cmd-1"),
  threadId: ThreadId.makeUnsafe("thread-1"),
  message: {
    messageId: MessageId.makeUnsafe("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.makeUnsafe("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.makeUnsafe("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.makeUnsafe("project-b")).map(
        (thread) => thread.id,
      ),
    ).toEqual([ThreadId.makeUnsafe("thread-2")]);
  });

  it("threadHasActiveTurn trusts an active session turn or a running latest turn", () => {
    const activeTurn = { activeTurnId: TurnId.makeUnsafe("turn-x") };
    expect(threadHasActiveTurn({ session: activeTurn, latestTurn: null })).toBe(true);
    expect(threadHasActiveTurn({ session: null, latestTurn: { state: "running" } })).toBe(true);
    expect(threadHasActiveTurn({ session: null, latestTurn: { state: "completed" } })).toBe(false);
    expect(threadHasActiveTurn({ session: { activeTurnId: null }, latestTurn: null })).toBe(false);
    expect(
      threadHasActiveTurn({
        session: { activeTurnId: TurnId.makeUnsafe("turn-x") },
        latestTurn: { state: "completed" },
      }),
    ).toBe(true);
  });

  it("threadHasInFlightTurn includes starting/running sessions that active-turn misses", () => {
    const runningSession = {
      status: "running" as const,
      activeTurnId: TurnId.makeUnsafe("turn-x"),
    };
    expect(
      threadHasInFlightTurn({ session: runningSession, latestTurn: { state: "completed" } }),
    ).toBe(true);
    expect(threadHasInFlightTurn({ session: null, latestTurn: { state: "completed" } })).toBe(
      false,
    );
    const errored = { status: "error" as const, activeTurnId: TurnId.makeUnsafe("turn-x") };
    expect(threadHasInFlightTurn({ session: errored, latestTurn: null })).toBe(false);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.makeUnsafe("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.makeUnsafe("thread-deleted"),
        }),
      ),
    ).rejects.toThrow("was deleted");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-2"),
          threadId: ThreadId.makeUnsafe("thread-3"),
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "new",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.makeUnsafe("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-3"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            projectId: ProjectId.makeUnsafe("project-a"),
            title: "dup",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });

  it("requires thread to be archived for unarchive command", async () => {
    const archiveCommand: OrchestrationCommand = {
      type: "thread.unarchive",
      commandId: CommandId.makeUnsafe("cmd-unarchive"),
      threadId: ThreadId.makeUnsafe("thread-archived"),
    };

    // Should succeed for archived thread
    const thread = await Effect.runPromise(
      requireThreadArchived({
        readModel,
        command: archiveCommand,
        threadId: ThreadId.makeUnsafe("thread-archived"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-archived"));

    // Should fail for non-archived thread
    await expect(
      Effect.runPromise(
        requireThreadArchived({
          readModel,
          command: archiveCommand,
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).rejects.toThrow("is not archived");
  });

  it("requires thread to not be archived for archive command", async () => {
    const archiveCommand: OrchestrationCommand = {
      type: "thread.archive",
      commandId: CommandId.makeUnsafe("cmd-archive"),
      threadId: ThreadId.makeUnsafe("thread-1"),
    };

    // Should succeed for non-archived thread
    const thread = await Effect.runPromise(
      requireThreadNotArchived({
        readModel,
        command: archiveCommand,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-1"));

    // Should fail for already archived thread
    await expect(
      Effect.runPromise(
        requireThreadNotArchived({
          readModel,
          command: archiveCommand,
          threadId: ThreadId.makeUnsafe("thread-archived"),
        }),
      ),
    ).rejects.toThrow("is already archived");
  });

  it("requires project to have no remaining threads before delete", async () => {
    const deleteCommand: OrchestrationCommand = {
      type: "project.delete",
      commandId: CommandId.makeUnsafe("cmd-project-delete"),
      projectId: ProjectId.makeUnsafe("project-a"),
    };

    await expect(
      Effect.runPromise(
        requireProjectHasNoThreads({
          readModel,
          command: deleteCommand,
          projectId: ProjectId.makeUnsafe("project-a"),
        }),
      ),
    ).rejects.toThrow("still has 2 threads");

    await expect(
      Effect.runPromise(
        requireProjectHasNoThreads({
          readModel,
          command: deleteCommand,
          projectId: ProjectId.makeUnsafe("project-missing"),
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
