import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { AntigravityAdapter } from "../Services/AntigravityAdapter";
import {
  makeAntigravityAdapterLive,
  type AntigravityAdapterDependencies,
} from "./AntigravityAdapter";

const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const done = {
  event: "step_update",
  step_update: {
    step_index: 3,
    step_type: "agent_response",
    state: "DONE",
    text_delta: "Finished",
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 20 },
  },
};
const checkpoint = {
  event: "step_update",
  step_update: { step_index: 4, step_type: "checkpoint", state: "DONE" },
};
const envelope = (error?: string, num_turns = 1, status = error ? "ERROR" : "SUCCESS") => ({
  event: "result",
  result: { status, error, num_turns, response: "Finished" },
});
async function runPrintTurn(input: {
  stdout?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  hooks?: string[];
  transcript?: unknown[];
  stop?: boolean;
  interrupt?: boolean;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-output-"));
  let child: ChildProcess;
  let eventFile: string;
  const transcriptFile = path.join(root, "transcript.jsonl");
  const spawnProcess = ((
    _cmd: string,
    _args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    eventFile = options.env!.SYNARA_ANTIGRAVITY_EVENTS!;
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
    return child;
  }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AntigravityAdapter;
        const threadId = ThreadId.makeUnsafe("antigravity-output");
        yield* adapter.startSession({
          provider: "antigravity",
          threadId,
          runtimeMode: "full-access",
          cwd: root,
          providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((e) => e.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId, input: "output lifecycle", attachments: [] });
        if (input.transcript)
          yield* Effect.promise(() =>
            fs.writeFile(transcriptFile, encode(input.transcript!) + "\n"),
          );
        const hooks = [
          `pre-invocation\t${JSON.stringify({ conversationId: "output-conversation", ...(input.transcript ? { transcriptPath: transcriptFile } : {}) })}`,
          ...(input.hooks ?? []),
          ...(input.stop ? ["stop\t{}"] : []),
        ];
        yield* Effect.promise(() => fs.writeFile(eventFile, hooks.join("\n") + "\n"));
        if (input.stdout) child!.stdout!.emit("data", input.stdout);
        if (input.interrupt) yield* adapter.interruptTurn(threadId);
        child!.emit("close", input.code === undefined ? 0 : input.code, input.signal ?? null);
        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("3 seconds")));
        yield* adapter.stopSession(threadId);
        return events;
      }).pipe(
        Effect.provide(
          makeAntigravityAdapterLive({
            ensurePlugin: async () => undefined,
            spawnProcess,
            teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
          }).pipe(
            Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "antigravity-output-" })),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const terminalPayload = (events: Awaited<ReturnType<typeof runPrintTurn>>) =>
  events.find((e) => e.type === "turn.completed")?.payload;
const textPayloads = (events: Awaited<ReturnType<typeof runPrintTurn>>) =>
  events.filter((e) => e.type === "content.delta").map((e) => e.payload);
const preToolHook = (step: number) =>
  `pre-tool\t${JSON.stringify({ stepIdx: step, toolCall: { name: "run_command", args: { CommandLine: "echo same" } } })}`;
const postToolHook = (step: number) =>
  `post-tool\t${JSON.stringify({ stepIdx: step, toolCall: { name: "run_command" }, error: "" })}`;
const transcriptToolStep = (step: number) => ({
  step_index: step,
  type: "PLANNER_RESPONSE",
  tool_calls: [{ name: "run_command", args: { CommandLine: "echo same" } }],
});
describe("Antigravity structured output lifecycle", () => {
  it.each([
    "[Read this](https://example.com)",
    "{example}",
    '{"answer":42}',
    "Long response ".repeat(12000),
  ])("preserves legacy text output %#", async (stdout) => {
    const events = await runPrintTurn({ stdout });
    expect(textPayloads(events)).toEqual([{ streamKind: "assistant_text", delta: stdout.trim() }]);
    expect(terminalPayload(events)).toMatchObject({ state: "completed" });
  });
  it("explicit user interruption remains interrupted and suppresses late raw stdout", async () => {
    const events = await runPrintTurn({
      stdout: encode([done]),
      code: null,
      signal: "SIGKILL",
      interrupt: true,
    });
    expect(terminalPayload(events)).toMatchObject({ state: "interrupted" });
    expect(textPayloads(events)).toEqual([]);
  });
  it("normal SUCCESS with a trailing checkpoint preserves response text", async () => {
    const events = await runPrintTurn({ stdout: encode([done, checkpoint, envelope()]) });
    expect(terminalPayload(events)).toMatchObject({
      state: "completed",
    });
    expect(textPayloads(events)).toEqual([{ streamKind: "assistant_text", delta: "Finished" }]);
  });
  it.each([1, 2])("does not recover a genuine error on conversation turn %s", async (turns) => {
    expect(
      terminalPayload(
        await runPrintTurn({ stdout: encode([done, envelope("quota exceeded", turns)]), code: 1 }),
      ),
    ).toMatchObject({ state: "failed" });
  });
  it("keeps explicit timeout errors failed even after a stop hook", async () => {
    expect(
      terminalPayload(
        await runPrintTurn({
          stdout: encode([done, checkpoint, envelope("timeout waiting for response")]),
          stop: true,
          code: null,
          signal: "SIGKILL",
        }),
      ),
    ).toMatchObject({ state: "failed" });
  });
  it("settles its own stop-hook teardown from a DONE response and checkpoint without a result", async () => {
    const events = await runPrintTurn({
      stdout: encode([done, checkpoint]),
      stop: true,
      code: null,
      signal: "SIGKILL",
    });
    expect(textPayloads(events)).toEqual([{ streamKind: "assistant_text", delta: "Finished" }]);
    expect(terminalPayload(events)).toMatchObject({ state: "completed" });
  });
  it("keeps a missing-result process failure failed and preserves only response text", async () => {
    const events = await runPrintTurn({ stdout: encode([done]), code: 1 });
    expect(textPayloads(events)).toEqual([{ streamKind: "assistant_text", delta: "Finished" }]);
    expect(terminalPayload(events)).toMatchObject({ state: "failed" });
  });
  it("preserves a valid result before an incomplete trailing record", async () => {
    const events = await runPrintTurn({
      stdout: encode([done, envelope()]) + '\n{"event":',
      code: 0,
    });
    expect(textPayloads(events)).toEqual([{ streamKind: "assistant_text", delta: "Finished" }]);
    expect(terminalPayload(events)).toMatchObject({ state: "completed" });
  });
  it("retains different identical calls when one is hook-only and one transcript-only", async () => {
    const events = await runPrintTurn({
      hooks: [preToolHook(2), postToolHook(2)],
      transcript: [transcriptToolStep(5)],
    });
    expect(
      events.filter((e) => e.type === "item.started" && e.payload.itemType === "command_execution"),
    ).toHaveLength(2);
  });
  it.each(["CANCELED", "INTERRUPTED"])(
    "honors %s without a user-requested interrupt",
    async (status) => {
      expect(
        terminalPayload(
          await runPrintTurn({ stdout: encode([done, envelope(undefined, 2, status)]), code: 1 }),
        ),
      ).toMatchObject({ state: "interrupted" });
    },
  );
  it.each(["INVALID", "WAITING", "RUNNING"])(
    "does not complete terminal status %s on exit zero",
    async (status) => {
      expect(
        terminalPayload(
          await runPrintTurn({ stdout: encode([envelope(undefined, 1, status)]), code: 0 }),
        ),
      ).toMatchObject({ state: "failed" });
    },
  );
});
