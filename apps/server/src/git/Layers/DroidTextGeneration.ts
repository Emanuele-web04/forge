import { Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { DroidModelSelection, ProviderStartOptions } from "@synara/contracts";
import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";

import {
  applyDroidAcpInteractionMode,
  applyDroidAcpModelSelection,
  makeDroidAcpRuntime,
  type DroidAcpRuntimeSettings,
} from "../../provider/acp/DroidAcpSupport.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  DroidTextGeneration,
  TextGeneration,
  type TextGenerationShape,
  type TextGenerationOperation,
} from "../Services/TextGeneration.ts";
import {
  buildAutomationIntentPrompt,
  buildAutomationCompletionEvaluationPrompt,
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildDiffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadRecapPrompt,
  buildThreadTitlePrompt,
  sanitizeCommitSubject,
  sanitizeDiffSummary,
  sanitizeThreadRecap,
  sanitizePrTitle,
  type RawTextFallback,
} from "../textGenerationShared.ts";
import {
  isTextGenerationError,
  mapError,
  runAcpTextGeneration,
  type AcpTextGenerationConfig,
} from "./AcpTextGeneration.ts";

const DROID_TEXT_GENERATION_LABEL = "Droid Agent";
const DROID_TIMEOUT_MS = 180_000;

function resolveDroidModelSelection(input: {
  readonly model?: string;
  readonly modelSelection?: {
    readonly provider: string;
    readonly model: string;
    readonly options?: unknown;
  };
}): DroidModelSelection | null {
  if (input.modelSelection?.provider === "droid") {
    return input.modelSelection as DroidModelSelection;
  }
  return null;
}

function resolveDroidSettings(
  providerOptions: ProviderStartOptions | undefined,
): DroidAcpRuntimeSettings | undefined {
  const binaryPath = providerOptions?.droid?.binaryPath;
  if (!binaryPath) return undefined;
  return { binaryPath };
}

const droidAcpConfig: AcpTextGenerationConfig<DroidModelSelection, DroidAcpRuntimeSettings> = {
  providerLabel: DROID_TEXT_GENERATION_LABEL,
  timeoutMs: DROID_TIMEOUT_MS,
  resolveModelSelection: resolveDroidModelSelection,
  resolveSettings: resolveDroidSettings,
  makeRuntime: ({ childProcessSpawner, settings, cwd }) =>
    makeDroidAcpRuntime({
      childProcessSpawner,
      droidSettings: settings,
      cwd,
      clientInfo: { name: "synara-git-text", version: "0.0.0" },
    }),
  prepareRuntime: ({
    runtime,
    modelSelection,
    operation: _operation,
    mapError: mapErrorForOperation,
  }) =>
    Effect.gen(function* () {
      yield* runtime.start();
      yield* applyDroidAcpInteractionMode({
        runtime,
        interactionMode: "default",
        runtimeMode: "approval-required",
        mapError: ({ cause }) =>
          mapErrorForOperation(
            "Failed to set Droid ACP interaction mode for text generation.",
            cause,
          ),
      });
      yield* applyDroidAcpModelSelection({
        runtime,
        model: modelSelection.model,
        reasoningEffort: modelSelection.options?.reasoningEffort,
        mapError: ({ cause }) =>
          mapErrorForOperation("Failed to set Droid ACP model for text generation.", cause),
      });
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapErrorForOperation("Droid ACP request failed.", cause),
      ),
    ),
  mapError,
};

type OperationInput = {
  readonly cwd: string;
  readonly model?: string;
  readonly modelSelection?: {
    readonly provider: string;
    readonly model: string;
    readonly options?: unknown;
  };
  readonly providerOptions?: ProviderStartOptions;
};
type OperationInputOf<K extends TextGenerationOperation> = Parameters<TextGenerationShape[K]>[0];

