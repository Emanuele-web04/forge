import { EventId, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  planRestartTurnReconciliation,
  type ReconcilableThread,
} from "./startupTurnReconciliation.ts";

const NOW = "2026-06-14T10:00:00.000Z";

const makeThread = (
  id: string,
  overrides: Partial<Omit<ReconcilableThread, "id">> = {},
): ReconcilableThread => ({
  id: ThreadId.makeUnsafe(id),
  runtimeMode: "full-access",
  session: null,
  latestTurn: null,
  ...overrides,
});

const makeSession = (
  threadId: string,
  overrides: Partial<NonNullable<ReconcilableThread["session"]>> = {},
): NonNullable<ReconcilableThread["session"]> => ({
  threadId: ThreadId.makeUnsafe(threadId),
  status: "running",
  providerName: "grok",
  runtimeMode: "approval-required",
  activeTurnId: TurnId.makeUnsafe(`${threadId}-turn`),
  lastError: null,
  updatedAt: "2026-06-13T09:00:00.000Z",
  ...overrides,
});

const makeActivity = (
  id: string,
  kind: string,
  payload: NonNullable<ReconcilableThread["activities"]>[number]["payload"],
  sequence: number,
): NonNullable<ReconcilableThread["activities"]>[number] => ({
  id: EventId.makeUnsafe(id),
  kind,
  payload,
  sequence,
  createdAt: `2026-06-13T09:00:0${sequence}.000Z`,
});

const expectSessionCommands = (commands: ReturnType<typeof planRestartTurnReconciliation>) =>
  commands.map((command) => {
    expect(command.type).toBe("thread.session.set");
    if (command.type !== "thread.session.set") {
      throw new Error(`expected thread.session.set command, got ${command.type}`);
    }
    return command;
  });

