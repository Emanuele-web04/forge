// FILE: ProviderService.test.ts
// Purpose: Verifies cross-provider routing, persistence, recovery, and runtime lifecycle behavior.
// Layer: Provider service integration tests
// Depends on: ProviderServiceLive with in-memory adapter and SQLite fakes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderForkThreadInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderStartReviewInput,
  ProviderSteerTurnInput,
  ProviderTurnStartResult,
} from "@synara/contracts";
import {
  ApprovalRequestId,
  EventId,
  type ProviderKind,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterSessionNotFoundError,
  ProviderSessionDirectoryPersistenceError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import {
  makeProviderServiceLive,
  PROVIDER_RUNTIME_QUARANTINE_CAUSE_MAX_BYTES,
  summarizeProviderRuntimeQuarantineCause,
} from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { AGENT_GATEWAY_TURN_AUTHORITY_RETIRED } from "../../agentGateway/sessionLease.ts";

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type ReleaseListSessions = (sessions: ReadonlyArray<ProviderSession>) => void;

it("bounds durable quarantine cause details while preserving diagnostics", () => {
  const cause = "💥 failure ".repeat(PROVIDER_RUNTIME_QUARANTINE_CAUSE_MAX_BYTES);
  const summary = summarizeProviderRuntimeQuarantineCause(cause);

  assert.equal(summary.causeTruncated, true);
  assert.equal(summary.causeOriginalBytes, Buffer.byteLength(cause, "utf8"));
  assert.equal(summary.causeSha256?.length, 64);
  assert.ok(
    Buffer.byteLength(summary.cause, "utf8") <= PROVIDER_RUNTIME_QUARANTINE_CAUSE_MAX_BYTES,
  );
  assert.equal(summary.cause.includes("\uFFFD"), false);
});

// Converts deferred listSessions callbacks into typed release handles for race tests.
function requireReleaseListSessions(release: ReleaseListSessions | undefined): ReleaseListSessions {
  if (typeof release !== "function") {
    assert.fail("Expected listSessions release callback");
  }
  return release;
}

function withoutResumeCursor(session: ProviderSession): ProviderSession {
  const { resumeCursor: _omittedResumeCursor, ...rest } = session;
  return rest;
}

function asRuntimePayloadRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function makeFakeCodexAdapter(
  provider: ProviderKind = "codex",
  options?: {
    readonly conversationRollback?: "native" | "restart-session";
    readonly didResumeSession?: NonNullable<
      ProviderAdapterShape<ProviderAdapterError>["didResumeSession"]
    >;
  },
) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn(
    (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.sync(() => {
        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? { opaque: `resume-${String(input.threadId)}` },
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(session.threadId, session);
        return session;
      }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.makeUnsafe(`turn-${String(input.threadId)}`),
      });
    },
  );

  const steerTurn = vi.fn(
    (input: ProviderSteerTurnInput): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.makeUnsafe(`steer-${String(input.threadId)}`),
      }),
  );

  const startReview = vi.fn(
    (
      input: ProviderStartReviewInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.makeUnsafe(`review-${String(input.threadId)}`),
      }),
  );

  const interruptTurn = vi.fn(
    (
      _threadId: ThreadId,
      _turnId?: TurnId,
      _providerThreadId?: string,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const compactThread = vi.fn(
    (_threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const forkThread = vi.fn(
    (
      input: ProviderForkThreadInput,
    ): Effect.Effect<
      { readonly threadId: ThreadId; readonly resumeCursor: { readonly opaque: string } },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId: input.threadId,
        resumeCursor: { opaque: `fork-${String(input.threadId)}` },
      }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsTurnSteering: true,
      ...(options?.conversationRollback
        ? { conversationRollback: options.conversationRollback }
        : {}),
    },
    startSession,
    ...(options?.didResumeSession ? { didResumeSession: options.didResumeSession } : {}),
    sendTurn,
    steerTurn,
    startReview,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    compactThread,
    forkThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const waitForRuntimeSubscribers = (count = 1): Effect.Effect<void> =>
    waitUntil(
      () => runtimeEventPubSub.subscribers.size >= count,
      500,
      20,
      `${provider} runtime event subscriber`,
    );

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    waitForRuntimeSubscribers,
    updateSession,
    startSession,
    sendTurn,
    steerTurn,
    startReview,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    compactThread,
    forkThread,
    stopAll,
  };
}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const waitUntil = (
  predicate: () => boolean,
  timeoutMs = 500,
  intervalMs = 20,
  description = "condition",
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      yield* sleep(intervalMs);
    }
    if (!predicate()) {
      assert.fail(`Timed out waiting for ${description}`);
    }
  });

const waitUntilEffect = <E = never, R = never>(
  predicate: () => Effect.Effect<boolean, E, R>,
  timeoutMs = 500,
  intervalMs = 20,
  description = "condition",
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    let matched = yield* predicate();
    while (!matched && Date.now() < deadline) {
      yield* sleep(intervalMs);
      matched = yield* predicate();
    }
    if (!matched) {
      assert.fail(`Timed out waiting for ${description}`);
    }
  });

function makeProviderServiceLayer(
  options?: Parameters<typeof makeProviderServiceLive>[0],
  providers?: {
    readonly includeRestartRollbackDroid?: boolean;
    readonly includePi?: boolean;
    readonly codexDidResumeSession?: NonNullable<
      ProviderAdapterShape<ProviderAdapterError>["didResumeSession"]
    >;
  },
) {
  const codex = makeFakeCodexAdapter("codex", {
    ...(providers?.codexDidResumeSession
      ? { didResumeSession: providers.codexDidResumeSession }
      : {}),
  });
  const claude = makeFakeCodexAdapter("claudeAgent");
  const antigravity = makeFakeCodexAdapter("antigravity");
  const droid = makeFakeCodexAdapter("droid", { conversationRollback: "restart-session" });
  const pi = makeFakeCodexAdapter("pi");
  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(codex.adapter)
        : provider === "claudeAgent"
          ? Effect.succeed(claude.adapter)
          : provider === "antigravity"
            ? Effect.succeed(antigravity.adapter)
            : provider === "droid" && providers?.includeRestartRollbackDroid === true
              ? Effect.succeed(droid.adapter)
              : provider === "pi" && providers?.includePi === true
                ? Effect.succeed(pi.adapter)
                : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () =>
      Effect.succeed([
        "codex",
        "claudeAgent",
        "antigravity",
        ...(providers?.includeRestartRollbackDroid === true ? (["droid"] as const) : []),
        ...(providers?.includePi === true ? (["pi"] as const) : []),
      ] as const),
  };

  const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const rawLayer = Layer.mergeAll(
    makeProviderServiceLive(options).pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
    ),
    directoryLayer,
    runtimeRepositoryLayer,
    NodeServices.layer,
  );
  const layer = it.layer(rawLayer);

  return {
    codex,
    claude,
    antigravity,
    droid,
    pi,
    layer,
    rawLayer,
  };
}

const routing = makeProviderServiceLayer();
const rotationRetryPersistAttempts = new Map<string, number>();
const ROTATION_RETRY_FAILURE_EVENT_ID = "terminal-rotation-settlement-retry";
const rotationRetry = makeProviderServiceLayer({
  persistRuntimeEvent: (event) =>
    Effect.suspend(() => {
      const eventId = String(event.eventId);
      const attempts = (rotationRetryPersistAttempts.get(eventId) ?? 0) + 1;
      rotationRetryPersistAttempts.set(eventId, attempts);
      if (eventId === ROTATION_RETRY_FAILURE_EVENT_ID && attempts === 1) {
        return Effect.fail(new Error("injected transient runtime persistence failure"));
      }
      return Effect.succeed({ sequence: attempts, event });
    }),
  runtimeEventRetryBaseDelayMs: 1,
  runtimeEventRetryMaxDelayMs: 1,
});
const restartRollbackRouting = makeProviderServiceLayer(undefined, {
  includeRestartRollbackDroid: true,
});
const piInteractionRouting = makeProviderServiceLayer(undefined, { includePi: true });
const adapterConfirmedFreshRouting = makeProviderServiceLayer(undefined, {
  codexDidResumeSession: () => false,
});
it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId: asThreadId("thread-stale") });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive persists active sessions as stopped when adapter cleanup fails",
  () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-stopall-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const codex = makeFakeCodexAdapter();
      const threadId = asThreadId("thread-stopall");
      const resumeCursor = {
        threadId,
        resume: "resume-session-stopall",
        resumeSessionAt: "assistant-message-stopall",
        turnCount: 1,
      };
      codex.stopAll.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: "codex",
            threadId,
          }),
        ),
      );

      const registry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(codex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };

      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(threadId, {
          provider: "codex",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        codex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "running",
          activeTurnId: asTurnId("turn-stopall"),
          resumeCursor,
        }));
      }).pipe(Effect.provide(providerLayer));

      const persisted = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({ threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));

      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        const runtimePayload = persisted.value.runtimePayload as Record<string, unknown>;
        assert.equal(persisted.value.status, "stopped");
        assert.deepEqual(persisted.value.resumeCursor, resumeCursor);
        assert.equal(runtimePayload.activeTurnId, null);
        assert.equal(runtimePayload.lastRuntimeEvent, "provider.stopAll");
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

type ShutdownCursorOrderingScenario =
  | "newer-runtime-write"
  | "ignored-runtime-event"
  | "cursorless-runtime-write"
  | "mid-list-runtime-write"
  | "blocked-runtime-write"
  | "queued-runtime-write"
  | "late-nonterminal-runtime-write";

function verifyShutdownCursorOrdering(scenario: ShutdownCursorOrderingScenario) {
  return Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-stopall-race-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const releaseStoppedSessionSweep = yield* Deferred.make<void>();
    const runtimeEventObserved = yield* Deferred.make<void>();
    const runtimeWriteStarted = yield* Deferred.make<void>();
    const runtimeCursorCaptureStarted = yield* Deferred.make<void>();
    const providerTeardownStarted = yield* Deferred.make<void>();
    let shutdownStarted = false;
    let shutdownRequested = false;

    const delayedDirectoryLayer = Layer.effect(
      ProviderSessionDirectory,
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        return {
          ...directory,
          getBinding: (threadId) => {
            const read =
              scenario === "queued-runtime-write" && shutdownRequested
                ? Deferred.succeed(runtimeWriteStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(providerTeardownStarted)),
                    Effect.andThen(directory.getBinding(threadId)),
                  )
                : directory.getBinding(threadId);
            return read.pipe(
              Effect.tap(() =>
                scenario === "ignored-runtime-event" && shutdownStarted
                  ? Deferred.succeed(runtimeEventObserved, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            );
          },
          listThreadIds: () =>
            Deferred.await(releaseStoppedSessionSweep).pipe(
              Effect.andThen(directory.listThreadIds()),
            ),
          upsert: (binding) => {
            const lastRuntimeEvent = asRuntimePayloadRecord(
              binding.runtimePayload,
            ).lastRuntimeEvent;
            const persist =
              scenario === "cursorless-runtime-write" && lastRuntimeEvent === "provider.stopAll"
                ? Deferred.await(providerTeardownStarted).pipe(
                    Effect.andThen(directory.upsert(binding)),
                  )
                : scenario === "blocked-runtime-write" && lastRuntimeEvent === "turn.completed"
                  ? Deferred.succeed(runtimeWriteStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(providerTeardownStarted)),
                      Effect.andThen(directory.upsert(binding)),
                    )
                  : directory.upsert(binding);
            return persist.pipe(
              Effect.tap(() =>
                scenario !== "ignored-runtime-event" && lastRuntimeEvent === "turn.completed"
                  ? Deferred.succeed(runtimeEventObserved, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            );
          },
        } satisfies ProviderSessionDirectoryShape;
      }),
    ).pipe(Layer.provide(directoryLayer));

    const codex = makeFakeCodexAdapter();
    const threadId = asThreadId("thread-stopall-terminal-race");
    const shutdownSnapshotCursor = { resume: "shutdown-snapshot" };
    const terminalCursor = { resume: "terminal-cursor" };
    const expectedCursor =
      scenario === "newer-runtime-write" ||
      scenario === "mid-list-runtime-write" ||
      scenario === "blocked-runtime-write" ||
      scenario === "queued-runtime-write"
        ? terminalCursor
        : shutdownSnapshotCursor;
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };

    const updateSessionWithTerminalCursor = (): void => {
      codex.updateSession(threadId, (session) => ({
        ...session,
        status: "closed",
        resumeCursor: terminalCursor,
        updatedAt: new Date().toISOString(),
      }));
    };
    const emitTerminalTurn = (): void => {
      codex.emit({
        type: "turn.completed",
        eventId: asEventId("event-stopall-terminal-race"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId,
        payload: { state: "completed" },
      });
    };

    if (
      scenario === "mid-list-runtime-write" ||
      scenario === "queued-runtime-write" ||
      scenario === "late-nonterminal-runtime-write"
    ) {
      const listSessions = codex.listSessions.getMockImplementation();
      assert.ok(listSessions);
      let emittedDuringShutdownList = false;
      let runtimeCursorCapturePending = false;
      codex.listSessions.mockImplementation(() => {
        const currentSessions = listSessions();
        if (runtimeCursorCapturePending) {
          runtimeCursorCapturePending = false;
          return Deferred.succeed(runtimeCursorCaptureStarted, undefined).pipe(
            Effect.andThen(Deferred.await(providerTeardownStarted)),
            Effect.andThen(listSessions()),
          );
        }
        if (!shutdownRequested || emittedDuringShutdownList) {
          return currentSessions;
        }
        emittedDuringShutdownList = true;
        return Effect.gen(function* () {
          const staleSessions = (yield* currentSessions).map((session) => ({ ...session }));
          if (scenario === "late-nonterminal-runtime-write") {
            runtimeCursorCapturePending = true;
            codex.emit({
              type: "turn.tasks.updated",
              eventId: asEventId("event-stopall-late-nonterminal-race"),
              provider: "codex",
              createdAt: new Date().toISOString(),
              threadId,
              payload: { tasks: [{ task: "Finishing shutdown", status: "inProgress" }] },
            });
            yield* Deferred.await(runtimeCursorCaptureStarted);
            return staleSessions;
          } else {
            updateSessionWithTerminalCursor();
            emitTerminalTurn();
          }
          yield* Deferred.await(
            scenario === "queued-runtime-write" ? runtimeWriteStarted : runtimeEventObserved,
          );
          return staleSessions;
        });
      });
    }

    codex.stopAll.mockImplementation(() =>
      Effect.gen(function* () {
        shutdownStarted = true;
        if (scenario === "newer-runtime-write") {
          updateSessionWithTerminalCursor();
          emitTerminalTurn();
        } else if (scenario === "cursorless-runtime-write") {
          yield* Deferred.succeed(providerTeardownStarted, undefined);
          yield* codex.stopSession(threadId);
          emitTerminalTurn();
        } else if (scenario === "ignored-runtime-event") {
          codex.emit({
            type: "session.exited",
            eventId: asEventId("event-stopall-terminal-race"),
            provider: "claudeAgent",
            createdAt: new Date().toISOString(),
            threadId,
            payload: { exitKind: "graceful" },
          });
        } else if (scenario === "blocked-runtime-write") {
          yield* Deferred.succeed(providerTeardownStarted, undefined);
        } else if (scenario === "queued-runtime-write") {
          yield* codex.stopSession(threadId);
          yield* Deferred.succeed(providerTeardownStarted, undefined);
        } else if (scenario === "late-nonterminal-runtime-write") {
          yield* codex.stopSession(threadId);
          yield* Deferred.succeed(providerTeardownStarted, undefined);
          yield* Deferred.succeed(releaseStoppedSessionSweep, undefined);
          return;
        }
        yield* Deferred.await(runtimeEventObserved);
        yield* Deferred.succeed(releaseStoppedSessionSweep, undefined);
      }),
    );

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(delayedDirectoryLayer),
    );

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      yield* provider.startSession(threadId, {
        provider: "codex",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        threadId,
      });
      codex.updateSession(threadId, (session) => ({
        ...session,
        resumeCursor: shutdownSnapshotCursor,
      }));
      yield* codex.waitForRuntimeSubscribers();
      if (scenario === "blocked-runtime-write") {
        updateSessionWithTerminalCursor();
        emitTerminalTurn();
        yield* Deferred.await(runtimeWriteStarted);
      }
      shutdownRequested = true;
    }).pipe(Effect.provide(providerLayer));

    const persisted = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId });
    }).pipe(Effect.provide(runtimeRepositoryLayer));

    assert.equal(Option.isSome(persisted), true);
    if (Option.isSome(persisted)) {
      assert.equal(persisted.value.status, "stopped");
      assert.deepEqual(persisted.value.resumeCursor, expectedCursor);
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer));
}

