import { ThreadId, TurnId, type ProviderSession } from "@synara/contracts";
import { Deferred, Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  clearAcpActiveTurn,
  finalizeAcpActiveTurnCost,
  forkAcpAdapterTurnIdleWatchdog,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveRequestedAcpSessionModeId,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  waitForAcpQueuedTurnEventsDrained,
  withAcpPlanModePrompt,
} from "./AcpAdapterSessionSupport.ts";

describe("ACP adapter session support", () => {
  it("resolves plan, approval, full-access, and fallback ACP modes in policy order", () => {
    const aliases = {
      plan: ["plan", "architect"],
      implement: ["code", "agent", "default", "chat", "implement"],
      approval: ["ask"],
    } as const;
    const modeState = {
      currentModeId: "current",
      availableModes: [
        { id: "architecture", name: "Architect", description: "Plan changes" },
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code" },
      ],
    };

    expect(
      resolveRequestedAcpSessionModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState,
        aliases,
      }),
    ).toBe("architecture");
    expect(
      resolveRequestedAcpSessionModeId({
        interactionMode: "debug",
        runtimeMode: "approval-required",
        modeState,
        aliases,
      }),
    ).toBe("ask");
    expect(
      resolveRequestedAcpSessionModeId({
        interactionMode: "debug",
        runtimeMode: "full-access",
        modeState,
        aliases,
      }),
    ).toBe("code");
    expect(
      resolveRequestedAcpSessionModeId({
        interactionMode: "default",
        runtimeMode: "full-access",
        modeState: {
          currentModeId: "current",
          availableModes: [
            { id: "plan", name: "Plan" },
            { id: "custom", name: "Custom" },
          ],
        },
        aliases,
      }),
    ).toBe("custom");
    expect(
      resolveRequestedAcpSessionModeId({
        interactionMode: "default",
        runtimeMode: "full-access",
        modeState: {
          currentModeId: "current",
          availableModes: [{ id: "plan", name: "Plan" }],
        },
        aliases,
      }),
    ).toBe("current");
    expect(
      resolveRequestedAcpSessionModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: undefined,
        aliases,
      }),
    ).toBeUndefined();
  });

  it("does not inherit Plan when the next turn omits its interaction mode", () => {
    const aliases = {
      plan: ["plan"],
      implement: ["code"],
      approval: ["ask"],
    } as const;
    const modeState = {
      currentModeId: "plan",
      availableModes: [
        { id: "plan", name: "Plan" },
        { id: "code", name: "Code" },
      ],
    };

    const interactionMode = resolveAcpTurnInteractionMode(undefined);
    expect(interactionMode).toBe("default");
    expect(
      resolveRequestedAcpSessionModeId({
        interactionMode,
        runtimeMode: "full-access",
        modeState,
        aliases,
      }),
    ).toBe("code");
  });

  it("scopes reused runtime and tool ids while preserving the provider id", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    expect(scopeAcpRuntimeItemIdForTurn("grok", turnId, "item-1")).toBe("grok:turn-1:item-1");
    expect(
      scopeAcpToolCallStateForTurn("grok", turnId, {
        toolCallId: "call-1",
        status: "completed",
        data: { toolCallId: "call-1" },
      }),
    ).toMatchObject({
      toolCallId: "grok:turn-1:call-1",
      data: { toolCallId: "call-1", providerToolCallId: "call-1" },
    });
  });

  it("clears only the matching active turn and removes it from the session snapshot", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const context = {
      activeTurnId: turnId as TurnId | undefined,
      activeTurnHadAssistantContent: true,
      activeAssistantItemsWithContent: new Set(["item-1"]),
      activeTurnFailedToolDetail: "failed" as string | undefined,
      activePromptFiber: { id: "fiber" } as { id: string } | undefined,
      activeInteractionMode: "plan" as "plan" | "default" | undefined,
      session: {
        provider: "grok",
        status: "running",
        runtimeMode: "full-access",
        threadId: ThreadId.makeUnsafe("thread-1"),
        activeTurnId: turnId,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
      } satisfies ProviderSession,
    };

    expect(clearAcpActiveTurn(context, TurnId.makeUnsafe("other-turn"))).toBe(false);
    expect(clearAcpActiveTurn(context, turnId)).toBe(true);
    expect(context).toMatchObject({
      activeTurnId: undefined,
      activeTurnHadAssistantContent: false,
      activeTurnFailedToolDetail: undefined,
      activePromptFiber: undefined,
      activeInteractionMode: undefined,
    });
    expect(context.activeAssistantItemsWithContent.size).toBe(0);
    expect(Object.hasOwn(context.session, "activeTurnId")).toBe(false);
  });

  it("records only valid USD cost snapshots", () => {
    const context = { latestSessionCostUsd: undefined as number | undefined };
    recordAcpSessionCost(context, { amount: 1.25, currency: "USD" });
    expect(finalizeAcpActiveTurnCost(context)).toEqual({ cumulativeCostUsd: 1.25 });
    recordAcpSessionCost(context, { amount: 99, currency: "EUR" });
    expect(finalizeAcpActiveTurnCost(context)).toEqual({ cumulativeCostUsd: 1.25 });
  });

  it("wraps only Plan-mode prompts", () => {
    expect(
      withAcpPlanModePrompt({
        text: "  inspect this  ",
        interactionMode: "plan",
        promptPrefix: "PLAN",
      }),
    ).toBe("PLAN\n\nUser request:\ninspect this");
    expect(
      withAcpPlanModePrompt({
        text: "  preserve spacing  ",
        interactionMode: "default",
        promptPrefix: "PLAN",
      }),
    ).toBe("  preserve spacing  ");
  });

  it("resolves explicit, session, and server fallback working directories in order", () => {
    expect(
      resolveAcpSessionCwd({
        inputCwd: "/explicit",
        sessionCwd: "/session",
        serverCwd: "/server",
        homeDir: "/home/test",
      }),
    ).toBe("/explicit");
    expect(
      resolveAcpSessionCwd({
        inputCwd: undefined,
        sessionCwd: "/session",
        serverCwd: "/server",
        homeDir: "/home/test",
      }),
    ).toBe("/session");
    expect(
      resolveAcpSessionCwd({
        inputCwd: undefined,
        serverCwd: "/server",
        homeDir: "/home/test",
      }),
    ).toBe("/server");
  });

  it("runs the shared turn watchdog from adapter lifecycle state", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const timedOut = yield* Deferred.make<number>();
        const turnId = TurnId.makeUnsafe("turn-watchdog");
        const pendingApprovals = new Map<string, unknown>([["approval", {}]]);
        const context = {
          scope,
          pendingApprovals,
          pendingUserInputs: new Map<string, unknown>(),
          activeTurnId: turnId as TurnId | undefined,
          lastTurnActivityAt: 0 as number | undefined,
          stopped: false,
        };

        yield* forkAcpAdapterTurnIdleWatchdog({
          context,
          turnId,
          idleTimeoutMs: 1,
          checkIntervalMs: 1,
          onIdleTimeout: (idleMs) => Deferred.succeed(timedOut, idleMs).pipe(Effect.asVoid),
        });
        yield* Effect.sleep(5);
        const touchedWhileAwaitingHuman = (context.lastTurnActivityAt ?? 0) > 0;
        pendingApprovals.clear();
        context.lastTurnActivityAt = 0;
        const idleMs = yield* Deferred.await(timedOut).pipe(Effect.timeout(1_000));
        yield* Scope.close(scope, Exit.void);
        return { idleMs, touchedWhileAwaitingHuman };
      }),
    );

    expect(result.touchedWhileAwaitingHuman).toBe(true);
    expect(result.idleMs).toBeGreaterThanOrEqual(1);
  });

  it("waits until the consumer catches up with enqueued session updates", async () => {
    let processed = 0;
    const drained = Effect.runPromise(
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: Effect.succeed(3),
        sessionUpdatesProcessed: () => processed,
        maxWaitMs: 1_000,
        pollMs: 1,
      }),
    );
    // Simulate the notification consumer handling queued events asynchronously,
    // as happens across two consecutive turns whose trailing updates are still
    // in flight when the prompt response resolves.
    setTimeout(() => {
      processed = 3;
    }, 10);
    await drained;
    expect(processed).toBe(3);
  });

  it("returns immediately when the consumer already kept up", async () => {
    const startedAt = Date.now();
    await Effect.runPromise(
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: Effect.succeed(2),
        sessionUpdatesProcessed: () => 2,
        maxWaitMs: 1_000,
        pollMs: 25,
      }),
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("bounds the wait so a stalled consumer cannot block settlement", async () => {
    await Effect.runPromise(
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: Effect.succeed(5),
        sessionUpdatesProcessed: () => 0,
        maxWaitMs: 20,
        pollMs: 1,
      }),
    );
  });
});
