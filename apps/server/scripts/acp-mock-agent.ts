#!/usr/bin/env bun
// FILE: acp-mock-agent.ts
// Purpose: Provides a deterministic ACP subprocess for runtime integration tests.
// Layer: Test fixture executable
// Exports: none; communicates over JSON-RPC stdio.

import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import * as OfficialAcp from "@agentclientprotocol/sdk";
import * as Effect from "effect/Effect";
import type * as AcpSchema from "@agentclientprotocol/sdk";

const requestLogPath = process.env.SYNARA_ACP_REQUEST_LOG_PATH;
const exitLogPath = process.env.SYNARA_ACP_EXIT_LOG_PATH;
const emitToolCalls = process.env.SYNARA_ACP_EMIT_TOOL_CALLS === "1";
const emitInterleavedAssistantToolCalls =
  process.env.SYNARA_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitUpstreamAssistantMessageIds =
  process.env.SYNARA_ACP_EMIT_UPSTREAM_ASSISTANT_MESSAGE_IDS === "1";
const emitReasoningThenToolCall = process.env.SYNARA_ACP_EMIT_REASONING_THEN_TOOL_CALL === "1";
const emitGenericToolPlaceholders = process.env.SYNARA_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitAskQuestion = process.env.SYNARA_ACP_EMIT_ASK_QUESTION === "1";
const failSessionNewOnce = process.env.SYNARA_ACP_FAIL_SESSION_NEW_ONCE === "1";
const failSetConfigOption = process.env.SYNARA_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.SYNARA_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const promptResponseText = process.env.SYNARA_ACP_PROMPT_RESPONSE_TEXT;
const supportsSessionResume = process.env.SYNARA_ACP_SUPPORT_SESSION_RESUME === "1";
const supportsSessionLoad = process.env.SYNARA_ACP_SUPPORT_SESSION_LOAD !== "0";
const supportsSessionFork = process.env.SYNARA_ACP_SUPPORT_SESSION_FORK === "1";
const emitAvailableCommands = process.env.SYNARA_ACP_EMIT_AVAILABLE_COMMANDS === "1";
const modeConfigId = process.env.SYNARA_ACP_MODE_CONFIG_ID || "mode";
const sessionId = "mock-session-1";

let currentModeId = "ask";
let currentModelId = "default";
let parameterizedModelPicker = false;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
let sessionNewAttempts = 0;
const cancelledSessions = new Set<string>();

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

function configOptions(): Array<AcpSchema.SessionConfigOption> {
  if (parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        id: modeConfigId,
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (currentModelId) {
      case "gpt-5.4":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "extra-high", name: "Extra High" },
            ],
          },
          {
            id: "context",
            name: "Context",
            category: "model_config",
            type: "select",
            currentValue: currentContext,
            options: [
              { value: "272k", name: "272K" },
              { value: "1m", name: "1M" },
            ],
          },
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "composer-2":
        return [
          ...baseOptions,
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "claude-opus-4-6":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ];
      default:
        return baseOptions;
    }
  }

  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

const availableModes: Array<AcpSchema.SessionMode> = [
  {
    id: "ask",
    name: "Ask",
    description: "Request permission before making any changes",
  },
  {
    id: "architect",
    name: "Architect",
    description: "Design and plan software systems without implementation",
  },
  {
    id: "code",
    name: "Code",
    description: "Write and modify code with full tool access",
  },
];

function modeState(): AcpSchema.SessionModeState {
  return {
    currentModeId,
    availableModes,
  };
}

function runEffect<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect);
}

function makeClient(context: OfficialAcp.AgentContext) {
  return {
    sessionUpdate: (notification: AcpSchema.SessionNotification) =>
      Effect.promise(() => context.notify(OfficialAcp.methods.client.session.update, notification)),
    requestPermission: (request: AcpSchema.RequestPermissionRequest) =>
      Effect.promise(() =>
        context.request(OfficialAcp.methods.client.session.requestPermission, request),
      ),
    extRequest: (method: string, params: unknown) =>
      Effect.promise(() => context.request(method, params)),
  };
}

function requestInput(): ReadableStream<Uint8Array> {
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  if (!requestLogPath) return input;

  const decoder = new TextDecoder();
  let pending = "";
  const logLines = (chunk: Uint8Array, final: boolean) => {
    pending += decoder.decode(chunk, { stream: !final });
    const lines = pending.split("\n");
    pending = final ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.length > 0) appendFileSync(requestLogPath, `${line}\n`, "utf8");
    }
    if (final && pending.length > 0) appendFileSync(requestLogPath, `${pending}\n`, "utf8");
  };

  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        logLines(chunk, false);
        controller.enqueue(chunk);
      },
      flush() {
        logLines(new Uint8Array(), true);
      },
    }),
  );
}

const app = OfficialAcp.agent({ name: "synara-acp-mock" });

app.onRequest(OfficialAcp.methods.agent.initialize, ({ params: request }) =>
  runEffect(
    Effect.sync(() => {
      parameterizedModelPicker =
        request.clientCapabilities?._meta !== null &&
        request.clientCapabilities?._meta !== undefined &&
        "parameterizedModelPicker" in request.clientCapabilities._meta;
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: supportsSessionLoad,
          sessionCapabilities: {
            ...(supportsSessionResume ? { resume: {} } : {}),
            ...(supportsSessionFork ? { fork: {} } : {}),
          },
        },
      };
    }),
  ),
);

app.onRequest(OfficialAcp.methods.agent.authenticate, () => ({}));

