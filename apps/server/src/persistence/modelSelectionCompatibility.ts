// FILE: modelSelectionCompatibility.ts
// Purpose: Normalizes persisted model-selection JSON from older/newer app builds.
// Layer: Persistence compatibility helper
// Exports: normalizeLegacyModelSelection, normalizePersistedModelSelection

import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";

type ModelProviderKind =
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "antigravity"
  | "grok"
  | "droid"
  | "opencode"
  | "pi";

const NON_DROID_MODEL_SLUGS = new Set(
  Object.entries(MODEL_OPTIONS_BY_PROVIDER).flatMap(([provider, models]) =>
    provider === "droid" ? [] : models.map((model) => model.slug.toLowerCase()),
  ),
);
const DROID_ONLY_MODEL_SLUGS = new Set(
  MODEL_OPTIONS_BY_PROVIDER.droid
    .map((model) => model.slug.toLowerCase())
    .filter((slug) => !NON_DROID_MODEL_SLUGS.has(slug)),
);

const LEGACY_GEMINI_MODEL_LABELS: Readonly<Record<string, string>> = {
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3-flash-preview": "Gemini 3.5 Flash",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Imported instance ids may be runtime names rather than Synara provider literals.
function inferProviderFromLabel(label: string): ModelProviderKind | undefined {
  const lowerLabel = label.toLowerCase();
  if (/(^|[^a-z0-9])pi([^a-z0-9]|$)/u.test(lowerLabel)) {
    return "pi";
  }
  if (lowerLabel.includes("opencode")) {
    return "opencode";
  }
  if (lowerLabel.includes("kilo")) {
    return "opencode";
  }
  if (lowerLabel.includes("cursor")) {
    return "cursor";
  }
  if (lowerLabel.includes("antigravity")) {
    return "antigravity";
  }
  if (lowerLabel.includes("claude") || lowerLabel.includes("anthropic")) {
    return "claudeAgent";
  }
  if (lowerLabel.includes("gemini") || lowerLabel.includes("google")) {
    return "antigravity";
  }
  if (lowerLabel.includes("grok") || lowerLabel.includes("xai") || lowerLabel.includes("x.ai")) {
    return "grok";
  }
  if (lowerLabel.includes("droid") || lowerLabel.includes("factory")) {
    return "droid";
  }
  if (lowerLabel.includes("codex")) {
    return "codex";
  }
  return undefined;
}

function inferLegacyModelProvider(provider: unknown, model: string): ModelProviderKind {
  if (
    provider === "codex" ||
    provider === "claudeAgent" ||
    provider === "cursor" ||
    provider === "antigravity" ||
    provider === "grok" ||
    provider === "droid" ||
    provider === "opencode" ||
    provider === "pi"
  ) {
    return provider;
  }
  if (provider === "gemini") {
    return "antigravity";
  }
  if (provider === "kilo") {
    return "opencode";
  }
  if (typeof provider === "string") {
    const providerFromLabel = inferProviderFromLabel(provider);
    if (providerFromLabel !== undefined) {
      return providerFromLabel;
    }
  }
  const lowerModel = model.toLowerCase();
  // Shared Claude/Gemini/OpenAI slugs remain ambiguous without an instance label;
  // only Factory-exclusive built-ins are safe to attribute to Droid.
  if (DROID_ONLY_MODEL_SLUGS.has(lowerModel)) {
    return "droid";
  }
  if (lowerModel.includes("claude")) {
    return "claudeAgent";
  }
  if (lowerModel.includes("gemini")) {
    return "antigravity";
  }
  if (lowerModel.includes("grok")) {
    return "grok";
  }
  return "codex";
}

function readLegacyProviderOptions(
  options: unknown,
  provider: ModelProviderKind,
  legacyProvider?: string,
): unknown {
  if (!isRecord(options)) {
    return options;
  }
  // Selections migrated from a renamed provider (e.g. kilo → opencode) keep
  // their options scoped under the original provider key.
  const providerScopedOptions =
    options[provider] ?? (legacyProvider === undefined ? undefined : options[legacyProvider]);
  return providerScopedOptions === undefined ? options : providerScopedOptions;
}

function normalizeModelOptions(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const option of input) {
    if (!isRecord(option)) {
      return input;
    }
    const id = readTrimmedString(option, "id");
    if (id === undefined) {
      return input;
    }
    entries.push([id, option.value]);
  }
  return Object.fromEntries(entries);
}

function splitLegacyAntigravityModelLabel(model: string): {
  model: string;
  reasoningEffort?: string;
} {
  const match = model.trim().match(/^(.*?)\s+\(([^()]+)\)$/u);
  if (!match?.[1] || !match[2]) {
    return { model };
  }
  const reasoningEffort = match[2].trim().toLowerCase();
  if (!new Set(["low", "medium", "high", "thinking"]).has(reasoningEffort)) {
    return { model };
  }
  return {
    model: match[1].trim(),
    reasoningEffort,
  };
}

function migrateLegacyGeminiModel(model: string): string {
  const trimmed = model.trim();
  return LEGACY_GEMINI_MODEL_LABELS[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeLegacyModelSelection(input: {
  readonly provider: unknown;
  readonly model: string;
  readonly options: unknown;
}): Record<string, unknown> {
  const provider = inferLegacyModelProvider(input.provider, input.model);
  const migratedGeminiSelection = input.provider === "gemini";
  const normalizedOptions = migratedGeminiSelection
    ? undefined
    : normalizeModelOptions(
        readLegacyProviderOptions(
          input.options,
          provider,
          typeof input.provider === "string" ? input.provider : undefined,
        ),
      );
  const antigravityModel =
    provider === "antigravity"
      ? splitLegacyAntigravityModelLabel(
          migratedGeminiSelection ? migrateLegacyGeminiModel(input.model) : input.model,
        )
      : null;
  const options =
    antigravityModel?.reasoningEffort &&
    (normalizedOptions === undefined || isRecord(normalizedOptions))
      ? {
          ...(isRecord(normalizedOptions) ? normalizedOptions : {}),
          reasoningEffort: antigravityModel.reasoningEffort,
        }
      : normalizedOptions;
  return {
    provider,
    model: antigravityModel?.model ?? input.model,
    ...(options === undefined ? {} : { options }),
  };
}

export function normalizePersistedModelSelection(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const model = readTrimmedString(input, "model");
  if (model === undefined) {
    return input;
  }

  // Newer Synara writes provider-less selections as { instanceId, model } and
  // option rows as [{ id, value }]; Synara stores canonical provider/options objects.
  return normalizeLegacyModelSelection({
    provider: input.provider ?? input.instanceId,
    model,
    options: input.options,
  });
}
