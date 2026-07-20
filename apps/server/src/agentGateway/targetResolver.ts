import {
  CLAUDE_CODE_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DROID_REASONING_EFFORT_OPTIONS,
  GROK_REASONING_EFFORT_OPTIONS,
  PI_THINKING_LEVEL_OPTIONS,
  type ModelSelection,
  type ProviderKind,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
  type ServerProviderAuthStatus,
} from "@synara/contracts";
import { Effect } from "effect";

import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";

export type AgentGatewayTargetErrorCode =
  | "provider_unavailable"
  | "model_unavailable"
  | "model_option_unavailable";

export class AgentGatewayTargetError extends Error {
  readonly code: AgentGatewayTargetErrorCode;
  readonly details?: unknown;

  constructor(code: AgentGatewayTargetErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AgentGatewayTargetError";
    this.code = code;
    this.details = details;
  }
}

export interface AgentGatewayProviderCatalog {
  readonly provider: ProviderKind;
  readonly defaultModel: string | null;
  readonly models: ReadonlyArray<ProviderModelDescriptor>;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly authStatus?: ServerProviderAuthStatus;
  readonly source?: string;
  readonly error?: string;
}

export interface AgentGatewayProviderAvailability {
  readonly enabled: boolean;
  /** Undefined means health has not produced a trustworthy snapshot yet. */
  readonly available?: boolean;
  readonly authStatus?: ServerProviderAuthStatus;
  readonly message?: string;
}

export const AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION =
  "Provider-specific target options. Use targetConstruction[provider].optionsByModel[model] when present; otherwise use providerOptions. Preserve each option's exact key and valueType. allowedValues are authoritative unless allowsCustomValue is true.";

export type AgentGatewayTargetOptionValue = string | number | boolean;

export interface AgentGatewayTargetOptionRule {
  readonly key: string;
  readonly valueType: "string" | "number" | "boolean";
  readonly allowedValues: ReadonlyArray<AgentGatewayTargetOptionValue>;
  readonly allowedValuesSource: "provider-contract" | "model-discovery";
  readonly allowsCustomValue?: boolean;
}

export interface AgentGatewayTargetOptionGuidance {
  readonly primaryOptionKey: string;
  readonly alternativeOptionKeys: ReadonlyArray<string>;
  readonly optionSelectionRule: string;
  readonly providerOptions: ReadonlyArray<AgentGatewayTargetOptionRule>;
  readonly optionsByModel: Readonly<Record<string, ReadonlyArray<AgentGatewayTargetOptionRule>>>;
  readonly exampleTarget: {
    readonly provider: ProviderKind;
    readonly model: string;
    readonly options: Readonly<Record<string, AgentGatewayTargetOptionValue>>;
  } | null;
}

type ModelSelectionForProvider<P extends ProviderKind> = Extract<
  ModelSelection,
  { readonly provider: P }
>;

type ProviderTargetOptionKey<P extends ProviderKind> = keyof NonNullable<
  ModelSelectionForProvider<P>["options"]
> &
  string;

type ProviderOptionValidation =
  | { readonly kind: "effort" }
  | {
      readonly kind: "boolean-capability";
      readonly capability: "supportsFastMode" | "supportsThinkingToggle";
    }
  | { readonly kind: "context-window" }
  | { readonly kind: "non-empty-string" };

interface ProviderTargetOptionRuleSpec extends Omit<AgentGatewayTargetOptionRule, "key"> {
  readonly advertised: boolean;
  readonly validation: ProviderOptionValidation;
}

interface ResolvedProviderTargetOptionRuleSpec extends ProviderTargetOptionRuleSpec {
  readonly key: string;
}

type ProviderTargetOptionRuleRegistry<P extends ProviderKind> = {
  readonly [Key in ProviderTargetOptionKey<P>]: ProviderTargetOptionRuleSpec;
};

interface ProviderTargetOptionConfigInput<P extends ProviderKind> {
  readonly primaryOptionKey: ProviderTargetOptionKey<P>;
  readonly options: ProviderTargetOptionRuleRegistry<P>;
}

