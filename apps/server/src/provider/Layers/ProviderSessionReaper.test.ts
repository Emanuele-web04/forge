import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderKind,
  type ProviderSession,
  type ProviderSessionStartInput,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import { fakeProjectionSnapshotQuery } from "../../orchestration/testing/fakeProjectionSnapshotQuery";
import { ProviderUnsupportedError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper";

const unsupported = () => Effect.die(new Error("Unsupported test call")) as never;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeThreadShell(input: {
  readonly threadId: ThreadId;
  readonly activeTurnId: TurnId | null;
}): OrchestrationThreadShell {
  return {
    id: input.threadId,
    session: input.activeTurnId
      ? {
          activeTurnId: input.activeTurnId,
        }
      : null,
  } as unknown as OrchestrationThreadShell;
}

function makeLayer(input: {
  readonly threadShell: OrchestrationThreadShell;
  readonly directory: ProviderSessionDirectoryShape;
  readonly providerService: ProviderServiceShape;
}) {
  return makeProviderSessionReaperLive({
    inactivityThresholdMs: 1,
    sweepIntervalMs: 60_000,
  }).pipe(
    Layer.provide(Layer.succeed(ProviderSessionDirectory, input.directory)),
    Layer.provide(Layer.succeed(ProviderService, input.providerService)),
    Layer.provide(
      Layer.succeed(
        ProjectionSnapshotQuery,
        fakeProjectionSnapshotQuery({
          getThreadShellById: () => Effect.succeed(Option.some(input.threadShell)),
        }),
      ),
    ),
  );
}

function makeProviderServiceStub(input: {
  readonly stopSession: ProviderServiceShape["stopSession"];
  readonly stopRuntimeSession?: NonNullable<ProviderServiceShape["stopRuntimeSession"]>;
}): ProviderServiceShape {
  return {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    interruptTurn: () => unsupported(),
    stopTask: () => unsupported(),
    backgroundTask: () => unsupported(),
    steerSubagent: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: input.stopSession,
    ...(input.stopRuntimeSession ? { stopRuntimeSession: input.stopRuntimeSession } : {}),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => unsupported(),
    rollbackConversation: () => unsupported(),
    compactThread: () => unsupported(),
    closeRuntimeEvents: Effect.void,
    streamEvents: Stream.empty,
  };
}

function makeFakeAdapter(provider: ProviderKind) {
  const sessions = new Map<ThreadId, ProviderSession>();

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { threadId: `native-${String(input.threadId)}` },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const stopSession = vi.fn((threadId: ThreadId) =>
    Effect.sync(() => {
      sessions.delete(threadId);
    }),
  );

  const adapter: ProviderAdapterShape<never> = {
    provider,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn: () => unsupported(),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession,
    stopAll: () =>
      Effect.sync(() => {
        sessions.clear();
      }),
    listSessions: () => Effect.sync(() => Array.from(sessions.values())),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) =>
      Effect.succeed({
        threadId,
        turns: [],
      }),
    rollbackThread: (threadId) =>
      Effect.succeed({
        threadId,
        turns: [],
      }),
    streamEvents: Stream.never,
  };

  return { adapter, startSession, stopSession };
}

