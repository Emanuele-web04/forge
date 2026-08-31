// FILE: runtimeModelCapabilities.ts
// Purpose: Bridges runtime-discovered model metadata into composer capabilities without replacing static defaults wholesale.
// Layer: Chat composer helpers
// Exports: runtime model lookup and Codex capability overrides derived from provider discovery responses.

import type {
  EffortOption,
  ModelCapabilities,
  ProviderKind,
  ProviderModelDescriptor,
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

// Reuses static capability flags but lets runtime-discovered models override exposed effort menus.
export function getRuntimeAwareModelCapabilities(input: {
  provider: ProviderKind;
  model: string | null | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
}): ModelCapabilities {
  const staticCapabilities = getModelCapabilities(input.provider, input.model);
  // Runtime discovery is authoritative when available; the static table is only a startup fallback.
  const supportsFastMode =
    (input.provider === "codex" || input.provider === "cursor") && input.runtimeModel
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
      input.provider !== "opencode" &&
      input.provider !== "pi") ||
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

  if (input.provider === "opencode") {
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