interface ProviderTargetOptionConfig {
  readonly primaryOptionKey: string;
  readonly options: Readonly<Record<string, ProviderTargetOptionRuleSpec>>;
}

function defineProviderOptionConfig<P extends ProviderKind>(
  config: ProviderTargetOptionConfigInput<P>,
): ProviderTargetOptionConfig {
  return config;
}

function providerOptionRule(
  valueType: AgentGatewayTargetOptionRule["valueType"],
  allowedValues: ReadonlyArray<AgentGatewayTargetOptionValue>,
  allowedValuesSource: AgentGatewayTargetOptionRule["allowedValuesSource"] = "provider-contract",
  options?: {
    readonly advertised?: boolean;
    readonly validation?: ProviderOptionValidation;
    readonly allowsCustomValue?: boolean;
  },
): ProviderTargetOptionRuleSpec {
  return {
    valueType,
    allowedValues,
    allowedValuesSource,
    advertised: options?.advertised ?? true,
    validation: options?.validation ?? { kind: "effort" },
    allowsCustomValue: options?.allowsCustomValue ?? false,
  };
}

const PROVIDER_TARGET_OPTION_RULES = {
  codex: defineProviderOptionConfig<"codex">({
    primaryOptionKey: "reasoningEffort",
    options: {
      reasoningEffort: providerOptionRule("string", CODEX_REASONING_EFFORT_OPTIONS),
      fastMode: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsFastMode" },
      }),
    },
  }),
  cursor: defineProviderOptionConfig<"cursor">({
    primaryOptionKey: "reasoningEffort",
    options: {
      reasoningEffort: providerOptionRule("string", CODEX_REASONING_EFFORT_OPTIONS),
      fastMode: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsFastMode" },
      }),
      thinking: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsThinkingToggle" },
      }),
      contextWindow: providerOptionRule("string", [], "model-discovery", {
        advertised: false,
        validation: { kind: "context-window" },
      }),
    },
  }),
  grok: defineProviderOptionConfig<"grok">({
    primaryOptionKey: "reasoningEffort",
    options: {
      reasoningEffort: providerOptionRule("string", GROK_REASONING_EFFORT_OPTIONS),
    },
  }),
  droid: defineProviderOptionConfig<"droid">({
    primaryOptionKey: "reasoningEffort",
    options: {
      reasoningEffort: providerOptionRule("string", DROID_REASONING_EFFORT_OPTIONS),
    },
  }),
  claudeAgent: defineProviderOptionConfig<"claudeAgent">({
    primaryOptionKey: "effort",
    options: {
      effort: providerOptionRule("string", CLAUDE_CODE_EFFORT_OPTIONS),
      fastMode: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsFastMode" },
      }),
      thinking: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsThinkingToggle" },
      }),
      autoCompactWindow: providerOptionRule("string", [], "model-discovery", {
        advertised: false,
        validation: { kind: "context-window" },
      }),
      contextWindow: providerOptionRule("string", [], "model-discovery", {
        advertised: false,
        validation: { kind: "context-window" },
      }),
    },
  }),
  pi: defineProviderOptionConfig<"pi">({
    primaryOptionKey: "thinkingLevel",
    options: { thinkingLevel: providerOptionRule("string", PI_THINKING_LEVEL_OPTIONS) },
  }),
  antigravity: defineProviderOptionConfig<"antigravity">({
    primaryOptionKey: "reasoningEffort",
    options: { reasoningEffort: providerOptionRule("string", [], "model-discovery") },
  }),
  kilo: defineProviderOptionConfig<"kilo">({
    primaryOptionKey: "variant",
    options: {
      variant: providerOptionRule("string", [], "model-discovery"),
      agent: providerOptionRule("string", [], "model-discovery", {
        validation: { kind: "non-empty-string" },
        allowsCustomValue: true,
      }),
    },
  }),
  opencode: defineProviderOptionConfig<"opencode">({
    primaryOptionKey: "variant",
    options: {
      variant: providerOptionRule("string", [], "model-discovery"),
      agent: providerOptionRule("string", [], "model-discovery", {
        validation: { kind: "non-empty-string" },
        allowsCustomValue: true,
      }),
    },
  }),
  devin: defineProviderOptionConfig<"devin">({
    primaryOptionKey: "variant",
    options: {
      variant: providerOptionRule("string", [], "model-discovery", {
        validation: { kind: "non-empty-string" },
        allowsCustomValue: true,
      }),
      fastMode: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsFastMode" },
      }),
      thinking: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsThinkingToggle" },
      }),
      contextWindow: providerOptionRule("string", [], "model-discovery", {
        advertised: false,
        validation: { kind: "context-window" },
      }),
      reasoningEffort: providerOptionRule("string", [], "model-discovery"),
    },
  }),
} as const satisfies Record<ProviderKind, ProviderTargetOptionConfig>;

