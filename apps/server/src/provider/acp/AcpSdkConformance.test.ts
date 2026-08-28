// Verifies the current Synara ACP boundary against an official-SDK subprocess.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION, client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { afterEach, describe, expect, it as test } from "vitest";

import { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/acp-conformance-agent.ts",
);
const officialMockFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);
const temporaryDirectories: string[] = [];

interface FixtureLogEntry {
  readonly type: string;
  readonly payload: unknown;
}

function createFixtureLog(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "synara-acp-conformance-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "fixture.jsonl");
}

function readFixtureLog(logPath: string): ReadonlyArray<FixtureLogEntry> {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readJsonLines(logPath: string): ReadonlyArray<Record<string, unknown>> {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function canonicalWireMessage(message: Record<string, unknown>): Record<string, unknown> {
  const { id: _requestId, ...canonical } = message;
  return canonical;
}

function captureByteStream(
  input: ReadableStream<Uint8Array>,
  capture: Uint8Array[],
): ReadableStream<Uint8Array> {
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        capture.push(chunk.slice());
        controller.enqueue(chunk);
      },
    }),
  );
}

function runtimeLayer(logPath: string, env: Record<string, string> = {}) {
  return AcpSessionRuntime.layer({
    spawn: {
      command: process.execPath,
      args: [fixturePath],
      env: {
        VITEST: "true",
        SYNARA_ACP_CONFORMANCE_LOG_PATH: logPath,
        ...env,
      },
    },
    cwd: process.cwd(),
    clientCapabilities: {
      _meta: {
        primitive: "client-meta",
        nested: { source: "synara" },
      },
    },
    clientInfo: { name: "synara-conformance-test", version: "0.0.0" },
    authMethodId: "test",
    authenticateMeta: {
      primitive: 11,
      nested: { source: "synara-auth" },
    },
  });
}

