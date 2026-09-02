// FILE: OpenCodeDiscovery.ts
// Purpose: Pure normalization for OpenCode-compatible model, agent, and command discovery.
// Layer: Server provider domain
// Exports: Discovery inventory inputs and canonical provider discovery projections.

import type {
  ProviderListAgentsResult,
  ProviderListCommandsResult,
  ProviderListModelsResult,
} from "@synara/contracts";
import type { Agent, OpencodeClient } from "@opencode-ai/sdk/v2";

import { type OpenCodeCliModelDescriptor, type OpenCodeRuntimeError } from "./opencodeRuntime.ts";
import { positiveInteger } from "./tokenUsage.ts";

export interface OpenCodeModelInventory {
  readonly providerList: {
    readonly connected: ReadonlyArray<string>;
    readonly all: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly source?: string;
      readonly env?: ReadonlyArray<string>;
      readonly options?: Record<string, unknown>;
      readonly models: Record<
        string,
        {
          readonly id: string;
          readonly name: string;
          readonly options?: Record<string, unknown>;
          readonly capabilities?: {
            readonly reasoning?: boolean;
          };
          readonly limit?: {
            readonly context?: number;
            readonly output?: number;
          };
          readonly variants?: Record<string, Record<string, unknown>>;
        }
      >;
    }>;
  };
  readonly consoleState?: {
    readonly consoleManagedProviders: ReadonlyArray<string>;
  } | null;
}

