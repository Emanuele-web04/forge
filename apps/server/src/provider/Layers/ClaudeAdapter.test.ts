import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  HookInput,
  PermissionMode,
  PermissionResult,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ProviderItemId,
  ProviderRuntimeEvent,
  ThreadId,
} from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Random, Stream } from "effect";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import {
  buildEmbeddedClaudeSystemPromptAppend,
  makeClaudeAdapterLive,
  type ClaudeAdapterLiveOptions,
  type ClaudeOwnedProcess,
} from "./ClaudeAdapter.ts";

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly interruptCalls: Array<void> = [];
  public readonly stopTaskCalls: Array<string> = [];
  public readonly backgroundTasksCalls: Array<string | undefined> = [];
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public readonly applyFlagSettingsCalls: Array<Record<string, unknown>> = [];
  public getContextUsageCalls = 0;
  private contextUsageResponse: SDKControlGetContextUsageResponse | undefined;
  private contextUsageNeverResolves = false;
  public closeCalls = 0;

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly interrupt = async (): Promise<void> => {
    this.interruptCalls.push(undefined);
  };

  readonly stopTask = async (taskId: string): Promise<void> => {
    this.stopTaskCalls.push(taskId);
  };

  readonly backgroundTasks = async (toolUseId?: string): Promise<boolean> => {
    this.backgroundTasksCalls.push(toolUseId);
    return true;
  };

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };

  readonly setMaxThinkingTokens = async (maxThinkingTokens: number | null): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };

  readonly applyFlagSettings = async (settings: Record<string, unknown>): Promise<void> => {
    this.applyFlagSettingsCalls.push(settings);
  };

  setContextUsageResponse(response: SDKControlGetContextUsageResponse): void {
    this.contextUsageResponse = response;
  }

  setContextUsageNeverResolves(): void {
    this.contextUsageNeverResolves = true;
  }

  readonly getContextUsage = async (): Promise<SDKControlGetContextUsageResponse> => {
    this.getContextUsageCalls += 1;
    if (this.contextUsageNeverResolves) {
      return new Promise<SDKControlGetContextUsageResponse>(() => {});
    }
    if (!this.contextUsageResponse) {
      throw new Error("Context usage unavailable in this test.");
    }
    return this.contextUsageResponse;
  };

  readonly supportedCommands = async (): Promise<
    Array<{ name: string; description: string; argumentHint: string }>
  > => {
    return [];
  };

  readonly supportedModels = async (): Promise<[]> => {
    return [];
  };

  readonly supportedAgents = async (): Promise<[]> => {
    return [];
  };

  readonly close = (): void => {
    this.closeCalls += 1;
    this.finish();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly workflowRuntimePollIntervalMs?: number;
}) {
  const query = new FakeClaudeQuery();
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    createQuery: (input) => {
      createInput = input;
      return query;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
    ...(config?.workflowRuntimePollIntervalMs !== undefined
      ? {
          workflowRuntimePollIntervalMs: config.workflowRuntimePollIntervalMs,
        }
      : {}),
  };

  return {
    layer: makeClaudeAdapterLive(adapterOptions).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLastCreateQueryInput: () => createInput,
  };
}

