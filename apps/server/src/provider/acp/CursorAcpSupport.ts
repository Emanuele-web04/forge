/**
 * CursorAcpSupport - helpers for Cursor ACP sessions and model selection.
 *
 * Owns spawn input construction, model picker flattening, and ACP config
 * mutations used by the Cursor provider adapter.
 *
 * @module CursorAcpSupport
 */
import { type CursorModelOptions, type ProviderModelDescriptor } from "@synara/contracts";
import { formatModelDisplayName, parseCursorCliReasoningEffort } from "@synara/shared/model";
import { Effect, Layer, Schema, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { SessionConfigOption as SessionConfigOptionCodec } from "./AcpExtensions.ts";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import {
  CURSOR_AGENT_BROWSERLESS_ENV,
  buildCursorAgentCommand,
  type CursorAgentCommand,
  type CursorAgentCommandOptions,
} from "./CursorAcpCommand.ts";

export interface CursorAcpRuntimeCursorSettings {
  readonly apiEndpoint?: string;
  readonly binaryPath?: string;
}

export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<Acp.InitializeRequest["clientCapabilities"]>;

export interface CursorAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
}

export interface CursorAcpModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export interface CursorAcpModelSelectionNotice {
  readonly reason: "model-unavailable" | "model-rejected";
  readonly message: string;
  readonly requestedModel: string;
  /** Model the session keeps running with, when one could be applied. */
  readonly appliedModel?: string;
  readonly cause?: AcpErrors.AcpError;
}

/** JSON-RPC invalid params: Cursor's answer to an unknown model value. */
const CURSOR_INVALID_MODEL_ERROR_CODE = -32602;

function isCursorModelRejection(cause: AcpErrors.AcpError): boolean {
  return (
    Schema.is(AcpErrors.AcpRequestError)(cause) && cause.code === CURSOR_INVALID_MODEL_ERROR_CODE
  );
}

export interface CursorAcpModelChoice {
  readonly slug: string;
  readonly name: string;
  readonly upstreamProviderId?: string;
  readonly upstreamProviderName?: string;
}

interface CursorAcpSelectOption {
  readonly value: string;
  readonly name: string;
  readonly groupId?: string;
  readonly groupName?: string;
}

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
  commandOptions?: CursorAgentCommandOptions,
): AcpSpawnInput {
  const command = buildCursorAgentCommand(
    cursorSettings?.binaryPath,
    [...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []), "acp"],
    commandOptions,
  );
  return {
    command: command.command,
    args: command.args,
    cwd,
    // Keep ACP startup browserless without forcing CI/noninteractive flags onto user turns.
    env: buildProviderChildEnvironment({
      provider: "cursor",
      overrides: CURSOR_AGENT_BROWSERLESS_ENV,
    }),
  };
}

export function buildCursorCliModelListCommand(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  commandOptions?: CursorAgentCommandOptions,
): CursorAgentCommand {
  return buildCursorAgentCommand(
    cursorSettings?.binaryPath,
    [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      "models",
    ],
    commandOptions,
  );
}

export const makeCursorAcpRuntime = (
  input: CursorAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCursorAcpSpawnInput(input.cursorSettings, input.cwd),
        authMethodId: "cursor_login",
        authenticateMeta: { headless: true },
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

interface CursorAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, AcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, AcpErrors.AcpError>;
}

export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "auto") return "auto";
  const parameterStart = trimmed.indexOf("[");
  return parameterStart === -1 ? trimmed : trimmed.slice(0, parameterStart).trim() || "auto";
}

function normalizedText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function flattenSessionConfigSelectOptions(
  configOption: Acp.SessionConfigOption | undefined,
): ReadonlyArray<CursorAcpSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((option) => ({
          value: option.value.trim(),
          name: option.name.trim(),
          ...("group" in entry && typeof entry.group === "string" && entry.group.trim().length > 0
            ? { groupId: entry.group.trim() }
            : {}),
          ...("name" in entry && typeof entry.name === "string" && entry.name.trim().length > 0
            ? { groupName: entry.name.trim() }
            : {}),
        })),
  );
}

function findCursorModelConfigOption(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
): Acp.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model");
}

function findConfigOption(
  options: ReadonlyArray<Acp.SessionConfigOption>,
  aliases: ReadonlyArray<string>,
): Acp.SessionConfigOption | undefined {
  const normalizedAliases = aliases.map(normalizedText);
  return options.find((option) => {
    const haystack = normalizedText(`${option.id} ${option.name} ${option.category ?? ""}`);
    return normalizedAliases.some((alias) => haystack.includes(alias));
  });
}

function stripCursorParameterizedSuffix(value: string): string {
  const trimmed = value.trim();
  const suffixStart = trimmed.indexOf("[");
  return suffixStart >= 0 ? trimmed.slice(0, suffixStart).trim() : trimmed;
}

function parseCursorModelParameters(value: string): ReadonlyMap<string, string> {
  const match = value.match(/\[([^\]]*)\]$/u);
  if (!match?.[1]) {
    return new Map();
  }
  const params = new Map<string, string>();
  for (const part of match[1].split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    const paramValue = part.slice(separatorIndex + 1).trim();
    if (key && paramValue) {
      params.set(key, paramValue);
    }
  }
  return params;
}

function cursorModelParametersToObject(value: string): Record<string, string> {
  return Object.fromEntries(parseCursorModelParameters(value).entries());
}

function buildCursorParameterizedModelSlug(
  baseModel: string,
  params: Record<string, string>,
): string {
  const entries = Object.entries(params).filter(([, value]) => value.trim().length > 0);
  if (entries.length === 0) {
    return baseModel;
  }
  return `${baseModel}[${entries.map(([key, value]) => `${key}=${value}`).join(",")}]`;
}

