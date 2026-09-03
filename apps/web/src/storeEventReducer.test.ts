// FILE: storeEventReducer.test.ts
// Purpose: Exercises orchestration domain-event reduction and batching.

import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  SpaceId,
  ThreadId,
  ThreadMarkerId,
  TurnId,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { applyOrchestrationEvents, applyOrchestrationEventsHotPath } from "./storeEventReducer";
import {
  syncServerShellSnapshot,
  syncServerReadModel,
  syncServerThreadDetailHotPath,
} from "./storeProjection";
import type { AppState } from "./storeState";
import {
  makeThread,
  makeDomainEvent,
  makeActivity,
  makeState,
  makeProject,
  makeReadModelThread,
  makeReadModel,
  makeShellSnapshot,
  threadsOf,
} from "./storeTestFixtures";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";

describe("store event reducer", () => {
  it("hydrates and removes Spaces while clearing matching project assignments", () => {
    const spaceId = SpaceId.makeUnsafe("space-work");
    let state = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("space.created", {
        spaceId,
        name: "Work",
        icon: "bag",
        sortOrder: 0,
        createdAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:00:00.000Z",
      }),
      makeDomainEvent("project.meta-updated", {
        projectId: ProjectId.makeUnsafe("project-1"),
        spaceId,
        updatedAt: "2026-07-15T10:00:01.000Z",
      }),
    ]);

    expect(state.spaces.map((space) => space.id)).toEqual([spaceId]);
    expect(state.projects[0]?.spaceId).toBe(spaceId);

    state = applyOrchestrationEvents(state, [
      makeDomainEvent("space.deleted", {
        spaceId,
        deletedAt: "2026-07-15T10:00:02.000Z",
      }),
    ]);

    expect(state.spaces).toEqual([]);
    expect(state.projects[0]?.spaceId).toBeNull();
    expect(state.projects[0]?.updatedAt).toBe("2026-07-15T10:00:02.000Z");
  });

  it("preserves plugin mention references from live thread.message-sent events", () => {
    const messageId = MessageId.makeUnsafe("message-with-plugin-mention");
    const next = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId,
        role: "user",
        text: "Use @linear",
        attachments: [],
        mentions: [{ name: "linear", path: "plugin://linear@openai-curated" }],
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.messages[0]?.mentions).toEqual([
      { name: "linear", path: "plugin://linear@openai-curated" },
    ]);
  });

  it("updates thread error and marks the running latest turn failed from session-set events", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "provider crashed",
          updatedAt: "2026-02-27T00:02:00.000Z",
        },
      }),
    ]);

    expect(threadsOf(next)[0]?.error).toBe("provider crashed");
    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "error",
      completedAt: "2026-02-27T00:02:00.000Z",
    });
  });

  it("does not settle the running turn while an interrupted session still retains it", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "interrupted",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          lastError: null,
          updatedAt: "2026-02-27T00:02:00.000Z",
        },
      }),
    ]);

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "running",
      completedAt: null,
    });
  });

  it.each([
    { status: "ready", expectedState: "completed" },
    { status: "interrupted", expectedState: "interrupted" },
    { status: "stopped", expectedState: "interrupted" },
  ] as const)(
    "settles the running latest turn when a session-set event leaves running ($status → $expectedState)",
    ({ status, expectedState }) => {
      const initialState = makeState(
        makeThread({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-running"),
            state: "running",
            requestedAt: "2026-02-27T00:01:00.000Z",
            startedAt: "2026-02-27T00:01:05.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      );

      const next = applyOrchestrationEvents(initialState, [
        makeDomainEvent("thread.session-set", {
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-02-27T00:02:00.000Z",
          },
        }),
      ]);

      expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
        turnId: TurnId.makeUnsafe("turn-running"),
        state: expectedState,
        completedAt: "2026-02-27T00:02:00.000Z",
      });
    },
  );

  it("does not settle a running turn from a stale session-set that predates its start", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:01:00.000Z",
        },
      }),
    ]);

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "running",
      completedAt: null,
    });
  });

  it("adds projects immediately from live project.created events", () => {
    const next = applyOrchestrationEvents(
      {
        spaces: [],
        projects: [],
        sidebarThreadSummaryById: {},
        threadsHydrated: false,
      },
      [
        makeDomainEvent(
          "project.created",
          {
            projectId: ProjectId.makeUnsafe("project-live"),
            title: "Live Project",
            workspaceRoot: "/tmp/live-project",
            defaultModelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            scripts: [],
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          { aggregateKind: "project" },
        ),
      ],
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]).toMatchObject({
      id: ProjectId.makeUnsafe("project-live"),
      name: "Live Project",
      remoteName: "Live Project",
      folderName: "live-project",
      cwd: "/tmp/live-project",
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:00.000Z",
    });
  });

  it("updates existing projects immediately from live project.meta-updated events", () => {
    const initialState: AppState = {
      spaces: [],
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-live"),
          name: "Local Name",
          remoteName: "Original Name",
          localName: "Local Name",
          folderName: "original-project",
          cwd: "/tmp/original-project",
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "project.meta-updated",
        {
          projectId: ProjectId.makeUnsafe("project-live"),
          title: "Renamed Remotely",
          workspaceRoot: "/tmp/renamed-project",
          defaultModelSelection: null,
          scripts: [
            {
              id: "lint",
              name: "Lint",
              command: "bun lint",
              icon: "lint",
              runOnWorktreeCreate: false,
            },
          ],
          updatedAt: "2026-02-27T00:05:00.000Z",
        },
        { aggregateKind: "project" },
      ),
    ]);

    expect(next.projects[0]).toMatchObject({
      id: ProjectId.makeUnsafe("project-live"),
      name: "Local Name",
      remoteName: "Renamed Remotely",
      folderName: "renamed-project",
      localName: "Local Name",
      cwd: "/tmp/renamed-project",
      defaultModelSelection: null,
      updatedAt: "2026-02-27T00:05:00.000Z",
      scripts: [
        {
          id: "lint",
          name: "Lint",
          command: "bun lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ],
    });
  });

  it("removes projects immediately from live project.deleted events", () => {
    const next = applyOrchestrationEvents(
      {
        spaces: [],
        projects: [makeProject({ id: ProjectId.makeUnsafe("project-live") })],
        sidebarThreadSummaryById: {},
        threadsHydrated: true,
      },
      [
        makeDomainEvent(
          "project.deleted",
          {
            projectId: ProjectId.makeUnsafe("project-live"),
            deletedAt: "2026-02-27T00:06:00.000Z",
          },
          { aggregateKind: "project" },
        ),
      ],
    );

    expect(next.projects).toEqual([]);
    expect(next.deletedProjectIdsById?.[ProjectId.makeUnsafe("project-live")]).toEqual(
      expect.any(Number),
    );
  });

  it("settles a running latest turn immediately when session stop is requested", () => {
    const initialState = makeState(
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          createdAt: "2026-02-27T00:01:00.000Z",
          updatedAt: "2026-02-27T00:01:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("assistant-running"),
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-stop-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-02-27T00:02:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.session).toMatchObject({
      status: "closed",
      orchestrationStatus: "stopped",
      activeTurnId: undefined,
      updatedAt: "2026-02-27T00:02:00.000Z",
    });
    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "interrupted",
      requestedAt: "2026-02-27T00:01:00.000Z",
      startedAt: "2026-02-27T00:01:05.000Z",
      completedAt: "2026-02-27T00:02:00.000Z",
      assistantMessageId: MessageId.makeUnsafe("assistant-running"),
    });
  });

  it("keeps the latest turn running when interrupt is only requested", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("assistant-running"),
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-interrupt-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-running"),
        createdAt: "2026-02-27T00:02:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "running",
      requestedAt: "2026-02-27T00:01:00.000Z",
      startedAt: "2026-02-27T00:01:05.000Z",
      completedAt: null,
      assistantMessageId: MessageId.makeUnsafe("assistant-running"),
    });
  });

  it("keeps pending proposed-plan linkage across live turn updates", () => {
    const sourceProposedPlan = {
      threadId: ThreadId.makeUnsafe("thread-source"),
      planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
    };
    const next = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("thread.turn-start-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-message"),
        runtimeMode: "full-access",
        interactionMode: DEFAULT_INTERACTION_MODE,
        dispatchMode: "queue",
        createdAt: "2026-02-27T00:01:00.000Z",
        sourceProposedPlan,
      }),
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-message"),
        role: "assistant",
        text: "Done",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        createdAt: "2026-02-27T00:01:05.000Z",
        updatedAt: "2026-02-27T00:01:06.000Z",
        attachments: [],
        source: "native",
      }),
    ]);

    expect(threadsOf(next)[0]?.pendingSourceProposedPlan).toEqual(sourceProposedPlan);
    expect(threadsOf(next)[0]?.latestTurn?.sourceProposedPlan).toEqual(sourceProposedPlan);
  });

  it("does not adopt runtime/interaction modes from automation-dispatched turns", () => {
    const initialState = makeState(makeThread({ runtimeMode: "approval-required" }));

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-start-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("automation-message"),
        runtimeMode: "full-access",
        interactionMode: DEFAULT_INTERACTION_MODE,
        dispatchMode: "queue",
        dispatchOrigin: "automation",
        createdAt: "2026-02-27T00:01:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.runtimeMode).toBe("approval-required");
  });

  it("adopts runtime mode from user-dispatched turns", () => {
    const initialState = makeState(makeThread({ runtimeMode: "approval-required" }));

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-start-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-message"),
        runtimeMode: "full-access",
        interactionMode: DEFAULT_INTERACTION_MODE,
        dispatchMode: "queue",
        dispatchOrigin: "user",
        createdAt: "2026-02-27T00:01:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.runtimeMode).toBe("full-access");
  });

  it("replaces streamed assistant text when a non-streaming completion diverges from the local prefix", () => {
    const assistantId = MessageId.makeUnsafe("assistant-message");
    const turnId = TurnId.makeUnsafe("turn-1");
    const localText = "The reply begins here and then drifts.";
    const serverText = "The reply begins here, then continues to the end.";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const initialState = makeState(
        makeThread({
          messages: [
            {
              id: assistantId,
              role: "assistant",
              text: localText,
              turnId,
              createdAt: "2026-02-27T00:01:05.000Z",
              streaming: true,
              source: "native",
            },
          ],
          latestTurn: {
            turnId,
            state: "running",
            requestedAt: "2026-02-27T00:01:00.000Z",
            startedAt: "2026-02-27T00:01:05.000Z",
            completedAt: null,
            assistantMessageId: assistantId,
          },
        }),
      );

      const next = applyOrchestrationEvents(initialState, [
        makeDomainEvent("thread.message-sent", {
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: assistantId,
          role: "assistant",
          text: serverText,
          turnId,
          streaming: false,
          createdAt: "2026-02-27T00:01:05.000Z",
          updatedAt: "2026-02-27T00:01:06.000Z",
          attachments: [],
          source: "native",
        }),
      ]);

      expect(threadsOf(next)[0]?.messages).toMatchObject([
        {
          id: assistantId,
          text: serverText,
          streaming: false,
          completedAt: "2026-02-27T00:01:06.000Z",
        },
      ]);
      expect(threadsOf(next)[0]?.messages[0]?.text).not.toBe(`${localText}${serverText}`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("replaces duplicated local streamed text with the authoritative completion", () => {
    const assistantId = MessageId.makeUnsafe("assistant-message");
    const turnId = TurnId.makeUnsafe("turn-1");
    const serverText = "final text";
    const initialState = makeState(
      makeThread({
        messages: [
          {
            id: assistantId,
            role: "assistant",
            text: `${serverText}${serverText}`,
            turnId,
            createdAt: "2026-02-27T00:01:05.000Z",
            streaming: true,
            source: "native",
          },
        ],
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: assistantId,
        },
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const next = applyOrchestrationEvents(initialState, [
        makeDomainEvent("thread.message-sent", {
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: assistantId,
          role: "assistant",
          text: serverText,
          turnId,
          streaming: false,
          createdAt: "2026-02-27T00:01:05.000Z",
          updatedAt: "2026-02-27T00:01:06.000Z",
          attachments: [],
          source: "native",
        }),
      ]);

      expect(threadsOf(next)[0]?.messages[0]).toMatchObject({
        id: assistantId,
        text: serverText,
        streaming: false,
        completedAt: "2026-02-27T00:01:06.000Z",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("replaces a non-streaming user message when an active-tail edit reuses its message id", () => {
    const userId = MessageId.makeUnsafe("user-active-edit");
    const initialState = makeState(
      makeThread({
        messages: [
          {
            id: userId,
            role: "user",
            text: "old prompt",
            turnId: null,
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: false,
            source: "native",
          },
        ],
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: userId,
        role: "user",
        text: "edited prompt",
        turnId: null,
        streaming: false,
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:05.000Z",
        attachments: [],
        source: "native",
      }),
    ]);

    expect(threadsOf(next)[0]?.messages).toMatchObject([
      {
        id: userId,
        text: "edited prompt",
        streaming: false,
      },
    ]);
  });

  it("applies thread.meta-updated branch metadata immediately during live updates", () => {
    const initialState = makeState(
      makeThread({
        title: "Old title",
        envMode: "worktree",
        branch: "synara/tmp-working",
        worktreePath: "/tmp/project/.worktrees/tmp-working",
        associatedWorktreePath: "/tmp/project/.worktrees/tmp-working",
        associatedWorktreeBranch: "synara/tmp-working",
        associatedWorktreeRef: "synara/tmp-working",
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New title",
        branch: "synara/app-startup-crash",
        worktreePath: "/tmp/project/.worktrees/app-startup-crash",
        associatedWorktreePath: "/tmp/project/.worktrees/app-startup-crash",
        associatedWorktreeBranch: "synara/app-startup-crash",
        associatedWorktreeRef: "synara/app-startup-crash",
        updatedAt: "2026-02-27T00:01:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]).toMatchObject({
      title: "New title",
      branch: "synara/app-startup-crash",
      worktreePath: "/tmp/project/.worktrees/app-startup-crash",
      associatedWorktreePath: "/tmp/project/.worktrees/app-startup-crash",
      associatedWorktreeBranch: "synara/app-startup-crash",
      associatedWorktreeRef: "synara/app-startup-crash",
      session: null,
      updatedAt: "2026-02-27T00:01:00.000Z",
    });
  });

  it("keeps createBranchFlowCompleted sticky for stale thread.meta-updated payloads", () => {
    const initialState = makeState(
      makeThread({
        envMode: "worktree",
        branch: "feature/semantic-branch",
        worktreePath: "/tmp/project/.worktrees/semantic-branch",
        associatedWorktreePath: "/tmp/project/.worktrees/semantic-branch",
        associatedWorktreeBranch: "feature/semantic-branch",
        associatedWorktreeRef: "feature/semantic-branch",
        createBranchFlowCompleted: true,
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        createBranchFlowCompleted: false,
        updatedAt: "2026-02-27T00:01:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.createBranchFlowCompleted).toBe(true);
  });

  it("surfaces thread annotations from a live thread.meta-updated event", () => {
    const initialState = makeState(makeThread());
    const messageId = MessageId.makeUnsafe("assistant-pin-2");
    const pinnedMessages = [
      {
        messageId,
        label: "Check the migration",
        done: false,
        pinnedAt: "2026-02-27T00:02:00.000Z",
      },
    ];

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        pinnedMessages,
        notes: "scratch",
        goal: "Ship the whole feature",
        updatedAt: "2026-02-27T00:02:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.pinnedMessages).toEqual(pinnedMessages);
    expect(threadsOf(next)[0]?.notes).toBe("scratch");
    expect(threadsOf(next)[0]?.goal).toBe("Ship the whole feature");
  });

  it("applies live pinned-message operation events without replacing the whole list", () => {
    const initialState = makeState(makeThread());
    const firstMessageId = MessageId.makeUnsafe("assistant-pin-op-1");
    const secondMessageId = MessageId.makeUnsafe("assistant-pin-op-2");

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.pinned-message-added", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        pin: {
          messageId: firstMessageId,
          label: null,
          done: false,
          pinnedAt: "2026-02-27T00:03:00.000Z",
        },
        updatedAt: "2026-02-27T00:03:00.000Z",
      }),
      makeDomainEvent("thread.pinned-message-added", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        pin: {
          messageId: secondMessageId,
          label: null,
          done: false,
          pinnedAt: "2026-02-27T00:03:05.000Z",
        },
        updatedAt: "2026-02-27T00:03:05.000Z",
      }),
      makeDomainEvent("thread.pinned-message-done-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: firstMessageId,
        done: true,
        updatedAt: "2026-02-27T00:03:10.000Z",
      }),
      makeDomainEvent("thread.pinned-message-label-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: firstMessageId,
        label: "Follow up",
        updatedAt: "2026-02-27T00:03:15.000Z",
      }),
      makeDomainEvent("thread.pinned-message-removed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: secondMessageId,
        updatedAt: "2026-02-27T00:03:20.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.pinnedMessages).toEqual([
      {
        messageId: firstMessageId,
        label: "Follow up",
        done: true,
        pinnedAt: "2026-02-27T00:03:00.000Z",
      },
    ]);
    expect(threadsOf(next)[0]?.updatedAt).toBe("2026-02-27T00:03:20.000Z");
  });

  it("applies live thread marker operation events without replacing the whole list", () => {
    const initialState = makeState(makeThread());
    const markerId = ThreadMarkerId.makeUnsafe("marker-op-1");
    const secondMarkerId = ThreadMarkerId.makeUnsafe("marker-op-2");
    const messageId = MessageId.makeUnsafe("assistant-marker-op");

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.marker-added", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        marker: {
          id: markerId,
          messageId,
          startOffset: 6,
          endOffset: 20,
          selectedText: "important text",
          style: "highlight",
          color: "yellow",
          label: null,
          done: false,
          createdAt: "2026-02-27T00:03:00.000Z",
          updatedAt: "2026-02-27T00:03:00.000Z",
        },
        updatedAt: "2026-02-27T00:03:00.000Z",
      }),
      makeDomainEvent("thread.marker-added", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        marker: {
          id: secondMarkerId,
          messageId,
          startOffset: 30,
          endOffset: 39,
          selectedText: "underline",
          style: "underline",
          color: "blue",
          label: null,
          done: false,
          createdAt: "2026-02-27T00:03:05.000Z",
          updatedAt: "2026-02-27T00:03:05.000Z",
        },
        updatedAt: "2026-02-27T00:03:05.000Z",
      }),
      makeDomainEvent("thread.marker-done-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        markerId,
        done: true,
        updatedAt: "2026-02-27T00:03:10.000Z",
      }),
      makeDomainEvent("thread.marker-label-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        markerId,
        label: "Follow up",
        updatedAt: "2026-02-27T00:03:15.000Z",
      }),
      makeDomainEvent("thread.marker-removed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        markerId: secondMarkerId,
        updatedAt: "2026-02-27T00:03:20.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.threadMarkers).toEqual([
      {
        id: markerId,
        messageId,
        startOffset: 6,
        endOffset: 20,
        selectedText: "important text",
        style: "highlight",
        color: "yellow",
        label: "Follow up",
        done: true,
        createdAt: "2026-02-27T00:03:00.000Z",
        updatedAt: "2026-02-27T00:03:15.000Z",
      },
    ]);
    expect(threadsOf(next)[0]?.updatedAt).toBe("2026-02-27T00:03:20.000Z");
  });

  it("updates turn diffs and latest turn immediately from live events", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        pendingSourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        completedAt: "2026-02-27T00:02:00.000Z",
        status: "ready",
        files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        assistantMessageId: MessageId.makeUnsafe("assistant-message"),
        checkpointTurnCount: 1,
      }),
    ]);

    expect(threadsOf(next)[0]?.turnDiffSummaries).toHaveLength(1);
    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      completedAt: "2026-02-27T00:02:00.000Z",
      assistantMessageId: MessageId.makeUnsafe("assistant-message"),
    });
  });

  it("preserves the previously-recorded assistantMessageId when a turn-diff event arrives with a null id", () => {
    const existingAssistantMessageId = MessageId.makeUnsafe("assistant-real");
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: existingAssistantMessageId,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        completedAt: "2026-02-27T00:02:00.000Z",
        status: "ready",
        files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        assistantMessageId: null,
        checkpointTurnCount: 1,
      }),
    ]);

    expect(threadsOf(next)[0]?.latestTurn?.assistantMessageId).toBe(existingAssistantMessageId);
  });

  it("keeps an active turn running when an interim provider diff placeholder arrives", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        completedAt: "2026-02-27T00:02:00.000Z",
        status: "missing",
        files: [],
        checkpointRef: CheckpointRef.makeUnsafe("provider-diff:event-1"),
        assistantMessageId: null,
        checkpointTurnCount: 1,
      }),
    ]);

    expect(threadsOf(next)[0]?.turnDiffSummaries).toHaveLength(1);
    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "running",
      completedAt: null,
    });
  });

  it("keeps a settled turn intact when a late provider diff placeholder arrives", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: "2026-02-27T00:01:30.000Z",
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        completedAt: "2026-02-27T00:01:31.000Z",
        status: "missing",
        files: [],
        checkpointRef: CheckpointRef.makeUnsafe("provider-diff:event-late"),
        assistantMessageId: null,
        checkpointTurnCount: 1,
      }),
    ]);

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      completedAt: "2026-02-27T00:01:30.000Z",
    });
  });

  it("does not leak the previous turn's assistantMessageId into a null-id summary for a different turn", () => {
    const existingAssistantMessageId = MessageId.makeUnsafe("assistant-turn-1");
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: "2026-02-27T00:01:30.000Z",
          assistantMessageId: existingAssistantMessageId,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-2"),
        completedAt: "2026-02-27T00:02:00.000Z",
        status: "ready",
        files: [{ path: "src/other.ts", kind: "modified", additions: 1, deletions: 0 }],
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-2"),
        assistantMessageId: null,
        checkpointTurnCount: 2,
      }),
    ]);

    // latestTurn is only replaced when turnIds match, so turn-1 stays intact
    // and its real assistantMessageId is preserved (no bleed-through from the
    // turn-2 null payload).
    expect(threadsOf(next)[0]?.latestTurn?.turnId).toBe(TurnId.makeUnsafe("turn-1"));
    expect(threadsOf(next)[0]?.latestTurn?.assistantMessageId).toBe(existingAssistantMessageId);

    const turn2Summary = threadsOf(next)[0]?.turnDiffSummaries.find(
      (entry) => entry.turnId === TurnId.makeUnsafe("turn-2"),
    );
    expect(turn2Summary?.assistantMessageId ?? null).toBeNull();
  });

  it("deduplicates duplicate checkpoint file paths in live turn diff events", () => {
    const initialState = makeState(makeThread());

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        completedAt: "2026-02-27T00:02:00.000Z",
        status: "ready",
        files: [
          { path: "CLAUDE.md", kind: "modified", additions: 1, deletions: 0 },
          { path: "CLAUDE.md", kind: "modified", additions: 0, deletions: 2 },
        ],
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        assistantMessageId: MessageId.makeUnsafe("assistant-message"),
        checkpointTurnCount: 1,
      }),
    ]);

    expect(threadsOf(next)[0]?.turnDiffSummaries[0]?.files).toEqual([
      { path: "CLAUDE.md", kind: "modified", additions: 1, deletions: 2 },
    ]);
  });

  it("cleans thread state on revert and clears pending proposed plans", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "completed",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: "2026-02-27T00:03:00.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        },
        pendingSourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
        },
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "one",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "reply",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:10.000Z",
            completedAt: "2026-02-27T00:00:10.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "two",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-1"),
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "keep",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:05.000Z",
            updatedAt: "2026-02-27T00:00:05.000Z",
          },
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-2"),
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "drop",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:01:05.000Z",
            updatedAt: "2026-02-27T00:01:05.000Z",
          },
        ],
        activities: [
          makeActivity({ id: "activity-1", turnId: "turn-1" }),
          makeActivity({ id: "activity-2", turnId: "turn-2" }),
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:15.000Z",
            status: "ready",
            files: [],
            checkpointTurnCount: 1,
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:03:00.000Z",
            status: "ready",
            files: [],
            checkpointTurnCount: 2,
          },
        ],
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    ]);

    expect(threadsOf(next)[0]?.pendingSourceProposedPlan).toBeUndefined();
    expect(threadsOf(next)[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("user-1"),
      MessageId.makeUnsafe("assistant-1"),
    ]);
    expect(threadsOf(next)[0]?.proposedPlans.map((plan) => plan.id)).toEqual([
      OrchestrationProposedPlanId.makeUnsafe("plan-1"),
    ]);
    expect(threadsOf(next)[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(threadsOf(next)[0]?.latestTurn?.turnId).toBe(TurnId.makeUnsafe("turn-1"));
  });

  it("rolls back conversation state from an edited user message", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "completed",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: "2026-02-27T00:03:00.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        },
        pendingSourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
        },
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "one",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "reply one",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:10.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "two",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-2"),
            role: "assistant",
            text: "reply two",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:01:10.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-2"),
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "drop",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:01:05.000Z",
            updatedAt: "2026-02-27T00:01:05.000Z",
          },
        ],
        activities: [makeActivity({ id: "activity-2", turnId: "turn-2" })],
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:15.000Z",
            status: "ready",
            files: [],
            checkpointTurnCount: 1,
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:03:00.000Z",
            status: "ready",
            files: [],
            checkpointTurnCount: 2,
          },
        ],
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.conversation-rolled-back", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-2"),
        numTurns: 1,
        removedTurnIds: [TurnId.makeUnsafe("turn-2")],
      }),
    ]);

    expect(threadsOf(next)[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("user-1"),
      MessageId.makeUnsafe("assistant-1"),
    ]);
    expect(threadsOf(next)[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.makeUnsafe("turn-1"),
    ]);
    expect(threadsOf(next)[0]?.proposedPlans).toEqual([]);
    expect(threadsOf(next)[0]?.activities).toEqual([]);
    expect(threadsOf(next)[0]?.pendingSourceProposedPlan).toBeUndefined();
    expect(threadsOf(next)[0]?.latestTurn?.turnId).toBe(TurnId.makeUnsafe("turn-1"));
  });

  it("reconciles snapshot state even when thread updatedAt matches a prior live event", () => {
    const sourceProposedPlan = {
      threadId: ThreadId.makeUnsafe("thread-source"),
      planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
    };
    const liveState = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("thread.turn-start-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-message"),
        runtimeMode: "full-access",
        interactionMode: DEFAULT_INTERACTION_MODE,
        dispatchMode: "queue",
        createdAt: "2026-02-27T00:05:00.000Z",
        sourceProposedPlan,
      }),
    ]);

    const next = syncServerReadModel(
      liveState,
      makeReadModel(
        makeReadModelThread({
          updatedAt: "2026-02-27T00:05:00.000Z",
          latestTurn: null,
          session: null,
        }),
      ),
    );

    expect(threadsOf(next)[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
    expect(threadsOf(next)[0]?.latestTurn).toBeNull();
    expect(threadsOf(next)[0]?.pendingSourceProposedPlan).toBeUndefined();
  });

  it("does not rebuild sidebar summaries for streaming assistant deltas", () => {
    const initialState = syncServerReadModel(
      makeState(makeThread({ title: "Stable sidebar title" })),
      makeReadModel(
        makeReadModelThread({
          title: "Stable sidebar title",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const previousSummary = initialState.sidebarThreadSummaryById["thread-1"];
    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-streaming"),
        role: "assistant",
        text: "streaming delta",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:00.000Z",
        attachments: [],
        source: "native",
      }),
    ]);

    expect(next.sidebarThreadSummaryById["thread-1"]).toBe(previousSummary);
    expect(threadsOf(next)[0]?.messages.at(-1)).toMatchObject({
      id: MessageId.makeUnsafe("assistant-streaming"),
      text: "streaming delta",
      streaming: true,
    });
  });

  it("replaces duplicate live activities by id instead of appending duplicate ids", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = makeState(
      makeThread({
        activities: [
          makeActivity({
            id: "activity-command",
            kind: "tool.completed",
            summary: "Ran command",
            payload: { title: "Ran command" },
          }),
        ],
      }),
    );
    const richActivity = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        data: {
          item: {
            type: "commandExecution",
            command: `/bin/zsh -lc "sed -n '1,220p' README.md"`,
          },
        },
      },
    });

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.activity-appended", {
        threadId,
        activity: richActivity,
      }),
    ]);

    expect(threadsOf(next)[0]?.activities).toHaveLength(1);
    expect(threadsOf(next)[0]?.activities[0]?.payload).toEqual(richActivity.payload);
    expect(next.activityIdsByThreadId?.[threadId]).toEqual(["activity-command"]);
    expect(Object.keys(next.activityByThreadId?.[threadId] ?? {})).toEqual(["activity-command"]);
  });

  it("replaces a live reasoning start with completion under its stable activity id", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const activityId = "provider-reasoning:thread-1:reasoning-1";
    const started = makeActivity({
      id: activityId,
      createdAt: "2026-02-27T00:00:01.000Z",
      kind: "task.progress",
      summary: "Reasoning trace",
      tone: "tool",
      payload: {
        status: "inProgress",
        data: { toolCallId: "reasoning-1" },
      },
      turnId: "turn-1",
    });
    const completed = makeActivity({
      id: activityId,
      createdAt: "2026-02-27T00:00:02.000Z",
      kind: "task.progress",
      summary: "Reasoning trace",
      tone: "tool",
      payload: {
        status: "completed",
        detail: "Inspecting apps/web/src/store.ts",
        data: { toolCallId: "reasoning-1" },
      },
      turnId: "turn-1",
    });

    const next = applyOrchestrationEventsHotPath(makeState(makeThread()), [
      makeDomainEvent("thread.activity-appended", { threadId, activity: started }, { sequence: 1 }),
      makeDomainEvent(
        "thread.activity-appended",
        { threadId, activity: completed },
        { sequence: 2 },
      ),
    ]);

    expect(threadsOf(next)[0]?.activities).toHaveLength(1);
    expect(threadsOf(next)[0]?.activities[0]).toMatchObject({
      id: activityId,
      sequence: 2,
      payload: {
        status: "completed",
        detail: "Inspecting apps/web/src/store.ts",
        data: { toolCallId: "reasoning-1" },
      },
    });
    expect(next.activityIdsByThreadId?.[threadId]).toEqual([activityId]);
  });

  it("batch-reduces consecutive activity events without changing the resulting state", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const events = [0, 1, 2].map((index) =>
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({
            id: `activity-batch-${index}`,
            sequence: index + 1,
            kind: "tool.updated",
            summary: `Tool update ${index}`,
            createdAt: `2026-07-09T00:00:0${index}.000Z`,
          }),
        },
        { sequence: index + 1 },
      ),
    );
    const initialState = makeState(makeThread());

    const sequential = events.reduce(
      (state, currentEvent) => applyOrchestrationEventsHotPath(state, [currentEvent]),
      initialState,
    );
    const batched = applyOrchestrationEventsHotPath(initialState, events);

    expect(threadsOf(batched)[0]?.activities).toEqual(threadsOf(sequential)[0]?.activities);
    expect(batched.activityIdsByThreadId?.[threadId]).toEqual(
      sequential.activityIdsByThreadId?.[threadId],
    );
    expect(batched.activityByThreadId?.[threadId]).toEqual(
      sequential.activityByThreadId?.[threadId],
    );
    expect(threadsOf(batched)[0]?.updatedAt).toBe("2026-07-09T00:00:02.000Z");
  });

  it("replaces provider-local activity sequences with durable orchestration sequences", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const events = [
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({ id: "activity-before-restart", sequence: 99 }),
        },
        { sequence: 40 },
      ),
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({ id: "activity-after-restart", sequence: 0 }),
        },
        { sequence: 41 },
      ),
    ];
    const initialState = makeState(makeThread());

    const sequential = events.reduce(
      (state, event) => applyOrchestrationEventsHotPath(state, [event]),
      initialState,
    );
    const batched = applyOrchestrationEventsHotPath(initialState, events);

    expect(threadsOf(sequential)[0]?.activities.map((activity) => activity.sequence)).toEqual([
      40, 41,
    ]);
    expect(threadsOf(batched)[0]?.activities.map((activity) => activity.sequence)).toEqual([
      40, 41,
    ]);
  });

  it("keeps batched activity timestamps equivalent when a generic duplicate is discarded", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const richActivity = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      createdAt: "2026-07-09T00:00:00.000Z",
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        detail: "echo hello",
        data: {
          item: {
            type: "commandExecution",
            command: "echo hello",
          },
        },
      },
    });
    const initialState = makeState(
      makeThread({
        updatedAt: richActivity.createdAt,
        activities: [richActivity],
      }),
    );
    const events = [
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({
            id: "activity-new",
            kind: "tool.updated",
            summary: "New activity",
            createdAt: "2026-07-09T00:00:01.000Z",
          }),
        },
        { sequence: 1 },
      ),
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({
            id: richActivity.id,
            kind: richActivity.kind,
            summary: richActivity.summary,
            createdAt: "2026-07-09T00:00:10.000Z",
            payload: { title: "Ran command" },
          }),
        },
        { sequence: 2 },
      ),
    ];

    const sequential = events.reduce(
      (state, currentEvent) => applyOrchestrationEventsHotPath(state, [currentEvent]),
      initialState,
    );
    const batched = applyOrchestrationEventsHotPath(initialState, events);

    expect(threadsOf(batched)[0]).toEqual(threadsOf(sequential)[0]);
    expect(threadsOf(batched)[0]?.updatedAt).toBe("2026-07-09T00:00:01.000Z");
  });

  it("keeps richer activity payloads when duplicate events arrive with generic data", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const richActivity = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        detail: `/bin/zsh -lc "sed -n '1,220p' README.md"`,
        data: {
          item: {
            type: "commandExecution",
            command: `/bin/zsh -lc "sed -n '1,220p' README.md"`,
            commandActions: [{ type: "read", command: "sed -n '1,220p' README.md" }],
          },
        },
      },
    });
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({ activities: [richActivity] })),
    );
    const genericDuplicate = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { title: "Ran command" },
    });

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.activity-appended", {
        threadId,
        activity: genericDuplicate,
      }),
    ]);

    expect(threadsOf(next)[0]?.activities).toHaveLength(1);
    expect(threadsOf(next)[0]?.activities[0]).toBe(richActivity);
    expect(next.activityByThreadId?.[threadId]?.["activity-command"]).toBe(richActivity);
  });

  it("uses durable user-input settlement without fabricating a resolved activity", () => {
    const initialState = syncServerReadModel(
      makeState(
        makeThread({
          hasPendingUserInput: true,
          activities: [
            makeActivity({
              id: "activity-user-input-requested",
              createdAt: "2026-02-27T00:00:30.000Z",
              kind: "user-input.requested",
              summary: "Need more input",
              payload: {
                requestId: "request-1",
                questions: [
                  {
                    id: "q1",
                    prompt: "Pick one",
                    type: "single_select",
                    options: [{ id: "yes", label: "Yes" }],
                  },
                ],
              },
              sequence: 1,
            }),
          ],
        }),
      ),
      makeReadModel(
        makeReadModelThread({
          hasPendingUserInput: true,
          pendingInteractions: [
            {
              interactionKind: "userInput",
              requestId: ApprovalRequestId.makeUnsafe("request-1"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              turnId: null,
              lifecycleGeneration: "generation-1",
              status: "pending",
              decision: null,
              responseCommandId: null,
              responseRequestedAt: null,
              createdAt: "2026-02-27T00:00:30.000Z",
              resolvedAt: null,
            },
          ],
          activities: [
            makeActivity({
              id: "activity-user-input-requested",
              createdAt: "2026-02-27T00:00:30.000Z",
              kind: "user-input.requested",
              summary: "Need more input",
              payload: {
                requestId: "request-1",
                lifecycleGeneration: "generation-1",
                questions: [
                  {
                    id: "q1",
                    prompt: "Pick one",
                    type: "single_select",
                    options: [{ id: "yes", label: "Yes" }],
                  },
                ],
              },
              sequence: 1,
            }),
          ],
        }),
      ),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "thread.user-input-response-requested",
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId: ApprovalRequestId.makeUnsafe("request-1"),
          answers: {
            q1: "yes",
          },
          lifecycleGeneration: "generation-1",
          createdAt: "2026-02-27T00:01:00.000Z",
        },
        {
          commandId: CommandId.makeUnsafe("command-user-input-response"),
        },
      ),
    ]);

    expect(threadsOf(next)[0]?.hasPendingUserInput).toBe(false);
    expect(threadsOf(next)[0]?.pendingInteractions?.[0]?.status).toBe("responding");
    expect(threadsOf(next)[0]?.pendingInteractions?.[0]?.responseCommandId).toBe(
      CommandId.makeUnsafe("command-user-input-response"),
    );
    expect(
      threadsOf(next)[0]?.activities.some((activity) => activity.kind === "user-input.resolved"),
    ).toBe(false);
    expect(next.sidebarThreadSummaryById["thread-1"]?.hasPendingUserInput).toBe(false);

    const retryable = applyOrchestrationEvents(next, [
      makeDomainEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: makeActivity({
          id: "activity-user-input-retryable",
          kind: "provider.user-input.respond.failed",
          payload: {
            requestId: "request-1",
            lifecycleGeneration: "generation-1",
            responseCommandId: "command-user-input-response",
            settlementStatus: "retryable",
          },
          sequence: 3,
        }),
      }),
    ]);
    expect(threadsOf(retryable)[0]?.pendingInteractions?.[0]?.status).toBe("retryable");
    expect(threadsOf(retryable)[0]?.hasPendingUserInput).toBe(true);

    const confirmed = applyOrchestrationEvents(retryable, [
      makeDomainEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: makeActivity({
          id: "activity-user-input-confirmed",
          kind: "user-input.resolved",
          payload: {
            requestId: "request-1",
            lifecycleGeneration: "generation-1",
          },
          sequence: 4,
        }),
      }),
    ]);
    expect(threadsOf(confirmed)[0]?.pendingInteractions).toEqual([]);
    expect(threadsOf(confirmed)[0]?.hasPendingUserInput).toBe(false);
  });

  it.each([
    {
      label: "uncertain",
      status: "uncertain" as const,
      responseRequestedAt: "2026-07-14T12:20:00.000Z",
    },
    {
      label: "orphaned responding",
      status: "responding" as const,
      responseRequestedAt: "2026-07-14T12:30:00.000Z",
    },
  ])("tracks a reclaimed $label interaction through a retryable failure", (initialClaim) => {
    const requestId = ApprovalRequestId.makeUnsafe(`request-reclaimed-${initialClaim.status}`);
    const lifecycleGeneration = "generation-reclaimed";
    const requestedActivity = makeActivity({
      id: `activity-requested-${initialClaim.status}`,
      createdAt: "2026-07-14T12:19:00.000Z",
      kind: "user-input.requested",
      summary: "Need more input",
      payload: {
        requestId,
        lifecycleGeneration,
        questions: [
          {
            id: "q1",
            header: "Continue",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue the task" }],
          },
        ],
      },
      sequence: 1,
    });
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          hasPendingUserInput: false,
          pendingInteractions: [
            {
              interactionKind: "userInput",
              requestId,
              threadId: ThreadId.makeUnsafe("thread-1"),
              turnId: null,
              lifecycleGeneration,
              status: initialClaim.status,
              decision: null,
              responseCommandId: CommandId.makeUnsafe("command-response-old"),
              responseRequestedAt: initialClaim.responseRequestedAt,
              createdAt: "2026-07-14T12:19:00.000Z",
              resolvedAt: null,
            },
          ],
          activities: [requestedActivity],
        }),
      ),
    );

    const responding = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "thread.user-input-response-requested",
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId,
          answers: { q1: "yes" },
          lifecycleGeneration,
          createdAt: "2026-07-14T12:31:00.000Z",
        },
        { commandId: CommandId.makeUnsafe("command-response-reclaimed") },
      ),
    ]);

    expect(threadsOf(responding)[0]?.pendingInteractions?.[0]).toMatchObject({
      status: "responding",
      responseCommandId: "command-response-reclaimed",
      responseRequestedAt: "2026-07-14T12:31:00.000Z",
    });

    const retryable = applyOrchestrationEvents(responding, [
      makeDomainEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: makeActivity({
          id: `activity-failed-${initialClaim.status}`,
          createdAt: "2026-07-14T12:31:01.000Z",
          kind: "provider.user-input.respond.failed",
          payload: {
            requestId,
            lifecycleGeneration,
            responseCommandId: "command-response-reclaimed",
            settlementStatus: "retryable",
          },
          sequence: 3,
        }),
      }),
    ]);

    expect(threadsOf(retryable)[0]?.pendingInteractions?.[0]?.status).toBe("retryable");
    expect(threadsOf(retryable)[0]?.hasPendingUserInput).toBe(true);
  });

  it("clears pending approval summary state when an approval response is requested", () => {
    const initialState = syncServerReadModel(
      makeState(
        makeThread({
          hasPendingApprovals: true,
          activities: [
            makeActivity({
              id: "activity-approval-requested",
              createdAt: "2026-02-27T00:00:30.000Z",
              kind: "approval.requested",
              summary: "Command approval requested",
              tone: "approval",
              payload: {
                requestId: "request-1",
                requestKind: "command",
              },
              sequence: 1,
            }),
          ],
        }),
      ),
      makeReadModel(
        makeReadModelThread({
          hasPendingApprovals: true,
          pendingInteractions: [
            {
              interactionKind: "approval",
              requestId: ApprovalRequestId.makeUnsafe("request-1"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              turnId: null,
              lifecycleGeneration: "generation-1",
              status: "pending",
              decision: null,
              responseCommandId: null,
              responseRequestedAt: null,
              createdAt: "2026-02-27T00:00:30.000Z",
              resolvedAt: null,
            },
          ],
          activities: [
            makeActivity({
              id: "activity-approval-requested",
              createdAt: "2026-02-27T00:00:30.000Z",
              kind: "approval.requested",
              summary: "Command approval requested",
              tone: "approval",
              payload: {
                requestId: "request-1",
                lifecycleGeneration: "generation-1",
                requestKind: "command",
              },
              sequence: 1,
            }),
          ],
        }),
      ),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "thread.approval-response-requested",
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId: ApprovalRequestId.makeUnsafe("request-1"),
          lifecycleGeneration: "generation-1",
          decision: "accept",
          createdAt: "2026-02-27T00:01:00.000Z",
        },
        {
          commandId: CommandId.makeUnsafe("command-approval-response"),
        },
      ),
    ]);

    expect(threadsOf(next)[0]?.hasPendingApprovals).toBe(false);
    expect(threadsOf(next)[0]?.pendingInteractions?.[0]?.status).toBe("responding");
    expect(next.sidebarThreadSummaryById["thread-1"]?.hasPendingApprovals).toBe(false);
  });

  it("updates sidebar summaries during hot-path archive events", () => {
    const initialState = syncServerReadModel(
      makeState(makeThread({ title: "Archivable thread" })),
      makeReadModel(
        makeReadModelThread({
          title: "Archivable thread",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.archived", {
          threadId: ThreadId.makeUnsafe("thread-1"),
          archivedAt: "2026-02-27T00:07:00.000Z",
          updatedAt: "2026-02-27T00:07:00.000Z",
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(next.sidebarThreadSummaryById["thread-1"]?.archivedAt).toBe("2026-02-27T00:07:00.000Z");
  });

  it("removes archived threads when a delete event reaches the hot path", () => {
    const threadId = ThreadId.makeUnsafe("thread-archived");
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          id: threadId,
          archivedAt: "2026-02-27T00:05:00.000Z",
        }),
      ),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.deleted", {
          threadId,
          deletedAt: "2026-02-27T00:06:00.000Z",
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(threadsOf(next)).toHaveLength(0);
    expect(next.threadIds).not.toContain(threadId);
    expect(next.threadShellById?.[threadId]).toBeUndefined();
    expect(next.sidebarThreadSummaryById[threadId]).toBeUndefined();
    expect(next.deletedThreadIdsById?.[threadId]).toEqual(expect.any(Number));

    const afterStaleSnapshot = syncServerShellSnapshot(
      next,
      makeShellSnapshot({
        id: threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Stale archived thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:30.000Z",
        handoff: null,
        session: null,
      }),
    );
    expect(threadsOf(afterStaleSnapshot)).toHaveLength(0);
    expect(afterStaleSnapshot.threadShellById?.[threadId]).toBeUndefined();
  });

  it("updates sidebar summaries during hot-path thread renames", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = syncServerReadModel(
      makeState(makeThread({ title: "Original title" })),
      makeReadModel(
        makeReadModelThread({
          title: "Original title",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.meta-updated", {
          threadId,
          title: "Renamed title",
          updatedAt: "2026-02-27T00:03:00.000Z",
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(next.sidebarThreadSummaryById[threadId]).toMatchObject({
      title: "Renamed title",
      updatedAt: "2026-02-27T00:03:00.000Z",
    });
    expect(next.threadShellById?.[threadId]?.title).toBe("Renamed title");
    expect(threadsOf(next).find((thread) => thread.id === threadId)?.title).toBe("Renamed title");
  });

  it("updates sidebar summaries when a hot-path session starts running", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-running");
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.session-set", {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-02-27T00:04:00.000Z",
          },
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(next.sidebarThreadSummaryById[threadId]?.session).toMatchObject({
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: turnId,
    });
    expect(next.sidebarThreadSummaryById[threadId]?.latestTurn).toMatchObject({
      turnId,
      state: "running",
      completedAt: null,
    });
  });

  it("projects side chat activity and expiry into the live pane and its parent list row", () => {
    const threadId = ThreadId.makeUnsafe("thread-sidechat");
    const sourceThreadId = ThreadId.makeUnsafe("thread-source");
    const initialActivityAt = "2026-02-27T00:00:00.000Z";
    const latestActivityAt = "2026-02-27T00:30:00.000Z";
    const expiredAt = "2026-02-27T01:30:00.000Z";
    const initialState = syncServerReadModel(
      makeState(
        makeThread({
          id: threadId,
          sidechatSourceThreadId: sourceThreadId,
          sidechatLastActivityAt: initialActivityAt,
          sidechatExpiredAt: null,
        }),
      ),
      makeReadModel(
        makeReadModelThread({
          id: threadId,
          sidechatSourceThreadId: sourceThreadId,
          sidechatLastActivityAt: initialActivityAt,
          sidechatExpiredAt: null,
        }),
      ),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.sidechat-activity-recorded", {
          threadId,
          lastActivityAt: latestActivityAt,
        }),
        makeDomainEvent("thread.sidechat-expired", {
          threadId,
          expectedLastActivityAt: latestActivityAt,
          expiredAt,
        }),
        makeDomainEvent(
          "thread.session-set",
          {
            threadId,
            session: {
              threadId,
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-02-27T01:30:01.000Z",
            },
          },
          { occurredAt: "2026-02-27T01:30:01.000Z" },
        ),
      ],
      { updateSidebarSummary: true },
    );

    expect(threadsOf(next).find((thread) => thread.id === threadId)).toMatchObject({
      sidechatLastActivityAt: latestActivityAt,
      sidechatExpiredAt: expiredAt,
    });
    expect(next.sidebarThreadSummaryById[threadId]).toMatchObject({
      sidechatLastActivityAt: latestActivityAt,
      sidechatExpiredAt: expiredAt,
    });
  });

  it("updates sidebar summaries during hot-path archive events after thread detail sync", () => {
    const shellState = syncServerReadModel(
      makeState(makeThread({ title: "Archivable thread" })),
      makeReadModel(
        makeReadModelThread({
          title: "Archivable thread",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );
    const initialState = syncServerThreadDetailHotPath(
      shellState,
      makeReadModelThread({
        title: "Detail-only title",
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.archived", {
          threadId: ThreadId.makeUnsafe("thread-1"),
          archivedAt: "2026-02-27T00:07:00.000Z",
          updatedAt: "2026-02-27T00:07:00.000Z",
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(next.sidebarThreadSummaryById["thread-1"]?.archivedAt).toBe("2026-02-27T00:07:00.000Z");
  });

  it("preserves outer normalized records when an event is a no-op", () => {
    const state = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({ title: "Thread" })),
    );
    const next = applyOrchestrationEvents(state, [
      makeDomainEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("missing-thread"),
        title: "Ignored",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
    ]);

    expect(next).toBe(state);
    expect(next.threadShellById).toBe(state.threadShellById);
    expect(next.messageByThreadId).toBe(state.messageByThreadId);
    expect(next.activityByThreadId).toBe(state.activityByThreadId);
    expect(next.sidebarThreadSummaryById).toBe(state.sidebarThreadSummaryById);
  });

  it("touches only the streamed message slot and its id list stays reference-stable", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const olderIds = Array.from({ length: 5 }, (_, index) =>
      MessageId.makeUnsafe(`message-${index}`),
    );
    const streamingId = MessageId.makeUnsafe("message-streaming");
    const initialState = makeState(
      makeThread({
        messages: [
          ...olderIds.map((id, index) => ({
            id,
            role: "user" as const,
            text: `prompt ${index}`,
            turnId: null,
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: false,
            source: "native" as const,
          })),
          {
            id: streamingId,
            role: "assistant" as const,
            text: "Hello",
            turnId: null,
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: true,
            source: "native" as const,
          },
        ],
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId,
        messageId: streamingId,
        role: "assistant",
        text: " world",
        turnId: null,
        streaming: true,
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:01.000Z",
        attachments: [],
        source: "native",
      }),
    ]);

    expect(threadsOf(next)[0]?.messages.at(-1)?.text).toBe("Hello world");
    // Only the streamed message is rewritten; every untouched message keeps its identity so
    // memoized message rows do not re-render on each delta.
    for (const id of olderIds) {
      expect(next.messageByThreadId?.[threadId]?.[id]).toBe(
        initialState.messageByThreadId?.[threadId]?.[id],
      );
    }
    expect(next.messageByThreadId?.[threadId]?.[streamingId]).not.toBe(
      initialState.messageByThreadId?.[threadId]?.[streamingId],
    );
    // The id order is unchanged by an in-place update, so the id list must not be rebuilt.
    expect(next.messageIdsByThreadId?.[threadId]).toBe(
      initialState.messageIdsByThreadId?.[threadId],
    );
  });
});
