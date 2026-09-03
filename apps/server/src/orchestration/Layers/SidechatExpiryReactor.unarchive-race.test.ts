import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { SidechatExpiryReactor } from "../Services/SidechatExpiryReactor.ts";
import { makeSidechatExpiryReactor } from "./SidechatExpiryReactor.ts";

function makeArchivedSidechat(nowMs: number): OrchestrationThread {
  const timestamp = new Date(nowMs).toISOString();
  return {
    id: ThreadId.makeUnsafe("sidechat-unarchive-view-race"),
    projectId: ProjectId.makeUnsafe("project-sidechat-unarchive-view-race"),
    title: "Side investigation",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    sidechatSourceThreadId: ThreadId.makeUnsafe("sidechat-source"),
    sidechatLastActivityAt: timestamp,
    sidechatExpiredAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    latestTurn: null,
    handoff: null,
    messages: [],
    session: null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    archivedAt: timestamp,
    deletedAt: null,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: thread.updatedAt,
    spaces: [],
    projects: [],
    threads: [thread],
  };
}

describe("SidechatExpiryReactor unarchive view race", () => {
  it("acquires a view lease before the unarchive event stream catches up", async () => {
    const nowMs = 10_000;
    let thread = makeArchivedSidechat(nowMs);
    const commands: OrchestrationCommand[] = [];
    const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>((command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    );
    const orchestrationEngine = {
      dispatch,
      getReadModel: () => Effect.succeed(makeReadModel(thread)),
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;
    const providerService = {
      stopSession: () => Effect.void,
    } as unknown as ProviderServiceShape;
    const layer = Layer.effect(
      SidechatExpiryReactor,
      makeSidechatExpiryReactor({
        now: () => nowMs,
        schedule: (callback, delayMs) => setTimeout(callback, delayMs),
        cancel: clearTimeout,
        runFork: (effect) => {
          Effect.runFork(effect);
        },
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    );
    const runtime = ManagedRuntime.make(layer);
    const scope = await Effect.runPromise(Scope.make("sequential"));

    try {
      const reactor = await runtime.runPromise(Effect.service(SidechatExpiryReactor));
      await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

      // The shell can publish the unarchived projection before this reactor sees
      // the matching domain event. The view must still seed from that projection.
      thread = { ...thread, archivedAt: null };
      await Effect.runPromise(reactor.viewStarted(thread.id));

      expect(commands).toContainEqual(
        expect.objectContaining({
          type: "thread.sidechat.activity.record",
          threadId: thread.id,
          activityAt: new Date(nowMs).toISOString(),
        }),
      );
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });
});
