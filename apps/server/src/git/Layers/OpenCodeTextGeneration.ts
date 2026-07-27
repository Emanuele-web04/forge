// FILE: OpenCodeTextGeneration.ts
// Purpose: Runs OpenCode-compatible one-shot text generation for titles, branches, recaps, and release text.
// Layer: Server git/text-generation adapter
// Depends on: OpenCode SDK runtime, prompt builders, attachment projection, and server config.

import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import type {
  ChatAttachment,
  KiloModelSelection,
  OpenCodeModelSelection,
  OpenCodeModelOptions,
  ProviderStartOptions,
} from "@synara/contracts";
import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";
import { getModelSelectionStringOptionValue } from "@synara/shared/model";

import { resolveProviderAttachmentPath } from "../../provider/providerAttachmentPaths.ts";
import { ServerConfig } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../../provider/attachmentProjection.ts";
import {
  OpenCodeRuntime,
  KILO_CLI_SPEC,
  OPENCODE_CLI_SPEC,
  type OpenCodeCompatibleCliSpec,
  type OpenCodeServerConnection,
  type OpenCodeServerProcess,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
} from "../../provider/opencodeRuntime.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  type TextGenerationOperation,
  type TextGenerationShape,
  KiloTextGeneration,
  OpenCodeTextGeneration,
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
  decodeStructuredTextGenerationOutput,
  type RawTextFallback,
  sanitizeCommitSubject,
  sanitizeDiffSummary,
  sanitizeThreadRecap,
  sanitizePrTitle,
} from "../textGenerationShared.ts";

const OPENCODE_TEXT_GENERATION_IDLE_TTL = "30 seconds";

function getOpenCodePromptErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return message;
  }

  if ("name" in error && typeof error.name === "string") {
    const name = error.name.trim();
    return name.length > 0 ? name : null;
  }

  return null;
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      if (!("type" in part) || part.type !== "text") {
        return [];
      }
      if (!("text" in part) || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("")
    .trim();
}

interface SharedOpenCodeTextGenerationServerState {
  server: OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  binaryPath: string | null;
  cwd: string | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

interface AcquiredOpenCodeTextGenerationServer {
  server: OpenCodeServerProcess;
  shared: boolean;
  serverScope: Scope.Closeable | null;
}

type OpenCodeCompatibleTextGenerationProvider = "opencode" | "kilo";
type OpenCodeCompatibleModelSelection = OpenCodeModelSelection | KiloModelSelection;

interface OpenCodeCompatibleTextGenerationConfig {
  readonly provider: OpenCodeCompatibleTextGenerationProvider;
  readonly displayName: string;
  readonly serviceName: string;
  readonly cliSpec: OpenCodeCompatibleCliSpec;
  readonly resolveServerPassword?: (
    provider: OpenCodeCompatibleTextGenerationProvider,
  ) => Effect.Effect<string | undefined>;
}

function resolveOpenCodeCompatibleModelSelection(
  config: OpenCodeCompatibleTextGenerationConfig,
  input: {
    readonly model?: string;
    readonly modelSelection?: { provider: string; model: string; options?: unknown };
  },
): OpenCodeCompatibleModelSelection | null {
  if (input.modelSelection?.provider === config.provider) {
    return input.modelSelection as OpenCodeCompatibleModelSelection;
  }

  const model = input.model?.trim();
  if (config.provider !== "opencode" || !model || parseOpenCodeModelSlug(model) === null) {
    return null;
  }

  return {
    provider: "opencode",
    model,
  };
}

const makeOpenCodeCompatibleTextGeneration = (config: OpenCodeCompatibleTextGenerationConfig) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const sharedServerMutex = yield* Semaphore.make(1);
    const sharedServerState: SharedOpenCodeTextGenerationServerState = {
      server: null,
      serverScope: null,
      binaryPath: null,
      cwd: null,
      activeRequests: 0,
      idleCloseFiber: null,
    };

