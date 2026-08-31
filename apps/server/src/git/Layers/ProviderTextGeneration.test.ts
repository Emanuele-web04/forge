import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerSettingsService } from "../../serverSettings.ts";
import * as TextGen from "../Services/TextGeneration.ts";
import { ProviderTextGenerationLive } from "./ProviderTextGeneration.ts";

function createTextGenerationDouble(label: string) {
  const generateCommitMessage = vi.fn<TextGen.TextGenerationShape["generateCommitMessage"]>(
    (_input) => Effect.succeed({ subject: `${label} commit`, body: "" }),
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
        Effect.succeed({} as TextGen.AutomationIntentGenerationResult),
      evaluateAutomationCompletion: () =>
        Effect.succeed({ stopMatched: false, confidence: 0.2, reason: `${label} completion` }),
    } satisfies TextGen.TextGenerationShape,
    generateCommitMessage,
  };
}

const baseInput = { cwd: "/", branch: null, stagedSummary: "", stagedPatch: "" } as const;
const commitInput = (extra: Partial<TextGen.CommitMessageGenerationInput>) => ({
  ...baseInput,
  ...extra,
});

function makeTestLayer(
  settingsOverrides: Parameters<typeof ServerSettingsService.layerTest>[0] = {},
) {
  const codex = createTextGenerationDouble("codex");
  const cursor = createTextGenerationDouble("cursor");
  const droid = createTextGenerationDouble("droid");
  const openCode = createTextGenerationDouble("openCode");

  const allEnabled = { enabled: true };
  const settings = ServerSettingsService.layerTest({
    providers: { codex: allEnabled, cursor: allEnabled, droid: allEnabled, opencode: allEnabled },
    textGenerationModelSelection: { provider: "codex", model: "gpt-5.5" },
    ...settingsOverrides,
  });

  return {
    layer: ProviderTextGenerationLive.pipe(
      Layer.provide(Layer.succeed(TextGen.CodexTextGeneration, codex.service)),
      Layer.provide(Layer.succeed(TextGen.CursorTextGeneration, cursor.service)),
      Layer.provide(Layer.succeed(TextGen.DroidTextGeneration, droid.service)),
      Layer.provide(Layer.succeed(TextGen.OpenCodeTextGeneration, openCode.service)),
      Layer.provide(settings),
    ),
    droid: droid.generateCommitMessage,
  };
}

describe("ProviderTextGeneration", () => {
  it("routes droid selections to droid", async () => {
    const { layer, droid } = makeTestLayer();
    const program = Effect.gen(function* () {
      const text = yield* TextGen.TextGeneration;
      yield* text.generateCommitMessage(
        commitInput({ modelSelection: { provider: "droid", model: "deepseek-v4-flash-0731" } }),
      );
      return droid.mock.calls.length;
    });
    expect(await Effect.runPromise(Effect.provide(program, layer))).toBe(1);
  });

  it.each([
    "droid:particle/deepseek-v4-flash-0731",
    "droid/particle/deepseek-v4-flash-0731",
  ] as const)("routes droid %s slugs to droid", async (slug) => {
    const { layer, droid } = makeTestLayer();
    const program = Effect.gen(function* () {
      const text = yield* TextGen.TextGeneration;
      yield* text.generateCommitMessage(commitInput({ model: slug }));
      return droid.mock.calls;
    });
    const calls = await Effect.runPromise(Effect.provide(program, layer));
    const forwarded = calls[0]?.[0];
    expect(calls.length).toBe(1);
    expect(forwarded?.model).toBe("particle/deepseek-v4-flash-0731");
    expect(forwarded?.modelSelection).toEqual({
      provider: "droid",
      model: "particle/deepseek-v4-flash-0731",
    });
  });

  it("passes explicit droid model selections through unchanged", async () => {
    const { layer, droid } = makeTestLayer();
    const explicitSelection = { provider: "droid", model: "x" } as const;
    const program = Effect.gen(function* () {
      const text = yield* TextGen.TextGeneration;
      yield* text.generateCommitMessage(commitInput({ modelSelection: explicitSelection }));
      return droid.mock.calls;
    });
    const calls = await Effect.runPromise(Effect.provide(program, layer));
    const forwarded = calls[0]?.[0];
    expect(calls.length).toBe(1);
    expect(forwarded?.modelSelection).toEqual(explicitSelection);
  });

  it("routes codex model-only inputs to codex", async () => {
    const { layer, droid } = makeTestLayer();
    const program = Effect.gen(function* () {
      const text = yield* TextGen.TextGeneration;
      yield* text.generateCommitMessage(commitInput({ model: "gpt-5.5" }));
      return droid.mock.calls.length;
    });
    expect(await Effect.runPromise(Effect.provide(program, layer))).toBe(0);
  });
});