describe("ProviderSessionReaperLive", () => {
  it("stops stale sessions without active turns using a cursor-preserving runtime stop", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-stale");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const stopRuntimeSession = vi.fn<NonNullable<ProviderServiceShape["stopRuntimeSession"]>>(
      () => Effect.void,
    );
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            resumeCursor: { threadId: "native-thread-reaper-stale" },
          },
        ]),
    };

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            threadShell: makeThreadShell({ threadId, activeTurnId: null }),
            directory,
            providerService: makeProviderServiceStub({ stopSession, stopRuntimeSession }),
          }),
        ),
        Effect.runPromise,
      );
      await waitFor(() => stopRuntimeSession.mock.calls.length === 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopRuntimeSession).toHaveBeenCalledWith({ threadId });
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("skips stale sessions with active turns", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-active");
    const turnId = TurnId.makeUnsafe("turn-reaper-active");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const stopRuntimeSession = vi.fn<NonNullable<ProviderServiceShape["stopRuntimeSession"]>>(
      () => Effect.void,
    );
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            resumeCursor: { threadId: "native-thread-reaper-active" },
          },
        ]),
    };

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            threadShell: makeThreadShell({ threadId, activeTurnId: turnId }),
            directory,
            providerService: makeProviderServiceStub({ stopSession, stopRuntimeSession }),
          }),
        ),
        Effect.runPromise,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopRuntimeSession).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("skips idle sweep when stopRuntimeSession is unavailable", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-missing-runtime-stop");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            resumeCursor: { threadId: "native-thread-reaper-missing-runtime-stop" },
          },
        ]),
    };

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            threadShell: makeThreadShell({ threadId, activeTurnId: null }),
            directory,
            providerService: makeProviderServiceStub({ stopSession }),
          }),
        ),
        Effect.runPromise,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopSession).not.toHaveBeenCalled();
  });

  it("keeps the Codex resume cursor after an idle reaper sweep of a pre-warmed running session", async () => {
    await assertIdleReaperPreservesResumeCursor("codex", "thread-reaper-idle-codex");
  });

  it("keeps the resume cursor without session.started emission", async () => {
    await assertIdleReaperPreservesResumeCursor("claudeAgent", "thread-reaper-idle-claude");
  });
});

async function assertIdleReaperPreservesResumeCursor(
  provider: ProviderKind,
  threadIdValue: string,
): Promise<void> {
  const threadId = ThreadId.makeUnsafe(threadIdValue);
  const fake = makeFakeAdapter(provider);
  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (requested) =>
      requested === provider
        ? Effect.succeed(fake.adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider: requested })),
    listProviders: () => Effect.succeed([provider]),
  };
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const providerLayer = makeProviderServiceLive({ runtimeIdleStopMs: 0 }).pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
  );
  const sharedLayer = Layer.mergeAll(providerLayer, directoryLayer, NodeServices.layer);
  const reaperLayer = makeProviderSessionReaperLive({
    inactivityThresholdMs: 1,
    sweepIntervalMs: 60_000,
  }).pipe(
    Layer.provide(sharedLayer),
    Layer.provide(
      Layer.succeed(
        ProjectionSnapshotQuery,
        fakeProjectionSnapshotQuery({
          getThreadShellById: () =>
            Effect.succeed(Option.some(makeThreadShell({ threadId, activeTurnId: null }))),
        }),
      ),
    ),
  );
  const layer = Layer.mergeAll(sharedLayer, reaperLayer);
  const expectedResumeCursor = { threadId: `native-${threadIdValue}` };

  await Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const reaper = yield* ProviderSessionReaper;

    const started = yield* providerService.startSession(threadId, {
      provider,
      threadId,
      cwd: "/tmp/reaper-idle",
      runtimeMode: "full-access",
    });
    expect(started.resumeCursor).toEqual(expectedResumeCursor);

    if (!providerService.stopRuntimeSession) {
      throw new Error("Expected stopRuntimeSession");
    }
    yield* providerService.stopRuntimeSession({ threadId });
    fake.startSession.mockClear();
    const prewarmed = yield* providerService.startSession(threadId, {
      provider,
      threadId,
      cwd: "/tmp/reaper-idle",
      runtimeMode: "full-access",
    });
    expect(fake.startSession.mock.calls[0]?.[0]?.resumeCursor).toEqual(expectedResumeCursor);
    const prewarmedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    expect(prewarmedBinding?.status).toBe("running");
    expect(prewarmedBinding?.resumeCursor).toEqual(prewarmed.resumeCursor);

    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    const adapterStopsBeforeSweep = fake.stopSession.mock.calls.length;
    yield* reaper.start();
    yield* Effect.promise(() =>
      waitFor(() => fake.stopSession.mock.calls.length === adapterStopsBeforeSweep + 1),
    );

    const afterSweep = Option.getOrUndefined(yield* directory.getBinding(threadId));
    expect(afterSweep).toBeDefined();
    expect(afterSweep?.resumeCursor).toEqual(expectedResumeCursor);
    expect(afterSweep?.status).toBe("stopped");

    fake.startSession.mockClear();
    yield* providerService.startSession(threadId, {
      provider,
      threadId,
      cwd: "/tmp/reaper-idle",
      runtimeMode: "full-access",
    });
    expect(fake.startSession.mock.calls[0]?.[0]?.resumeCursor).toEqual(expectedResumeCursor);
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
}
