import { PROVIDER_DISPLAY_NAMES, type ModelSelection, type ProviderKind } from "@synara/contracts";
import { Effect, Layer } from "effect";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import { providerDisabledSettingsMessage } from "../../provider/enabledProviderAdapter.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGenerationError } from "../Errors.ts";
import * as TextGen from "../Services/TextGeneration.ts";
import * as Selection from "../textGenerationSelection.ts";

const parseDroidModelSlug = (model: string | undefined): { readonly model: string } | null => {
  const match = model && /^droid[:/](.+)$/.exec(model);
  return match && match[1] ? { model: match[1] } : null;
};

const makeProviderTextGeneration = Effect.gen(function* () {
  const codexTextGeneration = yield* TextGen.CodexTextGeneration;
  const cursorTextGeneration = yield* TextGen.CursorTextGeneration;
  const droidTextGeneration = yield* TextGen.DroidTextGeneration;
  const openCodeTextGeneration = yield* TextGen.OpenCodeTextGeneration;
  const serverSettings = yield* ServerSettingsService;

  const resolveRequestedProvider = (input: {
    readonly model?: string;
    readonly modelSelection?: ModelSelection;
  }): ProviderKind =>
    input.modelSelection?.provider ??
    (parseDroidModelSlug(input.model) !== null
      ? "droid"
      : parseOpenCodeModelSlug(input.model) !== null
        ? "opencode"
        : "codex");

  const implementations = {
    codex: codexTextGeneration,
    cursor: cursorTextGeneration,
    droid: droidTextGeneration,
    opencode: openCodeTextGeneration,
  } satisfies Record<Selection.GitTextGenerationProvider, TextGen.TextGenerationShape>;

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
      const fallbackModelSelection = Selection.hasDedicatedTextGenerationProvider(requestedProvider)
        ? undefined
        : settings.textGenerationModelSelection;
      const provider = fallbackModelSelection?.provider ?? requestedProvider;
      if (!Selection.hasDedicatedTextGenerationProvider(provider)) {
        return yield* Effect.fail(
          new TextGenerationError({
            operation,
            detail: `${PROVIDER_DISPLAY_NAMES[requestedProvider]} does not support Git text generation, and no supported fallback is enabled.`,
          }),
        );
      }
      if (!settings.providers[provider].enabled) {
        return yield* Effect.fail(
          new TextGenerationError({ operation, detail: providerDisabledSettingsMessage(provider) }),
        );
      }
      return { implementation: implementations[provider], fallbackModelSelection };
    });

  const call = <
    Input extends { readonly model?: string; readonly modelSelection?: ModelSelection },
    Output,
  >(
    operation: string,
    input: Input,
    run: (
      implementation: TextGen.TextGenerationShape,
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

  const operations = [
    "generateCommitMessage",
    "generatePrContent",
    "generateDiffSummary",
    "generateBranchName",
    "generateThreadTitle",
    "generateThreadRecap",
    "generateAutomationIntent",
    "evaluateAutomationCompletion",
  ] as const;

  return Object.fromEntries(
    operations.map((op) => [
      op,
      (input: unknown) => call(op, input as never, (impl, value) => (impl as any)[op](value)),
    ]),
  ) as unknown as TextGen.TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(
  TextGen.TextGeneration,
  makeProviderTextGeneration,
);
