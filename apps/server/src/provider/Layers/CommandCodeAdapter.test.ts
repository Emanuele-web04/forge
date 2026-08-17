import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { resolveCommandCodeBinaryPath } from "../commandCodeCli.ts";
import { CommandCodeAdapter } from "../Services/CommandCodeAdapter.ts";

import {
  buildCommandCodeTurnArgs,
  commandCodeReviewPrompt,
  type CommandCodeAdapterDependencies,
  makeCommandCodeAdapterLive,
  parseCommandCodeModelLines,
} from "./CommandCodeAdapter.ts";

describe("CommandCodeAdapter", () => {
  it("uses the non-reserved cmdc binary name on Windows", () => {
    expect(resolveCommandCodeBinaryPath("cmd", "win32")).toBe("cmdc");
    expect(resolveCommandCodeBinaryPath("C:\\tools\\command-code.exe", "win32")).toBe(
      "C:\\tools\\command-code.exe",
    );
  });
  it("parses model IDs and descriptions from the CLI catalog", () => {
    expect(
      parseCommandCodeModelLines(`Free models
poolside/laguna-s-2.1-free  Laguna S 2.1 (free)

Other models
anthropic/claude-sonnet-4-6  Claude Sonnet 4.6
not a model heading`),
    ).toEqual([
      {
        slug: "poolside/laguna-s-2.1-free",
        name: "poolside/laguna-s-2.1-free",
        description: "Laguna S 2.1 (free)",
      },
      {
        slug: "anthropic/claude-sonnet-4-6",
        name: "anthropic/claude-sonnet-4-6",
        description: "Claude Sonnet 4.6",
      },
    ]);
  });

  it("uses resumable NDJSON print mode and maps permission modes", () => {
    expect(
      buildCommandCodeTurnArgs({
        model: "poolside/laguna-s-2.1-free",
        resumeSessionId: "session-1",
        runtimeMode: "full-access",
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "poolside/laguna-s-2.1-free",
      "--skip-onboarding",
      "--no-auto-update",
      "--max-turns",
      "100",
      "--resume",
      "session-1",
      "--yolo",
    ]);
    expect(buildCommandCodeTurnArgs({ model: "model", runtimeMode: "auto" })).toContain(
      "--auto-accept",
    );
    expect(
      buildCommandCodeTurnArgs({
        model: "model",
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    ).toContain("--plan");
    expect(
      buildCommandCodeTurnArgs({ model: "model", runtimeMode: "approval-required" }),
    ).not.toEqual(expect.arrayContaining(["--yolo", "--auto-accept"]));
    expect(
      buildCommandCodeTurnArgs({
        model: "model",
        runtimeMode: "full-access",
        interactionMode: "debug",
      }),
    ).toEqual(expect.arrayContaining(["--yolo"]));
  });

  it("projects Synara review targets into deterministic review prompts", () => {
    expect(commandCodeReviewPrompt({ type: "uncommittedChanges" })).toContain(
      "current uncommitted changes",
    );
    expect(commandCodeReviewPrompt({ type: "baseBranch", branch: "origin/main" })).toContain(
      'base branch "origin/main"',
    );
  });

  it("streams canonical events and keeps prompts out of argv", async () => {
    const captured: { args?: readonly string[]; prompt?: string } = {};
    const spawnProcess = ((_command: string, args: readonly string[]) => {
      captured.args = args;
      const child = new EventEmitter() as ChildProcess;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        pid: 42_424,
        stdin,
        stdout,
        stderr,
        killed: false,
        kill: () => true,
      });
      let prompt = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        prompt += chunk;
      });
      stdin.once("finish", () => {
        captured.prompt = prompt;
        stdout.write(
          `${JSON.stringify({ type: "event", event: { type: "run_start", sessionId: "cc-session-1" } })}\n`,
        );
        stdout.write(
          `${JSON.stringify({ type: "event", event: { type: "text_delta", delta: "Hello" } })}\n`,
        );
        stdout.write(
          `${JSON.stringify({ type: "event", event: { type: "tool_running", toolCallId: "tool-1", toolName: "shell", description: "pwd" } })}\n`,
        );
        stdout.write(
          `${JSON.stringify({ type: "event", event: { type: "tool_completed", toolCallId: "tool-1", toolName: "shell", result: [{ type: "text", text: "/repo" }] } })}\n`,
        );
        stdout.end(
          `${JSON.stringify({ type: "result", subtype: "success", sessionId: "cc-session-1", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1 }, durationMs: 10, finalText: "Hello" })}\n`,
        );
        stderr.end();
        queueMicrotask(() => child.emit("close", 0, null));
      });
      return child;
    }) as NonNullable<CommandCodeAdapterDependencies["spawnProcess"]>;

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const threadId = ThreadId.makeUnsafe("thread-commandcode-stream");
        yield* adapter.startSession({
          provider: "commandCode",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
          providerOptions: { commandCode: { binaryPath: "/fake/cmd" } },
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId, input: "private prompt", attachments: [] });
        return Array.from(yield* Fiber.join(eventsFiber));
      }).pipe(
        Effect.provide(
          makeCommandCodeAdapterLive({ spawnProcess }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "commandcode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(captured.args).not.toContain("private prompt");
    expect(captured.prompt).toBe("private prompt");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.started",
          payload: { providerThreadId: "cc-session-1" },
        }),
        expect.objectContaining({
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "Hello" },
        }),
        expect.objectContaining({
          type: "item.started",
          payload: expect.objectContaining({ itemType: "command_execution", title: "shell" }),
        }),
        expect.objectContaining({
          type: "turn.completed",
          payload: expect.objectContaining({ state: "completed", stopReason: "end_turn" }),
        }),
      ]),
    );
  });
});