const makeDroidTextGeneration = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  function runDroidAcpOperation<Input extends OperationInput, S extends Schema.Top, Output>(
    operation: TextGenerationOperation,
    input: Input,
    build: (input: Input) => {
      readonly prompt: string;
      readonly outputSchemaJson: S;
      readonly rawTextFallback?: RawTextFallback;
    },
    transform: (generated: S["Type"], input: Input) => Output,
  ): Effect.Effect<Output, TextGenerationError, S["DecodingServices"]> {
    return Effect.gen(function* () {
      const modelSelection = resolveDroidModelSelection(input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation,
          detail: "Invalid Droid model selection.",
        });
      }
      const { prompt, outputSchemaJson, rawTextFallback } = build(input);
      const generated = yield* runAcpTextGeneration(droidAcpConfig, {
        childProcessSpawner,
        operation,
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        providerOptions: input.providerOptions,
      });
      return transform(generated, input);
    });
  }

  return {
    generateCommitMessage: Effect.fn("DroidTextGeneration.generateCommitMessage")(function* (
      input: OperationInputOf<"generateCommitMessage">,
    ) {
      return yield* runDroidAcpOperation(
        "generateCommitMessage",
        input,
        (input) =>
          buildCommitMessagePrompt({
            branch: input.branch,
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
            includeBranch: input.includeBranch === true,
          }),
        (generated, _input) => ({
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        }),
      );
    }),
    generatePrContent: Effect.fn("DroidTextGeneration.generatePrContent")(function* (
      input: OperationInputOf<"generatePrContent">,
    ) {
      return yield* runDroidAcpOperation(
        "generatePrContent",
        input,
        (input) =>
          buildPrContentPrompt({
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            commitSummary: input.commitSummary,
            diffSummary: input.diffSummary,
            diffPatch: input.diffPatch,
            ...(input.prTemplate !== undefined ? { prTemplate: input.prTemplate } : {}),
          }),
        (generated) => ({
          title: sanitizePrTitle(generated.title),
          body: generated.body.trim(),
        }),
      );
    }),
    generateDiffSummary: Effect.fn("DroidTextGeneration.generateDiffSummary")(function* (
      input: OperationInputOf<"generateDiffSummary">,
    ) {
      return yield* runDroidAcpOperation(
        "generateDiffSummary",
        input,
        (input) => buildDiffSummaryPrompt({ patch: input.patch }),
        (generated) => ({ summary: sanitizeDiffSummary(generated.summary) }),
      );
    }),
    generateBranchName: Effect.fn("DroidTextGeneration.generateBranchName")(function* (
      input: OperationInputOf<"generateBranchName">,
    ) {
      return yield* runDroidAcpOperation(
        "generateBranchName",
        input,
        (input) =>
          buildBranchNamePrompt({
            message: input.message,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          }),
        (generated) => ({ branch: sanitizeBranchFragment(generated.branch) }),
      );
    }),
    generateThreadTitle: Effect.fn("DroidTextGeneration.generateThreadTitle")(function* (
      input: OperationInputOf<"generateThreadTitle">,
    ) {
      return yield* runDroidAcpOperation(
        "generateThreadTitle",
        input,
        (input) =>
          buildThreadTitlePrompt({
            message: input.message,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          }),
        (generated) => ({ title: sanitizeGeneratedThreadTitle(generated.title) }),
      );
    }),
    generateThreadRecap: Effect.fn("DroidTextGeneration.generateThreadRecap")(function* (
      input: OperationInputOf<"generateThreadRecap">,
    ) {
      return yield* runDroidAcpOperation(
        "generateThreadRecap",
        input,
        (input) =>
          buildThreadRecapPrompt({
            ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
            newMaterial: input.newMaterial,
            ...(input.currentState ? { currentState: input.currentState } : {}),
          }),
        (generated, input) => ({
          recap: sanitizeThreadRecap(generated.recap, input.previousRecap),
        }),
      );
    }),
    generateAutomationIntent: Effect.fn("DroidTextGeneration.generateAutomationIntent")(function* (
      input: OperationInputOf<"generateAutomationIntent">,
    ) {
      return yield* runDroidAcpOperation(
        "generateAutomationIntent",
        input,
        (input) =>
          buildAutomationIntentPrompt({
            message: input.message,
            ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
            nowIso: input.nowIso,
          }),
        (generated) => generated,
      );
    }),
    evaluateAutomationCompletion: Effect.fn("DroidTextGeneration.evaluateAutomationCompletion")(
      function* (input: OperationInputOf<"evaluateAutomationCompletion">) {
        return yield* runDroidAcpOperation(
          "evaluateAutomationCompletion",
          input,
          (input) => buildAutomationCompletionEvaluationPrompt(input),
          (generated) => generated,
        );
      },
    ),
  };
});

export const DroidTextGenerationServiceLive = Layer.effect(
  DroidTextGeneration,
  makeDroidTextGeneration,
);
export const DroidTextGenerationLive = Layer.effect(TextGeneration, makeDroidTextGeneration);
