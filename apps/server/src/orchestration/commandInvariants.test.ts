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

type ProjectShell = OrchestrationReadModel["projects"][number];
type ThreadShell = OrchestrationReadModel["threads"][number];

const project = (id: string): ProjectShell => ({
  id: ProjectId.makeUnsafe(id),
  title: `Project ${id.slice(-1).toUpperCase()}`,
  workspaceRoot: `/tmp/${id}`,
  defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
  scripts: [],
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
});

const thread = (id: string, extra: Partial<ThreadShell> = {}): ThreadShell => ({
  id: ThreadId.makeUnsafe(id),
  projectId: ProjectId.makeUnsafe("project-a"),
  title: `Thread ${id}`,
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "full-access" as const,
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
  ...extra,
});

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  spaces: [],
  projects: [project("project-a"), project("project-b")],
  threads: [
    thread("thread-1"),
    { ...thread("thread-2"), projectId: ProjectId.makeUnsafe("project-b") },
    thread("thread-archived", { archivedAt: now }),
    thread("thread-deleted", { deletedAt: now }),
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

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);

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
    const threadResult = await run(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(threadResult.id).toBe(ThreadId.makeUnsafe("thread-1"));

    await expect(
      run(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.makeUnsafe("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");

    await expect(
      run(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.makeUnsafe("thread-deleted"),
        }),
      ),
    ).rejects.toThrow("was deleted");
  });

  it("requires missing thread for create flows", async () => {
    const createCommand = (commandId: string, threadId: string, title: string) =>
      ({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(commandId),
        threadId: ThreadId.makeUnsafe(threadId),
        projectId: ProjectId.makeUnsafe("project-a"),
        title,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }) as OrchestrationCommand;

    await run(
      requireThreadAbsent({
        readModel,
        command: createCommand("cmd-2", "thread-3", "new"),
        threadId: ThreadId.makeUnsafe("thread-3"),
      }),
    );

    await expect(
      run(
        requireThreadAbsent({
          readModel,
          command: createCommand("cmd-3", "thread-1", "dup"),
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires non-negative integers", async () => {
    await run(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      run(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });

  it.each([
    {
      label: "requires thread to be archived for unarchive command",
      type: "thread.unarchive",
      invariant: requireThreadArchived,
      okThreadId: "thread-archived",
      failThreadId: "thread-1",
      failError: "is not archived",
    },
    {
      label: "requires thread to not be archived for archive command",
      type: "thread.archive",
      invariant: requireThreadNotArchived,
      okThreadId: "thread-1",
      failThreadId: "thread-archived",
      failError: "is already archived",
    },
  ])("$label", async ({ type, invariant, okThreadId, failThreadId, failError }) => {
    const command: OrchestrationCommand = {
      type,
      commandId: CommandId.makeUnsafe(`cmd-${type}`),
      threadId: ThreadId.makeUnsafe(okThreadId),
    } as OrchestrationCommand;

    const okThread = await run(
      invariant({ readModel, command, threadId: ThreadId.makeUnsafe(okThreadId) }),
    );
    expect(okThread.id).toBe(ThreadId.makeUnsafe(okThreadId));

    await expect(
      run(invariant({ readModel, command, threadId: ThreadId.makeUnsafe(failThreadId) })),
    ).rejects.toThrow(failError);
  });

  it("requires project to have no remaining threads before delete", async () => {
    const deleteCommand: OrchestrationCommand = {
      type: "project.delete",
      commandId: CommandId.makeUnsafe("cmd-project-delete"),
      projectId: ProjectId.makeUnsafe("project-a"),
    };

    await expect(
      run(
        requireProjectHasNoThreads({
          readModel,
          command: deleteCommand,
          projectId: ProjectId.makeUnsafe("project-a"),
        }),
      ),
    ).rejects.toThrow("still has 2 threads");

    await expect(
      run(
        requireProjectHasNoThreads({
          readModel,
          command: deleteCommand,
          projectId: ProjectId.makeUnsafe("project-missing"),
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
