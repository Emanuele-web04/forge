import { describe, expect, it } from "vitest";

import * as OfficialAcp from "@agentclientprotocol/sdk";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Scope, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { TestClock } from "effect/testing";
import type * as Acp from "@agentclientprotocol/sdk";

import {
  AcpSessionRuntime,
  assistantItemId,
  awaitAcpChildExit,
  decodeSetSessionConfigOptionResponse,
  isAcpAuthRequiredError,
  isAcpStartupTimeoutError,
  makeAcpIncomingFrameGuard,
  makeStartupInteractionRegistry,
  runAcpFreshSessionSetup,
  sessionConfigOptionsFromSetup,
  teardownAcpChildProcess,
} from "./AcpSessionRuntime.ts";
import * as AcpErrors from "./AcpErrors.ts";

describe("makeAcpIncomingFrameGuard", () => {
  const encode = (value: string) => new TextEncoder().encode(value);

  it("enforces the frame budget across split chunks and resets it at newline boundaries", () => {
    const guard = makeAcpIncomingFrameGuard(5);

    expect(guard(encode("123"))).toBeUndefined();
    expect(guard(encode("45\n12345\n"))).toBeUndefined();
    expect(guard(encode("1\n"))).toBeUndefined();
  });

  it("rejects an oversized unterminated frame", () => {
    const guard = makeAcpIncomingFrameGuard(5);

    expect(guard(encode("123"))).toBeUndefined();
    const error = guard(encode("456"));
    expect(error?._tag).toBe("AcpTransportError");
    expect(error?.detail).toContain("5-byte limit");
  });
});

describe("teardownAcpChildProcess", () => {
  it("keeps ACP scope closure pending until the owned root exit settles", async () => {
    const processExited = Deferred.makeUnsafe<number>();
    const exitCode = Deferred.await(processExited);
    let observeTeardown!: (input: {
      readonly rootPid: number;
      readonly rootExited: Promise<unknown>;
    }) => void;
    const teardownStarted = new Promise<{
      readonly rootPid: number;
      readonly rootExited: Promise<unknown>;
    }>((resolve) => {
      observeTeardown = resolve;
    });
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(
      Effect.addFinalizer(() =>
        teardownAcpChildProcess({ pid: 4_242, exitCode }, async (input) => {
          observeTeardown(input);
          await input.rootExited;
          return { escalated: false, signalErrors: [] };
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    let scopeClosed = false;
    const closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
      scopeClosed = true;
    });
    const teardown = await teardownStarted;
    expect(teardown.rootPid).toBe(4_242);
    await Promise.resolve();
    expect(scopeClosed).toBe(false);

    Deferred.doneUnsafe(processExited, Effect.succeed(0));
    await closing;
    expect(scopeClosed).toBe(true);
  });
});

describe("awaitAcpChildExit", () => {
  it("completes for both successful and failed child exit signals", async () => {
    const successfulExit = Deferred.makeUnsafe<number>();
    const failedExit = Deferred.makeUnsafe<number, Error>();
    let successfulCompleted = false;
    let failedCompleted = false;

    const successfulWait = Effect.runPromise(
      awaitAcpChildExit({ pid: 1, exitCode: Deferred.await(successfulExit) }),
    ).then(() => {
      successfulCompleted = true;
    });
    const failedWait = Effect.runPromise(
      awaitAcpChildExit({ pid: 2, exitCode: Deferred.await(failedExit) }),
    ).then(() => {
      failedCompleted = true;
    });

    await Promise.resolve();
    expect(successfulCompleted).toBe(false);
    expect(failedCompleted).toBe(false);

    Deferred.doneUnsafe(successfulExit, Effect.succeed(0));
    Deferred.doneUnsafe(failedExit, Effect.fail(new Error("child exit signal failed")));
    await Promise.all([successfulWait, failedWait]);

    expect(successfulCompleted).toBe(true);
    expect(failedCompleted).toBe(true);
  });
});

describe("runAcpFreshSessionSetup", () => {
  it("retries one matching fresh-session failure and then succeeds", async () => {
    const retryable = new AcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Path not found.",
      data: { code: "FS_NOT_FOUND" },
    });
    let attempts = 0;
    const setup = Effect.suspend(() => {
      attempts += 1;
      return attempts === 1 ? Effect.fail(retryable) : Effect.succeed("session-ready");
    });

    await expect(
      Effect.runPromise(
        runAcpFreshSessionSetup(setup, {
          shouldRetry: (error) => error === retryable,
        }),
      ),
    ).resolves.toBe("session-ready");
    expect(attempts).toBe(2);
  });

  it("does not retry a non-matching failure", async () => {
    const terminal = new AcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Permission denied.",
      data: { code: "FS_PERMISSION_DENIED" },
    });
    let attempts = 0;
    const setup = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(terminal);
    });

    await expect(
      Effect.runPromise(
        runAcpFreshSessionSetup(setup, {
          shouldRetry: () => false,
        }),
      ),
    ).rejects.toThrow("Permission denied.");
    expect(attempts).toBe(1);
  });
});

