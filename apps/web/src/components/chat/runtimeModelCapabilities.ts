// FILE: runtimeModelCapabilities.ts
// Purpose: Bridges runtime-discovered model metadata into composer capabilities without replacing static defaults wholesale.
// Layer: Chat composer helpers
// Exports: runtime model lookup and Codex capability overrides derived from provider discovery responses.

import type {
  EffortOption,
  ModelCapabilities,
  ProviderKind,
  ProviderModelDescriptor,
  ProviderModelVariantDescriptor,
} from "@synara/contracts";
import {
  getDefaultEffort,
  getModelCapabilities,
  normalizeModelSlug,
  trimOrNull,
} from "@synara/shared/model";
import { normalizeCursorModelVariantBaseId } from "../../cursorModelVariants";

function runtimeEffortLabel(value: string): string {
  switch (value) {
    case "none":
      return "None";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return value
        .split(/[-_\s]+/u)
        .filter((segment) => segment.length > 0)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(" ");
  }
}

// Matches the selected model to its runtime descriptor after provider-specific normalization.
export function resolveRuntimeModelDescriptor(input: {
  provider: ProviderKind;
  model: string | null | undefined;
  runtimeModels: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
}): ProviderModelDescriptor | undefined {
  const { provider, model, runtimeModels } = input;
  if (!runtimeModels?.length) {
    return undefined;
  }

  const normalizedModel = normalizeModelSlug(model, provider) ?? trimOrNull(model);
  if (!normalizedModel) {
    return undefined;
  }

  return runtimeModels.find((candidate) => {
    const normalizedCandidate = normalizeModelSlug(candidate.slug, provider) ?? candidate.slug;
    const normalizedResolvedModel =
      normalizeModelSlug(candidate.resolvedModel, provider) ?? candidate.resolvedModel;
    if (normalizedCandidate === normalizedModel || normalizedResolvedModel === normalizedModel) {
      return true;
    }
    return (
      provider === "cursor" &&
      normalizeCursorModelVariantBaseId(normalizedCandidate) ===
        normalizeCursorModelVariantBaseId(normalizedModel)
    );
  });
}

/**
 * Resolves Devin's friendly composer selections to the concrete model UID
 * accepted by `devin acp --model`. Devin publishes this matrix at the family
 * level, so keeping the resolver next to the runtime capability bridge avoids
 * duplicating suffix heuristics in the UI and server.
 */
export function resolveDevinModelVariant(input: {
  runtimeModel?: ProviderModelDescriptor | undefined;
  reasoningEffort?: string | null | undefined;
  fastMode?: boolean | undefined;
  thinking?: boolean | null | undefined;
  contextWindow?: string | null | undefined;
}): string | undefined {
  const variants = input.runtimeModel?.modelVariants;
  if (!variants || variants.length === 0) {
    return undefined;
  }

  const reasoningEffort = trimOrNull(input.reasoningEffort);
  const contextWindow = trimOrNull(input.contextWindow);
  const defaultContextWindow = trimOrNull(input.runtimeModel?.defaultContextWindow);
  const matches = (variant: ProviderModelVariantDescriptor): boolean => {
    if (reasoningEffort && variant.reasoningEffort !== reasoningEffort) {
      return false;
    }
    if (contextWindow && variant.contextWindow !== contextWindow) {
      return false;
    }
    if (input.fastMode === true && variant.fastMode !== true) {
      return false;
    }
    if (input.fastMode !== true && variant.fastMode === true) {
      return false;
    }
    if (input.thinking !== null && input.thinking !== undefined && variant.thinking !== undefined) {
      return variant.thinking === input.thinking;
    }
    return true;
  };

  const preferred = variants.filter(matches);
  const withDefaultContext =
    !contextWindow && defaultContextWindow
      ? preferred.filter((variant) => variant.contextWindow === defaultContextWindow)
      : preferred;
  return (withDefaultContext[0] ?? preferred[0] ?? variants[0])?.model;
}

// Reuses static capability flags but lets runtime-discovered models override exposed effort menus.
export function getRuntimeAwareModelCapabilities(input: {
  provider: ProviderKind;
  model: string | null | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
}): ModelCapabilities {
  const staticCapabilities = getModelCapabilities(input.provider, input.model);
  // Runtime discovery is authoritative when available; the static table is only a startup fallback.
  const supportsFastMode =
    (input.provider === "codex" || input.provider === "cursor" || input.provider === "devin") &&
    input.runtimeModel
      ? input.runtimeModel.supportsFastMode === true
      : staticCapabilities.supportsFastMode;
  const supportsThinkingToggle =
    input.runtimeModel?.supportsThinkingToggle ?? staticCapabilities.supportsThinkingToggle;
  const contextWindowOptions =
    input.runtimeModel?.contextWindowOptions?.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.isDefault === true ? { isDefault: true as const } : {}),
    })) ?? staticCapabilities.contextWindowOptions;
  const optionDescriptors =
    input.runtimeModel?.optionDescriptors ?? staticCapabilities.optionDescriptors;
  const runtimeEfforts = input.runtimeModel?.supportedReasoningEfforts;
  // Providers with dynamic catalogs, including Droid, expose model-specific effort ladders here.
  if (
    (input.provider !== "codex" &&
      input.provider !== "cursor" &&
      input.provider !== "antigravity" &&
      input.provider !== "grok" &&
      input.provider !== "droid" &&
      input.provider !== "kilo" &&
      input.provider !== "opencode" &&
      input.provider !== "pi" &&
      input.provider !== "devin") ||
    !runtimeEfforts ||
    runtimeEfforts.length === 0
  ) {
    return {
      ...staticCapabilities,
      ...(optionDescriptors ? { optionDescriptors } : {}),
      supportsFastMode,
      supportsThinkingToggle,
      contextWindowOptions,
    };
  }

  const staticDefaultEffort = getDefaultEffort(staticCapabilities);
  const runtimeDefaultEffort =
    trimOrNull(input.runtimeModel?.defaultReasoningEffort) ??
    (staticDefaultEffort && runtimeEfforts.some((effort) => effort.value === staticDefaultEffort)
      ? staticDefaultEffort
      : null);

  const runtimeOptions: EffortOption[] = runtimeEfforts.map((effort) => {
    const description = trimOrNull(effort.description);
    return {
      value: effort.value,
      label: trimOrNull(effort.label) ?? runtimeEffortLabel(effort.value),
      ...(description ? { description } : {}),
      ...(effort.value === runtimeDefaultEffort ? { isDefault: true as const } : {}),
    };
  });

  if (input.provider === "kilo" || input.provider === "opencode") {
    return {
      ...staticCapabilities,
      ...(optionDescriptors ? { optionDescriptors } : {}),
      variantOptions: runtimeOptions,
      supportsThinkingToggle,
      contextWindowOptions,
    };
  }

  return {
    ...staticCapabilities,
    ...(optionDescriptors ? { optionDescriptors } : {}),
    supportsFastMode,
    supportsThinkingToggle,
    contextWindowOptions,
    reasoningEffortLevels: runtimeOptions,
  };
}
