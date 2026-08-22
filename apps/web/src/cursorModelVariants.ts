import type { ProviderModelDescriptor } from "@synara/contracts";
import { parseCursorCliReasoningEffort } from "@synara/shared/model";

function uniqueByValue<T extends { readonly value: string }>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value.value)) {
      continue;
    }
    seen.add(value.value);
    result.push(value);
  }
  return result;
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

function stripCursorParameterizedSuffix(value: string): string {
  return value.trim().replace(/\[[^\]]*\]$/u, "");
}

export function normalizeCursorModelVariantBaseId(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) {
    return null;
  }
  let base = stripCursorParameterizedSuffix(trimmed)
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "")
    .replace(/-thinking$/u, "")
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "");

  if (base.endsWith("-max") && !base.includes("codex-max")) {
    base = base.slice(0, -"-max".length);
  }
  base = base
    .replace(/^claude-(\d+(?:\.\d+)?)-([a-z]+)-max$/u, "claude-$1-$2")
    .replace(/-preview$/u, "");

  const claudeReordered = base.match(/^claude-(\d+(?:\.\d+)?)-([a-z]+)$/u);
  if (claudeReordered) {
    const version = claudeReordered[1];
    const family = claudeReordered[2];
    if (version && family) {
      return `claude-${family}-${version.replace(".", "-")}`;
    }
  }
  return base;
}

function removeVariantNameSuffix(name: string): string {
  return name
    .replace(/\s+Fast$/iu, "")
    .replace(/\s+Thinking$/iu, "")
    .replace(/\s+Fast$/iu, "")
    .replace(/\s+(?:None|Low|Medium|High|Extra High)$/iu, "")
    .replace(/\s+1M$/u, "")
    .trim();
}

function defaultEffortForGroup(
  baseSlug: string,
  efforts: ReadonlyArray<string>,
): string | undefined {
  if (efforts.length === 0) {
    return undefined;
  }
  if (baseSlug.includes("gpt") || baseSlug.includes("codex")) {
    return efforts.includes("medium") ? "medium" : efforts[0];
  }
  // Claude and Grok (and most other Cursor chat models) default to high.
  // Collapsed CLI lists are ordered low → high, so taking efforts[0] would
  // make Grok look like a low-default model in the picker.
  if (efforts.includes("high")) {
    return "high";
  }
  return efforts[0];
}

function isCursorOneMillionVariant(model: ProviderModelDescriptor): boolean {
  if (model.defaultContextWindow === "1m") {
    return true;
  }
  if (
    model.contextWindowOptions?.some((option) => option.value === "1m" && option.isDefault === true)
  ) {
    return true;
  }
  return /\b1M\b/u.test(model.name ?? "");
}

function fallbackContextWindowOptionsForCursorBase(
  baseSlug: string,
  variants: ReadonlyArray<ProviderModelDescriptor>,
): NonNullable<ProviderModelDescriptor["contextWindowOptions"]> {
  if (!variants.some(isCursorOneMillionVariant)) {
    return [];
  }
  if (baseSlug === "gpt-5.5" || baseSlug === "gpt-5.4") {
    return [
      { value: "272k", label: "272K", isDefault: true },
      { value: "1m", label: "1M" },
    ];
  }
  if (
    baseSlug === "claude-fable-5" ||
    baseSlug === "claude-sonnet-5" ||
    baseSlug === "claude-opus-4-8" ||
    baseSlug === "claude-opus-4-7"
  ) {
    return [
      { value: "300k", label: "300K", isDefault: true },
      { value: "1m", label: "1M" },
    ];
  }
  if (baseSlug === "claude-opus-4-6" || baseSlug === "claude-sonnet-4-6") {
    return [
      { value: "200k", label: "200K", isDefault: true },
      { value: "1m", label: "1M" },
    ];
  }
  return [];
}

export function collapseCursorModelVariants(
  models: ReadonlyArray<ProviderModelDescriptor>,
): ProviderModelDescriptor[] {
  const groups = new Map<string, ProviderModelDescriptor[]>();
  for (const model of models) {
    const baseSlug = normalizeCursorModelVariantBaseId(model.slug) ?? model.slug;
    const group = groups.get(baseSlug);
    if (group) {
      group.push(model);
    } else {
      groups.set(baseSlug, [model]);
    }
  }

  return Array.from(groups.entries()).map(([baseSlug, variants]) => {
    const preferredName =
      variants.find((variant) => variant.slug === baseSlug)?.name ??
      variants.find((variant) => !variant.slug.endsWith("-fast"))?.name ??
      variants[0]?.name ??
      baseSlug;
    const efforts = uniqueByValue(
      variants.flatMap((variant) => [
        ...(variant.supportedReasoningEfforts ?? []),
        ...(parseCursorCliReasoningEffort(variant.slug)
          ? [
              {
                value: parseCursorCliReasoningEffort(variant.slug)!,
                label: cursorReasoningLabel(parseCursorCliReasoningEffort(variant.slug)!),
              },
            ]
          : []),
      ]),
    );
    const defaultEffort =
      variants.find((variant) => normalizeCursorModelVariantBaseId(variant.slug) === variant.slug)
        ?.defaultReasoningEffort ??
      defaultEffortForGroup(
        baseSlug,
        efforts.map((effort) => effort.value),
      );
    // The flat `cursor-agent models` fallback names only 1M variants for some
    // families; synthesize the missing default context when ACP metadata is absent.
    const fallbackContextWindowOptions = fallbackContextWindowOptionsForCursorBase(
      baseSlug,
      variants,
    );
    const contextWindowOptions = uniqueByValue([
      ...fallbackContextWindowOptions,
      ...variants.flatMap((variant) => variant.contextWindowOptions ?? []),
    ]);

    return {
      slug: baseSlug,
      name: removeVariantNameSuffix(preferredName),
      ...(variants[0]?.upstreamProviderId
        ? { upstreamProviderId: variants[0].upstreamProviderId }
        : {}),
      ...(variants[0]?.upstreamProviderName
        ? { upstreamProviderName: variants[0].upstreamProviderName }
        : {}),
      ...(efforts.length > 0
        ? {
            supportedReasoningEfforts: efforts.map((effort) => ({
              value: effort.value,
              label: effort.label,
              ...(effort.value === defaultEffort ? { isDefault: true as const } : {}),
            })),
            ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
          }
        : {}),
      ...(variants.some((variant) => variant.supportsFastMode === true)
        ? { supportsFastMode: true as const }
        : {}),
      ...(variants.some((variant) => variant.supportsThinkingToggle === true)
        ? { supportsThinkingToggle: true as const }
        : {}),
      ...(contextWindowOptions.length > 0
        ? {
            contextWindowOptions,
            defaultContextWindow:
              contextWindowOptions.find((option) => option.isDefault === true)?.value ??
              contextWindowOptions[0]?.value,
          }
        : {}),
    };
  });
}