describe("assistantItemId", () => {
  // Format contract only — distinct runtimeInstanceId wiring is covered by
  // AcpJsonRpcConnection.test.ts ("assigns distinct fallback assistant item ids...").
  it("produces distinct ids across runtime instances with the same session id and segment index", () => {
    const sessionId = "session-1";
    const a = assistantItemId(sessionId, "aaaa1111", 0);
    const b = assistantItemId(sessionId, "bbbb2222", 0);
    expect(a).not.toBe(b);
    expect(a).toBe("assistant:session-1:aaaa1111:segment:0");
    expect(b).toBe("assistant:session-1:bbbb2222:segment:0");
  });
});

describe("decodeSetSessionConfigOptionResponse", () => {
  const configOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-5.6-luna",
      options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
    },
  ] satisfies ReadonlyArray<Acp.SessionConfigOption>;

  it("uses the matching config update for an empty response", () => {
    const decoded = Effect.runSync(
      decodeSetSessionConfigOptionResponse({}, Effect.succeed(configOptions)),
    );
    expect(decoded).toEqual({ configOptions });
  });

  it("strictly decodes a non-empty response without awaiting an update", () => {
    let awaitedUpdate = false;
    const decoded = Effect.runSync(
      decodeSetSessionConfigOptionResponse(
        { configOptions },
        Effect.sync(() => {
          awaitedUpdate = true;
          return [];
        }),
      ),
    );
    expect(decoded).toEqual({ configOptions });
    expect(awaitedUpdate).toBe(false);
  });

  it("rejects an invalid non-empty response", async () => {
    const error = await Effect.runPromise(
      decodeSetSessionConfigOptionResponse(
        { unexpected: true },
        Effect.succeed(configOptions),
      ).pipe(Effect.flip),
    );
    expect(error._tag).toBe("AcpTransportError");
    if (error._tag === "AcpTransportError") {
      expect(error.detail).toContain("invalid session/set_config_option response");
    }
  });
});

describe("sessionConfigOptionsFromSetup", () => {
  const replayedConfigOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-5.6-luna",
      options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
    },
  ] satisfies ReadonlyArray<Acp.SessionConfigOption>;

  it("preserves config retained from replay when setup omits configOptions", () => {
    expect(sessionConfigOptionsFromSetup({}, replayedConfigOptions)).toBe(replayedConfigOptions);
  });

  it("uses an explicit setup inventory instead of replayed config", () => {
    expect(sessionConfigOptionsFromSetup({ configOptions: [] }, replayedConfigOptions)).toEqual([]);
  });
});