function noAuthenticationRuntimeLayer(logPath: string) {
  return AcpSessionRuntime.layer({
    spawn: {
      command: process.execPath,
      args: [fixturePath],
      env: {
        VITEST: "true",
        SYNARA_ACP_CONFORMANCE_LOG_PATH: logPath,
        SYNARA_ACP_CONFORMANCE_NO_AUTH: "1",
      },
    },
    cwd: process.cwd(),
    clientInfo: { name: "synara-no-auth-test", version: "0.0.0" },
    authentication: "when-advertised",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("official ACP SDK conformance at the current Synara boundary", () => {
  it.effect("negotiates initialize and authentication using official SDK handlers", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started).toMatchObject({
        sessionId: "official-sdk-session-1",
        sessionSetupMethod: "new",
        initializeResult: {
          protocolVersion: 1,
          authMethods: [{ id: "test", name: "Test authentication" }],
        },
      });
      expect(started.initializeResult._meta).toEqual({
        primitive: "initialize-meta",
        nested: { source: "official-sdk" },
      });
      expect(started.sessionSetupResult._meta).toEqual({
        primitive: 7,
        nested: { phase: "new" },
      });

      const entries = readFixtureLog(logPath);
      expect(entries.map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/new",
      ]);
      expect(entries[0]?.payload).toMatchObject({
        protocolVersion: 1,
        clientInfo: { name: "synara-conformance-test", version: "0.0.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: {
            primitive: "client-meta",
            nested: { source: "synara" },
          },
        },
      });
      expect(entries[1]?.payload).toEqual({
        methodId: "test",
        _meta: {
          primitive: 11,
          nested: { source: "synara-auth" },
        },
      });
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("skips authentication when a generic ACP agent advertises no methods", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.initializeResult.authMethods).toEqual([]);
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "session/new",
      ]);
    }).pipe(
      Effect.provide(noAuthenticationRuntimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("preserves early session updates and prompt update ordering", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const result = yield* runtime.prompt({
        prompt: [{ type: "text", text: "continue" }],
      });
      const events = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 7)));

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(events.map((event) => event._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
        "AssistantItemStarted",
        "ContentDelta",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      expect(
        events.flatMap((event) => (event._tag === "ContentDelta" ? [event.text] : [])),
      ).toEqual(["early-new", "prompt-one", "prompt-two"]);
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("fails pending work when the official-SDK subprocess exits", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      const exit = yield* runtime
        .request("conformance/exit", {})
        .pipe(Effect.timeout("2 seconds"), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(readFixtureLog(logPath).some((entry) => entry.type === "conformance/exit")).toBe(true);
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("uses the official SDK malformed-line policy without a second parser", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.timeout("2 seconds"));
      expect(started.sessionId).toBe("official-sdk-session-1");
    }).pipe(
      Effect.provide(
        runtimeLayer(logPath, {
          SYNARA_ACP_CONFORMANCE_MALFORMED_PREFIX: "1",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("round-trips extension requests and delivers extension notifications", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.notify("conformance/notice", {
        primitive: false,
        nested: { source: "synara-notice" },
      });
      const response = yield* runtime.request("conformance/echo", {
        primitive: 42,
        nested: { source: "synara-request" },
      });

      expect(response).toEqual({
        echo: {
          primitive: 42,
          nested: { source: "synara-request" },
        },
        _meta: {
          primitive: true,
          nested: { source: "official-sdk" },
        },
      });
      expect(
        readFixtureLog(logPath)
          .filter((entry) => entry.type.startsWith("conformance/"))
          .map((entry) => entry.type),
      ).toEqual(["conformance/notice", "conformance/echo"]);
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("cancels an in-flight official-SDK prompt with session/cancel", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      const ready = yield* runtime.getEvents().pipe(
        Stream.filter((event) => event._tag === "ContentDelta" && event.text === "cancel-ready"),
        Stream.runHead,
        Effect.forkChild,
      );
      const prompt = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "wait-for-cancel" }] })
        .pipe(Effect.forkChild);

      expect(yield* Fiber.join(ready)).toBeDefined();
      yield* runtime.cancel;
      expect(yield* Fiber.join(prompt)).toEqual({ stopReason: "cancelled" });
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/new",
        "session/prompt",
        "session/cancel",
      ]);
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("cancels an extension request through official-SDK $/cancel_request", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const ready = yield* Deferred.make<void>();
      const observed = yield* Deferred.make<void>();
      yield* runtime.handleExtNotification("conformance/generic-cancel-ready", Schema.Unknown, () =>
        Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      );
      yield* runtime.handleExtNotification(
        "conformance/generic-cancel-observed",
        Schema.Unknown,
        () => Deferred.succeed(observed, undefined).pipe(Effect.asVoid),
      );
      yield* runtime.start();
      const request = yield* runtime
        .request("conformance/wait-for-generic-cancel", { source: "synara" })
        .pipe(Effect.forkChild);

      yield* Deferred.await(ready);
      yield* Fiber.interrupt(request);
      yield* Deferred.await(observed);
      expect(
        readFixtureLog(logPath)
          .filter((entry) => entry.type.startsWith("conformance/"))
          .map((entry) => entry.type),
      ).toEqual(["conformance/wait-for-generic-cancel", "conformance/generic-cancel-observed"]);
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});

describe("official ACP SDK client against the official SDK mock agent", () => {
  test("completes initialize, authentication, session, prompt, updates, stop, and teardown", async () => {
    const requestLogPath = createFixtureLog();
    const exitLogPath = createFixtureLog();
    const child = spawn(process.execPath, [officialMockFixturePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SYNARA_ACP_REQUEST_LOG_PATH: requestLogPath,
        SYNARA_ACP_EXIT_LOG_PATH: exitLogPath,
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: "mock says héllo 👋",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    const agentWireChunks: Uint8Array[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    let workflowCompleted = false;
    try {
      const agentOutput = captureByteStream(
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        agentWireChunks,
      );
      const result = await client({ name: "official-sdk-reverse-conformance" }).connectWith(
        ndJsonStream(Writable.toWeb(child.stdin), agentOutput),
        async (agent) => {
          const initializeResult = await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "official-sdk-reverse-conformance", version: "1.0.0" },
          });
          const authenticateResult = await agent.request(methods.agent.authenticate, {
            methodId: "test",
          });
          return agent.buildSession("/conformance/repo").withSession(async (session) => {
            const promptResult = session.prompt("reverse compatibility");
            const updates = [];
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                return {
                  initializeResult,
                  authenticateResult,
                  sessionResult: session.newSessionResponse,
                  promptResult: await promptResult,
                  stopResponse: message.response,
                  updates,
                };
              }
              updates.push(message.notification);
            }
          });
        },
      );
      workflowCompleted = true;

      expect(result.initializeResult).toMatchObject({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      });
      expect(result.authenticateResult).toEqual({});
      expect(result.sessionResult.sessionId).toBe("mock-session-1");
      expect(result.promptResult).toEqual({ stopReason: "end_turn" });
      expect(result.stopResponse).toEqual(result.promptResult);
      expect(
        result.updates,
        `Agent wire: ${Buffer.concat(agentWireChunks).toString("utf8")}`,
      ).toEqual([
        {
          sessionId: "mock-session-1",
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
        },
        {
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "mock says héllo 👋" },
          },
        },
      ]);

      const rawNotifications = Buffer.concat(agentWireChunks)
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((message) => message.method === "session/update");
      expect(rawNotifications).toEqual(
        result.updates.map((params) => ({
          jsonrpc: "2.0",
          method: "session/update",
          params,
        })),
      );

      const clientWire = readJsonLines(requestLogPath);
      expect(clientWire.map((message) => message.id)).toEqual([0, 1, 2, 3]);
      expect(clientWire.map(canonicalWireMessage)).toEqual([
        {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "official-sdk-reverse-conformance", version: "1.0.0" },
          },
        },
        {
          jsonrpc: "2.0",
          method: "authenticate",
          params: { methodId: "test" },
        },
        {
          jsonrpc: "2.0",
          method: "session/new",
          params: { cwd: "/conformance/repo", mcpServers: [] },
        },
        {
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            sessionId: "mock-session-1",
            prompt: [{ type: "text", text: "reverse compatibility" }],
          },
        },
      ]);
    } finally {
      child.kill("SIGTERM");
      const exit = await exited;
      if (workflowCompleted) {
        expect(exit).toEqual({ code: 0, signal: null });
        expect(readFileSync(exitLogPath, "utf8").trim().split("\n")).toEqual(["SIGTERM", "exit:0"]);
        expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("");
      }
    }
  });
});

