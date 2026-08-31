import { Effect, Layer, Option, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { DEFAULT_MODEL_BY_PROVIDER } from "@synara/contracts";
import type { DroidModelSelection, ModelSelection, ProviderStartOptions } from "@synara/contracts";
import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";
import { resolveTextGenerationModelSlug } from "@synara/shared/model";
import { version } from "../../../package.json" with { type: "json" };

import {
  applyDroidAcpInteractionMode,
  applyDroidAcpModelSelection,
  DroidAcpRuntime,
  DroidAcpRuntimeLayer,
  type DroidAcpRuntimeSettings,
  type DroidAcpRuntimeShape,
} from "../../provider/acp/DroidAcpSupport.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  DroidTextGeneration,
  type AutomationCompletionEvaluationInput,
  type AutomationCompletionEvaluationResult,
  type AutomationIntentGenerationInput,
  type AutomationIntentGenerationResult,
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationInput,
  type CommitMessageGenerationResult,
  type DiffSummaryGenerationInput,
  type DiffSummaryGenerationResult,
  type PrContentGenerationInput,
  type PrContentGenerationResult,
  type TextGenerationOperation,
  type TextGenerationShape,
  type ThreadRecapGenerationInput,
  type ThreadRecapGenerationResult,
  type ThreadTitleGenerationInput,
  type ThreadTitleGenerationResult,
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

const DROID_OUTPUT_MAX_CHARS = 256_000;
const DROID_PROMPT_TIMEOUT_MS = 180_000;
const DROID_GIT_TEXT_CLIENT_NAME = "synara-git-text";
const DROID_GIT_TEXT_CLIENT_VERSION = version;

const CommitMessageOutputSchema = Schema.Struct({
  subject: Schema.String,
  body: Schema.String,
  branch: Schema.optional(Schema.String),
});

const parseDroidPrefixedModel = (value: string | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const prefix = "droid:";
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  const modelPart = trimmed.slice(prefix.length).trim();
  if (!modelPart || modelPart.includes(":")) return null;
  return modelPart;
};

const resolveDroidModelSelection = (input: {
  model?: string;
  modelSelection?: ModelSelection;
}): DroidModelSelection | null => {
  if (input.modelSelection !== undefined) {
    if (input.modelSelection.provider !== "droid") {
      return null;
    }

    const droidOptions = input.modelSelection.options;
    const rawModel = input.modelSelection.model;
    if (!rawModel) {
      return {
        provider: "droid",
        model: DEFAULT_MODEL_BY_PROVIDER.droid,
        options: droidOptions,
      };
    }

    const resolved = resolveTextGenerationModelSlug(rawModel);
    if (resolved?.provider === "droid") {
      return { provider: "droid", model: resolved.model, options: droidOptions };
    }

    const fallback = parseDroidPrefixedModel(rawModel);
    if (fallback) {
      return { provider: "droid", model: fallback, options: droidOptions };
    }

    return null;
  }

  if (input.model) {
    const resolved = resolveTextGenerationModelSlug(input.model);
    if (resolved?.provider === "droid") {
      return { provider: "droid", model: resolved.model };
    }

    const fallback = parseDroidPrefixedModel(input.model);
    if (fallback) {
      return { provider: "droid", model: fallback };
    }

    return null;
  }

  return { provider: "droid", model: DEFAULT_MODEL_BY_PROVIDER.droid };
};

const resolveDroidSettings = (
  options?: ProviderStartOptions,
): DroidAcpRuntimeSettings | undefined => {
  const binaryPath = options?.droid?.binaryPath;
  return binaryPath ? { binaryPath } : undefined;
};

const makeMapOpError =
  (operation: TextGenerationOperation) =>
  (detail: string, cause?: unknown): TextGenerationError => {
    const error = new TextGenerationError({
      operation,
      detail,
    });
    if (cause !== undefined) {
      error.cause = cause;
    }
    return error;
  };

function runDroidAcp<S extends Schema.Top>(
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  droidAcpRuntime: DroidAcpRuntimeShape,
  input: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    rawTextFallback?: RawTextFallback | undefined;
    modelSelection: DroidModelSelection;
    providerOptions?: ProviderStartOptions | undefined;
  },
) {
  const mapOpError = makeMapOpError(input.operation);
  return Effect.gen(function* () {
    const outputRef = yield* Ref.make("");
    const sizeExceededRef = yield* Ref.make(false);
    const runtime = yield* droidAcpRuntime.make({
      childProcessSpawner,
      droidSettings: resolveDroidSettings(input.providerOptions),
      cwd: input.cwd,
      clientInfo: {
        name: DROID_GIT_TEXT_CLIENT_NAME,
        version: DROID_GIT_TEXT_CLIENT_VERSION,
      },
    });

    yield* runtime.handleSessionUpdate((notification) =>
      Effect.gen(function* () {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") return;
        const content = update.content;
        if (content.type !== "text") return;

        const current = yield* Ref.get(outputRef);
        const nextLength = current.length + content.text.length;
        if (nextLength > DROID_OUTPUT_MAX_CHARS) {
          yield* Ref.set(sizeExceededRef, true);
          yield* runtime.cancel;
          return;
        }

        yield* Ref.set(outputRef, current + content.text);
      }),
    );

    const runDroidAcpSession = Effect.gen(function* () {
      yield* runtime.start();
      yield* applyDroidAcpModelSelection({
        runtime,
        model: input.modelSelection.model,
        reasoningEffort: input.modelSelection.options?.reasoningEffort,
        mapError: ({ cause }) =>
          mapOpError("Failed to set Droid ACP model for text generation.", cause),
      });
      yield* applyDroidAcpInteractionMode({
        runtime,
        interactionMode: "plan",
        mapError: ({ cause }) =>
          mapOpError("Failed to set Droid ACP interaction mode for text generation.", cause),
      });
      return yield* runtime.prompt({ prompt: [{ type: "text", text: input.prompt }] });
    });

    const promptOption = yield* runDroidAcpSession.pipe(
      Effect.timeoutOption(DROID_PROMPT_TIMEOUT_MS),
      Effect.mapError((cause) =>
        cause instanceof TextGenerationError
          ? cause
          : mapOpError("Droid Agent ACP request failed.", cause),
      ),
    );

    const sizeExceeded = yield* Ref.get(sizeExceededRef);
    if (sizeExceeded) {
      return yield* Effect.fail(mapOpError("Droid Agent output exceeded maximum size."));
    }

    const promptResult = yield* Option.match(promptOption, {
      onNone: () => Effect.fail(mapOpError("Droid Agent request timed out.")),
      onSome: Effect.succeed,
    });

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
      rawTextFallback: input.rawTextFallback,
    });
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof TextGenerationError
        ? cause
        : mapOpError("Droid Agent ACP text generation failed.", cause),
    ),
    Effect.scoped,
  );
}

