import type { ModelSelection, ProviderKind, ProviderStartOptions } from "@synara/contracts";

export const GIT_TEXT_GENERATION_PROVIDER_ORDER = [
  "codex",
  "cursor",
  "opencode",
  "droid",
] as const satisfies readonly ProviderKind[];

export type GitTextGenerationProvider = (typeof GIT_TEXT_GENERATION_PROVIDER_ORDER)[number];

const GIT_TEXT_GENERATION_PROVIDER_SET = new Set<ProviderKind>([
  ...GIT_TEXT_GENERATION_PROVIDER_ORDER,
]);

export interface TextGenerationProviderInput {
  readonly modelSelection: ModelSelection;
  readonly providerOptions?: ProviderStartOptions;
  readonly codexHomePath?: string;
}

export function hasDedicatedTextGenerationProvider(
  provider: ProviderKind | undefined,
): provider is GitTextGenerationProvider {
  return provider !== undefined && GIT_TEXT_GENERATION_PROVIDER_SET.has(provider);
}

export function resolveTextGenerationInputForSelection(
  modelSelection: ModelSelection | undefined,
  providerOptions: ProviderStartOptions | undefined,
): TextGenerationProviderInput | null {
  if (!modelSelection || !hasDedicatedTextGenerationProvider(modelSelection.provider)) {
    return null;
  }

  if (modelSelection.provider === "codex") {
    return {
      modelSelection,
      ...(providerOptions ? { providerOptions } : {}),
      ...(providerOptions?.codex?.homePath
        ? { codexHomePath: providerOptions.codex.homePath }
        : {}),
    };
  }

  return {
    modelSelection,
    ...(providerOptions ? { providerOptions } : {}),
  };
}

export function buildGitTextGenerationCallInput(input: {
  readonly textGenerationModel?: string | undefined;
  readonly textGenerationModelSelection?: ModelSelection | undefined;
  readonly codexHomePath?: string | undefined;
  readonly providerOptions?: ProviderStartOptions | undefined;
}): {
  readonly model?: string;
  readonly modelSelection?: ModelSelection;
  readonly codexHomePath?: string;
  readonly providerOptions?: ProviderStartOptions;
} {
  const modelSelection = input.textGenerationModelSelection;
  const model = input.textGenerationModel?.trim() || modelSelection?.model;

  return {
    ...(model ? { model } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
  };
}
