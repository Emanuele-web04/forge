import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Stream } from "effect";
import { ThreadId, type ProviderRuntimeEvent, type TurnId } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerConfig } from "../../config.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import { makePiAdapterLive } from "./PiAdapter.ts";

const captured = vi.hoisted(() => ({
  sessions: [] as AgentSession[],
  extensions: [] as InlineExtension[],
  events: [] as AgentSessionEvent[],
  stream: undefined as StreamFn | undefined,
}));

// Keep the real SDK session, agent loop, retry timers and cancellation. Replace
// only model transport, and keep session files inside the test's isolated cwd.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    SessionManager: {
      ...sdk.SessionManager,
      create: (cwd: string) => sdk.SessionManager.create(cwd, path.join(cwd, "sessions")),
    },
    createAgentSessionServices: async (
      options: Parameters<typeof sdk.createAgentSessionServices>[0],
    ) =>
      sdk.createAgentSessionServices({
        ...options,
        resourceLoaderOptions: { extensionFactories: captured.extensions },
      }),
    createAgentSessionFromServices: async (
      input: Parameters<typeof sdk.createAgentSessionFromServices>[0],
    ) => {
      const result = await sdk.createAgentSessionFromServices(input);
      result.session.agent.streamFunction = (...args) => captured.stream!(...args);
      result.session.subscribe((event) => captured.events.push(event));
      captured.sessions.push(result.session);
      return result;
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  captured.sessions.length = 0;
  captured.extensions.length = 0;
  captured.events.length = 0;
  captured.stream = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ResponseKind = "success" | "error" | "overflow" | "partial-error" | "until-abort";
function responses(...kinds: ResponseKind[]) {
  let calls = 0;
  captured.stream = (model, _context, options) => {
    const kind = kinds[calls++] ?? "success";
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: {
        input: 10,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: message });
    if (kind === "error" || kind === "overflow") {
      message.stopReason = "error";
      message.errorMessage =
        kind === "overflow"
          ? "maximum context length exceeded"
          : "[rate_limit_exceeded] Rate limit exceeded";
      stream.push({ type: "error", reason: "error", error: message });
    } else {
      message.content.push({ type: "thinking", thinking: "Considered" });
      stream.push({
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Considered",
        partial: message,
      });
      message.content.push({ type: "text", text: "Answer" });
      stream.push({ type: "text_delta", contentIndex: 1, delta: "Answer", partial: message });
      if (kind === "partial-error") {
        message.stopReason = "error";
        message.errorMessage = "[rate_limit_exceeded] Rate limit exceeded";
        stream.push({ type: "error", reason: "error", error: message });
      } else if (kind === "until-abort") {
        const abort = () => {
          message.stopReason = "aborted";
          message.errorMessage = "Request was aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      } else {
        stream.push({ type: "done", reason: "stop", message });
      }
    }
    return stream;
  };
  return () => calls;
}

const threadId = ThreadId.makeUnsafe("pi-lifecycle-test");
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 5, timeout: 3_000 });
const completions = (events: ProviderRuntimeEvent[]) =>
  events.filter((event) => event.type === "turn.completed");

