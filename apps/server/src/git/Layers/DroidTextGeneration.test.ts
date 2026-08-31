import * as os from "node:os";
import * as path from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { DroidTextGenerationLive } from "./DroidTextGeneration.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const DroidTextGenerationTestLayer = DroidTextGenerationLive.pipe(
  Layer.provideMerge(NodeServices.layer),
);

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeDroidAcpAgentWrapper(dir: string, env: Record<string, string>): string {
  const binDir = path.join(dir, "bin");
  const agentPath = path.join(binDir, "agent");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    agentPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(agentPath, 0o755);
  return agentPath;
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effect: (agentPath: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-droid-text-acp-"));
      return {
        tempDir,
        agentPath: makeDroidAcpAgentWrapper(tempDir, env),
      };
    }),
    ({ agentPath }) => effect(agentPath),
    ({ tempDir }) =>
      Effect.sync(() => {
        rmSync(tempDir, { recursive: true, force: true });
      }),
  );
}

function waitForFileContent(filePath: string, containing?: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const content = readFileSync(filePath, "utf8");
        if (containing === undefined || content.includes(containing)) {
          return content;
        }
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file content: ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}

it.layer(DroidTextGenerationTestLayer)("DroidTextGenerationLive", (it) => {
  it.effect("uses ACP model config options instead of raw CLI model ids", () => {
    const requestLogDir = mkdtempSync(path.join(os.tmpdir(), "synara-droid-text-log-"));
    const requestLogPath = path.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        SYNARA_ACP_REQUEST_LOG_PATH: requestLogPath,
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated Droid commit message",
          body: "- verify droid acp model config path",
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/droid-text-generation",
            stagedSummary: "M apps/server/src/git/Layers/DroidTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/git/Layers/DroidTextGeneration.ts b/apps/server/src/git/Layers/DroidTextGeneration.ts",
            modelSelection: {
              provider: "droid",
              model: "composer-2",
              options: {
                reasoningEffort: "high",
              },
            },
            providerOptions: {
              droid: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.subject).toBe("Add generated Droid commit message");
          expect(generated.body).toBe("- verify droid acp model config path");

          const requests = readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );

          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "composer-2",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "reasoning_effort" &&
                request.params?.value === "high",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "mode" &&
                request.params?.value === "normal",
            ),
          ).toBe(true);

          rmSync(requestLogDir, { recursive: true, force: true });
        }),
    );
  });

  it.effect("generates diff summaries through Droid ACP text generation", () =>
    withFakeAcpAgent(
      {
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          summary: "## Summary\n- Route git summaries through Droid.",
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateDiffSummary({
            cwd: process.cwd(),
            patch: "diff --git a/file.ts b/file.ts",
            modelSelection: {
              provider: "droid",
              model: "composer-2",
            },
            providerOptions: {
              droid: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.summary).toBe("## Summary\n- Route git summaries through Droid.");
        }),
    ),
  );

  it.effect("falls back to raw text when Droid replies without JSON for a thread title", () =>
    withFakeAcpAgent(
      {
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: "Sidebar Thread Row Spacing",
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Improve sidebar thread row spacing and hover states.",
            modelSelection: {
              provider: "droid",
              model: "composer-2",
            },
            providerOptions: {
              droid: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.title).toBe("Sidebar Thread Row Spacing");
        }),
    ),
  );

  it.effect("rejects sentence-length prose instead of using it as a title", () =>
    withFakeAcpAgent(
      {
        SYNARA_ACP_PROMPT_RESPONSE_TEXT:
          "I'm sorry, but I cannot generate a concise title for this particular request right now.",
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const result = yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix the websocket reconnect backoff.",
              modelSelection: {
                provider: "droid",
                model: "composer-2",
              },
              providerOptions: {
                droid: {
                  binaryPath: agentPath,
                },
              },
            })
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: "Left" as const, left: error }),
                onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
              }),
            );

          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(TextGenerationError);
            expect(result.left.message).toContain("Droid Agent returned invalid structured output");
          }
        }),
    ),
  );

  it.effect("closes the ACP child process after text generation completes", () => {
    const exitLogDir = mkdtempSync(path.join(os.tmpdir(), "synara-droid-text-exit-log-"));
    const exitLogPath = path.join(exitLogDir, "exit.log");

    return withFakeAcpAgent(
      {
        SYNARA_ACP_EXIT_LOG_PATH: exitLogPath,
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: '"Trim reconnect spinner status after resume."',
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: {
              provider: "droid",
              model: "composer-2",
            },
            providerOptions: {
              droid: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.title).toBe("Trim reconnect spinner status after resume");

          const exitLog = yield* waitForFileContent(exitLogPath, "exit:0");
          expect(exitLog).toContain("exit:0");

          rmSync(exitLogDir, { recursive: true, force: true });
        }),
    );
  });
});
