import assert from "node:assert/strict";
import path from "node:path";
import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it, vi } from "@effect/vitest";

import { Effect, Fiber, FileSystem, Layer, Option, Stream } from "effect";

import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
  type CodexAppServerSendTurnInput,
} from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeCodexAdapterLive } from "./CodexAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);

class FakeCodexManager extends CodexAppServerManager {
  public startSessionImpl = vi.fn(
    async (input: CodexAppServerStartSessionInput): Promise<ProviderSession> => {
      const now = new Date().toISOString();
      return {
        provider: "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (_input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
    }),
  );

  public steerTurnImpl = vi.fn(
    async (_input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-steer-1"),
    }),
  );

  public interruptTurnImpl = vi.fn(
    async (_threadId: ThreadId, _turnId?: TurnId, _providerThreadId?: string): Promise<void> =>
      undefined,
  );

  public readThreadImpl = vi.fn(async (_threadId: ThreadId) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public rollbackThreadImpl = vi.fn(async (_threadId: ThreadId, _numTurns: number) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public respondToRequestImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Promise<void> => undefined,
  );

  public respondToUserInputImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Promise<void> => undefined,
  );

  public stopAllImpl = vi.fn(() => undefined);

  override startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    return this.startSessionImpl(input);
  }

  override sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input);
  }

  override steerTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.steerTurnImpl(input);
  }

  override interruptTurn(
    threadId: ThreadId,
    turnId?: TurnId,
    providerThreadId?: string,
  ): Promise<void> {
    return this.interruptTurnImpl(threadId, turnId, providerThreadId);
  }

  override readThread(threadId: ThreadId) {
    return this.readThreadImpl(threadId);
  }

  override rollbackThread(threadId: ThreadId, numTurns: number) {
    return this.rollbackThreadImpl(threadId, numTurns);
  }

  override respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    return this.respondToRequestImpl(threadId, requestId, decision);
  }

  override respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    return this.respondToUserInputImpl(threadId, requestId, answers);
  }

  override async stopSession(_threadId: ThreadId): Promise<void> {}

  override listSessions(): ProviderSession[] {
    return [];
  }

  override hasSession(_threadId: ThreadId): boolean {
    return false;
  }

  override async stopAll(): Promise<void> {
    this.stopAllImpl();
  }
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const validationManager = new FakeCodexManager();
const validationLayer = it.layer(
  makeCodexAdapterLive({ manager: validationManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: "claudeAgent",
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      assert.equal(validationManager.startSessionImpl.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-1"),
        lifecycleGeneration: "generation-start-a",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(validationManager.startSessionImpl.mock.calls[0]?.[0], {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        lifecycleGeneration: "generation-start-a",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
        runtimeMode: "full-access",
      });
    }),
  );
});

const sessionErrorManager = new FakeCodexManager();
sessionErrorManager.sendTurnImpl.mockImplementation(async () => {
  throw new Error("Unknown session: sess-missing");
});
const sessionErrorLayer = it.layer(
  makeCodexAdapterLive({ manager: sessionErrorManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps unknown-session sendTurn errors to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }

      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      if (result.failure._tag !== "ProviderAdapterSessionNotFoundError") {
        return;
      }
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.threadId, "sess-missing");
      assert.equal(result.failure.cause instanceof Error, true);
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          attachments: [],
        }),
      );

      assert.deepStrictEqual(sessionErrorManager.sendTurnImpl.mock.calls[0]?.[0], {
        threadId: asThreadId("sess-missing"),
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
      });
    }),
  );
});

const turnPreparationManager = new FakeCodexManager();
const turnPreparationLayer = it.layer(
  makeCodexAdapterLive({ manager: turnPreparationManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "codex-turn-input-" })),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