function makeMultiQueryHarness(config?: {
  readonly failCreateAt?: number;
  readonly gatewayCredentials?: AgentGatewayCredentialsShape;
}) {
  const queries: Array<FakeClaudeQuery> = [];
  const createInputs: Array<{
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }> = [];
  let layer = makeClaudeAdapterLive({
    createQuery: (input) => {
      if (queries.length === config?.failCreateAt) {
        throw new Error("simulated Claude spawn failure");
      }
      const query = new FakeClaudeQuery();
      queries.push(query);
      createInputs.push(input);
      return query;
    },
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
    Layer.provideMerge(NodeServices.layer),
  );
  if (config?.gatewayCredentials) {
    layer = layer.pipe(
      Layer.provideMerge(Layer.succeed(AgentGatewayCredentials, config.gatewayCredentials)),
    );
  }

  return { layer, queries, createInputs };
}

function makeGatewayCredentialsHarness() {
  let sequence = 0;
  const revokedTokens: string[] = [];
  const credentials = {
    mcpEndpointUrl: "http://127.0.0.1:48123/mcp",
    setListeningPort: () => undefined,
    issueSessionToken: () => `gateway-token-${++sequence}`,
    verifySessionToken: () => null,
    verifySession: () => null,
    bindWriteAuthority: () => null,
    verifyWriteAuthority: () => false,
    revokeSessionToken: (token: string) => {
      revokedTokens.push(token);
    },
    connectionForThread: () => ({
      url: "http://127.0.0.1:48123/mcp",
      bearerToken: `gateway-token-${++sequence}`,
    }),
    stdioProxy: { command: "node", args: ["/state/proxy.mjs"] },
  } satisfies AgentGatewayCredentialsShape;
  return { credentials, revokedTokens };
}

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  const content = next.value.message.content[0];
  if (!content || typeof content === "string" || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

function autoCompactWindowFromOptions(options: ClaudeQueryOptions | undefined): number | undefined {
  const settings = options?.settings;
  return settings && typeof settings === "object" ? settings.autoCompactWindow : undefined;
}

function effortLevelFromOptions(options: ClaudeQueryOptions | undefined): string | undefined {
  const settings = options?.settings;
  return settings && typeof settings === "object" ? settings.effortLevel : undefined;
}

const THREAD_ID = ThreadId.makeUnsafe("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.makeUnsafe("thread-claude-resume");

describe("Claude Synara harness policy", () => {
  it("advertises scoped MCP additively when credentials are available", () => {
    const text = buildEmbeddedClaudeSystemPromptAppend(true);
    assert.include(text, SYNARA_HARNESS_POLICY_MARKER);
    assert.include(text, "Use the synara_* tools");
    assert.notInclude(text, "Synara MCP control is unavailable");
  });

  it("stays truthful when scoped MCP credentials are absent", () => {
    const text = buildEmbeddedClaudeSystemPromptAppend(false);
    assert.include(text, SYNARA_HARNESS_POLICY_MARKER);
    assert.include(text, "Synara MCP control is unavailable");
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({ threadId: THREAD_ID, provider: "codex", runtimeMode: "full-access" })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("loads Claude filesystem settings sources for SDK sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, undefined);
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
      const systemPrompt = createInput?.options.systemPrompt;
      if (
        systemPrompt === undefined ||
        typeof systemPrompt === "string" ||
        Array.isArray(systemPrompt) ||
        systemPrompt.type !== "preset"
      ) {
        return assert.fail("Expected Claude preset system prompt.");
      }
      assert.equal(systemPrompt.preset, "claude_code");
      assert.equal(systemPrompt.excludeDynamicSections, true);
      assert.include(systemPrompt.append ?? "", "When spawning subagents");
      assert.include(systemPrompt.append ?? "", "worker-<tier>");
      assert.include(systemPrompt.append ?? "", SYNARA_HARNESS_POLICY_MARKER);
      assert.include(systemPrompt.append ?? "", "Synara is the host and harness");
      // This characterization harness intentionally omits gateway credentials.
      assert.include(systemPrompt.append ?? "", "Synara MCP control is unavailable");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps explicit claude permission mode over runtime-derived defaults", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        providerOptions: {
          claudeAgent: {
            permissionMode: "plan",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "plan");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards the 1m Claude auto-compact budget without changing the model id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            autoCompactWindow: "1m",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-opus-4-6");
      assert.equal(autoCompactWindowFromOptions(createInput?.options), 1_000_000);
      assert.isUndefined(createInput?.options.betas);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards xhigh effort for Claude Opus 4.7", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: {
            effort: "xhigh",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
      assert.equal(effortLevelFromOptions(createInput?.options), "xhigh");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Sonnet 5 xhigh effort and a 1m auto-compact budget", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-5",
          options: {
            effort: "xhigh",
            autoCompactWindow: "1m",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-sonnet-5");
      assert.equal(autoCompactWindowFromOptions(createInput?.options), 1_000_000);
      assert.equal(createInput?.options.effort, undefined);
      assert.equal(effortLevelFromOptions(createInput?.options), "xhigh");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards every Sonnet 5 API effort unchanged", () =>
    Effect.gen(function* () {
      for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-sonnet-5",
              options: { effort },
            },
            runtimeMode: "full-access",
          });

          const createInput = harness.getLastCreateQueryInput();
          assert.equal(createInput?.options.model, "claude-sonnet-5");
          // Non-max effort rides in flag settings so it can change live;
          // `max` has no Settings equivalent and stays a spawn option.
          if (effort === "max") {
            assert.equal(createInput?.options.effort, "max");
            assert.equal(effortLevelFromOptions(createInput?.options), undefined);
          } else {
            assert.equal(createInput?.options.effort, undefined);
            assert.equal(effortLevelFromOptions(createInput?.options), effort);
          }
        }).pipe(Effect.provide(harness.layer));
      }
    }).pipe(Effect.provideService(Random.Random, makeDeterministicRandomService())),
  );

  it.effect("forwards Sonnet 5 ultracode as xhigh plus the Claude Code setting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-5",
          options: {
            effort: "ultracode",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-sonnet-5");
      assert.equal(createInput?.options.effort, undefined);
      assert.deepEqual(createInput?.options.settings, {
        autoCompactEnabled: true,
        autoCompactWindow: 200_000,
        effortLevel: "xhigh",
        ultracode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards supported max effort for Sonnet 4.6", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores adaptive effort for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: {
            effort: "high",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle into SDK settings for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: {
            thinking: false,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        autoCompactEnabled: true,
        alwaysThinkingEnabled: false,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking toggle for non-Haiku models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            thinking: false,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        autoCompactEnabled: true,
        autoCompactWindow: 200_000,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude fast mode into SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        autoCompactEnabled: true,
        autoCompactWindow: 200_000,
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for non-opus models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        autoCompactEnabled: true,
        autoCompactWindow: 200_000,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats ultrathink as a prompt keyword instead of a session effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "ultrathink",
          },
        },
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "ultrathink",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Ultrathink:\nInvestigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("skips a redundant setPermissionMode on the first full-access turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "First turn",
        attachments: [],
      });

      // The CLI already spawned in bypassPermissions (full-access). Re-sending the
      // identical mode would block the first turn on the CLI init handshake, so the
      // control request must be skipped entirely.
      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("re-sends setPermissionMode on a second turn with the same desired mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      // First full-access turn: desired mode equals the spawn mode, so the
      // redundant control request is skipped (provable first-turn state).
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "First turn",
        attachments: [],
      });
      assert.deepEqual(harness.query.setPermissionModeCalls, []);

      // Second turn wants the SAME desired mode, but the CLI's mode is no longer
      // provable once a prompt has run, so the request is sent unconditionally
      // (the pre-optimization behavior, with no equality skip against a tracked
      // mode).
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Second turn",
        attachments: [],
      });
      assert.deepEqual(harness.query.setPermissionModeCalls, ["bypassPermissions"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sends setPermissionMode on each turn of a plan then default sequence", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      // Plan differs from the spawn mode (bypassPermissions) -> request is sent
      // even though this is the first turn.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Plan this",
        attachments: [],
        interactionMode: "plan",
      });
      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);

      // A following default turn auto-closes the stale plan turn and restores the
      // base bypassPermissions mode -> request is sent again.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Now build it",
        attachments: [],
        interactionMode: "default",
      });
      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", "bypassPermissions"]);

      // The first-turn skip window has closed, so a third identical default turn
      // re-sends unconditionally rather than skipping.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Keep going",
        attachments: [],
        interactionMode: "default",
      });
      assert.deepEqual(harness.query.setPermissionModeCalls, [
        "plan",
        "bypassPermissions",
        "bypassPermissions",
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("skips the redundant setPermissionMode on the first turn after resume", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      // Resume also spawns a fresh CLI in bypassPermissions, so the tracked mode is
      // initialized correctly and the first turn after resume skips the redundant
      // control request instead of blocking on the init handshake.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Continue",
        attachments: [],
      });
      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "text",
          text: "What's in this image?",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("projects unsupported Claude image types as readable file attachments", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-svg-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-svg-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-svg-12345678-1234-1234-1234-123456789abc",
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        sizeBytes: 11,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, "<svg></svg>");

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Inspect this diagram",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "text",
          text: "Inspect this diagram",
        },
        {
          type: "text",
          text: [
            "<attached_files>",
            "The user attached the following file(s), saved on disk. Read/extract them with your tools as needed; do not assume their contents.",
            `- \"diagram.svg\" - image/svg+xml - 11 B - ${attachmentPath}`,
            "</attached_files>",
          ].join("\n"),
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: "src/example.ts:1:foo",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolCallId: "tool-grep-1",
          callId: "tool-grep-1",
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits a turn diff update when Claude finishes a file-change tool", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "edit the file",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-file-edit",
        uuid: "stream-text-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-file-edit",
        uuid: "stream-text-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Updated it.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-file-edit",
        uuid: "stream-text-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-file-edit",
        uuid: "stream-edit-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-edit-1",
            name: "Edit",
            input: {
              file_path: "src/example.ts",
              old_string: "before",
              new_string: "after",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-file-edit",
        uuid: "stream-edit-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-file-edit",
        uuid: "user-edit-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-edit-1",
              content: "Updated src/example.ts",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-file-edit",
        uuid: "result-file-edit",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const diffUpdatedIndex = runtimeEvents.findIndex(
        (event) => event.type === "turn.diff.updated",
      );
      const turnCompletedIndex = runtimeEvents.findIndex(
        (event) => event.type === "turn.completed",
      );

      assert.equal(diffUpdatedIndex >= 0, true);
      assert.equal(turnCompletedIndex >= 0, true);
      assert.equal(diffUpdatedIndex < turnCompletedIndex, true);

      const diffUpdated = runtimeEvents[diffUpdatedIndex];
      assert.equal(diffUpdated?.type, "turn.diff.updated");
      if (diffUpdated?.type === "turn.diff.updated") {
        assert.equal(String(diffUpdated.turnId), String(turn.turnId));
        assert.equal(diffUpdated.payload.unifiedDiff, "");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes subagent-tagged messages to a child provider thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn.completed" && event.providerRefs?.providerThreadId === undefined,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-subagent",
        uuid: "stream-subagent-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        tool_use_id: "tool-task-1",
        subagent_type: "code-reviewer",
        description: "Review the database layer",
        session_id: "sdk-session-subagent",
        uuid: "task-started-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent",
        uuid: "assistant-subagent-1",
        parent_tool_use_id: "tool-task-1",
        message: {
          id: "assistant-message-subagent-1",
          content: [{ type: "text", text: "Reviewing the migration now." }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "tool_progress",
        tool_use_id: "tool-subagent-heartbeat-1",
        tool_name: "Grep",
        parent_tool_use_id: "tool-task-1",
        elapsed_time_seconds: 5,
        heartbeat: true,
        session_id: "sdk-session-subagent",
        uuid: "tool-progress-subagent-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-1",
        tool_use_id: "tool-task-1",
        description: "Review the database layer",
        usage: { total_tokens: 123, tool_uses: 4, duration_ms: 987 },
        session_id: "sdk-session-subagent",
        uuid: "task-progress-subagent-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        tool_use_id: "tool-task-1",
        status: "completed",
        output_file: "/tmp/task-1-output.md",
        summary: "Reviewed the migration.",
        session_id: "sdk-session-subagent",
        uuid: "task-notification-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-subagent",
        uuid: "result-subagent-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const childEvents = runtimeEvents.filter(
        (event) => event.providerRefs?.providerThreadId === "tool-task-1",
      );
      assert.equal(
        childEvents.every((event) => event.providerRefs?.providerParentThreadId === THREAD_ID),
        true,
      );
      assert.equal(
        childEvents.some((event) => event.type === "turn.started"),
        true,
      );
      assert.equal(
        childEvents.some(
          (event) => event.type === "tool.progress" && event.payload.toolName === "Grep",
        ),
        true,
      );

      const collabStarted = runtimeEvents.find(
        (event) =>
          event.type === "item.started" && event.payload.itemType === "collab_agent_tool_call",
      );
      assert.equal(collabStarted?.type, "item.started");
      if (collabStarted?.type === "item.started") {
        const data = collabStarted.payload.data as Record<string, unknown>;
        assert.equal(data.receiverThreadId, "tool-task-1");
        assert.equal(data.agentType, "code-reviewer");
        assert.equal(data.nickname, "Review the database layer");
      }

      // The subagent's assistant text streams on the child thread, never the parent.
      const textDeltas = runtimeEvents.filter(
        (event) =>
          event.type === "content.delta" && event.payload.delta.includes("Reviewing the migration"),
      );
      assert.equal(textDeltas.length > 0, true);
      assert.equal(
        textDeltas.every((event) => event.providerRefs?.providerThreadId === "tool-task-1"),
        true,
      );

      // Subagent usage (assistant per-call + task_progress) feeds only the child meter.
      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(usageEvents.length > 0, true);
      assert.equal(
        usageEvents.every((event) => event.providerRefs?.providerThreadId === "tool-task-1"),
        true,
      );
      const taskUsage = usageEvents.find(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 123,
      );
      assert.equal(taskUsage?.type, "thread.token-usage.updated");

      const childTurnCompleted = childEvents.find((event) => event.type === "turn.completed");
      assert.equal(childTurnCompleted?.type, "turn.completed");
      if (childTurnCompleted?.type === "turn.completed") {
        assert.equal(childTurnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps async Bash progress on the parent thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn.completed" && event.providerRefs?.providerThreadId === undefined,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run the browser tests",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-async-bash",
        uuid: "stream-async-bash-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-bash-1",
            name: "Bash",
            input: { command: "bun run test:browser" },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-bash-1",
        task_type: "local_bash",
        tool_use_id: "tool-bash-1",
        description: "Run browser tests",
        session_id: "sdk-session-async-bash",
        uuid: "task-started-async-bash-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "tool_progress",
        tool_use_id: "tool-bash-1-heartbeat-0",
        tool_name: "Bash",
        parent_tool_use_id: "tool-bash-1",
        elapsed_time_seconds: 30,
        heartbeat: true,
        session_id: "sdk-session-async-bash",
        uuid: "tool-progress-async-bash-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-async-bash",
        uuid: "user-async-bash-result-1",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-bash-1",
              content: "Tests passed",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-async-bash",
        uuid: "result-async-bash-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(
        runtimeEvents.some((event) => event.providerRefs?.providerThreadId !== undefined),
        false,
      );
      const progress = runtimeEvents.find(
        (event) => event.type === "tool.progress" && event.payload.toolName === "Bash",
      );
      assert.equal(progress?.type, "tool.progress");
      assert.equal(progress?.providerRefs?.providerThreadId, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // Subagent conversations arrive as complete assistant/user messages only — the CLI
  // forwards no stream events for them — so every message after the first, and every
  // tool call, must project from the snapshots alone.
  it.effect("projects a complete-message subagent conversation onto the child thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn.completed" && event.providerRefs?.providerThreadId === undefined,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-subagent",
        uuid: "stream-subagent-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Explore the codebase",
              prompt: "Find the relevant modules",
              subagent_type: "explore",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent",
        uuid: "assistant-subagent-1",
        parent_tool_use_id: "tool-task-1",
        message: {
          id: "assistant-message-subagent-1",
          content: [{ type: "text", text: "First update from the subagent." }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent",
        uuid: "assistant-subagent-2",
        parent_tool_use_id: "tool-task-1",
        message: {
          id: "assistant-message-subagent-2",
          content: [
            {
              type: "tool_use",
              id: "tool-grep-1",
              name: "Bash",
              input: { command: "rg foo" },
            },
          ],
          usage: { input_tokens: 20, output_tokens: 8 },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-subagent",
        uuid: "user-subagent-1",
        parent_tool_use_id: "tool-task-1",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: [{ type: "text", text: "2 matches" }],
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent",
        uuid: "assistant-subagent-3",
        parent_tool_use_id: "tool-task-1",
        message: {
          id: "assistant-message-subagent-3",
          content: [{ type: "text", text: "Final summary: everything checks out." }],
          usage: { input_tokens: 30, output_tokens: 12 },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-subagent",
        uuid: "result-subagent-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const childEvents = runtimeEvents.filter(
        (event) => event.providerRefs?.providerThreadId === "tool-task-1",
      );
      assert.equal(
        childEvents.every((event) => event.providerRefs?.providerParentThreadId === THREAD_ID),
        true,
      );

      // Every assistant message's text projects — not just the first one.
      const childDeltaText = childEvents
        .filter((event) => event.type === "content.delta")
        .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
        .join("");
      assert.equal(childDeltaText.includes("First update from the subagent."), true);
      assert.equal(childDeltaText.includes("Final summary: everything checks out."), true);
      const childMessageCompletions = childEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(childMessageCompletions.length, 2);

      // Tool calls from complete assistant messages open on the child thread and
      // complete when the matching tool_result arrives.
      const toolStarted = childEvents.find(
        (event) =>
          event.type === "item.started" && event.providerRefs?.providerItemId === "tool-grep-1",
      );
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        const data = toolStarted.payload.data as Record<string, unknown>;
        assert.equal(data.toolName, "Bash");
        assert.deepEqual(data.input, { command: "rg foo" });
      }
      const toolCompleted = childEvents.find(
        (event) =>
          event.type === "item.completed" && event.providerRefs?.providerItemId === "tool-grep-1",
      );
      assert.equal(toolCompleted?.type, "item.completed");
      if (toolCompleted?.type === "item.completed") {
        assert.equal(toolCompleted.payload.status, "completed");
      }

      // The subagent's internal tool never leaks onto the parent thread.
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.providerRefs?.providerThreadId === undefined &&
            event.providerRefs?.providerItemId === "tool-grep-1",
        ),
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("announces newly backgrounded tasks once with a background notice", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const warningsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "runtime.warning"),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "bg-1", task_type: "local_bash", description: "sleep 120" }],
        session_id: "sdk-session-bg",
        uuid: "bg-change-1",
      } as unknown as SDKMessage);
      // Same task again plus one addition: only the addition is announced.
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "bg-1", task_type: "local_bash", description: "sleep 120" },
          { task_id: "bg-2", task_type: "subagent", description: "beta" },
        ],
        session_id: "sdk-session-bg",
        uuid: "bg-change-2",
      } as unknown as SDKMessage);
      // Removal-only change announces nothing.
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "bg-2", task_type: "subagent", description: "beta" }],
        session_id: "sdk-session-bg",
        uuid: "bg-change-3",
      } as unknown as SDKMessage);
      // Sentinel unknown subtype closes the collection window; its warning
      // arriving third proves the removal produced no notice.
      harness.query.emit({
        type: "system",
        subtype: "totally_unknown_subtype",
        session_id: "sdk-session-bg",
        uuid: "bg-sentinel",
      } as unknown as SDKMessage);

      const warnings = Array.from(yield* Fiber.join(warningsFiber));
      assert.deepEqual(
        warnings.map((event) => (event.type === "runtime.warning" ? event.payload.message : "")),
        ["sleep 120", "beta", "Unhandled Claude system message subtype 'totally_unknown_subtype'."],
      );
      const firstNotice = warnings[0];
      assert.equal(firstNotice?.type, "runtime.warning");
      if (firstNotice?.type === "runtime.warning") {
        // The SDK message rides on detail so ingestion can tell background
        // notices apart from plain runtime warnings.
        const detail = firstNotice.payload.detail as Record<string, unknown>;
        assert.equal(detail.subtype, "background_tasks_changed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops zombie-tagged messages after a subagent task settles", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn.completed" && event.providerRefs?.providerThreadId === undefined,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-zombie",
        uuid: "stream-zombie-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-zombie",
            name: "Task",
            input: {
              description: "Sleep repeatedly",
              prompt: "Sleep in a loop",
              subagent_type: "worker-low",
            },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-zombie",
        tool_use_id: "tool-task-zombie",
        subagent_type: "worker-low",
        description: "Sleep repeatedly",
        session_id: "sdk-session-zombie",
        uuid: "task-started-zombie",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-zombie",
        uuid: "assistant-zombie-1",
        parent_tool_use_id: "tool-task-zombie",
        message: {
          id: "assistant-message-zombie-1",
          content: [{ type: "text", text: "Sleeping now." }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      } as unknown as SDKMessage);
      // The user stopped the task; the SDK settles it — in the real stream a
      // terminal task_updated patch lands first (retiring the run), then the
      // task_notification follows.
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-zombie",
        patch: { status: "killed" },
        session_id: "sdk-session-zombie",
        uuid: "task-updated-zombie",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-zombie",
        tool_use_id: "tool-task-zombie",
        status: "stopped",
        output_file: "/tmp/task-zombie-output.md",
        summary: "Stopped.",
        session_id: "sdk-session-zombie",
        uuid: "task-notification-zombie",
      } as unknown as SDKMessage);
      // ...but a message already in flight arrives with the same tag. It must
      // not resurrect the settled child (a new synthetic turn would pin the
      // strip row on "Running" forever).
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-zombie",
        uuid: "assistant-zombie-2",
        parent_tool_use_id: "tool-task-zombie",
        message: {
          id: "assistant-message-zombie-2",
          content: [{ type: "text", text: "Still going." }],
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      } as unknown as SDKMessage);
      // The Task tool_result for a stopped task arrives error-shaped; the
      // settled status must stamp a "stopped" agent state onto the item.
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-zombie",
        uuid: "tool-result-zombie",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-zombie",
              content: "Task was aborted",
              is_error: true,
            },
          ],
        },
      } as unknown as SDKMessage);

      // Second subagent settles via task_notification alone (no terminal
      // task_updated) — the other real-world settle order.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-zombie2",
        tool_use_id: "tool-task-zombie2",
        subagent_type: "worker-low",
        description: "Sleep repeatedly too",
        session_id: "sdk-session-zombie",
        uuid: "task-started-zombie2",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-zombie",
        uuid: "assistant-zombie2-1",
        parent_tool_use_id: "tool-task-zombie2",
        message: {
          id: "assistant-message-zombie2-1",
          content: [{ type: "text", text: "Napping." }],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-zombie2",
        tool_use_id: "tool-task-zombie2",
        status: "stopped",
        output_file: "/tmp/task-zombie2-output.md",
        summary: "Stopped.",
        session_id: "sdk-session-zombie",
        uuid: "task-notification-zombie2",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-zombie",
        uuid: "assistant-zombie2-2",
        parent_tool_use_id: "tool-task-zombie2",
        message: {
          id: "assistant-message-zombie2-2",
          content: [{ type: "text", text: "Napping again." }],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-zombie",
        uuid: "result-zombie-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      for (const toolUseId of ["tool-task-zombie", "tool-task-zombie2"]) {
        const childEvents = runtimeEvents.filter(
          (event) => event.providerRefs?.providerThreadId === toolUseId,
        );
        // Exactly one child turn: started once, completed once at settle, and
        // the zombie tail neither streams text nor reopens a turn.
        assert.equal(childEvents.filter((event) => event.type === "turn.started").length, 1);
        assert.equal(childEvents.filter((event) => event.type === "turn.completed").length, 1);
        const lastChildEvent = childEvents.at(-1);
        assert.equal(lastChildEvent?.type, "turn.completed");
      }
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" &&
            (event.payload.delta.includes("Still going") ||
              event.payload.delta.includes("Napping again")),
        ),
        false,
      );
      const stoppedItemCompleted = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" &&
          event.providerRefs?.providerItemId === "tool-task-zombie",
      );
      assert.equal(stoppedItemCompleted?.type, "item.completed");
      if (stoppedItemCompleted?.type === "item.completed") {
        const data = stoppedItemCompleted.payload.data as Record<string, unknown>;
        assert.deepEqual(data.agentStates, {
          "tool-task-zombie": { status: "stopped" },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stops a targeted subagent task instead of interrupting the whole turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "task.started"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(harness.getLastCreateQueryInput()?.options.forwardSubagentText, true);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-stop-1",
        tool_use_id: "tool-task-stop-1",
        subagent_type: "code-reviewer",
        description: "Long-running review",
        session_id: "sdk-session-stop",
        uuid: "task-started-stop-1",
      } as unknown as SDKMessage);
      yield* Fiber.join(runtimeEventsFiber);

      yield* adapter.interruptTurn(session.threadId, undefined, "tool-task-stop-1");
      assert.deepEqual(harness.query.stopTaskCalls, ["task-stop-1"]);
      assert.equal(harness.query.interruptCalls.length, 0);
      assert.equal(harness.query.backgroundTasksCalls.length, 0);

      // Without a known task id (task_started not seen yet) the stop is queued —
      // never backgrounded — and fires the moment task_started maps the tool use.
      yield* adapter.interruptTurn(session.threadId, undefined, "tool-task-pending");
      assert.equal(harness.query.backgroundTasksCalls.length, 0);
      assert.deepEqual(harness.query.stopTaskCalls, ["task-stop-1"]);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-pending-1",
        tool_use_id: "tool-task-pending",
        subagent_type: "code-reviewer",
        description: "Stopped before task_started",
        session_id: "sdk-session-stop",
        uuid: "task-started-pending-1",
      } as unknown as SDKMessage);
      // Wait for the stream handler to process the mapping and fire the queued stop.
      for (let i = 0; i < 10_000 && harness.query.stopTaskCalls.length < 2; i += 1) {
        yield* Effect.yieldNow;
      }
      assert.deepEqual(harness.query.stopTaskCalls, ["task-stop-1", "task-pending-1"]);
      assert.equal(harness.query.backgroundTasksCalls.length, 0);
      assert.equal(harness.query.interruptCalls.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("delivers queued subagent steers through the PreToolUse hook", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.steered"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const hook = harness.getLastCreateQueryInput()?.options.hooks?.PreToolUse?.[0]?.hooks[0];
      assert.isDefined(hook);
      const invokeHook = (agentId: string | undefined) =>
        Effect.promise(() =>
          hook!(
            {
              hook_event_name: "PreToolUse",
              tool_name: "Read",
              tool_input: {},
              tool_use_id: "tool-read-1",
              session_id: "sdk-session-steer",
              transcript_path: "/tmp/transcript",
              cwd: "/tmp",
              ...(agentId ? { agent_id: agentId } : {}),
            } as HookInput,
            "tool-read-1",
            { signal: new AbortController().signal },
          ),
        );

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-steer-1",
        tool_use_id: "tool-task-steer-1",
        subagent_type: "worker-high",
        description: "Long-running task",
        session_id: "sdk-session-steer",
        uuid: "task-started-steer-1",
      } as unknown as SDKMessage);

      // No pending steer: the hook stays a clean passthrough.
      assert.deepEqual(yield* invokeHook("task-steer-1"), {});

      yield* adapter.steerSubagent(session.threadId, "tool-task-steer-1", {
        input: "Focus on the tests",
      });

      // Main-thread hook calls carry no agent_id and must never drain the queue.
      assert.deepEqual(yield* invokeHook(undefined), {});

      const delivered = yield* invokeHook("task-steer-1");
      assert.deepEqual(delivered, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            "The user sent you a message mid-task: Focus on the tests. Address it and adjust your work accordingly.",
        },
      });

      // The queue drained: a second delivery attempt passes through untouched.
      assert.deepEqual(yield* invokeHook("task-steer-1"), {});

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const steered = runtimeEvents.find((event) => event.type === "turn.steered");
      assert.equal(steered?.type, "turn.steered");
      if (steered?.type === "turn.steered") {
        assert.equal(steered.payload.message, "Focus on the tests");
        assert.equal(steered.providerRefs?.providerThreadId, "tool-task-steer-1");
        assert.equal(steered.providerRefs?.providerParentThreadId, THREAD_ID);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("projects attachment-only steer messages as disk-path references", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-steer-attachments-"));
    const harness = makeHarness({ baseDir });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "file" as const,
        id: "thread-claude-steer-attachment-12345678-1234-1234-1234-123456789abc",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-steer-attach-1",
        tool_use_id: "tool-task-steer-attach-1",
        subagent_type: "worker-high",
        description: "Long-running task",
        session_id: "sdk-session-steer-attach",
        uuid: "task-started-steer-attach-1",
      } as unknown as SDKMessage);

      const hook = harness.getLastCreateQueryInput()?.options.hooks?.PreToolUse?.[0]?.hooks[0];
      assert.isDefined(hook);
      const invokeHook = () =>
        Effect.promise(() =>
          hook!(
            {
              hook_event_name: "PreToolUse",
              tool_name: "Read",
              tool_input: {},
              tool_use_id: "tool-read-steer-attach-1",
              session_id: "sdk-session-steer-attach",
              transcript_path: "/tmp/transcript",
              cwd: "/tmp",
              agent_id: "task-steer-attach-1",
            } as HookInput,
            "tool-read-steer-attach-1",
            { signal: new AbortController().signal },
          ),
        );

      // Drains the microtask queue so the stream fiber ingests task_started
      // (and registers the subagent run) before the steer is queued.
      assert.deepEqual(yield* invokeHook(), {});

      yield* adapter.steerSubagent(session.threadId, "tool-task-steer-attach-1", {
        input: "",
        attachments: [attachment],
      });

      const hookOutput = yield* invokeHook();
      const additionalContext =
        "hookSpecificOutput" in hookOutput &&
        hookOutput.hookSpecificOutput?.hookEventName === "PreToolUse"
          ? hookOutput.hookSpecificOutput.additionalContext
          : undefined;
      assert.isDefined(additionalContext);
      assert.include(additionalContext, "<attached_files>");
      assert.include(additionalContext, attachmentPath);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rejects steering a subagent that already settled", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const result = yield* adapter
        .steerSubagent(session.threadId, "tool-task-finished", { input: "too late" })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ProviderAdapterRequestError);
      }
      void harness;
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("moves an in-flight foreground task to the background on request", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.backgroundTask(session.threadId, "tool-task-bg-1");
      assert.deepEqual(harness.query.backgroundTasksCalls, ["tool-task-bg-1"]);
      assert.equal(harness.query.interruptCalls.length, 0);
      assert.equal(harness.query.stopTaskCalls.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("surfaces task_updated backgrounded patches with the run's tool use id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "task.updated"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-bg-2",
        tool_use_id: "tool-task-bg-2",
        subagent_type: "code-reviewer",
        description: "Backgroundable review",
        session_id: "sdk-session-bg",
        uuid: "task-started-bg-2",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-bg-2",
        patch: { is_backgrounded: true },
        session_id: "sdk-session-bg",
        uuid: "task-updated-bg-2",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const taskUpdated = runtimeEvents.find((event) => event.type === "task.updated");
      assert.equal(taskUpdated?.type, "task.updated");
      if (taskUpdated?.type === "task.updated") {
        assert.equal(taskUpdated.payload.isBackgrounded, true);
        assert.equal(taskUpdated.payload.toolUseId, "tool-task-bg-2");
        assert.equal(taskUpdated.payload.status, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stamps worker-tier effort and background hints on subagent spawn items", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "item.started" && event.payload.itemType === "collab_agent_tool_call",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-effort",
        uuid: "stream-effort-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-effort-1",
            name: "Agent",
            input: {
              description: "Deep audit",
              prompt: "Audit the changes",
              subagent_type: "worker-high",
              model: "sonnet",
              run_in_background: true,
            },
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const collabStarted = runtimeEvents.find(
        (event) =>
          event.type === "item.started" && event.payload.itemType === "collab_agent_tool_call",
      );
      assert.equal(collabStarted?.type, "item.started");
      if (collabStarted?.type === "item.started") {
        const data = collabStarted.payload.data as Record<string, unknown>;
        assert.equal(data.receiverThreadId, "tool-task-effort-1");
        assert.equal(data.agentType, "worker-high");
        assert.equal(data.model, "sonnet");
        assert.equal(data.effort, "high");
        assert.equal(data.background, true);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("tags workflow member tasks with the live workflow run and stops it by task id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => event.type === "task.started" && event.payload.taskId === "wf-agent-2",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      // Workflow run itself: no tool_use_id, identified by task_type/workflow_name.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "wf-1",
        task_type: "local_workflow",
        workflow_name: "spec",
        description: "Draft the feature spec",
        session_id: "sdk-session-workflow",
        uuid: "workflow-started-1",
      } as unknown as SDKMessage);

      // Member agent spawned by the workflow: no Task tool call, so no tool_use_id.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "wf-agent-1",
        subagent_type: "researcher",
        description: "Research prior art",
        session_id: "sdk-session-workflow",
        uuid: "workflow-agent-started-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "wf-agent-1",
        description: "Research prior art",
        usage: { total_tokens: 321, tool_uses: 2, duration_ms: 4_500 },
        session_id: "sdk-session-workflow",
        uuid: "workflow-agent-progress-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "wf-agent-1",
        patch: { status: "paused" },
        session_id: "sdk-session-workflow",
        uuid: "workflow-agent-updated-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "wf-agent-1",
        status: "completed",
        output_file: "/tmp/wf-agent-1-output.md",
        summary: "Research finished.",
        usage: { total_tokens: 500, tool_uses: 3, duration_ms: 9_000 },
        session_id: "sdk-session-workflow",
        uuid: "workflow-agent-notification-1",
      } as unknown as SDKMessage);

      // Ambient shell tasks (each Bash call an agent makes) are not workflow
      // members even while exactly one workflow is live.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "ambient-bash-1",
        tool_use_id: "toolu-ambient-bash-1",
        task_type: "local_bash",
        description: "Sleep call 3 of 40",
        session_id: "sdk-session-workflow",
        uuid: "ambient-bash-started-1",
      } as unknown as SDKMessage);

      // Task-tool subagent spawns (tool_use_id + subagent_type) belong to the
      // subagent strip; they must not double as workflow member rows.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "strip-subagent-1",
        tool_use_id: "toolu-strip-subagent-1",
        subagent_type: "worker-low",
        description: "phi",
        session_id: "sdk-session-workflow",
        uuid: "strip-subagent-started-1",
      } as unknown as SDKMessage);

      // A second concurrent workflow makes membership ambiguous: later agent
      // tasks must stay untagged instead of guessing.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "wf-2",
        task_type: "local_workflow",
        workflow_name: "review",
        description: "Review the feature spec",
        session_id: "sdk-session-workflow",
        uuid: "workflow-started-2",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "wf-agent-2",
        subagent_type: "reviewer",
        description: "Review the draft",
        session_id: "sdk-session-workflow",
        uuid: "workflow-agent-started-2",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const workflowStarted = runtimeEvents.find(
        (event) => event.type === "task.started" && event.payload.taskId === "wf-1",
      );
      assert.equal(workflowStarted?.type, "task.started");
      if (workflowStarted?.type === "task.started") {
        assert.equal(workflowStarted.payload.taskType, "local_workflow");
        assert.equal(workflowStarted.payload.workflowName, "spec");
        assert.equal(workflowStarted.payload.workflowTaskId, undefined);
      }

      const agentStarted = runtimeEvents.find(
        (event) => event.type === "task.started" && event.payload.taskId === "wf-agent-1",
      );
      assert.equal(agentStarted?.type, "task.started");
      if (agentStarted?.type === "task.started") {
        assert.equal(agentStarted.payload.subagentType, "researcher");
        assert.equal(agentStarted.payload.workflowTaskId, "wf-1");
      }

      const agentProgress = runtimeEvents.find(
        (event) => event.type === "task.progress" && event.payload.taskId === "wf-agent-1",
      );
      assert.equal(agentProgress?.type, "task.progress");
      if (agentProgress?.type === "task.progress") {
        assert.equal(agentProgress.payload.workflowTaskId, "wf-1");
        assert.deepEqual(agentProgress.payload.usage, {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 4_500,
        });
      }

      const agentUpdated = runtimeEvents.find(
        (event) => event.type === "task.updated" && event.payload.taskId === "wf-agent-1",
      );
      assert.equal(agentUpdated?.type, "task.updated");
      if (agentUpdated?.type === "task.updated") {
        assert.equal(agentUpdated.payload.status, "paused");
        assert.equal(agentUpdated.payload.workflowTaskId, "wf-1");
      }

      const agentCompleted = runtimeEvents.find(
        (event) => event.type === "task.completed" && event.payload.taskId === "wf-agent-1",
      );
      assert.equal(agentCompleted?.type, "task.completed");
      if (agentCompleted?.type === "task.completed") {
        assert.equal(agentCompleted.payload.status, "completed");
        assert.equal(agentCompleted.payload.workflowTaskId, "wf-1");
      }

      const ambiguousAgentStarted = runtimeEvents.find(
        (event) => event.type === "task.started" && event.payload.taskId === "wf-agent-2",
      );
      assert.equal(ambiguousAgentStarted?.type, "task.started");
      if (ambiguousAgentStarted?.type === "task.started") {
        assert.equal(ambiguousAgentStarted.payload.workflowTaskId, undefined);
      }

      const ambientBashStarted = runtimeEvents.find(
        (event) => event.type === "task.started" && event.payload.taskId === "ambient-bash-1",
      );
      assert.equal(ambientBashStarted?.type, "task.started");
      if (ambientBashStarted?.type === "task.started") {
        assert.equal(ambientBashStarted.payload.workflowTaskId, undefined);
      }

      const stripSubagentStarted = runtimeEvents.find(
        (event) => event.type === "task.started" && event.payload.taskId === "strip-subagent-1",
      );
      assert.equal(stripSubagentStarted?.type, "task.started");
      if (stripSubagentStarted?.type === "task.started") {
        assert.equal(stripSubagentStarted.payload.workflowTaskId, undefined);
      }

      yield* adapter.stopTask(session.threadId, "wf-1");
      assert.deepEqual(harness.query.stopTaskCalls, ["wf-1"]);
      assert.equal(harness.query.interruptCalls.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("retires paused workflows from live task association", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => event.type === "task.started" && event.payload.taskId === "agent-after-pause",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "wf-paused",
        task_type: "local_workflow",
        workflow_name: "paused workflow",
        description: "Pause before the next task",
        session_id: "sdk-session-workflow-paused",
        uuid: "workflow-paused-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "wf-paused",
        patch: { status: "paused" },
        session_id: "sdk-session-workflow-paused",
        uuid: "workflow-paused-updated",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "agent-after-pause",
        subagent_type: "researcher",
        description: "Unrelated task",
        session_id: "sdk-session-workflow-paused",
        uuid: "agent-after-pause-started",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const unrelatedAgent = runtimeEvents.find(
        (event) => event.type === "task.started" && event.payload.taskId === "agent-after-pause",
      );
      assert.equal(unrelatedAgent?.type, "task.started");
      if (unrelatedAgent?.type === "task.started") {
        assert.equal(unrelatedAgent.payload.workflowTaskId, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("surfaces workflow meta, launch identifiers, and final agents on task events", () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "claude-workflow-output-"));
    const harness = makeHarness();
    const workflowScript = `export const meta = {
  name: "spec",
  description: "Draft the feature spec",
  phases: [
    { title: "One", detail: "Research" },
    { title: "Two" },
  ],
};

const research = await agent("Research prior art", { label: "gamma-agent", phase: "One" });
await agent("Draft the spec", { label: "delta-agent", phase: "Two" });
`;
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(outputDir, {
            recursive: true,
            force: true,
          }),
        ),
      );
      const outputFile = path.join(outputDir, "wf-real-1-output.json");
      writeFileSync(
        outputFile,
        JSON.stringify({
          workflowProgress: [
            { type: "workflow_phase", title: "One" },
            {
              type: "workflow_agent",
              label: "gamma-agent",
              phaseIndex: 0,
              agentId: "agent-1",
              model: "haiku",
              state: "completed",
            },
            { type: "workflow_agent", label: "delta-agent", phaseIndex: 1, state: "completed" },
          ],
        }),
      );

      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => event.type === "task.completed" && event.payload.taskId === "wf-real-1",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-workflow-meta",
        uuid: "stream-workflow-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-workflow-1",
            name: "Workflow",
            input: { script: workflowScript },
          },
        },
      } as unknown as SDKMessage);

      // task_started carries the full script text as `prompt`.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "wf-real-1",
        task_type: "local_workflow",
        workflow_name: "spec",
        tool_use_id: "tool-workflow-1",
        description: "Draft the feature spec",
        prompt: workflowScript,
        session_id: "sdk-session-workflow-meta",
        uuid: "workflow-meta-started",
      } as unknown as SDKMessage);

      // Member agents emit no task events of their own; the workflow's own
      // progress carries "<phase>: <label>" descriptions.
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "wf-real-1",
        tool_use_id: "tool-workflow-1",
        description: "One: gamma-agent",
        usage: { total_tokens: 900, tool_uses: 4, duration_ms: 5_000 },
        session_id: "sdk-session-workflow-meta",
        uuid: "workflow-meta-progress",
      } as unknown as SDKMessage);

      // Older Workflow results omit taskType but still carry the launch
      // identifiers needed for resume and transcript polling.
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-workflow-meta",
        uuid: "workflow-meta-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-workflow-1",
              content: "Workflow running in background",
            },
          ],
        },
        tool_use_result: {
          status: "async_launched",
          taskId: "wf-real-1",
          workflowName: "spec",
          runId: "wf_abc123",
          summary: "Launched",
          transcriptDir: outputDir,
          scriptPath: "/sessions/abc/workflow-spec.ts",
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "wf-real-1",
        patch: { status: "completed" },
        session_id: "sdk-session-workflow-meta",
        uuid: "workflow-meta-updated",
      } as unknown as SDKMessage);

      // The final notification can arrive after the terminal status patch. It
      // must still backfill authoritative per-agent state from output_file.
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "wf-real-1",
        tool_use_id: "tool-workflow-1",
        status: "completed",
        output_file: outputFile,
        summary: "Workflow finished.",
        usage: { total_tokens: 2_000, tool_uses: 9, duration_ms: 60_000 },
        session_id: "sdk-session-workflow-meta",
        uuid: "workflow-meta-notification",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const workflowStarted = runtimeEvents.find(
        (event) => event.type === "task.started" && event.payload.taskId === "wf-real-1",
      );
      assert.equal(workflowStarted?.type, "task.started");
      if (workflowStarted?.type === "task.started") {
        assert.equal(workflowStarted.payload.workflowName, "spec");
        assert.deepEqual(workflowStarted.payload.workflowPhases, [
          { title: "One", detail: "Research" },
          { title: "Two" },
        ]);
        assert.deepEqual(workflowStarted.payload.workflowAgentPhases, {
          "gamma-agent": "One",
          "delta-agent": "Two",
        });
      }

      const workflowProgress = runtimeEvents.find(
        (event) => event.type === "task.progress" && event.payload.taskId === "wf-real-1",
      );
      assert.equal(workflowProgress?.type, "task.progress");
      if (workflowProgress?.type === "task.progress") {
        assert.equal(workflowProgress.payload.description, "One: gamma-agent");
      }

      const workflowLaunch = runtimeEvents.find(
        (event) => event.type === "task.updated" && event.payload.taskId === "wf-real-1",
      );
      assert.equal(workflowLaunch?.type, "task.updated");
      if (workflowLaunch?.type === "task.updated") {
        assert.equal(workflowLaunch.payload.workflowRunId, "wf_abc123");
        assert.equal(workflowLaunch.payload.workflowScriptPath, "/sessions/abc/workflow-spec.ts");
      }

      const workflowCompleted = runtimeEvents.find(
        (event) => event.type === "task.completed" && event.payload.taskId === "wf-real-1",
      );
      assert.equal(workflowCompleted?.type, "task.completed");
      if (workflowCompleted?.type === "task.completed") {
        assert.deepEqual(workflowCompleted.payload.workflowAgents, [
          {
            label: "gamma-agent",
            phaseIndex: 0,
            agentId: "agent-1",
            model: "haiku",
            state: "completed",
          },
          { label: "delta-agent", phaseIndex: 1, state: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("polls the workflow transcript directory into live agent snapshots", () => {
    const transcriptDir = mkdtempSync(path.join(os.tmpdir(), "claude-workflow-transcripts-"));
    const harness = makeHarness({ workflowRuntimePollIntervalMs: 25 });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(transcriptDir, { recursive: true, force: true })),
      );
      writeFileSync(
        path.join(transcriptDir, "journal.jsonl"),
        `${JSON.stringify({ type: "started", key: "v2:abc", agentId: "agent-live-1" })}\n`,
      );
      writeFileSync(
        path.join(transcriptDir, "agent-agent-live-1.jsonl"),
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "Research prior art in depth." },
            timestamp: "2026-07-14T22:48:58.400Z",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              id: "msg_1",
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "tool_use", id: "toolu_1", name: "WebSearch", input: {} }],
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: 17_276,
                cache_read_input_tokens: 0,
                output_tokens: 97,
              },
            },
            timestamp: "2026-07-14T22:49:14.490Z",
          }),
          "",
        ].join("\n"),
      );

      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => event.type === "task.progress" && event.payload.workflowAgents !== undefined,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-workflow-poll",
        uuid: "stream-workflow-poll-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-workflow-poll",
            name: "Workflow",
            input: { script: "export const meta = { name: 'spec' };" },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "wf-poll-1",
        task_type: "local_workflow",
        workflow_name: "spec",
        tool_use_id: "tool-workflow-poll",
        description: "Draft the feature spec",
        session_id: "sdk-session-workflow-poll",
        uuid: "workflow-poll-started",
      } as unknown as SDKMessage);
      // Progress description supplies the label the poller zips onto the
      // journal's first started agent.
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "wf-poll-1",
        tool_use_id: "tool-workflow-poll",
        description: "One: gamma-agent",
        usage: { total_tokens: 900, tool_uses: 4, duration_ms: 5_000 },
        session_id: "sdk-session-workflow-poll",
        uuid: "workflow-poll-progress",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-workflow-poll",
        uuid: "workflow-poll-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-workflow-poll",
              content: "Workflow running in background",
            },
          ],
        },
        tool_use_result: {
          status: "async_launched",
          taskId: "wf-poll-1",
          taskType: "local_workflow",
          workflowName: "spec",
          runId: "wf_poll123",
          summary: "Launched",
          transcriptDir,
          scriptPath: "/sessions/abc/workflow-spec.ts",
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      // Settle the workflow so the poller fiber is interrupted.
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "wf-poll-1",
        tool_use_id: "tool-workflow-poll",
        status: "completed",
        summary: "Workflow finished.",
        session_id: "sdk-session-workflow-poll",
        uuid: "workflow-poll-notification",
      } as unknown as SDKMessage);

      const snapshotEvent = runtimeEvents.findLast(
        (event) => event.type === "task.progress" && event.payload.workflowAgents !== undefined,
      );
      assert.equal(snapshotEvent?.type, "task.progress");
      if (snapshotEvent?.type === "task.progress") {
        assert.equal(snapshotEvent.payload.taskId, "wf-poll-1");
        assert.deepEqual(snapshotEvent.payload.workflowAgents, [
          {
            agentId: "agent-live-1",
            label: "gamma-agent",
            model: "claude-sonnet-4-6",
            state: "running",
            tokens: 17_376,
            toolCalls: 1,
            recentToolNames: ["WebSearch"],
            promptPreview: "Research prior art in depth.",
            startedAt: "2026-07-14T22:48:58.400Z",
            lastActivityAt: "2026-07-14T22:49:14.490Z",
          },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("backfills live-observed effort into the settled workflow snapshots", () => {
    const transcriptDir = mkdtempSync(path.join(os.tmpdir(), "claude-workflow-effort-"));
    const harness = makeHarness({ workflowRuntimePollIntervalMs: 25 });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(transcriptDir, { recursive: true, force: true })),
      );
      writeFileSync(
        path.join(transcriptDir, "journal.jsonl"),
        `${JSON.stringify({ type: "started", key: "v2:abc", agentId: "agent-live-1" })}\n`,
      );
      // The transcript is the only place effort appears: assistant lines carry
      // it as a top-level field next to `message`.
      writeFileSync(
        path.join(transcriptDir, "agent-agent-live-1.jsonl"),
        `${JSON.stringify({
          type: "assistant",
          effort: "xhigh",
          message: {
            id: "msg_1",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "tool_use", id: "toolu_1", name: "WebSearch", input: {} }],
          },
          timestamp: "2026-07-14T22:49:14.490Z",
        })}\n`,
      );
      // The settled output file carries model/state but no effort.
      const outputFile = path.join(transcriptDir, "workflow-output.json");
      writeFileSync(
        outputFile,
        JSON.stringify({
          workflowProgress: [
            {
              type: "workflow_agent",
              label: "gamma-agent",
              agentId: "agent-live-1",
              model: "claude-sonnet-4-6",
              state: "done",
            },
          ],
        }),
      );

      const adapter = yield* ClaudeAdapter;
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.tap((event) => Effect.sync(() => seen.push(event))),
        Stream.takeUntil((event) => event.type === "task.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-workflow-effort",
        uuid: "stream-workflow-effort-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-workflow-effort",
            name: "Workflow",
            input: { script: "export const meta = { name: 'spec' };" },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "wf-effort-1",
        task_type: "local_workflow",
        workflow_name: "spec",
        tool_use_id: "tool-workflow-effort",
        description: "Draft the feature spec",
        session_id: "sdk-session-workflow-effort",
        uuid: "workflow-effort-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-workflow-effort",
        uuid: "workflow-effort-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-workflow-effort",
              content: "Workflow running in background",
            },
          ],
        },
        tool_use_result: {
          status: "async_launched",
          taskId: "wf-effort-1",
          taskType: "local_workflow",
          workflowName: "spec",
          runId: "wf_effort123",
          summary: "Launched",
          transcriptDir,
          scriptPath: "/sessions/abc/workflow-spec.ts",
        },
      } as unknown as SDKMessage);

      // Wait for the poller to fold the transcript (and its effort) into the
      // runtime state before the run settles. Real-time wait: the poller runs
      // on the live runtime, while this test body is on the test clock.
      while (
        !seen.some(
          (event) => event.type === "task.progress" && event.payload.workflowAgents !== undefined,
        )
      ) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      }

      // Regression: a terminal task_updated tears the poller down first; the
      // later task_notification must still see the runtime state to backfill.
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "wf-effort-1",
        patch: { status: "completed" },
        session_id: "sdk-session-workflow-effort",
        uuid: "workflow-effort-updated",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "wf-effort-1",
        tool_use_id: "tool-workflow-effort",
        status: "completed",
        output_file: outputFile,
        summary: "Workflow finished.",
        session_id: "sdk-session-workflow-effort",
        uuid: "workflow-effort-notification",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const workflowCompleted = runtimeEvents.find(
        (event) => event.type === "task.completed" && event.payload.taskId === "wf-effort-1",
      );
      assert.equal(workflowCompleted?.type, "task.completed");
      if (workflowCompleted?.type === "task.completed") {
        assert.deepEqual(workflowCompleted.payload.workflowAgents, [
          {
            label: "gamma-agent",
            agentId: "agent-live-1",
            model: "claude-sonnet-4-6",
            effort: "xhigh",
            state: "done",
          },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps task_updated status patches onto the subagent thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "session.state.changed" &&
            event.providerRefs?.providerThreadId === "tool-task-2",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-2",
        tool_use_id: "tool-task-2",
        subagent_type: "code-reviewer",
        description: "Pausable review",
        session_id: "sdk-session-updated",
        uuid: "task-started-2",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-2",
        patch: { status: "paused" },
        session_id: "sdk-session-updated",
        uuid: "task-updated-2",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const stateChanged = runtimeEvents.find(
        (event) =>
          event.type === "session.state.changed" &&
          event.providerRefs?.providerThreadId === "tool-task-2",
      );
      assert.equal(stateChanged?.type, "session.state.changed");
      if (stateChanged?.type === "session.state.changed") {
        assert.equal(stateChanged.payload.state, "waiting");
        assert.equal(stateChanged.providerRefs?.providerParentThreadId, THREAD_ID);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("retires a subagent on a terminal task_updated without task_notification", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-terminal-update",
        tool_use_id: "tool-task-terminal-update",
        subagent_type: "code-reviewer",
        description: "Terminal patch only",
        session_id: "sdk-session-terminal-update",
        uuid: "task-started-terminal-update",
      } as unknown as SDKMessage);

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
      yield* adapter.steerSubagent(session.threadId, "tool-task-terminal-update", {
        input: "queued before completion",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-terminal-update",
        patch: { status: "completed" },
        session_id: "sdk-session-terminal-update",
        uuid: "task-updated-terminal-update",
      } as unknown as SDKMessage);

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
      const result = yield* adapter
        .steerSubagent(session.threadId, "tool-task-terminal-update", { input: "too late" })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ProviderAdapterRequestError);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("suppresses Claude ede_diagnostic text emitted during a user interrupt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-abort",
        uuid: "assistant-abort-diagnostic",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-abort-diagnostic",
          content: [
            {
              type: "text",
              text: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        lifecycleGeneration: "generation-claude-a",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );
      assert.equal(
        runtimeEvents.every((event) => event.lifecycleGeneration === "generation-claude-a"),
        true,
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats an external SIGTERM (exit code 143) as a benign suspend", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      // The Claude SDK surfaces an external SIGTERM as this error string.
      harness.query.fail(new Error("Claude Code process exited with code 143"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();

      // A graceful termination must not surface a runtime.error toast.
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.error"),
        false,
      );

      const turnCompleted = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(
          turnCompleted.payload.errorMessage,
          "Claude runtime stopped and will resume on your next message.",
        );
      }

      // The session is torn down so the next message resumes from the cursor.
      assert.equal(
        runtimeEvents.some((event) => event.type === "session.exited"),
        true,
      );
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("invalidates a missing resumed conversation reported by the async stream", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: THREAD_ID,
          resume: "44c0b890-8775-4f30-b47f-0709d29cc9e1",
          resumeSessionAt: "assistant-stale",
          turnCount: 2,
        },
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "continue",
        attachments: [],
      });

      harness.query.fail(
        new Error("No conversation found with session ID: 44c0b890-8775-4f30-b47f-0709d29cc9e1"),
      );

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "runtime.error",
          "turn.completed",
          "session.exited",
        ],
      );
      const turnCompleted = runtimeEvents[5];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(turnCompleted.providerRefs?.providerThreadId, undefined);
      }
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("retains Claude session ownership until subprocess-tree exit is proven", () => {
    const query = new FakeClaudeQuery();
    let proveExit: (() => void) | undefined;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let teardownCalls = 0;
    const ownedProcess = {
      pid: 73_311,
      exitCode: 0,
      signalCode: null,
    } as unknown as ClaudeOwnedProcess;
    const layer = makeClaudeAdapterLive({
      spawnClaudeCodeProcess: () => ownedProcess,
      teardownProcessTree: async () => {
        teardownCalls += 1;
        await exitProof;
        return { escalated: false, signalErrors: [] };
      },
      createQuery: (input) => {
        input.options.spawnClaudeCodeProcess?.({
          command: "claude",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        return query;
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const stopping = yield* adapter.stopSession(THREAD_ID).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.equal(query.closeCalls, 1);
      assert.equal(teardownCalls, 1);
      assert.equal((yield* adapter.listSessions()).length, 1);

      proveExit?.();
      yield* Fiber.join(stopping);
      assert.equal((yield* adapter.listSessions()).length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("retains Claude ownership and retries when teardown proof fails", () => {
    const query = new FakeClaudeQuery();
    let teardownCalls = 0;
    const ownedProcess = {
      pid: 73_312,
      exitCode: 0,
      signalCode: null,
    } as unknown as ClaudeOwnedProcess;
    const layer = makeClaudeAdapterLive({
      spawnClaudeCodeProcess: () => ownedProcess,
      teardownProcessTree: async () => {
        teardownCalls += 1;
        if (teardownCalls === 1) {
          throw new Error("rootExited=false; surviving process remains");
        }
        return { escalated: true, signalErrors: [] };
      },
      createQuery: (input) => {
        input.options.spawnClaudeCodeProcess?.({
          command: "claude",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        return query;
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const failedStop = yield* Effect.exit(adapter.stopSession(THREAD_ID));
      assert.isTrue(Exit.isFailure(failedStop));
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      assert.equal((yield* adapter.listSessions()).length, 1);

      yield* adapter.stopSession(THREAD_ID);
      assert.equal(teardownCalls, 2);
      assert.equal((yield* adapter.listSessions()).length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("blocks a retry when createQuery spawned before failing cleanup", () => {
    const query = new FakeClaudeQuery();
    let allowStart = false;
    let createCalls = 0;
    let spawnCalls = 0;
    let teardownCalls = 0;
    const ownedProcess = {
      pid: 73_313,
      exitCode: null,
      signalCode: null,
      once: () => undefined,
      removeListener: () => undefined,
    } as unknown as ClaudeOwnedProcess;
    const layer = makeClaudeAdapterLive({
      spawnClaudeCodeProcess: () => {
        spawnCalls += 1;
        return ownedProcess;
      },
      teardownProcessTree: async () => {
        teardownCalls += 1;
        if (teardownCalls < 3) {
          throw new Error("rootExited=false; surviving process remains");
        }
        return { escalated: true, signalErrors: [] };
      },
      createQuery: (input) => {
        createCalls += 1;
        input.options.spawnClaudeCodeProcess?.({
          command: "claude",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        if (!allowStart) {
          throw new Error("simulated failure after spawn");
        }
        return query;
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const input = {
        threadId: THREAD_ID,
        provider: "claudeAgent" as const,
        runtimeMode: "full-access" as const,
      };

      assert.isTrue(Exit.isFailure(yield* Effect.exit(adapter.startSession(input))));
      assert.equal(createCalls, 1);
      assert.equal(spawnCalls, 1);
      assert.equal(teardownCalls, 1);

      // The second attempt retries teardown and fails before createQuery can
      // spawn another process.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(adapter.startSession(input))));
      assert.equal(createCalls, 1);
      assert.equal(spawnCalls, 1);
      assert.equal(teardownCalls, 2);

      allowStart = true;
      yield* adapter.startSession(input);
      assert.equal(createCalls, 2);
      assert.equal(spawnCalls, 2);
      assert.equal(teardownCalls, 3);

      yield* adapter.stopSession(THREAD_ID);
      assert.equal(teardownCalls, 4);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("blocks command rediscovery until an unproven process tree is reaped", () => {
    const query = new FakeClaudeQuery();
    let spawnCalls = 0;
    let teardownCalls = 0;
    const ownedProcess = {
      pid: 73_314,
      exitCode: null,
      signalCode: null,
      once: () => undefined,
      removeListener: () => undefined,
    } as unknown as ClaudeOwnedProcess;
    const layer = makeClaudeAdapterLive({
      spawnClaudeCodeProcess: () => {
        spawnCalls += 1;
        return ownedProcess;
      },
      teardownProcessTree: async () => {
        teardownCalls += 1;
        if (teardownCalls < 3) {
          throw new Error("rootExited=false; discovery process remains");
        }
        return { escalated: true, signalErrors: [] };
      },
      createQuery: (input) => {
        input.options.spawnClaudeCodeProcess?.({
          command: "claude",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        return query;
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const listCommands = adapter.listCommands;
      if (!listCommands) {
        assert.fail("Expected Claude adapter to support command discovery.");
      }
      const input = {
        provider: "claudeAgent" as const,
        cwd: "/tmp/project",
        forceReload: true,
      };

      assert.isTrue(Exit.isFailure(yield* Effect.exit(listCommands(input))));
      assert.equal(spawnCalls, 1);
      assert.equal(teardownCalls, 1);

      // The retry must fail while reaping the retained owner, before another
      // temporary process can be spawned.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(listCommands(input))));
      assert.equal(spawnCalls, 1);
      assert.equal(teardownCalls, 2);

      yield* adapter.stopAll();
      assert.equal(teardownCalls, 3);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "retains command discovery ownership when query construction throws after spawn",
    () => {
      let spawnCalls = 0;
      let createCalls = 0;
      let teardownCalls = 0;
      const ownedProcess = {
        pid: 73_315,
        exitCode: null,
        signalCode: null,
        once: () => undefined,
        removeListener: () => undefined,
      } as unknown as ClaudeOwnedProcess;
      const layer = makeClaudeAdapterLive({
        spawnClaudeCodeProcess: () => {
          spawnCalls += 1;
          return ownedProcess;
        },
        teardownProcessTree: async () => {
          teardownCalls += 1;
          if (teardownCalls < 3) {
            throw new Error("rootExited=false; discovery construction process remains");
          }
          return { escalated: true, signalErrors: [] };
        },
        createQuery: (input) => {
          createCalls += 1;
          input.options.spawnClaudeCodeProcess?.({
            command: "claude",
            args: [],
            env: {},
            signal: new AbortController().signal,
          });
          throw new Error("simulated discovery construction failure after spawn");
        },
      }).pipe(
        Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
        Layer.provideMerge(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          assert.fail("Expected Claude adapter to support command discovery.");
        }
        const input = {
          provider: "claudeAgent" as const,
          cwd: "/tmp/project",
          forceReload: true,
        };

        assert.isTrue(Exit.isFailure(yield* Effect.exit(listCommands(input))));
        assert.equal(createCalls, 1);
        assert.equal(spawnCalls, 1);
        assert.equal(teardownCalls, 1);

        assert.isTrue(Exit.isFailure(yield* Effect.exit(listCommands(input))));
        assert.equal(createCalls, 1);
        assert.equal(spawnCalls, 1);
        assert.equal(teardownCalls, 2);

        yield* adapter.stopAll();
        assert.equal(teardownCalls, 3);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = makeClaudeAdapterLive({
      createQuery: (input) => {
        // Simulate the SDK consuming the prompt iterable
        (async () => {
          try {
            for await (const _message of input.prompt) {
              /* SDK processes user messages */
            }
          } catch (error) {
            promptConsumerError = error;
          }
        })();
        return query;
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, () => Effect.void),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "suppresses thinking_tokens/task_updated telemetry and de-dupes each unknown Claude subtype once",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "task.progress"),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        // High-frequency reasoning telemetry — must never reach the timeline.
        for (let i = 0; i < 3; i += 1) {
          harness.query.emit({
            type: "system",
            subtype: "thinking_tokens",
            estimated_tokens: 50 * (i + 1),
            estimated_tokens_delta: 50,
            session_id: "sdk-session-thinking",
            uuid: `thinking-${i}`,
          } as unknown as SDKMessage);
        }

        // Incremental task patches we intentionally drop — must not warn either.
        for (let i = 0; i < 3; i += 1) {
          harness.query.emit({
            type: "system",
            subtype: "task_updated",
            session_id: "sdk-session-task-updated",
            uuid: `task-updated-${i}`,
          } as unknown as SDKMessage);
        }

        // Two distinct unknown subtypes, each emitted twice — each must surface
        // exactly one warning (per-kind de-dup), so two warnings in total.
        for (const subtype of ["future_unknown_subtype", "another_unknown_subtype"]) {
          for (let i = 0; i < 2; i += 1) {
            harness.query.emit({
              type: "system",
              subtype,
              session_id: `sdk-session-${subtype}`,
              uuid: `${subtype}-${i}`,
            } as unknown as SDKMessage);
          }
        }

        // Sentinel that produces a real event so the collector terminates.
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-sentinel",
          description: "sentinel",
          usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 },
          session_id: "sdk-session-sentinel",
          uuid: "task-progress-sentinel",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const warningMessages = runtimeEvents.flatMap((event) =>
          event.type === "runtime.warning" ? [event.payload.message] : [],
        );

        assert.equal(warningMessages.length, 2);
        assert.equal(
          warningMessages.some((message) => message.includes("thinking_tokens")),
          false,
        );
        assert.equal(
          warningMessages.some((message) => message.includes("task_updated")),
          false,
        );
        assert.equal(
          warningMessages.some((message) => message.includes("future_unknown_subtype")),
          true,
        );
        assert.equal(
          warningMessages.some((message) => message.includes("another_unknown_subtype")),
          true,
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("maps Claude TodoWrite tool input into shared turn plan updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "build the feature",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-start",
        uuid: "stream-todo-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "Inspect files",
                  activeForm: "Inspecting files",
                  status: "in_progress",
                },
                {
                  content: "Patch UI",
                  status: "pending",
                },
                {
                  content: "Run checks",
                  status: "completed",
                },
              ],
            },
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const taskEvent = runtimeEvents.find((event) => event.type === "turn.tasks.updated");
      assert.equal(taskEvent?.type, "turn.tasks.updated");
      if (taskEvent?.type === "turn.tasks.updated") {
        assert.deepEqual(taskEvent.payload.tasks, [
          { task: "Inspecting files", status: "inProgress" },
          { task: "Patch UI", status: "pending" },
          { task: "Run checks", status: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates shared turn task lists from Claude TodoWrite json deltas", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "ship the patch",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-delta",
        uuid: "stream-todo-delta-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-todo-delta-1",
            name: "TodoWrite",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-delta",
        uuid: "stream-todo-delta-update",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"todos":[{"content":"Inspect files","status":"pending"},{"content":"Patch UI","activeForm":"Patching UI","status":"in_progress"}]}',
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const taskEvent = runtimeEvents.findLast((event) => event.type === "turn.tasks.updated");
      assert.equal(taskEvent?.type, "turn.tasks.updated");
      if (taskEvent?.type === "turn.tasks.updated") {
        assert.deepEqual(taskEvent.payload.tasks, [
          { task: "Inspect files", status: "pending" },
          { task: "Patching UI", status: "inProgress" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("tracks Claude TaskCreate and TaskUpdate results as a shared task list", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "build the feature",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-create",
        uuid: "stream-task-create",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-create-1",
            name: "TaskCreate",
            input: {
              subject: "Inspect files",
              description: "Find the relevant files",
              activeForm: "Inspecting files",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-create",
        uuid: "user-task-create-result",
        parent_tool_use_id: null,
        tool_use_result: {
          task: { id: "task-1", subject: "Inspect files" },
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-create-1",
              content: "Task created successfully",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-update",
        uuid: "stream-task-update",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-task-update-1",
            name: "TaskUpdate",
            input: {
              task_id: "task-1",
              status: "in_progress",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-update",
        uuid: "user-task-update-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-update-1",
              content: JSON.stringify({
                success: true,
                taskId: "task-1",
                updatedFields: ["status"],
              }),
            },
          ],
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const taskEvents = runtimeEvents.filter((event) => event.type === "turn.tasks.updated");
      assert.equal(taskEvents.length, 2);
      assert.deepEqual(taskEvents[0]?.payload.tasks, [
        { task: "Inspect files", status: "pending" },
      ]);
      assert.deepEqual(taskEvents[1]?.payload.tasks, [
        { task: "Inspecting files", status: "inProgress" },
      ]);

      const taskCreateStarted = runtimeEvents.find(
        (event) => event.type === "item.started" && event.itemId === "tool-task-create-1",
      );
      assert.equal(taskCreateStarted?.type, "item.started");
      if (taskCreateStarted?.type === "item.started") {
        assert.equal(taskCreateStarted.payload.itemType, "plan");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rebuilds Claude tasks from TaskList and refreshes them from TaskGet", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "continue the work",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-list",
        uuid: "stream-task-list",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-list-1",
            name: "TaskList",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-list",
        uuid: "user-task-list-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-list-1",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    tasks: [
                      {
                        id: "task-1",
                        subject: "Inspect files",
                        status: "completed",
                        blockedBy: [],
                      },
                      {
                        id: "task-2",
                        subject: "Patch UI",
                        status: "pending",
                        blockedBy: ["task-1"],
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-get",
        uuid: "stream-task-get",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-task-get-1",
            name: "TaskGet",
            input: { id: "task-2" },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-get",
        uuid: "user-task-get-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-get-1",
              content: {
                task: {
                  id: "task-2",
                  subject: "Patch the UI",
                  description: "Render Claude tasks",
                  status: "in_progress",
                  blocks: [],
                  blockedBy: [],
                },
              },
            },
          ],
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const taskEvents = runtimeEvents.filter((event) => event.type === "turn.tasks.updated");
      assert.equal(taskEvents.length, 2);
      assert.deepEqual(taskEvents[0]?.payload.tasks, [
        { task: "Inspect files", status: "completed" },
        { task: "Patch UI", status: "pending" },
      ]);
      assert.deepEqual(taskEvents[1]?.payload.tasks, [
        { task: "Inspect files", status: "completed" },
        { task: "Patch the UI", status: "inProgress" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("restores unfinished Claude tasks from the resume cursor on the next turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const taskEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.tasks.updated"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor: {
          threadId: THREAD_ID,
          trackedTasks: [
            {
              id: "task-1",
              subject: "Inspect files",
              description: "Find the relevant files",
              activeForm: "Inspecting files",
              status: "in_progress",
              owner: null,
              blockedBy: [],
            },
            {
              id: "task-2",
              subject: "Patch UI",
              status: "pending",
              blockedBy: ["task-1"],
            },
          ],
        },
      });

      assert.deepEqual((session.resumeCursor as { trackedTasks?: unknown })?.trackedTasks, [
        {
          id: "task-1",
          subject: "Inspect files",
          description: "Find the relevant files",
          activeForm: "Inspecting files",
          status: "in_progress",
          owner: undefined,
          blockedBy: [],
        },
        {
          id: "task-2",
          subject: "Patch UI",
          description: undefined,
          activeForm: undefined,
          status: "pending",
          owner: undefined,
          blockedBy: ["task-1"],
        },
      ]);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "continue",
        attachments: [],
      });

      const taskEvents = Array.from(yield* Fiber.join(taskEventFiber));
      assert.deepEqual(taskEvents[0]?.payload.tasks, [
        { task: "Inspecting files", status: "inProgress" },
        { task: "Patch UI", status: "pending" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("clears a completed Claude task group before the next turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const taskEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.tasks.updated"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor: {
          threadId: THREAD_ID,
          trackedTasks: [
            {
              id: "old-task",
              subject: "Old completed work",
              status: "completed",
              blockedBy: [],
            },
          ],
        },
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "start unrelated work",
        attachments: [],
      });
      assert.equal("trackedTasks" in (turn.resumeCursor as Record<string, unknown>), false);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-new-task-group",
        uuid: "stream-new-task-create",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-new-task-create",
            name: "TaskCreate",
            input: {
              subject: "New work",
              description: "Handle the new request",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-new-task-group",
        uuid: "user-new-task-create-result",
        parent_tool_use_id: null,
        tool_use_result: {
          task: { id: "new-task", subject: "New work" },
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-new-task-create",
              content: "Task created successfully",
            },
          ],
        },
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventFiber));
      assert.deepEqual(taskEvents[0]?.payload.tasks, [{ task: "New work", status: "pending" }]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits thread token usage updates from Claude task progress", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 321,
            lastUsedTokens: 321,
            maxTokens: 200_000,
            toolUses: 2,
            durationMs: 654,
          },
        });
      }
      assert.equal(progressEvent?.type, "task.progress");
      if (usageEvent && progressEvent) {
        assert.notStrictEqual(usageEvent.eventId, progressEvent.eventId);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            outputTokens: 679,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("clamps oversized Claude usage to the reported context window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 535000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "preserves oversized Claude result totals after task progress snapshots are recorded",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-usage-clamped",
          description: "Thinking through the patch",
          usage: {
            total_tokens: 190000,
          },
          session_id: "sdk-session-task-usage-clamped",
          uuid: "task-usage-progress-clamped",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1200,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-result-usage-clamped-after-progress",
          usage: {
            total_tokens: 535000,
          },
          modelUsage: {
            "claude-opus-4-6": {
              contextWindow: 200000,
              maxOutputTokens: 64000,
            },
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const usageEvents = runtimeEvents.filter(
          (event) => event.type === "thread.token-usage.updated",
        );
        const finalUsageEvent = usageEvents.at(-1);
        assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
        if (finalUsageEvent?.type === "thread.token-usage.updated") {
          assert.deepEqual(finalUsageEvent.payload, {
            usage: {
              usedTokens: 190000,
              lastUsedTokens: 190000,
              totalProcessedTokens: 535000,
              maxTokens: 200000,
            },
          });
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("does not let stale result metadata shrink a known Claude model capacity", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-window-shrinks",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 190000,
        },
        session_id: "sdk-session-task-usage-window-shrinks",
        uuid: "task-usage-window-shrinks",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-window-shrinks",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 128000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      const finalUsageEvent = usageEvents.at(-1);
      assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
      if (finalUsageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(finalUsageEvent.payload, {
          usage: {
            usedTokens: 190000,
            lastUsedTokens: 190000,
            totalProcessedTokens: 535000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores malformed Claude model usage context windows", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-model-usage-invalid",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 190000,
        },
        session_id: "sdk-session-task-usage-model-usage-invalid",
        uuid: "task-usage-model-usage-invalid",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-model-usage-invalid",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: Number.NaN,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      const finalUsageEvent = usageEvents.at(-1);
      assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
      if (finalUsageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(finalUsageEvent.payload, {
          usage: {
            usedTokens: 190000,
            lastUsedTokens: 190000,
            maxTokens: 200_000,
            totalProcessedTokens: 535000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bridges approval request/response lifecycle through canUseTool", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-approval-1",
        uuid: "stream-approval-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-approval-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
          ],
          toolUseID: "tool-use-1",
          requestId: "request-tool-use-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") {
        return;
      }
      assert.equal(requested.value.type, "request.opened");
      if (requested.value.type !== "request.opened") {
        return;
      }
      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(runtimeRequestId),
        "accept",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "accept");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("registers shared Claude subagent definitions with the SDK query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.isDefined(createInput?.options.agents);
      assert.deepEqual(Object.keys(createInput?.options.agents ?? {}).toSorted(), [
        "build",
        "explore",
        "plan",
        "review",
        "worker-high",
        "worker-low",
        "worker-medium",
        "worker-xhigh",
      ]);

      // Worker tiers carry only an effort override (model inherits so the Agent
      // tool's `model` input composes), and the system prompt teaches the model
      // to pick them per task complexity.
      const workerHigh = createInput?.options.agents?.["worker-high"];
      assert.equal(workerHigh?.effort, "high");
      assert.equal(workerHigh?.model, undefined);
      const systemPrompt = createInput?.options.systemPrompt;
      const append =
        systemPrompt && !Array.isArray(systemPrompt) && typeof systemPrompt === "object"
          ? systemPrompt.append
          : undefined;
      assert.include(append ?? "", "worker-xhigh");
      assert.include(append ?? "", "`model` parameter");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "rewrites inline Claude subagent mentions into explicit Agent-tool instructions",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input:
            "Compare the migration and @review(check regressions) then @explore(find related files)",
          attachments: [],
        });

        const createInput = harness.getLastCreateQueryInput();
        const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
        assert.isDefined(promptText);
        assert.include(promptText ?? "", 'Use the "review" agent for this task:');
        assert.include(promptText ?? "", "check regressions");
        assert.include(promptText ?? "", 'Use the "explore" agent for this task:');
        assert.include(promptText ?? "", "Original user prompt:");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-1",
          requestId: "request-tool-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some" || agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-grep-approval-1",
          requestId: "request-tool-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some" || grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes Claude resume ids without pinning a stale assistant checkpoint", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-99",
        turnCount: 3,
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves durable resume ids across Claude resume hooks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const durableSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const transientHookSessionId = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719";

      const threadStartedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "thread.started",
      ).pipe(Stream.runHead, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: durableSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "continue",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "hook_started",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        session_id: transientHookSessionId,
        uuid: "resume-hook-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "hook_response",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        output: "",
        stdout: "",
        stderr: "",
        outcome: "success",
        session_id: transientHookSessionId,
        uuid: "resume-hook-response",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: durableSessionId,
        uuid: "resume-stream-durable",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-resume-durable",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Fiber.join(threadStartedFiber);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag === "Some" && threadStarted.value.type === "thread.started") {
        const rawPayload =
          threadStarted.value.raw?.payload &&
          typeof threadStarted.value.raw.payload === "object" &&
          "session_id" in threadStarted.value.raw.payload
            ? threadStarted.value.raw.payload.session_id
            : undefined;
        assert.equal(threadStarted.value.payload?.providerThreadId ?? rawPayload, durableSessionId);
      }

      const activeSessions = yield* adapter.listSessions();
      const resumeCursor = activeSessions[0]?.resumeCursor as
        | {
            readonly resume?: string;
          }
        | undefined;
      assert.equal(resumeCursor?.resume, durableSessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses an app-generated Claude session id for fresh sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const sessionResumeCursor = session.resumeCursor as {
        threadId?: string;
        resume?: string;
        turnCount?: number;
      };
      assert.equal(sessionResumeCursor.threadId, THREAD_ID);
      assert.equal(typeof sessionResumeCursor.resume, "string");
      assert.equal(sessionResumeCursor.turnCount, 0);
      assert.match(
        sessionResumeCursor.resume ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, sessionResumeCursor.resume);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reports Claude rollback as restart-owned instead of mutating only local turns", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const firstTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first",
        attachments: [],
      });

      const firstCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-rollback",
        uuid: "result-first",
      } as unknown as SDKMessage);

      const firstCompleted = yield* Fiber.join(firstCompletedFiber);
      assert.equal(firstCompleted._tag, "Some");
      if (firstCompleted._tag === "Some" && firstCompleted.value.type === "turn.completed") {
        assert.equal(String(firstCompleted.value.turnId), String(firstTurn.turnId));
      }

      const secondTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "second",
        attachments: [],
      });

      const secondCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-rollback",
        uuid: "result-second",
      } as unknown as SDKMessage);

      const secondCompleted = yield* Fiber.join(secondCompletedFiber);
      assert.equal(secondCompleted._tag, "Some");
      if (secondCompleted._tag === "Some" && secondCompleted.value.type === "turn.completed") {
        assert.equal(String(secondCompleted.value.turnId), String(secondTurn.turnId));
      }

      const threadBeforeRollback = yield* adapter.readThread(session.threadId);
      assert.equal(threadBeforeRollback.turns.length, 2);

      const rolledBack = yield* Effect.exit(adapter.rollbackThread(session.threadId, 1));
      assert.ok(Exit.isFailure(rolledBack));

      const threadAfterRollback = yield* adapter.readThread(session.threadId);
      assert.equal(threadAfterRollback.turns.length, 2);
      assert.equal(threadAfterRollback.turns[0]?.id, firstTurn.turnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates model on sendTurn when model override is provided", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates the auto-compact budget live without changing the Claude model id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            autoCompactWindow: "1m",
          },
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6"]);
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [{ autoCompactWindow: 1_000_000 }]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits the configured window when the auto-compact budget changes live", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const configuredEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { autoCompactWindow: "1m" },
        },
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "use the default auto-compact budget",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "switch to a discovered model",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude/custom-opus",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        { autoCompactWindow: 200_000 },
        { autoCompactWindow: null },
      ]);
      const configuredEvents = Array.from(yield* Fiber.join(configuredEventsFiber));
      assert.deepEqual(
        configuredEvents.map((event) =>
          event.type === "session.configured" ? event.payload.config.autoCompactWindow : undefined,
        ),
        [1_000_000, 200_000, null],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates the thinking toggle live instead of restarting the session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: { thinking: false },
        },
      });
      const settings = harness.getLastCreateQueryInput()?.options.settings;
      assert.ok(settings && typeof settings === "object");
      assert.equal((settings as { alwaysThinkingEnabled?: boolean }).alwaysThinkingEnabled, false);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: { thinking: true },
        },
        attachments: [],
      });
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [{ alwaysThinkingEnabled: true }]);

      // The same toggle value on the next turn stays quiet.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "continue",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: { thinking: true },
        },
        attachments: [],
      });
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [{ alwaysThinkingEnabled: true }]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("applies effort, fast mode, and ultracode live instead of restarting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-8",
          options: { effort: "high" },
        },
      });
      assert.equal(effortLevelFromOptions(harness.getLastCreateQueryInput()?.options), "high");

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-8",
          options: { effort: "ultracode", fastMode: true },
        },
        attachments: [],
      });
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        { effortLevel: "xhigh", ultracode: true, fastMode: true },
      ]);

      // The same selection on the next turn stays quiet.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "continue",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-8",
          options: { effort: "ultracode", fastMode: true },
        },
        attachments: [],
      });
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        { effortLevel: "xhigh", ultracode: true, fastMode: true },
      ]);

      // Returning to defaults clears the keys from the flag-settings layer.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "wrap up",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-8",
        },
        attachments: [],
      });
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        { effortLevel: "xhigh", ultracode: true, fastMode: true },
        { effortLevel: null, ultracode: null, fastMode: null },
      ]);

      // No restart happened at any point: the original spawn is the only one.
      assert.deepEqual(harness.query.setModelCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("warns once when a turn ingests a large uncached prompt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // Synthetic low-cache-ratio result: ~60k of 61k prompt tokens uncached.
      const uncachedUsage = {
        input_tokens: 5_000,
        cache_creation_input_tokens: 55_000,
        cache_read_input_tokens: 1_000,
        output_tokens: 10,
      };
      for (let i = 0; i < 2; i += 1) {
        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-uncached",
          uuid: `assistant-uncached-${i}`,
          parent_tool_use_id: null,
          message: {
            id: `assistant-message-uncached-${i}`,
            content: [{ type: "text", text: "working" }],
            usage: uncachedUsage,
          },
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-uncached",
        uuid: "result-uncached",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const warningMessages = runtimeEvents.flatMap((event) =>
        event.type === "runtime.warning" ? [event.payload.message] : [],
      );
      // Emitted once per session even though two responses crossed the bar.
      assert.equal(warningMessages.length, 1);
      assert.ok(warningMessages[0]?.includes("uncached prompt tokens"));
      assert.ok(warningMessages[0]?.includes("resume"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("skips redundant setModel when the turn model matches the session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-8",
        },
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-8",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("always enables auto-compaction in the query settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const configuredEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.runHead, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const settings = harness.getLastCreateQueryInput()?.options.settings;
      assert.ok(settings && typeof settings === "object");
      assert.equal((settings as { autoCompactEnabled?: boolean }).autoCompactEnabled, true);
      assert.equal((settings as { autoCompactWindow?: number }).autoCompactWindow, 200_000);

      const configuredEvent = yield* Fiber.join(configuredEventFiber);
      assert.equal(configuredEvent._tag, "Some");
      if (configuredEvent._tag === "Some" && configuredEvent.value.type === "session.configured") {
        assert.equal(configuredEvent.value.payload.config.autoCompactWindow, 200_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("warns immediately when a thread starts with the 1M auto-compact budget", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const warningFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message.includes("1M limit"),
      ).pipe(Stream.runHead, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-8",
          options: { autoCompactWindow: "1m" },
        },
      });

      const warning = yield* Fiber.join(warningFiber);
      assert.equal(warning._tag, "Some");
      if (warning._tag === "Some" && warning.value.type === "runtime.warning") {
        assert.ok(warning.value.payload.message.includes("switch Auto-compact to 200k"));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("restores the selected model once a safeguard-rerouted turn completes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const reroutedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "model.rerouted",
      ).pipe(Stream.runHead, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-fable-5",
        },
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-fable-5",
        },
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "model_refusal_fallback",
        content: "Fable 5's safeguards flagged this message. Switched to Opus 4.8.",
        original_model: "claude-fable-5",
        fallback_model: "claude-opus-4-8",
        request_id: "fallback-request-1",
        session_id: "sdk-session-fallback",
        uuid: "fallback-1",
      } as unknown as SDKMessage);

      const rerouted = yield* Fiber.join(reroutedFiber);
      assert.equal(rerouted._tag, "Some");
      if (rerouted._tag === "Some" && rerouted.value.type === "model.rerouted") {
        assert.equal(rerouted.value.payload.fromModel, "claude-fable-5");
        assert.equal(rerouted.value.payload.toModel, "claude-opus-4-8");
      }

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback",
        uuid: "result-1",
      } as unknown as SDKMessage);
      yield* Fiber.join(turnCompletedFiber);

      // The reroute only covers the completed turn: completion switches the
      // session back so the fallback cannot pin every subsequent turn to Opus.
      assert.deepEqual(harness.query.setModelCalls, ["claude-fable-5"]);

      // The next turn already runs on the selection; no extra control request.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "continue",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-fable-5",
        },
        attachments: [],
      });
      assert.deepEqual(harness.query.setModelCalls, ["claude-fable-5"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resumes with the selected model instead of a prior reroute fallback", () => {
    const harness = makeMultiQueryHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const reroutedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "model.rerouted",
      ).pipe(Stream.runHead, Effect.forkChild);

      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-fable-5",
          options: { autoCompactWindow: "1m" },
        },
      });
      const firstQuery = harness.queries[0];
      assert.ok(firstQuery);

      firstQuery.emit({
        type: "system",
        subtype: "model_refusal_fallback",
        original_model: "claude-fable-5",
        fallback_model: "claude-opus-4-8",
        request_id: "fallback-request-resume",
        session_id: "sdk-session-fallback-resume",
        uuid: "fallback-resume-1",
      } as unknown as SDKMessage);
      yield* Fiber.join(reroutedFiber);

      const activeAfterFallback = (yield* adapter.listSessions()).find(
        (session) => session.threadId === firstSession.threadId,
      );
      assert.ok(activeAfterFallback?.resumeCursor);

      const resumedSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-fable-5",
          options: { autoCompactWindow: "1m" },
        },
        resumeCursor: activeAfterFallback?.resumeCursor,
      });
      const secondQuery = harness.queries[1];
      assert.ok(secondQuery);
      assert.equal(firstQuery.closeCalls, 1);
      assert.equal(harness.createInputs[1]?.options.model, "claude-fable-5");
      assert.equal(autoCompactWindowFromOptions(harness.createInputs[1]?.options), 1_000_000);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal((yield* adapter.listSessions()).length, 1);

      yield* adapter.sendTurn({
        threadId: resumedSession.threadId,
        input: "continue after resume",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-fable-5",
          options: { autoCompactWindow: "1m" },
        },
        attachments: [],
      });
      assert.deepEqual(secondQuery.setModelCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("leaves no Claude runtime when replacement spawn fails", () => {
    const harness = makeMultiQueryHarness({ failCreateAt: 1 });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
      });
      const firstQuery = harness.queries[0];
      assert.ok(firstQuery);

      const replacement = yield* Effect.exit(
        adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-opus-4-8",
            options: { effort: "max" },
          },
        }),
      );

      assert.ok(Exit.isFailure(replacement));
      assert.equal(firstQuery.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      assert.equal((yield* adapter.listSessions()).length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("releases old and failed-replacement gateway leases exactly once", () => {
    const gateway = makeGatewayCredentialsHarness();
    const harness = makeMultiQueryHarness({
      failCreateAt: 1,
      gatewayCredentials: gateway.credentials,
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const replacement = yield* Effect.exit(
        adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-opus-4-8",
            options: { effort: "max" },
          },
        }),
      );

      assert.ok(Exit.isFailure(replacement));
      assert.deepEqual(gateway.revokedTokens, ["gateway-token-1", "gateway-token-2"]);
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("releases the gateway lease when the Claude stream aborts spontaneously", () => {
    const gateway = makeGatewayCredentialsHarness();
    const harness = makeMultiQueryHarness({ gatewayCredentials: gateway.credentials });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.queries[0]?.fail(new Error("All fibers interrupted without error"));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepEqual(gateway.revokedTokens, ["gateway-token-1"]);
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes an uninstalled Claude query when post-spawn setup fails", () => {
    const query = new FakeClaudeQuery();
    (query as { supportedModels: () => Promise<[]> }).supportedModels = () => {
      throw new Error("simulated post-spawn setup failure");
    };
    const layer = makeClaudeAdapterLive({ createQuery: () => query }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* Effect.exit(
        adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        }),
      );

      assert.ok(Exit.isFailure(result));
      assert.equal(query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      assert.equal((yield* adapter.listSessions()).length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("warns once when the per-request prompt nears the context window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const warningsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const bigUsageAssistant = (uuid: string) =>
        ({
          type: "assistant",
          session_id: "sdk-session-context",
          uuid,
          parent_tool_use_id: null,
          message: {
            id: `assistant-${uuid}`,
            content: [{ type: "text", text: "working" }],
            usage: {
              input_tokens: 2,
              cache_read_input_tokens: 170_000,
              output_tokens: 5,
            },
          },
        }) as unknown as SDKMessage;

      harness.query.emit(bigUsageAssistant("ctx-1"));
      harness.query.emit(bigUsageAssistant("ctx-2"));
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-context",
        uuid: "result-ctx",
      } as unknown as SDKMessage);

      const warnings = Array.from(yield* Fiber.join(warningsFiber));
      assert.equal(warnings.length, 1);
      const warning = warnings[0];
      assert.equal(warning?.type, "runtime.warning");
      if (warning?.type === "runtime.warning") {
        assert.ok(warning.payload.message.includes("80%"));
      }

      // The second oversized request must not emit another warning; the turn
      // completed without a second runtime.warning in the stream.
      const thread = yield* adapter.readThread(session.threadId);
      assert.ok(thread.turns.length >= 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("warns about large prompts past 200k on a 1M session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const warningsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message.includes("processing"),
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { autoCompactWindow: "1m" },
        },
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1m",
        uuid: "assistant-1m",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1m",
          content: [{ type: "text", text: "working" }],
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 320_000,
            output_tokens: 5,
          },
        },
      } as unknown as SDKMessage);

      const warnings = Array.from(yield* Fiber.join(warningsFiber));
      assert.equal(warnings.length, 1);
      const warning = warnings[0];
      assert.equal(warning?.type, "runtime.warning");
      if (warning?.type === "runtime.warning") {
        assert.ok(warning.payload.message.includes("logical prompt tokens per request"));
        assert.ok(warning.payload.message.includes("cached reads cost less"));
        assert.ok(!warning.payload.message.includes("premium"));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses the requested Claude auto-compact budget for in-flight usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "thread.token-usage.updated",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            autoCompactWindow: "1m",
          },
        },
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1m",
        description: "Thinking through the larger context",
        usage: {
          total_tokens: 23_000,
        },
        session_id: "sdk-session-task-usage-1m",
        uuid: "task-usage-progress-1m",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 23_000,
            lastUsedTokens: 23_000,
            maxTokens: 1_000_000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves the 1m auto-compact budget when final model usage reports 200k", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "thread.token-usage.updated",
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            autoCompactWindow: "1m",
          },
        },
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1m-final",
        description: "Thinking through the larger context",
        usage: {
          total_tokens: 23_000,
        },
        session_id: "sdk-session-task-usage-1m-final",
        uuid: "task-usage-progress-1m-final",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-1m-final",
        usage: {
          total_tokens: 23_000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      const finalUsageEvent = usageEvents.at(-1);
      assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
      if (finalUsageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(finalUsageEvent.payload, {
          usage: {
            usedTokens: 23_000,
            lastUsedTokens: 23_000,
            maxTokens: 1_000_000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses the SDK's live context usage and auto-compact threshold at completion", () => {
    const harness = makeHarness();
    harness.query.setContextUsageResponse({
      categories: [],
      totalTokens: 120_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 12,
      gridRows: [],
      model: "claude-sonnet-5",
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      autoCompactThreshold: 200_000,
      isAutoCompactEnabled: true,
      apiUsage: {
        input_tokens: 10_000,
        output_tokens: 2_000,
        cache_creation_input_tokens: 5_000,
        cache_read_input_tokens: 105_000,
      },
    });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const usageFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "thread.token-usage.updated",
      ).pipe(Stream.runHead, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-context-usage",
        uuid: "result-context-usage",
      } as unknown as SDKMessage);

      const usageEvent = yield* Fiber.join(usageFiber);
      assert.equal(usageEvent._tag, "Some");
      if (usageEvent._tag === "Some" && usageEvent.value.type === "thread.token-usage.updated") {
        assert.equal(usageEvent.value.payload.usage.usedTokens, 120_000);
        assert.equal(usageEvent.value.payload.usage.maxTokens, 200_000);
        assert.equal(usageEvent.value.payload.usage.inputTokens, 120_000);
        assert.equal(usageEvent.value.payload.usage.cachedInputTokens, 105_000);
        assert.equal(usageEvent.value.payload.usage.compactsAutomatically, true);
      }
      assert.equal(harness.query.getContextUsageCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("completes turns when the Claude context-usage control request hangs", () => {
    const harness = makeHarness();
    harness.query.setContextUsageNeverResolves();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const completedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-context-timeout",
        uuid: "result-context-timeout",
      } as unknown as SDKMessage);

      const completed = yield* Fiber.join(completedFiber);
      assert.equal(completed._tag, "Some");
      assert.equal(harness.query.getContextUsageCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sets plan permission mode on sendTurn when interactionMode is plan", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.include(promptText ?? "", "Synara plan mode is active.");
      assert.include(promptText ?? "", "<proposed_plan>");
      assert.include(promptText ?? "", "User request:\nplan this for me");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("restores base permission mode on sendTurn when interactionMode is default", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      // First turn in plan mode
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });

      // Complete the turn so we can send another
      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-plan-restore",
        uuid: "result-plan",
      } as unknown as SDKMessage);

      yield* Fiber.join(turnCompletedFiber);

      // Second turn back to default
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "now do it",
        interactionMode: "default",
        attachments: [],
      });

      // First call sets "plan", second call restores "bypassPermissions" (the base for full-access)
      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", "bypassPermissions"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("skips restoring the base permission mode when it matches the spawn mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // The base (bypassPermissions) already matches the mode the CLI spawned in,
      // so no redundant control request is issued on the first turn.
      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves Claude settings permission mode when no base mode is known", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resets Claude plan mode to default when settings provided the base mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-plan-settings-base",
        uuid: "result-plan-settings-base",
      } as unknown as SDKMessage);

      yield* Fiber.join(turnCompletedFiber);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "now build it",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", "default"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not leave Claude in plan mode when a follow-up omits interactionMode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-plan-omitted-reset",
        uuid: "result-plan-omitted-reset",
      } as unknown as SDKMessage);

      yield* Fiber.join(turnCompletedFiber);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "now build it",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", "bypassPermissions"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("captures ExitPlanMode as a proposed plan and denies auto-exit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "ExitPlanMode",
        {
          plan: "# Ship it\n\n- one\n- two",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-1",
          requestId: "request-tool-exit-1",
        },
      );

      const proposedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Ship it\n\n- one\n- two");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-exit-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
      const deniedResult = permissionResult as PermissionResult & {
        message?: string;
      };
      assert.equal(deniedResult.message?.includes("captured your proposed plan"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant ExitPlanMode snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-exit-plan",
        uuid: "assistant-exit-plan",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-6",
          id: "msg-exit-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-exit-2",
              name: "ExitPlanMode",
              input: {
                plan: "# Final plan\n\n- capture it",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Final plan\n\n- capture it");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-exit-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant tagged markdown snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-tagged-plan",
        uuid: "assistant-tagged-plan",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-6",
          id: "msg-tagged-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Here is the plan.\n<proposed_plan>\n# Tagged plan\n\n- capture it\n</proposed_plan>",
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Tagged plan\n\n- capture it");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-1",
        uuid: "stream-user-input-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-1",
        requestId: "request-tool-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some") {
        return;
      }
      assert.equal(requestedEvent.value.type, "user-input.requested");
      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }
      const requestId = requestedEvent.value.requestId;
      assert.equal(typeof requestId, "string");
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestId!),
        { Framework: "React" },
      );

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some") {
        return;
      }
      assert.equal(resolvedEvent.value.type, "user-input.resolved");
      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("coerces multi-select array answers into comma-separated strings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "multi-select turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-multi",
        uuid: "stream-user-input-multi",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-multi",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      if (!canUseTool) {
        assert.fail("Expected canUseTool to be defined");
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Which features do you use most?",
            header: "Features",
            options: [
              { label: "CLI scaffolding", description: "Generate boilerplate" },
              { label: "Type checking", description: "Static analysis" },
              { label: "Hot reload", description: "Live updates" },
            ],
            multiSelect: true,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-multi",
        requestId: "request-tool-ask-multi",
      });

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestId!),
        { Features: ["CLI scaffolding", "Type checking"] },
      );

      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, {
        "Which features do you use most?": "CLI scaffolding, Type checking",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes AskUserQuestion through user-input flow even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // In full-access mode, regular tools are auto-approved.
      // AskUserQuestion should still go through the user-input flow.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Deploy to which env?",
            header: "Env",
            options: [
              { label: "Staging", description: "Staging environment" },
              { label: "Production", description: "Production environment" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-2",
        requestId: "request-tool-ask-2",
      });

      // Should still get user-input.requested even in full-access mode.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestId!),
        { "Deploy to which env?": "Staging" },
      );

      // Drain the resolved event.
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Deploy to which env?": "Staging" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the waiting turn is aborted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const controller = new AbortController();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          toolUseID: "tool-ask-abort",
          requestId: "request-tool-ask-abort",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      assert.equal(requestedEvent.value.threadId, session.threadId);

      controller.abort();

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        threadId?: string;
        turnId?: string;
      };
    }> = [];
    const nativeThreadIds: Array<string | null> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-native-log",
        uuid: "result-native-log",
      } as unknown as SDKMessage);

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "claudeAgent"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) =>
            String(
              (record.event as { readonly providerThreadId?: string } | undefined)
                ?.providerThreadId,
            ) === "sdk-session-native-log",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => String(record.event?.turnId) === String(turn.turnId)),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.method === "claude/stream_event/content_block_delta/text_delta",
        ),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === String(THREAD_ID)),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
