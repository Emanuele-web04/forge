// FILE: AcpJsonRpcConnection.test.ts
// Purpose: Verifies ACP session negotiation, lifecycle, and event normalization.
// Layer: Provider ACP runtime tests

import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect } from "vitest";

import {
  AcpSessionRuntime,
  type AcpProtocolLogEvent,
  type AcpSessionRequestLogEvent,
} from "./AcpSessionRuntime.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const bunExe = process.execPath;

describe("AcpSessionRuntime", () => {
  it.effect("merges custom initialize client capabilities into the ACP handshake", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const initializeStarted = requestEvents.find(
        (event) => event.method === "initialize" && event.status === "started",
      );
      expect(initializeStarted?.payload).toMatchObject({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { parameterizedModelPicker: true },
        },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("forwards provider session metadata when creating a session", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const sessionStarted = requestEvents.find(
        (event) => event.method === "session/new" && event.status === "started",
      );
      expect(sessionStarted?.payload).toMatchObject({
        _meta: {
          "x.ai/hooks": {
            PreToolUse: [{ matcher: "*", hookCallbackIds: ["synara-plan-guard"] }],
          },
        },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          sessionMeta: {
            "x.ai/hooks": {
              PreToolUse: [{ matcher: "*", hookCallbackIds: ["synara-plan-guard"] }],
            },
          },
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("retries one matching fresh session setup failure", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.sessionId).toBe("mock-session-1");
      expect(
        requestEvents.filter(
          (event) => event.method === "session/new" && event.status === "started",
        ),
      ).toHaveLength(2);
      expect(
        requestEvents.filter(
          (event) => event.method === "initialize" && event.status === "started",
        ),
      ).toHaveLength(1);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              SYNARA_ACP_FAIL_SESSION_NEW_ONCE: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
          freshSessionRetry: {
            shouldRetry: (error) =>
              error._tag === "AcpRequestError" &&
              typeof error.data === "object" &&
              error.data !== null &&
              (error.data as { readonly code?: unknown }).code === "FS_NOT_FOUND",
          },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("loads a resumed session and still prompts normally", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionId).toBe("mock-session-1");

      // Resumed sessions drop session/update until a consumer attaches, so the
      // events stream must be taken before prompting (mirrors the adapters,
      // which fork the drain right after start()).
      const eventsFiber = yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)).pipe(
        Effect.forkChild,
      );
      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      // The session/load replay chunk emitted before the consumer attached is
      // dropped; only the prompt's own events arrive.
      const notes = Array.from(yield* Fiber.join(eventsFiber));
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("forwards provider session metadata when loading a session", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionSetupMethod).toBe("load");
      expect(
        requestEvents.find((event) => event.method === "session/load" && event.status === "started")
          ?.payload,
      ).toMatchObject({ _meta: { reconnectPolicy: "keep-hooks" } });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          sessionMeta: { reconnectPolicy: "keep-hooks" },
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("prefers session/resume when the agent advertises it", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionSetupMethod).toBe("resume");
      expect(requestEvents.some((event) => event.method === "session/resume")).toBe(true);
      expect(requestEvents.some((event) => event.method === "session/load")).toBe(false);
      expect(
        requestEvents.find(
          (event) => event.method === "session/resume" && event.status === "started",
        )?.payload,
      ).toMatchObject({ _meta: { reconnectPolicy: "keep-hooks" } });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: { VITEST: "true", SYNARA_ACP_SUPPORT_SESSION_RESUME: "1" },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          sessionMeta: { reconnectPolicy: "keep-hooks" },
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("does not call session/load when the agent does not advertise it", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.exit);
      expect(Exit.isFailure(started)).toBe(true);
      expect(requestEvents.some((event) => event.method === "session/load")).toBe(false);
      expect(requestEvents.some((event) => event.method === "session/new")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: { VITEST: "true", SYNARA_ACP_SUPPORT_SESSION_LOAD: "0" },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("resolves semantic mode config ids and exposes commands and forks", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      expect(yield* runtime.supportsSessionFork).toBe(true);
      yield* runtime.setMode("code");
      const commands = yield* runtime.getAvailableCommands;
      const forked = yield* runtime.forkSession({ cwd: process.cwd(), mcpServers: [] });

      expect(commands).toEqual([{ name: "compact", description: "Compact the current context" }]);
      expect(forked.sessionId).toBe("mock-session-fork-1");
      const modeRequest = requestEvents.find(
        (event) => event.method === "session/set_config_option" && event.status === "started",
      );
      expect(modeRequest?.payload).toMatchObject({
        configId: "autonomy_level",
        value: "code",
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              SYNARA_ACP_SUPPORT_SESSION_FORK: "1",
              SYNARA_ACP_EMIT_AVAILABLE_COMMANDS: "1",
              SYNARA_ACP_MODE_CONFIG_ID: "autonomy_level",
            },
          },
          cwd: process.cwd(),
          clientCapabilities: { _meta: { parameterizedModelPicker: true } },
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect(
    "assigns distinct fallback assistant item ids across separate runtime instances",
    () => {
      const runtimeLayer = AcpSessionRuntime.layer({
        spawn: {
          command: bunExe,
          args: [mockAgentPath],
        },
        cwd: process.cwd(),
        resumeSessionId: "mock-session-1",
        clientInfo: { name: "synara-test", version: "0.0.0" },
        authMethodId: "test",
      });

      const collectFallbackAssistantItemId = Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start();
        const eventsFiber = yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)).pipe(
          Effect.forkChild,
        );
        yield* runtime.prompt({
          prompt: [{ type: "text", text: "hi" }],
        });
        const notes = Array.from(yield* Fiber.join(eventsFiber));
        const delta = notes.find((note) => note._tag === "ContentDelta");
        expect(delta?._tag).toBe("ContentDelta");
        return delta?._tag === "ContentDelta" ? delta.itemId : undefined;
      }).pipe(Effect.provide(runtimeLayer), Effect.scoped, Effect.provide(NodeServices.layer));

      return Effect.gen(function* () {
        const firstItemId = yield* collectFallbackAssistantItemId;
        const secondItemId = yield* collectFallbackAssistantItemId;
        const fallbackIdPattern = /^assistant:mock-session-1:[0-9a-f]{8}:segment:0$/;
        expect(firstItemId).toMatch(fallbackIdPattern);
        expect(secondItemId).toMatch(fallbackIdPattern);
        expect(firstItemId).not.toBe(secondItemId);
      });
    },
  );

  it.effect("starts a session, prompts, and emits normalized events against the mock agent", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.initializeResult).toMatchObject({ protocolVersion: 1 });
      expect(started.sessionId).toBe("mock-session-1");

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes).toHaveLength(4);
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const planUpdate = notes.find((note) => note._tag === "PlanUpdated");
      expect(planUpdate?._tag).toBe("PlanUpdated");
      if (planUpdate?._tag === "PlanUpdated") {
        expect(planUpdate.payload.plan).toHaveLength(2);
      }
      const assistantStart = notes[1];
      const assistantDelta = notes[2];
      if (
        assistantStart?._tag === "AssistantItemStarted" &&
        assistantDelta?._tag === "ContentDelta"
      ) {
        expect(assistantDelta.itemId).toBe(assistantStart.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("segments assistant text around ACP tool calls", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 7)));
      expect(notes.map((note) => note._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
        "ToolCallUpdated",
        "ToolCallUpdated",
        "AssistantItemStarted",
        "ContentDelta",
      ]);

      const firstStarted = notes[0];
      const firstDelta = notes[1];
      const firstCompleted = notes[2];
      const secondStarted = notes[5];
      const secondDelta = notes[6];
      expect(firstStarted?._tag).toBe("AssistantItemStarted");
      expect(firstCompleted?._tag).toBe("AssistantItemCompleted");
      expect(secondStarted?._tag).toBe("AssistantItemStarted");
      if (
        firstStarted?._tag === "AssistantItemStarted" &&
        firstDelta?._tag === "ContentDelta" &&
        firstCompleted?._tag === "AssistantItemCompleted" &&
        secondStarted?._tag === "AssistantItemStarted" &&
        secondDelta?._tag === "ContentDelta"
      ) {
        expect(firstDelta.itemId).toBe(firstStarted.itemId);
        expect(firstCompleted.itemId).toBe(firstStarted.itemId);
        expect(secondStarted.itemId).not.toBe(firstStarted.itemId);
        expect(secondDelta.itemId).toBe(secondStarted.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              SYNARA_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("preserves upstream assistant message ids across ACP tool-call segments", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 11)));
      const contentDeltas = notes.filter((note) => note._tag === "ContentDelta");
      expect(contentDeltas.map((note) => note.itemId)).toEqual([
        "upstream-answer",
        "upstream-answer",
        "upstream-followup",
      ]);
      expect(contentDeltas.map((note) => note.text)).toEqual([
        "before tool",
        " after tool",
        "separate answer",
      ]);
      expect(
        notes.filter((note) => note._tag === "AssistantItemStarted").map((note) => note.itemId),
      ).toEqual(["upstream-answer", "upstream-answer", "upstream-followup"]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              SYNARA_ACP_EMIT_UPSTREAM_ASSISTANT_MESSAGE_IDS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("emits generic placeholder tool lifecycle updates", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 3)));
      expect(notes.map((note) => note._tag)).toEqual([
        "ToolCallUpdated",
        "ToolCallUpdated",
        "ToolCallUpdated",
      ]);
      const toolCall = notes[0];
      expect(toolCall?._tag).toBe("ToolCallUpdated");
      if (toolCall?._tag === "ToolCallUpdated") {
        expect(toolCall.toolCall.status).toBe("pending");
        expect(toolCall.toolCall.title).toBe("Reading");
      }
      const completedToolCall = notes[2];
      expect(completedToolCall?._tag).toBe("ToolCallUpdated");
      if (completedToolCall?._tag === "ToolCallUpdated") {
        expect(completedToolCall.toolCall.status).toBe("completed");
        expect(completedToolCall.toolCall.title).toBe("Read");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              SYNARA_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("does not open assistant segments for reasoning chunks before tool calls", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 3)));
      expect(notes.map((note) => note._tag)).toEqual([
        "ContentDelta",
        "ToolCallUpdated",
        "ToolCallUpdated",
      ]);
      const reasoningDelta = notes[0];
      expect(reasoningDelta?._tag).toBe("ContentDelta");
      if (reasoningDelta?._tag === "ContentDelta") {
        expect(reasoningDelta.streamKind).toBe("reasoning_text");
        expect(reasoningDelta.itemId).toBeUndefined();
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              SYNARA_ACP_EMIT_REASONING_THEN_TOOL_CALL: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("logs ACP requests from the shared runtime", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setModel("composer-2");
      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "succeeded",
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("skips no-op session config writes when the requested value is already active", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setConfigOption("model", "default");
      yield* runtime.setMode("ask");

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("emits low-level ACP protocol logs for raw and decoded messages", () => {
    const protocolEvents: Array<AcpProtocolLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "decoded"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "decoded"),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event) =>
              Effect.sync(() => {
                protocolEvents.push(event);
              }),
          },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("rejects invalid config option values before sending session/set_config_option", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "acp-runtime-"));
    const requestLogPath = path.join(tempDir, "requests.ndjson");
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const error = yield* runtime.setModel("composer-2[fast=false]").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.code).toBe(-32602);
        expect(error.message).toContain(
          'Invalid value "composer-2[fast=false]" for session config option "model"',
        );
        expect(error.message).toContain("composer-2[fast=true]");
      }

      const recordedRequests = readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: { value?: unknown } });
      expect(
        recordedRequests.some(
          (message) =>
            message.method === "session/set_config_option" &&
            message.params?.value === "composer-2[fast=false]",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              SYNARA_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "synara-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
});