function humanizeCursorModelName(value: string): string {
  const base = stripCursorParameterizedSuffix(value);
  if (base.length === 0) {
    return value;
  }
  const sharedDisplayName = formatModelDisplayName(base);
  if (sharedDisplayName) {
    return sharedDisplayName;
  }
  return base
    .split(/[-_/]+/u)
    .filter((part) => part.length > 0)
    .map((part) => {
      const lower = part.toLowerCase();
      if (/^gpt$/u.test(lower)) return "GPT";
      if (/^ai$/u.test(lower)) return "AI";
      if (/^codex$/u.test(lower)) return "Codex";
      if (/^claude$/u.test(lower)) return "Claude";
      if (/^opus$/u.test(lower)) return "Opus";
      if (/^sonnet$/u.test(lower)) return "Sonnet";
      if (/^haiku$/u.test(lower)) return "Haiku";
      if (/^gemini$/u.test(lower)) return "Gemini";
      if (/^grok$/u.test(lower)) return "Grok";
      if (/^kimi$/u.test(lower)) return "Kimi";
      if (/^llama$/u.test(lower)) return "Llama";
      if (/^qwen$/u.test(lower)) return "Qwen";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function normalizeCursorAcpModelName(choice: CursorAcpSelectOption): string {
  const rawName = choice.name.trim();
  const rawBase = stripCursorParameterizedSuffix(choice.value);
  if (
    rawName.length > 0 &&
    rawName.toLowerCase() !== choice.value.trim().toLowerCase() &&
    rawName.toLowerCase() !== rawBase.toLowerCase()
  ) {
    return rawName;
  }
  return humanizeCursorModelName(choice.value);
}

function inferCursorUpstreamProvider(choice: CursorAcpSelectOption): {
  readonly upstreamProviderId: string;
  readonly upstreamProviderName: string;
} {
  const groupId = choice.groupId?.trim();
  const groupName = choice.groupName?.trim();
  if (groupId || groupName) {
    return {
      upstreamProviderId: (groupId || groupName || "cursor").toLowerCase().replace(/\s+/gu, "-"),
      upstreamProviderName: groupName || groupId || "Cursor",
    };
  }

  const token = stripCursorParameterizedSuffix(`${choice.value} ${choice.name}`)
    .trim()
    .toLowerCase();
  if (token.includes("claude")) {
    return { upstreamProviderId: "anthropic", upstreamProviderName: "Anthropic" };
  }
  if (token.includes("gemini")) {
    return { upstreamProviderId: "google", upstreamProviderName: "Google" };
  }
  if (token.includes("grok")) {
    return { upstreamProviderId: "xai", upstreamProviderName: "xAI" };
  }
  if (token.includes("kimi")) {
    return { upstreamProviderId: "moonshot", upstreamProviderName: "Moonshot AI" };
  }
  if (token.includes("deepseek")) {
    return { upstreamProviderId: "deepseek", upstreamProviderName: "DeepSeek" };
  }
  if (token.includes("qwen")) {
    return { upstreamProviderId: "alibaba", upstreamProviderName: "Alibaba" };
  }
  if (token.includes("llama")) {
    return { upstreamProviderId: "meta", upstreamProviderName: "Meta" };
  }
  if (token.includes("mistral")) {
    return { upstreamProviderId: "mistral", upstreamProviderName: "Mistral" };
  }
  if (token.includes("nemotron")) {
    return { upstreamProviderId: "nvidia", upstreamProviderName: "NVIDIA" };
  }
  if (
    token.includes("gpt") ||
    token.includes("codex") ||
    token.includes("o1") ||
    token.includes("o3") ||
    token.includes("o4")
  ) {
    return { upstreamProviderId: "openai", upstreamProviderName: "OpenAI" };
  }
  return { upstreamProviderId: "cursor", upstreamProviderName: "Cursor" };
}

export function flattenCursorAcpModelChoices(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
): ReadonlyArray<CursorAcpModelChoice> {
  const seen = new Set<string>();
  const choices: Array<CursorAcpModelChoice> = [];
  for (const choice of flattenSessionConfigSelectOptions(
    findCursorModelConfigOption(configOptions),
  )) {
    if (!choice.value || seen.has(choice.value)) {
      continue;
    }
    seen.add(choice.value);
    const upstreamProvider = inferCursorUpstreamProvider(choice);
    choices.push({
      slug: choice.value,
      name: normalizeCursorAcpModelName(choice),
      ...upstreamProvider,
    });
  }
  return choices;
}

export function parseCursorCliModelList(stdout: string): ReadonlyArray<ProviderModelDescriptor> {
  const seen = new Set<string>();
  const models: Array<ProviderModelDescriptor> = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "Available models" || trimmed.startsWith("Tip:")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(" - ");
    if (separatorIndex <= 0) {
      continue;
    }
    const slug = trimmed.slice(0, separatorIndex).trim();
    const rawName = trimmed.slice(separatorIndex + 3).trim();
    if (!slug || !rawName || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const name = rawName.replace(/\s+\((?:default|current)\)$/iu, "").trim() || rawName;
    const upstreamProvider = inferCursorUpstreamProvider({ value: slug, name });
    const options = cursorModelOptionsFromCliModelId(slug);
    models.push({
      slug,
      name,
      ...upstreamProvider,
      ...(options.fastMode === true ? { supportsFastMode: true } : {}),
      ...(options.thinking === true ? { supportsThinkingToggle: true } : {}),
      ...(options.reasoningEffort
        ? {
            supportedReasoningEfforts: [
              {
                value: options.reasoningEffort,
                label: cursorReasoningLabel(options.reasoningEffort),
              },
            ],
            defaultReasoningEffort: options.reasoningEffort,
          }
        : {}),
      ...(options.contextWindow
        ? {
            contextWindowOptions: [
              {
                value: options.contextWindow,
                label: options.contextWindow === "1m" ? "1M" : options.contextWindow.toUpperCase(),
                isDefault: true as const,
              },
            ],
            defaultContextWindow: options.contextWindow,
          }
        : {}),
    });
  }
  return models;
}

// ── ACP parameterized model discovery (cursor/list_available_models) ───
//
// The headless `cursor-agent models` CLI list pins every model to a single
// context window, so it can't surface the 300k/1m (etc.) choice the native TUI
// exposes. The richer per-model matrix lives behind the ACP extension method
// `cursor/list_available_models`, which returns every model alongside its own
// config options (context, effort/reasoning, thinking, fast). We project those
// into ProviderModelDescriptors so the composer can offer the same selectors as
// the built-in Claude models.

export const CURSOR_LIST_AVAILABLE_MODELS_METHOD = "cursor/list_available_models";

// Cursor exposes "auto" as a `default` model id over ACP; keep Synara's "auto"
// slug so the picker and DEFAULT_MODEL_BY_PROVIDER stay consistent.
const CURSOR_ACP_AUTO_MODEL_ID = "default";

const CursorAcpAvailableModel = Schema.Struct({
  value: Schema.String,
  name: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  configOptions: Schema.optional(Schema.Array(SessionConfigOptionCodec)),
});
export type CursorAcpAvailableModel = typeof CursorAcpAvailableModel.Type;

const CursorAcpListAvailableModelsResult = Schema.Struct({
  models: Schema.Array(CursorAcpAvailableModel),
});

const decodeCursorAcpListAvailableModelsResult = Schema.decodeUnknownEffect(
  CursorAcpListAvailableModelsResult,
);

function cursorContextWindowLabel(value: string): string {
  const normalized = value.trim();
  return normalized.toLowerCase() === "1m" ? "1M" : normalized.toUpperCase();
}

function findCursorThinkingConfigOption(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
): Acp.SessionConfigOption | undefined {
  return configOptions.find((option) => option.id.trim().toLowerCase() === "thinking");
}

function findCursorFastConfigOption(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
): Acp.SessionConfigOption | undefined {
  return configOptions.find((option) => option.id.trim().toLowerCase() === "fast");
}

function buildCursorAcpAvailableModelDescriptor(
  model: CursorAcpAvailableModel,
): ProviderModelDescriptor | undefined {
  const rawSlug = model.value.trim();
  if (!rawSlug) {
    return undefined;
  }
  const slug = rawSlug === CURSOR_ACP_AUTO_MODEL_ID ? "auto" : rawSlug;
  const configOptions = model.configOptions ?? [];

  const effortOption = findCursorEffortConfigOption(configOptions);
  const supportedReasoningEfforts =
    effortOption?.type === "select"
      ? flattenSessionConfigSelectOptions(effortOption).flatMap((entry) => {
          const value = normalizeCursorReasoningValue(entry.value);
          return value ? [{ value, label: cursorReasoningLabel(value) }] : [];
        })
      : [];
  const defaultReasoningEffort =
    effortOption?.type === "select"
      ? normalizeCursorReasoningValue(effortOption.currentValue)
      : undefined;

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) =>
          contextOption.currentValue === entry.value
            ? {
                value: entry.value,
                label: cursorContextWindowLabel(entry.value),
                isDefault: true as const,
              }
            : { value: entry.value, label: cursorContextWindowLabel(entry.value) },
        )
      : [];
  const defaultContextWindow = contextWindowOptions.find((option) => option.isDefault)?.value;

  const supportsThinkingToggle = findCursorThinkingConfigOption(configOptions) !== undefined;
  const supportsFastMode = findCursorFastConfigOption(configOptions) !== undefined;

  const name = model.name?.trim() || humanizeCursorModelName(slug);
  const upstreamProvider = inferCursorUpstreamProvider({ value: slug, name });

  return {
    slug,
    name,
    ...upstreamProvider,
    ...(supportedReasoningEfforts.length > 0
      ? {
          supportedReasoningEfforts,
          ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        }
      : {}),
    ...(supportsFastMode ? { supportsFastMode: true as const } : {}),
    ...(supportsThinkingToggle ? { supportsThinkingToggle: true as const } : {}),
    ...(contextWindowOptions.length > 0
      ? {
          contextWindowOptions,
          ...(defaultContextWindow ? { defaultContextWindow } : {}),
        }
      : {}),
  };
}

export function buildCursorAcpModelDescriptorsFromAvailableModels(
  models: ReadonlyArray<CursorAcpAvailableModel>,
): ReadonlyArray<ProviderModelDescriptor> {
  const seen = new Set<string>();
  const descriptors: Array<ProviderModelDescriptor> = [];
  for (const model of models) {
    const descriptor = buildCursorAcpAvailableModelDescriptor(model);
    if (!descriptor || seen.has(descriptor.slug)) {
      continue;
    }
    seen.add(descriptor.slug);
    descriptors.push(descriptor);
  }
  return descriptors;
}

// Calls the Cursor ACP extension method and projects the response into model
// descriptors. Decode failures surface as AcpError so the adapter can fall back
// to the flat CLI list.
export function fetchCursorAcpModelDescriptors(
  runtime: Pick<AcpSessionRuntimeShape, "request">,
  sessionId: string,
): Effect.Effect<ReadonlyArray<ProviderModelDescriptor>, AcpErrors.AcpError> {
  return runtime.request(CURSOR_LIST_AVAILABLE_MODELS_METHOD, { sessionId }).pipe(
    Effect.flatMap((raw) =>
      decodeCursorAcpListAvailableModelsResult(raw).pipe(
        Effect.mapError((cause) =>
          AcpErrors.AcpRequestError.parseError(
            "Failed to decode Cursor available models response.",
            cause,
          ),
        ),
      ),
    ),
    Effect.map((result) => buildCursorAcpModelDescriptorsFromAvailableModels(result.models)),
  );
}

function normalizeCursorCliBaseModelId(model: string): string {
  const trimmed = model.trim();
  const withoutVariantSuffixes = trimmed
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "")
    .replace(/-thinking$/u, "")
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "")
    // `cursor-agent models` namespaces Grok as `cursor-grok-*`, while the ACP
    // session model option exposes the same model as `grok-*`.
    .replace(/^cursor-(?=grok-)/u, "")
    .replace(/^claude-(\d+(?:\.\d+)?)-([a-z]+)-max$/u, "claude-$1-$2")
    .replace(/-preview$/u, "");

  const claudeReordered = withoutVariantSuffixes.match(/^claude-(\d+(?:\.\d+)?)-([a-z]+)$/u);
  if (claudeReordered) {
    const version = claudeReordered[1];
    const family = claudeReordered[2];
    if (!version || !family) {
      return withoutVariantSuffixes;
    }
    return `claude-${family}-${version.replace(".", "-")}`;
  }
  return withoutVariantSuffixes;
}

function isCursorCliOneMillionContextModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("gpt-5.5-")) {
    return true;
  }
  if (/^gpt-5\.4-(?:low|medium|high|xhigh|extra-high)$/u.test(normalized)) {
    return true;
  }
  if (/^claude-4\.6-(?:opus|sonnet)(?:-|$)/u.test(normalized)) {
    return true;
  }
  if (/^claude-(?:fable-5|opus-4-(?:7|8))-/u.test(normalized)) {
    return true;
  }
  return false;
}

function cursorModelOptionsFromCliModelId(model: string | null | undefined): CursorModelOptions {
  const trimmed = model?.trim();
  if (!trimmed || trimmed.includes("[")) {
    return {};
  }

  const lower = trimmed.toLowerCase();
  const reasoningEffort = parseCursorCliReasoningEffort(lower);
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(lower.endsWith("-fast") ? { fastMode: true } : {}),
    ...(lower.includes("-thinking") ? { thinking: true } : {}),
    ...(isCursorCliOneMillionContextModel(lower) ? { contextWindow: "1m" } : {}),
  };
}

function cursorAcpParameterKeyForModel(baseModel: string, options: CursorModelOptions): string {
  if (options.reasoningEffort && (baseModel.includes("claude") || baseModel.includes("grok"))) {
    return "effort";
  }
  return "reasoning";
}

