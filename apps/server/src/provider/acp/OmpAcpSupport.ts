/**
 * OMP ACP support - builds the Oh My Pi `omp acp` command and resolves auth.
 *
 * @module OmpAcpSupport
 */
import { existsSync } from "node:fs";
import * as nodePath from "node:path";

import { type ProviderModelDescriptor, OMP_THINKING_LEVEL_OPTIONS } from "@synara/contracts";
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
import {
  availableAuthMethodIds,
  findSelectConfig,
  flattenConfigOptions,
} from "./AcpConfigOptions.ts";

export interface OmpAcpRuntimeSettings {
  readonly binaryPath?: string;
}

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeSettings | null | undefined;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

export interface OmpAcpModeSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

const OMP_MODEL_CONFIG_ID = "model";
const OMP_THINKING_CONFIG_ID = "thinking";
const OMP_MODE_CONFIG_ID = "mode";
const OMP_DEFAULT_MODE_ID = "default";
const OMP_PLAN_MODE_ID = "plan";

const OMP_AGENT_AUTH_METHOD_ID = "agent";

/** Honors a configured binary path first, then resolves `omp` from PATH. */
export function resolveOmpCliBinaryPath(binaryPath?: string | null): string {
  const configured = binaryPath?.trim();
  if (configured) {
    return configured;
  }
  const name = "omp";
  const searchPath = process.env.PATH ?? "";
  for (const directory of searchPath.split(nodePath.delimiter)) {
    if (!directory.trim()) {
      continue;
    }
    const candidate = nodePath.join(directory, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return name;
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: resolveOmpCliBinaryPath(ompSettings?.binaryPath),
    args: ["acp"],
    cwd,
    env: buildProviderChildEnvironment({ provider: "omp" }),
  };
}

export const resolveOmpAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    if (authMethodIds.has(OMP_AGENT_AUTH_METHOD_ID)) {
      return OMP_AGENT_AUTH_METHOD_ID;
    }
    return yield* new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "OMP ACP authentication is unavailable.",
      data: {
        authMethods: [...authMethodIds],
        detail: "Run `omp` to authenticate locally so ~/.omp credentials exist.",
      },
    });
  });

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(input.ompSettings, input.cwd),
        resolveAuthMethodId: resolveOmpAcpAuthMethodId,
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
 * Applies the requested model and thinking level over ACP. `omp acp` reads its
 * model and thinking from session config options (not CLI flags), so
 * `session/set_config_option` is the only mechanism that switches them. The
 * model is applied first because it determines which thinking levels are valid.
 * The shared runtime validates values against the advertised options and skips
 * the RPC when the current value already matches.
 */
export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "setConfigOption">;
  readonly model: string;
  readonly thinkingLevel?: string | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const mapError = (cause: AcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    const model = input.model.trim();
    if (model) {
      yield* input.runtime
        .setConfigOption(OMP_MODEL_CONFIG_ID, model)
        .pipe(Effect.mapError(mapError));
    }
    const thinkingLevel = input.thinkingLevel?.trim();
    if (thinkingLevel) {
      yield* input.runtime
        .setConfigOption(OMP_THINKING_CONFIG_ID, thinkingLevel)
        .pipe(Effect.mapError(mapError));
    }
  });
}

/**
 * Applies OMP's native mode config option before a prompt is dispatched. OMP
 * advertises a `mode` select option (category "mode") with `default` always
 * present and `plan` only when plan mode is enabled. Synara's `plan`
 * interaction mode routes to OMP `"plan"`; everything else passes through as
 * `default`. If the requested mode is not advertised (e.g. plan disabled), or
 * OMP did not advertise a mode option, OMP is left on its current (default) mode.
 */
export function applyOmpAcpInteractionMode<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setConfigOption">;
  readonly interactionMode?: "default" | "plan";
  readonly runtimeMode?: "approval-required" | "full-access";
  readonly mapError: (context: OmpAcpModeSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const requestedModeId = input.interactionMode === "plan" ? OMP_PLAN_MODE_ID : OMP_DEFAULT_MODE_ID;
  return Effect.gen(function* () {
    const mapError = (cause: AcpErrors.AcpError) =>
      input.mapError({ cause, method: "session/set_config_option" });
    const options = yield* input.runtime.getConfigOptions;
    const modeConfig = findSelectConfig(options, {
      id: OMP_MODE_CONFIG_ID,
      category: "mode",
    });
    // Unknown/unavailable requested mode, or no mode option advertised → leave OMP as-is.
    if (!modeConfig) {
      return;
    }
    const advertisedValues = new Set(
      flattenConfigOptions(modeConfig.options).map((choice) => choice.value),
    );
    if (!advertisedValues.has(requestedModeId)) {
      return;
    }
    yield* input.runtime
      .setConfigOption(modeConfig.id, requestedModeId)
      .pipe(Effect.mapError(mapError));
  });
}

/**
 * Parses the multi-provider model catalog emitted by `omp models --json`.
 *
 * OMP aggregates many upstream providers (alibaba, cursor, google, xai, …) and
 * `omp models --json` returns every model in a single subprocess call, each with
 * its own `thinking` effort list inline. Discovery is therefore O(1) round-trips
 * and scales to OMP's full catalog. The in-band ACP model option exposes only
 * slug/name; reading per-model thinking that way needs one
 * `session/set_config_option` round-trip per model, which is unscalable for the
 * 300+ model catalogs OMP routinely serves.
 */
const OMP_THINKING_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  auto: "Auto",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
  xhigh: "XHigh",
};

const ompThinkingLabel = (value: string): string =>
  OMP_THINKING_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
const OMP_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(OMP_THINKING_LEVEL_OPTIONS);

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readStringArrayField(record: Record<string, unknown>, key: string): ReadonlyArray<string> {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

export function parseOmpCliModelList(stdout: string): ReadonlyArray<ProviderModelDescriptor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  let rawModels: ReadonlyArray<unknown>;
  if (Array.isArray(parsed)) {
    rawModels = parsed;
  } else if (isStringRecord(parsed) && "models" in parsed && Array.isArray(parsed.models)) {
    rawModels = parsed.models;
  } else {
    rawModels = [];
  }
  const seen = new Set<string>();
  const models: ProviderModelDescriptor[] = [];
  for (const entry of rawModels) {
    if (!isStringRecord(entry)) {
      continue;
    }
    const slug = readStringField(entry, "selector").trim();
    const name = readStringField(entry, "name").trim();
    if (!slug || !name || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const upstreamProviderId = readStringField(entry, "provider").trim();
    const thinking = readStringArrayField(entry, "thinking");
    const seenEfforts = new Set<string>();
    const efforts = thinking
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is string => {
        if (seenEfforts.has(value) || !OMP_THINKING_LEVEL_SET.has(value)) {
          return false;
        }
        seenEfforts.add(value);
        return true;
      });
    models.push({
      slug,
      name,
      ...(upstreamProviderId ? { upstreamProviderId } : {}),
      ...(efforts.length > 0
        ? {
            supportedReasoningEfforts: efforts.map((value) => ({
              value,
              label: ompThinkingLabel(value),
            })),
          }
        : {}),
    });
  }
  return models;
}
