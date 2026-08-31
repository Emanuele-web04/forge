import { PROVIDER_DISPLAY_NAMES, type ModelSelection, type ProviderKind } from "@synara/contracts";
import { Effect, Layer } from "effect";

import {
  resolveTextGenerationModelSlug,
  type ResolvedTextGenerationModel,
} from "@synara/shared/model";
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
  DroidTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const makeProviderTextGeneration = Effect.gen(function* () {
  const codexTextGeneration = yield* CodexTextGeneration;
  const cursorTextGeneration = yield* CursorTextGeneration;
  const droidTextGeneration = yield* DroidTextGeneration;
  const openCodeTextGeneration = yield* OpenCodeTextGeneration;
  const serverSettings = yield* ServerSettingsService;

  const implementationForProvider = (provider: GitTextGenerationProvider): TextGenerationShape => {
    switch (provider) {
      case "cursor":
        return cursorTextGeneration;
      case "droid":
        return droidTextGeneration;
      case "opencode":
        return openCodeTextGeneration;
      case "codex":
        return codexTextGeneration;
    }
  };

  const buildResolvedModelSelection = (
    resolved: ResolvedTextGenerationModel,
    options?: unknown,
  ): ModelSelection =>
    ({
      provider: resolved.provider,
      model: resolved.model,
      ...(options ? { options } : {}),
    }) as ModelSelection;

  const resolveFromModelSelection = (
    modelSelection: ModelSelection,
  ): { readonly provider: ProviderKind; readonly modelSelection: ModelSelection } => {
    const resolved = resolveTextGenerationModelSlug(modelSelection.model);
    if (resolved && resolved.provider === modelSelection.provider) {
      return {
        provider: resolved.provider,
        modelSelection: buildResolvedModelSelection(resolved, modelSelection.options),
      };
    }
    return {
      provider: modelSelection.provider,
      modelSelection,
    };
  };

  const resolveFromModel = (
    model: string,
  ): { readonly provider: ProviderKind; readonly modelSelection: ModelSelection } | null => {
    const resolved = resolveTextGenerationModelSlug(model);
    if (!resolved) {
      return null;
    }
    const provider = resolved.provider === "claudeAgent" ? "codex" : resolved.provider;
    return {
      provider,
      modelSelection: buildResolvedModelSelection({ ...resolved, provider }),
    };
  };

  const resolveTextGenerationRequest = (
    operation: string,
    input: {
      readonly model?: string;
      readonly modelSelection?: ModelSelection;
    },
  ) =>
    Effect.gen(function* () {
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

      const requested = (() => {
        if (input.modelSelection?.provider) {
          return resolveFromModelSelection(input.modelSelection);
        }
        const model = input.model?.trim();
        if (model) {
          return resolveFromModel(model);
        }
        return {
          provider: settings.textGenerationModelSelection.provider,
          modelSelection: settings.textGenerationModelSelection,
        };
      })();

      if (requested === null) {
        return yield* Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Unknown model selection.",
          }),
        );
      }

      const requestedProviderIsEnabledDedicated =
        hasDedicatedTextGenerationProvider(requested.provider) &&
        settings.providers[requested.provider].enabled;
      const fallbackModelSelection = requestedProviderIsEnabledDedicated
        ? undefined
        : settings.textGenerationModelSelection;
      const provider = fallbackModelSelection?.provider ?? requested.provider;
      if (!hasDedicatedTextGenerationProvider(provider)) {
        return yield* Effect.fail(
          new TextGenerationError({
            operation,
            detail: `${PROVIDER_DISPLAY_NAMES[requested.provider]} does not support Git text generation, and no supported fallback is enabled.`,
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
        resolvedModelSelection: requestedProviderIsEnabledDedicated
          ? requested.modelSelection
          : undefined,
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
    resolveTextGenerationRequest(operation, input).pipe(
      Effect.flatMap(({ implementation, resolvedModelSelection, fallbackModelSelection }) => {
        const mergedInput: Input = resolvedModelSelection
          ? { ...input, modelSelection: resolvedModelSelection }
          : input;
        const finalInput: Input = fallbackModelSelection
          ? {
              ...mergedInput,
              model: fallbackModelSelection.model,
              modelSelection: fallbackModelSelection,
            }
          : mergedInput;
        return run(implementation, finalInput);
      }),
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
