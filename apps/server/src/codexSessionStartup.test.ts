import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ThreadId } from "@synara/contracts";
import { spawnProcess } from "@synara/shared/processRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager.ts";
import { CodexSessionStartError } from "./codexErrorClassification.ts";
import { ServerConfig } from "./config.ts";
import { classifyProviderAttemptOutcome } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter.ts";
import { CodexAdapter } from "./provider/Services/CodexAdapter.ts";

vi.mock("@synara/shared/processRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synara/shared/processRuntime")>()),
  spawnProcess: vi.fn(),
}));

class FakeCodexChild extends EventEmitter {
  readonly pid = 42424;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  exit() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

function createStartupHarness(failingMethod?: string, failure: "error" | "exit" = "error") {
  const child = new FakeCodexChild();
  const requests: string[] = [];
  const transportError = new Error("Codex pipe failed during startup: ECONNRESET");
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as { id?: number; method: string };
    requests.push(request.method);
    if (request.method === failingMethod) {
      queueMicrotask(() => {
        if (failure === "exit") child.exit();
        else child.emit("error", transportError);
      });
    } else if (request.id !== undefined) {
      queueMicrotask(() => {
        const result = request.method === "thread/resume" ? { thread: { id: "native-thread" } } : {};
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      });
    }
  });
  vi.mocked(spawnProcess)
    .mockReset()
    .mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  const teardownProcessTree = vi.fn(async () => {
    child.exit();
    return { escalated: false, signalErrors: [] };
  });
  const manager = new CodexAppServerManager(undefined, { teardownProcessTree });
  const internals = manager as unknown as {
    assertSupportedCodexCliVersion: () => Promise<void>;
    buildSessionProcessEnv: () => Promise<NodeJS.ProcessEnv>;
  };
  vi.spyOn(internals, "assertSupportedCodexCliVersion").mockResolvedValue(undefined);
  vi.spyOn(internals, "buildSessionProcessEnv").mockResolvedValue({});
  const input = {
    threadId: ThreadId.makeUnsafe("thread-startup-failed"),
    cwd: process.cwd(),
    runtimeMode: "full-access" as const,
    resumeCursor: { threadId: "codex-existing-thread" },
  };
  const expectedErrorMessage =
    failure === "exit"
      ? "codex app-server exited (code=0, signal=null)."
      : transportError.message;
  return { manager, child, input, requests, teardownProcessTree, expectedErrorMessage };
}

afterEach(() => vi.restoreAllMocks());

describe("Codex session startup failures", () => {
  it.each([
    ["initialize", "error"],
    ["account/read", "error"],
    ["thread/resume", "error"],
    ["initialize", "exit"],
    ["thread/resume", "exit"],
  ] as const)(
    "preserves the cause during %s/%s and confirms cleanup before rejecting",
    async (method, failure) => {
      const { manager, child, input, requests, teardownProcessTree, expectedErrorMessage } =
        createStartupHarness(method, failure);
      let proveExit: (() => void) | undefined;
      const exitProof = new Promise<void>((resolve) => {
        proveExit = resolve;
      });
      teardownProcessTree.mockImplementation(async () => {
        await exitProof;
        child.exit();
        return { escalated: false, signalErrors: [] };
      });
      let settled = false;
      const result = manager.startSession(input).catch((error: unknown) => error);
      void result.then(() => {
        settled = true;
      });
      try {
        await vi.waitFor(() => expect(teardownProcessTree).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        expect(manager.hasSession(input.threadId)).toBe(false);
      } finally {
        proveExit?.();
      }
      const error = await result;
      expect(error).toBeInstanceOf(CodexSessionStartError);
      expect(error).toMatchObject({
        message: expectedErrorMessage,
        cause: { message: expectedErrorMessage },
      });
      expect(requests).not.toContain("turn/start");
      expect(requests).not.toContain("thread/start");
      expect(manager.listSessions()).toEqual([]);
    },
  );

  it.each(["error", "exit"] as const)(
    "keeps failed cleanup and failed replacement barriers uncertain after %s",
    async (failure) => {
      const { manager, child, input, teardownProcessTree } = createStartupHarness(
        "initialize",
        failure,
      );
      teardownProcessTree.mockRejectedValue(
        new Error(`rootExited=${failure === "exit"}; surviving descendant remains`),
      );
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const error = await manager.startSession(input).catch((error: unknown) => error);
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(CodexSessionStartError);
          expect(error).toMatchObject({
            message: expect.stringContaining("Failed to prove Codex app-server process-tree exit"),
          });
        }
        expect(spawnProcess).toHaveBeenCalledTimes(1);
      } finally {
        teardownProcessTree.mockImplementation(async () => {
          child.exit();
          return { escalated: false, signalErrors: [] };
        });
        await manager.stopAll();
      }
    },
  );

  it("keeps a turn uncertain when stdin closes after accepting its frame", async () => {
    const { manager, child, input } = createStartupHarness();
    await manager.startSession(input);
    let acceptedFrame: unknown;
    vi.spyOn(child.stdin, "write").mockImplementation((frame) => {
      acceptedFrame = JSON.parse(String(frame));
      // The provider can receive the frame before the stream's write callback
      // confirms it. Closing here loses acknowledgement, not proof of delivery.
      queueMicrotask(() => child.stdin.emit("close"));
      return true;
    });
    const layer = makeCodexAdapterLive({ manager }).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "codex-write-uncertain-" })),
      Layer.provide(NodeServices.layer),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        return yield* adapter
          .sendTurn({ threadId: input.threadId, input: "Apply the change", attachments: [] })
          .pipe(Effect.result);
      }).pipe(Effect.provide(layer)),
    );
    expect(acceptedFrame).toMatchObject({ method: "turn/start" });
    if (result._tag !== "Failure") throw new Error("Expected lost acknowledgement");
    expect(result.failure._tag).toBe("ProviderAdapterRequestError");
    expect(classifyProviderAttemptOutcome(Exit.fail(result.failure))._tag).toBe("uncertain");
  });
});