function buildCursorParameterizedModelFromCliModelId(input: {
  readonly acpModelValue: string;
  readonly cliModel: string;
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
}): string | undefined {
  if (!input.acpModelValue.includes("[")) {
    return undefined;
  }
  const cliOptions = cursorModelOptionsFromCliModelId(input.cliModel);
  if (Object.keys(cliOptions).length === 0) {
    return undefined;
  }

  const baseModel = stripCursorParameterizedSuffix(input.acpModelValue);
  const params = cursorModelParametersToObject(input.acpModelValue);
  if (cliOptions.reasoningEffort) {
    const parameterKey = cursorAcpParameterKeyForModel(baseModel, cliOptions);
    params[parameterKey] =
      resolveCursorChoiceParameterValue({
        choices: input.choices,
        baseModel,
        key: parameterKey,
        requestedValue: cliOptions.reasoningEffort,
      }) ?? cursorReasoningParameterValue(cliOptions.reasoningEffort);
  }
  if (cliOptions.contextWindow) {
    params.context = cliOptions.contextWindow;
  }
  if (cliOptions.fastMode !== undefined) {
    params.fast = String(cliOptions.fastMode);
  }
  if (cliOptions.thinking !== undefined) {
    params.thinking = String(cliOptions.thinking);
  }
  return buildCursorParameterizedModelSlug(baseModel, params);
}

function buildCursorParameterizedModelFromOptions(input: {
  readonly acpModelValue: string;
  readonly options: CursorModelOptions | null | undefined;
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
}): string | undefined {
  if (!input.acpModelValue.includes("[")) {
    return undefined;
  }
  if (!input.options || Object.keys(input.options).length === 0) {
    return undefined;
  }

  const baseModel = stripCursorParameterizedSuffix(input.acpModelValue);
  const params = cursorModelParametersToObject(input.acpModelValue);
  if (input.options.reasoningEffort) {
    const parameterKey = cursorAcpParameterKeyForModel(baseModel, input.options);
    params[parameterKey] =
      resolveCursorChoiceParameterValue({
        choices: input.choices,
        baseModel,
        key: parameterKey,
        requestedValue: input.options.reasoningEffort,
      }) ?? cursorReasoningParameterValue(input.options.reasoningEffort);
  }
  if (input.options.contextWindow) {
    params.context = input.options.contextWindow;
  }
  if (input.options.fastMode !== undefined) {
    params.fast = String(input.options.fastMode);
  }
  if (input.options.thinking !== undefined) {
    params.thinking = String(input.options.thinking);
  }
  return buildCursorParameterizedModelSlug(baseModel, params);
}

function normalizeCursorReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function cursorReasoningParameterValue(value: string): string {
  return value === "xhigh" ? "extra-high" : value;
}

function cursorReasoningLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

function cursorContextLabel(
  value: string,
  contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>,
): string {
  return (
    contextWindowOptions.find((option) => option.value === value)?.label ?? value.toUpperCase()
  );
}

function isCursorEffortConfigOption(option: Acp.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findCursorEffortConfigOption(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
): Acp.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isCursorEffortConfigOption(option),
  );
  return (
    candidates.find((option) => option.category === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => option.category === "thought_level") ??
    candidates[0]
  );
}