app.onRequest(OfficialAcp.methods.agent.session.new, ({ client: context }) => {
  sessionNewAttempts += 1;
  if (failSessionNewOnce && sessionNewAttempts === 1) {
    throw new OfficialAcp.RequestError(-32603, "Path not found.", {
      code: "FS_NOT_FOUND",
      detail: "No such file or directory (os error 2)",
    });
  }
  const client = makeClient(context);
  return runEffect(
    Effect.gen(function* () {
      if (emitAvailableCommands) {
        yield* client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "compact", description: "Compact the current context" }],
          },
        });
      }
      return {
        sessionId,
        modes: modeState(),
        configOptions: configOptions(),
      };
    }),
  );
});

app.onRequest(OfficialAcp.methods.agent.session.load, ({ client: context, params: request }) => {
  const client = makeClient(context);
  return runEffect(
    client
      .sessionUpdate({
        sessionId: String(request.sessionId ?? sessionId),
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "replay" },
        },
      })
      .pipe(
        Effect.as({
          modes: modeState(),
          configOptions: configOptions(),
        }),
      ),
  );
});

app.onRequest(OfficialAcp.methods.agent.session.resume, () => ({
  modes: modeState(),
  configOptions: configOptions(),
}));

app.onRequest(OfficialAcp.methods.agent.session.fork, () => ({
  sessionId: "mock-session-fork-1",
  modes: modeState(),
  configOptions: configOptions(),
}));

app.onRequest(OfficialAcp.methods.agent.session.setConfigOption, ({ params: request }) => {
  if (failSetConfigOption) {
    throw OfficialAcp.RequestError.invalidParams(
      {
        method: "session/set_config_option",
        params: request,
      },
      "Mock invalid params for session/set_config_option",
    );
  }
  return runEffect(
    Effect.gen(function* () {
      if (exitOnSetConfigOption) {
        return yield* Effect.sync(() => {
          process.exit(7);
        });
      }
      if (request.configId === modeConfigId && typeof request.value === "string") {
        currentModeId = request.value;
      }
      if (request.configId === "model" && typeof request.value === "string") {
        currentModelId = request.value;
      }
      if (request.configId === "reasoning" && typeof request.value === "string") {
        currentReasoning = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        currentContext = request.value;
      }
      if (request.configId === "fast") {
        currentFast = request.value === true || request.value === "true";
      }
      return {
        configOptions: configOptions(),
      };
    }),
  );
});

app.onNotification(OfficialAcp.methods.agent.session.cancel, ({ params: { sessionId } }) => {
  cancelledSessions.add(String(sessionId ?? "mock-session-1"));
});

app.onRequest(OfficialAcp.methods.agent.session.prompt, ({ client: context, params: request }) => {
  const client = makeClient(context);
  return runEffect(
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);

      if (emitInterleavedAssistantToolCalls) {
        const toolCallId = "tool-call-1";

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "hello"],
            },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: "hello",
              stderr: "",
            },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "after tool" },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitUpstreamAssistantMessageIds) {
        const toolCallId = "tool-call-upstream-message-id-1";

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "upstream-answer",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "hello"],
            },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: "hello",
              stderr: "",
            },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "upstream-answer",
            content: { type: "text", text: " after tool" },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "upstream-followup",
            content: { type: "text", text: "separate answer" },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitReasoningThenToolCall) {
        const toolCallId = "tool-call-reasoning-1";

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking before tool" },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "hello"],
            },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: "hello",
              stderr: "",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitToolCalls) {
        const toolCallId = "tool-call-1";

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["cat", "server/package.json"],
            },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        const permission = yield* client.requestPermission({
          sessionId: requestedSessionId,
          toolCall: {
            toolCallId,
            title: "`cat server/package.json`",
            kind: "execute",
            status: "pending",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Not in allowlist: cat server/package.json",
                },
              },
            ],
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });

        const cancelled =
          cancelledSessions.delete(requestedSessionId) ||
          permission.outcome.outcome === "cancelled";

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: '{ "name": "synara" }',
              stderr: "",
            },
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from mock" },
          },
        });

        return { stopReason: cancelled ? "cancelled" : "end_turn" };
      }

      if (emitGenericToolPlaceholders) {
        const toolCallId = "tool-call-generic-1";

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        yield* client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              content: "package.json\n",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitAskQuestion) {
        yield* client.extRequest("cursor/ask_question", {
          toolCallId: "ask-question-tool-call-1",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [
                { id: "workspace", label: "Workspace" },
                { id: "session", label: "Session" },
              ],
            },
          ],
        });

        return { stopReason: "end_turn" };
      }

      yield* client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Inspect mock ACP state",
              priority: "high",
              status: "completed",
            },
            {
              content: "Implement the requested change",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      });

      yield* client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: promptResponseText ?? "hello from mock" },
        },
      });

      return { stopReason: "end_turn" };
    }),
  );
});

app.onRequest(
  "session/mode/set",
  { parse: (params: unknown) => params },
  ({ client: context, params }) => {
    const nextModeId =
      typeof params === "object" &&
      params !== null &&
      "modeId" in params &&
      typeof params.modeId === "string"
        ? params.modeId
        : typeof params === "object" &&
            params !== null &&
            "mode" in params &&
            typeof params.mode === "string"
          ? params.mode
          : undefined;
    const requestedSessionId =
      typeof params === "object" &&
      params !== null &&
      "sessionId" in params &&
      typeof params.sessionId === "string"
        ? params.sessionId
        : sessionId;

    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      return runEffect(
        makeClient(context)
          .sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId,
            },
          })
          .pipe(Effect.as({})),
      );
    }

    return {};
  },
);

const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const connection = app.connect(OfficialAcp.ndJsonStream(output, requestInput()));
await connection.closed;