describe("official ACP SDK byte-stream characterization", () => {
  test("decodes JSON lines split inside UTF-8 code points and across partial lines", async () => {
    const encoder = new TextEncoder();
    const first = encoder.encode(
      `${JSON.stringify({ jsonrpc: "2.0", method: "conformance/notice", params: { text: "héllo 👋" } })}\n`,
    );
    const second = encoder.encode(
      `${JSON.stringify({ jsonrpc: "2.0", id: "response-1", result: { text: "done ✅" } })}\n`,
    );
    const bytes = new Uint8Array(first.length + second.length);
    bytes.set(first);
    bytes.set(second, first.length);
    const waveStart = bytes.indexOf(0xf0);
    expect(waveStart).toBeGreaterThan(0);
    const splitOffsets = [1, waveStart + 1, waveStart + 3, first.length - 1, first.length + 5];
    const chunks = splitOffsets
      .concat(bytes.length)
      .map((end, index) => bytes.slice(index === 0 ? 0 : splitOffsets[index - 1], end));
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const stream = ndJsonStream(new WritableStream<Uint8Array>(), input);
    const reader = stream.readable.getReader();

    expect((await reader.read()).value).toEqual({
      jsonrpc: "2.0",
      method: "conformance/notice",
      params: { text: "héllo 👋" },
    });
    expect((await reader.read()).value).toEqual({
      jsonrpc: "2.0",
      id: "response-1",
      result: { text: "done ✅" },
    });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("drains a finite notification burst with explicit count and byte bounds", async () => {
    const notificationCount = 512;
    const encoder = new TextEncoder();
    const lines = Array.from({ length: notificationCount }, (_, sequence) =>
      encoder.encode(
        `${JSON.stringify({ jsonrpc: "2.0", method: "conformance/burst", params: { sequence } })}\n`,
      ),
    );
    const totalBytes = lines.reduce((total, line) => total + line.byteLength, 0);
    let pullCount = 0;
    let received = 0;
    let maxBufferedLead = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        const line = lines[pullCount];
        if (!line) {
          controller.close();
          return;
        }
        pullCount += 1;
        maxBufferedLead = Math.max(maxBufferedLead, pullCount - received);
        controller.enqueue(line);
      },
    });
    const reader = ndJsonStream(new WritableStream<Uint8Array>(), input).readable.getReader();
    let lastSequence = -1;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      received += 1;
      if (!("params" in item.value)) throw new Error("Expected ACP notification params");
      lastSequence = (item.value.params as { sequence: number }).sequence;
    }

    expect(received).toBe(notificationCount);
    expect(lastSequence).toBe(notificationCount - 1);
    expect(pullCount).toBe(notificationCount);
    expect(maxBufferedLead).toBeLessThanOrEqual(4);
    expect(totalBytes).toBeLessThan(64 * 1024);
  });
});
