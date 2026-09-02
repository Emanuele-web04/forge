import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CursorModelSelection, ProviderStartOptions } from "@synara/contracts";
import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";

import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
  type CursorAcpRuntimeCursorSettings,
} from "../../provider/acp/CursorAcpSupport.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  CursorTextGeneration,
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

const CURSOR_TEXT_GENERATION_LABEL = "Cursor Agent";

const CURSOR_TIMEOUT_MS = 180_000;

function resolveCursorModelSelection(input: {
  readonly model?: string;
  readonly modelSelection?: {
    readonly provider: string;
    readonly model: string;
    readonly options?: unknown;
  };
}): CursorModelSelection | null {
  if (input.modelSelection?.provider === "cursor") {
    return input.modelSelection as CursorModelSelection;
  }

  return null;
}

function resolveCursorSettings(
  providerOptions: ProviderStartOptions | undefined,
): CursorAcpRuntimeCursorSettings | undefined {
  const cursorOptions = providerOptions?.cursor;
  if (!cursorOptions) return undefined;
  return {
    ...(cursorOptions.binaryPath ? { binaryPath: cursorOptions.binaryPath } : {}),
    ...(cursorOptions.apiEndpoint ? { apiEndpoint: cursorOptions.apiEndpoint } : {}),
  };
}

const cursorAcpConfig: AcpTextGenerationConfig<
  CursorModelSelection,
  CursorAcpRuntimeCursorSettings
> = {
  providerLabel: CURSOR_TEXT_GENERATION_LABEL,
  timeoutMs: CURSOR_TIMEOUT_MS,
  resolveModelSelection: resolveCursorModelSelection,
  resolveSettings: resolveCursorSettings,
  makeRuntime: ({ childProcessSpawner, settings, cwd }) =>
    makeCursorAcpRuntime({
      cursorSettings: settings,
      childProcessSpawner,
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
      yield* Effect.ignore(runtime.setMode("ask"));
      yield* applyCursorAcpModelSelection({
        runtime,
        model: modelSelection.model,
        options: modelSelection.options,
        mapError: ({ cause, step, configId }) =>
          mapErrorForOperation(
            step === "set-config-option"
              ? `Failed to set Cursor ACP config option "${configId}" for text generation.`
              : "Failed to set Cursor ACP base model for text generation.",
            cause,
          ),
      });
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapErrorForOperation("Cursor ACP request failed.", cause),
      ),
    ),
  mapError,
};

const makeCursorTextGeneration = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CursorTextGeneration.generateCommitMessage",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runAcpTextGeneration(cursorAcpConfig, {
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
    "CursorTextGeneration.generatePrContent",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid Cursor model selection.",
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
    const generated = yield* runAcpTextGeneration(cursorAcpConfig, {
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
    "CursorTextGeneration.generateDiffSummary",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateDiffSummary",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson, rawTextFallback } = buildDiffSummaryPrompt({
      patch: input.patch,
    });
    const generated = yield* runAcpTextGeneration(cursorAcpConfig, {
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
    "CursorTextGeneration.generateBranchName",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson, rawTextFallback } = buildBranchNamePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runAcpTextGeneration(cursorAcpConfig, {
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
    "CursorTextGeneration.generateThreadTitle",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson, rawTextFallback } = buildThreadTitlePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runAcpTextGeneration(cursorAcpConfig, {
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
    "CursorTextGeneration.generateThreadRecap",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateThreadRecap",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson, rawTextFallback } = buildThreadRecapPrompt({
      ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
      newMaterial: input.newMaterial,
      ...(input.currentState ? { currentState: input.currentState } : {}),
    });
    const generated = yield* runAcpTextGeneration(cursorAcpConfig, {
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
    "CursorTextGeneration.generateAutomationIntent",
  )(function* (input) {
    const modelSelection = resolveCursorModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateAutomationIntent",
        detail: "Invalid Cursor model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildAutomationIntentPrompt({
      message: input.message,
      ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
      nowIso: input.nowIso,
    });
    return yield* runAcpTextGeneration(cursorAcpConfig, {
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
    Effect.fn("CursorTextGeneration.evaluateAutomationCompletion")(function* (input) {
      const modelSelection = resolveCursorModelSelection(input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "evaluateAutomationCompletion",
          detail: "Invalid Cursor model selection.",
        });
      }

      const { prompt, outputSchemaJson } = buildAutomationCompletionEvaluationPrompt(input);
      return yield* runAcpTextGeneration(cursorAcpConfig, {
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

export const CursorTextGenerationServiceLive = Layer.effect(
  CursorTextGeneration,
  makeCursorTextGeneration,
);

export const CursorTextGenerationLive = Layer.effect(TextGeneration, makeCursorTextGeneration);