async function withAdapter(
  run: (adapter: PiAdapterShape, events: ProviderRuntimeEvent[], cwd: string) => Promise<void>,
  delayMs = 100,
  credentials?: AgentGatewayCredentialsShape,
) {
  vi.stubEnv("PI_OFFLINE", "1");
  const cwd = mkdtempSync(path.join(tmpdir(), "synara-pi-lifecycle-"));
  dirs.push(cwd);
  writeFileSync(
    path.join(cwd, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "test-only" } }),
  );
  writeFileSync(
    path.join(cwd, "settings.json"),
    JSON.stringify({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: delayMs },
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
    }),
  );
  const gatewayFetch = async (_input: string | URL | Request, init?: RequestInit) =>
    Response.json({
      jsonrpc: "2.0",
      id: JSON.parse(String(init?.body)).id,
      result: {
        tools: [
          {
            name: "synara_list_threads",
            description: "List threads",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  let layer = makePiAdapterLive({ agentGatewayFetch: gatewayFetch }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(cwd, path.join(cwd, "server"))),
    Layer.provideMerge(NodeServices.layer),
  );
  if (credentials)
    layer = layer.pipe(Layer.provide(Layer.succeed(AgentGatewayCredentials, credentials)));
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        cwd,
        runtimeMode: "full-access",
        providerOptions: { pi: { agentDir: cwd } },
        modelSelection: { provider: "pi", model: "openai/gpt-4o" },
      });
      yield* Effect.promise(() => run(adapter, events, cwd));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}

async function send(adapter: PiAdapterShape) {
  return Effect.runPromise(adapter.sendTurn({ threadId, input: "Test this turn" }));
}

async function expectNextTurn(
  adapter: PiAdapterShape,
  events: ProviderRuntimeEvent[],
  previous: TurnId,
) {
  responses("success");
  const next = await send(adapter);
  expect(next.turnId).not.toBe(previous);
  await waitFor(() =>
    expect(completions(events).filter((event) => event.turnId === next.turnId)).toHaveLength(1),
  );
  expect(completions(events).filter((event) => event.turnId === previous)).toHaveLength(1);
}

it("keeps one turn through a real SDK retry and settles text, reasoning and usage once", async () => {
  const calls = responses("error", "success");
  await withAdapter(async (adapter, events) => {
    const turn = await send(adapter);
    await waitFor(() =>
      expect(events.some((event) => event.type === "runtime.warning")).toBe(true),
    );
    expect(completions(events)).toHaveLength(0);
    expect((await Effect.runPromise(adapter.listSessions()))[0]?.activeTurnId).toBe(turn.turnId);
    expect(
      (await Effect.runPromise(adapter.readThread(threadId))).turns.some(
        (entry) => entry.id === turn.turnId,
      ),
    ).toBe(true);
    await waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(calls()).toBe(2);
    expect(completions(events)[0]).toMatchObject({
      turnId: turn.turnId,
      payload: { state: "completed", usage: { tokens: { input: 20, output: 6, cacheRead: 4 } } },
    });
    expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(0);
    expect(
      events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
    ).toEqual([turn.turnId, turn.turnId]);
    expect(
      events
        .filter((event) => event.type === "item.completed")
        .map((event) => event.payload.status),
    ).toEqual(["completed", "completed"]);
    expect(
      events.filter(
        (event) => event.type === "thread.token-usage.updated" && event.turnId === turn.turnId,
      ),
    ).toHaveLength(1);
    await expectNextTurn(adapter, events, turn.turnId);
  });
});

it("reports exhausted SDK retries once, without a late unscoped failure warning", async () => {
  responses("error", "error");
  await withAdapter(async (adapter, events) => {
    const turn = await send(adapter);
    await waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      turnId: turn.turnId,
      payload: { state: "failed", stopReason: "error" },
    });
    expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(1);
    const warnings = events.filter((event) => event.type === "runtime.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.turnId).toBe(turn.turnId);
    await expectNextTurn(adapter, events, turn.turnId);
  }, 1);
});

it.each(["adapter", "extension"] as const)(
  "settles cancellation in retry backoff through %s abort without another agent_end",
  async (source) => {
    responses("error");
    await withAdapter(async (adapter, events) => {
      const turn = await send(adapter);
      const session = captured.sessions[0]!;
      await waitFor(() => expect(session.isRetrying).toBe(true));
      if (source === "adapter")
        await Effect.runPromise(adapter.interruptTurn(threadId, turn.turnId));
      else session.extensionRunner.createCommandContext().abort();
      await waitFor(() => expect(completions(events)).toHaveLength(1));
      expect(captured.events.filter((event) => event.type === "agent_end")).toHaveLength(1);
      expect(
        captured.events.some(
          (event) => event.type === "auto_retry_end" && event.finalError === "Retry cancelled",
        ),
      ).toBe(true);
      expect(completions(events)[0]).toMatchObject({
        turnId: turn.turnId,
        payload: { state: "interrupted", stopReason: "aborted" },
      });
      expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(0);
      expect(session.isIdle).toBe(true);
      await expectNextTurn(adapter, events, turn.turnId);
    }, 60_000);
  },
);