describe("makeStartupInteractionRegistry", () => {
  it("buffers dispatches before startup completes and flushes them on complete", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* makeStartupInteractionRegistry<string, string>("default");
      const handled: string[] = [];
      const response = "ok";

      const dispatchFiber1 = yield* registry.dispatch("a").pipe(Effect.forkChild);
      const dispatchFiber2 = yield* registry.dispatch("b").pipe(Effect.forkChild);

      yield* registry.register((req) =>
        Effect.sync(() => {
          handled.push(req);
          return response;
        }),
      );

      yield* registry.complete();

      const results = yield* Effect.all([Fiber.join(dispatchFiber1), Fiber.join(dispatchFiber2)]);

      expect(handled).toEqual(["a", "b"]);
      expect(results).toEqual([response, response]);
    });

    await Effect.runPromise(program);
  });

  it("routes dispatches directly to the handler after startup completes", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* makeStartupInteractionRegistry<string, string>("default");

      yield* registry.register((req) => Effect.succeed(`handled:${req}`));
      yield* registry.complete();

      const result = yield* registry.dispatch("x");
      expect(result).toBe("handled:x");
    });

    await Effect.runPromise(program);
  });

  it("cancels pending dispatches on begin and when explicitly cancelled", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* makeStartupInteractionRegistry<string, string>("cancelled");

      const fiber = yield* registry.dispatch("a").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* registry.begin();
      const result = yield* Fiber.join(fiber);
      expect(result).toBe("cancelled");
    });

    await Effect.runPromise(program);
  });

  it("does not lose concurrent dispatches buffered during startup", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* makeStartupInteractionRegistry<string, string>("default");
      const handled: string[] = [];

      const fibers = yield* Effect.all(
        Array.from({ length: 50 }, (_, i) => registry.dispatch(String(i)).pipe(Effect.forkChild)),
      );
      yield* Effect.yieldNow;

      yield* registry.register((req) =>
        Effect.sync(() => {
          handled.push(req);
          return `handled:${req}`;
        }),
      );
      yield* registry.complete();

      const results = yield* Effect.all(fibers.map((fiber) => Fiber.join(fiber)));
      expect(handled).toHaveLength(50);
      expect(results).toEqual(Array.from({ length: 50 }, (_, i) => `handled:${i}`));
    });

    await Effect.runPromise(program);
  });

  it("answers dispatches from a previous generation with the default instead of replaying them", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* makeStartupInteractionRegistry<string, string>("cancelled");
      const handled: string[] = [];

      const staleFiber = yield* registry.dispatch("stale").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* registry.begin();

      yield* registry.register((req) =>
        Effect.sync(() => {
          handled.push(req);
          return `handled:${req}`;
        }),
      );
      yield* registry.complete();

      const staleResult = yield* Fiber.join(staleFiber);
      expect(staleResult).toBe("cancelled");
      expect(handled).toEqual([]);

      const fresh = yield* registry.dispatch("fresh");
      expect(fresh).toBe("handled:fresh");
      expect(handled).toEqual(["fresh"]);
    });

    await Effect.runPromise(program);
  });

  it("delivers each buffered dispatch exactly once when register races complete", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* makeStartupInteractionRegistry<string, string>("default");
      const handled: string[] = [];
      const handler = (req: string) =>
        Effect.sync(() => {
          handled.push(req);
          return `handled:${req}`;
        });

      const fiber = yield* registry.dispatch("a").pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      // complete before any handler exists: the dispatch must stay buffered.
      yield* registry.complete();
      yield* registry.register(handler);
      // A second register after the flush must not re-deliver.
      yield* registry.register(handler);

      const result = yield* Fiber.join(fiber);
      expect(result).toBe("handled:a");
      expect(handled).toEqual(["a"]);
    });

    await Effect.runPromise(program);
  });

  it("keeps the direct dispatch path intact after a post-complete cancel", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* makeStartupInteractionRegistry<string, string>("default");

      yield* registry.register((req) => Effect.succeed(`handled:${req}`));
      yield* registry.complete();
      yield* registry.cancel();

      const result = yield* registry.dispatch("x");
      expect(result).toBe("handled:x");
    });

    await Effect.runPromise(program);
  });

  it("rejects dispatches once the buffer is exhausted", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* makeStartupInteractionRegistry<string, string>("default");

      for (let i = 0; i < 256; i++) {
        yield* registry.dispatch(String(i)).pipe(Effect.forkChild);
      }
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const error = yield* registry.dispatch("overflow").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
    });

    await Effect.runPromise(program);
  });
});

describe("isAcpAuthRequiredError", () => {
  it("classifies a qualified missing or invalid api key message as auth-required", () => {
    expect(
      isAcpAuthRequiredError(
        new AcpErrors.AcpRequestError({ code: -32000, errorMessage: "Missing api key." }),
      ),
    ).toBe(true);
    expect(
      isAcpAuthRequiredError(
        new AcpErrors.AcpRequestError({ code: -32000, errorMessage: "Invalid api key." }),
      ),
    ).toBe(true);
  });

  it("does not treat a bare api-key mention as an auth challenge", () => {
    expect(
      isAcpAuthRequiredError(
        new AcpErrors.AcpRequestError({
          code: -32000,
          errorMessage: "API key could not be verified by the upstream service.",
        }),
      ),
    ).toBe(false);
  });

  it("does not treat permission failures with another protocol code as auth-required", () => {
    expect(
      isAcpAuthRequiredError(
        new AcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Permission denied while reading the workspace.",
        }),
      ),
    ).toBe(false);
  });
});

