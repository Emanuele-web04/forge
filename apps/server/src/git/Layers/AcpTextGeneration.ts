import { Buffer } from "node:buffer";

import { Effect, Option, Ref, Schema, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ProviderStartOptions } from "@synara/contracts";

import * as AcpErrors from "../../provider/acp/AcpErrors.ts";
import type { AcpSessionRuntimeShape } from "../../provider/acp/AcpSessionRuntime.ts";
import { TextGenerationError } from "../Errors.ts";
import type { TextGenerationOperation } from "../Services/TextGeneration.ts";
import {
  decodeStructuredTextGenerationOutput,
  type RawTextFallback,
} from "../textGenerationShared.ts";

export const ACP_TEXT_GENERATION_MAX_OUTPUT_BYTES = 1_000_000;

export interface AcpTextGenerationOutput {
  readonly text: string;
  readonly byteLength: number;
  readonly exceededLimit: boolean;
}

export function appendAcpTextGenerationOutput(
  current: AcpTextGenerationOutput,
  chunk: string,
  maxBytes = ACP_TEXT_GENERATION_MAX_OUTPUT_BYTES,
): AcpTextGenerationOutput {
  if (current.exceededLimit) {
    return current;
  }

  const byteLength = current.byteLength + Buffer.byteLength(chunk, "utf8");
  if (byteLength > maxBytes) {
    return { ...current, exceededLimit: true };
  }

  return {
    text: current.text + chunk,
    byteLength,
    exceededLimit: false,
  };
}

export function mapError(
  operation: TextGenerationOperation,
  detail: string,
  cause?: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag?: unknown })._tag === "TextGenerationError"
  );
}

export interface AcpTextGenerationConfig<
  ModelSelection extends {
    readonly provider: string;
    readonly model: string;
    readonly options?: unknown;
  },
  RuntimeSettings,
> {
  readonly providerLabel: string;
  readonly timeoutMs: number;
  readonly resolveModelSelection: (input: {
    readonly model?: string;
    readonly modelSelection?: {
      readonly provider: string;
      readonly model: string;
      readonly options?: unknown;
    };
  }) => ModelSelection | null;
  readonly resolveSettings: (providerOptions?: ProviderStartOptions) => RuntimeSettings | undefined;
  readonly makeRuntime: (input: {
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly settings: RuntimeSettings | undefined;
    readonly cwd: string;
  }) => Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope>;
  readonly prepareRuntime: (input: {
    readonly runtime: AcpSessionRuntimeShape;
    readonly modelSelection: ModelSelection;
    readonly operation: TextGenerationOperation;
    readonly mapError: (detail: string, cause?: unknown) => TextGenerationError;
  }) => Effect.Effect<void, TextGenerationError>;
  readonly mapError: (
    operation: TextGenerationOperation,
    detail: string,
    cause?: unknown,
  ) => TextGenerationError;
}

export function runAcpTextGeneration<
  ModelSelection extends {
    readonly provider: string;
    readonly model: string;
    readonly options?: unknown;
  },
  RuntimeSettings,
  S extends Schema.Top,
>(
  config: AcpTextGenerationConfig<ModelSelection, RuntimeSettings>,
  input: {
    readonly operation: TextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly rawTextFallback?: RawTextFallback | undefined;
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly modelSelection: ModelSelection;
    readonly providerOptions?: ProviderStartOptions | undefined;
  },
): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> {
  return Effect.gen(function* () {
    const modelSelection = config.resolveModelSelection({
      modelSelection: input.modelSelection,
    });
    if (!modelSelection) {
      return yield* Effect.fail(
        config.mapError(input.operation, `Invalid ${config.providerLabel} model selection.`),
      );
    }

    const outputRef = yield* Ref.make<AcpTextGenerationOutput>({
      text: "",
      byteLength: 0,
      exceededLimit: false,
    });
    const runtime = yield* config.makeRuntime({
      childProcessSpawner: input.childProcessSpawner,
      settings: config.resolveSettings(input.providerOptions),
      cwd: input.cwd,
    });

    yield* runtime.handleSessionUpdate((notification) => {
      const update = notification.update;
      if (update.sessionUpdate !== "agent_message_chunk") {
        return Effect.void;
      }
      const content = update.content;
      if (content.type !== "text") {
        return Effect.void;
      }
      return Ref.update(outputRef, (current) =>
        appendAcpTextGenerationOutput(current, content.text),
      );
    });

    const mapErrorForOperation = (detail: string, cause?: unknown) =>
      config.mapError(input.operation, detail, cause);

    const promptResult = yield* Effect.gen(function* () {
      yield* config.prepareRuntime({
        runtime,
        modelSelection,
        operation: input.operation,
        mapError: mapErrorForOperation,
      });
      return yield* runtime.prompt({
        prompt: [{ type: "text", text: input.prompt }],
      });
    }).pipe(
      Effect.timeoutOption(config.timeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapErrorForOperation(`${config.providerLabel} request timed out.`)),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapErrorForOperation(`${config.providerLabel} ACP request failed.`, cause),
      ),
    );

    const output = yield* Ref.get(outputRef);
    if (output.exceededLimit) {
      return yield* Effect.fail(
        mapErrorForOperation(
          `${config.providerLabel} output exceeded the ${ACP_TEXT_GENERATION_MAX_OUTPUT_BYTES}-byte limit.`,
        ),
      );
    }

    const rawResult = output.text.trim();
    if (!rawResult) {
      return yield* Effect.fail(
        new TextGenerationError({
          operation: input.operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? `${config.providerLabel} ACP request was cancelled.`
              : `${config.providerLabel} returned empty output.`,
        }),
      );
    }

    return yield* decodeStructuredTextGenerationOutput({
      schema: input.outputSchemaJson,
      raw: rawResult,
      operation: input.operation,
      providerLabel: config.providerLabel,
      ...(input.rawTextFallback ? { rawTextFallback: input.rawTextFallback } : {}),
    });
  }).pipe(
    Effect.mapError((cause) =>
      isTextGenerationError(cause)
        ? cause
        : config.mapError(
            input.operation,
            `${config.providerLabel} ACP text generation failed.`,
            cause,
          ),
    ),
    Effect.scoped,
  );
}