it.effect("ProviderServiceLive preserves a terminal cursor newer than its shutdown snapshot", () =>
  verifyShutdownCursorOrdering("newer-runtime-write"),
);

it.effect("ProviderServiceLive retains its shutdown snapshot after an ignored runtime event", () =>
  verifyShutdownCursorOrdering("ignored-runtime-event"),
);

it.effect("ProviderServiceLive preserves its snapshot across a cursorless shutdown event", () =>
  verifyShutdownCursorOrdering("cursorless-runtime-write"),
);

it.effect("ProviderServiceLive refreshes a session snapshot after a mid-list cursor write", () =>
  verifyShutdownCursorOrdering("mid-list-runtime-write"),
);

it.effect("ProviderServiceLive starts teardown while an earlier binding write is blocked", () =>
  verifyShutdownCursorOrdering("blocked-runtime-write"),
);

it.effect("ProviderServiceLive preserves a cursor from a writer queued before shutdown", () =>
  verifyShutdownCursorOrdering("queued-runtime-write"),
);

it.effect("ProviderServiceLive keeps a late nonterminal shutdown write stopped", () =>
  verifyShutdownCursorOrdering("late-nonterminal-runtime-write"),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-restart-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(firstCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: "codex",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({ threadId: startedSession.threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(secondCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

adapterConfirmedFreshRouting.layer("ProviderServiceLive resume confirmation", (it) => {
  it.effect("keeps transcript bootstrap pending when the adapter rejects a supplied cursor", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-adapter-rejected-resume");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.stopRuntimeSession!({ threadId });
      const outcome = yield* provider.startSessionWithOutcome!(
        threadId,
        {
          provider: "codex",
          threadId,
          runtimeMode: "full-access",
        },
        { registerPriorTranscriptBootstrapOnFreshStart: true },
      );

      assert.equal(outcome.nativeResumeSucceeded, false);
      assert.equal(outcome.priorTranscriptBootstrapPending, true);
      yield* provider.stopSession({ threadId });
    }),
  );
});

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("reports native resume and persists bootstrap state until completion", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-start-outcome");
      const upsertSpy = vi.spyOn(directory, "upsert");

      const initial = yield* provider.startSessionWithOutcome!(
        threadId,
        {
          provider: "codex",
          threadId,
          runtimeMode: "full-access",
        },
        { registerPriorTranscriptBootstrapOnFreshStart: true },
      );
      assert.equal(upsertSpy.mock.calls.length, 1);
      const initialBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(
        asRuntimePayloadRecord(initialBinding?.runtimePayload).priorTranscriptBootstrapPending,
        true,
      );
      upsertSpy.mockRestore();
      yield* provider.stopRuntimeSession!({ threadId });
      const resumed = yield* provider.startSessionWithOutcome!(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });

      assert.equal(initial.nativeResumeSucceeded, false);
      assert.equal(initial.priorTranscriptBootstrapPending, true);
      assert.equal(resumed.nativeResumeSucceeded, true);
      assert.equal(resumed.priorTranscriptBootstrapPending, true);
      assert.deepEqual(
        routing.codex.startSession.mock.calls.at(-1)?.[0]?.resumeCursor,
        initial.session.resumeCursor,
      );

      yield* provider.completePriorTranscriptBootstrap!({ threadId });
      yield* provider.stopRuntimeSession!({ threadId });
      const resumedAfterCompletion = yield* provider.startSessionWithOutcome!(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      assert.equal(resumedAfterCompletion.nativeResumeSucceeded, true);
      assert.equal(resumedAfterCompletion.priorTranscriptBootstrapPending, false);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("reuses a deferred native fork binding and preserves its inherited cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const sourceThreadId = asThreadId("thread-native-fork-source");
      const targetThreadId = asThreadId("thread-native-fork-target");

      yield* provider.startSession(sourceThreadId, {
        provider: "codex",
        threadId: sourceThreadId,
        cwd: "/tmp/native-fork-source",
        runtimeMode: "full-access",
      });
      const forkCallCount = routing.codex.forkThread.mock.calls.length;
      const forkInput = {
        sourceThreadId,
        threadId: targetThreadId,
        runtimeMode: "full-access" as const,
      };

      const first = yield* provider.forkThread!(forkInput);
      yield* provider.stopSession({ threadId: sourceThreadId });
      yield* directory.remove(sourceThreadId);
      const second = yield* provider.forkThread!(forkInput);
      const startsBeforeRecovery = routing.codex.startSession.mock.calls.length;
      yield* provider.sendTurn({
        threadId: targetThreadId,
        input: "continue the fork",
        attachments: [],
      });

      assert.deepEqual(second, first);
      assert.equal(routing.codex.forkThread.mock.calls.length - forkCallCount, 1);
      assert.equal(routing.codex.startSession.mock.calls.length, startsBeforeRecovery + 1);
      const recoveredStart = routing.codex.startSession.mock.calls.at(-1)?.[0];
      assert.equal(recoveredStart?.threadId, targetThreadId);
      assert.equal(recoveredStart?.cwd, "/tmp/native-fork-source");
      assert.deepEqual(recoveredStart?.resumeCursor, first?.resumeCursor);
      const targetBinding = Option.getOrUndefined(yield* directory.getBinding(targetThreadId));
      assert.equal(targetBinding?.status, "running");
      assert.equal(
        asRuntimePayloadRecord(targetBinding?.runtimePayload).cwd,
        "/tmp/native-fork-source",
      );

      yield* provider.stopSession({ threadId: targetThreadId });
    }),
  );

  it.effect("fork source overrides explicit and persisted resume cursors", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-external-fork");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        resumeCursor: { threadId: "persisted-thread" },
        runtimeMode: "full-access",
      });
      routing.codex.startSession.mockClear();

      const forkSourceResumeCursor = { threadId: "external-thread" };
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        forkSourceResumeCursor,
        resumeCursor: { threadId: "explicit-thread" },
        runtimeMode: "full-access",
      });

      const startInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.deepEqual(startInput?.forkSourceResumeCursor, forkSourceResumeCursor);
      assert.equal(startInput?.resumeCursor, undefined);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("runs the idempotent adapter cleanup barrier for an inactive binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-explicit-stop-inactive");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      routing.codex.stopSession.mockClear();
      routing.codex.hasSession.mockReturnValueOnce(Effect.succeed(false));

      yield* provider.stopSession({ threadId });

      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(Option.isNone(yield* directory.getBinding(threadId)), true);
    }),
  );

  it.effect("serializes lifecycle mutations and persists a fresh generation per start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-lifecycle-generation");
      const startInput: ProviderSessionStartInput = {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      };

      yield* provider.startSession(threadId, startInput);
      const firstBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const firstGeneration = firstBinding?.lifecycleGeneration;
      assert.equal(typeof firstGeneration, "string");

      yield* provider.stopSession({ threadId });
      yield* provider.stopSession({ threadId });
      yield* provider.startSession(threadId, startInput);
      const secondBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const secondGeneration = secondBinding?.lifecycleGeneration;
      assert.equal(typeof secondGeneration, "string");
      assert.notEqual(secondGeneration, firstGeneration);

      const responseCallCount = routing.codex.respondToRequest.mock.calls.length;
      const staleResponse = yield* Effect.result(
        provider.respondToRequest({
          threadId,
          requestId: asRequestId("request-from-old-generation"),
          lifecycleGeneration: String(firstGeneration),
          decision: "accept",
        }),
      );
      assertFailure(
        staleResponse,
        new ProviderValidationError({
          operation: "ProviderService.respondToRequest",
          issue: `Cannot respond to stale request 'request-from-old-generation' from provider generation '${String(firstGeneration)}'.`,
        }),
      );
      assert.equal(routing.codex.respondToRequest.mock.calls.length, responseCallCount);

      const userInputResponseCallCount = routing.codex.respondToUserInput.mock.calls.length;
      const staleUserInputResponse = yield* Effect.result(
        provider.respondToUserInput({
          threadId,
          requestId: asRequestId("user-input-from-old-generation"),
          lifecycleGeneration: String(firstGeneration),
          answers: { answer: "stale" },
        }),
      );
      assertFailure(
        staleUserInputResponse,
        new ProviderValidationError({
          operation: "ProviderService.respondToUserInput",
          issue: `Cannot respond to stale request 'user-input-from-old-generation' from provider generation '${String(firstGeneration)}'.`,
        }),
      );
      assert.equal(routing.codex.respondToUserInput.mock.calls.length, userInputResponseCallCount);

      yield* routing.codex.waitForRuntimeSubscribers();
      routing.codex.emit({
        type: "session.exited",
        eventId: asEventId("runtime-old-generation-exited"),
        provider: "codex",
        threadId,
        createdAt: "2026-07-14T14:00:00.000Z",
        lifecycleGeneration: String(firstGeneration),
        payload: { reason: "late old-runtime exit" },
      });
      yield* sleep(25);
      const bindingAfterStaleEvent = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(bindingAfterStaleEvent?.lifecycleGeneration, secondGeneration);
      assert.equal(bindingAfterStaleEvent?.status, "running");

      const defaultStart = routing.codex.startSession.getMockImplementation();
      if (!defaultStart) assert.fail("Expected the fake adapter start implementation");
      let releaseDelayedStart: () => void = () => undefined;
      const delayedStart = new Promise<void>((resolve) => {
        releaseDelayedStart = resolve;
      });
      routing.codex.startSession.mockImplementationOnce((input) =>
        Effect.promise(() => delayedStart).pipe(Effect.andThen(defaultStart(input))),
      );
      const startCallCount = routing.codex.startSession.mock.calls.length;
      const stopCallCount = routing.codex.stopSession.mock.calls.length;
      const startFiber = yield* provider.startSession(threadId, startInput).pipe(Effect.forkChild);
      yield* waitUntil(
        () => routing.codex.startSession.mock.calls.length > startCallCount,
        500,
        10,
        "delayed provider start",
      );
      const stopFiber = yield* provider.stopSession({ threadId }).pipe(Effect.forkChild);
      yield* sleep(25);
      assert.equal(routing.codex.stopSession.mock.calls.length, stopCallCount);

      releaseDelayedStart();
      yield* Fiber.join(startFiber);
      yield* Fiber.join(stopFiber);
      assert.equal(Option.isNone(yield* directory.getBinding(threadId)), true);
    }),
  );

  const staleSettlementPersistedEvents = new Map<string, ProviderRuntimeEvent>();
  const staleSettlementRouting = makeProviderServiceLayer({
    persistRuntimeEvent: (event) =>
      Effect.suspend(() => {
        staleSettlementPersistedEvents.set(String(event.eventId), event);
        return Effect.succeed({ sequence: staleSettlementPersistedEvents.size, event });
      }),
    runtimeEventRetryBaseDelayMs: 1,
    runtimeEventRetryMaxDelayMs: 1,
  });

  staleSettlementRouting.layer("ProviderServiceLive stale-generation settlement", (it) => {
    it.effect("processes stale terminal events when no lifecycle generation is current", () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("thread-stale-terminal-no-generation");
        yield* staleSettlementRouting.codex.waitForRuntimeSubscribers();

        // A thread with no current lifecycle generation (retired/stopped runtime)
        // must still accept the old session's terminal events: they are the only
        // signal left that can settle the binding and projection. Non-terminal
        // stale events stay dropped.
        staleSettlementRouting.codex.emit({
          type: "content.delta",
          eventId: asEventId("stale-delta-no-generation"),
          provider: "codex",
          threadId,
          createdAt: "2026-07-14T14:00:00.000Z",
          lifecycleGeneration: "old-generation",
          payload: { streamKind: "assistant_text", delta: "invisible" },
        });
        staleSettlementRouting.codex.emit({
          type: "session.exited",
          eventId: asEventId("stale-exit-no-generation"),
          provider: "codex",
          threadId,
          createdAt: "2026-07-14T14:00:01.000Z",
          lifecycleGeneration: "old-generation",
          payload: { reason: "late old-runtime exit", recoverable: false, exitKind: "error" },
        });
        staleSettlementRouting.codex.emit({
          type: "runtime.error",
          eventId: asEventId("stale-error-no-generation"),
          provider: "codex",
          threadId,
          createdAt: "2026-07-14T14:00:02.000Z",
          lifecycleGeneration: "old-generation",
          payload: {
            message: "OpenCode server exited unexpectedly (130).",
            class: "transport_error",
          },
        });

        yield* waitUntil(
          () => staleSettlementPersistedEvents.has("stale-exit-no-generation"),
          500,
          10,
          "stale session.exited to be persisted",
        );
        assert.equal(staleSettlementPersistedEvents.has("stale-delta-no-generation"), false);
        assert.equal(
          staleSettlementPersistedEvents.get("stale-exit-no-generation")?.type,
          "session.exited",
        );
        assert.equal(
          staleSettlementPersistedEvents.get("stale-error-no-generation")?.type,
          "runtime.error",
        );
      }),
    );

    it.effect("settles a stale terminal event naming the binding's active turn", () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("thread-stale-terminal-matching-turn");
        yield* staleSettlementRouting.codex.waitForRuntimeSubscribers();

        yield* provider.startSession(threadId, {
          provider: "codex",
          threadId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        yield* provider.sendTurn({ threadId, input: "hello", attachments: [] });
        const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const activeTurnId = asRuntimePayloadRecord(binding?.runtimePayload).activeTurnId;
        assert.equal(typeof activeTurnId, "string");

        // A stale terminal event that still names the binding's active turn is
        // accepted (it settles the same turn a newer epoch has not replaced); a
        // stale terminal event for a different turn stays dropped.
        staleSettlementRouting.codex.emit({
          type: "turn.aborted",
          eventId: asEventId("stale-abort-matching-turn"),
          provider: "codex",
          threadId,
          turnId: TurnId.makeUnsafe(String(activeTurnId)),
          createdAt: "2026-07-14T14:00:00.000Z",
          lifecycleGeneration: "old-generation",
          payload: { reason: "late abort for the bound turn" },
        });
        staleSettlementRouting.codex.emit({
          type: "turn.aborted",
          eventId: asEventId("stale-abort-other-turn"),
          provider: "codex",
          threadId,
          turnId: TurnId.makeUnsafe("turn-some-other"),
          createdAt: "2026-07-14T14:00:01.000Z",
          lifecycleGeneration: "old-generation",
          payload: { reason: "late abort for a different turn" },
        });

        yield* waitUntil(
          () => staleSettlementPersistedEvents.has("stale-abort-matching-turn"),
          500,
          10,
          "matching stale turn.aborted to be persisted",
        );
        const settledBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        assert.equal(asRuntimePayloadRecord(settledBinding?.runtimePayload).activeTurnId, null);
        assert.equal(settledBinding?.status, "stopped");
        assert.equal(staleSettlementPersistedEvents.has("stale-abort-other-turn"), false);
      }),
    );

    it.effect("recovers instead of routing into a session whose binding generation is stale", () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("thread-stale-binding-routing");
        yield* staleSettlementRouting.codex.waitForRuntimeSubscribers();

        yield* provider.startSession(threadId, {
          provider: "codex",
          threadId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        // Rotate the runtime generation (as a stop does), keep a live adapter
        // session around (the zombie), and rewind the persisted binding to the
        // old generation — a turn send must not fast-path into that session,
        // whose events the stale-generation gate would reject.
        assert.equal(typeof provider.stopRuntimeSession, "function");
        if (!provider.stopRuntimeSession) assert.fail("Expected stopRuntimeSession");
        yield* provider.stopRuntimeSession({ threadId });
        yield* directory.upsert({
          threadId,
          provider: "codex",
          status: "running",
          lifecycleGeneration: "old-generation",
          resumeCursor: { opaque: `resume-${String(threadId)}` },
          runtimePayload: { activeTurnId: null },
        });
        yield* staleSettlementRouting.codex.startSession({
          threadId,
          provider: "codex",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });

        const sendCallsBefore = staleSettlementRouting.codex.sendTurn.mock.calls.length;
        yield* provider.sendTurn({ threadId, input: "after the wedge", attachments: [] });
        assert.equal(staleSettlementRouting.codex.sendTurn.mock.calls.length, sendCallsBefore + 1);

        // Recovery re-adopts the persisted generation, so the still-live
        // session's events become visible again instead of being dropped.
        staleSettlementRouting.codex.emit({
          type: "content.delta",
          eventId: asEventId("stale-binding-delta"),
          provider: "codex",
          threadId,
          createdAt: "2026-07-14T14:00:00.000Z",
          lifecycleGeneration: "old-generation",
          payload: { streamKind: "assistant_text", delta: "visible again" },
        });
        yield* waitUntil(
          () => staleSettlementPersistedEvents.has("stale-binding-delta"),
          500,
          10,
          "delta from the re-adopted generation to be persisted",
        );
      }),
    );
  });

  it.effect("serializes overlapping same-provider and cross-provider starts", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-overlapping-provider-starts");
      const codexInput: ProviderSessionStartInput = {
        provider: "codex",
        threadId,
        cwd: "/tmp/provider-starts",
        runtimeMode: "full-access",
      };

      yield* provider.startSession(threadId, codexInput);
      const defaultCodexStart = routing.codex.startSession.getMockImplementation();
      if (!defaultCodexStart) assert.fail("Expected the fake Codex start implementation");

      let releaseSameProviderStart: () => void = () => undefined;
      const delayedSameProviderStart = new Promise<void>((resolve) => {
        releaseSameProviderStart = resolve;
      });
      routing.codex.startSession.mockImplementationOnce((input) =>
        Effect.promise(() => delayedSameProviderStart).pipe(
          Effect.andThen(defaultCodexStart(input)),
        ),
      );
      const codexStartCount = routing.codex.startSession.mock.calls.length;
      const claudeStartCount = routing.claude.startSession.mock.calls.length;

      const sameProviderFiber = yield* provider
        .startSession(threadId, codexInput)
        .pipe(Effect.forkChild);
      yield* waitUntil(
        () => routing.codex.startSession.mock.calls.length > codexStartCount,
        500,
        10,
        "same-provider start",
      );
      const crossProviderFiber = yield* provider
        .startSession(threadId, {
          provider: "claudeAgent",
          threadId,
          cwd: "/tmp/provider-starts",
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* sleep(25);
      assert.equal(routing.claude.startSession.mock.calls.length, claudeStartCount);

      releaseSameProviderStart();
      yield* Fiber.join(sameProviderFiber);
      yield* Fiber.join(crossProviderFiber);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const [codexSessions, claudeSessions] = yield* Effect.all([
        routing.codex.listSessions(),
        routing.claude.listSessions(),
      ]);
      assert.equal(binding?.provider, "claudeAgent");
      assert.equal(
        codexSessions.some((session) => session.threadId === threadId),
        false,
      );
      assert.equal(claudeSessions.filter((session) => session.threadId === threadId).length, 1);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("restores the previous runtime and generation when provider replacement fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-failed-provider-replacement");
      const initial = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/failed-provider-replacement",
        runtimeMode: "full-access",
      });
      const originalBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const replacementFailure = new ProviderAdapterSessionNotFoundError({
        provider: "claudeAgent",
        threadId,
      });
      routing.claude.startSession.mockImplementationOnce(() => Effect.fail(replacementFailure));

      const replacement = yield* Effect.result(
        provider.startSession(threadId, {
          provider: "claudeAgent",
          threadId,
          cwd: "/tmp/failed-provider-replacement",
          runtimeMode: "full-access",
        }),
      );
      assertFailure(replacement, replacementFailure);

      const restoredBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const [codexSessions, claudeSessions] = yield* Effect.all([
        routing.codex.listSessions(),
        routing.claude.listSessions(),
      ]);
      const restoreCall = routing.codex.startSession.mock.calls.findLast(
        ([input]) => input.threadId === threadId,
      )?.[0];
      assert.equal(restoredBinding?.provider, "codex");
      assert.equal(restoredBinding?.status, "running");
      assert.equal(restoredBinding?.lifecycleGeneration, originalBinding?.lifecycleGeneration);
      assert.equal(codexSessions.filter((session) => session.threadId === threadId).length, 1);
      assert.equal(
        claudeSessions.some((session) => session.threadId === threadId),
        false,
      );
      assert.deepEqual(restoreCall?.resumeCursor, initial.resumeCursor);
      assert.equal(restoreCall?.lifecycleGeneration, originalBinding?.lifecycleGeneration);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("serializes recovery before a competing provider start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-recovery-start-race");
      const initial = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/recovery-start-race",
        runtimeMode: "full-access",
      });
      assert.equal(typeof provider.stopRuntimeSession, "function");
      if (!provider.stopRuntimeSession) assert.fail("Expected stopRuntimeSession");
      yield* provider.stopRuntimeSession({ threadId });

      const defaultCodexStart = routing.codex.startSession.getMockImplementation();
      if (!defaultCodexStart) assert.fail("Expected the fake Codex start implementation");
      let releaseRecovery: () => void = () => undefined;
      const delayedRecovery = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      routing.codex.startSession.mockImplementationOnce((input) =>
        Effect.promise(() => delayedRecovery).pipe(Effect.andThen(defaultCodexStart(input))),
      );
      const codexStartCount = routing.codex.startSession.mock.calls.length;
      const claudeStartCount = routing.claude.startSession.mock.calls.length;

      const recoveryFiber = yield* provider
        .sendTurn({ threadId, input: "recover", attachments: [] })
        .pipe(Effect.forkChild);
      yield* waitUntil(
        () => routing.codex.startSession.mock.calls.length > codexStartCount,
        500,
        10,
        "provider recovery start",
      );
      const competingStartFiber = yield* provider
        .startSession(threadId, {
          provider: "claudeAgent",
          threadId,
          cwd: "/tmp/recovery-start-race",
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* sleep(25);
      assert.equal(routing.claude.startSession.mock.calls.length, claudeStartCount);

      releaseRecovery();
      yield* Fiber.join(recoveryFiber);
      yield* Fiber.join(competingStartFiber);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const [codexSessions, claudeSessions] = yield* Effect.all([
        routing.codex.listSessions(),
        routing.claude.listSessions(),
      ]);
      const recoveryCall = routing.codex.startSession.mock.calls.findLast(
        ([input]) => input.threadId === threadId,
      )?.[0];
      assert.equal(binding?.provider, "claudeAgent");
      assert.equal(
        codexSessions.some((session) => session.threadId === threadId),
        false,
      );
      assert.equal(claudeSessions.filter((session) => session.threadId === threadId).length, 1);
      assert.deepEqual(recoveryCall?.resumeCursor, initial.resumeCursor);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("requires the source lifecycle generation for modern Claude interactions", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-claude-interaction-generation");

      yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const lifecycleGeneration = binding?.lifecycleGeneration;
      assert.equal(typeof lifecycleGeneration, "string");

      const approvalCallCount = routing.claude.respondToRequest.mock.calls.length;
      const missingApprovalGeneration = yield* Effect.result(
        provider.respondToRequest({
          threadId,
          requestId: asRequestId("claude-approval-without-generation"),
          decision: "accept",
        }),
      );
      assertFailure(
        missingApprovalGeneration,
        new ProviderValidationError({
          operation: "ProviderService.respondToRequest",
          issue:
            "Cannot respond to request 'claude-approval-without-generation' without its provider lifecycle generation.",
        }),
      );
      assert.equal(routing.claude.respondToRequest.mock.calls.length, approvalCallCount);

      const userInputCallCount = routing.claude.respondToUserInput.mock.calls.length;
      const missingUserInputGeneration = yield* Effect.result(
        provider.respondToUserInput({
          threadId,
          requestId: asRequestId("claude-user-input-without-generation"),
          answers: { answer: "continue" },
        }),
      );
      assertFailure(
        missingUserInputGeneration,
        new ProviderValidationError({
          operation: "ProviderService.respondToUserInput",
          issue:
            "Cannot respond to request 'claude-user-input-without-generation' without its provider lifecycle generation.",
        }),
      );
      assert.equal(routing.claude.respondToUserInput.mock.calls.length, userInputCallCount);

      yield* provider.respondToRequest({
        threadId,
        requestId: asRequestId("claude-approval-current-generation"),
        lifecycleGeneration,
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId,
        requestId: asRequestId("claude-user-input-current-generation"),
        lifecycleGeneration,
        answers: { answer: "continue" },
      });
      assert.equal(routing.claude.respondToRequest.mock.calls.length, approvalCallCount + 1);
      assert.equal(routing.claude.respondToUserInput.mock.calls.length, userInputCallCount + 1);
      yield* provider.stopSession({ threadId });
      routing.claude.startSession.mockClear();
      routing.claude.respondToRequest.mockClear();
      routing.claude.respondToUserInput.mockClear();
      routing.claude.stopSession.mockClear();
    }),
  );

  it.effect("requires the source lifecycle generation for modern Antigravity approvals", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-antigravity-interaction-generation");

      yield* provider.startSession(threadId, {
        provider: "antigravity",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const lifecycleGeneration = binding?.lifecycleGeneration;
      assert.equal(typeof lifecycleGeneration, "string");

      const responseCallCount = routing.antigravity.respondToRequest.mock.calls.length;
      const missingGeneration = yield* Effect.result(
        provider.respondToRequest({
          threadId,
          requestId: asRequestId("antigravity-approval-without-generation"),
          decision: "accept",
        }),
      );
      assertFailure(
        missingGeneration,
        new ProviderValidationError({
          operation: "ProviderService.respondToRequest",
          issue:
            "Cannot respond to request 'antigravity-approval-without-generation' without its provider lifecycle generation.",
        }),
      );
      assert.equal(routing.antigravity.respondToRequest.mock.calls.length, responseCallCount);

      yield* provider.respondToRequest({
        threadId,
        requestId: asRequestId("antigravity-approval-current-generation"),
        lifecycleGeneration,
        decision: "accept",
      });
      assert.equal(routing.antigravity.respondToRequest.mock.calls.length, responseCallCount + 1);

      yield* provider.stopSession({ threadId });
      routing.antigravity.startSession.mockClear();
      routing.antigravity.respondToRequest.mockClear();
      routing.antigravity.stopSession.mockClear();
    }),
  );

  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      routing.codex.sendTurn.mockClear();
      routing.codex.interruptTurn.mockClear();
      routing.codex.startSession.mockClear();
      routing.codex.stopSession.mockClear();
      routing.codex.respondToRequest.mockClear();
      routing.codex.respondToUserInput.mockClear();

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");
      const binding = Option.getOrUndefined(yield* directory.getBinding(session.threadId));
      const lifecycleGeneration = binding?.lifecycleGeneration;
      assert.equal(typeof lifecycleGeneration, "string");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        lifecycleGeneration,
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        lifecycleGeneration,
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [
        [session.threadId, asTurnId("turn-thread-1"), undefined],
      ]);
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[session.threadId]]);
      const fencedBinding = Option.getOrUndefined(yield* directory.getBinding(session.threadId));
      assert.equal(fencedBinding?.status, "stopped");
      assert.equal(
        asRuntimePayloadRecord(fencedBinding?.runtimePayload)
          .agentGatewayCredentialRotationRequired,
        true,
      );

      const startsBeforeRecovery = routing.codex.startSession.mock.calls.length;
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "continue after interrupt",
        attachments: [],
      });
      assert.equal(routing.codex.startSession.mock.calls.length, startsBeforeRecovery + 1);
      const resumedInput = routing.codex.startSession.mock.calls.at(-1)?.[0];
      assert.deepEqual(resumedInput?.resumeCursor, session.resumeCursor);
      const recoveredBinding = Option.getOrUndefined(yield* directory.getBinding(session.threadId));
      assert.equal(
        asRuntimePayloadRecord(recoveredBinding?.runtimePayload)
          .agentGatewayCredentialRotationRequired,
        false,
      );

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      const sendAfterStop = yield* Effect.result(
        provider.sendTurn({
          threadId: session.threadId,
          input: "after-stop",
          attachments: [],
        }),
      );
      assertFailure(
        sendAfterStop,
        new ProviderValidationError({
          operation: "ProviderService.sendTurn",
          issue: `Cannot route thread '${session.threadId}' because no persisted provider binding exists.`,
        }),
      );
    }),
  );

  it.effect("uses the authoritative active turn when an interrupt carries stale UI state", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-exact-interrupt");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({ threadId, input: "hello", attachments: [] });
      routing.codex.interruptTurn.mockClear();

      yield* provider.interruptTurn({
        threadId,
        turnId: asTurnId("turn-stale"),
      });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [
        [threadId, asTurnId("turn-thread-exact-interrupt"), undefined],
      ]);
    }),
  );

  it.effect("rotates the shared gateway credential after a targeted child interrupt", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-child-interrupt-credential-rotation");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });
      const startsBeforeRotation = routing.codex.startSession.mock.calls.length;
      const stopsBeforeRotation = routing.codex.stopSession.mock.calls.length;

      yield* provider.interruptTurn({
        threadId,
        turnId: asTurnId("turn-child-A"),
        providerThreadId: "provider-child-A",
      });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls.at(-1), [
        threadId,
        asTurnId("turn-child-A"),
        "provider-child-A",
      ]);
      assert.equal(routing.codex.stopSession.mock.calls.length, stopsBeforeRotation);
      const flaggedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(
        asRuntimePayloadRecord(flaggedBinding?.runtimePayload)
          .agentGatewayCredentialRotationRequired,
        true,
      );

      yield* provider.sendTurn({ threadId, input: "turn B", attachments: [] });
      assert.equal(routing.codex.stopSession.mock.calls.length, stopsBeforeRotation + 1);
      assert.equal(routing.codex.startSession.mock.calls.length, startsBeforeRotation + 1);
      const recoveredBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(
        asRuntimePayloadRecord(recoveredBinding?.runtimePayload)
          .agentGatewayCredentialRotationRequired,
        false,
      );

      const interruptsAfterFirstStop = routing.codex.interruptTurn.mock.calls.length;
      const startsAfterRotation = routing.codex.startSession.mock.calls.length;
      const stopsAfterRotation = routing.codex.stopSession.mock.calls.length;
      yield* provider.interruptTurn({
        threadId,
        turnId: asTurnId("turn-child-A"),
        providerThreadId: "provider-child-A",
      });
      assert.equal(routing.codex.interruptTurn.mock.calls.length, interruptsAfterFirstStop);
      const duplicateBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(
        asRuntimePayloadRecord(duplicateBinding?.runtimePayload)
          .agentGatewayCredentialRotationRequired,
        false,
      );
      yield* provider.sendTurn({ threadId, input: "turn C", attachments: [] });
      assert.equal(routing.codex.startSession.mock.calls.length, startsAfterRotation);
      assert.equal(routing.codex.stopSession.mock.calls.length, stopsAfterRotation);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect(
    "retires A's runtime before admitting B while allowing background tasks to finish",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("thread-terminal-gateway-credential-rotation");
        const turnA = asTurnId(`turn-${threadId}`);

        yield* provider.startSession(threadId, {
          provider: "codex",
          threadId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        const initialBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const lifecycleGeneration = initialBinding?.lifecycleGeneration;
        assert.equal(typeof lifecycleGeneration, "string");
        yield* routing.codex.waitForRuntimeSubscribers();
        yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });
        routing.codex.emit({
          type: "task.started",
          eventId: asEventId("terminal-rotation-background-started"),
          provider: "codex",
          createdAt: "2026-07-23T12:00:00.000Z",
          threadId,
          lifecycleGeneration,
          payload: { taskId: "background-after-a" },
        });
        if (provider.hasLiveRuntimeTasks) {
          yield* waitUntilEffect(
            () => provider.hasLiveRuntimeTasks!({ threadId }),
            500,
            20,
            "background task ownership before terminal rotation",
          );
        }
        routing.codex.emit({
          type: "turn.completed",
          eventId: asEventId("terminal-rotation-turn-a-completed"),
          provider: "codex",
          createdAt: "2026-07-23T12:00:01.000Z",
          threadId,
          turnId: turnA,
          lifecycleGeneration,
          payload: { state: "completed" },
          raw: {
            source: "codex.app-server.notification",
            method: "turn/completed",
            payload: { [AGENT_GATEWAY_TURN_AUTHORITY_RETIRED]: true },
          },
        });
        yield* waitUntilEffect(
          () =>
            directory.getBinding(threadId).pipe(
              Effect.map(
                Option.match({
                  onNone: () => false,
                  onSome: (binding) =>
                    asRuntimePayloadRecord(binding.runtimePayload)
                      .agentGatewayCredentialRotationRequired === true,
                }),
              ),
            ),
          500,
          20,
          "terminal credential retirement persistence",
        );

        const startsBeforeB = routing.codex.startSession.mock.calls.length;
        const stopsBeforeB = routing.codex.stopSession.mock.calls.length;
        const sendsBeforeB = routing.codex.sendTurn.mock.calls.length;
        const turnB = yield* provider
          .sendTurn({ threadId, input: "turn B", attachments: [] })
          .pipe(Effect.forkChild);
        yield* sleep(25);
        assert.equal(routing.codex.stopSession.mock.calls.length, stopsBeforeB);
        assert.equal(routing.codex.startSession.mock.calls.length, startsBeforeB);
        assert.equal(routing.codex.sendTurn.mock.calls.length, sendsBeforeB);

        routing.codex.emit({
          type: "task.updated",
          eventId: asEventId("terminal-rotation-background-completed"),
          provider: "codex",
          createdAt: "2026-07-23T12:00:02.000Z",
          threadId,
          lifecycleGeneration,
          payload: { taskId: "background-after-a", status: "completed" },
        });
        yield* Fiber.join(turnB);

        assert.equal(routing.codex.stopSession.mock.calls.length, stopsBeforeB + 1);
        assert.equal(routing.codex.startSession.mock.calls.length, startsBeforeB + 1);
        assert.equal(routing.codex.sendTurn.mock.calls.length, sendsBeforeB + 1);
        const recoveredBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        assert.equal(
          asRuntimePayloadRecord(recoveredBinding?.runtimePayload)
            .agentGatewayCredentialRotationRequired,
          false,
        );

        yield* provider.stopSession({ threadId });
      }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect("rotates a terminal turn's retired gateway session before the next turn is sent", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-proactive-terminal-gateway-rotation");
      const turnA = asTurnId(`turn-${threadId}`);

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const initialBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const lifecycleGeneration = initialBinding?.lifecycleGeneration;
      assert.equal(typeof lifecycleGeneration, "string");
      yield* routing.codex.waitForRuntimeSubscribers();
      yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });

      const startsBeforeRotation = routing.codex.startSession.mock.calls.length;
      const stopsBeforeRotation = routing.codex.stopSession.mock.calls.length;
      routing.codex.emit({
        type: "turn.completed",
        eventId: asEventId("proactive-terminal-rotation-turn-a-completed"),
        provider: "codex",
        createdAt: "2026-07-23T13:00:01.000Z",
        threadId,
        turnId: turnA,
        lifecycleGeneration,
        payload: { state: "completed" },
        raw: {
          source: "codex.app-server.notification",
          method: "turn/completed",
          payload: { [AGENT_GATEWAY_TURN_AUTHORITY_RETIRED]: true },
        },
      });

      yield* waitUntilEffect(
        () =>
          directory.getBinding(threadId).pipe(
            Effect.map((binding) => {
              const current = Option.getOrUndefined(binding);
              return (
                routing.codex.stopSession.mock.calls.length === stopsBeforeRotation + 1 &&
                routing.codex.startSession.mock.calls.length === startsBeforeRotation + 1 &&
                asRuntimePayloadRecord(current?.runtimePayload)
                  .agentGatewayCredentialRotationRequired === false
              );
            }),
          ),
        500,
        20,
        "proactive terminal credential rotation",
      );

      const startsBeforeB = routing.codex.startSession.mock.calls.length;
      const stopsBeforeB = routing.codex.stopSession.mock.calls.length;
      const sendsBeforeB = routing.codex.sendTurn.mock.calls.length;
      yield* provider.sendTurn({ threadId, input: "turn B", attachments: [] });
      assert.equal(routing.codex.stopSession.mock.calls.length, stopsBeforeB);
      assert.equal(routing.codex.startSession.mock.calls.length, startsBeforeB);
      assert.equal(routing.codex.sendTurn.mock.calls.length, sendsBeforeB + 1);

      yield* provider.stopSession({ threadId });
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect(
    "fences a next turn before a targeted child interrupt acquires lifecycle ownership",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("thread-child-interrupt-preflight-fence");
        const responseStarted = yield* Deferred.make<void>();
        const releaseResponse = yield* Deferred.make<void>();
        const defaultRespond = routing.codex.respondToRequest.getMockImplementation();
        assert.isDefined(defaultRespond);
        routing.codex.respondToRequest.mockImplementationOnce((...args) =>
          Deferred.succeed(responseStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseResponse)),
            Effect.andThen(defaultRespond!(...args)),
          ),
        );

        yield* provider.startSession(threadId, {
          provider: "codex",
          threadId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });
        const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        assert.isDefined(binding?.lifecycleGeneration);
        const sendsBeforeB = routing.codex.sendTurn.mock.calls.length;

        const heldLifecycle = yield* provider
          .respondToRequest({
            threadId,
            requestId: asRequestId("request-holding-lifecycle"),
            lifecycleGeneration: binding!.lifecycleGeneration,
            decision: "accept",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(responseStarted);
        const targetedInterrupt = yield* provider
          .interruptTurn({
            threadId,
            turnId: asTurnId("turn-child-A"),
            providerThreadId: "provider-child-A",
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const nextTurn = yield* provider
          .sendTurn({ threadId, input: "turn B", attachments: [] })
          .pipe(Effect.forkChild);
        yield* sleep(10);
        assert.equal(routing.codex.sendTurn.mock.calls.length, sendsBeforeB);

        yield* Deferred.succeed(releaseResponse, undefined);
        yield* Fiber.join(heldLifecycle);
        yield* Fiber.join(targetedInterrupt);
        yield* Fiber.join(nextTurn);
        assert.equal(routing.codex.sendTurn.mock.calls.length, sendsBeforeB + 1);

        yield* provider.stopSession({ threadId });
      }),
  );

  it.effect("tombstones a targeted child stop even when its native interrupt fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-child-interrupt-uncertain-failure");
      routing.codex.interruptTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: "codex",
            threadId,
          }),
        ),
      );

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });
      const firstStop = yield* Effect.exit(
        provider.interruptTurn({
          threadId,
          turnId: asTurnId("turn-child-failed"),
          providerThreadId: "provider-child-failed",
        }),
      );
      assert.equal(Exit.isFailure(firstStop), true);
      const interruptCallsAfterFailure = routing.codex.interruptTurn.mock.calls.length;

      yield* provider.interruptTurn({
        threadId,
        turnId: asTurnId("turn-child-failed"),
        providerThreadId: "provider-child-failed",
      });
      assert.equal(routing.codex.interruptTurn.mock.calls.length, interruptCallsAfterFailure + 1);
      const interruptCallsAfterRetry = routing.codex.interruptTurn.mock.calls.length;

      yield* provider.sendTurn({ threadId, input: "turn B", attachments: [] });
      const startsAfterRotation = routing.codex.startSession.mock.calls.length;
      const stopsAfterRotation = routing.codex.stopSession.mock.calls.length;
      yield* provider.interruptTurn({
        threadId,
        turnId: asTurnId("turn-child-failed"),
        providerThreadId: "provider-child-failed",
      });
      assert.equal(routing.codex.interruptTurn.mock.calls.length, interruptCallsAfterRetry);

      yield* provider.sendTurn({ threadId, input: "turn C", attachments: [] });
      assert.equal(routing.codex.startSession.mock.calls.length, startsAfterRotation);
      assert.equal(routing.codex.stopSession.mock.calls.length, stopsAfterRotation);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("holds a concurrent next turn behind interrupted-runtime credential rotation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-interrupt-credential-fence");
      const stopStarted = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      const defaultStop = routing.codex.stopSession.getMockImplementation();
      assert.isDefined(defaultStop);
      routing.codex.stopSession.mockImplementationOnce((stoppedThreadId) =>
        Deferred.succeed(stopStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStop)),
          Effect.andThen(defaultStop!(stoppedThreadId)),
        ),
      );

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });
      const sendCallsBeforeB = routing.codex.sendTurn.mock.calls.length;

      const interrupted = yield* provider.interruptTurn({ threadId }).pipe(Effect.forkChild);
      yield* Deferred.await(stopStarted);
      const nextTurn = yield* provider
        .sendTurn({ threadId, input: "turn B", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(routing.codex.sendTurn.mock.calls.length, sendCallsBeforeB);

      yield* Deferred.succeed(releaseStop, undefined);
      yield* Fiber.join(interrupted);
      yield* Fiber.join(nextTurn);
      assert.equal(routing.codex.sendTurn.mock.calls.length, sendCallsBeforeB + 1);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("holds an explicit session replacement behind interrupted-runtime retirement", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-interrupt-start-fence");
      const stopStarted = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      const defaultStop = routing.codex.stopSession.getMockImplementation();
      assert.isDefined(defaultStop);
      routing.codex.stopSession.mockImplementationOnce((stoppedThreadId) =>
        Deferred.succeed(stopStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStop)),
          Effect.andThen(defaultStop!(stoppedThreadId)),
        ),
      );

      const startInput = {
        provider: "codex" as const,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access" as const,
      };
      yield* provider.startSession(threadId, startInput);
      yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });
      const startsBeforeReplacement = routing.codex.startSession.mock.calls.length;

      const interrupted = yield* provider.interruptTurn({ threadId }).pipe(Effect.forkChild);
      yield* Deferred.await(stopStarted);
      const replacement = yield* provider.startSession(threadId, startInput).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(routing.codex.startSession.mock.calls.length, startsBeforeReplacement);

      yield* Deferred.succeed(releaseStop, undefined);
      yield* Fiber.join(interrupted);
      yield* Fiber.join(replacement);
      assert.equal(routing.codex.startSession.mock.calls.length, startsBeforeReplacement + 1);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("settles the interruption fence when its caller is cancelled during teardown", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-interrupt-caller-cancelled");
      const stopStarted = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      const defaultStop = routing.codex.stopSession.getMockImplementation();
      assert.isDefined(defaultStop);
      routing.codex.stopSession.mockImplementationOnce((stoppedThreadId) =>
        Deferred.succeed(stopStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStop)),
          Effect.andThen(defaultStop!(stoppedThreadId)),
        ),
      );

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });
      const sendsBeforeRecovery = routing.codex.sendTurn.mock.calls.length;

      const interrupted = yield* provider.interruptTurn({ threadId }).pipe(Effect.forkChild);
      yield* Deferred.await(stopStarted);
      const cancellation = yield* Fiber.interrupt(interrupted).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Deferred.succeed(releaseStop, undefined);
      yield* Fiber.join(cancellation);
      yield* provider.sendTurn({ threadId, input: "turn B", attachments: [] });
      assert.equal(routing.codex.sendTurn.mock.calls.length, sendsBeforeRecovery + 1);

      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("fails closed when the interrupted runtime cannot be retired", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-interrupt-retirement-failure");
      routing.codex.stopSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: "codex",
            threadId,
          }),
        ),
      );

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });
      assert.equal(Exit.isFailure(yield* Effect.exit(provider.interruptTurn({ threadId }))), true);

      const staleSecondInterrupt = yield* Effect.exit(
        provider.interruptTurn({ threadId, turnId: asTurnId("turn-stale-after-failure") }),
      );
      assert.equal(Exit.isFailure(staleSecondInterrupt), true);
      if (Exit.isFailure(staleSecondInterrupt)) {
        const failure = Cause.squash(staleSecondInterrupt.cause);
        assert.instanceOf(failure, ProviderValidationError);
        assert.match(failure.issue, /previous runtime could not be retired safely/);
      }

      const blocked = yield* Effect.exit(
        provider.sendTurn({ threadId, input: "turn B", attachments: [] }),
      );
      assert.equal(Exit.isFailure(blocked), true);
      if (Exit.isFailure(blocked)) {
        const failure = Cause.squash(blocked.cause);
        assert.instanceOf(failure, ProviderValidationError);
        assert.equal(failure.operation, "ProviderService.turnDispatch");
        assert.match(failure.issue, /could not be retired safely/);
      }

      // An explicit session replacement is the recovery authority after a
      // failed teardown and clears the fail-closed fence.
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect(
    "routes early approval and user-input responses to live sessions before persistence",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("thread-live-startup-prompt");

        routing.codex.respondToRequest.mockClear();
        routing.codex.respondToUserInput.mockClear();
        yield* routing.codex.adapter.startSession({
          provider: "codex",
          threadId,
          runtimeMode: "approval-required",
        });

        const bindingBeforeResponse = yield* directory.getBinding(threadId);
        assert.equal(Option.isNone(bindingBeforeResponse), true);

        yield* provider.respondToRequest({
          threadId,
          requestId: asRequestId("req-live-approval"),
          decision: "accept",
        });
        yield* provider.respondToUserInput({
          threadId,
          requestId: asRequestId("req-live-user-input"),
          answers: {
            answer: "continue",
          },
        });

        assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
          [threadId, asRequestId("req-live-approval"), "accept"],
        ]);
        assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
          [
            threadId,
            asRequestId("req-live-user-input"),
            {
              answer: "continue",
            },
          ],
        ]);
      }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as { provider?: string; cwd?: string };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(startPayload.modelSelection, {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        });
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: "codex",
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, process.cwd());
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("clears persisted active turn metadata when a runtime turn completes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-complete"), {
        provider: "codex",
        threadId: asThreadId("thread-runtime-complete"),
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
        modelSelection: {
          provider: "opencode",
          model: "opencode/minimax-m2.5-free",
        },
      });
      yield* sleep(50);

      routing.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-complete-event"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId: session.threadId,
        turnId: turn.turnId,
        payload: { state: "completed" },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "stopped");
        const payload = runtime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            activeTurnId: string | null;
            lastRuntimeEvent: string | null;
            modelSelection?: unknown;
          };
          assert.equal(runtimePayload.activeTurnId, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "turn.completed");
          assert.deepEqual(runtimePayload.modelSelection, {
            provider: "opencode",
            model: "opencode/minimax-m2.5-free",
          });
        }
      }
    }),
  );

  it.effect("keeps a newer binding active when an overlapping older turn completes late", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-overlapping-stale-terminal");
      const olderTurnId = asTurnId("turn-overlapping-older");
      const newerTurnId = asTurnId("turn-overlapping-newer");
      const olderResumeCursor = { cursor: "older-resume" };
      const newerResumeCursor = { cursor: "newer-resume" };
      const olderModelSelection = { provider: "codex" as const, model: "gpt-5.1-codex-mini" };
      const newerModelSelection = {
        provider: "opencode" as const,
        model: "opencode/minimax-m2.5-free",
      };
      let olderDispatchStarted = false;
      let releaseOlderDispatch: ((result: ProviderTurnStartResult) => void) | undefined;

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<ProviderTurnStartResult>((resolve) => {
                olderDispatchStarted = true;
                releaseOlderDispatch = resolve;
              }),
          ),
        )
        .mockImplementationOnce((input) =>
          Effect.succeed({
            threadId: input.threadId,
            turnId: newerTurnId,
            resumeCursor: newerResumeCursor,
          }),
        );

      const olderSendFiber = yield* provider
        .sendTurn({
          threadId,
          input: "older",
          attachments: [],
          modelSelection: olderModelSelection,
        })
        .pipe(Effect.forkChild);
      yield* waitUntil(() => olderDispatchStarted, 500, 20, "older turn dispatch");
      yield* provider.sendTurn({
        threadId,
        input: "newer",
        attachments: [],
        modelSelection: newerModelSelection,
      });

      yield* routing.codex.waitForRuntimeSubscribers();
      routing.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-overlapping-older-completed"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        turnId: olderTurnId,
        payload: { state: "completed" },
      });
      yield* sleep(50);

      const release = releaseOlderDispatch;
      if (!release) {
        assert.fail("Expected delayed older dispatch release callback");
      }
      release({ threadId, turnId: olderTurnId, resumeCursor: olderResumeCursor });
      yield* Fiber.join(olderSendFiber);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const runtimePayload = asRuntimePayloadRecord(binding?.runtimePayload);
      assert.equal(binding?.status, "running");
      assert.deepEqual(binding?.resumeCursor, newerResumeCursor);
      assert.equal(runtimePayload.activeTurnId, newerTurnId);
      assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
      assert.deepEqual(runtimePayload.modelSelection, newerModelSelection);
    }),
  );

  it.effect("keeps the newer invocation active when an older dispatch returns last", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-overlapping-return-order");
      const olderTurnId = asTurnId("turn-return-order-older");
      const newerTurnId = asTurnId("turn-return-order-newer");
      let releaseOlder: ((result: ProviderTurnStartResult) => void) | undefined;

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<ProviderTurnStartResult>((resolve) => {
                releaseOlder = resolve;
              }),
          ),
        )
        .mockImplementationOnce((input) =>
          Effect.succeed({
            threadId: input.threadId,
            turnId: newerTurnId,
            resumeCursor: { cursor: "newer" },
          }),
        );

      const olderFiber = yield* provider
        .sendTurn({ threadId, input: "older", attachments: [] })
        .pipe(Effect.forkChild);
      yield* waitUntil(() => releaseOlder !== undefined, 500, 20, "older dispatch start");
      yield* provider.sendTurn({ threadId, input: "newer", attachments: [] });
      releaseOlder?.({ threadId, turnId: olderTurnId, resumeCursor: { cursor: "older" } });
      yield* Fiber.join(olderFiber);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const payload = binding?.runtimePayload as Record<string, unknown>;
      assert.equal(payload.activeTurnId, newerTurnId);
      assert.deepEqual(binding?.resumeCursor, { cursor: "newer" });
    }),
  );

  it.effect("promotes an older successful dispatch when the newer invocation fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-promote-older-success");
      const olderTurnId = asTurnId("turn-promoted-older");
      const olderCursor = { cursor: "promoted-older" };
      const olderModelSelection = { provider: "codex" as const, model: "gpt-5-codex" };
      const newerFailure = new ProviderAdapterSessionNotFoundError({
        provider: "codex",
        threadId,
      });
      let releaseOlder: ((result: ProviderTurnStartResult) => void) | undefined;
      let failNewer: (() => void) | undefined;

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<ProviderTurnStartResult>((resolve) => {
                releaseOlder = resolve;
              }),
          ),
        )
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                failNewer = resolve;
              }),
          ).pipe(Effect.andThen(Effect.fail(newerFailure))),
        );

      const olderFiber = yield* provider
        .sendTurn({
          threadId,
          input: "older",
          attachments: [],
          modelSelection: olderModelSelection,
        })
        .pipe(Effect.forkChild);
      yield* waitUntil(() => releaseOlder !== undefined, 500, 20, "older dispatch start");
      const newerFiber = yield* provider
        .sendTurn({ threadId, input: "newer", attachments: [] })
        .pipe(Effect.forkChild);
      yield* waitUntil(() => failNewer !== undefined, 500, 20, "newer dispatch start");

      releaseOlder?.({ threadId, turnId: olderTurnId, resumeCursor: olderCursor });
      yield* Fiber.join(olderFiber);
      const beforeNewerFailure = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const beforeFailurePayload = beforeNewerFailure?.runtimePayload as
        | Record<string, unknown>
        | undefined;
      assert.notEqual(beforeFailurePayload?.activeTurnId, olderTurnId);

      failNewer?.();
      const failedResult = yield* Effect.result(Fiber.join(newerFiber));
      assertFailure(failedResult, newerFailure);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const payload = binding?.runtimePayload as Record<string, unknown>;
      assert.equal(binding?.status, "running");
      assert.equal(payload.activeTurnId, olderTurnId);
      assert.deepEqual(binding?.resumeCursor, olderCursor);
      assert.deepEqual(payload.modelSelection, olderModelSelection);
    }),
  );

  it.effect("rolls back turn bookkeeping when started-turn persistence fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-started-persistence-failure");
      const failedTurnId = asTurnId("turn-persistence-failed");
      const nextTurnId = asTurnId("turn-after-persistence-failure");
      const persistenceFailure = new ProviderSessionDirectoryPersistenceError({
        operation: "test",
        detail: "injected started-turn persistence failure",
      });

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn
        .mockImplementationOnce((input) =>
          Effect.succeed({ threadId: input.threadId, turnId: failedTurnId }),
        )
        .mockImplementationOnce((input) =>
          Effect.succeed({ threadId: input.threadId, turnId: nextTurnId }),
        );
      const upsertSpy = vi
        .spyOn(directory, "upsert")
        .mockImplementationOnce(() => Effect.fail(persistenceFailure));

      const failedResult = yield* Effect.result(
        provider.sendTurn({ threadId, input: "fails to persist", attachments: [] }),
      );
      assertFailure(failedResult, persistenceFailure);
      upsertSpy.mockRestore();

      yield* provider.sendTurn({ threadId, input: "next turn", attachments: [] });
      yield* routing.codex.waitForRuntimeSubscribers();
      routing.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-unscoped-after-persistence-failure"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });
      yield* sleep(50);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const payload = binding?.runtimePayload as Record<string, unknown>;
      assert.equal(binding?.status, "stopped");
      assert.equal(payload.activeTurnId, null);
      assert.equal(payload.lastRuntimeEvent, "turn.completed");
    }),
  );

  it.effect("ignores subagent-scoped runtime events for the parent binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-subagent-scoped-events");
      const turnId = asTurnId("turn-parent-live");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Effect.succeed({ threadId: input.threadId, turnId }),
      );
      yield* provider.sendTurn({ threadId, input: "spawn a subagent", attachments: [] });
      yield* routing.codex.waitForRuntimeSubscribers();

      // A stopped subagent completes its child turn and flips its child session
      // to ready — both events ride the parent thread id with the child
      // identity in providerRefs. Neither may clear the parent's active turn.
      const subagentRefs = {
        providerThreadId: "toolu_subagent_1",
        providerParentThreadId: String(threadId),
      };
      routing.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-subagent-turn-completed"),
        provider: "codex",
        createdAt: "2026-02-27T00:05:00.000Z",
        threadId,
        turnId: asTurnId("turn-subagent-child"),
        payload: { state: "interrupted" },
        providerRefs: subagentRefs,
      });
      routing.codex.emit({
        type: "session.state.changed",
        eventId: asEventId("runtime-subagent-session-ready"),
        provider: "codex",
        createdAt: "2026-02-27T00:05:00.100Z",
        threadId,
        payload: { state: "ready", reason: "task:killed" },
        providerRefs: subagentRefs,
      });
      yield* sleep(50);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const runtimePayload = asRuntimePayloadRecord(binding?.runtimePayload);
      assert.equal(binding?.status, "running");
      assert.equal(runtimePayload.activeTurnId, turnId);
    }),
  );

  it.effect("persists steer turn lifecycle, cursor, and model metadata", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-steer-persistence");
      const turnId = asTurnId("turn-steer-persistence");
      const resumeCursor = { cursor: "steer-resume" };
      const modelSelection = {
        provider: "opencode" as const,
        model: "opencode/minimax-m2.5-free",
      };

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.steerTurn.mockImplementationOnce((input) =>
        Effect.succeed({ threadId: input.threadId, turnId, resumeCursor }),
      );

      yield* provider.steerTurn({
        threadId,
        input: "steer toward this",
        attachments: [],
        modelSelection,
      });

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const runtimePayload = asRuntimePayloadRecord(binding?.runtimePayload);
      assert.equal(binding?.status, "running");
      assert.deepEqual(binding?.resumeCursor, resumeCursor);
      assert.equal(runtimePayload.activeTurnId, turnId);
      assert.equal(runtimePayload.lastRuntimeEvent, "provider.steerTurn");
      assert.deepEqual(runtimePayload.modelSelection, modelSelection);
    }),
  );

  it.effect("keeps a newer review binding when an older steer returns late", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-review-newer-generation");
      const staleSteerTurnId = asTurnId("turn-stale-steer");
      const reviewTurnId = asTurnId("turn-newer-review");
      const staleSteerCursor = { cursor: "stale-steer-resume" };
      const reviewCursor = { cursor: "newer-review-resume" };
      const initialModelSelection = { provider: "codex" as const, model: "gpt-5-codex" };
      const staleSteerModelSelection = {
        provider: "opencode" as const,
        model: "opencode/minimax-m2.5-free",
      };
      let steerStarted = false;
      let releaseSteer: ((result: ProviderTurnStartResult) => void) | undefined;

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
        modelSelection: initialModelSelection,
      });
      routing.codex.steerTurn.mockImplementationOnce(() =>
        Effect.promise(
          () =>
            new Promise<ProviderTurnStartResult>((resolve) => {
              steerStarted = true;
              releaseSteer = resolve;
            }),
        ),
      );
      routing.codex.startReview.mockImplementationOnce((input) =>
        Effect.succeed({
          threadId: input.threadId,
          turnId: reviewTurnId,
          resumeCursor: reviewCursor,
        }),
      );

      const steerFiber = yield* provider
        .steerTurn({
          threadId,
          input: "older steer",
          attachments: [],
          modelSelection: staleSteerModelSelection,
        })
        .pipe(Effect.forkChild);
      yield* waitUntil(() => steerStarted, 500, 20, "delayed steer dispatch");

      yield* provider.startReview({
        threadId,
        target: { type: "uncommittedChanges" },
      });

      const release = releaseSteer;
      if (!release) {
        assert.fail("Expected delayed steer release callback");
      }
      release({ threadId, turnId: staleSteerTurnId, resumeCursor: staleSteerCursor });
      yield* Fiber.join(steerFiber);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const runtimePayload = asRuntimePayloadRecord(binding?.runtimePayload);
      assert.equal(binding?.status, "running");
      assert.deepEqual(binding?.resumeCursor, reviewCursor);
      assert.equal(runtimePayload.activeTurnId, reviewTurnId);
      assert.equal(runtimePayload.lastRuntimeEvent, "provider.startReview");
      assert.deepEqual(runtimePayload.modelSelection, initialModelSelection);
    }),
  );

  it.effect("refreshes persisted resume cursor immediately on model reroutes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-resume-refresh"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-runtime-resume-refresh"),
        runtimeMode: "full-access",
      });
      const updatedResumeCursor = {
        threadId: session.threadId,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-message-refresh",
        turnCount: 2,
        rerouteOriginalApiModelId: "claude-fable-5",
        rerouteFallbackApiModelId: "claude-opus-4-8",
      };

      routing.claude.updateSession(session.threadId, (existing) => ({
        ...existing,
        resumeCursor: updatedResumeCursor,
      }));
      routing.claude.emit({
        type: "model.rerouted",
        eventId: asEventId("runtime-model-rerouted-refresh"),
        provider: "claudeAgent",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId: session.threadId,
        payload: {
          fromModel: "claude-fable-5",
          toModel: "claude-opus-4-8",
          reason: "Model safeguards rerouted this request.",
        },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.deepEqual(runtime.value.resumeCursor, updatedResumeCursor);
      }
    }),
  );

  it.effect("persists task-list resume state before the active turn completes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-task-resume-refresh"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-task-resume-refresh"),
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "continue the work",
        attachments: [],
      });
      const updatedResumeCursor = {
        threadId: session.threadId,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        turnCount: 1,
        trackedTasks: [
          {
            id: "task-1",
            subject: "Patch UI",
            status: "in_progress",
            blockedBy: [],
          },
        ],
      };

      routing.claude.updateSession(session.threadId, (existing) => ({
        ...existing,
        resumeCursor: updatedResumeCursor,
      }));
      routing.claude.emit({
        type: "turn.tasks.updated",
        eventId: asEventId("runtime-task-resume-refresh"),
        provider: "claudeAgent",
        createdAt: "2026-02-27T00:04:30.000Z",
        threadId: session.threadId,
        turnId: turn.turnId,
        payload: {
          tasks: [{ task: "Patching UI", status: "inProgress" }],
        },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId: session.threadId }).pipe(
            Effect.map(
              Option.exists((runtime) => {
                const cursor = runtime.resumeCursor;
                return cursor !== null && typeof cursor === "object" && "trackedTasks" in cursor;
              }),
            ),
          ),
        500,
        20,
        "task resume cursor persistence",
      );

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.deepEqual(runtime.value.resumeCursor, updatedResumeCursor);
        assert.equal(runtime.value.status, "running");
      }
    }),
  );

  it.effect("marks persisted runtime bindings errored on runtime errors", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-error"), {
        provider: "codex",
        threadId: asThreadId("thread-runtime-error"),
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      routing.codex.emit({
        type: "runtime.error",
        eventId: asEventId("runtime-error-event"),
        provider: "codex",
        createdAt: "2026-02-27T00:05:00.000Z",
        threadId: session.threadId,
        turnId: turn.turnId,
        payload: { message: "Provider crashed", class: "provider_error" },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "error");
        const payload = runtime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.activeTurnId, null);
          assert.equal(runtimePayload.lastError, "Provider crashed");
          assert.equal(runtimePayload.lastRuntimeEvent, "runtime.error");
        }
      }
    }),
  );

  it.effect("marks terminal thread state changes stopped or errored", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-state-error"), {
        provider: "codex",
        threadId: asThreadId("thread-runtime-state-error"),
        runtimeMode: "full-access",
      });

      routing.codex.emit({
        type: "thread.state.changed",
        eventId: asEventId("runtime-thread-state-error"),
        provider: "codex",
        createdAt: "2026-02-27T00:05:00.000Z",
        threadId: session.threadId,
        payload: { state: "error" },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "error");
        const payload = runtime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          assert.equal((payload as Record<string, unknown>).activeTurnId, null);
          assert.equal(
            (payload as Record<string, unknown>).lastRuntimeEvent,
            "thread.state.changed",
          );
        }
      }
    }),
  );

  it.effect("preserves active turns across compacted thread state boundaries", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-compact-boundary"), {
        provider: "codex",
        threadId: asThreadId("thread-runtime-compact-boundary"),
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      routing.codex.emit({
        type: "thread.state.changed",
        eventId: asEventId("runtime-thread-compact-boundary"),
        provider: "codex",
        createdAt: "2026-02-27T00:05:00.000Z",
        threadId: session.threadId,
        payload: { state: "compacted" },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "running");
        const payload = runtime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          assert.equal((payload as Record<string, unknown>).activeTurnId, turn.turnId);
          assert.equal(
            (payload as Record<string, unknown>).lastRuntimeEvent,
            "thread.state.changed",
          );
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-start-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter("claudeAgent");
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(firstClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: "claudeAgent",
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter("claudeAgent");
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(secondClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: "claudeAgent",
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("clears stale resume cursor while preserving provider options for fresh restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-clear-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const providerOptions = {
        codex: {
          homePath: "/tmp/custom-codex-home",
          binaryPath: "/usr/local/bin/codex",
        },
      };

      const firstCodex = makeFakeCodexAdapter("codex");
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(firstCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const session = yield* provider.startSession(asThreadId("thread-clear-resume"), {
          provider: "codex",
          threadId: asThreadId("thread-clear-resume"),
          cwd: "/tmp/project-clear-resume",
          providerOptions,
          runtimeMode: "full-access",
        });
        assert.equal(typeof provider.clearSessionResumeCursor, "function");
        if (provider.clearSessionResumeCursor) {
          yield* provider.clearSessionResumeCursor({ threadId: session.threadId });
        }
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const secondCodex = makeFakeCodexAdapter("codex");
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(secondCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: "codex",
          threadId: initial.threadId,
          cwd: "/tmp/project-clear-resume",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const restartedInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof restartedInput === "object" && restartedInput !== null, true);
      if (restartedInput && typeof restartedInput === "object") {
        const startPayload = restartedInput as {
          providerOptions?: unknown;
          resumeCursor?: unknown;
        };
        assert.deepEqual(startPayload.providerOptions, providerOptions);
        assert.equal(startPayload.resumeCursor, null);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops the live runtime while preserving resume cursor and provider options", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "synara-provider-service-stop-runtime-"),
      );
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const providerOptions = {
        claudeAgent: {
          binaryPath: "/usr/local/bin/claude",
          permissionMode: "acceptEdits",
        },
      };

      const firstClaude = makeFakeCodexAdapter("claudeAgent");
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(firstClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const session = yield* provider.startSession(asThreadId("thread-stop-runtime"), {
          provider: "claudeAgent",
          threadId: asThreadId("thread-stop-runtime"),
          cwd: "/tmp/project-stop-runtime",
          providerOptions,
          runtimeMode: "full-access",
        });
        assert.equal(typeof provider.stopRuntimeSession, "function");
        if (provider.stopRuntimeSession) {
          yield* provider.stopRuntimeSession({ threadId: session.threadId });
        }
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      assert.equal(firstClaude.stopSession.mock.calls.length, 1);

      const secondClaude = makeFakeCodexAdapter("claudeAgent");
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(secondClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: "claudeAgent",
          threadId: initial.threadId,
          cwd: "/tmp/project-stop-runtime",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const restartedInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof restartedInput === "object" && restartedInput !== null, true);
      if (restartedInput && typeof restartedInput === "object") {
        const startPayload = restartedInput as {
          providerOptions?: unknown;
          resumeCursor?: unknown;
        };
        assert.deepEqual(startPayload.providerOptions, providerOptions);
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

rotationRetry.layer("ProviderServiceLive credential rotation event durability", (it) => {
  it.effect("retries task settlement durably before rotating the provider generation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-terminal-rotation-persistence-retry");
      const turnId = asTurnId(`turn-${threadId}`);
      const settlementEventId = asEventId(ROTATION_RETRY_FAILURE_EVENT_ID);
      rotationRetryPersistAttempts.clear();

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const lifecycleGeneration = binding?.lifecycleGeneration;
      assert.equal(typeof lifecycleGeneration, "string");
      yield* rotationRetry.codex.waitForRuntimeSubscribers();
      yield* provider.sendTurn({ threadId, input: "turn A", attachments: [] });

      rotationRetry.codex.emit({
        type: "task.started",
        eventId: asEventId("terminal-rotation-retry-task-started"),
        provider: "codex",
        createdAt: "2026-07-24T10:00:00.000Z",
        threadId,
        lifecycleGeneration,
        payload: { taskId: "background-retry" },
      });
      if (provider.hasLiveRuntimeTasks) {
        yield* waitUntilEffect(
          () => provider.hasLiveRuntimeTasks!({ threadId }),
          500,
          20,
          "background task registration before persistence retry",
        );
      }

      rotationRetry.codex.emit({
        type: "turn.completed",
        eventId: asEventId("terminal-rotation-retry-turn-completed"),
        provider: "codex",
        createdAt: "2026-07-24T10:00:01.000Z",
        threadId,
        turnId,
        lifecycleGeneration,
        payload: { state: "completed" },
        raw: {
          source: "codex.app-server.notification",
          method: "turn/completed",
          payload: { [AGENT_GATEWAY_TURN_AUTHORITY_RETIRED]: true },
        },
      });
      yield* waitUntilEffect(
        () =>
          directory.getBinding(threadId).pipe(
            Effect.map(
              Option.match({
                onNone: () => false,
                onSome: (current) =>
                  asRuntimePayloadRecord(current.runtimePayload)
                    .agentGatewayCredentialRotationRequired === true,
              }),
            ),
          ),
        500,
        20,
        "credential rotation flag before persistence retry",
      );

      const receivedEventIds: string[] = [];
      const settlementConsumer = yield* provider.streamEvents.pipe(
        Stream.filter((event) => event.eventId === settlementEventId),
        Stream.take(1),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedEventIds.push(String(event.eventId));
          }),
        ),
        Effect.forkChild,
      );
      yield* sleep(20);

      const startsBeforeB = rotationRetry.codex.startSession.mock.calls.length;
      const stopsBeforeB = rotationRetry.codex.stopSession.mock.calls.length;
      const turnB = yield* provider
        .sendTurn({ threadId, input: "turn B", attachments: [] })
        .pipe(Effect.forkChild);
      rotationRetry.codex.emit({
        type: "task.updated",
        eventId: settlementEventId,
        provider: "codex",
        createdAt: "2026-07-24T10:00:02.000Z",
        threadId,
        lifecycleGeneration,
        payload: { taskId: "background-retry", status: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          provider.getRuntimeEventPumpHealth
            ? provider
                .getRuntimeEventPumpHealth()
                .pipe(
                  Effect.map(
                    (health) =>
                      health.find((entry) => entry.provider === "codex")?.status === "recovering",
                  ),
                )
            : Effect.succeed(false),
        1_000,
        20,
        "runtime event pump persistence retry scheduling",
      );
      yield* TestClock.adjust("2 millis");
      yield* waitUntil(
        () => rotationRetryPersistAttempts.get(String(settlementEventId)) === 2,
        1_000,
        20,
        "task settlement persistence retry",
      );
      yield* waitUntil(
        () => receivedEventIds.length === 1,
        1_000,
        20,
        "task settlement fanout after persistence retry",
      );
      yield* waitUntil(
        () =>
          rotationRetry.codex.stopSession.mock.calls.length === stopsBeforeB + 1 &&
          rotationRetry.codex.startSession.mock.calls.length === startsBeforeB + 1,
        1_000,
        20,
        "credential rotation after durable task settlement",
      );
      yield* Fiber.join(settlementConsumer);
      yield* Fiber.join(turnB);

      assert.equal(rotationRetryPersistAttempts.get(String(settlementEventId)), 2);
      assert.deepEqual(receivedEventIds, [String(settlementEventId)]);
      assert.equal(rotationRetry.codex.stopSession.mock.calls.length, stopsBeforeB + 1);
      assert.equal(rotationRetry.codex.startSession.mock.calls.length, startsBeforeB + 1);

      yield* provider.stopSession({ threadId });
    }),
  );
});

restartRollbackRouting.layer("ProviderServiceLive restart-based rollback", (it) => {
  it.effect("requires the source lifecycle generation for modern ACP interactions", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-droid-interaction-generation");

      yield* provider.startSession(threadId, {
        provider: "droid",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const lifecycleGeneration = binding?.lifecycleGeneration;
      assert.equal(typeof lifecycleGeneration, "string");

      const responseCallCount = restartRollbackRouting.droid.respondToRequest.mock.calls.length;
      const missingGeneration = yield* Effect.result(
        provider.respondToRequest({
          threadId,
          requestId: asRequestId("droid-approval-without-generation"),
          decision: "accept",
        }),
      );
      assertFailure(
        missingGeneration,
        new ProviderValidationError({
          operation: "ProviderService.respondToRequest",
          issue:
            "Cannot respond to request 'droid-approval-without-generation' without its provider lifecycle generation.",
        }),
      );
      assert.equal(
        restartRollbackRouting.droid.respondToRequest.mock.calls.length,
        responseCallCount,
      );

      yield* provider.respondToRequest({
        threadId,
        requestId: asRequestId("droid-approval-current-generation"),
        lifecycleGeneration,
        decision: "accept",
      });
      assert.equal(
        restartRollbackRouting.droid.respondToRequest.mock.calls.length,
        responseCallCount + 1,
      );

      yield* provider.stopSession({ threadId });
      restartRollbackRouting.droid.startSession.mockClear();
      restartRollbackRouting.droid.respondToRequest.mockClear();
      restartRollbackRouting.droid.stopSession.mockClear();
    }),
  );

  it.effect("clears Droid's native cursor instead of reporting a fake rewind", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-droid-restart-rollback");
      const session = yield* provider.startSession(threadId, {
        provider: "droid",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.rollbackConversation({ threadId, numTurns: 1 });

      assert.equal(restartRollbackRouting.droid.rollbackThread.mock.calls.length, 0);
      assert.deepEqual(restartRollbackRouting.droid.stopSession.mock.calls, [[session.threadId]]);
      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isSome(binding), true);
      if (Option.isSome(binding)) {
        assert.equal(binding.value.status, "stopped");
        assert.equal(binding.value.resumeCursor, null);
      }
    }),
  );
});

piInteractionRouting.layer("ProviderServiceLive Pi interaction generation", (it) => {
  it.effect("requires the source lifecycle generation for modern Pi user input", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-pi-interaction-generation");

      yield* provider.startSession(threadId, {
        provider: "pi",
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const lifecycleGeneration = binding?.lifecycleGeneration;
      assert.equal(typeof lifecycleGeneration, "string");

      const responseCallCount = piInteractionRouting.pi.respondToUserInput.mock.calls.length;
      const missingGeneration = yield* Effect.result(
        provider.respondToUserInput({
          threadId,
          requestId: asRequestId("pi-user-input-without-generation"),
          answers: { answer: "continue" },
        }),
      );
      assertFailure(
        missingGeneration,
        new ProviderValidationError({
          operation: "ProviderService.respondToUserInput",
          issue:
            "Cannot respond to request 'pi-user-input-without-generation' without its provider lifecycle generation.",
        }),
      );
      assert.equal(piInteractionRouting.pi.respondToUserInput.mock.calls.length, responseCallCount);

      yield* provider.respondToUserInput({
        threadId,
        requestId: asRequestId("pi-user-input-current-generation"),
        lifecycleGeneration,
        answers: { answer: "continue" },
      });
      assert.equal(
        piInteractionRouting.pi.respondToUserInput.mock.calls.length,
        responseCallCount + 1,
      );

      yield* provider.stopSession({ threadId });
      piInteractionRouting.pi.startSession.mockClear();
      piInteractionRouting.pi.respondToUserInput.mockClear();
      piInteractionRouting.pi.stopSession.mockClear();
    }),
  );
});

const idleCleanup = makeProviderServiceLayer({ runtimeIdleStopMs: 100 });
idleCleanup.layer("ProviderServiceLive idle cleanup", (it) => {
  it.effect("does not schedule idle cleanup for a stale terminal event", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-idle-stale-terminal");
      const olderTurnId = asTurnId("turn-idle-stale-older");
      const newerTurnId = asTurnId("turn-idle-stale-newer");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.sendTurn
        .mockImplementationOnce((input) =>
          Effect.succeed({ threadId: input.threadId, turnId: olderTurnId }),
        )
        .mockImplementationOnce((input) =>
          Effect.succeed({ threadId: input.threadId, turnId: newerTurnId }),
        );
      yield* provider.sendTurn({ threadId, input: "older", attachments: [] });
      yield* provider.sendTurn({ threadId, input: "newer", attachments: [] });

      idleCleanup.codex.stopSession.mockClear();
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.aborted",
        eventId: asEventId("runtime-idle-stale-older-aborted"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        turnId: olderTurnId,
        payload: { state: "interrupted" },
      });
      yield* sleep(150);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const runtimePayload = asRuntimePayloadRecord(binding?.runtimePayload);
      assert.equal(binding?.status, "running");
      assert.equal(runtimePayload.activeTurnId, newerTurnId);
      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 0);

      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-newer-completed"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:01.000Z",
        threadId,
        turnId: newerTurnId,
        payload: { state: "completed" },
      });
      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "matching terminal idle cleanup",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
      yield* waitUntilEffect(
        () =>
          directory.getBinding(threadId).pipe(
            Effect.map((current) => {
              const currentBinding = Option.getOrUndefined(current);
              const payload = asRuntimePayloadRecord(currentBinding?.runtimePayload);
              return payload.lastRuntimeEvent === "provider.stopRuntimeSession";
            }),
          ),
        500,
        20,
        "matching terminal idle cleanup persistence",
      );
      idleCleanup.codex.stopSession.mockClear();
    }),
  );

  it.effect("ignores an unscoped terminal event while overlapping turns are outstanding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-idle-ambiguous-terminal");
      const firstTurnId = asTurnId("turn-ambiguous-first");
      const secondTurnId = asTurnId("turn-ambiguous-second");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.sendTurn
        .mockImplementationOnce((input) =>
          Effect.succeed({ threadId: input.threadId, turnId: firstTurnId }),
        )
        .mockImplementationOnce((input) =>
          Effect.succeed({ threadId: input.threadId, turnId: secondTurnId }),
        );
      yield* provider.sendTurn({ threadId, input: "first", attachments: [] });
      yield* provider.sendTurn({ threadId, input: "second", attachments: [] });

      idleCleanup.codex.stopSession.mockClear();
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.aborted",
        eventId: asEventId("runtime-ambiguous-terminal"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "interrupted" },
      });
      yield* sleep(150);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const payload = binding?.runtimePayload as Record<string, unknown>;
      assert.equal(binding?.status, "running");
      assert.equal(payload.activeTurnId, secondTurnId);
      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 0);
    }),
  );

  it.effect(
    "stops idle ready runtime using the persisted cursor when the live snapshot omits it",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const runtimeRepository = yield* ProviderSessionRuntimeRepository;

        const session = yield* provider.startSession(asThreadId("thread-idle-persisted-cursor"), {
          provider: "codex",
          threadId: asThreadId("thread-idle-persisted-cursor"),
          runtimeMode: "full-access",
        });

        const persistedBefore = yield* runtimeRepository.getByThreadId({
          threadId: session.threadId,
        });
        assert.equal(Option.isSome(persistedBefore), true);
        if (Option.isSome(persistedBefore)) {
          assert.deepEqual(persistedBefore.value.resumeCursor, session.resumeCursor);
        }

        idleCleanup.codex.updateSession(session.threadId, withoutResumeCursor);
        yield* idleCleanup.codex.waitForRuntimeSubscribers();
        idleCleanup.codex.emit({
          type: "turn.completed",
          eventId: asEventId("runtime-idle-persisted-cursor-complete"),
          provider: "codex",
          createdAt: "2026-02-27T00:04:00.000Z",
          threadId: session.threadId,
          payload: { state: "completed" },
        });

        yield* waitUntil(
          () => idleCleanup.codex.stopSession.mock.calls.length > 0,
          500,
          20,
          "idle runtime stop",
        );

        assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 1);
        assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], session.threadId);

        const persistedAfter = yield* runtimeRepository.getByThreadId({
          threadId: session.threadId,
        });
        assert.equal(Option.isSome(persistedAfter), true);
        if (Option.isSome(persistedAfter)) {
          assert.equal(persistedAfter.value.status, "stopped");
          assert.deepEqual(persistedAfter.value.resumeCursor, session.resumeCursor);
        }
      }),
  );

  it.effect("clears a pending idle stop before dispatching new turn work", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-new-turn");

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, withoutResumeCursor);
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-new-turn"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "new turn before idle stop",
        attachments: [],
      });
      yield* sleep(150);

      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 0);
    }),
  );

  it.effect("clears a pending idle stop when a runtime turn starts", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-runtime-turn-start");

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, withoutResumeCursor);
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-runtime-turn-start"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.emit({
        type: "turn.started",
        eventId: asEventId("runtime-turn-start-clears-idle"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:01.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-runtime-clears-idle"),
        payload: { state: "running" },
      });
      yield* sleep(150);

      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 0);
    }),
  );

  it.effect("keeps the runtime alive until background tasks settle", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-idle-background-task");

      idleCleanup.claude.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        threadId,
        runtimeMode: "full-access",
      });
      yield* idleCleanup.claude.waitForRuntimeSubscribers();
      idleCleanup.claude.emit({
        type: "task.started",
        eventId: asEventId("runtime-background-task-started"),
        provider: "claudeAgent",
        createdAt: "2026-07-16T20:00:00.000Z",
        threadId,
        payload: { taskId: "background-task-1" },
      });
      idleCleanup.claude.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-background-parent-completed"),
        provider: "claudeAgent",
        createdAt: "2026-07-16T20:00:01.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* sleep(150);
      assert.equal(idleCleanup.claude.stopSession.mock.calls.length, 0);

      idleCleanup.claude.emit({
        type: "task.updated",
        eventId: asEventId("runtime-background-task-completed"),
        provider: "claudeAgent",
        createdAt: "2026-07-16T20:00:02.000Z",
        threadId,
        payload: { taskId: "background-task-1", status: "completed" },
      });

      yield* waitUntil(
        () => idleCleanup.claude.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after background task settlement",
      );
      assert.deepEqual(idleCleanup.claude.stopSession.mock.calls[0]?.[0], session.threadId);
    }),
  );

  it.effect("keeps routing runtime events after a superseded idle stop no-ops", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-superseded-generation");

      idleCleanup.codex.stopSession.mockClear();
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(typeof binding?.lifecycleGeneration, "string");
      const lifecycleGeneration = String(binding?.lifecycleGeneration);

      // Park the idle stop inside its lifecycle run, right where it re-checks
      // whether new work displaced it.
      const defaultHasSession = idleCleanup.codex.hasSession.getMockImplementation();
      if (!defaultHasSession) assert.fail("Expected the fake adapter hasSession implementation");
      let releaseIdleStop: () => void = () => undefined;
      const parkedIdleStop = new Promise<void>((resolve) => {
        releaseIdleStop = resolve;
      });
      let idleStopParked = false;
      idleCleanup.codex.hasSession.mockImplementationOnce((probedThreadId) =>
        Effect.suspend(() => {
          idleStopParked = true;
          return Effect.promise(() => parkedIdleStop).pipe(
            Effect.andThen(defaultHasSession(probedThreadId)),
          );
        }),
      );

      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-superseded-complete"),
        provider: "codex",
        createdAt: "2026-07-21T09:00:00.000Z",
        threadId,
        lifecycleGeneration,
        payload: { state: "completed" },
      });

      yield* waitUntil(() => idleStopParked, 2000, 10, "idle stop reaching the session probe");

      // New runtime work displaces the idle stop while it is parked, so the
      // stop must abandon itself without touching the still-live session.
      idleCleanup.codex.emit({
        type: "task.started",
        eventId: asEventId("runtime-idle-superseded-task"),
        provider: "codex",
        createdAt: "2026-07-21T09:00:01.000Z",
        threadId,
        payload: { taskId: "task-superseding-idle-stop" },
      });
      assert.equal(typeof provider.hasLiveRuntimeTasks, "function");
      yield* waitUntilEffect(
        () => provider.hasLiveRuntimeTasks!({ threadId }),
        500,
        10,
        "live runtime task registration",
      );

      releaseIdleStop();
      yield* sleep(50);
      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 0);
      assert.equal(yield* idleCleanup.codex.hasSession(threadId), true);

      // The abandoned stop must leave the live runtime's generation intact:
      // otherwise every later event from that runtime is silently dropped.
      const turnId = asTurnId("turn-after-superseded-idle-stop");
      idleCleanup.codex.emit({
        type: "turn.started",
        eventId: asEventId("runtime-idle-superseded-turn-started"),
        provider: "codex",
        createdAt: "2026-07-21T09:00:02.000Z",
        threadId,
        turnId,
        lifecycleGeneration,
        payload: { state: "running" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              return (
                asRuntimePayloadRecord(runtime.value.runtimePayload).activeTurnId === String(turnId)
              );
            }),
          ),
        500,
        20,
        "runtime turn routed after the superseded idle stop",
      );
    }),
  );

  it.effect("clears a stale cursor without stopping a runtime that owns live tasks", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-clear-resume-live-task");

      idleCleanup.claude.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        threadId,
        runtimeMode: "full-access",
      });
      yield* idleCleanup.claude.waitForRuntimeSubscribers();
      idleCleanup.claude.emit({
        type: "task.started",
        eventId: asEventId("runtime-clear-resume-live-task-started"),
        provider: "claudeAgent",
        createdAt: "2026-07-17T12:00:00.000Z",
        threadId,
        payload: { taskId: "background-task-clear-resume" },
      });

      assert.equal(typeof provider.hasLiveRuntimeTasks, "function");
      if (provider.hasLiveRuntimeTasks) {
        yield* waitUntilEffect(
          () => provider.hasLiveRuntimeTasks!({ threadId }),
          500,
          20,
          "live runtime task registration",
        );
      }
      assert.equal(typeof provider.clearSessionResumeCursor, "function");
      if (provider.clearSessionResumeCursor) {
        yield* provider.clearSessionResumeCursor({
          threadId,
          preserveActiveRuntime: true,
        });
      }

      assert.equal(idleCleanup.claude.stopSession.mock.calls.length, 0);
      assert.equal(yield* idleCleanup.claude.hasSession(threadId), true);
      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.resumeCursor, null);
      }
      assert.equal(
        (yield* provider.listSessions()).some((entry) => entry.threadId === session.threadId),
        true,
      );
    }),
  );

  it.effect("keeps lifecycle ownership on the first of two conflicting turn starts", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-conflicting-runtime-starts");
      const firstTurnId = asTurnId("turn-conflicting-start-first");
      const secondTurnId = asTurnId("turn-conflicting-start-second");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.started",
        eventId: asEventId("runtime-conflicting-start-first"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:01.000Z",
        threadId,
        turnId: firstTurnId,
        payload: { state: "running" },
      });
      yield* waitUntilEffect(
        () =>
          directory.getBinding(threadId).pipe(
            Effect.map((current) => {
              const binding = Option.getOrUndefined(current);
              const payload = binding?.runtimePayload as Record<string, unknown> | undefined;
              return payload?.activeTurnId === firstTurnId;
            }),
          ),
        500,
        20,
        "first runtime turn start persistence",
      );

      idleCleanup.codex.emit({
        type: "turn.started",
        eventId: asEventId("runtime-conflicting-start-second"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:02.000Z",
        threadId,
        turnId: secondTurnId,
        payload: { state: "running" },
      });
      yield* sleep(50);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const payload = binding?.runtimePayload as Record<string, unknown>;
      assert.equal(binding?.status, "running");
      assert.equal(payload.activeTurnId, firstTurnId);
      assert.equal(payload.lastRuntimeEvent, "turn.started");
    }),
  );

  it.effect("serializes a fired idle stop before starting new turn work", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-fired-new-turn");
      let listSessionsStarted = false;
      let releaseListSessions: ReleaseListSessions | undefined;

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const { resumeCursor: _omittedResumeCursor, ...staleReadySession } = session;

      idleCleanup.codex.listSessions
        .mockImplementationOnce(() => Effect.succeed([session]))
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<ReadonlyArray<ProviderSession>>((resolve) => {
                listSessionsStarted = true;
                releaseListSessions = resolve;
              }),
          ),
        );

      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-fired-before-new-turn"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );
      yield* waitUntil(() => listSessionsStarted, 500, 20, "idle listSessions start");

      const sendTurnFiber = yield* provider
        .sendTurn({
          threadId,
          input: "new turn after idle timeout fired",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const release = releaseListSessions;
      requireReleaseListSessions(release)([staleReadySession]);
      yield* Fiber.join(sendTurnFiber);
      yield* sleep(100);

      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 1);
      const persistedAfter = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(persistedAfter), true);
      if (Option.isSome(persistedAfter)) {
        assert.equal(persistedAfter.value.status, "running");
        const payload = persistedAfter.value.runtimePayload;
        assert.equal(
          payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            (payload as Record<string, unknown>).activeTurnId === `turn-${String(threadId)}`,
          true,
        );
      }
    }),
  );

  it.effect("restores idle cleanup when new turn dispatch is interrupted", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-interrupted-dispatch");

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, withoutResumeCursor);
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-interrupted-dispatch"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.sendTurn.mockImplementationOnce(() => Effect.interrupt);
      yield* Effect.exit(
        provider.sendTurn({
          threadId: session.threadId,
          input: "new turn interrupted before runtime events",
          attachments: [],
        }),
      );

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after interrupted dispatch",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("reschedules idle cleanup after successful rollback work", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-rollback-success");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, withoutResumeCursor);
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-rollback"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.stopSession.mockClear();
      yield* provider.rollbackConversation({
        threadId,
        numTurns: 1,
      });

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after successful rollback",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("waits for fired idle cleanup before removing an explicit stop binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-stop-remove-race");
      let listSessionsStarted = false;
      let releaseListSessions: ReleaseListSessions | undefined;

      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const { resumeCursor: _omittedResumeCursor, ...staleReadySession } = session;
      idleCleanup.codex.listSessions
        .mockImplementationOnce(() => Effect.succeed([session]))
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<ReadonlyArray<ProviderSession>>((resolve) => {
                listSessionsStarted = true;
                releaseListSessions = resolve;
              }),
          ),
        );

      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-explicit-stop"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });
      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );
      yield* waitUntil(() => listSessionsStarted, 500, 20, "idle listSessions start");

      const stopFiber = yield* provider.stopSession({ threadId }).pipe(Effect.forkChild);
      const release = releaseListSessions;
      requireReleaseListSessions(release)([staleReadySession]);
      yield* Fiber.join(stopFiber);

      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isNone(binding), true);
    }),
  );

  it.effect("waits for fired idle cleanup before explicit runtime stop", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-runtime-stop-race");
      let listSessionsStarted = false;
      let releaseListSessions: ReleaseListSessions | undefined;

      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const { resumeCursor: _omittedResumeCursor, ...staleReadySession } = session;
      idleCleanup.codex.stopSession.mockClear();
      idleCleanup.codex.listSessions
        .mockImplementationOnce(() => Effect.succeed([session]))
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<ReadonlyArray<ProviderSession>>((resolve) => {
                listSessionsStarted = true;
                releaseListSessions = resolve;
              }),
          ),
        );

      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-runtime-stop"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });
      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );
      yield* waitUntil(() => listSessionsStarted, 500, 20, "idle listSessions start");

      assert.equal(typeof provider.stopRuntimeSession, "function");
      if (!provider.stopRuntimeSession) {
        assert.fail("stopRuntimeSession unavailable");
      }
      const stopFiber = yield* provider.stopRuntimeSession({ threadId }).pipe(Effect.forkChild);
      const release = releaseListSessions;
      requireReleaseListSessions(release)([staleReadySession]);
      yield* Fiber.join(stopFiber);

      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 1);
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("reschedules idle cleanup after successful compact work", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-compact-success");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, withoutResumeCursor);
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-compact-success"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.stopSession.mockClear();
      idleCleanup.codex.compactThread.mockImplementationOnce((inputThreadId) =>
        Effect.sync(() => {
          idleCleanup.codex.updateSession(inputThreadId, (existing) => ({
            ...existing,
            status: "running",
            activeTurnId: undefined,
          }));
        }),
      );
      yield* provider.compactThread({ threadId });

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after successful compact",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("schedules idle cleanup for closed thread state changes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-idle-closed-state");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.stopSession.mockClear();
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "thread.state.changed",
        eventId: asEventId("runtime-idle-closed-state"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "closed" },
      });

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after closed thread state",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("stops a compacted runtime that remains running without an active turn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-idle-compact-running");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.stopSession.mockClear();
      idleCleanup.codex.updateSession(threadId, (existing) => ({
        ...existing,
        status: "running",
        activeTurnId: undefined,
      }));
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "thread.state.changed",
        eventId: asEventId("runtime-idle-compact-completed"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "compacted" },
      });

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after compact",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("restores idle cleanup when new turn dispatch fails before runtime events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-failed-dispatch");
      const dispatchFailure = new ProviderAdapterSessionNotFoundError({
        provider: "codex",
        threadId,
      });

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, withoutResumeCursor);
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-failed-dispatch"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.sendTurn.mockImplementationOnce(() => Effect.fail(dispatchFailure));
      const failedTurn = yield* Effect.result(
        provider.sendTurn({
          threadId: session.threadId,
          input: "new turn that fails before runtime events",
          attachments: [],
        }),
      );
      assertFailure(failedTurn, dispatchFailure);

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after failed dispatch",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* sleep(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* sleep(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: "codex",
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* sleep(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* sleep(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("clears persisted active turn when provider session reports ready", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-ready");
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({ threadId, input: "hello" });
      yield* sleep(50);

      fanout.codex.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-ready"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId,
        payload: {
          state: "ready",
        },
      });
      yield* sleep(50);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const runtimePayload = asRuntimePayloadRecord(binding?.runtimePayload);
      assert.equal(runtimePayload.activeTurnId, null);
    }),
  );
});

