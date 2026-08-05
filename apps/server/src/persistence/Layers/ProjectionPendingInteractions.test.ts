import { ApprovalRequestId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionPendingInteractionRepository } from "../Services/ProjectionPendingInteractions.ts";
import { ProjectionPendingInteractionRepositoryLive } from "./ProjectionPendingInteractions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionPendingInteractionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionPendingInteractionRepository", (it) => {
  it.effect("keeps equal provider request ids independent across threads and kinds", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingInteractionRepository;
      const requestId = ApprovalRequestId.makeUnsafe("shared-provider-request");
      const firstThreadId = ThreadId.makeUnsafe("thread-provider-request-a");
      const secondThreadId = ThreadId.makeUnsafe("thread-provider-request-b");
      const base = {
        requestId,
        turnId: null,
        lifecycleGeneration: "generation-a",
        status: "pending" as const,
        decision: null,
        responseCommandId: null,
        responseRequestedAt: null,
        createdAt: "2026-07-14T12:00:00.000Z",
        resolvedAt: null,
      };

      yield* repository.upsert({
        ...base,
        interactionKind: "approval",
        threadId: firstThreadId,
      });
      yield* repository.upsert({
        ...base,
        interactionKind: "userInput",
        threadId: firstThreadId,
      });
      yield* repository.upsert({
        ...base,
        interactionKind: "approval",
        threadId: secondThreadId,
      });

      yield* repository.deleteByIdentity({
        threadId: firstThreadId,
        interactionKind: "approval",
        requestId,
      });
      assert.strictEqual(
        (yield* repository.getByIdentity({
          threadId: firstThreadId,
          interactionKind: "approval",
          requestId,
        }))._tag,
        "None",
      );
      assert.strictEqual(
        (yield* repository.getByIdentity({
          threadId: firstThreadId,
          interactionKind: "userInput",
          requestId,
        }))._tag,
        "Some",
      );
      assert.strictEqual(
        (yield* repository.getByIdentity({
          threadId: secondThreadId,
          interactionKind: "approval",
          requestId,
        }))._tag,
        "Some",
      );
    }),
  );

  it.effect("lets exactly one command claim each interaction response", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingInteractionRepository;
      const threadId = ThreadId.makeUnsafe("thread-claim-response");
      const requestId = ApprovalRequestId.makeUnsafe("request-claim-response");
      yield* repository.upsert({
        interactionKind: "userInput",
        requestId,
        threadId,
        turnId: null,
        lifecycleGeneration: "generation-claim",
        status: "pending",
        decision: null,
        responseCommandId: null,
        responseRequestedAt: null,
        createdAt: "2026-07-14T12:10:00.000Z",
        resolvedAt: null,
      });

      assert.strictEqual(
        yield* repository.claimResponse({
          threadId,
          interactionKind: "userInput",
          requestId,
          lifecycleGeneration: "generation-claim",
          responseCommandId: "command-claim-a" as never,
          decision: null,
          requestedAt: "2026-07-14T12:10:01.000Z",
        }),
        true,
      );
      assert.strictEqual(
        yield* repository.claimResponse({
          threadId,
          interactionKind: "userInput",
          requestId,
          lifecycleGeneration: "generation-claim",
          responseCommandId: "command-claim-b" as never,
          decision: null,
          requestedAt: "2026-07-14T12:10:02.000Z",
        }),
        false,
      );
      const row = yield* repository.getByIdentity({
        threadId,
        interactionKind: "userInput",
        requestId,
      });
      assert.strictEqual(row._tag, "Some");
      if (row._tag === "Some") {
        assert.strictEqual(row.value.status, "responding");
        assert.strictEqual(row.value.responseCommandId, "command-claim-a");
      }
    }),
  );

  it.effect("re-claims an uncertain interaction so a later response can settle it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingInteractionRepository;
      const threadId = ThreadId.makeUnsafe("thread-reclaim-uncertain");
      const requestId = ApprovalRequestId.makeUnsafe("request-reclaim-uncertain");
      yield* repository.upsert({
        interactionKind: "userInput",
        requestId,
        threadId,
        turnId: null,
        lifecycleGeneration: "generation-uncertain",
        status: "uncertain",
        decision: null,
        responseCommandId: "command-uncertain-old" as never,
        responseRequestedAt: "2026-07-14T12:20:00.000Z",
        createdAt: "2026-07-14T12:19:00.000Z",
        resolvedAt: null,
      });

      assert.strictEqual(
        yield* repository.claimResponse({
          threadId,
          interactionKind: "userInput",
          requestId,
          lifecycleGeneration: "generation-uncertain",
          responseCommandId: "command-uncertain-retry" as never,
          decision: null,
          requestedAt: "2026-07-14T12:21:00.000Z",
        }),
        true,
      );
      const row = yield* repository.getByIdentity({
        threadId,
        interactionKind: "userInput",
        requestId,
      });
      assert.strictEqual(row._tag, "Some");
      if (row._tag === "Some") {
        assert.strictEqual(row.value.status, "responding");
        assert.strictEqual(row.value.responseCommandId, "command-uncertain-retry");
      }
    }),
  );

  it.effect("re-claims an orphaned responding interaction after the reclaim grace period", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingInteractionRepository;
      const threadId = ThreadId.makeUnsafe("thread-reclaim-orphaned");
      const requestId = ApprovalRequestId.makeUnsafe("request-reclaim-orphaned");
      const base = {
        interactionKind: "userInput" as const,
        requestId,
        threadId,
        turnId: null,
        lifecycleGeneration: "generation-orphaned",
        status: "responding" as const,
        decision: null,
        responseCommandId: "command-orphaned" as never,
        createdAt: "2026-07-14T12:30:00.000Z",
        resolvedAt: null,
      };
      yield* repository.upsert({
        ...base,
        responseRequestedAt: "2026-07-14T12:30:00.000Z",
      });

      // Inside the grace period the in-flight claim still shields the row.
      assert.strictEqual(
        yield* repository.claimResponse({
          threadId,
          interactionKind: "userInput",
          requestId,
          lifecycleGeneration: "generation-orphaned",
          responseCommandId: "command-orphaned-retry" as never,
          decision: null,
          requestedAt: "2026-07-14T12:30:10.000Z",
        }),
        false,
      );
      // A claim that never settled must not lock the interaction out forever.
      assert.strictEqual(
        yield* repository.claimResponse({
          threadId,
          interactionKind: "userInput",
          requestId,
          lifecycleGeneration: "generation-orphaned",
          responseCommandId: "command-orphaned-retry" as never,
          decision: null,
          requestedAt: "2026-07-14T12:31:00.000Z",
        }),
        true,
      );
      // A responding row without a claim timestamp is orphaned by definition.
      yield* repository.upsert({
        ...base,
        requestId: ApprovalRequestId.makeUnsafe("request-reclaim-no-timestamp"),
        responseRequestedAt: null,
      });
      assert.strictEqual(
        yield* repository.claimResponse({
          threadId,
          interactionKind: "userInput",
          requestId: ApprovalRequestId.makeUnsafe("request-reclaim-no-timestamp"),
          lifecycleGeneration: "generation-orphaned",
          responseCommandId: "command-orphaned-retry" as never,
          decision: null,
          requestedAt: "2026-07-14T12:30:10.000Z",
        }),
        true,
      );
    }),
  );
});