function isCursorContextConfigOption(option: Acp.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function withCursorVariantName(
  baseName: string,
  effort: string | undefined,
  defaultEffort: string | undefined,
  contextWindow: string | undefined,
  defaultContextWindow: string | undefined,
  contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>,
  fastMode: boolean | undefined,
): string {
  const suffixes: Array<string> = [];
  if (effort && effort !== defaultEffort) {
    suffixes.push(cursorReasoningLabel(effort));
  }
  if (contextWindow && contextWindow !== defaultContextWindow) {
    suffixes.push(cursorContextLabel(contextWindow, contextWindowOptions));
  }
  if (fastMode) {
    suffixes.push("Fast");
  }
  return suffixes.length === 0 ? baseName : `${baseName} ${suffixes.join(" ")}`;
}

function buildCursorAcpModelDescriptor(input: {
  readonly choice: CursorAcpModelChoice;
  readonly slug: string;
  readonly name: string;
  readonly supportedReasoningEfforts: NonNullable<
    ProviderModelDescriptor["supportedReasoningEfforts"]
  >;
  readonly defaultReasoningEffort?: string;
  readonly contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>;
  readonly defaultContextWindow?: string;
}): ProviderModelDescriptor {
  return {
    slug: input.slug,
    name: input.name,
    ...(input.choice.upstreamProviderId
      ? { upstreamProviderId: input.choice.upstreamProviderId }
      : {}),
    ...(input.choice.upstreamProviderName
      ? { upstreamProviderName: input.choice.upstreamProviderName }
      : {}),
    ...(input.supportedReasoningEfforts.length > 0 && input.defaultReasoningEffort
      ? {
          supportedReasoningEfforts: input.supportedReasoningEfforts,
          defaultReasoningEffort: input.defaultReasoningEffort,
        }
      : {}),
    ...(input.contextWindowOptions.length > 0 && input.defaultContextWindow
      ? {
          contextWindowOptions: input.contextWindowOptions.map((option) => ({
            value: option.value,
            label: option.label,
            ...(option.value === input.defaultContextWindow ? { isDefault: true as const } : {}),
          })),
          defaultContextWindow: input.defaultContextWindow,
        }
      : {}),
  };
}

function expandCursorParameterizedModelDescriptors(input: {
  readonly choice: CursorAcpModelChoice;
  readonly supportedReasoningEfforts: NonNullable<
    ProviderModelDescriptor["supportedReasoningEfforts"]
  >;
  readonly defaultReasoningEffort?: string;
  readonly contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>;
  readonly defaultContextWindow?: string;
}): ReadonlyArray<ProviderModelDescriptor> {
  const params = cursorModelParametersToObject(input.choice.slug);
  const reasoningKey =
    params.reasoning !== undefined ? "reasoning" : params.effort !== undefined ? "effort" : null;
  const parameterReasoningEffort = normalizeCursorReasoningValue(
    reasoningKey ? params[reasoningKey] : undefined,
  );
  const parameterContextWindow = params.context;
  const hasFastParameter = params.fast !== undefined;
  const canExpandReasoning = Boolean(reasoningKey && input.supportedReasoningEfforts.length > 0);
  const canExpandContext = Boolean(parameterContextWindow && input.contextWindowOptions.length > 1);
  const canExpandFast = hasFastParameter;

  if (!canExpandReasoning && !canExpandContext && !canExpandFast) {
    return [
      buildCursorAcpModelDescriptor({
        choice: input.choice,
        slug: input.choice.slug,
        name: input.choice.name,
        supportedReasoningEfforts: input.supportedReasoningEfforts,
        ...(parameterReasoningEffort ? { defaultReasoningEffort: parameterReasoningEffort } : {}),
        contextWindowOptions: input.contextWindowOptions,
        ...(parameterContextWindow ? { defaultContextWindow: parameterContextWindow } : {}),
      }),
    ];
  }

  const baseModel = stripCursorParameterizedSuffix(input.choice.slug);
  const reasoningValues = canExpandReasoning
    ? input.supportedReasoningEfforts.map((effort) => effort.value)
    : [parameterReasoningEffort].filter((value): value is string => Boolean(value));
  const contextValues = canExpandContext
    ? input.contextWindowOptions.map((contextWindow) => contextWindow.value)
    : [parameterContextWindow].filter((value): value is string => Boolean(value));
  const fastValues = canExpandFast ? [false, true] : [undefined];
  const variantDefaultEffort = parameterReasoningEffort ?? input.defaultReasoningEffort;
  const variantDefaultContextWindow = parameterContextWindow ?? input.defaultContextWindow;
  const descriptors: Array<ProviderModelDescriptor> = [];
  const seen = new Set<string>();

  for (const effort of reasoningValues.length > 0 ? reasoningValues : [undefined]) {
    for (const contextWindow of contextValues.length > 0 ? contextValues : [undefined]) {
      for (const fastMode of fastValues) {
        const variantParams = { ...params };
        if (reasoningKey && effort) {
          variantParams[reasoningKey] = cursorReasoningParameterValue(effort);
        }
        if (contextWindow) {
          variantParams.context = contextWindow;
        }
        if (fastMode !== undefined) {
          variantParams.fast = String(fastMode);
        }
        const slug = buildCursorParameterizedModelSlug(baseModel, variantParams);
        if (seen.has(slug)) {
          continue;
        }
        seen.add(slug);
        descriptors.push(
          buildCursorAcpModelDescriptor({
            choice: input.choice,
            slug,
            name: withCursorVariantName(
              input.choice.name,
              effort,
              variantDefaultEffort,
              contextWindow,
              variantDefaultContextWindow,
              input.contextWindowOptions,
              fastMode,
            ),
            supportedReasoningEfforts: [],
            contextWindowOptions: [],
          }),
        );
      }
    }
  }

  return descriptors;
}

export function buildCursorAcpModelDescriptors(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
): ReadonlyArray<ProviderModelDescriptor> {
  const choices = flattenCursorAcpModelChoices(configOptions);
  if (choices.length === 0) {
    return [];
  }

  const effortOption = findCursorEffortConfigOption(configOptions);
  const supportedReasoningEfforts =
    effortOption?.type === "select"
      ? flattenSessionConfigSelectOptions(effortOption).flatMap((entry) => {
          const value = normalizeCursorReasoningValue(entry.value);
          if (!value) {
            return [];
          }
          return [
            {
              value,
              label: entry.name || value,
            },
          ];
        })
      : [];
  const defaultReasoningEffort =
    effortOption?.type === "select"
      ? normalizeCursorReasoningValue(effortOption.currentValue)
      : undefined;
  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) => ({
          value: entry.value,
          label: entry.name || entry.value,
          ...(contextOption.currentValue === entry.value ? { isDefault: true as const } : {}),
        }))
      : [];
  const defaultContextWindow = contextWindowOptions.find((option) => option.isDefault)?.value;

  const descriptors = choices.flatMap((choice) =>
    expandCursorParameterizedModelDescriptors({
      choice,
      supportedReasoningEfforts,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      contextWindowOptions,
      ...(defaultContextWindow ? { defaultContextWindow } : {}),
    }),
  );
  const seen = new Set<string>();
  return descriptors.filter((descriptor) => {
    if (seen.has(descriptor.slug)) {
      return false;
    }
    seen.add(descriptor.slug);
    return true;
  });
}