const makeDroidTextGeneration = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const droidAcpRuntime = yield* DroidAcpRuntime;

  const makeDroidOperation =
    <
      I extends {
        readonly cwd: string;
        readonly model?: string;
        readonly modelSelection?: ModelSelection;
        readonly providerOptions?: ProviderStartOptions;
      },
      S extends Schema.Top,
      O,
    >(
      operation: TextGenerationOperation,
      build: (input: I) => {
        readonly prompt: string;
        readonly outputSchemaJson: S;
        readonly rawTextFallback?: RawTextFallback;
      },
      sanitize: (g: S["Type"], input: I) => O,
    ): ((input: I) => Effect.Effect<O, TextGenerationError, S["DecodingServices"]>) =>
    (input) =>
      Effect.gen(function* () {
        const modelSelection = resolveDroidModelSelection(input);
        if (!modelSelection) {
          return yield* new TextGenerationError({
            operation,
            detail: "Invalid Droid model selection.",
          });
        }
        const buildOutput = build(input);
        const generated = yield* runDroidAcp(childProcessSpawner, droidAcpRuntime, {
          operation,
          cwd: input.cwd,
          prompt: buildOutput.prompt,
          outputSchemaJson: buildOutput.outputSchemaJson,
          rawTextFallback: buildOutput.rawTextFallback,
          modelSelection,
          providerOptions: input.providerOptions,
        });
        return sanitize(generated, input);
      });

  const ops = {
    generateCommitMessage: makeDroidOperation(
      "generateCommitMessage",
      (input: CommitMessageGenerationInput) =>
        buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
        }),
      (generated, input): CommitMessageGenerationResult => {
        const g = Schema.decodeUnknownSync(CommitMessageOutputSchema)(generated);
        const result: CommitMessageGenerationResult = {
          subject: sanitizeCommitSubject(g.subject),
          body: g.body.trim(),
        };
        if (input.includeBranch && g.branch !== undefined) {
          result.branch = sanitizeFeatureBranchName(g.branch);
        }
        return result;
      },
    ),
    generatePrContent: makeDroidOperation(
      "generatePrContent",
      (input: PrContentGenerationInput) => buildPrContentPrompt(input),
      (g): PrContentGenerationResult => ({
        title: sanitizePrTitle(g.title),
        body: g.body.trim(),
      }),
    ),
    generateDiffSummary: makeDroidOperation(
      "generateDiffSummary",
      (input: DiffSummaryGenerationInput) => buildDiffSummaryPrompt({ patch: input.patch }),
      (g): DiffSummaryGenerationResult => ({ summary: sanitizeDiffSummary(g.summary) }),
    ),
    generateBranchName: makeDroidOperation(
      "generateBranchName",
      (input: BranchNameGenerationInput) =>
        buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        }),
      (g): BranchNameGenerationResult => ({ branch: sanitizeBranchFragment(g.branch) }),
    ),
    generateThreadTitle: makeDroidOperation(
      "generateThreadTitle",
      (input: ThreadTitleGenerationInput) =>
        buildThreadTitlePrompt({
          message: input.message,
          attachments: input.attachments,
        }),
      (g): ThreadTitleGenerationResult => ({ title: sanitizeGeneratedThreadTitle(g.title) }),
    ),
    generateThreadRecap: makeDroidOperation(
      "generateThreadRecap",
      (input: ThreadRecapGenerationInput) =>
        buildThreadRecapPrompt({
          previousRecap: input.previousRecap,
          newMaterial: input.newMaterial,
          currentState: input.currentState,
        }),
      (g, input): ThreadRecapGenerationResult => ({
        recap: sanitizeThreadRecap(g.recap, input.previousRecap),
      }),
    ),
    generateAutomationIntent: makeDroidOperation(
      "generateAutomationIntent",
      (input: AutomationIntentGenerationInput) =>
        buildAutomationIntentPrompt({
          message: input.message,
          defaultMode: input.defaultMode,
          nowIso: input.nowIso,
        }),
      (g): AutomationIntentGenerationResult => g,
    ),
    evaluateAutomationCompletion: makeDroidOperation(
      "evaluateAutomationCompletion",
      (input: AutomationCompletionEvaluationInput) =>
        buildAutomationCompletionEvaluationPrompt(input),
      (g): AutomationCompletionEvaluationResult => g,
    ),
  };

  return ops satisfies TextGenerationShape;
});

export const DroidTextGenerationServiceLive = Layer.effect(
  DroidTextGeneration,
  makeDroidTextGeneration,
).pipe(Layer.provide(DroidAcpRuntimeLayer));
