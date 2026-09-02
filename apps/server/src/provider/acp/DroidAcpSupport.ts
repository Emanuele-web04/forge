/**
 * Droid ACP support - builds the Factory Droid `droid exec --output-format acp` command and resolves auth.
 *
 * @module DroidAcpSupport
 */
import { existsSync } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { resolveExecutable } from "@synara/shared/executable";
import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";
import {
  type DroidModelOptions,
  type ProviderListModelsResult,
  type ProviderInteractionMode,
  type ProviderModelDescriptor,
} from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface DroidAcpRuntimeSettings {
  readonly appendSystemPrompt?: string;
  readonly binaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: DroidModelOptions["reasoningEffort"];
}

export interface DroidAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly droidSettings: DroidAcpRuntimeSettings | null | undefined;
}

export interface DroidAcpModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

export interface DroidAcpModeSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

const DROID_MODEL_CONFIG_ID = "model";
const DROID_REASONING_EFFORT_CONFIG_ID = "reasoning_effort";
const DROID_AUTONOMY_CONFIG_ID = "autonomy_level";
const DROID_DEFAULT_MODE_ID = "normal";
const DROID_PLAN_MODE_ID = "spec";

const DROID_API_KEY_AUTH_METHOD_ID = "factory-api-key";
const DROID_DEVICE_PAIRING_AUTH_METHOD_ID = "device-pairing";
const DROID_API_KEY_ENV_KEYS = ["FACTORY_API_KEY"] as const;

export function getDroidApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of DROID_API_KEY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function hasDroidApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return getDroidApiKeyEnv(env) !== undefined;
}

export interface DroidCliResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly pathExists?: (candidate: string) => boolean;
}

/** Uses shared executable resolution, then Factory's provider-specific POSIX fallback. */
export function resolveDroidCliBinaryPath(
  binaryPath?: string | null,
  options: DroidCliResolutionOptions = {},
): string {
  const configured = binaryPath?.trim();
  if (configured) {
    return configured;
  }
  const name = "droid";
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolved = resolveExecutable(name, { platform, env });
  if (resolved) {
    return resolved;
  }
  if (supportsPosixPermissions(platform)) {
    const localBin = nodePath.join(options.homeDir ?? nodeOs.homedir(), ".local", "bin", name);
    if ((options.pathExists ?? existsSync)(localBin)) {
      return localBin;
    }
  }
  return name;
}

export function buildDroidAcpSpawnInput(
  droidSettings: DroidAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  const args = ["exec", "--output-format", "acp"];
  const appendSystemPrompt = droidSettings?.appendSystemPrompt?.trim();
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }
  const model = droidSettings?.model?.trim();
  if (model) {
    args.push("-m", model);
  }
  const reasoningEffort = droidSettings?.reasoningEffort?.trim();
  if (reasoningEffort) {
    args.push("-r", reasoningEffort);
  }

  return {
    command: resolveDroidCliBinaryPath(droidSettings?.binaryPath),
    args,
    cwd,
    env: buildProviderChildEnvironment({ provider: "droid" }),
  };
}

function availableAuthMethodIds(initializeResult: Acp.InitializeResponse): ReadonlySet<string> {
  return new Set((initializeResult.authMethods ?? []).map((method) => method.id.trim()));
}

export const resolveDroidAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    if (hasDroidApiKeyEnv() && authMethodIds.has(DROID_API_KEY_AUTH_METHOD_ID)) {
      return DROID_API_KEY_AUTH_METHOD_ID;
    }
    if (authMethodIds.has(DROID_DEVICE_PAIRING_AUTH_METHOD_ID)) {
      return DROID_DEVICE_PAIRING_AUTH_METHOD_ID;
    }
    return yield* new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "Droid ACP authentication is unavailable.",
      data: {
        authMethods: [...authMethodIds],
        detail: "Run `droid` to authenticate locally, or set FACTORY_API_KEY.",
      },
    });
  });

export const makeDroidAcpRuntime = (
  input: DroidAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDroidAcpSpawnInput(input.droidSettings, input.cwd),
        resolveAuthMethodId: resolveDroidAcpAuthMethodId,
        authenticateMeta: { headless: true },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

/**
 * Applies the requested model and reasoning effort over ACP. `droid exec`
 * ignores `-m`/`-r` when running in ACP mode (the session inherits the user's
 * `~/.factory` settings defaults), so `session/set_config_option` is the only
 * mechanism that actually switches the session's model. The model is applied
 * first because it determines which reasoning-effort values are valid. The
 * shared runtime validates values against the advertised options and skips
 * the RPC when the current value already matches.
 */
export function applyDroidAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "setConfigOption">;
  readonly model: string;
  readonly reasoningEffort?: string | null | undefined;
  readonly mapError: (context: DroidAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const mapError = (cause: AcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    const model = input.model.trim();
    if (model) {
      yield* input.runtime
        .setConfigOption(DROID_MODEL_CONFIG_ID, model)
        .pipe(Effect.mapError(mapError));
    }
    const reasoningEffort = input.reasoningEffort?.trim();
    if (reasoningEffort) {
      yield* input.runtime
        .setConfigOption(DROID_REASONING_EFFORT_CONFIG_ID, reasoningEffort)
        .pipe(Effect.mapError(mapError));
    }
  });
}

