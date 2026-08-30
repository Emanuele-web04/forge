import { PROVIDER_DISPLAY_NAMES, type ModelSelection, type ProviderKind } from "@synara/contracts";
import { Effect, Layer } from "effect";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import { providerDisabledSettingsMessage } from "../../provider/enabledProviderAdapter.ts";
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
    readonly modelSelection?: ModelSelection;
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
      readonly modelSelection?: ModelSelection;
    },
  ) =>
    Effect.gen(function* () {
      const requestedProvider = resolveRequestedProvider(input);
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
      const fallbackModelSelection = hasDedicatedTextGenerationProvider(requestedProvider)
        ? undefined
        : settings.textGenerationModelSelection;
      const provider = fallbackModelSelection?.provider ?? requestedProvider;
      if (!hasDedicatedTextGenerationProvider(provider)) {
        return yield* Effect.fail(
          new TextGenerationError({
            operation,
            detail: `${PROVIDER_DISPLAY_NAMES[requestedProvider]} does not support Git text generation, and no supported fallback is enabled.`,
          }),
        );
      }
      if (!settings.providers[provider].enabled) {
        return yield* Effect.fail(
          new TextGenerationError({
            operation,
            detail: providerDisabledSettingsMessage(provider),
          }),
        );
      }
      return {
        implementation: implementationForProvider(provider),
        fallbackModelSelection,
      };
    });

  const call = <
    Input extends { readonly model?: string; readonly modelSelection?: ModelSelection },
    Output,
  >(
    operation: string,
    input: Input,
    run: (
      implementation: TextGenerationShape,
      input: Input,
    ) => Effect.Effect<Output, TextGenerationError>,
  ) =>
    resolveImplementation(operation, input).pipe(
      Effect.flatMap(({ implementation, fallbackModelSelection }) =>
        run(
          implementation,
          fallbackModelSelection
            ? ({
                ...input,
                model: fallbackModelSelection.model,
                modelSelection: fallbackModelSelection,
              } as Input)
            : input,
        ),
      ),
    );

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