    const closeSharedServer = Effect.fn("closeSharedServer")(function* () {
      const scope = sharedServerState.serverScope;
      sharedServerState.server = null;
      sharedServerState.serverScope = null;
      sharedServerState.binaryPath = null;
      sharedServerState.cwd = null;
      if (scope !== null) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      }
    });

    const cancelIdleCloseFiber = Effect.fn("cancelIdleCloseFiber")(function* () {
      const idleCloseFiber = sharedServerState.idleCloseFiber;
      sharedServerState.idleCloseFiber = null;
      if (idleCloseFiber !== null) {
        yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
      }
    });

    const scheduleIdleClose = Effect.fn("scheduleIdleClose")(function* (
      server: OpenCodeServerProcess,
    ) {
      yield* cancelIdleCloseFiber();
      const fiber = yield* Effect.sleep(OPENCODE_TEXT_GENERATION_IDLE_TTL).pipe(
        Effect.andThen(
          sharedServerMutex.withPermit(
            Effect.gen(function* () {
              if (sharedServerState.server !== server || sharedServerState.activeRequests > 0) {
                return;
              }
              sharedServerState.idleCloseFiber = null;
              yield* closeSharedServer();
            }),
          ),
        ),
        Effect.forkIn(idleFiberScope),
      );
      sharedServerState.idleCloseFiber = fiber;
    });

    const acquireSharedServer = (input: {
      readonly binaryPath: string;
      readonly cwd: string;
      readonly operation: TextGenerationOperation;
    }) =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          yield* cancelIdleCloseFiber();

          const startServer = Effect.fn("startOpenCodeTextGenerationServer")(function* () {
            const serverScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              openCodeRuntime
                .startOpenCodeServerProcess({
                  binaryPath: input.binaryPath,
                  cliSpec: config.cliSpec,
                  cwd: input.cwd,
                })
                .pipe(
                  Effect.provideService(Scope.Scope, serverScope),
                  Effect.mapError(
                    (cause) =>
                      new TextGenerationError({
                        operation: input.operation,
                        detail: openCodeRuntimeErrorDetail(cause),
                        cause,
                      }),
                  ),
                ),
            );

            if (startedExit._tag === "Failure") {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            return {
              server: startedExit.value,
              serverScope,
            };
          });

          const existingServer = sharedServerState.server;
          if (existingServer !== null) {
            const sameConfigScope =
              sharedServerState.binaryPath === input.binaryPath &&
              sharedServerState.cwd === input.cwd;
            if (!sameConfigScope && sharedServerState.activeRequests === 0) {
              yield* closeSharedServer();
            } else {
              if (!sameConfigScope) {
                yield* Effect.logWarning(
                  `${config.displayName} shared server config scope mismatch: requested ` +
                    input.binaryPath +
                    " at " +
                    input.cwd +
                    " but active server uses " +
                    sharedServerState.binaryPath +
                    " at " +
                    sharedServerState.cwd +
                    "; starting a dedicated server for this request",
                );
                const dedicated = yield* startServer();
                return {
                  server: dedicated.server,
                  shared: false,
                  serverScope: dedicated.serverScope,
                } satisfies AcquiredOpenCodeTextGenerationServer;
              }
              sharedServerState.activeRequests += 1;
              return {
                server: existingServer,
                shared: true,
                serverScope: null,
              } satisfies AcquiredOpenCodeTextGenerationServer;
            }
          }

          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const { server, serverScope } = yield* restore(startServer());
              sharedServerState.server = server;
              sharedServerState.serverScope = serverScope;
              sharedServerState.binaryPath = input.binaryPath;
              sharedServerState.cwd = input.cwd;
              sharedServerState.activeRequests = 1;
              return {
                server,
                shared: true,
                serverScope: null,
              } satisfies AcquiredOpenCodeTextGenerationServer;
            }),
          );
        }),
      );

    const releaseSharedServer = (acquired: AcquiredOpenCodeTextGenerationServer) =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          if (!acquired.shared) {
            if (acquired.serverScope !== null) {
              yield* Scope.close(acquired.serverScope, Exit.void).pipe(Effect.ignore);
            }
            return;
          }
          if (sharedServerState.server !== acquired.server) {
            return;
          }
          sharedServerState.activeRequests = Math.max(0, sharedServerState.activeRequests - 1);
          if (sharedServerState.activeRequests === 0) {
            yield* scheduleIdleClose(acquired.server);
          }
        }),
      );

    yield* Effect.addFinalizer(() =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          yield* cancelIdleCloseFiber();
          sharedServerState.activeRequests = 0;
          yield* closeSharedServer();
        }),
      ),
    );

    const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
      readonly operation: TextGenerationOperation;
      readonly cwd: string;
      readonly prompt: string;
      readonly outputSchemaJson: S;
      readonly rawTextFallback?: RawTextFallback;
      readonly modelSelection: OpenCodeCompatibleModelSelection;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
      readonly providerOptions?: ProviderStartOptions;
    }) {
      const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
      if (!parsedModel) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: `${config.displayName} model selection must use the 'provider/model' format.`,
        });
      }

      const providerOptions = input.providerOptions?.[config.provider];
      const binaryPath = providerOptions?.binaryPath?.trim() || config.cliSpec.defaultBinaryPath;
      const serverUrl = providerOptions?.serverUrl?.trim() || "";
      const serverPassword = config.resolveServerPassword
        ? ((yield* config.resolveServerPassword(config.provider)) ?? "")
        : "";
      const providerId = parsedModel.providerID;
      const modelId = parsedModel.modelID;
      const modelOptions = input.modelSelection.options as OpenCodeModelOptions | undefined;
      const agent = modelOptions?.agent?.trim();
      const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant")?.trim();

      const promptText =
        appendFileAttachmentsPromptBlock({
          text: input.prompt,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        }) ?? input.prompt;
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveProviderAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });

      const runAgainstServer = (server: Pick<OpenCodeServerConnection, "url">) =>
        Effect.tryPromise({
          try: async () => {
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: input.cwd,
              ...(serverPassword.length > 0 ? { serverPassword } : {}),
              cliSpec: config.cliSpec,
            });
            const sessionCreateInput = {
              title: `Synara ${input.operation}`,
              model: {
                providerID: providerId,
                id: modelId,
                ...(variant ? { variant } : {}),
              },
              ...(agent ? { agent } : {}),
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            };
            const session = await client.session.create(
              sessionCreateInput as unknown as Parameters<typeof client.session.create>[0],
            );
            if (!session.data) {
              throw new Error("OpenCode session.create returned no session payload.");
            }

            const result = await client.session.prompt({
              sessionID: session.data.id,
              model: parsedModel,
              ...(agent ? { agent } : {}),
              ...(variant ? { variant } : {}),
              parts: [{ type: "text", text: promptText }, ...fileParts],
            });
            const info = result.data?.info;
            const errorMessage = getOpenCodePromptErrorMessage(info?.error);
            if (errorMessage) {
              throw new Error(errorMessage);
            }
            const rawText = getOpenCodeTextResponse(result.data?.parts);
            if (rawText.length === 0) {
              throw new Error("OpenCode returned empty output.");
            }
            return rawText;
          },
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: [
                openCodeRuntimeErrorDetail(cause),
                `model=${providerId}/${modelId}`,
                variant ? `variant=${variant}` : null,
                agent ? `agent=${agent}` : null,
                serverUrl.length > 0 ? "server=external" : "server=managed",
              ]
                .filter(Boolean)
                .join(" "),
              cause,
            }),
        });

      yield* Effect.logDebug("OpenCode text generation request", {
        operation: input.operation,
        cwd: input.cwd,
        providerId,
        modelId,
        variant,
        agent,
        attachmentCount: input.attachments?.length ?? 0,
        filePartCount: fileParts.length,
        binaryPath,
        usingExternalServer: serverUrl.length > 0,
      });

      const rawOutput =
        serverUrl.length > 0
          ? yield* runAgainstServer({ url: serverUrl })
          : yield* Effect.acquireUseRelease(
              acquireSharedServer({
                binaryPath,
                cwd: input.cwd,
                operation: input.operation,
              }),
              (acquired) => runAgainstServer(acquired.server),
              releaseSharedServer,
            );

      return yield* decodeStructuredTextGenerationOutput({
        schema: input.outputSchemaJson,
        raw: rawOutput,
        operation: input.operation,
        providerLabel: config.displayName,
        ...(input.rawTextFallback ? { rawTextFallback: input.rawTextFallback } : {}),
      });
    });

    const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
      `${config.serviceName}.generateCommitMessage`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateCommitMessage",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
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
      `${config.serviceName}.generatePrContent`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generatePrContent",
          detail: `Invalid ${config.displayName} model selection.`,
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
      const generated = yield* runOpenCodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

    const generateDiffSummary: TextGenerationShape["generateDiffSummary"] = Effect.fn(
      `${config.serviceName}.generateDiffSummary`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateDiffSummary",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildDiffSummaryPrompt({
        patch: input.patch,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateDiffSummary",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        summary: sanitizeDiffSummary(generated.summary),
      };
    });

    const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
      `${config.serviceName}.generateBranchName`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateBranchName",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildBranchNamePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

    const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
      `${config.serviceName}.generateThreadTitle`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildThreadTitlePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        title: sanitizeGeneratedThreadTitle(generated.title),
      };
    });

    const generateThreadRecap: TextGenerationShape["generateThreadRecap"] = Effect.fn(
      `${config.serviceName}.generateThreadRecap`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateThreadRecap",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildThreadRecapPrompt({
        ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
        newMaterial: input.newMaterial,
        ...(input.currentState ? { currentState: input.currentState } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadRecap",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        recap: sanitizeThreadRecap(generated.recap, input.previousRecap),
      };
    });

    const generateAutomationIntent: TextGenerationShape["generateAutomationIntent"] = Effect.fn(
      `${config.serviceName}.generateAutomationIntent`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateAutomationIntent",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson } = buildAutomationIntentPrompt({
        message: input.message,
        ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
        nowIso: input.nowIso,
      });
      return yield* runOpenCodeJson({
        operation: "generateAutomationIntent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });
    });

    const evaluateAutomationCompletion: TextGenerationShape["evaluateAutomationCompletion"] =
      Effect.fn(`${config.serviceName}.evaluateAutomationCompletion`)(function* (input) {
        const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
        if (!modelSelection) {
          return yield* new TextGenerationError({
            operation: "evaluateAutomationCompletion",
            detail: `Invalid ${config.displayName} model selection.`,
          });
        }

        const { prompt, outputSchemaJson } = buildAutomationCompletionEvaluationPrompt(input);
        return yield* runOpenCodeJson({
          operation: "evaluateAutomationCompletion",
          cwd: input.cwd,
          prompt,
          outputSchemaJson,
          modelSelection,
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
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

export const makeOpenCodeTextGenerationServiceLive = (
  resolveServerPassword?: OpenCodeCompatibleTextGenerationConfig["resolveServerPassword"],
) =>
  Layer.effect(
    OpenCodeTextGeneration,
    makeOpenCodeCompatibleTextGeneration({
      provider: "opencode",
      displayName: "OpenCode",
      serviceName: "OpenCodeTextGeneration",
      cliSpec: OPENCODE_CLI_SPEC,
      ...(resolveServerPassword ? { resolveServerPassword } : {}),
    }),
  );

export const makeKiloTextGenerationServiceLive = (
  resolveServerPassword?: OpenCodeCompatibleTextGenerationConfig["resolveServerPassword"],
) =>
  Layer.effect(
    KiloTextGeneration,
    makeOpenCodeCompatibleTextGeneration({
      provider: "kilo",
      displayName: "Kilo",
      serviceName: "KiloTextGeneration",
      cliSpec: KILO_CLI_SPEC,
      ...(resolveServerPassword ? { resolveServerPassword } : {}),
    }),
  );

export const OpenCodeTextGenerationServiceLive = makeOpenCodeTextGenerationServiceLive();
export const KiloTextGenerationServiceLive = makeKiloTextGenerationServiceLive();