describe("AcpSessionRuntime initialize validation", () => {
  const makeRuntimeLayer = (
    agentApp: OfficialAcp.AgentApp,
    validateInitializeResult: NonNullable<
      Parameters<typeof AcpSessionRuntime.layer>[0]["validateInitializeResult"]
    >,
  ) => {
    const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
    const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
    const agentInput = new ReadableStream<Uint8Array>({
      pull(controller) {
        return Effect.runPromise(Queue.take(clientToAgent)).then((chunk) =>
          controller.enqueue(chunk),
        );
      },
    });
    const agentOutput = new WritableStream<Uint8Array>({
      write(chunk) {
        return Effect.runPromise(Queue.offer(agentToClient, chunk)).then(() => undefined);
      },
    });
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          agentApp.connect(OfficialAcp.ndJsonStream(agentOutput, agentInput));
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(clientToAgent, chunk)),
            stdout: Stream.fromQueue(agentToClient),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          });
        }),
      ),
    );

    return AcpSessionRuntime.layer({
      spawn: { command: "in-memory-acp-agent", args: [] },
      cwd: process.cwd(),
      clientInfo: { name: "synara-test", version: "0.0.0" },
      authPolicy: "on-demand",
      validateInitializeResult,
      teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
    }).pipe(Layer.provide(spawnerLayer));
  };

  it("validates after initialize and before session/new", async () => {
    const calls: string[] = [];
    const agentApp = OfficialAcp.agent({ name: "initialize-validation-agent" })
      .onRequest(OfficialAcp.methods.agent.initialize, () => {
        calls.push("initialize");
        return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
      })
      .onRequest(OfficialAcp.methods.agent.session.new, () => {
        calls.push("session/new");
        return { sessionId: "validated-session" };
      });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        return yield* runtime.start();
      }).pipe(
        Effect.provide(
          makeRuntimeLayer(agentApp, () =>
            Effect.sync(() => {
              calls.push("validate");
            }),
          ),
        ),
        Effect.scoped,
      ),
    );

    expect(result.sessionId).toBe("validated-session");
    expect(calls).toEqual(["initialize", "validate", "session/new"]);
  });

  it("does not create a session when initialize validation fails", async () => {
    let sessionNewCalls = 0;
    const validationError = new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "initialize rejected",
    });
    const agentApp = OfficialAcp.agent({ name: "initialize-validation-agent" })
      .onRequest(OfficialAcp.methods.agent.initialize, () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      }))
      .onRequest(OfficialAcp.methods.agent.session.new, () => {
        sessionNewCalls += 1;
        return { sessionId: "must-not-exist" };
      });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        return yield* runtime.start();
      }).pipe(
        Effect.provide(makeRuntimeLayer(agentApp, () => Effect.fail(validationError))),
        Effect.scoped,
        Effect.flip,
      ),
    );

    expect(error).toBe(validationError);
    expect(sessionNewCalls).toBe(0);
  });
});

