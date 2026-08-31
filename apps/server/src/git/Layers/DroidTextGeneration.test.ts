import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Duration, Effect, Fiber, Layer, Queue, Ref, Schema, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import { TextGenerationError } from "../Errors.ts";
import { DroidTextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import { DroidTextGenerationServiceLive } from "./DroidTextGeneration.ts";

type CapturedCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

type RequestRecord = {
  readonly method: string;
  readonly params: unknown;
};

const JsonRpcRequestSchema = Schema.Struct({
  id: Schema.optional(Schema.Number),
  method: Schema.String,
  params: Schema.Unknown,
});

type JsonRpcRequest = Schema.Schema.Type<typeof JsonRpcRequestSchema>;

const SetConfigOptionRequestSchema = Schema.Struct({
  sessionId: Schema.String,
  configId: Schema.String,
  value: Schema.String,
});

type OutgoingMessage =
  | { readonly jsonrpc: "2.0"; readonly id?: number | undefined; readonly result?: unknown }
  | { readonly jsonrpc: "2.0"; readonly id?: number | undefined; readonly error?: unknown }
  | { readonly method: string; readonly params: unknown };

function failingSpawnerLayer(state: { commands: Array<CapturedCommand> } = { commands: [] }) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "test droid binary not found",
          }),
        );
      }
      state.commands.push({ command: command.command, args: [...command.args] });
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "test droid binary not found",
        }),
      );
    }),
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function droidAgentSpawnerLayer(config: {
  readonly responseText: string;
  readonly stopReason?: "end_turn" | "cancelled";
  readonly hangAtPrompt?: boolean;
  readonly commands?: Array<CapturedCommand>;
  readonly requests?: Array<RequestRecord>;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "test droid agent can only spawn standard commands",
          }),
        );
      }
      config.commands?.push({ command: command.command, args: [...command.args] });
      return Effect.succeed(makeDroidAgentHandle(config));
    }),
  );
}

