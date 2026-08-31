import { Effect, Layer, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import { TextGenerationError } from "../Errors.ts";
import { DroidTextGeneration } from "../Services/TextGeneration.ts";
import { DroidTextGenerationServiceLive } from "./DroidTextGeneration.ts";

type CapturedCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

function failingSpawnerLayer(state: { commands: Array<CapturedCommand> } = { commands: [] }) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      // SAFETY: the test spawner only receives the StandardCommand shape; the unstable
      // ChildProcessSpawner API exposes this as `unknown`, so we assert the concrete shape.
      const cmd = command as CapturedCommand;
      state.commands.push({ command: cmd.command, args: [...cmd.args] });
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
    const captured = { commands: [] satisfies Array<CapturedCommand> };

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
              droid: { binaryPath: "/custom/bin/droid" },
            },
          })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(DroidTextGenerationServiceLive),
        Effect.provide(failingSpawnerLayer(captured)),
      ),
    );

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("Droid Agent ACP text generation failed.");
    expect(captured.commands).toEqual([
      { command: "/custom/bin/droid", args: ["exec", "--output-format", "acp"] },
    ]);
  });
});
