import { ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Agent,
  OpencodeClient,
  Part,
  PermissionRequest,
  Provider,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { describe, it, expect, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  type OpenCodeCliModelDescriptor,
  OpenCodeRuntimeError,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { KiloAdapter } from "../Services/KiloAdapter.ts";
import {
  makeOpenCodeAdapterLive,
  makeKiloAdapterLive,
  normalizeOpenCodeTokenUsage,
} from "./OpenCodeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const OPEN_CODE_PLAN_PERMISSION_RULES = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "list", pattern: "*", action: "allow" },
  { permission: "lsp", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "websearch", pattern: "*", action: "allow" },
  { permission: "codesearch", pattern: "*", action: "allow" },
  { permission: "todoread", pattern: "*", action: "allow" },
  { permission: "todowrite", pattern: "*", action: "allow" },
  { permission: "question", pattern: "*", action: "allow" },
] as const;

function createMockOpenCodeRuntime(options?: {
  readonly inventory?: OpenCodeInventory;
  readonly inventoryError?: OpenCodeRuntimeError;
  readonly connectError?: OpenCodeRuntimeError;
  readonly cliModelsError?: OpenCodeRuntimeError;
  readonly cliModels?: ReadonlyArray<OpenCodeCliModelDescriptor>;
  readonly events?: AsyncIterable<unknown>;
  readonly eventSubscriptions?: ReadonlyArray<AsyncIterable<unknown>>;
  readonly prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly promptAsync?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly commandList?: () => Promise<{
    data?: ReadonlyArray<{ name: string; description?: string }>;
  }>;
  readonly commandLists?: ReadonlyArray<ReadonlyArray<{ name: string; description?: string }>>;
  readonly messages?: () => Promise<{
    data: Array<{ info: Record<string, unknown>; parts: Part[] }>;
  }>;
  readonly session?: Record<string, unknown>;
  readonly childrenBySessionId?: Readonly<Record<string, ReadonlyArray<{ id: string }>>>;
  readonly children?: (input: { sessionID: string }) => Promise<unknown>;
  readonly pendingPermissions?: ReadonlyArray<PermissionRequest>;
  readonly permissionList?: () => Promise<unknown>;
  readonly pendingQuestions?: ReadonlyArray<QuestionRequest>;
  readonly questionList?: () => Promise<unknown>;
  readonly permissionReply?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly mcpAdd?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly serverExit?: Effect.Effect<number>;
  readonly sessionCreateError?: Error;
  readonly sessionUpdate?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly scopeCloseDefect?: boolean;
  readonly connectBarrier?: Effect.Effect<void>;
  readonly onScopeClose?: () => void;
}) {
  const abortCalls: Array<{ sessionID: string }> = [];
  const cliModelCalls: Array<Parameters<OpenCodeRuntimeShape["listOpenCodeCliModels"]>[0]> = [];
  const connectCalls: Array<Parameters<OpenCodeRuntimeShape["connectToOpenCodeServer"]>[0]> = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];
  const forkCalls: Array<{ sessionID: string }> = [];
  const permissionReplyCalls: Array<Record<string, unknown>> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  const mcpAddCalls: Array<Record<string, unknown>> = [];
  let eventSubscribeCallCount = 0;
  const emptySubscription = {
    async *[Symbol.asyncIterator]() {
      // No provider-side events needed for these adapter lifecycle tests.
    },
  };
  const client = {
    event: {
      subscribe: async () => {
        const subscriptionIndex = eventSubscribeCallCount;
        eventSubscribeCallCount += 1;
        return {
          stream:
            options?.eventSubscriptions?.[subscriptionIndex] ??
            options?.events ??
            emptySubscription,
        };
      },
    },
    session: {
      create: async (input: Record<string, unknown>) => {
        createCalls.push(input);
        if (options?.sessionCreateError) throw options.sessionCreateError;
        return { data: { id: "opencode-session-1" } };
      },
      update: async (input: Record<string, unknown>) => {
        updateCalls.push(input);
        return options?.sessionUpdate ? options.sessionUpdate(input) : { data: null };
      },
      promptAsync: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        if (options?.promptAsync) {
          return options.promptAsync(promptInput);
        }
        return { data: null };
      },
      prompt: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        if (options?.prompt) {
          return options.prompt(promptInput);
        }
        return { data: null };
      },
      abort: async (input: { sessionID: string }) => {
        abortCalls.push(input);
        return { data: null };
      },
      messages: options?.messages ?? (async () => ({ data: [] })),
      children: async (input: { sessionID: string }) =>
        options?.children
          ? options.children(input)
          : { data: options?.childrenBySessionId?.[input.sessionID] ?? [] },
      get: async () => ({ data: { directory: process.cwd(), ...(options?.session ?? {}) } }),
      revert: async () => ({ data: null }),
      summarize: async () => ({ data: null }),
      fork: async (input: { sessionID: string }) => {
        forkCalls.push(input);
        return { data: { id: "forked-session-1" } };
      },
    },
    permission: {
      list: async () =>
        options?.permissionList
          ? options.permissionList()
          : { data: options?.pendingPermissions ?? [] },
      reply: async (input: Record<string, unknown>) => {
        permissionReplyCalls.push(input);
        return options?.permissionReply ? options.permissionReply(input) : { data: null };
      },
    },
    question: {
      list: async () =>
        options?.questionList ? options.questionList() : { data: options?.pendingQuestions ?? [] },
      reply: async () => ({ data: null }),
    },
    command: {
      list: options?.commandList ?? (async () => ({ data: [] })),
    },
    mcp: {
      add: async (input: Record<string, unknown>) => {
        mcpAddCalls.push(input);
        return options?.mcpAdd
          ? options.mcpAdd(input)
          : { data: { synara: { status: "connected" } } };
      },
    },
  };
  let createClientCallCount = 0;

  const unexpectedOperation = (operation: string) =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation,
        detail: `Unexpected runtime operation: ${operation}`,
      }),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = () => {
    const commandList = options?.commandLists?.[createClientCallCount];
    createClientCallCount += 1;
    if (!commandList) {
      return client as unknown as OpencodeClient;
    }
    return {
      ...client,
      command: {
        list: async () => ({ data: commandList }),
      },
    } as unknown as OpencodeClient;
  };

  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () => unexpectedOperation("startOpenCodeServerProcess"),
    connectToOpenCodeServer: (input) =>
      Effect.gen(function* () {
        connectCalls.push(input);
        if (options?.connectError) {
          return yield* options.connectError;
        }
        if (options?.scopeCloseDefect) {
          const scope = yield* Scope.Scope;
          yield* Scope.addFinalizer(scope, Effect.die(new Error("scope close defect")));
        }
        if (options?.onScopeClose) {
          const scope = yield* Scope.Scope;
          yield* Scope.addFinalizer(scope, Effect.sync(options.onScopeClose));
        }
        if (options?.connectBarrier) yield* options.connectBarrier;
        return {
          url: input.serverUrl ?? "http://127.0.0.1:4099",
          exitCode: options?.serverExit ?? null,
          external: Boolean(input.serverUrl),
        };
      }),
    runOpenCodeCommand: () => unexpectedOperation("runOpenCodeCommand"),
    createOpenCodeSdkClient,
    loadOpenCodeInventory: () =>
      options?.inventoryError
        ? Effect.fail(options.inventoryError)
        : Effect.succeed(
            options?.inventory ?? {
              providerList: { connected: [], all: [], default: {} },
              agents: [],
              consoleState: null,
            },
          ),
    listOpenCodeCliModels: (input) =>
      Effect.gen(function* () {
        cliModelCalls.push(input);
        if (options?.cliModelsError) {
          return yield* options.cliModelsError;
        }
        return options?.cliModels ?? [];
      }),
    loadOpenCodeCredentialProviderIDs: () => Effect.succeed([]),
  };

  return {
    abortCalls,
    cliModelCalls,
    connectCalls,
    createCalls,
    updateCalls,
    forkCalls,
    permissionReplyCalls,
    promptCalls,
    mcpAddCalls,
    get eventSubscribeCallCount() {
      return eventSubscribeCallCount;
    },
    runtime,
  };
}