function makeDroidAgentHandle(config: {
  readonly responseText: string;
  readonly stopReason?: "end_turn" | "cancelled";
  readonly hangAtPrompt?: boolean;
  readonly requests?: Array<RequestRecord>;
}) {
  const stdoutQueue = Effect.runSync(Queue.unbounded<Uint8Array>());
  const bufferRef = Effect.runSync(Ref.make(""));

  const sessionId = "mock-session-1";
  const state = {
    currentMode: "normal",
    currentModel: "default",
    currentReasoning: "medium",
  };

  const availableModes = [
    { id: "normal", name: "Normal" },
    { id: "spec", name: "Spec" },
  ];

  const modeOptions = [
    { value: "normal", name: "Normal" },
    { value: "spec", name: "Spec" },
  ];

  const getConfigOptions = () =>
    [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select" as const,
        currentValue: state.currentMode,
        options: [...modeOptions],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select" as const,
        currentValue: state.currentModel,
        options: [
          { value: "default", name: "Auto" },
          { value: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning",
        category: "thought_level",
        type: "select" as const,
        currentValue: state.currentReasoning,
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
      {
        id: "autonomy_level",
        name: "Autonomy",
        category: "autonomy",
        type: "select" as const,
        currentValue: "normal",
        options: [{ value: "normal", name: "Normal" }],
      },
    ] satisfies Array<unknown>;

  const send = (message: OutgoingMessage) =>
    Queue.offer(stdoutQueue, encoder.encode(`${JSON.stringify(message)}\n`));

  const handleMessage = (
    message: JsonRpcRequest,
  ): Effect.Effect<OutgoingMessage | undefined, never, never> =>
    Effect.gen(function* () {
      config.requests?.push({ method: message.method, params: message.params });

      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0" as const,
          id: message.id,
          result: {
            protocolVersion: 1,
            authMethods: [{ id: "device-pairing", name: "Device Pairing" }],
            agentCapabilities: { sessionCapabilities: {} },
          },
        };
      }

      if (message.method === "authenticate") {
        return { jsonrpc: "2.0" as const, id: message.id, result: {} };
      }

      if (message.method === "session/new") {
        return {
          jsonrpc: "2.0" as const,
          id: message.id,
          result: {
            sessionId,
            modes: { currentModeId: state.currentMode, availableModes },
            configOptions: getConfigOptions(),
          },
        };
      }

      if (message.method === "session/set_config_option") {
        const request = yield* Schema.decodeUnknownEffect(SetConfigOptionRequestSchema)(
          message.params,
        ).pipe(Effect.orDie);
        if (request.configId === "mode") {
          state.currentMode = request.value;
        }
        if (request.configId === "model") {
          state.currentModel = request.value;
        }
        if (request.configId === "reasoning_effort") {
          state.currentReasoning = request.value;
        }
        return {
          jsonrpc: "2.0" as const,
          id: message.id,
          result: { configOptions: getConfigOptions() },
        };
      }

      if (message.method === "session/prompt") {
        if (config.hangAtPrompt) {
          return undefined;
        }
        if (config.responseText.length > 0) {
          yield* send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: config.responseText },
              },
            },
          });
        }
        return {
          jsonrpc: "2.0" as const,
          id: message.id,
          result: { stopReason: config.stopReason ?? "end_turn" },
        };
      }

      // session/cancel is a notification; no response needed.
      return undefined;
    });

  const stdin: Sink.Sink<void, Uint8Array, never, never, never> = Sink.forEach((chunk) =>
    Effect.gen(function* () {
      const text = decoder.decode(chunk, { stream: true });
      const previous = yield* Ref.get(bufferRef);
      const combined = previous + text;
      const lines = combined.split("\n");
      const remainder = lines.pop() ?? "";
      yield* Ref.set(bufferRef, remainder);

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const message = yield* Schema.decodeUnknownEffect(JsonRpcRequestSchema)(
          JSON.parse(trimmed),
        ).pipe(Effect.orDie);
        const response = yield* handleMessage(message);
        if (response !== undefined) {
          yield* send(response);
        }
      }
    }),
  );

  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(999_999),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    stdin,
    stdout: Stream.fromQueue(stdoutQueue),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const makeTestLayer = (spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  Layer.merge(DroidTextGenerationServiceLive.pipe(Layer.provide(spawner)), TestClock.layer());

describe("DroidTextGenerationServiceLive", () => {
  it("rejects a non-droid model selection before spawning", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const droid = yield* DroidTextGeneration;
        return yield* droid
          .generateCommitMessage({
            cwd: "/repo",
            branch: "main",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: { provider: "cursor", model: "composer-2" },
          })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(DroidTextGenerationServiceLive),
        Effect.provide(failingSpawnerLayer()),
      ),
    );

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("Invalid Droid model selection.");
  });

  it("spawns the configured droid binary with ACP exec args", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-spawn-"));
    const customBinaryPath = path.join(tempDir, "droid");
    fs.writeFileSync(customBinaryPath, "", "utf8");

    const commands: Array<CapturedCommand> = [];

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const droid = yield* DroidTextGeneration;
          return yield* droid
            .generateCommitMessage({
              cwd: "/repo",
              branch: "feature/droid",
              stagedSummary: "M apps/server/src/git/Layers/DroidTextGeneration.ts",
              stagedPatch:
                "diff --git a/apps/server/src/git/Layers/DroidTextGeneration.ts b/apps/server/src/git/Layers/DroidTextGeneration.ts",
              modelSelection: {
                provider: "droid",
                model: "claude-opus-4-8",
                options: { reasoningEffort: "high" },
              },
              providerOptions: {
                droid: { binaryPath: customBinaryPath },
              },
            })
            .pipe(Effect.flip);
        }).pipe(
          Effect.provide(DroidTextGenerationServiceLive),
          Effect.provide(failingSpawnerLayer({ commands })),
        ),
      );

      expect(result).toBeInstanceOf(TextGenerationError);
      expect(result.detail).toBe("Droid Agent ACP text generation failed.");
      expect(commands).toEqual([
        { command: customBinaryPath, args: ["exec", "--output-format", "acp"] },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves the default droid model to deepseek-v4-flash-0731", async () => {
    const commands: Array<CapturedCommand> = [];
    const requests: Array<RequestRecord> = [];
    const spawner = droidAgentSpawnerLayer({
      responseText: `{"summary":"droid summary"}`,
      commands,
      requests,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const droid = yield* DroidTextGeneration;
        const result = yield* droid.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
        });
        expect(result.summary).toBe("droid summary");
      }).pipe(Effect.provide(makeTestLayer(spawner))),
    );

    const setModel = requests.find((r) => r.method === "session/set_config_option");
    expect(setModel).toBeDefined();
    const setModelParams = Schema.decodeUnknownSync(SetConfigOptionRequestSchema)(setModel!.params);
    expect(setModelParams.value).toBe("deepseek-v4-flash-0731");
  });

  it("resolves a droid model alias to deepseek-v4-flash-0731", async () => {
    const commands: Array<CapturedCommand> = [];
    const requests: Array<RequestRecord> = [];
    const spawner = droidAgentSpawnerLayer({
      responseText: `{"summary":"droid summary"}`,
      commands,
      requests,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const droid = yield* DroidTextGeneration;
        const result = yield* droid.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
          model: "flash",
        });
        expect(result.summary).toBe("droid summary");
      }).pipe(Effect.provide(makeTestLayer(spawner))),
    );

    const setModel = requests.find((r) => r.method === "session/set_config_option");
    expect(setModel).toBeDefined();
    const setModelParams = Schema.decodeUnknownSync(SetConfigOptionRequestSchema)(setModel!.params);
    expect(setModelParams.value).toBe("deepseek-v4-flash-0731");
  });

  it("returns an error when the droid agent returns an empty response", async () => {
    const spawner = droidAgentSpawnerLayer({ responseText: "" });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const droid = yield* DroidTextGeneration;
        return yield* droid
          .generateDiffSummary({
            cwd: "/repo",
            patch: "diff --git a/file.ts b/file.ts",
            modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeTestLayer(spawner))),
    );

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("Droid Agent returned empty output.");
  });

  it("returns an error when the droid agent cancels the request", async () => {
    const spawner = droidAgentSpawnerLayer({
      responseText: "",
      stopReason: "cancelled",
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const droid = yield* DroidTextGeneration;
        return yield* droid
          .generateDiffSummary({
            cwd: "/repo",
            patch: "diff --git a/file.ts b/file.ts",
            modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeTestLayer(spawner))),
    );

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("Droid Agent ACP request was cancelled.");
  });

  it("times out when the droid agent never responds to the prompt", async () => {
    const requests: Array<RequestRecord> = [];
    const spawner = droidAgentSpawnerLayer({
      responseText: `{"summary":"droid summary"}`,
      hangAtPrompt: true,
      requests,
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const droid = yield* DroidTextGeneration;
          const fiber = yield* droid
            .generateDiffSummary({
              cwd: "/repo",
              patch: "diff --git a/file.ts b/file.ts",
              modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
            })
            .pipe(Effect.forkDetach);

          // Allow the forked ACP startup to complete (initialize/authenticate/session)
          // before advancing the test clock. Once the prompt request is sent, advance
          // the clock past the 180 second prompt timeout.
          for (let i = 0; i < 50; i++) {
            if (requests.some((request) => request.method === "session/prompt")) {
              break;
            }
            yield* Effect.yieldNow;
          }
          yield* TestClock.adjust(Duration.millis(180_000 + 1));
          return yield* Fiber.join(fiber).pipe(Effect.flip);
        }),
      ).pipe(Effect.provide(makeTestLayer(spawner))),
    );

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("Droid Agent request timed out.");
  });

  it("fails when the droid agent output exceeds the maximum size", async () => {
    const oversizedResponse = "{" + "x".repeat(256_001) + "}";
    const spawner = droidAgentSpawnerLayer({ responseText: oversizedResponse });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const droid = yield* DroidTextGeneration;
        return yield* droid
          .generateDiffSummary({
            cwd: "/repo",
            patch: "diff --git a/file.ts b/file.ts",
            modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeTestLayer(spawner))),
    );

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("Droid Agent output exceeded maximum size.");
  });

  it.each([
    [
      "generateCommitMessage",
      (droid: TextGenerationShape) =>
        droid.generateCommitMessage({
          cwd: "/repo",
          branch: "main",
          stagedSummary: "M file.ts",
          stagedPatch: "diff --git a/file.ts b/file.ts",
          modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
        }),
      `{"subject":"Add droid support","body":"- Add droid text generation."}`,
      { subject: "Add droid support", body: "- Add droid text generation." },
    ],
    [
      "generateCommitMessage with branch",
      (droid: TextGenerationShape) =>
        droid.generateCommitMessage({
          cwd: "/repo",
          branch: "main",
          stagedSummary: "M file.ts",
          stagedPatch: "diff --git a/file.ts b/file.ts",
          includeBranch: true,
          modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
        }),
      `{"subject":"Add droid support","body":"- Add droid text generation.","branch":"droid"}`,
      {
        subject: "Add droid support",
        body: "- Add droid text generation.",
        branch: "feature/droid",
      },
    ],
    [
      "generatePrContent",
      (droid: TextGenerationShape) =>
        droid.generatePrContent({
          cwd: "/repo",
          baseBranch: "main",
          headBranch: "feature/droid",
          commitSummary: "Add droid text generation.",
          diffSummary: "Adds droid ACP support.",
          diffPatch: "diff --git a/file.ts b/file.ts",
          modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
        }),
      `{"title":"Add droid text generation","body":"This PR adds droid ACP text generation."}`,
      { title: "Add droid text generation", body: "This PR adds droid ACP text generation." },
    ],
    [
      "generateDiffSummary",
      (droid: TextGenerationShape) =>
        droid.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
          modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
        }),
      `{"summary":"Adds a droid ACP text generation layer."}`,
      { summary: "Adds a droid ACP text generation layer." },
    ],
    [
      "generateBranchName",
      (droid: TextGenerationShape) =>
        droid.generateBranchName({
          cwd: "/repo",
          message: "Add droid ACP text generation",
          modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
        }),
      `{"branch":"droid-acp"}`,
      { branch: "droid-acp" },
    ],
    [
      "generateThreadTitle",
      (droid: TextGenerationShape) =>
        droid.generateThreadTitle({
          cwd: "/repo",
          message: "Help with droid text generation",
          modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
        }),
      `{"title":"Droid text generation help"}`,
      { title: "Droid text generation help" },
    ],
    [
      "generateThreadRecap",
      (droid: TextGenerationShape) =>
        droid.generateThreadRecap({
          cwd: "/repo",
          previousRecap: "",
          newMaterial: "We added droid ACP support.",
          currentState: "In progress",
          modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
        }),
      `{"recap":"We added droid ACP support."}`,
      { recap: "We added droid ACP support." },
    ],
    [
      "generateAutomationIntent",
      (droid: TextGenerationShape) =>
        droid.generateAutomationIntent({
          cwd: "/repo",
          message: "every hour check the site",
          nowIso: "2025-01-01T00:00:00Z",
          modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
        }),
      JSON.stringify({
        isAutomation: true,
        confidence: 0.9,
        language: null,
        name: "Hourly site check",
        taskPrompt: "Check the site every hour.",
        schedule: null,
        mode: "heartbeat",
        maxIterations: null,
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      }),
      {
        isAutomation: true,
        confidence: 0.9,
        language: null,
        name: "Hourly site check",
        taskPrompt: "Check the site every hour.",
        schedule: null,
        mode: "heartbeat",
        maxIterations: null,
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      },
    ],
    [
      "evaluateAutomationCompletion",
      (droid: TextGenerationShape) =>
        droid.evaluateAutomationCompletion({
          cwd: "/repo",
          automationName: "Hourly site check",
          automationPrompt: "Check the site every hour.",
          stopWhen: "the site is down",
          runUserMessage: "Check the site.",
          runAssistantText: "The site is up.",
          modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
        }),
      `{"stopMatched":false,"confidence":0.5,"reason":"The site is up."}`,
      { stopMatched: false, confidence: 0.5, reason: "The site is up." },
    ],
  ] as const)("%s succeeds through the droid ACP runtime", async (...row) => {
    const [, makeCall, responseText, expected] = row;
    const spawner = droidAgentSpawnerLayer({ responseText });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const droid = yield* DroidTextGeneration;
        return yield* makeCall(droid);
      }).pipe(Effect.provide(makeTestLayer(spawner))),
    );

    expect(result).toEqual(expected);
  });
});