turnPreparationLayer("CodexAdapterLive turn input preparation", (it) => {
  it.effect("prepares equivalent rich send and steer manager payloads", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const imageBytes = Uint8Array.from([1, 2, 3, 4]);
      const imageId = "codex-rich-input-image";
      const fileId = "codex-rich-input-file";
      const imagePath = path.join(serverConfig.attachmentsDir, `${imageId}.png`);
      const filePath = path.join(serverConfig.attachmentsDir, `${fileId}.txt`);
      yield* fileSystem.writeFile(imagePath, imageBytes);
      yield* fileSystem.writeFileString(filePath, "notes");

      turnPreparationManager.sendTurnImpl.mockClear();
      turnPreparationManager.steerTurnImpl.mockClear();
      const input = {
        threadId: asThreadId("thread-rich-input"),
        input: "Inspect the attached context",
        attachments: [
          {
            type: "image" as const,
            id: imageId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: imageBytes.byteLength,
          },
          {
            type: "file" as const,
            id: fileId,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
          },
        ],
        skills: [{ name: "check-code", path: "/skills/check-code/SKILL.md" }],
        mentions: [{ name: "github", path: "plugin://github@openai-curated" }],
        modelSelection: {
          provider: "codex" as const,
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        interactionMode: "plan" as const,
      };

      yield* adapter.sendTurn(input);
      const steerTurn = adapter.steerTurn;
      assert.ok(steerTurn);
      yield* steerTurn(input);

      const sendInput = turnPreparationManager.sendTurnImpl.mock.calls[0]?.[0];
      const steerInput = turnPreparationManager.steerTurnImpl.mock.calls[0]?.[0];
      assert.deepStrictEqual(steerInput, sendInput);
      assert.deepStrictEqual(sendInput, {
        threadId: asThreadId("thread-rich-input"),
        input: [
          "Inspect the attached context",
          "",
          "<attached_files>",
          "The user attached the following file(s), saved on disk. Read/extract them with your tools as needed; do not assume their contents.",
          `- \"notes.txt\" - text/plain - 5 B - ${filePath}`,
          "</attached_files>",
        ].join("\n"),
        skills: [{ name: "check-code", path: "/skills/check-code/SKILL.md" }],
        mentions: [{ name: "github", path: "plugin://github@openai-curated" }],
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
        interactionMode: "plan",
        attachments: [
          {
            type: "localImage",
            path: imagePath,
          },
        ],
      });
      assert.equal(turnPreparationManager.sendTurnImpl.mock.calls.length, 1);
      assert.equal(turnPreparationManager.steerTurnImpl.mock.calls.length, 1);
    }),
  );

  it.effect("preserves the steer method and cause for an invalid native image path", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      turnPreparationManager.steerTurnImpl.mockClear();
      const steerTurn = adapter.steerTurn;
      assert.ok(steerTurn);

      const result = yield* steerTurn({
        threadId: asThreadId("thread-invalid-image"),
        attachments: [
          {
            type: "image",
            id: "../invalid-image",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
        ],
      }).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      if (result.failure._tag !== "ProviderAdapterRequestError") {
        return;
      }
      assert.equal(result.failure.method, "turn/steer");
      assert.equal(result.failure.detail, "Invalid attachment id '../invalid-image'.");
      assert.equal(result.failure.cause instanceof Error, true);
      assert.equal(turnPreparationManager.steerTurnImpl.mock.calls.length, 0);
    }),
  );
});