type OpenCodeInventoryProvider = OpenCodeModelInventory["providerList"]["all"][number];
type OpenCodeModelDescriptor = ProviderListModelsResult["models"][number];

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatOpenCodeIdentifier(value: string): string {
  return value
    .trim()
    .split(/[-_/]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function isOpenCodeManagedProvider(provider: OpenCodeInventoryProvider) {
  const normalizedId = provider.id.trim().toLowerCase();
  const normalizedName = provider.name.trim().toLowerCase();
  const envVars = new Set((provider.env ?? []).map((value) => value.trim().toUpperCase()));

  return (
    envVars.has("OPENCODE_API_KEY") ||
    normalizedId === "opencode" ||
    normalizedId.startsWith("opencode-") ||
    normalizedName.startsWith("opencode")
  );
}

// Custom providers declared in opencode.jsonc carry their credential inline
// (`options.apiKey`) instead of through auth.json, so they never appear in
// credentialProviderIDs even though `connected` already proves they are usable.
function hasInlineConfiguredApiKey(provider: OpenCodeInventoryProvider): boolean {
  return (
    trimNonEmptyString(provider.options?.apiKey) !== undefined ||
    trimNonEmptyString(provider.options?.api_key) !== undefined
  );
}

export function resolvePreferredOpenCodeModelProviders(input: {
  readonly inventory: OpenCodeModelInventory;
  readonly credentialProviderIDs?: ReadonlyArray<string>;
}) {
  const { inventory } = input;
  const connected = new Set(inventory.providerList.connected);
  const connectedProviders = inventory.providerList.all.filter((provider) =>
    connected.has(provider.id),
  );
  if (connectedProviders.length === 0) {
    return [];
  }

  const credentialProviders = new Set(input.credentialProviderIDs ?? []);
  const authenticatedConnectedProviders = connectedProviders.filter(
    (provider) => credentialProviders.has(provider.id) || hasInlineConfiguredApiKey(provider),
  );

  const consoleManagedProviders = new Set(inventory.consoleState?.consoleManagedProviders ?? []);
  const consoleManagedConnectedProviders = connectedProviders.filter((provider) =>
    consoleManagedProviders.has(provider.id),
  );

  const openCodeManagedConnectedProviders = connectedProviders.filter(isOpenCodeManagedProvider);
  const preferredProviderIDs = new Set(
    [
      ...authenticatedConnectedProviders,
      ...consoleManagedConnectedProviders,
      ...openCodeManagedConnectedProviders,
    ].map((provider) => provider.id),
  );
  if (preferredProviderIDs.size > 0) {
    return connectedProviders.filter((provider) => preferredProviderIDs.has(provider.id));
  }

  const nonEnvironmentConnectedProviders = connectedProviders.filter(
    (provider) => provider.source !== "env",
  );
  return nonEnvironmentConnectedProviders.length > 0
    ? nonEnvironmentConnectedProviders
    : connectedProviders;
}

function compareOpenCodeModelDescriptors(
  left: OpenCodeModelDescriptor,
  right: OpenCodeModelDescriptor,
) {
  const leftProvider =
    left.upstreamProviderName?.trim() || left.upstreamProviderId?.trim() || "\uffff";
  const rightProvider =
    right.upstreamProviderName?.trim() || right.upstreamProviderId?.trim() || "\uffff";
  return (
    leftProvider.localeCompare(rightProvider) ||
    left.name.localeCompare(right.name) ||
    left.slug.localeCompare(right.slug)
  );
}

function readOpenCodeInventoryVariantValue(
  variantKey: string,
  variant: Record<string, unknown>,
): string | undefined {
  const directValue =
    trimNonEmptyString(variant.reasoningEffort) ??
    trimNonEmptyString(variant.reasoning_effort) ??
    trimNonEmptyString(variant.effort);
  if (directValue) {
    return directValue;
  }

  const thinkingConfig =
    variant.thinkingConfig &&
    typeof variant.thinkingConfig === "object" &&
    !Array.isArray(variant.thinkingConfig)
      ? (variant.thinkingConfig as Record<string, unknown>)
      : variant.thinking_config &&
          typeof variant.thinking_config === "object" &&
          !Array.isArray(variant.thinking_config)
        ? (variant.thinking_config as Record<string, unknown>)
        : null;
  const thinkingLevel =
    trimNonEmptyString(thinkingConfig?.thinkingLevel) ??
    trimNonEmptyString(thinkingConfig?.thinking_level);
  if (thinkingLevel) {
    return thinkingLevel;
  }

  const reasoning =
    variant.reasoning && typeof variant.reasoning === "object" && !Array.isArray(variant.reasoning)
      ? (variant.reasoning as Record<string, unknown>)
      : null;
  const reasoningConfig =
    variant.reasoningConfig &&
    typeof variant.reasoningConfig === "object" &&
    !Array.isArray(variant.reasoningConfig)
      ? (variant.reasoningConfig as Record<string, unknown>)
      : variant.reasoning_config &&
          typeof variant.reasoning_config === "object" &&
          !Array.isArray(variant.reasoning_config)
        ? (variant.reasoning_config as Record<string, unknown>)
        : null;
  const nestedReasoningEffort =
    trimNonEmptyString(reasoning?.effort) ??
    trimNonEmptyString(reasoningConfig?.maxReasoningEffort) ??
    trimNonEmptyString(reasoningConfig?.max_reasoning_effort);
  if (nestedReasoningEffort) {
    return nestedReasoningEffort;
  }

  if (
    "thinking" in variant ||
    "thinkingConfig" in variant ||
    "thinking_config" in variant ||
    "reasoning" in variant ||
    "reasoningConfig" in variant ||
    "reasoning_config" in variant ||
    Object.keys(variant).length === 0
  ) {
    return trimNonEmptyString(variantKey);
  }
  return undefined;
}

function normalizeOpenCodeReasoningDescriptors(input: {
  readonly descriptors: ReadonlyArray<{
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
  }>;
  readonly defaultReasoningEffort?: string | undefined;
}) {
  const descriptors = Array.from(
    new Map(
      input.descriptors
        .map((descriptor) => {
          const value = descriptor.value.trim();
          if (value.length === 0) {
            return null;
          }

          const label = trimNonEmptyString(descriptor.label);
          const description = trimNonEmptyString(descriptor.description);
          return [
            value,
            {
              value,
              ...(label ? { label } : {}),
              ...(description ? { description } : {}),
            },
          ] as const;
        })
        .filter((descriptor) => descriptor !== null),
    ).values(),
  );
  const defaultReasoningEffort = trimNonEmptyString(input.defaultReasoningEffort);

  return {
    descriptors,
    defaultReasoningEffort:
      defaultReasoningEffort &&
      descriptors.some((descriptor) => descriptor.value === defaultReasoningEffort)
        ? defaultReasoningEffort
        : undefined,
  };
}

function inferOpenCodeDefaultReasoningEffort(
  providerId: string,
  descriptors: ReadonlyArray<{ readonly value: string }>,
): string | undefined {
  const values = descriptors.map((descriptor) => descriptor.value);
  if (values.length === 1) {
    return values[0];
  }

  const normalizedProviderId = providerId.trim().toLowerCase();
  if (normalizedProviderId === "anthropic" || normalizedProviderId.startsWith("google")) {
    return values.includes("high") ? "high" : undefined;
  }
  if (normalizedProviderId === "openai" || normalizedProviderId === "opencode") {
    return values.includes("medium") ? "medium" : values.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function resolveOpenCodeModelReasoningSupport(
  model: OpenCodeInventoryProvider["models"][string] | undefined,
) {
  if (!model) {
    return {
      descriptors: [] as Array<{
        readonly value: string;
        readonly label?: string;
        readonly description?: string;
      }>,
      defaultReasoningEffort: undefined as string | undefined,
    };
  }

  const descriptors = Object.entries(model.variants ?? {}).flatMap(([variantKey, variant]) => {
    const value = readOpenCodeInventoryVariantValue(variantKey, variant);
    if (!value) {
      return [];
    }

    const label = trimNonEmptyString(variant.label);
    const description = trimNonEmptyString(variant.description);
    return [
      {
        value,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
      },
    ];
  });
  if (descriptors.length > 0) {
    return normalizeOpenCodeReasoningDescriptors({
      descriptors,
      defaultReasoningEffort:
        trimNonEmptyString(model.options?.reasoningEffort) ??
        trimNonEmptyString(model.options?.reasoning_effort) ??
        trimNonEmptyString(model.options?.effort),
    });
  }

  return {
    descriptors: [] as Array<{
      readonly value: string;
      readonly label?: string;
      readonly description?: string;
    }>,
    defaultReasoningEffort: undefined as string | undefined,
  };
}

function numberToContextWindowValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}m`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}k`;
  return String(value);
}

function resolveOpenCodeContextWindowSupport(
  model: OpenCodeInventoryProvider["models"][string] | undefined,
): {
  readonly contextWindowOptions: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly isDefault?: true;
  }>;
  readonly defaultContextWindow: string | undefined;
} {
  const context = numberToContextWindowValue(model?.limit?.context);
  if (!context) {
    return { contextWindowOptions: [], defaultContextWindow: undefined };
  }
  return {
    contextWindowOptions: [{ value: context, label: context.toUpperCase(), isDefault: true }],
    defaultContextWindow: context,
  };
}

function toOpenCodeModelDescriptor(input: {
  readonly slug: string;
  readonly name: string;
  readonly provider: Pick<OpenCodeInventoryProvider, "id" | "name">;
  readonly model?: OpenCodeInventoryProvider["models"][string];
  readonly cliModel?: Pick<
    OpenCodeCliModelDescriptor,
    | "supportedReasoningEfforts"
    | "defaultReasoningEffort"
    | "contextWindowOptions"
    | "defaultContextWindow"
  >;
}): OpenCodeModelDescriptor | null {
  const name = input.name.trim();
  if (name.length === 0) {
    return null;
  }

  const upstreamProviderName = input.provider.name.trim();
  const contextSupport =
    input.cliModel?.contextWindowOptions && input.cliModel.contextWindowOptions.length > 0
      ? {
          contextWindowOptions: input.cliModel.contextWindowOptions,
          defaultContextWindow: input.cliModel.defaultContextWindow,
        }
      : resolveOpenCodeContextWindowSupport(input.model);
  const reasoningSupport =
    input.cliModel && input.cliModel.supportedReasoningEfforts.length > 0
      ? {
          descriptors: input.cliModel.supportedReasoningEfforts,
          defaultReasoningEffort:
            input.cliModel.defaultReasoningEffort ??
            inferOpenCodeDefaultReasoningEffort(
              input.provider.id,
              input.cliModel.supportedReasoningEfforts,
            ),
        }
      : (() => {
          const resolved = resolveOpenCodeModelReasoningSupport(input.model);
          return {
            descriptors: resolved.descriptors,
            defaultReasoningEffort:
              resolved.defaultReasoningEffort ??
              inferOpenCodeDefaultReasoningEffort(input.provider.id, resolved.descriptors),
          };
        })();
  return {
    slug: input.slug,
    name,
    upstreamProviderId: input.provider.id,
    ...(upstreamProviderName.length > 0 ? { upstreamProviderName } : {}),
    ...(reasoningSupport.descriptors.length > 0
      ? { supportedReasoningEfforts: reasoningSupport.descriptors }
      : {}),
    ...(reasoningSupport.defaultReasoningEffort
      ? { defaultReasoningEffort: reasoningSupport.defaultReasoningEffort }
      : {}),
    ...(contextSupport.contextWindowOptions.length > 0
      ? {
          contextWindowOptions: contextSupport.contextWindowOptions,
          ...(contextSupport.defaultContextWindow
            ? { defaultContextWindow: contextSupport.defaultContextWindow }
            : {}),
        }
      : {}),
  };
}

function formatOpenCodeCliProviderName(providerId: string): string {
  const normalizedProviderId = providerId.trim();
  const knownNames: Record<string, string> = {
    "302-ai": "302.AI",
    "amazon-bedrock": "Amazon Bedrock",
    anthropic: "Anthropic",
    "atomic-chat": "Atomic Chat",
    "azure-openai": "Azure OpenAI",
    "azure-cognitive-services": "Azure Cognitive Services",
    baseten: "Baseten",
    cerebras: "Cerebras",
    "cloudflare-ai-gateway": "Cloudflare AI Gateway",
    "cloudflare-workers-ai": "Cloudflare Workers AI",
    cortecs: "Cortecs",
    deepinfra: "Deep Infra",
    deepseek: "DeepSeek",
    fireworks: "Fireworks AI",
    "fireworks-ai": "Fireworks AI",
    frogbot: "FrogBot",
    "github-copilot": "GitHub Copilot",
    "gitlab-duo": "GitLab Duo",
    "google-vertex": "Google Vertex AI",
    "google-vertex-ai": "Google Vertex AI",
    groq: "Groq",
    "hugging-face": "Hugging Face",
    huggingface: "Hugging Face",
    "io-net": "IO.NET",
    "kimi-for-coding": "Kimi For Coding",
    "llama.cpp": "llama.cpp",
    lmstudio: "LM Studio",
    minimax: "MiniMax",
    "moonshot-ai": "Moonshot AI",
    "nebius-token-factory": "Nebius Token Factory",
    nvidia: "NVIDIA",
    ollama: "Ollama",
    "ollama-cloud": "Ollama Cloud",
    openai: "OpenAI",
    opencode: "OpenCode",
    "opencode-go": "OpenCode Go",
    "opencode-zen": "OpenCode Zen",
    openrouter: "OpenRouter",
    "ovhcloud-ai-endpoints": "OVHcloud AI Endpoints",
    "sap-ai-core": "SAP AI Core",
    scaleway: "Scaleway",
    stackit: "STACKIT",
    "together-ai": "Together AI",
    "venice-ai": "Venice AI",
    "vercel-ai-gateway": "Vercel AI Gateway",
    xai: "xAI",
    "z-ai": "Z.AI",
    zenmux: "ZenMux",
  };
  return knownNames[normalizedProviderId.toLowerCase()] ?? formatOpenCodeIdentifier(providerId);
}

export function flattenOpenCodeCliModels(input: {
  readonly models: ReadonlyArray<OpenCodeCliModelDescriptor>;
}): ProviderListModelsResult["models"] {
  return input.models
    .flatMap((model) => {
      const descriptor = toOpenCodeModelDescriptor({
        slug: model.slug,
        name: model.name,
        provider: {
          id: model.providerID,
          name: formatOpenCodeCliProviderName(model.providerID),
        },
        cliModel: model,
      });
      return descriptor ? [descriptor] : [];
    })
    .toSorted(compareOpenCodeModelDescriptors);
}

export function flattenOpenCodeModels(input: {
  readonly inventory: OpenCodeModelInventory;
  readonly credentialProviderIDs?: ReadonlyArray<string>;
}): ProviderListModelsResult["models"] {
  return resolvePreferredOpenCodeModelProviders(input)
    .flatMap((provider) =>
      Object.values(provider.models).flatMap((model) => {
        const descriptor = toOpenCodeModelDescriptor({
          slug: `${provider.id}/${model.id}`,
          name: model.name,
          provider,
          model,
        });
        return descriptor ? [descriptor] : [];
      }),
    )
    .toSorted(compareOpenCodeModelDescriptors);
}

export function mergeOpenCodeCliModelDescriptors(input: {
  readonly inventory: OpenCodeModelInventory;
  readonly models: ReadonlyArray<OpenCodeModelDescriptor>;
  readonly cliModels: ReadonlyArray<OpenCodeCliModelDescriptor>;
}): ProviderListModelsResult["models"] {
  const providerById = new Map(
    input.inventory.providerList.all.map((provider) => [provider.id, provider] as const),
  );
  const mergedBySlug = new Map(input.models.map((model) => [model.slug, model] as const));

  for (const cliModel of input.cliModels) {
    if (mergedBySlug.has(cliModel.slug)) {
      continue;
    }
    const provider =
      providerById.get(cliModel.providerID) ??
      ({
        id: cliModel.providerID,
        name: formatOpenCodeIdentifier(cliModel.providerID) || cliModel.providerID,
      } satisfies Pick<OpenCodeInventoryProvider, "id" | "name">);
    const descriptor = toOpenCodeModelDescriptor({
      slug: cliModel.slug,
      name: cliModel.name,
      provider,
      ...(providerById.get(cliModel.providerID)?.models[cliModel.modelID]
        ? { model: providerById.get(cliModel.providerID)!.models[cliModel.modelID] }
        : {}),
      cliModel,
    });
    if (descriptor) {
      mergedBySlug.set(descriptor.slug, descriptor);
    }
  }

  return [...mergedBySlug.values()].toSorted(compareOpenCodeModelDescriptors);
}

export function emptyOpenCodeModelInventory(): OpenCodeModelInventory {
  return {
    providerList: {
      connected: [],
      all: [],
    },
    consoleState: null,
  };
}

export function buildOpenCodeModelContextLimitMap(
  inventory: OpenCodeModelInventory,
): Map<string, number> {
  const limits = new Map<string, number>();
  for (const provider of inventory.providerList.all) {
    for (const model of Object.values(provider.models)) {
      const contextLimit = positiveInteger(model.limit?.context);
      if (contextLimit !== undefined) {
        limits.set(`${provider.id}/${model.id}`, contextLimit);
      }
    }
  }
  return limits;
}

export function flattenOpenCodeAgents(
  agents: ReadonlyArray<Agent>,
): ProviderListAgentsResult["agents"] {
  return agents
    .filter((agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"))
    .map((agent) => {
      const displayName = trimNonEmptyString(
        "displayName" in agent ? agent.displayName : undefined,
      );
      return {
        name: agent.name,
        displayName: displayName ?? formatOpenCodeIdentifier(agent.name),
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.model ? { model: `${agent.model.providerID}/${agent.model.modelID}` } : {}),
      };
    })
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
}

type OpenCodeCommand = Awaited<ReturnType<OpencodeClient["command"]["list"]>>["data"] extends
  | ReadonlyArray<infer TCommand>
  | undefined
  ? TCommand
  : never;

export function flattenOpenCodeCommands(
  commands: ReadonlyArray<OpenCodeCommand>,
): ProviderListCommandsResult["commands"] {
  return commands
    .filter((command) => command.name.trim().length > 0)
    .map((command) => ({
      name: command.name.trim(),
      ...(command.description?.trim() ? { description: command.description.trim() } : {}),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function isUnsupportedOpenCodeCommandListError(cause: OpenCodeRuntimeError): boolean {
  const detail = cause.detail.toLowerCase();
  return (
    detail.includes("status=404") ||
    detail.includes("404") ||
    detail.includes("not found") ||
    detail.includes("method not found") ||
    detail.includes("unknown method")
  );
}
