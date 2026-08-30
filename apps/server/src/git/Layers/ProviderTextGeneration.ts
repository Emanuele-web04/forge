import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import { Effect, Layer } from "effect";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  hasDedicatedTextGenerationProvider,
  type GitTextGenerationProvider,
} from "../textGenerationSelection.ts";
import {
  CodexTextGeneration,
  CursorTextGeneration,
  KiloTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const makeProviderTextGeneration = Effect.gen(function* () {
  const codexTextGeneration = yield* CodexTextGeneration;
  const cursorTextGeneration = yield* CursorTextGeneration;
  const kiloTextGeneration = yield* KiloTextGeneration;
  const openCodeTextGeneration = yield* OpenCodeTextGeneration;
  const serverSettings = yield* ServerSettingsService;

  const resolveRequestedProvider = (input: {
    readonly model?: string;
    readonly modelSelection?: { provider: ProviderKind };
  }): ProviderKind => {
    if (input.modelSelection?.provider) {
      return input.modelSelection.provider;
    }
    return parseOpenCodeModelSlug(input.model) !== null ? "opencode" : "codex";
  };

  const implementationForProvider = (provider: GitTextGenerationProvider): TextGenerationShape => {
    switch (provider) {
      case "cursor":
        return cursorTextGeneration;
      case "kilo":
        return kiloTextGeneration;
      case "opencode":
        return openCodeTextGeneration;
      case "codex":
        return codexTextGeneration;
    }
  };

  const resolveImplementation = (
    operation: string,
    input: {
      readonly model?: string;
      readonly modelSelection?: { provider: ProviderKind };
    },
  ) =>
    Effect.gen(function* () {
      const provider = resolveRequestedProvider(input);
      if (!hasDedicatedTextGenerationProvider(provider)) {
        return yield* Effect.fail(
          new TextGenerationError({
            operation,
            detail: `${PROVIDER_DISPLAY_NAMES[provider]} does not support Git text generation.`,
          }),
        );
      }
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read provider enablement settings.",
              cause,
            }),
        ),
      );
      if (!settings.providers[provider].enabled) {
        return yield* Effect.fail(
          new TextGenerationError({
            operation,
            detail: `${PROVIDER_DISPLAY_NAMES[provider]} is disabled in Settings > Providers.`,
          }),
        );
      }
      return implementationForProvider(provider);
    });

  const runWithProvider = <Output>(
    operation: string,
    input: {
      readonly model?: string;
      readonly modelSelection?: { provider: ProviderKind };
    },
    run: (implementation: TextGenerationShape) => Effect.Effect<Output, TextGenerationError>,
  ) => resolveImplementation(operation, input).pipe(Effect.flatMap(run));

  const call = <
    Input extends { readonly model?: string; readonly modelSelection?: { provider: ProviderKind } },
    Output,
  >(
    operation: string,
    input: Input,
    run: (
      implementation: TextGenerationShape,
      input: Input,
    ) => Effect.Effect<Output, TextGenerationError>,
  ) => runWithProvider(operation, input, (implementation) => run(implementation, input));

  return {
    generateCommitMessage: (input) =>
      call("generateCommitMessage", input, (implementation, value) =>
        implementation.generateCommitMessage(value),
      ),
    generatePrContent: (input) =>
      call("generatePrContent", input, (implementation, value) =>
        implementation.generatePrContent(value),
      ),
    generateDiffSummary: (input) =>
      call("generateDiffSummary", input, (implementation, value) =>
        implementation.generateDiffSummary(value),
      ),
    generateBranchName: (input) =>
      call("generateBranchName", input, (implementation, value) =>
        implementation.generateBranchName(value),
      ),
    generateThreadTitle: (input) =>
      call("generateThreadTitle", input, (implementation, value) =>
        implementation.generateThreadTitle(value),
      ),
    generateThreadRecap: (input) =>
      call("generateThreadRecap", input, (implementation, value) =>
        implementation.generateThreadRecap(value),
      ),
    generateAutomationIntent: (input) =>
      call("generateAutomationIntent", input, (implementation, value) =>
        implementation.generateAutomationIntent(value),
      ),
    evaluateAutomationCompletion: (input) =>
      call("evaluateAutomationCompletion", input, (implementation, value) =>
        implementation.evaluateAutomationCompletion(value),
      ),
  } satisfies TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(TextGeneration, makeProviderTextGeneration);