describe("planRestartTurnReconciliation", () => {
  it("returns nothing for an empty thread set", () => {
    expect(planRestartTurnReconciliation({ threads: [], now: NOW })).toEqual([]);
  });

  it("leaves clean threads untouched (no active turn, no in-flight session, no open turn)", () => {
    const threads = [
      makeThread("idle-no-session"),
      makeThread("ready", {
        session: makeSession("ready", { status: "ready", activeTurnId: null }),
        latestTurn: { state: "completed" },
      }),
      makeThread("stopped", {
        session: makeSession("stopped", { status: "stopped", activeTurnId: null }),
        latestTurn: { state: "interrupted" },
      }),
      makeThread("errored", {
        session: makeSession("errored", {
          status: "error",
          activeTurnId: null,
          lastError: "boom",
        }),
        latestTurn: { state: "error" },
      }),
    ];

    expect(planRestartTurnReconciliation({ threads, now: NOW })).toEqual([]);
  });

  it("clears a dangling active turn id while preserving the terminal error session", () => {
    const threads = [
      makeThread("errored", {
        session: makeSession("errored", {
          status: "error",
          activeTurnId: TurnId.makeUnsafe("failed-turn"),
          lastError: "runtime exploded",
        }),
        latestTurn: { state: "error" },
      }),
    ];

    // The turn is already settled, but the retained `activeTurnId` keeps every
    // "is this thread busy?" check true - so the pointer is cleared without
    // rewriting the terminal status or dropping the error banner.
    expect(planRestartTurnReconciliation({ threads, now: NOW })).toEqual([
      {
        type: "thread.session.set",
        commandId: `restart-reconcile-active-turn:errored:${NOW}`,
        threadId: "errored",
        createdAt: NOW,
        session: {
          threadId: "errored",
          status: "error",
          providerName: "grok",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "runtime exploded",
          updatedAt: NOW,
        },
      },
    ]);
  });

  it("marks an unfinished checkpoint revert as failed after restart", () => {
    const thread = makeThread("stale-checkpoint-revert", {
      activities: [
        makeActivity(
          "checkpoint-revert-started",
          "checkpoint.revert.started",
          { turnCount: 1, scope: "thread" },
          1,
        ),
      ],
    });

    expect(planRestartTurnReconciliation({ threads: [thread], now: NOW })).toEqual([
      expect.objectContaining({
        type: "thread.activity.append",
        threadId: "stale-checkpoint-revert",
        activity: expect.objectContaining({ kind: "checkpoint.revert.failed" }),
      }),
    ]);
  });

  it("cleans stale requests from a terminal error without overwriting the error session", () => {
    const threads = [
      makeThread("errored-with-requests", {
        session: makeSession("errored-with-requests", {
          status: "error",
          activeTurnId: TurnId.makeUnsafe("failed-turn"),
          lastError: "runtime exploded",
        }),
        latestTurn: { state: "error" },
        activities: [
          makeActivity(
            "approval-requested-after-error",
            "approval.requested",
            {
              requestId: "approval-after-error",
              requestKind: "command",
            },
            1,
          ),
          makeActivity(
            "input-requested-after-error",
            "user-input.requested",
            {
              requestId: "input-after-error",
              questions: [
                {
                  id: "next_step",
                  header: "Next",
                  question: "How should the failed turn continue?",
                  options: [
                    {
                      label: "Cancel",
                      description: "Stop the stale request.",
                    },
                  ],
                },
              ],
            },
            2,
          ),
        ],
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.activity.append",
      "thread.activity.append",
      "thread.session.set",
    ]);
    expect(commands[0]).toMatchObject({
      commandId: `restart-reconcile:errored-with-requests:approval:approval-after-error:${NOW}`,
    });
    expect(commands[1]).toMatchObject({
      commandId: `restart-reconcile:errored-with-requests:user-input:input-after-error:${NOW}`,
    });
    // Only the stale turn pointer is settled: the error status and its banner survive.
    expect(commands[2]).toEqual({
      type: "thread.session.set",
      commandId: `restart-reconcile-active-turn:errored-with-requests:${NOW}`,
      threadId: "errored-with-requests",
      createdAt: NOW,
      session: {
        threadId: "errored-with-requests",
        status: "error",
        providerName: "grok",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: "runtime exploded",
        updatedAt: NOW,
      },
    });
  });

  it("reconciles a thread whose session still points at an active turn", () => {
    const threads = [
      makeThread("stuck", {
        session: makeSession("stuck", {
          status: "running",
          activeTurnId: TurnId.makeUnsafe("stuck-turn"),
        }),
        latestTurn: { state: "running" },
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command).toEqual({
      type: "thread.session.set",
      commandId: `restart-reconcile:stuck:${NOW}`,
      threadId: "stuck",
      createdAt: NOW,
      session: {
        threadId: "stuck",
        status: "interrupted",
        providerName: "grok",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });
  });

  it("resolves stale pending approval and user-input requests before interrupting the session", () => {
    const threads = [
      makeThread("stuck-with-requests", {
        session: makeSession("stuck-with-requests", {
          status: "running",
          activeTurnId: TurnId.makeUnsafe("stuck-with-requests-turn"),
        }),
        latestTurn: { state: "running" },
        activities: [
          makeActivity(
            "approval-requested",
            "approval.requested",
            {
              requestId: "approval-1",
              requestKind: "command",
            },
            1,
          ),
          makeActivity(
            "approval-requested-resolved",
            "approval.requested",
            {
              requestId: "approval-resolved",
              requestKind: "command",
            },
            2,
          ),
          makeActivity(
            "approval-resolved",
            "approval.resolved",
            {
              requestId: "approval-resolved",
              decision: "cancel",
            },
            3,
          ),
          makeActivity(
            "user-input-requested",
            "user-input.requested",
            {
              requestId: "input-1",
              questions: [
                {
                  id: "next_step",
                  header: "Next",
                  question: "How should the recovered turn continue?",
                  options: [
                    {
                      label: "Cancel",
                      description: "Stop the stale request.",
                    },
                  ],
                },
              ],
            },
            4,
          ),
          makeActivity(
            "user-input-requested-resolved",
            "user-input.requested",
            {
              requestId: "input-resolved",
              questions: [
                {
                  id: "next_step",
                  header: "Next",
                  question: "How should the recovered turn continue?",
                  options: [
                    {
                      label: "Cancel",
                      description: "Stop the stale request.",
                    },
                  ],
                },
              ],
            },
            5,
          ),
          makeActivity(
            "user-input-resolved",
            "user-input.resolved",
            {
              requestId: "input-resolved",
              answers: {},
            },
            6,
          ),
        ],
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });

    expect(commands.map((command) => command.type)).toEqual([
      "thread.activity.append",
      "thread.activity.append",
      "thread.session.set",
    ]);
    expect(commands[0]).toMatchObject({
      type: "thread.activity.append",
      commandId: `restart-reconcile:stuck-with-requests:approval:approval-1:${NOW}`,
      threadId: "stuck-with-requests",
      activity: {
        kind: "provider.approval.respond.failed",
        payload: {
          requestId: "approval-1",
          detail: expect.stringContaining("Stale pending approval request: approval-1"),
        },
      },
    });
    expect(commands[1]).toMatchObject({
      type: "thread.activity.append",
      commandId: `restart-reconcile:stuck-with-requests:user-input:input-1:${NOW}`,
      threadId: "stuck-with-requests",
      activity: {
        kind: "provider.user-input.respond.failed",
        payload: {
          requestId: "input-1",
          detail: expect.stringContaining("Stale pending user-input request: input-1"),
        },
      },
    });
    expect(commands[2]).toMatchObject({
      type: "thread.session.set",
      threadId: "stuck-with-requests",
      session: {
        status: "interrupted",
        activeTurnId: null,
      },
    });
  });

  it("reconciles an in-flight session even with no active turn id (starting/running)", () => {
    const threads = [
      makeThread("starting", {
        session: makeSession("starting", { status: "starting", activeTurnId: null }),
      }),
      makeThread("running-no-turn", {
        session: makeSession("running-no-turn", { status: "running", activeTurnId: null }),
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    const sessionCommands = expectSessionCommands(commands);
    expect(sessionCommands.map((command) => command.threadId)).toEqual([
      "starting",
      "running-no-turn",
    ]);
    expect(sessionCommands.every((command) => command.session.activeTurnId === null)).toBe(true);
    expect(sessionCommands.every((command) => command.session.status === "interrupted")).toBe(true);
  });

  it("heals an open turn projection even when the session already looks terminal", () => {
    const threads = [
      makeThread("orphan-turn", {
        session: makeSession("orphan-turn", { status: "interrupted", activeTurnId: null }),
        latestTurn: { state: "running" },
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.threadId).toBe("orphan-turn");
  });

  it("falls back to the thread runtime mode and a null provider when no session row exists", () => {
    const threads = [
      makeThread("no-session-open-turn", {
        runtimeMode: "approval-required",
        session: null,
        latestTurn: { state: "running" },
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    expect(commands).toHaveLength(1);
    const sessionCommands = expectSessionCommands(commands);
    expect(sessionCommands[0]?.session).toMatchObject({
      providerName: null,
      runtimeMode: "approval-required",
      status: "interrupted",
      activeTurnId: null,
    });
  });

  it("selects only the stuck threads from a mixed set, preserving order", () => {
    const threads = [
      makeThread("clean-a", {
        session: makeSession("clean-a", { status: "ready", activeTurnId: null }),
        latestTurn: { state: "completed" },
      }),
      makeThread("stuck-a", {
        session: makeSession("stuck-a", {
          status: "running",
          activeTurnId: TurnId.makeUnsafe("stuck-a-turn"),
        }),
      }),
      makeThread("clean-b"),
      makeThread("stuck-b", { latestTurn: { state: "running" } }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    expect(commands.map((command) => command.threadId)).toEqual(["stuck-a", "stuck-b"]);
  });

  it("produces deterministic command ids for identical inputs", () => {
    const threads = [
      makeThread("stuck", {
        session: makeSession("stuck", { status: "running" }),
      }),
    ];

    const first = planRestartTurnReconciliation({ threads, now: NOW });
    const second = planRestartTurnReconciliation({ threads, now: NOW });
    expect(first[0]?.commandId).toBe(second[0]?.commandId);
    expect(first[0]?.commandId).toBe(`restart-reconcile:stuck:${NOW}`);
  });
});
