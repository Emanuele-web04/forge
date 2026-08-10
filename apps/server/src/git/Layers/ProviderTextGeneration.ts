import { Effect, Layer } from "effect";
import type { ModelSelection } from "@synara/contracts";
import { providerTargetFromModelSelection } from "@synara/shared/providerTarget";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import { resolveDefaultProviderProfile } from "../../provider/providerProfileResolver.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  CodexTextGeneration,
  CursorTextGeneration,
  KiloTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  type TextGenerationOperation,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const makeProviderTextGeneration = Effect.gen(function* () {
  const codexTextGeneration = yield* CodexTextGeneration;
  const cursorTextGeneration = yield* CursorTextGeneration;
  const kiloTextGeneration = yield* KiloTextGeneration;
  const openCodeTextGeneration = yield* OpenCodeTextGeneration;

  const resolveImplementation = (input: {
    readonly model?: string;
    readonly modelSelection?: { provider: string };
  }): TextGenerationShape => {
    if (input.modelSelection?.provider === "cursor") {
      return cursorTextGeneration;
    }
    if (input.modelSelection?.provider === "kilo") {
      return kiloTextGeneration;
    }
    if (input.modelSelection?.provider === "opencode") {
      return openCodeTextGeneration;
    }
    return parseOpenCodeModelSlug(input.model) !== null
      ? openCodeTextGeneration
      : codexTextGeneration;
  };

  const withImplementation = <A>(
    operation: TextGenerationOperation,
    input: { readonly modelSelection?: ModelSelection },
    run: (implementation: TextGenerationShape) => Effect.Effect<A, TextGenerationError>,
  ): Effect.Effect<A, TextGenerationError> => {
    const validateProfile = input.modelSelection
      ? resolveDefaultProviderProfile({
          operation: `TextGeneration.${operation}`,
          target: providerTargetFromModelSelection(input.modelSelection),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: cause.issue,
                cause,
              }),
          ),
          Effect.asVoid,
        )
      : Effect.void;

    return validateProfile.pipe(
      Effect.flatMap(() => run(resolveImplementation(input))),
    );
  };

  return {
    generateCommitMessage: (input) =>
      withImplementation("generateCommitMessage", input, (implementation) =>
        implementation.generateCommitMessage(input),
      ),
    generatePrContent: (input) =>
      withImplementation("generatePrContent", input, (implementation) =>
        implementation.generatePrContent(input),
      ),
    generateDiffSummary: (input) =>
      withImplementation("generateDiffSummary", input, (implementation) =>
        implementation.generateDiffSummary(input),
      ),
    generateBranchName: (input) =>
      withImplementation("generateBranchName", input, (implementation) =>
        implementation.generateBranchName(input),
      ),
    generateThreadTitle: (input) =>
      withImplementation("generateThreadTitle", input, (implementation) =>
        implementation.generateThreadTitle(input),
      ),
    generateThreadRecap: (input) =>
      withImplementation("generateThreadRecap", input, (implementation) =>
        implementation.generateThreadRecap(input),
      ),
    generateAutomationIntent: (input) =>
      withImplementation("generateAutomationIntent", input, (implementation) =>
        implementation.generateAutomationIntent(input),
      ),
    evaluateAutomationCompletion: (input) =>
      withImplementation("evaluateAutomationCompletion", input, (implementation) =>
        implementation.evaluateAutomationCompletion(input),
      ),
  } satisfies TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(TextGeneration, makeProviderTextGeneration);
