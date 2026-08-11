import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const FORK_THREAD_ID = ThreadId.makeUnsafe("thread-fork-1");
const WORKTREE_BRANCH = "feature/worktree";
const WORKTREE_PATH = "/tmp/worktrees/feature-worktree";

const asEventId = (value: string) => EventId.makeUnsafe(value);

async function createProjectReadModel(now: string, kind: "project" | "studio" = "project") {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind,
        title: kind === "studio" ? "Studio" : "Project",
        workspaceRoot: kind === "studio" ? "/tmp/Studio" : "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function createWorktreeThreadReadModel(now: string, kind: "project" | "studio" = "project") {
  const withProject = await createProjectReadModel(now, kind);

  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Worktree thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        envMode: "worktree",
        branch: WORKTREE_BRANCH,
        worktreePath: WORKTREE_PATH,
        associatedWorktreePath: WORKTREE_PATH,
        associatedWorktreeBranch: WORKTREE_BRANCH,
        associatedWorktreeRef: WORKTREE_BRANCH,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        handoff: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

describe("decider worktree metadata", () => {
  it("converts legacy Studio worktreePath input into an ordinary working directory", async () => {
    const now = new Date().toISOString();
    const readModel = await createProjectReadModel(now, "studio");

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-studio-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Studio thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          envMode: "worktree",
          branch: WORKTREE_BRANCH,
          worktreePath: WORKTREE_PATH,
          associatedWorktreePath: WORKTREE_PATH,
          associatedWorktreeBranch: WORKTREE_BRANCH,
          associatedWorktreeRef: WORKTREE_BRANCH,
          createBranchFlowCompleted: true,
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.created");
    if (!event || event.type !== "thread.created") {
      return;
    }

    expect(event.payload).toMatchObject({
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: WORKTREE_PATH,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      createBranchFlowCompleted: false,
    });
  });

  it("self-heals legacy Studio workspace metadata on any meta update", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now, "studio");

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-studio-thread-rename"),
          threadId: THREAD_ID,
          title: "Renamed Studio thread",
          workingDirectory: "/tmp/updated-reference-folder",
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (!event || event.type !== "thread.meta-updated") {
      return;
    }

    expect(event.payload).toMatchObject({
      title: "Renamed Studio thread",
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: "/tmp/updated-reference-folder",
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      createBranchFlowCompleted: false,
    });
  });

  it("preserves the Studio folder during legacy branch-only metadata updates", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now, "studio");

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-studio-legacy-branch-update"),
          threadId: THREAD_ID,
          branch: "feature/another-branch",
          worktreePath: null,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (!event || event.type !== "thread.meta-updated") {
      return;
    }

    expect(event.payload).toMatchObject({
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: WORKTREE_PATH,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      createBranchFlowCompleted: false,
    });
  });

  it("clears the Studio folder only through an explicit working-directory update", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now, "studio");

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-studio-clear-working-directory"),
          threadId: THREAD_ID,
          workingDirectory: null,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (!event || event.type !== "thread.meta-updated") {
      return;
    }

    expect(event.payload.workingDirectory).toBeNull();
  });

  it("derives associated worktree metadata during thread.create when only branch and worktreePath are provided", async () => {
    const now = new Date().toISOString();
    const readModel = await createProjectReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create-derived-worktree"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Worktree thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          envMode: "worktree",
          branch: WORKTREE_BRANCH,
          worktreePath: WORKTREE_PATH,
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.created");
    if (!event || event.type !== "thread.created") {
      return;
    }

    expect(event.payload).toMatchObject({
      associatedWorktreePath: WORKTREE_PATH,
      associatedWorktreeBranch: WORKTREE_BRANCH,
      associatedWorktreeRef: WORKTREE_BRANCH,
    });
  });

  it("derives associated worktree metadata for thread.fork.create as well", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.fork.create",
          commandId: CommandId.makeUnsafe("cmd-thread-fork-derived-worktree"),
          threadId: FORK_THREAD_ID,
          sourceThreadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Forked thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          envMode: "worktree",
          branch: WORKTREE_BRANCH,
          worktreePath: WORKTREE_PATH,
          importedMessages: [],
          createdAt: now,
        },
        readModel,
      }),
    );

    const createdEvent = (Array.isArray(result) ? result : [result])[0];
    expect(createdEvent?.type).toBe("thread.created");
    if (!createdEvent || createdEvent.type !== "thread.created") {
      return;
    }

    expect(createdEvent.payload).toMatchObject({
      title: "Worktree thread (2)",
      associatedWorktreePath: WORKTREE_PATH,
      associatedWorktreeBranch: WORKTREE_BRANCH,
      associatedWorktreeRef: WORKTREE_BRANCH,
    });
  });

  it("preserves purpose-built sidechat titles", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.fork.create",
          commandId: CommandId.makeUnsafe("cmd-sidechat-title"),
          threadId: FORK_THREAD_ID,
          sourceThreadId: THREAD_ID,
          sidechatSourceThreadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Sidechat: Worktree thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          envMode: "local",
          branch: null,
          worktreePath: null,
          importedMessages: [],
          createdAt: now,
        },
        readModel,
      }),
    );

    const createdEvent = (Array.isArray(result) ? result : [result])[0];
    expect(createdEvent?.type).toBe("thread.created");
    if (!createdEvent || createdEvent.type !== "thread.created") {
      return;
    }

    expect(createdEvent.payload.title).toBe("Sidechat: Worktree thread");
  });

  it("does not emit associated worktree clears for unrelated thread.meta.update commands", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-update-title-only"),
          threadId: THREAD_ID,
          title: "Renamed worktree thread",
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (!event || event.type !== "thread.meta-updated") {
      return;
    }

    expect(event.payload).toMatchObject({
      threadId: THREAD_ID,
      title: "Renamed worktree thread",
    });
    expect(event.payload).not.toHaveProperty("associatedWorktreePath");
    expect(event.payload).not.toHaveProperty("associatedWorktreeBranch");
    expect(event.payload).not.toHaveProperty("associatedWorktreeRef");
  });

  it("keeps associated worktree metadata when switching back to local without an explicit clear", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-detach-to-local"),
          threadId: THREAD_ID,
          envMode: "local",
          worktreePath: null,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (!event || event.type !== "thread.meta-updated") {
      return;
    }

    expect(event.payload).toMatchObject({
      threadId: THREAD_ID,
      envMode: "local",
      worktreePath: null,
    });
    expect(event.payload).not.toHaveProperty("associatedWorktreePath");
    expect(event.payload).not.toHaveProperty("associatedWorktreeBranch");
    expect(event.payload).not.toHaveProperty("associatedWorktreeRef");

    const nextReadModel = await Effect.runPromise(
      projectEvent(readModel, {
        ...event,
        sequence: 3,
      }),
    );
    const thread = nextReadModel.threads.find((candidate) => candidate.id === THREAD_ID);

    expect(thread).toMatchObject({
      envMode: "local",
      worktreePath: null,
      associatedWorktreePath: WORKTREE_PATH,
      associatedWorktreeBranch: WORKTREE_BRANCH,
      associatedWorktreeRef: WORKTREE_BRANCH,
    });
  });

  it("still forwards explicit associated worktree clears during thread.meta.update", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-clear-associated-worktree"),
          threadId: THREAD_ID,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (!event || event.type !== "thread.meta-updated") {
      return;
    }

    expect(event.payload).toMatchObject({
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
    });
  });
});

describe("decider user input answers", () => {
  it("omits null answers before resolving provider user input", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.user-input.respond",
          commandId: CommandId.makeUnsafe("cmd-user-input-null-answer"),
          threadId: THREAD_ID,
          requestId: ApprovalRequestId.makeUnsafe("request-1"),
          answers: {
            Language: null,
            Runtime: "Bun",
          },
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.user-input-response-requested");
    if (!event || event.type !== "thread.user-input-response-requested") {
      return;
    }
    expect(event.payload.answers).toEqual({
      Runtime: "Bun",
    });
  });

  it("accepts concrete string and array answers", async () => {
    const now = new Date().toISOString();
    const readModel = await createWorktreeThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.user-input.respond",
          commandId: CommandId.makeUnsafe("cmd-user-input-valid-answer"),
          threadId: THREAD_ID,
          requestId: ApprovalRequestId.makeUnsafe("request-1"),
          answers: {
            Language: "TypeScript",
            Frontend: ["React", "Astro"],
          },
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.user-input-response-requested");
    if (!event || event.type !== "thread.user-input-response-requested") {
      return;
    }
    expect(event.payload.answers).toEqual({
      Language: "TypeScript",
      Frontend: ["React", "Astro"],
    });
  });
});