describe("AcpSessionRuntime startup timeouts", () => {
  // Per-step budget; the aggregate handshake budget stays far above it so the
  // step timeout is what fires first.
  const STEP_TIMEOUT_MS = 1_000;
  const TOTAL_TIMEOUT_MS = 60_000;
  // Generous vitest timeout: the flow is real-async and contains no sleeps,
  // but a regression that stalls the handshake should fail visibly, not hang.
  const TEST_TIMEOUT_MS = 15_000;

  /**
   * Returns an ACP request handler that records that the request arrived and
   * then holds the response open in-process. Only the runtime's step budget
   * (advanced on the test clock) can resolve it.
   */
  const holdResponseOpen = (received: Deferred.Deferred<void>) => () => {
    Deferred.doneUnsafe(received, Effect.succeed(undefined));
    return new Promise<never>(() => {});
  };

  /**
   * Bridges an in-memory OfficialAcp.agent() to the runtime through a fake
   * ChildProcessSpawner, then runs start until the step budget fires.
   */
  const runStartTimeout = (input: {
    readonly agentApp: OfficialAcp.AgentApp;
    readonly received: Deferred.Deferred<void>;
  }) => {
    const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
    const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());

    const agentInput = new ReadableStream<Uint8Array>({
      pull(controller) {
        return Effect.runPromise(Queue.take(clientToAgent)).then((chunk) => {
          controller.enqueue(chunk);
        });
      },
    });
    const agentOutput = new WritableStream<Uint8Array>({
      write(chunk) {
        return Effect.runPromise(Queue.offer(agentToClient, chunk)).then(() => undefined);
      },
    });

    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          input.agentApp.connect(OfficialAcp.ndJsonStream(agentOutput, agentInput));
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(clientToAgent, chunk)),
            stdout: Stream.fromQueue(agentToClient),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          });
        }),
      ),
    );

    const tornDownPids: number[] = [];

    const runtimeLayer = AcpSessionRuntime.layer({
      spawn: { command: "in-memory-acp-agent", args: [] },
      cwd: process.cwd(),
      clientInfo: { name: "synara-test", version: "0.0.0" },
      authPolicy: "always",
      authMethodId: "test-auth",
      startupTimeouts: {
        initializeMs: STEP_TIMEOUT_MS,
        authenticateMs: STEP_TIMEOUT_MS,
        sessionSetupMs: STEP_TIMEOUT_MS,
        totalMs: TOTAL_TIMEOUT_MS,
      },
      teardownProcessTree: async ({ rootPid }) => {
        tornDownPids.push(rootPid);
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(Layer.provide(spawnerLayer));

    const program = Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const startFiber = yield* runtime.start().pipe(Effect.forkChild);
      yield* Deferred.await(input.received);
      yield* TestClock.adjust(Duration.millis(STEP_TIMEOUT_MS));
      yield* Effect.yieldNow;
      return yield* Fiber.join(startFiber).pipe(Effect.flip);
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(runtimeLayer), Effect.scoped);

    return Effect.runPromise(program).then((error) => ({ error, tornDownPids }));
  };

  it(
    "times out initialize with acp-startup-timeout and tears the child down",
    async () => {
      const received = Deferred.makeUnsafe<void>();
      const agentApp = OfficialAcp.agent({ name: "startup-timeout-agent" }).onRequest(
        OfficialAcp.methods.agent.initialize,
        holdResponseOpen(received),
      );

      const { error, tornDownPids } = await runStartTimeout({ agentApp, received });

      expect(isAcpStartupTimeoutError(error)).toBe(true);
      expect(error).toMatchObject({
        code: -32001,
        errorMessage: "ACP agent did not respond to initialize within 1s.",
        data: { reason: "acp-startup-timeout", step: "initialize", timeoutMs: STEP_TIMEOUT_MS },
      });
      expect(tornDownPids).toEqual([1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "times out authenticate with acp-startup-timeout and tears the child down",
    async () => {
      const received = Deferred.makeUnsafe<void>();
      const agentApp = OfficialAcp.agent({ name: "startup-timeout-agent" })
        .onRequest(OfficialAcp.methods.agent.initialize, () => ({
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
        }))
        .onRequest(OfficialAcp.methods.agent.authenticate, holdResponseOpen(received));

      const { error, tornDownPids } = await runStartTimeout({ agentApp, received });

      expect(isAcpStartupTimeoutError(error)).toBe(true);
      expect(error).toMatchObject({
        code: -32001,
        errorMessage: "ACP agent did not respond to authenticate within 1s.",
        data: { reason: "acp-startup-timeout", step: "authenticate", timeoutMs: STEP_TIMEOUT_MS },
      });
      expect(tornDownPids).toEqual([1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "times out session setup with acp-startup-timeout and tears the child down",
    async () => {
      const received = Deferred.makeUnsafe<void>();
      const agentApp = OfficialAcp.agent({ name: "startup-timeout-agent" })
        .onRequest(OfficialAcp.methods.agent.initialize, () => ({
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
        }))
        .onRequest(OfficialAcp.methods.agent.authenticate, () => ({}))
        .onRequest(OfficialAcp.methods.agent.session.new, holdResponseOpen(received));

      const { error, tornDownPids } = await runStartTimeout({ agentApp, received });

      expect(isAcpStartupTimeoutError(error)).toBe(true);
      expect(error).toMatchObject({
        code: -32001,
        errorMessage: "ACP agent did not respond to session/new within 1s.",
        data: { reason: "acp-startup-timeout", step: "session/new", timeoutMs: STEP_TIMEOUT_MS },
      });
      expect(tornDownPids).toEqual([1]);
    },
    TEST_TIMEOUT_MS,
  );
});
