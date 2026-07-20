// FILE: AcpSessionRuntime.epoch.test.ts
// Purpose: Regression test for atomic session/update capture during the setSessionEpoch transition window.
// Layer: Provider ACP runtime tests

import * as OfficialAcp from "@agentclientprotocol/sdk";
import { Deferred, Effect, Fiber, Layer, Option, Queue, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

const FINAL_SESSION_ID = "session-epoch-final";

/**
 * Bridges an in-memory OfficialAcp.agent() to the runtime through a fake
 * ChildProcessSpawner: the "child" stdin/stdout are Queue-bridged to the
 * agent's ReadableStream/WritableStream transport.
 */
function makeInMemoryAgentSpawner() {
  const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
  const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());

  let agentConnection: OfficialAcp.AgentConnection | undefined;

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

  const agentApp = OfficialAcp.agent({ name: "epoch-test-agent" })
    .onRequest(OfficialAcp.methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
    }))
    .onRequest(OfficialAcp.methods.agent.session.new, () => ({
      sessionId: FINAL_SESSION_ID,
    }));

  const connectAgent = () => {
    agentConnection = agentApp.connect(OfficialAcp.ndJsonStream(agentOutput, agentInput));
    return agentConnection;
  };

  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        connectAgent();
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

  return {
    spawnerLayer,
    getAgentConnection: () => {
      if (!agentConnection) throw new Error("agent connection not established");
      return agentConnection;
    },
  };
}

/** Settles the in-memory transport and the client's session/update dispatch chain. */
async function flushTransport(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("AcpSessionRuntime session epoch transition", () => {
  it("applies a session/update that arrives during the setSessionEpoch transition window exactly once", async () => {
    const { spawnerLayer, getAgentConnection } = makeInMemoryAgentSpawner();

    const transitionReached = Deferred.makeUnsafe<void>();
    const transitionPause = Deferred.makeUnsafe<void>();

    const runtimeLayer = AcpSessionRuntime.layer({
      spawn: { command: "in-memory-acp-agent", args: [] },
      cwd: process.cwd(),
      clientInfo: { name: "synara-test", version: "0.0.0" },
      authPolicy: "on-demand",
      teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
      __testTransitionReached: Deferred.succeed(transitionReached, undefined).pipe(Effect.asVoid),
      __testTransitionPause: Deferred.await(transitionPause),
    }).pipe(Layer.provide(spawnerLayer));

    const program = Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;

      // Start the runtime in a fiber; it will block inside the transition window.
      const startFiber = yield* runtime.start().pipe(Effect.forkChild);

      // Wait until setSessionEpoch has captured the pending buffer but has
      // not yet installed the final epoch.
      yield* Deferred.await(transitionReached);

      // Deliver a session/update for the final session id inside the window
      // and let it settle into the pending buffer.
      yield* Effect.promise(() =>
        getAgentConnection().client.notify(OfficialAcp.methods.client.session.update, {
          sessionId: FINAL_SESSION_ID,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "epoch-window-command", description: "delivered mid-transition" },
            ],
          },
        }),
      );
      yield* Effect.promise(() => flushTransport());

      // Resume the transition and join the start fiber.
      yield* Deferred.succeed(transitionPause, undefined);
      const started = yield* Fiber.join(startFiber);
      expect(started.sessionId).toBe(FINAL_SESSION_ID);

      // Let any in-flight handler dispatch settle before asserting.
      yield* Effect.promise(() => flushTransport());

      const commands = yield* runtime.getAvailableCommands;
      const delivered = commands.filter((command) => command.name === "epoch-window-command");
      expect(delivered).toHaveLength(1);
      expect(commands).toHaveLength(1);

      const epoch = yield* runtime.getSessionEpoch();
      expect(Option.isSome(epoch.activeSessionId)).toBe(true);
      expect(Option.getOrThrow(epoch.activeSessionId)).toBe(FINAL_SESSION_ID);

      // No pending state may remain after the transition.
      const pending = yield* runtime.getPendingSessionNotificationCount();
      expect(pending).toBe(0);
    }).pipe(Effect.provide(runtimeLayer), Effect.scoped);

    await Effect.runPromise(program);
  }, 15_000);
});