function providerDefaultModel(provider: ProviderKind): string | null {
  return provider === "pi" ? null : DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function loadAgentGatewayProviderCatalog(input: {
  readonly provider: ProviderKind;
  readonly discovery: ProviderDiscoveryServiceShape;
  readonly availability?: AgentGatewayProviderAvailability;
  readonly cwd?: string;
}): Effect.Effect<AgentGatewayProviderCatalog> {
  const defaultModel = providerDefaultModel(input.provider);
  const availability = input.availability ?? { enabled: true };
  const unavailableReason =
    availability.enabled === false
      ? `Provider "${input.provider}" is disabled in Synara settings.`
      : availability.available === false
        ? (availability.message ?? `Provider "${input.provider}" is not available.`)
        : availability.authStatus === "unauthenticated"
          ? (availability.message ?? `Provider "${input.provider}" is not authenticated.`)
          : null;
  if (unavailableReason !== null) {
    return Effect.succeed({
      provider: input.provider,
      defaultModel,
      models: [],
      enabled: availability.enabled,
      available: false,
      ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
      error: unavailableReason,
    });
  }
  return input.discovery
    .listModels({ provider: input.provider, ...(input.cwd ? { cwd: input.cwd } : {}) })
    .pipe(
      Effect.map((result: ProviderListModelsResult) => ({
        provider: input.provider,
        defaultModel,
        models: result.models,
        enabled: true,
        available: result.models.length > 0 || defaultModel !== null,
        ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
        ...(result.source ? { source: result.source } : {}),
      })),
      Effect.catch((error) =>
        Effect.succeed({
          provider: input.provider,
          defaultModel,
          models: [],
          enabled: true,
          available: defaultModel !== null,
          ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
}

function providerTargetOptionRules(
  provider: ProviderKind,
): ReadonlyArray<AgentGatewayTargetOptionRule> {
  return Object.entries(PROVIDER_TARGET_OPTION_RULES[provider].options)
    .filter(([, option]) => option.advertised)
    .map(([key, { valueType, allowedValues, allowedValuesSource, allowsCustomValue }]) => ({
      key,
      valueType,
      allowedValues,
      allowedValuesSource,
      ...(allowsCustomValue ? { allowsCustomValue: true } : {}),
    }));
}

function providerPrimaryOptionKey(provider: ProviderKind): string {
  return PROVIDER_TARGET_OPTION_RULES[provider].primaryOptionKey;
}

function convertDiscoveredOptionValue(
  value: string,
  valueType: AgentGatewayTargetOptionRule["valueType"],
): AgentGatewayTargetOptionValue | null {
  if (valueType === "string") return value;
  if (valueType === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function modelTargetOptionRules(
  provider: ProviderKind,
  model: ProviderModelDescriptor,
): ReadonlyArray<AgentGatewayTargetOptionRule> {
  const rules = providerTargetOptionRules(provider).map(
    ({ key, valueType, allowedValues, allowedValuesSource, allowsCustomValue }) => ({
      key,
      valueType,
      allowedValues,
      allowedValuesSource,
      ...(allowsCustomValue === undefined ? {} : { allowsCustomValue }),
    }),
  );
  const replaceAllowedValues = (
    key: string,
    values: ReadonlyArray<AgentGatewayTargetOptionValue>,
    allowEmpty = false,
  ) => {
    if (values.length === 0 && !allowEmpty) return;
    const index = rules.findIndex((rule) => rule.key === key);
    if (index < 0) return;
    rules[index] = {
      ...rules[index]!,
      allowedValues: values,
      allowedValuesSource: "model-discovery",
      ...(rules[index]!.allowsCustomValue === true ? { allowsCustomValue: false } : {}),
    };
  };

  const discoveredEfforts = model.supportedReasoningEfforts?.map((entry) => entry.value) ?? [];
  replaceAllowedValues(providerPrimaryOptionKey(provider), discoveredEfforts);

  for (const descriptor of model.optionDescriptors ?? []) {
    const rule = rules.find((candidate) => candidate.key === descriptor.id);
    if (!rule) continue;
    if (descriptor.type === "select") {
      replaceAllowedValues(
        descriptor.id,
        descriptor.options
          .map((option) => convertDiscoveredOptionValue(option.id, rule.valueType))
          .filter((value): value is AgentGatewayTargetOptionValue => value !== null),
        true,
      );
    } else if (descriptor.type === "boolean") {
      replaceAllowedValues(descriptor.id, [true, false]);
    }
  }
  return rules;
}

function preferredExampleOptionValue(
  rule: AgentGatewayTargetOptionRule,
): AgentGatewayTargetOptionValue | null {
  const preferences: ReadonlyArray<AgentGatewayTargetOptionValue> =
    rule.key === "reasoningEffort"
      ? ["medium", "low"]
      : rule.key === "thinkingLevel"
        ? ["LOW", "low"]
        : ["low"];
  return (
    preferences.find((value) => rule.allowedValues.includes(value)) ?? rule.allowedValues[0] ?? null
  );
}

function exampleOptionsForRules(
  primaryOptionKey: string,
  rules: ReadonlyArray<AgentGatewayTargetOptionRule>,
): Readonly<Record<string, AgentGatewayTargetOptionValue>> {
  const primaryRule = rules.find((rule) => rule.key === primaryOptionKey);
  const exampleRule =
    primaryRule && primaryRule.allowedValues.length > 0
      ? primaryRule
      : rules.find((rule) => rule.allowedValues.length > 0);
  if (!exampleRule) return {};
  const value = preferredExampleOptionValue(exampleRule);
  return value === null ? {} : { [exampleRule.key]: value };
}

/** Compact, typed construction guidance returned before the full model catalog. */
export function agentGatewayTargetOptionGuidance(
  catalog: AgentGatewayProviderCatalog,
): AgentGatewayTargetOptionGuidance {
  const primaryOptionKey = providerPrimaryOptionKey(catalog.provider);
  const providerOptions = providerTargetOptionRules(catalog.provider);
  const optionsByModel = Object.fromEntries(
    catalog.models.map((model) => [model.slug, modelTargetOptionRules(catalog.provider, model)]),
  );
  const exampleModel = catalog.models[0]?.slug ?? catalog.defaultModel;
  const exampleRules = exampleModel
    ? (optionsByModel[exampleModel] ?? providerOptions)
    : providerOptions;
  return {
    primaryOptionKey,
    alternativeOptionKeys: providerOptions
      .map((rule) => rule.key)
      .filter((key) => key !== primaryOptionKey),
    optionSelectionRule:
      "Use optionsByModel[model] when present. Its keys and valueType are authoritative. Choose from allowedValues unless allowsCustomValue is true; otherwise use providerOptions.",
    providerOptions,
    optionsByModel,
    exampleTarget:
      catalog.available && exampleModel
        ? {
            provider: catalog.provider,
            model: exampleModel,
            options: exampleOptionsForRules(primaryOptionKey, exampleRules),
          }
        : null,
  };
}

function failUnavailableOption(
  target: ModelSelection,
  option: string,
  available?: ReadonlyArray<string>,
): never {
  throw new AgentGatewayTargetError(
    "model_option_unavailable",
    `Option "${option}" is not available for ${target.provider}/${target.model}.${
      available && available.length > 0 ? ` Available values: ${available.join(", ")}.` : ""
    }`,
    { provider: target.provider, model: target.model, option, available: available ?? [] },
  );
}

const DISCOVERED_EFFORT_OPTION_IDS = new Set([
  "reasoningEffort",
  "effort",
  "thinkingLevel",
  "thinkingBudget",
  "variant",
]);

function providerOptionRuleSpec(
  provider: ProviderKind,
  optionId: string,
): ResolvedProviderTargetOptionRuleSpec | undefined {
  const rule = PROVIDER_TARGET_OPTION_RULES[provider].options[optionId];
  return rule ? { key: optionId, ...rule } : undefined;
}

function normalizedEffortValue(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return undefined;
}

function validateOptionsWithoutCatalog(target: ModelSelection): void {
  const rawOptions = target.options as Record<string, unknown> | undefined;
  for (const [optionId, value] of Object.entries(rawOptions ?? {})) {
    if (value === undefined) continue;
    const rule = providerOptionRuleSpec(target.provider, optionId);
    if (!rule) failUnavailableOption(target, optionId);
    switch (rule.validation.kind) {
      case "effort": {
        const effort = normalizedEffortValue(value);
        const available = rule.allowedValues.map(String);
        if (effort === undefined || !available.includes(effort)) {
          failUnavailableOption(target, effort ?? optionId, available);
        }
        break;
      }
      case "boolean-capability":
        if (typeof value !== "boolean" || value === true) {
          failUnavailableOption(target, optionId);
        }
        break;
      case "context-window":
        failUnavailableOption(target, optionId);
      case "non-empty-string":
        if (typeof value !== "string" || value.trim().length === 0) {
          failUnavailableOption(target, optionId);
        }
        break;
    }
  }
}

function validateDiscoveredDescriptorOption(
  target: ModelSelection,
  descriptor: ProviderModelDescriptor,
  optionId: string,
  value: unknown,
): void {
  const advertised = descriptor.optionDescriptors?.find((option) => option.id === optionId);
  if (advertised?.type === "select") {
    const available = advertised.options.map((entry) => entry.id);
    if (available.includes(String(value))) return;
    failUnavailableOption(target, String(value), available);
  }
  if (advertised?.type === "boolean" && typeof value === "boolean") return;
  failUnavailableOption(target, optionId);
}

function validateEffortOption(
  target: ModelSelection,
  descriptor: ProviderModelDescriptor,
  rule: ResolvedProviderTargetOptionRuleSpec,
  value: unknown,
): void {
  const effort = normalizedEffortValue(value);
  if (effort === undefined) failUnavailableOption(target, rule.key);

  const advertisedEfforts = descriptor.supportedReasoningEfforts?.map((entry) => entry.value);
  if (advertisedEfforts && advertisedEfforts.length > 0 && !advertisedEfforts.includes(effort)) {
    failUnavailableOption(target, effort, advertisedEfforts);
  }

  const effortDescriptors = (descriptor.optionDescriptors ?? []).filter(
    (option) => option.type === "select" && DISCOVERED_EFFORT_OPTION_IDS.has(option.id),
  );
  for (const option of effortDescriptors) {
    if (option.type !== "select") continue;
    const available = option.options.map((entry) => entry.id);
    if (!available.includes(effort)) {
      failUnavailableOption(target, effort, available);
    }
  }

  if ((advertisedEfforts?.length ?? 0) === 0 && effortDescriptors.length === 0) {
    const available = rule.allowedValues.map(String);
    if (!available.includes(effort)) failUnavailableOption(target, effort, available);
  }
}

function validateKnownProviderOption(
  target: ModelSelection,
  descriptor: ProviderModelDescriptor,
  rule: ResolvedProviderTargetOptionRuleSpec,
  value: unknown,
): void {
  switch (rule.validation.kind) {
    case "effort":
      validateEffortOption(target, descriptor, rule, value);
      return;
    case "boolean-capability":
      if (typeof value !== "boolean") failUnavailableOption(target, rule.key);
      if (value === true && descriptor[rule.validation.capability] !== true) {
        failUnavailableOption(target, rule.key);
      }
      return;
    case "context-window": {
      const available = descriptor.contextWindowOptions?.map((entry) => entry.value) ?? [];
      if (available.includes(String(value))) return;
      validateDiscoveredDescriptorOption(target, descriptor, rule.key, value);
      return;
    }
    case "non-empty-string": {
      if (typeof value !== "string" || value.trim().length === 0) {
        failUnavailableOption(target, rule.key);
      }
      if (descriptor.optionDescriptors?.some((option) => option.id === rule.key)) {
        validateDiscoveredDescriptorOption(target, descriptor, rule.key, value);
      }
      return;
    }
  }
}

function validateAdvertisedOption(
  target: ModelSelection,
  descriptor: ProviderModelDescriptor,
): void {
  const rawOptions = target.options as Record<string, unknown> | undefined;
  for (const [optionId, value] of Object.entries(rawOptions ?? {})) {
    if (value === undefined) continue;
    const rule = providerOptionRuleSpec(target.provider, optionId);
    if (rule) {
      validateKnownProviderOption(target, descriptor, rule, value);
    } else {
      validateDiscoveredDescriptorOption(target, descriptor, optionId, value);
    }
  }
}

/** Resolve an exact advertised target before any git/orchestration side effect. */
export function resolveAgentGatewayTarget(input: {
  readonly target: ModelSelection;
  readonly discovery: ProviderDiscoveryServiceShape;
  readonly availability?: AgentGatewayProviderAvailability;
  readonly cwd?: string;
}): Effect.Effect<ModelSelection, AgentGatewayTargetError> {
  return Effect.gen(function* () {
    const catalog = yield* loadAgentGatewayProviderCatalog({
      provider: input.target.provider,
      discovery: input.discovery,
      ...(input.availability ? { availability: input.availability } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    if (!catalog.available) {
      return yield* Effect.fail(
        new AgentGatewayTargetError(
          "provider_unavailable",
          catalog.error ?? `Provider "${input.target.provider}" is unavailable.`,
          {
            provider: input.target.provider,
            enabled: catalog.enabled,
            authStatus: catalog.authStatus,
          },
        ),
      );
    }
    const descriptor = catalog.models.find((model) => model.slug === input.target.model);

    if (catalog.models.length > 0 && descriptor === undefined) {
      return yield* Effect.fail(
        new AgentGatewayTargetError(
          "model_unavailable",
          `Model "${input.target.model}" is not available for ${input.target.provider}. Use an exact slug from synara_capabilities.`,
          {
            provider: input.target.provider,
            requestedModel: input.target.model,
            availableModels: catalog.models.map((model) => model.slug),
          },
        ),
      );
    }

    if (catalog.models.length === 0) {
      if (catalog.defaultModel === null) {
        return yield* Effect.fail(
          new AgentGatewayTargetError(
            "provider_unavailable",
            `Provider "${input.target.provider}" has no available model catalog or configured default.`,
            { provider: input.target.provider, discoveryError: catalog.error },
          ),
        );
      }
      if (input.target.model !== catalog.defaultModel) {
        return yield* Effect.fail(
          new AgentGatewayTargetError(
            "model_unavailable",
            `The ${input.target.provider} model catalog is unavailable. Only its configured default "${catalog.defaultModel}" can be used safely; custom model "${input.target.model}" was not verified.`,
            { provider: input.target.provider, requestedModel: input.target.model },
          ),
        );
      }
      try {
        validateOptionsWithoutCatalog(input.target);
      } catch (error) {
        if (error instanceof AgentGatewayTargetError) return yield* Effect.fail(error);
        throw error;
      }
      return input.target;
    }

    try {
      validateAdvertisedOption(input.target, descriptor!);
    } catch (error) {
      if (error instanceof AgentGatewayTargetError) return yield* Effect.fail(error);
      throw error;
    }
    return input.target;
  });
}