it("cancels a live retry attempt and closes its streaming items", async () => {
  const calls = responses("error", "until-abort");
  await withAdapter(async (adapter, events) => {
    const turn = await send(adapter);
    await waitFor(() => expect(calls()).toBe(2));
    await Effect.runPromise(adapter.interruptTurn(threadId, turn.turnId));
    await waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({ payload: { state: "interrupted" } });
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(2);
    expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(0);
    await expectNextTurn(adapter, events, turn.turnId);
  }, 1);
});

it("waits for prompt rejection even when the SDK has finished its agent cycle", async () => {
  responses("success");
  await withAdapter(async (adapter, events) => {
    const session = captured.sessions[0]!;
    const emit = session.extensionRunner.emit.bind(session.extensionRunner);
    const spy = vi.spyOn(session.extensionRunner, "emit").mockImplementation(async (event) => {
      if (event.type === "agent_settled") throw new Error("settled extension failed");
      return emit(event);
    });
    const turn = await send(adapter);
    await waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      payload: { state: "failed", errorMessage: "settled extension failed" },
    });
    expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(1);
    spy.mockRestore();
    await expectNextTurn(adapter, events, turn.turnId);
  });
});

it("keeps steering during backoff inside the same logical turn", async () => {
  responses("error", "success", "success");
  await withAdapter(async (adapter, events) => {
    const turn = await send(adapter);
    const session = captured.sessions[0]!;
    await waitFor(() => expect(session.isRetrying).toBe(true));
    const steered = await Effect.runPromise(
      adapter.steerTurn!({ threadId, input: "Also check this" }),
    );
    expect(steered.turnId).toBe(turn.turnId);
    await waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      turnId: turn.turnId,
      payload: { state: "completed" },
    });
    expect(
      session.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("Also check this"),
      ),
    ).toBe(true);
  });
});

it("keeps the turn alive through SDK overflow compaction and its continuation", async () => {
  const calls = responses("success", "overflow", "success", "success");
  await withAdapter(async (adapter, events) => {
    await send(adapter);
    await waitFor(() => expect(completions(events)).toHaveLength(1));
    const session = captured.sessions[0]!;
    session.setAutoCompactionEnabled(true);
    const turn = await send(adapter);
    await waitFor(() => expect(completions(events)).toHaveLength(2));
    expect(
      captured.events.some((event) => event.type === "compaction_end" && event.willRetry),
    ).toBe(true);
    expect(calls()).toBe(4);
    expect(completions(events)[1]).toMatchObject({
      turnId: turn.turnId,
      payload: { state: "completed" },
    });
    expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(0);
  });
});

it("does not let an old prompt rejection settle a replacement session's turn", async () => {
  responses("until-abort");
  await withAdapter(async (adapter, events, cwd) => {
    const oldSession = captured.sessions[0]!;
    let rejectOld!: (cause: Error) => void;
    vi.spyOn(oldSession, "prompt").mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const oldTurn = await send(adapter);
    await Effect.runPromise(adapter.stopSession(threadId));
    await Effect.runPromise(
      adapter.startSession({
        threadId,
        cwd,
        runtimeMode: "full-access",
        providerOptions: { pi: { agentDir: cwd } },
        modelSelection: { provider: "pi", model: "openai/gpt-4o" },
      }),
    );
    const next = await send(adapter);
    await waitFor(() =>
      expect(
        events.some((event) => event.type === "content.delta" && event.turnId === next.turnId),
      ).toBe(true),
    );
    rejectOld(new Error("late old prompt failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(completions(events)).toHaveLength(0);
    expect((await Effect.runPromise(adapter.listSessions()))[0]?.activeTurnId).toBe(next.turnId);
    await Effect.runPromise(adapter.interruptTurn(threadId, next.turnId));
    await waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]?.turnId).toBe(next.turnId);
    expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(0);
    expect(oldTurn.turnId).not.toBe(next.turnId);
  });
});

