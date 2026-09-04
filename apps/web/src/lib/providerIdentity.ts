import type { ModelSelection, ProviderKind } from "@synara/contracts";

/** The provider discriminant of any model selection: a built-in kind or "external". */
export type AnyModelProvider = ModelSelection["provider"];

/** Provider discriminant accepted by read-only display surfaces. */
export type DisplayProvider = ProviderKind | "external";

export function isBuiltInModelProvider(
  provider: AnyModelProvider | null | undefined,
): provider is ProviderKind {
  return provider !== null && provider !== undefined && provider !== "external";
}

import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";

/** Narrow a selection provider to a built-in kind, falling back when external or absent. */
/** Narrow a selection provider to a built-in kind, falling back when external or absent. */
export function builtInProviderOrDefault(
  provider: AnyModelProvider | null | undefined,
  fallback: ProviderKind = "codex",
): ProviderKind {
  return isBuiltInModelProvider(provider) ? provider : fallback;
}

export function builtInProviderOrNull(
  provider: AnyModelProvider | null | undefined,
): ProviderKind | null {
  return isBuiltInModelProvider(provider) ? provider : null;
}

/** Human-readable provider label for display surfaces, including external agents. */
export function providerDisplayName(provider: DisplayProvider): string {
  return provider === "external" ? "External agent" : PROVIDER_DISPLAY_NAMES[provider];
}
