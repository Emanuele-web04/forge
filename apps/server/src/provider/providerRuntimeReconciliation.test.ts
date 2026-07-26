import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type ProviderSession,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { planProviderRuntimeReconciliation } from "./providerRuntimeReconciliation.ts";
import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";

const NOW = Date.parse("2026-07-23T20:00:30.000Z");
const THREAD_ID = ThreadId.makeUnsafe("thread-reconcile");
const OLD_TURN_ID = TurnId.makeUnsafe("turn-old");
const LIVE_TURN_ID = TurnId.makeUnsafe("turn-live");

function threadShell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-reconcile"),
    title: "Runtime reconciliation",
    modelSelection: { provider: "codex", model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: {
      turnId: OLD_TURN_ID,
      state: "running",
      requestedAt: "2026-07-23T20:00:00.000Z",
      startedAt: "2026-07-23T20:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: "2026-07-23T19:00:00.000Z",
    updatedAt: "2026-07-23T20:00:00.000Z",
    archivedAt: null,
    handoff: null,
    session: {
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: OLD_TURN_ID,
      lastError: null,
      updatedAt: "2026-07-23T20:00:00.000Z",
    },
    ...overrides,
  };
}

function binding(
  activeTurnId: string | null = OLD_TURN_ID,
  provider: ProviderRuntimeBinding["provider"] = "codex",
): ProviderRuntimeBinding {
  return {
    threadId: THREAD_ID,
    provider,
    status: activeTurnId === null ? "stopped" : "running",
    lastSeenAt: "2026-07-23T20:00:00.000Z",
    runtimePayload: { activeTurnId },
  };
}

function liveSession(input: {
  readonly status: ProviderSession["status"];
  readonly activeTurnId?: TurnId;
  readonly provider?: ProviderSession["provider"];
  readonly lastError?: string;
}): ProviderSession {
  return {
    provider: input.provider ?? "codex",
    status: input.status,
    runtimeMode: "full-access",
    threadId: THREAD_ID,
    ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    createdAt: "2026-07-23T19:00:00.000Z",
    updatedAt: "2026-07-23T20:00:25.000Z",
  };
}