it("disposes during SDK backoff without a resumed request or late turn completion", async () => {
  const calls = responses("error", "until-abort");
  await withAdapter(async (adapter, events) => {
    await send(adapter);
    const session = captured.sessions[0]!;
    await waitFor(() => expect(session.isRetrying).toBe(true));
    await Effect.runPromise(adapter.stopSession(threadId));
    await waitFor(() => expect(events.some((event) => event.type === "session.exited")).toBe(true));
    expect(session.isIdle).toBe(true);
    expect(calls()).toBe(1);
    expect(completions(events)).toHaveLength(0);
    expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
  }, 60_000);
});

it.each(["adapter", "extension"] as const)(
  "does not start queued steering after %s abort during backoff",
  async (source) => {
    const calls = responses("error", "until-abort");
    await withAdapter(async (adapter, events) => {
      const turn = await send(adapter);
      const session = captured.sessions[0]!;
      await waitFor(() => expect(session.isRetrying).toBe(true));
      await Effect.runPromise(adapter.steerTurn!({ threadId, input: "Queued steering" }));
      let resumed!: (result: string) => void;
      const resumedRun = new Promise<string>((resolve) => {
        resumed = resolve;
      });
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_start") resumed("continued");
      });
      const interrupt =
        source === "adapter"
          ? Effect.runPromise(adapter.interruptTurn(threadId, turn.turnId))
          : (session.extensionRunner.createCommandContext().abort(), session.waitForIdle());
      const outcome = await Promise.race([interrupt.then(() => "stopped"), resumedRun]);
      unsubscribe();
      if (outcome === "continued") {
        await waitFor(() => expect(calls()).toBe(2));
        await session.abort();
      }
      await interrupt;
      expect(outcome).toBe("stopped");
      expect(calls()).toBe(1);
      await waitFor(() => expect(completions(events)).toHaveLength(1));
    }, 60_000);
  },
);

it("keeps partial assistant and reasoning items open across retries until final settlement", async () => {
  responses("partial-error", "success");
  await withAdapter(async (adapter, events) => {
    const turn = await send(adapter);
    await waitFor(() => expect(captured.sessions[0]!.isRetrying).toBe(true));
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(0);
    await waitFor(() => expect(completions(events)).toHaveLength(1));
    for (const itemType of ["assistant_message", "reasoning"] as const) {
      const started = events.filter(
        (event) => event.type === "item.started" && event.payload.itemType === itemType,
      );
      const completed = events.filter(
        (event) => event.type === "item.completed" && event.payload.itemType === itemType,
      );
      expect(started).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        itemId: started[0]!.itemId,
        turnId: turn.turnId,
        payload: { status: "completed" },
      });
      expect(
        events.filter(
          (event) => event.type === "content.delta" && event.itemId === started[0]!.itemId,
        ),
      ).toHaveLength(2);
    }
  });
});

function gatewayCredentials() {
  let sequence = 0;
  return {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    setListeningPort: () => undefined,
    issueSessionToken: () => `unused-${++sequence}`,
    verifySessionToken: () => null,
    verifySession: () => null,
    issueStdioBootstrapToken: () => null,
    exchangeStdioBootstrapToken: () => null,
    bindWriteAuthority: () => null,
    verifyWriteAuthority: () => false,
    registerInFlightRequest: () => () => undefined,
    cancelInFlightRequests: () => ({ count: 0, settled: Promise.resolve() }),
    cancelSessionTurnRequests: vi.fn(async (_token: string, _turnId: string) => undefined),
    retireSessionTurn: vi.fn(async (_token: string, _turnId: string) => undefined),
    revokeSessionToken: vi.fn((_token: string) => undefined),
    connectionForThread: vi.fn(() => ({
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: `lease-${++sequence}`,
    })),
    stdioProxy: { command: process.execPath, args: [] },
  } satisfies AgentGatewayCredentialsShape;
}

