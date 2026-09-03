import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

describe("decider project scripts", () => {
  it("emits empty scripts on project.create", async () => {
    const now = new Date().toISOString();
    const readModel = createEmptyReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it("retires all empty project shells before recreating a workspace root", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withFirstProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-stale-project-a"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-stale-a"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stale-project-a"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stale-project-a"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-stale-a"),
          title: "Stale A",
          workspaceRoot: "/tmp/recreate-root",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withFirstProject, {
        sequence: 2,
        eventId: asEventId("evt-stale-project-b"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-stale-b"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stale-project-b"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stale-project-b"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-stale-b"),
          title: "Stale B",
          workspaceRoot: "/tmp/recreate-root",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-recreate"),
          projectId: asProjectId("project-recreated"),
          title: "Recreated",
          workspaceRoot: "/tmp/recreate-root",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "project.deleted",
      "project.deleted",
      "project.created",
    ]);
    expect(events.map((event) => (event.payload as { projectId: ProjectId }).projectId)).toEqual([
      asProjectId("project-stale-a"),
      asProjectId("project-stale-b"),
      asProjectId("project-recreated"),
    ]);
  });

  it("blocks on the project with saved threads before retiring empty duplicate shells", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withStaleProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-mixed-stale-project"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-mixed-stale"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-mixed-stale-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-mixed-stale-project"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-mixed-stale"),
          title: "Mixed Stale",
          workspaceRoot: "/tmp/mixed-root",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withActiveProject = await Effect.runPromise(
      projectEvent(withStaleProject, {
        sequence: 2,
        eventId: asEventId("evt-mixed-active-project"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-mixed-active"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-mixed-active-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-mixed-active-project"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-mixed-active"),
          title: "Mixed Active",
          workspaceRoot: "/tmp/mixed-root",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withActiveProject, {
        sequence: 3,
        eventId: asEventId("evt-mixed-active-thread"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-mixed-active"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-mixed-active-thread"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-mixed-active-thread"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-mixed-active"),
          projectId: asProjectId("project-mixed-active"),
          title: "Saved chat",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          handoff: null,
          envMode: "local",
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.makeUnsafe("cmd-project-mixed-recreate"),
            projectId: asProjectId("project-mixed-recreated"),
            title: "Mixed Recreated",
            workspaceRoot: "/tmp/mixed-root",
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("Project 'project-mixed-active' already uses workspace root");
  });

  it("propagates scripts in project.meta.update payload", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const scripts = [
      {
        id: "lint",
        name: "Lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ] as const;

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
  });

  it("rejects pinning more than three active projects", async () => {
    const now = new Date().toISOString();
    let readModel = createEmptyReadModel(now);

    for (const index of [1, 2, 3, 4]) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, {
          sequence: index,
          eventId: asEventId(`evt-project-pin-${index}`),
          aggregateKind: "project",
          aggregateId: asProjectId(`project-pin-${index}`),
          type: "project.created",
          occurredAt: now,
          commandId: CommandId.makeUnsafe(`cmd-project-pin-${index}`),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe(`cmd-project-pin-${index}`),
          metadata: {},
          payload: {
            projectId: asProjectId(`project-pin-${index}`),
            title: `Project Pin ${index}`,
            workspaceRoot: `/tmp/project-pin-${index}`,
            defaultModelSelection: null,
            scripts: [],
            isPinned: index <= 3,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
    }

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-project-pin-fourth"),
            projectId: asProjectId("project-pin-4"),
            isPinned: true,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("Only 3 projects can be pinned at once.");

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-project-repin-existing"),
          projectId: asProjectId("project-pin-1"),
          isPinned: true,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
  });

  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          handoff: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload.assistantDeliveryMode).toBe("streaming");
    expect(turnStartEvent.payload).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: asMessageId("message-user-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "approval-required",
    });
  });

  it("emits thread.runtime-mode-set from thread.runtime-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          handoff: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.makeUnsafe("cmd-runtime-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single runtime-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.runtime-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
      },
    });
  });

  it("emits thread.interaction-mode-set from thread.interaction-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          handoff: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe("cmd-interaction-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          interactionMode: "plan",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single interaction-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.interaction-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        previousInteractionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        interactionMode: "plan",
      },
    });
  });

  it("rejects re-handoff when the source handoff thread has no native chat messages yet", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-handoff"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-handoff"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-handoff"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-handoff"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-handoff"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withThread = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create-handoff"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-handoff"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create-handoff"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create-handoff"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-handoff"),
          projectId: asProjectId("project-handoff"),
          title: "Handoff",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          handoff: {
            sourceThreadId: ThreadId.makeUnsafe("thread-original"),
            sourceProvider: "claudeAgent",
            importedAt: now,
            bootstrapStatus: "pending",
          },
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withThread, {
        sequence: 3,
        eventId: asEventId("evt-thread-imported-message"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-handoff"),
        type: "thread.message-sent",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-imported-message"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-imported-message"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-handoff"),
          messageId: asMessageId("message-imported-1"),
          role: "user",
          text: "Imported history",
          turnId: null,
          streaming: false,
          source: "handoff-import",
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.handoff.create",
            commandId: CommandId.makeUnsafe("cmd-thread-rehandoff"),
            threadId: ThreadId.makeUnsafe("thread-handoff-copy"),
            sourceThreadId: ThreadId.makeUnsafe("thread-handoff"),
            projectId: asProjectId("project-handoff"),
            title: "Handoff Copy",
            modelSelection: {
              provider: "claudeAgent",
              model: "sonnet",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            importedMessages: [
              {
                messageId: asMessageId("message-imported-2"),
                role: "user",
                text: "Imported history",
                createdAt: now,
                updatedAt: now,
              },
            ],
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("must contain at least one native chat message after handoff");
  });

  it("allows re-handoff after the handoff thread has native chat messages", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-native-handoff"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-native-handoff"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-native-handoff"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-native-handoff"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-native-handoff"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withThread = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create-native-handoff"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-native-handoff"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create-native-handoff"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create-native-handoff"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-native-handoff"),
          projectId: asProjectId("project-native-handoff"),
          title: "Handoff",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          handoff: {
            sourceThreadId: ThreadId.makeUnsafe("thread-original"),
            sourceProvider: "claudeAgent",
            importedAt: now,
            bootstrapStatus: "completed",
          },
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withImportedMessage = await Effect.runPromise(
      projectEvent(withThread, {
        sequence: 3,
        eventId: asEventId("evt-thread-native-imported-message"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-native-handoff"),
        type: "thread.message-sent",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-native-imported-message"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-native-imported-message"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-native-handoff"),
          messageId: asMessageId("message-native-imported-1"),
          role: "user",
          text: "Imported history",
          turnId: null,
          streaming: false,
          source: "handoff-import",
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withImportedMessage, {
        sequence: 4,
        eventId: asEventId("evt-thread-native-user-message"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-native-handoff"),
        type: "thread.message-sent",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-native-user-message"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-native-user-message"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-native-handoff"),
          messageId: asMessageId("message-native-user-1"),
          role: "user",
          text: "A real new follow-up",
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.handoff.create",
          commandId: CommandId.makeUnsafe("cmd-thread-native-rehandoff"),
          threadId: ThreadId.makeUnsafe("thread-native-handoff-copy"),
          sourceThreadId: ThreadId.makeUnsafe("thread-native-handoff"),
          projectId: asProjectId("project-native-handoff"),
          title: "Handoff Copy",
          modelSelection: {
            provider: "claudeAgent",
            model: "sonnet",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          importedMessages: [
            {
              messageId: asMessageId("message-native-imported-2"),
              role: "user",
              text: "Imported history",
              createdAt: now,
              updatedAt: now,
            },
            {
              messageId: asMessageId("message-native-imported-3"),
              role: "user",
              text: "A real new follow-up",
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.type).toBe("thread.created");
    expect(events[1]?.type).toBe("thread.message-sent");
  });
});
