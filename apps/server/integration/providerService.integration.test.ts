import { ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ProviderUnsupportedError } from "../src/provider/Errors.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
  type TestTurnResponse,
} from "./TestProviderAdapter.integration.ts";
import {
  codexTurnApprovalFixture,
  codexTurnToolFixture,
  codexTurnTextFixture,
} from "./fixtures/providerRuntime.ts";

const makeWorkspaceDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

interface IntegrationFixture {
  readonly cwd: string;
  readonly harness: TestProviderAdapterHarness;
  readonly layer: Layer.Layer<ProviderService, unknown, never>;
}

const makeIntegrationFixture = Effect.gen(function* () {
  const cwd = yield* makeWorkspaceDirectory;
  const harness = yield* makeTestProviderAdapterHarness();

  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(harness.adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed(["codex"]),
  };

  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );

  const shared = Layer.mergeAll(
    directoryLayer,
    Layer.succeed(ProviderAdapterRegistry, registry),
  ).pipe(Layer.provide(SqlitePersistenceMemory));

  const layer = makeProviderServiceLive().pipe(Layer.provide(shared));

  return {
    cwd,
    harness,
    layer,
  } satisfies IntegrationFixture;
});

const runTurn = (input: {
  readonly provider: ProviderServiceShape;
  readonly harness: TestProviderAdapterHarness;
  readonly threadId: ThreadId;
  readonly userText: string;
  readonly response: TestTurnResponse;
}) =>
  Effect.gen(function* () {
    yield* input.harness.queueTurnResponse(input.threadId, input.response);

    yield* input.provider.sendTurn({
      threadId: input.threadId,
      input: input.userText,
      attachments: [],
    });

    return yield* input.harness.adapter.readThread(input.threadId);
  });

it.effect("replays typed runtime fixture events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(
        ThreadId.makeUnsafe("thread-integration-typed"),
        {
          threadId: ThreadId.makeUnsafe("thread-integration-typed"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        },
      );
      assert.equal((session.threadId ?? "").length > 0, true);

      const snapshot = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "hello",
        response: { events: codexTurnTextFixture },
      });

      assert.equal(snapshot.turns.length, 1);
      assert.deepEqual(snapshot.turns[0]?.items, [
        {
          type: "userMessage",
          content: [{ type: "text", text: "hello" }],
        },
        {
          type: "agentMessage",
          text: "I will make a small update.\nDone.\n",
        },
      ]);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("replays file-changing fixture turn events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture;
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(
        ThreadId.makeUnsafe("thread-integration-tools"),
        {
          threadId: ThreadId.makeUnsafe("thread-integration-tools"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        },
      );
      assert.equal((session.threadId ?? "").length > 0, true);

      const snapshot = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "make a small change",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      assert.equal(snapshot.turns.length, 1);
      assert.deepEqual(snapshot.turns[0]?.items, [
        {
          type: "userMessage",
          content: [{ type: "text", text: "make a small change" }],
        },
        {
          type: "agentMessage",
          text: "Applied the requested edit.\n",
        },
      ]);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("runs multi-turn tool/approval flow", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture;
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(
        ThreadId.makeUnsafe("thread-integration-multi"),
        {
          threadId: ThreadId.makeUnsafe("thread-integration-multi"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        },
      );
      assert.equal((session.threadId ?? "").length > 0, true);

      const firstSnapshot = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.equal(firstSnapshot.turns.length, 1);
      assert.deepEqual(firstSnapshot.turns[0]?.items, [
        {
          type: "userMessage",
          content: [{ type: "text", text: "turn 1" }],
        },
        {
          type: "agentMessage",
          text: "Applied the requested edit.\n",
        },
      ]);

      const secondSnapshot = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.equal(secondSnapshot.turns.length, 2);
      assert.deepEqual(secondSnapshot.turns[1]?.items, [
        {
          type: "userMessage",
          content: [{ type: "text", text: "turn 2 approval" }],
        },
        {
          type: "agentMessage",
          text: "Approval received and command executed.\n",
        },
      ]);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rolls back provider conversation state only", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture;
    const { join } = yield* Path.Path;
    const { writeFileString, readFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(
        ThreadId.makeUnsafe("thread-integration-rollback"),
        {
          threadId: ThreadId.makeUnsafe("thread-integration-rollback"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        },
      );
      assert.equal((session.threadId ?? "").length > 0, true);

      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });

      const rollbackCalls = fixture.harness.getRollbackCalls(session.threadId);
      assert.deepEqual(rollbackCalls, [1]);

      const readme = yield* readFileString(join(fixture.cwd, "README.md"));
      assert.equal(readme, "v3\n");
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