describe("planProviderRuntimeReconciliation", () => {
  it("settles a stale projection when the live Adapter is ready with no active turn", () => {
    expect(
      planProviderRuntimeReconciliation({
        threads: [threadShell()],
        bindings: [binding(null)],
        liveSessions: [liveSession({ status: "ready" })],
        pumpHealth: [],
        nowMs: NOW,
        staleAfterMs: 10_000,
      }),
    ).toEqual([
      expect.objectContaining({
        action: "settle-interrupted",
        threadId: THREAD_ID,
        projectedTurnId: OLD_TURN_ID,
        runtimeTurnId: null,
      }),
    ]);
  });

  it("uses the same stale-turn recovery for Claude sessions", () => {
    expect(
      planProviderRuntimeReconciliation({
        threads: [
          threadShell({
            modelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
            session: {
              ...threadShell().session!,
              providerName: "claudeAgent",
            },
          }),
        ],
        bindings: [binding(null, "claudeAgent")],
        liveSessions: [liveSession({ provider: "claudeAgent", status: "ready" })],
        pumpHealth: [
          {
            provider: "claudeAgent",
            status: "recovering",
            consecutiveFailures: 1,
            updatedAt: "2026-07-23T20:00:29.000Z",
          },
        ],
        nowMs: NOW,
        staleAfterMs: 10_000,
      }),
    ).toEqual([
      expect.objectContaining({
        action: "settle-interrupted",
        provider: "claudeAgent",
        projectedTurnId: OLD_TURN_ID,
        runtimeTurnId: null,
      }),
    ]);
  });

  it("trusts a terminal live error over stale active-turn metadata", () => {
    expect(
      planProviderRuntimeReconciliation({
        threads: [threadShell()],
        bindings: [binding()],
        liveSessions: [
          liveSession({
            status: "error",
            activeTurnId: OLD_TURN_ID,
            lastError: "Provider process exited.",
          }),
        ],
        pumpHealth: [],
        nowMs: NOW,
        staleAfterMs: 10_000,
      }),
    ).toEqual([
      expect.objectContaining({
        action: "settle-error",
        projectedTurnId: OLD_TURN_ID,
        runtimeTurnId: null,
        errorMessage: "Provider process exited.",
      }),
    ]);
  });

  it("realigns the projection when the live Adapter owns a newer turn", () => {
    expect(
      planProviderRuntimeReconciliation({
        threads: [threadShell()],
        bindings: [binding(LIVE_TURN_ID)],
        liveSessions: [liveSession({ status: "running", activeTurnId: LIVE_TURN_ID })],
        pumpHealth: [],
        nowMs: NOW,
        staleAfterMs: 10_000,
      }),
    ).toEqual([
      expect.objectContaining({
        action: "align-running-turn",
        projectedTurnId: OLD_TURN_ID,
        runtimeTurnId: LIVE_TURN_ID,
      }),
    ]);
  });

  it("does not second-guess matching, fresh, or shared child runtime state", () => {
    const matching = planProviderRuntimeReconciliation({
      threads: [threadShell()],
      bindings: [binding()],
      liveSessions: [liveSession({ status: "running", activeTurnId: OLD_TURN_ID })],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });
    const fresh = planProviderRuntimeReconciliation({
      threads: [
        threadShell({
          session: {
            ...threadShell().session!,
            updatedAt: "2026-07-23T20:00:29.000Z",
          },
        }),
      ],
      bindings: [binding(null)],
      liveSessions: [liveSession({ status: "ready" })],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });
    const childWithoutBinding = planProviderRuntimeReconciliation({
      threads: [threadShell({ parentThreadId: ThreadId.makeUnsafe("parent") })],
      bindings: [],
      liveSessions: [],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });
    const settledWithoutSession = planProviderRuntimeReconciliation({
      threads: [
        threadShell({
          session: null,
          latestTurn: {
            ...threadShell().latestTurn!,
            state: "completed",
            completedAt: "2026-07-23T20:00:05.000Z",
          },
        }),
      ],
      bindings: [binding(null)],
      liveSessions: [],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });

    expect(matching).toEqual([]);
    expect(fresh).toEqual([]);
    expect(childWithoutBinding).toEqual([]);
    expect(settledWithoutSession).toEqual([]);
  });

  it("does not recover a queued startup that has no concrete in-flight turn", () => {
    const plans = planProviderRuntimeReconciliation({
      threads: [
        threadShell({
          latestTurn: {
            ...threadShell().latestTurn!,
            state: "completed",
            completedAt: "2026-07-23T20:00:05.000Z",
          },
          session: {
            ...threadShell().session!,
            status: "starting",
            activeTurnId: null,
          },
        }),
      ],
      bindings: [binding(null)],
      liveSessions: [liveSession({ status: "ready" })],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });

    expect(plans).toEqual([]);
  });

  it("aligns a queued startup when the live provider has acquired a turn", () => {
    const plans = planProviderRuntimeReconciliation({
      threads: [
        threadShell({
          latestTurn: {
            ...threadShell().latestTurn!,
            state: "completed",
            completedAt: "2026-07-23T20:00:05.000Z",
          },
          session: {
            ...threadShell().session!,
            status: "starting",
            activeTurnId: null,
          },
        }),
      ],
      bindings: [binding(LIVE_TURN_ID)],
      liveSessions: [liveSession({ status: "running", activeTurnId: LIVE_TURN_ID })],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });

    expect(plans).toEqual([
      expect.objectContaining({
        action: "align-running-turn",
        projectedTurnId: null,
        runtimeTurnId: LIVE_TURN_ID,
      }),
    ]);
  });

  it("retains a running latest turn when its starting session update was partial", () => {
    const plans = planProviderRuntimeReconciliation({
      threads: [
        threadShell({
          session: {
            ...threadShell().session!,
            status: "starting",
            activeTurnId: null,
          },
        }),
      ],
      bindings: [binding(null)],
      liveSessions: [liveSession({ status: "ready" })],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });

    expect(plans).toEqual([
      expect.objectContaining({
        action: "settle-interrupted",
        projectedTurnId: OLD_TURN_ID,
        runtimeTurnId: null,
      }),
    ]);
  });

  it("settles a running latest turn projected under an idle session", () => {
    const plans = planProviderRuntimeReconciliation({
      threads: [
        threadShell({
          session: {
            ...threadShell().session!,
            status: "idle",
            activeTurnId: null,
          },
        }),
      ],
      bindings: [binding(null)],
      liveSessions: [liveSession({ status: "ready" })],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });

    expect(plans).toEqual([
      expect.objectContaining({
        action: "settle-interrupted",
        projectedTurnId: OLD_TURN_ID,
        runtimeTurnId: null,
      }),
    ]);
  });

  it.each(["ready", "interrupted", "stopped", "error"] as const)(
    "settles a stale running turn without reopening its %s session",
    (status) => {
      const terminalSession = {
        ...threadShell().session!,
        status,
        activeTurnId: null,
      };
      const plans = planProviderRuntimeReconciliation({
        threads: [
          threadShell({
            session: terminalSession,
          }),
        ],
        bindings: [binding(null)],
        liveSessions: [liveSession({ status: "ready" })],
        pumpHealth: [],
        nowMs: NOW,
        staleAfterMs: 10_000,
      });

      expect(plans).toEqual([
        expect.objectContaining({
          action: "settle-terminal-projection",
          projectedTurnId: OLD_TURN_ID,
          runtimeTurnId: null,
          terminalSession,
        }),
      ]);
    },
  );

  it("does not let stale readiness complete a turn after a live provider error", () => {
    const plans = planProviderRuntimeReconciliation({
      threads: [
        threadShell({
          session: {
            ...threadShell().session!,
            status: "ready",
            activeTurnId: null,
          },
        }),
      ],
      bindings: [binding(null)],
      liveSessions: [
        liveSession({
          status: "error",
          lastError: "Provider stream failed.",
        }),
      ],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });

    expect(plans).toEqual([
      expect.objectContaining({
        action: "settle-interrupted",
        projectedTurnId: OLD_TURN_ID,
        runtimeTurnId: null,
      }),
    ]);
  });

  it("does not attribute a live provider error to a different projected turn", () => {
    const plans = planProviderRuntimeReconciliation({
      threads: [threadShell()],
      bindings: [binding(LIVE_TURN_ID)],
      liveSessions: [
        liveSession({
          status: "error",
          activeTurnId: LIVE_TURN_ID,
          lastError: "Newer provider turn failed.",
        }),
      ],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });

    expect(plans).toEqual([
      expect.objectContaining({
        action: "settle-interrupted",
        projectedTurnId: OLD_TURN_ID,
        runtimeTurnId: null,
      }),
    ]);
    expect(plans[0]?.reason).toContain(LIVE_TURN_ID);
  });

  it("prefers a recovered live session over a stale durable binding error", () => {
    const terminalSession = {
      ...threadShell().session!,
      status: "ready" as const,
      activeTurnId: null,
    };
    const plans = planProviderRuntimeReconciliation({
      threads: [threadShell({ session: terminalSession })],
      bindings: [
        {
          ...binding(null),
          status: "error",
          runtimePayload: {
            activeTurnId: null,
            lastError: "Previous provider failure.",
          },
        },
      ],
      liveSessions: [liveSession({ status: "ready" })],
      pumpHealth: [],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });

    expect(plans).toEqual([
      expect.objectContaining({
        action: "settle-terminal-projection",
        projectedTurnId: OLD_TURN_ID,
        terminalSession,
      }),
    ]);
  });

  it("records degraded pump evidence in the reconciliation reason", () => {
    const plans = planProviderRuntimeReconciliation({
      threads: [threadShell()],
      bindings: [binding(null)],
      liveSessions: [],
      pumpHealth: [
        {
          provider: "codex",
          status: "recovering",
          consecutiveFailures: 2,
          updatedAt: "2026-07-23T20:00:29.000Z",
        },
      ],
      nowMs: NOW,
      staleAfterMs: 10_000,
    });

    expect(plans[0]?.reason).toContain("runtime-event pump is recovering");
  });
});
