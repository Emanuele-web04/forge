import { Effect, Layer, Option, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { DroidModelSelection, ModelSelection, ProviderStartOptions } from "@synara/contracts";
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
  type TextGenerationOperation,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import {
  buildAutomationCompletionEvaluationPrompt,
  buildAutomationIntentPrompt,
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildDiffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadRecapPrompt,
  buildThreadTitlePrompt,
  decodeStructuredTextGenerationOutput,
  sanitizeCommitSubject,
  sanitizeDiffSummary,
  sanitizePrTitle,
  sanitizeThreadRecap,
  type RawTextFallback,
} from "../textGenerationShared.ts";

const resolveDroidModelSelection = (input: {
  modelSelection?: ModelSelection;
}): DroidModelSelection | null => {
  const selection = input.modelSelection;
  return selection?.provider === "droid" ? selection : null;
};

const resolveDroidSettings = (
  options?: ProviderStartOptions,
): DroidAcpRuntimeSettings | undefined => {
  const binaryPath = options?.droid?.binaryPath;
  return binaryPath ? { binaryPath } : undefined;
};

function runDroidAcp<S extends Schema.Top>(
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    rawTextFallback?: RawTextFallback | undefined;
    modelSelection: DroidModelSelection;
    providerOptions?: ProviderStartOptions;
  },
) {
  return Effect.gen(function* () {
    const outputRef = yield* Ref.make("");
    const runtime = yield* makeDroidAcpRuntime({
      childProcessSpawner,
      droidSettings: resolveDroidSettings(input.providerOptions),
      cwd: input.cwd,
      clientInfo: { name: "synara-git-text", version: "0.0.0" },
    });
    yield* runtime.handleSessionUpdate((notification) => {
      const update = notification.update;
      if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
      const content = update.content;
      if (content.type !== "text") return Effect.void;
      return Ref.update(outputRef, (current) => current + content.text);
    });
    const mapOpError = (detail: string, cause?: unknown) =>
      new TextGenerationError(
        cause === undefined
          ? { operation: input.operation, detail }
          : { operation: input.operation, detail, cause },
      );
    yield* runtime.start();
    yield* applyDroidAcpInteractionMode({
      runtime,
      mapError: ({ cause }) =>
        mapOpError("Failed to set Droid ACP interaction mode for text generation.", cause),
    });
    yield* applyDroidAcpModelSelection({
      runtime,
      model: input.modelSelection.model,
      reasoningEffort: input.modelSelection.options?.reasoningEffort,
      mapError: ({ cause }) =>
        mapOpError("Failed to set Droid ACP model for text generation.", cause),
    });
    const promptResult = yield* runtime
      .prompt({ prompt: [{ type: "text", text: input.prompt }] })
      .pipe(
        Effect.timeoutOption(180_000),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(mapOpError("Droid Agent request timed out.")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          cause instanceof TextGenerationError
            ? cause
            : mapOpError("Droid Agent ACP request failed.", cause),
        ),
      );
    const raw = (yield* Ref.get(outputRef)).trim();
    if (!raw) {
      return yield* Effect.fail(
        mapOpError(
          promptResult.stopReason === "cancelled"
            ? "Droid Agent ACP request was cancelled."
            : "Droid Agent returned empty output.",
        ),
      );
    }
    return yield* decodeStructuredTextGenerationOutput({
      schema: input.outputSchemaJson,
      raw,
      operation: input.operation,
      providerLabel: "Droid Agent",
      ...(input.rawTextFallback ? { rawTextFallback: input.rawTextFallback } : {}),
    });
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof TextGenerationError
        ? cause
        : new TextGenerationError({
            operation: input.operation,
            detail: "Droid Agent ACP text generation failed.",
            cause,
          }),
    ),
    Effect.scoped,
  );
}

const droidOps = [
  [
    "generateCommitMessage" as TextGenerationOperation,
    (input: any) =>
      buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      }),
    (g: any) => ({
      subject: sanitizeCommitSubject(g.subject),
      body: g.body.trim(),
      ...("branch" in g && typeof g.branch === "string"
        ? { branch: sanitizeFeatureBranchName(g.branch) }
        : {}),
    }),
  ],
  [
    "generatePrContent" as TextGenerationOperation,
    (input: any) =>
      buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        prTemplate: input.prTemplate,
      }),
    (g: any) => ({ title: sanitizePrTitle(g.title), body: g.body.trim() }),
  ],
  [
    "generateDiffSummary" as TextGenerationOperation,
    (input: any) => buildDiffSummaryPrompt({ patch: input.patch }),
    (g: any) => ({ summary: sanitizeDiffSummary(g.summary) }),
  ],
  [
    "generateBranchName" as TextGenerationOperation,
    (input: any) =>
      buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      }),
    (g: any) => ({ branch: sanitizeBranchFragment(g.branch) }),
  ],
  [
    "generateThreadTitle" as TextGenerationOperation,
    (input: any) =>
      buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      }),
    (g: any) => ({ title: sanitizeGeneratedThreadTitle(g.title) }),
  ],
  [
    "generateThreadRecap" as TextGenerationOperation,
    (input: any) =>
      buildThreadRecapPrompt({
        previousRecap: input.previousRecap,
        newMaterial: input.newMaterial,
        currentState: input.currentState,
      }),
    (g: any, input: any) => ({ recap: sanitizeThreadRecap(g.recap, input.previousRecap) }),
  ],
  [
    "generateAutomationIntent" as TextGenerationOperation,
    (input: any) =>
      buildAutomationIntentPrompt({
        message: input.message,
        defaultMode: input.defaultMode,
        nowIso: input.nowIso,
      }),
    (g: any) => g,
  ],
  [
    "evaluateAutomationCompletion" as TextGenerationOperation,
    (input: any) => buildAutomationCompletionEvaluationPrompt(input),
    (g: any) => g,
  ],
] as const;

const makeDroidTextGeneration = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ops = Object.fromEntries(
    droidOps.map(([operation, build, sanitize]) => [
      operation,
      (input: any) =>
        Effect.gen(function* () {
          const modelSelection = resolveDroidModelSelection(input);
          if (!modelSelection)
            return yield* new TextGenerationError({
              operation,
              detail: "Invalid Droid model selection.",
            });
          const { prompt, outputSchemaJson, rawTextFallback } = build(input) as {
            prompt: string;
            outputSchemaJson: Schema.Top;
            rawTextFallback?: RawTextFallback | undefined;
          };
          const generated = yield* runDroidAcp(childProcessSpawner, {
            operation,
            cwd: input.cwd,
            prompt,
            outputSchemaJson,
            rawTextFallback,
            modelSelection,
            providerOptions: input.providerOptions,
          });
          return sanitize(generated, input);
        }),
    ]),
  );
  return ops as unknown as TextGenerationShape;
});

export const DroidTextGenerationServiceLive = Layer.effect(
  DroidTextGeneration,
  makeDroidTextGeneration,
);