function makeGatewayCredentials() {
  let nextToken = 0;
  const revoked: string[] = [];
  const ownerByToken = new Map<string, string>();
  const credentials: AgentGatewayCredentialsShape = {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    setListeningPort: () => undefined,
    issueSessionToken: (threadId) => {
      const token = `gateway-token-${String(++nextToken)}`;
      ownerByToken.set(token, threadId);
      return token;
    },
    verifySessionToken: (token) => ownerByToken.get(token) ?? null,
    verifySession: () => null,
    bindWriteAuthority: () => null,
    verifyWriteAuthority: () => false,
    revokeSessionToken: (token) => {
      revoked.push(token);
      ownerByToken.delete(token);
    },
    connectionForThread: (threadId) => {
      const token = credentials.issueSessionToken(threadId, "opencode");
      return { url: credentials.mcpEndpointUrl, bearerToken: token };
    },
    stdioProxy: { command: process.execPath, args: [] },
  };
  return { credentials, ownerByToken, revoked };
}

function createSubscribedEventQueue() {
  const pendingEvents: Array<unknown> = [];
  let waitingResolver: ((result: IteratorResult<unknown>) => void) | undefined;
  let closed = false;

  return {
    push(event: unknown) {
      if (closed) {
        return;
      }
      if (waitingResolver) {
        const resolve = waitingResolver;
        waitingResolver = undefined;
        resolve({ value: event, done: false });
        return;
      }
      pendingEvents.push(event);
    },
    close() {
      closed = true;
      if (waitingResolver) {
        const resolve = waitingResolver;
        waitingResolver = undefined;
        resolve({ value: undefined, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (pendingEvents.length > 0) {
              return {
                value: pendingEvents.shift(),
                done: false,
              };
            }
            if (closed) {
              return { value: undefined, done: true };
            }
            return await new Promise<IteratorResult<unknown>>((resolve) => {
              waitingResolver = resolve;
            });
          },
        };
      },
    },
  };
}

function makeInventoryWithContextLimit(input: {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly contextLimit?: number;
}): OpenCodeInventory {
  const providerId = input.providerId ?? "openai";
  const modelId = input.modelId ?? "gpt-5.4";
  return {
    providerList: {
      connected: [providerId],
      all: [
        {
          id: providerId,
          name: "OpenAI",
          source: "api",
          models: {
            [modelId]: {
              id: modelId,
              name: "GPT-5.4",
              limit: {
                context: input.contextLimit ?? 200_000,
                output: 8_192,
              },
            },
          },
        } as unknown as Provider,
      ],
      default: {},
    },
    agents: [],
    consoleState: null,
  };
}

function assistantMessageUpdated(input?: {
  readonly id?: string;
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: {
      readonly read: number;
      readonly write: number;
    };
  };
  readonly cost?: number;
}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "opencode-session-1",
      info: {
        id: input?.id ?? "assistant-message-usage",
        role: "assistant",
        tokens: input?.tokens ?? {
          input: 120,
          output: 80,
          reasoning: 30,
          cache: {
            read: 10,
            write: 5,
          },
        },
        cost: input?.cost ?? 0.1234,
      },
    },
  };
}