it.each(["success", "failure", "cancel", "rejection"] as const)(
  "retires or revokes the gateway turn authority once on %s",
  async (outcome) => {
    const credentials = gatewayCredentials();
    responses(...((outcome === "success" ? ["success"] : ["error", "error"]) as ResponseKind[]));
    await withAdapter(
      async (adapter, events) => {
        if (outcome === "rejection")
          vi.spyOn(captured.sessions[0]!, "prompt").mockRejectedValueOnce(
            new Error("prompt rejected"),
          );
        const turn = await send(adapter);
        if (outcome === "cancel") {
          await waitFor(() => expect(captured.sessions[0]!.isRetrying).toBe(true));
          await Effect.runPromise(adapter.interruptTurn(threadId, turn.turnId));
        }
        await waitFor(() => expect(completions(events)).toHaveLength(1));
        if (outcome === "cancel") {
          expect(credentials.cancelSessionTurnRequests).toHaveBeenCalledExactlyOnceWith(
            "lease-1",
            turn.turnId,
          );
          // Interrupt already revoked this lease; terminal retirement is idempotent.
          expect(credentials.retireSessionTurn).not.toHaveBeenCalled();
        } else {
          expect(credentials.retireSessionTurn).toHaveBeenCalledExactlyOnceWith(
            "lease-1",
            turn.turnId,
          );
        }
        expect(credentials.revokeSessionToken).toHaveBeenCalledExactlyOnceWith("lease-1");
        expect(credentials.connectionForThread).toHaveBeenCalledTimes(2);
        await expectNextTurn(adapter, events, turn.turnId);
        expect(credentials.retireSessionTurn).toHaveBeenLastCalledWith(
          "lease-2",
          completions(events)[1]!.turnId,
        );
        expect(
          credentials.revokeSessionToken.mock.calls.filter(([token]) => token === "lease-1"),
        ).toHaveLength(1);
      },
      outcome === "cancel" ? 60_000 : 1,
      credentials,
    );
  },
);

it("does not reuse a previous provider error for a handled extension command", async () => {
  captured.extensions.push((pi) => {
    pi.registerCommand("noop", { description: "No inference", handler: async () => {} });
  });
  const calls = responses("error", "error");
  await withAdapter(async (adapter, events) => {
    await send(adapter);
    await waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({ payload: { state: "failed" } });
    const command = await Effect.runPromise(adapter.sendTurn({ threadId, input: "/noop" }));
    await waitFor(() => expect(completions(events)).toHaveLength(2));
    expect(completions(events)[1]).toMatchObject({
      turnId: command.turnId,
      payload: { state: "completed" },
    });
    expect(calls()).toBe(2);
  }, 1);
});

it("cancels retry and queued steering before awaiting gateway teardown drainage", async () => {
  const credentials = gatewayCredentials();
  let drain!: () => void;
  credentials.cancelSessionTurnRequests.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        drain = resolve;
      }),
  );
  const calls = responses("error", "until-abort");
  await withAdapter(
    async (adapter, events) => {
      const turn = await send(adapter);
      const session = captured.sessions[0]!;
      await waitFor(() => expect(session.isRetrying).toBe(true));
      await Effect.runPromise(
        adapter.steerTurn!({ threadId, input: "Do not restart this queued work" }),
      );
      const stopped = Effect.runPromise(adapter.stopSession(threadId));
      try {
        await waitFor(() => expect(credentials.cancelSessionTurnRequests).toHaveBeenCalled());
        await waitFor(() => expect(session.isIdle).toBe(true));
        expect(calls()).toBe(1);
        expect(session.pendingMessageCount).toBe(0);
      } finally {
        drain();
        await stopped;
      }
      await waitFor(() =>
        expect(events.some((event) => event.type === "session.exited")).toBe(true),
      );
      expect(completions(events)).toHaveLength(1);
      expect(completions(events)[0]).toMatchObject({
        turnId: turn.turnId,
        payload: { state: "interrupted" },
      });
    },
    100,
    credentials,
  );
});
