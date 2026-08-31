import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  CodexTextGeneration,
  CursorTextGeneration,
  DroidTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import { ProviderTextGenerationLive } from "./ProviderTextGeneration.ts";

function createTextGenerationDouble(label: string) {
  const generateCommitMessage = vi.fn<TextGenerationShape["generateCommitMessage"]>(() =>
    Effect.succeed({ subject: `${label} commit`, body: "" }),
  );

  return {
    service: {
      generateCommitMessage,
      generatePrContent: () => Effect.succeed({ title: `${label} pr`, body: "" }),
      generateDiffSummary: () => Effect.succeed({ summary: `${label} summary` }),
      generateBranchName: () => Effect.succeed({ branch: `${label}-branch` }),
      generateThreadTitle: () => Effect.succeed({ title: `${label} title` }),
      generateThreadRecap: () => Effect.succeed({ recap: `${label} recap` }),
      generateAutomationIntent: () =>
        Effect.succeed({
          isAutomation: true,
          confidence: 1,
          language: null,
          name: `${label} automation`,
          taskPrompt: "",
          schedule: { type: "interval", everySeconds: 3600 },
          mode: "heartbeat",
          completionPolicy: { type: "none" },
          missingFields: [],
          needsConfirmation: false,
          reason: null,
        }),
      evaluateAutomationCompletion: () =>
        Effect.succeed({ stopMatched: false, confidence: 0.2, reason: `${label} completion` }),
    } satisfies TextGenerationShape,
    generateCommitMessage,
  };
}

function makeTestLayer(
  settingsOverrides: Parameters<typeof ServerSettingsService.layerTest>[0] = {},
) {
  const codex = createTextGenerationDouble("codex");
  const cursor = createTextGenerationDouble("cursor");
  const droid = createTextGenerationDouble("droid");
  const openCode = createTextGenerationDouble("openCode");

  const settings = ServerSettingsService.layerTest({
    providers: {
      codex: { enabled: true },
      cursor: { enabled: true },
      droid: { enabled: true },
      opencode: { enabled: true },
    },
    textGenerationModelSelection: { provider: "codex", model: "gpt-5.5" },
    ...settingsOverrides,
  });

  return {
    layer: ProviderTextGenerationLive.pipe(
      Layer.provide(Layer.succeed(CodexTextGeneration, codex.service)),
      Layer.provide(Layer.succeed(CursorTextGeneration, cursor.service)),
      Layer.provide(Layer.succeed(DroidTextGeneration, droid.service)),
      Layer.provide(Layer.succeed(OpenCodeTextGeneration, openCode.service)),
      Layer.provide(settings),
    ),
    outputs: { codex, cursor, droid, openCode },
  };
}

const run = (effect: Effect.Effect<unknown, unknown, never>) => Effect.runPromise(effect);

describe("ProviderTextGeneration", () => {
  it("routes droid selections to droid", async () => {
    const { layer, outputs } = makeTestLayer();
    const program = Effect.gen(function* () {
      const text = yield* TextGeneration;
      yield* text.generateCommitMessage({
        cwd: "/",
        branch: null,
        stagedSummary: "",
        stagedPatch: "",
        modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" },
      });
      return outputs.droid.generateCommitMessage.mock.calls.length;
    });
    expect(await run(Effect.provide(program, layer))).toBe(1);
  });

  it("routes droid:<model> slugs to droid", async () => {
    const { layer, outputs } = makeTestLayer();
    const program = Effect.gen(function* () {
      const text = yield* TextGeneration;
      yield* text.generateCommitMessage({
        cwd: "/",
        branch: null,
        stagedSummary: "",
        stagedPatch: "",
        model: "droid:deepseek-v4-flash-0731",
      });
      return outputs.droid.generateCommitMessage.mock.calls.length;
    });
    expect(await run(Effect.provide(program, layer))).toBe(1);
  });
});
