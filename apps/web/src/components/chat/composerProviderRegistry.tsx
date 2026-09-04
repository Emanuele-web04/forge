// FILE: composerProviderRegistry.tsx
// Purpose: Normalizes provider-specific composer state for display and dispatch.
// Layer: Chat composer orchestration
// Depends on: shared model helpers and runtime model discovery metadata.

import {
  type ModelSlug,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ProviderModelOptions,
} from "@synara/contracts";
import {
  getDefaultContextWindow,
  getDefaultEffort,
  hasContextWindowOption,
  hasEffortLevel,
  isClaudeUltrathinkPrompt,
  normalizeAntigravityModelOptions,
  normalizeClaudeModelOptions,
  normalizeCursorModelOptions,
  normalizeOpenCodeModelOptions,
  normalizePiModelOptions,
  resolveDevinModelVariant,
  resolveLabeledOptionValue,
  trimOrNull,
} from "@synara/shared/model";
import { classifyCodexReasoningEffortSupport } from "../../lib/codexReasoningEffort";
import { getRuntimeAwareModelCapabilities } from "./runtimeModelCapabilities";

export type ComposerProviderStateInput = {
  provider: ProviderKind;
  model: ModelSlug;
  runtimeModel?: ProviderModelDescriptor | undefined;
  prompt: string;
  modelOptions: ProviderModelOptions | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

export function getComposerProviderState(
  input: ComposerProviderStateInput,
): ComposerProviderState {
  const { provider, model, runtimeModel, prompt, modelOptions } = input;
  const caps = getRuntimeAwareModelCapabilities({ provider, model, runtimeModel });

  let rawEffort: string | null = null;
  let normalizedOptions: ProviderModelOptions[ProviderKind] | undefined;

  switch (provider) {
    case "codex": {
      const providerOptions = modelOptions?.codex;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      const defaultReasoningEffort = getDefaultEffort(caps);
      const reasoningEffortSupport = classifyCodexReasoningEffortSupport({
        model,
        effort: rawEffort,
        ...(runtimeModel ? { runtimeModel } : {}),
      });
      const reasoningEffort =
        rawEffort &&
        reasoningEffortSupport !== "unsupported" &&
        rawEffort !== defaultReasoningEffort
          ? rawEffort
          : undefined;
      const fastModeEnabled = caps.supportsFastMode && providerOptions?.fastMode === true;
      const nextOptions = {
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(fastModeEnabled ? { fastMode: true } : {}),
      };
      normalizedOptions = Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
      break;
    }
    case "claudeAgent": {
      const providerOptions = modelOptions?.claudeAgent;
      rawEffort = trimOrNull(providerOptions?.effort);
      normalizedOptions = normalizeClaudeModelOptions(model, providerOptions);
      break;
    }
    case "cursor": {
      const providerOptions = modelOptions?.cursor;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      normalizedOptions = normalizeCursorModelOptions(model, providerOptions, caps);
      break;
    }
    case "antigravity": {
      const providerOptions = modelOptions?.antigravity;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      normalizedOptions = normalizeAntigravityModelOptions(model, providerOptions, caps);
      break;
    }
    case "grok": {
      const providerOptions = modelOptions?.grok;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      const defaultReasoningEffort = getDefaultEffort(caps);
      const reasoningEffort =
        rawEffort && hasEffortLevel(caps, rawEffort) && rawEffort !== defaultReasoningEffort
          ? providerOptions?.reasoningEffort
          : undefined;
      normalizedOptions = reasoningEffort ? { reasoningEffort } : undefined;
      break;
    }
    case "droid": {
      const providerOptions = modelOptions?.droid;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      // Droid's advertised "default" is the mutable current CLI preference.
      // Once the user selects an effort, always dispatch it explicitly.
      const reasoningEffort =
        rawEffort && hasEffortLevel(caps, rawEffort) ? providerOptions?.reasoningEffort : undefined;
      normalizedOptions = reasoningEffort ? { reasoningEffort } : undefined;
      break;
    }
    case "opencode": {
      const providerOptions = modelOptions?.opencode;
      rawEffort = trimOrNull(providerOptions?.variant);
      const variantOptions = caps.variantOptions ?? [];
      const reasoningVariant =
        rawEffort && variantOptions.some((option) => option.value === rawEffort)
          ? rawEffort
          : undefined;
      const agent = trimOrNull(providerOptions?.agent);
      if (variantOptions.length > 0) {
        const nextOptions = {
          ...(reasoningVariant ? { variant: reasoningVariant } : {}),
          ...(agent ? { agent } : {}),
        };
        normalizedOptions = Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
        break;
      }
      normalizedOptions = normalizeOpenCodeModelOptions(providerOptions);
      break;
    }
    case "pi": {
      const providerOptions = modelOptions?.pi;
      rawEffort = trimOrNull(providerOptions?.thinkingLevel);
      normalizedOptions = normalizePiModelOptions(providerOptions);
      break;
    }
    case "devin": {
      const providerOptions = modelOptions?.devin;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      const defaultReasoningEffort = getDefaultEffort(caps);
      const reasoningEffort =
        rawEffort && hasEffortLevel(caps, rawEffort) && rawEffort !== defaultReasoningEffort
          ? rawEffort
          : undefined;
      const rawContextWindow = trimOrNull(providerOptions?.contextWindow);
      const defaultContextWindow = getDefaultContextWindow(caps);
      const contextWindow =
        rawContextWindow &&
        hasContextWindowOption(caps, rawContextWindow) &&
        rawContextWindow !== defaultContextWindow
          ? rawContextWindow
          : undefined;
      const fastModeEnabled = caps.supportsFastMode && providerOptions?.fastMode === true;
      const requestedThinking =
        caps.supportsThinkingToggle && providerOptions?.thinking !== undefined
          ? providerOptions.thinking
          : undefined;
      const modelVariant = resolveDevinModelVariant({
        model,
        runtimeModel,
        modelVariant: providerOptions?.modelVariant,
        reasoningEffort: rawEffort && hasEffortLevel(caps, rawEffort) ? rawEffort : undefined,
        fastMode: caps.supportsFastMode ? providerOptions?.fastMode : undefined,
        thinking: requestedThinking,
        contextWindow:
          rawContextWindow && hasContextWindowOption(caps, rawContextWindow)
            ? rawContextWindow
            : undefined,
      });
      const nextOptions = {
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(fastModeEnabled ? { fastMode: true } : {}),
        ...(requestedThinking !== undefined ? { thinking: requestedThinking } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(modelVariant &&
        (Boolean(reasoningEffort) ||
          fastModeEnabled ||
          requestedThinking !== undefined ||
          Boolean(contextWindow) ||
          Boolean(providerOptions?.modelVariant))
          ? { modelVariant }
          : {}),
      };
      normalizedOptions = Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
      break;
    }
  }

  const draftEffort = trimOrNull(rawEffort);
  const defaultEffort = getDefaultEffort(caps);
  const isPromptInjected = draftEffort
    ? caps.promptInjectedEffortLevels.includes(draftEffort)
    : false;
  const promptEffort =
    provider === "opencode"
      ? resolveLabeledOptionValue(caps.variantOptions, draftEffort)
      : draftEffort &&
          !isPromptInjected &&
          (provider === "codex"
            ? classifyCodexReasoningEffortSupport({
                model,
                effort: draftEffort,
                ...(runtimeModel ? { runtimeModel } : {}),
              }) !== "unsupported"
            : hasEffortLevel(caps, draftEffort))
        ? draftEffort
        : defaultEffort && hasEffortLevel(caps, defaultEffort)
          ? defaultEffort
          : null;

  const ultrathinkActive =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: normalizedOptions,
    ...(ultrathinkActive ? { composerFrameClassName: "ultrathink-frame" } : {}),
    ...(ultrathinkActive ? { modelPickerIconClassName: "ultrathink-chroma" } : {}),
  };
}