const lifecycleManager = new FakeCodexManager();
const lifecycleLayer = it.layer(
  makeCodexAdapterLive({ manager: lifecycleManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("normalizes whitespace in configuration warnings at the provider boundary", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-config-warning"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "configWarning",
        threadId: asThreadId("thread-1"),
        payload: {
          summary: "  Invalid MCP configuration  ",
          details: "url is not supported for stdio\n",
          path: "  mcp_servers.synara  ",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "config.warning");
      if (firstEvent.value.type !== "config.warning") {
        return;
      }
      assert.equal(firstEvent.value.payload.summary, "Invalid MCP configuration");
      assert.equal(firstEvent.value.payload.details, "url is not supported for stdio");
      assert.equal(firstEvent.value.payload.path, "mcp_servers.synara");
    }),
  );

  it.effect("maps Codex 0.144 reasoning summaries from canonical item arrays", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-reasoning-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("reasoning_1"),
        payload: {
          item: {
            type: "reasoning",
            id: "reasoning_1",
            summary: ["Inspect the protocol.", "Update the adapter."],
            content: [],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "reasoning");
      assert.equal(firstEvent.value.payload.detail, "Inspect the protocol.\n\nUpdate the adapter.");
    }),
  );

  it.effect("maps structured reasoning summary parts without exposing raw content", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-structured-reasoning-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("reasoning_2"),
        payload: {
          item: {
            type: "reasoning",
            id: "reasoning_2",
            summary: [
              { type: "summary_text", text: "Inspect the protocol." },
              { summary: "Update the adapter." },
            ],
            content: [{ type: "reasoning_text", text: "private raw trace" }],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.detail, "Inspect the protocol.\n\nUpdate the adapter.");
    }),
  );

  it.effect("keeps Codex reasoning trace and summary delta streams distinct", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-reasoning-trace-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/reasoning/textDelta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("reasoning_1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          itemId: "reasoning_1",
          delta: "raw trace",
          contentIndex: 2,
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-reasoning-summary-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/reasoning/summaryTextDelta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("reasoning_1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          itemId: "reasoning_1",
          delta: "readable summary",
          summaryIndex: 1,
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "content.delta");
      assert.equal(events[1]?.type, "content.delta");
      if (events[0]?.type === "content.delta") {
        assert.equal(events[0].payload.streamKind, "reasoning_text");
        assert.equal(events[0].payload.contentIndex, 2);
      }
      if (events[1]?.type === "content.delta") {
        assert.equal(events[1].payload.streamKind, "reasoning_summary_text");
        assert.equal(events[1].payload.summaryIndex, 1);
      }
    }),
  );

  it.effect("preserves failed commandExecution status from canonical completed items", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-command-failed"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("command_1"),
        payload: {
          item: {
            type: "commandExecution",
            id: "command_1",
            command: "bun run test --runInBand",
            cwd: "/repo",
            status: "failed",
            commandActions: [],
            aggregatedOutput: "Unknown option --runInBand",
            exitCode: 1,
            durationMs: 42,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "command_execution");
      assert.equal(firstEvent.value.payload.status, "failed");
      assert.equal(firstEvent.value.payload.title, "Ran command");
      assert.equal(firstEvent.value.payload.detail, "bun run test --runInBand");
    }),
  );

  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          item: {
            type: "agentMessage",
            id: "msg_1",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("maps completed generated-image items to structured image artifacts", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-image-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        providerThreadId: "provider-thread-1",
        turnId: asTurnId("turn-1"),
        itemId: asItemId("img_call_1"),
        payload: {
          item: {
            type: "image_generation_call",
            id: "img_call_1",
            saved_path: "/tmp/provider-thread-1/img_call_1.png",
            result: "large-inline-base64",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "image_generation");
      assert.equal(firstEvent.value.payload.title, "Generated image");
      assert.deepStrictEqual(firstEvent.value.payload.data, {
        kind: "codex.generated_image",
        path: "/tmp/provider-thread-1/img_call_1.png",
        callId: "img_call_1",
      });
      const rawPayload = firstEvent.value.raw?.payload as {
        item?: { result?: string; result_elided_for_relay?: boolean };
      };
      assert.equal(rawPayload.item?.result, undefined);
      assert.equal(rawPayload.item?.result_elided_for_relay, true);
    }),
  );

  it.effect("maps legacy image_generation_end notifications", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-image-end"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "codex/event/image_generation_end",
        threadId: asThreadId("thread-1"),
        payload: {
          msg: {
            type: "image_generation_end",
            threadId: "provider-thread-1",
            turn_id: "turn-1",
            call_id: "img_call_2",
            saved_path: "/tmp/provider-thread-1/img_call_2.png",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.itemId, "img_call_2");
      assert.equal(firstEvent.value.payload.itemType, "image_generation");
      assert.deepStrictEqual(firstEvent.value.payload.data, {
        kind: "codex.generated_image",
        path: "/tmp/provider-thread-1/img_call_2.png",
        callId: "img_call_2",
      });
    }),
  );

  it.effect("maps exited review items to assistant completion events with review text", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-review-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-review"),
        payload: {
          item: {
            type: "exitedReviewMode",
            id: "review_1",
            review: "Working tree is clean.",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-review");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
      assert.equal(firstEvent.value.payload.detail, "Working tree is clean.");
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          item: {
            type: "Plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "session/closed",
        message: "Session stopped",
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps non-fatal Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-non-fatal-error"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          error: {
            message:
              "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
          },
          willRetry: false,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
      );
    }),
  );

  it.effect("maps process stderr provider errors to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr"),
        kind: "error",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "write_stdin failed: stdin is closed for this session",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "write_stdin failed: stdin is closed for this session",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        payload: {
          request: {
            method: "item/commandExecution/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("maps permission-profile approval requests to the canonical permission kind", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-permissions-request"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/permissions/requestApproval",
        requestId: ApprovalRequestId.makeUnsafe("req-permissions-1"),
        requestKind: "permissions",
        payload: {
          reason: "Needs network access",
          permissions: { network: { enabled: true } },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") return;
      assert.equal(firstEvent.value.payload.requestType, "permissions_approval");
      assert.equal(firstEvent.value.payload.detail, "Needs network access");
      assert.deepEqual(firstEvent.value.payload.args, {
        reason: "Needs network access",
        permissions: { network: { enabled: true } },
      });
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-file-read-1"),
        payload: {
          request: {
            method: "item/fileRead/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: [],
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          success: false,
          detail: "unsupported environment",
        },
      };

      lifecycleManager.emit("event", event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.notEqual(firstEvent?.eventId, secondEvent?.eventId);
      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          lifecycleGeneration: "generation-request-a",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          lifecycleGeneration: "generation-request-a",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].lifecycleGeneration, "generation-request-a");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.equal(events[1].lifecycleGeneration, "generation-request-a");
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("maps Codex task and reasoning event chunks into canonical runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_started",
            turn_id: "turn-structured-1",
            collaboration_mode_kind: "plan",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-agent-reasoning"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/agent_reasoning",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "agent_reasoning",
            text: "Need to compare both transport layers before finalizing the plan.",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-reasoning-delta"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/reasoning_content_delta",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "reasoning_content_delta",
            turn_id: "turn-structured-1",
            item_id: "rs_reasoning_1",
            delta: "**Compare** transport boundaries",
            summary_index: 0,
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-complete"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_complete",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_complete",
            turn_id: "turn-structured-1",
            last_agent_message: "<proposed_plan>\n# Ship it\n</proposed_plan>",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events[0]?.type, "task.started");
      if (events[0]?.type === "task.started") {
        assert.equal(events[0].turnId, "turn-structured-1");
        assert.equal(events[0].payload.taskId, "turn-structured-1");
        assert.equal(events[0].payload.taskType, "plan");
      }

      assert.equal(events[1]?.type, "task.progress");
      if (events[1]?.type === "task.progress") {
        assert.equal(events[1].payload.taskId, "turn-structured-1");
        assert.equal(
          events[1].payload.description,
          "Need to compare both transport layers before finalizing the plan.",
        );
      }

      assert.equal(events[2]?.type, "content.delta");
      if (events[2]?.type === "content.delta") {
        assert.equal(events[2].turnId, "turn-structured-1");
        assert.equal(events[2].itemId, "rs_reasoning_1");
        assert.equal(events[2].payload.streamKind, "reasoning_summary_text");
        assert.equal(events[2].payload.summaryIndex, 0);
      }

      assert.equal(events[3]?.type, "task.completed");
      if (events[3]?.type === "task.completed") {
        assert.equal(events[3].turnId, "turn-structured-1");
        assert.equal(events[3].payload.taskId, "turn-structured-1");
        assert.equal(events[3].payload.summary, "<proposed_plan>\n# Ship it\n</proposed_plan>");
      }

      assert.equal(events[4]?.type, "turn.proposed.completed");
      if (events[4]?.type === "turn.proposed.completed") {
        assert.equal(events[4].turnId, "turn-structured-1");
        assert.equal(events[4].payload.planMarkdown, "# Ship it");
      }
      assert.notEqual(events[3]?.eventId, events[4]?.eventId);
    }),
  );

  it.effect("prefers manager-assigned turn ids for Codex task events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-started-parent-turn"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-child",
          msg: {
            type: "task_started",
            turn_id: "turn-child",
            collaboration_mode_kind: "default",
          },
          conversationId: "child-provider-thread",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.started");
      if (firstEvent.value.type !== "task.started") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-parent");
      assert.equal(firstEvent.value.providerRefs?.providerTurnId, "turn-parent");
      assert.equal(firstEvent.value.payload.taskId, "turn-child");
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      assert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("maps thread/compacting notifications to context compaction progress events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-thread-compacting"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/compacting",
        message: "Compacting context",
        payload: {
          threadId: "thread-1",
          state: "compacting",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.updated");
      if (firstEvent.value.type !== "item.updated") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "context_compaction");
      assert.equal(firstEvent.value.payload.detail, "Compacting context");
      assert.equal(firstEvent.value.payload.status, "inProgress");
    }),
  );
});

afterAll(() => {
  if (lifecycleManager.stopAllImpl.mock.calls.length === 0) {
    lifecycleManager.stopAll();
  }
  assert.ok(lifecycleManager.stopAllImpl.mock.calls.length >= 1);
});