function toConfigValue(
  option: Acp.SessionConfigOption,
  value: string | boolean,
): string | boolean | undefined {
  if (option.type === "boolean") {
    return typeof value === "boolean" ? value : value.toLowerCase() === "true";
  }
  if (option.type !== "select") {
    return undefined;
  }
  const stringValue = String(value).trim();
  if (!stringValue) return undefined;
  const normalized = normalizedText(stringValue);
  const normalizedAliases =
    normalized === "xhigh" || normalized === "extra high"
      ? new Set([normalized, "xhigh", "extra high"])
      : new Set([normalized]);
  for (const entry of option.options) {
    const candidates =
      "value" in entry
        ? [{ value: entry.value, name: entry.name }]
        : entry.options.map((nested) => ({ value: nested.value, name: nested.name }));
    for (const candidate of candidates) {
      if (
        normalizedAliases.has(normalizedText(candidate.value)) ||
        normalizedAliases.has(normalizedText(candidate.name))
      ) {
        return candidate.value;
      }
    }
  }
  return undefined;
}

function cursorChoiceMatchesBase(choice: CursorAcpModelChoice, baseModel: string): boolean {
  const choiceBase = resolveCursorAcpBaseModelId(choice.slug);
  const cliBaseModel = normalizeCursorCliBaseModelId(baseModel);
  return choiceBase === baseModel || choiceBase === cliBaseModel;
}

function cursorParameterValuesMatch(key: string, left: string, right: string): boolean {
  if (key === "reasoning" || key === "effort") {
    return normalizeCursorReasoningValue(left) === normalizeCursorReasoningValue(right);
  }
  return normalizedText(left) === normalizedText(right);
}

function resolveCursorChoiceParameterValue(input: {
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
  readonly baseModel: string;
  readonly key: string;
  readonly requestedValue: string;
}): string | undefined {
  // Match ACP's own parameter spelling so xhigh/extra-high variants remain valid.
  let sawParameterizedChoice = false;
  for (const choice of input.choices) {
    if (!cursorChoiceMatchesBase(choice, input.baseModel)) {
      continue;
    }
    const value = parseCursorModelParameters(choice.slug).get(input.key);
    if (!value) {
      continue;
    }
    sawParameterizedChoice = true;
    if (cursorParameterValuesMatch(input.key, value, input.requestedValue)) {
      return value;
    }
  }
  return sawParameterizedChoice ? undefined : input.requestedValue;
}

function cursorModelOptionValueSupported(input: {
  readonly configOptions: ReadonlyArray<Acp.SessionConfigOption>;
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
  readonly baseModel: string;
  readonly aliases: ReadonlyArray<string>;
  readonly parameterKey: string;
  readonly value: string | boolean;
}): boolean {
  const option = findConfigOption(input.configOptions, input.aliases);
  if (option) {
    return toConfigValue(option, input.value) !== undefined;
  }
  if (typeof input.value === "boolean") {
    if (
      input.value === false &&
      (input.parameterKey === "fast" || input.parameterKey === "thinking")
    ) {
      return true;
    }
    return (
      resolveCursorChoiceParameterValue({
        choices: input.choices,
        baseModel: input.baseModel,
        key: input.parameterKey,
        requestedValue: String(input.value),
      }) !== undefined
    );
  }
  return (
    resolveCursorChoiceParameterValue({
      choices: input.choices,
      baseModel: input.baseModel,
      key: input.parameterKey,
      requestedValue: input.value,
    }) !== undefined
  );
}

