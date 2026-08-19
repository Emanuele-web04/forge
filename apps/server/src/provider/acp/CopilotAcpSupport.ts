// FILE: CopilotAcpSupport.ts
// Purpose: Builds and configures GitHub Copilot CLI's native ACP transport.
// Layer: Server provider ACP support

import type * as Acp from "@agentclientprotocol/sdk";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ProviderListModelsResult, ProviderModelDescriptor } from "@synara/contracts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import * as AcpErrors from "./AcpErrors.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface CopilotAcpRuntimeSettings {
  readonly binaryPath?: string;
}

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "authentication" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: CopilotAcpRuntimeSettings | null | undefined;
}

export interface CopilotAcpModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

/**
 * Copilot CLI exposes ACP directly over newline-delimited JSON on stdio.
 * Keep transport selection explicit even though stdio is currently the default
 * so future CLI defaults cannot silently change Synara's process contract.
 */
export function buildCopilotAcpSpawnInput(
  settings: CopilotAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: settings?.binaryPath?.trim() || "copilot",
    args: ["--acp", "--stdio"],
    cwd,
    // The shared ACP profile deliberately allows provider-owned credentials.
    // Copilot may use its persisted GitHub login or user-configured BYOK env.
    env: buildProviderChildEnvironment({ provider: "acp" }),
  };
}

/**
 * Let the agent advertise the authentication methods it supports and select its
 * first preferred method. Synara should not hard-code GitHub's evolving login
 * mechanism into the ACP transport layer.
 */
export const resolveCopilotAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
): Effect.Effect<string | undefined> =>
  Effect.succeed(
    (initializeResult.authMethods ?? []).map((method) => method.id.trim()).find(Boolean),
  );

export const makeCopilotAcpRuntime = (
  input: CopilotAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCopilotAcpSpawnInput(input.copilotSettings, input.cwd),
        resolveAuthMethodId: resolveCopilotAcpAuthMethodId,
        authentication: "when-advertised",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

export function applyCopilotAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "setModel">;
  readonly model: string;
  readonly mapError: (context: CopilotAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const model = input.model.trim();
  if (!model) {
    return Effect.void;
  }
  return input.runtime.setModel(model).pipe(
    Effect.mapError((cause) =>
      input.mapError({
        cause,
        method: "session/set_config_option",
      }),
    ),
  );
}

export function flattenCopilotConfigOptions(
  options: Acp.SessionConfigSelectOptions,
): ReadonlyArray<Acp.SessionConfigSelectOption> {
  return options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

function findCopilotModelConfig(
  options: ReadonlyArray<Acp.SessionConfigOption>,
): Extract<Acp.SessionConfigOption, { readonly type: "select" }> | undefined {
  return options.find(
    (option): option is Extract<Acp.SessionConfigOption, { readonly type: "select" }> =>
      option.type === "select" &&
      (option.id.trim().toLowerCase() === "model" ||
        option.category?.trim().toLowerCase() === "model"),
  );
}

function copilotModelDescriptor(model: Acp.SessionConfigSelectOption): ProviderModelDescriptor {
  return {
    slug: model.value,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
  };
}

/**
 * Read Copilot's model catalog from the ACP session config instead of pinning
 * model names in Synara. This keeps the integration aligned with the CLI's
 * account-specific and version-specific model availability.
 */
export function discoverCopilotAcpModels(
  runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions">,
): Effect.Effect<ProviderListModelsResult, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const configOptions = yield* runtime.getConfigOptions;
    const modelConfig = findCopilotModelConfig(configOptions);
    if (!modelConfig) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "GitHub Copilot CLI ACP did not advertise a model configuration option.",
      });
    }

    return {
      models: flattenCopilotConfigOptions(modelConfig.options).map(copilotModelDescriptor),
      source: "copilot-acp",
      cached: false,
    } satisfies ProviderListModelsResult;
  });
}