describe("normalizeOpenCodeTokenUsage", () => {
  it("converts OpenCode assistant tokens into a context usage snapshot", () => {
    expect(
      normalizeOpenCodeTokenUsage(
        {
          input: 100,
          output: 50,
          reasoning: 25,
          cache: {
            read: 10,
            write: 5,
          },
        },
        200_000,
      ),
    ).toEqual({
      usedTokens: 190,
      totalProcessedTokens: 190,
      maxTokens: 200_000,
      inputTokens: 100,
      cachedInputTokens: 15,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 190,
      lastInputTokens: 100,
      lastCachedInputTokens: 15,
      lastOutputTokens: 50,
      lastReasoningOutputTokens: 25,
    });
  });

  it("returns undefined for missing, malformed, negative, infinite, or all-zero usage", () => {
    const validBase = {
      input: 1,
      output: 1,
      reasoning: 1,
      cache: {
        read: 1,
        write: 1,
      },
    };

    expect(normalizeOpenCodeTokenUsage(undefined)).toBeUndefined();
    expect(normalizeOpenCodeTokenUsage({ ...validBase, input: -1 })).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({ ...validBase, output: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({ ...validBase, cache: { read: Number.NaN, write: 1 } }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({
        input: 1,
        output: 1,
        reasoning: 1,
      }),
    ).toBeUndefined();
  });

  it("clamps used tokens to the model context limit while preserving total processed tokens", () => {
    expect(
      normalizeOpenCodeTokenUsage(
        {
          input: 150,
          output: 75,
          reasoning: 50,
          cache: {
            read: 25,
            write: 25,
          },
        },
        200,
      ),
    ).toMatchObject({
      usedTokens: 200,
      totalProcessedTokens: 325,
      maxTokens: 200,
      lastUsedTokens: 200,
    });
  });
});

describe("OpenCodeAdapter runtime lifecycle", () => {
  it("lists OpenCode models from the CLI before falling back to server inventory", async () => {
    const runtime = createMockOpenCodeRuntime({
      cliModels: [
        {
          slug: "opencode/minimax-m2.5-free",
          providerID: "opencode",
          modelID: "minimax-m2.5-free",
          name: "MiniMax M2.5 Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode-go/kimi-k2.6",
          providerID: "opencode-go",
          modelID: "kimi-k2.6",
          name: "Kimi K2.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
      inventory: {
        providerList: {
          connected: ["openai"],
          default: {},
          all: [
            {
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: {
                "gpt-5": {
                  id: "gpt-5",
                  name: "GPT-5",
                },
              },
            } as unknown as Provider,
          ],
        },
        agents: [],
        consoleState: null,
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listModels = adapter.listModels;
        if (!listModels) {
          throw new Error("Expected OpenCode adapter to support runtime model listing.");
        }
        return yield* listModels({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/model-discovery-config",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toMatchObject({
      source: "opencode-cli",
      cached: false,
    });
    expect(result?.models.map((model) => model.slug)).toEqual([
      "openai/gpt-5",
      "opencode/minimax-m2.5-free",
      "opencode-go/kimi-k2.6",
    ]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/model-discovery-config" });
    expect(runtime.cliModelCalls).toHaveLength(1);
    expect(runtime.cliModelCalls[0]).toMatchObject({ cwd: "/repo/model-discovery-config" });
  });

  it("lists OpenCode CLI models when server inventory discovery fails", async () => {
    const runtime = createMockOpenCodeRuntime({
      connectError: new OpenCodeRuntimeError({
        operation: "connectToOpenCodeServer",
        detail: "OpenCode server failed to start.",
      }),
      cliModels: [
        {
          slug: "opencode/nemotron-3-ultra-free",
          providerID: "opencode",
          modelID: "nemotron-3-ultra-free",
          name: "Nemotron 3 Ultra Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listModels = adapter.listModels;
        if (!listModels) {
          throw new Error("Expected OpenCode adapter to support runtime model listing.");
        }
        return yield* listModels({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/server-startup-fails",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toMatchObject({
      source: "opencode-cli",
      cached: false,
    });
    expect(result?.models.map((model) => model.slug)).toEqual(["opencode/nemotron-3-ultra-free"]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/server-startup-fails" });
    expect(runtime.cliModelCalls).toHaveLength(1);
    expect(runtime.cliModelCalls[0]).toMatchObject({ cwd: "/repo/server-startup-fails" });
  });

  it("lists OpenCode agents from the active discovery cwd", async () => {
    const runtime = createMockOpenCodeRuntime({
      inventory: {
        providerList: {
          connected: [],
          default: {},
          all: [],
        },
        agents: [
          {
            name: "project-review",
            displayName: "Project Review",
            description: "Review code with the project-local agent",
            mode: "primary",
            hidden: false,
          } as unknown as Agent,
        ],
        consoleState: null,
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listAgents = adapter.listAgents;
        if (!listAgents) {
          throw new Error("Expected OpenCode adapter to support runtime agent listing.");
        }
        return yield* listAgents({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/agent-discovery-config",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toMatchObject({
      source: "opencode",
      cached: false,
      agents: [
        {
          name: "project-review",
          displayName: "Project Review",
          description: "Review code with the project-local agent",
        },
      ],
    });
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/agent-discovery-config" });
  });

  it("does not reuse an unrelated active OpenCode session for command discovery", async () => {
    const runtime = createMockOpenCodeRuntime({
      commandLists: [[{ name: "wrong-thread" }], [{ name: "review", description: "Review code" }]],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-active"),
          runtimeMode: "full-access",
        });

        return yield* listCommands({
          provider: "opencode",
          cwd: process.cwd(),
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toEqual({
      commands: [{ name: "review", description: "Review code" }],
      source: "opencode",
      cached: false,
    });
  });

  it("passes the session cwd to managed OpenCode server connections", async () => {
    const runtime = createMockOpenCodeRuntime();
    const cwd = process.cwd();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-managed-cwd"),
          runtimeMode: "full-access",
          cwd,
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd });
  });

  it("isolates same-cwd managed sessions, injects distinct gateway tokens, and revokes them", async () => {
    const runtime = createMockOpenCodeRuntime();
    const gateway = makeGatewayCredentials();
    const firstThread = asThreadId("thread-gateway-a");
    const secondThread = asThreadId("thread-gateway-b");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        for (const threadId of [firstThread, secondThread]) {
          yield* adapter.startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "full-access",
            cwd: "/same/repo",
          });
          yield* adapter.sendTurn({
            threadId,
            input: "coordinate work",
            attachments: [],
            modelSelection: { provider: "opencode", model: "openai/gpt-5" },
          });
        }
        yield* adapter.stopSession(firstThread);
        expect(gateway.ownerByToken.has("gateway-token-1")).toBe(false);
        expect(gateway.ownerByToken.get("gateway-token-2")).toBe(secondThread);
        yield* adapter.stopSession(secondThread);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.connectCalls).toHaveLength(2);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/same/repo" });
    expect(runtime.connectCalls[1]).toMatchObject({ cwd: "/same/repo" });
    expect(runtime.connectCalls[0]?.poolIsolationKey).toBeTruthy();
    expect(runtime.connectCalls[1]?.poolIsolationKey).toBeTruthy();
    expect(runtime.connectCalls[0]?.poolIsolationKey).not.toBe(
      runtime.connectCalls[1]?.poolIsolationKey,
    );
    expect(runtime.mcpAddCalls).toHaveLength(2);
    expect(runtime.mcpAddCalls.map((call) => call.config)).toEqual([
      expect.objectContaining({
        headers: { Authorization: "Bearer gateway-token-1" },
      }),
      expect.objectContaining({
        headers: { Authorization: "Bearer gateway-token-2" },
      }),
    ]);
    expect(runtime.promptCalls).toHaveLength(2);
    for (const prompt of runtime.promptCalls) {
      expect(JSON.stringify(prompt)).toContain("Use the synara_* tools");
    }
    expect(gateway.revoked).toEqual(["gateway-token-1", "gateway-token-2"]);
  });

  it("keeps shared external OpenCode servers identity-only and never installs a token", async () => {
    const runtime = createMockOpenCodeRuntime();
    const gateway = makeGatewayCredentials();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-external-gateway-disabled");
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          providerOptions: {
            opencode: { serverUrl: "http://127.0.0.1:9999" },
          },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "coordinate work",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5" },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.connectCalls[0]?.poolIsolationKey).toBeUndefined();
    expect(runtime.mcpAddCalls).toEqual([]);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(JSON.stringify(runtime.promptCalls[0])).toContain("Synara MCP control is unavailable");
  });

  it("keeps managed sessions identity-only and revokes credentials when MCP setup is not connected", async () => {
    const runtime = createMockOpenCodeRuntime({
      mcpAdd: async () => ({ data: { synara: { status: "failed", error: "offline" } } }),
    });
    const gateway = makeGatewayCredentials();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-gateway-setup-failed");
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "coordinate work",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5" },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(gateway.revoked).toEqual(["gateway-token-1"]);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(JSON.stringify(runtime.promptCalls[0])).toContain("Synara MCP control is unavailable");
  });

  it("applies the same isolated gateway lifecycle to managed Kilo sessions", async () => {
    const runtime = createMockOpenCodeRuntime();
    const gateway = makeGatewayCredentials();
    const threadId = asThreadId("thread-kilo-gateway");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* KiloAdapter;
        yield* adapter.startSession({
          provider: "kilo",
          threadId,
          runtimeMode: "full-access",
          cwd: "/repo",
        });
        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.provide(
          makeKiloAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.connectCalls[0]?.poolIsolationKey).toBeTruthy();
    expect(runtime.mcpAddCalls[0]?.config).toMatchObject({
      headers: { Authorization: "Bearer gateway-token-1" },
    });
    expect(gateway.revoked).toEqual(["gateway-token-1"]);
  });

  it("revokes a managed gateway lease exactly once when the server exits unexpectedly", async () => {
    const serverExit = Deferred.makeUnsafe<number>();
    const runtime = createMockOpenCodeRuntime({ serverExit: Deferred.await(serverExit) });
    const gateway = makeGatewayCredentials();
    const threadId = asThreadId("thread-gateway-unexpected-exit");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });
        expect(gateway.ownerByToken.get("gateway-token-1")).toBe(threadId);

        Deferred.doneUnsafe(serverExit, Effect.succeed(17));
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(gateway.ownerByToken.has("gateway-token-1")).toBe(false)),
        );
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(gateway.revoked).toEqual(["gateway-token-1"]);
  });

  it("revokes a managed gateway lease even when failed-start scope cleanup defects", async () => {
    const runtime = createMockOpenCodeRuntime({
      sessionCreateError: new Error("session create failed"),
      scopeCloseDefect: true,
    });
    const gateway = makeGatewayCredentials();

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        return yield* Effect.exit(
          adapter.startSession({
            provider: "opencode",
            threadId: asThreadId("thread-gateway-failed-start"),
            runtimeMode: "full-access",
          }),
        );
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(gateway.revoked).toEqual(["gateway-token-1"]);
  });

  it("closes the private server scope and revokes its lease when startup is interrupted", async () => {
    const connectBarrier = Deferred.makeUnsafe<void>();
    let scopeCloseCount = 0;
    const runtime = createMockOpenCodeRuntime({
      connectBarrier: Deferred.await(connectBarrier),
      onScopeClose: () => {
        scopeCloseCount += 1;
      },
    });
    const gateway = makeGatewayCredentials();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const startFiber = yield* adapter
          .startSession({
            provider: "opencode",
            threadId: asThreadId("thread-gateway-interrupted-start"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => vi.waitFor(() => expect(runtime.connectCalls).toHaveLength(1)));

        yield* Fiber.interrupt(startFiber);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(scopeCloseCount).toBe(1);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(gateway.revoked).toEqual(["gateway-token-1"]);
  });

  it("retains startup ownership until a connected session is registered", async () => {
    const beforeInstallEntered = Deferred.makeUnsafe<void>();
    const installBarrier = Deferred.makeUnsafe<void>();
    let scopeCloseCount = 0;
    const runtime = createMockOpenCodeRuntime({
      onScopeClose: () => {
        scopeCloseCount += 1;
      },
    });
    const gateway = makeGatewayCredentials();
    const threadId = asThreadId("thread-gateway-interrupted-before-install");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const startFiber = yield* adapter
          .startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "full-access",
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(beforeInstallEntered);
        expect(gateway.ownerByToken.get("gateway-token-1")).toBe(threadId);
        expect(yield* adapter.hasSession(threadId)).toBe(false);

        yield* Fiber.interrupt(startFiber);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            beforeSessionInstall: Effect.sync(() =>
              Deferred.doneUnsafe(beforeInstallEntered, Effect.void),
            ).pipe(Effect.andThen(Deferred.await(installBarrier))),
          }).pipe(
            Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(scopeCloseCount).toBe(1);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(gateway.revoked).toEqual(["gateway-token-1"]);
  });

  it("uses the persisted resume cursor cwd when resuming OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        return yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-resume-cwd"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.createCalls).toEqual([]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/resume" });
    expect(result.cwd).toBe("/repo/resume");
    expect(result.resumeCursor).toMatchObject({
      openCodeSessionId: "existing-session-1",
      cwd: "/repo/resume",
    });
  });

  it("applies fail-closed resume permissions and restores Full Access for a new turn", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-resume-permissions");
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Implement the change",
          attachments: [],
          interactionMode: "default",
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.createCalls).toEqual([]);
    expect(runtime.updateCalls).toEqual([
      {
        sessionID: "existing-session-1",
        permission: OPEN_CODE_PLAN_PERMISSION_RULES,
      },
      {
        sessionID: "existing-session-1",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    ]);
  });

  it("fails closed and aborts when resume Plan permissions cannot be applied", async () => {
    const runtime = createMockOpenCodeRuntime({
      sessionUpdate: async () => {
        throw new Error("session.update unavailable during resume");
      },
    });

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          yield* adapter.startSession({
            provider: "opencode",
            threadId: asThreadId("thread-resume-plan-permission-failure"),
            runtimeMode: "full-access",
            resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
          });
        }).pipe(
          Effect.provide(
            makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ).rejects.toThrow("session.update unavailable during resume");

    expect(runtime.updateCalls).toEqual([
      { sessionID: "existing-session-1", permission: OPEN_CODE_PLAN_PERMISSION_RULES },
    ]);
    expect(runtime.abortCalls).toContainEqual({ sessionID: "existing-session-1" });
    expect(runtime.promptCalls).toEqual([]);
  });

  it("declines inactive OpenCode native fork when source and target cwd differ", async () => {
    const runtime = createMockOpenCodeRuntime();

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const forkThread = adapter.forkThread;
          if (!forkThread) {
            throw new Error("Expected OpenCode adapter to support native thread forking.");
          }
          return yield* forkThread({
            sourceThreadId: asThreadId("thread-source"),
            threadId: asThreadId("thread-target"),
            sourceResumeCursor: { openCodeSessionId: "source-session-1" },
            sourceCwd: "/repo/source",
            cwd: "/repo/target",
            runtimeMode: "full-access",
          });
        }).pipe(
          Effect.provide(
            makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ).rejects.toThrow("native fork cannot cross cwd boundaries");

    expect(runtime.forkCalls).toEqual([]);
    expect(runtime.connectCalls).toEqual([]);
  });

  it("defaults inactive OpenCode native forks to the source cwd", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const forkThread = adapter.forkThread;
        if (!forkThread) {
          throw new Error("Expected OpenCode adapter to support native thread forking.");
        }
        return yield* forkThread({
          sourceThreadId: asThreadId("thread-source"),
          threadId: asThreadId("thread-target"),
          sourceResumeCursor: { openCodeSessionId: "source-session-1" },
          sourceCwd: "/repo/source",
          runtimeMode: "full-access",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.forkCalls).toEqual([{ sessionID: "source-session-1" }]);
    expect(runtime.connectCalls).toHaveLength(2);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/source" });
    expect(runtime.connectCalls[1]).toMatchObject({ cwd: "/repo/source" });
    expect(result.resumeCursor).toMatchObject({
      openCodeSessionId: "forked-session-1",
      cwd: "/repo/source",
    });
  });

  it("reuses the matching active OpenCode thread for command discovery", async () => {
    const threadId = asThreadId("thread-command-discovery");
    const runtime = createMockOpenCodeRuntime({
      commandLists: [[{ name: "active-thread-command" }], [{ name: "scoped-client-command" }]],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });

        return yield* listCommands({
          provider: "opencode",
          threadId,
          cwd: process.cwd(),
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.commands.map((command) => command.name)).toEqual(["active-thread-command"]);
  });

  it("returns no OpenCode commands when command discovery is unsupported", async () => {
    const runtime = createMockOpenCodeRuntime({
      commandList: async () => {
        throw new Error("status=404 body={}");
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        return yield* listCommands({
          provider: "opencode",
          cwd: process.cwd(),
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toEqual({
      commands: [],
      source: "unsupported",
      cached: false,
    });
  });

  it("pins the initial model on new OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-model-pin"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "opencode",
            model: "opencode/big-pickle",
            options: {
              agent: "build",
              variant: "fast",
            },
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.createCalls[0]).toMatchObject({
      model: {
        providerID: "opencode",
        id: "big-pickle",
        variant: "fast",
      },
      agent: "build",
      title: "Synara thread-model-pin",
    });
  });

  it("clears adapter session state when interrupting an active OpenCode turn", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-1"),
          lifecycleGeneration: "generation-opencode-a",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-1"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
            options: {
              variant: "high",
            },
          },
        });

        const [runningSession] = yield* adapter.listSessions();

        yield* adapter.interruptTurn(asThreadId("thread-1"));

        const [readySession] = yield* adapter.listSessions();
        const events = Array.from(yield* Fiber.join(eventsFiber));

        return { events, readySession, runningSession };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls).toHaveLength(1);
    const firstPromptText = (
      runtime.promptCalls[0]?.parts as ReadonlyArray<{ readonly text?: string }> | undefined
    )?.[0]?.text;
    expect(firstPromptText).toContain(SYNARA_HARNESS_POLICY_MARKER);
    expect(firstPromptText).toContain("Synara MCP control is unavailable");
    expect(runtime.promptCalls[0]).toMatchObject({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
      variant: "high",
    });
    expect(runtime.abortCalls.length).toBeGreaterThanOrEqual(1);
    expect(runtime.abortCalls[0]).toEqual({ sessionID: "opencode-session-1" });
    expect(result.runningSession?.status).toBe("running");
    expect(result.runningSession?.activeTurnId).toBeDefined();
    expect(result.readySession).toMatchObject({
      provider: "opencode",
      status: "ready",
      model: "openai/gpt-5.4",
    });
    expect(result.readySession?.activeTurnId).toBeUndefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
    ]);
    expect(
      result.events.every((event) => event.lifecycleGeneration === "generation-opencode-a"),
    ).toBe(true);
    expect(result.events[3]).toMatchObject({
      type: "turn.aborted",
      payload: {
        reason: "Interrupted by user.",
      },
    });
  });

  it("replays assistant text when OpenCode sends delta before part snapshot and assistant role", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-ordered-events"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-ordered-events"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.part.delta",
          properties: {
            sessionID: "opencode-session-1",
            partID: "part-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-1",
              messageID: "assistant-message-1",
              type: "text",
              text: "",
              time: {
                start: 1,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-1",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-1",
              messageID: "assistant-message-1",
              type: "text",
              text: "Hello",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });
        eventQueue.push({
          type: "session.status",
          properties: {
            sessionID: "opencode-session-1",
            status: {
              type: "idle",
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();

        return { events, turn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.turn.turnId).toBeDefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Hello",
      },
    });
    expect(result.events[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "Hello",
      },
    });
  });

  it("filters Kilo synthetic and ignored text parts from assistant transcript", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-synthetic-kilo-parts"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-synthetic-kilo-parts"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-filtered",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-synthetic",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Initializing snapshot...",
              synthetic: true,
              time: {
                start: 1,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-ignored",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Internal warning",
              ignored: true,
              time: {
                start: 2,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-visible",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Actual answer",
              time: {
                start: 3,
                end: 4,
              },
            },
          },
        });
        eventQueue.push({
          type: "session.status",
          properties: {
            sessionID: "opencode-session-1",
            status: {
              type: "idle",
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Actual answer",
      },
    });
    expect(JSON.stringify(result)).not.toContain("Initializing snapshot");
    expect(JSON.stringify(result)).not.toContain("Internal warning");
  });

  it("sends plan-mode prompt instructions and captures tagged markdown as a proposed plan", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-plan-events"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-plan-events"),
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-plan",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-plan",
              messageID: "assistant-message-plan",
              type: "text",
              text: "<proposed_plan>\n# OpenCode plan\n\n- capture it\n</proposed_plan>",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]?.parts).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Synara plan mode is active."),
      },
    ]);
    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
    ]);
    expect(result[4]).toMatchObject({
      type: "turn.proposed.completed",
      payload: {
        planMarkdown: "# OpenCode plan\n\n- capture it",
      },
    });
  });

  it("pins default-mode turns to the OpenCode build agent", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-default-build-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-default-build-agent"),
          input: "implement this",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "build",
    });
  });

  it("projects generic file attachments into text instead of native OpenCode file parts", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-docx-attachment"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-docx-attachment"),
          input: "summarize this",
          interactionMode: "default",
          attachments: [
            {
              type: "file",
              id: "thread-docx-attachment-00000000-0000-4000-8000-000000000001",
              name: "minutes.docx",
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              sizeBytes: 4_096,
            },
          ],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const parts = runtime.promptCalls[0]?.parts as Array<Record<string, unknown>> | undefined;
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toMatchObject({ type: "text" });
    expect(parts?.[0]?.text).toEqual(expect.stringContaining("<attached_files>"));
    expect(parts?.[0]?.text).toEqual(expect.stringContaining('"minutes.docx"'));
    expect(parts?.[0]?.text).toEqual(
      expect.stringContaining(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    );
    expect(parts?.[0]?.text).toEqual(expect.stringContaining(".docx"));
  });

  it("pins plan-mode turns to the OpenCode plan agent", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-plan-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-plan-agent"),
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "plan",
    });
  });

  it("ignores a stale plan agent option when Synara interaction mode is default", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-stale-plan-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-stale-plan-agent"),
          input: "implement this",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
            options: {
              agent: "plan",
            },
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "build",
    });
  });

  it("preserves explicitly selected OpenCode agents", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-explicit-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-explicit-agent"),
          input: "use custom agent",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
            options: {
              agent: "reviewer",
            },
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "reviewer",
    });
  });

  it("does not capture tagged markdown as a proposed plan outside plan mode", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-default-tagged-plan"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-default-tagged-plan"),
          input: "show an example tagged block",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-default-plan",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-default-plan",
              messageID: "assistant-message-default-plan",
              type: "text",
              text: "<proposed_plan>\n# Not a Synara plan\n</proposed_plan>",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
    ]);
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "<proposed_plan>\n# Not a Synara plan\n</proposed_plan>",
      },
    });
  });

  it("emits context usage from OpenCode assistant message updates", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      inventory: makeInventoryWithContextLimit({ contextLimit: 200_000 }),
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-events"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-events"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantMessageUpdated());

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, turn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const usageEvent = result.events.find((event) => event.type === "thread.token-usage.updated");
    expect(usageEvent).toMatchObject({
      type: "thread.token-usage.updated",
      turnId: result.turn.turnId,
      payload: {
        usage: {
          usedTokens: 245,
          totalProcessedTokens: 245,
          inputTokens: 120,
          cachedInputTokens: 15,
          outputTokens: 80,
          reasoningOutputTokens: 30,
          maxTokens: 200_000,
          lastUsedTokens: 245,
          lastInputTokens: 120,
          lastCachedInputTokens: 15,
          lastOutputTokens: 80,
          lastReasoningOutputTokens: 30,
        },
      },
      raw: {
        source: "opencode.sdk.event",
      },
    });
  });

  it("does not emit duplicate usage for identical assistant message updates", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      inventory: makeInventoryWithContextLimit({ contextLimit: 200_000 }),
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-dedup"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-dedup"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantMessageUpdated());
        eventQueue.push(assistantMessageUpdated());

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.filter((event) => event.type === "thread.token-usage.updated")).toHaveLength(1);
  });

  it("emits usage without max tokens when the selected model limit is unknown", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-unknown-limit"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-unknown-limit"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantMessageUpdated());

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
    expect(usageEvent).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 245,
          totalProcessedTokens: 245,
        },
      },
    });
    expect(
      usageEvent?.type === "thread.token-usage.updated" && usageEvent.payload.usage,
    ).not.toHaveProperty("maxTokens");
  });

  it("ignores malformed and zero-token assistant usage updates", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-zero"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-zero"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(
          assistantMessageUpdated({
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          }),
        );
        eventQueue.push(
          assistantMessageUpdated({
            id: "assistant-message-malformed",
            tokens: {
              input: Number.NaN,
              output: 1,
              reasoning: 1,
              cache: {
                read: 1,
                write: 1,
              },
            },
          }),
        );
        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
    ]);
  });

  it("maps OpenCode todo updates into shared turn tasks", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-todo-updated"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-todo-updated"),
          input: "work through todos",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "todo.updated",
          properties: {
            sessionID: "opencode-session-1",
            todos: [
              { content: "Inspect OpenCode events", status: "completed", priority: "high" },
              { content: "Wire todo updates", status: "in_progress", priority: "medium" },
              { content: "Report back", status: "pending", priority: "low" },
            ],
          },
        });

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const taskEvent = events.find((event) => event.type === "turn.tasks.updated");
    expect(taskEvent?.type).toBe("turn.tasks.updated");
    if (taskEvent?.type === "turn.tasks.updated") {
      expect(taskEvent.payload.tasks).toEqual([
        { task: "Inspect OpenCode events", status: "completed" },
        { task: "Wire todo updates", status: "inProgress" },
        { task: "Report back", status: "pending" },
      ]);
    }
  });

  it("streams and completes turns from newer OpenCode session.next events", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-next-events"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-next-events"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0.025,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Hello",
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "Hello",
      },
    });
  });

  it("enforces Plan permissions under full access and restores them for the next turn", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-plan-permissions");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "Plan the change",
          attachments: [],
          interactionMode: "plan",
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId);
        yield* adapter.sendTurn({
          threadId,
          input: "Implement the change",
          attachments: [],
          interactionMode: "default",
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.updateCalls).toEqual([
      {
        sessionID: "opencode-session-1",
        permission: OPEN_CODE_PLAN_PERMISSION_RULES,
      },
      {
        sessionID: "opencode-session-1",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    ]);
  });

  it("auto-approves a child-session permission before task metadata arrives", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      childrenBySessionId: {
        "opencode-session-1": [{ id: "opencode-child-1" }],
      },
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-child-permission");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "Delegate a read-only check",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "permission.asked",
          properties: {
            id: "child-permission-1",
            sessionID: "opencode-child-1",
            permission: "external_directory",
            patterns: ["/tmp/**"],
            metadata: {},
            always: [],
          },
        });
        yield* Effect.sleep(20);
        eventQueue.close();
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.permissionReplyCalls).toContainEqual({
      requestID: "child-permission-1",
      reply: "once",
    });
  });

  it("rejects stale child permissions when resuming a full-access session", async () => {
    const runtime = createMockOpenCodeRuntime({
      childrenBySessionId: {
        "existing-session-1": [{ id: "existing-child-1" }],
      },
      pendingPermissions: [
        {
          id: "resumed-child-permission",
          sessionID: "existing-child-1",
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: [],
        },
      ],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-resumed-child-permission"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: process.cwd() },
        });
        yield* Effect.sleep(20);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.permissionReplyCalls).toContainEqual({
      requestID: "resumed-child-permission",
      reply: "reject",
    });
  });

  it("recovers root permissions when child or question discovery fails", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      events: eventQueue.stream,
      children: async () => {
        throw new Error("session.children unavailable");
      },
      pendingPermissions: [
        {
          id: "resumed-root-permission",
          sessionID: "existing-session-1",
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: [],
        },
      ],
      questionList: async () => {
        throw new Error("question.list unavailable");
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-partial-reconciliation"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: process.cwd() },
        });
        yield* Effect.sleep(20);
        eventQueue.close();
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.permissionReplyCalls).toContainEqual({
      requestID: "resumed-root-permission",
      reply: "reject",
    });
  });

  it("re-subscribes when the OpenCode event stream ends cleanly", async () => {
    const connectedQueue = createSubscribedEventQueue();
    const endedStream = {
      async *[Symbol.asyncIterator]() {
        return;
      },
    };
    const runtime = createMockOpenCodeRuntime({
      eventSubscriptions: [endedStream, connectedQueue.stream],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-event-reconnect"),
          runtimeMode: "full-access",
        });
        yield* Effect.sleep(300);
        connectedQueue.close();
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.eventSubscribeCallCount).toBeGreaterThanOrEqual(2);
  });

  it("fails a full-access turn instead of falling back to a visible approval", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      permissionReply: async () => {
        throw new Error("permission endpoint unavailable");
      },
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const eventTypes = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-full-access-reply-failure");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "Run a command",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "permission.asked",
          properties: {
            id: "permission-failure-1",
            sessionID: "opencode-session-1",
            permission: "bash",
            patterns: ["npm test"],
            metadata: {},
            always: [],
          },
        });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events.map((event) => event.type);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(eventTypes).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.completed",
    ]);
    expect(runtime.abortCalls).toContainEqual({ sessionID: "opencode-session-1" });
  });

  it("auto-approves OpenCode permission asks in full access without surfacing approvals", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-full-access-permission"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-full-access-permission"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "opencode-session-1",
            permission: "external_directory",
            patterns: ["/outside/project/**"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          id: "evt-permission-replied",
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "permission-1",
            reply: "once",
          },
        });
        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(runtime.permissionReplyCalls).toEqual([{ requestID: "permission-1", reply: "once" }]);
  });

  it("suppresses a permission.replied echo that arrives after turn teardown", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-late-permission-echo"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-late-permission-echo"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        // Auto-approved ask at the tail of the turn; the reply echo has not arrived yet
        // when the turn completes and active-turn state is torn down.
        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-late-1",
            sessionID: "opencode-session-1",
            permission: "external_directory",
            patterns: ["/outside/project/**"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });
        // Late echo after teardown: must be swallowed as the auto-approved reply, not
        // surfaced as a request.resolved for a request the UI never saw opened.
        eventQueue.push({
          id: "evt-late-permission-replied",
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "permission-late-1",
            reply: "once",
          },
        });
        // A queued question flushes the stream: the queue is FIFO, so its
        // user-input.requested must be the next event, proving the late echo emitted nothing.
        eventQueue.push({
          id: "evt-question-asked",
          type: "question.asked",
          properties: {
            id: "question-1",
            sessionID: "opencode-session-1",
            questions: [
              {
                question: "Proceed?",
                header: "Confirm",
                options: [{ label: "Yes", description: "" }],
                multiple: false,
                custom: false,
              },
            ],
            tool: undefined,
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
      "user-input.requested",
    ]);
    expect(runtime.permissionReplyCalls).toEqual([
      { requestID: "permission-late-1", reply: "once" },
    ]);
  });

  it("surfaces OpenCode permission asks as approvals in approval-required mode", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-approval-required-permission"),
          runtimeMode: "approval-required",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-approval-required-permission"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "opencode-session-1",
            permission: "bash",
            patterns: ["rm -rf *"],
            metadata: {},
            always: [],
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "request.opened",
    ]);
    expect(result[3]).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "command_execution_approval",
        detail: "rm -rf *",
      },
    });
    expect(runtime.permissionReplyCalls).toEqual([]);
  });

  it("keeps newer OpenCode tool-call steps attached to the active turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-next-tool-call"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-next-tool-call"),
          input: "inspect files",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-next-step-tool-calls",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "tool-calls",
            cost: 0.01,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });
        eventQueue.push({
          id: "evt-next-tool-called",
          type: "session.next.tool.called",
          properties: {
            timestamp: 4,
            sessionID: "opencode-session-1",
            callID: "tool-call-1",
            tool: "read",
            input: {
              filePath: "README.md",
            },
            provider: {
              executed: true,
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.started",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.started",
      turnId: result[2]?.turnId,
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
      },
    });
  });

  it("forwards OpenCode child-session tool activity created by task parts", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-child-session-tools"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-child-session-tools"),
          input: "inspect files",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "parent-task-part",
              messageID: "assistant-message-1",
              type: "tool",
              tool: "task",
              callID: "task-call-1",
              state: {
                status: "running",
                title: "Find changelog implementation",
                input: {
                  description: "Find changelog implementation",
                  prompt: "Explore changelog files.",
                },
                metadata: {
                  sessionId: "child-session-1",
                  parentSessionId: "opencode-session-1",
                },
                time: {
                  start: 1,
                },
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "child-session-1",
            part: {
              id: "child-grep-part",
              messageID: "child-assistant-message-1",
              type: "tool",
              tool: "grep",
              callID: "grep-call-1",
              state: {
                status: "completed",
                input: {
                  pattern: "changelog",
                },
                output: "Found 18 matches",
                time: {
                  start: 2,
                  end: 3,
                },
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.updated",
      "item.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.updated",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: "Find changelog implementation",
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      turnId: result[2]?.turnId,
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        detail: "Found 18 matches",
      },
    });
  });

  it("projects newer OpenCode shell step events as command executions", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-next-shell"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-next-shell"),
          input: "inspect files",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-next-shell-started",
          type: "session.next.shell.started",
          properties: {
            timestamp: 4,
            sessionID: "opencode-session-1",
            callID: "shell-call-1",
            command: "cat package.json | grep next",
          },
        });
        eventQueue.push({
          id: "evt-next-shell-ended",
          type: "session.next.shell.ended",
          properties: {
            timestamp: 5,
            sessionID: "opencode-session-1",
            callID: "shell-call-1",
            output: '"next": "15.5.0"',
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.started",
      "item.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        detail: "cat package.json | grep next",
        data: {
          command: "cat package.json | grep next",
        },
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
        detail: '"next": "15.5.0"',
        data: {
          output: '"next": "15.5.0"',
        },
      },
    });
  });

  it("does not block sendTurn when the OpenCode prompt request stalls during startup", async () => {
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => await new Promise(() => {}),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-stalled-prompt-async"),
          runtimeMode: "full-access",
        });

        const turnReturned = yield* adapter
          .sendTurn({
            threadId: asThreadId("thread-stalled-prompt-async"),
            input: "hello",
            attachments: [],
            modelSelection: {
              provider: "opencode",
              model: "opencode/claude-opus-4-7",
            },
          })
          .pipe(
            Effect.timeoutOption(50),
            Effect.map((turnOption) => turnOption._tag === "Some"),
          );

        const events = Array.from(yield* Fiber.join(eventsFiber));
        return { events, turnReturned };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            promptSubmissionInlineWaitMs: 1,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.turnReturned).toBe(true);
    expect(runtime.promptCalls).toHaveLength(1);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
    ]);
  });

  it("keeps immediate OpenCode prompt failures on the sendTurn failure path", async () => {
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => {
        throw new Error("prompt rejected");
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-rejected-prompt-async"),
          runtimeMode: "full-access",
        });

        const sendExit = yield* Effect.exit(
          adapter.sendTurn({
            threadId: asThreadId("thread-rejected-prompt-async"),
            input: "hello",
            attachments: [],
            modelSelection: {
              provider: "opencode",
              model: "opencode/claude-opus-4-7",
            },
          }),
        );

        const events = Array.from(yield* Fiber.join(eventsFiber));
        return { events, sendFailed: sendExit._tag === "Failure" };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            promptSubmissionInlineWaitMs: 50,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.sendFailed).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "turn.aborted",
      payload: {
        reason: "prompt rejected",
      },
    });
  });

  it("treats OpenCode session.idle as turn completion", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-session-idle"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-session-idle"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-session-idle",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-session-idle",
              messageID: "msg-session-idle",
              type: "text",
              text: "done",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });
        eventQueue.push({
          id: "evt-session-idle",
          type: "session.idle",
          properties: {
            sessionID: "opencode-session-1",
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
  });

  it("recovers final parts before settling an early idle", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    let messageSnapshot: Array<{ info: Record<string, unknown>; parts: Part[] }> = [];
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        return { data: messageSnapshot };
      },
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const eventTypes = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-early-idle-final-assistant");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        messageSnapshot = [
          {
            info: {
              id: "msg-early-idle",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
            parts: [
              {
                id: "part-early-idle",
                messageID: "msg-early-idle",
                type: "text",
                text: "done",
                time: { start: 1, end: 2 },
              } as Part,
            ],
          },
        ];

        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-early-idle",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        // The stream part arrives after the grace period. Synara must first
        // recover the provider snapshot, then ignore this duplicate late event.
        yield* Effect.sleep(30);
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-early-idle",
              messageID: "msg-early-idle",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events.map((event) => event.type);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(eventTypes).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(messageFetchCount).toBeGreaterThanOrEqual(2);
  });

  it("recovers delayed parts when final metadata arrives before idle", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        return {
          data:
            messageFetchCount === 1
              ? []
              : [
                  {
                    info: {
                      id: "msg-final-before-parts",
                      role: "assistant",
                      finish: "stop",
                      time: { completed: 2 },
                    },
                    // OpenCode can expose final metadata before persisting parts.
                    parts: [],
                  },
                ],
        };
      },
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const eventTypes = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-final-before-parts");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-final-before-parts",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        // The first recovery sees final metadata with no parts. The late SSE
        // part must still be emitted before the turn completes.
        yield* Effect.sleep(30);
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-final-before-parts",
              messageID: "msg-final-before-parts",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events.map((event) => event.type);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(eventTypes).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(messageFetchCount).toBeGreaterThanOrEqual(2);
  });

  it("waits for every late final-message part before completing a plan turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      // Exercise the event-stream fallback: OpenCode's read model may still lag
      // while several final text parts are arriving over SSE.
      messages: async () => ({ data: [] }),
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 9)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-late-multipart-plan");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-late-multipart-plan",
              role: "assistant",
              finish: "stop",
              time: { completed: 3 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-late-multipart-preamble",
              messageID: "msg-late-multipart-plan",
              type: "text",
              text: "I prepared the implementation plan.",
              time: { start: 1, end: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-late-multipart-plan",
              messageID: "msg-late-multipart-plan",
              type: "text",
              text: "<proposed_plan>\n# Complete plan\n\n- implement it\n</proposed_plan>",
              time: { start: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        yield* Effect.sleep(10);
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-late-multipart-plan",
              messageID: "msg-late-multipart-plan",
              type: "text",
              text: "<proposed_plan>\n# Complete plan\n\n- implement it\n</proposed_plan>",
              time: { start: 2, end: 3 },
            },
          },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
      "turn.completed",
    ]);
    expect(events[6]).toMatchObject({
      type: "turn.proposed.completed",
      payload: { planMarkdown: "# Complete plan\n\n- implement it" },
    });
  });

  it("does not recover a final snapshot until all assistant text parts are complete", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageSnapshot: Array<{ info: Record<string, unknown>; parts: Part[] }> = [];
    const runtime = createMockOpenCodeRuntime({
      messages: async () => ({ data: messageSnapshot }),
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 9)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-mixed-final-snapshot");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        const finalInfo = {
          id: "msg-mixed-final-snapshot",
          role: "assistant",
          finish: "stop",
          time: { completed: 3 },
        };
        const preamblePart = {
          id: "part-mixed-final-preamble",
          messageID: "msg-mixed-final-snapshot",
          type: "text",
          text: "I prepared the implementation plan.",
          time: { start: 1, end: 2 },
        } as Part;
        const planText = "<proposed_plan>\n# Snapshot plan\n\n- implement it\n</proposed_plan>";
        messageSnapshot = [
          {
            info: finalInfo,
            parts: [
              preamblePart,
              {
                id: "part-mixed-final-plan",
                messageID: "msg-mixed-final-snapshot",
                type: "text",
                text: planText,
                time: { start: 2 },
              } as Part,
            ],
          },
        ];

        eventQueue.push({
          type: "message.updated",
          properties: { sessionID: "opencode-session-1", info: finalInfo },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        // The first recovery sees one complete part and one open part. The turn
        // must remain running until the provider snapshot closes the latter.
        yield* Effect.sleep(30);
        const [sessionWhilePlanPartOpen] = yield* adapter.listSessions();
        messageSnapshot = [
          {
            info: finalInfo,
            parts: [
              preamblePart,
              {
                id: "part-mixed-final-plan",
                messageID: "msg-mixed-final-snapshot",
                type: "text",
                text: planText,
                time: { start: 2, end: 3 },
              } as Part,
            ],
          },
        ];

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, sessionWhilePlanPartOpen };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.sessionWhilePlanPartOpen?.status).toBe("running");
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
      "turn.completed",
    ]);
    expect(result.events[6]).toMatchObject({
      type: "turn.proposed.completed",
      payload: { planMarkdown: "# Snapshot plan\n\n- implement it" },
    });
  });

  it("does not let stale recovery complete a newer turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    let startRecovery: (() => void) | undefined;
    let resolveRecovery:
      | ((value: { data: Array<{ info: Record<string, unknown>; parts: Part[] }> }) => void)
      | undefined;
    const recoveryStarted = new Promise<void>((resolve) => {
      startRecovery = resolve;
    });
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        if (messageFetchCount !== 2) {
          return { data: [] };
        }
        startRecovery?.();
        return await new Promise((resolve) => {
          resolveRecovery = resolve;
        });
      },
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-stale-recovery");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-stale-recovery",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });

        yield* Effect.promise(() => recoveryStarted);
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        yield* Effect.sync(() => {
          resolveRecovery?.({
            data: [
              {
                info: {
                  id: "msg-stale-recovery",
                  role: "assistant",
                  finish: "stop",
                  time: { completed: 2 },
                },
                parts: [
                  {
                    id: "part-stale-recovery",
                    messageID: "msg-stale-recovery",
                    type: "text",
                    text: "obsolete",
                    time: { start: 1, end: 2 },
                  } as Part,
                ],
              },
            ],
          });
        });
        yield* Effect.sleep(10);

        const [session] = yield* adapter.listSessions();
        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, secondTurn, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
      "turn.started",
    ]);
    expect(result.session).toMatchObject({
      status: "running",
      activeTurnId: result.secondTurn.turnId,
    });
  });
});
