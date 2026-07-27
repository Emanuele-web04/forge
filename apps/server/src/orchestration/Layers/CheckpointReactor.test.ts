import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type {
  OrchestrationEvent,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@synara/contracts";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnLive,
  checkpointRefForThreadTurnStart,
} from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
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

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = "codex",
  providerStatus: ProviderSession["status"] = "ready",
  activeTurnId?: TurnId,
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: providerStatus,
            runtimeMode: "full-access",
            threadId: ThreadId.makeUnsafe("thread-1"),
            cwd: sessionCwd,
            ...(activeTurnId !== undefined ? { activeTurnId } : {}),
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    forkThread: () => Effect.succeed(null),
    interruptTurn: () => unsupported(),
    stopTask: () => unsupported(),
    backgroundTask: () => unsupported(),
    steerSubagent: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation,
    compactThread: () => unsupported(),
    closeRuntimeEvents: Effect.void,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{
      checkpointTurnCount: number;
      status: "ready" | "missing" | "error";
      assistantMessageId?: MessageId | null;
      files?: ReadonlyArray<{ path: string }>;
    }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{
      checkpointTurnCount: number;
      status: "ready" | "missing" | "error";
      assistantMessageId?: MessageId | null;
      files?: ReadonlyArray<{ path: string }>;
    }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: OrchestrationEvent) => boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository(hasInitialCommit = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synara-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  if (hasInitialCommit) {
    fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["commit", "-m", "Initial"]);
  }
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | CheckpointReactor | CheckpointStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderKind;
    readonly providerStatus?: ProviderSession["status"];
    readonly providerActiveTurnId?: TurnId;
    readonly hasInitialCommit?: boolean;
  }) {
    const cwd = createGitRepository(options?.hasInitialCommit ?? true);
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? "codex",
      options?.providerStatus ?? "ready",
      options?.providerActiveTurnId,
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-checkpoint-reactor-test-",
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(TurnCheckpointCoordinatorLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(GitCoreLive))),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
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
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      }),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      provider,
      checkpointStore,
      cwd,
      drain,
    };
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-capture"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurnStart(ThreadId.makeUnsafe("thread-1"), asTurnId("turn-1")),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.latestTurn?.turnId === "turn-1" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.files?.map((file) => file.path).includes("README.md") === true,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("summarizes only files changed after each turn's start checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const firstMessageId = MessageId.makeUnsafe("message-turn-a");
    const secondMessageId = MessageId.makeUnsafe("message-turn-b");
    const firstTurnId = asTurnId("turn-a");
    const secondTurnId = asTurnId("turn-b");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-a-start"),
        threadId,
        message: {
          messageId: firstMessageId,
          role: "user",
          text: "create a",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadMessageStart(threadId, firstMessageId),
    );
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-a-started"),
      provider: "codex",
      createdAt,
      threadId,
      turnId: firstTurnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, firstTurnId));
    fs.writeFileSync(path.join(harness.cwd, "a.txt"), "A\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-a-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId: firstTurnId,
      payload: { state: "completed" },
    });
    await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.files?.map((file) => file.path).includes("a.txt") === true,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-b-start"),
        threadId,
        message: {
          messageId: secondMessageId,
          role: "user",
          text: "create b",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadMessageStart(threadId, secondMessageId),
    );
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-b-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId: secondTurnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, secondTurnId));
    fs.writeFileSync(path.join(harness.cwd, "b.txt"), "B\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-b-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId: secondTurnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 2 &&
        entry.checkpoints.some(
          (checkpoint) =>
            checkpoint.checkpointTurnCount === 2 &&
            checkpoint.files?.map((file) => file.path).join(",") === "b.txt",
        ),
    );

    expect(thread.checkpoints.at(-1)?.files?.map((file) => file.path)).toEqual(["b.txt"]);
  });

  it("recreates a missing message-start baseline before aliasing the turn-start ref", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("message-missing-baseline");
    const turnId = asTurnId("turn-missing-baseline");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-missing-baseline-start"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "recover baseline",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    const messageStartRef = checkpointRefForThreadMessageStart(threadId, messageId);
    await waitForGitRefExists(harness.cwd, messageStartRef);

    // Simulate a missing message-start baseline when the provider's
    // turn.started arrives, regardless of which startup path dropped it.
    runGit(harness.cwd, ["update-ref", "-d", messageStartRef]);

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-missing-baseline-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
    });
    const turnStartRef = checkpointRefForThreadTurnStart(threadId, turnId);
    await waitForGitRefExists(harness.cwd, turnStartRef);

    // The reactor must re-establish the message-start baseline and alias the
    // turn-start ref to it, not capture an independent turn-start snapshot.
    expect(gitRefExists(harness.cwd, messageStartRef)).toBe(true);
    expect(runGit(harness.cwd, ["rev-parse", messageStartRef]).trim()).toBe(
      runGit(harness.cwd, ["rev-parse", turnStartRef]).trim(),
    );
  });

  it("waits briefly for the assistant message id before finalizing a completed turn checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const turnId = asTurnId("turn-assistant-race");
    const assistantMessageId = MessageId.makeUnsafe("assistant:item-race");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-assistant-race"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-assistant-race"),
      provider: "codex",
      createdAt,
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId,
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "race\n", "utf8");

    setTimeout(() => {
      void Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("cmd-assistant-complete-race"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: assistantMessageId,
          turnId,
          createdAt: new Date().toISOString(),
        }),
      );
    }, 10);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-assistant-race"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 1),
    );

    expect(thread.checkpoints[0]?.assistantMessageId).toBe(assistantMessageId);
  });

  it("leaves placeholders unresolved until turn completion, then captures the real checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const turnId = asTurnId("turn-placeholder-race");
    const assistantMessageId = MessageId.makeUnsafe("assistant:item-placeholder-real");
    const syntheticAssistantMessageId = MessageId.makeUnsafe("assistant:evt-placeholder-synthetic");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-placeholder-baseline"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: MessageId.makeUnsafe("message-user-placeholder"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadMessageStart(
        ThreadId.makeUnsafe("thread-1"),
        MessageId.makeUnsafe("message-user-placeholder"),
      ),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-placeholder-race"),
      provider: "codex",
      createdAt,
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId,
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurnStart(ThreadId.makeUnsafe("thread-1"), turnId),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "placeholder\n", "utf8");

    setTimeout(() => {
      void Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("cmd-assistant-complete-placeholder-race"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: assistantMessageId,
          turnId,
          createdAt: new Date().toISOString(),
        }),
      );
    }, 10);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-diff-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "missing",
        files: [],
        assistantMessageId: syntheticAssistantMessageId,
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    let thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 1),
    );

    expect(thread.checkpoints[0]?.status).toBe("missing");
    expect(thread.checkpoints[0]?.assistantMessageId).toBe(syntheticAssistantMessageId);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(false);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-placeholder-race"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) =>
          checkpoint.checkpointTurnCount === 1 &&
          checkpoint.status === "ready" &&
          checkpoint.assistantMessageId === assistantMessageId,
      ),
    );

    expect(thread.checkpoints[0]?.assistantMessageId).toBe(assistantMessageId);
  });

  it("does not freeze an early placeholder snapshot as the final turn checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-placeholder-final");
    const messageId = MessageId.makeUnsafe("message-user-placeholder-final");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-placeholder-final"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-placeholder-final"),
      provider: "codex",
      createdAt,
      threadId,
      turnId,
    });

    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, turnId));

    fs.writeFileSync(path.join(harness.cwd, "early.txt"), "early\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-diff-early-placeholder"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "late.txt"), "late\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-placeholder-final"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) =>
          checkpoint.checkpointTurnCount === 1 &&
          checkpoint.status === "ready" &&
          checkpoint.files
            ?.map((file) => file.path)
            .sort()
            .join(",") === "early.txt,late.txt",
      ),
    );

    expect(thread.checkpoints[0]?.files?.map((file) => file.path).sort()).toEqual([
      "early.txt",
      "late.txt",
    ]);
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-primary-running"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-aux"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: "claudeAgent",
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-capture-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-claude-1"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-claude-1"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
  });

  it("derives a live turn-diff placeholder from git for claude file edits mid-turn", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: "claudeAgent",
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-claude-live");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-claude-live"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-claude-live"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, turnId));

    // A file edit completes while the turn is still running (no turn.completed yet).
    fs.writeFileSync(path.join(harness.cwd, "live.txt"), "live\n", "utf8");
    harness.provider.emit({
      type: "item.completed",
      eventId: EventId.makeUnsafe("evt-item-file-change-live"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
      itemId: "item-file-change-1",
      payload: { itemType: "file_change", status: "completed" },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) =>
          checkpoint.status === "missing" &&
          checkpoint.files?.map((file) => file.path).includes("live.txt") === true,
      ),
    );
    const livePlaceholder = liveThread.checkpoints.find(
      (checkpoint) => checkpoint.status === "missing",
    );
    expect(livePlaceholder?.checkpointTurnCount).toBe(1);
    const liveFile = livePlaceholder?.files?.find((file) => file.path === "live.txt") as
      | { readonly path: string; readonly additions?: number; readonly deletions?: number }
      | undefined;
    expect(liveFile?.additions).toBe(1);
    // The throwaway snapshot ref must not linger as a durable checkpoint.
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurnLive(threadId, turnId))).toBe(false);

    // The terminal turn.completed capture must overwrite the placeholder with the
    // authoritative git checkpoint (status "ready"), keeping a single entry.
    fs.writeFileSync(path.join(harness.cwd, "second.txt"), "second\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-claude-live"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) => checkpoint.checkpointTurnCount === 1 && checkpoint.status === "ready",
      ),
    );
    expect(finalThread.checkpoints).toHaveLength(1);
    expect(finalThread.checkpoints[0]?.files?.map((file) => file.path).sort()).toEqual([
      "live.txt",
      "second.txt",
    ]);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-baseline"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-for-baseline"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: MessageId.makeUnsafe("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-provider-cwd"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.makeUnsafe("evt-checkpoint-captured-3"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    // Force the completion capture to fail inside git: a ref nested under the
    // turn-1 checkpoint ref makes `git update-ref` refuse to create it, while
    // every other checkpoint ref in the family stays writable.
    runGit(harness.cwd, [
      "update-ref",
      `${checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)}/blocker`,
      "HEAD",
    ]);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-runtime-capture-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-after-runtime-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    // The first event must genuinely fail, otherwise this test proves nothing.
    await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(false);

    // The second event is still processed by the same worker.
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0)),
    ).toBe(true);
  });

  it("undoes turn files without trimming chat or rolling back the Claude conversation", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: "claudeAgent",
    });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnOneId = asTurnId("turn-files-1");
    const turnTwoId = asTurnId("turn-files-2");
    const placeholderTurnId = asTurnId("turn-files-placeholder");

    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 0),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "one.txt"), "one\n", "utf8");
    runGit(harness.cwd, ["add", "one.txt"]);
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      }),
    );
    await runtime!.runPromise(
      harness.checkpointStore.copyCheckpointRef({
        cwd: harness.cwd,
        fromCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        toCheckpointRef: checkpointRefForThreadTurnStart(threadId, turnTwoId),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "two.txt"), "two\n", "utf8");
    runGit(harness.cwd, ["add", "two.txt"]);
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 2),
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-files-undo-chat"),
        threadId,
        messages: [
          {
            messageId: MessageId.makeUnsafe("message-files-undo-user"),
            role: "user",
            text: "Change two files",
            createdAt,
            updatedAt: createdAt,
          },
          {
            messageId: MessageId.makeUnsafe("message-files-undo-assistant"),
            role: "assistant",
            text: "Changed them",
            createdAt,
            updatedAt: createdAt,
          },
        ],
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-files-undo"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const [turnCount, turnId, filePath] of [
      [1, turnOneId, "one.txt"],
      [2, turnTwoId, "two.txt"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`cmd-files-undo-diff-${turnCount}`),
          threadId,
          turnId,
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [{ path: filePath, kind: "modified", additions: 1, deletions: 0 }],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-files-undo-live-placeholder"),
        threadId,
        turnId: placeholderTurnId,
        completedAt: createdAt,
        checkpointRef: CheckpointRef.makeUnsafe("provider-diff:files-undo-placeholder"),
        status: "missing",
        files: [{ path: "placeholder.txt", kind: "modified", additions: 1, deletions: 0 }],
        checkpointTurnCount: 3,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-undo-files-turn-2"),
        threadId,
        turnCount: 2,
        scope: "files",
        createdAt,
      }),
    );
    await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.some(
          (checkpoint) => checkpoint.checkpointTurnCount === 2 && checkpoint.files?.length === 0,
        ) && entry.activities.some((activity) => activity.kind === "checkpoint.revert.succeeded"),
    );
    const afterFirstUndo = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(afterFirstUndo?.activities.map((activity) => activity.kind)).toEqual([
      "checkpoint.revert.started",
      "checkpoint.revert.succeeded",
    ]);
    expect(
      afterFirstUndo?.checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === 2)?.files,
    ).toEqual([]);
    expect(fs.readFileSync(path.join(harness.cwd, "one.txt"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(harness.cwd, "two.txt"))).toBe(false);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-undo-files-turn-1"),
        threadId,
        turnCount: 1,
        scope: "files",
        createdAt,
      }),
    );
    await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) => checkpoint.checkpointTurnCount === 1 && checkpoint.files?.length === 0,
      ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(
      thread?.checkpoints
        .filter((checkpoint) => !checkpoint.checkpointRef.startsWith("provider-diff:"))
        .every((checkpoint) => checkpoint.files.length === 0),
    ).toBe(true);
    expect(thread?.latestTurn?.turnId).toBe(placeholderTurnId);
    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Change two files",
      "Changed them",
    ]);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(harness.cwd, "one.txt"))).toBe(false);
    expect(fs.existsSync(path.join(harness.cwd, "two.txt"))).toBe(false);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
    expect(runGit(harness.cwd, ["rev-parse", checkpointRefForThreadTurn(threadId, 1)]).trim()).toBe(
      runGit(harness.cwd, ["rev-parse", checkpointRefForThreadTurn(threadId, 2)]).trim(),
    );
    expect(
      runGit(harness.cwd, [
        "rev-parse",
        checkpointRefForThreadTurnStart(threadId, turnTwoId),
      ]).trim(),
    ).toBe(runGit(harness.cwd, ["rev-parse", checkpointRefForThreadTurn(threadId, 1)]).trim());
    expect(
      runGit(harness.cwd, [
        "ls-tree",
        "-r",
        "--name-only",
        checkpointRefForThreadTurnStart(threadId, turnTwoId),
      ]),
    ).not.toContain("one.txt");
    expect(runGit(harness.cwd, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const fileUndoEvent = events.find(
      (event) =>
        event.type === "thread.turn-diff-completed" &&
        event.payload.turnId === turnOneId &&
        event.payload.files.length === 0,
    );
    expect(fileUndoEvent?.type === "thread.turn-diff-completed").toBe(true);
    if (fileUndoEvent?.type === "thread.turn-diff-completed") {
      expect(fileUndoEvent.payload.preserveLatestTurn).toBe(true);
    }
    expect(events.some((event) => event.type === "thread.reverted")).toBe(false);

    fs.writeFileSync(path.join(harness.cwd, "later.txt"), "later\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-full-revert-after-files-undo"),
        threadId,
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(fs.existsSync(path.join(harness.cwd, "one.txt"))).toBe(false);
    expect(fs.existsSync(path.join(harness.cwd, "two.txt"))).toBe(false);
    expect(fs.existsSync(path.join(harness.cwd, "later.txt"))).toBe(false);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
  });

  it("undoes staged renames without an active session or HEAD", async () => {
    const harness = await createHarness({
      hasSession: false,
      hasInitialCommit: false,
      seedFilesystemCheckpoints: false,
    });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 0),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "before.txt"), "before\n", "utf8");
    runGit(harness.cwd, ["add", "before.txt"]);
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      }),
    );
    runGit(harness.cwd, ["mv", "before.txt", "after.txt"]);
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 2),
      }),
    );

    for (const [turnCount, turnId, filePath] of [
      [1, asTurnId("turn-unborn-add"), "before.txt"],
      [2, asTurnId("turn-unborn-rename"), "after.txt"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`cmd-unborn-diff-${turnCount}`),
          threadId,
          turnId,
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [{ path: filePath, kind: "modified", additions: 1, deletions: 0 }],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-unborn-undo-rename"),
        threadId,
        turnCount: 2,
        scope: "files",
        createdAt,
      }),
    );
    await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.some(
          (checkpoint) => checkpoint.checkpointTurnCount === 2 && checkpoint.files?.length === 0,
        ) && entry.activities.some((activity) => activity.kind === "checkpoint.revert.succeeded"),
    );

    expect(fs.existsSync(path.join(harness.cwd, "before.txt"))).toBe(true);
    expect(fs.existsSync(path.join(harness.cwd, "after.txt"))).toBe(false);
    expect(runGit(harness.cwd, ["diff", "--cached", "--name-only"])).toBe("before.txt\n");
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(thread?.activities.map((activity) => activity.kind)).toEqual([
      "checkpoint.revert.started",
      "checkpoint.revert.succeeded",
    ]);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("does not undo files when the exact turn baseline is missing", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-missing-baseline");

    fs.writeFileSync(path.join(harness.cwd, "turn.txt"), "turn\n", "utf8");
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "later.txt"), "later\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-missing-baseline-diff"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [{ path: "turn.txt", kind: "modified", additions: 1, deletions: 0 }],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-missing-baseline-undo"),
        threadId,
        turnCount: 1,
        scope: "files",
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(harness.cwd, "turn.txt"), "utf8")).toBe("turn\n");
    expect(fs.readFileSync(path.join(harness.cwd, "later.txt"), "utf8")).toBe("later\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("rechecks live provider state before mutating a projected-idle thread", async () => {
    const harness = await createHarness({
      providerStatus: "running",
      providerActiveTurnId: asTurnId("runtime-turn"),
    });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-projected-ready-runtime-running"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const turnCount of [1, 2] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`cmd-runtime-guard-diff-${turnCount}`),
          threadId,
          turnId: asTurnId(`runtime-guard-turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-runtime-guard-revert"),
        threadId,
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("rejects a child-thread revert while its parent-owned provider session is active", async () => {
    const harness = await createHarness({
      providerStatus: "running",
      providerActiveTurnId: asTurnId("parent-runtime-turn"),
    });
    const createdAt = new Date().toISOString();
    const childThreadId = ThreadId.makeUnsafe("subagent:thread-1:child-revert");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-child-revert-thread-create"),
        threadId: childThreadId,
        projectId: asProjectId("project-1"),
        title: "Child revert",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: harness.cwd,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-child-revert-active-parent"),
        threadId: childThreadId,
        turnCount: 0,
        scope: "thread",
        createdAt,
      }),
    );

    const events = await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.activity-appended" &&
        event.payload.threadId === childThreadId &&
        event.payload.activity.kind === "checkpoint.revert.failed",
    );
    const failure = events.find(
      (event) =>
        event.type === "thread.activity-appended" &&
        event.payload.threadId === childThreadId &&
        event.payload.activity.kind === "checkpoint.revert.failed",
    ) as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    expect(failure.payload.activity.payload).toMatchObject({
      detail: `Thread '${childThreadId}' has an active turn. Interrupt the current turn before reverting checkpoints.`,
    });
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("keeps full thread revert behavior for explicit thread scope", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2)),
    ).toBe(false);
  });

  it("restores turn zero from the persisted checkpoint family", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const historicalTurnZeroRef = checkpointRefForThreadTurn(threadId, 0).replace(
      "refs/synara/",
      "refs/historical/",
    );
    const historicalTurnOneRef = CheckpointRef.makeUnsafe(
      checkpointRefForThreadTurn(threadId, 1).replace("refs/synara/", "refs/historical/"),
    );

    runGit(harness.cwd, ["update-ref", historicalTurnZeroRef, "HEAD"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    runGit(harness.cwd, ["add", "."]);
    runGit(harness.cwd, ["commit", "-m", "Second"]);
    runGit(harness.cwd, ["update-ref", historicalTurnOneRef, "HEAD"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v3\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-historical-session-set"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-historical-diff-1"),
        threadId,
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: historicalTurnOneRef,
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-historical-revert-zero"),
        threadId,
        turnCount: 0,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");
  });

  it("refuses turn zero when the exact baseline is missing without touching the workspace", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnOneRef = checkpointRefForThreadTurn(threadId, 1);

    runGit(harness.cwd, ["update-ref", turnOneRef, "HEAD"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    runGit(harness.cwd, ["add", "README.md"]);
    runGit(harness.cwd, ["commit", "-m", "Move HEAD after the missing baseline"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "tracked working change\n", "utf8");
    fs.writeFileSync(path.join(harness.cwd, "untracked.txt"), "keep me\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-missing-zero-session-set"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-missing-zero-diff"),
        threadId,
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: turnOneRef,
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-missing-zero-revert"),
        threadId,
        turnCount: 0,
        scope: "thread",
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
      "tracked working change\n",
    );
    expect(fs.readFileSync(path.join(harness.cwd, "untracked.txt"), "utf8")).toBe("keep me\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: "claudeAgent" });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-claude-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-claude-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-request-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-inline-revert"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.filter((activity) => activity.kind === "checkpoint.revert.succeeded")
          .length === 1,
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    const deadline = Date.now() + 20_000;
    const waitForRollbackCalls = async (): Promise<void> => {
      if (harness.provider.rollbackConversation.mock.calls.length >= 2) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for rollbackConversation calls.");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return waitForRollbackCalls();
    };
    await waitForRollbackCalls();
    const settledThread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.filter((activity) => activity.kind === "checkpoint.revert.succeeded")
          .length === 2,
    );

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(
      settledThread.activities.filter((activity) => activity.kind === "checkpoint.revert.started"),
    ).toHaveLength(2);
    expect(
      settledThread.activities.filter(
        (activity) => activity.kind === "checkpoint.revert.succeeded",
      ),
    ).toHaveLength(2);
    expect(
      settledThread.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    ).toBe(false);
  });

  it("appends an error activity when revert is requested without an active session", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-no-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