function normalizeCursorAcpRuntimeOptions(input: {
  readonly configOptions: ReadonlyArray<Acp.SessionConfigOption>;
  readonly choices: ReadonlyArray<CursorAcpModelChoice>;
  readonly baseModel: string;
  readonly options: CursorModelOptions | null | undefined;
}): CursorModelOptions | undefined {
  // Runtime choices are authoritative; persisted traits can outlive Cursor's model matrix.
  if (!input.options) {
    return undefined;
  }

  const nextOptions: {
    reasoningEffort?: string;
    contextWindow?: string;
    fastMode?: boolean;
    thinking?: boolean;
  } = {};
  if (input.options.reasoningEffort) {
    const parameterKey = cursorAcpParameterKeyForModel(input.baseModel, input.options);
    if (
      cursorModelOptionValueSupported({
        configOptions: input.configOptions,
        choices: input.choices,
        baseModel: input.baseModel,
        aliases: ["effort", "reasoning", "thought level"],
        parameterKey,
        value: input.options.reasoningEffort,
      })
    ) {
      nextOptions.reasoningEffort = input.options.reasoningEffort;
    }
  }
  if (
    input.options.contextWindow &&
    cursorModelOptionValueSupported({
      configOptions: input.configOptions,
      choices: input.choices,
      baseModel: input.baseModel,
      aliases: ["context", "context size", "context window"],
      parameterKey: "context",
      value: input.options.contextWindow,
    })
  ) {
    nextOptions.contextWindow = input.options.contextWindow;
  }
  if (
    input.options.fastMode !== undefined &&
    cursorModelOptionValueSupported({
      configOptions: input.configOptions,
      choices: input.choices,
      baseModel: input.baseModel,
      aliases: ["fast", "fast mode"],
      parameterKey: "fast",
      value: input.options.fastMode,
    })
  ) {
    nextOptions.fastMode = input.options.fastMode;
  }
  if (
    input.options.thinking !== undefined &&
    cursorModelOptionValueSupported({
      configOptions: input.configOptions,
      choices: input.choices,
      baseModel: input.baseModel,
      aliases: ["thinking"],
      parameterKey: "thinking",
      value: input.options.thinking,
    })
  ) {
    nextOptions.thinking = input.options.thinking;
  }

  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

function collectCursorAcpConfigUpdates(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
  options: CursorModelOptions | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!options) return [];
  const updates: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  const pushUpdate = (
    aliases: ReadonlyArray<string>,
    value: string | boolean | undefined,
  ): void => {
    if (value === undefined) return;
    const option = findConfigOption(configOptions, aliases);
    if (!option) return;
    const configValue = toConfigValue(option, value);
    if (configValue === undefined) return;
    updates.push({ configId: option.id, value: configValue });
  };

  pushUpdate(["effort", "reasoning", "thought level"], options.reasoningEffort);
  pushUpdate(["context", "context size", "context window"], options.contextWindow);
  pushUpdate(["fast", "fast mode"], options.fastMode);
  pushUpdate(["thinking"], options.thinking);
  return updates;
}

