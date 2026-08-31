import { Effect, Layer } from "effect";
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

const makeDroidTextGeneration = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "DroidTextGeneration.generateCommitMessage",
  )(function* (input) {
    const modelSelection = resolveDroidModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid Droid model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runAcpTextGeneration(droidAcpConfig, {
      childProcessSpawner,
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      providerOptions: input.providerOptions,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "DroidTextGeneration.generatePrContent",
  )(function* (input) {
    const modelSelection = resolveDroidModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid Droid model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
      ...(input.prTemplate !== undefined ? { prTemplate: input.prTemplate } : {}),
    });
    const generated = yield* runAcpTextGeneration(droidAcpConfig, {
      childProcessSpawner,
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      providerOptions: input.providerOptions,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateDiffSummary: TextGenerationShape["generateDiffSummary"] = Effect.fn(
    "DroidTextGeneration.generateDiffSummary",
  )(function* (input) {
    const modelSelection = resolveDroidModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateDiffSummary",
        detail: "Invalid Droid model selection.",
      });
    }

    const { prompt, outputSchemaJson, rawTextFallback } = buildDiffSummaryPrompt({
      patch: input.patch,
    });
    const generated = yield* runAcpTextGeneration(droidAcpConfig, {
      childProcessSpawner,
      operation: "generateDiffSummary",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      rawTextFallback,
      modelSelection,
      providerOptions: input.providerOptions,
    });

    return {
      summary: sanitizeDiffSummary(generated.summary),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "DroidTextGeneration.generateBranchName",
  )(function* (input) {
    const modelSelection = resolveDroidModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid Droid model selection.",
      });
    }

    const { prompt, outputSchemaJson, rawTextFallback } = buildBranchNamePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runAcpTextGeneration(droidAcpConfig, {
      childProcessSpawner,
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      rawTextFallback,
      modelSelection,
      providerOptions: input.providerOptions,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "DroidTextGeneration.generateThreadTitle",
  )(function* (input) {
    const modelSelection = resolveDroidModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid Droid model selection.",
      });
    }

    const { prompt, outputSchemaJson, rawTextFallback } = buildThreadTitlePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runAcpTextGeneration(droidAcpConfig, {
      childProcessSpawner,
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      rawTextFallback,
      modelSelection,
      providerOptions: input.providerOptions,
    });

    return {
      title: sanitizeGeneratedThreadTitle(generated.title),
    };
  });

  const generateThreadRecap: TextGenerationShape["generateThreadRecap"] = Effect.fn(
    "DroidTextGeneration.generateThreadRecap",
  )(function* (input) {
    const modelSelection = resolveDroidModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateThreadRecap",
        detail: "Invalid Droid model selection.",
      });
    }

    const { prompt, outputSchemaJson, rawTextFallback } = buildThreadRecapPrompt({
      ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
      newMaterial: input.newMaterial,
      ...(input.currentState ? { currentState: input.currentState } : {}),
    });
    const generated = yield* runAcpTextGeneration(droidAcpConfig, {
      childProcessSpawner,
      operation: "generateThreadRecap",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      rawTextFallback,
      modelSelection,
      providerOptions: input.providerOptions,
    });

    return {
      recap: sanitizeThreadRecap(generated.recap, input.previousRecap),
    };
  });

  const generateAutomationIntent: TextGenerationShape["generateAutomationIntent"] = Effect.fn(
    "DroidTextGeneration.generateAutomationIntent",
  )(function* (input) {
    const modelSelection = resolveDroidModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateAutomationIntent",
        detail: "Invalid Droid model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildAutomationIntentPrompt({
      message: input.message,
      ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
      nowIso: input.nowIso,
    });
    return yield* runAcpTextGeneration(droidAcpConfig, {
      childProcessSpawner,
      operation: "generateAutomationIntent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      providerOptions: input.providerOptions,
    });
  });

  const evaluateAutomationCompletion: TextGenerationShape["evaluateAutomationCompletion"] =
    Effect.fn("DroidTextGeneration.evaluateAutomationCompletion")(function* (input) {
      const modelSelection = resolveDroidModelSelection(input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "evaluateAutomationCompletion",
          detail: "Invalid Droid model selection.",
        });
      }

      const { prompt, outputSchemaJson } = buildAutomationCompletionEvaluationPrompt(input);
      return yield* runAcpTextGeneration(droidAcpConfig, {
        childProcessSpawner,
        operation: "evaluateAutomationCompletion",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        providerOptions: input.providerOptions,
      });
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateDiffSummary,
    generateBranchName,
    generateThreadTitle,
    generateThreadRecap,
    generateAutomationIntent,
    evaluateAutomationCompletion,
  } satisfies TextGenerationShape;
});

export const DroidTextGenerationServiceLive = Layer.effect(
  DroidTextGeneration,
  makeDroidTextGeneration,
);

export const DroidTextGenerationLive = Layer.effect(TextGeneration, makeDroidTextGeneration);
