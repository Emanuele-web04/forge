// FILE: threadDisplayProvider.ts
// Purpose: Resolve the provider shown for a thread in UI surfaces (chips, pickers).
// Layer: Web display helper
// Exports: resolveThreadDisplayProvider

import type { ModelSelection, ProviderKind } from "@synara/contracts";

import type { DisplayProvider } from "./providerIdentity";

/** The live session's provider wins over the configured model selection. */
export function resolveThreadDisplayProvider(thread: {
  readonly session?: { readonly provider: ProviderKind | "external" } | null;
  readonly modelSelection: { readonly provider: ModelSelection["provider"] };
}): DisplayProvider {
  return thread.session?.provider ?? thread.modelSelection.provider;
}