function cursorModelOptionsFromModelParameters(
  model: string | null | undefined,
): CursorModelOptions | undefined {
  if (!model) {
    return undefined;
  }
  const params = parseCursorModelParameters(model);
  const reasoningEffort = normalizeCursorReasoningValue(
    params.get("reasoning") ?? params.get("effort"),
  );
  const contextWindow = params.get("context")?.trim();
  const fastModeParam = params.get("fast")?.trim().toLowerCase();
  const thinkingParam = params.get("thinking")?.trim().toLowerCase();
  const fastMode = fastModeParam === "true" ? true : fastModeParam === "false" ? false : undefined;
  const thinking = thinkingParam === "true" ? true : thinkingParam === "false" ? false : undefined;
  const options: CursorModelOptions = {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

function mergeCursorModelOptions(
  base: CursorModelOptions | undefined,
  override: CursorModelOptions | null | undefined,
): CursorModelOptions | undefined {
  const merged: CursorModelOptions = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function cursorModelParametersEqualExceptFast(left: string, right: string): boolean {
  const leftParams = cursorModelParametersToObject(left);
  const rightParams = cursorModelParametersToObject(right);
  delete leftParams.fast;
  delete rightParams.fast;
  return JSON.stringify(leftParams) === JSON.stringify(rightParams);
}

function findCursorModelChoiceIgnoringFast(
  choices: ReadonlyArray<CursorAcpModelChoice>,
  model: string,
): string | undefined {
  const requestedParams = parseCursorModelParameters(model);
  if (requestedParams.get("fast") !== "true") {
    return undefined;
  }

  const baseModel = stripCursorParameterizedSuffix(model);
  return choices.find(
    (choice) =>
      stripCursorParameterizedSuffix(choice.slug) === baseModel &&
      parseCursorModelParameters(choice.slug).has("fast") &&
      cursorModelParametersEqualExceptFast(choice.slug, model),
  )?.slug;
}

function cursorModelChoiceSupportsRequestedParameters(choice: string, requested: string): boolean {
  if (stripCursorParameterizedSuffix(choice) !== stripCursorParameterizedSuffix(requested)) {
    return false;
  }

  const choiceParams = parseCursorModelParameters(choice);
  const requestedParams = parseCursorModelParameters(requested);
  for (const [key, requestedValue] of requestedParams) {
    const choiceValue = choiceParams.get(key);
    if (choiceValue === requestedValue) {
      continue;
    }
    if ((key === "fast" || key === "thinking") && requestedValue === "false") {
      continue;
    }
    return false;
  }
  return true;
}

function findCursorModelChoiceWithSupportedParameters(
  choices: ReadonlyArray<CursorAcpModelChoice>,
  model: string,
): string | undefined {
  return choices.find((choice) => cursorModelChoiceSupportsRequestedParameters(choice.slug, model))
    ?.slug;
}

function resolveCursorAutoModelValue(
  choices: ReadonlyArray<CursorAcpModelChoice>,
): string | undefined {
  return (
    choices.find((choice) => choice.slug.trim().toLowerCase() === "auto")?.slug ??
    choices.find((choice) => choice.slug.trim().toLowerCase() === CURSOR_ACP_AUTO_MODEL_ID)?.slug ??
    choices.find((choice) => normalizedText(choice.name) === "auto")?.slug
  );
}

// The session's own selection is the safest degrade target; the agent's default
// ("auto") is the last resort. Both are session-advertised by construction.
function resolveCursorSessionModelValue(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
  choices: ReadonlyArray<CursorAcpModelChoice>,
): string | undefined {
  const modelOption = findCursorModelConfigOption(configOptions);
  const currentValue = modelOption?.type === "select" ? modelOption.currentValue.trim() : undefined;
  if (currentValue && choices.some((choice) => choice.slug === currentValue)) {
    return currentValue;
  }
  return resolveCursorAutoModelValue(choices);
}

type CursorAcpModelSelectionOutcome =
  /** Nothing to apply: no model requested, or the agent picks it ("auto"). */
  | { readonly _tag: "None" }
  | { readonly _tag: "Resolved"; readonly value: string }
  | { readonly _tag: "Fallback"; readonly value: string; readonly requested: string }
  | { readonly _tag: "Unavailable"; readonly requested: string };

function resolveCursorAcpModelSelection(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
  model: string | null | undefined,
  options: CursorModelOptions | null | undefined,
): CursorAcpModelSelectionOutcome {
  const trimmed = model?.trim();
  if (!trimmed) {
    return { _tag: "None" };
  }

  const choices = flattenCursorAcpModelChoices(configOptions);
  if (trimmed === "auto") {
    const autoValue = resolveCursorAutoModelValue(choices);
    return autoValue ? { _tag: "Resolved", value: autoValue } : { _tag: "None" };
  }

  const exactChoice = choices.find((choice) => choice.slug === trimmed);
  if (exactChoice) {
    return { _tag: "Resolved", value: exactChoice.slug };
  }

  const baseModel = resolveCursorAcpBaseModelId(trimmed);
  if (baseModel === "auto") {
    return { _tag: "None" };
  }
  const cliBaseModel = normalizeCursorCliBaseModelId(baseModel);

  const acpModelValue =
    choices.find((choice) => choice.slug === baseModel)?.slug ??
    choices.find((choice) => resolveCursorAcpBaseModelId(choice.slug) === baseModel)?.slug ??
    choices.find((choice) => resolveCursorAcpBaseModelId(choice.slug) === cliBaseModel)?.slug ??
    baseModel;
  const inferredModel =
    buildCursorParameterizedModelFromCliModelId({
      acpModelValue,
      cliModel: trimmed,
      choices,
    }) ?? acpModelValue;
  const resolvedModel =
    buildCursorParameterizedModelFromOptions({
      acpModelValue: inferredModel,
      options,
      choices,
    }) ?? inferredModel;
  if (choices.some((choice) => choice.slug === resolvedModel)) {
    return { _tag: "Resolved", value: resolvedModel };
  }

  const relaxedMatch =
    findCursorModelChoiceIgnoringFast(choices, resolvedModel) ??
    findCursorModelChoiceWithSupportedParameters(choices, resolvedModel);
  if (relaxedMatch) {
    return { _tag: "Resolved", value: relaxedMatch };
  }

  // Parameterized ids ("model[context=1m,effort=high]") are accepted even though
  // only base ids are advertised, so a parameterized value whose base is
  // advertised still passes through. An unadvertised base never does: Cursor
  // rejects it with -32602 and that used to abort the whole session start.
  const resolvedBase = stripCursorParameterizedSuffix(resolvedModel);
  if (choices.some((choice) => stripCursorParameterizedSuffix(choice.slug) === resolvedBase)) {
    return { _tag: "Resolved", value: resolvedModel };
  }

  const fallbackValue = resolveCursorSessionModelValue(configOptions, choices);
  return fallbackValue
    ? { _tag: "Fallback", value: fallbackValue, requested: trimmed }
    : { _tag: "Unavailable", requested: trimmed };
}

function cursorModelLabel(model: string): string {
  return formatModelDisplayName(model) ?? model;
}

function makeCursorUnavailableModelNotice(
  selection: Extract<CursorAcpModelSelectionOutcome, { _tag: "Fallback" | "Unavailable" }>,
): CursorAcpModelSelectionNotice {
  const requested = cursorModelLabel(selection.requested);
  return {
    reason: "model-unavailable",
    requestedModel: selection.requested,
    ...(selection._tag === "Fallback" ? { appliedModel: selection.value } : {}),
    message:
      selection._tag === "Fallback"
        ? `Cursor does not offer ${requested} in this session; continuing with ${cursorModelLabel(selection.value)}.`
        : `Cursor does not offer ${requested} in this session; continuing with the agent's current model.`,
  };
}

function makeCursorRejectedModelNotice(
  requestedModel: string | null | undefined,
  appliedModel: string,
  cause: AcpErrors.AcpError,
): CursorAcpModelSelectionNotice {
  const requested = requestedModel?.trim() || appliedModel;
  return {
    reason: "model-rejected",
    requestedModel: requested,
    message: `Cursor rejected model ${cursorModelLabel(appliedModel)} (${cause.message}); continuing with the agent's current model.`,
    cause,
  };
}

export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly options: CursorModelOptions | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
  /** Model selection must degrade, never abort the session; notices go here. */
  readonly onNotice?: (notice: CursorAcpModelSelectionNotice) => Effect.Effect<void>;
}): Effect.Effect<void, E> {
  const notify = (notice: CursorAcpModelSelectionNotice): Effect.Effect<void> =>
    input.onNotice ? input.onNotice(notice) : Effect.void;
  return Effect.gen(function* () {
    const initialConfigOptions = yield* input.runtime.getConfigOptions;
    const choices = flattenCursorAcpModelChoices(initialConfigOptions);
    const baseModel = resolveCursorAcpBaseModelId(input.model);
    const runtimeSafeOptions = normalizeCursorAcpRuntimeOptions({
      configOptions: initialConfigOptions,
      choices,
      baseModel,
      options: mergeCursorModelOptions(
        cursorModelOptionsFromModelParameters(input.model),
        input.options,
      ),
    });
    const mergedOptions = mergeCursorModelOptions(
      cursorModelOptionsFromCliModelId(input.model),
      runtimeSafeOptions,
    );
    const selection = resolveCursorAcpModelSelection(
      initialConfigOptions,
      input.model,
      mergedOptions,
    );
    if (selection._tag === "Fallback" || selection._tag === "Unavailable") {
      yield* notify(makeCursorUnavailableModelNotice(selection));
    }
    if (selection._tag === "Resolved" || selection._tag === "Fallback") {
      const modelValue = selection.value;
      yield* input.runtime.setModel(modelValue).pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          isCursorModelRejection(cause)
            ? notify(makeCursorRejectedModelNotice(input.model, modelValue, cause))
            : Effect.fail(
                input.mapError({
                  cause,
                  step: "set-model",
                }),
              ),
        ),
      );
    }

    const configUpdates = collectCursorAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      mergedOptions,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}
