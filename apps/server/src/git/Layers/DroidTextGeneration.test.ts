import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
const droidModel = { provider: "droid" as const, model: "composer-2" };

function droidOptions(agentPath: string) {
  return { droid: { binaryPath: agentPath } };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeAcpAgentWrapper(dir: string, env: Record<string, string>): string {
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
  env: (tempDir: string) => Record<string, string>,
  effect: (agentPath: string, tempDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-droid-text-acp-"));
      return {
        tempDir,
        agentPath: makeAcpAgentWrapper(tempDir, env(tempDir)),
      };
    }),
    ({ agentPath, tempDir }) => effect(agentPath, tempDir),
    ({ tempDir }) =>
      Effect.sync(() => {
        rmSync(tempDir, { recursive: true, force: true });
      }),
  );
}

function waitForFileContent(filePath: string, containing: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const content = readFileSync(filePath, "utf8");
        if (content.includes(containing)) {
          return content;
        }
      } catch {
        // The child process may not have flushed the file yet.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file content: ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}

function expectConfigOption(
  requests: Array<{ method?: string; params?: Record<string, unknown> }>,
  configId: string,
  value: unknown,
): void {
  expect(
    requests.some(
      (request) =>
        request.method === "session/set_config_option" &&
        request.params?.configId === configId &&
        request.params?.value === value,
    ),
  ).toBe(true);
}

type TestCase = {
  readonly name: string;
  readonly env: (tempDir: string) => Record<string, string>;
  readonly run: (
    agentPath: string,
    tempDir: string,
  ) => Effect.Effect<void, TextGenerationError, TextGeneration>;
};

const cases: TestCase[] = [
  {
    name: "uses ACP model config options instead of raw CLI model ids",
    env: (tempDir) => ({
      SYNARA_ACP_REQUEST_LOG_PATH: path.join(tempDir, "requests.ndjson"),
      SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
        subject: "Add generated Droid commit message",
        body: "- verify droid acp model config path",
      }),
    }),
    run: (agentPath, tempDir) =>
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/droid-text-generation",
          stagedSummary: "M apps/server/src/git/Layers/DroidTextGeneration.ts",
          stagedPatch: "diff --git a/a b/a",
          modelSelection: {
            ...droidModel,
            options: { reasoningEffort: "high" },
          },
          providerOptions: droidOptions(agentPath),
        });

        expect(generated.subject).toBe("Add generated Droid commit message");
        expect(generated.body).toBe("- verify droid acp model config path");

        const requests = readFileSync(path.join(tempDir, "requests.ndjson"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
        expectConfigOption(requests, "model", "composer-2");
        expectConfigOption(requests, "reasoning_effort", "high");
        expectConfigOption(requests, "mode", "normal");
      }),
  },
  {
    name: "generates diff summaries through Droid ACP text generation",
    env: () => ({
      SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
        summary: "## Summary\n- Route git summaries through Droid.",
      }),
    }),
    run: (agentPath) =>
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateDiffSummary({
          cwd: process.cwd(),
          patch: "diff --git a/file.ts b/file.ts",
          modelSelection: droidModel,
          providerOptions: droidOptions(agentPath),
        });

        expect(generated.summary).toBe("## Summary\n- Route git summaries through Droid.");
      }),
  },
  {
    name: "falls back to raw text when Droid replies without JSON for a thread title",
    env: () => ({ SYNARA_ACP_PROMPT_RESPONSE_TEXT: "Sidebar Thread Row Spacing" }),
    run: (agentPath) =>
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Improve sidebar thread row spacing and hover states.",
          modelSelection: droidModel,
          providerOptions: droidOptions(agentPath),
        });

        expect(generated.title).toBe("Sidebar Thread Row Spacing");
      }),
  },
  {
    name: "rejects sentence-length prose instead of using it as a title",
    env: () => ({
      SYNARA_ACP_PROMPT_RESPONSE_TEXT:
        "I'm sorry, but I cannot generate a concise title for this particular request right now.",
    }),
    run: (agentPath) =>
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the websocket reconnect backoff.",
            modelSelection: droidModel,
            providerOptions: droidOptions(agentPath),
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
  },
  {
    name: "closes the ACP child process after text generation completes",
    env: (tempDir) => ({
      SYNARA_ACP_EXIT_LOG_PATH: path.join(tempDir, "exit.log"),
      SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
        title: '"Trim reconnect spinner status after resume."',
      }),
    }),
    run: (agentPath, tempDir) =>
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Fix the reconnect spinner after a resumed session.",
          modelSelection: droidModel,
          providerOptions: droidOptions(agentPath),
        });

        expect(generated.title).toBe("Trim reconnect spinner status after resume");
        const exitLog = yield* waitForFileContent(path.join(tempDir, "exit.log"), "exit:0");
        expect(exitLog).toContain("exit:0");
      }),
  },
];

it.layer(DroidTextGenerationTestLayer)("DroidTextGenerationLive", (it) => {
  it.effect.each(cases)("$name", (test) => withFakeAcpAgent(test.env, test.run));
});