let persistedFanoutSequence = 0;
const persistedFanout = makeProviderServiceLayer({
  persistRuntimeEvent: (event) =>
    Effect.sync(() => ({
      sequence: ++persistedFanoutSequence,
      event,
    })),
});
persistedFanout.layer("ProviderServiceLive durable fanout", (it) => {
  it.effect("reuses the durable journal result without changing the canonical event stream", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-persisted-fanout");
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      assert.notEqual(provider.streamPersistedEvents, undefined);

      const canonicalEvents = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const persistedEvents = yield* Ref.make<
        Array<{ readonly sequence: number; readonly event: ProviderRuntimeEvent }>
      >([]);
      const canonicalEventFiber = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(canonicalEvents, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      const persistedEventFiber = yield* Stream.runForEach(
        provider.streamPersistedEvents!,
        (event) => Ref.update(persistedEvents, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* sleep(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-persisted-fanout"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-persisted-fanout"),
        status: "completed",
      };
      persistedFanout.codex.emit(completedEvent);
      yield* sleep(100);

      const canonicalEvent = (yield* Ref.get(canonicalEvents))[0];
      const persistedEvent = (yield* Ref.get(persistedEvents))[0];
      yield* Fiber.interrupt(canonicalEventFiber);
      yield* Fiber.interrupt(persistedEventFiber);
      assert.notEqual(canonicalEvent, undefined);
      assert.notEqual(persistedEvent, undefined);
      if (canonicalEvent === undefined || persistedEvent === undefined) {
        assert.fail("Expected both canonical and persisted runtime events");
      }
      assert.equal(canonicalEvent.eventId, completedEvent.eventId);
      assert.equal(persistedEvent.event.eventId, completedEvent.eventId);
      assert.equal(persistedEvent.sequence > 0, true);
    }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("fails loudly when the adapter does not support stopping a task", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      yield* provider.startSession(asThreadId("thread-task-stop-unsupported"), {
        provider: "codex",
        threadId: asThreadId("thread-task-stop-unsupported"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const failure = yield* Effect.result(
        provider.stopTask({
          threadId: asThreadId("thread-task-stop-unsupported"),
          taskId: "task-1",
        }),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.stopTask");
      assert.equal(failure.failure.issue.includes("does not support stopping"), true);
    }),
  );

  it.effect("fails loudly when the adapter does not support backgrounding a task", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      yield* provider.startSession(asThreadId("thread-task-bg-unsupported"), {
        provider: "codex",
        threadId: asThreadId("thread-task-bg-unsupported"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const failure = yield* Effect.result(
        provider.backgroundTask({
          threadId: asThreadId("thread-task-bg-unsupported"),
          toolUseId: "tool-1",
        }),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.backgroundTask");
      assert.equal(failure.failure.issue.includes("does not support backgrounding"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "codex",
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: "codex",
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});

const disabledProviderStart = makeProviderServiceLayer({
  providerIsEnabled: (provider) => Effect.succeed(provider !== "codex"),
});
disabledProviderStart.layer("ProviderServiceLive enablement", (it) => {
  it.effect("rejects session starts for disabled providers before reaching the adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-disabled-provider"), {
          provider: "codex",
          threadId: asThreadId("thread-disabled-provider"),
          runtimeMode: "full-access",
        }),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") return;
      assert.equal(failure.failure._tag, "ProviderValidationError");
      assert.equal(failure.failure.message.includes("disabled"), true);
      assert.equal(disabledProviderStart.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects recovery-triggered provider starts while disabled", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-disabled-provider-recovery");
      disabledProviderStart.codex.startSession.mockClear();
      disabledProviderStart.codex.compactThread.mockClear();
      yield* directory.upsert({
        threadId,
        provider: "codex",
        status: "stopped",
        resumeCursor: { opaque: "resume-disabled-provider" },
        runtimeMode: "full-access",
      });

      const failure = yield* Effect.result(provider.compactThread({ threadId }));

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") return;
      assert.equal(failure.failure._tag, "ProviderValidationError");
      assert.equal(failure.failure.message.includes("disabled"), true);
      assert.equal(disabledProviderStart.codex.startSession.mock.calls.length, 0);
      assert.equal(disabledProviderStart.codex.compactThread.mock.calls.length, 0);
    }),
  );
});

let providerEnabledDuringStart = true;
const providerDisabledAfterInitialCheck = makeProviderServiceLayer({
  providerIsEnabled: () =>
    Effect.sync(() => {
      const enabled = providerEnabledDuringStart;
      providerEnabledDuringStart = false;
      return enabled;
    }),
});
providerDisabledAfterInitialCheck.layer("ProviderServiceLive enablement race", (it) => {
  it.effect("rechecks provider enablement immediately before adapter startup", () =>
    Effect.gen(function* () {
      providerEnabledDuringStart = true;
      providerDisabledAfterInitialCheck.codex.startSession.mockClear();
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-disabled-during-start");

      const failure = yield* Effect.result(
        provider.startSession(threadId, {
          provider: "codex",
          threadId,
          runtimeMode: "full-access",
        }),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") return;
      assert.equal(failure.failure._tag, "ProviderValidationError");
      assert.equal(failure.failure.message.includes("disabled"), true);
      assert.equal(providerDisabledAfterInitialCheck.codex.startSession.mock.calls.length, 0);
    }),
  );
});

const boundedFanout = makeProviderServiceLayer({ runtimeEventBufferCapacity: 1 });
it.effect("ProviderServiceLive starts independent provider teardown concurrently", () =>
  Effect.gen(function* () {
    const shutdown = makeProviderServiceLayer();
    const scope = yield* Scope.make("sequential");
    const releaseStops = yield* Deferred.make<void>();
    const startedProviders = new Set<ProviderKind>();

    for (const adapter of [shutdown.codex, shutdown.claude, shutdown.antigravity]) {
      adapter.stopAll.mockImplementation(() =>
        Effect.sync(() => {
          startedProviders.add(adapter.adapter.provider);
        }).pipe(Effect.andThen(Deferred.await(releaseStops))),
      );
    }

    yield* Layer.buildWithScope(shutdown.rawLayer, scope);
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);

    yield* waitUntil(
      () => startedProviders.size === 3,
      500,
      20,
      "all provider teardown operations to start",
    ).pipe(Effect.ensuring(Deferred.succeed(releaseStops, undefined)));
    yield* Fiber.join(closing);
  }),
);

it.effect("ProviderServiceLive starts adapter teardown when a queued session refresh fails", () =>
  Effect.gen(function* () {
    const shutdown = makeProviderServiceLayer();
    const scope = yield* Scope.make("sequential");
    const services = yield* Layer.buildWithScope(shutdown.rawLayer, scope);
    const provider = yield* Effect.service(ProviderService).pipe(Effect.provide(services));
    const threadId = asThreadId("thread-stopall-refresh-failure");
    const teardownStarted = yield* Deferred.make<void>();

    yield* provider.startSession(threadId, {
      provider: "codex",
      threadId,
      runtimeMode: "full-access",
    });

    const listSessions = shutdown.codex.listSessions.getMockImplementation();
    assert.ok(listSessions);
    let shutdownListCalls = 0;
    shutdown.codex.listSessions.mockImplementation(() => {
      shutdownListCalls += 1;
      return shutdownListCalls === 2
        ? Effect.die(new Error("injected queued listSessions failure"))
        : listSessions();
    });
    shutdown.codex.stopAll.mockImplementation(() =>
      Deferred.succeed(teardownStarted, undefined).pipe(Effect.asVoid),
    );

    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* Deferred.await(teardownStarted);
    yield* Fiber.join(closing);
  }),
);

it.effect("ProviderServiceLive backpressures slow subscribers and completes fanout shutdown", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const releaseSlowConsumer = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const services = yield* Layer.buildWithScope(boundedFanout.rawLayer, scope);
      const provider = yield* Effect.service(ProviderService).pipe(Effect.provide(services));
      const threadId = asThreadId("thread-bounded-fanout");
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      yield* boundedFanout.codex.waitForRuntimeSubscribers();

      const slowConsumerStarted = yield* Deferred.make<void>();
      const slowConsumer = yield* Stream.runForEach(provider.streamEvents, () =>
        Deferred.succeed(slowConsumerStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSlowConsumer)),
        ),
      ).pipe(Effect.forkChild);

      const receivedByHealthy = yield* Ref.make<Array<string>>([]);
      const healthyConsumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Ref.update(receivedByHealthy, (current) => [...current, event.eventId]),
        ),
        Effect.forkChild,
      );
      yield* sleep(20);

      for (const index of [1, 2, 3]) {
        boundedFanout.codex.emit({
          type: "message.delta",
          eventId: asEventId(`evt-bounded-${index}`),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId,
          turnId: asTurnId("turn-bounded"),
          delta: String(index),
        });
      }

      yield* Deferred.await(slowConsumerStarted);
      yield* sleep(30);
      const receivedBeforeRelease = yield* Ref.get(receivedByHealthy);
      yield* Deferred.succeed(releaseSlowConsumer, undefined);
      assert.equal(receivedBeforeRelease.length < 3, true);
      yield* Fiber.join(healthyConsumer);
      assert.deepEqual(yield* Ref.get(receivedByHealthy), [
        asEventId("evt-bounded-1"),
        asEventId("evt-bounded-2"),
        asEventId("evt-bounded-3"),
      ]);

      yield* provider.closeRuntimeEvents;
      yield* provider.closeRuntimeEvents;
      yield* Fiber.interrupt(slowConsumer);
    }).pipe(
      Effect.ensuring(Deferred.succeed(releaseSlowConsumer, undefined).pipe(Effect.asVoid)),
      Effect.ensuring(Scope.close(scope, Exit.void)),
    );
  }),
);