/** Applies Droid's native read-only spec mode before a Plan-mode prompt is dispatched. */
export function applyDroidAcpInteractionMode<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "setConfigOption" | "setMode">;
  readonly interactionMode?: ProviderInteractionMode;
  readonly runtimeMode?: "approval-required" | "full-access";
  readonly mapError: (context: DroidAcpModeSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const modeId =
    input.interactionMode === "plan"
      ? DROID_PLAN_MODE_ID
      : input.runtimeMode === "full-access"
        ? "auto-high"
        : DROID_DEFAULT_MODE_ID;
  return input.runtime.setMode(modeId).pipe(
    // Older Droid ACP builds exposed the autonomy selector without a modes block.
    Effect.catch(() => input.runtime.setConfigOption(DROID_AUTONOMY_CONFIG_ID, modeId)),
    Effect.mapError((cause) => input.mapError({ cause, method: "session/set_config_option" })),
    Effect.asVoid,
  );
}

export function flattenDroidConfigOptions(
  options: Acp.SessionConfigSelectOptions,
): ReadonlyArray<Acp.SessionConfigSelectOption> {
  return options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

function findDroidSelectConfig(
  options: ReadonlyArray<Acp.SessionConfigOption>,
  input: { readonly id: string; readonly category: string },
): Extract<Acp.SessionConfigOption, { readonly type: "select" }> | undefined {
  return options.find(
    (option): option is Extract<Acp.SessionConfigOption, { readonly type: "select" }> =>
      option.type === "select" && (option.id === input.id || option.category === input.category),
  );
}

function droidModelDescriptor(
  model: Acp.SessionConfigSelectOption,
  reasoning: Extract<Acp.SessionConfigOption, { readonly type: "select" }> | undefined,
): ProviderModelDescriptor {
  const efforts = reasoning ? flattenDroidConfigOptions(reasoning.options) : [];
  const optionDescriptors = reasoning
    ? [
        {
          id: "reasoningEffort",
          label: reasoning.name,
          type: "select" as const,
          options: efforts.map((effort) => ({
            id: effort.value,
            label: effort.name,
            ...(effort.description ? { description: effort.description } : {}),
          })),
          ...(reasoning.currentValue ? { currentValue: reasoning.currentValue } : {}),
        },
      ]
    : undefined;
  return {
    slug: model.value,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    supportedReasoningEfforts: efforts.map((effort) => ({
      value: effort.value,
      label: effort.name,
      ...(effort.description ? { description: effort.description } : {}),
    })),
    ...(optionDescriptors ? { optionDescriptors } : {}),
    supportsFastMode: false,
    supportsThinkingToggle: false,
  };
}

/**
 * Reads the model catalog from ACP and reselects each model so Droid returns that
 * model's current reasoning choices. Discovery runs in a disposable session.
 */
export function discoverDroidAcpModels(
  runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setConfigOption">,
): Effect.Effect<ProviderListModelsResult, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const initialOptions = yield* runtime.getConfigOptions;
    const modelConfig = findDroidSelectConfig(initialOptions, {
      id: DROID_MODEL_CONFIG_ID,
      category: "model",
    });
    if (!modelConfig) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Droid ACP did not advertise a model configuration option.",
      });
    }

    const originalModel = modelConfig.currentValue;
    const originalReasoning = findDroidSelectConfig(initialOptions, {
      id: DROID_REASONING_EFFORT_CONFIG_ID,
      category: "thought_level",
    })?.currentValue;
    const models = flattenDroidConfigOptions(modelConfig.options);
    const descriptors = yield* Effect.forEach(
      models,
      (model) =>
        runtime.setConfigOption(modelConfig.id, model.value).pipe(
          Effect.andThen(runtime.getConfigOptions),
          Effect.map((updatedOptions) =>
            droidModelDescriptor(
              model,
              findDroidSelectConfig(updatedOptions, {
                id: DROID_REASONING_EFFORT_CONFIG_ID,
                category: "thought_level",
              }),
            ),
          ),
          // A newly announced model should remain selectable even if its option probe fails.
          Effect.catch(() => Effect.succeed(droidModelDescriptor(model, undefined))),
        ),
      { concurrency: 1 },
    );

    if (originalModel) {
      yield* runtime.setConfigOption(modelConfig.id, originalModel).pipe(Effect.ignore);
      if (originalReasoning) {
        yield* runtime
          .setConfigOption(DROID_REASONING_EFFORT_CONFIG_ID, originalReasoning)
          .pipe(Effect.ignore);
      }
    }

    return {
      models: descriptors,
      source: "droid-acp",
      cached: false,
    } satisfies ProviderListModelsResult;
  });
}