const liveFallback = makeProviderServiceLayer();
liveFallback.layer("ProviderServiceLive live-fallback settled turns", (it) => {
  it.effect("persists the first binding row as stopped when the turn settles pre-write", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-live-fallback-settled");
      const turnId = asTurnId("turn-live-fallback-settled");

      // The adapter owns a live session but startSession has not persisted a
      // binding row yet (the startup window resolveRoutableSession allows).
      liveFallback.codex.hasSession.mockImplementation((candidate: ThreadId) =>
        Effect.succeed(candidate === threadId),
      );
      liveFallback.codex.sendTurn.mockImplementationOnce((input: ProviderSendTurnInput) =>
        Effect.gen(function* () {
          // The terminal runtime event is fully processed before sendTurn
          // returns, so the post-dispatch write takes the settled-turn branch.
          liveFallback.codex.emit({
            type: "turn.completed",
            eventId: asEventId("evt-live-fallback-settled"),
            provider: "codex",
            createdAt: new Date().toISOString(),
            threadId: input.threadId,
            turnId,
            payload: { state: "cancelled" },
          });
          yield* sleep(100);
          return { threadId: input.threadId, turnId };
        }),
      );
      yield* liveFallback.codex.waitForRuntimeSubscribers();

      yield* provider.sendTurn({ threadId, input: "hello" });

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(binding?.status, "stopped");
    }),
  );

  it.effect("retains settlement markers for more than eight overlapping dispatches", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-live-fallback-many-settled");
      let sequence = 0;

      liveFallback.codex.hasSession.mockImplementation((candidate: ThreadId) =>
        Effect.succeed(candidate === threadId),
      );
      liveFallback.codex.sendTurn.mockImplementation((input: ProviderSendTurnInput) =>
        Effect.gen(function* () {
          sequence += 1;
          const turnId = asTurnId(`turn-many-settled-${sequence}`);
          liveFallback.codex.emit({
            type: "turn.completed",
            eventId: asEventId(`evt-many-settled-${sequence}`),
            provider: "codex",
            createdAt: new Date().toISOString(),
            threadId: input.threadId,
            turnId,
            payload: { state: "cancelled" },
          });
          yield* sleep(50);
          return { threadId: input.threadId, turnId };
        }),
      );
      yield* liveFallback.codex.waitForRuntimeSubscribers();

      yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          provider.sendTurn({ threadId, input: `turn ${index}` }),
        ),
        { concurrency: "unbounded" },
      );

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(binding?.status, "stopped");
      const payload = binding?.runtimePayload as Record<string, unknown> | undefined;
      assert.notEqual(payload?.activeTurnId, asTurnId("turn-many-settled-1"));
    }),
  );
});
